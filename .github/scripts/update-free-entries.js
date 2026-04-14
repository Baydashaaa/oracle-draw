// .github/scripts/update-free-entries.js
// Runs hourly via GitHub Actions
// Reads on-chain tx history via FCD → updates free-entries.json

import fetch from 'node-fetch';
import fs    from 'fs';
import path  from 'path';

// ── Constants ────────────────────────────────────────────────────────────────
const TREASURY_WALLET   = 'terra1549z8zd9hkggzlwf0rcuszhc9rs9fxqfy2kagt';
const DAILY_WALLET      = 'terra1amp68zg7vph3nq84ummnfma4dz753ezxfqa9px';
const WEEKLY_WALLET     = 'terra1p5l6q95kfl3hes7edy76tywav9f79n6xlkz6qz';

// Exclude these senders — they send protocol funds, not user payments
const EXCLUDED_SENDERS  = new Set([DAILY_WALLET, WEEKLY_WALLET, TREASURY_WALLET]);

const CHAT_MIN_ULUNA    = 5_000_000_000;    // 5,000 LUNC — chat message (to TREASURY_WALLET)
const Q_MIN_ULUNA       = 100_000_000_000;  // 100,000 LUNC — question pool portion (to WEEKLY_WALLET, always fixed)
const CHAT_ENTRIES_PER_10 = 1;
const CHAT_MAX_PER_DAY    = 2;
const QUESTION_ENTRIES    = 2;
const WINDOW_DAYS         = 90;  // scan 90 days back — entries accumulate
const WINDOW_SEC          = WINDOW_DAYS * 86400;

const FCD_NODES = [
  'https://terra-classic-fcd.publicnode.com',
  'https://fcd.terra-classic.hexxagon.io',
];

const JSON_PATH = path.resolve('free-entries.json');

// ── FCD fetch with fallback ──────────────────────────────────────────────────
async function fcdFetch(endpoint) {
  for (const base of FCD_NODES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(base + endpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'TerraOracle/1.0' },
      });
      clearTimeout(timer);
      if (res.ok) return res.json();
      console.warn('FCD ' + base + ' returned ' + res.status);
    } catch (e) {
      console.warn('FCD ' + base + ' failed: ' + e.message);
    }
  }
  throw new Error('All FCD nodes failed for: ' + endpoint);
}

// ── Fetch all txs involving a wallet since cutoff ────────────────────────────
async function fetchTxsTo(wallet, cutoffSec) {
  const result = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = '/v1/txs?account=' + wallet + '&limit=' + limit + '&offset=' + offset;
    let data;
    try {
      data = await fcdFetch(url);
    } catch (e) {
      console.error('fetchTxsTo error:', e.message);
      break;
    }

    const list = data && data.txs ? data.txs : [];
    if (!list.length) break;

    let done = false;
    for (const tx of list) {
      const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
      if (ts < cutoffSec) { done = true; break; }

      const msgs = (tx.tx && tx.tx.value && tx.tx.value.msg) ? tx.tx.value.msg : [];
      const memo = (tx.tx && tx.tx.value && tx.tx.value.memo) ? tx.tx.value.memo : '';

      for (const msg of msgs) {
        if (msg.type !== 'bank/MsgSend') continue;
        const val = msg.value || {};
        if (val.to_address !== wallet) continue;
        const coins = val.amount || [];
        result.push({
          from:  val.from_address,
          coins: coins,
          memo:  memo,
          ts:    ts,
        });
      }
    }

    if (done || list.length < limit) break;
    offset += limit;
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now    = Math.floor(Date.now() / 1000);
  const cutoff = now - WINDOW_SEC;

  // Load existing JSON
  let existing = { _meta: {}, entries: {} };
  if (fs.existsSync(JSON_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch (e) {}
  }

  // ── Fetch txs to TREASURY_WALLET (chat) and WEEKLY_WALLET (questions) ──────
  console.log('Fetching txs to TREASURY_WALLET (chat fees)...');
  const treasuryTxs = await fetchTxsTo(TREASURY_WALLET, cutoff);
  console.log('Found ' + treasuryTxs.length + ' treasury txs');

  console.log('Fetching txs to WEEKLY_WALLET (question pool)...');
  const weeklyTxs = await fetchTxsTo(WEEKLY_WALLET, cutoff);
  console.log('Found ' + weeklyTxs.length + ' weekly pool txs');

  const chatByWallet = {};
  const questionByWallet = {};

  // ── Chat: txs to TREASURY_WALLET, 5k LUNC per message ───────────────────
  for (const tx of treasuryTxs) {
    if (EXCLUDED_SENDERS.has(tx.from)) continue;
    const uluna = tx.coins.find(function(c) { return c.denom === 'uluna'; });
    if (!uluna) continue;
    const amount = Number(uluna.amount);
    if (amount >= CHAT_MIN_ULUNA && amount < Q_MIN_ULUNA) {
      const day = new Date(tx.ts * 1000).toISOString().slice(0, 10);
      if (!chatByWallet[tx.from]) chatByWallet[tx.from] = {};
      chatByWallet[tx.from][day] = (chatByWallet[tx.from][day] || 0) + 1;
    }
  }

  // ── Questions: txs to WEEKLY_WALLET >= 100k LUNC (always fixed amount) ───
  for (const tx of weeklyTxs) {
    if (EXCLUDED_SENDERS.has(tx.from)) continue;
    const uluna = tx.coins.find(function(c) { return c.denom === 'uluna'; });
    if (!uluna) continue;
    const amount = Number(uluna.amount);
    if (amount >= Q_MIN_ULUNA) {
      questionByWallet[tx.from] = (questionByWallet[tx.from] || 0) + 1;
    }
  }

  // ── Calculate entries ─────────────────────────────────────────────────────
  const allWallets = new Set([
    ...Object.keys(chatByWallet),
    ...Object.keys(questionByWallet),
  ]);
  console.log('Chat wallets: ' + Object.keys(chatByWallet).length + ', Question wallets: ' + Object.keys(questionByWallet).length);

  const entries = {};
  for (const wallet of allWallets) {
    // Chat entries: floor(msgs/10) per day, max 2/day
    let chatTotal = 0;
    if (chatByWallet[wallet]) {
      for (const day of Object.values(chatByWallet[wallet])) {
        const dayEntries = Math.min(
          Math.floor(day / 10) * CHAT_ENTRIES_PER_10,
          CHAT_MAX_PER_DAY
        );
        chatTotal += dayEntries;
      }
    }

    // Question entries: 2 per question
    const qCount = questionByWallet[wallet] || 0;
    const qEntries = qCount * QUESTION_ENTRIES;

    if (chatTotal > 0 || qEntries > 0) {
      entries[wallet] = {
        chat:      chatTotal,
        questions: qEntries,
        total:     chatTotal + qEntries,
      };
    }
  }

  // ── Write JSON ────────────────────────────────────────────────────────────
  const output = {
    _meta: {
      description:  'Free Weekly Draw entries — Terra Oracle protocol',
      sources: {
        chat:      '1 entry per 10 messages per day (max 2/day)',
        questions: '2 entries per Oracle question (200k LUNC)',
      },
      updated:     new Date().toISOString(),
      history_from: new Date(cutoff * 1000).toISOString(),
      window_days: 90,  // historical window for entry tracking
    },
    entries: entries,
  };

  fs.writeFileSync(JSON_PATH, JSON.stringify(output, null, 2));

  const totalEntries = Object.values(entries).reduce(function(s, e) { return s + e.total; }, 0);
  console.log('Done: ' + allWallets.size + ' wallets, ' + totalEntries + ' total entries');
}

main().catch(function(e) { console.error(e); process.exit(1); });
