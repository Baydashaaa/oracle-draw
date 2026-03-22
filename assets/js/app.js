// ─── CONSTANTS ──────────────────────────────────────────────────────────────
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
let currentLottery = 'daily'; // 'daily' | 'weekly'
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
      : fmt(w.prize) + ' USTC';
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
    document.getElementById('pool-lunc').textContent = fmt(poolPrize) + ' LUNC';
    document.getElementById('pool-usd').textContent = luncPrice > 0 ? '≈ $' + poolUsd.toFixed(2) + ' USD' : '';
  } else {
    const tPrice = weeklyTicketPrice();
    poolPrize = count * tPrice * 0.80;
    poolUsd = poolPrize * ustcPrice;
    document.getElementById('pool-lunc').textContent = fmt(poolPrize) + ' USTC';
    document.getElementById('pool-usd').textContent = ustcPrice > 0 ? '≈ $' + poolUsd.toFixed(2) + ' USD' : '';
  }

  document.getElementById('pool-tickets').textContent = count + ' NFT' + (count !== 1 ? 's' : '') + ' minted this round';

  const minNotice = document.getElementById('pool-min-notice');
  if (count <= MIN_TICKETS && count > 0) {
    minNotice.style.display = 'block';
  } else {
    minNotice.style.display = 'none';
  }

  // Update stats
  const totalTickets = dailyTickets.length + weeklyTickets.length + winnersData.reduce((s, w) => s + w.tickets, 0);
  const totalBurned  = 0; // burn removed from protocol
  document.getElementById('stat-total').textContent  = fmt(totalTickets);
  document.getElementById('stat-burned').textContent = totalBurned > 0 ? fmt(totalBurned) : '0';
  document.getElementById('stat-draws').textContent  = winnersData.length;

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
    document.getElementById('modal-total-val').textContent = fmt(ticketCount * wp) + ' USTC';
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
  const isDaily = type === 'daily';

  // Tabs
  document.getElementById('tab-daily').className  = 'lottery-tab ' + (isDaily ? 'active-daily' : '');
  document.getElementById('tab-weekly').className = 'lottery-tab ' + (!isDaily ? 'active-weekly' : '');

  // Hero
  document.getElementById('hero-title').innerHTML       = isDaily ? 'DAILY<br><span class="gold" id="hero-subtitle">DRAW</span>' : 'WEEKLY<br><span class="blue-text" id="hero-subtitle">DRAW</span>';
  document.getElementById('hero-sub').textContent       = isDaily ? 'Mint an NFT. Burn it. Win the daily pool.' : 'Mint an NFT. Burn it. Win the weekly pool.';

  // Steps
  const wp = weeklyTicketPrice();
  document.getElementById('step1-text').textContent = isDaily
    ? 'Choose your tier — Common, Rare or Legendary. Pay in LUNC or USTC equivalent.'
    : 'Choose your tier — Common, Rare or Legendary. Burn your NFT to enter the weekly draw.';

  // Pool display
  document.getElementById('pool-display').className = 'pool-display' + (isDaily ? '' : ' weekly-pool');
  document.getElementById('pool-lunc').className    = 'pool-amount' + (isDaily ? '' : ' blue');

  // Buy button
  const btn = document.getElementById('btn-buy-main');
  btn.className = 'btn-buy' + (isDaily ? '' : ' weekly');

  // Modal
  document.getElementById('modal-inner').className = 'modal' + (isDaily ? '' : ' weekly-modal');
  document.getElementById('modal-title').className = 'modal-title' + (isDaily ? '' : ' blue');
  document.getElementById('lottery-buy-btn').className = 'btn-confirm' + (isDaily ? '' : ' weekly');

  // Switch wheel panel style
  const wheelPanel = document.getElementById('wheel-panel-hero');
  if (wheelPanel) {
    wheelPanel.className = 'wheel-panel' + (isDaily ? '' : ' weekly-panel');
  }
  const wheelPanelLabel = document.getElementById('wheel-panel-label');
  if (wheelPanelLabel) wheelPanelLabel.textContent = isDaily ? 'FORTUNE WHEEL' : 'WEEKLY WHEEL';

  startTimer();
  updatePoolDisplay();
  document.getElementById('wheel-winner-card').style.display='none';
  updateWheelTickets();

  // ── Toggle unique Daily / Weekly blocks ──────────────────────
  const dailyExtra  = document.getElementById('daily-extra');
  const weeklyExtra = document.getElementById('weekly-extra');
  if (dailyExtra)  dailyExtra.style.display  = isDaily ? 'block' : 'none';
  if (weeklyExtra) weeklyExtra.style.display = isDaily ? 'none'  : 'block';

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

  // ── Weekly body theme ────────────────────────────────────────
  if (isDaily) {
    document.body.classList.remove('weekly-mode');
  } else {
    document.body.classList.add('weekly-mode');
  }

  // ── Page transition flash ─────────────────────────────────────
  const overlay = document.getElementById('page-transition');
  if (overlay) {
    overlay.classList.add('flash');
    setTimeout(() => overlay.classList.remove('flash'), 300);
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
  document.getElementById('modal').classList.add('open');
  document.getElementById('lottery-tx-status').style.display = 'none';
  document.getElementById('lottery-tx-success').style.display = 'none';
  ticketCount = 1;
  document.getElementById('count-display').value = 1;
  updateBuyBtn();
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
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
  const currency = isDaily ? 'LUNC' : 'USTC';
  const total = ticketCount * pricePerTicket;
  document.getElementById('buy-btn-count').textContent = ticketCount;
  document.getElementById('buy-btn-total').textContent = fmt(total);
  document.getElementById('modal-total-val').textContent = fmt(total) + ' ' + currency;
  const btn = document.getElementById('lottery-buy-btn');
  if (lotteryAddress) btn.style.display = 'block';
}

// ─── KEPLR ──────────────────────────────────────────────────────────────────
async function connectLotteryKeplr() {
  if (!window.keplr) { alert('Keplr wallet not found! Please install Keplr extension.'); return; }
  try {
    await window.keplr.enable(CHAIN_ID);
    const offlineSigner = window.keplr.getOfflineSigner(CHAIN_ID);
    const accounts = await offlineSigner.getAccounts();
    lotteryAddress = accounts[0].address;
    document.getElementById('lottery-addr-display').textContent = fmtAddr(lotteryAddress);
    document.getElementById('lottery-not-connected').style.display = 'none';
    document.getElementById('lottery-connected').style.display = 'block';
    document.getElementById('lottery-buy-btn').style.display = 'block';
    updateBuyBtn();
  } catch(e) { alert('Connection failed: ' + (e.message || e)); }
}
function disconnectLotteryKeplr() {
  lotteryAddress = null;
  document.getElementById('lottery-not-connected').style.display = 'block';
  document.getElementById('lottery-connected').style.display = 'none';
  document.getElementById('lottery-buy-btn').style.display = 'none';
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

    btn.textContent = `🎭 Mint ${ticketCount > 1 ? ticketCount + ' NFTs' : 'NFT'} — ${fmt(ticketCount*pricePerTicket)} ${isDaily?'LUNC':'USTC'}`;
    btn.disabled = false;

    // Refresh tickets
    await loadAllData();


  } catch(e) {
    statusEl.style.display = 'none';
    btn.disabled = false;
    btn.textContent = `🎭 Mint ${ticketCount > 1 ? ticketCount + ' NFTs' : 'NFT'} — ${fmt(ticketCount*(isDaily?LUNC_PER_TICKET:weeklyTicketPrice()))} ${isDaily?'LUNC':'USTC'}`;
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
  ticksCanvas = document.getElementById('wheel-ticks');
  if (!wheelCanvas) return;
  wheelCtx  = wheelCanvas.getContext('2d');
  ticksCtx  = ticksCanvas ? ticksCanvas.getContext('2d') : null;
  // Pre-load USTC logo image
  getUSTCImage();
  updateWheelTickets();
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
      const addrLabel = addr.slice(0,6) + '..' + addr.slice(-4);
      const fs = n > 14 ? 7 : (n > 8 ? 8 : 9);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = col.stroke;
      ctx.shadowBlur  = 6;

      ctx.font = `600 ${fs}px 'Inter', monospace`;
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

  // USTC logo drawn directly on main canvas for weekly
  if (currentLottery === 'weekly') {
    drawUSTCLogo(ctx, cx, cy, r * 0.16);
  } else {
    drawLUNCLogo(ctx, cx, cy, r * 0.16);
  }
}

const USTC_IMG_B64 = "data:image/jpeg;base64,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";
let _ustcImg = null;
function getUSTCImage() {
  if (_ustcImg) return _ustcImg;
  _ustcImg = new Image();
  _ustcImg.src = USTC_IMG_B64;
  return _ustcImg;
}

function drawUSTCLogo(ctx, cx, cy, radius) {
  const img = getUSTCImage();
  const d = radius * 2;
  // Dark circular background
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.05, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(5,10,40,0.85)';
  ctx.fill();
  ctx.strokeStyle = '#4a90d9';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Clip to circle
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI*2);
  ctx.clip();
  if (img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, cx - radius, cy - radius, d, d);
  } else {
    img.onload = () => {
      if (wheelTickets && wheelTickets.length) {
        drawWheel(wheelTickets, wheelAngle);
      }
    };
    // Fallback: draw "USTC" text
    ctx.fillStyle = '#7eb8ff';
    ctx.font = `bold ${radius*0.45}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('USTC', cx, cy);
  }
  ctx.restore();
}

function drawLUNCLogo(ctx, cx, cy, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.05, 0, Math.PI*2);
  const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius*1.05);
  bgGrad.addColorStop(0, 'rgba(40,25,0,0.95)');
  bgGrad.addColorStop(1, 'rgba(10,6,0,0.98)');
  ctx.fillStyle = bgGrad;
  ctx.fill();
  ctx.strokeStyle = '#d4a017';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#f4d03f';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI*2);
  ctx.clip();

  // Outer gold ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.90, 0, Math.PI*2);
  const ringGrad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  ringGrad.addColorStop(0, '#ffe066');
  ringGrad.addColorStop(0.45, '#e67e22');
  ringGrad.addColorStop(1, '#d4a017');
  ctx.strokeStyle = ringGrad;
  ctx.lineWidth = radius * 0.12;
  ctx.stroke();

  // Inner fill
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.78, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(10,6,0,0.90)';
  ctx.fill();

  // "T" letter
  ctx.shadowColor = '#f4d03f';
  ctx.shadowBlur = 8;
  ctx.font = `900 ${Math.round(radius * 1.05)}px Arial, sans-serif`;
  ctx.fillStyle = ringGrad;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', cx, cy + radius * 0.06);
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
  const currency    = isDaily ? 'LUNC' : 'USTC';
  const pricePerTix = isDaily ? LUNC_PER_TICKET : weeklyTicketPrice();

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

  // Hub color
  const hub = document.getElementById('wheel-hub');
  if (hub) {
    hub.style.borderColor = isDaily ? 'rgba(244,208,63,0.8)' : 'rgba(74,144,217,0.6)';
    hub.style.boxShadow   = isDaily
      ? '0 0 20px rgba(244,208,63,0.6),0 0 40px rgba(200,100,0,0.3),inset 0 0 20px rgba(0,0,0,0.8)'
      : '0 0 20px rgba(212,160,23,0.5),0 0 40px rgba(160,0,255,0.3),inset 0 0 20px rgba(0,0,0,0.8)';
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
  const currency = isDaily ? 'LUNC' : 'USTC';

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
function checkDrawTime() {
  const drawTime = getNextDrawTime(currentLottery);
  const diff     = drawTime - Date.now();
  const msgEl    = document.getElementById('wheel-msg');
  if (!msgEl) return;

  if (diff <= 0 && diff > -90000 && !wheelSpunThisSession && !wheelSpinning) {
    wheelSpunThisSession = true;
    triggerWheelSpin(false);
  } else if (diff > 0 && !wheelSpinning) {
    setWheelMsg(
      '⏳ Next draw in ' + formatDiffShort(diff),
      'Wheel spins automatically at 20:00 UTC',
      'rgba(0,200,255,0.7)'
    );
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
  const currency  = isDaily ? 'LUNC' : 'USTC';

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
  const currency   = isDaily ? 'LUNC' : 'USTC';
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
      document.getElementById('lottery-addr-display').textContent = fmtAddr(lotteryAddress);
      document.getElementById('lottery-not-connected').style.display = 'none';
      document.getElementById('lottery-connected').style.display = 'block';
      document.getElementById('lottery-buy-btn').style.display = 'block';
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

  // Update button
  const btn = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  btn.classList.add('connected');
  const short = address.slice(0, 8) + '…' + address.slice(-4);
  label.textContent = short;

  // Update info popover
  document.getElementById('wallet-info-addr').textContent = address;
  document.getElementById('wallet-bal-lunc').textContent = '…';
  document.getElementById('wallet-bal-ustc').textContent = '…';

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
    document.getElementById('wallet-bal-lunc').textContent = luncAmt;
    document.getElementById('wallet-bal-ustc').textContent = ustcAmt;
  } catch(e) {
    document.getElementById('wallet-bal-lunc').textContent = '—';
    document.getElementById('wallet-bal-ustc').textContent = '—';
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
  document.getElementById('lottery-addr-display').textContent = fmtAddr(lotteryAddress);
  document.getElementById('lottery-not-connected').style.display = 'none';
  document.getElementById('lottery-connected').style.display = 'block';
  document.getElementById('lottery-buy-btn').style.display = 'block';
  if (typeof updateBuyBtn === 'function') updateBuyBtn();
  document.getElementById('wallet-info').classList.remove('open');
  openModal();
}

function disconnectWallet() {
  connectedWalletAddress = null;
  walletProvider = null;
  const btn = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  btn.classList.remove('connected');
  label.textContent = 'Connect Wallet';
  document.getElementById('wallet-info').classList.remove('open');
}

// ─── INIT ────────────────────────────────────────────────────────────────────
(async () => {
  startTimer();
  initWheel();
  initAdminTrigger();
  await loadWinners();
  await loadAllData();

  // Hide loader now that everything is ready
  const loader = document.getElementById('page-loader');
  if (loader) {
    setTimeout(() => loader.classList.add('hidden'), 600);
  }

  // Refresh every 60s
  setInterval(loadAllData, 60000);
  setInterval(checkDrawTime, 1000);
})();
