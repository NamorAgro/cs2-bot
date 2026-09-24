const express = require('express');
const fs = require('fs');
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const { getGameConfig, validateSteamId, loadClients, authenticateClient, authorizeGame,
  validateOfferRequest, isSellableItem, belongsToStoreOffer } = require('./lib/commerce');
const { loadInventory } = require('./lib/inventory');
const { createCallbackStore } = require('./lib/callbacks');

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

// ================== AGEENT ========================


const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);


// ================== CONFIG & ENV ==================

const botClients = loadClients(process.env);
const STEAM_BOT_PASSWORD = process.env.STEAM_BOT_PASSWORD;



if (!STEAM_BOT_PASSWORD) {
  console.error('❌ STEAM_BOT_PASSWORD is not set in .env');
  process.exit(1);
}

const inventoryCache = new Map();
const inventoryRequests = new Map();

const INVENTORY_CACHE_TTL = 30_000;

function getInventoryKey(steamId, gameConfig) {
  return `${gameConfig.key}:${steamId}`;
}

// ================== STEAM AUTH ==================
const OFFER_MAP_PATH = path.join(__dirname, 'offer-callbacks.json');
const callbacks = createCallbackStore({ filename: OFFER_MAP_PATH, clients: botClients });
const creatingOffers = new Set();

function getOfferMetadata(offer) {
  return callbacks.get(offer.id) || offer.data('storeContext') || null;
}

let isBotReady = false;
let refreshPromise = null;
let loginInProgress = false;
let reconnectTimer = null;



function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (!client.steamID) {
      console.log('🔁 Reconnecting to Steam...');
      steamLogin();
    }
  }, 15000);
}

function cancelActiveOffersToUser(steamId, gameConfig, botClient, callbackUrl) {
  return new Promise((resolve, reject) => {
    manager.getOffers(
      TradeOfferManager.EOfferFilter.ActiveOnly,
      (err, sentOffers, receivedOffers) => {
        if (err) return reject(err);

        const activeOffers = sentOffers.filter((offer) => {
          return (
            offer.state === TradeOfferManager.ETradeOfferState.Active &&
            belongsToStoreOffer(offer, getOfferMetadata(offer), steamId, gameConfig, botClient.id, callbackUrl)
          );
        });

        if (!activeOffers.length) {
          return resolve(0);
        }

        let finished = 0;
        let canceled = 0;

        activeOffers.forEach((offer) => {
          offer.cancel((cancelErr) => {
            finished++;

            if (cancelErr) {
              console.error(`❌ Failed to cancel offer ${offer.id}:`, cancelErr.message);
              reject(new Error('An earlier offer could not be canceled; no new offer was sent.'));
            } else {
              canceled++;
              console.log(`🚫 Canceled old active offer ${offer.id}`);
            }

            if (finished === activeOffers.length) {
              resolve(canceled);
            }
          });
        });
      }
    );
  });
}

function steamLogin() {
  if (loginInProgress) {
    console.log('⏳ Steam login already in progress, skipping...');
    return;
  }

  if (client.steamID) {
    console.log('✅ Already connected to Steam network, skipping login...');
    return;
  }

  loginInProgress = true;

  console.log('🔐 Logging in as', accountName, '...');

  try {
    client.logOn({
      accountName,
      password: STEAM_BOT_PASSWORD,
      twoFactorCode: getTwoFactorCode()
    });
  } catch (err) {
    loginInProgress = false;
    isBotReady = false;

    console.error('❌ Steam error:', err);

    scheduleReconnect();
  }
}

async function safeRefreshWebSession() {
  if (!client.steamID) {
    isBotReady = false;
    throw new Error('Bot is not connected to Steam network yet');
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = refreshWebSession().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function getPublicSteamInventory(steamId, appId, contextId) {
  return loadInventory(steamId, { appId, contextId }, async (url) => {
    let stdout;
    try {
      ({ stdout } = await execFileAsync('curl', [
        '--silent', '--show-error', '--fail-with-body', '--max-time', '15',
        '--connect-timeout', '5', '--header', 'Accept: application/json',
        '--header', 'User-Agent: Mozilla/5.0', url,
      ], { maxBuffer: 20 * 1024 * 1024 }));
    } catch (error) {
      const match = String(error.stderr || '').match(/The requested URL returned error: (\d+)/);
      const status = match ? Number(match[1]) : null;
      throw Object.assign(new Error(status ? `Steam inventory HTTP error ${status}` : 'Steam inventory request failed.'), { code: status });
    }
    try { return JSON.parse(stdout); }
    catch { throw new Error('Steam returned invalid inventory JSON'); }
  });
}

async function getUserInventoryWithRetry(
  steamId,
  gameConfig,
  options = {}
) {
  const { forceRefresh = false } = options;
  const key = getInventoryKey(steamId, gameConfig);

  if (!forceRefresh) {
    const cached = inventoryCache.get(key);

    if (
      cached &&
      Date.now() - cached.createdAt < INVENTORY_CACHE_TTL
    ) {
      console.log(
        `♻️ Returning cached ${gameConfig.name} inventory for ${steamId}`
      );

      return cached.inventory;
    }
  }

  const existingRequest = inventoryRequests.get(key);

  if (existingRequest) {
    console.log(
      `🔗 Joining existing ${gameConfig.name} inventory request for ${steamId}`
    );

    return existingRequest;
  }

  const request = getPublicSteamInventory(
    steamId,
    gameConfig.appId,
    gameConfig.contextId
  )
    .then((inventory) => {
      inventoryCache.set(key, {
        createdAt: Date.now(),
        inventory,
      });

      return inventory;
    })
    .finally(() => {
      inventoryRequests.delete(key);
    });

  inventoryRequests.set(key, request);

  return request;
}

function refreshWebSession() {
  return new Promise((resolve, reject) => {
    if (!client.steamID) {
      isBotReady = false;
      return reject(new Error('Bot is not connected to Steam network yet'));
    }

    console.log('🔄 Refreshing Steam web session...');

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;

      settled = true;
      client.removeListener('webSession', onWebSession);

      reject(new Error('Timeout while refreshing Steam web session'));
    }, 15000);

    const onWebSession = (sessionId, cookies) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      community.setCookies(cookies);

      manager.setCookies(cookies, (err) => {
        if (err) {
          isBotReady = false;
          return reject(err);
        }

        isBotReady = true;
        console.log('✅ TradeOfferManager cookies refreshed');

        resolve();
      });
    };

    client.once('webSession', onWebSession);
    client.webLogOn();
  });
}

const maFilePath = path.join(__dirname, 'lib', 'secrets', 'bot.maFile');

if (!fs.existsSync(maFilePath)) {
  console.error('❌ maFile not found at', maFilePath);
  process.exit(1);
}

const maDataRaw = fs.readFileSync(maFilePath, 'utf8');
const maData = JSON.parse(maDataRaw);

const accountName = maData.account_name;
const sharedSecret = maData.shared_secret;

const client = new SteamUser();
const community = new SteamCommunity();

const manager = new TradeOfferManager({
  steam: client,
  community: community,
  language: 'en',
  savePollData: true,
});

function getTwoFactorCode() {
  return SteamTotp.generateAuthCode(sharedSecret);
}

const logOnOptions = {
  accountName,
  password: STEAM_BOT_PASSWORD,
  twoFactorCode: getTwoFactorCode()
};

steamLogin();

client.on('loggedOn', () => {
  loginInProgress = false;

  console.log('✅ Bot logged in to Steam!');
  client.setPersona(SteamUser.EPersonaState.Online);
});

client.on('error', (err) => {
  loginInProgress = false;
  isBotReady = false;

  console.error('❌ Steam error:', err);

  scheduleReconnect();
});

client.on('webSession', (sessionId, cookies) => {
  console.log('🌐 Got web session, cookies count:', cookies.length);

  community.setCookies(cookies);

  manager.setCookies(cookies, (err) => {
    if (err) {
      isBotReady = false;
      console.error('❌ Error setting manager cookies:', err);
      return;
    }

    community.acknowledgeTradeProtection((ackErr) => {
      if (ackErr) {
        isBotReady = false;
        console.error('❌ Trade protection error:', ackErr);
        return;
      }

      isBotReady = true;
      console.log('✅ Trade protection acknowledged');
      console.log('✅ TradeOfferManager is ready');
    });
  });
});


setInterval(async () => {
  if (!client.steamID) {
    console.warn('⚠ Cannot refresh web session: bot is not connected');
    isBotReady = false;
    loginInProgress = false;
    scheduleReconnect();
    return;
  }

  try {
    await safeRefreshWebSession();
    console.log('✅ Scheduled Steam web session refresh complete');
  } catch (err) {
    console.error('❌ Scheduled Steam web session refresh failed:', err.message);
    isBotReady = false;
    scheduleReconnect();
  }
}, 1000 * 60 * 60 * 12);


client.on('disconnected', (eresult, msg) => {
  loginInProgress = false;
  isBotReady = false;

  console.error('🔌 Steam disconnected:', eresult, msg);

  scheduleReconnect();
});

client.on('loggedOff', (eresult) => {
  loginInProgress = false;
  isBotReady = false;

  console.error('🚪 Steam logged off:', eresult);

  scheduleReconnect();
});

// ================== EXPRESS API ==================

const app = express();
app.use(express.json());


app.use((req, res, next) => {
  const providedKey = req.headers['x-bot-api-key'];
  req.botClient = authenticateClient(botClients, providedKey);

  if (!req.botClient) {
    console.warn('⚠ Unauthorized bot API request', {
      time: new Date().toISOString(),
      ip: req.ip,
      method: req.method,
      path: req.originalUrl,
      userAgent: req.headers['user-agent'],
      hasKey: Boolean(providedKey),
    });

    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
  }

  next();
});

// ---- /get-inventory ----
app.post('/get-inventory', async (req, res) => {
  try {
    const { steamId, game = 'cs2' } = req.body || {};
    validateSteamId(steamId);
    const gameConfig = getGameConfig(game);
    authorizeGame(req.botClient, gameConfig);

    if (!client.steamID || !isBotReady) {
      return res.status(503).json({
        ok: false,
        error: 'Steam bot is not ready.',
      });
    }

    console.log(`📦 Request ${gameConfig.name} inventory for steamId: ${steamId}`);

    const inventory = await getUserInventoryWithRetry(
      steamId,
      gameConfig
    );

    if (!inventory.length) {
      return res.json({
        ok: true,
        game: gameConfig.key,
        count: 0,
        items: [],
        message: `No ${gameConfig.name} items available for sale.`,
      });
    }

    const mapped = inventory.filter((item) => isSellableItem(item, gameConfig)).map((item) => ({
      assetid: item.assetid,
      classid: item.classid,
      market_hash_name: item.market_hash_name,
      icon: item.icon_url
        ? `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}`
        : null,
    }));

    return res.json({
      ok: true,
      game: gameConfig.key,
      count: mapped.length,
      items: mapped
    });

  } catch (err) {
    console.error('❌ Error loading user inventory:', err);

    if (err.statusCode) return res.status(err.statusCode).json({ ok: false, error: err.message });

    const status = Number(err.code);

    if (status === 429) {
      return res.status(429).json({
        ok: false,
        error: 'Steam rate limit. Try again later.',
      });
    }

    if (status === 403) {
      return res.status(403).json({
        ok: false,
        error: 'Steam inventory is private or unavailable.',
      });
    }

    return res.status(502).json({
      ok: false,
      error: err.message || 'Unable to load Steam inventory.',
    });
  }
});

// ---- /create-offer ----
app.post('/create-offer', async (req, res) => {
  let lockKey;
  let sendStarted = false;
  try {
    const { steamId, tradeUrl, assetids, callbackUrl, gameConfig } = validateOfferRequest(req.body, req.botClient);
    // Serialize offers for the same inventory, including requests from different stores.
    lockKey = getInventoryKey(steamId, gameConfig);
    if (creatingOffers.has(lockKey)) {
      lockKey = null;
      return res.status(409).json({ ok: false, error: 'Another offer is being created for this inventory.' });
    }
    creatingOffers.add(lockKey);

    if (!client.steamID) {
      return res.status(503).json({ ok: false, error: 'Steam bot is disconnected from Steam network.' });
    }
    if (!isBotReady) await safeRefreshWebSession();

    const inventory = await getUserInventoryWithRetry(steamId, gameConfig, { forceRefresh: true });
    const selectedAssetIds = new Set(assetids);
    const itemsToTake = inventory.filter((item) => selectedAssetIds.has(item.assetid) && isSellableItem(item, gameConfig));
    if (itemsToTake.length !== selectedAssetIds.size) {
      const found = new Set(itemsToTake.map((item) => item.assetid));
      return res.status(409).json({ ok: false,
        error: 'Some selected items are no longer available or are not tradable.',
        missingAssetIds: assetids.filter((id) => !found.has(id)),
      });
    }

    await cancelActiveOffersToUser(steamId, gameConfig, req.botClient, callbackUrl);
    const offer = manager.createOffer(tradeUrl);
    offer.addTheirItems(itemsToTake.map((item) => ({
      appid: gameConfig.appId, contextid: String(gameConfig.contextId), assetid: item.assetid,
      // The storefront quotes one unit per asset ID, including stackable Dota items.
      amount: 1,
    })));
    offer.setMessage(`Выкуп ваших ${gameConfig.name} скинов на нашем сайте`);
    const metadata = { callbackUrl, game: gameConfig.key, clientId: req.botClient.id };
    // TradeOfferManager persists custom data in pollData as soon as the offer has an ID.
    offer.data('storeContext', metadata);
    sendStarted = true;
    const status = await new Promise((resolve, reject) => {
      offer.send((error, result) => error ? reject(error) : resolve(result));
    });
    callbacks.remember(String(offer.id), metadata);
    inventoryCache.delete(lockKey);
    console.log(`Offer ${offer.id} sent: game=${gameConfig.key}, store=${req.botClient.id}, status=${status}`);
    return res.json({ ok: true, offerId: offer.id, status });
  } catch (error) {
    // An error after send() is not proof that Steam rejected the offer. The storefront
    // keeps non-2xx responses pending until an authoritative callback arrives.
    console.error(`Create offer failed: ${error.message}`);
    return res.status(error.statusCode || 502).json({ ok: false,
      error: sendStarted ? 'Steam offer result is uncertain; await its status callback.' : error.message,
    });
  } finally {
    if (lockKey) creatingOffers.delete(lockKey);
  }
});

// ================== OFFER STATUS CALLBACKS ==================
manager.on('sentOfferChanged', async (offer) => {
  try {
    const E = TradeOfferManager.ETradeOfferState;
    const states = {
      [E.Accepted]: 'ACCEPTED', [E.Canceled]: 'CANCELED', [E.Declined]: 'DECLINED',
      [E.Expired]: 'EXPIRED', [E.InEscrow]: 'ESCROW', [E.InvalidItems]: 'CANCELED',
      [E.CanceledBySecondFactor]: 'CANCELED',
    };
    const state = states[offer.state];
    if (!state) return;
    const metadata = getOfferMetadata(offer);
    if (!metadata) {
      console.warn(`Offer ${offer.id}: no originating store; callback skipped.`);
      return;
    }
    callbacks.enqueue(String(offer.id), metadata, { offerId: String(offer.id), state, rawState: offer.state });
    await callbacks.deliver(String(offer.id));
  } catch (error) {
    console.error(`Offer ${offer.id}: cannot save or deliver status: ${error.message}`);
  }
});

const retryCallbacks = () => callbacks.retryPending().catch((error) => {
  console.error(`Callback retry failed: ${error.message}`);
});
setInterval(retryCallbacks, 15000).unref();
void retryCallbacks();

// ================== START SERVER ==================

const PORT = process.env.PORT || 3002;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Bot API running on http://127.0.0.1:${PORT}`);
});
