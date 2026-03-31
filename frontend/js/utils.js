/**
 * utils.js — Saf yardımcı fonksiyonlar (state bağımlılığı yok)
 * app.js'den önce yüklenir.
 */

// ─── Key helpers ─────────────────────────────────────────────────────────────

/** Extract base symbol from sym_tf key (e.g. "BTC_5M" → "BTC") */
function baseSym(key) { return key.includes('_') ? key.split('_')[0] : key; }

/** Extract timeframe from sym_tf key (e.g. "BTC_5M" → "5M") */
function keyTF(key) { return key.includes('_') ? key.split('_').slice(1).join('_') : '5M'; }

// ─── Format helpers ───────────────────────────────────────────────────────────

/** Format countdown seconds into compact string: 4:32, 1h12m, 23h05m */
function fmtCD(cd) {
  if (cd <= 0) return '0:00';
  if (cd < 3600) { const m = Math.floor(cd/60); return `${m}:${String(cd%60).padStart(2,'0')}`; }
  const h = Math.floor(cd/3600); const m = Math.floor((cd%3600)/60);
  return `${h}h${String(m).padStart(2,'0')}m`;
}

/** Format a number as USD string (e.g. 12.5 → "$12.50", -3 → "-$3.00") */
function formatUSD(val) {
  let n = Number(val) || 0;
  if (!isFinite(n)) n = 0;
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

/** Format asset spot price with appropriate decimal places */
function formatAssetPrice(sym, price) {
  let p = Number(price) || 0;
  if (!isFinite(p)) p = 0;
  if (p >= 1000) return `$${p.toLocaleString('en', {maximumFractionDigits:2})}`;
  if (p >= 1)    return `$${p.toFixed(3)}`;
  return `$${p.toFixed(5)}`;
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/** Set textContent of element by id (no-op if not found) */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/** Read numeric value from input element by id */
function numVal(id) { return parseFloat(document.getElementById(id)?.value || '0'); }

/** Read checkbox state from element by id */
function checkVal(id) { return document.getElementById(id)?.checked || false; }

// ─── Toast notification ───────────────────────────────────────────────────────

/** Show a transient toast notification at bottom-right */
function showToast(message, type = 'info') {
  const colors = {
    info:    'var(--accent-blue)',
    success: 'var(--accent-green)',
    warn:    'var(--accent-yellow)',
    error:   'var(--accent-red)',
  };
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;
    background:var(--bg-card);border:1px solid ${colors[type] || colors.info};
    color:var(--text-primary);padding:12px 18px;border-radius:var(--radius-md);
    font-size:13px;box-shadow:var(--shadow-popup);animation:fade-in 0.2s ease;max-width:320px;`;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
