import express from 'express';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── CONTRACT ADDRESSES ───
const TOKEN_PACKAGE = '0x5613a7e1f4f8fc7b896781aaba9b52944763e14421458d14c829223541d77c1c';
const REGISTRY_ID   = '0x63af8f92c3988601b889a543615b0984ebabbfa420d8b38b2461751f8c05194f';
const POOL_ID       = '0xba79012088507127692c8c8ba97d4fdc4a83d2f9fff4e9a1ea61ebdc00ff460c';
const POOL_PACKAGE  = '0x3599b83bfc78a1e13baa256b35c340b34111ac18dab3736732efb48ce3cd6952';
const CLOCK_ID      = '0x0000000000000000000000000000000000000000000000000000000000000006';
const ARENA_PACKAGE = '0xac38870890071543644ea81d1f5fe8000d45030c266c82c24c26eccbf0c239db';
const ARENA_ID      = '0x1cc3b2ead3ead0a8c198be912e5b8926963718ebc9d737f35e928cd4fddefc5d';
const ARENA_ADMIN_CAP = '0x81d63f7fecfab19b5409c29dead1e695a349f56e29269d03980ebfad64442695';
const COIN_TYPE     = `${TOKEN_PACKAGE}::agent::AGENT`;

const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' });

function getAdminKeypair() {
  const key = process.env.ADMIN_PRIVATE_KEY;
  if (!key) throw new Error('ADMIN_PRIVATE_KEY not set');
  const { secretKey } = decodeSuiPrivateKey(key);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

// ─── CURRENT ROUND TRACKING ───
// Updated by /arena/set-round endpoint or CURRENT_ROUND_ID env var
let currentRoundId = process.env.CURRENT_ROUND_ID || null;

// ─── KEEP ALIVE PING ───
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 14 * 60 * 1000); // ping every 14 mins to prevent sleep
}

// ══════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: '$AGENT Backend',
    version: '2.0.0',
    currentRound: currentRoundId,
    contracts: {
      token:    TOKEN_PACKAGE,
      pool:     POOL_PACKAGE,
      registry: REGISTRY_ID,
      arena:    ARENA_PACKAGE,
    }
  });
});

// ══════════════════════════════════════════
// WALLET REGISTRATION — mint AgentBadge
// ══════════════════════════════════════════
app.post('/register', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ success: false, error: 'wallet address required' });

  try {
    // Check if already registered
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

    const keypair = getAdminKeypair();
    const tx = new Transaction();
    tx.moveCall({
      target: `${TOKEN_PACKAGE}::agent::register_agent`,
      arguments: [
        tx.object(REGISTRY_ID),
        tx.pure.address(wallet),
        tx.object(CLOCK_ID)
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
      res.json({ success: true, badgeId: badge?.objectId, tx: result.digest, wallet });
    } else {
      res.json({ success: false, error: result.effects?.status?.error });
    }
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════
// WALLET STATUS — check registration
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

    // Get balances
    const suiBal   = await client.getBalance({ owner: wallet });
    const agentBal = await client.getBalance({ owner: wallet, coinType: COIN_TYPE }).catch(() => ({ totalBalance: '0' }));

    res.json({
      registered,
      badgeId,
      wallet,
      balances: {
        sui:   (parseInt(suiBal.totalBalance) / 1e9).toFixed(4),
        agent: (parseInt(agentBal.totalBalance) / 1e6).toFixed(0)
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// POOL STATS — live price and reserves
// ══════════════════════════════════════════
app.get('/pool', async (req, res) => {
  try {
    const obj = await client.getObject({ id: POOL_ID, options: { showContent: true } });
    const f   = obj.data?.content?.fields || {};
    const sui   = parseInt(f.sui_reserve?.fields?.balance   || f.sui_reserve   || 0);
    const agent = parseInt(f.agent_reserve?.fields?.balance || f.agent_reserve || 0);
    const price = agent > 0 ? (sui / 1e9) / (agent / 1e6) : 0;
    const SUI_USD = parseFloat(process.env.SUI_USD_PRICE || '1.78');

    res.json({
      suiReserve:      sui,
      agentReserve:    agent,
      price,
      priceFormatted:  price.toFixed(10),
      priceUsd:        (price * SUI_USD).toFixed(12),
      suiFormatted:    (sui/1e9).toFixed(2),
      agentFormatted:  (agent/1e6).toFixed(0),
      liquidity:       ((sui/1e9) * SUI_USD * 2).toFixed(2),
      marketCap:       (1_000_000_000 * price * SUI_USD).toFixed(2),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// TRADES — recent pool trades
// ══════════════════════════════════════════
app.get('/trades', async (req, res) => {
  try {
    const events = await client.queryEvents({
      query: { MoveModule: { package: POOL_PACKAGE, module: 'pool' } },
      limit: 20,
      order: 'descending'
    });
    const trades = events.data.map(e => ({
      type:      e.type?.includes('Buy') ? 'buy' : 'sell',
      wallet:    e.parsedJson?.buyer || e.parsedJson?.seller || '0x0000',
      suiAmount: e.parsedJson?.sui_in || e.parsedJson?.sui_out || 0,
      agentAmount: e.parsedJson?.agent_out || e.parsedJson?.agent_in || 0,
      timestamp: e.timestampMs,
      tx:        e.id?.txDigest
    }));
    res.json({ trades, count: trades.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// ARENA — get current round info
// ══════════════════════════════════════════
app.get('/arena', async (req, res) => {
  try {
    // Get arena global state
    const arenaObj = await client.getObject({ id: ARENA_ID, options: { showContent: true } });
    const arenaFields = arenaObj.data?.content?.fields || {};

    let roundData = null;
    if (currentRoundId) {
      const roundObj = await client.getObject({ id: currentRoundId, options: { showContent: true } });
      const f = roundObj.data?.content?.fields || {};
      const stateMap = { '0': 'open', '1': 'active', '2': 'ended' };
      const endTime  = parseInt(f.end_time || 0);
      const now      = Date.now();

      roundData = {
        roundId:      currentRoundId,
        roundNumber:  parseInt(f.round_number || 0),
        state:        stateMap[f.state] || f.state,
        activeAgents: parseInt(f.active_count || 0),
        prizePool:    (parseInt(f.prize_pool?.fields?.value || f.prize_pool || 0) / 1e9).toFixed(4),
        startTime:    parseInt(f.start_time || 0),
        endTime,
        timeRemaining: endTime > now ? endTime - now : 0,
        winner:       f.winner?.fields?.vec?.[0] || null,
        prizeClaimed: f.prize_claimed || false,
      };
    }

    res.json({
      arenaId:      ARENA_ID,
      totalRounds:  parseInt(arenaFields.current_round || 0),
      currentRound: roundData,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// ARENA — get any round by ID
// ══════════════════════════════════════════
app.get('/arena/round/:roundId', async (req, res) => {
  const { roundId } = req.params;
  try {
    const roundObj = await client.getObject({ id: roundId, options: { showContent: true } });
    const f = roundObj.data?.content?.fields || {};
    const stateMap = { '0': 'open', '1': 'active', '2': 'ended' };
    const endTime  = parseInt(f.end_time || 0);
    const now      = Date.now();

    res.json({
      roundId,
      roundNumber:  parseInt(f.round_number || 0),
      state:        stateMap[f.state] || f.state,
      activeAgents: parseInt(f.active_count || 0),
      prizePool:    (parseInt(f.prize_pool?.fields?.value || f.prize_pool || 0) / 1e9).toFixed(4),
      startTime:    parseInt(f.start_time || 0),
      endTime,
      timeRemaining: endTime > now ? endTime - now : 0,
      winner:       f.winner?.fields?.vec?.[0] || null,
      prizeClaimed: f.prize_claimed || false,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// ARENA — set current round (admin only)
// ══════════════════════════════════════════
app.post('/arena/set-round', async (req, res) => {
  const { roundId, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!roundId) return res.status(400).json({ error: 'roundId required' });
  currentRoundId = roundId;
  res.json({ success: true, currentRound: currentRoundId });
});

// ══════════════════════════════════════════
// ARENA — check if wallet is registered in round
// ══════════════════════════════════════════
app.get('/arena/check/:wallet', async (req, res) => {
  const { wallet } = req.params;
  const roundId = req.query.round || currentRoundId;
  if (!roundId) return res.status(400).json({ error: 'no active round' });

  try {
    const roundObj = await client.getObject({ id: roundId, options: { showContent: true } });
    const f = roundObj.data?.content?.fields || {};
    const stateMap = { '0': 'open', '1': 'active', '2': 'ended' };

    res.json({
      roundId,
      wallet,
      roundState: stateMap[f.state] || f.state,
      activeAgents: parseInt(f.active_count || 0),
      prizePool: (parseInt(f.prize_pool?.fields?.value || 0) / 1e9).toFixed(4),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════
// STATS — overall project stats
// ══════════════════════════════════════════
app.get('/stats', async (req, res) => {
  try {
    const [registryObj, poolObj] = await Promise.all([
      client.getObject({ id: REGISTRY_ID, options: { showContent: true } }),
      client.getObject({ id: POOL_ID, options: { showContent: true } }),
    ]);

    const rf = registryObj.data?.content?.fields || {};
    const pf = poolObj.data?.content?.fields || {};

    const sui   = parseInt(pf.sui_reserve?.fields?.balance   || pf.sui_reserve   || 0);
    const agent = parseInt(pf.agent_reserve?.fields?.balance || pf.agent_reserve || 0);
    const price = agent > 0 ? (sui / 1e9) / (agent / 1e6) : 0;

    res.json({
      registeredAgents: parseInt(rf.agent_count || rf.total_agents || 0),
      totalTrades:      parseInt(rf.total_trades || 0),
      totalVolumeSui:   parseFloat(rf.total_volume || 0) / 1e9,
      price,
      poolSui:          (sui/1e9).toFixed(2),
      poolAgent:        (agent/1e6).toFixed(0),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`$AGENT Backend running on port ${PORT}`);
  console.log(`Arena Package: ${ARENA_PACKAGE}`);
  console.log(`Current Round: ${currentRoundId || 'none'}`);
});
