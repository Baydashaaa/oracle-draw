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

  try { localStorage.setItem('activeTab', tab); } catch(e) {};

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
const MIN_TICKETS    = 5; // minimum to hold draw
const LCD_NODES      = [
  'https://terra-classic-lcd.publicnode.com',
  'https://api-terra-ia.cosmosia.notional.ventures',
];
const RPC_NODES      = [
  'https://terra-classic-rpc.publicnode.com',
  'https://rpc.terra-classic.io',
];

// ─── STATE ──────────────────────────────────────────────────────────────────
let currentLottery = 'daily';
window.currentLottery = currentLottery; // 'daily' | 'weekly'
let lotteryAddress = null;
let ticketCount = 1;
let luncPrice = 0;
let ustcPrice = 0;
let dailyTickets = [];   // array of {address, txhash, time}
let weeklyTickets = [];
let winnersData = [];    // loaded from winners.json
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
    ? Math.floor(Date.now()/1000) - 86400          // last 24h
    : Math.floor(Date.now()/1000) - 7 * 86400;     // last 7 days

  const tickets = [];
  let nextKey = null;

  try {
    do {
      let url = `/cosmos/tx/v1beta1/txs?events=transfer.recipient%3D%27${wallet}%27&pagination.limit=100&order_by=ORDER_BY_DESC`;
      if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
      const data = await lcdFetch(url);
      if (!data?.txs?.length) break;

      let done = false;
      for (const tx of data.txs) {
        const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
        if (ts < cutoff) { done = true; break; }

        // Find sender and amount
        const msgs = tx.tx?.body?.messages || [];
        for (const msg of msgs) {
          if (msg['@type'] === '/cosmos.bank.v1beta1.MsgSend' && msg.to_address === wallet) {
            const amountCoins = msg.amount || [];
            for (const coin of amountCoins) {
              const isLunc  = coin.denom === 'uluna';
              const isUstc  = coin.denom === 'uusd';
              if (isDaily && isLunc) {
                const luncAmt = Number(coin.amount) / 1e6;
                const numTickets = Math.floor(luncAmt / LUNC_PER_TICKET);
                for (let i = 0; i < numTickets; i++) {
                  tickets.push({ address: msg.from_address, txhash: tx.txhash, time: ts });
                }
              } else if (!isDaily && isUstc) {
                // weekly: each ticket = ustcTicketPrice USTC
                const ustcAmt = Number(coin.amount) / 1e6;
                const numTickets = Math.floor(ustcAmt / weeklyTicketPrice());
                for (let i = 0; i < numTickets; i++) {
                  tickets.push({ address: msg.from_address, txhash: tx.txhash, time: ts });
                }
              }
            }
          }
        }
        if (done) break;
      }

      nextKey = data.pagination?.next_key || null;
      if (done) break;
    } while (nextKey);
  } catch(e) {
    console.warn('fetchTickets error:', e);
  }

  return tickets;
}

// ─── WEEKLY TICKET PRICE (≈ daily in USTC) ──────────────────────────────────
function weeklyTicketPrice() {
  // Daily ticket = 25,000 LUNC ≈ X USTC
  if (ustcPrice > 0 && luncPrice > 0) {
    return Math.ceil((LUNC_PER_TICKET * luncPrice) / ustcPrice);
  }
  return 25; // fallback ~25 USTC
}

// ─── LOAD WINNERS FROM winners.json ─────────────────────────────────────────
async function loadWinners() {
  try {
    const r = await fetch('./winners.json?t=' + Date.now());
    if (r.ok) winnersData = await r.json();
  } catch { winnersData = []; }
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
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">🎰 No draws yet — be part of the first round!</td></tr>`;
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

  let poolPrize, poolUsd;
  if (isDaily) {
    poolPrize = count * LUNC_PER_TICKET * 0.80;
    poolUsd = poolPrize * luncPrice;
    const _pl=document.getElementById('pool-lunc');if(_pl)_pl.textContent = fmt(poolPrize) + ' LUNC';
    const _pu=document.getElementById('pool-usd');if(_pu)_pu.textContent = luncPrice > 0 ? '≈ $' + poolUsd.toFixed(2) + ' USD' : '';
  } else {
    const tPrice = weeklyTicketPrice();
    poolPrize = count * tPrice * 0.80;
    poolUsd = poolPrize * ustcPrice;
    const _pl=document.getElementById('pool-lunc');if(_pl)_pl.textContent = fmt(poolPrize) + ' LUNC';
    const _pu=document.getElementById('pool-usd');if(_pu)_pu.textContent = ustcPrice > 0 ? '≈ $' + poolUsd.toFixed(2) + ' USD' : '';
  }

  const _pt=document.getElementById('pool-tickets');if(_pt)_pt.textContent = count + ' NFT' + (count !== 1 ? 's' : '') + ' minted this round';

  const minNotice = document.getElementById('pool-min-notice');
  if (count <= MIN_TICKETS && count > 0) {
    minNotice.style.display = 'block';
  } else {
    minNotice.style.display = 'none';
  }

  // Update stats
  const totalTickets = dailyTickets.length + weeklyTickets.length + winnersData.reduce((s, w) => s + w.tickets, 0);
  const totalBurned  = 0; // burn removed from protocol
  const _st=document.getElementById('stat-total');if(_st)_st.textContent  = fmt(totalTickets);
  const _sb=document.getElementById('stat-burned');if(_sb)_sb.textContent = totalBurned > 0 ? fmt(totalBurned) : '0';
  const _sd=document.getElementById('stat-draws');if(_sd)_sd.textContent  = winnersData.length;

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
  if (!isDaily) {
    const wp = weeklyTicketPrice();
    document.getElementById('ticket-price-display').textContent = 'Common · Rare · Legendary';
    document.getElementById('modal-sub').textContent = 'Choose your NFT tier · Burn to enter draw';
    document.getElementById('buy-btn-total').textContent = fmt(ticketCount * wp);
    document.getElementById('modal-total-val').textContent = fmt(ticketCount * LUNC_PER_TICKET) + ' LUNC';
  } else {
    document.getElementById('ticket-price-display').textContent = 'Common · Rare · Legendary';
    document.getElementById('modal-sub').textContent = 'Choose your NFT tier · Burn to enter draw';
    document.getElementById('buy-btn-total').textContent = fmt(ticketCount * LUNC_PER_TICKET);
    document.getElementById('modal-total-val').textContent = fmt(ticketCount * LUNC_PER_TICKET) + ' LUNC';
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
    ? 'Choose your tier — Common, Rare or Legendary. Pay in LUNC or USTC equivalent.'
    : 'Choose your tier — Common, Rare or Legendary. Pay in LUNC or USTC equivalent.';
  if (step2El) step2El.textContent = isDaily
    ? 'Burn your NFT on-chain to register your entry. The draw happens every day at 20:00 UTC.'
    : 'Burn your NFT on-chain to register your entry. Pool accumulates all week until Monday 20:00 UTC.';

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

  // ── Populate Daily: last winner ───────────────────────────────
  if (isDaily) {
    const last = winnersData.find(w => w.type === 'daily' && w.winner);
    const addrEl  = document.getElementById('last-winner-addr');
    const prizeEl = document.getElementById('last-winner-prize');
    const dateEl  = document.getElementById('last-winner-date');
    if (last && addrEl) {
      const addr = last.winner;
      addrEl.textContent  = addr.slice(0,10) + '...' + addr.slice(-6);
      prizeEl.textContent = fmt(last.prize) + ' LUNC';
      dateEl.textContent  = last.time ? new Date(last.time * 1000).toLocaleDateString() : '—';
    } else if (addrEl) {
      addrEl.textContent  = 'No draws yet';
      prizeEl.textContent = '—';
      dateEl.textContent  = '—';
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

    // Free entries: fetch from weekly questions (2 per question tx to oracle wallet)
    const freeEl = document.getElementById('weekly-free-entries');
    if (freeEl) {
      // Count weekly question TXs — each gives 2 entries
      const weekAgo = Math.floor(Date.now()/1000) - 7*86400;
      const qEntries = weeklyTickets.filter(t => t.isQuestion && t.time > weekAgo).length * 2;
      freeEl.textContent = qEntries > 0 ? qEntries : '0';
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
    if (totalEl) totalEl.textContent = fmt(pool) + ' LUNC';
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
  document.getElementById('count-display').value = 1;
  updateBuyBtn();
}
function closeModal() { const _mo2=document.getElementById('modal');if(_mo2)_mo2.classList.remove('open'); }
document.getElementById('modal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });

function changeCount(delta) {
  ticketCount = Math.max(1, Math.min(100, ticketCount + delta));
  document.getElementById('count-display').value = ticketCount;
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
  if (!window.keplr) { alert('Keplr wallet not found! Please install Keplr extension.'); return; }
  try {
    await window.keplr.enable(CHAIN_ID);
    const offlineSigner = window.keplr.getOfflineSigner(CHAIN_ID);
    const accounts = await offlineSigner.getAccounts();
    lotteryAddress = accounts[0].address;
    const d1 = document.getElementById('lottery-addr-display');
    const d2 = document.getElementById('lottery-not-connected');
    const d3 = document.getElementById('lottery-connected');
    const d4 = document.getElementById('lottery-buy-btn');
    if (d1) d1.textContent = fmtAddr(lotteryAddress);
    if (d2) d2.style.display = 'none';
    if (d3) d3.style.display = 'block';
    if (d4) d4.style.display = 'block';
    if (typeof updateBuyBtn === 'function') updateBuyBtn();
  } catch(e) { alert('Connection failed: ' + (e.message || e)); }
}
function disconnectLotteryKeplr() {
  lotteryAddress = null;
  const e1 = document.getElementById('lottery-not-connected');
  const e2 = document.getElementById('lottery-connected');
  const e3 = document.getElementById('lottery-buy-btn');
  if (e1) e1.style.display = 'block';
  if (e2) e2.style.display = 'none';
  if (e3) e3.style.display = 'none';
}

// ─── BUY TICKETS ────────────────────────────────────────────────────────────
async function buyTicketsKeplr() {
  if (!lotteryAddress) { alert('Connect Keplr first!'); return; }
  const isDaily = currentLottery === 'daily';
  const btn = document.getElementById('lottery-buy-btn');
  const statusEl = document.getElementById('lottery-tx-status');
  const msgEl = document.getElementById('lottery-tx-msg');
  const successEl = document.getElementById('lottery-tx-success');

  btn.disabled = true;
  btn.textContent = '⏳ Waiting for Keplr...';
  statusEl.style.display = 'block';
  successEl.style.display = 'none';
  msgEl.textContent = 'Opening Keplr — please approve the transaction...';

  const wallet = isDaily ? DAILY_WALLET : WEEKLY_WALLET;
  const denom  = isDaily ? 'uluna' : 'uusd';
  const pricePerTicket = isDaily ? LUNC_PER_TICKET : weeklyTicketPrice();
  const totalAmount = ticketCount * pricePerTicket * 1000000;
  const memo = `Lottery Classic · ${isDaily ? 'Daily' : 'Weekly'} · ${ticketCount} ticket${ticketCount > 1 ? 's' : ''}`;

  try {
    const { SigningStargateClient } = await import('https://esm.sh/@cosmjs/stargate@0.32.4');
    const offlineSigner = window.keplr.getOfflineSigner(CHAIN_ID);
    let client = null;
    for (const rpc of RPC_NODES) {
      try { client = await SigningStargateClient.connectWithSigner(rpc, offlineSigner); break; }
      catch {}
    }
    if (!client) throw new Error('Could not connect to RPC node');

    msgEl.textContent = 'Transaction submitted — confirming on-chain...';

    const result = await client.sendTokens(
      lotteryAddress, wallet,
      [{ denom, amount: String(totalAmount) }],
      { amount: [{ denom: 'uluna', amount: '100000' }], gas: '200000' },
      memo
    );

    if (result.code !== 0) throw new Error('TX failed: ' + result.rawLog);

    statusEl.style.display = 'none';
    successEl.style.display = 'block';
    document.getElementById('lottery-success-msg').textContent =
      `🎟️ ${ticketCount} ticket${ticketCount > 1 ? 's' : ''} purchased successfully!`;
    document.getElementById('lottery-tx-link').href =
      `https://finder.terraclassic.community/columbus-5/tx/${result.transactionHash}`;
    document.getElementById('lottery-tx-link').textContent = '🔗 ' + result.transactionHash.slice(0,16) + '...';

    btn.textContent = `🎭 Mint ${ticketCount > 1 ? ticketCount + ' NFTs' : 'NFT'} — ${fmt(ticketCount*pricePerTicket)} LUNC`;
    btn.disabled = false;

    // Refresh tickets
    await loadAllData();


  } catch(e) {
    statusEl.style.display = 'none';
    btn.disabled = false;
    btn.textContent = `🎭 Mint ${ticketCount > 1 ? ticketCount + ' NFTs' : 'NFT'} — ${fmt(ticketCount*LUNC_PER_TICKET)} LUNC`;
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

// ─── LOAD ALL DATA ───────────────────────────────────────────────────────────
async function loadAllData() {
  await fetchPrices();
  [dailyTickets, weeklyTickets] = await Promise.all([
    fetchTickets(DAILY_WALLET, true),
    fetchTickets(WEEKLY_WALLET, false),
  ]);
  updatePoolDisplay();
  updatePodiumPrizes();
}

function updatePodiumPrizes() {
  const pool = weeklyTickets.length * 25000;
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
      status.innerHTML = `<span style="color:#6B7AA6;">⏳ Need ${remaining} more LUNC to start draw</span>`;
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
    const col = NEON_COLORS[i % NEON_COLORS.length];

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
      const dist = r*0.62;
      const tx   = cx + dist*Math.cos(mid);
      const ty   = cy + dist*Math.sin(mid);
      ctx.translate(tx,ty);
      ctx.rotate(mid + Math.PI/2);

      const addr  = s.address;
      // Show only last 4 chars: "...51ca" — clean and recognizable
      const addrLabel = addr.slice(0,7) + '...' + addr.slice(-4);
      const fs = n > 14 ? 8 : (n > 8 ? 9 : 11);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = col.stroke;
      ctx.shadowBlur  = 8;

      ctx.font = `700 ${fs}px 'Courier New', monospace`;
      ctx.fillStyle = col.text;
      ctx.fillText(addrLabel, 0, 0);
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
      highlightSector(targetIdx, wheelTickets);
      if (onComplete) onComplete(targetIdx);
    }
  }
  requestAnimationFrame(animate);
}

// ── Build ticket list for wheel ───────────────────────────────────────────────
function updateWheelTickets() {
  const tickets     = currentLottery === 'daily' ? dailyTickets : weeklyTickets;
  const isDaily     = currentLottery === 'daily';
  const currency    = 'LUNC'; // both draws pay out in LUNC
  const pricePerTix = LUNC_PER_TICKET;

  // Count tickets per address
  const seen = new Map();
  for (const t of tickets) {
    seen.set(t.address, (seen.get(t.address) || 0) + 1);
  }

  // Each unique address = one sector, but we store their ticket count for display
  // Proportional: address with more tickets gets more sectors (up to MAX_SECTORS total)
  wheelTickets = [];
  for (const [addr, count] of seen.entries()) {
    if (wheelTickets.length >= MAX_SECTORS) break;
    wheelTickets.push({ address: addr, tickets: count });
  }

  if (!wheelTickets.length) {
    wheelTickets = Array.from({length:12},()=>({placeholder:true}));
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
  if (partEl) partEl.textContent = seen.size || 0;
  if (tickEl) tickEl.textContent = tickets.length || 0;
  if (poolEl) poolEl.textContent = fmt(tickets.length * pricePerTix * 0.80) + ' ' + currency;

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
  setWheelMsg('🎡 Spinning...', 'Selecting winner on-chain', '#00c8ff');
  document.getElementById('wheel-winner-card').style.display = 'none';

  // Get winner index from latest draw result or simulate
  let targetIdx = 0;
  const lastWinner = winnersData.find(w => w.type === currentLottery && w.winner);
  if (lastWinner && lastWinner.drawBlock) {
    targetIdx = lastWinner.drawBlock % Math.min(tickets.length, MAX_SECTORS);
  } else if (isAdmin) {
    targetIdx = Math.floor(Math.random() * wheelTickets.length);
  }

  spinWheel(targetIdx, (idx) => {
    const winner = wheelTickets[idx];
    const prize  = tickets.length * (isDaily ? LUNC_PER_TICKET : weeklyTicketPrice()) * 0.80;

    setWheelMsg('✦ Winner Selected ✦', 'Payout sent automatically', '#66ffaa');

    const card = document.getElementById('wheel-winner-card');
    document.getElementById('ww-address').textContent = winner.address || '—';
    document.getElementById('ww-prize').textContent   = fmt(prize) + ' ' + currency;

    // TX link if available
    const txEl = document.getElementById('ww-tx');
    if (lastWinner?.txHashes?.winner) {
      txEl.innerHTML = `<a href="https://finder.terraclassic.community/columbus-5/tx/${lastWinner.txHashes.winner}"
        target="_blank" style="font-size:11px;color:rgba(0,200,255,0.6);text-decoration:none;">
        🔗 View payout on explorer</a>`;
    } else { txEl.innerHTML = ''; }

    card.style.display = 'block';
    card.classList.remove('show');
    void card.offsetWidth;
    card.classList.add('show');
  });
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

  // Calculate win chance
  const totalTix = allTickets.length;
  const myTix    = myTickets.length;
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

  const completed = winnersData.filter(w => w.winner !== null);
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

  const completed = winnersData.filter(w => w.winner !== null);
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
    await window.keplr.enable('columbus-5');
    const offlineSigner = window.keplr.getOfflineSigner('columbus-5');
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
    const data = await lcdFetch(`/cosmos/bank/v1beta1/balances/${connectedWalletAddress}`);
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
  const f1 = document.getElementById('lottery-addr-display');
  const f2 = document.getElementById('lottery-not-connected');
  const f3 = document.getElementById('lottery-connected');
  const f4 = document.getElementById('lottery-buy-btn');
  if (f1) f1.textContent = fmtAddr(lotteryAddress);
  if (f2) f2.style.display = 'none';
  if (f3) f3.style.display = 'block';
  if (f4) f4.style.display = 'block';
  if (typeof updateBuyBtn === 'function') updateBuyBtn();
  document.getElementById('wallet-info').classList.remove('open');
  openModal();
}

function disconnectWallet() {
  connectedWalletAddress = null;
  walletProvider = null;
  try { localStorage.removeItem('walletAddress'); localStorage.removeItem('walletProvider'); } catch(e) {}
  const btn = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  const info = document.getElementById('wallet-info');
  if (btn) btn.classList.remove('connected');
  if (label) label.textContent = 'Connect Wallet';
  if (info) info.classList.remove('open');
}

// ─── INIT ────────────────────────────────────────────────────────────────────
(async () => {
  // Restore last active tab
  try {
    const savedTab = localStorage.getItem('activeTab') || 'home';
    const savedLottery = localStorage.getItem('activeLottery') || 'daily';
    showTab(savedTab);
    if (savedTab === 'draw') {
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
  const wallet = window.connectedWallet;
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
    { id: 47,  type: 'common',    entries: 1,  name: 'Common Mask #47',    pool: 'daily',  inCurrentRound: true  },
    { id: 12,  type: 'rare',      entries: 5,  name: 'Rare Mask #12',      pool: 'weekly', inCurrentRound: true  },
    { id: 3,   type: 'legendary', entries: 10, name: 'Legendary Mask #3',  pool: 'weekly', inCurrentRound: false },
    { id: 88,  type: 'common',    entries: 1,  name: 'Common Mask #88',    pool: 'daily',  inCurrentRound: false },
  ];

  const mockHistory = [
    { round: 15, type: 'Daily',  nft: 'Common #31',     result: 'lost',  prize: null },
    { round: 13, type: 'Weekly', nft: 'Rare #08',       result: 'won',   prize: '45,000 LUNC' },
    { round: 10, type: 'Daily',  nft: 'Common #22',     result: 'lost',  prize: null },
    { round: 7,  type: 'Daily',  nft: 'Legendary #01',  result: 'lost',  prize: null },
  ];
  // ── End mock data ────────────────────────────────────────────────────────

  const totalWon     = mockHistory.filter(h => h.result === 'won').length;
  const totalEntries = mockNFTs.reduce((s, n) => s + n.entries, 0);
  const inRoundNFTs  = mockNFTs.filter(n => n.inCurrentRound);
  const roundEntries = inRoundNFTs.reduce((s, n) => s + n.entries, 0);

  // Stats
  const el = id => document.getElementById(id);
  if (el('bag-stat-nfts'))    el('bag-stat-nfts').textContent    = mockNFTs.length;
  if (el('bag-stat-won'))     el('bag-stat-won').textContent     = totalWon;
  if (el('bag-stat-burns'))   el('bag-stat-burns').textContent   = roundEntries;
  if (el('bag-nft-count'))    el('bag-nft-count').textContent    = mockNFTs.length;

  // NFT Grid
  const grid  = el('bag-nft-grid');
  const empty = el('bag-empty');
  if (grid) {
    if (mockNFTs.length === 0) {
      grid.style.display  = 'none';
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      grid.style.display = 'grid';
      grid.innerHTML = mockNFTs.map(nft => {
        const cfg = {
          common:    { color:'#b0b8c8', glow:'rgba(180,190,210,0.35)', bg:'rgba(180,190,210,0.05)', icon:'🎭', label:'COMMON',    lunc:'25,000'  },
          rare:      { color:'#3b82f6', glow:'rgba(59,130,246,0.45)',  bg:'rgba(59,130,246,0.06)',  icon:'🔮', label:'RARE',       lunc:'100,000' },
          legendary: { color:'#f97316', glow:'rgba(251,146,60,0.45)',  bg:'rgba(251,146,60,0.07)',  icon:'👁', label:'LEGENDARY',  lunc:'175,000' },
        }[nft.type];
        // Check if this NFT was purchased in current round (mock: nft.id % 2 === 0)
        const inRound = nft.inCurrentRound || false;
        const statusHtml = inRound
          ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px;
               padding:8px 12px;border-radius:8px;
               background:rgba(102,255,170,0.08);border:1px solid rgba(102,255,170,0.25);
               color:#66ffaa;font-size:11px;font-weight:600;">
               ✅ In this round
             </div>`
          : `<div style="display:flex;align-items:center;justify-content:center;gap:6px;
               padding:8px 12px;border-radius:8px;
               background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
               color:var(--muted);font-size:11px;">
               ⏸ Not in current round
             </div>`;
        return `
        <div style="background:${cfg.bg};border:1px solid ${cfg.glow};border-radius:16px;padding:24px 20px;text-align:center;
          box-shadow:0 0 20px ${cfg.glow};transition:transform 0.2s;"
          onmouseover="this.style.transform='translateY(-3px)'"
          onmouseout="this.style.transform='translateY(0)'">
          <div style="font-size:36px;margin-bottom:10px;">${cfg.icon}</div>
          <div style="font-size:9px;letter-spacing:0.2em;color:${cfg.color};font-weight:700;margin-bottom:4px;">${cfg.label}</div>
          <div style="font-family:'Cinzel',serif;font-size:15px;color:#fff;margin-bottom:4px;">#${nft.id}</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">${nft.entries} ${nft.entries===1?'entry':'entries'}</div>
          <div style="font-size:10px;color:var(--muted);margin-bottom:14px;">
            ${nft.pool === 'daily' ? '🌙 Daily Pool' : '📅 Weekly Pool'}
          </div>
          ${statusHtml}
        </div>`;
      }).join('');
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
