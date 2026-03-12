#!/usr/bin/env node
/**
 * Lottery Classic — Auto Draw Script
 * Runs via GitHub Actions at 20:00 UTC daily
 *
 * ENV vars (GitHub Secrets):
 *   OPERATOR_MNEMONIC_DAILY   — mnemonic of DAILY_WALLET operator
 *   OPERATOR_MNEMONIC_WEEKLY  — mnemonic of WEEKLY_WALLET operator
 *   DRAW_TYPE                 — "daily" | "weekly"
 *
 * Winner selection (matches Draw Proof on the site):
 *   seed      = SHA256(`${blockHeight}:${blockHash}:${ticketCount}`)
 *   winnerIdx = BigInt(seed) % BigInt(ticketCount)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');   // Node built-in — no install needed

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const DAILY_WALLET    = 'terra1amp68zg7vph3nq84ummnfma4dz753ezxfqa9px';
const WEEKLY_WALLET   = 'terra1p5l6q95kfl3hes7edy76tywav9f79n6xlkz6qz';
const BURN_WALLET     = 'terra16m05j95p9qvq93cdtchjcpwgvny8f57vzdj06p';
const DEV_WALLET      = 'terra17g55uzkm6cr5fcl3vzcrmu73v8as4yvf2kktzr';
const CHAIN_ID        = 'columbus-5';
const LCD             = 'https://terra-classic-lcd.publicnode.com';
const LCD_FALLBACK    = 'https://api-terra-ia.cosmosia.notional.ventures';
const FCD             = 'https://fcd.terra.dev';
const RPC             = 'https://terra-classic-rpc.publicnode.com';
const LUNC_PER_TICKET = 25000;   // LUNC
const MIN_TICKETS     = 5;

const WINNER_PCT = 0.80;
const BURN_PCT   = 0.05;
const DEV_PCT    = 0.15;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function httpGet(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);
  return res.json();
}

// Try primary LCD, fall back to secondary
async function lcdGet(path) {
  for (const base of [LCD, LCD_FALLBACK]) {
    try {
      const res = await fetch(base + path, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return res.json();
    } catch (e) {
      log(`LCD ${base} failed: ${e.message}`);
    }
  }
  throw new Error(`All LCD nodes failed for path: ${path}`);
}

// ─── WINNER SELECTION — SHA-256 ──────────────────────────────────────────────
/**
 * Deterministic winner index — matches the Draw Proof on the website.
 *   seed      = SHA256(`${blockHeight}:${blockHash}:${ticketCount}`)
 *   winnerIdx = BigInt('0x' + seed) % BigInt(ticketCount)
 *
 * @param {number} blockHeight
 * @param {string} blockHash    — hex string, e.g. "A3F1..."
 * @param {number} ticketCount
 * @returns {number}
 */
function selectWinner(blockHeight, blockHash, ticketCount) {
  const seedStr = `${blockHeight}:${blockHash}:${ticketCount}`;
  const seedHex = crypto.createHash('sha256').update(seedStr).digest('hex');
  log(`Seed string : ${seedStr}`);
  log(`Seed SHA256 : ${seedHex}`);
  const idx = Number(BigInt('0x' + seedHex) % BigInt(ticketCount));
  log(`Winner idx  : ${idx} (out of ${ticketCount})`);
  return idx;
}

// ─── LOAD / SAVE winners.json ─────────────────────────────────────────────────
function loadWinners() {
  const file = path.join(__dirname, 'winners.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }
  return [];
}

function saveWinners(data) {
  fs.writeFileSync(path.join(__dirname, 'winners.json'), JSON.stringify(data, null, 2));
  log('Saved winners.json →', data.length, 'entries');
}

// ─── FETCH TX HISTORY VIA FCD ────────────────────────────────────────────────
async function fetchTickets(wallet, drawType, windowSec) {
  const cutoff  = Math.floor(Date.now() / 1000) - windowSec;
  const tickets = [];
  let page = 1;
  let done = false;

  log(`Fetching tickets for ${drawType} wallet ${wallet} (window ${windowSec}s)`);

  while (!done) {
    const url = `${FCD}/v1/txs?account=${wallet}&limit=100&page=${page}`;
    log(`Fetching page ${page}: ${url}`);

    let data;
    try { data = await httpGet(url); }
    catch (e) { log('FCD error:', e.message); break; }

    const txs = data.txs || [];
    if (!txs.length) break;

    for (const tx of txs) {
      const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
      if (ts < cutoff) { done = true; break; }

      const msgs = tx.tx?.value?.msg || [];
      for (const msg of msgs) {
        if (msg.type !== 'bank/MsgSend') continue;
        const v = msg.value;
        if (v.to_address !== wallet) continue;

        const coins = v.amount || [];
        for (const coin of coins) {
          if (drawType === 'daily' && coin.denom === 'uluna') {
            const luncAmt = Number(coin.amount) / 1e6;
            const numTix  = Math.floor(luncAmt / LUNC_PER_TICKET);
            for (let i = 0; i < numTix; i++) {
              tickets.push({ address: v.from_address, txhash: tx.txhash, time: ts });
            }
          } else if (drawType === 'weekly' && coin.denom === 'uusd') {
            // Each tx = 1 ticket (price-based logic handled on frontend)
            tickets.push({ address: v.from_address, txhash: tx.txhash, time: ts });
          }
        }
      }
      if (done) break;
    }

    const total = data.total || 0;
    if (page * 100 >= total) break;
    page++;
  }

  log(`Found ${tickets.length} tickets`);
  return tickets;
}

// ─── GET LATEST BLOCK (height + hash) ───────────────────────────────────────
async function getLatestBlock() {
  const data = await lcdGet('/cosmos/base/tendermint/v1beta1/blocks/latest');
  const height = Number(data.block.header.height);

  // blockHash is the hash of the *previous* block stored in the header —
  // for randomness we want the hash of the current block itself.
  // The Tendermint API returns it as block_id.hash (base64).
  // We convert to hex to match the format the frontend uses.
  const hashBase64 = data.block_id?.hash || data.block?.header?.last_block_id?.hash || '';
  const hashHex = Buffer.from(hashBase64, 'base64').toString('hex').toUpperCase();

  log(`Block height : ${height}`);
  log(`Block hash   : ${hashHex}`);
  return { height, hash: hashHex };
}

// ─── GET WALLET BALANCE ──────────────────────────────────────────────────────
async function getBalance(wallet, denom) {
  const data = await lcdGet(`/cosmos/bank/v1beta1/balances/${wallet}`);
  const coin = (data.balances || []).find(b => b.denom === denom);
  return coin ? Number(coin.amount) : 0;
}

// ─── SEND TRANSACTION ────────────────────────────────────────────────────────
async function sendTx(mnemonic, fromWallet, toWallet, amountUdenom, denom, memo) {
  const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
  const { SigningStargateClient }   = await import('@cosmjs/stargate');

  const signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'terra',
    hdPath: "m/44'/330'/0'/0/0",
  });

  const client = await SigningStargateClient.connectWithSigner(RPC, signer);

  const result = await client.sendTokens(
    fromWallet, toWallet,
    [{ denom, amount: String(amountUdenom) }],
    { amount: [{ denom: 'uluna', amount: '150000' }], gas: '200000' },
    memo
  );

  if (result.code !== 0) throw new Error(`TX failed (code ${result.code}): ${result.rawLog}`);
  log(`TX OK → ${toWallet} | ${amountUdenom/1e6} ${denom === 'uluna' ? 'LUNC' : 'USTC'} | ${result.transactionHash}`);
  return result.transactionHash;
}

// ─── MAIN DRAW ────────────────────────────────────────────────────────────────
async function runDraw(drawType) {
  log(`=== LOTTERY CLASSIC — ${drawType.toUpperCase()} DRAW ===`);

  const isDaily      = drawType === 'daily';
  const wallet       = isDaily ? DAILY_WALLET : WEEKLY_WALLET;
  const mnemonic     = isDaily ? process.env.OPERATOR_MNEMONIC_DAILY : process.env.OPERATOR_MNEMONIC_WEEKLY;
  const windowSec    = isDaily ? 86400 : 7 * 86400;
  const balanceDenom = isDaily ? 'uluna' : 'uusd';

  if (!mnemonic) {
    log(`ERROR: OPERATOR_MNEMONIC_${drawType.toUpperCase()} not set in secrets`);
    process.exit(1);
  }

  // 1) Fetch tickets
  const tickets = await fetchTickets(wallet, drawType, windowSec);

  // 2) Load winners history
  const winners    = loadWinners();
  const prevRounds = winners.filter(w => w.type === drawType);
  const round      = prevRounds.length + 1;
  const lastEntry  = prevRounds[prevRounds.length - 1];

  // 3) Check minimum tickets
  if (tickets.length <= MIN_TICKETS) {
    log(`Only ${tickets.length} tickets — minimum is ${MIN_TICKETS}. Rolling over.`);
    winners.unshift({
      round, type: drawType, winner: null, tickets: tickets.length,
      prize: 0, totalPool: 0, drawBlock: null, drawBlockHash: null,
      time: Math.floor(Date.now() / 1000),
      rolledOver: (lastEntry?.rolledOver || 0) + 1,
      noDrawReason: 'insufficient_tickets',
    });
    saveWinners(winners);
    return;
  }

  // 4) Get block height + hash for randomness seed
  const { height: blockHeight, hash: blockHash } = await getLatestBlock();

  // 5) Select winner via SHA-256 (same formula as Draw Proof on the website)
  const winnerIdx    = selectWinner(blockHeight, blockHash, tickets.length);
  const winnerTicket = tickets[winnerIdx];
  log(`Winner: ${winnerTicket.address} (ticket #${winnerIdx}, tx ${winnerTicket.txhash})`);

  // 6) Check balance
  const balanceUdenom = await getBalance(wallet, balanceDenom);
  log(`Wallet balance: ${balanceUdenom / 1e6} ${isDaily ? 'LUNC' : 'USTC'}`);

  if (balanceUdenom < 1_000_000) {
    log('ERROR: Balance too low for payout');
    process.exit(1);
  }

  // 7) Calculate payouts
  const gasReserve  = 500_000;
  const payablePool = balanceUdenom - gasReserve;
  const winnerAmt   = Math.floor(payablePool * WINNER_PCT);
  const burnAmt     = Math.floor(payablePool * BURN_PCT);
  const devAmt      = Math.floor(payablePool * DEV_PCT);

  log(`Payouts — Winner: ${winnerAmt/1e6} | Burn: ${burnAmt/1e6} | Dev: ${devAmt/1e6}`);

  // 8) Send payouts
  const txHashes = {};
  txHashes.winner = await sendTx(mnemonic, wallet, winnerTicket.address, winnerAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — 🏆 You won!`);
  await sleep(4000);
  txHashes.burn = await sendTx(mnemonic, wallet, BURN_WALLET, burnAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — 🔥 Burn`);
  await sleep(4000);
  txHashes.dev = await sendTx(mnemonic, wallet, DEV_WALLET, devAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — ⚙️ Dev`);

  // 9) Record result — includes blockHash and winnerIndex for on-site Draw Proof verification
  winners.unshift({
    round,
    type: drawType,
    winner:        winnerTicket.address,
    winnerIndex:   winnerIdx,
    winnerTicketTx: winnerTicket.txhash,
    tickets:       tickets.length,
    prize:         winnerAmt / 1e6,
    totalPool:     balanceUdenom / 1e6,
    drawBlock:     blockHeight,
    drawBlockHash: blockHash,       // ← NEW: required for Draw Proof verification
    time:          Math.floor(Date.now() / 1000),
    rolledOver:    0,
    txHashes,
  });
  saveWinners(winners);

  log(`=== DRAW COMPLETE === Round #${round} | Winner: ${winnerTicket.address} | Prize: ${winnerAmt/1e6}`);
}

// ─── ENTRY ────────────────────────────────────────────────────────────────────
(async () => {
  const drawType = (process.env.DRAW_TYPE || 'daily').toLowerCase();
  if (!['daily', 'weekly'].includes(drawType)) {
    console.error('DRAW_TYPE must be "daily" or "weekly"'); process.exit(1);
  }
  try { await runDraw(drawType); }
  catch (e) { console.error('FATAL:', e); process.exit(1); }
})();
