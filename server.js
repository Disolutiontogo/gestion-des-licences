import express from 'express';
import nacl from 'tweetnacl';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { google } from 'googleapis';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Utiliser express.raw pour /interactions pour garder le corps brut
app.post('/interactions', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = req.body; // Buffer brut

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

    // Parse JSON uniquement après validation
    const body = JSON.parse(rawBody.toString());

    // Ping de Discord (type 1)
    if (body.type === 1) {
      return res.json({ type: 1 });
    }

    // Récupérer les options
    const data = body.data;
    const userId = data.options.find(o => o.name === 'user').value;
    const proof = data.options.find(o => o.name === 'proof').value;

    // Initialiser Google Sheets
    const credentials = JSON.parse(process.env.GOOGLE_CREDS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Dates formatées
    function formatDate(date) {
      const d = new Date(date);
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    }

    const now = new Date();
    const startDate = formatDate(now);
    const expDate = formatDate(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000));

    // Lire la dernière ID client au format CLT-XXXXX dans la colonne C
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'FormResponses!C:C'
    });

    const ids = (read.data.values || [])
      .map(row => row[0])
      .filter(val => val && val.startsWith('CLT-'))
      .map(val => parseInt(val.replace('CLT-', ''), 10))
      .filter(num => !isNaN(num));

    const lastId = ids.length > 0 ? Math.max(...ids) : 0;
    const nextIdNum = lastId + 1;
    const clientId = `CLT-${("00000" + nextIdNum).slice(-5)}`;

    // Append dans la feuille
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'FormResponses!A:E',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[userId, proof, clientId, startDate, expDate]]
      }
    });

    // Discord client (déjà connecté plus bas)
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);

    // Récupérer les rôles client et prospect
    const clientRole = guild.roles.cache.find(r => r.name === "client");
    const prospectRole = guild.roles.cache.find(r => r.name === "prospect");

    if (clientRole && member) {
      // Ajout du rôle client
      await member.roles.add(clientRole);

      // Suppression du rôle prospect si présent
      if (prospectRole && member.roles.cache.has(prospectRole.id)) {
        await member.roles.remove(prospectRole);
      }

      try {
        await member.send(`🎉 Paiement validé, tu as reçu le rôle client pour 1 an (jusqu’au ${expDate}) !`);
      } catch {
        console.log("Impossible d’envoyer le DM (DM fermés).");
      }
    }

    return res.json({
      type: 4,
      data: {
        content:
          `✅ Validation réussie pour <@${userId}>.\n• ID client : ${clientId}\n• Début de licence : ${startDate}\n• Expiration : ${expDate}\n\n🎉 Le rôle client a été attribué automatiquement et le rôle prospect retiré !`
      }
    });

  } catch (err) {
    console.error('Erreur sur /interactions:', err);
    res.json({
      type: 4,
      data: { content: '❌ Erreur lors de la validation. Merci de réessayer.' }
    });
  }
});

// Setup Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.login(process.env.BOT_TOKEN);

client.once('ready', () => {
  console.log('🤖 Discord bot connecté !');
});

// Cron notifications (inchangé)
cron.schedule('0 10 * * *', async () => {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'FormResponses!A:E'
    });

    const today = new Date();
    const reminders = [
      { days: 30, msg: "dans 1 mois" },
      { days: 14, msg: "dans 2 semaines" },
      { days: 1, msg: "demain" }
    ];

    if (!resp.data.values) return;

    for (let row of resp.data.values) {
      const [userId, , , , expDateStr] = row;
      if (!userId || !expDateStr) continue;

      const [day, month, year] = expDateStr.split('/');
      const expDate = new Date(`${year}-${month}-${day}`);

      const diff = Math.ceil((expDate - today) / (1000 * 3600 * 24));
      const reminder = reminders.find(r => r.days === diff);
      if (reminder) {
        try {
          const guild = await client.guilds.fetch(process.env.GUILD_ID);
          const member = await guild.members.fetch(userId);
          await member.send(`⏰ Rappel : ton rôle client expire ${reminder.msg} (le ${expDateStr}). Pense à renouveler ton accès !`);
        } catch (e) {
          console.log("Rappel impossible à ", userId, e.message);
        }
      }
    }
  } catch (e) {
    console.log("Erreur CRON Google Sheets :", e.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server ready on http://localhost:" + (process.env.PORT || 3000));
});
