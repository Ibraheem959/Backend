// ══════════════════════════════════════
// Add these routes to index.mjs before app.listen
// ══════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';

// ─── PARTICIPANT STORE ───
const PARTICIPANTS_FILE = './arena-participants.json';

function loadParticipants() {
  try {
    return existsSync(PARTICIPANTS_FILE)
      ? JSON.parse(readFileSync(PARTICIPANTS_FILE, 'utf8'))
      : {};
  } catch { return {}; }
}

function saveParticipants(data) {
  writeFileSync(PARTICIPANTS_FILE, JSON.stringify(data, null, 2));
}

// ══════════════════════════════════════
// ARENA — register participant from site
// ══════════════════════════════════════
app.post('/arena/register-participant', async (req, res) => {
  const { wallet, telegram, strategy, settings, roundId } = req.body;

  if (!wallet || !wallet.startsWith('0x')) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }
  if (!strategy) {
    return res.status(400).json({ success: false, error: 'Strategy required' });
  }

  try {
    // Check if wallet has AgentBadge, register if not
    const objects = await client.getOwnedObjects({
      owner: wallet,
      filter: { StructType: `${TOKEN_PACKAGE}::agent::AgentBadge` },
      options: { showContent: true }
    });

    let badgeId = null;
    if (objects.data.length > 0) {
      badgeId = objects.data[0].data.objectId;
    } else {
      // Auto register badge
      try {
        const keypair = getAdminKeypair();
        const tx = new Transaction();
        tx.moveCall({
          target: `${TOKEN_PACKAGE}::agent::register_agent`,
          arguments: [tx.object(REGISTRY_ID), tx.pure.address(wallet), tx.object(CLOCK_ID)]
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
          badgeId = badge?.objectId;
        }
      } catch(e) {
        console.error('Badge mint error:', e.message);
      }
    }

    // Save participant
    const participants = loadParticipants();
    const roundKey = roundId || 'current';
    if (!participants[roundKey]) participants[roundKey] = [];

    // Check if already registered
    const existing = participants[roundKey].find(p => p.wallet === wallet);
    if (existing) {
      return res.json({
        success: true,
        alreadyRegistered: true,
        message: 'Already registered for this round',
        participant: existing
      });
    }

    const participant = {
      wallet,
      telegram: telegram || null,
      strategy,
      settings: {
        buyAmount:   settings?.buyAmount   || '0.1',
        buyDrop:     settings?.buyDrop     || '5',
        takeProfit:  settings?.takeProfit  || '20',
        stopLoss:    settings?.stopLoss    || '8',
      },
      badgeId,
      registeredAt: Date.now(),
      eliminated: false,
      pnl: 0,
    };

    participants[roundKey].push(participant);
    saveParticipants(participants);

    // Notify buy bot channel about new registration
    const count = participants[roundKey].length;
    if (process.env.TG_BUYBOT_TOKEN && process.env.TG_CHANNEL_ID) {
      fetch(`https://api.telegram.org/bot${process.env.TG_BUYBOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TG_CHANNEL_ID,
          text: `🏟 *New Arena Registration!*\n\n` +
                `Agent: \`${wallet.slice(0,8)}...${wallet.slice(-6)}\`\n` +
                `Strategy: ${strategy.toUpperCase()}\n` +
                `Agents: ${count}/10\n\n` +
                (count >= 10 ? '⚡ *10 agents reached — round starting soon!*' : `Need ${10 - count} more to start`),
          parse_mode: 'Markdown'
        })
      }).catch(() => {});
    }

    res.json({ success: true, participant, totalRegistered: count });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════
// ARENA — get participants for a round
// ══════════════════════════════════════
app.get('/arena/participants', async (req, res) => {
  const roundId = req.query.round || 'current';
  try {
    const participants = loadParticipants();
    const list = participants[roundId] || [];

    // Return sanitized list (no private info)
    const safe = list.map(p => ({
      wallet:      p.wallet,
      strategy:    p.strategy,
      eliminated:  p.eliminated,
      pnl:         p.pnl,
      registeredAt: p.registeredAt,
    }));

    res.json({ participants: safe, count: safe.length, roundId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════
// ARENA — update participant PnL (called by monitor)
// ══════════════════════════════════════
app.post('/arena/update-pnl', async (req, res) => {
  const { wallet, pnl, eliminated, adminKey, roundId } = req.body;
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const participants = loadParticipants();
    const roundKey = roundId || 'current';
    if (!participants[roundKey]) return res.status(404).json({ error: 'round not found' });

    const p = participants[roundKey].find(p => p.wallet === wallet);
    if (!p) return res.status(404).json({ error: 'participant not found' });

    p.pnl = pnl;
    if (eliminated) p.eliminated = true;
    saveParticipants(participants);

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════
// ARENA — get winner (highest PnL among survivors)
// ══════════════════════════════════════
app.get('/arena/winner', async (req, res) => {
  const roundId = req.query.round || 'current';
  try {
    const participants = loadParticipants();
    const list = (participants[roundId] || []).filter(p => !p.eliminated);
    if (list.length === 0) {
      // All eliminated — last one to be eliminated wins
      const all = participants[roundId] || [];
      const last = all.sort((a, b) => (b.eliminatedAt || 0) - (a.eliminatedAt || 0))[0];
      return res.json({ winner: last || null, reason: 'last_eliminated' });
    }
    if (list.length === 1) {
      return res.json({ winner: list[0], reason: 'last_standing' });
    }
    // Multiple survivors — highest PnL wins
    const winner = list.sort((a, b) => b.pnl - a.pnl)[0];
    res.json({ winner, reason: 'highest_pnl', survivors: list.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
