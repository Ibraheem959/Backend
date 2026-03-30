import { SuiClient } from '@mysten/sui/client';

const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' });

const POOL_PACKAGE_OLD = '0x3599b83bfc78a1e13baa256b35c340b34111ac18dab3736732efb48ce3cd6952';

// In-memory candle store
// Map<timeframe, Map<bucketTs, Candle>>
const candleStore = {
  '1m':  new Map(),
  '5m':  new Map(),
  '15m': new Map(),
  '1h':  new Map(),
  '4h':  new Map(),
  '1d':  new Map(),
};

const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

let lastEventCursor = null;
let suiUsdPrice     = 1.78;

// ─── Candle logic ───
function getBucket(ts, tfMs) { return Math.floor(ts / tfMs) * tfMs; }

function updateCandle(tf, ts, priceSui, suiVol) {
  const tfMs   = TF_MS[tf];
  const bucket = getBucket(ts, tfMs);
  const store  = candleStore[tf];
  const priceUsd = priceSui * suiUsdPrice;

  if (!store.has(bucket)) {
    store.set(bucket, { t: bucket, o: priceUsd, h: priceUsd, l: priceUsd, c: priceUsd, v: suiVol });
  } else {
    const c = store.get(bucket);
    c.h = Math.max(c.h, priceUsd);
    c.l = Math.min(c.l, priceUsd);
    c.c = priceUsd;
    c.v += suiVol;
  }

  // Keep max 500 candles per timeframe
  if (store.size > 500) {
    const oldest = Math.min(...store.keys());
    store.delete(oldest);
  }
}

// ─── Fetch price from trade event ───
function getPriceFromEvent(e) {
  const f = e.parsedJson || {};
  const isBuy = e.type?.includes('TokensBought');

  if (isBuy) {
    const suiIn    = parseInt(f.sui_in    || 0);
    const agentOut = parseInt(f.agent_out || 0);
    if (agentOut === 0) return null;
    return { priceSui: (suiIn / 1e9) / (agentOut / 1e6), vol: suiIn / 1e9, isBuy };
  } else {
    const agentIn = parseInt(f.agent_in || 0);
    const suiOut  = parseInt(f.sui_out  || 0);
    if (agentIn === 0) return null;
    return { priceSui: (suiOut / 1e9) / (agentIn / 1e6), vol: suiOut / 1e9, isBuy };
  }
}

// ─── Poll new events from chain ───
export async function pollCandles() {
  try {
    const events = await client.queryEvents({
      query: { MoveModule: { package: POOL_PACKAGE_OLD, module: 'pool' } },
      cursor:     lastEventCursor,
      limit:      50,
      order:      'ascending',
    });

    for (const e of events.data) {
      const trade = getPriceFromEvent(e);
      if (!trade) continue;
      const ts = parseInt(e.timestampMs || Date.now());
      for (const tf of Object.keys(TF_MS)) {
        updateCandle(tf, ts, trade.priceSui, trade.vol);
      }
    }

    if (events.data.length > 0) {
      lastEventCursor = events.nextCursor;
    }
  } catch(e) { console.error('[Candles] poll error:', e.message); }
}

// ─── Seed historical candles on startup ───
export async function seedCandles() {
  console.log('[Candles] Seeding from chain events...');
  try {
    let cursor = null;
    let total  = 0;
    for (let page = 0; page < 10; page++) { // up to 500 events
      const events = await client.queryEvents({
        query: { MoveModule: { package: POOL_PACKAGE_OLD, module: 'pool' } },
        cursor, limit: 50, order: 'ascending',
      });
      for (const e of events.data) {
        const trade = getPriceFromEvent(e);
        if (!trade) continue;
        const ts = parseInt(e.timestampMs || Date.now());
        for (const tf of Object.keys(TF_MS)) {
          updateCandle(tf, ts, trade.priceSui, trade.vol);
        }
        total++;
      }
      cursor = events.nextCursor;
      if (!events.hasNextPage) break;
    }
    console.log(`[Candles] Seeded ${total} events`);
    lastEventCursor = cursor;
  } catch(e) { console.error('[Candles] seed error:', e.message); }
}

// ─── Get candles for API ───
export function getCandles(tf = '5m', limit = 200) {
  const store = candleStore[tf] || candleStore['5m'];
  return [...store.values()]
    .sort((a, b) => a.t - b.t)
    .slice(-limit);
}

// ─── Set SUI price ───
export function setSuiPrice(p) { suiUsdPrice = p; }

// ─── Start polling ───
export function startCandlePoller() {
  seedCandles().then(() => {
    setInterval(pollCandles, 15000); // poll every 15s
    console.log('[Candles] Poller started');
  });
}
