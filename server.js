import express from 'express';
import { verifyKey } from 'discord-interactions';
import { google } from 'googleapis';
import nacl from 'tweetnacl';
import 'dotenv/config';
const credentials = JSON.parse(process.env.GOOGLE_CREDS);

const {
  PUBLIC_KEY, BOT_TOKEN,
  APPLICATION_ID, GUILD_ID,
  SHEET_ID, PORT = 3000
} = process.env;

// Initialisation Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.post('/interactions', async (req, res) => {
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');
  if (!verifyKey(req.rawBody, signature, timestamp, PUBLIC_KEY)) {
    return res.status(401).send('invalid request signature');
  }

  const { type, data } = req.body;
  if (type === 1) {
    return res.json({ type: 1 });
  }

  // Récupère options
  const userId = data.options.find(o => o.name === 'user').value;
  const proof  = data.options.find(o => o.name === 'proof').value;

  // Dates & ID client
  const now = new Date();
  const startDate = now.toISOString().split('T')[0];
  const expDate   = new Date(now.getTime() + 365*24*3600*1000)
                      .toISOString().split('T')[0];

  // Lecture de la feuille pour générer l’ID séquentiel
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: 'FormResponses!A:C'
  });
  const rows = sheetRes.data.values || [];
  const lastId = rows.length > 1 ? parseInt(rows[rows.length-1][2],10) : 0;
  const clientId = String(lastId + 1).padStart(5, '0');

  // Append
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'FormResponses!A:E',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[userId, proof, clientId, startDate, expDate]]
    }
  });

  // Réponse Discord
  return res.json({
    type: 4,
    data: {
      content:
        `✅ Validation réussie pour <@${userId}>\n` +
        `• ID client : ${clientId}\n` +
        `• Début : ${startDate}\n` +
        `• Expire : ${expDate}\n\n` +
        `\`\`\`?give-role @${userId} client 365d\`\`\``
    }
  });
});

app.listen(PORT, () =>
  console.log(`Server ready on http://localhost:${PORT}`));
