require('dotenv').config();
const { Telegraf } = require('telegraf');
const ExcelJS     = require('exceljs');
const axios       = require('axios');
const FormData    = require('form-data');
const fs          = require('fs');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const bot        = new Telegraf(process.env.BOT_TOKEN);
const TG_BASE    = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.2-11b-vision-preview';

// ─── Telegram helpers (axios only — bypasses telegraf node-fetch) ─────────────

async function tgSend(chatId, text, extra = {}) {
  await axios.post(`${TG_BASE}/sendMessage`, { chat_id: chatId, text, ...extra });
}

async function tgSendDocument(chatId, filePath, filename, caption) {
  const form = new FormData();
  form.append('chat_id',    String(chatId));
  form.append('caption',    caption || '');
  form.append('parse_mode', 'Markdown');
  form.append('document',   fs.createReadStream(filePath), { filename });
  await axios.post(`${TG_BASE}/sendDocument`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
  });
}

async function downloadTelegramFile(fileId) {
  const res  = await axios.get(`${TG_BASE}/getFile`, { params: { file_id: fileId } });
  const file = res.data.result;
  const url  = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const dl   = await axios.get(url, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(dl.data), filePath: file.file_path };
}

// ─── State ────────────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId))
    sessions.set(chatId, { rows: [], processing: 0, albumTimeouts: new Map() });
  return sessions.get(chatId);
}
function clearSession(chatId) { sessions.delete(chatId); }

// ─── Groq OCR ─────────────────────────────────────────────────────────────────
const BILL_PROMPT = `
You are an expert OCR engine for bills, invoices, receipts, and shopping lists.
Return ONLY a valid JSON object — no markdown, no explanation:

{
  "billDate": "2025-06-15",
  "userName": "Rahul Shah",
  "items": [
    { "productName": "Basmati Rice 5kg", "rate": 425, "quantity": 2 },
    { "productName": "Toor Dal 1kg",     "rate": 145, "quantity": 3 }
  ]
}

Rules:
- billDate: date on the bill (YYYY-MM-DD preferred)
- userName: customer/buyer name, or "N/A" if absent
- items: every line-item; rate = price per unit (number); quantity defaults to 1
- Use "N/A" for missing strings, 0 for missing numbers. Never invent data.
`;

function getMimeType(fp) {
  const ext = (fp || '').split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'image/jpeg';
}

async function extractFromImage(buffer, filePath) {
  const mimeType  = getMimeType(filePath);
  const base64Url = `data:${mimeType};base64,${buffer.toString('base64')}`;

  const body = {
    model: GROQ_MODEL, temperature: 0.1, max_tokens: 2048,
    messages: [{ role: 'user', content: [
      { type: 'text',      text: BILL_PROMPT },
      { type: 'image_url', image_url: { url: base64Url } },
    ]}],
  };

  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await axios.post(GROQ_URL, body, {
        headers: { 'Content-Type': 'application/json',
                   'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        timeout: 60000,
      });
      break;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 && attempt < 3) {
        const wait = parseInt(err.response?.headers?.['retry-after']) || attempt * 20;
        console.log(`Groq 429 — retry in ${wait}s (${attempt}/3)`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw new Error(`Groq API ${status}: ${JSON.stringify(err?.response?.data || err.message)}`);
      }
    }
  }

  const raw = response.data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty Groq response');
  console.log('Groq raw:', raw.substring(0, 300));

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Groq response');

  const parsed   = JSON.parse(match[0]);
  const billDate = parsed.billDate || 'N/A';
  const userName = parsed.userName || 'N/A';
  const items    = Array.isArray(parsed.items) ? parsed.items : [];

  return items.map(item => {
    const rate     = isNaN(Number(item.rate))     ? 0 : Number(item.rate);
    const quantity = isNaN(Number(item.quantity)) ? 1 : Number(item.quantity);
    return { billDate, userName, productName: item.productName || 'N/A',
             rate, quantity, amount: +(rate * quantity).toFixed(2) };
  });
}

// ─── Excel builder ────────────────────────────────────────────────────────────
async function buildExcel(rows, chatId) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bills', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'Bill Date',    key: 'billDate',    width: 14 },
    { header: 'Customer',     key: 'userName',    width: 22 },
    { header: 'Product Name', key: 'productName', width: 38 },
    { header: 'Rate',         key: 'rate',        width: 13 },
    { header: 'Qty',          key: 'quantity',    width: 8  },
    { header: 'Amount',       key: 'amount',      width: 15 },
  ];

  const hr = ws.getRow(1);
  hr.height = 22;
  hr.eachCell(cell => {
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3C5E' } };
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border    = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} };
  });

  rows.forEach((row, i) => {
    const dr = ws.addRow(row);
    dr.height = 18;
    dr.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.fill      = { type:'pattern', pattern:'solid', fgColor:{ argb: i%2===0 ? 'FFEEF3F8':'FFFFFFFF' } };
      cell.font      = { name:'Calibri', size:10 };
      cell.border    = { top:{style:'hair',color:{argb:'FFCCCCCC'}}, bottom:{style:'hair',color:{argb:'FFCCCCCC'}},
                         left:{style:'hair',color:{argb:'FFCCCCCC'}}, right:{style:'hair',color:{argb:'FFCCCCCC'}} };
      cell.alignment = [4,6].includes(col) ? {horizontal:'right'}
                     : col===5             ? {horizontal:'center'}
                     : {horizontal:'left', wrapText:true};
    });
  });

  const total   = rows.reduce((s, r) => s + r.amount, 0);
  const tr      = ws.addRow({ billDate:'', userName:'', productName:'GRAND TOTAL',
                               rate:'', quantity:'', amount:+total.toFixed(2) });
  tr.height     = 22;
  tr.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.fill   = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A3C5E'} };
    cell.font   = { bold:true, color:{argb:'FFFFFFFF'}, size:11, name:'Calibri' };
    cell.border = { top:{style:'medium'}, bottom:{style:'medium'}, left:{style:'thin'}, right:{style:'thin'} };
    if ([3,6].includes(col)) cell.alignment = { horizontal:'right' };
  });

  ws.autoFilter = { from: 'A1', to: 'F1' };
  const out = path.join('/tmp', `bills_${chatId}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(out);
  return out;
}

// ─── Bot handlers ─────────────────────────────────────────────────────────────

bot.start(async ctx => {
  await tgSend(ctx.chat.id,
    '👋 Welcome to Bill Extractor Bot!\n\n' +
    '📸 Send one or more bill photos.\n' +
    '📊 /done — generate Excel\n' +
    '📋 /status — items queued\n' +
    '🗑 /clear — reset session'
  );
});

bot.command('status', async ctx => {
  const chatId  = ctx.chat.id;
  const session = getSession(chatId);
  if (session.rows.length === 0) return tgSend(chatId, '📭 No items queued yet. Send bill photos!');
  const dates = [...new Set(session.rows.map(r => r.billDate))].join(', ');
  await tgSend(chatId,
    `📋 Session Status\n\n🧾 Items: ${session.rows.length}\n📅 Dates: ${dates}\n\nSend /done to get Excel.`
  );
});

bot.command('clear', async ctx => {
  clearSession(ctx.chat.id);
  await tgSend(ctx.chat.id, '🗑 Session cleared. Send new bill photos to start fresh.');
});

bot.command('done', async ctx => {
  const chatId  = ctx.chat.id;
  const session = getSession(chatId);
  if (session.processing > 0)
    return tgSend(chatId, `⏳ Still processing ${session.processing} image(s). Try /done again shortly.`);
  if (session.rows.length === 0)
    return tgSend(chatId, '📭 No data yet. Send bill photos first.');

  await tgSend(chatId, '📊 Generating Excel...');
  try {
    const fp = await buildExcel(session.rows, chatId);
    await tgSendDocument(chatId, fp, `bills_${Date.now()}.xlsx`,
      `✅ *${session.rows.length} item(s)* extracted.\nUse /clear to start a new session.`);
    fs.unlinkSync(fp);
    clearSession(chatId);
  } catch (err) {
    console.error('Excel error:', err.message);
    await tgSend(chatId, '❌ Failed to generate Excel. Try /done again.');
  }
});

bot.on('photo', async ctx => {
  const chatId       = ctx.chat.id;
  const photo        = ctx.message.photo[ctx.message.photo.length - 1];
  const mediaGroupId = ctx.message.media_group_id;
  const session      = getSession(chatId);

  session.processing += 1;
  if (!mediaGroupId || !session.albumTimeouts.has(mediaGroupId))
    await tgSend(chatId, '📸 Received! Extracting bill data...');

  (async () => {
    try {
      const { buffer, filePath } = await downloadTelegramFile(photo.file_id);
      const rows = await extractFromImage(buffer, filePath);

      if (rows.length > 0) {
        session.rows.push(...rows);
        await tgSend(chatId,
          `✅ Extracted ${rows.length} product(s). Total queued: ${session.rows.length}\n\nSend more photos or /done to get Excel.`
        );
      } else {
        await tgSend(chatId, '⚠️ No items found. Try a clearer photo of the bill.');
      }
    } catch (err) {
      console.error('Image processing error:', err.message);
      await tgSend(chatId, '❌ Error processing image. Please resend a clearer photo.');
    } finally {
      session.processing -= 1;
    }

    if (mediaGroupId) {
      if (session.albumTimeouts.has(mediaGroupId))
        clearTimeout(session.albumTimeouts.get(mediaGroupId));

      session.albumTimeouts.set(mediaGroupId, setTimeout(async () => {
        await new Promise(resolve => {
          const iv = setInterval(() => {
            if (session.processing === 0) { clearInterval(iv); resolve(); }
          }, 300);
        });
        session.albumTimeouts.delete(mediaGroupId);

        if (session.rows.length > 0) {
          await tgSend(chatId, '📊 Album done! Generating Excel...');
          try {
            const fp = await buildExcel(session.rows, chatId);
            await tgSendDocument(chatId, fp, `bills_${Date.now()}.xlsx`,
              `✅ *${session.rows.length} item(s)* from your album.\nUse /clear to start fresh.`);
            fs.unlinkSync(fp);
            clearSession(chatId);
          } catch (err) {
            console.error('Album Excel error:', err.message);
            await tgSend(chatId, '❌ Excel failed. Try /done manually.');
          }
        }
      }, 4000));
    }
  })();
});

// ─── Vercel Webhook ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST')
    return res.status(200).send('Bill Extractor Bot is running ✅');

  res.status(200).send('OK'); // ACK Telegram immediately

  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
};