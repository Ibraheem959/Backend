import express from 'express';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { startArenaMonitor } from './arena-monitor.mjs';
import { startCandlePoller, getCandles, setSuiPrice } from './candles.mjs';

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── CONTRACT ADDRESSES ───
const TOKEN_PACKAGE  = '0x5613a7e1f4f8fc7b896781aaba9b52944763e14421458d14c829223541d77c1c';
const TOKEN_ADMIN_CAP = process.env.ADMIN_CAP_ID || '0x3a202c081798cf0781b13d0bbe9efdf3a95a1d94cd901cdbcd51d9f8745eed10';
const REGISTRY_ID    = '0x63af8f92c3988601b889a543615b0984ebabbfa420d8b38b2461751f8c05194f';
const POOL_ID        = '0xba79012088507127692c8c8ba97d4fdc4a83d2f9fff4e9a1ea61ebdc00ff460c';
const POOL_PACKAGE    = '0x3599b83bfc78a1e13baa256b35c340b34111ac18dab3736732efb48ce3cd6952';
const CLOCK_ID        = '0x0000000000000000000000000000000000000000000000000000000000000006';
// LP Pool
const LP_POOL_ID      = process.env.LP_POOL_ID      || '0xe2cb18758423840159a11243387efc27c21db171ba97c1bad2d6009a474d2e79';
const LP_POOL_PACKAGE = process.env.LP_POOL_PACKAGE || '0xf554dad1683cb25386ddf57f2d40f2774fb8287b17f467ebc657c5bc20f226e3';
const LP_ADMIN_CAP    = process.env.LP_ADMIN_CAP    || '0xcaf008988b557cc9ddf4a5921e42d2440db13e108f05c884c44c57903bc7c4e5';
const SPLIT_RATIO     = 0.70; // 70% old pool, 30% LP pool
const ARENA_PACKAGE  = '0xac38870890071543644ea81d1f5fe8000d45030c266c82c24c26eccbf0c239db';
const ARENA_OBJECT   = '0x1cc3b2ead3ead0a8c198be912e5b8926963718ebc9d737f35e928cd4fddefc5d';
const ARENA_ADMIN_CAP= '0x81d63f7fecfab19b5409c29dead1e695a349f56e29269d03980ebfad64442695';
const COIN_TYPE      = `${TOKEN_PACKAGE}::agent::AGENT`;

const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' });

function getAdminKeypair() {
  const key = process.env.ADMIN_PRIVATE_KEY;
  if (!key) throw new Error('ADMIN_PRIVATE_KEY not set');
  const { secretKey } = decodeSuiPrivateKey(key);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

// ─── CURRENT ROUND ───
let currentRoundId = process.env.CURRENT_ROUND_ID || '0x1e0b8b0fc3b79ec750bb258df0eca82f80a194d79229d2f1ec798ba28c6f6c45';

// ─── PARTICIPANT STORE ───
const PARTICIPANTS_FILE = './arena-participants.json';
function loadParticipants() {
  try { return existsSync(PARTICIPANTS_FILE) ? JSON.parse(readFileSync(PARTICIPANTS_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveParticipants(data) { writeFileSync(PARTICIPANTS_FILE, JSON.stringify(data, null, 2)); }

// ─── KEEP ALIVE ───
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {}); }, 14 * 60 * 1000);
}

// ─── NOTIFY TELEGRAM ───
async function notify(msg) {
  const token  = process.env.TG_BUYBOT_TOKEN;
  const chatId = process.env.TG_CHANNEL_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    });
  } catch(e) { console.error('TG notify error:', e.message); }
}

// ══════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: '$AGENT Backend',
    version: '3.0.0',
    currentRound: currentRoundId,
    contracts: {
      token:        TOKEN_PACKAGE,
      tokenAdminCap: TOKEN_ADMIN_CAP,
      registry:     REGISTRY_ID,
      pool:         POOL_PACKAGE,
      arenaPackage: ARENA_PACKAGE,
      arenaObject:  ARENA_OBJECT,
    }
  });
});

// ══════════════════════════════════════════
// REGISTER — mint AgentBadge (correct args)
// ══════════════════════════════════════════
app.post('/register', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ success: false, error: 'wallet address required' });

  try {
    // Check if already has badge
    const existing = await client.getOwnedObjects({
      owner: wallet,
      filter: { StructType: `${TOKEN_PACKAGE}::agent::AgentBadge` },
      options: { showContent: true }
    });
    if (existing.data.length > 0) {
      return res.json({
        success: true,
        alreadyRegistered: true,
        badgeId: existing.data[0].data.objectId,
        wallet
      });
    }

    // Mint new badge
    // register_agent(registry, _admin_cap, agent_address, skill_hash, clock, ctx)
    const keypair      = getAdminKeypair();
    const skillHashBytes = Array.from(Buffer.from('default-agent-skill', 'utf8'));
    const tx = new Transaction();
    tx.moveCall({
      target: `${TOKEN_PACKAGE}::agent::register_agent`,
      arguments: [
        tx.object(REGISTRY_ID),           // registry
        tx.object(TOKEN_ADMIN_CAP),       // _admin_cap
        tx.pure.address(wallet),          // agent_address
        tx.pure.vector('u8', skillHashBytes), // skill_hash
        tx.object(CLOCK_ID),              // clock
      ]
    });
    tx.setGasBudget(10_000_000);

    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx,
      options: { showEffects: true, showObjectChanges: true }
    });

    if (result.effects?.status?.status === 'success') {
      const badge = result.objectChanges?.find(o =>
        o.type === 'created' && o.objectType?.includes('AgentBadge')
      );
      console.log(`✅ Badge minted for ${wallet} — TX: ${result.digest}`);
      res.json({ success: true, badgeId: badge?.objectId, txDigest: result.digest, wallet });
    } else {
      console.error(`❌ Badge mint failed for ${wallet}:`, result.effects?.status?.error);
      res.json({ success: false, error: result.effects?.status?.error });
    }
  } catch(e) {
    console.error('Registration error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// STATUS — check wallet registration
// ══════════════════════════════════════════
app.get('/status/:wallet', async (req, res) => {
  const { wallet } = req.params;
  try {
    const objects = await client.getOwnedObjects({
      owner: wallet,
      filter: { StructType: `${TOKEN_PACKAGE}::agent::AgentBadge` },
      options: { showContent: true }
    });
    const registered = objects.data.length > 0;
    const badgeId    = registered ? objects.data[0].data.objectId : null;
    const suiBal     = await client.getBalance({ owner: wallet });
    const agentBal   = await client.getBalance({ owner: wallet, coinType: COIN_TYPE }).catch(() => ({ totalBalance: '0' }));
    res.json({
      registered, badgeId, wallet,
      balances: {
        sui:   (parseInt(suiBal.totalBalance)   / 1e9).toFixed(4),
        agent: (parseInt(agentBal.totalBalance) / 1e6).toFixed(0)
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// POOL — live price and reserves
// ══════════════════════════════════════════
app.get('/pool', async (req, res) => {
  try {
    const obj = await client.getObject({ id: POOL_ID, options: { showContent: true } });
    const f   = obj.data?.content?.fields || {};
    const sui   = parseInt(f.sui_reserve?.fields?.balance   || f.sui_reserve   || 0);
    const agent = parseInt(f.agent_reserve?.fields?.balance || f.agent_reserve || 0);
    const price = agent > 0 ? (sui / 1e9) / (agent / 1e6) : 0;
    res.json({
      suiReserve:   sui,
      agentReserve: agent,
      price,
      priceFormatted: price.toFixed(10),
      suiFormatted:   (sui/1e9).toFixed(2),
      agentFormatted: (agent/1e6).toFixed(0),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// ARENA — get current round info
// ══════════════════════════════════════════
app.get('/arena', async (req, res) => {
  try {
    const arenaObj = await client.getObject({ id: ARENA_OBJECT, options: { showContent: true } });
    const arenaFields = arenaObj.data?.content?.fields || {};
    let roundData = null;
    if (currentRoundId) {
      const roundObj = await client.getObject({ id: currentRoundId, options: { showContent: true } });
      const f = roundObj.data?.content?.fields || {};
      const stateMap = { '0': 'open', '1': 'active', '2': 'ended' };
      const endTime  = parseInt(f.end_time || 0);
      const now      = Date.now();
      const prizeRaw = parseInt(f.prize_pool?.fields?.value || f.prize_pool || 0);
      roundData = {
        roundId:      currentRoundId,
        roundNumber:  parseInt(f.round_number || 0),
        state:        stateMap[f.state] || f.state,
        activeAgents: parseInt(f.active_count || 0),
        prizePool:    (prizeRaw / 1_000_000).toFixed(0) + ' $AGENT',
        prizeRaw,
        startTime:    parseInt(f.start_time || 0),
        endTime,
        timeRemaining: endTime > now ? endTime - now : 0,
        winner:       f.winner?.fields?.vec?.[0] || null,
        prizeClaimed: f.prize_claimed || false,
      };
    }
    res.json({ arenaId: ARENA_OBJECT, totalRounds: parseInt(arenaFields.current_round || 0), currentRound: roundData });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// ARENA — register participant from site/bot
// ══════════════════════════════════════════
app.post('/arena/register-participant', async (req, res) => {
  const { wallet, telegram, strategy, settings, roundId } = req.body;
  if (!wallet) return res.status(400).json({ success: false, error: 'wallet required' });
  if (!strategy) return res.status(400).json({ success: false, error: 'strategy required' });

  try {
    const participants = loadParticipants();
    const roundKey = roundId || currentRoundId || 'current';
    if (!participants[roundKey]) participants[roundKey] = [];

    const existing = participants[roundKey].find(p => p.wallet === wallet);
    if (existing) return res.json({ success: true, alreadyRegistered: true, participant: existing });

    const STRAT_DEFAULTS = {
      scalper:      { buyAmount:'0.1', buyDrop:'2',  takeProfit:'8',  stopLoss:'3'  },
      swing:        { buyAmount:'0.3', buyDrop:'5',  takeProfit:'20', stopLoss:'8'  },
      conservative: { buyAmount:'0.1', buyDrop:'10', takeProfit:'15', stopLoss:'5'  },
      degen:        { buyAmount:'0.5', buyDrop:'1',  takeProfit:'50', stopLoss:'15' },
      auto:         { buyAmount:'0.1', buyDrop:'3',  takeProfit:'20', stopLoss:'8'  },
    };
    const def = STRAT_DEFAULTS[strategy] || STRAT_DEFAULTS.swing;

    const participant = {
      wallet, telegram: telegram || null, strategy,
      settings: {
        buyAmount:  settings?.buyAmount  || def.buyAmount,
        buyDrop:    settings?.buyDrop    || def.buyDrop,
        takeProfit: settings?.takeProfit || def.takeProfit,
        stopLoss:   settings?.stopLoss   || def.stopLoss,
      },
      registeredAt: Date.now(),
      eliminated: false, pnl: 0,
    };

    participants[roundKey].push(participant);
    saveParticipants(participants);

    const count = participants[roundKey].length;
    await notify(
      `🏟 *New Arena Registration!*\n\n` +
      `Agent: \`${wallet.slice(0,8)}...${wallet.slice(-6)}\`\n` +
      `Strategy: ${strategy.toUpperCase()}\n` +
      `Agents: ${count}/10\n\n` +
      (count >= 10 ? `⚡ *10 agents — round starting!*` : `Need ${10 - count} more`)
    );

    res.json({ success: true, participant, totalRegistered: count });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════
// ARENA — get participants
// ══════════════════════════════════════════
app.get('/arena/participants', async (req, res) => {
  const roundId = req.query.round || currentRoundId || 'current';
  try {
    const participants = loadParticipants();
    const list = (participants[roundId] || []).map(p => ({
      wallet: p.wallet, strategy: p.strategy,
      eliminated: p.eliminated, pnl: p.pnl, registeredAt: p.registeredAt,
    }));
    res.json({ participants: list, count: list.length, roundId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// ARENA — get winner
// ══════════════════════════════════════════
app.get('/arena/winner', async (req, res) => {
  const roundId = req.query.round || currentRoundId || 'current';
  try {
    const participants = loadParticipants();
    const list  = participants[roundId] || [];
    const alive = list.filter(p => !p.eliminated);
    if (alive.length === 1) return res.json({ winner: alive[0], reason: 'last_standing' });
    if (alive.length > 1) {
      const winner = alive.sort((a,b) => b.pnl - a.pnl)[0];
      return res.json({ winner, reason: 'highest_pnl', survivors: alive.length });
    }
    const last = list.sort((a,b) => (b.eliminatedAt||0) - (a.eliminatedAt||0))[0];
    return res.json({ winner: last || null, reason: 'last_eliminated' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// POOL — add liquidity (admin only)
// ══════════════════════════════════════════
app.post('/pool/add-liquidity', async (req, res) => {
  const { suiAmount, agentAmount, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!suiAmount || !agentAmount) {
    return res.status(400).json({ error: 'suiAmount and agentAmount required' });
  }

  try {
    const keypair    = getAdminKeypair();
    const sender     = keypair.toSuiAddress();

    // suiAmount in SUI (e.g. 10), agentAmount in $AGENT (e.g. 1000000)
    const suiRaw   = Math.floor(parseFloat(suiAmount)   * 1_000_000_000); // SUI → MIST
    const agentRaw = Math.floor(parseFloat(agentAmount) * 1_000_000);     // $AGENT → raw

    // Get SUI coins
    const suiCoins = await client.getCoins({ owner: sender });
    if (!suiCoins.data.length) return res.status(400).json({ error: 'No SUI coins in admin wallet' });

    // Get $AGENT coins
    const agentCoins = await client.getCoins({ owner: sender, coinType: COIN_TYPE });
    if (!agentCoins.data.length) return res.status(400).json({ error: 'No $AGENT coins in admin wallet' });

    const tx = new Transaction();

    // Split exact SUI amount
    const [suiCoin] = tx.splitCoins(tx.gas, [suiRaw]);

    // Merge and split exact $AGENT amount
    const primaryAgent = tx.object(agentCoins.data[0].coinObjectId);
    if (agentCoins.data.length > 1) {
      tx.mergeCoins(primaryAgent, agentCoins.data.slice(1).map(c => tx.object(c.coinObjectId)));
    }
    const [agentCoin] = tx.splitCoins(primaryAgent, [agentRaw]);

    // Call add_liquidity(pool, admin_cap, sui_coin, agent_coin)
    tx.moveCall({
      target: `${POOL_PACKAGE}::pool::add_liquidity`,
      arguments: [
        tx.object(POOL_ID),
        tx.object(TOKEN_ADMIN_CAP),
        suiCoin,
        agentCoin,
      ]
    });
    tx.setGasBudget(20_000_000);

    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx,
      options: { showEffects: true }
    });

    if (result.effects?.status?.status === 'success') {
      console.log(`✅ Liquidity added: ${suiAmount} SUI + ${agentAmount} $AGENT — TX: ${result.digest}`);
      res.json({
        success: true,
        txDigest: result.digest,
        added: { sui: suiAmount, agent: agentAmount }
      });
    } else {
      res.json({ success: false, error: result.effects?.status?.error });
    }
  } catch(e) {
    console.error('Add liquidity error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// SWAP — get quote for buying/selling $AGENT
// ══════════════════════════════════════════
app.get('/swap/quote', async (req, res) => {
  const { type, amount } = req.query; // type: buy|sell, amount in SUI or AGENT
  if (!type || !amount) return res.status(400).json({ error: 'type and amount required' });
  try {
    const obj = await client.getObject({ id: POOL_ID, options: { showContent: true } });
    const f   = obj.data?.content?.fields || {};
    const suiRes   = parseInt(f.sui_reserve?.fields?.balance   || f.sui_reserve   || 0);
    const agentRes = parseInt(f.agent_reserve?.fields?.balance || f.agent_reserve || 0);
    const FEE_BPS  = 30;

    if (type === 'buy') {
      const suiIn    = Math.floor(parseFloat(amount) * 1e9);
      const fee      = Math.floor(suiIn * FEE_BPS / 10000);
      const suiNet   = suiIn - fee;
      const agentOut = Math.floor((suiNet * agentRes) / (suiRes + suiNet));
      res.json({
        type: 'buy', suiIn,
        agentOut, agentOutFormatted: (agentOut/1e6).toFixed(0),
        fee, feeSui: (fee/1e9).toFixed(6),
        priceImpact: ((suiNet / suiRes) * 100).toFixed(3) + '%',
        price: (suiIn/1e9) / (agentOut/1e6),
      });
    } else {
      const agentIn  = Math.floor(parseFloat(amount) * 1e6);
      const suiGross = Math.floor((agentIn * suiRes) / (agentRes + agentIn));
      const fee      = Math.floor(suiGross * FEE_BPS / 10000);
      const suiOut   = suiGross - fee;
      res.json({
        type: 'sell', agentIn,
        suiOut, suiOutFormatted: (suiOut/1e9).toFixed(6),
        fee, feeSui: (fee/1e9).toFixed(6),
        priceImpact: ((agentIn / agentRes) * 100).toFixed(3) + '%',
        price: (suiOut/1e9) / (agentIn/1e6),
      });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// CANDLES — OHLCV from on-chain events
// ══════════════════════════════════════════
app.get('/candles', (req, res) => {
  const tf    = req.query.tf    || '5m';
  const limit = parseInt(req.query.limit || '200');
  const valid = ['1m','5m','15m','1h','4h','1d'];
  if (!valid.includes(tf)) return res.status(400).json({ error: 'invalid timeframe' });
  const candles = getCandles(tf, limit);
  res.json({ candles, tf, count: candles.length });
});

// ══════════════════════════════════════════
// LP POOL — add liquidity (user signs tx client-side)
// Returns unsigned tx bytes for wallet to sign
// ══════════════════════════════════════════
app.get('/lp/pool', async (req, res) => {
  if (!LP_POOL_ID) return res.status(503).json({ error: 'LP pool not deployed yet' });
  try {
    const obj = await client.getObject({ id: LP_POOL_ID, options: { showContent: true } });
    const f   = obj.data?.content?.fields || {};
    const sui       = parseInt(f.sui_reserve?.fields?.balance   || f.sui_reserve   || 0);
    const agent     = parseInt(f.agent_reserve?.fields?.balance || f.agent_reserve || 0);
    const lpTotal   = parseInt(f.lp_supply?.fields?.value       || 0);
    const price     = agent > 0 ? (sui / 1e9) / (agent / 1e6) : 0;
    res.json({
      poolId:       LP_POOL_ID,
      suiReserve:   sui,
      agentReserve: agent,
      lpTotal,
      price,
      priceFormatted: price.toFixed(12),
      suiFormatted:   (sui/1e9).toFixed(4),
      agentFormatted: (agent/1e6).toFixed(0),
      feeBps:  parseInt(f.fee_bps      || 30),
      paused:  f.is_paused || false,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/lp/position/:wallet', async (req, res) => {
  if (!LP_POOL_ID) return res.status(503).json({ error: 'LP pool not deployed yet' });
  const { wallet } = req.params;
  try {
    // Get user's LP token balance
    const LP_COIN_TYPE = LP_POOL_PACKAGE ? `${LP_POOL_PACKAGE}::pool_lp::LP` : null;
    if (!LP_COIN_TYPE) return res.json({ lpBalance: 0, suiValue: 0, agentValue: 0 });

    const lpBal = await client.getBalance({ owner: wallet, coinType: LP_COIN_TYPE }).catch(() => ({ totalBalance: '0' }));
    const userLp = parseInt(lpBal.totalBalance);

    // Get pool state to compute share value
    const poolObj = await client.getObject({ id: LP_POOL_ID, options: { showContent: true } });
    const f       = poolObj.data?.content?.fields || {};
    const sui     = parseInt(f.sui_reserve?.fields?.balance   || 0);
    const agent   = parseInt(f.agent_reserve?.fields?.balance || 0);
    const lpTotal = parseInt(f.lp_supply?.fields?.value       || 0) + userLp;

    const suiValue   = lpTotal > 0 ? Math.floor(userLp * sui   / lpTotal) : 0;
    const agentValue = lpTotal > 0 ? Math.floor(userLp * agent / lpTotal) : 0;
    const sharePct   = lpTotal > 0 ? (userLp / lpTotal * 100).toFixed(4) : '0';

    res.json({ wallet, lpBalance: userLp, suiValue, agentValue, sharePct, lpTotal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// BUILD-TX — build unsigned TX for wallet to sign
// ══════════════════════════════════════════
app.post('/build-tx', async (req, res) => {
  const { sender, action, amount, badgeId, suiAmount, agentAmount, lpAmount } = req.body;
  if (!sender || !action) return res.status(400).json({ error: 'sender and action required' });

  try {
    const tx = new Transaction();
    tx.setSender(sender);

    if (action === 'buy') {
      // Buy $AGENT — splits across old pool (badge) + LP pool
      if (!badgeId) return res.status(400).json({ error: 'badgeId required for buy' });
      // Check LP pool has liquidity
      let lpHasLiq = false;
      try {
        const lpObj = await client.getObject({ id: LP_POOL_ID, options: { showContent: true } });
        const lf = lpObj.data?.content?.fields || {};
        lpHasLiq = parseInt(lf.sui_reserve?.fields?.balance || lf.sui_reserve || 0) > 1_000_000_000;
      } catch(e) {}

      if (lpHasLiq) {
        const mainAmt = Math.floor(amount * SPLIT_RATIO);
        const lpAmt   = amount - mainAmt;
        const [mainCoin] = tx.splitCoins(tx.gas, [mainAmt]);
        const [lpCoin]   = tx.splitCoins(tx.gas, [lpAmt]);
        const [out1] = tx.moveCall({
          target: `${POOL_PACKAGE}::pool::buy_agent_verified`,
          arguments: [tx.object(POOL_ID), tx.object(badgeId), tx.object(REGISTRY_ID), mainCoin, tx.pure.u64(0), tx.object(CLOCK_ID)]
        });
        const [out2] = tx.moveCall({
          target: `${LP_POOL_PACKAGE}::pool_lp::buy_agent`,
          arguments: [tx.object(LP_POOL_ID), lpCoin, tx.pure.u64(0), tx.object(CLOCK_ID)]
        });
        tx.transferObjects([out1, out2], sender);
      } else {
        const [coin] = tx.splitCoins(tx.gas, [amount]);
        const [out]  = tx.moveCall({
          target: `${POOL_PACKAGE}::pool::buy_agent_verified`,
          arguments: [tx.object(POOL_ID), tx.object(badgeId), tx.object(REGISTRY_ID), coin, tx.pure.u64(0), tx.object(CLOCK_ID)]
        });
        tx.transferObjects([out], sender);
      }
      tx.setGasBudget(20_000_000);

    } else if (action === 'sell') {
      // Sell $AGENT — splits across both pools
      if (!badgeId) return res.status(400).json({ error: 'badgeId required for sell' });
      const agentCoins = await client.getCoins({ owner: sender, coinType: COIN_TYPE });
      if (!agentCoins.data.length) return res.status(400).json({ error: 'No $AGENT coins found' });
      const primary = tx.object(agentCoins.data[0].coinObjectId);
      if (agentCoins.data.length > 1) {
        tx.mergeCoins(primary, agentCoins.data.slice(1).map(c => tx.object(c.coinObjectId)));
      }
      let lpHasLiq = false;
      try {
        const lpObj = await client.getObject({ id: LP_POOL_ID, options: { showContent: true } });
        const lf = lpObj.data?.content?.fields || {};
        lpHasLiq = parseInt(lf.sui_reserve?.fields?.balance || lf.sui_reserve || 0) > 1_000_000_000;
      } catch(e) {}

      if (lpHasLiq) {
        const mainAmt = Math.floor(amount * SPLIT_RATIO);
        const lpAmt   = amount - mainAmt;
        const [mainAgent] = tx.splitCoins(primary, [mainAmt]);
        const [lpAgent]   = tx.splitCoins(primary, [lpAmt]);
        const [sui1] = tx.moveCall({
          target: `${POOL_PACKAGE}::pool::sell_agent_verified`,
          arguments: [tx.object(POOL_ID), tx.object(badgeId), tx.object(REGISTRY_ID), mainAgent, tx.pure.u64(0), tx.object(CLOCK_ID)]
        });
        const [sui2] = tx.moveCall({
          target: `${LP_POOL_PACKAGE}::pool_lp::sell_agent`,
          arguments: [tx.object(LP_POOL_ID), lpAgent, tx.pure.u64(0), tx.object(CLOCK_ID)]
        });
        tx.transferObjects([sui1, sui2], sender);
      } else {
        const [aCoin] = tx.splitCoins(primary, [amount]);
        const [out]   = tx.moveCall({
          target: `${POOL_PACKAGE}::pool::sell_agent_verified`,
          arguments: [tx.object(POOL_ID), tx.object(badgeId), tx.object(REGISTRY_ID), aCoin, tx.pure.u64(0), tx.object(CLOCK_ID)]
        });
        tx.transferObjects([out], sender);
      }
      tx.setGasBudget(20_000_000);

    } else if (action === 'add_liquidity') {
      if (!suiAmount || !agentAmount) return res.status(400).json({ error: 'suiAmount and agentAmount required' });
      // LP Pool add_liquidity
      const agentCoins = await client.getCoins({ owner: sender, coinType: COIN_TYPE });
      if (!agentCoins.data.length) return res.status(400).json({ error: 'No $AGENT coins' });
      const [suiCoin]   = tx.splitCoins(tx.gas, [suiAmount]);
      const primaryAg   = tx.object(agentCoins.data[0].coinObjectId);
      if (agentCoins.data.length > 1) {
        tx.mergeCoins(primaryAg, agentCoins.data.slice(1).map(c => tx.object(c.coinObjectId)));
      }
      const [agentCoin] = tx.splitCoins(primaryAg, [agentAmount]);
      const [lpOut]     = tx.moveCall({
        target: `${LP_POOL_PACKAGE}::pool_lp::add_liquidity`,
        arguments: [
          tx.object(LP_POOL_ID), suiCoin, agentCoin,
          tx.pure.u64(0), tx.object(CLOCK_ID)
        ]
      });
      tx.transferObjects([lpOut], sender);
      tx.setGasBudget(20_000_000);

    } else if (action === 'remove_liquidity') {
      if (!lpAmount) return res.status(400).json({ error: 'lpAmount required' });
      const LP_COIN_TYPE = LP_POOL_PACKAGE ? `${LP_POOL_PACKAGE}::pool_lp::POOL_LP` : null;
      if (!LP_COIN_TYPE) return res.status(400).json({ error: 'LP pool not configured' });
      const lpCoins = await client.getCoins({ owner: sender, coinType: LP_COIN_TYPE });
      if (!lpCoins.data.length) return res.status(400).json({ error: 'No LP tokens found' });
      const primaryLp = tx.object(lpCoins.data[0].coinObjectId);
      if (lpCoins.data.length > 1) {
        tx.mergeCoins(primaryLp, lpCoins.data.slice(1).map(c => tx.object(c.coinObjectId)));
      }
      const [lpCoin]  = tx.splitCoins(primaryLp, [lpAmount]);
      const [suiOut, agentOut] = tx.moveCall({
        target: `${LP_POOL_PACKAGE}::pool_lp::remove_liquidity`,
        arguments: [
          tx.object(LP_POOL_ID), lpCoin,
          tx.pure.u64(0), tx.pure.u64(0), tx.object(CLOCK_ID)
        ]
      });
      tx.transferObjects([suiOut, agentOut], sender);
      tx.setGasBudget(20_000_000);

    } else {
      return res.status(400).json({ error: 'unknown action: ' + action });
    }

    // Serialize TX for wallet to sign
    const txBytes = await tx.build({ client });
    const txBase64 = Buffer.from(txBytes).toString('base64');
    res.json({ success: true, txBytes: txBase64, action });

  } catch(e) {
    console.error('build-tx error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// ARENA — set round (admin)
// ══════════════════════════════════════════
app.post('/arena/set-round', async (req, res) => {
  const { roundId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  if (!roundId) return res.status(400).json({ error: 'roundId required' });
  currentRoundId = roundId;
  res.json({ success: true, currentRound: currentRoundId });
});

// ══════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`$AGENT Backend running on port ${PORT}`);
  console.log(`Admin cap: ${TOKEN_ADMIN_CAP}`);
  console.log(`Registry:  ${REGISTRY_ID}`);
  console.log(`Arena:     ${ARENA_PACKAGE}`);
  console.log(`Round:     ${currentRoundId}`);
  console.log(`LP Pool:   ${LP_POOL_ID || 'not deployed yet'}`);
  // Start arena monitor
  if (currentRoundId) {
    startArenaMonitor(currentRoundId).catch(e => console.error('Monitor error:', e.message));
    console.log('🏟 Arena monitor started');
  }
  // Start candle aggregator
  startCandlePoller();
});

// ══════════════════════════════════════════
// CLAIM LP FEES — sends protocol fees to dev wallet
// ══════════════════════════════════════════
app.post('/lp/claim-fees', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    const keypair    = getAdminKeypair();
    const devWallet  = keypair.toSuiAddress(); // fees go to admin/dev wallet
    const tx         = new Transaction();
    const [feeCoin]  = tx.moveCall({
      target: `${LP_POOL_PACKAGE}::pool_lp::withdraw_protocol_fees`,
      arguments: [tx.object(LP_POOL_ID), tx.object(LP_ADMIN_CAP)]
    });
    tx.transferObjects([feeCoin], devWallet);
    tx.setGasBudget(10_000_000);
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true }
    });
    if (result.effects?.status?.status === 'success') {
      console.log(`✅ LP fees claimed to dev wallet: ${result.digest}`);
      res.json({ success: true, txDigest: result.digest, recipient: devWallet });
    } else {
      res.json({ success: false, error: result.effects?.status?.error });
    }
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
