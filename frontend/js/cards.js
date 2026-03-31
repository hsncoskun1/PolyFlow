/**
 * cards.js — Event kartları render ve güncelleme sistemi
 *
 * Bağımlılıklar (global scope'tan):
 *   utils.js          : fmtCD, formatUSD, formatAssetPrice
 *   settings-modal.js : openAssetSettings
 *   app.js            : state, _prevCardVals, getAssetStrategy,
 *                       togglePin, pinAndOpenSettings, filterEvents,
 *                       onCardDragStart, onCardDragEnd, onCardDragOver, onCardDrop,
 *                       closePosition
 */

// ─── Cards-local state ────────────────────────────────────────────────────────

let _prevPrices = {};          // key → son fiyat (flash için)
const _goAlerted = {};         // sym → bool (GO alert tekrarını önle)


// ─── In-Place Card Update (anti-flicker + delta check) ──────────────────────

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
    const ptbEl = card.querySelector('.eac-ptb-val');
    if (ptbEl) {
      ptbEl.textContent = a.ptb
        ? '$' + Number(a.ptb).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
        : '...';
    }
    const livePriceEl = card.querySelector('.eac-live-price');
    const priceSepEl  = card.querySelector('.eac-price-sep');
    const deltaEl     = card.querySelector('.eac-inline-delta');
    if (a.live_price && a.live_price > 0) {
      const lpStr = '$' + Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
      if (livePriceEl) {
        livePriceEl.textContent = lpStr;
        livePriceEl.style.display = '';
      } else {
        const ptbRow = ptbEl?.parentElement;
        if (ptbRow) {
          if (!ptbRow.querySelector('.eac-price-sep')) {
            ptbRow.insertAdjacentHTML('beforeend', `<span class="eac-price-sep">|</span><span class="eac-anlık-label">ANLIK</span><span class="eac-live-price">${lpStr}</span>`);
          }
        }
      }
      if (priceSepEl) priceSepEl.style.display = '';
      // Delta inline güncelle
      const d = mp.btc_delta != null ? mp.btc_delta : (a.ptb ? a.live_price - a.ptb : null);
      if (deltaEl && d != null) {
        const pos = d >= 0;
        deltaEl.textContent = (pos ? 'Δ+$' : 'Δ-$') + Math.abs(d).toFixed(2);
        deltaEl.className = 'eac-inline-delta ' + (pos ? 'pos' : 'neg');
        deltaEl.style.display = '';
      } else if (deltaEl) {
        deltaEl.style.display = 'none';
      }
    } else {
      if (livePriceEl) livePriceEl.style.display = 'none';
      if (priceSepEl)  priceSepEl.style.display  = 'none';
      if (deltaEl)     deltaEl.style.display      = 'none';
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
    const st             = getAssetStrategy(key);
    const spreadDisabled = (st.max_slippage_pct || 0.03) >= 0.5;
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

    // PTB + canlı fiyat güncelle
    const liveEl = card.querySelector('.eac-live-price');
    if (a.live_price) {
      if (liveEl) {
        liveEl.textContent = '$' + Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
      } else {
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


// ─── GO Alert System ──────────────────────────────────────────────────────────

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
  banner.innerHTML = `<span class="go-banner-icon">🟢</span> <strong>${sym}</strong> — Tüm kurallar sağlandı! Giriş için hazır. <span class="go-banner-time">${new Date().toLocaleTimeString()}</span>`;
  banner.style.display = 'flex';
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => { banner.style.display = 'none'; }, 8000);
}


// ─── Asset Chips ──────────────────────────────────────────────────────────────

function buildAssetChips(syms) {
  const chips = document.getElementById('asset-chips');
  if (!chips) return;
  if (syms.length <= 1) { chips.innerHTML = ''; return; }
  chips.innerHTML =
    `<button class="asset-chip ${state.chipFilter === 'ALL' ? 'active' : ''}" onclick="filterEvents('ALL',this)">All</button>` +
    syms.map(sym => {
      const key = Object.keys(state.assets).find(k => k.startsWith(sym + '_'));
      const a = key ? state.assets[key] : null;
      const active = state.chipFilter === sym ? 'active' : '';
      return `<button class="asset-chip ${active}" onclick="filterEvents('${sym}',this)"
        style="${active ? '' : `border-color:${a?.color||'#555'}33;`}">${sym}</button>`;
    }).join('');
}


// ─── Price Freshness Badge ────────────────────────────────────────────────────

function _makePriceFreshnessBadge(a) {
  const priceTs = a.price_ts || 0;
  if (!priceTs) {
    return '<span class="price-source-badge stale" title="Fiyat zamanı bilinmiyor">? BE</span>';
  }
  const ageMs = Date.now() - priceTs;
  const ageSec = Math.round(ageMs / 1000);
  if (ageMs < 5000) {
    return `<span class="price-source-badge fresh" title="Backend fiyatı — ${ageSec}sn önce">⚡ BE</span>`;
  } else if (ageMs < 15000) {
    return `<span class="price-source-badge recent" title="Backend fiyatı — ${ageSec}sn önce">${ageSec}s BE</span>`;
  } else {
    return `<span class="price-source-badge stale" title="Fiyat stale — ${ageSec}sn önce">⚠ ${ageSec}s</span>`;
  }
}


// ─── Single Event Card ────────────────────────────────────────────────────────

function renderEventCard(key) {
  const a = state.assets[key];
  if (!a) return '';

  const sym = a.symbol || key.split('_')[0];
  const tf  = a.timeframe || key.split('_').slice(1).join('_') || '5M';

  const mp      = a.market || {};
  const cd      = a.countdown || 0;
  const cdStr   = fmtCD(cd);

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
  const settingsConfigured = a.settings_configured !== false;
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

  const slug = a.slug || a.event?.slug || '';
  const eventUrl = slug ? `https://polymarket.com/event/${slug}` : '';
  const eventQ = a.event?.question || '';

  const shortTitle = a.name;

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
          ${a.live_price ? `<span class="eac-price-sep">|</span><span class="eac-anlık-label">ANLIK</span><span class="eac-live-price">$${Number(a.live_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>` : ''}
          ${btcDelta != null ? `<span class="eac-inline-delta ${btcDelta >= 0 ? 'pos' : 'neg'}">${btcDelta >= 0 ? 'Δ+$' : 'Δ-$'}${Math.abs(btcDelta).toFixed(2)}</span>` : `<span class="eac-inline-delta" style="display:none"></span>`}
        </div>
      </div>
    </div>

    <!-- ORTA: bildirim alanı -->
    <div class="eac-hdr-mid">
      ${(()=>{
        const notif = (state._cardNotifications || {})[key];
        if (notif) return `<span class="eac-card-notif notif-${notif.type}">${notif.icon} ${notif.text}</span>`;
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


// ─── Expanded Event Body ──────────────────────────────────────────────────────

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

  const isPinned = state.pinned.includes(sym) || state.pinned.includes(sym);

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
        <span style="float:right;display:flex;align-items:center;gap:6px;">
          ${_makePriceFreshnessBadge(a)}
          <span style="font-weight:700;color:${slipColor};">Slip ${(mp.slippage_pct||0).toFixed(2)}%</span>
        </span>
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
