// lottery-draw-testnet.js
// Testnet version for rebel-2
// Runs via GitHub Actions manually or at 20:00 UTC
// Winner selection: sha256(height:hash:total) % total_entries (verifiable on-chain)

import crypto from 'crypto';
import fs     from 'fs';
import path   from 'path';

// ── Constants ────────────────────────────────────────────────────────────────
const DRAW_TYPE       = process.env.DRAW_TYPE || 'daily';
const IS_DAILY        = DRAW_TYPE === 'daily';
const CHAIN_ID        = 'rebel-2';
const DENOM           = 'uluna';

const DAILY_WALLET    = 'terra1amp68zg7vph3nq84ummnfma4dz753ezxfqa9px';
const WEEKLY_WALLET   = 'terra1p5l6q95kfl3hes7edy76tywav9f79n6xlkz6qz';
const TREASURY_WALLET = 'terra1549z8zd9hkggzlwf0rcuszhc9rs9fxqfy2kagt';

const DRAW_WALLET     = IS_DAILY ? DAILY_WALLET : WEEKLY_WALLET;
const MNEMONIC        = IS_DAILY
  ? process.env.OPERATOR_MNEMONIC_DAILY
  : process.env.OPERATOR_MNEMONIC_WEEKLY;

// Testnet tier prices (LUNC)
const TIER_PRICES = {
  common:    { lunc: 100,  entries: 1  },
  rare:      { lunc: 500,  entries: 5  },
  legendary: { lunc: 1500, entries: 10 },
};

// Prize split
const DAILY_SPLIT  = { winner: 0.80, seeds: 0.10, treasury: 0.10 };
const WEEKLY_SPLIT = [
  { share: 0.48, label: '1st' },
  { share: 0.20, label: '2nd' },
  { share: 0.12, label: '3rd' },
];
const WEEKLY_SEEDS    = 0.10;
const WEEKLY_TREASURY = 0.10;

const MIN_ENTRIES = 2; // testnet: minimum 2 entries

const LCD_BASE = 'https://lcd.luncblaze.com';
const RPC_BASE = 'https://rpc.luncblaze.com';

const WINNERS_PATH      = path.resolve('testnet/winners.json');
const FREE_ENTRIES_PATH = path.resolve('free-entries.json');

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) { return Math.floor(n).toLocaleString(); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Get wallet balance via LCD ───────────────────────────────────────────────
async function getBalance(address) {
  const res = await fetch(`${LCD_BASE}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=10`);
  const data = await res.json();
  const balances = data.balances || [];
  const luna = balances.find(b => b.denom === DENOM);
  return luna ? Number(luna.amount) : 0;
}

// ── Get account info ─────────────────────────────────────────────────────────
async function getAccountInfo(address) {
  const res = await fetch(`${LCD_BASE}/cosmos/auth/v1beta1/accounts/${address}`);
  const data = await res.json();
  const acct = data.account || {};
  return {
    accountNumber: String(acct.account_number || '0'),
    sequence:      String(acct.sequence || '0'),
  };
}

// ── Fetch participants via RPC tx_search ─────────────────────────────────────
async function fetchParticipants(wallet, cutoffSec) {
  // { "terra1abc": entryCount }
  const participants = {};
  let page = 1;
  const perPage = 50;

  while (true) {
    const query = encodeURIComponent(`"transfer.recipient='${wallet}'"`);
    const url = `${RPC_BASE}/tx_search?query=${query}&per_page=${perPage}&page=${page}&order_by="desc"`;
    const res = await fetch(url);
    if (!res.ok) { console.warn('tx_search failed:', res.status); break; }
    const data = await res.json();
    const txs  = data?.result?.txs || [];
    if (!txs.length) break;

    let done = false;
    for (const tx of txs) {
      if (tx.tx_result?.code !== 0) continue;

      // Get block time
      const height = parseInt(tx.height);
      let ts = Math.floor(Date.now() / 1000);
      try {
        const blkRes  = await fetch(`${RPC_BASE}/block?height=${height}`);
        const blkData = await blkRes.json();
        const timeStr = blkData?.result?.block?.header?.time;
        if (timeStr) ts = Math.floor(new Date(timeStr).getTime() / 1000);
      } catch {}

      if (ts < cutoffSec) { done = true; break; }

      // Parse events — collect all coin_received amounts for wallet, take largest
      const events = tx.tx_result?.events || [];
      let fromAddr = null;
      const receivedAmounts = [];

      for (const evt of events) {
        if (evt.type === 'coin_received') {
          const attrs    = evt.attributes || [];
          const receiver = attrs.find(a => a.key === 'receiver')?.value;
          const amount   = attrs.find(a => a.key === 'amount')?.value;
          if (receiver === wallet && amount && amount.includes('uluna')) {
            const uamt = parseInt(amount.replace(/[^0-9]/g, ''));
            if (!isNaN(uamt)) receivedAmounts.push(uamt);
          }
        }
        if (evt.type === 'coin_spent') {
          const attrs   = evt.attributes || [];
          const spender = attrs.find(a => a.key === 'spender')?.value;
          if (spender && spender !== wallet) fromAddr = spender;
        }
      }

      if (!receivedAmounts.length || !fromAddr) continue;

      // Largest amount = actual NFT payment (not tax)
      const receivedUluna = Math.max(...receivedAmounts);
      const luncReceived  = receivedUluna / 1e6;
      const grossLunc     = luncReceived / 0.995; // reverse 0.5% tax

      // Determine entries by tier
      let entries = 1;
      if (Math.abs(grossLunc - TIER_PRICES.legendary.lunc) < TIER_PRICES.legendary.lunc * 0.02) {
        entries = TIER_PRICES.legendary.entries;
      } else if (Math.abs(grossLunc - TIER_PRICES.rare.lunc) < TIER_PRICES.rare.lunc * 0.02) {
        entries = TIER_PRICES.rare.entries;
      } else if (Math.abs(grossLunc - TIER_PRICES.common.lunc) < TIER_PRICES.common.lunc * 0.02) {
        entries = TIER_PRICES.common.entries;
      } else {
        entries = Math.max(1, Math.floor(grossLunc / TIER_PRICES.common.lunc));
      }

      participants[fromAddr] = (participants[fromAddr] || 0) + entries;
      console.log(`  TX ${tx.hash.slice(0,8)}: ${fromAddr.slice(0,12)}... +${entries} entries (~${grossLunc.toFixed(1)} LUNC gross)`);

      if (done) break;
    }

    const total = parseInt(data?.result?.total_count || '0');
    if (done || txs.length < perPage) break;
    page++;
  }

  return participants;
}

// ── Add free entries for Weekly Draw ────────────────────────────────────────
function addFreeEntries(participants) {
  if (!fs.existsSync(FREE_ENTRIES_PATH)) return participants;
  try {
    const data    = JSON.parse(fs.readFileSync(FREE_ENTRIES_PATH, 'utf8'));
    const entries = data.entries || {};
    for (const [wallet, info] of Object.entries(entries)) {
      const total = info.total || 0;
      if (total > 0) {
        participants[wallet] = (participants[wallet] || 0) + total;
        console.log(`  Free entries: ${wallet.slice(0,12)}... +${total}`);
      }
    }
  } catch (e) {
    console.warn('Could not load free-entries.json:', e.message);
  }
  return participants;
}

// ── Build ticket array ───────────────────────────────────────────────────────
function buildTickets(participants) {
  const tickets = [];
  for (const [addr, count] of Object.entries(participants)) {
    for (let i = 0; i < count; i++) tickets.push(addr);
  }
  return tickets;
}

// ── Get latest block hash via RPC ────────────────────────────────────────────
async function getLatestBlock() {
  const res  = await fetch(`${RPC_BASE}/block`);
  const data = await res.json();
  const header = data?.result?.block?.header;
  return {
    height: parseInt(header?.height || '0'),
    hash:   data?.result?.block_id?.hash || '',
  };
}

// ── Select winner using SHA256(height:hash:total) % total ────────────────────
function selectWinner(tickets, blockHeight, blockHash) {
  const total    = BigInt(tickets.length);
  const seedStr  = `${blockHeight}:${blockHash}:${tickets.length}`;
  const seedHex  = crypto.createHash('sha256').update(seedStr).digest('hex');
  const idx      = Number(BigInt('0x' + seedHex) % total);
  return { winner: tickets[idx], index: idx, blockHeight, blockHash, seedHex };
}

// ── Send LUNC via amino signing ───────────────────────────────────────────────
async function sendLunc(fromAddr, privKey, to, amountUluna, memo, acctInfo) {
  if (amountUluna < 1000000) {
    console.log(`Amount too small (<1 LUNC), skipping: ${to} ${fmt(amountUluna/1e6)} LUNC`);
    return null;
  }
  console.log(`Sending ${fmt(amountUluna/1e6)} LUNC to ${to} — ${memo}`);

  // Fee = gas fee + 0.5% tax on amount
  const gasFee  = 5665000; // ~5.665 LUNC for 200000 gas
  const taxFee  = Math.ceil(amountUluna * 0.005); // 0.5% tax
  const totalFee = gasFee + taxFee;
  const gasLimit = '200000';

  // Import cosmjs for signing
  const { DirectSecp256k1Wallet } = await import('@cosmjs/proto-signing');
  const { SigningStargateClient }  = await import('@cosmjs/stargate');

  const wallet = await DirectSecp256k1Wallet.fromKey(privKey, 'terra');
  const client = await SigningStargateClient.connectWithSigner(RPC_BASE, wallet, {
    broadcastPollIntervalMs: 3000,
    broadcastTimeoutMs: 60000,
  });

  const result = await client.sendTokens(
    fromAddr, to,
    [{ denom: DENOM, amount: String(Math.floor(amountUluna)) }],
    { amount: [{ denom: DENOM, amount: String(totalFee) }], gas: gasLimit },
    memo
  );

  if (result.code !== 0) throw new Error('TX failed: ' + result.rawLog);
  console.log('TX hash:', result.transactionHash);
  await sleep(3000); // wait between txs
  return result.transactionHash;
}

// ── Load / save winners.json ──────────────────────────────────────────────────
function loadWinners() {
  if (!fs.existsSync(WINNERS_PATH)) return { daily: [], weekly: [] };
  try { return JSON.parse(fs.readFileSync(WINNERS_PATH, 'utf8')); }
  catch (e) { return { daily: [], weekly: [] }; }
}
function saveWinners(data) {
  fs.mkdirSync(path.dirname(WINNERS_PATH), { recursive: true });
  fs.writeFileSync(WINNERS_PATH, JSON.stringify(data, null, 2));
}

// ── DAILY DRAW ────────────────────────────────────────────────────────────────
async function runDailyDraw(fromAddr, privKey) {
  console.log('\n=== DAILY DRAW (rebel-2 testnet) ===');
  const cutoff = Math.floor(Date.now() / 1000) - 86400;

  console.log('Fetching participants...');
  const participants = await fetchParticipants(DAILY_WALLET, cutoff);
  const tickets      = buildTickets(participants);
  console.log(`Participants: ${Object.keys(participants).length}, Total entries: ${tickets.length}`);

  if (tickets.length < MIN_ENTRIES) {
    console.log(`Not enough entries (${tickets.length} < ${MIN_ENTRIES}). Draw skipped, funds carry over.`);
    const winners = loadWinners();
    winners.daily.push({
      date:    new Date().toISOString().slice(0, 10),
      skipped: true,
      reason:  `Not enough entries: ${tickets.length}`,
      entries: tickets.length,
    });
    saveWinners(winners);
    return;
  }

  // Get balance
  const balance = await getBalance(DAILY_WALLET);
  console.log(`Pool balance: ${fmt(balance/1e6)} LUNC`);

  // Get block
  const { height, hash } = await getLatestBlock();
  console.log(`Block height: ${height}, hash: ${hash.slice(0,16)}...`);

  // Select winner
  const { winner, index, seedHex } = selectWinner(tickets, height, hash);
  console.log(`Seed hex: ${seedHex.slice(0,16)}...`);
  console.log(`Winner index: ${index} / ${tickets.length}`);
  console.log(`Winner: ${winner}`);

  // Calculate prizes
  const toWinner   = Math.floor(balance * DAILY_SPLIT.winner);
  const toTreasury = Math.floor(balance * DAILY_SPLIT.treasury);
  const toSeeds    = balance - toWinner - toTreasury; // stays in wallet
  console.log(`Prize: ${fmt(toWinner/1e6)} LUNC → winner`);
  console.log(`Treasury: ${fmt(toTreasury/1e6)} LUNC`);
  console.log(`Seeds (stays in pool): ${fmt(toSeeds/1e6)} LUNC`);

  // Send prizes
  const txWinner   = await sendLunc(fromAddr, privKey, winner,           toWinner,   'Oracle Draw · Daily Prize',    await getAccountInfo(fromAddr));
  const txTreasury = await sendLunc(fromAddr, privKey, TREASURY_WALLET,  toTreasury, 'Oracle Draw · Daily Treasury', await getAccountInfo(fromAddr));

  // Save result
  const winners = loadWinners();
  winners.daily.push({
    date:         new Date().toISOString().slice(0, 10),
    round:        winners.daily.length + 1,
    winner,
    prize:        Math.floor(toWinner / 1e6),
    entries:      tickets.length,
    participants: Object.keys(participants).length,
    drawBlock:    height,
    drawBlockHash: hash,
    seedHex:      seedHex.slice(0, 16),
    time:         Math.floor(Date.now() / 1000),
    tx_winner:    txWinner,
    tx_treasury:  txTreasury,
  });
  saveWinners(winners);
  console.log('✅ Daily draw complete!');
}

// ── WEEKLY DRAW ───────────────────────────────────────────────────────────────
async function runWeeklyDraw(fromAddr, privKey) {
  console.log('\n=== WEEKLY DRAW (rebel-2 testnet) ===');
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;

  console.log('Fetching paid participants...');
  let participants = await fetchParticipants(WEEKLY_WALLET, cutoff);
  console.log('Adding free entries...');
  participants = addFreeEntries(participants);

  const tickets = buildTickets(participants);
  console.log(`Participants: ${Object.keys(participants).length}, Total entries: ${tickets.length}`);

  if (tickets.length < MIN_ENTRIES) {
    console.log(`Not enough entries (${tickets.length} < ${MIN_ENTRIES}). Draw skipped.`);
    const winners = loadWinners();
    if (!winners.weekly) winners.weekly = [];
    winners.weekly.push({
      date:    new Date().toISOString().slice(0, 10),
      skipped: true,
      reason:  `Not enough entries: ${tickets.length}`,
      entries: tickets.length,
    });
    saveWinners(winners);
    return;
  }

  const balance = await getBalance(WEEKLY_WALLET);
  console.log(`Pool balance: ${fmt(balance/1e6)} LUNC`);

  const { height, hash } = await getLatestBlock();
  console.log(`Block height: ${height}, hash: ${hash.slice(0,16)}...`);

  // Select 3 unique winners
  const places   = [];
  const usedAddrs = new Set();
  let hashSeed   = hash;

  for (let place = 0; place < 3; place++) {
    const seedStr  = `${height}:${hashSeed}:${tickets.length}:${place}`;
    const seedHex  = crypto.createHash('sha256').update(seedStr).digest('hex');
    const total    = BigInt(tickets.length);
    let idx        = Number(BigInt('0x' + seedHex) % total);

    // Skip already used addresses
    let attempts = 0;
    while (usedAddrs.has(tickets[idx]) && attempts < tickets.length) {
      idx = (idx + 1) % tickets.length;
      attempts++;
    }

    usedAddrs.add(tickets[idx]);
    places.push({ address: tickets[idx], index: idx, place: place + 1, seedHex });
    hashSeed = seedHex;
    console.log(`Place ${place+1}: ${tickets[idx]} (index ${idx})`);
  }

  const toTreasury = Math.floor(balance * WEEKLY_TREASURY);
  const txs = [];

  for (const p of places) {
    const split  = WEEKLY_SPLIT[p.place - 1];
    const amount = Math.floor(balance * split.share);
    const tx = await sendLunc(
      fromAddr, privKey, p.address, amount,
      `Oracle Draw · Weekly Prize ${split.label}`,
      await getAccountInfo(fromAddr)
    );
    txs.push({ place: p.place, address: p.address, amount_lunc: Math.floor(amount/1e6), tx });
  }

  const txTreasury = await sendLunc(fromAddr, privKey, TREASURY_WALLET, toTreasury, 'Oracle Draw · Weekly Treasury', await getAccountInfo(fromAddr));

  const winners = loadWinners();
  if (!winners.weekly) winners.weekly = [];
  winners.weekly.push({
    date:         new Date().toISOString().slice(0, 10),
    round:        winners.weekly.length + 1,
    winners:      txs,
    entries:      tickets.length,
    participants: Object.keys(participants).length,
    drawBlock:    height,
    drawBlockHash: hash,
    time:         Math.floor(Date.now() / 1000),
    tx_treasury:  txTreasury,
    seeds_lunc:   Math.floor(balance * WEEKLY_SEEDS / 1e6),
  });
  saveWinners(winners);
  console.log('✅ Weekly draw complete!');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!MNEMONIC) throw new Error('OPERATOR_MNEMONIC not set in environment');

  console.log(`Chain: ${CHAIN_ID}`);
  console.log(`Draw type: ${DRAW_TYPE.toUpperCase()}`);
  console.log(`Draw wallet: ${DRAW_WALLET}`);

  // Derive private key from mnemonic
  const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
  const { stringToPath }            = await import('@cosmjs/crypto');

  const hdWallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix:  'terra',
    hdPaths: [stringToPath("m/44'/330'/0'/0/0")],
  });
  const [account] = await hdWallet.getAccounts();
  console.log(`Operator address: ${account.address}`);

  if (account.address !== DRAW_WALLET) {
    throw new Error(`Mnemonic address ${account.address} does not match expected ${DRAW_WALLET}`);
  }

  // Get private key bytes
  const privKeyObj = await hdWallet['getKeyPair'](stringToPath("m/44'/330'/0'/0/0"));
  const privKey    = privKeyObj.privkey;

  if (IS_DAILY) {
    await runDailyDraw(account.address, privKey);
  } else {
    await runWeeklyDraw(account.address, privKey);
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
