// ─── WALLET CONNECT ──────────────────────────────────────────────────────────
let connectedWalletAddress = null;

// ── Global API constants (must be declared before any function uses them) ──
// NFT_API_BASE / DRAW_WORKER moved to top of file (TDZ fix)

// ── Multi-layered wallet persistence (works around mobile browser quirks) ──
// Mobile Safari/Chrome can clear localStorage between sessions in some modes.
// Try localStorage → sessionStorage → cookie. Read from any source available.
function persistWallet(address, provider) {
  try { localStorage.setItem('walletAddress', address); localStorage.setItem('walletProvider', provider); } catch(e) {}
  try { sessionStorage.setItem('walletAddress', address); sessionStorage.setItem('walletProvider', provider); } catch(e) {}
  try {
    // Cookie fallback - 30 days
    const exp = new Date(Date.now() + 30 * 86400000).toUTCString();
    document.cookie = `oraclewallet=${encodeURIComponent(address)}; expires=${exp}; path=/; SameSite=Lax`;
    document.cookie = `oracleprovider=${encodeURIComponent(provider)}; expires=${exp}; path=/; SameSite=Lax`;
  } catch(e) {}
}
function loadPersistedWallet() {
  let address = null, provider = null;
  try { address = localStorage.getItem('walletAddress'); provider = localStorage.getItem('walletProvider'); } catch(e) {}
  if (!address) {
    try { address = sessionStorage.getItem('walletAddress'); provider = sessionStorage.getItem('walletProvider'); } catch(e) {}
  }
  if (!address) {
    try {
      const m = document.cookie.match(/(?:^|; )oraclewallet=([^;]+)/);
      if (m) address = decodeURIComponent(m[1]);
      const p = document.cookie.match(/(?:^|; )oracleprovider=([^;]+)/);
      if (p) provider = decodeURIComponent(p[1]);
    } catch(e) {}
  }
  return { address, provider };
}
function clearPersistedWallet() {
  try { localStorage.removeItem('walletAddress'); localStorage.removeItem('walletProvider'); } catch(e) {}
  try { sessionStorage.removeItem('walletAddress'); sessionStorage.removeItem('walletProvider'); } catch(e) {}
  try {
    document.cookie = 'oraclewallet=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    document.cookie = 'oracleprovider=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  } catch(e) {}
}
let walletProvider = null; // ключ OX_EXT, мобильный WC из OX_WC или 'luncdash' (см. tx.js)

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
  if (provider === 'luncdash') { promptManualAddress(); return; }
  if (_isExtProvider(provider)) await connectExtension(provider);
}

// Одно подключение для всех расширений (Frontier, Keplr, Galaxy, Station):
// тот же шаг, что и перед подписью (oxOpenWallet в tx.js).
async function connectExtension(provider) {
  const meta  = OX_EXT[provider];
  const label = document.getElementById('wallet-btn-label');
  const prevLabel = label ? label.textContent : null;
  if (label && !connectedWalletAddress) label.textContent = 'Connecting...';
  try {
    const w = await oxOpenWallet(provider, CHAIN_ID);
    setConnectedWallet(w.address, provider);
    lotteryAddress = w.address;
    syncDrawWalletUI(w.address);
    if (typeof updateBuyBtn === 'function') updateBuyBtn();
  } catch (e) {
    if (label && !connectedWalletAddress) label.textContent = prevLabel || 'Connect Wallet';
    if (e && e.code === 'WALLET_NOT_FOUND') {
      const how = provider === 'frontier' ? 'Open Frontier in Telegram instead?' : 'Install ' + meta.name + '?';
      if (confirm(meta.name + ' extension not found. ' + how)) window.open(meta.install, '_blank');
      return;
    }
    if (oxIsRejection(e)) return;
    console.error(meta.name + ' connect error:', e);
    alert('Could not connect to ' + meta.name + ': ' + ((e && e.message) || e));
  }
}

// Прежние имена - на случай вызовов из старой разметки.
function connectKeplr()         { return connectExtension('keplr'); }
function connectStation()       { return connectExtension('station'); }
function connectGalaxystation() { return connectExtension('galaxystation'); }
function connectFrontier()      { return connectExtension('frontier'); }

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
  // Refresh My Bag if open - DEFERRED via setTimeout(…,0). setConnectedWallet
  // can run during early boot (wallet restore) BEFORE the rest of this file
  // has finished parsing, so calling renderMyBag() synchronously here reached
  // const declarations further down the file while they were still in their
  // temporal-dead-zone ("Cannot access X before initialization" for
  // BAG_CACHE_MAX_AGE_MS, NFT_ID_TO_TIER, etc). Deferring to the next tick
  // guarantees every top-level const is initialized first. try/catch keeps
  // any remaining issue from blocking the wallet UI.
  setTimeout(() => {
    try {
      const bagPage = document.getElementById('page-bag');
      if (bagPage && bagPage.style.display !== 'none') renderMyBag();
    } catch(e) { console.warn('renderMyBag() during setConnectedWallet failed (non-fatal):', e); }
  }, 0);
  walletProvider = provider;

  // Persist across page reloads (multi-layer for mobile browser quirks)
  persistWallet(address, provider);

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
    if (balLunc3) balLunc3.textContent = '-';
    if (balUstc3) balUstc3.textContent = '-';
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
  clearPersistedWallet();
  const btn = document.getElementById('btn-wallet');
  const label = document.getElementById('wallet-btn-label');
  const info = document.getElementById('wallet-info');
  if (btn) btn.classList.remove('connected');
  if (label) label.textContent = 'Connect Wallet';
  if (info) info.classList.remove('open');
  /* Sync modal wallet UI */
  syncDrawWalletUI(null);
}
