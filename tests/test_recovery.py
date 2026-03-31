"""
POLYFLOW — Restart Recovery Test
Çalıştırma: python -m pytest tests/test_recovery.py -v
veya: python tests/test_recovery.py

Doğrulananlar:
  1. fill_confirmed, order_id, shares, entry_actual DB'ye kaydedilip geri yükleniyor mu?
  2. load_open_positions_from_db() sonrası _positions dict doğru doldu mu?
  3. Duplicate yükleme — iki kez çağırınca aynı trade_id eklenmez.
  4. safe_mode DB'den doğru yükleniyor mu?
  5. Bot restart sonrası entry_lock temiz (duplicate entry yok).
  6. Bozuk satır (eksik alan) sistemi çökertiyor mu? (graceful skip)
  7. fill_confirmed=False pozisyon da yükleniyor (reconciler için).
  8. update_position_fill sonrası DB'deki değerler güncellendi mi?
"""
import sys
import os
import sqlite3
import uuid

sys.stdout.reconfigure(encoding="utf-8")

# Proje kökünü path'e ekle
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

# Test DB — gerçek bot.db'ye dokunmaz
TEST_DB = os.path.join(ROOT, "test_recovery.db")
os.environ["POLYFLOW_TEST_DB"] = TEST_DB  # db.py bu env var'ı okuyorsa kullanır

# ─── db modülünü test DB ile yeniden bağla ─────────────────────────────────────
import importlib
import backend.storage.db as db_mod

# Monkey-patch: DB_PATH'i test DB'ye çevir
from pathlib import Path
db_mod.DB_PATH = Path(TEST_DB)
db_mod.init_db()  # tabloları oluştur / migrate et

# position_tracker'ı da temiz başlat
import backend.execution.position_tracker as pt
pt._positions.clear()  # in-memory temizle

# ─── Renk kodları (terminal çıktısı) ──────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
RESET  = "\033[0m"

PASS = f"{GREEN}[PASS]{RESET}"
FAIL = f"{RED}[FAIL]{RESET}"
INFO = f"{YELLOW}[INFO]{RESET}"

results = []


def check(name: str, condition: bool, detail: str = ""):
    tag = PASS if condition else FAIL
    msg = f"  {tag} {name}"
    if detail:
        msg += f"  ({detail})"
    print(msg)
    results.append((name, condition))


def section(title: str):
    print(f"\n{'─'*60}")
    print(f"  {title}")
    print(f"{'─'*60}")


# ─── Test 1: save_position + update_position_fill + get_open_positions ─────────

section("TEST 1 — DB Kaydet / Güncelle / Yükle")

tid1 = f"pf_{uuid.uuid4().hex[:10]}"

# 1a. Pozisyonu DB'ye kaydet (fill_confirmed=False başlangıç)
db_mod.save_position({
    "id":            tid1,
    "asset":         "BTC",
    "event_key":     "BTC_5M",
    "event_slug":    "btc-above-50k",
    "side":          "UP",
    "entry_price":   0.85,
    "current_price": 0.85,
    "target_price":  0.90,
    "stop_loss":     0.80,
    "amount":        10.0,
    "shares":        11.764706,
    "pnl":           0.0,
    "status":        "OPEN",
    "mode":          "PAPER",
    "order_id":      "",
    "fill_confirmed": False,
    "condition_id":  "cond_abc123",
    "entry_time":    "2026-01-01T12:00:00",
})

rows = db_mod.get_open_positions()
check("save_position DB'ye yazdı", any(r["id"] == tid1 for r in rows))

# 1b. Fill confirmation geldi → DB güncelle
db_mod.update_position_fill(tid1, "ord_xyz789", True, 11.765)

rows = db_mod.get_open_positions()
row = next((r for r in rows if r["id"] == tid1), None)
check("update_position_fill — order_id kaydedildi",
      row is not None and row.get("order_id") == "ord_xyz789",
      f"order_id={row.get('order_id') if row else 'ROW_NOT_FOUND'}")
check("update_position_fill — fill_confirmed=1",
      row is not None and bool(row.get("fill_confirmed")) is True,
      f"fill_confirmed={row.get('fill_confirmed') if row else '?'}")
check("update_position_fill — shares güncellendi",
      row is not None and abs(row.get("shares", 0) - 11.765) < 0.001,
      f"shares={row.get('shares') if row else '?'}")


# ─── Test 2: load_open_positions_from_db — in-memory yükleme ──────────────────

section("TEST 2 — load_open_positions_from_db")

pt._positions.clear()
pt.load_open_positions_from_db()

loaded = pt.get_all_positions()
check("Pozisyon in-memory'e yüklendi",
      any(p.trade_id == tid1 for p in loaded),
      f"{len(loaded)} pozisyon yüklendi")

pos = next((p for p in loaded if p.trade_id == tid1), None)
check("entry_actual doğru geri yüklendi",
      pos is not None and abs(pos.entry_actual - 0.85) < 0.001,
      f"entry_actual={pos.entry_actual if pos else '?'}")
check("order_id doğru geri yüklendi",
      pos is not None and pos.order_id == "ord_xyz789",
      f"order_id={pos.order_id if pos else '?'}")
check("fill_confirmed=True geri yüklendi",
      pos is not None and pos.fill_confirmed is True,
      f"fill_confirmed={pos.fill_confirmed if pos else '?'}")
check("shares doğru geri yüklendi",
      pos is not None and abs(pos.shares - 11.765) < 0.001,
      f"shares={pos.shares if pos else '?'}")
check("condition_id doğru geri yüklendi",
      pos is not None and pos.condition_id == "cond_abc123",
      f"condition_id={pos.condition_id if pos else '?'}")
check("exit_target doğru geri yüklendi",
      pos is not None and abs(pos.exit_target - 0.90) < 0.001,
      f"exit_target={pos.exit_target if pos else '?'}")
check("stop_loss_price doğru geri yüklendi",
      pos is not None and abs(pos.stop_loss_price - 0.80) < 0.001,
      f"stop_loss_price={pos.stop_loss_price if pos else '?'}")
check("event_slug doğru geri yüklendi",
      pos is not None and pos.event_slug == "btc-above-50k",
      f"event_slug={pos.event_slug if pos else '?'}")


# ─── Test 3: Duplicate yükleme ────────────────────────────────────────────────

section("TEST 3 — Duplicate Yükleme Koruması")

count_before = len(pt._positions)
pt.load_open_positions_from_db()  # İkinci kez çağır
count_after = len(pt._positions)

check("İkinci load_open_positions_from_db duplicate eklemez",
      count_before == count_after,
      f"önce={count_before}, sonra={count_after}")


# ─── Test 4: fill_confirmed=False pozisyon (reconciler için) ──────────────────

section("TEST 4 — fill_confirmed=False Pozisyon Yükleme")

tid2 = f"pf_{uuid.uuid4().hex[:10]}"
db_mod.save_position({
    "id":            tid2,
    "asset":         "ETH",
    "event_key":     "ETH_5M",
    "event_slug":    "eth-above-3k",
    "side":          "UP",
    "entry_price":   0.88,
    "current_price": 0.88,
    "target_price":  0.94,
    "stop_loss":     0.82,
    "amount":        5.0,
    "shares":        0.0,   # Fill olmamış → shares 0
    "pnl":           0.0,
    "status":        "OPEN",
    "mode":          "PAPER",
    "order_id":      "",
    "fill_confirmed": False,
    "condition_id":  "cond_def456",
    "entry_time":    "2026-01-01T12:05:00",
})

pt._positions.clear()
pt.load_open_positions_from_db()

pos2 = next((p for p in pt.get_all_positions() if p.trade_id == tid2), None)
check("fill_confirmed=False pozisyon yüklendi",
      pos2 is not None,
      f"pos2={'bulundu' if pos2 else 'BULUNAMADI'}")
check("fill_confirmed=False pozisyon → fill_confirmed False",
      pos2 is not None and pos2.fill_confirmed is False)
# shares=0 iken entry>0 → load fonksiyonu hesaplamalı
check("shares=0 + entry>0 → hesaplanarak geri yüklendi",
      pos2 is not None and pos2.shares > 0,
      f"shares={pos2.shares if pos2 else '?'}")


# ─── Test 5: safe_mode DB persistence ─────────────────────────────────────────

section("TEST 5 — safe_mode DB Kalıcılığı")

db_mod.set_bot_state("safe_mode", "true")
val = db_mod.get_bot_state("safe_mode", "false")
check("safe_mode=true DB'ye yazıldı ve okundu", val == "true", f"value='{val}'")

db_mod.set_bot_state("safe_mode", "false")
val = db_mod.get_bot_state("safe_mode", "false")
check("safe_mode=false DB'ye güncellendi", val == "false", f"value='{val}'")

# Simüle: Bot restart — bot_state tablosundan safe_mode oku
db_mod.set_bot_state("safe_mode", "true")
# main.py'deki lifespan kodunu simüle et
sm_raw = db_mod.get_bot_state("safe_mode", "false")
simulated_safe_mode = sm_raw == "true"
check("Restart sonrası safe_mode=True olarak yüklendi",
      simulated_safe_mode is True,
      f"DB value='{sm_raw}', parsed={simulated_safe_mode}")

# Temizle
db_mod.set_bot_state("safe_mode", "false")


# ─── Test 6: Entry lock — restart sonrası temiz ───────────────────────────────

section("TEST 6 — Entry Lock Restart Temizliği")

from backend.execution.entry_service import _entry_locks, lock_event, is_event_locked, unlock_event

lock_event("BTC_5M")
check("lock_event çalışıyor", is_event_locked("BTC_5M"))

# In-memory lock — restart'ı simüle et: _entry_locks dict temizlenir
_entry_locks.clear()
check("Restart (clear) sonrası lock gitti",
      not is_event_locked("BTC_5M"))


# ─── Test 7: Bozuk satır — graceful skip ──────────────────────────────────────

section("TEST 7 — Bozuk DB Satırı Graceful Skip")

# Eksik alan içeren bir satır doğrudan DB'ye yaz
conn = sqlite3.connect(str(db_mod.DB_PATH))
conn.row_factory = sqlite3.Row
tid3 = f"pf_{uuid.uuid4().hex[:10]}"
try:
    conn.execute(
        "INSERT INTO positions (id, asset, status) VALUES (?, ?, ?)",
        (tid3, "BTC", "OPEN")
    )
    conn.commit()
except Exception as e:
    print(f"  {INFO} Bozuk satır insert hatası (beklenen): {e}")
finally:
    conn.close()

prev_count = len(pt._positions)
try:
    pt._positions.clear()
    pt.load_open_positions_from_db()
    check("Bozuk satır sistemi çökertmedi", True)
    # Bozuk satır yüklenmeyebilir (entry_price=0) — sistem çökmemeli yeter
    print(f"  {INFO} {len(pt._positions)} pozisyon yüklendi (bozuk satır atlandı/yüklendi)")
except Exception as e:
    check("Bozuk satır sistemi çökertmedi", False, str(e))


# ─── Test 8: close_position → get_open_positions'da görünmemeli ───────────────

section("TEST 8 — Kapatılan Pozisyon Yüklenmez")

# tid1'i kapat
db_mod.close_position(tid1, 0.91, "TP")

pt._positions.clear()
pt.load_open_positions_from_db()

closed_in_memory = any(p.trade_id == tid1 for p in pt.get_all_positions())
check("Kapatılan pozisyon in-memory'e yüklenmedi",
      not closed_in_memory,
      f"closed_in_memory={closed_in_memory}")


# ─── Test 9: session_pnl callback ─────────────────────────────────────────────

section("TEST 9 — Session PnL Callback")

session_pnl_acc = []

def mock_close_callback(trade_id, pnl, reason):
    session_pnl_acc.append((trade_id, pnl, reason))

pt.set_close_callback(mock_close_callback)

# Yeni test pozisyonu aç ve kapat
tid4 = f"pf_{uuid.uuid4().hex[:10]}"
db_mod.save_position({
    "id": tid4, "asset": "BTC", "event_key": "BTC_5M",
    "event_slug": "test", "side": "UP",
    "entry_price": 0.90, "current_price": 0.90,
    "target_price": 0.95, "stop_loss": 0.85,
    "amount": 10.0, "shares": 11.11, "pnl": 0.0,
    "status": "OPEN", "mode": "PAPER",
    "order_id": "", "fill_confirmed": False,
    "condition_id": "", "entry_time": "2026-01-01T13:00:00",
})
pt._positions.clear()
pt.load_open_positions_from_db()

closed = pt.close_position(tid4, 0.95, "TP")
check("close_position callback çağrıldı",
      len(session_pnl_acc) == 1,
      f"callback çağrı sayısı={len(session_pnl_acc)}")
if session_pnl_acc:
    _, pnl, reason = session_pnl_acc[0]
    check("Callback doğru reason aldı", reason == "TP", f"reason={reason}")
    check("Callback PnL pozitif (TP @ 0.95 > 0.90)", pnl > 0, f"pnl={pnl:.4f}")

pt.set_close_callback(None)


# ─── Özet ─────────────────────────────────────────────────────────────────────

section("SONUÇLAR")
total   = len(results)
passed  = sum(1 for _, ok in results if ok)
failed  = total - passed

print(f"\n  Toplam: {total} | {GREEN}Geçti: {passed}{RESET} | {RED}Kaldı: {failed}{RESET}\n")

if failed:
    print(f"  {RED}Başarısız testler:{RESET}")
    for name, ok in results:
        if not ok:
            print(f"    - {name}")
    print()

# Temizlik: test DB sil
try:
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
        print(f"  {INFO} Test DB silindi: {TEST_DB}")
except Exception:
    pass

sys.exit(0 if failed == 0 else 1)
