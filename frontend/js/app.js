/**
 * POLYFLOW — Dashboard App v1.3.0
 * Accordion multi-event layout + notification bell + page modal
 */

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const state = {
  botRunning:    false,
  safeMode:      false,
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
  // Data health (backend verification layer)
  dataHealth: { verified: false, rtds_fresh_count: 0, rtds_stale_syms: [], stale_threshold_s: 10 },
};

let ws             = null;
let reconnectTimer = null;
let uptimeInterval = null;
let _historyFilter = 'all';
let _chipsBuilt    = false;
let _lastRenderKey = ''; // flickering prevention
let _dragSym       = null; // drag-and-drop source
let _rafPending    = false; // requestAnimationFrame batching
let _prevCardVals  = {};   // key → {price, cd, upPct, dnPct, rules} — delta check

// _enableDebugWs, _disableDebugWs, _buildTokenMap, _startDirectClob, _startDirectRtds,
// _maybeStartDirectFeeds, connectWS, wsSend, _mergeState, handleStateUpdate
// → frontend/js/ws.js
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

  // Safe mode warning
  const safeModeWarn = document.getElementById('safe-mode-warning');
  if (safeModeWarn) safeModeWarn.style.display = state.safeMode ? '' : 'none';

  // Bot start button: safe mode aktifse gri + disabled
  const toggleBtn = document.getElementById('bot-toggle-btn');
  if (toggleBtn) {
    if (state.safeMode && !state.botRunning) {
      toggleBtn.disabled = true;
      toggleBtn.style.opacity = '0.4';
      toggleBtn.title = 'Safe mode aktif — devre dışı bırakın';
    } else {
      toggleBtn.disabled = false;
      toggleBtn.style.opacity = '';
      toggleBtn.title = '';
    }
  }

  // Emergency stop button — bot çalışırken göster
  const emergRow = document.getElementById('emergency-stop-row');
  if (emergRow) emergRow.style.display = state.botRunning ? '' : 'none';

  // Session PnL
  const sesnPnlEl = document.getElementById('sidebar-session-pnl');
  if (sesnPnlEl) {
    const pnlVal = state.sessionPnl || 0;
    sesnPnlEl.textContent = (pnlVal >= 0 ? '+' : '') + '$' + pnlVal.toFixed(2);
    sesnPnlEl.className = 'status-value text-mono ' + (pnlVal >= 0 ? 'text-green' : 'text-red');
  }

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

// updateCardsInPlace, playGoAlert, showGoBanner, buildAssetChips,
// _makePriceFreshnessBadge, renderEventCard, renderEventBody, _goAlerted
// --> frontend/js/cards.js

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

// updatePositionsPage, updateHistoryPage → frontend/js/positions.js

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
    // Bot başlatmadan önce max işlem sayısını sor
    showBotStartModal();
  } finally {
    _botToggling = false;
  }
}

function showBotStartModal() {
  const existing = document.getElementById('bot-start-modal-overlay');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'bot-start-modal-overlay';
  el.className = 'cf-overlay';
  el.innerHTML = `
    <div class="cf-popup bot-start-popup">
      <div class="cf-title">▶ Bot Başlat</div>
      <div class="bot-start-body">
        <div class="bot-start-row">
          <span class="bot-start-label">Max İşlem Sayısı</span>
          <div class="bot-start-ctrl">
            <input type="number" id="bsm-max-trades" class="as-input"
                   min="1" max="9999" step="1" value="10" placeholder="örn: 10" style="width:64px;text-align:right;" />
            <span class="as-row-unit">↺</span>
            <button class="as-spread-toggle on" id="bsm-infinite-btn"
                    type="button" onclick="toggleBotStartInfinite()"
                    title="Sonsuz mod — bot otomatik durmadan çalışır">
              SONSUZ
            </button>
          </div>
        </div>
        <div class="bot-start-hint">
          Sonsuz modda bot siz durdurana kadar çalışır. Kapalıysa, belirlenen sayıda işlem sonrası otomatik durur.
        </div>
      </div>
      <div class="cf-actions">
        <button class="cf-btn-cancel" onclick="document.getElementById('bot-start-modal-overlay').remove()">İptal</button>
        <button class="cf-btn-confirm trade" onclick="confirmBotStart()">▶ Başlat</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });

  // Başlangıçta sonsuz kapalı — input aktif
  _botStartInfinite = false;
  _updateBotStartUI();
}

let _botStartInfinite = false;
function toggleBotStartInfinite() {
  _botStartInfinite = !_botStartInfinite;
  _updateBotStartUI();
}
function _updateBotStartUI() {
  const input = document.getElementById('bsm-max-trades');
  const btn   = document.getElementById('bsm-infinite-btn');
  if (!input || !btn) return;
  if (_botStartInfinite) {
    input.disabled = true;
    input.style.opacity = '0.35';
    btn.textContent = 'SONSUZ';
    btn.className = 'as-spread-toggle on';
  } else {
    input.disabled = false;
    input.style.opacity = '';
    btn.textContent = 'SINIRLI';
    btn.className = 'as-spread-toggle off';
  }
}

async function confirmBotStart() {
  const overlay = document.getElementById('bot-start-modal-overlay');
  const input   = document.getElementById('bsm-max-trades');
  const maxTrades = _botStartInfinite ? 0 : (parseInt(input?.value) || 0);
  if (overlay) overlay.remove();
  await fetch('/api/bot/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_total_trades: maxTrades }),
  }).catch(() => {});
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

async function emergencyStop() {
  if (!confirm('⚠️ ACİL DURDUR\n\nTüm açık pozisyonlar FORCE SELL olarak işaretlenecek ve safe mode aktif edilecek.\n\nDevam etmek istiyor musunuz?')) return;
  try {
    const r = await fetch('/api/bot/emergency-stop', { method: 'POST' });
    const d = await r.json();
    showToast(`🛑 ACİL DURDUR — ${d.force_sold || 0} pozisyon kapatılıyor. Safe mode aktif.`, 'warn');
  } catch(e) {
    showToast('ACİL DURDUR isteği gönderilemedi.', 'error');
  }
}

async function disableSafeMode() {
  if (!confirm('Safe mode devre dışı bırakılacak.\nBotu yeniden başlatabileceksiniz.\n\nOnaylıyor musunuz?')) return;
  try {
    await fetch('/api/bot/safe-mode/disable', { method: 'POST' });
    showToast('Safe mode devre dışı bırakıldı.', 'info');
  } catch(e) {
    showToast('İstek gönderilemedi.', 'error');
  }
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

// showToast → utils.js

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
// setText, numVal, checkVal, formatUSD, formatAssetPrice → utils.js

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
