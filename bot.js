require('dotenv').config();


const express = require('express');
const fs = require('fs');
const path = require('path');

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

// ================== AGEENT ========================

const { Agent } = require('undici');

const steamAgent = new Agent({
  connect: {
    family: 4,
  },
});


const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);


// ================== CONFIG & ENV ==================

const API_BASE_URL = process.env.API_BASE_URL;
const BOT_API_KEY = process.env.BOT_API_KEY;
const STEAM_BOT_PASSWORD = process.env.STEAM_BOT_PASSWORD;



if (!API_BASE_URL) {
  console.error('❌ API_BASE_URL is not set in .env');
  process.exit(1);
}

if (!BOT_API_KEY) {
  console.error('❌ BOT_API_KEY is not set in .env');
  process.exit(1);
}

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

// ================== GAME CONFG ==================

const GAMES = {
  cs2: {
    key: 'cs2',
    appId: 730,
    contextId: 2,
    name: 'CS2',
  },
  rust: {
    key: 'rust',
    appId: 252490,
    contextId: 2,
    name: 'Rust',
  },
};

function getGameConfig(game) {
  const key = String(game || 'cs2').toLowerCase();

  if (!GAMES[key]) {
    throw new Error(`Unsupported game: ${game}`);
  }

  return GAMES[key];
}


// ================== STEAM AUTH ==================
const OFFER_MAP_PATH = path.join(__dirname, 'offer-callbacks.json');

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

function cancelActiveOffersToUser(steamId) {
  return new Promise((resolve, reject) => {
    manager.getOffers(
      TradeOfferManager.EOfferFilter.ActiveOnly,
      (err, sentOffers, receivedOffers) => {
        if (err) return reject(err);

        const activeOffers = sentOffers.filter((offer) => {
          return (
            String(offer.partner.getSteamID64()) === String(steamId) &&
            offer.state === TradeOfferManager.ETradeOfferState.Active
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

function requestUserInventory(steamId, gameConfig) {
  return new Promise((resolve, reject) => {
    manager.getUserInventoryContents(
      steamId,
      gameConfig.appId,
      gameConfig.contextId,
      true,
      async (err, inventory) => {
        if (!err) {
          return resolve(inventory);
        }

        console.error(
          `❌ ${gameConfig.name} inventory error:`,
          err.message
        );

        const msg = String(err.message || '');
        const code = Number(err.code);

        if (
          code === 401 ||
          msg.includes('Not Logged In') ||
          msg.includes('Cannot log onto steamcommunity') ||
          msg.includes('HTTP error 401')
        ) {
          try {
            console.log(
              '🔄 Trying to refresh Steam web session after inventory error...'
            );

            await safeRefreshWebSession();

            manager.getUserInventoryContents(
              steamId,
              gameConfig.appId,
              gameConfig.contextId,
              true,
              (retryErr, retryInventory) => {
                if (retryErr) {
                  return reject(retryErr);
                }

                resolve(retryInventory);
              }
            );
          } catch (refreshErr) {
            reject(refreshErr);
          }

          return;
        }

        reject(err);
      }
    );
  });
}

async function getPublicSteamInventory(
  steamId,
  appId = 730,
  contextId = 2
) {
  const url =
    `https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}` +
    `?l=english&count=500`;

  let stdout;

  try {
    const result = await execFileAsync(
      'curl',
      [
        '--silent',
        '--show-error',
        '--fail-with-body',
        '--max-time',
        '15',
        '--connect-timeout',
        '5',
        '--header',
        'Accept: application/json',
        '--header',
        'User-Agent: Mozilla/5.0',
        url,
      ],
      {
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    stdout = result.stdout;
  } catch (err) {
    const statusMatch = String(err.stderr || '').match(
      /The requested URL returned error: (\d+)/
    );

    const status = statusMatch
      ? Number(statusMatch[1])
      : null;

    const error = new Error(
      status
        ? `Steam inventory HTTP error ${status}`
        : `Steam inventory request failed: ${err.message}`
    );

    error.code = status;
    throw error;
  }

  let data;

  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('Steam returned invalid inventory JSON');
  }

  if (data.success === false) {
    throw new Error('Steam inventory response was unsuccessful');
  }

  const descriptionsMap = new Map();

  for (const description of data.descriptions ?? []) {
    const key =
      `${description.classid}_${description.instanceid}`;

    descriptionsMap.set(key, description);
  }

  return (data.assets ?? []).map((asset) => {
    const key = `${asset.classid}_${asset.instanceid}`;
    const description = descriptionsMap.get(key);

    return {
      appid: Number(asset.appid),
      contextid: String(asset.contextid),
      assetid: String(asset.assetid),
      amount: Number(asset.amount ?? 1),

      classid: String(asset.classid),
      instanceid: String(asset.instanceid),

      market_hash_name:
        description?.market_hash_name ?? 'Unknown item',

      name:
        description?.name ?? 'Unknown item',

      icon_url:
        description?.icon_url ?? null,

      tradable:
        description?.tradable === 1,
    };
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

function loadOfferMap() {
  try {
    return JSON.parse(fs.readFileSync(OFFER_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveOfferMap(map) {
  fs.writeFileSync(OFFER_MAP_PATH, JSON.stringify(map, null, 2));
}

function setOfferCallback(offerId, callbackUrl) {
  const map = loadOfferMap();
  map[String(offerId)] = { callbackUrl, createdAt: Date.now() };
  saveOfferMap(map);
}

function getOfferCallback(offerId) {
  const map = loadOfferMap();
  return map[String(offerId)]?.callbackUrl || null;
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
  language: 'en'
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

  if (providedKey !== process.env.BOT_API_KEY) {
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
    const { steamId, game = 'cs2' } = req.body;

    if (!steamId) {
      return res.json({ ok: false, error: 'steamId required' });
    }

    const gameConfig = getGameConfig(game);

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

    const mapped = inventory.map((item) => ({
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
  try {
    const { steamId, tradeUrl, assetids, callbackUrl, game = 'cs2' } = req.body;
    const gameConfig = getGameConfig(game);

    if (!steamId || !tradeUrl || !Array.isArray(assetids) || assetids.length === 0 || !callbackUrl) {
      return res.json({ ok: false, error: 'steamId, tradeUrl, assetids и callbackUrl обязательны' });
    }

    if (!client.steamID) {
      return res.status(503).json({
        ok: false,
        error: 'Steam bot is disconnected from Steam network.',
      });
    }

    if (!isBotReady) {
      try {
        await safeRefreshWebSession();
      } catch (err) {
        return res.status(503).json({
          ok: false,
          error: `Steam bot is not ready: ${err.message}`,
        });
      }
    }

    console.log(`📨 Create offer for steamId=${steamId}, items=${assetids.length}`);

    try {
      const inventory = await getUserInventoryWithRetry(
        steamId,
        gameConfig,
        {
          forceRefresh: true,
        }
      );

      const selectedAssetIds = new Set(
        assetids.map(String)
      );

      const itemsToTake = inventory.filter(
        (item) =>
          selectedAssetIds.has(String(item.assetid)) &&
          item.tradable
      );

      if (itemsToTake.length !== selectedAssetIds.size) {
        const foundAssetIds = new Set(
          itemsToTake.map((item) => String(item.assetid))
        );

        const missingAssetIds = [...selectedAssetIds].filter(
          (assetid) => !foundAssetIds.has(assetid)
        );

        console.error(
          '⚠ Some selected items were not found or are not tradable:',
          missingAssetIds
        );

        return res.status(409).json({
          ok: false,
          error:
            'Some selected items are no longer available or are not tradable.',
          missingAssetIds,
        });
      }

      // await safeRefreshWebSession();

      await cancelActiveOffersToUser(steamId);

      const offer = manager.createOffer(tradeUrl);
      offer.addTheirItems(
        itemsToTake.map((item) => ({
          appid: item.appid,
          contextid: item.contextid,
          assetid: item.assetid,
          amount: item.amount,
        }))
      );
      offer.setMessage('Выкуп ваших CS2 скинов на нашем сайте');

      const result = await new Promise((resolve, reject) => {
        offer.send((sendErr, status) => {
          if (sendErr) return reject(sendErr);
          resolve(status);
        });
      });

      setOfferCallback(String(offer.id), callbackUrl);

      console.log(`✅ Offer sent. ID=${offer.id}, status=${result}`);
      console.log(`🔗 Saved callback for offer ${offer.id}: ${callbackUrl}`);

      return res.json({
        ok: true,
        offerId: offer.id,
        status: result,
      });
    } catch (err) {
      console.error('❌ Error sending offer:', err);

      return res.json({
        ok: false,
        error: err.message || 'Unknown error',
      });
    }
  }
  catch (err) {
    console.error('❌ Error sending offer:', err);

    return res.status(500).json({
      ok: false,
      error: err.message || 'Unknown error',
    });
  }
});

// ================== statuys ==================

manager.on('sentOfferChanged', async (offer, oldState) => {
  const E = TradeOfferManager.ETradeOfferState;

  console.log(`🔄 Offer state changed: id=${offer.id}, state=${offer.state}`);


  let status = 'UNKNOWN';

  if (offer.state === E.Accepted) status = 'ACCEPTED';
  else if (offer.state === E.Canceled) status = 'CANCELED';
  else if (offer.state === E.Declined) status = 'DECLINED';
  else if (offer.state === E.Expired) status = 'EXPIRED';
  else if (offer.state === E.InEscrow) status = 'ESCROW';

  const callbackUrl = getOfferCallback(offer.id);

  if (!callbackUrl) {
    console.warn('⚠ No callbackUrl for offerId', offer.id, '— skipping notify');
    return;
  }

  try {

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-api-key': BOT_API_KEY,
      },
      body: JSON.stringify({
        offerId: String(offer.id),
        state: status,
        rawState: offer.state,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      console.error('❌ API responded with error on offer-state-changed:', data);
    } else {
      console.log('📨 API confirmed offer-state-changed:', data);
    }
  } catch (apiErr) {
    console.error('❌ Failed to notify API about offer state:', apiErr);
  }
});

// ================== START SERVER ==================

const PORT = process.env.PORT || 3002;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Bot API running on http://127.0.0.1:${PORT}`);
});