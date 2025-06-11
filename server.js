import express from 'express';
import nacl from 'tweetnacl';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { google } from 'googleapis';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

app.post('/interactions', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = req.body;

    if (!signature || !timestamp) {
      return res.status(401).send('Unauthorized: missing signature headers');
    }

    const isVerified = nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody.toString()),
      Buffer.from(signature, 'hex'),
      Buffer.from(process.env.PUBLIC_KEY, 'hex')
    );

    if (!isVerified) {
      return res.status(401).send('Unauthorized: invalid request signature');
    }

    const body = JSON.parse(rawBody.toString());

    if (body.type === 1) return res.json({ type: 1 });

    const { data } = body;

    const credentials = JSON.parse(process.env.GOOGLE_CREDS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    if (data.name === 'validate') {
      // ... ta logique validate ici (inchangée)
      // Je ne la copie pas ici pour rester concentré sur renew
    }

    if (data.name === 'renew') {
      if (!data.options) {
        return res.json({
          type: 4,
          data: { content: "❌ Veuillez fournir toutes les options requises : clientid et proof." }
        });
      }

      const clientIdOpt = data.options.find(o => o.name === 'clientid');
      const proofOpt = data.options.find(o => o.name === 'proof');

      if (!clientIdOpt || !proofOpt) {
        return res.json({
          type: 4,
          data: { content: "❌ Options invalides. Assurez-vous de fournir clientid et proof." }
        });
      }

      const clientId = clientIdOpt.value;
      const newProof = proofOpt.value;

      console.log(`[renew] clientId=${clientId}, proof=${newProof}`);

      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: 'FormResponses!A:G'
      });

      const rows = resp.data.values || [];
      let rowIndex = -1;

      for (let i = 0; i < rows.length; i++) {
        if (rows[i][2] === clientId) {
          rowIndex = i;
          break;
        }
      }

      if (rowIndex === -1) {
        return res.json({
          type: 4,
          data: { content: `❌ Aucun client trouvé avec l'ID ${clientId}` }
        });
      }

      const oldExpDateStr = rows[rowIndex][4];
      if (!oldExpDateStr) {
        return res.json({
          type: 4,
          data: { content: `❌ La date d'expiration actuelle est invalide ou manquante pour ${clientId}` }
        });
      }

      const [day, month, year] = oldExpDateStr.split('/');
      const oldExpDate = new Date(`${year}-${month}-${day}`);

      const today = new Date();

      let startDate;
      if (oldExpDate > today) {
        startDate = oldExpDate;
      } else {
        startDate = today;
      }

      const formattedStartDate = formatDate(startDate);
      const expDate = formatDate(new Date(startDate.getTime() + 365 * 24 * 60 * 60 * 1000));

      const oldRenewal = parseInt(rows[rowIndex][6]) || 0;
      const newRenewal = oldRenewal + 1;

      const sheetRowNumber = rowIndex + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SHEET_ID,
        range: `FormResponses!B${sheetRowNumber}:G${sheetRowNumber}`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            newProof,
            clientId,
            formattedStartDate,
            expDate,
            rows[rowIndex][5],
            newRenewal
          ]]
        }
      });

      return res.json({
        type: 4,
        data: {
          content: `✅ Licence renouvelée pour ${clientId}.\n• Nouvelle date de début : ${formattedStartDate}\n• Nouvelle date de fin : ${expDate}\n• Nombre de renouvellements : ${newRenewal}`
        }
      });
    }

    return res.json({
      type: 4,
      data: { content: "Commande inconnue." }
    });

  } catch (err) {
    console.error('Erreur sur /interactions:', err);
    res.json({
      type: 4,
      data: { content: '❌ Erreur lors du traitement. Merci de réessayer.' }
    });
  }
});

// Setup Discord bot (inchangé, pareil que ta version)
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.login(process.env.BOT_TOKEN);

client.once('ready', () => {
  console.log('🤖 Discord bot connecté !');
});

// Cron inchangé ici...

app.listen(process.env.PORT || 3000, () => {
  console.log("Server ready on http://localhost:" + (process.env.PORT || 3000));
});
