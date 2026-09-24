const fs = require('node:fs');
const path = require('node:path');
const { loadClients } = require('../lib/commerce');
try {
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const clients = loadClients(process.env);
  const placeholder = (value) => !value || /^(replace-|your-|changeme)/i.test(value);
  if (placeholder(process.env.STEAM_BOT_PASSWORD) || clients.some((client) => placeholder(client.apiKey))) {
    throw new Error('Set real server credentials; example placeholders are not usable.');
  }
  const maFile = path.join(__dirname, '..', 'lib', 'secrets', 'bot.maFile');
  if (!fs.existsSync(maFile)) throw new Error('lib/secrets/bot.maFile is missing.');
  let maData;
  try { maData = JSON.parse(fs.readFileSync(maFile, 'utf8')); }
  catch { throw new Error('lib/secrets/bot.maFile is not valid JSON.'); }
  if (!maData?.account_name || !maData?.shared_secret) throw new Error('maFile requires account_name and shared_secret.');
  for (const client of clients) console.log(`Store ${client.id}: games=${client.games.join(',')}, origins=${client.callbackOrigins?.join(',') || 'legacy (configure BOT_CALLBACK_ORIGINS)'}`);
  console.log('Local configuration is valid. No Steam login or API request was performed.');
} catch (error) {
  console.error(`Configuration check failed: ${error.message}`);
  process.exitCode = 1;
}
