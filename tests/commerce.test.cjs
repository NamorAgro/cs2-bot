const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getGameConfig, loadClients, authenticateClient, validateOfferRequest,
  belongsToStoreOffer, isSellableItem } = require('../lib/commerce');
const { loadInventory } = require('../lib/inventory');
const { steamId, client, legacy, body, callbackUrl, page } = require('./helpers.cjs');

test('Dota, CS2 and Rust resolve to distinct Steam inventories; unknown/prototype games fail', () => {
  assert.equal(getGameConfig().appId, 730);
  assert.equal(getGameConfig('rust').appId, 252490);
  assert.equal(getGameConfig('dota2').appId, 570);
  for (const value of ['__proto__', 'constructor', 'dota', null, {}, '']) assert.throws(() => getGameConfig(value));
});

test('separate store credentials coexist with the unchanged legacy key', () => {
  const clients = loadClients({ BOT_API_KEY: legacy.apiKey, BOT_CLIENTS_JSON: JSON.stringify([client]) });
  assert.equal(authenticateClient(clients, legacy.apiKey).id, 'legacy');
  assert.equal(authenticateClient(clients, client.apiKey).id, 'dotaskin');
  assert.equal(authenticateClient(clients, 'wrong'), null);
  assert.equal(authenticateClient(clients, [client.apiKey]), null);
  assert.throws(() => loadClients({ BOT_CLIENTS_JSON: JSON.stringify([client, client]) }));
  assert.throws(() => loadClients({ BOT_CLIENTS_JSON: 'invalid json' }));
});

test('offer validation binds game, callback, Steam account and unique assets', () => {
  assert.equal(validateOfferRequest(body, client).gameConfig.appId, 570);
  for (const override of [
    { steamId: 'bad' }, { game: 'rust' }, { assetids: ['100', '100'] }, { assetids: [100] },
    { assetids: Array.from({ length: 51 }, (_, i) => String(i + 1)) },
    { tradeUrl: body.tradeUrl.replace('partner=', 'partner=1') },
    { tradeUrl: body.tradeUrl.replace('steamcommunity.com', 'example.com') },
    { callbackUrl: callbackUrl.replace('www.dotaskin.io', 'evil.example') },
    { callbackUrl: callbackUrl.replace('https:', 'http:') },
    { callbackUrl: 'https://www.dotaskin.io/not-a-callback' },
  ]) assert.throws(() => validateOfferRequest({ ...body, ...override }, client));
});

test('inventory paginates, merges descriptions, deduplicates assets and excludes locked items', async () => {
  const first = page(570, '100');
  first.more_items = 1; first.last_assetid = '100';
  const second = page(570, '200', 0);
  second.assets.push(first.assets[0]);
  const urls = [];
  const items = await loadInventory(steamId, getGameConfig('dota2'), async (url) => {
    urls.push(url); return urls.length === 1 ? first : second;
  });
  assert.equal(items.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get('start_assetid'), '100');
  assert.equal(items[0].market_hash_name, 'Item 100');
  assert.equal(items.filter((item) => isSellableItem(item, getGameConfig('dota2'))).length, 1);
});

test('Steam inventory rejects failed responses, foreign games, and pagination loops', async () => {
  const game = getGameConfig('dota2');
  await assert.rejects(loadInventory(steamId, game, async () => ({ success: 0 })));
  await assert.rejects(loadInventory(steamId, game, async () => page(730)), /outside/);
  await assert.rejects(loadInventory(steamId, game, async () => ({ ...page(), more_items: 1, last_assetid: '100' })), /advance/);
  const missing = page(); missing.descriptions = [];
  const [item] = await loadInventory(steamId, game, async () => missing);
  assert.equal(isSellableItem(item, game), false);
});

test('cancel selection is isolated by user, store, game, and buyback direction', () => {
  const offer = { partner: { getSteamID64: () => steamId }, itemsToGive: [], itemsToReceive: [{ appid: 570, contextid: '2' }] };
  const metadata = { callbackUrl, game: 'dota2', clientId: client.id };
  const belongs = (o = offer, m = metadata) => belongsToStoreOffer(o, m, steamId, getGameConfig('dota2'), client.id, callbackUrl);
  assert.equal(belongs(), true);
  assert.equal(belongs(offer, null), false);
  assert.equal(belongs(offer, { ...metadata, clientId: 'rust-store' }), false);
  assert.equal(belongs(offer, { ...metadata, callbackUrl: 'https://other.example' }), false);
  assert.equal(belongs({ ...offer, itemsToReceive: [{ appid: 730, contextid: '2' }] }), false);
  assert.equal(belongs({ ...offer, itemsToGive: [{ appid: 570 }] }), false);
  assert.equal(belongs({ ...offer, partner: { getSteamID64: () => '76561198000000000' } }), false);
});
