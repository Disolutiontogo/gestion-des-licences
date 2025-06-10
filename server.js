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

// -- Discord bot lancement global --
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});
client.login(process.env.BOT_TOKEN);
client.once('ready', () => {
  console.log('🤖 Discord bot connecté !');
});

// Utilise express.raw pour la route interactions
app.post('/interactions', express.raw({ type: 'application/json' }), async (req, res) => {
  // --- Sécurité Discord Signature ---
  try {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = req.body.toString();

    const isVerified = nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(process.env.PUBLIC_KEY, 'hex')
    );

    if (!isVerified) {
      return res.status(401).send('invalid request signature');
    }

    const body = JSON.parse(rawBody);

    // Répond au ping Discord
    if (body.type === 1) {
      return res.json({ type: 1 });
    }

    // Récupère les infos de la commande
    const data = body.data;
    const userId = data.options.find(o => o.name === 'user').value;
    const proof = data.options.find(o => o.name === 'proof').value;

    // Dates & ID client incrémental
    const now = new Date();
    const startDate = formatDate(now);
    const expDate = formatDate(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000));

    // --- On répond à Discord TOUT DE SUITE pour éviter tout timeout ! ---
    // On construit l'ID client dans la tâche de fond.
    res.json({
      type: 4,
      data: {
        content: `⏳ Validation en cours pour <@${userId}>...`
      }
    });

    // --- Traite la suite en tâche de fond, sans bloquer Discord ---
    (async () => {
      try {
        // Google Sheets setup
        const credentials = JSON.parse(process.env.GOOGLE_CREDS);
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // Cherche le dernier ID
        const read = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.SHEET_ID,
          range: 'FormResponses!C:C'
        });
        const ids = (read.data.values || [])
          .map(row => row[0])
          .filter(val => val && /^CLT-\d+$/.test(val));
        let lastNum = 0;
        if (ids.length > 0) {
          const matches = ids[ids.length - 1].match(/^CLT-(\d+)$/);
          if (matches) lastNum = parseInt(matches[1], 10);
        }
        const nextNum = lastNum + 1;
        const clientId = `CLT-${String(nextNum).padStart(5, '0')}`;

        // Ajoute la nouvelle ligne dans la sheet
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.SHEET_ID,
          range: 'FormResponses!A:E',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[userId, proof, clientId, startDate, expDate]]
          }
        });

        // Discord: ajoute le rôle client et retire prospect
        const guild = await client.guilds.fetch(process.env.GUILD_ID);
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

        // Envoie une notification dans le salon Discord (optionnel : pour retour visuel à l’admin)
        // const channel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
        // if (channel) {
        //   channel.send(`✅ Validation réussie pour <@${userId}>. • ID client : ${clientId} • Début : ${startDate} • Expiration : ${expDate}`);
        // }
      } catch (err) {
        console.error('Erreur de fond (sheet/roles) :', err);
        // Ici tu peux log ou même envoyer un DM à l'admin si besoin
      }
    })();

  } catch (err) {
    console.error('Erreur sur /interactions:', err);
    // Si ça plante AVANT la réponse, Discord aura une erreur.
    // Mais ce cas est extrêmement rare avec ce flow.
    return res.json({
      type: 4,
      data: { content: '❌ Erreur lors de la validation. Merci de réessayer.' }
    });
  }
});

// CRON notifications de rappel automatisées (pas modifié)
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
