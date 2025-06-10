import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { google } from 'googleapis';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();


const app = express();
app.use(express.json());

// Discord bot setup
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.login(process.env.BOT_TOKEN);

client.once('ready', () => {
  console.log('🤖 Discord bot connecté !');
});

// Google Sheets setup
const credentials = JSON.parse(process.env.GOOGLE_CREDS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Endpoint Discord Interactions
app.post('/interactions', async (req, res) => {
  try {
    const body = req.body;

    // Répond au ping Discord
    if (body.type === 1) {
      return res.json({ type: 1 });
    }

    // Récupère les infos de la commande
    const data = body.data;
    const userId = data.options.find(o => o.name === 'user').value;
    const proof = data.options.find(o => o.name === 'proof').value;

    // Sheets: ajoute l'utilisateur
    const now = new Date();
    const startDate = now.toISOString().slice(0, 10);
    const expDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Génére l’ID client (optionnel)
    // Récupère la dernière ligne pour incrémenter
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'FormResponses!C:C'
    });
    const nextIdNum = read.data.values && read.data.values.length ? parseInt(read.data.values.slice(-1)[0][0] || "0", 10) + 1 : 1;
    const clientId = ("00000" + nextIdNum).slice(-5);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: 'FormResponses!A:E',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[userId, proof, clientId, startDate, expDate]]
      }
    });

    // Discord: ajoute le rôle client au membre
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.find(r => r.name === "client");

    if (role && member) {
      await member.roles.add(role);

      // Message privé à l'utilisateur
      try {
        await member.send(`🎉 Paiement validé, tu as reçu le rôle client pour 1 an (jusqu’au ${expDate}) !`);
      } catch (e) {
        console.log("Impossible d’envoyer le DM à ce membre (DM fermés).");
      }
    }

    // Répond dans Discord
    res.json({
      type: 4,
      data: {
        content:
          `✅ Validation réussie pour <@${userId}>.\n• ID client : ${clientId}\n• Début de licence : ${startDate}\n• Expiration : ${expDate}\n\n🎉 Le rôle client a été attribué automatiquement !`
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

// Notifications de rappel automatisées
cron.schedule('0 10 * * *', async () => { // tous les jours à 10h (UTC)
  try {
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
      const [userId, , , , expDate] = row;
      if (!userId || !expDate) continue;
      const diff = Math.ceil((new Date(expDate) - today) / (1000 * 3600 * 24));
      const reminder = reminders.find(r => r.days === diff);
      if (reminder) {
        try {
          const guild = await client.guilds.fetch(process.env.GUILD_ID);
          const member = await guild.members.fetch(userId);
          await member.send(`⏰ Rappel : ton rôle client expire ${reminder.msg} (le ${expDate}). Pense à renouveler ton accès !`);
        } catch (e) {
          console.log("Rappel impossible à ", userId, e.message);
        }
      }
    }
  } catch (e) {
    console.log("Erreur CRON Google Sheets :", e.message);
  }
});

client.on('guildMemberAdd', async member => {
  // Vérifie que c'est bien sur TON serveur (optionnel si ton bot est sur plusieurs serveurs)
  if (member.guild.id !== process.env.GUILD_ID) return;

  // Cherche le rôle "prospect"
  const role = member.guild.roles.cache.find(r => r.name === 'prospect');
  if (role) {
    try {
      await member.roles.add(role);
      console.log(`Rôle 'prospect' attribué à ${member.user.tag}`);
      // (Optionnel) Envoie un DM au nouveau membre
      try {
        await member.send("Bienvenue sur le serveur ! Tu as le rôle prospect. Reste attentif pour passer client !");
      } catch (e) {
        console.log("Impossible d’envoyer le DM au membre.");
      }
    } catch (e) {
      console.log(`Erreur lors de l'attribution du rôle prospect à ${member.user.tag} :`, e.message);
    }
  } else {
    console.log("Rôle 'prospect' introuvable !");
  }
});

// Express écoute sur le port Render
app.listen(process.env.PORT || 3000, () => {
  console.log("Server ready on http://localhost:" + (process.env.PORT || 3000));
});
