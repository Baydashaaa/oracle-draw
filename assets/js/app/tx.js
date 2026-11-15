// ─── TX: один путь подписи и отправки для всех кошельков ─────────────────────
//
// Раньше у каждого кошелька и у каждой транзакции была своя ветка: покупка и
// выплата отправляли СВОЙ authInfo, минт и WalletConnect - подписанный;
// минт брал ключ через getKey (есть только у Keplr), остальные - через
// getAccounts; Station без своего объекта молча подписывал Keplr'ом, а
// адрес "только просмотр" (LUNCdash) при установленном Keplr подписывал
// чужим аккаунтом. Здесь всё сведено к одному принципу:
//
//   1. Кошелёк выбирается только по walletProvider. Нет кошелька - понятная
//      ошибка, никаких подмен на window.keplr.
//   2. Адрес и ключ берутся у кошелька в момент подписи (getAccounts).
//      Если в кошельке сменили аккаунт, сайт переключается на него и
//      останавливает транзакцию: покупка, вход NFT и минт привязаны к
//      адресу, и молча подписать другим аккаунтом нельзя.
//   3. Флаги preferNoSetFee/Memo передаются параметром getOfflineSigner.
//   4. Отправляются ровно те байты, которые кошелёк подписал.
//   5. Узлы перебираются по очереди, ошибка цепи показывается как есть.
//
// Расширения (Keplr, Frontier, Galaxy, Station) отдают Keplr-совместимый
// объект: enable + getOfflineSigner + signDirect. Мобильные идут через
// WalletConnect (_wcSignAndBroadcast). Подключать до modal.js и buy.js.

const OX_LCD = [
  'https://terra-classic-lcd.publicnode.com',
  'https://lcd.terra-classic.hexxagon.io',
  'https://terra-classic-fcd.publicnode.com',
];
const OX_SIGN_OPTS = { preferNoSetFee: true, preferNoSetMemo: true };

// Расширения: как найти объект кошелька и куда отправить без него.
const OX_EXT = {
  frontier: {
    name: 'Frontier',
    find: () => window.frontier || null,
    install: 'https://t.me/Frontier_WalletBot',
  },
  keplr: {
    name: 'Keplr',
    find: () => window.keplr || null,
    install: 'https://www.keplr.app/download',
  },
  galaxystation: {
    name: 'Galaxy Station',
    find: () => { const g = window.galaxyStation; return g ? (g.keplr || g) : null; },
    install: 'https://chrome.google.com/webstore/detail/galaxy-station/conpajdnokdflbcenodalfifbikfncpa',
  },
  station: {
    name: 'Terra Station',
    find: () => { const s = window.station; return s ? (s.keplr || (s.enable ? s : null)) : null; },
    install: 'https://chrome.google.com/webstore/detail/terra-station/aiifbnbfobpmeekipheeijimdpnlpgpp',
  },
};
// Мобильные через WalletConnect (имена - те, что ставит wallet-qr.js).
const OX_WC = ['keplr-mobile', 'galaxy-mobile', 'station-mobile', 'luncdash-wc'];
// Адрес введён вручную: смотреть можно, подписывать нечем.
const OX_VIEW_ONLY = ['luncdash'];

function _isWCProvider(provider) { return OX_WC.includes(provider); }
function _isExtProvider(provider) { return Object.prototype.hasOwnProperty.call(OX_EXT, provider); }

// Объект кошелька-расширения для провайдера или null (WC, просмотр, нет кошелька).
function getWalletKeplr(provider) {
  return _isExtProvider(provider) ? OX_EXT[provider].find() : null;
}

// Расширения вставляют свой объект не сразу после загрузки (Frontier - заметно
// позже). Ждём до ~2 с, прежде чем сказать "не найден".
async function oxWaitWallet(provider) {
  if (!_isExtProvider(provider)) return null;
  for (let i = 0; i < 20; i++) {
    const w = OX_EXT[provider].find();
    if (w) return w;
    await new Promise(r => setTimeout(r, 100));
  }
  return OX_EXT[provider].find();
}

function oxIsRejection(e) {
  return /reject|denied|cancel|declin/i.test((e && (e.message || e)) + '');
}

// Байты из того, что вернул кошелёк: Uint8Array, обычный объект {0:..},
// base64-строка (WC) или массив.
function oxBytes(v) {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return Uint8Array.from(atob(v), c => c.charCodeAt(0));
  if (v.buffer instanceof ArrayBuffer) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
  return new Uint8Array(Object.values(v));
}
function oxB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function oxSame(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// TxRaw { body_bytes=1, auth_info_bytes=2, signatures=3 }
function oxTxRaw(body, auth, sig) {
  const parts = [];
  for (const [f, d] of [[1, body], [2, auth], [3, sig]]) {
    const head = [(f << 3) | 2];
    let n = d.length;
    while (n > 127) { head.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    head.push(n);
    parts.push(Uint8Array.from(head), d);
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Открыть кошелёк: найти, предложить сеть, enable, прочитать аккаунт.
// Общий шаг для подключения и для подписи.
async function oxOpenWallet(provider, chainId) {
  const meta = OX_EXT[provider];
  const wallet = await oxWaitWallet(provider);
  if (!wallet) {
    const err = new Error(meta.name + ' not found. Install or unlock it and try again.');
    err.code = 'WALLET_NOT_FOUND';
    throw err;
  }
  if (typeof wallet.experimentalSuggestChain === 'function') {
    try { await wallet.experimentalSuggestChain(TERRA_CHAIN_CONFIG); } catch (e) {}
  }
  if (typeof wallet.enable === 'function') await wallet.enable(chainId);
  const signer = wallet.getOfflineSigner(chainId, OX_SIGN_OPTS);
  const accounts = await signer.getAccounts();
  const acc = accounts && accounts[0];
  if (!acc || !acc.address) throw new Error(meta.name + ' returned no account. Unlock the wallet and try again.');
  return { wallet, signer, address: acc.address, pubkey: oxBytes(acc.pubkey) };
}

// Аккаунт для подписи: { kind, address, pubkey, wallet?, signer? }.
// Всегда спрашивает кошелёк, а не берёт сохранённый адрес.
async function oxWalletAccount(chainId) {
  const p = walletProvider;
  if (!p) throw new Error('No wallet connected. Please connect a wallet first.');
  if (OX_VIEW_ONLY.includes(p)) {
    throw new Error('This address is view-only. Connect Frontier, Keplr, Galaxy, Station or a mobile wallet to send transactions.');
  }
  if (_isWCProvider(p)) {
    const address = connectedWalletAddress;
    if (!address) throw new Error('WalletConnect session lost. Please reconnect.');
    let pubkey = null;
    try {
      if (typeof window._wcGetAccountPubkey === 'function') pubkey = oxBytes(await window._wcGetAccountPubkey(address, chainId));
    } catch (e) {}
    // Без ключа кладём заглушку: кошелёк подставит свой в подписанный authInfo,
    // а отправляем мы именно подписанный.
    return { kind: 'wc', address, pubkey: pubkey || new Uint8Array(33) };
  }
  if (!_isExtProvider(p)) throw new Error('Unknown wallet "' + p + '". Please reconnect.');

  const w = await oxOpenWallet(p, chainId);
  if (!w.pubkey || w.pubkey.length !== 33) throw new Error('Could not read the wallet public key.');
  if (w.address !== connectedWalletAddress) {
    const was = connectedWalletAddress;
    console.warn('[tx] wallet account changed:', was, '->', w.address);
    setConnectedWallet(w.address, p);
    if (typeof lotteryAddress !== 'undefined' && lotteryAddress) {
      lotteryAddress = w.address;
      if (typeof syncDrawWalletUI === 'function') syncDrawWalletUI(w.address);
    }
    if (was) {
      const err = new Error('Your wallet is now on ' + w.address.slice(0, 10) + '...' + w.address.slice(-4) +
        '. The site switched to this account - check the details and try again.');
      err.code = 'ACCOUNT_CHANGED';
      throw err;
    }
  }
  return { kind: 'ext', address: w.address, pubkey: w.pubkey, wallet: w.wallet, signer: w.signer };
}

// account_number и sequence: узлы по очереди, отказ - явный.
async function oxAccountInfo(address) {
  for (const node of OX_LCD) {
    try {
      const r = await fetch(`${node}/cosmos/auth/v1beta1/accounts/${address}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      const a = (d.account && (d.account.base_account || d.account)) || {};
      if (a.account_number === undefined) continue;
      return { accountNumber: parseInt(a.account_number, 10), sequence: parseInt(a.sequence || '0', 10) };
    } catch (e) { /* следующий узел */ }
  }
  throw new Error('Could not read your account from the chain. Check your connection and try again.');
}

// Подписать и собрать TxRaw (base64). Отправляется то, что подписал кошелёк.
async function oxSign(acct, bodyBytes, authInfoBytes, accountNumber, chainId) {
  if (acct.kind === 'wc') {
    return _wcSignAndBroadcast(acct.address, bodyBytes, authInfoBytes, accountNumber, chainId);
  }
  // Запасной путь для кошельков, не принимающих параметр подписанта.
  // С ноября 2026 Keplr отдаёт неизменяемый объект: запись бросает
  // "object is not extensible" - тогда хватает параметра в getOfflineSigner.
  try {
    acct.wallet.defaultOptions = Object.assign({}, acct.wallet.defaultOptions, {
      sign: Object.assign({}, (acct.wallet.defaultOptions || {}).sign, OX_SIGN_OPTS),
    });
  } catch (e) { /* заморожен */ }

  const res = await acct.signer.signDirect(acct.address, {
    bodyBytes, authInfoBytes, chainId, accountNumber: BigInt(accountNumber),
  });
  const body = oxBytes(res.signed && res.signed.bodyBytes) || bodyBytes;
  const auth = oxBytes(res.signed && res.signed.authInfoBytes) || authInfoBytes;
  if (!oxSame(auth, authInfoBytes)) console.warn('[tx] wallet changed fee/gas - broadcasting the signed version');
  if (!oxSame(body, bodyBytes)) console.warn('[tx] wallet changed the tx body - broadcasting the signed version');
  const sig = oxBytes(res.signature && res.signature.signature);
  if (!sig || sig.length !== 64) throw new Error('The wallet returned no valid signature.');
  return oxB64(oxTxRaw(body, auth, sig));
}

// Отправить TxRaw. Недоступный узел - пробуем следующий; ответ цепи с ошибкой -
// показываем его. code 19 (уже в мемпуле) значит, что предыдущий узел принял.
async function oxBroadcast(txBase64) {
  let lastErr = null;
  for (const node of OX_LCD) {
    let data;
    try {
      const r = await fetch(`${node}/cosmos/tx/v1beta1/txs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tx_bytes: txBase64, mode: 'BROADCAST_MODE_SYNC' }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.status >= 500) { lastErr = new Error('Node ' + node + ' answered ' + r.status); continue; }
      data = await r.json();
    } catch (e) { lastErr = e; continue; }
    const resp = data.tx_response || data;
    const code = Number(resp.code || 0);
    if (code === 0 || code === 19) {
      if (!resp.txhash) throw new Error('No txhash in broadcast response.');
      return resp.txhash;
    }
    throw new Error('TX rejected (code ' + code + '): ' + (resp.raw_log || data.message || JSON.stringify(data)));
  }
  throw new Error('Broadcast failed - all nodes unreachable' + (lastErr ? ' (' + (lastErr.message || lastErr) + ')' : '') + '.');
}
