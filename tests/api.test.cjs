// Execute the real route handlers with Steam, Express, curl, timers and fetch replaced.
// This harness never loads .env, real maFiles, or opens network connections.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { createCallbackStore } = require('../lib/callbacks');
const { steamId, body, callbackUrl, client, legacy, quiet, page, tempDirectory } = require('./helpers.cjs');
const botFile = path.join(__dirname, '..', 'bot.js');
const actualRequire = createRequire(botFile);

function harness(t, options = {}) {
  const directory = tempDirectory(t);
  const routes = new Map(); const middlewares = []; const urls = []; const sent = []; const notifications = [];
  let steam, manager, callbackStore;
  class User extends EventEmitter {
    constructor() { super(); steam = this; this.steamID = 'mock-bot'; }
    logOn() { throw new Error('Tests must not log in to Steam.'); }
    setPersona() {}
  }
  User.EPersonaState = { Online: 1 };
  class Community {
    setCookies() {}
    acknowledgeTradeProtection(callback) { callback(null); }
  }
  class Manager extends EventEmitter {
    constructor(config) { super(); manager = this; this.config = config; }
    setCookies(_, callback) { callback(null); }
    getOffers(_, callback) { callback(null, options.activeOffers || [], []); }
    createOffer() {
      const data = {};
      const offer = {
        id: undefined, itemsToGive: [],
        data(key, value) { if (arguments.length === 2) data[key] = value; return data[key]; },
        addTheirItems(items) { this.itemsToReceive = items; },
        setMessage(message) { this.message = message; },
        send(callback) {
          sent.push(this);
          if (options.sendError) return callback(new Error('simulated timeout'));
          this.id = String(1000 + sent.length);
          if (options.deferSend) options.deferSend(() => callback(null, 'sent'));
          else callback(null, 'sent');
        },
      };
      return offer;
    }
  }
  Manager.EOfferFilter = { ActiveOnly: 1 };
  Manager.ETradeOfferState = { Active: 2, Accepted: 3, Expired: 5, Canceled: 6, Declined: 7, InvalidItems: 8, CanceledBySecondFactor: 10, InEscrow: 11 };
  const execFile = () => { throw new Error('Synchronous curl invocation is forbidden in tests.'); };
  execFile[promisify.custom] = async (_, args) => {
    const url = args.at(-1); urls.push(url);
    const appid = Number(new URL(url).pathname.split('/')[3]);
    return { stdout: JSON.stringify(options.inventory ? await options.inventory(url) : page(appid, '100', 1, '5')) };
  };
  const express = () => ({ use: (handler) => middlewares.push(handler), post: (route, handler) => routes.set(route, handler), listen() {} });
  express.json = () => () => {};
  const mockedFs = { ...fs,
    existsSync: (filename) => filename.endsWith('bot.maFile') || fs.existsSync(filename),
    readFileSync: (filename, encoding) => filename.endsWith('bot.maFile')
      ? JSON.stringify({ account_name: 'offline-test', shared_secret: 'test' }) : fs.readFileSync(filename, encoding),
  };
  const mocks = { express, fs: mockedFs, 'steam-user': User, steamcommunity: Community,
    'steam-totp': { generateAuthCode: () => 'TEST' }, 'steam-tradeoffer-manager': Manager,
    'node:child_process': { execFile }, './lib/callbacks': {
      createCallbackStore(config) {
        callbackStore = createCallbackStore({ ...config, logger: quiet, fetchImpl: async (url, request) => {
          notifications.push({ url, request }); return { ok: true, json: async () => ({ ok: true }) };
        } });
        return callbackStore;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(botFile, 'utf8'), {
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : actualRequire(name), __dirname: directory,
    process: { env: { BOT_API_KEY: legacy.apiKey, STEAM_BOT_PASSWORD: 'offline', BOT_CLIENTS_JSON: JSON.stringify([client]) },
      loadEnvFile() {}, exit() { throw new Error('Unexpected bot startup failure'); } },
    console: quiet, setInterval: () => ({ unref() {} }), setTimeout, clearTimeout, URL,
  }, { filename: botFile });
  steam.emit('webSession', 'offline', []);
  async function request(route, requestBody, key = client.apiKey) {
    const req = { headers: { 'x-bot-api-key': key }, body: requestBody };
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    let authorized = false;
    middlewares[1](req, response, () => { authorized = true; });
    if (authorized) await routes.get(route)(req, response);
    return response;
  }
  return { request, manager, callbackStore, urls, sent, notifications };
}

for (const [game, appid] of [['dota2', 570], ['cs2', 730], ['rust', 252490]]) {
  test(`${game}: real API selects correct inventory, sends one unit and reports ACCEPTED`, async (t) => {
    const h = harness(t);
    const key = game === 'dota2' ? client.apiKey : legacy.apiKey;
    const inventory = await h.request('/get-inventory', { steamId, game }, key);
    assert.equal(inventory.statusCode, 200); assert.equal(inventory.body.items.length, 1);
    assert.ok(h.urls[0].includes(`/${appid}/2?`));
    const result = await h.request('/create-offer', { ...body, game }, key);
    assert.equal(result.statusCode, 200); assert.equal(result.body.ok, true);
    const offer = h.sent[0];
    assert.equal(offer.itemsToReceive[0].appid, appid);
    assert.equal(offer.itemsToReceive[0].contextid, '2');
    assert.equal(offer.itemsToReceive[0].amount, 1);
    assert.equal(offer.itemsToGive.length, 0);
    assert.ok(offer.message.includes(game === 'dota2' ? 'Dota 2' : game === 'cs2' ? 'CS2' : 'Rust'));
    offer.state = 3;
    await h.manager.listeners('sentOfferChanged')[0](offer);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].request.headers['x-bot-api-key'], key);
    assert.equal(JSON.parse(h.notifications[0].request.body).state, 'ACCEPTED');
    await h.manager.listeners('sentOfferChanged')[0](offer);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.manager.config.savePollData, true);
  });
}

test('inventory cache is partitioned by game, unavailable items never enter offers', async (t) => {
  const h = harness(t, { inventory: async (url) => page(Number(new URL(url).pathname.split('/')[3]), '100', 0) });
  for (const game of ['dota2', 'cs2', 'rust']) {
    const response = await h.request('/get-inventory', { steamId, game }, legacy.apiKey);
    assert.equal(response.body.count, 0);
  }
  assert.equal(h.urls.length, 3);
  await h.request('/get-inventory', { steamId, game: 'cs2' }, legacy.apiKey);
  assert.equal(h.urls.length, 3);
  const response = await h.request('/create-offer', body);
  assert.equal(response.statusCode, 409); assert.equal(h.sent.length, 0);
});

test('API rejects invalid auth, game and trade recipient before any Steam request', async (t) => {
  const h = harness(t);
  assert.equal((await h.request('/get-inventory', { steamId }, 'bad')).statusCode, 401);
  assert.equal((await h.request('/get-inventory', { steamId, game: '__proto__' })).statusCode, 400);
  assert.equal((await h.request('/get-inventory', { steamId, game: 'rust' })).statusCode, 403);
  assert.equal((await h.request('/create-offer', { ...body, tradeUrl: body.tradeUrl.replace('partner=', 'partner=1') })).statusCode, 400);
  assert.equal(h.urls.length, 0); assert.equal(h.sent.length, 0);
});

test('send timeout returns a non-2xx uncertain result and releases the inventory lock', async (t) => {
  const h = harness(t, { sendError: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await h.request('/create-offer', body);
    assert.equal(response.statusCode, 502); assert.match(response.body.error, /uncertain/);
  }
  assert.equal(h.sent.length, 2);
});

test('simultaneous requests for the same user inventory cannot send parallel offers', async (t) => {
  let finish;
  const h = harness(t, { deferSend: (resolve) => { finish = resolve; } });
  const first = h.request('/create-offer', body);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const second = await h.request('/create-offer', body);
  assert.equal(second.statusCode, 409); assert.equal(h.sent.length, 1);
  finish(); assert.equal((await first).statusCode, 200);
});

test('creating Dota offer cancels only that stores Dota buyback', async (t) => {
  const canceled = [];
  const make = (id, appid, metadata) => ({ id, state: 2, partner: { getSteamID64: () => steamId }, itemsToGive: [],
    itemsToReceive: [{ appid, contextid: '2' }], data: () => metadata, cancel: (cb) => { canceled.push(id); cb(null); } });
  const metadata = { callbackUrl, clientId: client.id, game: 'dota2' };
  const h = harness(t, { activeOffers: [make('1', 570, metadata), make('2', 730, metadata), make('3', 252490, metadata),
    make('4', 570, { ...metadata, clientId: 'other' }), make('5', 570, null)] });
  assert.equal((await h.request('/create-offer', body)).statusCode, 200);
  assert.deepEqual(canceled, ['1']);
});

test('failed cancellation prevents a replacement offer', async (t) => {
  const h = harness(t, { activeOffers: [{ id: 'old', state: 2,
    partner: { getSteamID64: () => steamId }, itemsToGive: [], itemsToReceive: [{ appid: 570, contextid: '2' }],
    data: () => ({ callbackUrl, game: 'dota2', clientId: client.id }),
    cancel: (callback) => callback(new Error('Steam unavailable')),
  }] });
  assert.equal((await h.request('/create-offer', body)).statusCode, 502);
  assert.equal(h.sent.length, 0);
});
