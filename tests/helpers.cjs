const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const steamId = '76561199389462063';
const callbackUrl = 'https://www.dotaskin.io/api/steam/offer-state-changed?requestId=test-request';
const client = { id: 'dotaskin', apiKey: 'test-dota-key', games: ['dota2'], callbackOrigins: ['https://www.dotaskin.io'] };
const legacy = { id: 'legacy', apiKey: 'test-legacy-key', games: ['cs2', 'rust', 'dota2'], callbackOrigins: null };
const tradeUrl = `https://steamcommunity.com/tradeoffer/new/?partner=${BigInt(steamId) - 76561197960265728n}&token=abcdefgh`;
const body = { steamId, callbackUrl, tradeUrl, assetids: ['100'], game: 'dota2' };
const quiet = { log() {}, error() {}, warn() {} };

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-bot-test-'));
  t.after(() => {
    // Only files created inside this uniquely allocated test directory are removed.
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}

function page(appid = 570, assetid = '100', tradable = 1, amount = '1') {
  return { success: 1,
    assets: [{ appid, contextid: '2', assetid, classid: assetid, instanceid: '0', amount }],
    descriptions: [{ appid, classid: assetid, instanceid: '0', market_hash_name: `Item ${assetid}`, tradable, icon_url: 'icon' }],
  };
}

module.exports = { steamId, callbackUrl, client, legacy, tradeUrl, body, quiet, tempDirectory, page };
