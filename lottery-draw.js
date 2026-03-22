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
const DEV_WALLET      = 'terra17g55uzkm6cr5fcl3vzcrmu73v8as4yvf2kktzr'; // Chat & Oracle fees
const TREASURY_WALLET = 'terra1549z8zd9hkggzlwf0rcuszhc9rs9fxqfy2kagt'; // Lottery 10% share
const CHAIN_ID        = 'columbus-5';
const LCD             = 'https://terra-classic-lcd.publicnode.com';
const LCD_FALLBACK    = 'https://api-terra-ia.cosmosia.notional.ventures';
const FCD             = 'https://fcd.terra.dev';
const RPC             = 'https://terra-classic-rpc.publicnode.com';
const LUNC_PER_TICKET = 25000;   // LUNC
const MIN_TICKETS     = 5;

const WINNER_PCT = 0.80;
const SEED_PCT   = 0.10;  // 10% carries over to next round as starting prize
const TREASURY_PCT = 0.10; // 10% of lottery pool → Protocol Treasury

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

  // 5) Select winners via SHA-256
  // Daily  → 1 winner takes 80% of pool
  // Weekly → 3 winners: 1st=60%, 2nd=25%, 3rd=15% of the 80% prize share
  const WEEKLY_SPLIT = [0.60, 0.25, 0.15]; // of the 80% prize share

  let selectedWinners = [];
  if (isDaily) {
    const idx = selectWinner(blockHeight, blockHash, tickets.length);
    selectedWinners.push({ place: 1, ticket: tickets[idx], idx });
    log(`Winner: ${tickets[idx].address} (ticket #${idx})`);
  } else {
    // Weekly — pick 3 unique winners using different seed offsets
    const usedIdx = new Set();
    for (let place = 1; place <= 3; place++) {
      // Vary seed by appending place number to ensure unique selection
      const seedStr = `${blockHeight}:${blockHash}:${tickets.length}:${place}`;
      const crypto  = require('crypto');
      const seedHex = crypto.createHash('sha256').update(seedStr).digest('hex');
      let idx = Number(BigInt('0x' + seedHex) % BigInt(tickets.length));
      // Skip if already selected (collision avoidance)
      let attempts = 0;
      while (usedIdx.has(idx) && attempts < tickets.length) {
        idx = (idx + 1) % tickets.length;
        attempts++;
      }
      usedIdx.add(idx);
      selectedWinners.push({ place, ticket: tickets[idx], idx });
      log(`Place #${place}: ${tickets[idx].address} (ticket #${idx})`);
    }
  }

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
  const prizeShare  = Math.floor(payablePool * WINNER_PCT);  // 80%
  const seedAmt     = Math.floor(payablePool * SEED_PCT);    // 10% — stays in wallet
  const treasuryAmt = Math.floor(payablePool * TREASURY_PCT); // 10% → Protocol Treasury

  log(`Pool split — Prize: ${prizeShare/1e6} | Seed: ${seedAmt/1e6} | Treasury: ${treasuryAmt/1e6}`);

  // 8) Send payouts
  // Note: seedAmt stays in lottery wallet automatically — no TX needed
  const txHashes = {};

  if (isDaily) {
    const w = selectedWinners[0];
    const amt = prizeShare;
    txHashes.winner = await sendTx(mnemonic, wallet, w.ticket.address, amt, balanceDenom,
      `Lottery Classic Daily #${round} — 🏆 You won ${amt/1e6}!`);
    log(`Daily winner paid: ${amt/1e6}`);
  } else {
    // Weekly — pay 3 winners with their respective shares
    for (const w of selectedWinners) {
      const split = WEEKLY_SPLIT[w.place - 1];
      const amt   = Math.floor(prizeShare * split);
      const label = w.place === 1 ? '🥇' : w.place === 2 ? '🥈' : '🥉';
      txHashes[`winner${w.place}`] = await sendTx(mnemonic, wallet, w.ticket.address, amt, balanceDenom,
        `Lottery Classic Weekly #${round} — ${label} Place ${w.place} · ${amt/1e6}!`);
      log(`Weekly place #${w.place} paid: ${amt/1e6} to ${w.ticket.address}`);
      await sleep(4000);
    }
  }

  await sleep(4000);
  txHashes.treasury = await sendTx(mnemonic, wallet, TREASURY_WALLET, treasuryAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — 🏛 Protocol Treasury`);
  log(`Seed for next round: ${seedAmt/1e6} — remains in lottery wallet`);

  // 9) Record result
  const winnersRecord = isDaily
    ? { winner: selectedWinners[0].ticket.address, winnerIndex: selectedWinners[0].idx, winnerTicketTx: selectedWinners[0].ticket.txhash, prize: prizeShare/1e6 }
    : {
        winners: selectedWinners.map((w, i) => ({
          place: w.place,
          address: w.ticket.address,
          ticketTx: w.ticket.txhash,
          prize: (prizeShare * WEEKLY_SPLIT[i]) / 1e6,
          split: `${WEEKLY_SPLIT[i]*100}%`,
        })),
        prize: prizeShare/1e6,
      };

  winners.unshift({
    round,
    type: drawType,
    ...winnersRecord,
    tickets:       tickets.length,
    totalPool:     balanceUdenom / 1e6,
    seedNextRound: seedAmt / 1e6,
    treasuryShare: treasuryAmt / 1e6,
    drawBlock:     blockHeight,
    drawBlockHash: blockHash,
    time:          Math.floor(Date.now() / 1000),
    rolledOver:    0,
    txHashes,
  });
  saveWinners(winners);

  const summary = isDaily
    ? `Winner: ${selectedWinners[0].ticket.address} | Prize: ${prizeShare/1e6}`
    : `3 winners paid | Total prize: ${prizeShare/1e6}`;
  log(`=== DRAW COMPLETE === Round #${round} | ${summary}`);
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
