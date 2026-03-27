// lottery-draw.js
// Runs via GitHub Actions at 20:00 UTC daily/weekly
// Winner selection: block_hash % total_entries (verifiable on-chain)

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

// Prize split
const DAILY_SPLIT = { winner: 0.80, seeds: 0.10, treasury: 0.10 };
const WEEKLY_SPLIT = [
  { share: 0.48, label: '1st' },
  { share: 0.20, label: '2nd' },
  { share: 0.12, label: '3rd' },
];
const WEEKLY_SEEDS    = 0.10;
const WEEKLY_TREASURY = 0.10;

const MIN_ENTRIES = 5; // minimum to hold draw

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

// ── Fetch participants from on-chain txs ─────────────────────────────────────
// Daily: last 24h txs to DAILY_WALLET (LUNC)
// Weekly: last 7d txs to WEEKLY_WALLET (USTC or LUNC)
async function fetchParticipants(wallet, cutoffSec, isDaily) {
  // { "terra1abc": ticketCount }
  const participants = {};
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = '/v1/txs?account=' + wallet + '&limit=' + limit + '&offset=' + offset;
    let data;
    try { data = await fcdFetch(url); } catch (e) { console.error(e.message); break; }

    const list = (data && data.txs) ? data.txs : [];
    if (!list.length) break;

    let done = false;
    for (const tx of list) {
      const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
      if (ts < cutoffSec) { done = true; break; }

      const msgs = (tx.tx && tx.tx.value && tx.tx.value.msg) ? tx.tx.value.msg : [];
      for (const msg of msgs) {
        if (msg.type !== 'bank/MsgSend') continue;
        const val = msg.value || {};
        if (val.to_address !== wallet) continue;
        const coins = val.amount || [];

        let tickets = 0;
        for (const coin of coins) {
          const amt = Number(coin.amount);
          if (isDaily && coin.denom === DENOM) {
            // Daily: 25,000 LUNC per ticket
            tickets += Math.floor(amt / (25000 * 1e6));
          } else if (!isDaily) {
            // Weekly: USTC or LUNC, price varies — count each tx as entries
            // Each tx = floor(amount / ticket_price) tickets
            if (coin.denom === 'uusd') {
              tickets += Math.floor(amt / (25000 * 1e6)); // approx USTC equiv
            } else if (coin.denom === DENOM) {
              tickets += Math.floor(amt / (25000 * 1e6));
            }
          }
        }

        if (tickets > 0) {
          const sender = val.from_address;
          participants[sender] = (participants[sender] || 0) + tickets;
        }
      }
      if (done) break;
    }
    if (done || list.length < limit) break;
    offset += limit;
  }

  return participants;
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
  const result = await client.sendTokens(
    from, to,
    [{ denom: DENOM, amount: String(Math.floor(amountUluna)) }],
    { amount: [{ denom: DENOM, amount: '5665000' }], gas: '200000' },
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

// ── DAILY DRAW ───────────────────────────────────────────────────────────────
async function runDailyDraw(client, operatorAddr) {
  console.log('\n=== DAILY DRAW ===');
  const cutoff = Math.floor(Date.now() / 1000) - 86400;

  console.log('Fetching participants...');
  const participants = await fetchParticipants(DAILY_WALLET, cutoff, true);
  const tickets = buildTickets(participants);
  console.log('Participants: ' + Object.keys(participants).length + ', Tickets: ' + tickets.length);

  if (tickets.length < MIN_ENTRIES) {
    console.log('Not enough entries (' + tickets.length + ' < ' + MIN_ENTRIES + '). Draw skipped, funds carry to next round.');
    const winners = loadWinners();
    winners.daily.push({
      date:     new Date().toISOString().slice(0, 10),
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

  // Save result
  const winners = loadWinners();
  winners.daily.push({
    date:        new Date().toISOString().slice(0, 10),
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
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;

  console.log('Fetching paid participants...');
  let participants = await fetchParticipants(WEEKLY_WALLET, cutoff, false);
  console.log('Adding free entries...');
  participants = addFreeEntries(participants);

  const tickets = buildTickets(participants);
  console.log('Participants: ' + Object.keys(participants).length + ', Tickets: ' + tickets.length);

  if (tickets.length < MIN_ENTRIES) {
    console.log('Not enough entries (' + tickets.length + ' < ' + MIN_ENTRIES + '). Draw skipped.');
    const winners = loadWinners();
    if (!winners.weekly) winners.weekly = [];
    winners.weekly.push({
      date:    new Date().toISOString().slice(0, 10),
      skipped: true,
      reason:  'Not enough entries: ' + tickets.length,
      entries: tickets.length,
    });
    saveWinners(winners);
    return;
  }

  const balance = await getBalance(WEEKLY_WALLET);
  console.log('Pool balance: ' + fmt(balance / 1e6) + ' LUNC');

  // Select 3 unique winners
  const blockHash = await getBlockHash();
  console.log('Block hash: ' + blockHash);

  const places = [];
  const usedIdx = new Set();
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

  // Save result
  const winners = loadWinners();
  if (!winners.weekly) winners.weekly = [];
  winners.weekly.push({
    date:        new Date().toISOString().slice(0, 10),
    winners:     txs,
    entries:     tickets.length,
    participants: Object.keys(participants).length,
    block_hash:  blockHash,
    tx_treasury: txTreasury,
    seeds_lunc:  Math.floor(prizePot * WEEKLY_SEEDS / 1e6),
  });
  saveWinners(winners);
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
