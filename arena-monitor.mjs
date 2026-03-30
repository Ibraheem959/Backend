import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ─── CONFIG ───
const ARENA_PACKAGE = '0x7313c9ef54cb40988e09a06f1f44a3378e3901ca502c1d9cb9a0744b43d8b750';
const ARENA_ID      = '0x787f593f720ec75958944ea71b2fbff2acbbf627593b60344ced79b04aaf142d';
const ADMIN_CAP     = '0x8508a74899e9fbb40445a73ae72ef42c3195144964ce1db117868d70e318381c';
const POOL_ID       = '0xba79012088507127692c8c8ba97d4fdc4a83d2f9fff4e9a1ea61ebdc00ff460c';
const TOKEN_PKG     = '0x5613a7e1f4f8fc7b896781aaba9b52944763e14421458d14c829223541d77c1c';
const CLOCK_ID      = '0x0000000000000000000000000000000000000000000000000000000000000006';
const COIN_TYPE     = `${TOKEN_PKG}::agent::AGENT`;
const PARTICIPANTS_FILE = './arena-participants.json';
const MIN_AGENTS    = 10;
const ROUND_DURATION_MS = 3_600_000; // 1 hour

const client = new SuiClient({ url: 'https://fullnode.mainnet.sui.io:443' });

function getAdminKeypair() {
  const key = process.env.ADMIN_PRIVATE_KEY;
  if (!key) throw new Error('ADMIN_PRIVATE_KEY not set');
  const { secretKey } = decodeSuiPrivateKey(key);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

function loadParticipants() {
  try { return existsSync(PARTICIPANTS_FILE) ? JSON.parse(readFileSync(PARTICIPANTS_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveParticipants(data) {
  writeFileSync(PARTICIPANTS_FILE, JSON.stringify(data, null, 2));
}

// ─── NOTIFY TELEGRAM ───
async function notify(msg) {
  const token     = process.env.TG_BUYBOT_TOKEN;
  const channelId = process.env.TG_CHANNEL_ID;
  if (!token || !channelId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, text: msg, parse_mode: 'Markdown' })
    });
  } catch(e) { console.error('Notify error:', e.message); }
}

// ─── GET POOL PRICE ───
async function getPrice() {
  const obj = await client.getObject({ id: POOL_ID, options: { showContent: true } });
  const f   = obj.data?.content?.fields || {};
  const sui   = parseInt(f.sui_reserve?.fields?.balance   || f.sui_reserve   || 0);
  const agent = parseInt(f.agent_reserve?.fields?.balance || f.agent_reserve || 0);
  return agent > 0 ? (sui / 1e9) / (agent / 1e6) : 0;
}

// ─── GET AGENT BALANCE ───
async function getAgentBal(wallet) {
  try {
    const b = await client.getBalance({ owner: wallet, coinType: COIN_TYPE });
    return parseInt(b.totalBalance);
  } catch { return 0; }
}

// ─── GET ROUND STATE ───
async function getRoundState(roundId) {
  const obj = await client.getObject({ id: roundId, options: { showContent: true } });
  const f   = obj.data?.content?.fields || {};
  return {
    state:       f.state,
    activeCount: parseInt(f.active_count || 0),
    endTime:     parseInt(f.end_time || 0),
    startTime:   parseInt(f.start_time || 0),
    prizePool:   parseInt(f.prize_pool?.fields?.value || 0),
  };
}

// ─── AUTO START ROUND ───
async function startRound(roundId) {
  try {
    const keypair = getAdminKeypair();
    const tx = new Transaction();
    tx.moveCall({
      target: `${ARENA_PACKAGE}::arena::start_round`,
      arguments: [tx.object(ADMIN_CAP), tx.object(roundId), tx.object(CLOCK_ID)]
    });
    tx.setGasBudget(10_000_000);
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true }
    });
    if (result.effects?.status?.status === 'success') {
      console.log('✅ Round started! TX:', result.digest);
      await notify(
        `⚔️ *ARENA ROUND STARTED!*\n\n` +
        `10 agents have entered the battle.\n` +
        `1 hour countdown begins now.\n\n` +
        `Last Agent Standing wins everything!\n` +
        `🏟 suiagent.xyz/arena`
      );
      return true;
    }
  } catch(e) { console.error('Start round error:', e.message); }
  return false;
}

// ─── AUTO ELIMINATE AGENT ───
async function eliminateAgent(roundId, wallet) {
  try {
    const keypair = getAdminKeypair();
    const tx = new Transaction();
    tx.moveCall({
      target: `${ARENA_PACKAGE}::arena::eliminate_agent`,
      arguments: [tx.object(ADMIN_CAP), tx.object(roundId), tx.pure.address(wallet), tx.object(CLOCK_ID)]
    });
    tx.setGasBudget(10_000_000);
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true }
    });
    if (result.effects?.status?.status === 'success') {
      console.log(`💀 Eliminated: ${wallet}`);
      return true;
    }
  } catch(e) { console.error('Eliminate error:', e.message); }
  return false;
}

// ─── AUTO END ROUND ───
async function endRound(roundId) {
  try {
    const keypair = getAdminKeypair();
    const tx = new Transaction();
    tx.moveCall({
      target: `${ARENA_PACKAGE}::arena::end_round`,
      arguments: [tx.object(ADMIN_CAP), tx.object(roundId), tx.object(CLOCK_ID)]
    });
    tx.setGasBudget(10_000_000);
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true }
    });
    if (result.effects?.status?.status === 'success') {
      console.log('🏁 Round ended! TX:', result.digest);
      return true;
    }
  } catch(e) { console.error('End round error:', e.message); }
  return false;
}

// ─── MAIN MONITOR LOOP ───
export async function startArenaMonitor(currentRoundId) {
  if (!currentRoundId) { console.log('No active round to monitor'); return; }
  console.log('🏟 Arena monitor started for round:', currentRoundId);

  // Track entry balances for each participant
  const entryBalances = {};
  const roundKey      = currentRoundId;

  setInterval(async () => {
    try {
      const participants = loadParticipants();
      const list = participants[roundKey] || [];
      if (list.length === 0) return;

      const round = await getRoundState(currentRoundId);
      const now   = Date.now();

      // ── STATE: OPEN — check if 10 agents registered ──
      if (round.state === '0') {
        if (round.activeCount >= MIN_AGENTS) {
          console.log('10 agents registered — auto starting round...');
          const started = await startRound(currentRoundId);
          if (started) {
            // Record entry balances for all participants
            for (const p of list) {
              entryBalances[p.wallet] = await getAgentBal(p.wallet);
            }
          }
        }
        return;
      }

      // ── STATE: ACTIVE — monitor for stop losses ──
      if (round.state === '1') {
        const price = await getPrice();

        for (const p of list) {
          if (p.eliminated) continue;

          const currentBal = await getAgentBal(p.wallet);
          const entryBal   = entryBalances[p.wallet] || currentBal;

          // Record entry balance if not set
          if (!entryBalances[p.wallet]) {
            entryBalances[p.wallet] = currentBal;
            continue;
          }

          // Calculate P&L based on balance change
          const sl = parseFloat(p.settings?.stopLoss || '8');
          const balanceChange = entryBal > 0
            ? ((currentBal - entryBal) / entryBal) * 100
            : 0;

          // Update PnL
          p.pnl = balanceChange;

          // Check stop loss hit
          if (balanceChange <= -sl) {
            console.log(`🛑 Stop loss hit for ${p.wallet} — P&L: ${balanceChange.toFixed(2)}%`);
            const eliminated = await eliminateAgent(currentRoundId, p.wallet);
            if (eliminated) {
              p.eliminated     = true;
              p.eliminatedAt   = now;
              p.eliminatedPnl  = balanceChange;

              // Count remaining
              const alive = list.filter(x => !x.eliminated).length;
              await notify(
                `💀 *AGENT ELIMINATED!*\n\n` +
                `Wallet: \`${p.wallet.slice(0,8)}...${p.wallet.slice(-6)}\`\n` +
                `Strategy: ${p.strategy?.toUpperCase()}\n` +
                `Loss: ${balanceChange.toFixed(2)}%\n\n` +
                `Agents remaining: *${alive}*\n` +
                `🏟 suiagent.xyz/arena`
              );

              // If only 1 left → they win!
              if (alive === 1) {
                const winner = list.find(x => !x.eliminated);
                await notify(
                  `🏆 *WINNER! LAST AGENT STANDING!*\n\n` +
                  `Winner: \`${winner.wallet.slice(0,8)}...${winner.wallet.slice(-6)}\`\n` +
                  `Strategy: ${winner.strategy?.toUpperCase()}\n` +
                  `P&L: ${(winner.pnl||0).toFixed(2)}%\n\n` +
                  `Prize: ${(round.prizePool/1e9).toFixed(2)} SUI\n` +
                  `Run node trade.mjs arena compete to claim!\n\n` +
                  `🏟 suiagent.xyz/arena`
                );
              }
            }
          }
        }

        saveParticipants(participants);

        // Check if time is up
        if (now >= round.endTime && round.endTime > 0) {
          console.log('⏰ Time is up — ending round...');
          const ended = await endRound(currentRoundId);
          if (ended) {
            // Find winner by highest PnL
            const alive  = list.filter(p => !p.eliminated);
            const winner = alive.length > 0
              ? alive.sort((a, b) => b.pnl - a.pnl)[0]
              : list.sort((a, b) => (b.eliminatedAt||0) - (a.eliminatedAt||0))[0];

            if (winner) {
              await notify(
                `🏆 *ROUND OVER — WINNER BY HIGHEST P&L!*\n\n` +
                `Winner: \`${winner.wallet.slice(0,8)}...${winner.wallet.slice(-6)}\`\n` +
                `Strategy: ${winner.strategy?.toUpperCase()}\n` +
                `P&L: ${(winner.pnl||0).toFixed(2)}%\n` +
                `Survivors: ${alive.length}\n\n` +
                `Prize: ${(round.prizePool/1e9).toFixed(2)} SUI\n` +
                `🏟 suiagent.xyz/arena`
              );
            }
          }
        }
        return;
      }

      // ── STATE: ENDED ──
      if (round.state === '2') {
        console.log('Round ended. Monitor complete.');
      }

    } catch(e) { console.error('Monitor error:', e.message); }
  }, 60_000); // check every 60 seconds
}
