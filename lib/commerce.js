const { timingSafeEqual } = require('node:crypto');

const GAMES = Object.freeze({
  cs2: { key: 'cs2', appId: 730, contextId: 2, name: 'CS2' },
  rust: { key: 'rust', appId: 252490, contextId: 2, name: 'Rust' },
  dota2: { key: 'dota2', appId: 570, contextId: 2, name: 'Dota 2' },
});

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function getGameConfig(game = 'cs2') {
  if (typeof game !== 'string' || !Object.hasOwn(GAMES, game.toLowerCase())) {
    throw invalid('Unsupported game. Use cs2, rust or dota2.');
  }
  return GAMES[game.toLowerCase()];
}

function validateSteamId(steamId) {
  if (typeof steamId !== 'string' || !/^\d{17}$/.test(steamId)) {
    throw invalid('A valid SteamID64 string is required.');
  }
  const accountId = BigInt(steamId) - 76561197960265728n;
  if (accountId <= 0n || accountId > 4294967295n) throw invalid('Invalid SteamID64.');
}

function parseHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('Invalid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw invalid('A public HTTPS URL without credentials is required.');
  }
  return url;
}

function parseOrigins(origins) {
  if (!Array.isArray(origins) || !origins.length) throw new Error('Callback origins are required.');
  return origins.map((origin) => {
    const url = parseHttpsUrl(origin);
    if (url.pathname !== '/' || url.search) throw new Error('Use callback origins without paths.');
    return url.origin;
  });
}

function loadClients(env) {
  const clients = [];
  if (env.BOT_API_KEY) {
    clients.push({
      id: 'legacy', apiKey: env.BOT_API_KEY, games: Object.keys(GAMES),
      // Existing CS/Rust installations can migrate to explicit origins without changing their key.
      callbackOrigins: env.BOT_CALLBACK_ORIGINS
        ? parseOrigins(env.BOT_CALLBACK_ORIGINS.split(',').map((value) => value.trim())) : null,
    });
  }
  let configured;
  try { configured = JSON.parse(env.BOT_CLIENTS_JSON || '[]'); }
  catch { throw new Error('BOT_CLIENTS_JSON must contain a JSON array.'); }
  if (!Array.isArray(configured)) throw new Error('BOT_CLIENTS_JSON must contain a JSON array.');
  for (const entry of configured) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(entry.id)
      || entry.id === 'legacy' || typeof entry.apiKey !== 'string' || !entry.apiKey.trim()
      || !Array.isArray(entry.games) || !entry.games.length) {
      throw new Error('Each bot client needs a unique id, apiKey, games and callbackOrigins.');
    }
    clients.push({
      id: entry.id, apiKey: entry.apiKey,
      games: [...new Set(entry.games.map((game) => getGameConfig(game).key))],
      callbackOrigins: parseOrigins(entry.callbackOrigins),
    });
  }
  if (!clients.length) throw new Error('Configure BOT_API_KEY or BOT_CLIENTS_JSON.');
  if (new Set(clients.map((client) => client.id)).size !== clients.length
    || new Set(clients.map((client) => client.apiKey)).size !== clients.length) {
    throw new Error('Bot client ids and API keys must be unique.');
  }
  return clients;
}

function authenticateClient(clients, key) {
  if (typeof key !== 'string' || !key) return null;
  const received = Buffer.from(key);
  return clients.find((client) => {
    const expected = Buffer.from(client.apiKey);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }) || null;
}

function authorizeGame(client, game) {
  if (!client.games.includes(game.key)) {
    throw Object.assign(new Error('This game is not enabled for this store.'), { statusCode: 403 });
  }
}

function validateCallback(callbackUrl, client) {
  const url = parseHttpsUrl(callbackUrl);
  if (url.pathname !== '/api/steam/offer-state-changed'
    || (client.callbackOrigins && !client.callbackOrigins.includes(url.origin))) {
    throw invalid('Callback URL is not allowed for this store.');
  }
  return url.toString();
}

function validateOfferRequest(body, client) {
  const { steamId, tradeUrl, assetids, callbackUrl, game = 'cs2' } = body || {};
  validateSteamId(steamId);
  const gameConfig = getGameConfig(game);
  authorizeGame(client, gameConfig);
  const trade = parseHttpsUrl(tradeUrl);
  const partners = trade.searchParams.getAll('partner');
  const tokens = trade.searchParams.getAll('token');
  if (trade.hostname !== 'steamcommunity.com' || trade.pathname !== '/tradeoffer/new/'
    || partners.length !== 1 || !/^\d{1,10}$/.test(partners[0])
    || BigInt(partners[0]) + 76561197960265728n !== BigInt(steamId)
    || tokens.length !== 1 || !/^[A-Za-z0-9_-]{8}$/.test(tokens[0])) {
    throw invalid('The Steam trade URL must belong to the requested user.');
  }
  if (!Array.isArray(assetids) || !assetids.length || assetids.length > 50
    || assetids.some((id) => typeof id !== 'string' || !/^\d{1,20}$/.test(id))
    || new Set(assetids).size !== assetids.length) {
    throw invalid('Select between 1 and 50 unique asset IDs.');
  }
  return { steamId, tradeUrl: trade.toString(), assetids, gameConfig,
    callbackUrl: validateCallback(callbackUrl, client) };
}

function isSellableItem(item, game) {
  return Number(item.appid) === game.appId && String(item.contextid) === String(game.contextId)
    && item.tradable === true && Number.isInteger(item.amount) && item.amount > 0
    && typeof item.market_hash_name === 'string' && item.market_hash_name.trim().length > 0;
}

function belongsToStoreOffer(offer, metadata, steamId, game, clientId, callbackUrl) {
  if (!metadata || (metadata.clientId || 'legacy') !== clientId) return false;
  try {
    if (new URL(metadata.callbackUrl).origin !== new URL(callbackUrl).origin) return false;
  } catch { return false; }
  return String(offer.partner.getSteamID64()) === steamId
    && (!metadata.game || metadata.game === game.key)
    && Array.isArray(offer.itemsToGive) && offer.itemsToGive.length === 0
    && Array.isArray(offer.itemsToReceive) && offer.itemsToReceive.length > 0
    && offer.itemsToReceive.every((item) => Number(item.appid) === game.appId
      && String(item.contextid) === String(game.contextId));
}

module.exports = { GAMES, getGameConfig, validateSteamId, loadClients, authenticateClient,
  authorizeGame, validateCallback, validateOfferRequest, isSellableItem, belongsToStoreOffer };
