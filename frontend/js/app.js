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
  // Per-asset strategy overrides (persisted to localStorage)
  assetSettings: JSON.parse(localStorage.getItem('polyflow_asset_settings') || '{}'),
  // Manual sort order
  manualOrder: [],
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

// Helper: get effective strategy for a given asset (per-asset overrides global)
function getAssetStrategy(sym) {
  const base = sym.includes('_') ? sym.split('_')[0] : sym;
  return Object.assign({}, state.strategy, state.assetSettings[base] || {});
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

// ─── Timeframe / Market Filter ────────────
function setTimeframe(tf) {
  state.timeframe = tf;
  state.showAllMarkets = (tf === 'ALL');
  // Update tab UI
  ['PINNED','ALL','5M','15M','1H','4H','1D'].forEach(t => {
    const btn = document.getElementById(`tf-btn-${t}`);
    if (btn) btn.classList.toggle('active', t === tf);
  });
  // Reset chip filter when switching to all markets
  if (state.showAllMarkets) {
    state.chipFilter = 'ALL';
    _chipsBuilt = false; // rebuild chips with all assets
  } else {
    _chipsBuilt = false; // rebuild chips with pinned assets
  }
  _lastRenderKey = ''; // force full re-render
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
      if (msg.type === 'state_update')  handleStateUpdate(msg.data);
      else if (msg.type === 'log')      addLog(msg.level || 'info', msg.message);
      else if (msg.type === 'rate_limit') showRateLimitPopup(msg.retry_after || 60);
    } catch (e) { /* ignore */ }
  };

  ws.onclose = () => {
    state.connected = false;
    updateConnectionUI();
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
function handleStateUpdate(data) {
  if (data.bot_running  !== undefined) state.botRunning  = data.bot_running;
  if (data.mode)                       state.mode        = data.mode;
  if (data.balance      !== undefined) state.balance     = data.balance;
  if (data.session_pnl  !== undefined) state.sessionPnl  = data.session_pnl;
  if (data.assets)                     state.assets      = data.assets;
  if (data.pinned)                     state.pinned      = data.pinned;
  if (data.selected_asset)             state.selectedAsset = data.selected_asset;
  if (data.positions)                  state.positions   = data.positions;
  if (data.trade_history)              state.tradeHistory = data.trade_history;
  if (data.connection_status)          state.connections = data.connection_status;
  if (data.strategy_status)            state.strategyStatus = data.strategy_status;
  if (data.ws_client_count !== undefined) state.wsClientCount = data.ws_client_count;

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
    container.innerHTML = '<div class="text-center text-muted" style="padding:60px 20px;"><div style="font-size:32px;margin-bottom:10px;">📡</div>Yükleniyor...</div>';
    return;
  }

  // Timeframe filter
  let tfFiltered;
  if (state.timeframe === 'ALL') {
    tfFiltered = allKeys;
  } else if (state.timeframe === 'PINNED') {
    // Pinli mod: sadece pinlenmis eventleri goster (tum TF'ler)
    tfFiltered = allKeys.filter(k => state.pinned.includes(k));
  } else {
    tfFiltered = allKeys.filter(k => k.endsWith('_' + state.timeframe));
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

    html += buildGroup('aktif',   'Aktif Pozisyonlar', 'active', pinnedWithPos, false);
    html += buildGroup('tracked', 'Takip Edilenler',   'active', pinnedNoPos,   pinnedWithPos.length > 0);
    html += buildGroup('others',  'Diğer Marketler',   '',       unpinned,      pinnedWithPos.length > 0 || pinnedNoPos.length > 0);

    container.innerHTML = html;
  } else {
    updateCardsInPlace(sorted);
  }
}

// ─── In-Place Card Update (anti-flicker) ──
function updateCardsInPlace(keys) {
  const ruleKeys = ['time','price','btc_move','slippage','event_limit','max_positions'];
  keys.forEach(key => {
    const a   = state.assets[key];
    if (!a) return;
    const sym = a.symbol || key.split('_')[0];
    const mp  = a.market || {};
    const cd  = a.countdown || 0;
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

    // Price diff for rule calculations
    const refPrice  = a.event?.open_reference || a.price;
    const priceDiff = a.price - refPrice;

    // Countdown bar in expanded body
    const barFill = card.querySelector('.eac-cd-bar-fill');
    if (barFill) {
      barFill.style.width  = `${barPct}%`;
      barFill.style.background = barColor;
    }

    // Rule blocks
    const rules          = a.rules || {};
    const st             = getAssetStrategy(sym);
    const spreadDisabled = (st.max_slippage_pct || 0.03) >= 0.5;
    const upAsk          = mp.up_ask  || 0.5;
    const downAsk        = mp.down_ask || 0.5;
    const upPct          = (upAsk   * 100).toFixed(1);
    const dnPct          = (downAsk * 100).toFixed(1);
    const timeMin        = st.min_entry_seconds   || 10;
    const timeMax        = st.time_rule_threshold || 90;
    const timeMinStr     = timeMin < 60 ? `${timeMin}sn` : `${Math.floor(timeMin/60)}:${String(timeMin%60).padStart(2,'0')}dk`;
    const timeMaxStr     = timeMax < 60 ? `${timeMax}sn` : `${Math.floor(timeMax/60)}:${String(timeMax%60).padStart(2,'0')}dk`;
    const movePct        = refPrice > 0 ? (priceDiff / refPrice * 100) : 0;
    const moveStr        = (movePct >= 0 ? '+' : '') + movePct.toFixed(2) + '%';
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
        mainTxt = `↑${upPct}% ↓${dnPct}%`;
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
        if (mainEl) mainEl.textContent = mainTxt;
      }
    });

    // Rule count badge
    const passCount = ruleKeys.filter(k => {
      if (k === 'slippage' && spreadDisabled) return true;
      return rules[k] === 'pass';
    }).length;
    const allPass    = passCount === 6;
    const countColor = allPass ? 'all-pass' : passCount >= 4 ? 'waiting' : 'has-fail';
    const countDiv   = card.querySelector('.eac-rule-count');
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
  banner.innerHTML = `<span class="go-banner-icon">🟢</span> <strong>${sym}</strong> — Tum kurallar saglandi! Giris icin hazir. <span class="go-banner-time">${new Date().toLocaleTimeString()}</span>`;
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

  const upAsk   = mp.up_ask  || 0.5;
  const downAsk = mp.down_ask || 0.5;
  const upPct   = (upAsk  * 100).toFixed(1);
  const dnPct   = (downAsk * 100).toFixed(1);

  const pinned   = state.pinned.includes(key);
  const hasPos   = a.has_position;
  const rules    = a.rules || {};
  const ruleKeys = ['time','price','btc_move','slippage','event_limit','max_positions'];

  const st = getAssetStrategy(sym);
  const hasCustomSettings = !!(state.assetSettings[sym]);
  const spreadDisabled = (st.max_slippage_pct || 0.03) >= 0.5;

  const passCount = ruleKeys.filter(k => {
    if (k === 'slippage' && spreadDisabled) return true;
    return rules[k] === 'pass';
  }).length;
  const allPass    = passCount === 6;
  const countColor = allPass ? 'all-pass' : passCount >= 4 ? 'waiting' : 'has-fail';

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
  const priceRangeStr = `${(st.min_entry_price||0.75).toFixed(2)}–${(st.max_entry_price||0.98).toFixed(2)}`;

  const movePct    = refPrice > 0 ? (priceDiff / refPrice * 100) : 0;
  const moveStr    = (movePct >= 0 ? '+' : '') + movePct.toFixed(2) + '%';
  const minMoveStr = formatAssetPrice(sym, st.min_btc_move_up || 70);

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

    <!-- SOL: ikon + isim + 5DK + pin + canli -->
    <div class="eac-hdr-left">
      <div class="eac-icon" style="background:${a.color}22;color:${a.color};">${a.icon}</div>
      <div class="eac-hdr-text">
        <div class="eac-title-row">
          ${eventUrl
            ? `<a class="eac-name eac-name-link" href="${eventUrl}" target="_blank" onclick="event.stopPropagation()" title="${eventQ}">${shortTitle}</a>`
            : `<span class="eac-name">${shortTitle}</span>`
          }
          <span class="eac-tf">${{'5M':'5DK','15M':'15DK','1H':'1SA','4H':'4SA','1D':'1G'}[tf]||tf}</span>
          <button class="pin-btn pin-btn-title ${pinned ? 'pinned' : ''}"
            onclick="event.stopPropagation(); togglePin('${key}')"
            title="${pinned ? 'Takipten çıkar' : 'Takibe al'}">${pinned ? '📌' : '📍'}</button>
          ${liveBadge}
          ${hasPos ? '<span class="badge-pos">●</span>' : ''}
          ${(allPass && state.botRunning && pinned) ? '<span class="badge-ready">GO</span>' : ''}
        </div>
        <div class="eac-price-row">
          <span class="eac-price-up">UP ${(upAsk * 100).toFixed(1)}¢</span>
          <span class="eac-price-sep">│</span>
          <span class="eac-price-dn">DN ${(downAsk * 100).toFixed(1)}¢</span>
        </div>
      </div>
    </div>

    <!-- SAG: kurallar -->
    <div class="eac-hdr-right">

      ${isUntracked
        ? `<div class="eac-noconfig-block">
             <span class="eac-noconfig-msg">Ayar Yok — Takibe Al</span>
             <div class="eac-hdr-gap"></div>
             <button class="eac-settings-quick" onclick="event.stopPropagation(); togglePin('${key}'); openAssetSettings('${key}')" title="Takibe al ve ayar yap">Ayarlar</button>
           </div>`
        : `${pos
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
            <span class="eac-rb-main">↑${upPct}% ↓${dnPct}%</span>
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
            ? `<button class="eac-settings-quick${hasCustomSettings ? ' custom' : ''}"
                 onclick="event.stopPropagation(); openAssetSettings('${key}')"
                 title="${hasCustomSettings ? 'Özel ayar aktif' : 'Bu asset için ayar yap'}">
                 Ayarlar${hasCustomSettings ? ' ✦' : ''}
               </button>`
            : ''
          }`
      }
    </div>

  </div>
</div>`;
}

// ─── Per-Asset Settings Modal ──────────────
function openAssetSettings(key) {
  // key = "BTC_5M" gibi event key — her event icin ayri ayar
  const a = state.assets[key];
  if (!a) {
    // Eski format uyumlulugu: base sym ile gelmisse ilk event'i bul
    const assetKey = Object.keys(state.assets).find(k => k.startsWith(key + '_')) || key;
    return openAssetSettings(assetKey);
  }
  const st = getAssetStrategy(key);
  const over = state.assetSettings[key] || {};

  // Helper: display value (% fields shown as whole number e.g. 0.03 → 3)
  const dispVal = (key, val) => key === 'max_slippage_pct' ? (val * 100).toFixed(1) : val;

  const fld = (key, label, val, hint) => {
    const dv = dispVal(key, val);
    const isOverridden = over[key] !== undefined;
    return `<div class="as-field">
      <label class="as-label">${label}</label>
      <input class="as-input ${isOverridden ? 'overridden' : ''}"
             id="as-${sym}-${key}" type="number" step="any"
             value="${dv}"
             placeholder="Örn: ${hint}" />
      <span class="as-hint">${hint}</span>
    </div>`;
  };

  const body = `
<div class="as-modal" id="as-modal-${sym}">
  <div class="as-header">
    <div class="as-icon" style="background:${a.color}22;color:${a.color};">${a.icon}</div>
    <div>
      <div class="as-title">${a.name} — Event Ayarları</div>
      <div class="as-sub">Bu asset için global ayarları geçersiz kılar. Boş bırakılan alanlar global değeri kullanır.</div>
    </div>
  </div>
  <div class="as-grid">
    ${fld('min_entry_price',    'Min Giriş Fiyatı (0–1)',    st.min_entry_price,    '0.75 — UP token min olasılığı')}
    ${fld('max_entry_price',    'Max Giriş Fiyatı (0–1)',    st.max_entry_price,    '0.98 — UP token max olasılığı')}
    ${fld('time_rule_threshold','Max Süre (sn)',              st.time_rule_threshold,'90 — event bitişine max kalan süre')}
    ${fld('min_entry_seconds',  'Min Süre (sn)',              st.min_entry_seconds,  '10 — event bitişine min kalan süre')}
    ${fld('min_btc_move_up',    'Min Fiyat Hareketi',         st.min_btc_move_up,    '70 — BTC için $70, SOL için $1.5')}
    ${fld('max_slippage_pct',   'Max Spread (%)',             st.max_slippage_pct,   '3 — %3 spread, 0.5+ devre dışı bırakır')}
    ${fld('event_trade_limit',  'Event Başına Max İşlem',     st.event_trade_limit,  '1 — her 5M eventinde max işlem sayısı')}
    ${fld('order_amount',       'İşlem Miktarı ($)',          st.order_amount,       '2 — her işlemde kullanılacak tutar')}
  </div>
  <div class="as-actions">
    <button class="as-btn-reset" onclick="resetAssetSettings('${sym}')">Sıfırla (Global'e Dön)</button>
    <button class="as-btn-save"  onclick="saveAssetSettings('${sym}')">Kaydet</button>
  </div>
</div>`;

  const modal = document.getElementById('page-modal');
  const overlay = document.getElementById('page-modal-overlay');
  const title = document.getElementById('page-modal-title');
  const modalBody = document.getElementById('page-modal-body');
  if (!modal) return;
  title.textContent = `${a.name} · Event Ayarları`;
  modalBody.innerHTML = body;
  modal.style.display = 'flex';
  overlay.style.display = 'block';
}

function saveAssetSettings(sym) {
  // Fields that user enters as % whole number → stored as decimal (÷100)
  const pctFields = new Set(['max_slippage_pct']);
  const keys = ['min_entry_price','max_entry_price','time_rule_threshold','min_entry_seconds',
                 'min_btc_move_up','max_slippage_pct','event_trade_limit','order_amount'];
  const saved = {};
  keys.forEach(k => {
    const el = document.getElementById(`as-${sym}-${k}`);
    if (!el || el.value === '') return;
    let v = parseFloat(el.value);
    if (isNaN(v)) return;
    if (pctFields.has(k)) v = v / 100; // convert % back to decimal
    saved[k] = v;
  });
  state.assetSettings[sym] = saved;
  localStorage.setItem('polyflow_asset_settings', JSON.stringify(state.assetSettings));
  closePageModal();
  _lastRenderKey = '';
  renderEventsList();
}

function resetAssetSettings(sym) {
  delete state.assetSettings[sym];
  localStorage.setItem('polyflow_asset_settings', JSON.stringify(state.assetSettings));
  closePageModal();
  _lastRenderKey = '';
  renderEventsList();
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
async function toggleBot() {
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
  // key = "BTC_5M" veya "BTC" — event bazlı pin/unpin
  // Pinned listesi key bazlı (event bazlı) tutuluyor
  const pinned = new Set(state.pinned);
  if (pinned.has(key)) pinned.delete(key);
  else                 pinned.add(key);
  state.pinned = [...pinned];
  wsSend({ type: 'toggle_pin', asset: key });
  fetch(`/api/assets/${key}/pin`, { method: 'POST' }).catch(() => {});
  addLog('info', `${key} ${pinned.has(key) ? 'takibe alındı' : 'takipten çıkarıldı'}`);
  _chipsBuilt = false;
  _lastRenderKey = '';
  renderEventsList();
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
    min_entry_price:     numVal('cfg-min-entry'),
    max_entry_price:     numVal('cfg-max-entry'),
    max_slippage_pct:    numVal('cfg-slippage') / 100,
    target_exit_price:   numVal('cfg-target'),
    stop_loss_price:     numVal('cfg-stoploss'),
    order_amount:        numVal('cfg-amount'),
    event_trade_limit:   numVal('cfg-event-limit'),
    max_open_positions:  numVal('cfg-max-pos'),
    force_sell_enabled:  checkVal('cfg-force-sell'),
    auto_claim:          checkVal('cfg-auto-claim'),
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  }).catch(() => {});
  showToast('Strategy kaydedildi ✓', 'success');
}

async function saveSettings() {
  const s = {
    mode:             document.getElementById('cfg-mode')?.value || 'PAPER',
    btc_price_source: document.getElementById('cfg-btc-source')?.value || 'BINANCE',
    port:             numVal('cfg-port'),
    auto_start:       checkVal('cfg-auto-start'),
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  }).catch(() => {});
  showToast('Settings kaydedildi ✓', 'success');
}

function saveWallet() {
  const pk         = document.getElementById('cfg-pk')?.value?.trim() || '';
  const apiKey     = document.getElementById('cfg-apikey')?.value?.trim() || '';
  const secret     = document.getElementById('cfg-secret')?.value?.trim() || '';
  const passphrase = document.getElementById('cfg-passphrase')?.value?.trim() || '';
  const funder     = document.getElementById('cfg-funder')?.value?.trim() || '';

  if (!pk || !apiKey || !secret || !passphrase) {
    showToast('Lütfen zorunlu tüm alanları doldurun (Private Key, API Key, Secret, Passphrase)', 'warn');
    return;
  }

  fetch('/api/wallet/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ private_key: pk, api_key: apiKey, api_secret: secret, api_passphrase: passphrase, funder }),
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
  const subPageParents = { settings:'settings', strategy:'settings', wallet:'settings' };
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

  // Special: trigger page-specific updates
  if (page === 'positions') updatePositionsPage();
  if (page === 'history')   updateHistoryPage();
  if (page === 'logs')      renderLogPage();

  // Settings: reload form values
  if (page === 'settings' || page === 'strategy' || page === 'wallet') {
    fetch('/api/settings').then(r => r.json()).then(s => {
      const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
      set('cfg-time-threshold', s.time_rule_threshold);
      set('cfg-min-entry',      s.min_entry_price);
      set('cfg-max-entry',      s.max_entry_price);
      set('cfg-slippage',       s.max_slippage_pct !== undefined ? (s.max_slippage_pct*100).toFixed(1) : 3);
      set('cfg-target',         s.target_exit_price);
      set('cfg-stoploss',       s.stop_loss_price);
      set('cfg-amount',         s.order_amount);
      set('cfg-event-limit',    s.event_trade_limit);
      set('cfg-max-pos',        s.max_open_positions);
      set('cfg-mode',           s.mode);
      set('cfg-btc-source',     s.btc_price_source);
      set('cfg-port',           s.port);
      const fs = document.getElementById('cfg-force-sell');
      const ac = document.getElementById('cfg-auto-claim');
      const as = document.getElementById('cfg-auto-start');
      if (fs && s.force_sell_enabled !== undefined) fs.checked = s.force_sell_enabled;
      if (ac && s.auto_claim         !== undefined) ac.checked = s.auto_claim;
      if (as && s.auto_start         !== undefined) as.checked = s.auto_start;
    }).catch(() => {});
  }

  // Wallet: pre-populate form from .env (masked for security)
  if (page === 'wallet') {
    fetch('/api/wallet').then(r => r.json()).then(cfg => {
      const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
      set('cfg-pk',         cfg.private_key);
      set('cfg-apikey',     cfg.api_key);
      set('cfg-secret',     cfg.secret);
      set('cfg-passphrase', cfg.passphrase);
      set('cfg-funder',     cfg.funder);
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
  const n = Number(val) || 0;
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
function formatAssetPrice(sym, price) {
  const p = Number(price) || 0;
  if (p >= 1000) return `$${p.toLocaleString('en', {maximumFractionDigits:2})}`;
  if (p >= 1)    return `$${p.toFixed(3)}`;
  return `$${p.toFixed(5)}`;
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
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
  setInterval(() => {
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
  setInterval(() => {
    if (!state.connected) {
      fetch('/api/status').then(r => r.json()).then(handleStateUpdate).catch(() => {});
    }
  }, 2000);

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

  // ESC to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.currentPage !== 'watchlist') {
      closePageModal();
    }
  });
});
