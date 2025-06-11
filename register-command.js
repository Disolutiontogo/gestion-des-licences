import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import 'dotenv/config';

const { APPLICATION_ID, GUILD_ID, BOT_TOKEN } = process.env;

const commands = [
  {
    name: 'validate',
    description: 'Valide un paiement et enregistre en compta',
    options: [
      { name: 'user', type: 6, description: 'Utilisateur à valider', required: true },
      { name: 'proof', type: 3, description: 'Preuve de paiement (lien/ID)', required: true }
    ],
  },
  {
    name: 'renew',
    description: "Renouvelle la licence d'un client existant",
    options: [
      { name: 'clientid', type: 3, description: 'ID client (ex: CLT-00001)', required: true },
      { name: 'proof', type: 3, description: 'Nouvelle preuve de paiement', required: true }
    ],
  }
];

(async () => {
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    console.log('🚀 Enregistrement des commandes…');
    await rest.put(
      Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commandes enregistrées !');
  } catch (error) {
    console.error('Erreur lors de l’enregistrement des commandes :', error);
  }
})();
