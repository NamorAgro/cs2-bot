// The transport is injected so pagination and validation can be tested without Steam access.
async function loadInventory(steamId, game, requestPage) {
  const descriptions = new Map();
  const assets = new Map();
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://steamcommunity.com/inventory/${steamId}/${game.appId}/${game.contextId}`);
    url.searchParams.set('l', 'english');
    url.searchParams.set('count', '500');
    if (cursor) url.searchParams.set('start_assetid', cursor);
    const data = await requestPage(url.toString());
    if (!data || (data.success !== 1 && data.success !== true)
      || (data.assets !== undefined && !Array.isArray(data.assets))
      || (data.descriptions !== undefined && !Array.isArray(data.descriptions))) {
      throw new Error('Steam inventory response was unsuccessful or invalid.');
    }
    for (const desc of data.descriptions || []) {
      if (Number(desc.appid) === game.appId) descriptions.set(`${desc.classid}_${desc.instanceid || '0'}`, desc);
    }
    for (const asset of data.assets || []) {
      if (Number(asset.appid) !== game.appId || String(asset.contextid) !== String(game.contextId)
        || !/^\d{1,20}$/.test(String(asset.assetid))) {
        throw new Error('Steam returned an item outside the requested inventory.');
      }
      assets.set(String(asset.assetid), asset);
    }
    if (assets.size > 5000) throw new Error('Steam inventory exceeds the supported limit of 5000 items.');
    if (!data.more_items || data.more_items === '0') {
      return [...assets.values()].map((asset) => {
        const desc = descriptions.get(`${asset.classid}_${asset.instanceid || '0'}`);
        return {
          appid: game.appId, contextid: String(game.contextId), assetid: String(asset.assetid),
          amount: Number(asset.amount ?? 1), classid: String(asset.classid),
          instanceid: String(asset.instanceid || '0'), market_hash_name: desc?.market_hash_name || '',
          name: desc?.name || '', icon_url: desc?.icon_url || null, tradable: Number(desc?.tradable) === 1,
        };
      });
    }
    cursor = String(data.last_assetid || '');
    if (!/^\d{1,20}$/.test(cursor) || cursors.has(cursor)) {
      throw new Error('Steam inventory pagination did not advance.');
    }
    cursors.add(cursor);
  }
  throw new Error('Steam inventory pagination exceeded the supported page limit.');
}

module.exports = { loadInventory };
