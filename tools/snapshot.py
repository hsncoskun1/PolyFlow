"""
POLYFLOW — Sistem Durumu Snapshot Aracı
Kullanım: python tools/snapshot.py [--label "restart_oncesi"]

6 kanıt noktasını tek çalıştırmada docs/snapshots/ altına yazar:
  1. positions tablosu (önce/sonra karşılaştırması için)
  2. Yüklenen pozisyon state detayları (entry_actual, shares, fill_confirmed, order_id)
  3. audit_log son 50 kayıt
  4. session_pnl + bot_state (safe_mode dahil)
  5. reconciler logları (backend.log'dan filtrele)
  6. Genel sistem özeti

Çıktı: docs/snapshots/snapshot_YYYYMMDD_HHMMSS_<label>.txt
"""
import sys
import os
import sqlite3
import json
import re
import argparse
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent.parent
DB_PATH = ROOT / "bot.db"
LOG_PATH = ROOT / "backend.log"
SNAPSHOT_DIR = ROOT / "docs" / "snapshots"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

# ─── Argümanlar ───────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="POLYFLOW sistem snapshot")
parser.add_argument("--label", default="", help="Snapshot etiketi (örn: restart_oncesi)")
args = parser.parse_args()

label = args.label.replace(" ", "_") if args.label else "manual"
ts = datetime.now().strftime("%Y%m%d_%H%M%S")
filename = f"snapshot_{ts}_{label}.txt"
out_path = SNAPSHOT_DIR / filename

lines = []


def h(title: str):
    lines.append("")
    lines.append("=" * 70)
    lines.append(f"  {title}")
    lines.append("=" * 70)


def row_fmt(d: dict, fields: list, indent: int = 4) -> str:
    pad = " " * indent
    parts = []
    for f in fields:
        v = d.get(f, "—")
        parts.append(f"{f}={v}")
    return pad + " | ".join(parts)


# ─── Header ──────────────────────────────────────────────────────────────────
lines.append(f"POLYFLOW Sistem Snapshot")
lines.append(f"Oluşturulma: {datetime.now().isoformat()}")
lines.append(f"Etiket: {label}")
lines.append(f"DB: {DB_PATH}")


# ─── 1. Positions Tablosu ─────────────────────────────────────────────────────
h("1. POSITIONS TABLOSU (tüm kayıtlar, son 50)")

if not DB_PATH.exists():
    lines.append("  [UYARI] bot.db bulunamadı!")
else:
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM positions ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
        conn.close()

        if not rows:
            lines.append("  (kayıt yok)")
        else:
            lines.append(f"  Toplam gösterilen: {len(rows)}")
            lines.append("")
            header_fields = ["id", "asset", "side", "status", "mode", "entry_price",
                             "current_price", "target_price", "stop_loss",
                             "amount", "shares", "pnl",
                             "fill_confirmed", "order_id", "condition_id",
                             "entry_time", "close_time", "close_reason"]
            for r in rows:
                d = dict(r)
                lines.append(f"  ─ {d.get('id', '?')} [{d.get('status','?')}] {d.get('asset','')} {d.get('side','')} @ {d.get('entry_price',0):.4f}")
                lines.append(f"    amount=${d.get('amount',0):.2f}  shares={d.get('shares',0):.6f}  pnl={d.get('pnl',0):.4f}")
                lines.append(f"    fill_confirmed={d.get('fill_confirmed',0)}  order_id='{d.get('order_id','')}'")
                lines.append(f"    condition_id='{d.get('condition_id','')}'  mode={d.get('mode','')}")
                lines.append(f"    entry_time={d.get('entry_time','')}  close_time={d.get('close_time','')}")
                if d.get('close_reason'):
                    lines.append(f"    close_reason={d.get('close_reason')}")
                lines.append("")
    except Exception as e:
        lines.append(f"  [HATA] {e}")


# ─── 2. OPEN Pozisyon State Detayları ─────────────────────────────────────────
h("2. OPEN POZİSYON STATE DETAYLARI (fill/order kritik alanlar)")

if DB_PATH.exists():
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        open_rows = conn.execute(
            "SELECT id, asset, event_key, side, entry_price, shares, "
            "fill_confirmed, order_id, condition_id, amount, target_price, "
            "stop_loss, mode FROM positions WHERE status='OPEN'"
        ).fetchall()
        conn.close()

        confirmed = sum(1 for r in open_rows if r["fill_confirmed"])
        lines.append(f"  Açık pozisyon: {len(open_rows)}  (fill_confirmed: {confirmed}/{len(open_rows)})")
        lines.append("")

        for r in open_rows:
            d = dict(r)
            fill_ok   = "✓" if d.get("fill_confirmed") else "✗"
            order_ok  = "✓" if d.get("order_id")       else "✗"
            cond_ok   = "✓" if d.get("condition_id")   else "✗"
            shares_ok = "✓" if (d.get("shares") or 0) > 0 else "✗"

            lines.append(f"  {d['id']} — {d['asset']} {d['side']} @ {d['entry_price']:.4f} [{d['mode']}]")
            lines.append(f"    fill_confirmed:{fill_ok}  order_id:{order_ok}  condition_id:{cond_ok}  shares:{shares_ok}")
            lines.append(f"    shares={d.get('shares',0):.6f} / amount=${d.get('amount',0):.2f}")
            lines.append(f"    target={d.get('target_price',0):.4f}  stop={d.get('stop_loss',0):.4f}")
            lines.append(f"    event_key={d.get('event_key','')}")
            lines.append(f"    order_id='{d.get('order_id','')}'")
            lines.append(f"    condition_id='{d.get('condition_id','')}'")
            lines.append("")
    except Exception as e:
        lines.append(f"  [HATA] {e}")


# ─── 3. Audit Log Son 50 Kayıt ────────────────────────────────────────────────
h("3. AUDIT LOG (son 50 karar)")

if DB_PATH.exists():
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        audit_rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT 50"
        ).fetchall()

        # İstatistik
        stats_rows = conn.execute(
            "SELECT decision, COUNT(*) as cnt FROM audit_log GROUP BY decision"
        ).fetchall()
        conn.close()

        stats = {r["decision"]: r["cnt"] for r in stats_rows}
        lines.append(f"  İstatistik: {json.dumps(stats, ensure_ascii=False)}")
        lines.append("")

        if not audit_rows:
            lines.append("  (kayıt yok)")
        else:
            for r in audit_rows:
                d = dict(r)
                pnl_str = f"  pnl={d['pnl']:.4f}" if d.get("pnl") else ""
                lines.append(
                    f"  [{d.get('timestamp','')[:19]}] {d.get('decision','?'):20s} "
                    f"{d.get('event_key',''):12s}  {d.get('reason','')}"
                    f"{pnl_str}"
                )
    except Exception as e:
        lines.append(f"  [HATA] {e}")


# ─── 4. Bot State (safe_mode, session_pnl vb.) ────────────────────────────────
h("4. BOT STATE (safe_mode, session_pnl, diğer kalıcı değerler)")

if DB_PATH.exists():
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        state_rows = conn.execute(
            "SELECT key, value, updated_at FROM bot_state ORDER BY key"
        ).fetchall()
        conn.close()

        if not state_rows:
            lines.append("  (kayıt yok — bot hiç çalışmamış olabilir)")
        else:
            for r in state_rows:
                lines.append(f"  {r['key']:30s} = {r['value']}  (güncelleme: {r['updated_at']})")
    except Exception as e:
        lines.append(f"  [HATA] {e}")


# ─── 5. Trades Özeti ──────────────────────────────────────────────────────────
h("5. TRADES (son 20 kapanmış trade)")

if DB_PATH.exists():
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        trade_rows = conn.execute(
            "SELECT * FROM trades ORDER BY created_at DESC LIMIT 20"
        ).fetchall()

        # Günlük istatistik
        from datetime import date
        today = date.today().isoformat()
        daily = conn.execute(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(pnl),0) as total_pnl "
            "FROM trades WHERE date(created_at)=?", (today,)
        ).fetchone()
        conn.close()

        lines.append(f"  Bugün: {daily['cnt']} trade  toplam PnL={daily['total_pnl']:.4f}")
        lines.append("")

        if not trade_rows:
            lines.append("  (kayıt yok)")
        else:
            for r in trade_rows:
                d = dict(r)
                pnl_sign = "+" if (d.get("pnl") or 0) >= 0 else ""
                lines.append(
                    f"  {d.get('id','?'):18s} {d.get('asset',''):4s} {d.get('side',''):4s}  "
                    f"entry={d.get('entry_price',0):.4f} → exit={d.get('exit_price',0):.4f}  "
                    f"PnL={pnl_sign}{d.get('pnl',0):.4f}  [{d.get('status','')}] [{d.get('mode','')}]"
                )
    except Exception as e:
        lines.append(f"  [HATA] {e}")


# ─── 6. Reconciler + sell_retry + Error Logları ───────────────────────────────
h("6. LOG FİLTRESİ (reconciler / sell_retry / error — son 200 satır)")

if LOG_PATH.exists():
    try:
        with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            log_lines = f.readlines()

        # Son 2000 satırdan filtrele
        recent = log_lines[-2000:]
        keywords = ["reconcil", "sell_retry", "HOLD_TO_RESOLUTION",
                    "RECONCILE", "fill_confirm", "ERROR", "HATA",
                    "Pozisyon açıldı", "Pozisyon kapandı", "safe_mode",
                    "FORCE_SELL", "STOP_LOSS"]

        filtered = [
            l.rstrip() for l in recent
            if any(k.lower() in l.lower() for k in keywords)
        ]

        lines.append(f"  Eşleşen satır sayısı: {len(filtered)} (son 2000'den)")
        lines.append("")
        for l in filtered[-100:]:  # En fazla 100 satır
            lines.append(f"  {l}")
    except Exception as e:
        lines.append(f"  [HATA] {e}")
else:
    lines.append(f"  [UYARI] backend.log bulunamadı: {LOG_PATH}")


# ─── 7. Genel Özet ────────────────────────────────────────────────────────────
h("7. GENEL ÖZET")

if DB_PATH.exists():
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row

        open_count     = conn.execute("SELECT COUNT(*) FROM positions WHERE status='OPEN'").fetchone()[0]
        total_pos      = conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
        total_trades   = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
        total_audit    = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
        safe_mode_val  = conn.execute("SELECT value FROM bot_state WHERE key='safe_mode'").fetchone()
        session_pnl    = conn.execute("SELECT value FROM bot_state WHERE key='session_pnl'").fetchone()

        conn.close()

        safe_str = safe_mode_val["value"] if safe_mode_val else "—"
        pnl_str  = session_pnl["value"]   if session_pnl  else "—"

        lines.append(f"  Açık pozisyon:  {open_count}")
        lines.append(f"  Toplam position kaydı: {total_pos}")
        lines.append(f"  Toplam trade:   {total_trades}")
        lines.append(f"  Audit log kaydı: {total_audit}")
        lines.append(f"  safe_mode:      {safe_str}")
        lines.append(f"  session_pnl:    {pnl_str}")
        lines.append(f"  DB boyutu:      {DB_PATH.stat().st_size // 1024} KB")
    except Exception as e:
        lines.append(f"  [HATA] {e}")

lines.append("")
lines.append(f"Snapshot tamamlandı: {out_path}")
lines.append("")


# ─── Dosyaya yaz + terminale yazdır ──────────────────────────────────────────
output = "\n".join(lines)

with open(out_path, "w", encoding="utf-8") as f:
    f.write(output)

print(output)
print(f"\n[KAYDEDILDI] {out_path}")
