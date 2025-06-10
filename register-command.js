import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import 'dotenv/config';

const { APPLICATION_ID, GUILD_ID, BOT_TOKEN } = process.env;

const commands = [{
  name: 'validate',
  description: 'Valide un paiement et enregistre en compta',
  options: [
    { name: 'user',  type: 6, description: 'Utilisateur à valider', required: true },
    { name: 'proof', type: 3, description: 'Preuve de paiement (lien/ID)', required: true }
  ],
}];

(async () => {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  console.log('🚀 Enregistrement de /validate…');
  await rest.put(
    Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID),
    { body: commands }
  );
  console.log('✅ /validate enregistrée !');
})();
