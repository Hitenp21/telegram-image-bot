require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ExcelJS = require('exceljs');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Recommended for vision + speed

const userData = new Map(); // chatId -> array of extracted items
const mediaGroupTimeouts = new Map();

// Powerful prompt for bills with multiple items
const BILL_EXTRACTION_PROMPT = `
You are an expert at extracting data from bills, invoices, receipts, or shopping lists.

Analyze the image carefully and extract:

- billDate: The date of the bill/invoice (in YYYY-MM-DD format if possible, or as written)
- userName: Customer name, buyer name, or shop/customer identifier (if not found, use "N/A")
- items: Array of all products/line items. For each item extract:
  - productName: Full name of the product/item
  - rate: Price per unit (number only, remove currency)
  - quantity: Quantity (number). If not mentioned, assume 1.

Return ONLY a valid JSON object in this exact structure, nothing else:

{
  "billDate": "2025-12-25",
  "userName": "Hiten Patel",
  "items": [
    {
      "productName": "Wireless Headphones",
      "rate": 1299,
      "quantity": 1
    },
    {
      "productName": "Mobile Charger",
      "rate": 399,
      "quantity": 2
    }
  ]
}

If any value is missing or unclear, use null or "N/A" for strings, and 0 or 1 for numbers. Do not add explanations.
`;

async function downloadImage(fileId) {
  const file = await bot.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function extractDataFromImage(imageBuffer) {
  try {
    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const result = await model.generateContent([BILL_EXTRACTION_PROMPT, imagePart]);
    const text = result.response.text().trim();

    // Extract JSON part safely
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      const billDate = parsed.billDate || 'N/A';
      const userName = parsed.userName || 'N/A';

      const items = Array.isArray(parsed.items) ? parsed.items : [];

      // Convert items into flat rows with billDate and userName repeated
      return items.map(item => ({
        billDate: billDate,
        userName: userName,
        productName: item.productName || 'N/A',
        rate: Number(item.rate) || 0,
        quantity: Number(item.quantity) || 1,
      }));
    }
    return [];
  } catch (error) {
    console.error('Gemini Extraction Error:', error.message);
    return [];
  }
}

async function generateExcel(dataArray, chatId) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Bill Extraction');

  worksheet.columns = [
    { header: 'Bill Date', key: 'billDate', width: 15 },
    { header: 'User Name', key: 'userName', width: 25 },
    { header: 'Product Name', key: 'productName', width: 35 },
    { header: 'Rate', key: 'rate', width: 15 },
    { header: 'Quantity', key: 'quantity', width: 12 },
  ];

  // Add all rows (multiple products per bill)
  worksheet.addRows(dataArray);

  // Optional: Add total row at bottom
  if (dataArray.length > 0) {
    const totalAmount = dataArray.reduce((sum, row) => sum + (row.rate * row.quantity), 0);
    worksheet.addRow({
      billDate: '',
      userName: '',
      productName: 'TOTAL AMOUNT',
      rate: totalAmount,
      quantity: ''
    });
  }

  const filePath = path.join('/tmp', `bill_${chatId}_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// --- BOT LOGIC (Start, Photo Handler, etc.) ---
bot.start((ctx) => ctx.reply("Welcome! Send me a bill photo."));

// Photo handler
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const message = ctx.message;
  const photo = message.photo[message.photo.length - 1]; // best quality
  const mediaGroupId = message.media_group_id;

  if (!userData.has(chatId)) {
    userData.set(chatId, []);
  }

  await ctx.reply('📸 Processing bill image with Gemini...');

  try {
    const imageBuffer = await downloadImage(photo.file_id);
    const extractedRows = await extractDataFromImage(imageBuffer);

    if (extractedRows.length > 0) {
      userData.get(chatId).push(...extractedRows);
      await ctx.reply(`✅ Extracted ${extractedRows.length} product(s) from this bill.`);
    } else {
      await ctx.reply('⚠️ Could not extract clear data. Try sending a clearer image of the bill.');
    }

    // Media group (album) handling
    if (mediaGroupId) {
      if (!mediaGroupTimeouts.has(mediaGroupId)) {
        mediaGroupTimeouts.set(mediaGroupId, setTimeout(async () => {
          const allRows = userData.get(chatId) || [];
          if (allRows.length > 0) {
            const filePath = await generateExcel(allRows, chatId);
            await ctx.replyWithDocument({ 
              source: filePath, 
              filename: `bill_extraction_${Date.now()}.xlsx` 
            });
            fs.unlinkSync(filePath);
            userData.delete(chatId);
          }
          mediaGroupTimeouts.delete(mediaGroupId);
        }, 3000)); // 3 seconds for albums
      }
    } else {
      // Single image → send Excel immediately
      const allRows = userData.get(chatId);
      if (allRows.length > 0) {
        const filePath = await generateExcel(allRows, chatId);
        await ctx.replyWithDocument({ 
          source: filePath, 
          filename: `bill_extraction_${Date.now()}.xlsx` 
        });
        fs.unlinkSync(filePath);
        userData.delete(chatId);
      }
    }

  } catch (err) {
    console.error(err);
    await ctx.reply('❌ Error while processing. Please try again with a clearer photo.');
  }
});

// --- VERCEL ADAPTER ---
// Instead of bot.launch(), we export a function that Vercel calls
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Bot is running...');
        }
    } catch (err) {
        console.error("Vercel Handler Error:", err);
        res.status(500).send('Error');
    }
};