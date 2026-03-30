import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ─── NEW CONTRACT ADDRESSES ───
const ARENA_PACKAGE   = '0xac38870890071543644ea81d1f5fe8000d45030c266c82c24c26eccbf0c239db';
const ARENA_ADMIN_CAP = '0x81d63f7fecfab19b5409c29dead1e695a349f56e29269d03980ebfad64442695';
const POOL_ID         = '0xba79012088507127692c8c8ba97d4fdc4a83d2f9fff4e9a1ea61ebdc00ff460c';
const TOKEN_PKG       = '0x5613a7e1f4f8fc7b896781aaba9b52944763e14421458d14c829223541d77c1c';
const CLOCK_ID        = '0x0000000000000000000000000000000000000000000000000000000000000006';
const COIN_TYPE       = `${TOKEN_PKG}::agent::AGENT`;
const PARTICIPANTS_FILE = './arena-participants.json';
const MIN_AGENTS      = 10;

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
  const token  = process.env.TG_BUYBOT_TOKEN;
  const chatId = process.env.TG_CHANNEL_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    });
  } catch(e) { console.error('Notify error:', e.message); }
}

// ─── GET POOL PRICE ───
async function getPrice() {
  try {
    const obj   = await client.getObject({ id: POOL_ID, options: { showContent: true } });
    const f     = obj.data?.content?.fields || {};
    const sui   = parseInt(f.sui_reserve?.fields?.balance   || f.sui_reserve   || 0);
    const agent = parseInt(f.agent_reserve?.fields?.balance || f.agent_reserve || 0);
    return agent > 0 ? (sui / 1e9) / (agent / 1e6) : 0;
  } catch { return 0; }
}

// ─── GET $AGENT BALANCE ───
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
    endTime:     parseInt(f.end_time     || 0),
    startTime:   parseInt(f.start_time   || 0),
    prizePool:   parseInt(f.prize_pool?.fields?.value || 0),
  };
}

// ─── AUTO START ROUND ───
async function startRound(roundId) {
  try {
    const keypair = getAdminKeypair();
    const tx      = new Transaction();
    tx.moveCall({
      target: `${ARENA_PACKAGE}::arena::start_round`,
      arguments: [tx.object(ARENA_ADMIN_CAP), tx.object(roundId), tx.object(CLOCK_ID)]
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
        `1 hour countdown begins NOW.\n\n` +
        `Last Agent Standing wins everything!\n` +
        `🏟 suiagent.xyz/#arena`
      );
      return true;
    }
  } catch(e) { console.error('Start round error:', e.message); }
  return false;
}

// ─── ELIMINATE AGENT ───
async function eliminateAgent(roundId, wallet) {
  try {
    const keypair = getAdminKeypair();
    const tx      = new Transaction();
    tx.moveCall({
      target: `${ARENA_PACKAGE}::arena::eliminate_agent`,
      arguments: [
        tx.object(ARENA_ADMIN_CAP),
        tx.object(roundId),
        tx.pure.address(wallet),
        tx.object(CLOCK_ID)
      ]
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

// ─── END ROUND with winner ───
async function endRound(roundId, winnerWallet) {
  try {
    const keypair = getAdminKeypair();
    const tx      = new Transaction();
    tx.moveCall({
      target: `${ARENA_PACKAGE}::arena::end_round`,
      arguments: [
        tx.object(ARENA_ADMIN_CAP),
        tx.object(roundId),
        tx.pure.address(winnerWallet),
        tx.object(CLOCK_ID)
      ]
    });
    tx.setGasBudget(10_000_000);
    const result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true }
    });
    if (result.effects?.status?.status === 'success') {
      console.log('🏁 Round ended! Winner:', winnerWallet, 'TX:', result.digest);
      return true;
    }
  } catch(e) { console.error('End round error:', e.message); }
  return false;
}

// ─── MAIN MONITOR LOOP ───
export async function startArenaMonitor(currentRoundId) {
  if (!currentRoundId) { console.log('⚠️ No round ID to monitor'); return; }
  console.log('🏟 Arena monitor started for round:', currentRoundId);

  const entryBalances = {};
  const roundKey      = currentRoundId;

  setInterval(async () => {
    try {
      const participants = loadParticipants();
      const list         = participants[roundKey] || [];
      const round        = await getRoundState(currentRoundId);
      const now          = Date.now();

      // ── STATE 0: OPEN — wait for 10 agents on-chain ──
      if (round.state === '0') {
        console.log(`[Arena] Open — ${round.activeCount} agents on-chain`);
        if (round.activeCount >= MIN_AGENTS) {
          console.log('🚀 10 agents joined — auto starting round...');
          const started = await startRound(currentRoundId);
          if (started && list.length > 0) {
            for (const p of list) {
              entryBalances[p.wallet] = await getAgentBal(p.wallet);
            }
          }
        }
        return;
      }

      // ── STATE 1: ACTIVE — monitor stop losses ──
      if (round.state === '1') {
        if (list.length === 0) return;
        const price = await getPrice();
        console.log(`[Arena] Active — price: ${price.toFixed(12)} — ${round.activeCount} agents alive`);

        for (const p of list) {
          if (p.eliminated) continue;

          const currentBal = await getAgentBal(p.wallet);
          if (!entryBalances[p.wallet]) {
            entryBalances[p.wallet] = currentBal;
            continue;
          }

          const entryBal      = entryBalances[p.wallet];
          const sl            = parseFloat(p.settings?.stopLoss || '8');
          const balanceChange = entryBal > 0 ? ((currentBal - entryBal) / entryBal) * 100 : 0;
          p.pnl = balanceChange;

          if (balanceChange <= -sl) {
            console.log(`🛑 SL hit: ${p.wallet} — PnL: ${balanceChange.toFixed(2)}%`);
            const eliminated = await eliminateAgent(currentRoundId, p.wallet);
            if (eliminated) {
              p.eliminated   = true;
              p.eliminatedAt = now;
              const alive    = list.filter(x => !x.eliminated).length;

              await notify(
                `💀 *AGENT ELIMINATED!*\n\n` +
                `Wallet: \`${p.wallet.slice(0,8)}...${p.wallet.slice(-6)}\`\n` +
                `Strategy: ${p.strategy?.toUpperCase()}\n` +
                `Loss: ${balanceChange.toFixed(2)}%\n\n` +
                `Agents remaining: *${alive}*\n` +
                `🏟 suiagent.xyz/#arena`
              );

              if (alive === 1) {
                const winner = list.find(x => !x.eliminated);
                await notify(
                  `🏆 *LAST AGENT STANDING!*\n\n` +
                  `Winner: \`${winner.wallet.slice(0,8)}...${winner.wallet.slice(-6)}\`\n` +
                  `Strategy: ${winner.strategy?.toUpperCase()}\n\n` +
                  `Prize: All staked $AGENT\n` +
                  `Tap 💰 Claim Prize in the bot to claim!\n` +
                  `🏟 suiagent.xyz/#arena`
                );
              }
            }
          }
        }
        saveParticipants(participants);

        // ── Check if time is up ──
        if (round.endTime > 0 && now >= round.endTime) {
          console.log('⏰ Time up — finding winner by highest P&L...');
          const alive = list.filter(p => !p.eliminated);
          let winner;
          if (alive.length >= 1) {
            winner = alive.sort((a, b) => b.pnl - a.pnl)[0];
          } else {
            winner = list.sort((a,b) => (b.eliminatedAt||0) - (a.eliminatedAt||0))[0];
          }
          if (winner) {
            const ended = await endRound(currentRoundId, winner.wallet);
            if (ended) {
              await notify(
                `🏆 *ROUND OVER!*\n\n` +
                `Winner: \`${winner.wallet.slice(0,8)}...${winner.wallet.slice(-6)}\`\n` +
                `Strategy: ${winner.strategy?.toUpperCase()}\n` +
                `P&L: ${(winner.pnl||0).toFixed(2)}%\n` +
                `Reason: ${alive.length >= 1 ? 'Highest P&L' : 'Last eliminated'}\n\n` +
                `Prize: All staked $AGENT\n` +
                `Tap 💰 Claim Prize in the bot!\n` +
                `🏟 suiagent.xyz/#arena`
              );
            }
          }
        }
        return;
      }

      // ── STATE 2: ENDED ──
      if (round.state === '2') {
        console.log('[Arena] Round ended. Monitor complete.');
      }

    } catch(e) { console.error('Monitor error:', e.message); }
  }, 60_000); // check every 60 seconds
}
