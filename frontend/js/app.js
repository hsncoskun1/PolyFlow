/**
 * POLYFLOW — Dashboard App v1.3.0
 * Accordion multi-event layout + notification bell + page modal
 */

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const state = {
  botRunning:    false,
  mode:          'PAPER',
  connected:     false,
  currentPage:   'watchlist',
  assets:        {},
  pinned:        ['BTC_5M','ETH_5M','SOL_5M'],
  selectedAsset: 'BTC',
  positions:     [],
  tradeHistory:  [],
  balance:       0,
  sessionPnl:    0,
  connections:   { clob_ws:false, btc_ws:false, user_ws:false, gamma_api:false },
  wsClientCount: 0,
  logs:          [],
  // v1.2 additions
  expandedAsset: null,       // which accordion card is expanded
  chipFilter:    'ALL',      // asset chip filter
  orderAmount:   2,          // persisted order amount
  notifications: [],         // bell dropdown list
  notifOpen:     false,      // bell dropdown visible
  // v1.3 additions
  sortMode:      'rules',    // 'rules' | 'countdown' | 'name'
  sortDir:       'desc',     // 'asc' | 'desc'
  timeframe:     '5M',       // '5M' | '15M' | '1H' | '4H' | '1D' | 'ALL'
  showAllMarkets: false,     // true when timeframe === 'ALL'
  // Strategy settings (loaded from /api/settings)
  strategy: {
    min_entry_price:    0.75,
    max_entry_price:    0.98,
    time_rule_threshold: 90,
    min_entry_seconds:  10,
    max_slippage_pct:   0.03,
    min_btc_move_up:    70.0,
    order_amount:       2.0,
    event_trade_limit:  1,
    max_open_positions: 1,
  },
  // Per-event strategy overrides — keyed by full event key (BTC_5M, ETH_15M vs.)
  // Backend SQLite'tan yüklenir, localStorage kullanılmaz
  assetSettings: {},
  // Manual sort order
  manualOrder: [],
  _cardNotifications: {},  // key → {icon, text, type}
  // Collapsible group state
  collapsedGroups: {},
};

let ws             = null;
let reconnectTimer = null;
let uptimeInterval = null;
let _historyFilter = 'all';
let _prevPrices    = {};
let _chipsBuilt    = false;
let _lastRenderKey = ''; // flickering prevention
let _dragSym       = null; // drag-and-drop source
let _rafPending    = false; // requestAnimationFrame batching
let _prevCardVals  = {};   // key → {price, cd, upPct, dnPct, rules} — delta check

// ─── Direkt Polymarket Feed ───────────────────────────────────────────────────
// arbypoly gibi siteler Polymarket WS'e direkt tarayıcıdan bağlanır (1 hop, ~5ms).
// POLYFLOW: backend sadece kural/trade için; fiyat görüntüleme direkt feedden.
let _directClob   = null;  // CLOB WS — UP/DOWN token fiyatları (Polymarket)
let _directRtds   = null;  // RTDS WS — Spot fiyatlar (Binance via Polymarket)
let _tokenMap     = {};    // tokenId → {key:'BTC_5M', side:'up'|'down'}
let _symToKeys    = {};    // 'BTC' → ['BTC_5M','BTC_15M',...]
let _directReady  = false; // asset state yüklendi mi?
const RTDS_SYM_MAP = { btcusdt:'BTC', ethusdt:'ETH', solusdt:'SOL', xrpusdt:'XRP', dogeusdt:'DOGE', bnbusdt:'BNB', hypeusdt:'HYPE' };

// ─── WS Price Caches ────────────────────────────────────────────────────────
// Frontend CLOB/RTDS WS'den gelen fiyatlar burada saklanır.
// Backend state_update her 500ms'de state.assets'i eziyor → WS değerleri kaybolur.
// Çözüm: backend overwrite'tan sonra bu cache'lerden tekrar uygula → seesawing önle.
const _wsMarketPrices = {}; // key → {up_ask, up_bid, down_ask, down_bid, ts}
const _wsLivePrices   = {}; // sym → {val, ts}  — RTDS spot fiyatları (BTC/ETH/SOL...)

// rAF + throttle batching — CLOB 1000+ msg/sn push eder.
// Her kart için min 150ms görüntüleme süresi (göz okuyabilsin).
// Aynı frame'deki tüm değişiklikler toplu tek DOM update'e indirgenir.
let _directRafPending = false;
const _dirtyKeys      = new Set();
const _cardLastShown  = {};  // key → timestamp — throttle için
const DISPLAY_THROTTLE_MS = 100; // min kart güncelleme aralığı

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

/** Extract base symbol from sym_tf key (e.g. "BTC_5M" → "BTC") */
function baseSym(key) { return key.includes('_') ? key.split('_')[0] : key; }
/** Extract timeframe from sym_tf key (e.g. "BTC_5M" → "5M") */
function keyTF(key) { return key.includes('_') ? key.split('_').slice(1).join('_') : '5M'; }
/** Format countdown seconds into compact string: 4:32, 1h12m, 23h05m */
function fmtCD(cd) {
  if (cd <= 0) return '0:00';
  if (cd < 3600) { const m = Math.floor(cd/60); return `${m}:${String(cd%60).padStart(2,'0')}`; }
  const h = Math.floor(cd/3600); const m = Math.floor((cd%3600)/60);
  return `${h}h${String(m).padStart(2,'0')}m`;
}

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
function _startDirectRtds() {
  if (_directRtds) { try { _directRtds.close(); } catch(e){} _directRtds = null; }

  _directRtds = new WebSocket('wss://ws-live-data.polymarket.com');

  _directRtds.onopen = () => {
    // Tüm coinlere tek bağlantıdan subscribe ol (payload.symbol field var)
    Object.keys(RTDS_SYM_MAP).forEach(rtdsSym => {
      _directRtds.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices', type: '*', filters: JSON.stringify({ symbol: rtdsSym }) }],
      }));
    });
  };

  _directRtds.onmessage = ({ data }) => {
    if (!data || data === 'PONG') return;
    try {
      const msg = JSON.parse(data);
      const payload = msg.payload;
      if (!payload) return;

      // Symbol tayini — payload.symbol varsa direkt kullan
      const rtdsSym = (payload.symbol || payload.s || '').toLowerCase();
      const sym = RTDS_SYM_MAP[rtdsSym];
      if (!sym) return;

      // Değer çekimi
      let val = parseFloat(payload.value);
      if (!val || val <= 0) {
        const arr = payload.data;
        if (arr?.length) val = parseFloat(arr[arr.length - 1]?.value);
      }
      if (!val || val <= 0) return;

      // RTDS cache — state_update ezilmesine karşı
      _wsLivePrices[sym] = { val, ts: Date.now() };

      const keys = _symToKeys[sym] || [];
      keys.forEach(key => {
        const a = state.assets[key];
        if (!a || a.live_price === val) return;
        a.live_price = val;
        _prevCardVals[key] = null; // force re-render
        _scheduleDirectUpdate(key); // rAF batch
      });
    } catch(e) {}
  };

  _directRtds.onclose = () => {
    setTimeout(() => { if (_directReady) _startDirectRtds(); }, 3000);
  };
}

// ─── Direkt Feed: Başlat / Token map yenile ───────────────────────────────────
// Asset KEY değişimini VE token ID değişimini (her 5dk yeni window) izle
let _knownFeedHash = '';
function _maybeStartDirectFeeds() {
  if (!Object.keys(state.assets).length) return;
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
  if (data.mode)                       state.mode         = data.mode;
  if (data.balance      !== undefined) state.balance      = data.balance;
  if (data.session_pnl  !== undefined) state.sessionPnl   = data.session_pnl;
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
    // Backend state_update her 500ms'de state.assets'i tamamen eziyor → WS değerleri kaybolur
    // Çözüm 1: CLOB WS market fiyatlarını geri uygula (up_ask/down_ask)
    Object.entries(_wsMarketPrices).forEach(([k, wsc]) => {
      if (!state.assets[k]) return;
      if (!wsc.ts || Date.now() - wsc.ts > 10000) return; // 10sn stale → backend değeri kullan
      if (!state.assets[k].market) state.assets[k].market = {};
      if (wsc.up_ask   !== undefined) state.assets[k].market.up_ask   = wsc.up_ask;
      if (wsc.up_bid   !== undefined) state.assets[k].market.up_bid   = wsc.up_bid;
      if (wsc.down_ask !== undefined) state.assets[k].market.down_ask = wsc.down_ask;
      if (wsc.down_bid !== undefined) state.assets[k].market.down_bid = wsc.down_bid;
    });
    // Çözüm 2: RTDS live_price'ı geri uygula (BTC/ETH/SOL spot)
    Object.entries(state.assets).forEach(([k, a]) => {
      const sym = a.symbol || k.split('_')[0];
      const cached = _wsLivePrices[sym];
      if (cached && cached.val > 0 && Date.now() - cached.ts < 15000) {
        state.assets[k].live_price = cached.val;
      }
    });
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

// ═══════════════════════════════════════════
// MASTER UI
// ═══════════════════════════════════════════
function updateUI() {
  updateBotBtn();
  updateSidebar();
  updateConnectionUI();
  updateNotifBadge();

  // TF sekmelerini dinamik olustur (ilk seferde veya asset degisince)
  if (!_tfTabsBuilt || Object.keys(state.assets).length !== state._lastAssetCount) {
    buildTfTabs();
    state._lastAssetCount = Object.keys(state.assets).length;
  }

  // Events list always renders in background
  renderEventsList();

  // Modal page updates (if modal is open)
  if (state.currentPage === 'positions') updatePositionsPage();
  if (state.currentPage === 'history')   updateHistoryPage();
  if (state.currentPage === 'logs')      renderLogPage();
}

// ─── Bot Butonu ──────────────────────────
function updateBotBtn() {
  const dot        = document.getElementById('bot-status-dot');
  const text       = document.getElementById('bot-status-text');
  const startRow   = document.getElementById('bot-start-row');
  const runningRow = document.getElementById('bot-running-row');
  if (state.botRunning) {
    if (dot)        dot.className  = 'status-dot online pulse-green';
    if (text)       text.textContent = 'Çalışıyor';
    if (startRow)   startRow.style.display   = 'none';
    if (runningRow) runningRow.style.display  = 'flex';
  } else {
    if (dot)        dot.className  = 'status-dot offline';
    if (text)       text.textContent = 'Durduruldu';
    if (startRow)   startRow.style.display   = 'block';
    if (runningRow) runningRow.style.display  = 'none';
  }
}

// ─── Sidebar ─────────────────────────────
let _botStartTime = null;
let _runtimeInterval = null;

function _formatRuntime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function _updateRuntimeDisplay() {
  const el = document.getElementById('sidebar-runtime');
  if (!el) return;
  if (_botStartTime && state.botRunning) {
    el.textContent = _formatRuntime(Date.now() - _botStartTime);
  } else {
    el.textContent = '00:00:00';
  }
}

function updateSidebar() {
  // Bot status text (Turkish)
  const statusText = document.getElementById('bot-status-text');
  if (statusText) statusText.textContent = state.botRunning ? 'Çalışıyor' : 'Durduruldu';

  // Track runtime
  if (state.botRunning && !_botStartTime) {
    _botStartTime = Date.now();
    if (!_runtimeInterval) _runtimeInterval = setInterval(_updateRuntimeDisplay, 1000);
  } else if (!state.botRunning && _botStartTime) {
    _botStartTime = null;
    if (_runtimeInterval) { clearInterval(_runtimeInterval); _runtimeInterval = null; }
    _updateRuntimeDisplay();
  }

  // Wallet/api status
  const modeEl = document.getElementById('sidebar-mode');
  if (modeEl) {
    if (state._walletConfigured === true) {
      modeEl.textContent = 'API Bağlı';
      modeEl.style.color = 'var(--accent-green)';
    } else if (state._walletConfigured === false) {
      modeEl.textContent = 'API Eksik';
      modeEl.style.color = 'var(--accent-yellow)';
    } else {
      modeEl.textContent = '—';
      modeEl.style.color = '';
    }
  }

  // Active positions count badge in nav
  const posLocked = state.positions.reduce((sum, p) => sum + (p.amount || 0), 0);

  const pinCount = document.getElementById('nav-pinned-count');
  if (pinCount) pinCount.textContent = state.pinned.length;

  const posCount = document.getElementById('nav-pos-count');
  if (posCount) {
    posCount.textContent = state.positions.length;
    posCount.style.display = state.positions.length > 0 ? '' : 'none';
  }

  // WS / assets info
  setText('set-ws-clients', state.wsClientCount);
  setText('set-assets', Object.keys(state.assets).length);
}

// ─── Connections ─────────────────────────
function updateConnectionUI() {
  const map = {
    'conn-clob':      state.connections.clob_ws,
    'conn-btc':       state.connections.btc_ws,
    'conn-gamma':     state.connections.gamma_api,
    'conn-relayer':   state.connections.user_ws,
    'set-conn-clob':  state.connections.clob_ws,
    'set-conn-btc':   state.connections.btc_ws,
    'set-conn-user':  state.connections.user_ws,
    'set-conn-gamma': state.connections.gamma_api,
  };
  for (const [id, ok] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.className = `status-dot ${ok ? 'online' : 'offline'}`;
  }
}

// ═══════════════════════════════════════════
// EVENTS LIST (List/Accordion mode only)
// ═══════════════════════════════════════════
function renderEventsList() {
  const container = document.getElementById('events-list');
  if (!container) return;

  const allKeys = Object.keys(state.assets); // e.g. ["BTC_5M","BTC_1D","ETH_5M",...]
  if (!allKeys.length) {
    const connMsg = state.connected ? 'Market verileri taranıyor...' : 'Sunucuya bağlanıyor...';
    container.innerHTML = `<div class="text-center text-muted" style="padding:60px 20px;">
      <div style="font-size:32px;margin-bottom:10px;">📡</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:6px;">${connMsg}</div>
      <div style="font-size:11px;opacity:0.6;">Polymarket Gamma API taranıyor — lütfen bekleyin</div>
    </div>`;
    return;
  }

  // Timeframe filter — pinned (işlem açılacaklar) always shown regardless of TF
  const _pinnedKeys = allKeys.filter(k => state.pinned.includes(k));
  let tfFiltered;
  if (state.timeframe === 'ALL') {
    tfFiltered = allKeys;
  } else if (state.timeframe === 'PINNED') {
    tfFiltered = _pinnedKeys;
  } else {
    const tfMatch = allKeys.filter(k => k.endsWith('_' + state.timeframe));
    tfFiltered = [...new Set([..._pinnedKeys, ...tfMatch])];
  }

  // Pinned/untracked filter
  let baseKeys;
  if (state.showAllMarkets) {
    baseKeys = tfFiltered;
  } else {
    // Event bazlı pin: key'in kendisi veya base sym pinli ise göster
    // Event bazli pin: sadece key'in kendisi pinli ise goster
    baseKeys = tfFiltered.filter(k => state.pinned.includes(k));
    if (!baseKeys.length) baseKeys = tfFiltered;
  }

  // Build asset chips from unique base symbols
  if (!_chipsBuilt) {
    const uniqueSyms = [...new Set(baseKeys.map(k => k.split('_')[0]))];
    buildAssetChips(uniqueSyms);
    _chipsBuilt = true;
  }

  // Chip filter (by base sym)
  const filtered = state.chipFilter === 'ALL'
    ? baseKeys
    : baseKeys.filter(k => k.split('_')[0] === state.chipFilter);

  setText('events-count', `${filtered.length} market${filtered.length !== 1 ? 's' : ''}`);
  const tradingCount = state.pinned.length;
  setText('nav-pinned-count', `${tradingCount}/${allKeys.length}`);

  // Toolbar stats
  const wins   = state.tradeHistory.filter(t => (t.pnl||0) > 0).length;
  const losses = state.tradeHistory.filter(t => (t.pnl||0) < 0).length;
  const total  = wins + losses;
  const wr     = total > 0 ? Math.round(wins / total * 100) : 0;
  setText('tb-balance', formatUSD(state.balance));
  const tbPnl = document.getElementById('tb-pnl');
  if (tbPnl) {
    tbPnl.textContent = formatUSD(state.sessionPnl);
    tbPnl.className = `toolbar-stat-val ${state.sessionPnl >= 0 ? 'text-green' : 'text-red'}`;
  }
  setText('tb-winrate', `${wr}%`);
  setText('tb-trades', state.positions.length);

  // Sort (with direction)
  const ruleKeys = ['time','price','btc_move','slippage','event_limit','max_positions'];
  const dir = state.sortDir === 'asc' ? 1 : -1;
  let sorted = [...filtered];
  if (state.sortMode === 'rules') {
    sorted.sort((a, b) => {
      const aPass = ruleKeys.filter(k => (state.assets[a]?.rules?.[k]) === 'pass').length;
      const bPass = ruleKeys.filter(k => (state.assets[b]?.rules?.[k]) === 'pass').length;
      return (aPass - bPass) * dir;
    });
  } else if (state.sortMode === 'countdown') {
    sorted.sort((a, b) => {
      const acd = state.assets[a]?.countdown ?? 999;
      const bcd = state.assets[b]?.countdown ?? 999;
      return (acd - bcd) * dir;
    });
  } else if (state.sortMode === 'name') {
    sorted.sort((a, b) => a.localeCompare(b) * dir);
  } else if (state.sortMode === 'manual') {
    if (!state.manualOrder.length) state.manualOrder = [...sorted];
    sorted.sort((a, b) => {
      const ai = state.manualOrder.indexOf(a);
      const bi = state.manualOrder.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
  }

  // Grouping: TRACKED (pinned) always on top, then untracked
  const isPinned = k => state.pinned.includes(k);
  const pinnedWithPos = sorted.filter(k => isPinned(k) &&  state.assets[k]?.has_position);
  const pinnedNoPos   = sorted.filter(k => isPinned(k) && !state.assets[k]?.has_position);
  const unpinned      = sorted.filter(k => !isPinned(k));
  sorted = [...pinnedWithPos, ...pinnedNoPos, ...unpinned];

  // Smart render key (include collapsed state)
  const cgKey = JSON.stringify(state.collapsedGroups);
  const renderKey = sorted.join(',') + '|' + (state.expandedAsset || '') + '|' + state.chipFilter + '|' + (state.showAllMarkets ? '1' : '0') + '|' + state.sortMode + '|' + cgKey;
  if (renderKey !== _lastRenderKey || !container.querySelector('.eac')) {
    _lastRenderKey = renderKey;
    let html = '';

    // Helper to build a collapsible group section
    const buildGroup = (groupId, label, dot, items, topGap) => {
      if (items.length === 0) return '';
      const collapsed = !!state.collapsedGroups[groupId];
      const arrow = collapsed ? '▶' : '▼';
      const gapStyle = topGap ? 'margin-top:8px' : '';
      let out = `<div class="group-label group-toggle" style="${gapStyle}" onclick="toggleGroup('${groupId}')">
        <span class="group-dot ${dot}"></span>
        <span class="group-label-text">${label} (${items.length})</span>
        <span class="group-arrow">${arrow}</span>
      </div>`;
      if (!collapsed) out += items.map(sym => renderEventCard(sym)).join('');
      return out;
    };

    html += buildGroup('aktif',   'Aktif Pozisyonlar',   'active', pinnedWithPos, false);
    html += buildGroup('trading', 'İşlem Açılacaklar',   'active', pinnedNoPos,   pinnedWithPos.length > 0);
    html += buildGroup('others',  'İşlem Açılmayanlar',  '',       unpinned,      pinnedWithPos.length > 0 || pinnedNoPos.length > 0);

    container.innerHTML = html;
  } else {
    updateCardsInPlace(sorted);
  }
}

// ─── In-Place Card Update (anti-flicker + delta check) ──
function updateCardsInPlace(keys) {
  const ruleKeys = ['time','price','btc_move','slippage','event_limit','max_positions'];
  keys.forEach(key => {
    const a   = state.assets[key];
    if (!a) return;
    const sym = a.symbol || key.split('_')[0];
    const mp  = a.market || {};
    const cd  = a.countdown || 0;

    // Delta check — bu card için hiçbir şey değişmediyse DOM'a dokunma
    // ptb ve live_price dahil — bunlar değişince DOM güncellensin
    const _pv = _prevCardVals[key];
    const rulesStr = a.rules ? Object.values(a.rules).join('') : '';
    const _cv = {
      p: a.price, cd, uA: mp.up_ask, dA: mp.down_ask,
      lp: a.live_price, r: rulesStr,
      ptb: a.ptb || 0,               // PTB değişince güncelle
    };
    if (_pv && _pv.p === _cv.p && _pv.cd === _cv.cd &&
        _pv.uA === _cv.uA && _pv.dA === _cv.dA &&
        _pv.lp === _cv.lp && _pv.r === _cv.r &&
        _pv.ptb === _cv.ptb) {
      return; // hiçbir şey değişmedi, bu kart için geç
    }
    _prevCardVals[key] = _cv;
    const cdStr = fmtCD(cd);
    const barPct   = cd > 0 ? Math.max(1, ((300 - cd) / 300) * 100) : 0;
    const barColor = cd <= 20 ? 'var(--accent-red)' : cd <= 60 ? 'var(--accent-yellow)' : 'var(--accent-purple)';
    const card = document.getElementById(`eac-${key}`);
    if (!card) return;

    // Current price flash
    const prev     = _prevPrices[key] || a.price;
    const flashCls = a.price > prev ? 'flash-green' : a.price < prev ? 'flash-red' : '';
    _prevPrices[key] = a.price;
    const priceEl = card.querySelector('.eac-anlık-val');
    if (priceEl) {
      priceEl.textContent = formatAssetPrice(sym, a.price);
      if (flashCls) {
        priceEl.classList.add(flashCls);
        setTimeout(() => priceEl.classList.remove(flashCls), 600);
      }
    }

    // PTB ve live_price header güncellemesi
    // (buildEventCard sadece ilk render'da oluşturuyor — sonrasını biz güncelliyoruz)
    const ptbEl = card.querySelector('.eac-ptb-val');
    if (ptbEl) {
      ptbEl.textContent = a.ptb
        ? '$' + Number(a.ptb).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
        : '...';
    }
    const livePriceEl = card.querySelector('.eac-live-price');
    const priceSepEl  = card.querySelector('.eac-price-sep');
    if (a.live_price && a.live_price > 0) {
      const lpStr = '$' + Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
      if (livePriceEl) {
        livePriceEl.textContent = lpStr;
        livePriceEl.style.display = '';
      } else {
        // Eleman henüz yok → oluştur
        const ptbRow = ptbEl?.parentElement;
        if (ptbRow) {
          if (!ptbRow.querySelector('.eac-price-sep')) {
            ptbRow.insertAdjacentHTML('beforeend', `<span class="eac-price-sep">|</span><span class="eac-live-price">${lpStr}</span>`);
          }
        }
      }
      if (priceSepEl) priceSepEl.style.display = '';
    } else {
      if (livePriceEl) livePriceEl.style.display = 'none';
      if (priceSepEl)  priceSepEl.style.display  = 'none';
    }

    // Price diff for rule calculations
    const refPrice  = a.event?.open_reference || a.price;
    const priceDiff = a.price - refPrice;

    // Countdown bar in expanded body
    const barFill = card.querySelector('.eac-cd-bar-fill');
    if (barFill) {
      barFill.style.width  = `${barPct}%`;
      barFill.style.background = barColor;
    }

    // Rule blocks — st: per-event settings (key="BTC_5M"), sym değil ("BTC" olursa bulunamaz)
    const rules          = a.rules || {};
    const st             = getAssetStrategy(key);
    const spreadDisabled = (st.max_slippage_pct || 0.03) >= 0.5;
    // up_ask kullan (WS = gerçek zamanlı, _applyToken zaten 0.03-0.97 filtreli)
    const upAsk          = mp.up_ask  || 0.5;
    const downAsk        = mp.down_ask || 0.5;
    const upPct          = (upAsk   * 100).toFixed(0);
    const dnPct          = (downAsk * 100).toFixed(0);
    const timeMin        = st.min_entry_seconds   || 10;
    const timeMax        = st.time_rule_threshold || 90;
    const _fmtSec = (s) => {
      if (s < 60) return `${s}sn`;
      if (s < 3600) return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}dk`;
      const hh = Math.floor(s/3600), mm = Math.floor((s%3600)/60);
      return `${hh}h${String(mm).padStart(2,'0')}dk`;
    };
    const timeMinStr     = _fmtSec(timeMin);
    const timeMaxStr     = _fmtSec(timeMax);
    // Delta: backend mp.btc_delta öncelikli (simulation_tick'te live_price-ptb hesaplar)
    // Fallback: frontend kendi hesaplar (RTDS cache + ptb)
    const btcDelta = mp.btc_delta != null
      ? mp.btc_delta
      : (a.live_price && a.ptb ? (a.live_price - a.ptb) : null);
    const moveStr  = btcDelta != null
      ? (btcDelta >= 0 ? '+$' : '-$') + Math.abs(btcDelta).toFixed(2)
      : '...';
    const spreadVal      = (mp.slippage_pct || 0).toFixed(2) + '%';
    const posCount       = state.positions.length;
    const assetPosCnt    = state.positions.filter(p => p.asset === sym).length;
    const eTradeLim      = st.event_trade_limit || 1;
    const maxOpenPos     = st.max_open_positions || 1;

    card.querySelectorAll('.eac-rb[data-rb]').forEach(rb => {
      const key = rb.dataset.rb;
      let status, mainTxt;
      if (key === 'time') {
        status  = rules.time || 'waiting';
        mainTxt = `${timeMinStr} │ ${cdStr} │ ${timeMaxStr}`;
      } else if (key === 'price') {
        status  = rules.price || 'waiting';
        mainTxt = `↑${upPct}% │ ↓${dnPct}%`;
      } else if (key === 'move') {
        status  = rules.btc_move || 'waiting';
        mainTxt = `Δ ${moveStr}`;
      } else if (key === 'slip') {
        status = spreadDisabled ? 'pass' : (rules.slippage || 'waiting');
        if (!spreadDisabled) mainTxt = spreadVal;
      } else if (key === 'event-limit') {
        status  = rules.event_limit || 'waiting';
        mainTxt = `${assetPosCnt}/${eTradeLim}`;
      } else if (key === 'max-pos') {
        status  = rules.max_positions || 'waiting';
        mainTxt = `${posCount}/${maxOpenPos}`;
      }
      rb.className = `eac-rb rb-${status}`;
      if (mainTxt !== undefined) {
        const mainEl = rb.querySelector('.eac-rb-main');
        if (mainEl && mainEl.textContent !== mainTxt) {
          mainEl.textContent = mainTxt;
          mainEl.classList.remove('rb-val-flash');
          void mainEl.offsetWidth; // reflow to restart animation
          mainEl.classList.add('rb-val-flash');
        }
      }
    });

    // Rule count badge
    const passCount = ruleKeys.filter(k => {
      if (k === 'slippage' && spreadDisabled) return true;
      return rules[k] === 'pass';
    }).length;
    const allPass    = passCount === 6;
    const countColor = allPass ? 'all-pass' : passCount >= 4 ? 'waiting' : 'has-fail';
    const countDiv   = card.querySelector('.eac-hdr-right .eac-rule-count');
    if (countDiv) {
      countDiv.className = `eac-rule-count ${countColor}`;
      const numEl = countDiv.querySelector('.eac-rule-count-num');
      if (numEl) numEl.textContent = `${passCount}/6`;
    }

    // PNL inline badge update in header
    const pnlBadge = card.querySelector('.eac-pnl-inline');
    const pos = state.positions.find(p => p.asset === sym);
    if (pnlBadge && pos) {
      const pnl = pos.pnl || 0;
      pnlBadge.className = `eac-pnl-inline ${pnl >= 0 ? 'pos' : 'neg'}`;
      pnlBadge.textContent = `${pnl >= 0 ? '+' : ''}${formatUSD(pnl)}`;
    }

    // PTB + canli fiyat guncelle
    const ptbEl = card.querySelector('.eac-ptb-val');
    if (ptbEl && a.ptb) {
      ptbEl.textContent = '$' + Number(a.ptb).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    }
    const liveEl = card.querySelector('.eac-live-price');
    if (a.live_price) {
      if (liveEl) {
        liveEl.textContent = '$' + Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
      } else {
        // live_price elementi yoksa ekle
        const priceRow = card.querySelector('.eac-price-row');
        if (priceRow && !priceRow.querySelector('.eac-live-price')) {
          priceRow.insertAdjacentHTML('beforeend',
            `<span class="eac-price-sep">|</span><span class="eac-live-price">$${Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>`
          );
        }
      }
    }

    // GO alert: sound + banner when all rules pass for a tracked asset
    if (allPass && state.pinned.includes(key) && state.botRunning) {
      if (!_goAlerted[sym]) {
        _goAlerted[sym] = true;
        playGoAlert(sym);
      }
    } else {
      _goAlerted[sym] = false;
    }
  });
}

// ─── GO Alert System ────────────────────────
const _goAlerted = {};
function playGoAlert(sym) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0.15;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch(e) {}
  showGoBanner(sym);
}

function showGoBanner(sym) {
  let banner = document.getElementById('go-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'go-banner';
    banner.className = 'go-banner';
    document.querySelector('.main-content')?.prepend(banner);
  }
  const a = state.assets[sym];
  banner.innerHTML = `<span class="go-banner-icon">🟢</span> <strong>${sym}</strong> — Tüm kurallar sağlandı! Giriş için hazır. <span class="go-banner-time">${new Date().toLocaleTimeString()}</span>`;
  banner.style.display = 'flex';
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => { banner.style.display = 'none'; }, 8000);
}

function buildAssetChips(syms) {
  // syms = unique base symbols (e.g. ["BTC","ETH","SOL"])
  const chips = document.getElementById('asset-chips');
  if (!chips) return;
  if (syms.length <= 1) { chips.innerHTML = ''; return; }
  chips.innerHTML =
    `<button class="asset-chip ${state.chipFilter === 'ALL' ? 'active' : ''}" onclick="filterEvents('ALL',this)">All</button>` +
    syms.map(sym => {
      // find any asset entry for this sym to get color
      const key = Object.keys(state.assets).find(k => k.startsWith(sym + '_'));
      const a = key ? state.assets[key] : null;
      const active = state.chipFilter === sym ? 'active' : '';
      return `<button class="asset-chip ${active}" onclick="filterEvents('${sym}',this)"
        style="${active ? '' : `border-color:${a?.color||'#555'}33;`}">${sym}</button>`;
    }).join('');
}

// ─── Single Accordion Card ────────────────
function renderEventCard(key) {
  const a = state.assets[key];
  if (!a) return '';

  // key = "BTC_5M" → sym = "BTC", tf = "5M"
  const sym = a.symbol || key.split('_')[0];
  const tf  = a.timeframe || key.split('_').slice(1).join('_') || '5M';

  const mp      = a.market || {};
  const cd      = a.countdown || 0;
  const cdStr   = fmtCD(cd);

  // up_ask kullan (WS = gerçek zamanlı, _applyToken zaten 0.03-0.97 filtreli)
  const upAsk   = mp.up_ask  || 0.5;
  const downAsk = mp.down_ask || 0.5;
  const upPct   = (upAsk  * 100).toFixed(0);
  const dnPct   = (downAsk * 100).toFixed(0);

  const pinned   = state.pinned.includes(key);
  const hasPos   = a.has_position;
  const rules    = a.rules || {};
  const ruleKeys = ['time','price','btc_move','slippage','event_limit','max_positions'];

  const st = getAssetStrategy(key);
  const hasCustomSettings = !!(state.assetSettings[key]);
  const settingsConfigured = a.settings_configured !== false; // backend'den gelir, yoksa true kabul et
  const spreadDisabled = (st.max_slippage_pct || 0.03) >= 0.5;

  const passCount = ruleKeys.filter(k => {
    if (k === 'slippage' && spreadDisabled) return true;
    return rules[k] === 'pass';
  }).length;
  const allPass    = settingsConfigured && passCount === 6;
  const countColor = !settingsConfigured ? 'has-fail' : allPass ? 'all-pass' : passCount >= 4 ? 'waiting' : 'has-fail';

  const refPrice  = a.event?.open_reference || a.price;
  const priceDiff = a.price - refPrice;

  const timeStatus   = rules.time          || 'waiting';
  const priceStatus  = rules.price         || 'waiting';
  const moveStatus   = rules.btc_move      || 'waiting';
  const spreadStatus = spreadDisabled ? 'pass' : (rules.slippage || 'waiting');
  const elStatus     = rules.event_limit   || 'waiting';
  const mpStatus     = rules.max_positions || 'waiting';

  const timeMin    = st.min_entry_seconds || 10;
  const timeMax    = st.time_rule_threshold || 90;
  const timeMinStr = timeMin < 60 ? `${timeMin}sn` : `${Math.floor(timeMin/60)}:${String(timeMin%60).padStart(2,'0')}dk`;
  const timeMaxStr = timeMax < 60 ? `${timeMax}sn` : `${Math.floor(timeMax/60)}:${String(timeMax%60).padStart(2,'0')}dk`;
  const priceRangeStr = `${((st.min_entry_price||0.75)*100).toFixed(0)}–${((st.max_entry_price||0.98)*100).toFixed(0)}%`;

  // BTC USD delta = anlık fiyat - PTB (Polymarket sayfasındaki gibi)
  const btcDelta   = (a.live_price && a.ptb) ? (a.live_price - a.ptb) : null;
  const minMoveUsd = st.min_move_delta != null ? Number(st.min_move_delta) : 70;
  const moveStr    = btcDelta != null
    ? (btcDelta >= 0 ? '+' : '') + '$' + Math.abs(btcDelta).toFixed(2)
    : '...';
  const minMoveStr = `Min $${minMoveUsd.toFixed(0)}`;

  const spreadVal = (mp.slippage_pct || 0).toFixed(2) + '%';
  const spreadMax = ((st.max_slippage_pct || 0.03) * 100).toFixed(0) + '%';

  const posCount    = state.positions.length;
  const assetPosCnt = state.positions.filter(p => p.asset === sym).length;
  const eTradeLim   = st.event_trade_limit || 1;
  const maxOpenPos  = st.max_open_positions || 1;

  const pos = state.positions.find(p => p.asset === sym) || null;

  const prev     = _prevPrices[key] || a.price;
  const flashCls = a.price > prev ? 'flash-green' : a.price < prev ? 'flash-red' : '';
  _prevPrices[key] = a.price;

  const isDraggable = state.sortMode === 'manual';
  const dragAttrs   = isDraggable
    ? `draggable="true" ondragstart="onCardDragStart('${key}',event)" ondragend="onCardDragEnd(event)" ondragover="onCardDragOver('${key}',event)" ondrop="onCardDrop('${key}',event)"`
    : '';

  const isUntracked = !pinned && state.showAllMarkets;

  // Event data
  const slug = a.slug || a.event?.slug || '';
  const eventUrl = slug ? `https://polymarket.com/event/${slug}` : '';
  const eventQ = a.event?.question || '';

  // Kısa başlık: sadece coin adı (TF ayrı badge olarak gösterilir)
  const shortTitle = a.name;

  // LIVE check: market is live if countdown > 0 and source is "live"
  const isLive = cd > 0 && (a.event?.source === 'live' || !!slug);
  const liveBadge = isLive ? '<span class="badge-live">CANLI</span>' : '';

  return `
<div class="eac ${hasPos ? 'has-position' : ''} ${isUntracked ? 'untracked' : ''}" id="eac-${key}" ${dragAttrs}>
  <div class="eac-hdr">

    <!-- SOL: ikon + isim + 5DK + pin + CANLI -->
    <div class="eac-hdr-left">
      <div class="eac-icon" style="background:${a.color}22;color:${a.color};">${a.icon}</div>
      <div class="eac-hdr-text">
        <div class="eac-title-row">
          ${eventUrl
            ? `<a class="eac-name eac-name-link" href="${eventUrl}" target="_blank" onclick="event.stopPropagation()" title="${eventQ}">${shortTitle}</a>`
            : `<span class="eac-name">${shortTitle}</span>`
          }
          <span class="eac-tf">${{'5M':'5DK','15M':'15DK','1H':'1SA','4H':'4SA','1D':'1G'}[tf]||tf}</span>
          <button class="trade-btn ${pinned ? 'active' : ''}"
            onclick="event.stopPropagation(); togglePin('${key}')"
            title="${pinned ? 'İşlem açılacaklardan çıkar' : 'İşlem açılacaklara ekle'}">$</button>
          ${liveBadge}
          ${hasPos ? '<span class="badge-pos">●</span>' : ''}
          ${(allPass && state.botRunning && pinned) ? '<span class="badge-ready">AL</span>' : ''}
        </div>
        <div class="eac-price-row">
          <span class="eac-ptb-label">PTB</span>
          <span class="eac-ptb-val">${a.ptb ? '$' + Number(a.ptb).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '...'}</span>
          ${a.live_price ? `<span class="eac-price-sep">|</span><span class="eac-live-price">$${Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- ORTA: bildirim alanı -->
    <div class="eac-hdr-mid">
      ${(()=>{
        // Transient trade bildirimleri (bot events, TP, SL, vs.) önceliklidir
        const notif = (state._cardNotifications || {})[key];
        if (notif) return `<span class="eac-card-notif notif-${notif.type}">${notif.icon} ${notif.text}</span>`;
        // State'den hesaplanan kalıcı bildirim
        const isPinned = state.pinned && state.pinned.includes(key);
        if (isPinned && settingsConfigured) return `<span class="eac-card-notif notif-info">💸 Tüm ayarlar tamam — kural taraması yapılıyor</span>`;
        if (!isPinned && settingsConfigured) return `<span class="eac-card-notif notif-success">✅ Ayarlandı — işlem açmaya hazır</span>`;
        return `<span class="eac-card-notif notif-warn">⚠ Ayar yapmadan işlem açılamaz</span>`;
      })()}
    </div>

    <!-- SAG: 0/6 + kurallar (her zaman gösterilir) -->
    <div class="eac-hdr-right">
      ${pos
        ? `<span class="eac-pnl-inline ${(pos.pnl||0)>=0?'pos':'neg'}" title="Acik pozisyon P&L">${(pos.pnl||0)>=0?'+':''}${formatUSD(pos.pnl)}</span><div class="eac-rb-sep"></div>`
        : ''
      }
      <div class="eac-rule-count ${countColor}" title="Kural durumu">
        <span class="eac-rule-count-num">${passCount}/6</span>
      </div>
      <div class="eac-rb-sep"></div>
      <div class="eac-rb rb-${timeStatus}" data-rb="time" title="Zaman: ${timeMinStr}–${timeMaxStr}">
        <span class="eac-rb-main">${timeMinStr} │ ${cdStr} │ ${timeMaxStr}</span>
        <span class="eac-rb-sub">Min │ Kalan │ Max</span>
      </div>
      <div class="eac-rb-sep"></div>
      <div class="eac-rb rb-${priceStatus}" data-rb="price" title="Entry: ${priceRangeStr}">
        <span class="eac-rb-main">↑${upPct}% │ ↓${dnPct}%</span>
        <span class="eac-rb-sub">${priceRangeStr}</span>
      </div>
      <div class="eac-rb-sep"></div>
      <div class="eac-rb rb-${moveStatus}" data-rb="move" title="Min: ${minMoveStr}">
        <span class="eac-rb-main">Δ ${moveStr}</span>
        <span class="eac-rb-sub">${minMoveStr}</span>
      </div>
      <div class="eac-rb-sep"></div>
      <div class="eac-rb rb-${spreadStatus}" data-rb="slip"
        title="${spreadDisabled ? 'Devre dışı' : `Anlık: ${spreadVal} / Max: ${spreadMax}`}">
        ${spreadDisabled
          ? `<span class="eac-rb-main"><span class="eac-rb-deaktif">DEAKTIF</span></span><span class="eac-rb-sub">Spread</span>`
          : `<span class="eac-rb-main">${spreadVal}</span><span class="eac-rb-sub">Max ${spreadMax}</span>`}
      </div>
      <div class="eac-rb-sep"></div>
      <div class="eac-rb rb-${elStatus}" data-rb="event-limit" title="Event başına max: ${assetPosCnt}/${eTradeLim}">
        <span class="eac-rb-main">${assetPosCnt}/${eTradeLim}</span>
        <span class="eac-rb-sub">Olay Maks</span>
      </div>
      <div class="eac-rb-sep"></div>
      <div class="eac-rb rb-${mpStatus}" data-rb="max-pos" title="Aç. pos: ${posCount}/${maxOpenPos}">
        <span class="eac-rb-main">${posCount}/${maxOpenPos}</span>
        <span class="eac-rb-sub">Bot Maks</span>
      </div>
      <div class="eac-hdr-gap"></div>
      ${pinned
        ? `<button class="eac-settings-quick${!settingsConfigured ? ' needs-settings' : ''}"
               onclick="event.stopPropagation(); openAssetSettings('${key}')"
               title="${!settingsConfigured ? '⚠️ Ayar gerekli!' : 'Ayarları düzenle'}">
               ${!settingsConfigured ? 'Ayar Gerekli' : 'Ayarlar'}
             </button>`
        : `<button class="eac-settings-quick untracked-add"
               onclick="event.stopPropagation(); pinAndOpenSettings('${key}')"
               title="Ayarla ve işlem açılacaklar listesine ekle">Ayarlar</button>`
      }
    </div>

  </div>
</div>`;
}

// ─── Per-Event Settings Modal ──────────────────────────────────────────────────
// Her event (BTC_5M, ETH_15M vs.) kendi ayarlarını SQLite'ta saklar.
// Yeni eventlerde alanlar boş gösterilir (sadece silik placeholder).
// Tüm alanlar doldurulmadan kayıt yapılamaz.

// min/max: kullanıcıya gösterilen birimde (% alanlar zaten ×100 gösterilir)
const EVENT_SETTING_FIELDS = [
  // — Giriş Koşulları —
  { key:'min_entry_price',    label:'Min Giriş',         unit:'%',  min:50,  max:99,    step:'1',   placeholder:'örn: 76',  hint:'UP token minimum olasılık eşiği. Bu değerin altında işlem açılmaz. (örn: 76 = %76)' },
  { key:'max_entry_price',    label:'Max Giriş',         unit:'%',  min:51,  max:99,    step:'1',   placeholder:'örn: 97',  hint:'UP token maksimum olasılık eşiği. Bu değerin üzerinde işlem açılmaz. (örn: 97 = %97)' },
  { key:'time_rule_threshold',label:'Zaman Kuralı',       unit:'sn', min:10,  max:300,   step:'5',   placeholder:'örn: 90',  hint:'Ne kadar zaman kala işleme girsin? Sayaç bu değerin altına inince giriş koşulu aktifleşir. Örn: 90 → event bitmesine 90sn kalınca pencere açılır.' },
  { key:'min_entry_seconds',  label:'Min Kalan Süre',    unit:'sn', min:0,   max:120,   step:'1',   placeholder:'örn: 20',  hint:'Event bitmesine en az bu kadar süre kalmalı. Bu süreden azsa giriş yapılmaz.' },
  { key:'min_move_delta',     label:'Min Fiyat Hareketi',unit:'$',  min:0,   max:5000,  step:'1',   placeholder:'örn: 70',  hint:'Coin fiyatında son periyotta gereken minimum $ değişimi. Düşük volatilitede giriş engellenir.' },
  { key:'max_slippage_pct',   label:'Max Spread',        unit:'%',  min:0.5, max:50,    step:'0.5', placeholder:'örn: 3',   hint:'Bid-ask spread (alış-satış farkı) üst sınırı. %50 girersen kural devre dışı kalır.' },
  // — Çıkış Stratejisi —
  { key:'target_exit_pct',    label:'Hedef Çıkış',       unit:'%',  min:1,   max:100,   step:'0.5', placeholder:'örn: 15',  hint:'Giriş fiyatına göre kâr yüzdesi. Örn: 15 → %15 kâra ulaşınca pozisyon kapanır.' },
  { key:'stop_loss_pct',      label:'Stop Loss',         unit:'%',  min:0.5, max:50,    step:'0.5', placeholder:'örn: 5',   hint:'Giriş fiyatına göre zarar yüzdesi limiti. Örn: 5 → %5 zararda pozisyon kesilir.' },
  { key:'force_sell_before_resolution_seconds', label:'Force Sell', unit:'sn', min:0, max:120, step:'1', placeholder:'örn: 15', hint:'Event bitmesine bu kadar süre kaldığında pozisyon zorla kapatılır.' },
  { key:'sell_retry_count',   label:'Satış Deneme',      unit:'↺',  min:1,   max:500,   step:'1',   placeholder:'örn: 200', hint:'Satış emri başarısız olursa kaç kez yeniden denenecek.' },
  // — Limitler —
  { key:'order_amount',       label:'İşlem Miktarı',     unit:'$',  min:1,   max:10000, step:'0.5', placeholder:'örn: 2',   hint:'Her işlemde kullanılacak USDC miktarı.' },
  { key:'event_trade_limit',  label:'Event Başına Max',  unit:'↺',  min:1,   max:10,    step:'1',   placeholder:'örn: 1',   hint:'Bu event penceresinde açılabilecek toplam pozisyon sayısı.' },
  { key:'max_open_positions', label:'Toplam Max Açık',   unit:'↺',  min:1,   max:20,    step:'1',   placeholder:'örn: 1',   hint:'Tüm eventlerde eş zamanlı açık kalabilecek maksimum pozisyon sayısı.' },
];

// Bölüm grupları — modal'da ve confirm popup'ta kullanılır
const AS_SECTIONS = [
  { label: 'Giriş Koşulları', keys: ['min_entry_price','max_entry_price','time_rule_threshold','min_entry_seconds','min_move_delta','max_slippage_pct'] },
  { label: 'Çıkış Stratejisi', keys: ['target_exit_pct','stop_loss_pct','force_sell_before_resolution_seconds','sell_retry_count'] },
  { label: 'Limitler',         keys: ['order_amount','event_trade_limit','max_open_positions'] },
];

// Kullanıcı 0-100 (%) girer → backend'e 0-1 olarak gönderilir (÷100)
// Kullanıcı 0-1 olan değeri okurken → 0-100 olarak gösterilir (×100)
const _pctFields = new Set([
  'min_entry_price','max_entry_price','target_exit_pct','stop_loss_pct',
  'max_slippage_pct'
]);

function openAssetSettings(key) {
  const a = state.assets[key];
  if (!a) return;

  // Bot çalışıyorken ayar değiştirmeyi engelle (açık pozisyon riski)
  if (state.botRunning) {
    showToast('Bot çalışırken ayar değiştirilemez. Önce botu durdurun.', 'warn');
    return;
  }

  const saved = state.assetSettings[key] || null; // null = henüz ayar yok
  const tf   = a.timeframe || key.split('_').slice(1).join('_') || '5M';
  const tfLabel = {'5M':'5 Dk','15M':'15 Dk','1H':'1 Sa','4H':'4 Sa','1D':'1 Gün'}[tf] || tf;

  // Alan satırı oluşturucu — compact yatay layout
  const fld = (f) => {
    if (!f) return '';
    let raw = saved ? saved[f.key] : undefined;
    const hasVal = raw !== undefined && raw !== null && raw !== '';
    let dispVal;
    if (hasVal && _pctFields.has(f.key)) {
      dispVal = (Number(raw) * 100).toFixed(Number(raw) % 1 === 0 ? 0 : 1);
    } else if (hasVal && f.key === 'min_move_delta' && Number(raw) < 1) {
      dispVal = ''; raw = undefined;
    } else {
      dispVal = hasVal ? raw : '';
    }
    return `<div class="as-row">
      <div class="as-row-meta">
        <span class="as-row-name">${f.label}</span>
        <span class="as-row-range">${f.min}–${f.max} ${f.unit}</span>
      </div>
      <div class="as-row-ctrl">
        <div class="as-tip-wrap"><span class="as-tip" data-tip="${f.hint.replace(/"/g,"'")}">?</span><div class="as-tip-popup">${f.hint}</div></div>
        <input class="as-input${hasVal ? ' has-value' : ''}"
               id="esf-${key}-${f.key}"
               type="number"
               step="${f.step || 'any'}"
               min="${f.min ?? ''}"
               max="${f.max ?? ''}"
               value="${dispVal}"
               placeholder="${f.placeholder}"
               oninput="onEventSettingInput('${key}')" />
        <span class="as-row-unit">${f.unit}</span>
      </div>
    </div>`;
  };

  // Seksiyonları oluştur
  const sectionsHTML = AS_SECTIONS.map(sec => `
    <div class="as-section">
      <div class="as-section-hdr">${sec.label}</div>
      <div class="as-rows">
        ${sec.keys.map(k => fld(EVENT_SETTING_FIELDS.find(f => f.key === k))).join('')}
      </div>
    </div>`).join('');

  const isNew = !saved;
  const body = `
<div class="as-modal" id="as-modal-${key}">
  <div class="as-header">
    <div class="as-icon" style="background:${a.color}22;color:${a.color};">${a.icon}</div>
    <div style="flex:1;">
      <div class="as-title">${a.name} <span style="opacity:.5;font-weight:400;">·</span> ${tfLabel}</div>
      <div class="as-sub">Strateji Ayarları</div>
    </div>
    ${isNew ? '<div class="as-badge-new">YENİ</div>' : ''}
  </div>
  ${isNew ? '<div class="as-alert-new">⚠️ Bu event için henüz ayar yok. Tüm alanları doldurun.</div>' : ''}
  ${sectionsHTML}
  <div class="as-actions">
    ${!isNew ? `<button class="as-btn-reset" onclick="clearEventSettings('${key}')">🗑 Temizle</button>` : '<div></div>'}
    <div class="as-save-area" style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;">
      <span class="as-save-msg" id="esf-msg-${key}"></span>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
        <button class="as-btn-cancel" onclick="closePageModal()">İptal</button>
        <button class="as-btn-save-only" id="esf-save-only-${key}"
                onclick="saveEventSettings('${key}', false)"
                ${isNew ? 'disabled' : ''}>
          Kaydet
        </button>
        <button class="as-btn-save" id="esf-save-${key}"
                onclick="saveEventSettings('${key}', true)"
                ${isNew ? 'disabled' : ''}>
          💸 Kaydet ve İşlem Aç
        </button>
      </div>
    </div>
  </div>
</div>`;

  const modal    = document.getElementById('page-modal');
  const overlay  = document.getElementById('page-modal-overlay');
  const title    = document.getElementById('page-modal-title');
  const modalBody= document.getElementById('page-modal-body');
  if (!modal) return;
  title.textContent = `${a.name} ${tfLabel} · Strateji Ayarları`;
  modalBody.innerHTML = body;
  modal.style.display = 'flex';
  overlay.style.display = 'block';
  onEventSettingInput(key); // kaydet butonunu başlangıçta değerlendir
}

// Kullanıcı alan doldurunca kaydet butonunu aktifleştir/pasifleştir
function onEventSettingInput(key) {
  const btn = document.getElementById(`esf-save-${key}`);
  const btnOnly = document.getElementById(`esf-save-only-${key}`);
  if (!btn) return;
  let allValid = true;
  EVENT_SETTING_FIELDS.forEach(f => {
    const el = document.getElementById(`esf-${key}-${f.key}`);
    if (!el) { allValid = false; return; }
    const v = parseFloat(el.value);
    const isEmpty = el.value.trim() === '' || isNaN(v);
    const outOfRange = !isEmpty && (
      (f.min !== undefined && v < f.min) ||
      (f.max !== undefined && v > f.max)
    );
    if (isEmpty || outOfRange) {
      el.style.borderColor = isEmpty ? '' : 'var(--accent-red)';
      allValid = false;
    } else {
      el.style.borderColor = 'var(--accent-green)';
    }
  });
  btn.disabled = !allValid;
  if (btnOnly) btnOnly.disabled = !allValid;
  if (allValid) {
    btn.textContent = '💸 Kaydet ve İşlem Aç';
    if (btnOnly) btnOnly.textContent = 'Kaydet ama İşlem Açma';
  } else {
    btn.textContent = '💸 Kaydet ve İşlem Aç (alanları kontrol edin)';
    if (btnOnly) btnOnly.textContent = 'Kaydet ama İşlem Açma (alanları kontrol edin)';
  }
}

// ─── Custom Confirm Popup ──────────────────────────────────────────────────────
function showConfirmPopup({ title, body, confirmText = 'Onayla', cancelText = 'İptal', isTrading = false, onConfirm, onCancel }) {
  const existing = document.getElementById('cf-popup-overlay');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'cf-popup-overlay';
  el.className = 'cf-overlay';
  el.innerHTML = `
    <div class="cf-popup">
      <div class="cf-title">${title}</div>
      <div class="cf-body">${body}</div>
      <div class="cf-actions">
        <button class="cf-btn-cancel">${cancelText}</button>
        <button class="cf-btn-confirm${isTrading ? ' trade' : ''}">${confirmText}</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  el.querySelector('.cf-btn-cancel').onclick = () => { el.remove(); if (onCancel) onCancel(); };
  el.querySelector('.cf-btn-confirm').onclick = () => { el.remove(); if (onConfirm) onConfirm(); };
  el.addEventListener('click', e => { if (e.target === el) { el.remove(); if (onCancel) onCancel(); } });
}

async function saveEventSettings(key, startTrading = false) {
  const msg = document.getElementById(`esf-msg-${key}`);
  const a = state.assets[key] || {};

  // Değerleri topla
  const payload = {};
  let valid = true;
  EVENT_SETTING_FIELDS.forEach(f => {
    const el = document.getElementById(`esf-${key}-${f.key}`);
    if (!el || el.value.trim() === '') { valid = false; return; }
    let v = parseFloat(el.value);
    if (isNaN(v)) { valid = false; return; }
    if (_pctFields.has(f.key)) v = v / 100;
    payload[f.key] = v;
  });

  if (!valid) {
    if (msg) { msg.textContent = '⚠️ Tüm alanlar doldurulmalı.'; msg.className = 'as-save-msg err'; }
    return;
  }

  // Custom confirm popup — gruplu özet tablo
  const tableRows = AS_SECTIONS.map(sec => {
    const rows = sec.keys.map(fkey => {
      const f = EVENT_SETTING_FIELDS.find(x => x.key === fkey);
      if (!f) return '';
      let val = payload[f.key];
      if (_pctFields.has(f.key)) val = (val * 100).toFixed(1).replace(/\.0$/, '');
      else val = (val !== undefined && val !== null) ? val : '—';
      return `<tr><td class="cf-td-label">${f.label}</td><td class="cf-td-val">${val} <span class="cf-td-unit">${f.unit}</span></td></tr>`;
    }).join('');
    return `<tr class="cf-sec-row"><td colspan="2">${sec.label}</td></tr>${rows}`;
  }).join('');

  const bodyHTML = `<table class="cf-table">${tableRows}</table>`;
  const title = startTrading
    ? `<span style="color:var(--accent-green)">💸</span> ${a.name || key} — Kaydet ve İşlem Aç`
    : `<span style="color:var(--accent-purple)">✅</span> ${a.name || key} — Kaydet`;

  showConfirmPopup({
    title,
    body: bodyHTML,
    confirmText: startTrading ? '💸 Onayla ve İşlem Aç' : '✅ Kaydet',
    cancelText: 'İptal',
    isTrading: startTrading,
    onConfirm: () => _doSaveEventSettings(key, startTrading, payload),
  });
}

async function _doSaveEventSettings(key, startTrading, payload) {
  const msg = document.getElementById(`esf-msg-${key}`);
  const btn = document.getElementById(`esf-save-${key}`);

  if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor...'; }
  if (msg) { msg.textContent = ''; msg.className = 'as-save-msg'; }

  try {
    const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Sunucu hatası');

    const returned = data.settings || {};
    const mismatches = EVENT_SETTING_FIELDS.filter(f =>
      Math.abs((returned[f.key] || 0) - (payload[f.key] || 0)) > 0.0001
    );
    if (mismatches.length > 0) throw new Error(`Kayıt doğrulanamadı (${mismatches.map(f=>f.label).join(', ')})`);

    state.assetSettings[key] = returned;

    if (startTrading) {
      if (!state.pinned.includes(key)) {
        state.pinned = [...state.pinned, key];
        wsSend({ type: 'toggle_pin', asset: key });
        fetch(`/api/assets/${key}/pin`, { method: 'POST' }).catch(() => {});
      }
    }
    // _cardNotifications temizle — buildEventCard state'den hesaplar artık
    delete state._cardNotifications[key];

    if (msg) { msg.textContent = '✓ Kaydedildi'; msg.className = 'as-save-msg ok'; }
    setTimeout(() => {
      closePageModal();
      _chipsBuilt = false;
      _lastRenderKey = '';
      renderEventsList();
    }, 800);

  } catch(e) {
    if (msg) { msg.textContent = `❌ ${e.message}`; msg.className = 'as-save-msg err'; }
    if (btn) { btn.disabled = false; btn.textContent = '💸 Kaydet ve İşlem Aç'; }
  }
}

async function clearEventSettings(key) {
  const a = state.assets[key] || {};
  const label = a.name ? `${a.name} (${key})` : key;
  showConfirmPopup({
    title: '🗑 Ayarları Temizle',
    body: `<p style="color:var(--text-secondary);font-size:13px;margin:0 0 4px;">"<b>${label}</b>" event ayarları silinecek.</p>
           <p style="color:var(--text-muted);font-size:12px;margin:0;">Bot bu event için işlem açamayacak.</p>`,
    confirmText: 'Temizle',
    cancelText: 'İptal',
    onConfirm: async () => {
      try {
        const res  = await fetch(`/api/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Silinemedi');
        delete state.assetSettings[key];
        delete state._cardNotifications[key];
        closePageModal();
        _lastRenderKey = '';
        renderEventsList();
      } catch(e) {
        showToast(`Temizlenemedi: ${e.message}`, 'error');
      }
    },
  });
}

// ─── Expanded Body ────────────────────────
function renderEventBody(sym) {
  const a = state.assets[sym];
  if (!a) return '';

  const mp    = a.market || {};
  const rules = a.rules  || {};
  const cd    = a.countdown || 0;
  const mins  = Math.floor(cd / 60);
  const secs  = String(cd % 60).padStart(2, '0');

  const barPct   = cd > 0 ? Math.max(2, ((300 - cd) / 300) * 100) : 0;
  const barColor = cd <= 20 ? 'var(--accent-red)' : cd <= 60 ? 'var(--accent-yellow)' : 'var(--accent-purple)';
  const cdColor  = cd <= 20 ? 'var(--accent-red)' : cd <= 60 ? 'var(--accent-yellow)' : 'var(--accent-purple)';
  const slipColor = (mp.slippage_pct||0) < 2 ? 'var(--accent-green)' : (mp.slippage_pct||0) < 3 ? 'var(--accent-yellow)' : 'var(--accent-red)';

  const pos = state.positions.find(p => p.asset === sym);

  const st = state.strategy;
  const refPrice = a.event?.open_reference || a.price;
  const priceDiff = a.price - refPrice;
  const currentUpAsk = mp.up_ask || 0.5;
  const posCount = state.positions.length;
  const assetPosCount = state.positions.filter(p => p.asset === sym).length;

  // Rule map with current values vs thresholds
  const ruleMap = [
    {
      key: 'time', label: 'Time Window',
      current: `${Math.floor(cd/60)}:${String(cd%60).padStart(2,'0')} kaldı`,
      threshold: `Entry: ${Math.floor((st.min_entry_seconds||10)/60)}:${String((st.min_entry_seconds||10)%60).padStart(2,'0')} – ${Math.floor((st.time_rule_threshold||90)/60)}:${String((st.time_rule_threshold||90)%60).padStart(2,'0')}`,
      detail: cd <= (st.time_rule_threshold||90) && cd > (st.min_entry_seconds||10) ? '✓ Pencerede' : cd > (st.time_rule_threshold||90) ? '⏳ Çok erken' : '⏰ Çok geç',
    },
    {
      key: 'price', label: 'Entry Price Range',
      current: `UP ask: ${currentUpAsk.toFixed(3)}`,
      threshold: `Aralık: ${(st.min_entry_price||0.75).toFixed(2)} – ${(st.max_entry_price||0.98).toFixed(2)}`,
      detail: (currentUpAsk >= (st.min_entry_price||0.75) && currentUpAsk <= (st.max_entry_price||0.98)) ? '✓ Aralıkta' : currentUpAsk < (st.min_entry_price||0.75) ? '↓ Çok düşük' : '↑ Çok yüksek',
    },
    {
      key: 'btc_move', label: 'Fiyat Hareketi',
      current: `${priceDiff >= 0 ? '+' : ''}${formatAssetPrice(sym, priceDiff)} (${(priceDiff/refPrice*100).toFixed(2)}%)`,
      threshold: `Min hareket: ${formatAssetPrice(sym, (st.min_btc_move_up||70))}`,
      detail: Math.abs(priceDiff) >= (st.min_btc_move_up||70) ? '✓ Yeterli hareket' : `⏳ Eksik: ${formatAssetPrice(sym, Math.max(0,(st.min_btc_move_up||70) - Math.abs(priceDiff)))} daha`,
    },
    {
      key: 'slippage', label: 'Slippage',
      current: `${(mp.slippage_pct||0).toFixed(2)}%`,
      threshold: `Max: ${((st.max_slippage_pct||0.03)*100).toFixed(0)}%`,
      detail: (mp.slippage_pct||0) < (st.max_slippage_pct||0.03)*100 ? '✓ Kabul edilebilir' : '✗ Limit aşıldı',
    },
    {
      key: 'event_limit', label: 'Event Trade Limit',
      current: `${assetPosCount} trade bu event`,
      threshold: `Max: ${st.event_trade_limit||1} trade/event`,
      detail: assetPosCount < (st.event_trade_limit||1) ? '✓ Limit altında' : '✗ Limit doldu',
    },
    {
      key: 'max_positions', label: 'Max Açık Pozisyon',
      current: `${posCount} açık pozisyon`,
      threshold: `Max: ${st.max_open_positions||1}`,
      detail: posCount < (st.max_open_positions||1) ? '✓ Kapasite var' : '✗ Dolu',
    },
  ];
  const allPass = ruleMap.every(r => rules[r.key] === 'pass');
  const anyFail = ruleMap.some(r  => rules[r.key] === 'fail');
  const pipStatus = !state.botRunning   ? '⏸ Bot durduruldu'
                  : allPass             ? '🚀 READY TO TRADE'
                  : anyFail             ? '⛔ Koşullar sağlanmadı'
                  :                       '🔍 Tarama devam ediyor...';
  const pipCls = !state.botRunning ? 'text-muted'
               : allPass           ? 'text-green'
               : anyFail           ? 'text-red'
               :                     'text-yellow';

  // Check if pinned for untracked notice
  const isPinned = state.pinned.includes(sym) || state.pinned.includes(key);

  // Position panel or waiting info (no manual order buttons)
  let rightCol;
  if (pos) {
    rightCol = `
    <span class="eac-section-lbl" style="color:var(--accent-green);">Açık Pozisyon</span>
    <div class="eac-pos-card">
      <div class="eac-pos-row">
        <span class="text-xs text-muted">Side</span>
        <span class="font-bold ${pos.side==='UP'?'text-green':'text-red'}">${pos.side==='UP'?'↑ UP':'↓ DOWN'}</span>
      </div>
      <div class="eac-pos-row">
        <span class="text-xs text-muted">Entry → Now</span>
        <span class="text-mono">${(pos.entry_price||0).toFixed(3)} → ${(pos.current_price||0).toFixed(3)}</span>
      </div>
      <div class="eac-pos-row">
        <span class="text-xs text-muted">Target / SL</span>
        <span>
          <span class="text-mono text-green">${(pos.target_price||0).toFixed(3)}</span>
          <span class="text-muted"> / </span>
          <span class="text-mono text-red">${(pos.stop_loss||0).toFixed(3)}</span>
        </span>
      </div>
      <div class="eac-pos-row">
        <span class="text-xs text-muted">P&amp;L</span>
        <span class="font-bold text-mono ${(pos.pnl||0)>=0?'text-green':'text-red'}">${formatUSD(pos.pnl)}</span>
      </div>
      <div style="height:3px;background:var(--bg-primary);border-radius:2px;overflow:hidden;margin:8px 0;">
        <div style="height:100%;background:${(pos.pnl||0)>=0?'var(--accent-green)':'var(--accent-red)'};
          width:${Math.min(100,Math.max(0,(pos.current_price-pos.stop_loss)/(pos.target_price-pos.stop_loss)*100))}%;
          transition:width 0.5s;"></div>
      </div>
      <button class="btn btn-sm btn-danger w-full" onclick="event.stopPropagation(); closePosition('${pos.id}')">
        Pozisyon Kapat
      </button>
    </div>`;
  } else if (!isPinned) {
    rightCol = `
    <div class="eac-untracked-notice">
      <div>⚠️ Bu market takip listesine eklenmemiş.</div>
      <div style="font-size:11px;margin-top:4px;color:var(--text-muted);">Takibe almak için 📌 butonunu kullanın.</div>
    </div>`;
  } else {
    rightCol = `
    <span class="eac-section-lbl">Bot Durumu</span>
    <div style="font-size:11px;color:var(--text-muted);line-height:1.5;">
      ${state.botRunning
        ? (allPass
            ? '<span class="text-green font-bold">🚀 Tüm kurallar sağlandı — giriş bekleniyor</span>'
            : '<span class="text-yellow">🔍 Bot kuralları taramaya devam ediyor...</span>')
        : '<span class="text-muted">⏸ Bot durduruldu</span>'}
    </div>
    <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">
      Manuel order şu an devre dışı — otomatik mod aktif.
    </div>`;
  }

  return `
  <div class="eac-cd-bar-wrap">
    <div class="eac-cd-bar-fill" style="width:${barPct}%;background:${barColor};"></div>
  </div>
  <div class="eac-body-grid">

    <!-- Col 1: Countdown & Event Info -->
    <div class="eac-body-col">
      <span class="eac-section-lbl">Geri Sayım</span>
      <div class="eac-big-cd" style="color:${cdColor};">${mins}:${secs}</div>
      <div class="text-xs text-muted" style="margin-top:5px;">${a.event ? a.event.subtitle : ''}</div>
      ${a.event ? `
      <div class="eac-meta-row">
        <span class="event-stat">Liq: <strong>$${(a.event.liquidity||0).toLocaleString()}</strong></span>
        <span class="event-stat">Vol: <strong>$${(a.event.volume||0).toLocaleString()}</strong></span>
      </div>
      <div class="text-xs text-muted" style="margin-top:4px;">
        Ref: <span class="text-mono">${formatAssetPrice(sym, a.event.open_reference)}</span>
      </div>` : ''}
    </div>

    <!-- Col 2: Market Prices -->
    <div class="eac-body-col">
      <span class="eac-section-lbl">Market Prices
        <span style="float:right;font-weight:700;color:${slipColor};">Slip ${(mp.slippage_pct||0).toFixed(2)}%</span>
      </span>
      <div class="outcome-row up" style="margin-bottom:8px;">
        <div class="outcome-indicator"></div>
        <div style="flex:1;">
          <div class="outcome-label">UP ↑</div>
          <div class="text-xs text-muted">bid ${(mp.up_bid||0).toFixed(3)}</div>
        </div>
        <div class="outcome-price up">${(mp.up_ask||0).toFixed(3)}</div>
      </div>
      <div class="outcome-row down">
        <div class="outcome-indicator"></div>
        <div style="flex:1;">
          <div class="outcome-label">DOWN ↓</div>
          <div class="text-xs text-muted">bid ${(mp.down_bid||0).toFixed(3)}</div>
        </div>
        <div class="outcome-price down">${(mp.down_ask||0).toFixed(3)}</div>
      </div>
    </div>

    <!-- Col 3: Order / Position -->
    <div class="eac-body-col">
      ${rightCol}
    </div>
  </div>

  <!-- Pipeline (full width, with current values) -->
  <div class="eac-pipeline-row">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span class="eac-section-lbl" style="margin-bottom:0;">⚙️ Strateji Kuralları — Mevcut Değerler</span>
      <span class="text-sm ${pipCls}" style="font-weight:600;">${pipStatus}</span>
    </div>
    <div class="rule-detail-grid">
      ${ruleMap.map(r => {
        const s = rules[r.key] || 'waiting';
        const ico = s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏳';
        const borderColor = s === 'pass' ? 'var(--accent-green-dim)' : s === 'fail' ? 'var(--accent-red-dim)' : 'var(--bg-card-hover)';
        const labelColor  = s === 'pass' ? 'var(--accent-green)' : s === 'fail' ? 'var(--accent-red)' : 'var(--text-muted)';
        return `<div class="rule-detail-card" style="background:${borderColor};border:1px solid ${s==='pass'?'var(--accent-green)':s==='fail'?'var(--accent-red)':'var(--border-primary)'};">
          <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;">
            <span>${ico}</span>
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:${labelColor};">${r.label}</span>
          </div>
          <div style="font-size:12px;font-weight:700;font-family:var(--font-mono);color:var(--text-primary);">${r.current}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${r.threshold}</div>
          <div style="font-size:10px;color:${labelColor};margin-top:2px;font-weight:600;">${r.detail}</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ─── Expand/Collapse ──────────────────────
function expandEvent(sym) {
  if (state.expandedAsset === sym) {
    state.expandedAsset = null;
  } else {
    state.expandedAsset = sym;
    state.selectedAsset = sym;
    wsSend({ type: 'select_asset', asset: sym });
  }
  renderEventsList();
}

// ─── Chip Filter ──────────────────────────
function filterEvents(sym, btn) {
  state.chipFilter = sym;
  document.querySelectorAll('.asset-chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderEventsList();
}

// ═══════════════════════════════════════════
// POSITIONS PAGE
// ═══════════════════════════════════════════
function updatePositionsPage() {
  const tbody = document.getElementById('positions-tbody');
  if (!tbody) return;
  if (!state.positions.length) {
    const emptyMsg = state.currentPage === 'positions' ? 'Açık pozisyon yok' : 'Pozisyon bulunamadı';
    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding:24px;">${emptyMsg}</td></tr>`;
    return;
  }
  tbody.innerHTML = state.positions.map(pos => {
    const pnl   = pos.pnl || 0;
    const pnlCl = pnl >= 0 ? 'text-green' : 'text-red';
    return `<tr>
      <td><span style="font-weight:700;">${pos.asset || '--'}</span></td>
      <td class="text-xs text-muted">${pos.event_slug || '--'}</td>
      <td><span class="font-bold ${pos.side==='UP'?'text-green':'text-red'}">${pos.side==='UP'?'↑ UP':'↓ DOWN'}</span></td>
      <td class="text-mono">${(pos.entry_price||0).toFixed(3)}</td>
      <td class="text-mono">${(pos.current_price||0).toFixed(3)}</td>
      <td class="text-mono text-green">${(pos.target_price||0).toFixed(3)}</td>
      <td class="text-mono text-red">${(pos.stop_loss||0).toFixed(3)}</td>
      <td class="text-mono font-bold ${pnlCl}">${formatUSD(pnl)}</td>
      <td><span class="pipeline-step pass" style="padding:2px 8px;font-size:11px;">AÇIK</span></td>
      <td><button class="btn btn-sm btn-danger" onclick="closePosition('${pos.id}')">Kapat</button></td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════
// HISTORY PAGE
// ═══════════════════════════════════════════
function updateHistoryPage() {
  const tbody = document.getElementById('history-tbody');
  if (!tbody) return;

  let trades = state.tradeHistory;
  if (_historyFilter === 'wins')   trades = trades.filter(t => (t.pnl||0) > 0);
  if (_historyFilter === 'losses') trades = trades.filter(t => (t.pnl||0) < 0);

  const all    = state.tradeHistory;
  const wins   = all.filter(t => (t.pnl||0) > 0).length;
  const losses = all.filter(t => (t.pnl||0) < 0).length;
  const total  = all.reduce((s, t) => s + (t.pnl||0), 0);

  const summaryEl = document.getElementById('history-summary');
  if (summaryEl) summaryEl.innerHTML = `
    <span class="text-muted">Toplam: <strong class="text-primary">${all.length}</strong></span>
    <span class="text-green">Kazanan: <strong>${wins}</strong></span>
    <span class="text-red">Kaybeden: <strong>${losses}</strong></span>
    <span class="${total>=0?'text-green':'text-red'}">P&L: <strong class="text-mono">${formatUSD(total)}</strong></span>
  `;

  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:24px;">Trade geçmişi yok</td></tr>';
    return;
  }

  tbody.innerHTML = trades.map(t => {
    const pnl   = t.pnl || 0;
    const pnlCl = pnl >= 0 ? 'text-green' : 'text-red';
    const stCl  = t.status === 'TARGET_HIT' ? 'pass' : t.status === 'STOP_LOSS' ? 'fail' : 'waiting';
    return `<tr>
      <td class="text-mono text-xs">${t.date||'--'}</td>
      <td><span style="font-weight:700;color:var(--text-primary);">${t.asset||'--'}</span></td>
      <td><span class="font-bold ${t.side==='UP'?'text-green':'text-red'}">${t.side==='UP'?'↑ UP':'↓ DOWN'}</span></td>
      <td class="text-mono">${(t.entry_price||0).toFixed(3)}</td>
      <td class="text-mono">${(t.exit_price||0).toFixed(3)}</td>
      <td class="text-mono font-bold ${pnlCl}">${formatUSD(pnl)}</td>
      <td><span class="pipeline-step ${stCl}" style="padding:2px 8px;font-size:11px;">${t.status||'--'}</span></td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════
// LOGS PAGE
// ═══════════════════════════════════════════
function renderLogPage() {
  const c = document.getElementById('log-container');
  if (!c) return;
  const colors = { info:'var(--accent-blue)', warn:'var(--accent-yellow)',
                   error:'var(--accent-red)',  success:'var(--accent-green)' };
  c.innerHTML = state.logs.slice(0, 150).map(l => `
    <div style="padding:3px 0;border-bottom:1px solid var(--border-primary);">
      <span style="color:var(--text-muted)">${l.time}</span>
      <span style="color:${colors[l.level]||'#aaa'};font-weight:600;margin:0 6px;">[${(l.level||'info').toUpperCase()}]</span>
      <span>${l.message}</span>
    </div>`).join('');
}

// ═══════════════════════════════════════════
// NOTIFICATION SYSTEM
// ═══════════════════════════════════════════
function toggleNotifDropdown() {
  state.notifOpen = !state.notifOpen;
  const dd   = document.getElementById('notif-dropdown');
  const bell = document.getElementById('notif-bell');
  if (dd)   dd.style.display = state.notifOpen ? 'block' : 'none';
  if (bell) bell.classList.toggle('active', state.notifOpen);
  if (state.notifOpen) renderNotifications();
}

function renderNotifications() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!state.notifications.length) {
    list.innerHTML = '<div class="notif-empty">Bildirim yok</div>';
    return;
  }
  list.innerHTML = state.notifications.slice(0, 25).map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'} nlvl-${n.level}">
      <div class="notif-msg">${n.message}</div>
      <div class="notif-time">${n.time}</div>
    </div>`).join('');
}

function markAllRead() {
  state.notifications.forEach(n => n.read = true);
  updateNotifBadge();
  renderNotifications();
}

function updateNotifBadge() {
  const unread = state.notifications.filter(n => !n.read).length;
  const badge  = document.getElementById('notif-badge');
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.style.display = unread > 0 ? '' : 'none';
  }
}

function pushNotification(level, message) {
  const time = new Date().toLocaleTimeString();
  state.notifications.unshift({ level, message, time, read: false });
  if (state.notifications.length > 50) state.notifications.pop();
  updateNotifBadge();
  if (state.notifOpen) renderNotifications();
}

// ═══════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════
let _botToggling = false;
async function toggleBot() {
  if (_botToggling) return;
  _botToggling = true;
  try {
    if (state.botRunning) {
      await fetch('/api/bot/stop', { method: 'POST' }).catch(() => {});
      return;
    }
    try {
      const cfg = await fetch('/api/wallet').then(r => r.json());
      if (!cfg.configured) { showBotBlockedModal(cfg); return; }
    } catch(e) {
      showToast('Cuzdan durumu kontrol edilemedi.', 'warn');
    }
    await fetch('/api/bot/start', { method: 'POST' }).catch(() => {});
  } finally {
    _botToggling = false;
  }
}

function pauseBot() {
  // Pause = stop scanning but keep positions open
  if (!state.botRunning) return;
  showToast('Bot duraklatildi — mevcut pozisyonlar korunuyor.', 'warn');
  // TODO: implement /api/bot/pause when backend supports it
  fetch('/api/bot/stop', { method: 'POST' }).catch(() => {});
}

function stopBot() {
  if (!state.botRunning) return;
  fetch('/api/bot/stop', { method: 'POST' }).catch(() => {});
}

function showBotBlockedModal(cfg) {
  const missing = [];
  if (!cfg.has_private_key) missing.push('Private Key (POLYMARKET_PRIVATE_KEY)');
  if (!cfg.has_api_key)     missing.push('API Key (POLYMARKET_API_KEY)');

  const modal    = document.getElementById('page-modal');
  const overlay  = document.getElementById('page-modal-overlay');
  const title    = document.getElementById('page-modal-title');
  const modalBody = document.getElementById('page-modal-body');
  if (!modal) return;

  title.textContent = '⚠️ Bot Başlatılamıyor';
  modalBody.innerHTML = `
<div style="display:flex;flex-direction:column;gap:18px;">
  <div style="padding:16px;background:var(--accent-yellow-dim);border:1px solid var(--accent-yellow);border-radius:var(--radius-md);">
    <div style="font-size:14px;font-weight:700;color:var(--accent-yellow);margin-bottom:8px;">
      🔑 Cüzdan ve API bilgileriniz eksik
    </div>
    <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">
      Botu başlatmak için aşağıdaki bilgilerin girilmiş olması gerekiyor:
    </div>
    <ul style="margin:8px 0 0 16px;font-size:12px;color:var(--accent-yellow);line-height:1.8;">
      ${missing.map(m => `<li>${m}</li>`).join('')}
    </ul>
  </div>
  <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">
    Gerçek işlem yapabilmek için Polymarket hesabınıza ait özel anahtarınızı ve API anahtarınızı ayarlar bölümüne girmelisiniz.
  </div>
  <div style="display:flex;gap:10px;justify-content:flex-end;">
    <button onclick="closePageModal()" style="padding:8px 16px;background:var(--bg-card);border:1px solid var(--border-primary);color:var(--text-muted);border-radius:var(--radius-sm);cursor:pointer;font-size:13px;">
      Vazgeç
    </button>
    <button onclick="closePageModal();switchPage('wallet')" style="padding:8px 20px;background:var(--accent-purple);border:none;color:white;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:700;">
      ⚙️ Ayarlara Git
    </button>
  </div>
</div>`;
  modal.style.display   = 'flex';
  overlay.style.display = 'block';
}

function selectAsset(sym) {
  state.selectedAsset = sym;
  wsSend({ type: 'select_asset', asset: sym });
}

function togglePin(key) {
  const pinned = new Set(state.pinned);
  const isCurrentlyPinned = pinned.has(key);

  if (!isCurrentlyPinned) {
    // $ butonuna basarak İşlem Açılacaklar'a ekleme — ayar kontrolü
    const a = state.assets[key];
    const hasSettings = !!(state.assetSettings[key]);
    const settingsConfigured = a?.settings_configured !== false;
    if (!hasSettings && !settingsConfigured) {
      showToast('Bu event için henüz ayar yapılmamış!', 'warn');
      // Kullanıcıyı bilgilendirip ayar modalını aç
      const go = confirm(
        `⚠️ "${a?.name || key}" için ayar yapılmamış.\n\n` +
        `Bot bu event'te işlem açamaz.\n\n` +
        `Şimdi ayarları yapmak ister misiniz?\n` +
        `(Ayar sayfasında "💸 Kaydet ve İşlem Aç" seçeneğini kullanın)`
      );
      if (go) openAssetSettings(key);
      return;
    }
    pinned.add(key);
  } else {
    pinned.delete(key);
    // İşlem Açılacaklar'dan çıkarılınca bildirim temizle
    if (state._cardNotifications) delete state._cardNotifications[key];
  }

  state.pinned = [...pinned];
  wsSend({ type: 'toggle_pin', asset: key });
  fetch(`/api/assets/${key}/pin`, { method: 'POST' }).catch(() => {});
  addLog('info', `${key} ${pinned.has(key) ? 'işlem açılacaklara eklendi' : 'işlem açılacaklardan çıkarıldı'}`);
  _chipsBuilt = false;
  _lastRenderKey = '';
  renderEventsList();
}

function pinAndOpenSettings(key) {
  // Untracked event "Ayarlar" butonu: sadece ayar modalını aç, pin yapmadan.
  // Pinleme saveEventSettings içinde "Kaydet ve İşlem Aç" seçilince yapılır.
  openAssetSettings(key);
}

async function closePosition(posId) {
  await fetch(`/api/positions/${posId}/close`, { method: 'POST' }).catch(() => {});
  addLog('warn', `Position ${posId} kapatıldı`);
}

function placeOrder(sym, side) {
  const amount = state.orderAmount || 2;
  addLog('info', `Manuel order: ${sym} ${side} $${amount}`);
  showToast(`${sym} ${side} $${amount} — emir gönderildi`, 'info');
}

async function saveStrategy() {
  const s = {
    time_rule_threshold: numVal('cfg-time-threshold'),
    min_entry_seconds:   numVal('cfg-min-entry-sec'),
    min_entry_price:     numVal('cfg-min-entry'),
    max_entry_price:     numVal('cfg-max-entry'),
    min_btc_move_up:     numVal('cfg-btc-move'),
    min_btc_move_down:   numVal('cfg-btc-move'),
    max_slippage_pct:    numVal('cfg-slippage') / 100,
    target_exit_price:   numVal('cfg-target'),
    stop_loss_price:     numVal('cfg-stoploss'),
    force_sell_before_resolution_seconds: numVal('cfg-force-sell-sec'),
    sell_retry_count:    numVal('cfg-sell-retry'),
    force_sell_enabled:  checkVal('cfg-force-sell'),
    stop_loss_enabled:   checkVal('cfg-stop-loss-enabled'),
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Strateji kaydedildi', 'success');
  } catch(e) {
    showToast(`Kayıt başarısız: ${e.message}`, 'error');
  }
}

async function saveTrade() {
  // Oto claim kontrolu: relayer ayari yoksa aktif edilemez
  const autoClaim = checkVal('cfg-auto-claim');
  if (autoClaim) {
    try {
      const w = await fetch('/api/wallet').then(r => r.json());
      if (!w.relayer_api_key || !w.relayer_address) {
        showToast('Otomatik Tahsilat icin once Cuzdan > Relayer ayarlarini doldurun', 'error');
        const el = document.getElementById('cfg-auto-claim');
        if (el) el.checked = false;
        return;
      }
    } catch(e) {}
  }
  const s = {
    order_amount:        numVal('cfg-amount'),
    buy_order_type:      document.getElementById('cfg-buy-type')?.value || 'MARKET',
    sell_order_type:     document.getElementById('cfg-sell-type')?.value || 'MARKET',
    event_trade_limit:   numVal('cfg-event-limit'),
    max_open_positions:  numVal('cfg-max-pos'),
    max_total_trades:    numVal('cfg-max-daily'),
    auto_claim:          autoClaim,
    one_trade_per_event: checkVal('cfg-one-per-event'),
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Trade ayarlari kaydedildi', 'success');
  } catch(e) {
    showToast(`Kayıt başarısız: ${e.message}`, 'error');
  }
}

async function saveSettings() {
  const s = {
    btc_price_source:      document.getElementById('cfg-btc-source')?.value || 'BINANCE',
    auto_start:            checkVal('cfg-auto-start'),
    notifications_enabled: checkVal('cfg-notifications'),
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Settings kaydedildi ✓', 'success');
  } catch(e) {
    showToast(`Kayıt başarısız: ${e.message}`, 'error');
  }
}

function saveWallet() {
  const pk           = document.getElementById('cfg-pk')?.value?.trim() || '';
  const apiKey       = document.getElementById('cfg-apikey')?.value?.trim() || '';
  const secret       = document.getElementById('cfg-secret')?.value?.trim() || '';
  const passphrase   = document.getElementById('cfg-passphrase')?.value?.trim() || '';
  const funder       = document.getElementById('cfg-funder')?.value?.trim() || '';
  const relayerKey   = document.getElementById('cfg-relayer-key')?.value?.trim() || '';
  const relayerAddr  = document.getElementById('cfg-relayer-addr')?.value?.trim() || '';

  if (!pk || !apiKey || !secret || !passphrase) {
    showToast('Lütfen zorunlu tüm alanları doldurun (Private Key, API Key, Secret, Passphrase)', 'warn');
    return;
  }

  // Character count validation
  const warnings = [];
  if (pk.length < 60 || pk.length > 70) {
    warnings.push(`• Private Key: ${pk.length} karakter (beklenen ~64)`);
  }
  if (apiKey.length < 30 || apiKey.length > 50) {
    warnings.push(`• API Key: ${apiKey.length} karakter (beklenen ~36 UUID)`);
  }
  if (secret.length < 30 || secret.length > 60) {
    warnings.push(`• Secret: ${secret.length} karakter (beklenen ~44 Base64)`);
  }
  if (passphrase.length > 0 && passphrase.length < 8) {
    warnings.push(`• Passphrase: ${passphrase.length} karakter (çok kısa, min 8)`);
  }
  if (funder.length > 0 && !funder.startsWith('0x')) {
    warnings.push(`• Funder Adresi: "0x" ile başlamalı`);
  }

  if (warnings.length > 0) {
    const proceed = confirm(`⚠️ Bazı alanlar beklenenden farklı görünüyor:\n\n${warnings.join('\n')}\n\nDevam etmek için Tamam, düzeltmek için İptal.`);
    if (!proceed) return;
  }

  fetch('/api/wallet/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      private_key: pk,
      api_key: apiKey,
      secret: secret,
      passphrase: passphrase,
      funder: funder,
      relayer_api_key: relayerKey,
      relayer_address: relayerAddr,
    }),
  }).then(r => r.json()).then(d => {
    const el = document.getElementById('wallet-status');
    const dot = document.getElementById('wallet-status-dot');
    if (d.ok || d.success || d.configured) {
      if (el)  { el.textContent = '✅ API anahtarları kaydedildi — bot başlatılabilir'; el.style.color = 'var(--accent-green)'; }
      if (dot) { dot.style.background = 'var(--accent-green)'; dot.style.boxShadow = '0 0 5px rgba(0,210,106,0.5)'; }
      state._walletConfigured = true;
      updateSidebar();
      showToast('Cüzdan bilgileri kaydedildi', 'success');
    } else {
      showToast(d.message || 'Kayıt başarısız', 'error');
    }
  }).catch(() => {
    // Backend endpoint not implemented yet — store locally and show success
    showToast('Kaydedildi (backend endpoint güncellenmeli)', 'warn');
  });
}

function testWalletConnection() {
  showToast('Bağlantı testi yakında eklenecek...', 'info');
}

function toggleKeyVisibility(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const PAGE_TITLES = {
  watchlist: 'Marketler',
  positions: 'Pozisyonlar',
  history:   'İşlem Geçmişi',
  strategy:  'Strateji Kuralları',
  trade:     'Trade Motoru',
  settings:  'Genel Ayarlar',
  wallet:    'Cüzdan',
  logs:      'Kayıtlar',
};

function switchPage(page) {
  // Watchlist is always the background page - never open as modal
  if (page === 'watchlist') {
    closePageModal();
    state.currentPage = 'watchlist';
    updateUI();
    return;
  }

  // Toggle: clicking same active page closes the modal
  if (state.currentPage === page) {
    closePageModal();
    return;
  }

  openPageModal(page);
}

function openPageModal(page) {
  state.currentPage = page;

  // Update sidebar active states
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.nav-subitem, .nav-subsubitem').forEach(n => n.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  document.querySelectorAll(`.nav-subitem[data-page="${page}"], .nav-subsubitem[data-page="${page}"]`)
    .forEach(n => n.classList.add('active'));

  // Auto-open parent submenu for settings pages, close for others
  const subPageParents = { settings:'settings', strategy:'settings', trade:'settings', wallet:'settings' };
  const isSettingsPage = !!subPageParents[page];
  // Close all submenus first
  document.querySelectorAll('.nav-submenu, .nav-sub-submenu').forEach(s => {
    if (!isSettingsPage || !s.id.includes('settings')) {
      s.classList.remove('open');
    }
  });
  document.querySelectorAll('.has-submenu').forEach(p => {
    if (!isSettingsPage || !p.id.includes('settings')) {
      p.classList.remove('submenu-open');
    }
  });
  if (isSettingsPage) {
    const sub = document.getElementById(`submenu-${subPageParents[page]}`);
    const par = document.getElementById(`nav-${subPageParents[page]}-parent`);
    if (sub) sub.classList.add('open');
    if (par) par.classList.add('submenu-open');
  }

  // Inject template content into modal body
  const tpl = document.getElementById(`tpl-${page}`);
  const modalBody = document.getElementById('page-modal-body');
  if (tpl && modalBody) {
    modalBody.innerHTML = tpl.innerHTML;
  }

  // Set modal title
  setText('page-modal-title', PAGE_TITLES[page] || page);

  // Show modal
  document.getElementById('page-modal-overlay').style.display = 'block';
  document.getElementById('page-modal').style.display = 'flex';
  document.body.classList.add('modal-open');

  // Special: trigger page-specific updates
  if (page === 'positions') updatePositionsPage();
  if (page === 'history')   updateHistoryPage();
  if (page === 'logs')      renderLogPage();

  // Settings: reload form values
  if (page === 'settings' || page === 'strategy' || page === 'trade' || page === 'wallet') {
    fetch('/api/settings').then(r => r.json()).then(s => {
      const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
      const chk = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.checked = v; };
      // Strateji
      set('cfg-time-threshold', s.time_rule_threshold);
      set('cfg-min-entry-sec',  s.min_entry_seconds);
      set('cfg-min-entry',      s.min_entry_price);
      set('cfg-max-entry',      s.max_entry_price);
      set('cfg-btc-move',       s.min_btc_move_up);
      set('cfg-slippage',       s.max_slippage_pct !== undefined ? (s.max_slippage_pct*100).toFixed(1) : 3);
      set('cfg-target',         s.target_exit_price);
      set('cfg-stoploss',       s.stop_loss_price);
      set('cfg-force-sell-sec', s.force_sell_before_resolution_seconds);
      set('cfg-sell-retry',     s.sell_retry_count);
      chk('cfg-force-sell',     s.force_sell_enabled);
      chk('cfg-stop-loss-enabled', s.stop_loss_enabled !== undefined ? s.stop_loss_enabled : true);
      // Trade motoru
      set('cfg-amount',         s.order_amount);
      set('cfg-buy-type',       s.buy_order_type);
      set('cfg-sell-type',      s.sell_order_type);
      set('cfg-event-limit',    s.event_trade_limit);
      set('cfg-max-pos',        s.max_open_positions);
      set('cfg-max-daily',      s.max_total_trades);
      chk('cfg-auto-claim',     s.auto_claim);
      chk('cfg-one-per-event',  s.one_trade_per_event !== undefined ? s.one_trade_per_event : true);
      // Genel
      chk('cfg-auto-start',    s.auto_start);
      chk('cfg-notifications', s.notifications_enabled !== undefined ? s.notifications_enabled : true);
    }).catch(() => {});
  }

  // Wallet: pre-populate form from .env (masked for security)
  if (page === 'wallet') {
    fetch('/api/wallet').then(r => r.json()).then(cfg => {
      const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
      set('cfg-pk',           cfg.private_key);
      set('cfg-apikey',       cfg.api_key);
      set('cfg-secret',       cfg.secret);
      set('cfg-passphrase',   cfg.passphrase);
      set('cfg-funder',       cfg.funder);
      set('cfg-relayer-key',  cfg.relayer_api_key);
      set('cfg-relayer-addr', cfg.relayer_address);
      const dot = document.getElementById('wallet-status-dot');
      const lbl = document.getElementById('wallet-status');
      if (cfg.configured) {
        if (dot) { dot.style.background = 'var(--accent-green)'; dot.style.boxShadow = '0 0 5px rgba(0,210,106,0.5)'; }
        if (lbl) { lbl.textContent = '✅ API anahtarları mevcut — private key/funder DISABLED (güvenli)'; lbl.style.color = 'var(--accent-green)'; }
      }
    }).catch(() => {});
  }
}

function closePageModal() {
  document.getElementById('page-modal-overlay').style.display = 'none';
  document.getElementById('page-modal').style.display = 'none';
  document.body.classList.remove('modal-open');
  state.currentPage = 'watchlist';
  // Update sidebar: set watchlist active
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.nav-subitem, .nav-subsubitem').forEach(n => n.classList.remove('active'));
  const navEl = document.querySelector('.nav-item[data-page="watchlist"]');
  if (navEl) navEl.classList.add('active');
}

function filterWL(f, btn) { updateTabUI(btn); }
function filterPositions(f, btn) { updateTabUI(btn); updatePositionsPage(); }
function filterHistory(f, btn) { _historyFilter = f; updateTabUI(btn); updateHistoryPage(); }
function updateTabUI(btn) {
  if (!btn) return;
  btn.closest('.tabs')?.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
}

// ═══════════════════════════════════════════
// LOGGING & TOAST
// ═══════════════════════════════════════════
function addLog(level, message) {
  const time = new Date().toLocaleTimeString();
  state.logs.unshift({ time, level, message });
  if (state.logs.length > 300) state.logs.pop();
  if (state.currentPage === 'logs') renderLogPage();

  // Important events → notification bell
  if (level === 'success' || level === 'error' || level === 'warn') {
    pushNotification(level, message);
  }
}

function clearLogs() {
  state.logs = [];
  const c = document.getElementById('log-container');
  if (c) c.innerHTML = '<div class="text-muted">Logs temizlendi</div>';
}

function showRateLimitPopup(retryAfterSecs) {
  let existing = document.getElementById('rate-limit-overlay');
  if (existing) return;
  const secs = retryAfterSecs || 60;
  const overlay = document.createElement('div');
  overlay.id = 'rate-limit-overlay';
  overlay.className = 'rate-limit-overlay';
  overlay.innerHTML = `
    <div class="rate-limit-popup">
      <h2>⛔ API Hız Limiti Aşıldı</h2>
      <p>Polymarket API'den 429 Too Many Requests hatası alındı.<br>
         Bot geçici olarak duraklatıldı.</p>
      <div style="font-family:var(--font-mono);font-size:20px;font-weight:700;color:var(--accent-yellow);margin:12px 0;" id="rl-countdown">${secs}s</div>
      <p style="font-size:12px;opacity:0.7;">Otomatik olarak ${secs} saniye sonra yeniden denenecek.</p>
      <button onclick="document.getElementById('rate-limit-overlay').remove()">Tamam, Anladım</button>
    </div>`;
  document.body.appendChild(overlay);
  addLog('error', `Rate limit: 429 alındı — ${secs}s bekleniyor`);
  let remaining = secs;
  const timer = setInterval(() => {
    remaining--;
    const cd = document.getElementById('rl-countdown');
    if (cd) cd.textContent = `${remaining}s`;
    if (remaining <= 0) {
      clearInterval(timer);
      const el = document.getElementById('rate-limit-overlay');
      if (el) el.remove();
    }
  }, 1000);
}

function showToast(message, type = 'info') {
  const colors = { info:'var(--accent-blue)', success:'var(--accent-green)',
                   warn:'var(--accent-yellow)', error:'var(--accent-red)' };
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;
    background:var(--bg-card);border:1px solid ${colors[type]||colors.info};
    color:var(--text-primary);padding:12px 18px;border-radius:var(--radius-md);
    font-size:13px;box-shadow:var(--shadow-popup);animation:fade-in 0.2s ease;max-width:320px;`;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ═══════════════════════════════════════════
// UPTIME
// ═══════════════════════════════════════════
function startUptimeCounter() {
  const start = Date.now();
  uptimeInterval = setInterval(() => {
    const s   = Math.floor((Date.now() - start) / 1000);
    const h   = String(Math.floor(s / 3600)).padStart(2,'0');
    const m   = String(Math.floor((s % 3600) / 60)).padStart(2,'0');
    const sec = String(s % 60).padStart(2,'0');
    setText('set-uptime', `${h}:${m}:${sec}`);
  }, 1000);
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function numVal(id)   { return parseFloat(document.getElementById(id)?.value || '0'); }
function checkVal(id) { return document.getElementById(id)?.checked || false; }
function formatUSD(val) {
  let n = Number(val) || 0;
  if (!isFinite(n)) n = 0;
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
function formatAssetPrice(sym, price) {
  let p = Number(price) || 0;
  if (!isFinite(p)) p = 0;
  if (p >= 1000) return `$${p.toLocaleString('en', {maximumFractionDigits:2})}`;
  if (p >= 1)    return `$${p.toFixed(3)}`;
  return `$${p.toFixed(5)}`;
}

async function toggleBrowserNotifPermission(checkbox) {
  if (!('Notification' in window)) {
    showToast('Bu tarayıcı bildirimleri desteklemiyor', 'error');
    if (checkbox) checkbox.checked = false;
    return;
  }
  if (checkbox && checkbox.checked) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Tarayıcı bildirimi izni reddedildi', 'warn');
      checkbox.checked = false;
    } else {
      showToast('Tarayıcı bildirimleri aktif ✓', 'success');
    }
  }
}

function sendBrowserNotif(title, body, type) {
  if (Notification.permission !== 'granted') return;
  const enabled = document.getElementById('cfg-browser-notif')?.checked;
  if (!enabled) return;
  const typeChecks = {
    'trade-open':  'cfg-bn-trade-open',
    'trade-close': 'cfg-bn-trade-close',
    'rules-pass':  'cfg-bn-rules-pass',
    'errors':      'cfg-bn-errors',
  };
  const checkId = typeChecks[type];
  if (checkId && document.getElementById(checkId)?.checked === false) return;
  try { new Notification(title, { body, silent: false }); } catch(e) {}
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  loadAllEventSettings(); // tüm event ayarlarını backend'den yükle
  startUptimeCounter();
  addLog('info', 'POLYFLOW v1.3.0 — Modal pages + Timeframe filter + All Markets view');
  // Set initial timeframe
  setTimeframe('5M');
  updateSortBtns(); // init sort button labels with direction arrows

  // Check wallet/API configuration on startup
  fetch('/api/wallet').then(r => r.json()).then(cfg => {
    state._walletConfigured = cfg.configured;
    updateSidebar();
    // Warn in the log if not configured
    if (!cfg.configured) {
      addLog('warn', 'API anahtarları eksik — bot başlatılamaz. Ayarlar > Wallet bölümünü kontrol edin.');
    }
  }).catch(() => {});

  // Load strategy settings into state
  fetch('/api/settings').then(r => r.json()).then(s => {
    state.strategy = {
      min_entry_price:     s.min_entry_price      ?? 0.75,
      max_entry_price:     s.max_entry_price      ?? 0.98,
      time_rule_threshold: s.time_rule_threshold  ?? 90,
      min_entry_seconds:   s.min_entry_seconds    ?? 10,
      max_slippage_pct:    s.max_slippage_pct     ?? 0.03,
      min_btc_move_up:     s.min_btc_move_up      ?? 70,
      order_amount:        s.order_amount         ?? 2,
      event_trade_limit:   s.event_trade_limit    ?? 1,
      max_open_positions:  s.max_open_positions   ?? 1,
    };
    addLog('info', 'Strategy settings loaded');
  }).catch(() => {});

  // Refresh strategy settings every 60 seconds
  const _settingsRefreshInterval = setInterval(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      Object.assign(state.strategy, s);
    }).catch(() => {});
  }, 60000);

  // REST state on load
  fetch('/api/status')
    .then(r => r.json())
    .then(d => { handleStateUpdate(d); addLog('success', 'Initial state loaded'); })
    .catch(() => {});

  // Polling when WS disconnected
  const _pollingInterval = setInterval(() => {
    if (!state.connected) {
      fetch('/api/status').then(r => r.json()).then(handleStateUpdate).catch(() => {});
    }
  }, 2000);

  // Cleanup on unload — timer/interval sızıntısını önle
  window.addEventListener('beforeunload', () => {
    clearInterval(_settingsRefreshInterval);
    clearInterval(_pollingInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (typeof _runtimeInterval !== 'undefined' && _runtimeInterval) clearInterval(_runtimeInterval);
    if (typeof uptimeInterval !== 'undefined' && uptimeInterval) clearInterval(uptimeInterval);
    if (ws) { try { ws.close(); } catch(_) {} }
  });

  // Bildirimler gerçek bot eventlerinden gelecek

  // Close notification dropdown on outside click
  document.addEventListener('click', (e) => {
    if (state.notifOpen && !e.target.closest('.notif-wrapper')) {
      state.notifOpen = false;
      const dd   = document.getElementById('notif-dropdown');
      const bell = document.getElementById('notif-bell');
      if (dd)   dd.style.display = 'none';
      if (bell) bell.classList.remove('active');
    }
  });

  // Bell: close on outside click
  document.addEventListener('click', (e) => {
    if (state.notifOpen && !e.target.closest('#notif-bell') && !e.target.closest('#notif-dropdown')) {
      state.notifOpen = false;
      const dd = document.getElementById('notif-dropdown');
      const bell = document.getElementById('notif-bell');
      if (dd) dd.style.display = 'none';
      if (bell) bell.classList.remove('active');
    }
  });

  // ESC to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.currentPage !== 'watchlist') {
      closePageModal();
    }
  });
});
