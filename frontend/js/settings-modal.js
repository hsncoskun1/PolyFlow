/**
 * settings-modal.js — Event strateji ayarları modal ve confirm popup
 *
 * Bağımlılıklar (global scope'tan):
 *   utils.js   : showToast
 *   app.js     : state, wsSend, closePageModal, renderEventsList,
 *                loadAllEventSettings, _chipsBuilt, _lastRenderKey
 */

// ─── Alan Tanımları ───────────────────────────────────────────────────────────

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

// Bölüm grupları — confirm popup tablosu için (düz liste)
const AS_SECTIONS = [
  { label: 'Giriş Koşulları', keys: ['min_entry_price','max_entry_price','time_rule_threshold','min_entry_seconds','min_move_delta','max_slippage_pct'] },
  { label: 'Çıkış Stratejisi', keys: ['target_exit_pct','stop_loss_pct','force_sell_before_resolution_seconds','sell_retry_count'] },
  { label: 'Limitler',         keys: ['order_amount','event_trade_limit','max_open_positions'] },
];

// Görsel layout — modal'da çiftli satırlar ve gelişmiş blok
const AS_LAYOUT = [
  {
    label: 'Giriş Koşulları',
    rows: [
      { pair: ['min_entry_price',    'max_entry_price']         }, // Min | Max giriş
      { pair: ['time_rule_threshold','min_entry_seconds']       }, // Zaman kuralı | Min kalan
      { pair: ['min_move_delta',     'max_slippage_pct']        }, // Fiyat hareketi | Max spread
    ],
  },
  {
    label: 'Çıkış Stratejisi',
    rows: [
      { pair: ['target_exit_pct', 'stop_loss_pct'] },             // Hedef | Stop Loss
    ],
  },
  {
    label: 'Limitler',
    rows: [
      { single: 'order_amount' },
      { pair: ['event_trade_limit', 'max_open_positions'] },      // Event limit | Max açık
    ],
  },
  {
    label: '⚙ Gelişmiş',
    adv: true,
    rows: [
      { pair: ['force_sell_before_resolution_seconds', 'sell_retry_count'] },
    ],
  },
];

// Kullanıcı 0-100 (%) girer → backend'e 0-1 olarak gönderilir (÷100)
// Kullanıcı 0-1 olan değeri okurken → 0-100 olarak gösterilir (×100)
const _pctFields = new Set([
  'min_entry_price','max_entry_price','target_exit_pct','stop_loss_pct',
  'max_slippage_pct'
]);

// ─── Modal Aç ─────────────────────────────────────────────────────────────────

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

  // Çiftli satır oluşturucu
  const fldPair = (k1, k2) => {
    const f1 = EVENT_SETTING_FIELDS.find(f => f.key === k1);
    const f2 = EVENT_SETTING_FIELDS.find(f => f.key === k2);
    return `<div class="as-row-pair">${fld(f1)}${fld(f2)}</div>`;
  };
  const renderRow = (row) => {
    if (row.pair)   return fldPair(row.pair[0], row.pair[1]);
    if (row.single) return fld(EVENT_SETTING_FIELDS.find(f => f.key === row.single));
    return '';
  };

  // Seksiyonları oluştur (AS_LAYOUT'tan — çiftli satır destekli)
  const sectionsHTML = AS_LAYOUT.map(sec => `
    <div class="as-section${sec.adv ? ' as-section-adv' : ''}">
      <div class="as-section-hdr">${sec.label}</div>
      <div class="as-rows">
        ${sec.rows.map(renderRow).join('')}
      </div>
    </div>`).join('');

  // PnL önizleme bloğu
  const pnlPreviewHTML = `
  <div class="as-pnl-preview" id="esf-pnl-${key}">
    <div class="as-pnl-preview-hdr">Tahmini PnL Önizleme</div>
    <div class="as-pnl-row"><span>Referans Giriş (Min Giriş)</span><span class="as-pnl-val" id="esf-pnl-entry-${key}">—</span></div>
    <div class="as-pnl-row"><span>Tahmini Hisse</span><span class="as-pnl-val" id="esf-pnl-shares-${key}">—</span></div>
    <div class="as-pnl-row profit"><span>TP'de Tahmini Kâr</span><span class="as-pnl-val" id="esf-pnl-tp-${key}">—</span></div>
    <div class="as-pnl-row loss"><span>SL'de Tahmini Zarar</span><span class="as-pnl-val" id="esf-pnl-sl-${key}">—</span></div>
    <div class="as-pnl-row note"><span>* Gerçek fill/slippage farklı olabilir</span></div>
  </div>`;

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
  ${pnlPreviewHTML}
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

// ─── Input validation + PnL preview ─────────────────────────────────────────

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

  // PnL önizleme güncelle
  const _v = id => parseFloat(document.getElementById(`esf-${key}-${id}`)?.value) || 0;
  const amt      = _v('order_amount');
  const tpPct    = _v('target_exit_pct');
  const slPct    = _v('stop_loss_pct');
  const minEntry = _v('min_entry_price');
  const refEntry = minEntry > 0 ? minEntry / 100 : 0;
  if (amt > 0 && tpPct > 0 && slPct > 0 && refEntry > 0) {
    const shares  = amt / refEntry;
    const tpExit  = Math.min(1.0, refEntry * (1 + tpPct / 100));
    const slExit  = Math.max(0.01, refEntry * (1 - slPct / 100));
    const tpPnl   = shares * tpExit - amt;
    const slPnl   = shares * slExit - amt;
    const $ = id => document.getElementById(id);
    const e = $(`esf-pnl-entry-${key}`);   if (e)  e.textContent  = `${(refEntry*100).toFixed(0)}%`;
    const sh = $(`esf-pnl-shares-${key}`); if (sh) sh.textContent = shares.toFixed(4);
    const tp = $(`esf-pnl-tp-${key}`);     if (tp) tp.textContent = `+$${tpPnl.toFixed(4)}`;
    const sl = $(`esf-pnl-sl-${key}`);     if (sl) sl.textContent = `-$${Math.abs(slPnl).toFixed(4)}`;
  }
}

// ─── Confirm Popup ────────────────────────────────────────────────────────────

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

// ─── Save / Clear ─────────────────────────────────────────────────────────────

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
    // Modal her zaman % tabanlı — strategy_mode: PERCENT ekle
    const bodyToSend = { ...payload, strategy_mode: 'PERCENT' };
    const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(bodyToSend),
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
