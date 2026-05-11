require('dotenv').config();


const express = require('express');
const fs = require('fs');
const path = require('path');

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

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

// ================== STEAM AUTH ==================
const OFFER_MAP_PATH = path.join(__dirname, 'offer-callbacks.json');

let isBotReady = false;

let refreshPromise = null;

function steamLogin() {
  console.log('🔐 Logging in as', accountName, '...');

  client.logOn({
    accountName,
    password: STEAM_BOT_PASSWORD,
    twoFactorCode: getTwoFactorCode()
  });
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

function getUserInventoryWithRetry(steamId) {
  return new Promise((resolve, reject) => {
    manager.getUserInventoryContents(steamId, 730, 2, true, async (err, inventory) => {
      if (!err) return resolve(inventory);

      console.error('❌ Inventory error:', err.message);

      const msg = String(err.message || '');

      if (
        msg.includes('Not Logged In') ||
        msg.includes('Cannot log onto steamcommunity')
      ) {
        try {
          console.log('🔄 Trying to refresh Steam web session after inventory error...');
          await safeRefreshWebSession();

          manager.getUserInventoryContents(steamId, 730, 2, true, (err2, inventory2) => {
            if (err2) return reject(err2);
            resolve(inventory2);
          });
        } catch (refreshErr) {
          reject(refreshErr);
        }

        return;
      }

      reject(err);
    });
  });
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

    try {
      client.webLogOn();
    } catch (err) {
      clearTimeout(timeout);
      client.removeListener('webSession', onWebSession);
      isBotReady = false;
      reject(err);
    }
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
  console.log('✅ Bot logged in to Steam!');
  client.setPersona(SteamUser.EPersonaState.Online);
});

client.on('webSession', (sessionId, cookies) => {
  console.log('🌐 Got web session, cookies count:', cookies.length);

  community.setCookies(cookies);

  manager.setCookies(cookies, (err) => {
    if (err) {
      console.error('❌ Error setting TradeOfferManager cookies:', err);
      isBotReady = false;
      return;
    }

    community.acknowledgeTradeProtection((ackErr) => {
      if (ackErr) {
        console.error('❌ Error acknowledging trade protection:', ackErr);
        isBotReady = false;
        return;
      }

      isBotReady = true;
      console.log('✅ Trade protection acknowledged');
      console.log('✅ TradeOfferManager is ready');

      manager.getInventoryContents(730, 2, true, (invErr, inventory) => {
        if (invErr) {
          console.error('❌ Error loading bot inventory:', invErr);
          return;
        }

        console.log(`🎒 Bot CS2 inventory loaded. Items count: ${inventory.length}`);

        if (inventory.length > 0) {
          console.log('Примеры предметов:');
          inventory.slice(0, 5).forEach((item, idx) => {
            console.log(
              `#${idx + 1}: ${item.market_hash_name} (assetid=${item.assetid})`
            );
          });
        } else {
          console.log('⚠ Bot is empty CS2 (730, contextId=2)');
        }
      });
    });
  });
});


setInterval(async () => {
  if (!client.steamID) {
    console.warn('⚠ Cannot refresh web session: bot is not connected');
    return;
  }

  try {
    await safeRefreshWebSession();
    console.log('✅ Scheduled Steam web session refresh complete');
  } catch (err) {
    console.error('❌ Scheduled Steam web session refresh failed:', err.message);
  }
}, 1000 * 60 * 60 * 12);


client.on('disconnected', (eresult, msg) => {
  console.error('🔌 Steam disconnected:', eresult, msg);
  isBotReady = false;

  setTimeout(() => {
    console.log('🔁 Trying to reconnect to Steam...');
    steamLogin();
  }, 10000);
});

client.on('loggedOff', (eresult) => {
  console.error('🚪 Steam logged off:', eresult);
  isBotReady = false;

  setTimeout(() => {
    console.log('🔁 Trying to login again...');
    steamLogin();
  }, 10000);
});

// ================== EXPRESS API ==================

const app = express();
app.use(express.json());


app.use((req, res, next) => {
  const key = req.headers['x-bot-api-key'];

  if (!key || key !== BOT_API_KEY) {
    console.warn('⚠ Unauthorized request to bot API from', req.ip);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  next();
});

// ---- /get-inventory ----
app.post('/get-inventory', async (req, res) => {
  const steamId = req.body.steamId;

  if (!steamId) {
    return res.json({ ok: false, error: 'steamId required' });
  }

  if (!client.steamID || !isBotReady) {
    return res.status(503).json({
      ok: false,
      error: 'Steam bot is not ready.',
    });
  }

  try {
    console.log(`📦 Request inventory for steamId: ${steamId}`);

    const inventory = await getUserInventoryWithRetry(steamId);

    const mapped = inventory.map((item) => ({
      assetid: item.assetid,
      classid: item.classid,
      market_hash_name: item.market_hash_name,
      icon: item.icon_url
        ? `https://steamcommunity-a.akamaihd.net/economy/image/${item.icon_url}`
        : null,
    }));

    return res.json({
      ok: true,
      count: mapped.length,
      items: mapped
    });
  } catch (err) {
    console.error('❌ Error loading user inventory:', err);
    return res.json({
      ok: false,
      error: err.message || 'Unknown inventory error'
    });
  }
});

// ---- /create-offer ----
app.post('/create-offer', async (req, res) => {
  const { steamId, tradeUrl, assetids, callbackUrl } = req.body;

  if (!steamId || !tradeUrl || !Array.isArray(assetids) || assetids.length === 0 || !callbackUrl) {
    return res.json({ ok: false, error: 'steamId, tradeUrl, assetids и callbackUrl обязательны' });
  }

  if (!client.steamID || !isBotReady) {
    return res.status(503).json({
      ok: false,
      error: 'Steam bot is not ready. Try again later.',
    });
  }

  console.log(`📨 Create offer for steamId=${steamId}, items=${assetids.length}`);

  try {
    const inventory = await getUserInventoryWithRetry(steamId);

    const itemsToTake = inventory.filter((it) => assetids.includes(it.assetid));

    if (!itemsToTake.length) {
      console.error('⚠ No matching items in user inventory for given assetids');
      return res.json({ ok: false, error: 'Unable to find in internet' });
    }

    // await refreshWebSession();

    const offer = manager.createOffer(tradeUrl);
    offer.addTheirItems(itemsToTake);
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