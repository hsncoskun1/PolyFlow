/**
 * positions.js — Pozisyon ve trade geçmişi sayfa render
 *
 * Global scope'tan kullanılan:
 *   state, _historyFilter — app.js
 * Çağrılan fonksiyonlar:
 *   formatUSD — utils.js
 *   closePosition — app.js
 */
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
