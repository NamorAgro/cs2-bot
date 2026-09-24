const fs = require('node:fs');
const { validateCallback } = require('./commerce');

function createCallbackStore({ filename, clients, fetchImpl = fetch, now = Date.now, logger = console }) {
  let records = {};
  try { records = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read offer-callbacks.json; restore it before starting the bot.'); }
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid offer callback storage.');
  const inFlight = new Set();

  function update(id, changes) {
    const next = { ...records, [String(id)]: { ...records[String(id)], ...changes } };
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filename);
    records = next;
  }

  function remember(id, metadata) {
    update(id, { ...metadata, createdAt: records[String(id)]?.createdAt || now() });
  }

  function enqueue(id, metadata, payload) {
    const previous = records[String(id)];
    // Once accepted, a later poll must not replace an undelivered credit notification.
    if (previous?.lastState === 'ACCEPTED' && payload.state !== 'ACCEPTED') return;
    if (previous?.lastState === payload.state && !previous.pending) return;
    update(id, { ...metadata, createdAt: previous?.createdAt || now(), lastState: payload.state,
      pending: { payload, attempts: 0, nextAttempt: now(), version: (previous?.version || 0) + 1 },
      version: (previous?.version || 0) + 1 });
  }

  async function deliver(id) {
    id = String(id);
    const record = records[id];
    const pending = record?.pending;
    if (!pending || pending.nextAttempt > now() || inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const client = clients.find((entry) => entry.id === (record.clientId || 'legacy'));
      if (!client) throw new Error('The originating store is not configured.');
      const callbackUrl = validateCallback(record.callbackUrl, client);
      const response = await fetchImpl(callbackUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'x-bot-api-key': client.apiKey },
        body: JSON.stringify(pending.payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(`Store callback failed (HTTP ${response.status}).`);
      if (records[id]?.pending?.version === pending.version) {
        update(id, { pending: null, deliveredAt: now() });
      }
      logger.log(`Offer ${id}: callback delivered to store ${client.id}.`);
    } catch (error) {
      if (records[id]?.pending?.version === pending.version) {
        const attempts = pending.attempts + 1;
        update(id, { pending: { ...pending, attempts,
          nextAttempt: now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)) } });
      }
      // URLs and API keys are deliberately absent from logs.
      logger.error(`Offer ${id}: callback pending retry: ${error.message}`);
    } finally { inFlight.delete(id); }
  }

  async function retryPending() {
    // Keep callback traffic bounded when recovering after an outage.
    const ids = Object.keys(records).filter((id) => records[id]?.pending?.nextAttempt <= now());
    for (let offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map(deliver));
    }
  }

  return { remember, enqueue, deliver, retryPending, get: (id) => records[String(id)] || null };
}

module.exports = { createCallbackStore };
