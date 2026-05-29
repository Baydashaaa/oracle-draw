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
const Q_MIN_ULUNA       = 100_000_000_000;  // 100,000 LUNC — kept for chat upper bound
const CHAT_ENTRIES_PER_10 = 1;
const QUESTION_ENTRIES    = 2;
const STREAK_14D_ENTRIES  = 2;   // one-time free entries at 14-day streak milestone
const WINDOW_DAYS         = 90;  // scan 90 days back — entries accumulate
const WINDOW_SEC          = WINDOW_DAYS * 86400;

// Terra Oracle Worker — authoritative source for questions and streak milestones
const ORACLE_WORKER   = 'https://terra-oracle-questions.vladislav-baydan.workers.dev';
const ACTIONS_SECRET  = process.env.ACTIONS_SECRET || '';  // for secret-gated streak endpoint

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
  const now        = Math.floor(Date.now() / 1000);
  const windowCut  = now - WINDOW_SEC;

  // Load existing JSON
  let existing = { _meta: {}, entries: {} };
  if (fs.existsSync(JSON_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch (e) {}
  }

  // Respect history_from set by resetFreeEntries() after a weekly draw.
  // Entries accumulate only since the last weekly reset. If history_from is
  // missing or older than the 90-day window, fall back to the window.
  let cutoff = windowCut;
  const histRaw = existing && existing._meta && existing._meta.history_from;
  if (histRaw) {
    const histSec = Math.floor(new Date(histRaw).getTime() / 1000);
    if (!Number.isNaN(histSec) && histSec > windowCut) {
      cutoff = histSec;
      console.log('Using history_from as cutoff (since last weekly reset):', histRaw);
    }
  }
  const cutoffIso = new Date(cutoff * 1000).toISOString();

  // ── Fetch txs to TREASURY_WALLET (chat) ───────────────────────────────────
  console.log('Fetching txs to TREASURY_WALLET (chat fees)...');
  const treasuryTxs = await fetchTxsTo(TREASURY_WALLET, cutoff);
  console.log('Found ' + treasuryTxs.length + ' treasury txs');

  const chatByWallet = {};
  const questionByWallet = {};
  const streakByWallet = {};

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

  // ── Questions: from authoritative questions.json (via Worker /questions) ───
  // NOT from on-chain payments — NFT mints also pay WEEKLY_WALLET and would be
  // miscounted. A question only counts if it's actually recorded as a question.
  console.log('Fetching questions from Worker /questions...');
  try {
    const qRes = await fetch(ORACLE_WORKER + '/questions', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'TerraOracle/1.0' },
    });
    if (qRes.ok) {
      const qData = await qRes.json();
      const questions = (qData && qData.questions) ? qData.questions : [];
      for (const q of questions) {
        if (!q.wallet) continue;
        const created = Number(q.createdAt) || 0;   // unix seconds
        if (created < cutoff) continue;               // only this round
        questionByWallet[q.wallet] = (questionByWallet[q.wallet] || 0) + 1;
      }
      console.log('Counted questions from ' + questions.length + ' total records');
    } else {
      console.warn('Worker /questions returned ' + qRes.status);
    }
  } catch (e) {
    console.error('Questions fetch error:', e.message);
  }

  // ── Streak 14-day milestone: one-time +2 free entries (the round it's earned) ─
  if (ACTIONS_SECRET) {
    console.log('Fetching 14-day streak milestones...');
    try {
      const sRes = await fetch(ORACLE_WORKER + '/streak/milestone14-entries?secret=' + encodeURIComponent(ACTIONS_SECRET), {
        headers: { 'Accept': 'application/json', 'User-Agent': 'TerraOracle/1.0' },
      });
      if (sRes.ok) {
        const sData = await sRes.json();
        for (const m of (sData.wallets || [])) {
          if (!m.wallet || !m.achievedAt) continue;
          const achievedSec = Math.floor(new Date(m.achievedAt).getTime() / 1000);
          if (achievedSec < cutoff) continue;          // only the round it was earned
          streakByWallet[m.wallet] = (streakByWallet[m.wallet] || 0) + STREAK_14D_ENTRIES;
        }
        console.log('Streak milestone wallets credited: ' + Object.keys(streakByWallet).length);
      } else {
        console.warn('Worker /streak/milestone14-entries returned ' + sRes.status);
      }
    } catch (e) {
      console.error('Streak milestone fetch error:', e.message);
    }
  } else {
    console.warn('ACTIONS_SECRET not set — skipping 14-day streak entries');
  }

  // ── Calculate entries ─────────────────────────────────────────────────────
  const allWallets = new Set([
    ...Object.keys(chatByWallet),
    ...Object.keys(questionByWallet),
    ...Object.keys(streakByWallet),
  ]);
  console.log('Chat: ' + Object.keys(chatByWallet).length + ', Questions: ' + Object.keys(questionByWallet).length + ', Streak: ' + Object.keys(streakByWallet).length);

  const entries = {};
  for (const wallet of allWallets) {
    // Chat entries: floor(total_msgs/10) — every 10th message = 1 entry, no daily cap
    let chatTotal = 0;
    if (chatByWallet[wallet]) {
      let totalMsgs = 0;
      for (const day of Object.values(chatByWallet[wallet])) {
        totalMsgs += day;
      }
      chatTotal = Math.floor(totalMsgs / 10) * CHAT_ENTRIES_PER_10;
    }

    // Question entries: 2 per question
    const qEntries = (questionByWallet[wallet] || 0) * QUESTION_ENTRIES;

    // Streak 14-day milestone entries (one-time)
    const sEntries = streakByWallet[wallet] || 0;

    const total = chatTotal + qEntries + sEntries;
    if (total > 0) {
      entries[wallet] = {
        chat:      chatTotal,
        questions: qEntries,
        streak:    sEntries,
        total:     total,
      };
    }
  }

  // ── Write JSON ────────────────────────────────────────────────────────────
  const output = {
    _meta: {
      description:  'Free Weekly Draw entries — Terra Oracle protocol',
      sources: {
        chat:      '1 entry per 10 messages total (no daily cap)',
        questions: '2 entries per Oracle question (from questions.json)',
        streak:    '2 one-time entries at 14-day streak milestone',
      },
      updated:     new Date().toISOString(),
      history_from: cutoffIso,  // preserved reset marker — entries counted since here
      window_days: 90,  // historical window for entry tracking
    },
    entries: entries,
  };

  fs.writeFileSync(JSON_PATH, JSON.stringify(output, null, 2));

  const totalEntries = Object.values(entries).reduce(function(s, e) { return s + e.total; }, 0);
  console.log('Done: ' + allWallets.size + ' wallets, ' + totalEntries + ' total entries');
}

main().catch(function(e) { console.error(e); process.exit(1); });
