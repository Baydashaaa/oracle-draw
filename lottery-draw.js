// lottery-draw.js
// Runs via GitHub Actions at 20:00 UTC daily/weekly
// Winner selection: block_hash % total_entries (verifiable on-chain)
//
// Source of participants (NEW): Cloudflare Worker /round-stats?pool=daily|weekly
// After successful draw: POST /round-complete → marks activations consumed

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { stringToPath } from '@cosmjs/crypto';
import { SigningStargateClient }    from '@cosmjs/stargate';
import crypto from 'crypto';
import fs     from 'fs';
import path   from 'path';

// ── Constants ────────────────────────────────────────────────────────────────
const DRAW_TYPE       = process.env.DRAW_TYPE || 'daily';
const IS_DAILY        = DRAW_TYPE === 'daily';
const CHAIN_ID        = 'columbus-5';
const DENOM           = 'uluna';

const DAILY_WALLET    = 'terra1amp68zg7vph3nq84ummnfma4dz753ezxfqa9px';
const WEEKLY_WALLET   = 'terra1p5l6q95kfl3hes7edy76tywav9f79n6xlkz6qz';
const TREASURY_WALLET = 'terra1549z8zd9hkggzlwf0rcuszhc9rs9fxqfy2kagt';

const DRAW_WALLET     = IS_DAILY ? DAILY_WALLET   : WEEKLY_WALLET;
const MNEMONIC        = IS_DAILY
  ? process.env.OPERATOR_MNEMONIC_DAILY
  : process.env.OPERATOR_MNEMONIC_WEEKLY;

// Worker integration
const DRAW_WORKER_URL     = process.env.DRAW_WORKER_URL     || 'https://oracle-draw.vladislav-baydan.workers.dev';
const DISTRIBUTION_SECRET = process.env.DISTRIBUTION_SECRET || '';

// Prize split
const DAILY_SPLIT = { winner: 0.80, seeds: 0.10, treasury: 0.10 };
const WEEKLY_SPLIT = [
  { share: 0.48, label: '1st' },
  { share: 0.20, label: '2nd' },
  { share: 0.12, label: '3rd' },
];
const WEEKLY_SEEDS    = 0.10;
const WEEKLY_TREASURY = 0.10;

const MIN_ENTRIES  = 5;           // minimum to hold daily draw
const WEEKLY_MIN_LUNC = 500000;   // minimum pool balance (LUNC) to hold weekly draw

const RPC_NODES = [
  'https://terra-classic-rpc.publicnode.com',
  'https://rpc.terra-classic.hexxagon.io',
];

const FCD_NODES = [
  'https://terra-classic-fcd.publicnode.com',
  'https://fcd.terra-classic.hexxagon.io',
];

const WINNERS_PATH       = path.resolve('winners.json');
const FREE_ENTRIES_PATH  = path.resolve('free-entries.json');

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) { return Math.floor(n).toLocaleString(); }

async function fcdFetch(endpoint) {
  for (const base of FCD_NODES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(base + endpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'OracleDraw/1.0' },
      });
      clearTimeout(timer);
      if (res.ok) return res.json();
    } catch (e) {
      console.warn('FCD ' + base + ' failed: ' + e.message);
    }
  }
  throw new Error('All FCD nodes failed: ' + endpoint);
}

// ── Fetch participants from Worker /round-stats ──────────────────────────────
// Returns { "terra1abc": entriesCount, ... }
async function fetchParticipants(pool) {
  const url = DRAW_WORKER_URL + '/round-stats?pool=' + pool;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    throw new Error('Worker /round-stats returned HTTP ' + res.status);
  }
  const data = await res.json();
  return data.byWallet || {};
}

// ── Mark activations as consumed after successful draw ──────────────────────
async function markRoundComplete(pool, roundId, winnerWallet, drawTxHash) {
  if (!DISTRIBUTION_SECRET) {
    console.warn('DISTRIBUTION_SECRET not set — skipping /round-complete. Activations will NOT be consumed!');
    return;
  }
  try {
    const res = await fetch(DRAW_WORKER_URL + '/round-complete', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + DISTRIBUTION_SECRET,
      },
      body: JSON.stringify({ pool, roundId, winnerWallet, drawTxHash }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('/round-complete returned HTTP ' + res.status + ':', body.error || body);
      return;
    }
    console.log('/round-complete OK — consumed ' + (body.consumedCount || 0) + ' activations');
  } catch(e) {
    console.warn('/round-complete request failed:', e.message);
  }
}

// Get current round id (matches Worker's getCurrentRoundId logic)
function getCurrentRoundId(pool) {
  const now = new Date();
  if (pool === 'daily') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0));
    if (now.getTime() < d.getTime()) d.setUTCDate(d.getUTCDate() - 1);
    return 'daily_' + d.toISOString().slice(0, 10);
  }
  if (pool === 'weekly') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0));
    const dayOfWeek = d.getUTCDay();
    const diffToMon = (dayOfWeek + 6) % 7;
    d.setUTCDate(d.getUTCDate() - diffToMon);
    if (now.getTime() < d.getTime()) d.setUTCDate(d.getUTCDate() - 7);
    return 'weekly_' + d.toISOString().slice(0, 10);
  }
  return pool + '_unknown';
}

// ── Add free entries for Weekly Draw ────────────────────────────────────────
function addFreeEntries(participants) {
  if (!fs.existsSync(FREE_ENTRIES_PATH)) return participants;
  try {
    const data = JSON.parse(fs.readFileSync(FREE_ENTRIES_PATH, 'utf8'));
    const entries = data.entries || {};
    for (const [wallet, info] of Object.entries(entries)) {
      const total = info.total || 0;
      if (total > 0) {
        participants[wallet] = (participants[wallet] || 0) + total;
      }
    }
  } catch (e) {
    console.warn('Could not load free-entries.json:', e.message);
  }
  return participants;
}

// ── Build ticket array ───────────────────────────────────────────────────────
// [ "terra1abc", "terra1abc", "terra1xyz", ... ]
function buildTickets(participants) {
  const tickets = [];
  for (const [addr, count] of Object.entries(participants)) {
    for (let i = 0; i < count; i++) tickets.push(addr);
  }
  return tickets;
}

// ── Select winner using block hash ───────────────────────────────────────────
// winner_index = BigInt(block_hash_hex) % BigInt(total_tickets)
async function getBlockHash() {
  for (const base of FCD_NODES) {
    try {
      const res = await fetch(base + '/v1/blocks?limit=1', {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const hash = data && data.blocks && data.blocks[0] && data.blocks[0].id
        ? data.blocks[0].id
        : null;
      if (hash) return hash;
    } catch (e) {
      console.warn('Block hash fetch failed:', e.message);
    }
  }
  // Fallback: use current timestamp hash
  console.warn('Using timestamp as fallback randomness source');
  return crypto.createHash('sha256').update(String(Date.now())).digest('hex');
}

function selectWinner(tickets, blockHash) {
  const total = BigInt(tickets.length);
  const hashBig = BigInt('0x' + blockHash.replace(/[^0-9a-fA-F]/g, '').slice(0, 64));
  const idx = Number(hashBig % total);
  return { winner: tickets[idx], index: idx, blockHash };
}

// ── Get wallet balance ───────────────────────────────────────────────────────
async function getBalance(address) {
  for (const base of FCD_NODES) {
    try {
      const res = await fetch(base + '/v1/bank/' + address, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const balances = (data && data.balances) ? data.balances : [];
      const luna = balances.find(function(b) { return b.denom === DENOM; });
      return luna ? Number(luna.amount) : 0;
    } catch (e) {
      console.warn('Balance fetch failed:', e.message);
    }
  }
  return 0;
}

// ── Send LUNC ────────────────────────────────────────────────────────────────
async function sendLunc(client, from, to, amountUluna, memo) {
  if (amountUluna < 1000000) {
    console.log('Amount too small to send (<1 LUNC), skipping: ' + to + ' ' + fmt(amountUluna / 1e6) + ' LUNC');
    return null;
  }
  console.log('Sending ' + fmt(amountUluna / 1e6) + ' LUNC to ' + to + ' — ' + memo);
  // Gas: 300k is safe (200k was hitting out-of-gas on columbus-5).
  // Fee on Terra Classic: gas × ~28.3 uluna — use 8.5M uluna for headroom.
  const result = await client.sendTokens(
    from, to,
    [{ denom: DENOM, amount: String(Math.floor(amountUluna)) }],
    { amount: [{ denom: DENOM, amount: '8500000' }], gas: '300000' },
    memo
  );
  if (result.code !== 0) throw new Error('TX failed: ' + result.rawLog);
  console.log('TX hash: ' + result.transactionHash);
  return result.transactionHash;
}

// ── Load / save winners.json ──────────────────────────────────────────────
function loadWinners() {
  if (!fs.existsSync(WINNERS_PATH)) return { daily: [], weekly: [] };
  try { return JSON.parse(fs.readFileSync(WINNERS_PATH, 'utf8')); } catch (e) { return { daily: [], weekly: [] }; }
}

function saveWinners(data) {
  fs.writeFileSync(WINNERS_PATH, JSON.stringify(data, null, 2));
}

// ── Reset free-entries.json after weekly draw ────────────────────────────────
function resetFreeEntries() {
  try {
    const empty = {
      _meta: {
        description:  'Free Weekly Draw entries — Terra Oracle protocol',
        updated:      new Date().toISOString(),
        reset_reason: 'Weekly draw completed — entries consumed',
      },
      entries: {},
    };
    fs.writeFileSync(FREE_ENTRIES_PATH, JSON.stringify(empty, null, 2));
    console.log('Free entries reset after weekly draw.');
  } catch(e) {
    console.warn('Could not reset free-entries.json:', e.message);
  }
}

// ── DAILY DRAW ───────────────────────────────────────────────────────────────
async function runDailyDraw(client, operatorAddr) {
  console.log('\n=== DAILY DRAW ===');
  const roundId = getCurrentRoundId('daily');
  console.log('Round: ' + roundId);

  console.log('Fetching participants from Worker /round-stats...');
  const participants = await fetchParticipants('daily');
  const tickets = buildTickets(participants);
  console.log('Participants: ' + Object.keys(participants).length + ', Tickets: ' + tickets.length);

  if (tickets.length < MIN_ENTRIES) {
    console.log('Not enough entries (' + tickets.length + ' < ' + MIN_ENTRIES + '). Draw skipped — activations roll over to next round.');
    const winners = loadWinners();
    winners.daily.push({
      date:     new Date().toISOString().slice(0, 10),
      round_id: roundId,
      skipped:  true,
      reason:   'Not enough entries: ' + tickets.length,
      entries:  tickets.length,
    });
    saveWinners(winners);
    return;
  }

  // Get balance
  const balance = await getBalance(DAILY_WALLET);
  console.log('Pool balance: ' + fmt(balance / 1e6) + ' LUNC');

  // Select winner
  const blockHash = await getBlockHash();
  const { winner, index } = selectWinner(tickets, blockHash);
  console.log('Block hash: ' + blockHash);
  console.log('Winner index: ' + index + ' / ' + tickets.length);
  console.log('Winner: ' + winner);

  // Calculate prizes
  const prizePot   = balance;
  const toWinner   = Math.floor(prizePot * DAILY_SPLIT.winner);
  const toTreasury = Math.floor(prizePot * DAILY_SPLIT.treasury);
  // seeds = remainder stays in DAILY_WALLET (no transfer needed)

  console.log('Prize: ' + fmt(toWinner / 1e6) + ' LUNC to winner');
  console.log('Treasury: ' + fmt(toTreasury / 1e6) + ' LUNC');
  console.log('Seeds (stays in pool): ' + fmt((prizePot - toWinner - toTreasury) / 1e6) + ' LUNC');

  // Send prizes
  const txWinner   = await sendLunc(client, operatorAddr, winner, toWinner, 'Oracle Draw — Daily Prize');
  const txTreasury = await sendLunc(client, operatorAddr, TREASURY_WALLET, toTreasury, 'Oracle Draw — Daily Treasury');

  // Mark activations as consumed in Worker
  await markRoundComplete('daily', roundId, winner, txWinner);

  // Save result
  const winners = loadWinners();
  winners.daily.push({
    date:        new Date().toISOString().slice(0, 10),
    round_id:    roundId,
    winner:      winner,
    prize_lunc:  Math.floor(toWinner / 1e6),
    entries:     tickets.length,
    participants: Object.keys(participants).length,
    block_hash:  blockHash,
    winner_index: index,
    tx_winner:   txWinner,
    tx_treasury: txTreasury,
  });
  saveWinners(winners);
  console.log('Daily draw complete!');
}

// ── WEEKLY DRAW ──────────────────────────────────────────────────────────────
async function runWeeklyDraw(client, operatorAddr) {
  console.log('\n=== WEEKLY DRAW ===');
  const roundId = getCurrentRoundId('weekly');
  console.log('Round: ' + roundId);

  console.log('Fetching paid participants from Worker /round-stats...');
  let participants = await fetchParticipants('weekly');
  console.log('Adding free entries from free-entries.json...');
  participants = addFreeEntries(participants);

  const tickets = buildTickets(participants);
  console.log('Participants: ' + Object.keys(participants).length + ', Tickets: ' + tickets.length);

  // Two thresholds must both pass for weekly: entries count AND pool balance
  if (tickets.length < MIN_ENTRIES) {
    console.log('Not enough entries (' + tickets.length + ' < ' + MIN_ENTRIES + '). Draw skipped.');
    const winners = loadWinners();
    if (!winners.weekly) winners.weekly = [];
    winners.weekly.push({
      date:    new Date().toISOString().slice(0, 10),
      round_id: roundId,
      skipped: true,
      reason:  'Not enough entries: ' + tickets.length,
      entries: tickets.length,
    });
    saveWinners(winners);
    return;
  }

  const balance = await getBalance(WEEKLY_WALLET);
  console.log('Pool balance: ' + fmt(balance / 1e6) + ' LUNC');

  const balanceLunc = balance / 1e6;
  if (balanceLunc < WEEKLY_MIN_LUNC) {
    console.log('Pool balance too low (' + fmt(balanceLunc) + ' < ' + fmt(WEEKLY_MIN_LUNC) + ' LUNC). Draw skipped — funds roll over.');
    const winners = loadWinners();
    if (!winners.weekly) winners.weekly = [];
    winners.weekly.push({
      date:     new Date().toISOString().slice(0, 10),
      round_id: roundId,
      skipped:  true,
      reason:   'Pool below minimum: ' + fmt(balanceLunc) + ' / ' + fmt(WEEKLY_MIN_LUNC) + ' LUNC',
      entries:  tickets.length,
      pool_lunc: Math.floor(balanceLunc),
    });
    saveWinners(winners);
    return;
  }

  // Select 3 unique winners
  const blockHash = await getBlockHash();
  console.log('Block hash: ' + blockHash);

  const places = [];
  let hashSeed = blockHash;

  for (let place = 0; place < 3; place++) {
    // Use hash + place number to get different indices
    const seedHash = crypto.createHash('sha256')
      .update(hashSeed + String(place))
      .digest('hex');
    const total = BigInt(tickets.length);
    const hashBig = BigInt('0x' + seedHash.slice(0, 64));
    let idx = Number(hashBig % total);

    // Find unique winner (skip already used addresses)
    const usedAddrs = new Set(places.map(function(p) { return p.address; }));
    let attempts = 0;
    while (usedAddrs.has(tickets[idx]) && attempts < tickets.length) {
      idx = (idx + 1) % tickets.length;
      attempts++;
    }

    places.push({ address: tickets[idx], index: idx, place: place + 1 });
    hashSeed = seedHash;
    console.log('Place ' + (place + 1) + ': ' + tickets[idx] + ' (index ' + idx + ')');
  }

  // Calculate prizes
  const prizePot   = balance;
  const toTreasury = Math.floor(prizePot * WEEKLY_TREASURY);
  // seeds stay in WEEKLY_WALLET

  const txs = [];

  for (const p of places) {
    const split = WEEKLY_SPLIT[p.place - 1];
    const amount = Math.floor(prizePot * split.share);
    const tx = await sendLunc(
      client, operatorAddr, p.address, amount,
      'Oracle Draw — Weekly Prize ' + split.label
    );
    txs.push({ place: p.place, address: p.address, amount_lunc: Math.floor(amount / 1e6), tx });
  }

  const txTreasury = await sendLunc(client, operatorAddr, TREASURY_WALLET, toTreasury, 'Oracle Draw — Weekly Treasury');

  // Mark activations as consumed in Worker (1st place is primary winner; others also get isWinner flag)
  const primaryWinner = places[0].address;
  const primaryTx     = txs[0]?.tx;
  await markRoundComplete('weekly', roundId, primaryWinner, primaryTx);

  // Save result
  const winners = loadWinners();
  if (!winners.weekly) winners.weekly = [];
  winners.weekly.push({
    date:        new Date().toISOString().slice(0, 10),
    round_id:    roundId,
    winners:     txs,
    entries:     tickets.length,
    participants: Object.keys(participants).length,
    block_hash:  blockHash,
    tx_treasury: txTreasury,
    seeds_lunc:  Math.floor(prizePot * WEEKLY_SEEDS / 1e6),
  });
  saveWinners(winners);
  resetFreeEntries(); // entries consumed — reset for next round
  console.log('Weekly draw complete!');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!MNEMONIC) throw new Error('OPERATOR_MNEMONIC not set');

  console.log('Draw type: ' + DRAW_TYPE.toUpperCase());
  console.log('Draw wallet: ' + DRAW_WALLET);

  // Connect wallet
  // Terra Classic uses coin type 330, not standard cosmos 118
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix: 'terra',
    hdPaths: [stringToPath("m/44'/330'/0'/0/0")],
  });
  const [account] = await wallet.getAccounts();
  console.log('Operator address: ' + account.address);

  if (account.address !== DRAW_WALLET) {
    throw new Error('Mnemonic address ' + account.address + ' does not match expected ' + DRAW_WALLET);
  }

  // Connect to RPC
  let client = null;
  for (const rpc of RPC_NODES) {
    try {
      client = await SigningStargateClient.connectWithSigner(rpc, wallet);
      console.log('Connected to RPC: ' + rpc);
      break;
    } catch (e) {
      console.warn('RPC ' + rpc + ' failed: ' + e.message);
    }
  }
  if (!client) throw new Error('Could not connect to any RPC node');

  if (IS_DAILY) {
    await runDailyDraw(client, account.address);
  } else {
    await runWeeklyDraw(client, account.address);
  }
}

main().catch(function(e) {
  console.error('FATAL:', e.message);
  process.exit(1);
});
