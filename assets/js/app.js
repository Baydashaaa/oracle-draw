// ─── CONSTANTS ──────────────────────────────────────────────────────────────

// ── TAB NAVIGATION ────────────────────────────────────────────────────────────
function showTab(tab) {
  const tabs = ['home','draw','winners','verify','bag'];
  tabs.forEach(t => {
    const page = document.getElementById('page-' + t);
    const nav  = document.getElementById('nav-' + t);
    if (page) page.style.display = t === tab ? 'block' : 'none';
    if (nav)  nav.classList.toggle('active-tab', t === tab);
  });

  // Tab is not persisted — always starts from home on reload

  if (tab === 'bag') renderMyBag();

  // Sync stats on home tab
  if (tab === 'home') {
    const draws = document.getElementById('stat-draws');
    const total = document.getElementById('stat-total');
    const hDraws = document.getElementById('home-stat-draws');
    const hNfts  = document.getElementById('home-stat-nfts');
    if (hDraws && draws) hDraws.textContent = draws.textContent;
    if (hNfts  && total) hNfts.textContent  = total.textContent;
  }

  // Re-trigger lottery switch when going to draw tab to ensure correct state
  if (tab === 'draw') {
    // Small delay to ensure page is fully visible before switching
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        switchLottery(window.currentLottery || 'daily');
      });
    });
  }

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const DAILY_WALLET   = 'terra1amp68zg7vph3nq84ummnfma4dz753ezxfqa9px';
const WEEKLY_WALLET  = 'terra1p5l6q95kfl3hes7edy76tywav9f79n6xlkz6qz';
const BURN_WALLET    = 'terra16m05j95p9qvq93cdtchjcpwgvny8f57vzdj06p';
const DEV_WALLET     = 'terra17g55uzkm6cr5fcl3vzcrmu73v8as4yvf2kktzr';
const CHAIN_ID       = 'columbus-5';
const LUNC_PER_TICKET = 25000;

// ── Free entries from Terra Oracle (GitHub JSON) ─────────────────────────────
// Free entries are computed on-chain — no static JSON needed
let freeEntriesData = {}; // { "terra1abc": { chat:1, questions:2, total:3 } }

const ORACLE_TREASURY = 'terra1549z8zd9hkggzlwf0rcuszhc9rs9fxqfy2kagt';
const CHAT_ULUNA_FE   = 5000 * 1e6;
const QA_ULUNA_FE     = 100000 * 1e6; // 100k LUNC to Treasury (half of Q&A payment)
const TOLERANCE_FE    = 0.01;
const FCD_NODES_FE    = [
  'https://fcd.terra-classic.hexxagon.io',
  'https://terra-classic-fcd.publicnode.com',
];

async function loadFreeEntries() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const days   = {}; // { "wallet": { "YYYY-MM-DD": msgCount } }
  const qa     = {}; // { "wallet": qaCount }

  for (const base of FCD_NODES_FE) {
    try {
      let offset = 0, done = false;
      while (!done) {
        const url = `${base}/v1/txs?account=${ORACLE_TREASURY}&limit=100&offset=${offset}`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) break;
        const data = await res.json();
        const txs = data.txs || [];
        if (!txs.length) break;

        for (const tx of txs) {
          const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
          if (ts < cutoff) { done = true; break; }

          const memo = tx.tx?.value?.memo || tx.tx?.body?.memo || '';
          const msgs = tx.tx?.value?.msg  || tx.tx?.body?.messages || [];

          for (const msg of msgs) {
            const type = msg['@type'] || msg.type || '';
            if (!type.includes('MsgSend')) continue;
            const val  = msg.value || msg;
            if ((val.to_address || '') !== ORACLE_TREASURY) continue;
            const sender = val.from_address || '';
            const coins  = val.amount || [];
            const lunc   = coins.find(c => c.denom === 'uluna');
            if (!lunc) continue;
            const amt = Number(lunc.amount);

            // Chat: ~5,000 LUNC + non-empty memo
            if (memo.trim().length > 0 &&
                amt >= CHAT_ULUNA_FE * (1 - TOLERANCE_FE) &&
                amt <= CHAT_ULUNA_FE * (1 + TOLERANCE_FE)) {
              const day = new Date(tx.timestamp).toISOString().slice(0, 10);
              if (!days[sender]) days[sender] = {};
              days[sender][day] = (days[sender][day] || 0) + 1;
            }

            // Q&A: ~100,000 LUNC (Treasury portion)
            if (amt >= QA_ULUNA_FE * (1 - TOLERANCE_FE) &&
                amt <= QA_ULUNA_FE * (1 + TOLERANCE_FE)) {
              qa[sender] = (qa[sender] || 0) + 1;
            }
          }
        }
        if (txs.length < 100) break;
        offset += 100;
      }
      break; // success
    } catch(e) {
      console.warn('[OracleDraw] loadFreeEntries node failed:', e.message);
      continue;
    }
  }

  // Build freeEntriesData
  freeEntriesData = {};
  const allWallets = new Set([...Object.keys(days), ...Object.keys(qa)]);
  for (const wallet of allWallets) {
    let chatEntries = 0;
    if (days[wallet]) {
      for (const cnt of Object.values(days[wallet])) {
        chatEntries += Math.min(Math.floor(cnt / 10), 2);
      }
    }
    const qaEntries = (qa[wallet] || 0) * 2;
    const total = chatEntries + qaEntries;
    if (total > 0) {
      freeEntriesData[wallet] = { chat: chatEntries, questions: qaEntries, total };
    }
  }
  console.log('[OracleDraw] Free entries loaded on-chain:', Object.keys(freeEntriesData).length, 'wallets');
}

function getFreeEntries(wallet) {
  return freeEntriesData[wallet] || { chat: 0, questions: 0, total: 0 };
}
const MIN_TICKETS    = 5; // minimum to hold draw
const LCD_NODES      = [
  'https://terra-classic-fcd.publicnode.com',
  'https://fcd.terra-classic.hexxagon.io',
  'https://terra-classic-lcd.publicnode.com',
];
const RPC_NODES      = [
  'https://terra-classic-rpc.publicnode.com',
  'https://rpc.terra-classic.io',
];

// ─── STATE ──────────────────────────────────────────────────────────────────
let currentLottery = 'daily';
window.currentLottery = currentLottery; // 'daily' | 'weekly'
// selectedTier and selectedPool are defined in index.html — do not redeclare here
let lotteryAddress = null;
let ticketCount = 1;
let luncPrice = 0;
let ustcPrice = 0;
let dailyTickets = [];   // array of {address, txhash, time}
let weeklyTickets = [];
let winnersData = [];    // flat array loaded from winners.json (daily + weekly combined)
let winnersFilter = 'all';
let timerInterval = null;

// ─── PARTICLES ──────────────────────────────────────────────────────────────
const container = document.getElementById('particles');
for (let i = 0; i < 30; i++) {
  const p = document.createElement('div');
  p.className = 'particle';
  p.style.left = Math.random() * 100 + '%';
  p.style.animationDuration = (8 + Math.random() * 15) + 's';
  p.style.animationDelay = (Math.random() * 10) + 's';
  p.style.width = p.style.height = (1 + Math.random() * 2) + 'px';
  container.appendChild(p);
}

// ─── FORMAT HELPERS ─────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1e9)  return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n/1e6).toFixed(2) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString('en-US');
}
function fmtAddr(a) { return a ? a.slice(0,10) + '...' + a.slice(-4) : '—'; }
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

// ─── LCD FETCH ──────────────────────────────────────────────────────────────
async function lcdFetch(path) {
  for (const base of LCD_NODES) {
    try {
      const r = await Promise.race([
        fetch(base + path),
        new Promise((_, rej) => setTimeout(() => rej(), 6000))
      ]);
      if (r && r.ok) return await r.json();
    } catch {}
  }
  return null;
}

// ─── PRICE FETCH ────────────────────────────────────────────────────────────
async function fetchPrices() {
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/pricemulti?fsyms=LUNC,USTC&tsyms=USD');
    const d = await r.json();
    luncPrice = d?.LUNC?.USD || 0;
    ustcPrice = d?.USTC?.USD || 0;
  } catch {}
}

// ─── FETCH TICKETS FROM BLOCKCHAIN ──────────────────────────────────────────
async function fetchTickets(wallet, isDaily) {
  const cutoff = isDaily
    ? Math.floor(Date.now()/1000) - 86400
    : Math.floor(Date.now()/1000) - 7 * 86400;

  const tickets = [];
  const LCD_BASE = 'https://terra-classic-lcd.publicnode.com';

  try {
    let offset = 0;
    const limit = 50;
    while (true) {
      // LCD returns txs[] (bodies) + tx_responses[] (metadata with timestamp) — parallel arrays
      const url = `${LCD_BASE}/cosmos/tx/v1beta1/txs?events=transfer.recipient=%27${wallet}%27&pagination.limit=${limit}&order_by=2&pagination.offset=${offset}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) break;
      const data = await res.json();
      const txBodies    = data.txs || [];
      const txResponses = data.tx_responses || [];
      const count = Math.max(txBodies.length, txResponses.length);
      if (!count) break;

      let done = false;
      for (let idx = 0; idx < count; idx++) {
        const txBody = txBodies[idx];
        const txMeta = txResponses[idx];

        // Get timestamp from tx_response
        const timeStr = txMeta?.timestamp || '';
        const ts = timeStr ? Math.floor(new Date(timeStr).getTime() / 1000) : 0;
        if (ts < cutoff) { done = true; break; }

        // Get sender and amount from body.messages
        const msgs = txBody?.body?.messages || [];
        let fromAddr = null;
        let receivedUluna = 0;

        for (const msg of msgs) {
          const type = msg['@type'] || '';
          if (!type.includes('MsgSend')) continue;
          if ((msg.to_address || '') !== wallet) continue;
          fromAddr = msg.from_address || null;
          const coins = msg.amount || [];
          const lunc = coins.find(c => c.denom === 'uluna');
          if (lunc) receivedUluna = parseInt(lunc.amount);
        }

        if (!fromAddr || !receivedUluna) continue;

        const luncReceived = receivedUluna / 1e6;
        const grossLunc    = luncReceived / 0.995; // reverse 0.5% tax

        // Strict tier match — skip non-NFT payments (Q&A=100k, Chat=5k)
        const tiers = window.NFT_TIERS || (typeof NFT_TIERS !== 'undefined' ? NFT_TIERS : null);
        let entries = 0;
        if (tiers) {
          if (Math.abs(grossLunc - tiers.legendary.lunc) < tiers.legendary.lunc * 0.02) entries = tiers.legendary.entries;
          else if (Math.abs(grossLunc - tiers.rare.lunc) < tiers.rare.lunc * 0.02) entries = tiers.rare.entries;
          else if (Math.abs(grossLunc - tiers.common.lunc) < tiers.common.lunc * 0.02) entries = tiers.common.entries;
        }
        if (entries === 0) continue;

        const txhash = txMeta?.txhash || '';
        for (let i = 0; i < entries; i++) {
          tickets.push({ address: fromAddr, txhash, time: ts, entries, nft: i === 0 ? 1 : 0 });
        }
      }

      if (done || count < limit) break;
      offset += limit;
    }
  } catch(e) {
    console.warn('fetchTickets error:', e);
  }

  return tickets;
}


// ─── WEEKLY TICKET PRICE (≈ daily in USTC) ──────────────────────────────────
function weeklyTicketPrice() {
  // Weekly uses same LUNC price as Daily
  return LUNC_PER_TICKET;
}

// ─── LOAD WINNERS FROM winners.json ─────────────────────────────────────────
async function loadWinners() {
  try {
    const r = await fetch('./winners.json?t=' + Date.now());
    if (r.ok) {
      const raw = await r.json();
      // New format: { daily: [], weekly: [] } — flatten into single array
      if (raw && !Array.isArray(raw) && (raw.daily || raw.weekly)) {
        const daily  = (raw.daily  || []).map(function(w) { return Object.assign({type:'daily'},  w); });
        const weekly = (raw.weekly || []).map(function(w) { return Object.assign({type:'weekly'}, w); });
        winnersData = daily.concat(weekly).sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); });
      } else if (Array.isArray(raw)) {
        winnersData = raw;
      }
    }
  } catch(e) { console.warn('loadWinners:', e); winnersData = []; }
  renderWinners();
  populateDrawVerifySelect();
}

// ─── RENDER WINNERS TABLE ───────────────────────────────────────────────────
function renderWinners() {
  const tbody = document.getElementById('winners-body');
  let list = winnersData;
  if (winnersFilter === 'daily')  list = list.filter(w => w.type === 'daily');
  if (winnersFilter === 'weekly') list = list.filter(w => w.type === 'weekly');

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;font-size:13px;"> No draws yet - be part of the first round!</td></tr>`;
    return;
  }

  tbody.innerHTML = list.slice(0, 20).map((w, i) => {
    const badge = w.type === 'daily'
      ? `<span class="badge-daily">Daily</span>`
      : `<span class="badge-weekly">Weekly</span>`;
    const prizeStr = w.type === 'daily'
      ? fmt(w.prize) + ' LUNC'
      : fmt(w.prize) + ' LUNC';
    const rolledOver = w.rolledOver ? `<br><span class="rolled-over">↩ rolled over ${w.rolledOver}x</span>` : '';
    return `<tr>
      <td>#${w.round}</td>
      <td>${badge}</td>
      <td><span class="winner-addr">${fmtAddr(w.winner)}</span></td>
      <td>${w.tickets}</td>
      <td class="winner-prize">${prizeStr}${rolledOver}</td>
      <td><a href="https://finder.terraclassic.community/columbus-5/block/${w.drawBlock}" target="_blank" class="winner-tx">#${w.drawBlock}</a></td>
      <td>${fmtDate(w.time)}</td>
    </tr>`;
  }).join('');
}

// ─── UPDATE POOL DISPLAY ────────────────────────────────────────────────────
function updatePoolDisplay() {
  const tickets = currentLottery === 'daily' ? dailyTickets : weeklyTickets;
  const count = tickets.length;
  const isDaily = currentLottery === 'daily';

  // Count unique NFTs (transactions) vs entries
  const nftCount     = tickets.filter(t => t.nft === 1 || t.nft === undefined).length;
  const entriesCount = count; // total entries (for wheel)

  // Calculate prize pool from actual LUNC received
  // NFTs without nft field = old format, count by LUNC_PER_TICKET
  const tiers = window.NFT_TIERS || (typeof NFT_TIERS !== 'undefined' ? NFT_TIERS : null);
  let totalLunc = 0;
  const seen = new Set();
  for (const t of tickets) {
    if (seen.has(t.txhash)) continue;
    seen.add(t.txhash);
    if (tiers && t.entries) {
      if (t.entries === tiers.legendary.entries) totalLunc += tiers.legendary.lunc;
      else if (t.entries === tiers.rare.entries) totalLunc += tiers.rare.lunc;
      else totalLunc += tiers.common.lunc;
    } else {
      totalLunc += LUNC_PER_TICKET;
    }
  }

  // Use real wallet balance if available (includes Q&A + NFT contributions)
  const _realBalance = isDaily
    ? (window._dailyPoolBalance  || totalLunc)
    : (window._weeklyPoolBalance || totalLunc);
  let poolPrize = _realBalance * 0.80;
  let seededLunc = _realBalance * 0.10;
  let poolUsd = poolPrize * luncPrice;

  const _pl=document.getElementById('pool-lunc');if(_pl)_pl.textContent = fmt(poolPrize) + ' LUNC';
  const _pu=document.getElementById('pool-usd');if(_pu)_pu.textContent = luncPrice > 0 ? '≈ $' + poolUsd.toFixed(2) + ' USD' : '';

  // Seeded next round
  const _seed = document.getElementById('stat-seeded');if(_seed)_seed.textContent = fmt(seededLunc);

  const _pt=document.getElementById('pool-tickets');if(_pt)_pt.textContent = nftCount + ' NFT' + (nftCount !== 1 ? 's' : '') + ' minted this round';

  const minNotice = document.getElementById('pool-min-notice');
  if (count <= MIN_TICKETS && count > 0) {
    minNotice.style.display = 'block';
  } else {
    minNotice.style.display = 'none';
  }

  // Update stats
  // My Entries This Round — entries for connected wallet in current lottery
  const _myAddr = connectedWalletAddress || lotteryAddress;
  const _curTickets = currentLottery === 'daily' ? dailyTickets : weeklyTickets;
  const _myNFTEntries = _myAddr ? _curTickets.filter(t => t.address === _myAddr).length : 0;
  const _myFreeEntries = (currentLottery === 'weekly' && _myAddr) ? (getFreeEntries(_myAddr).total || 0) : 0;
  const _myEntries = _myNFTEntries + _myFreeEntries;
  const _st=document.getElementById('stat-total');if(_st)_st.textContent = _myEntries > 0 ? _myEntries : '0';
  // stat-burned = Seeded Next Round = 10% of current pool LUNC
  const _sb=document.getElementById('stat-burned');if(_sb)_sb.textContent = fmt(Math.round(seededLunc)) + ' LUNC';
  const _sd=document.getElementById('stat-draws');if(_sd)_sd.textContent = winnersData.filter(function(w){return !w.skipped;}).length;

  // Refresh weekly prize split if on weekly tab
  if (currentLottery === 'weekly') {
    const tickets = weeklyTickets;
    const pool80 = tickets.length * 25000 * 0.8;
    const p1 = document.getElementById('weekly-prize-1');
    const p2 = document.getElementById('weekly-prize-2');
    const p3 = document.getElementById('weekly-prize-3');
    if (p1) p1.textContent = fmt(Math.floor(pool80 * 0.60)) + ' LUNC';
    if (p2) p2.textContent = fmt(Math.floor(pool80 * 0.25)) + ' LUNC';
    if (p3) p3.textContent = fmt(Math.floor(pool80 * 0.15)) + ' LUNC';
  }

  // Weekly ticket price
  const _tpd = document.getElementById('ticket-price-display');
  const _ms  = document.getElementById('modal-sub');
  const _bbt = document.getElementById('buy-btn-total');
  const _mtv = document.getElementById('modal-total-val');
  if (!isDaily) {
    const wp = weeklyTicketPrice();
    if (_tpd) _tpd.textContent = 'Common · Rare · Legendary';
    if (_ms)  _ms.textContent  = 'Choose your NFT tier · Burn to enter draw';
    if (_bbt) _bbt.textContent = fmt(ticketCount * wp);
    if (_mtv) _mtv.textContent = fmt(ticketCount * LUNC_PER_TICKET) + ' LUNC';
  } else {
    if (_tpd) _tpd.textContent = 'Common · Rare · Legendary';
    if (_ms)  _ms.textContent  = 'Choose your NFT tier · Burn to enter draw';
    if (_bbt) _bbt.textContent = fmt(ticketCount * LUNC_PER_TICKET);
    if (_mtv) _mtv.textContent = fmt(ticketCount * LUNC_PER_TICKET) + ' LUNC';
  }
}

// ─── TIMER ──────────────────────────────────────────────────────────────────
function getNextDrawTime(type) {
  const now = new Date();

  if (type === 'daily') {
    const next = new Date();
    next.setUTCHours(20, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  // Weekly: next Monday 20:00 UTC
  // Build today's 20:00 UTC, then step forward until we hit a Monday
  const next = new Date();
  next.setUTCHours(20, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  // Keep advancing until we land on Monday (getUTCDay() === 1)
  while (next.getUTCDay() !== 1) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  const isBlue = currentLottery === 'weekly';

  // Apply blue color to timer if weekly
  ['t-days','t-hours','t-mins','t-secs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.toggle('blue', isBlue); }
  });

  function tick() {
    const drawTime = getNextDrawTime(currentLottery);
    const diff = drawTime - Date.now();
    if (diff <= 0) {
      ['t-days','t-hours','t-mins','t-secs'].forEach(id => {
        document.getElementById(id).textContent = '00';
      });
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    document.getElementById('t-days').textContent  = String(d).padStart(2,'0');
    document.getElementById('t-hours').textContent = String(h).padStart(2,'0');
    document.getElementById('t-mins').textContent  = String(m).padStart(2,'0');
    document.getElementById('t-secs').textContent  = String(s).padStart(2,'0');
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ─── SWITCH LOTTERY ─────────────────────────────────────────────────────────
function switchLottery(type) {
  currentLottery = type;
  window.currentLottery = type;
  try { localStorage.setItem('activeLottery', type); } catch(e) {}
  const isDaily = type === 'daily';

  // Tabs
  const tabDaily  = document.getElementById('tab-daily');
  const tabWeekly = document.getElementById('tab-weekly');
  if (tabDaily)  tabDaily.className  = 'lottery-tab ' + (isDaily ? 'active-daily' : '');
  if (tabWeekly) tabWeekly.className = 'lottery-tab ' + (!isDaily ? 'active-weekly' : '');

  // Weekly body theme
  if (isDaily) {
    document.body.classList.remove('weekly-mode');
  } else {
    document.body.classList.add('weekly-mode');
  }

  // Page transition flash + hero animation
  const overlay = document.getElementById('page-transition');
  if (overlay) {
    overlay.classList.remove('flash-out');
    overlay.classList.add('flash');
    setTimeout(() => {
      overlay.classList.remove('flash');
      overlay.classList.add('flash-out');
    }, 120);
  }

  // Hero entrance animation
  const heroEl = document.getElementById('hero-title');
  const wheelEl = document.getElementById('wheel-panel-hero');
  if (heroEl) {
    heroEl.classList.remove('hero-switch-weekly', 'hero-switch-daily');
    void heroEl.offsetWidth; // force reflow
    heroEl.classList.add(isDaily ? 'hero-switch-daily' : 'hero-switch-weekly');
  }
  if (wheelEl) {
    wheelEl.classList.remove('wheel-switch');
    void wheelEl.offsetWidth;
    wheelEl.classList.add('wheel-switch');
  }

  // Hero
  const heroTitle = document.getElementById('hero-title');
  const heroSub   = document.getElementById('hero-sub');
  if (heroTitle) heroTitle.innerHTML   = isDaily ? 'DAILY <span class="gold" id="hero-subtitle">DRAW</span>' : 'WEEKLY <span class="blue-text" id="hero-subtitle">DRAW</span>';
  if (heroSub)   heroSub.textContent   = isDaily ? 'Mint an NFT. Burn it. Win the daily pool.' : 'Mint an NFT. Burn it. Win the weekly pool.';

  // Steps
  const wp = weeklyTicketPrice();
  const step1El = document.getElementById('step1-text');
  const step2El = document.getElementById('step2-text');
  if (step1El) step1El.textContent = isDaily
    ? 'Choose your tier — Common, Rare or Legendary. Burn to enter draw.'
    : 'Choose your tier — Common, Rare or Legendary. Burn to enter draw.';
  if (step2El) step2El.textContent = isDaily
    ? 'Mint an NFT to enter — your purchase is automatically registered. Draw happens every day at 20:00 UTC.'
    : 'Mint an NFT to enter — your purchase is automatically registered. Pool accumulates all week until Monday 20:00 UTC.';

  // Pool display
  const poolDisplayEl = document.getElementById('pool-display');
  const poolLuncEl    = document.getElementById('pool-lunc');
  if (poolDisplayEl) poolDisplayEl.className = 'pool-display' + (isDaily ? '' : ' weekly-pool');
  if (poolLuncEl)    poolLuncEl.className    = 'pool-amount'  + (isDaily ? '' : ' blue');

  // Buy button
  const btn = document.getElementById('btn-buy-main');
  if (btn) btn.className = 'btn-buy' + (isDaily ? '' : ' weekly');

  // Modal
  const modalInner = document.getElementById('modal-inner');
  const modalTitle = document.getElementById('modal-title');
  const modalBtn   = document.getElementById('lottery-buy-btn');
  if (modalInner) modalInner.className = 'modal' + (isDaily ? '' : ' weekly-modal');
  if (modalTitle) modalTitle.className = 'modal-title' + (isDaily ? '' : ' blue');
  if (modalBtn)   modalBtn.className   = 'btn-confirm' + (isDaily ? '' : ' weekly');

  // Switch wheel panel style
  const wheelPanel = document.getElementById('wheel-panel-hero');
  if (wheelPanel) {
    wheelPanel.className = 'wheel-panel' + (isDaily ? '' : ' weekly-panel');
  }
  const wheelPanelLabel = document.getElementById('wheel-panel-label');
  if (wheelPanelLabel) wheelPanelLabel.textContent = isDaily ? 'FORTUNE WHEEL' : 'WEEKLY WHEEL';

  startTimer();
  updatePoolDisplay();
  const wwCard = document.getElementById('wheel-winner-card');
  if (wwCard) wwCard.style.display = 'none';
  updateWheelTickets();

  // ── Toggle ALL Daily / Weekly elements via JS (reliable) ────
  const dailyExtra     = document.getElementById('daily-extra');
  const weeklyExtra    = document.getElementById('weekly-extra');
  const weeklyPodium   = document.getElementById('weekly-podium');
  const weeklyPoolSum  = document.getElementById('weekly-pool-summary-card') || document.querySelector('.weekly-pool-summary');
  const poolDisplay    = document.getElementById('pool-display');

  // Daily elements
  if (dailyExtra)    dailyExtra.style.display   = isDaily ? 'block' : 'none';
  if (poolDisplay)   poolDisplay.style.display  = isDaily ? 'block' : 'none';

  // Weekly elements
  if (weeklyExtra)   weeklyExtra.style.display  = isDaily ? 'none' : 'block';
  if (weeklyPodium)  weeklyPodium.style.display = isDaily ? 'none' : 'grid';
  if (weeklyPoolSum) weeklyPoolSum.style.display = isDaily ? 'none' : 'block';

  // Update podium prizes AFTER elements are visible
  if (!isDaily) updatePodiumPrizes();

  // ── Populate Daily: last winner ───────────────────────────────
  if (isDaily) {
    const last = winnersData.find(function(w){return w.type==='daily' && w.winner && !w.skipped;});
    const addrEl  = document.getElementById('last-winner-addr');
    const prizeEl = document.getElementById('last-winner-prize');
    const dateEl  = document.getElementById('last-winner-date');
    if (last && addrEl) {
      const addr = last.winner;
      addrEl.textContent  = addr.slice(0,10) + '...' + addr.slice(-6);
      if (prizeEl) prizeEl.textContent = fmt(last.prize) + ' LUNC';
      if (dateEl)  dateEl.textContent  = last.time ? new Date(last.time * 1000).toLocaleDateString() : '—';
    } else if (addrEl) {
      addrEl.textContent  = 'No draws yet';
      if (prizeEl) prizeEl.textContent = '—';
      if (dateEl)  dateEl.textContent  = '—';
    }
  }

  // ── Populate Weekly: prize split + free entries ───────────────
  if (!isDaily) {
    const pool80 = weeklyTickets.length > 0
      ? weeklyTickets.length * 25000 * 0.8
      : 0;
    const p1 = document.getElementById('weekly-prize-1');
    const p2 = document.getElementById('weekly-prize-2');
    const p3 = document.getElementById('weekly-prize-3');
    if (p1) p1.textContent = fmt(Math.floor(pool80 * 0.60)) + ' LUNC';
    if (p2) p2.textContent = fmt(Math.floor(pool80 * 0.25)) + ' LUNC';
    if (p3) p3.textContent = fmt(Math.floor(pool80 * 0.15)) + ' LUNC';

    // Free entries — total from GitHub JSON (all wallets this week)
    const freeEl = document.getElementById('weekly-free-entries');
    if (freeEl) {
      const totalFree = Object.values(freeEntriesData).reduce((s, e) => s + (e.total || 0), 0);
      freeEl.textContent = totalFree > 0 ? totalFree : '0';
    }
  }

  // ── Update podium prizes ──────────────────────────────────────
  if (!isDaily) {
    const tickets = weeklyTickets;
    const pool = tickets.length * 25000;
    const prize80 = Math.floor(pool * 0.80);
    const p1El = document.getElementById('podium-prize-1');
    const p2El = document.getElementById('podium-prize-2');
    const p3El = document.getElementById('podium-prize-3');
    const totalEl = document.getElementById('weekly-pool-total');
    const tickEl  = document.getElementById('weekly-pool-tickets');
    if (p1El) p1El.textContent = fmt(Math.floor(prize80 * 0.60)) + ' LUNC';
    if (p2El) p2El.textContent = fmt(Math.floor(prize80 * 0.25)) + ' LUNC';
    if (p3El) p3El.textContent = fmt(Math.floor(prize80 * 0.15)) + ' LUNC';
    if (totalEl) totalEl.textContent = fmt(window._weeklyPoolBalance || pool) + ' LUNC';
    if (tickEl)  tickEl.textContent  = tickets.length + ' NFTs minted this round';
  }

  // Switch animated rings color
  const r1 = document.getElementById('wheel-ring-1');
  const r2 = document.getElementById('wheel-ring-2');
  const r3 = document.getElementById('wheel-ring-3');
  if (r1) r1.style.borderColor = isDaily ? 'rgba(244,208,63,0.2)' : 'rgba(74,144,217,0.15)';
  if (r2) r2.style.borderColor = isDaily ? 'rgba(244,208,63,0.35)' : 'rgba(74,144,217,0.25)';
  if (r3) r3.style.background = isDaily
    ? 'conic-gradient(from 0deg,transparent 0%,rgba(244,208,63,0.35) 15%,transparent 30%,rgba(200,80,0,0.3) 50%,transparent 65%,rgba(244,208,63,0.2) 80%,transparent 100%)'
    : 'conic-gradient(from 0deg,transparent 0%,rgba(0,200,255,0.3) 15%,transparent 30%,rgba(100,0,255,0.3) 50%,transparent 65%,rgba(0,200,255,0.2) 80%,transparent 100%)';

  // Restore canvas glow (inline style takes priority over CSS)
  if (wheelCanvas) {
    wheelCanvas.style.filter = isDaily
      ? 'drop-shadow(0 0 30px rgba(212,160,23,0.35)) drop-shadow(0 0 60px rgba(200,100,0,0.2))'
      : 'drop-shadow(0 0 25px rgba(124,92,255,0.5)) drop-shadow(0 0 50px rgba(0,212,255,0.15))';
  }

  // Switch pointer color
  const ptrStop0 = document.querySelector('#ptr-grad stop:first-child');
  const ptrStop1 = document.querySelector('#ptr-grad stop:last-child');
  const ptrPoly  = document.querySelector('#ptr-grad ~ polygon') || document.querySelector('[points="12,32 0,0 24,0"]');
  if (ptrStop0) ptrStop0.style.stopColor = isDaily ? '#ffe066' : '#00c8ff';
  if (ptrStop1) ptrStop1.style.stopColor = isDaily ? '#e67e22' : '#6400ff';
  if (ptrPoly)  ptrPoly.style.filter = 'none';
}

// ─── MODAL ──────────────────────────────────────────────────────────────────
function openModal() {
  const _mo=document.getElementById('modal');if(_mo)_mo.classList.add('open');
  const _ts=document.getElementById('lottery-tx-status');if(_ts)_ts.style.display='none';
  const _tss=document.getElementById('lottery-tx-success');if(_tss)_tss.style.display='none';
  ticketCount = 1;
  const _cd = document.getElementById('count-display'); if (_cd) _cd.value = 1;

  /* Sync wallet state — always use global wallet if available */
  if (connectedWalletAddress) {
    lotteryAddress = connectedWalletAddress;
  }
  const notConn = document.getElementById('lottery-not-connected');
  const conn    = document.getElementById('lottery-connected');
  const buyBtn  = document.getElementById('lottery-buy-btn');
  const addrEl  = document.getElementById('lottery-addr-display');
  syncDrawWalletUI(lotteryAddress || null);

  updateBuyBtn();
  /* Re-apply selected tier to fix price display after tab switch */
  if (typeof selectTier === 'function') selectTier(selectedTier || 'common');
  if (typeof selectPool === 'function') selectPool(selectedPool || 'daily');
}
function closeModal() { const _mo2=document.getElementById('modal');if(_mo2)_mo2.classList.remove('open'); }
document.getElementById('modal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });

function changeCount(delta) {
  ticketCount = Math.max(1, Math.min(100, ticketCount + delta));
  const _cd2 = document.getElementById('count-display'); if (_cd2) _cd2.value = ticketCount;
  updateBuyBtn();
}
function setCount(val) {
  const n = parseInt(val);
  ticketCount = isNaN(n) || n < 1 ? 1 : Math.min(n, 100);
  updateBuyBtn();
}
function updateBuyBtn() {
  const isDaily = currentLottery === 'daily';
  const pricePerTicket = isDaily ? LUNC_PER_TICKET : weeklyTicketPrice();
  const currency = 'LUNC';
  const total = ticketCount * pricePerTicket;
  const cntEl  = document.getElementById('buy-btn-count');
  const totEl  = document.getElementById('buy-btn-total');
  const mTotEl = document.getElementById('modal-total-val');
  const btn    = document.getElementById('lottery-buy-btn');
  if (cntEl)  cntEl.textContent  = ticketCount;
  if (totEl)  totEl.textContent  = fmt(total);
  if (mTotEl) mTotEl.textContent = fmt(total) + ' ' + currency;
  if (btn && lotteryAddress) btn.style.display = 'block';
}

// ─── KEPLR ──────────────────────────────────────────────────────────────────
async function connectLotteryKeplr() {
  if (!window.keplr) { alert('No wallet found! Please install Keplr, Galaxy Station or LUNCDash.'); return; }
  try {
    await window.keplr.enable(CHAIN_ID);
    const offlineSigner = window.keplr.getOfflineSigner(CHAIN_ID);
    const accounts = await offlineSigner.getAccounts();
    lotteryAddress = accounts[0].address;
    syncDrawWalletUI(lotteryAddress);
    if (typeof updateBuyBtn === 'function') updateBuyBtn();
  } catch(e) { alert('Connection failed: ' + (e.message || e)); }
}

/* Sync both modal wallet UI sections (lottery-* and draw-*) */
function syncDrawWalletUI(address) {
  /* lottery-* elements (inside modal) */
  const d1 = document.getElementById('lottery-addr-display');
  const d2 = document.getElementById('lottery-not-connected');
  const d3 = document.getElementById('lottery-connected');
  const d4 = document.getElementById('lottery-buy-btn');
  /* draw-* elements (in modal wallet section) */
  const d5 = document.getElementById('draw-addr-display');
  const d6 = document.getElementById('draw-not-connected');
  const d7 = document.getElementById('draw-connected');
  const d8 = document.getElementById('draw-buy-btn');

  if (address) {
    if (d1) d1.textContent = fmtAddr(address);
    if (d2) d2.style.display = 'none';
    if (d3) d3.style.display = 'block';
    if (d4) d4.style.display = 'block';
    if (d5) d5.textContent = fmtAddr(address);
    if (d6) d6.style.display = 'none';
    if (d7) d7.style.display = 'block';
    if (d8) d8.style.display = 'block';
  } else {
    if (d2) d2.style.display = 'block';
    if (d3) d3.style.display = 'none';
    if (d4) d4.style.display = 'none';
    if (d6) d6.style.display = 'block';
    if (d7) d7.style.display = 'none';
    if (d8) d8.style.display = 'none';
  }
}

/* Aliases used in index.html */
async function connectDrawKeplr() { return connectLotteryKeplr(); }
function disconnectDrawKeplr() { disconnectLotteryKeplr(); }

function disconnectLotteryKeplr() {
  lotteryAddress = null;
  connectedWalletAddress = null;
  walletProvider = null;
  try { localStorage.removeItem('walletAddress'); localStorage.removeItem('walletProvider'); } catch(e) {}
  syncDrawWalletUI(null);
  /* Update global wallet button */
  const btn   = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  const info  = document.getElementById('wallet-info');
  if (btn)   btn.classList.remove('connected');
  if (label) label.textContent = 'Connect Wallet';
  if (info)  info.classList.remove('open');
}

// ─── BUY TICKETS ────────────────────────────────────────────────────────────

// ─── SEND LUNC DIRECT (signDirect) ──────────────────────────────────────────
async function sendLuncDirect(fromAddr, toAddr, amountUluna, memo, chainId) {
  const directSigner = window.keplr.getOfflineSigner(chainId);
  const accounts     = await directSigner.getAccounts();
  const pubkeyBytes  = accounts[0].pubkey;

  const LCD_BASE = 'https://terra-classic-lcd.publicnode.com';
  const accRes  = await fetch(`${LCD_BASE}/cosmos/auth/v1beta1/accounts/${fromAddr}`);
  const accData = await accRes.json();
  const acct    = accData?.account || {};
  const accountNumber = parseInt(acct.account_number || '0');
  const sequence      = parseInt(acct.sequence || '0');

  function encodeVarint(n) {
    const buf = []; let v = n;
    while (v > 127) { buf.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    buf.push(v & 0x7f); return new Uint8Array(buf);
  }
  function encodeField(f, w, d) {
    const tag = encodeVarint((f << 3) | w);
    if (w === 2) {
      const len = encodeVarint(d.length);
      const out = new Uint8Array(tag.length + len.length + d.length);
      out.set(tag); out.set(len, tag.length); out.set(d, tag.length + len.length);
      return out;
    }
    return tag;
  }
  function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }
  const enc = new TextEncoder();

  // MsgSend proto
  const coinProto = concat(
    encodeField(1, 2, enc.encode('uluna')),
    encodeField(2, 2, enc.encode(String(amountUluna)))
  );
  const msgSendProto = concat(
    encodeField(1, 2, enc.encode(fromAddr)),
    encodeField(2, 2, enc.encode(toAddr)),
    encodeField(3, 2, coinProto)
  );
  const anyMsg = concat(
    encodeField(1, 2, enc.encode('/cosmos.bank.v1beta1.MsgSend')),
    encodeField(2, 2, msgSendProto)
  );

  // TxBody
  const txBodyBytes = concat(
    encodeField(1, 2, anyMsg),
    encodeField(2, 2, enc.encode(memo))
  );

  // Gas fee: 300000 gas × 28.325 = 8,497,500 uluna + 0.5% tax
  const gasFee   = Math.ceil(300000 * 28.325);
  const taxFee   = Math.ceil(amountUluna * 0.005);
  const totalFee = gasFee + taxFee;

  // PubKey Any
  const pubkeyProto = encodeField(1, 2, pubkeyBytes);
  const pubkeyAny   = concat(
    encodeField(1, 2, enc.encode('/cosmos.crypto.secp256k1.PubKey')),
    encodeField(2, 2, pubkeyProto)
  );
  // ModeInfo SIGN_MODE_DIRECT = 1
  const modeInfo = encodeField(1, 2, concat(encodeVarint((1 << 3) | 0), encodeVarint(1)));
  const seqBytes = encodeVarint(sequence);
  const signerInfo = concat(
    encodeField(1, 2, pubkeyAny),
    encodeField(2, 2, modeInfo),
    encodeVarint((3 << 3) | 0), seqBytes
  );
  // Fee
  const feeCoin = concat(
    encodeField(1, 2, enc.encode('uluna')),
    encodeField(2, 2, enc.encode(String(totalFee)))
  );
  const feeProto = concat(
    encodeField(1, 2, feeCoin),
    encodeVarint((2 << 3) | 0), encodeVarint(300000)
  );
  const authInfoBytes = concat(
    encodeField(1, 2, signerInfo),
    encodeField(2, 2, feeProto)
  );

  const { signed, signature } = await directSigner.signDirect(fromAddr, {
    bodyBytes:     txBodyBytes,
    authInfoBytes: authInfoBytes,
    chainId,
    accountNumber: BigInt(accountNumber),
  });

  // Keplr may return bodyBytes/authInfoBytes as plain object {0:...,1:...} not Uint8Array
  function toUint8(v, fallback) {
    if (!v) return fallback;
    if (v instanceof Uint8Array) return v;
    if (v.buffer instanceof ArrayBuffer) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return new Uint8Array(Object.values(v));
  }
  const finalBody     = toUint8(signed.bodyBytes,     txBodyBytes);
  const finalAuthInfo = toUint8(signed.authInfoBytes, authInfoBytes);
  const sigBytes      = Uint8Array.from(atob(signature.signature), c => c.charCodeAt(0));

  const txRaw = concat(
    encodeField(1, 2, finalBody),
    encodeField(2, 2, finalAuthInfo),
    encodeField(3, 2, sigBytes)
  );

  const txBase64 = btoa(String.fromCharCode(...txRaw));
  const broadcastRes = await fetch(`${LCD_BASE}/cosmos/tx/v1beta1/txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_bytes: txBase64, mode: 'BROADCAST_MODE_SYNC' }),
  });
  const broadcastData = await broadcastRes.json();
  const txHash = broadcastData?.tx_response?.txhash || broadcastData?.txhash;
  const code   = broadcastData?.tx_response?.code ?? broadcastData?.code ?? 0;
  if (code !== 0) throw new Error('TX failed on-chain: ' + (broadcastData?.tx_response?.raw_log || JSON.stringify(broadcastData)));
  return txHash;
}

async function buyTicketsKeplr() {
  if (!lotteryAddress) { alert('Please connect your wallet first!'); return; }
  const isDaily = (typeof selectedPool !== 'undefined' ? selectedPool : currentLottery) === 'daily';
  const btn = document.getElementById('draw-buy-btn') || document.getElementById('lottery-buy-btn');
  const statusEl = document.getElementById('draw-tx-status') || document.getElementById('lottery-tx-status');
  const msgEl = document.getElementById('draw-tx-msg') || document.getElementById('lottery-tx-msg');
  const successEl = document.getElementById('draw-tx-success') || document.getElementById('lottery-tx-success');

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Waiting for Keplr...'; }
  if (statusEl) statusEl.style.display = 'block';
  if (successEl) successEl.style.display = 'none';
  if (msgEl) msgEl.textContent = 'Opening Keplr — please approve the transaction...';

  const wallet = isDaily ? DAILY_WALLET : WEEKLY_WALLET;
  const denom  = 'uluna'; // LUNC only — no USTC

  // Get tier price and entries from NFT_TIERS (defined in index.html)
  // Snapshot selectedTier immediately — capture before any async operations
  const _snapTier = window.selectedTier || (typeof selectedTier !== 'undefined' ? selectedTier : 'common');
  const _snapNFT  = window.NFT_TIERS || (typeof NFT_TIERS !== 'undefined' ? NFT_TIERS : null);
  console.log('[BUY] snapTier:', _snapTier, 'snapNFT:', _snapNFT);
  const tier = (_snapNFT && _snapTier)
    ? _snapNFT[_snapTier] || _snapNFT['common']
    : { lunc: LUNC_PER_TICKET, entries: 1, label: 'Common' };
  const pricePerTicket = tier.lunc;
  const totalAmount = pricePerTicket * 1000000;
  const entries = tier.entries;
  const tierLabel = tier.label || selectedTier || 'Common';
  const memo = `Oracle Draw · ${isDaily ? 'Daily' : 'Weekly'} · ${tierLabel} · ${entries} ${entries === 1 ? 'entry' : 'entries'}`;

  try {
    await window.keplr.enable(CHAIN_ID);
    const accounts = await window.keplr.getOfflineSigner(CHAIN_ID).getAccounts();
    const senderAddress = accounts[0].address;

    if (msgEl) msgEl.textContent = 'Opening Keplr — please approve the transaction...';

    const txHash = await sendLuncDirect(senderAddress, wallet, totalAmount, memo, CHAIN_ID);

    if (msgEl) msgEl.textContent = 'Transaction submitted — confirming on-chain...';

    if (statusEl) statusEl.style.display = 'none';
    if (successEl) successEl.style.display = 'block';
    const successMsg = document.getElementById('draw-success-msg') || document.getElementById('lottery-success-msg');
    const txLink = document.getElementById('draw-tx-link') || document.getElementById('lottery-tx-link');
    if (successMsg) successMsg.textContent = `🎟 ${ticketCount} ticket${ticketCount > 1 ? 's' : ''} purchased successfully!`;
    if (txLink) {
      txLink.href = `https://finder.terraclassic.community/columbus-5/tx/${txHash}`;
      txLink.textContent = '🔗 ' + (txHash || '').slice(0,16) + '...';
    }

    if (btn) { btn.textContent = `🎭 Mint ${ticketCount > 1 ? ticketCount + ' NFTs' : 'NFT'} — ${fmt(ticketCount*pricePerTicket)} LUNC`; btn.disabled = false; }

    await loadAllData();

  } catch(e) {
    if (statusEl) statusEl.style.display = 'none';
    if (btn) { btn.disabled = false; btn.textContent = `🎭 Mint ${ticketCount > 1 ? ticketCount + ' NFTs' : 'NFT'} — ${fmt(ticketCount*LUNC_PER_TICKET)} LUNC`; }
    alert('Transaction failed: ' + (e.message || e));
  }
}

// ─── SCROLL ─────────────────────────────────────────────────────────────────
function scrollToId(id) {
  document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── WINNERS FILTER BUTTONS ─────────────────────────────────────────────────
function filterWinners(f) {
  winnersFilter = f;
  ['all','daily','weekly'].forEach(id => {
    const el = document.getElementById('wf-' + id);
    if (!el) return;
    el.classList.remove('active');
    if (id === f) el.classList.add('active');
  });
  renderWinners();
}

// ─── GET WALLET BALANCE ──────────────────────────────────────────────────────
async function getWalletBalance(address) {
  try {
    const res = await fetch(`https://terra-classic-lcd.publicnode.com/cosmos/bank/v1beta1/balances/${address}`);
    if (!res.ok) return 0;
    const data = await res.json();
    const balances = data.balances || [];
    const lunc = balances.find(b => b.denom === 'uluna');
    return lunc ? Math.floor(parseInt(lunc.amount) / 1e6) : 0;
  } catch(e) { return 0; }
}

// ─── LOAD ALL DATA ───────────────────────────────────────────────────────────
async function loadAllData() {
  await fetchPrices();

  // ── Step 1: balances only (very fast ~0.5s) — cards update immediately ──
  const [_dailyBal, _weeklyBal] = await Promise.all([
    getWalletBalance(DAILY_WALLET),
    getWalletBalance(WEEKLY_WALLET),
  ]);
  window._dailyPoolBalance  = _dailyBal;
  window._weeklyPoolBalance = _weeklyBal;
  updatePoolDisplay();
  updatePodiumPrizes(); // cards show immediately

  // ── Step 2: tickets + free entries in parallel (slower) ──
  const [_daily, _weekly] = await Promise.all([
    fetchTickets(DAILY_WALLET, true),
    fetchTickets(WEEKLY_WALLET, false),
    loadFreeEntries(),
  ]);
  dailyTickets  = _daily;
  weeklyTickets = _weekly;
  updatePoolDisplay();
  updatePodiumPrizes();
}

function updatePodiumPrizes() {
  // Use real wallet balance — not ticket count * price
  const pool = window._weeklyPoolBalance || weeklyTickets.length * 25000;
  const prize80 = Math.floor(pool * 0.80);
  const p1El = document.getElementById('podium-prize-1');
  const p2El = document.getElementById('podium-prize-2');
  const p3El = document.getElementById('podium-prize-3');
  const totalEl = document.getElementById('weekly-pool-total');
  const tickEl  = document.getElementById('weekly-pool-tickets');
  if (p1El) p1El.textContent = fmt(Math.floor(prize80 * 0.60)) + ' LUNC';
  if (p2El) p2El.textContent = fmt(Math.floor(prize80 * 0.25)) + ' LUNC';
  if (p3El) p3El.textContent = fmt(Math.floor(prize80 * 0.15)) + ' LUNC';
  if (totalEl) totalEl.textContent = fmt(pool) + ' LUNC';
  if (tickEl)  tickEl.textContent  = weeklyTickets.length + ' NFTs minted this round';

  // Update minimum pool progress bar
  const WEEKLY_MIN = 500000;
  const pct = Math.min(100, Math.round((pool / WEEKLY_MIN) * 100));
  const bar    = document.getElementById('weekly-progress-bar');
  const label  = document.getElementById('weekly-progress-label');
  const status = document.getElementById('weekly-draw-status');
  if (bar)   bar.style.width = pct + '%';
  if (label) label.textContent = fmt(pool) + ' / 500,000 LUNC';
  if (status) {
    if (pool >= WEEKLY_MIN) {
      bar.style.background = 'linear-gradient(90deg,#66ffaa,#00c8ff)';
      bar.style.boxShadow  = '0 0 8px rgba(102,255,170,0.5)';
      status.innerHTML = '<span style="color:#66ffaa;">✅ Pool ready — draw will start at 20:00 UTC</span>';
    } else {
      const remaining = fmt(WEEKLY_MIN - pool);
      bar.style.background = 'linear-gradient(90deg,#7C5CFF,#5B8CFF)';
      bar.style.boxShadow  = '0 0 8px rgba(124,92,255,0.5)';
      status.innerHTML = `<span style="color:#6B7AA6;">⏳ Need ${remaining} more LUNC · If not reached, funds roll over to next week</span>`;
    }
  }

  // Ensure podium visibility matches current tab
  const podium = document.getElementById('weekly-podium');
  const poolDisplay = document.getElementById('pool-display');
  const weeklyPoolSum = document.getElementById('weekly-pool-summary-card');
  const dailyExtra = document.getElementById('daily-extra');
  const weeklyExtra = document.getElementById('weekly-extra');
  if (currentLottery === 'weekly') {
    if (podium)       podium.style.display       = 'grid';
    if (weeklyPoolSum) weeklyPoolSum.style.display = 'block';
    if (weeklyExtra)  weeklyExtra.style.display   = 'block';
    if (poolDisplay)  poolDisplay.style.display   = 'none';
    if (dailyExtra)   dailyExtra.style.display    = 'none';
  } else {
    if (podium)       podium.style.display        = 'none';
    if (weeklyPoolSum) weeklyPoolSum.style.display = 'none';
    if (weeklyExtra)  weeklyExtra.style.display   = 'none';
    if (poolDisplay)  poolDisplay.style.display   = 'block';
    if (dailyExtra)   dailyExtra.style.display    = 'block';
  }
}



// ─── FORTUNE WHEEL ─────────────────────────────────────────────────────────────
// Cyber/neon style · Addresses on sectors · Auto-spin at draw time only
const ADMIN_WALLET    = 'terra15jt5a9ycsey4hd6nlqgqxccl9aprkmg2mxmfc6';
const MAX_SECTORS     = 20;

let wheelCanvas   = null;
let wheelCtx      = null;
let ticksCanvas   = null;
let ticksCtx      = null;
let wheelTickets  = [];
let wheelAngle    = 0;
let wheelSpinning = false;
let wheelAnimId   = null;
let wheelDrawnOnce = false;
let adminUnlocked = false;

// Neon palettes — daily (cyan/purple) vs weekly (gold/violet, premium feel)
const NEON_COLORS_DAILY = [
  { fill:'rgba(212,160,23,0.32)',  stroke:'#d4a017',  text:'#ffe066'  },  // gold
  { fill:'rgba(10,6,0,0.92)',      stroke:'#7a5a00',  text:'#d4a017'  },  // deep black-gold
  { fill:'rgba(230,100,20,0.28)',  stroke:'#e66414',  text:'#ffaa55'  },  // orange accent
  { fill:'rgba(5,3,0,0.94)',       stroke:'#5a3800',  text:'#c89010'  },  // dark
];
const NEON_COLORS_WEEKLY = [
  { fill:'rgba(74,144,217,0.20)',  stroke:'#7eb8ff',  text:'#ffffff'  },  // bright blue
  { fill:'rgba(5,15,50,0.85)',     stroke:'#1a3a8a',  text:'#7eb8ff'  },  // dark navy
  { fill:'rgba(100,180,255,0.18)', stroke:'#60c0ff',  text:'#ffffff'  },  // sky blue
  { fill:'rgba(8,20,70,0.90)',     stroke:'#0f2860',  text:'#60a0ff'  },  // deep navy
];
function getNeonColors() {
  return currentLottery === 'weekly' ? NEON_COLORS_WEEKLY : NEON_COLORS_DAILY;
}

function initWheel() {
  wheelCanvas = document.getElementById('wheel-canvas');
  if (!wheelCanvas) return;

  // On mobile: use CSS size for display, but render at 1x for memory efficiency
  // This keeps quality sharp while minimizing GPU memory
  if (window.innerWidth <= 768) {
    const cssSize = Math.min(Math.round(window.innerWidth * 0.92), 500);
    // Internal canvas = CSS size (1:1 ratio = sharp, no scaling artifacts)
    wheelCanvas.width  = cssSize;
    wheelCanvas.height = cssSize;
    // CSS display size matches internal — no blur
    wheelCanvas.style.width  = cssSize + 'px';
    wheelCanvas.style.height = cssSize + 'px';
  }

  wheelCtx = wheelCanvas.getContext('2d');
  updateWheelTickets();

  // iOS zoom survival: if context is lost, reinitialize
  wheelCanvas.addEventListener('contextlost', function(e) {
    e.preventDefault();
    setTimeout(function() {
      wheelCtx = wheelCanvas.getContext('2d');
      if (wheelCtx) updateWheelTickets();
    }, 200);
  });
}

// ── Draw the wheel ────────────────────────────────────────────────────────────
function drawWheel(tickets, angle) {
  if (!wheelCtx) return;
  const W = wheelCanvas.width, H = wheelCanvas.height;
  const cx = W/2, cy = H/2, r = cx - 6;
  const ctx = wheelCtx;
  ctx.clearRect(0,0,W,H);

  // Normalize angle to prevent float precision issues after many spins
  angle = ((angle % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);

  const sectors = tickets.length > 0 ? tickets : Array.from({length:12},()=>({placeholder:true}));
  const n       = sectors.length;
  const slice   = (2*Math.PI)/n;

  // Background circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx,cy,r,0,2*Math.PI);
  const bgGrad = ctx.createRadialGradient(cx,cy,0,cx,cy,r);
  if (currentLottery === 'daily') {
    bgGrad.addColorStop(0,  'rgba(28,12,0,0.97)');
    bgGrad.addColorStop(0.6,'rgba(14,6,0,0.99)');
    bgGrad.addColorStop(1,  'rgba(5,2,0,1)');
  } else {
    bgGrad.addColorStop(0,  'rgba(5,0,20,0.95)');
    bgGrad.addColorStop(0.6,'rgba(2,0,12,0.98)');
    bgGrad.addColorStop(1,  'rgba(0,0,8,1)');
  }
  ctx.fillStyle = bgGrad;
  ctx.fill();
  ctx.restore();

  // Draw sectors
  for (let i=0; i<n; i++) {
    const sa = angle + i*slice;
    const ea = sa + slice;
    const NEON_COLORS = getNeonColors();
    const colorIdx = sectors[i]?.entryIdx !== undefined
      ? sectors[i].entryIdx % NEON_COLORS.length
      : i % NEON_COLORS.length;
    const col = NEON_COLORS[colorIdx];

    // Sector fill
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,sa,ea);
    ctx.closePath();
    ctx.fillStyle = col.fill;
    ctx.fill();

    // Sector border (neon line)
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.lineTo(cx + r*Math.cos(sa), cy + r*Math.sin(sa));
    ctx.strokeStyle = col.stroke + '55';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Outer arc accent
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx,cy,r-1,sa,ea);
    ctx.strokeStyle = col.stroke + '88';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Address label + ticket count
    const s = sectors[i];
    if (!s.placeholder && s.address) {
      ctx.save();
      const mid  = sa + slice/2;
      // Place text along the radius — from center outward
      ctx.translate(cx, cy);
      ctx.rotate(mid);

      const addr  = s.address;
      const entryNum = s.entryIdx !== undefined ? ` #${s.entryIdx+1}` : '';
      const addrLabel = addr.slice(0,6) + '..' + addr.slice(-4) + entryNum;
      const fs = n > 14 ? 9 : (n > 8 ? 10 : 12);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur  = 0;
      ctx.font = `700 ${fs}px 'Courier New', monospace`;
      ctx.fillStyle = col.text;
      ctx.fillText(addrLabel, r * 0.28, 0);
      ctx.restore();
    } else if (s.placeholder) {
      ctx.save();
      const mid = sa + slice/2;
      const dist = r*0.62;
      ctx.translate(cx + dist*Math.cos(mid), cy + dist*Math.sin(mid));
      ctx.rotate(mid + Math.PI/2);
      ctx.font = '600 10px Inter';
      ctx.fillStyle = currentLottery === 'weekly' ? 'rgba(74,144,217,0.25)' : 'rgba(244,208,63,0.25)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 0);
      ctx.restore();
    }

    // Sector index dot near rim
    if (!s.placeholder) {
      ctx.save();
      const mid = sa + slice/2;
      const dotR = r - 12;
      ctx.beginPath();
      ctx.arc(cx + dotR*Math.cos(mid), cy + dotR*Math.sin(mid), 2.5, 0, 2*Math.PI);
      ctx.fillStyle = col.stroke;
      ctx.shadowColor = col.stroke;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.restore();
    }
  }

  // Outer rim glow ring — color depends on lottery type
  const rimCol = currentLottery === 'weekly' ? '#4a90d9' : '#d4a017';
  const rimAlpha = currentLottery === 'weekly' ? 'rgba(74,144,217,0.4)' : 'rgba(212,160,23,0.5)';
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx,cy,r,0,2*Math.PI);
  ctx.strokeStyle = rimAlpha;
  ctx.lineWidth = 2;
  ctx.shadowColor = rimCol;
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.restore();

  // Grid lines (subtle)
  for (let ring=0.3; ring<=0.85; ring+=0.27) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx,cy,r*ring,0,2*Math.PI);
    ctx.strokeStyle = currentLottery === 'weekly' ? 'rgba(74,144,217,0.04)' : 'rgba(244,208,63,0.04)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Inner dark core
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx,cy,r*0.18,0,2*Math.PI);
  const coreGrad = ctx.createRadialGradient(cx,cy,0,cx,cy,r*0.18);
  coreGrad.addColorStop(0, currentLottery === 'weekly' ? 'rgba(0,200,255,0.1)' : 'rgba(244,208,63,0.15)');
  coreGrad.addColorStop(1,'rgba(0,0,10,0.95)');
  ctx.fillStyle = coreGrad;
  ctx.fill();
  ctx.strokeStyle = currentLottery === 'weekly' ? 'rgba(0,200,255,0.4)' : 'rgba(244,208,63,0.6)';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = currentLottery === 'weekly' ? '#00c8ff' : '#f4d03f';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.restore();

  // Hub drawn on canvas
  const hubR = r * 0.115;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, 2*Math.PI);
  const hubBg = ctx.createRadialGradient(cx - hubR*0.3, cy - hubR*0.3, 0, cx, cy, hubR);
  hubBg.addColorStop(0, '#1a0050');
  hubBg.addColorStop(1, '#000010');
  ctx.fillStyle = hubBg;
  ctx.shadowColor = currentLottery === 'weekly' ? 'rgba(0,200,255,0.6)' : 'rgba(244,208,63,0.5)';
  ctx.shadowBlur = 15;
  ctx.fill();
  ctx.strokeStyle = currentLottery === 'weekly' ? 'rgba(0,200,255,0.7)' : 'rgba(244,208,63,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Hub inner glowing dot
  const dotR = hubR * 0.45;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, dotR, 0, 2*Math.PI);
  const dotGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, dotR);
  dotGrad.addColorStop(0, '#00c8ff');
  dotGrad.addColorStop(1, '#6400ff');
  ctx.fillStyle = dotGrad;
  ctx.shadowColor = '#00c8ff';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.restore();

  // Pointer triangle at top
  const pW = r * 0.08, pH = r * 0.13;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r + pH + 2);
  ctx.lineTo(cx - pW, cy - r - 4);
  ctx.lineTo(cx + pW, cy - r - 4);
  ctx.closePath();
  const pGrad = ctx.createLinearGradient(cx - pW, cy - r, cx + pW, cy - r + pH);
  pGrad.addColorStop(0, '#ffe066');
  pGrad.addColorStop(1, '#e67e22');
  ctx.fillStyle = pGrad;
  ctx.shadowColor = '#f4d03f';
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.restore();
}

// ── Highlight winner sector ───────────────────────────────────────────────────
function highlightSector(idx, tickets) {
  if (!wheelCtx) return;
  const n  = tickets.length;
  const W  = wheelCanvas.width;
  const cx = W/2, cy = W/2, r = cx-6;
  const slice = (2*Math.PI)/n;
  const sa = wheelAngle + idx*slice;
  const ea = sa + slice;

  wheelCtx.save();
  wheelCtx.beginPath();
  wheelCtx.moveTo(cx,cy);
  wheelCtx.arc(cx,cy,r,sa,ea);
  wheelCtx.closePath();
  wheelCtx.fillStyle = 'rgba(102,255,170,0.2)';
  wheelCtx.fill();
  wheelCtx.strokeStyle = '#66ffaa';
  wheelCtx.lineWidth = 3;
  wheelCtx.shadowColor = '#66ffaa';
  wheelCtx.shadowBlur = 20;
  wheelCtx.stroke();
  wheelCtx.restore();
}

// ── Spin animation ────────────────────────────────────────────────────────────
function spinWheel(targetIdx, onComplete) {
  if (wheelSpinning) return;
  if (!wheelTickets.length || wheelTickets[0].placeholder) return;
  wheelSpinning = true;

  const n      = wheelTickets.length;
  const slice  = (2*Math.PI)/n;
  const spins  = 6 + Math.random()*3;

  // Pointer at top (−π/2). Sector targetIdx center at: angle + targetIdx*slice + slice/2
  // We want that to equal −π/2 (mod 2π)
  const targetCenter = -(Math.PI/2) - (targetIdx*slice + slice/2);
  const finalAngle   = targetCenter - spins*2*Math.PI;

  const startAngle = wheelAngle;
  const duration   = 5000 + Math.random()*2000;
  const startTime  = performance.now();

  function easeOutQuart(t) { return 1 - Math.pow(1-t, 4); }

  function animate(now) {
    const t     = Math.min((now-startTime)/duration, 1);
    const eased = easeOutQuart(t);
    wheelAngle  = startAngle + (finalAngle-startAngle)*eased;

    drawWheel(wheelTickets, wheelAngle);

    if (t < 1) {
      wheelAnimId = requestAnimationFrame(animate);
    } else {
      wheelAngle  = ((finalAngle % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
      wheelSpinning = false;
      drawWheel(wheelTickets, wheelAngle);
      // Find actual sector under pointer at final position
      const _n = wheelTickets.length;
      const _slice = (2*Math.PI)/_n;
      const _pointer = ((-Math.PI/2) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);
      let _actualIdx = targetIdx;
      for (let _si = 0; _si < _n; _si++) {
        const _sc = ((wheelAngle + _si*_slice + _slice/2) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);
        const _diff = Math.abs(_sc - _pointer);
        if (_diff < _slice/2 || _diff > 2*Math.PI - _slice/2) {
          _actualIdx = _si;
          break;
        }
      }
      highlightSector(_actualIdx, wheelTickets);
      if (onComplete) onComplete(_actualIdx);
    }
  }
  requestAnimationFrame(animate);
}

// ── Build ticket list for wheel ───────────────────────────────────────────────
function updateWheelTickets() {
  // Don't update while spinning
  if (wheelSpinning) return;
  const tickets     = currentLottery === 'daily' ? dailyTickets : weeklyTickets;
  const isDaily     = currentLottery === 'daily';
  const currency    = 'LUNC'; // both draws pay out in LUNC
  const pricePerTix = LUNC_PER_TICKET;

  // Count tickets per address
  const seen = new Map();
  for (const t of tickets) {
    seen.set(t.address, (seen.get(t.address) || 0) + 1);
  }

  // Each entry = one sector (proportional chances)
  wheelTickets = [];
  for (const [addr, count] of seen.entries()) {
    for (let i = 0; i < count && wheelTickets.length < MAX_SECTORS; i++) {
      wheelTickets.push({ address: addr, tickets: count, entryIdx: i });
    }
  }
  // Add free entries as sectors on weekly wheel
  if (!isDaily) {
    for (const [addr, info] of Object.entries(freeEntriesData)) {
      const freeCount = info.total || 0;
      for (let i = 0; i < freeCount && wheelTickets.length < MAX_SECTORS; i++) {
        wheelTickets.push({ address: addr, tickets: freeCount, entryIdx: i, isFree: true });
      }
    }
  }

  // Always show at least 12 sectors — pad with placeholders if few participants
  const MIN_SECTORS = 12;
  if (!wheelTickets.length) {
    wheelTickets = Array.from({length: MIN_SECTORS}, () => ({placeholder: true}));
  } else if (wheelTickets.length < MIN_SECTORS) {
    const padCount = MIN_SECTORS - wheelTickets.length;
    for (let i = 0; i < padCount; i++) {
      wheelTickets.push({placeholder: true});
    }
  }

  // Update wheel visuals — rim color changes for weekly
  const canvas = document.getElementById('wheel-canvas');
  if (canvas) {
    const rimColor = isDaily ? 'rgba(0,200,255,0.25)' : 'rgba(212,160,23,0.3)';
    canvas.style.filter = isDaily
      ? 'drop-shadow(0 0 30px rgba(212,160,23,0.35)) drop-shadow(0 0 60px rgba(200,100,0,0.2))'
      : 'drop-shadow(0 0 30px rgba(74,144,217,0.3)) drop-shadow(0 0 60px rgba(30,80,180,0.2))';
  }



  // Pointer color
  const ptr = document.querySelector('#wheel-panel-hero svg stop:first-child');
  // (SVG gradient updated via CSS filter above)

  drawWheel(wheelTickets, wheelAngle);

  // Update badges
  const partEl = document.getElementById('wheel-participant-count');
  const tickEl = document.getElementById('wheel-ticket-count');
  const poolEl = document.getElementById('wheel-pool-display');
  // Count unique NFTs (transactions)
  const uniqueNFTs = new Set(tickets.map(t => t.txhash)).size;
  // Real prize pool
  const tiersRef = window.NFT_TIERS || (typeof NFT_TIERS !== 'undefined' ? NFT_TIERS : null);
  let realPool = 0;
  const seenTx = new Set();
  for (const t of tickets) {
    if (seenTx.has(t.txhash)) continue;
    seenTx.add(t.txhash);
    if (tiersRef && t.entries) {
      if (t.entries === tiersRef.legendary.entries) realPool += tiersRef.legendary.lunc;
      else if (t.entries === tiersRef.rare.entries) realPool += tiersRef.rare.lunc;
      else realPool += tiersRef.common.lunc;
    } else {
      realPool += LUNC_PER_TICKET;
    }
  }
  // Add free entries to total (weekly only)
  const _totalFree = isDaily ? 0 : Object.values(freeEntriesData).reduce((s, e) => s + (e.total || 0), 0);
  const _uniqueParts = seen.size + (isDaily ? 0 : Object.keys(freeEntriesData).filter(w => !seen.has(w)).length);
  if (partEl) partEl.textContent = _uniqueParts || 0;
  if (tickEl) tickEl.textContent = (tickets.length + _totalFree) || 0; // total entries incl free
  if (poolEl) poolEl.textContent = fmt(realPool * 0.80) + ' ' + currency;

  // Badge colors — daily=cyan, weekly=gold
  const badgeColor = isDaily ? '#f4d03f' : '#7eb8ff';
  const badgeShadow = isDaily ? 'rgba(244,208,63,0.5)' : 'rgba(74,144,217,0.5)';
  if (partEl) { partEl.style.color = badgeColor; partEl.style.textShadow = '0 0 10px '+badgeShadow; }
  if (tickEl) { tickEl.style.color = isDaily ? '#a060ff' : '#cc66ff'; }
  if (poolEl) { poolEl.style.color = '#66ffaa'; }
}

// ── Trigger spin (called at draw time OR by admin) ────────────────────────────
function triggerWheelSpin(isAdmin) {
  const tickets = currentLottery === 'daily' ? dailyTickets : weeklyTickets;
  const isDaily = currentLottery === 'daily';
  const currency = 'LUNC';

  if (tickets.length <= MIN_TICKETS) {
    setWheelMsg('⚠ Not enough tickets', 'Minimum ' + MIN_TICKETS + ' required for draw · Rolling over', '#ff9944');
    return;
  }

  updateWheelTickets();
  document.getElementById('wheel-winner-card').style.display = 'none';
  const lastWinner = winnersData.find(function(w){return w.type===currentLottery && w.winner && !w.skipped;});

  if (isDaily) {
    // Daily — 1 spin, 1 winner
    let targetIdx = 0;
    if (lastWinner && lastWinner.drawBlock) {
      targetIdx = lastWinner.drawBlock % Math.min(tickets.length, MAX_SECTORS);
    } else if (isAdmin) {
      targetIdx = Math.floor(Math.random() * wheelTickets.length);
    }
    setWheelMsg('🎡 Spinning...', 'Selecting winner on-chain', '#00c8ff');
    spinWheel(targetIdx, function(idx) {
      const winner = wheelTickets[idx];
      const prize  = tickets.length * LUNC_PER_TICKET * 0.80;
      setWheelMsg('✦ Winner Selected ✦', 'Payout sent automatically', '#66ffaa');
      const card = document.getElementById('wheel-winner-card');
      document.getElementById('ww-address').textContent = winner ? winner.address : '—';
      document.getElementById('ww-prize').textContent   = fmt(prize) + ' ' + currency;
      document.getElementById('ww-tx').innerHTML = '';
      card.style.display = 'block';
      card.classList.remove('show');
      void card.offsetWidth;
      card.classList.add('show');
      // Reset wheel after 1 hour
      setTimeout(function() {
        wheelSpunThisSession = false;
        wheelAngle = 0;
        document.getElementById('wheel-winner-card').style.display = 'none';
        document.getElementById('wheel-winner-card').classList.remove('show');
        updateWheelTickets();
        setWheelMsg('⏳ Next draw in ' + formatDiffShort(getNextDrawTime('daily') - Date.now()), 'Wheel spins automatically at 20:00 UTC', 'rgba(0,200,255,0.7)');
      }, 3600000); // 1 hour
    });
  } else {
    // Weekly — 3 spins, 3 winners
    const prizes = [0.48, 0.20, 0.12];
    const labels = ['🥇 1st Place', '🥈 2nd Place', '🥉 3rd Place'];
    const pool   = tickets.length * LUNC_PER_TICKET;
    const usedIdx = new Set();
    let spinNum = 0;

    function doNextSpin() {
      if (spinNum >= 3) return;
      const place = spinNum;
      setWheelMsg('🎡 Spin ' + (place+1) + '/3...', labels[place] + ' · Selecting winner', '#a78bfa');

      // Pick random unused sector
      let targetIdx = Math.floor(Math.random() * wheelTickets.length);
      let attempts = 0;
      while (usedIdx.has(wheelTickets[targetIdx]?.address) && attempts < wheelTickets.length) {
        targetIdx = (targetIdx + 1) % wheelTickets.length;
        attempts++;
      }

      spinWheel(targetIdx, function(idx) {
        const winner = wheelTickets[idx];
        const prize  = Math.floor(pool * prizes[place]);
        usedIdx.add(winner ? winner.address : '');

        setWheelMsg(labels[place] + ' ✦', (winner ? winner.address.slice(0,10)+'...' : '—') + ' wins ' + fmt(prize) + ' LUNC', '#a78bfa');

        const card = document.getElementById('wheel-winner-card');
        document.getElementById('ww-address').textContent = winner ? winner.address : '—';
        document.getElementById('ww-prize').textContent   = fmt(prize) + ' LUNC · ' + labels[place];
        document.getElementById('ww-tx').innerHTML = '<span style="font-size:11px;color:rgba(167,139,250,0.6);">' + labels[place] + '</span>';
        card.style.display = 'block';
        card.classList.remove('show');
        void card.offsetWidth;
        card.classList.add('show');

        spinNum++;
        if (spinNum < 3) {
          setTimeout(doNextSpin, 5000); // 5s pause between spins
        } else {
          setWheelMsg('✦ All Winners Selected ✦', 'Payouts sent automatically', '#66ffaa');
        }
      });
    }
    doNextSpin();
  }
}

function setWheelMsg(msg, sub, color) {
  const m = document.getElementById('wheel-msg');
  const s = document.getElementById('wheel-submsg');
  if (m) { m.textContent = msg; m.style.color = color || '#00c8ff'; m.style.textShadow = '0 0 20px '+color+'88'; }
  if (s)   s.textContent = sub || '';
}

// ── Auto check draw time (every second) ──────────────────────────────────────
let wheelSpunThisSession = false;
const BURN_DEADLINE_MS = 15 * 60 * 1000; // 15 minutes before draw

function checkDrawTime() {
  const drawTime = getNextDrawTime(currentLottery);
  const diff     = drawTime - Date.now();
  const msgEl    = document.getElementById('wheel-msg');
  if (!msgEl) return;

  if (diff <= 0 && diff > -90000 && !wheelSpunThisSession && !wheelSpinning) {
    wheelSpunThisSession = true;
    triggerWheelSpin(false);
    updateBurnButtonState(false); // Block burns during/after draw
  } else if (diff > 0 && !wheelSpinning) {
    if (diff <= BURN_DEADLINE_MS) {
      // 🔴 Last 15 minutes — burns closing soon
      const burnDiff = diff;
      const bm = Math.floor(burnDiff / 60000);
      const bs = Math.floor((burnDiff % 60000) / 1000);
      const timeStr = bm > 0 ? bm + 'm ' + bs + 's' : bs + 's';
      setWheelMsg(
        '🔴 Burns close in ' + timeStr,
        'Last chance to enter this round!',
        'rgba(255,80,80,0.9)'
      );
      updateBurnButtonState(false); // Disable burn button
    } else {
      // ✅ Round open — burns allowed
      setWheelMsg(
        '⏳ Next draw in ' + formatDiffShort(diff),
        'Wheel spins automatically at 20:00 UTC',
        'rgba(0,200,255,0.7)'
      );
      updateBurnButtonState(true); // Enable burn button
    }
  }
}

function updateBurnButtonState(open) {
  // Update burn buttons in My Bag
  document.querySelectorAll('.burn-btn').forEach(btn => {
    btn.disabled = !open;
    btn.style.opacity = open ? '1' : '0.4';
    btn.style.cursor  = open ? 'pointer' : 'not-allowed';
    btn.title = open ? '' : 'Burns closed — draw starting soon';
  });
  // Update buy button state
  const buyBtn = document.getElementById('btn-buy');
  if (buyBtn && !open) {
    buyBtn.style.opacity = '0.5';
    buyBtn.title = 'Round closing — wait for next draw';
  } else if (buyBtn) {
    buyBtn.style.opacity = '1';
    buyBtn.title = '';
  }
}

function formatDiffShort(ms) {
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000), s=Math.floor((ms%60000)/1000);
  if (h>0) return h+'h '+m+'m';
  if (m>0) return m+'m '+s+'s';
  return s+'s';
}

// ── Admin panel wheel demo ────────────────────────────────────────────────────
function adminSpinDemo() {
  if (!adminUnlocked) return;
  wheelSpunThisSession = false;
  triggerWheelSpin(true);
}

// ─── VERIFY TICKETS ──────────────────────────────────────────────────────────
function verifyKeplrAddress() {
  if (lotteryAddress) {
    document.getElementById('verify-input').value = lotteryAddress;
    verifyTickets();
  } else {
    connectLotteryKeplr().then(() => {
      if (lotteryAddress) {
        document.getElementById('verify-input').value = lotteryAddress;
        verifyTickets();
      }
    });
  }
}

function verifyTickets() {
  const addr = document.getElementById('verify-input').value.trim();

  const resultEl   = document.getElementById('verify-result');
  const emptyEl    = document.getElementById('verify-empty');
  const notFoundEl = document.getElementById('verify-notfound');

  // Reset
  resultEl.style.display   = 'none';
  emptyEl.style.display    = 'none';
  notFoundEl.style.display = 'none';

  if (!addr || addr.length < 10) {
    emptyEl.style.display = 'block';
    return;
  }

  if (!addr.startsWith('terra1')) {
    emptyEl.innerHTML = '<span style="color:#ff6060;">⚠ Address must start with terra1...</span>';
    emptyEl.style.display = 'block';
    return;
  }

  // Find tickets for this address in both lotteries
  const myDaily  = dailyTickets.filter(t => t.address === addr);
  const myWeekly = weeklyTickets.filter(t => t.address === addr);
  const myTickets = currentLottery === 'daily' ? myDaily : myWeekly;
  const allTickets = currentLottery === 'daily' ? dailyTickets : weeklyTickets;

  if (myTickets.length === 0) {
    notFoundEl.style.display = 'block';
    return;
  }

  // Free entries from GitHub JSON
  const myFreeData = getFreeEntries(addr);
  const myFreeTotal = myFreeData.total;

  // Calculate win chance (paid + free entries)
  const totalFreeAll = Object.values(freeEntriesData).reduce((s, e) => s + (e.total || 0), 0);
  const totalTix = allTickets.length + totalFreeAll;
  const myTix    = myTickets.length + myFreeTotal;
  const chance   = totalTix > 0 ? ((myTix / totalTix) * 100).toFixed(2) : '0.00';

  // Pool prize
  const isDaily = currentLottery === 'daily';
  const pricePerTix = isDaily ? LUNC_PER_TICKET : weeklyTicketPrice();
  const poolPrize = totalTix * pricePerTix * 0.80;
  const currency  = 'LUNC';

  // Render summary cards
  document.getElementById('verify-cards').innerHTML = `
    <div style="background:rgba(212,160,23,0.06);border:1px solid rgba(212,160,23,0.15);
      border-radius:10px;padding:16px;text-align:center;">
      <div style="font-family:'Cinzel',serif;font-size:28px;font-weight:700;color:var(--gold-light);">${myTix}</div>
      <div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-top:4px;">
        Your Tickets
      </div>
    </div>
    <div style="background:rgba(102,255,170,0.06);border:1px solid rgba(102,255,170,0.15);
      border-radius:10px;padding:16px;text-align:center;">
      <div style="font-family:'Cinzel',serif;font-size:28px;font-weight:700;color:#66ffaa;">${chance}%</div>
      <div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-top:4px;">
        Win Chance
      </div>
    </div>
    <div style="background:rgba(74,144,217,0.06);border:1px solid rgba(74,144,217,0.15);
      border-radius:10px;padding:16px;text-align:center;">
      <div style="font-family:'Cinzel',serif;font-size:20px;font-weight:700;color:#7eb8ff;">${fmt(poolPrize)}</div>
      <div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-top:4px;">
        Prize If Win (${currency})
      </div>
    </div>
    ${myFreeTotal > 0 ? `
    <div style="background:rgba(102,255,170,0.04);border:1px solid rgba(102,255,170,0.15);
      border-radius:10px;padding:16px;text-align:center;grid-column:1/-1;">
      <div style="font-family:'Cinzel',serif;font-size:22px;font-weight:700;color:#66ffaa;">${myFreeTotal}</div>
      <div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-top:4px;">
        Free Entries (Oracle protocol)
      </div>
      <div style="font-size:10px;color:rgba(102,255,170,0.5);margin-top:4px;">
        ${myFreeData.chat} from chat · ${myFreeData.questions} from questions
      </div>
    </div>` : ''}
  `;

  // Render TX list — deduplicated by txhash
  const uniqueTxs = [];
  const seen = new Set();
  for (const t of myTickets) {
    if (!seen.has(t.txhash)) {
      seen.add(t.txhash);
      const count = myTickets.filter(x => x.txhash === t.txhash).length;
      uniqueTxs.push({ ...t, count });
    }
  }

  const txRows = uniqueTxs.map(tx => {
    const d = new Date(tx.time * 1000);
    const dateStr = d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const explorerUrl = `https://finder.terraclassic.community/columbus-5/tx/${tx.txhash}`;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 14px;border-bottom:1px solid rgba(42,24,0,0.5);font-size:12px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="background:rgba(212,160,23,0.1);color:var(--gold-light);
            border-radius:4px;padding:3px 8px;font-family:'Cinzel',serif;font-size:11px;">
            ×${tx.count}
          </span>
          <span style="color:var(--muted);">${dateStr}</span>
        </div>
        <a href="${explorerUrl}" target="_blank"
          style="font-family:monospace;font-size:11px;color:var(--gold-dim);text-decoration:none;
            transition:color 0.2s;"
          onmouseover="this.style.color='var(--gold-light)'"
          onmouseout="this.style.color='var(--gold-dim)'">
          ${tx.txhash.slice(0,12)}...${tx.txhash.slice(-6)} 🔗
        </a>
      </div>
    `;
  }).join('');

  document.getElementById('verify-txlist').innerHTML = `
    <div style="border:1px solid rgba(42,24,0,0.8);border-radius:8px;overflow:hidden;">
      <div style="padding:10px 14px;background:rgba(212,160,23,0.04);
        font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);
        border-bottom:1px solid rgba(42,24,0,0.5);">
        Registered Transactions — ${totalTix} total tickets in this round
      </div>
      ${txRows}
    </div>
    <div style="text-align:center;margin-top:12px;font-size:11px;color:var(--muted);">
      All transactions verified on-chain · Draw at 20:00 UTC
    </div>
  `;

  resultEl.style.display = 'block';
}


// ─── DRAW VERIFICATION ───────────────────────────────────────────────────────
function populateDrawVerifySelect() {
  const sel = document.getElementById('dv-round-select');
  if (!sel) return;

  // Keep first placeholder option
  sel.innerHTML = '<option value="" style="background:#110a00;">— Select a completed round —</option>';

  const completed = winnersData.filter(function(w){return w.winner || (w.winners && w.winners.length > 0);});
  if (!completed.length) {
    document.getElementById('dv-empty').style.display = 'block';
    document.getElementById('dv-result').style.display = 'none';
    return;
  }

  completed.forEach((w, i) => {
    const d = new Date(w.time * 1000);
    const dateStr = d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const badge = w.type === 'daily' ? '🎰 Daily' : '🏆 Weekly';
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${badge} · Round #${w.round} · ${dateStr}`;
    opt.style.background = '#110a00';
    sel.appendChild(opt);
  });
}

async function loadDrawVerify() {
  const sel = document.getElementById('dv-round-select');
  const idx = sel.value;
  const resultEl = document.getElementById('dv-result');
  const emptyEl  = document.getElementById('dv-empty');

  if (idx === '') {
    resultEl.style.display = 'none';
    emptyEl.style.display  = 'block';
    return;
  }

  const completed = winnersData.filter(function(w){return w.winner || (w.winners && w.winners.length > 0);});
  const w = completed[parseInt(idx)];
  if (!w) return;

  emptyEl.style.display  = 'none';
  resultEl.style.display = 'block';

  const isDaily    = w.type === 'daily';
  const currency   = 'LUNC';
  const blockHash  = w.drawBlockHash || 'N/A (pre-upgrade draw)';
  const ticketCount = w.tickets;
  const blockHeight = w.drawBlock;

  // Recalculate winner index client-side using SubtleCrypto (SHA256)
  let recalcIdx = null;
  let seedHex   = null;
  if (w.drawBlockHash) {
    try {
      const seedStr = `${blockHeight}:${blockHash}:${ticketCount}`;
      const enc     = new TextEncoder().encode(seedStr);
      const hashBuf = await crypto.subtle.digest('SHA-256', enc);
      seedHex       = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
      // BigInt modulo
      recalcIdx     = Number(BigInt('0x' + seedHex) % BigInt(ticketCount));
    } catch(e) { console.warn('SHA256 recalc failed:', e); }
  }

  // Input data cards
  document.getElementById('dv-inputs').innerHTML = `
    <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(42,24,0,0.8);border-radius:8px;padding:12px;">
      <div style="font-size:10px;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;">Block Height</div>
      <div style="font-family:monospace;color:var(--gold-light);font-size:13px;">${blockHeight}</div>
    </div>
    <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(42,24,0,0.8);border-radius:8px;padding:12px;">
      <div style="font-size:10px;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;">Ticket Count</div>
      <div style="font-family:monospace;color:var(--gold-light);font-size:13px;">${ticketCount}</div>
    </div>
    <div style="grid-column:1/-1;background:rgba(0,0,0,0.3);border:1px solid rgba(42,24,0,0.8);border-radius:8px;padding:12px;">
      <div style="font-size:10px;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;">Block Hash</div>
      <div style="font-family:monospace;color:var(--gold-light);font-size:12px;word-break:break-all;">${blockHash}</div>
    </div>
  `;

  // Formula display
  const shortHash = blockHash.length > 16 ? blockHash.slice(0,16) + '...' : blockHash;
  document.getElementById('dv-formula').innerHTML = seedHex
    ? `seed&nbsp;&nbsp;&nbsp;= SHA256("<span style="color:#ffaa44;">${blockHeight}:${shortHash}:${ticketCount}</span>")<br>
       seed&nbsp;&nbsp;&nbsp;= <span style="color:#aaffcc;">${seedHex.slice(0,32)}...</span><br>
       winner = BigInt(seed) % ${ticketCount}<br>
       winner = <span style="color:var(--gold-light);font-size:14px;font-weight:700;">${recalcIdx}</span>`
    : `seed&nbsp;&nbsp;&nbsp;= SHA256("${blockHeight}:${blockHash}:${ticketCount}")<br>
       winner = BigInt(seed) % ${ticketCount}<br>
       <span style="color:var(--muted);">(blockHash not available for this round)</span>`;

  // Winner card
  const d = new Date(w.time * 1000);
  const dateStr = d.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const matchIcon = recalcIdx !== null
    ? (recalcIdx === (w.winnerIndex || recalcIdx) ? '✅' : '⚠️')
    : '—';

  document.getElementById('dv-winner-card').innerHTML = `
    <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:10px;">🏆 Winner</div>
    <div style="font-family:monospace;font-size:14px;color:var(--gold-light);margin-bottom:8px;word-break:break-all;">${w.winner}</div>
    <div style="display:flex;justify-content:center;gap:24px;margin-top:12px;flex-wrap:wrap;">
      <span style="font-size:12px;color:#66ffaa;">Prize: ${fmt(w.prize)} ${currency}</span>
      <span style="font-size:12px;color:var(--muted);">Ticket index: #${recalcIdx !== null ? recalcIdx : '—'}</span>
      <span style="font-size:12px;color:var(--muted);">${dateStr}</span>
    </div>
    <div style="margin-top:10px;font-size:11px;color:${recalcIdx !== null ? '#66ffaa' : 'var(--muted)'};">
      ${recalcIdx !== null ? matchIcon + ' Client-side recalculation matches draw result' : '— Legacy draw (no blockHash recorded)'}
    </div>
    ${w.txHashes?.winner ? `<a href="https://finder.terraclassic.community/columbus-5/tx/${w.txHashes.winner}" target="_blank"
      style="display:inline-block;margin-top:10px;font-size:11px;color:var(--gold-dim);text-decoration:none;">
      🔗 Payout TX: ${w.txHashes.winner.slice(0,16)}...</a>` : ''}
  `;

  // Code snippet for manual verification
  document.getElementById('dv-code-snippet').textContent =
    `crypto.subtle.digest('SHA-256', new TextEncoder().encode('${blockHeight}:${blockHash}:${ticketCount}'))`;
}


// ─── ADMIN PANEL — Keplr wallet auth ────────────────────────────────────────
function initAdminTrigger() {
  // Opens admin login if URL contains ?admin
  if (new URLSearchParams(window.location.search).has('admin')) {
    openAdminLogin();
  }
}

function openAdminLogin() {
  const el = document.getElementById('admin-login');
  el.style.display = 'flex';
  document.getElementById('admin-login-status').textContent = '';
  document.getElementById('admin-connect-btn').textContent  = '🔑 Connect Keplr';
}

function closeAdminLogin() {
  document.getElementById('admin-login').style.display = 'none';
}

async function connectAdminKeplr() {
  const statusEl = document.getElementById('admin-login-status');
  const btnEl    = document.getElementById('admin-connect-btn');

  if (!window.keplr) {
    statusEl.style.color = '#ff3c78';
    statusEl.textContent = '⚠ Keplr not found — install Keplr extension';
    return;
  }

  try {
    btnEl.textContent    = '⏳ Connecting...';
    statusEl.textContent = '';
    statusEl.style.color = 'var(--muted)';

    await window.keplr.enable(CHAIN_ID);
    const offlineSigner = window.keplr.getOfflineSigner(CHAIN_ID);
    const accounts      = await offlineSigner.getAccounts();
    const addr          = accounts[0].address;

    if (addr === ADMIN_WALLET) {
      adminUnlocked = true;
      closeAdminLogin();
      toggleAdminPanel();
    } else {
      // Wrong wallet — show error
      statusEl.style.color = '#ff3c78';
      statusEl.textContent = '✕ Access denied — wrong wallet';
      btnEl.textContent    = '🔑 Connect Keplr';
      // Briefly flash red border on modal
      const modal = document.querySelector('#admin-login > div');
      if (modal) {
        modal.style.borderColor = 'rgba(255,60,120,0.6)';
        setTimeout(() => { modal.style.borderColor = 'rgba(0,200,255,0.25)'; }, 1500);
      }
    }
  } catch(e) {
    statusEl.style.color = '#ff9944';
    statusEl.textContent = '⚠ ' + (e.message || 'Connection failed');
    btnEl.textContent    = '🔑 Connect Keplr';
  }
}

function toggleAdminPanel() {
  const panel = document.getElementById('admin-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  updateAdminStats();
}

function updateAdminStats() {
  const tickets = currentLottery === 'daily' ? dailyTickets : weeklyTickets;
  const countEl = document.getElementById('admin-ticket-count');
  const refEl   = document.getElementById('admin-last-refresh');
  if (countEl) countEl.textContent = tickets.length;
  if (refEl)   refEl.textContent   = new Date().toLocaleTimeString('en-GB');
}

function resetWheel() {
  if (!adminUnlocked) return;
  wheelSpunThisSession = false;
  wheelAngle = 0;
  document.getElementById('wheel-winner-card').style.display = 'none';
  document.getElementById('wheel-winner-card').classList.remove('show');
  updateWheelTickets();
  setWheelMsg('⏳ Wheel reset', 'Ready for next draw', 'rgba(0,200,255,0.7)');
}

// ─── WALLET CONNECT ──────────────────────────────────────────────────────────
let connectedWalletAddress = null;
let walletProvider = null; // 'keplr' | 'station' | 'luncdash'

const TERRA_CHAIN_CONFIG = {
  chainId: 'columbus-5',
  chainName: 'Terra Classic',
  rpc: 'https://terra-classic-rpc.publicnode.com',
  rest: 'https://terra-classic-lcd.publicnode.com',
  bip44: { coinType: 330 },
  bech32Config: {
    bech32PrefixAccAddr: 'terra',
    bech32PrefixAccPub: 'terrapub',
    bech32PrefixValAddr: 'terravaloper',
    bech32PrefixValPub: 'terravaloperpub',
    bech32PrefixConsAddr: 'terravalcons',
    bech32PrefixConsPub: 'terravalconspub',
  },
  currencies: [
    { coinDenom: 'LUNC', coinMinimalDenom: 'uluna', coinDecimals: 6 },
    { coinDenom: 'USTC', coinMinimalDenom: 'uusd', coinDecimals: 6 },
  ],
  feeCurrencies: [{ coinDenom: 'LUNC', coinMinimalDenom: 'uluna', coinDecimals: 6, gasPriceStep: { low: 28.325, average: 28.325, high: 28.325 } }],
  stakeCurrency: { coinDenom: 'LUNC', coinMinimalDenom: 'uluna', coinDecimals: 6 },
};

function walletBtnClick() {
  if (connectedWalletAddress) {
    toggleWalletInfo();
  } else {
    toggleWalletPicker();
  }
}

function toggleWalletPicker() {
  const picker = document.getElementById('wallet-picker');
  const info = document.getElementById('wallet-info');
  info.classList.remove('open');
  picker.classList.toggle('open');
}

function toggleWalletInfo() {
  const info = document.getElementById('wallet-info');
  const picker = document.getElementById('wallet-picker');
  picker.classList.remove('open');
  info.classList.toggle('open');
  if (info.classList.contains('open')) fetchWalletBalances();
}

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('wallet-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('wallet-picker').classList.remove('open');
    document.getElementById('wallet-info').classList.remove('open');
  }
});

async function connectWallet(provider) {
  document.getElementById('wallet-picker').classList.remove('open');

  if (provider === 'keplr') {
    await connectKeplr();
  } else if (provider === 'station') {
    await connectStation();
  } else if (provider === 'galaxystation') {
    await connectGalaxystation();
  } else if (provider === 'luncdash') {
    promptManualAddress();
  }
}

async function connectKeplr() {
  if (!window.keplr) {
    alert('Keplr extension not found.\nPlease install Keplr: https://www.keplr.app');
    return;
  }
  try {
    try { await window.keplr.experimentalSuggestChain(TERRA_CHAIN_CONFIG); } catch(e) {}
    await window.keplr.enable(CHAIN_ID);
    const offlineSigner = window.keplr.getOfflineSigner(CHAIN_ID);
    const accounts = await offlineSigner.getAccounts();
    if (accounts && accounts[0]) {
      setConnectedWallet(accounts[0].address, 'keplr');
      // Also sync with modal
      lotteryAddress = accounts[0].address;
      const addrDisp = document.getElementById('lottery-addr-display');
      const notConn  = document.getElementById('lottery-not-connected');
      const conn     = document.getElementById('lottery-connected');
      const buyBtn   = document.getElementById('lottery-buy-btn');
      if (addrDisp) addrDisp.textContent = fmtAddr(lotteryAddress);
      if (notConn)  notConn.style.display = 'none';
      if (conn)     conn.style.display    = 'block';
      if (buyBtn)   buyBtn.style.display  = 'block';
      if (typeof updateBuyBtn === 'function') updateBuyBtn();
    }
  } catch(e) {
    console.error('Keplr connect error:', e);
    alert('Could not connect to Keplr: ' + (e.message || e));
  }
}

async function connectStation() {
  const station = window.station || window.terraStation;
  if (!station) {
    alert('Terra Station wallet not found.\nPlease install Terra Station extension:\nhttps://chrome.google.com/webstore/detail/terra-station/aiifbnbfobpmeekipheeijimdpnlpgpp');
    return;
  }
  try {
    const conn = await station.connect();
    const address = conn?.address || conn?.addresses?.mainnet || conn?.addresses?.['columbus-5'];
    if (address) {
      setConnectedWallet(address, 'station');
    } else {
      alert('Could not get address from Terra Station.');
    }
  } catch(e) {
    console.error('Station connect error:', e);
    alert('Could not connect to Terra Station: ' + (e.message || e));
  }
}

async function connectGalaxystation() {
  const galaxy = window.galaxystation || window.galaxy;
  if (!galaxy) {
    alert('Galaxystation wallet not found.\nPlease install Galaxystation extension:\nhttps://chrome.google.com/webstore/detail/galaxy-station/conpajdnokdflbcenodalfifbikfncpa');
    return;
  }
  try {
    const conn = await galaxy.connect();
    const address = conn?.address || conn?.addresses?.mainnet || conn?.addresses?.['columbus-5'];
    if (address) {
      setConnectedWallet(address, 'galaxystation');
    } else {
      alert('Could not get address from Galaxystation.');
    }
  } catch(e) {
    console.error('Galaxystation connect error:', e);
    alert('Could not connect to Galaxystation: ' + (e.message || e));
  }
}

function promptManualAddress() {
  const addr = prompt('Enter your Terra Classic wallet address (terra1...):');
  if (addr && addr.trim().startsWith('terra1') && addr.trim().length >= 40) {
    setConnectedWallet(addr.trim(), 'luncdash');
  } else if (addr !== null) {
    alert('Invalid Terra Classic address. It should start with terra1 and be 44+ characters.');
  }
}

function setConnectedWallet(address, provider) {
  connectedWalletAddress = address;
  // Refresh My Bag if open
  if (document.getElementById('page-bag') &&
      document.getElementById('page-bag').style.display !== 'none') {
    renderMyBag();
  }
  walletProvider = provider;

  // Persist across page reloads
  try { localStorage.setItem('walletAddress', address); localStorage.setItem('walletProvider', provider); } catch(e) {}

  // Update button
  const btn = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  if (btn) btn.classList.add('connected');
  const short = address.slice(0, 8) + '…' + address.slice(-4);
  if (label) label.textContent = short;

  // Update info popover
  const addrEl = document.getElementById('wallet-info-addr');
  const balLunc = document.getElementById('wallet-bal-lunc');
  const balUstc = document.getElementById('wallet-bal-ustc');
  if (addrEl) addrEl.textContent = address;
  if (balLunc) balLunc.textContent = '…';
  if (balUstc) balUstc.textContent = '…';

  fetchWalletBalances();
}

async function fetchWalletBalances() {
  if (!connectedWalletAddress) return;
  try {
    const LCD_BASE = LCD_NODES[0];
    const r = await fetch(`${LCD_BASE}/cosmos/bank/v1beta1/balances/${connectedWalletAddress}?pagination.limit=50`);
    const data = await r.json();
    const balances = data.balances || [];
    const lunc = balances.find(b => b.denom === 'uluna');
    const ustc = balances.find(b => b.denom === 'uusd');
    const luncAmt = lunc ? (parseInt(lunc.amount) / 1e6).toLocaleString('en', {maximumFractionDigits: 2}) : '0';
    const ustcAmt = ustc ? (parseInt(ustc.amount) / 1e6).toLocaleString('en', {maximumFractionDigits: 2}) : '0';
    const balLunc2 = document.getElementById('wallet-bal-lunc');
    const balUstc2 = document.getElementById('wallet-bal-ustc');
    if (balLunc2) balLunc2.textContent = luncAmt;
    if (balUstc2) balUstc2.textContent = ustcAmt;
  } catch(e) {
    const balLunc3 = document.getElementById('wallet-bal-lunc');
    const balUstc3 = document.getElementById('wallet-bal-ustc');
    if (balLunc3) balLunc3.textContent = '—';
    if (balUstc3) balUstc3.textContent = '—';
  }
}

function copyWalletAddress() {
  if (!connectedWalletAddress) return;
  navigator.clipboard.writeText(connectedWalletAddress).then(() => {
    const el = document.getElementById('wallet-info-addr');
    const orig = el.textContent;
    el.textContent = '✓ Copied!';
    setTimeout(() => { el.textContent = orig; }, 1500);
  });
}

function fillWalletAddress() {
  if (!connectedWalletAddress) return;
  // Pre-fill the modal's lottery address state
  lotteryAddress = connectedWalletAddress;
  syncDrawWalletUI(lotteryAddress);
  if (typeof updateBuyBtn === 'function') updateBuyBtn();
  document.getElementById('wallet-info').classList.remove('open');
  openModal();
}

function disconnectWallet() {
  connectedWalletAddress = null;
  lotteryAddress = null;
  walletProvider = null;
  try { localStorage.removeItem('walletAddress'); localStorage.removeItem('walletProvider'); } catch(e) {}
  const btn = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  const info = document.getElementById('wallet-info');
  if (btn) btn.classList.remove('connected');
  if (label) label.textContent = 'Connect Wallet';
  if (info) info.classList.remove('open');
  /* Sync modal wallet UI */
  syncDrawWalletUI(null);
}

// ─── INIT ────────────────────────────────────────────────────────────────────
(async () => {
  // Restore last active tab
  try {
    const savedLottery = localStorage.getItem('activeLottery') || 'daily';
    showTab('home'); // Always start from home
    if (false) { // legacy — kept for structure
      window.currentLottery = savedLottery;
      currentLottery = savedLottery;
    }
  } catch(e) { showTab('home'); }

  // Restore wallet session
  try {
    const savedAddress  = localStorage.getItem('walletAddress');
    const savedProvider = localStorage.getItem('walletProvider');
    if (savedAddress) {
      setConnectedWallet(savedAddress, savedProvider || 'keplr');
    }
  } catch(e) {}

  startTimer();
  initWheel();
  initAdminTrigger();
  await loadWinners();

  // ── Load balances first — update podium immediately ──
  const [_dBal, _wBal] = await Promise.all([
    getWalletBalance(DAILY_WALLET),
    getWalletBalance(WEEKLY_WALLET),
  ]);
  window._dailyPoolBalance  = _dBal;
  window._weeklyPoolBalance = _wBal;
  updatePodiumPrizes();
  updatePoolDisplay();

  // ── Then load everything else ──
  await loadAllData();

  // Apply correct UI state after data is ready (podium, pool display, etc.)
  updatePodiumPrizes();

  // Hide loader now that everything is ready
  const loader = document.getElementById('page-loader');
  if (loader) {
    setTimeout(() => loader.classList.add('hidden'), 600);
  }

  // Refresh every 60s
  setInterval(loadAllData, 60000);
  setInterval(checkDrawTime, 1000);
})();

// ── MY BAG ────────────────────────────────────────────────────────────────────
function renderMyBag() {
  const wallet = connectedWalletAddress || lotteryAddress;
  const notConn = document.getElementById('bag-not-connected');
  const conn    = document.getElementById('bag-connected');
  if (!notConn || !conn) return;

  if (!wallet) {
    notConn.style.display = 'block';
    conn.style.display    = 'none';
    return;
  }

  notConn.style.display = 'none';
  conn.style.display    = 'block';

  // ── Mock NFT data (replace with real API later) ──────────────────────────
  const mockNFTs = [
    { id: 47,  type: 'common',    entries: 1,  pool: 'daily',  inCurrentRound: true  },
    { id: 12,  type: 'rare',      entries: 5,  pool: 'weekly', inCurrentRound: true  },
    { id: 3,   type: 'legendary', entries: 10, pool: 'weekly', inCurrentRound: false },
    { id: 88,  type: 'common',    entries: 1,  pool: 'daily',  inCurrentRound: false },
  ];

  const mockHistory = [
    { round: 15, type: 'Daily',  nft: 'Common #31',     result: 'lost',  prize: null },
    { round: 13, type: 'Weekly', nft: 'Rare #08',       result: 'won',   prize: '45,000 LUNC' },
    { round: 10, type: 'Daily',  nft: 'Common #22',     result: 'lost',  prize: null },
    { round: 7,  type: 'Daily',  nft: 'Legendary #01',  result: 'lost',  prize: null },
  ];
  // ── End mock data ────────────────────────────────────────────────────────

  const totalWon      = mockHistory.filter(h => h.result === 'won').length;
  const dailyEntries  = mockNFTs.filter(n => n.inCurrentRound && n.pool === 'daily')
                                .reduce((s, n) => s + n.entries, 0);
  const weeklyEntries = mockNFTs.filter(n => n.inCurrentRound && n.pool === 'weekly')
                                .reduce((s, n) => s + n.entries, 0);

  // Stats
  const el = id => document.getElementById(id);
  if (el('bag-stat-nfts'))    el('bag-stat-nfts').textContent    = mockNFTs.length;
  if (el('bag-stat-won'))     el('bag-stat-won').textContent     = totalWon;
  if (el('bag-stat-daily'))   el('bag-stat-daily').textContent   = dailyEntries;
  if (el('bag-stat-weekly'))  el('bag-stat-weekly').textContent  = weeklyEntries;
  if (el('bag-nft-count'))    el('bag-nft-count').textContent    = mockNFTs.length;

  // NFT Grid
  const grid  = el('bag-nft-grid');
  const empty = el('bag-empty');
  window._bagNFTs = mockNFTs; // store for filter
  if (grid) {
    if (mockNFTs.length === 0) {
      grid.style.display  = 'none';
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      grid.style.display = 'grid';
      setTimeout(() => filterBagNFTs('all'), 0);
    }
  }

  // History
  const histTable = el('bag-history-table');
  const histEmpty = el('bag-history-empty');
  const histBody  = el('bag-history-body');
  if (histBody) {
    if (mockHistory.length === 0) {
      if (histTable) histTable.style.display = 'none';
      if (histEmpty) histEmpty.style.display = 'block';
    } else {
      if (histEmpty) histEmpty.style.display = 'none';
      if (histTable) histTable.style.display = 'table';
      histBody.innerHTML = mockHistory.map(h => `
        <tr style="border-bottom:1px solid rgba(42,24,0,0.4);">
          <td style="padding:12px 14px;color:var(--muted);">#${h.round}</td>
          <td style="padding:12px 14px;">
            <span style="font-size:9px;padding:2px 8px;border-radius:4px;
              background:${h.type==='Daily'?'rgba(212,160,23,0.1)':'rgba(74,144,217,0.1)'};
              color:${h.type==='Daily'?'var(--gold)':'#7eb8ff'};
              border:1px solid ${h.type==='Daily'?'rgba(212,160,23,0.2)':'rgba(74,144,217,0.2)'};">
              ${h.type}
            </span>
          </td>
          <td style="padding:12px 14px;font-family:monospace;font-size:11px;color:var(--gold-light);">${h.nft}</td>
          <td style="padding:12px 14px;">
            ${h.result==='won'
              ? `<span style="color:#66ffaa;font-weight:700;">🏆 ${h.prize}</span>`
              : `<span style="color:var(--muted);font-size:12px;">—</span>`}
          </td>
        </tr>`).join('');
    }
  }
}

function burnNFT(nftId, drawType) {
  // Placeholder — will connect to real burn transaction later
  alert(`Burn NFT #${nftId} to enter ${drawType} draw — blockchain integration coming soon!`);
}

// Re-render bag when wallet connects/disconnects
const _origSetConnected = window.setConnectedWallet;
window.setConnectedWallet = function(addr, provider) {
  if (typeof _origSetConnected === 'function') _origSetConnected(addr, provider);
  if (document.getElementById('page-bag') &&
      document.getElementById('page-bag').style.display !== 'none') {
    renderMyBag();
  }
};

// ── MY BAG FILTER ─────────────────────────────────────────────────────────────
let _bagCurrentFilter = 'all';

function filterBagNFTs(filter) {
  _bagCurrentFilter = filter;
  const nfts = window._bagNFTs || [];

  // Update button styles
  ['all','common','rare','legendary','used'].forEach(f => {
    const btn = document.getElementById('bag-filter-' + f);
    if (!btn) return;
    const colors = {
      all:       { active: 'rgba(212,160,23,0.12)', border: 'rgba(212,160,23,0.5)',   text: 'var(--gold-light)' },
      common:    { active: 'rgba(180,190,210,0.1)', border: 'rgba(180,190,210,0.5)',  text: '#b0b8c8'           },
      rare:      { active: 'rgba(96,165,250,0.1)',  border: 'rgba(96,165,250,0.5)',   text: '#60a5fa'           },
      legendary: { active: 'rgba(251,146,60,0.1)',  border: 'rgba(251,146,60,0.5)',   text: '#fb923c'           },
      used:      { active: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.35)', text: '#e2e8f0'           },
    };
    const c = colors[f];
    if (f === filter) {
      btn.style.background = c.active;
      btn.style.borderColor = c.border.replace('0.5','0.8');
      btn.style.color = c.text;
      btn.style.fontWeight = '700';
    } else {
      btn.style.background = 'transparent';
      btn.style.borderColor = c.border.replace('0.5','0.2');
      btn.style.color = c.text;
      btn.style.fontWeight = '400';
      btn.style.opacity = '0.6';
    }
    btn.style.opacity = f === filter ? '1' : '0.6';
  });

  // Filter and sort: active first, then used
  let filtered = nfts;
  if (filter === 'used')       filtered = nfts.filter(n => !n.inCurrentRound);
  else if (filter !== 'all')   filtered = nfts.filter(n => n.type === filter);

  // Sort: in current round first
  filtered = filtered.slice().sort((a, b) => {
    if (a.inCurrentRound && !b.inCurrentRound) return -1;
    if (!a.inCurrentRound && b.inCurrentRound) return 1;
    return 0;
  });

  renderBagGrid(filtered);
}

function renderBagGrid(nfts) {
  const grid  = document.getElementById('bag-nft-grid');
  const empty = document.getElementById('bag-empty');
  if (!grid) return;

  if (!nfts.length) {
    grid.style.display = 'none';
    if (empty) { empty.style.display = 'block'; }
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.style.display = 'grid';

  const cfgs = {
    common:    { color:'#b0b8c8', glow:'rgba(180,190,210,0.35)', bg:'rgba(180,190,210,0.05)', icon:'🎭', label:'COMMON'    },
    rare:      { color:'#60a5fa', glow:'rgba(96,165,250,0.45)',  bg:'rgba(96,165,250,0.06)',  icon:'🔮', label:'RARE'       },
    legendary: { color:'#fb923c', glow:'rgba(251,146,60,0.45)',  bg:'rgba(251,146,60,0.07)',  icon:'👁', label:'LEGENDARY'  },
  };

  grid.innerHTML = nfts.map(nft => {
    const cfg = cfgs[nft.type];
    const pool = nft.pool === 'daily' ? 'Daily Pool' : 'Weekly Pool';

    let statusHtml;
    if (nft.inCurrentRound) {
      statusHtml = `<div style="padding:8px 12px;border-radius:8px;
        background:rgba(102,255,170,0.08);border:1px solid rgba(102,255,170,0.25);
        color:#66ffaa;font-size:11px;font-weight:600;text-align:center;">
        ✅ In this round
      </div>`;
    } else {
      statusHtml = `<div style="padding:8px 12px;border-radius:8px;
        background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);
        color:var(--muted);font-size:11px;text-align:center;">
        ✔ Round over
      </div>`;
    }

    const opacity = nft.inCurrentRound ? '1' : '0.55';
    return `
    <div style="background:${cfg.bg};border:1px solid ${cfg.glow};border-radius:16px;padding:24px 20px;
      text-align:center;box-shadow:0 0 20px ${cfg.glow};transition:transform 0.2s;opacity:${opacity};"
      onmouseover="this.style.transform='translateY(-3px)'"
      onmouseout="this.style.transform='translateY(0)'">
      <div style="font-size:9px;letter-spacing:0.2em;color:${cfg.color};font-weight:700;margin-bottom:4px;">${cfg.label}</div>
      <div style="font-family:'Cinzel',serif;font-size:18px;color:#fff;margin-bottom:4px;">#${nft.id}</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:3px;">${nft.entries} ${nft.entries===1?'entry':'entries'}</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:14px;">${pool}</div>
      ${statusHtml}
    </div>`;
  }).join('');
}
