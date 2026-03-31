"""
POLYFLOW — Snapshot Karşılaştırma Aracı
Kullanım:
  python tools/diff_snapshots.py snapshot_A.txt snapshot_B.txt
  python tools/diff_snapshots.py --latest 2          # son 2 snapshotı karşılaştır
  python tools/diff_snapshots.py --label-a restart_oncesi --label-b restart_sonrasi

Çıktı:
  - Pozisyon değişiklikleri (alan bazında)
  - Audit log farkı (yeni kararlar)
  - Bot state değişiklikleri
  - Trade sayısı / PnL delta
  - Özet: ne değişti, ne aynı kaldı
"""
import sys
import os
import re
import argparse
from pathlib import Path
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).parent.parent
SNAP_DIR = ROOT / "docs" / "snapshots"

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
DIM    = "\033[2m"
RESET  = "\033[0m"

# ─── Argümanlar ───────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="POLYFLOW snapshot diff")
parser.add_argument("files", nargs="*", help="İki snapshot dosyası (tam yol veya sadece dosya adı)")
parser.add_argument("--latest", type=int, default=0, metavar="N",
                    help="Son N snapshotı karşılaştır (varsayılan: 2)")
parser.add_argument("--label-a", default="", help="A snapshot etiketi")
parser.add_argument("--label-b", default="", help="B snapshot etiketi")
args = parser.parse_args()


def resolve_snap(name: str) -> Path:
    p = Path(name)
    if p.exists():
        return p
    candidate = SNAP_DIR / name
    if candidate.exists():
        return candidate
    # Etiketle ara
    matches = sorted(SNAP_DIR.glob(f"*_{name}.txt"))
    if matches:
        return matches[-1]
    raise FileNotFoundError(f"Snapshot bulunamadı: {name}")


def get_latest_snapshots(n: int = 2) -> list[Path]:
    snaps = sorted(SNAP_DIR.glob("snapshot_*.txt"))
    if len(snaps) < n:
        raise ValueError(f"Yeterli snapshot yok ({len(snaps)} < {n}). Önce snapshot al.")
    return snaps[-n:]


# Dosyaları belirle
if args.latest or (not args.files and not args.label_a):
    n = args.latest if args.latest >= 2 else 2
    snap_a, snap_b = get_latest_snapshots(n)[0], get_latest_snapshots(n)[-1]
elif args.label_a and args.label_b:
    snap_a = resolve_snap(args.label_a)
    snap_b = resolve_snap(args.label_b)
elif len(args.files) == 2:
    snap_a = resolve_snap(args.files[0])
    snap_b = resolve_snap(args.files[1])
else:
    parser.print_help()
    sys.exit(1)


# ─── Parser: snapshot dosyasından bölümleri çıkar ────────────────────────────

def parse_snapshot(path: Path) -> dict:
    """
    Snapshot dosyasını bölümlere ayır.
    Bölüm key'i: tam başlık satırı lowercase (sayı + parantez dahil)
    Örn: "1. positions tablosu (tüm kayıtlar, son 50)"
    Döner: {section_name: [satır listesi]}
    """
    sections = {}
    current = "header"
    sections[current] = []

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip()
            if "======" in line:
                continue
            # Bölüm başlığı: "  1. BAŞLIK (açıklama)" formatında
            m = re.match(r"^\s+(\d+\.\s+.+)$", line)
            if m and len(line.strip()) > 4:
                current = re.sub(r"\s+", " ", line.strip()).lower()
                sections[current] = []
            else:
                sections.setdefault(current, []).append(line)

    return sections


def extract_positions(snap_lines: list[str]) -> dict:
    """
    Pozisyon satırlarından {trade_id: {field: value}} çıkar.
    """
    positions = {}
    current_id = None
    for line in snap_lines:
        # ─ pf_xxxx [OPEN] BTC UP @ 0.8500
        m = re.match(r"\s+─\s+(pf_\w+)\s+\[(\w+)\]", line)
        if m:
            current_id = m.group(1)
            positions[current_id] = {"status": m.group(2)}
            # entry price
            ep = re.search(r"@\s+([\d.]+)", line)
            if ep:
                positions[current_id]["entry_price"] = ep.group(1)
        elif current_id:
            # shares, amount, pnl
            s = re.search(r"shares=([\d.]+)", line)
            if s:
                positions[current_id]["shares"] = s.group(1)
            a = re.search(r"amount=\$([\d.]+)", line)
            if a:
                positions[current_id]["amount"] = a.group(1)
            p = re.search(r"pnl=([-\d.]+)", line)
            if p:
                positions[current_id]["pnl"] = p.group(1)
            fc = re.search(r"fill_confirmed=(\d+)", line)
            if fc:
                positions[current_id]["fill_confirmed"] = fc.group(1)
            oid = re.search(r"order_id='([^']*)'", line)
            if oid:
                positions[current_id]["order_id"] = oid.group(1)
            cid = re.search(r"condition_id='([^']*)'", line)
            if cid:
                positions[current_id]["condition_id"] = cid.group(1)
    return positions


def extract_open_state(snap_lines: list[str]) -> dict:
    """
    Section 2 (open pozisyon state) → {trade_id: {fill_confirmed, order_id, shares, condition_id}}
    """
    state = {}
    current_id = None
    for line in snap_lines:
        m = re.match(r"\s+(pf_\w+)\s+—", line)
        if m:
            current_id = m.group(1)
            state[current_id] = {}
        elif current_id:
            fc  = re.search(r"fill_confirmed:([✓✗])", line)
            oid = re.search(r"order_id:([✓✗])", line)
            sh  = re.search(r"shares:([✓✗])", line)
            if fc:  state[current_id]["fill_confirmed_ok"] = fc.group(1)
            if oid: state[current_id]["order_id_ok"] = oid.group(1)
            if sh:  state[current_id]["shares_ok"] = sh.group(1)

            sv  = re.search(r"shares=([\d.]+)", line)
            if sv: state[current_id]["shares"] = sv.group(1)

            oidv = re.search(r"order_id='([^']*)'", line)
            if oidv: state[current_id]["order_id"] = oidv.group(1)

            cidv = re.search(r"condition_id='([^']*)'", line)
            if cidv: state[current_id]["condition_id"] = cidv.group(1)
    return state


def extract_audit_log(snap_lines: list[str]) -> list[str]:
    """Audit log satırlarını çıkar (timestamp dahil)."""
    entries = []
    for line in snap_lines:
        m = re.match(r"\s+\[(\d{4}-\d{2}-\d{2}T[\d:]+)\]\s+(\S+)\s+(\S+)\s*(.*)", line)
        if m:
            entries.append(f"[{m.group(1)}] {m.group(2)} {m.group(3)} {m.group(4)}".strip())
    return entries


def extract_bot_state(snap_lines: list[str]) -> dict:
    """bot_state satırlarını {key: value} olarak çıkar."""
    state = {}
    for line in snap_lines:
        m = re.match(r"\s+(\w+)\s+=\s+(\S+)", line)
        if m:
            state[m.group(1)] = m.group(2)
    return state


def extract_trade_summary(snap_lines: list[str]) -> dict:
    """Trades bölümünden bugün/toplam özetini çıkar."""
    for line in snap_lines:
        m = re.match(r"\s+Bugün:\s+(\d+)\s+trade\s+toplam PnL=([-\d.]+)", line)
        if m:
            return {"today_count": m.group(1), "today_pnl": m.group(2)}
    return {}


# ─── Verdict takip listeleri ─────────────────────────────────────────────────
# FAIL → pozisyon/state sapması, kritik kayıp, beklenmedik geçiş, error log
# WARN → yalnızca normal audit girişleri veya beklenen trade değişimleri
# PASS → hiçbir kritik fark yok

_fail_reasons: list[str] = []   # FAIL nedenleri
_warn_reasons: list[str] = []   # WARN nedenleri

# FAIL tetikleyen keyword'ler (log satırlarında)
_FAIL_LOG_KEYWORDS = [
    "ERROR", "HATA", "Traceback", "Exception",
    "RECONCILE_DISCREPANCY",
]
# WARN tetikleyen keyword'ler (FAIL olmayan ama dikkat isteyen)
_WARN_LOG_KEYWORDS = [
    "HOLD_TO_RESOLUTION", "FORCE_SELL", "STOP_LOSS",
    "Pozisyon kapandı",
]
# Beklenmedik status geçişleri (restart sırasında olmamalı)
_UNEXPECTED_STATUS = {"CLOSED", "STOP_LOSS", "FORCE_SELL", "HOLD_TO_RESOLUTION"}


# ─── Karşılaştır ──────────────────────────────────────────────────────────────

sa = parse_snapshot(snap_a)
sb = parse_snapshot(snap_b)

print(f"\n{CYAN}{'═'*70}{RESET}")
print(f"{CYAN}  POLYFLOW Snapshot Diff{RESET}")
print(f"{CYAN}{'═'*70}{RESET}")
print(f"  {DIM}A:{RESET} {snap_a.name}")
print(f"  {DIM}B:{RESET} {snap_b.name}")

ts_a = re.search(r"snapshot_(\d{8}_\d{6})", snap_a.name)
ts_b = re.search(r"snapshot_(\d{8}_\d{6})", snap_b.name)
if ts_a and ts_b:
    dt_a = datetime.strptime(ts_a.group(1), "%Y%m%d_%H%M%S")
    dt_b = datetime.strptime(ts_b.group(1), "%Y%m%d_%H%M%S")
    delta = abs((dt_b - dt_a).total_seconds())
    print(f"  {DIM}Ara:{RESET} {int(delta)}sn ({delta/60:.1f}dk)")


def section_header(title):
    print(f"\n  {YELLOW}── {title} {'─'*(55-len(title))}{RESET}")


def fail(reason: str):
    _fail_reasons.append(reason)


def warn(reason: str):
    _warn_reasons.append(reason)


# ─── 1. Pozisyon Değişiklikleri ───────────────────────────────────────────────
section_header("POZİSYONLAR")

pos_a = extract_positions(sa.get("1. positions tablosu (tüm kayıtlar, son 50)", []))
pos_b = extract_positions(sb.get("1. positions tablosu (tüm kayıtlar, son 50)", []))

all_ids = set(pos_a.keys()) | set(pos_b.keys())
if not all_ids:
    print(f"  {DIM}(pozisyon kaydı yok){RESET}")
else:
    for tid in sorted(all_ids):
        a = pos_a.get(tid)
        b = pos_b.get(tid)
        short = tid[-8:]

        if a is None:
            status_b = b.get("status", "?")
            print(f"  {GREEN}+{RESET} {tid} yeni eklendi — status={status_b}")
            # Yeni pozisyon açılması normaldir (WARN değil)
        elif b is None:
            print(f"  {RED}✗{RESET} {tid} A'da var, B'de kaybolmuş")
            fail(f"pozisyon kaybı: {short} (A'da var, B'de yok)")
        else:
            diffs = []
            for field in ["status", "shares", "fill_confirmed", "order_id", "condition_id", "pnl"]:
                va = a.get(field, "—")
                vb = b.get(field, "—")
                if va != vb:
                    diffs.append((field, va, vb))

            if diffs:
                print(f"  ~ {tid}")
                for field, va, vb in diffs:
                    # Değişim kritik mi?
                    is_critical = False

                    if field == "order_id" and va not in ("", "—") and vb in ("", "—"):
                        fail(f"{short}: order_id null'a düştü ({va} → boş)")
                        is_critical = True
                    elif field == "fill_confirmed" and va == "1" and vb == "0":
                        fail(f"{short}: fill_confirmed geriledi (1 → 0)")
                        is_critical = True
                    elif field == "shares":
                        try:
                            ratio = abs(float(vb) - float(va)) / max(float(va), 0.000001)
                            if ratio > 0.01:  # >%1 sapma
                                fail(f"{short}: shares sapması {va} → {vb} (%{ratio*100:.1f})")
                                is_critical = True
                        except (ValueError, ZeroDivisionError):
                            pass
                    elif field == "status" and vb in _UNEXPECTED_STATUS:
                        fail(f"{short}: beklenmedik status geçişi {va} → {vb}")
                        is_critical = True

                    color = RED if is_critical else GREEN
                    crit_tag = f" {RED}[KRİTİK]{RESET}" if is_critical else ""
                    print(f"    {field}: {RED}{va}{RESET} → {color}{vb}{RESET}{crit_tag}")
            else:
                print(f"  {DIM}= {tid} değişmedi{RESET}")


# ─── 2. Open Pozisyon State (kritik alanlar) ──────────────────────────────────
section_header("OPEN STATE (fill_confirmed / order_id / shares)")

os_a = extract_open_state(sa.get("2. open pozisyon state detayları (fill/order kritik alanlar)", []))
os_b = extract_open_state(sb.get("2. open pozisyon state detayları (fill/order kritik alanlar)", []))

if not os_a and not os_b:
    print(f"  {DIM}(open pozisyon yok){RESET}")
else:
    all_open = set(os_a.keys()) | set(os_b.keys())
    for tid in sorted(all_open):
        a = os_a.get(tid, {})
        b = os_b.get(tid, {})
        short = tid[-8:]
        diffs = []

        for field in ["fill_confirmed_ok", "order_id_ok", "shares_ok", "shares", "order_id", "condition_id"]:
            va = a.get(field, "—")
            vb = b.get(field, "—")
            if va != vb:
                diffs.append((field, va, vb))

        if diffs:
            print(f"  ~ {tid}")
            for field, va, vb in diffs:
                is_critical = False

                if field == "fill_confirmed_ok" and va == "✓" and vb == "✗":
                    fail(f"{short}: fill_confirmed geriledi (✓ → ✗)")
                    is_critical = True
                elif field == "order_id_ok" and va == "✓" and vb == "✗":
                    fail(f"{short}: order_id kayboldu (✓ → ✗)")
                    is_critical = True
                elif field == "shares_ok" and va == "✓" and vb == "✗":
                    fail(f"{short}: shares sıfırlandı (✓ → ✗)")
                    is_critical = True
                elif field == "shares":
                    try:
                        ratio = abs(float(vb) - float(va)) / max(float(va), 0.000001)
                        if ratio > 0.01:
                            fail(f"{short}: shares sapması {va} → {vb} (%{ratio*100:.1f})")
                            is_critical = True
                    except (ValueError, ZeroDivisionError):
                        pass

                color = RED if is_critical else (GREEN if vb == "✓" else YELLOW)
                crit_tag = f" {RED}[KRİTİK]{RESET}" if is_critical else ""
                print(f"    {field}: {RED}{va}{RESET} → {color}{vb}{RESET}{crit_tag}")
        else:
            fa = a.get("fill_confirmed_ok", "?")
            oa = a.get("order_id_ok", "?")
            sh = a.get("shares", "?")
            print(f"  {DIM}= {tid}  fill:{fa}  order:{oa}  shares:{sh}  — değişmedi{RESET}")


# ─── 3. Audit Log Farkı ───────────────────────────────────────────────────────
section_header("AUDİT LOG (yeni kararlar)")

al_a = set(extract_audit_log(sa.get("3. audit log (son 50 karar)", [])))
al_b = set(extract_audit_log(sb.get("3. audit log (son 50 karar)", [])))

new_entries = al_b - al_a
gone_entries = al_a - al_b

# Kritik audit kararları
_CRITICAL_AUDIT = {"RECONCILE_DISCREPANCY", "ORDER_REJECT"}
_WARN_AUDIT = {"HOLD_TO_RESOLUTION", "FORCE_SELL", "STOP_LOSS", "PARTIAL_FILL"}

if new_entries:
    for e in sorted(new_entries):
        decision_match = re.search(r"\] (\S+)\s+", e)
        decision = decision_match.group(1) if decision_match else ""

        if decision in _CRITICAL_AUDIT:
            print(f"  {RED}✗{RESET} {e}  {RED}[KRİTİK]{RESET}")
            fail(f"kritik audit kararı: {decision}")
        elif decision in _WARN_AUDIT:
            print(f"  {YELLOW}!{RESET} {e}  {YELLOW}[WARN]{RESET}")
            warn(f"dikkat audit kararı: {decision}")
        else:
            print(f"  {GREEN}+{RESET} {e}")
else:
    print(f"  {DIM}(yeni audit kaydı yok){RESET}")

if gone_entries:
    for e in sorted(gone_entries):
        print(f"  {DIM}  (limit dışına kaymış, A'da vardı){RESET}")


# ─── 4. Bot State Değişiklikleri ─────────────────────────────────────────────
section_header("BOT STATE")

bs_a = extract_bot_state(sa.get("4. bot state (safe_mode, session_pnl, diğer kalıcı değerler)", []))
bs_b = extract_bot_state(sb.get("4. bot state (safe_mode, session_pnl, diğer kalıcı değerler)", []))

all_keys = set(bs_a.keys()) | set(bs_b.keys())
if not all_keys:
    print(f"  {DIM}(bot_state kaydı yok){RESET}")
else:
    for k in sorted(all_keys):
        va = bs_a.get(k, "—")
        vb = bs_b.get(k, "—")
        if va != vb:
            # safe_mode beklenmedik şekilde true'ya dönmüşse FAIL
            if k == "safe_mode" and vb == "true" and va != "true":
                print(f"  {RED}✗{RESET} {k}: {RED}{va}{RESET} → {RED}{vb}{RESET}  {RED}[KRİTİK]{RESET}")
                fail("safe_mode beklenmedik şekilde true'ya döndü")
            else:
                color = GREEN
                print(f"  ~ {k}: {DIM}{va}{RESET} → {color}{vb}{RESET}")
                warn(f"bot_state değişti: {k} = {va} → {vb}")
        else:
            print(f"  {DIM}= {k} = {va}{RESET}")


# ─── 5. Trade Özeti Delta ────────────────────────────────────────────────────
section_header("TRADES ÖZET")

tr_a = extract_trade_summary(sa.get("5. trades (son 20 kapanmış trade)", []))
tr_b = extract_trade_summary(sb.get("5. trades (son 20 kapanmış trade)", []))

if tr_a or tr_b:
    cnt_a = int(tr_a.get("today_count", 0))
    cnt_b = int(tr_b.get("today_count", 0))
    pnl_a = float(tr_a.get("today_pnl", 0))
    pnl_b = float(tr_b.get("today_pnl", 0))

    cnt_delta = cnt_b - cnt_a
    pnl_delta = pnl_b - pnl_a

    cnt_str = f"{GREEN}+{cnt_delta}{RESET}" if cnt_delta > 0 else f"{DIM}{cnt_delta}{RESET}"
    pnl_color = GREEN if pnl_delta >= 0 else RED
    pnl_str = f"{pnl_color}{'+' if pnl_delta >= 0 else ''}{pnl_delta:.4f}{RESET}"

    print(f"  Trade sayısı: {cnt_a} → {cnt_b}  ({cnt_str})")
    print(f"  Günlük PnL:   {pnl_a:.4f} → {pnl_b:.4f}  (Δ {pnl_str})")
    # Trade sayısı değişimi beklenen davranış → WARN değil, bilgi
else:
    print(f"  {DIM}(trade verisi bulunamadı){RESET}")


# ─── 6. Log Farkı (kritik satırlar) ──────────────────────────────────────────
section_header("LOG (kritik satır farkı)")

log_a_lines = sa.get("6. log filtresi (reconciler / sell_retry / error — son 200 satır)", [])
log_b_lines = sb.get("6. log filtresi (reconciler / sell_retry / error — son 200 satır)", [])

log_a_set = set(l.strip() for l in log_a_lines if l.strip())
log_b_set = set(l.strip() for l in log_b_lines if l.strip())
new_log = log_b_set - log_a_set

if new_log:
    shown = 0
    for line in sorted(new_log):
        if shown >= 25:
            print(f"  {DIM}  ... ve {len(new_log)-25} satır daha{RESET}")
            break

        is_fail_log = any(k.lower() in line.lower() for k in _FAIL_LOG_KEYWORDS)
        is_warn_log = any(k.lower() in line.lower() for k in _WARN_LOG_KEYWORDS)

        if is_fail_log:
            print(f"  {RED}✗{RESET} {line}  {RED}[KRİTİK]{RESET}")
            fail(f"hata logu: {line[:60]}...")
        elif is_warn_log:
            print(f"  {YELLOW}!{RESET} {line}  {YELLOW}[WARN]{RESET}")
            warn(f"dikkat logu: {line[:60]}")
        else:
            print(f"  {DIM}+{RESET} {line}")
        shown += 1
else:
    print(f"  {DIM}(yeni kritik log satırı yok){RESET}")


# ─── VERDICT ─────────────────────────────────────────────────────────────────

critical_changes: bool = len(_fail_reasons) > 0

if critical_changes:
    verdict = "FAIL"
    verdict_color = RED
    verdict_icon = "✗"
elif _warn_reasons:
    verdict = "WARN"
    verdict_color = YELLOW
    verdict_icon = "!"
else:
    verdict = "PASS"
    verdict_color = GREEN
    verdict_icon = "✓"

print(f"\n{CYAN}{'═'*70}{RESET}")
print(f"\n  {verdict_color}RESULT: {verdict}   critical_changes={str(critical_changes).lower()}{RESET}\n")

if _fail_reasons:
    print(f"  {RED}FAIL nedenleri:{RESET}")
    for r in _fail_reasons:
        print(f"    {RED}✗{RESET} {r}")
    print()

if _warn_reasons:
    print(f"  {YELLOW}WARN nedenleri:{RESET}")
    for r in _warn_reasons:
        print(f"    {YELLOW}!{RESET} {r}")
    print()

# Recovery PASS kriterleri özeti (her zaman göster)
print(f"  {DIM}Recovery PASS kriterleri:{RESET}")
criteria = [
    ("fill_confirmed değişmedi",           not any("fill_confirmed" in r for r in _fail_reasons)),
    ("order_id kaybolmadı",                not any("order_id" in r for r in _fail_reasons)),
    ("shares sapmadı",                     not any("shares" in r for r in _fail_reasons)),
    ("beklenmedik status geçişi yok",      not any("status geçişi" in r for r in _fail_reasons)),
    ("RECONCILE_DISCREPANCY yok",          not any("RECONCILE" in r for r in _fail_reasons)),
    ("safe_mode beklenen değerde",         not any("safe_mode" in r for r in _fail_reasons)),
    ("açık pozisyon kaybı yok",            not any("pozisyon kaybı" in r for r in _fail_reasons)),
    ("hata logu yok",                      not any("hata logu" in r for r in _fail_reasons)),
]
for label_c, ok in criteria:
    icon = f"{GREEN}✓{RESET}" if ok else f"{RED}✗{RESET}"
    print(f"    {icon}  {label_c}")

print(f"\n{CYAN}{'═'*70}{RESET}\n")

# Exit code: 0=PASS, 1=WARN, 2=FAIL (CI uyumlu)
sys.exit(0 if verdict == "PASS" else (1 if verdict == "WARN" else 2))
