require('dotenv').config();
const { Telegraf } = require('telegraf');
const ExcelJS = require('exceljs');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── Init ─────────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

// Groq API — free tier, fast, supports Llama vision (get key at console.groq.com)
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.2-11b-vision-preview'; // free, 30 req/min, 1000 req/day

// ─── State ────────────────────────────────────────────────────────────────────
// chatId → { rows: [], processing: number, albumTimeouts: Map }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { rows: [], processing: 0, albumTimeouts: new Map() });
  }
  return sessions.get(chatId);
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

// ─── Gemini Prompt ─────────────────────────────────────────────────────────────
const BILL_PROMPT = `
You are an expert OCR engine specialized in bills, invoices, receipts, and shopping lists.

Carefully analyze the image and extract:

- billDate  : Date on the bill (YYYY-MM-DD preferred; use original format if unclear)
- userName  : Customer name, buyer name, or "N/A" if absent
- items     : Array of every product/line-item found. For each extract:
    - productName : Full name of the product/item
    - rate        : Price per unit (number only, no currency symbol)
    - quantity    : Quantity ordered (number; default 1 if not shown)

Return ONLY a single valid JSON object — no markdown, no explanation, no extra text.

{
  "billDate": "2025-06-15",
  "userName": "Rahul Shah",
  "items": [
    { "productName": "Basmati Rice 5kg",  "rate": 425,  "quantity": 2 },
    { "productName": "Toor Dal 1kg",       "rate": 145,  "quantity": 3 }
  ]
}

Rules:
- Use null for any value that is genuinely missing.
- If a product has no separate rate/quantity, estimate from total if visible.
- Never invent data; if unclear write "N/A" for strings and 0 for numbers.
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Detect MIME type from Telegram file_path extension */
function getMimeType(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return map[ext] || 'image/jpeg';
}

/** Download a Telegram file as a Buffer */
async function downloadTelegramFile(fileId) {
  const file = await bot.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(response.data), filePath: file.file_path };
}

/** Send image buffer to Gemini REST API and extract structured bill data */
async function extractFromImage(buffer, filePath) {
  const mimeType = getMimeType(filePath);

  // Build Groq request — OpenAI-compatible format with base64 vision
  const base64Url = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const requestBody = {
    model: GROQ_MODEL,
    temperature: 0.1,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text',      text: BILL_PROMPT },
          { type: 'image_url', image_url: { url: base64Url } },
        ],
      },
    ],
  };

  // Retry up to 3 times on 429 rate-limit
  let response;
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await axios.post(GROQ_URL, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        timeout: 60000,
      });
      break;
    } catch (apiErr) {
      const status  = apiErr?.response?.status;
      const errBody = apiErr?.response?.data;

      if (status === 429 && attempt < MAX_RETRIES) {
        // Groq returns Retry-After header in seconds
        const retryAfter = parseInt(apiErr.response?.headers?.['retry-after']) || (attempt * 20);
        console.log(`Groq 429 — waiting ${retryAfter}s before retry ${attempt}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      throw new Error(`Groq API ${status}: ${JSON.stringify(errBody || apiErr.message)}`);
    }
  }

  // Groq uses OpenAI response format
  const raw = response.data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty response from Groq API');
  console.log('Groq raw:', raw.substring(0, 300));

  // Extract JSON even if Gemini wraps it in markdown fences
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in Gemini response');

  const parsed = JSON.parse(match[0]);
  const billDate = parsed.billDate || 'N/A';
  const userName = parsed.userName || 'N/A';
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  return items.map(item => {
    const rate     = isNaN(Number(item.rate))     ? 0 : Number(item.rate);
    const quantity = isNaN(Number(item.quantity)) ? 1 : Number(item.quantity);
    return {
      billDate,
      userName,
      productName: item.productName || 'N/A',
      rate,
      quantity,
      amount: +(rate * quantity).toFixed(2),
    };
  });
}

/** Build a styled Excel workbook from accumulated rows */
async function buildExcel(rows, chatId) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BillBot';
  wb.created = new Date();

  const ws = wb.addWorksheet('Bills', { views: [{ state: 'frozen', ySplit: 1 }] });

  // Column definitions
  ws.columns = [
    { header: 'Bill Date',    key: 'billDate',     width: 14 },
    { header: 'Customer',     key: 'userName',     width: 22 },
    { header: 'Product Name', key: 'productName',  width: 38 },
    { header: 'Rate (₹)',     key: 'rate',         width: 13 },
    { header: 'Qty',          key: 'quantity',     width: 8  },
    { header: 'Amount (₹)',   key: 'amount',       width: 15 },
  ];

  // ── Header row styling ──────────────────────────────────────────────────────
  const headerRow = ws.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3C5E' } };
    cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top:    { style: 'thin', color: { argb: 'FF0D2137' } },
      bottom: { style: 'thin', color: { argb: 'FF0D2137' } },
      left:   { style: 'thin', color: { argb: 'FF0D2137' } },
      right:  { style: 'thin', color: { argb: 'FF0D2137' } },
    };
  });
  headerRow.height = 22;

  // ── Data rows ───────────────────────────────────────────────────────────────
  rows.forEach((row, i) => {
    const dataRow = ws.addRow(row);
    const isEven = i % 2 === 0;
    const bgColor = isEven ? 'FFEEF3F8' : 'FFFFFFFF';

    dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
      cell.font = { name: 'Calibri', size: 10 };
      cell.border = {
        top:    { style: 'hair', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'hair', color: { argb: 'FFCCCCCC' } },
        left:   { style: 'hair', color: { argb: 'FFCCCCCC' } },
        right:  { style: 'hair', color: { argb: 'FFCCCCCC' } },
      };

      // Align numeric columns right
      if ([4, 5, 6].includes(colNum)) {
        cell.alignment = { horizontal: 'right' };
        if (colNum === 5) cell.alignment = { horizontal: 'center' }; // Qty centered
      } else {
        cell.alignment = { horizontal: 'left', wrapText: true };
      }
    });
    dataRow.height = 18;
  });

  // ── Grand Total row ─────────────────────────────────────────────────────────
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);
  const totalRow = ws.addRow({
    billDate:    '',
    userName:    '',
    productName: 'GRAND TOTAL',
    rate:        '',
    quantity:    '',
    amount:      +grandTotal.toFixed(2),
  });

  totalRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3C5E' } };
    cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    cell.border = {
      top:    { style: 'medium', color: { argb: 'FF0D2137' } },
      bottom: { style: 'medium', color: { argb: 'FF0D2137' } },
      left:   { style: 'thin',   color: { argb: 'FF0D2137' } },
      right:  { style: 'thin',   color: { argb: 'FF0D2137' } },
    };
    if (colNum === 3) cell.alignment = { horizontal: 'right' };
    if (colNum === 6) cell.alignment = { horizontal: 'right' };
  });
  totalRow.height = 22;

  // ── Auto-filter ─────────────────────────────────────────────────────────────
  ws.autoFilter = { from: 'A1', to: 'F1' };

  // ── Write file ──────────────────────────────────────────────────────────────
  const filePath = path.join('/tmp', `bills_${chatId}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

// ─── Bot Commands ──────────────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  `👋 Welcome to *Bill Extractor Bot*!\n\n` +
  `📸 Send me one or multiple bill photos.\n` +
  `📊 Use /done to generate the Excel file.\n` +
  `🗑 Use /clear to reset your session.\n` +
  `📋 Use /status to see how many items are queued.`,
  { parse_mode: 'Markdown' }
));

bot.command('status', ctx => {
  const session = getSession(ctx.chat.id);
  const count = session.rows.length;
  if (count === 0) {
    return ctx.reply('📭 No items queued yet. Send some bill photos!');
  }
  const bills = [...new Set(session.rows.map(r => r.billDate))];
  ctx.reply(
    `📋 *Session Status*\n\n` +
    `🧾 Items extracted : ${count}\n` +
    `📅 Bill dates      : ${bills.join(', ')}\n\n` +
    `Send /done to generate your Excel file.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', ctx => {
  clearSession(ctx.chat.id);
  ctx.reply('🗑 Session cleared. You can start fresh by sending new bill photos.');
});

bot.command('done', async ctx => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);

  if (session.processing > 0) {
    return ctx.reply(`⏳ Still processing ${session.processing} image(s). Please wait and try /done again.`);
  }
  if (session.rows.length === 0) {
    return ctx.reply('📭 No data extracted yet. Please send bill photos first.');
  }

  await ctx.reply('📊 Generating your Excel file...');
  try {
    const filePath = await buildExcel(session.rows, chatId);
    await ctx.replyWithDocument(
      { source: filePath, filename: `bills_${Date.now()}.xlsx` },
      { caption: `✅ *${session.rows.length} item(s)* extracted from your bills.\nUse /clear to start a new session.`, parse_mode: 'Markdown' }
    );
    fs.unlinkSync(filePath);
    clearSession(chatId);
  } catch (err) {
    console.error('Excel generation error:', err);
    ctx.reply('❌ Failed to generate Excel. Please try /done again.');
  }
});

// ─── Photo Handler ─────────────────────────────────────────────────────────────

bot.on('photo', async ctx => {
  const chatId       = ctx.chat.id;
  const message      = ctx.message;
  const photo        = message.photo[message.photo.length - 1]; // highest resolution
  const mediaGroupId = message.media_group_id;
  const session      = getSession(chatId);

  session.processing += 1;

  // Acknowledge only once per album (first image)
  if (!mediaGroupId || !session.albumTimeouts.has(mediaGroupId)) {
    await ctx.reply('📸 Received! Extracting bill data with Gemini AI…');
  }

  (async () => {
    try {
      const { buffer, filePath } = await downloadTelegramFile(photo.file_id);
      const rows = await extractFromImage(buffer, filePath);

      if (rows.length > 0) {
        session.rows.push(...rows);
        await ctx.reply(`✅ Extracted *${rows.length}* product(s). Total queued: *${session.rows.length}*\n\nSend more photos or type /done to get Excel.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('⚠️ Could not find items in this image. Try a clearer photo of the bill.');
      }
    } catch (err) {
      console.error('Image processing error:', err.message);
      await ctx.reply('❌ Error processing this image. Please resend a clearer photo.');
    } finally {
      session.processing -= 1;
    }

    // ── Album: auto-send Excel after all images processed ──────────────────
    if (mediaGroupId) {
      // Reset debounce timer on each new album image
      if (session.albumTimeouts.has(mediaGroupId)) {
        clearTimeout(session.albumTimeouts.get(mediaGroupId));
      }

      session.albumTimeouts.set(mediaGroupId, setTimeout(async () => {
        // Wait until all parallel processing is done
        const waitForProcessing = () => new Promise(resolve => {
          const check = setInterval(() => {
            if (session.processing === 0) { clearInterval(check); resolve(); }
          }, 300);
        });
        await waitForProcessing();

        session.albumTimeouts.delete(mediaGroupId);

        if (session.rows.length > 0) {
          await ctx.reply('📊 Album complete! Generating Excel…');
          try {
            const filePath = await buildExcel(session.rows, chatId);
            await ctx.replyWithDocument(
              { source: filePath, filename: `bills_${Date.now()}.xlsx` },
              { caption: `✅ *${session.rows.length} item(s)* from your album.\nUse /clear to start fresh.`, parse_mode: 'Markdown' }
            );
            fs.unlinkSync(filePath);
            clearSession(chatId);
          } catch (err) {
            console.error('Album Excel error:', err);
            await ctx.reply('❌ Failed to generate Excel. Try /done manually.');
          }
        }
      }, 4000)); // 4 s debounce for album grouping
    }
  })();
});

// ─── Vercel Webhook Adapter ────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Bill Extractor Bot is running ✅');
  }

  // ⚡ Respond to Telegram IMMEDIATELY — prevents socket hang up on slow processing
  // Telegram retries if it doesn't get 200 within ~5s, so we must reply first
  res.status(200).send('OK');

  // Process the update in the background AFTER the response is sent
  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
};