/**
 * ws.js — WebSocket bağlantısı, debug direkt feed, state merge
 *
 * Global scope'tan kullanılan değişkenler (app.js'te tanımlı):
 *   state, ws, reconnectTimer, _rafPending, _prevCardVals, _chipsBuilt
 * Çağrılan fonksiyonlar (app.js / cards.js):
 *   updateUI, addLog, showRateLimitPopup, buildAssetChips, buildTfTabs, updateConnectionUI
 */
// ─── Backend Authoritative Pricing (FAZ 3.5) ─────────────────────────────────
// FAZ 3.5: Backend tek fiyat otoritesi.
// Execution kararları YALNIZCA backend state'inden alınır.
// Frontend direkt WS'ler devre dışı — fiyatlar backend broadcast'ten gelir.
//
// Debug modu için: tarayıcı konsolunda _enableDebugWs() yaz → direkt feed açılır.
// TRUE = backend tek fiyat otoritesi, seesawing yok. Browser RTDS'e bağlanır
// ama fiyatları backend'e relay eder — state.assets ASLA frontend'den güncellenmez.
// Bu ayarı false yapmayın: seesawing geri döner, mimari bozulur.
const _BACKEND_ONLY_MODE = true;

let _directClob   = null;  // CLOB WS — debug modda UP/DOWN token fiyatları
let _directRtds   = null;  // RTDS WS — debug modda spot fiyatlar
let _tokenMap     = {};    // tokenId → {key:'BTC_5M', side:'up'|'down'}
let _symToKeys    = {};    // 'BTC' → ['BTC_5M','BTC_15M',...]
let _directReady  = false; // asset state yüklendi mi?
const RTDS_SYM_MAP = { btcusdt:'BTC', ethusdt:'ETH', solusdt:'SOL', xrpusdt:'XRP', dogeusdt:'DOGE', bnbusdt:'BNB', hypeusdt:'HYPE' };

// ─── WS Price Caches (debug modda kullanılır) ────────────────────────────────
// BACKEND_ONLY_MODE=true: bu cache'ler _mergeState'te uygulanmaz.
// BACKEND_ONLY_MODE=false: eski seesawing-önleme workaround'u aktif.
const _wsMarketPrices = {}; // key → {up_ask, up_bid, down_ask, down_bid, ts}
const _wsLivePrices   = {}; // sym → {val, ts}  — RTDS spot fiyatları (BTC/ETH/SOL...)

// Debug WS açma (konsol)
function _enableDebugWs() {
  window._debugWsEnabled = true;
  _maybeStartDirectFeeds();
  console.warn('[PolyFlow] DEBUG: Direkt WS bağlantıları açıldı. Sadece görüntüleme — execution backend fiyatı kullanır.');
}
function _disableDebugWs() {
  window._debugWsEnabled = false;
  if (_directClob) { try { _directClob.close(); } catch(e){} _directClob = null; }
  if (_directRtds) { try { _directRtds.close(); } catch(e){} _directRtds = null; }
  console.log('[PolyFlow] DEBUG: Direkt WS kapatıldı. Backend-only mod aktif.');
}

// rAF + throttle batching — CLOB 1000+ msg/sn push eder.
// Her kart için min 150ms görüntüleme süresi (göz okuyabilsin).
// Aynı frame'deki tüm değişiklikler toplu tek DOM update'e indirgenir.
let _directRafPending = false;
const _dirtyKeys      = new Set();
const _cardLastShown  = {};  // key → timestamp — throttle için
const DISPLAY_THROTTLE_MS = 50; // min kart güncelleme aralığı (50ms = 20fps)

function _scheduleDirectUpdate(key) {
  const now = Date.now();
  const last = _cardLastShown[key] || 0;
  if (now - last < DISPLAY_THROTTLE_MS) return; // çok erken, atla
  _cardLastShown[key] = now;
  _dirtyKeys.add(key);
  if (!_directRafPending) {
    _directRafPending = true;
    requestAnimationFrame(() => {
      _directRafPending = false;
      const keys = [..._dirtyKeys];
      _dirtyKeys.clear();
      if (keys.length) updateCardsInPlace(keys);
    });
  }
}

// Helper: event'e özgü ayarları döndür — key = "BTC_5M" gibi tam event key'i
// event_settings[key] varsa global'in üstüne yazar, yoksa sadece global kullanılır
function getAssetStrategy(key) {
  return Object.assign({}, state.strategy, state.assetSettings[key] || {});
}

// Tüm event ayarlarını backend'den yükle
async function loadAllEventSettings() {
  try {
    const res = await fetch('/api/settings-all');
    if (!res.ok) return;
    const data = await res.json();
    state.assetSettings = data || {};
  } catch(e) { /* sessizce devam */ }
}

// baseSym, keyTF, fmtCD → utils.js

// ─── Sort Mode helpers ────────────────────
const SORT_DEFAULT_DIR = { rules: 'desc', countdown: 'asc', name: 'asc', manual: 'asc' };
const SORT_LABELS = {
  rules:     { label: '🎯 Rules',  desc: '↓ Çok→Az',    asc: '↑ Az→Çok' },
  countdown: { label: '⏱ Süre',   desc: '↓ Uzak→Yakın', asc: '↑ Yakın→Uzak' },
  name:      { label: 'A–Z',       desc: '↓ Z→A',        asc: '↑ A→Z' },
  manual:    { label: '☰ Manuel',  desc: 'Sürükle',      asc: 'Sürükle' },
};

function toggleGroup(groupId) {
  state.collapsedGroups[groupId] = !state.collapsedGroups[groupId];
  _lastRenderKey = '';
  renderEventsList();
}

function setSortMode(mode) {
  if (state.sortMode === mode && mode !== 'manual') {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sortMode = mode;
    state.sortDir  = SORT_DEFAULT_DIR[mode] || 'desc';
    if (mode === 'manual') {
      // Initialize manual order from current visible order
      const allSyms = Object.keys(state.assets);
      if (!state.manualOrder.length) state.manualOrder = [...allSyms];
    }
  }
  updateSortBtns();
  _lastRenderKey = '';
  renderEventsList();
}

function updateSortBtns() {
  ['rules','countdown','name','manual'].forEach(m => {
    const btn = document.getElementById(`sort-${m}-btn`);
    if (!btn) return;
    const isActive = m === state.sortMode;
    btn.classList.toggle('active', isActive);
    const info = SORT_LABELS[m];
    if (m === 'manual') {
      btn.innerHTML = `${info.label}`;
    } else if (isActive) {
      btn.innerHTML = `${info.label} <span class="sort-arrow">${state.sortDir === 'desc' ? '↓' : '↑'}</span>`;
      btn.title = state.sortDir === 'desc' ? info.desc : info.asc;
    } else {
      btn.innerHTML = `${info.label} <span class="sort-arrow muted">↕</span>`;
      btn.title = `${info.desc} / ${info.asc}`;
    }
  });
}

// ─── Drag-and-Drop (Manuel sort) ─────────
function onCardDragStart(sym, e) {
  if (state.sortMode !== 'manual') return;
  _dragSym = sym;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}
function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.eac.drag-over').forEach(el => el.classList.remove('drag-over'));
}
function onCardDragOver(sym, e) {
  if (state.sortMode !== 'manual' || !_dragSym || _dragSym === sym) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.eac.drag-over').forEach(el => el.classList.remove('drag-over'));
  e.currentTarget.classList.add('drag-over');
}
function onCardDrop(sym, e) {
  e.preventDefault();
  document.querySelectorAll('.eac.drag-over').forEach(el => el.classList.remove('drag-over'));
  if (!_dragSym || _dragSym === sym) return;
  const order = state.manualOrder.length ? [...state.manualOrder] : Object.keys(state.assets);
  const fromIdx = order.indexOf(_dragSym);
  const toIdx   = order.indexOf(sym);
  if (fromIdx >= 0 && toIdx >= 0) {
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, _dragSym);
    state.manualOrder = order;
  }
  _dragSym = null;
  _lastRenderKey = '';
  renderEventsList();
}

// ─── TF etiket cevirisi ────────────
const TF_LABELS = {
  '1M':'1DK','2M':'2DK','3M':'3DK','5M':'5DK','10M':'10DK','15M':'15DK','30M':'30DK',
  '1H':'1SA','2H':'2SA','3H':'3SA','4H':'4SA','6H':'6SA','8H':'8SA','12H':'12SA',
  '1D':'1G','2D':'2G',
};

// ─── Dinamik TF sekmeleri olustur ────────────
let _tfTabsBuilt = false;
function buildTfTabs() {
  const container = document.getElementById('tf-tabs');
  if (!container) return;
  // Asset key'lerden mevcut TF'leri cikar
  const tfsFromAssets = new Set();
  Object.keys(state.assets).forEach(k => {
    const tf = k.includes('_') ? k.split('_').slice(1).join('_') : '5M';
    tfsFromAssets.add(tf);
  });
  // TF_SECONDS sirasina gore sirala (kucukten buyuge)
  const tfOrder = {'1M':60,'2M':120,'3M':180,'5M':300,'10M':600,'15M':900,'30M':1800,
    '1H':3600,'2H':7200,'3H':10800,'4H':14400,'6H':21600,'8H':28800,'12H':43200,'1D':86400};
  const sorted = [...tfsFromAssets].sort((a,b) => (tfOrder[a]||99999) - (tfOrder[b]||99999));

  let html = '';
  html += `<button class="tf-tab" id="tf-btn-PINNED" onclick="setTimeframe('PINNED')">Pinli</button>`;
  html += `<button class="tf-tab tf-tab-all" id="tf-btn-ALL" onclick="setTimeframe('ALL')">Tumu</button>`;
  sorted.forEach(tf => {
    const label = TF_LABELS[tf] || tf;
    const active = state.timeframe === tf ? ' active' : '';
    html += `<button class="tf-tab${active}" id="tf-btn-${tf}" onclick="setTimeframe('${tf}')">${label}</button>`;
  });
  container.innerHTML = html;
  _tfTabsBuilt = true;
}

// ─── Timeframe / Market Filter ────────────
function setTimeframe(tf) {
  state.timeframe = tf;
  state.showAllMarkets = (tf === 'ALL');
  // Update tab UI — tum butonlari tara
  document.querySelectorAll('.tf-tab').forEach(btn => {
    const btnTf = btn.id.replace('tf-btn-', '');
    btn.classList.toggle('active', btnTf === tf);
  });
  if (state.showAllMarkets) {
    state.chipFilter = 'ALL';
    _chipsBuilt = false;
  } else {
    _chipsBuilt = false;
  }
  _lastRenderKey = '';
  renderEventsList();
}

// ─── Sidebar Sub-Menu Toggle ─────────────
function toggleNavSubmenu(name) {
  const sub = document.getElementById(`submenu-${name}`);
  if (!sub) return;
  const isOpen = sub.classList.contains('open');
  sub.classList.toggle('open', !isOpen);
  // Update parent arrow indicators
  const parentNav = document.getElementById(`nav-${name}-parent`);
  if (parentNav) parentNav.classList.toggle('submenu-open', !isOpen);
}

// ═══════════════════════════════════════════
// ─── Direkt Feed: Token Map ───────────────────────────────────────────────────
function _buildTokenMap() {
  const newTokenMap = {};
  const newSymToKeys = {};
  Object.entries(state.assets).forEach(([key, a]) => {
    const sym = a.symbol || key.split('_')[0];
    if (!newSymToKeys[sym]) newSymToKeys[sym] = [];
    if (!newSymToKeys[sym].includes(key)) newSymToKeys[sym].push(key);
    const tokens = a.event?.tokens || [];
    if (tokens[0]) newTokenMap[tokens[0]] = { key, side: 'up' };
    if (tokens[1]) newTokenMap[tokens[1]] = { key, side: 'down' };
  });
  _tokenMap  = newTokenMap;
  _symToKeys = newSymToKeys;
}

// ─── Direkt Feed: CLOB WebSocket (UP/DOWN token fiyatları) ───────────────────
function _startDirectClob() {
  if (_directClob) { try { _directClob.close(); } catch(e){} _directClob = null; }
  const tokenIds = Object.keys(_tokenMap);
  if (!tokenIds.length) return;

  _directClob = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  _directClob.onopen = () => {
    _directClob.send(JSON.stringify({
      assets_ids: tokenIds,
      type: 'market',
      custom_feature_enabled: true,
    }));
  };

  _directClob.onmessage = ({ data }) => {
    if (!data || data === 'PONG') return;
    try {
      const msg = JSON.parse(data);

      const _applyToken = (tokenId, price, bid, ask) => {
        const m = _tokenMap[String(tokenId)];
        if (!m) return;
        const a = state.assets[m.key];
        if (!a) return;

        const p = parseFloat(price) || (bid && ask ? (parseFloat(bid) + parseFloat(ask)) / 2 : 0);
        if (!p) return;

        // Extreme değerleri reddet (0.03-0.97 arası kabul — event sonu spike filtresi)
        if (p < 0.03 || p > 0.97) return;

        if (!a.market) a.market = {};
        if (!_wsMarketPrices[m.key]) _wsMarketPrices[m.key] = {};
        const wsc = _wsMarketPrices[m.key];

        if (m.side === 'up') {
          const uA = parseFloat(ask) > 0 ? parseFloat(ask) : p;
          const uB = parseFloat(bid) > 0 ? parseFloat(bid) : (p - 0.005);
          a.price         = p;
          a.market.up_ask = uA;
          a.market.up_bid = uB;
          wsc.up_ask = uA;
          wsc.up_bid = uB;
          wsc.ts = Date.now();
        } else {
          const dA = parseFloat(ask) > 0 ? parseFloat(ask) : p;
          const dB = parseFloat(bid) > 0 ? parseFloat(bid) : (p - 0.005);
          a.market.down_ask = dA;
          a.market.down_bid = dB;
          wsc.down_ask = dA;
          wsc.down_bid = dB;
          wsc.ts = Date.now();
        }
        // Gerçek spread
        const upAsk  = a.market.up_ask  || 0.5;
        const dnAsk  = a.market.down_ask || 0.5;
        a.market.slippage_pct = Math.max(0, (upAsk + dnAsk - 1) * 100);
        _prevCardVals[m.key] = null; // force re-render
        _scheduleDirectUpdate(m.key); // throttle + rAF batch
      };

      // Format 1: {market, price_changes:[{asset_id, price, best_bid, best_ask}]}
      if (msg.price_changes) {
        msg.price_changes.forEach(ch =>
          _applyToken(ch.asset_id, ch.price, ch.best_bid, ch.best_ask)
        );
      }
      // Format 2: [{market, asset_id, price, ...}] — initial snapshot array
      else if (Array.isArray(msg)) {
        msg.forEach(ch => _applyToken(ch.asset_id, ch.price, ch.best_bid, ch.best_ask));
      }
      // Format 3: single object {asset_id, price}
      // event_type kontrolü: 'book' ve 'book_delta' = orderbook seviyesi (fiyat değil) → atla
      // 'price_change', 'last_trade_price', 'tick_size_change' → işle
      else if (msg.asset_id) {
        const et = (msg.event_type || '').toLowerCase();
        if (et === 'book' || et === 'book_delta' || et === 'orderbook_update') {
          // Orderbook snapshot/delta — bids/asks güncellenir ama market price değil
          // ChatGPT önerisi: orderbook level ≠ trade price, ayrı tutulmalı
        } else {
          // price_change, last_trade_price, tick_size_change, veya bilinmeyen → fiyat güncelle
          const px = msg.price || msg.last_trade_price;
          _applyToken(msg.asset_id, px, msg.best_bid, msg.best_ask);
        }
      }
    } catch(e) {}
  };

  _directClob.onclose = () => {
    setTimeout(() => { if (_directReady) _startDirectClob(); }, 3000);
  };
}

// ─── Direkt Feed: RTDS WebSocket (spot fiyatlar — BTC/ETH/SOL etc.) ──────────
// Her coin ayrı WS bağlantısı alıyor — tek bağlantıda çoklu sub, server sadece 1 coin stream ediyor
const _rtdsWsMap = {};  // rtdsSym → WebSocket

// RTDS relay throttle: her sym için son relay zamanı (ms)
const _rtdsRelayTs = {};
const RTDS_RELAY_MIN_MS = 250; // backend'e max 4/sn relay

function _handleRtdsMsg(data) {
  if (!data || data === 'PONG') return;
  try {
    const msg = JSON.parse(data);
    const payload = msg.payload;
    if (!payload) return;
    const rtdsSym = (payload.symbol || payload.s || '').toLowerCase();
    const sym = RTDS_SYM_MAP[rtdsSym];
    if (!sym) return;
    let val = parseFloat(payload.value);
    if (!val || val <= 0) {
      const arr = payload.data;
      if (arr?.length) val = parseFloat(arr[arr.length - 1]?.value);
    }
    if (!val || val <= 0) return;

    // ─── RELAY — DEBUG/COMPAT ONLY, NOT AUTHORITATIVE ───────────────────────
    // Backend bu mesajı _relay_prices'a yazar — trade kararlarında KULLANILMAZ.
    // Authoritative kaynak: backend _rtds_poll_loop (Python, ~500ms).
    // state.assets ASLA buradan güncellenmez — backend broadcast'i beklenir.
    const now = Date.now();
    if (now - (_rtdsRelayTs[sym] || 0) >= RTDS_RELAY_MIN_MS) {
      _rtdsRelayTs[sym] = now;
      wsSend({ type: 'price_relay', sym, val });
    }
    // Cache güncelle (sadece debug modda kullanılır)
    _wsLivePrices[sym] = { val, ts: now };
  } catch(e) {}
}

function _startRtdsForSym(rtdsSym) {
  if (_rtdsWsMap[rtdsSym]) { try { _rtdsWsMap[rtdsSym].close(); } catch(e){} }
  const ws = new WebSocket('wss://ws-live-data.polymarket.com');
  _rtdsWsMap[rtdsSym] = ws;
  ws.onopen = () => ws.send(JSON.stringify({
    action: 'subscribe',
    subscriptions: [{ topic: 'crypto_prices', type: '*', filters: JSON.stringify({ symbol: rtdsSym }) }],
  }));
  ws.onmessage = ({ data }) => _handleRtdsMsg(data);
  ws.onclose = () => {
    delete _rtdsWsMap[rtdsSym];
    if (_directReady) setTimeout(() => _startRtdsForSym(rtdsSym), 3000);
  };
}

function _startDirectRtds() {
  // Eski bağlantıları kapat
  Object.values(_rtdsWsMap).forEach(w => { try { w.close(); } catch(e){} });
  Object.keys(_rtdsWsMap).forEach(k => delete _rtdsWsMap[k]);
  // Her coin için ayrı bağlantı — server her bağlantıda 1 coin stream ediyor
  Object.keys(RTDS_SYM_MAP).forEach((rtdsSym, i) => {
    setTimeout(() => _startRtdsForSym(rtdsSym), i * 200); // 200ms stagger
  });
  // _directRtds legacy ref — ilk coin ws'e işaret eder
  _directRtds = { readyState: 1 };  // OPEN placeholder
}

// ─── Direkt Feed: Başlat / Token map yenile ───────────────────────────────────
// Asset KEY değişimini VE token ID değişimini (her 5dk yeni window) izle
let _knownFeedHash = '';
function _maybeStartDirectFeeds() {
  if (!Object.keys(state.assets).length) return;

  // BACKEND_ONLY_MODE: CLOB WS başlatma (seesawing kaynağı).
  // RTDS WS başlatılır — fiyatları backend'e relay eder (display değil, relay amaçlı).
  // CLOB sadece debug modda açılır.
  if (_BACKEND_ONLY_MODE && !window._debugWsEnabled) {
    _buildTokenMap();
    _directReady = true;
    // RTDS relay bağlantılarını başlat (ilk kez veya hash değiştiyse)
    if (!_directRtds || _directRtds.readyState > 1) _startDirectRtds();
    return;
  }

  // Hash: asset keys + token ID'lerini birlikte kontrol et (5dk window değişimi)
  const feedHash = Object.entries(state.assets)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([key, a]) => key + ':' + (a.event?.tokens?.[0] || '').slice(0,8))
    .join('|');
  if (feedHash === _knownFeedHash) return; // hiçbir şey değişmedi
  _knownFeedHash = feedHash;

  _buildTokenMap();
  _directReady = true;

  // Yeni token ID'leri geldi → CLOB yeniden subscribe (RTDS token-bağımsız, gerek yok)
  _startDirectClob();
  if (!_directRtds || _directRtds.readyState > 1) _startDirectRtds();
}

// ═══════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    state.connected = true;
    addLog('success', 'Dashboard bağlandı');
    updateConnectionUI();
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'state_update') {
        // State'i hemen merge et (saf veri, DOM yok)
        _mergeState(msg.data);
        // DOM güncellemesini bir sonraki animation frame'e ertele — birden fazla
        // WS mesajı aynı frame'e düşerse tek bir DOM update yapılır (20→16ms)
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => { _rafPending = false; updateUI(); });
        }
      } else if (msg.type === 'log') {
        addLog(msg.level || 'info', msg.message);
      } else if (msg.type === 'rate_limit') {
        showRateLimitPopup(msg.retry_after || 60);
      }
    } catch (e) { /* ignore */ }
  };

  ws.onclose = () => {
    state.connected = false;
    updateConnectionUI();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 2000);
  };

  ws.onerror = () => { state.connected = false; };
}

function wsSend(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ═══════════════════════════════════════════
// STATE UPDATE
// ═══════════════════════════════════════════
// Hızlı state merge — sadece veri, DOM yok (rAF'tan önce çağrılır)
const _lastKnownSlugs = {}; // key → son bilinen slug (yeni event tespiti için)

function _mergeState(data) {
  if (data.bot_running  !== undefined) state.botRunning   = data.bot_running;
  if (data.data_health)                state.dataHealth   = data.data_health;
  if (data.mode)                       state.mode         = data.mode;
  if (data.balance      !== undefined) state.balance      = data.balance;
  if (data.session_pnl  !== undefined) state.sessionPnl   = data.session_pnl;
  if (data.safe_mode !== undefined) state.safeMode = data.safe_mode;
  if (data.assets    && typeof data.assets === 'object') {
    // Yeni event tespiti: slug değiştiyse WS fiyat cache'ini temizle
    // (eski event'in fiyatları yeni event için yanlış — seesawing kaynağı)
    Object.entries(data.assets).forEach(([k, a]) => {
      const newSlug = a.slug || (a.event && a.event.slug) || '';
      const oldSlug = _lastKnownSlugs[k];
      if (oldSlug && newSlug && oldSlug !== newSlug) {
        // Yeni event başladı — eski WS fiyatlarını temizle
        delete _wsMarketPrices[k];
        console.log(`[PolyFlow] Yeni event ${k}: ${oldSlug} → ${newSlug} | WS fiyat cache temizlendi`);
      }
      if (newSlug) _lastKnownSlugs[k] = newSlug;
    });

    state.assets = data.assets;

    // FAZ 3.5: Backend-only modda WS cache override YAPILMAZ
    // Backend fiyatları tek otorite — seesawing kökten çözüldü.
    if (!_BACKEND_ONLY_MODE || window._debugWsEnabled) {
      // DEBUG modu: Eski workaround aktif (direkt WS fiyatları geri uygula)
      Object.entries(_wsMarketPrices).forEach(([k, wsc]) => {
        if (!state.assets[k]) return;
        if (!wsc.ts || Date.now() - wsc.ts > 10000) return;
        if (!state.assets[k].market) state.assets[k].market = {};
        if (wsc.up_ask   !== undefined) state.assets[k].market.up_ask   = wsc.up_ask;
        if (wsc.up_bid   !== undefined) state.assets[k].market.up_bid   = wsc.up_bid;
        if (wsc.down_ask !== undefined) state.assets[k].market.down_ask = wsc.down_ask;
        if (wsc.down_bid !== undefined) state.assets[k].market.down_bid = wsc.down_bid;
      });
      Object.entries(state.assets).forEach(([k, a]) => {
        const sym = a.symbol || k.split('_')[0];
        const cached = _wsLivePrices[sym];
        if (cached && cached.val > 0 && Date.now() - cached.ts < 15000) {
          state.assets[k].live_price = cached.val;
        }
      });
    }
  }
  if (Array.isArray(data.pinned))                          state.pinned      = data.pinned;
  if (data.selected_asset)                                 state.selectedAsset = data.selected_asset;
  if (Array.isArray(data.positions))                       state.positions   = data.positions;
  if (Array.isArray(data.trade_history))                   state.tradeHistory = data.trade_history;
  if (data.connection_status)          state.connections  = data.connection_status;
  if (data.strategy_status)            state.strategyStatus = data.strategy_status;
  if (data.ws_client_count !== undefined) state.wsClientCount = data.ws_client_count;
  if (data.asset_settings && typeof data.asset_settings === 'object') {
    Object.assign(state.assetSettings, data.asset_settings);
  }
  // Asset listesi değiştiyse direkt feed'leri yenile (yeni token ID'leri)
  if (data.assets) _maybeStartDirectFeeds();
}

// Eski API uyumluluğu için (doğrudan çağrılan yerler için)
function handleStateUpdate(data) {
  _mergeState(data);
  updateUI();
}
