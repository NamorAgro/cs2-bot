const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');


const maFilePath = path.join(__dirname, '..', 'lib', 'secrets', 'bot.maFile');

if (!fs.existsSync(maFilePath)) {
    console.error('❌ maFile not found at', maFilePath);
    process.exit(1);
}

const maDataRaw = fs.readFileSync(maFilePath, 'utf8');
const maData = JSON.parse(maDataRaw);

const accountName = maData.account_name;
const sharedSecret = maData.shared_secret;

if (!process.env.STEAM_BOT_PASSWORD) {
    console.error('❌ STEAM_BOT_PASSWORD is not set in .env');
    process.exit(1);
}

const password = process.env.STEAM_BOT_PASSWORD;

const client = new SteamUser();
const community = new SteamCommunity();

// === TradeOfferManager ===
const manager = new TradeOfferManager({
    steam: client,
    community: community,
    language: 'en'
});

const twoFactorCode = SteamTotp.generateAuthCode(sharedSecret);

const logOnOptions = {
    accountName,
    password,
    twoFactorCode
};

console.log('🔐 Logging in as', accountName, '...');

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    console.log('✅ Bot logged in to Steam!');
    client.setPersona(SteamUser.EPersonaState.Online);
});

// web-ssions
client.on('webSession', (sessionId, cookies) => {
    console.log('🌐 Got web session, cookies count:', cookies.length);

    community.setCookies(cookies);

    manager.setCookies(cookies, (err) => {
        if (err) {
            console.error('❌ Error setting TradeOfferManager cookies:', err);
            return;
        }

        console.log('✅ TradeOfferManager is ready');
        manager.getInventoryContents(730, 2, true, (invErr, inventory) => {
            if (invErr) {
                console.error('❌ Error loading inventory:', invErr);
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


// ====== EXPRESS API ====

const app = express();
app.use(express.json());

app.post('/get-inventory', (req, res) => {
    const steamId = req.body.steamId;
    console.log(steamId)
    if (!steamId) {
        return res.json({ ok: false, error: 'steamId required' });
    }

    console.log(`📦 Request inventory for steamId: ${steamId}`);

    manager.getUserInventoryContents('76561199389462063', 730, 2, false, (err, inv) => {
        console.log('730 / 2:', err, inv?.length);
    });

    manager.getUserInventoryContents('76561199389462063', 730, 1, false, (err, inv) => {
        console.log('730 / 1:', err, inv?.length);
    });

    manager.getUserInventoryContents('76561199389462063', 730, 3, true, (err, inv) => {
        console.log('730 / 3:', err, inv);
    });

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


app.post('/create-offer', (req, res) => {
  const { steamId, tradeUrl, assetids } = req.body;

  if (!steamId || !tradeUrl || !Array.isArray(assetids) || assetids.length === 0) {
    return res.json({ ok: false, error: 'steamId, tradeUrl  assetids ' });
  }

  console.log(`📨 Create offer for steamId=${steamId}, items=${assetids.length}`);

  // Сначала подтягиваем инвентарь пользователя, чтобы получить объекты предметов
  manager.getUserInventoryContents(steamId, 730, 2, true, (err, inventory) => {
    if (err) {
      console.error('❌ Error loading user inventory (for offer):', err);
      return res.json({ ok: false, error: err.message });
    }

    // ищем нужные assetid'ы
    const itemsToTake = inventory.filter((it) => assetids.includes(it.assetid));

    if (!itemsToTake.length) {
      console.error('⚠ No matching items in user inventory for given assetids');
      return res.json({ ok: false, error: 'Не нашли выбранные предметы в инвентаре' });
    }

    const offer = manager.createOffer(tradeUrl);
    console.log(offer)
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

manager.on('sentOfferChanged', async (offer, oldState) => {
  const E = TradeOfferManager.ETradeOfferState;

  console.log(`🔄 Offer state changed: id=${offer.id}, state=${offer.state}`);

  const sellRequest = await prisma.sellRequest.findFirst({
    where: { tradeOfferId: String(offer.id) },
  });

  if (!sellRequest) {
    console.log('⚠ SellRequest not found for offer', offer.id);
    return;
  }

  if (offer.state === E.Accepted) {
    console.log('✅ Trade accepted for SellRequest', sellRequest.id);

    const lockDays = 8;
    const lockedUntil = new Date(Date.now() + lockDays * 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.sellRequest.update({
        where: { id: sellRequest.id },
        data: {
          status: 'LOCKED',
          lockedUntil,
        },
      }),
      prisma.user.update({
        where: { id: sellRequest.userId },
        data: {
          lockedBalance: {
            increment: sellRequest.totalPrice,
          },
        },
      }),
    ]);

    console.log(
      `💰 Locked ${sellRequest.totalPrice} ${sellRequest.currency} for user=${sellRequest.userId} until=${lockedUntil.toISOString()}`
    );
  } else if (
    offer.state === E.Canceled ||
    offer.state === E.Declined ||
    offer.state === E.Expired
  ) {
    console.log('⚠ Offer was not accepted. State=', offer.state);
    await prisma.sellRequest.update({
      where: { id: sellRequest.id },
      data: { status: 'CANCELED' },
    });
  }
});


app.listen(3002, () => {
    console.log('🚀 Bot API running at http://localhost:3002');
});
