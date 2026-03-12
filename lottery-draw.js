#!/usr/bin/env node
/**
 * Lottery Classic — Auto Draw Script
 * Runs via GitHub Actions at 20:00 UTC daily
 *
 * ENV vars (GitHub Secrets):
 *   OPERATOR_MNEMONIC_DAILY   — mnemonic of DAILY_WALLET operator
 *   OPERATOR_MNEMONIC_WEEKLY  — mnemonic of WEEKLY_WALLET operator
 *   DRAW_TYPE                 — "daily" | "weekly"
 */

const fs   = require('fs');
const path = require('path');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const DAILY_WALLET   = 'terra1amp68zg7vph3nq84ummnfma4dz753ezxfqa9px';
const WEEKLY_WALLET  = 'terra1p5l6q95kfl3hes7edy76tywav9f79n6xlkz6qz';
const BURN_WALLET    = 'terra16m05j95p9qvq93cdtchjcpwgvny8f57vzdj06p';
const DEV_WALLET     = 'terra17g55uzkm6cr5fcl3vzcrmu73v8as4yvf2kktzr';
const CHAIN_ID       = 'columbus-5';
const LCD            = 'https://terra-classic-lcd.publicnode.com';
const RPC            = 'https://terra-classic-rpc.publicnode.com';
const LUNC_PER_TICKET = 25_000;   // LUNC
const MIN_TICKETS     = 5;        // minimum tickets to hold draw

// Payout ratios
const WINNER_PCT = 0.80;
const BURN_PCT   = 0.05;
const DEV_PCT    = 0.15;

// ─── HELPERS ────────────────────────────────────────────────────────────────
async function lcdGet(path_) {
  const res = await fetch(LCD + path_);
  if (!res.ok) throw new Error(`LCD ${path_} → ${res.status}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// ─── LOAD winners.json ───────────────────────────────────────────────────────
function loadWinners() {
  const file = path.join(__dirname, 'winners.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return []; }
  }
  return [];
}

// ─── SAVE winners.json ───────────────────────────────────────────────────────
function saveWinners(data) {
  const file = path.join(__dirname, 'winners.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  log('Saved winners.json →', data.length, 'entries');
}

// ─── FETCH TICKETS ───────────────────────────────────────────────────────────
async function fetchTickets(wallet, drawType, windowSec) {
  const cutoff = Math.floor(Date.now() / 1000) - windowSec;
  const tickets = [];
  let nextKey = null;

  log(`Fetching tickets for ${drawType} wallet ${wallet} (window ${windowSec}s)`);

  do {
    let url = `/cosmos/tx/v1beta1/txs?events=transfer.recipient%3D${encodeURIComponent(wallet)}&pagination.limit=100&order_by=ORDER_BY_DESC`;
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
    const data = await lcdGet(url);

    if (!data.txs?.length) break;

    let done = false;
    for (const tx of data.txs) {
      const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
      if (ts < cutoff) { done = true; break; }

      const msgs = tx.tx?.body?.messages || [];
      for (const msg of msgs) {
        if (msg['@type'] !== '/cosmos.bank.v1beta1.MsgSend') continue;
        if (msg.to_address !== wallet) continue;

        for (const coin of (msg.amount || [])) {
          if (drawType === 'daily' && coin.denom === 'uluna') {
            const luncAmt  = Number(coin.amount) / 1e6;
            const numTix   = Math.floor(luncAmt / LUNC_PER_TICKET);
            for (let i = 0; i < numTix; i++) {
              tickets.push({ address: msg.from_address, txhash: tx.txhash, time: ts });
            }
          } else if (drawType === 'weekly' && coin.denom === 'uusd') {
            // Treat every TX to weekly wallet as 1 ticket (simpler)
            tickets.push({ address: msg.from_address, txhash: tx.txhash, time: ts });
          }
        }
      }
      if (done) break;
    }

    nextKey = data.pagination?.next_key || null;
    if (done) break;

  } while (nextKey);

  log(`Found ${tickets.length} tickets`);
  return tickets;
}

// ─── GET CURRENT BLOCK HEIGHT ────────────────────────────────────────────────
async function getBlockHeight() {
  const data = await lcdGet('/cosmos/base/tendermint/v1beta1/blocks/latest');
  return Number(data.block.header.height);
}

// ─── GET WALLET BALANCE ──────────────────────────────────────────────────────
async function getBalance(wallet, denom) {
  const data = await lcdGet(`/cosmos/bank/v1beta1/balances/${wallet}`);
  const coin = (data.balances || []).find(b => b.denom === denom);
  return coin ? Number(coin.amount) : 0;
}

// ─── SEND TRANSACTION ────────────────────────────────────────────────────────
async function sendTx(mnemonic, fromWallet, toWallet, amountUdenom, denom, memo) {
  // Use cosmjs via dynamic import
  const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
  const { SigningStargateClient, coin }  = await import('@cosmjs/stargate');

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'terra',
    hdPath: "m/44'/330'/0'/0/0",
  });

  const client = await SigningStargateClient.connectWithSigner(RPC, wallet);

  const result = await client.sendTokens(
    fromWallet,
    toWallet,
    [{ denom, amount: String(amountUdenom) }],
    { amount: [{ denom: 'uluna', amount: '150000' }], gas: '200000' },
    memo
  );

  if (result.code !== 0) throw new Error(`TX failed (code ${result.code}): ${result.rawLog}`);
  log(`TX OK: ${toWallet} ← ${amountUdenom / 1e6} ${denom === 'uluna' ? 'LUNC' : 'USTC'} | hash: ${result.transactionHash}`);
  return result.transactionHash;
}

// ─── MAIN DRAW LOGIC ─────────────────────────────────────────────────────────
async function runDraw(drawType) {
  log(`=== LOTTERY CLASSIC — ${drawType.toUpperCase()} DRAW ===`);

  const isDaily     = drawType === 'daily';
  const wallet      = isDaily ? DAILY_WALLET : WEEKLY_WALLET;
  const mnemonic    = isDaily
    ? process.env.OPERATOR_MNEMONIC_DAILY
    : process.env.OPERATOR_MNEMONIC_WEEKLY;
  const windowSec   = isDaily ? 86400 : 7 * 86400;
  const balanceDenom = isDaily ? 'uluna' : 'uusd';

  if (!mnemonic) {
    log(`ERROR: OPERATOR_MNEMONIC_${drawType.toUpperCase()} not set`);
    process.exit(1);
  }

  // 1) Get tickets
  const tickets = await fetchTickets(wallet, drawType, windowSec);

  // 2) Load existing winners to get round number & rollover info
  const winners = loadWinners();
  const prevRounds = winners.filter(w => w.type === drawType);
  const round = prevRounds.length + 1;

  // Check rollover
  const lastEntry = prevRounds[prevRounds.length - 1];
  const rolledOver = (lastEntry?.rolledOver || 0) + (tickets.length <= MIN_TICKETS && tickets.length > 0 ? 1 : 0);

  // 3) Check minimum tickets
  if (tickets.length <= MIN_TICKETS) {
    log(`Only ${tickets.length} tickets sold — minimum is ${MIN_TICKETS}. Rolling over.`);
    const rollEntry = {
      round,
      type: drawType,
      winner: null,
      tickets: tickets.length,
      prize: 0,
      totalPool: 0,
      drawBlock: null,
      time: Math.floor(Date.now() / 1000),
      rolledOver: rolledOver,
      noDrawReason: 'insufficient_tickets',
    };
    winners.unshift(rollEntry);
    saveWinners(winners);
    log('No draw. Pool rolls over to next round.');
    return;
  }

  // 4) Get block height for randomness
  const blockHeight = await getBlockHeight();
  log(`Block height for draw: ${blockHeight}`);

  // 5) Select winner
  const winnerIndex = blockHeight % tickets.length;
  const winnerTicket = tickets[winnerIndex];
  log(`Winner index: ${winnerIndex} / ${tickets.length} tickets`);
  log(`Winner address: ${winnerTicket.address}`);

  // 6) Get wallet balance
  const balanceUdenom = await getBalance(wallet, balanceDenom);
  log(`Wallet balance: ${balanceUdenom / 1e6} ${isDaily ? 'LUNC' : 'USTC'}`);

  if (balanceUdenom < 1_000_000) {
    log('ERROR: Wallet balance too low to pay out!');
    process.exit(1);
  }

  // 7) Calculate payouts (reserve gas fees)
  const gasReserve   = isDaily ? 500_000 : 0; // 0.5 LUNC gas reserve
  const payablePool  = balanceUdenom - gasReserve;
  const winnerAmt    = Math.floor(payablePool * WINNER_PCT);
  const burnAmt      = Math.floor(payablePool * BURN_PCT);
  const devAmt       = Math.floor(payablePool * DEV_PCT);

  log(`Payouts: Winner ${winnerAmt/1e6}, Burn ${burnAmt/1e6}, Dev ${devAmt/1e6}`);

  // 8) Send payouts
  const txHashes = {};

  log('Sending winner payout...');
  txHashes.winner = await sendTx(
    mnemonic, wallet, winnerTicket.address,
    winnerAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — 🏆 You won!`
  );
  await sleep(3000);

  log('Sending burn payout...');
  txHashes.burn = await sendTx(
    mnemonic, wallet, BURN_WALLET,
    burnAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — 🔥 Burn`
  );
  await sleep(3000);

  log('Sending dev payout...');
  txHashes.dev = await sendTx(
    mnemonic, wallet, DEV_WALLET,
    devAmt, balanceDenom,
    `Lottery Classic ${drawType} #${round} — ⚙️ Dev fund`
  );

  // 9) Record result
  const entry = {
    round,
    type: drawType,
    winner: winnerTicket.address,
    winnerTicketTx: winnerTicket.txhash,
    tickets: tickets.length,
    prize: winnerAmt / 1e6,
    totalPool: balanceUdenom / 1e6,
    drawBlock: blockHeight,
    time: Math.floor(Date.now() / 1000),
    rolledOver: 0,
    txHashes,
  };

  winners.unshift(entry);
  saveWinners(winners);

  log(`=== DRAW COMPLETE ===`);
  log(`Round #${round} | Winner: ${winnerTicket.address}`);
  log(`Prize: ${winnerAmt/1e6} ${isDaily ? 'LUNC' : 'USTC'}`);
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
(async () => {
  const drawType = (process.env.DRAW_TYPE || 'daily').toLowerCase();
  if (!['daily', 'weekly'].includes(drawType)) {
    console.error('DRAW_TYPE must be "daily" or "weekly"');
    process.exit(1);
  }
  try {
    await runDraw(drawType);
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
  }
})();
