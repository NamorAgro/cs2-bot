const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCallbackStore } = require('../lib/callbacks');
const { client, legacy, callbackUrl, quiet, tempDirectory } = require('./helpers.cjs');
const metadata = { clientId: client.id, game: 'dota2', callbackUrl };
const payload = { offerId: '1000', state: 'ACCEPTED', rawState: 3 };

test('failed callback survives restart and retries with the originating store key', async (t) => {
  const filename = path.join(tempDirectory(t), 'offer-callbacks.json');
  let time = 1000;
  const options = { filename, clients: [legacy, client], now: () => time, logger: quiet };
  const store = createCallbackStore({ ...options, fetchImpl: async () => { throw new Error('offline'); } });
  store.remember('1000', metadata); store.enqueue('1000', metadata, payload);
  await store.deliver('1000');
  assert.equal(store.get('1000').pending.attempts, 1);
  let called = 0;
  const restarted = createCallbackStore({ ...options, fetchImpl: async (url, request) => {
    called++;
    assert.equal(url, callbackUrl);
    assert.equal(request.headers['x-bot-api-key'], client.apiKey);
    assert.equal(request.redirect, 'error');
    assert.deepEqual(JSON.parse(request.body), payload);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  await restarted.retryPending(); assert.equal(called, 0);
  time += 5000;
  await restarted.retryPending(); assert.equal(called, 1);
  assert.equal(restarted.get('1000').pending, null);
  restarted.enqueue('1000', metadata, payload);
  await restarted.deliver('1000'); assert.equal(called, 1);
  assert.equal(fs.readFileSync(filename, 'utf8').includes(client.apiKey), false);
});

test('legacy callback map remains readable and uses the legacy key', async (t) => {
  const filename = path.join(tempDirectory(t), 'offer-callbacks.json');
  fs.writeFileSync(filename, JSON.stringify({ 1000: { callbackUrl, createdAt: 100 } }));
  const store = createCallbackStore({ filename, clients: [legacy, client], logger: quiet, fetchImpl: async (_, request) => {
    assert.equal(request.headers['x-bot-api-key'], legacy.apiKey);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  store.enqueue('1000', store.get('1000'), payload);
  await store.deliver('1000');
  assert.equal(store.get('1000').createdAt, 100);
  assert.equal(store.get('1000').pending, null);
});

test('an in-flight older state cannot clear a newer accepted notification', async (t) => {
  const filename = path.join(tempDirectory(t), 'offer-callbacks.json');
  let finish;
  const store = createCallbackStore({ filename, clients: [client], logger: quiet, fetchImpl: () => new Promise((resolve) => { finish = resolve; }) });
  store.enqueue('1000', metadata, { ...payload, state: 'ESCROW', rawState: 11 });
  const first = store.deliver('1000');
  store.enqueue('1000', metadata, payload);
  finish({ ok: true, json: async () => ({ ok: true }) }); await first;
  assert.equal(store.get('1000').pending.payload.state, 'ACCEPTED');
  store.enqueue('1000', metadata, { ...payload, state: 'ESCROW' });
  assert.equal(store.get('1000').pending.payload.state, 'ACCEPTED');
});

test('unknown store or disallowed callback never receives a key; corrupt storage fails visibly', async (t) => {
  const filename = path.join(tempDirectory(t), 'offer-callbacks.json');
  let requests = 0;
  const store = createCallbackStore({ filename, clients: [client], logger: quiet, fetchImpl: async () => { requests++; } });
  store.enqueue('1', { ...metadata, clientId: 'removed' }, { ...payload, offerId: '1' });
  store.enqueue('2', { ...metadata, callbackUrl: 'https://evil.example/api/steam/offer-state-changed' }, { ...payload, offerId: '2' });
  await store.retryPending(); assert.equal(requests, 0);
  assert.equal(store.get('1').pending.attempts, 1);
  fs.writeFileSync(filename, 'broken');
  assert.throws(() => createCallbackStore({ filename, clients: [client] }), /Cannot read/);
});
