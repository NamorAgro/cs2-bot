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

const maFilePath = path.join(__dirname, '..', 'lib', 'secrets', 'bot.maFile');

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

console.log('🔐 Logging in as', accountName, '...');

client.logOn(logOnOptions);

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
      return;
    }

    console.log('✅ TradeOfferManager is ready');

    // Тест: грузим инвентарь бота
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
        console.log('⚠ У бота пустой инвентарь CS2 (730, contextId=2)');
      }
    });
  });
});

client.on('error', (err) => {
  console.error('❌ Steam error:', err);
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
app.post('/get-inventory', (req, res) => {
  const steamId = req.body.steamId;

  if (!steamId) {
    return res.json({ ok: false, error: 'steamId required' });
  }

  console.log(`📦 Request inventory for steamId: ${steamId}`);

  manager.getUserInventoryContents(steamId, 730, 2, true, (err, inventory) => {
    if (err) {
      console.error('❌ Error loading user inventory:', err);
      return res.json({ ok: false, error: err.message });
    }

    const mapped = inventory.map((item) => ({
      assetid: item.assetid,
      classid: item.classid,
      market_hash_name: item.market_hash_name,
      icon: item.icon_url
        ? `https://steamcommunity-a.akamaihd.net/economy/image/${item.icon_url}`
        : null,
    }));

    res.json({
      ok: true,
      count: mapped.length,
      items: mapped
    });
  });
});

// ---- /create-offer ----
app.post('/create-offer', (req, res) => {
  const { steamId, tradeUrl, assetids } = req.body;

  if (!steamId || !tradeUrl || !Array.isArray(assetids) || assetids.length === 0) {
    return res.json({ ok: false, error: 'steamId, tradeUrl и assetids обязательны' });
  }

  console.log(`📨 Create offer for steamId=${steamId}, items=${assetids.length}`);

  manager.getUserInventoryContents(steamId, 730, 2, true, (err, inventory) => {
    if (err) {
      console.error('❌ Error loading user inventory (for offer):', err);
      return res.json({ ok: false, error: err.message });
    }

    const itemsToTake = inventory.filter((it) => assetids.includes(it.assetid));

    if (!itemsToTake.length) {
      console.error('⚠ No matching items in user inventory for given assetids');
      return res.json({ ok: false, error: 'Не нашли выбранные предметы в инвентаре' });
    }

    const offer = manager.createOffer(tradeUrl);
    offer.addTheirItems(itemsToTake);
    offer.setMessage('Выкуп ваших CS2 скинов на нашем сайте');

    offer.send((sendErr, status) => {
      if (sendErr) {
        console.error('❌ Error sending offer:', sendErr);
        return res.json({ ok: false, error: sendErr.message });
      }

      console.log(`✅ Offer sent. ID=${offer.id}, status=${status}`);
      res.json({
        ok: true,
        offerId: offer.id,
        status,
      });
    });
  });
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


  try {

    const response = await fetch(`${API_BASE_URL}/api/steam/offer-state-changed`, {
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
