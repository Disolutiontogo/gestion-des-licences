import express from 'express';
import nacl from 'tweetnacl';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { google } from 'googleapis';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Format JJ/MM/AAAA
function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// --------- Discord Bot UNIQUE INSTANCE ---------
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});
discordClient.login(process.env.BOT_TOKEN);

discordClient.once('ready', () => {
  console.log('🤖 Discord bot connecté !');
});

// ---------- Discord Interactions Secure ----------
app.post('/interactions', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = req.body.toString();

  // --- Vérification signature Discord ---
  const isVerified = nacl.sign.detached.verify(
    Buffer.from(timestamp + rawBody),
    Buffer.from(signature, 'hex'),
    Buffer.from(process.env.PUBLIC_KEY, 'hex')
  );
  if (!isVerified) {
    return res.status(401).send('invalid request signature');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send('invalid JSON');
  }

  // --- PING Discord ---
  if (body.type === 1) {
    return res.json({ type: 1 });
  }

  try {
    // --- Réponse rapide pour éviter le timeout Discord ---
    res.json({ type: 4, data: { content: "⏳ Validation en cours…" } });

    // --- TRAITEMENT ASYNC EN TACHE DE FOND ---
    (async () => {
      const data = body.data;
      const userId = data.options.find(o => o.name === 'user').value;
      const proof = data.options.find(o => o.name === 'proof').value;

      // Dates
      const now = new Date();
      const startDate = formatDate(now);
      const expDate = formatDate(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000));

      // Google Sheets setup
      const credentials = JSON.parse(process.env.GOOGLE_CREDS);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      // --- Génération ID client random alphanumérique unique (CLT-XXXXX) ---
      function randomAlphanum(size = 5) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let out = '';
        for (let i = 0; i < size; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
      }
      let clientId, unique = false, essais = 0;
      while (!unique && essais < 15) {
        essais++;
        clientId = `CLT-${randomAlphanum(5)}`;
        const read = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.SHEET_ID,
          range: 'FormResponses!C:C'
        });
        const ids = (read.data.values || []).map(row => row[0]);
        if (!ids.includes(clientId)) unique = true;
      }
      if (!clientId) clientId = `CLT-ERR${Date.now()}`;

      // Ajout Google Sheet
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: 'FormResponses!A:E',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[userId, proof, clientId, startDate, expDate]]
        }
      });

      // --- Attribution des rôles Discord ---
      try {
        // Attendre que le bot soit prêt si besoin
        if (!discordClient.isReady()) {
          await new Promise(resolve => discordClient.once('ready', resolve));
        }
        const guild = await discordClient.guilds.fetch(process.env.GUILD_ID);
        const member = await guild.members.fetch(userId);
        const clientRole = guild.roles.cache.find(r => r.name === "client");
        const prospectRole = guild.roles.cache.find(r => r.name === "prospect");

        if (clientRole && member) {
          await member.roles.add(clientRole);
          if (prospectRole && member.roles.cache.has(prospectRole.id)) {
            await member.roles.remove(prospectRole);
          }
          try {
            await member.send(`🎉 Paiement validé, tu as reçu le rôle client pour 1 an (jusqu’au ${expDate}) ! Ton ID client est ${clientId}`);
          } catch (e) {
            console.log("Impossible d’envoyer le DM à ce membre (DM fermés).");
          }
        }

        // EDIT DU MESSAGE INITIAL dans Discord si tu veux (optionnel)

      } catch (e) {
        console.error('Erreur Discord roles:', e);
      }
    })();

  } catch (err) {
    console.error('Erreur sur /interactions:', err);
    if (!res.headersSent) {
      res.json({
        type: 4,
        data: { content: '❌ Erreur lors de la validation. Merci de réessayer.' }
      });
    }
  }
});

// --- CRON notifications de rappel automatisées ---
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
          const guild = await discordClient.guilds.fetch(process.env.GUILD_ID);
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

// --- Express écoute sur le port Render ou local ---
app.listen(process.env.PORT || 3000, () => {
  console.log("Server ready on http://localhost:" + (process.env.PORT || 3000));
});
