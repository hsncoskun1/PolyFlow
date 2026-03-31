"""
backend/market/scan.py — Gamma market scan, slug discovery, timeframe kesfi.

Bağımlılıklar:
  - backend.market.registry : COIN_REGISTRY, ASSETS, _save_discovered
  - backend.state            : app_state, addlog
  - inject_scan_deps()       : lifespan'da çağrılmalı (asset_market, on_new_event, on_rate_limit)
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Callable

import httpx

from backend.market.registry import COIN_REGISTRY, ASSETS, _save_discovered
from backend.state import app_state, addlog

logger = logging.getLogger("polyflow")

# ─── Enjekte Bağımlılıklar ─────────────────────────────────────────────────────
# inject_scan_deps() ile lifespan'da doldurulur — öncesinde None

_asset_market_ref: dict | None = None    # main._asset_market — scan yeni event'te reset eder
_asset_phases_ref: dict | None = None    # main._asset_phases — _init_single_asset yazar
_asset_phase_ticks_ref: dict | None = None  # main._asset_phase_ticks
_on_new_event_cb: Callable | None = None    # (key, new_slug, old_slug) → reset locks
_on_rate_limit_cb: Callable | None = None   # async (retry_after) → WS broadcast


def inject_scan_deps(
    asset_market: dict,
    asset_phases: dict,
    asset_phase_ticks: dict,
    on_new_event: Callable,
    on_rate_limit: Callable,
) -> None:
    """Lifespan'da bir kez çağrılır — scan fonksiyonlarına main.py bağımlılıklarını enjekte eder."""
    global _asset_market_ref, _asset_phases_ref, _asset_phase_ticks_ref
    global _on_new_event_cb, _on_rate_limit_cb
    _asset_market_ref    = asset_market
    _asset_phases_ref    = asset_phases
    _asset_phase_ticks_ref = asset_phase_ticks
    _on_new_event_cb     = on_new_event
    _on_rate_limit_cb    = on_rate_limit


# ─── GAMMA MARKET SCAN ────────────────────────────────────────────────────────
GAMMA_BASE = "https://gamma-api.polymarket.com"

# Maps our asset symbols to keywords that appear in Polymarket question text
def _build_search_terms():
    """Build search terms from COIN_REGISTRY dynamically."""
    terms = {}
    for sym, info in COIN_REGISTRY.items():
        keywords = [info["slug_prefix"], info["slug_fullname"]]
        if info["name"].lower() not in keywords:
            keywords.append(info["name"].lower())
        if sym.lower() not in keywords:
            keywords.append(sym.lower())
        terms[sym] = list(set(keywords))
    return terms

ASSET_SEARCH_TERMS = _build_search_terms()
_market_cache: dict[str, dict] = {}  # sym_tf → {conditionId, tokens, question, slug, up_price, down_price, end_ts, timeframe}
_market_cache_update_ts: float = 0.0  # CLOB WS reconnect tetikleyici — cache her güncellenince artar


def get_market_cache() -> dict:
    """Mevcut _market_cache'i döndür (main.py'de lambda ile kullanım için)."""
    return _market_cache

def get_market_cache_ts() -> float:
    """CLOB WS reconnect sinyali için cache timestamp."""
    return _market_cache_update_ts


def parse_timeframe(text: str) -> str | None:
    """
    Generic timeframe parser — Polymarket slug veya question metninden TF çıkarır.
    Örnek: "5m", "15min", "4-hour", "1 day", "7d", "30M", "2H", "3D" → canonical form.
    Hiçbir şey eşleşmezse None döner (varsayılan uygulamak caller'ın sorumluluğu).
    """
    t = text.lower()
    # ── Gün desenleri (önce uzun sayılar) ─────────────────────────────────────
    for n in (7, 3, 2, 1):
        patterns = [f"{n}d", f"{n}-day", f"{n}day", f"{n} day"]
        if n == 1:
            patterns += ["daily", "24h", "24-hour", "24 hour"]
        if n == 7:
            patterns += ["weekly", "7-day", "week"]
        if any(p in t for p in patterns):
            return f"{n}D"
    # ── Saat desenleri ─────────────────────────────────────────────────────────
    for n in (12, 8, 6, 4, 3, 2, 1):
        patterns = [f"{n}h", f"{n}-hour", f"{n}hour", f"{n} hour"]
        if n == 1:
            patterns += ["1-hr", "hourly", "60min", "60m", "60-min", "60 min"]
        if any(p in t for p in patterns):
            return f"{n}H"
    # ── Dakika desenleri ───────────────────────────────────────────────────────
    for n in (30, 15, 10, 7, 5, 3, 2, 1):
        patterns = [f"{n}m", f"{n}-min", f"{n}min", f"{n} min", f"{n}-minute", f"{n} minute"]
        if n == 15:
            patterns += ["fifteen", "fifteenmin"]
        if n == 5:
            patterns += ["fivemin", "five-min"]
        if n == 30:
            patterns += ["halfhour", "half-hour", "half hour"]
        if any(p in t for p in patterns):
            return f"{n}M"
    return None


def _detect_tf(slug: str, question: str = "") -> str:
    """Detect timeframe from Polymarket slug/question. Falls back to '5M' if unknown."""
    combined = f"{slug} {question}"
    result = parse_timeframe(combined)
    return result if result else "5M"


# Timeframe → window seconds (bilinen TF'ler — yenileri otomatik eklenir)
TF_SECONDS = {
    "1M": 60,   "2M": 120,  "3M": 180,   "5M": 300,
    "7M": 420,  "10M": 600, "15M": 900,  "30M": 1800,
    "1H": 3600, "2H": 7200, "3H": 10800, "4H": 14400,
    "6H": 21600, "8H": 28800, "12H": 43200,
    "1D": 86400, "2D": 172800, "3D": 259200, "7D": 604800,
}

# Dinamik TF listesi — discovery_scan tarafindan otomatik guncellenir
_discovered_timeframes: set[str] = {"5M", "15M", "1H", "4H", "1D"}  # baslangic

def get_active_timeframes() -> list[str]:
    """Kesfedilen tum TF'leri dondur."""
    return sorted(_discovered_timeframes, key=lambda t: TF_SECONDS.get(t, 999999))

# Derived from COIN_REGISTRY (auto-updated when new coins discovered)
def _slug_prefix():  return {sym: info["slug_prefix"] for sym, info in COIN_REGISTRY.items()}
def _slug_fullname(): return {sym: info["slug_fullname"] for sym, info in COIN_REGISTRY.items()}
SLUG_PREFIX   = _slug_prefix()
SLUG_FULLNAME = _slug_fullname()

def _make_1h_slug(sym: str, dt: datetime) -> str:
    """Construct 1H text-based slug: bitcoin-up-or-down-march-29-2026-3pm-et"""
    fullname = SLUG_FULLNAME.get(sym, sym.lower())
    month = dt.strftime("%B").lower()  # "march"
    day = dt.day
    year = dt.year
    hour = dt.hour % 12 or 12  # 1-12, no leading zero (Windows-safe)
    ampm = "am" if dt.hour < 12 else "pm"
    return f"{fullname}-up-or-down-{month}-{day}-{year}-{hour}{ampm}-et"

def _make_1d_slug(sym: str, dt: datetime) -> str:
    """Construct 1D text-based slug: bitcoin-up-or-down-on-march-30-2026"""
    fullname = SLUG_FULLNAME.get(sym, sym.lower())
    month = dt.strftime("%B").lower()
    day = dt.day
    year = dt.year
    return f"{fullname}-up-or-down-on-{month}-{day}-{year}"

def _calc_candidate_slugs(sym: str, tf: str) -> list[tuple[str, int]]:
    """Calculate candidate slugs for all timeframe types.
    5M/15M/4H: timestamp-based  |  1H/1D: text-based with date construction.
    Returns list of (slug, expected_end_ts)."""
    now_ts = int(time.time())
    window = TF_SECONDS.get(tf, 300)

    if tf in ("5M", "15M", "4H"):
        # Timestamp-based slugs — try current first, then next, then prev
        prefix = SLUG_PREFIX.get(sym, sym.lower())
        tf_slug = tf.lower()
        current_start = (now_ts // window) * window
        results = []
        for offset in [0, 1, -1, 2]:  # current → next → prev → next+1
            ts = current_start + offset * window
            if ts < 0:
                continue
            results.append((f"{prefix}-updown-{tf_slug}-{ts}", ts + window))
        return results

    elif tf == "1H":
        # Text-based 1H: try current hour first, then next, then prev in ET (UTC-4)
        from datetime import timezone, timedelta
        et = timezone(timedelta(hours=-4))
        results = []
        for offset_h in [0, 1, -1]:  # current → next → prev
            dt_et = datetime.fromtimestamp(now_ts + offset_h * 3600, tz=et)
            # Round down to hour boundary
            dt_hour = dt_et.replace(minute=0, second=0, microsecond=0)
            slug = _make_1h_slug(sym, dt_hour)
            end_ts = int(dt_hour.timestamp()) + 3600  # 1 hour window
            results.append((slug, end_ts))
        return results

    elif tf == "1D":
        # Text-based 1D: try today and tomorrow in ET
        from datetime import timezone, timedelta
        et = timezone(timedelta(hours=-4))
        results = []
        for offset_d in [0, 1]:
            dt_et = datetime.fromtimestamp(now_ts + offset_d * 86400, tz=et)
            dt_day = dt_et.replace(hour=0, minute=0, second=0, microsecond=0)
            slug = _make_1d_slug(sym, dt_day)
            end_ts = int(dt_day.timestamp()) + 86400
            results.append((slug, end_ts))
        return results

    return []

async def discover_slug_market(client: httpx.AsyncClient, slug: str) -> dict | None:
    """Fetch a single market by slug from Gamma API. Returns parsed market or None."""
    try:
        resp = await client.get(f"{GAMMA_BASE}/markets?slug={slug}")
        if resp.status_code == 429:
            return None
        if resp.status_code != 200:
            return None
        raw = resp.json()
        markets = raw if isinstance(raw, list) else raw.get("markets", [])
        if not markets:
            return None
        m = markets[0]
        raw_prices = m.get("outcomePrices", ["0.5", "0.5"])
        if isinstance(raw_prices, str):
            try: raw_prices = json.loads(raw_prices)
            except Exception: raw_prices = ["0.5", "0.5"]
        up_price   = float(raw_prices[0]) if len(raw_prices) > 0 else 0.5
        down_price = float(raw_prices[1]) if len(raw_prices) > 1 else 0.5
        raw_tokens = m.get("clobTokenIds", [])
        if isinstance(raw_tokens, str):
            try: raw_tokens = json.loads(raw_tokens)
            except Exception: raw_tokens = []
        end_date = m.get("endDate", "")
        try:
            end_ts = datetime.fromisoformat(end_date.replace("Z", "+00:00")).timestamp()
        except Exception:
            end_ts = 0
        # ── CANONICAL REGISTRY FIELDS ────────────────────────────────────────
        # Polymarket token ID'leri: [0] = UP outcome, [1] = DOWN outcome
        up_asset_id   = raw_tokens[0] if len(raw_tokens) > 0 else ""
        down_asset_id = raw_tokens[1] if len(raw_tokens) > 1 else ""
        now_sec = time.time()
        market_status = "open" if end_ts > now_sec else ("closed" if end_ts > 0 else "unknown")
        return {
            # ── Core identity ────────────────────────────────────────────────
            "conditionId":      m.get("conditionId", ""),
            "question":         m.get("question", ""),
            "slug":             m.get("slug", "") or slug,
            # ── Canonical asset IDs ──────────────────────────────────────────
            "tokens":           raw_tokens,          # legacy compat
            "up_asset_id":      up_asset_id,
            "down_asset_id":    down_asset_id,
            # ── Prices ──────────────────────────────────────────────────────
            "up_price":         up_price,
            "down_price":       down_price,
            # ── Timing ──────────────────────────────────────────────────────
            "end_ts":           end_ts,
            # ── Market status ────────────────────────────────────────────────
            "market_status":    market_status,
            # ── Verification state (set by backend verification layer) ───────
            "verification_state": "unverified",       # upgraded to "verified" in simulation_tick
            # ── Volume / liquidity ───────────────────────────────────────────
            "volume":           float(m.get("volume", 0) or 0),
            "liquidity":        float(m.get("liquidity", 0) or 0),
        }
    except Exception:
        return None


async def scan_slug_based():
    """Slot-based discovery: try prev/current/next slugs and pick the CURRENTLY ACTIVE one.
    Rate-limited: max ~2 req/sec to avoid Gamma API 403/429."""
    global _market_cache, _market_cache_update_ts
    new_cache: dict[str, dict] = {}
    total = 0
    now_ts = time.time()
    req_count = 0
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            for sym in ASSET_SEARCH_TERMS:
                for tf in get_active_timeframes():
                    key = f"{sym}_{tf}"
                    try:
                        candidates = _calc_candidate_slugs(sym, tf)
                        found_markets = []
                        for slug, expected_end in candidates:
                            result = await discover_slug_market(client, slug)
                            req_count += 1
                            if result and result["end_ts"] > 0:
                                result["timeframe"] = tf
                                found_markets.append(result)
                                # Break only if we found an ACTIVE market (end_ts > now)
                                if result["end_ts"] > now_ts:
                                    break
                            if req_count % 6 == 0:
                                await asyncio.sleep(1.0)
                        if found_markets:
                            active = [m for m in found_markets if m["end_ts"] > now_ts]
                            if not active:
                                logger.warning(f"scan_slug {key}: {len(found_markets)} market bulundu ama hicbiri aktif degil")
                            pick = min(active, key=lambda m: m["end_ts"]) if active else max(found_markets, key=lambda m: m["end_ts"])
                            new_cache[key] = pick
                            # Slug degistiyse VEYA key ilk kezse → _asset_market sifirla (taze baslangic)
                            old_slug = _market_cache.get(key, {}).get("slug", "")
                            new_slug = pick.get("slug", "")
                            slug_changed = (not old_slug) or (old_slug != new_slug)
                            if slug_changed:
                                if _asset_market_ref is not None:
                                    _asset_market_ref[key] = {
                                        "up_bid": round(pick["up_price"] - 0.005, 3),
                                        "up_ask": pick["up_price"],
                                        "down_bid": round(pick["down_price"] - 0.005, 3),
                                        "down_ask": pick["down_price"],
                                        "slippage_pct": 1.2,
                                        "up_mid": 0.5, "down_mid": 0.5,
                                    }
                                if old_slug and old_slug != new_slug:
                                    addlog("info", f"Yeni event (slug-scan): {key} {old_slug} -> {new_slug} | market+WS reset")
                                    _market_cache_update_ts = time.time()
                                    if _on_new_event_cb:
                                        _on_new_event_cb(key, new_slug, old_slug)
                            total += 1
                        else:
                            old = _market_cache.get(key)
                            if old and old.get("end_ts", 0) > now_ts:
                                new_cache[key] = old
                            else:
                                logger.warning(f"scan_slug {key}: slug bulunamadi — {[s for s,_ in candidates[:2]]}")
                    except Exception as tf_err:
                        logger.warning(f"scan_slug {key}: {tf_err}")
                        old = _market_cache.get(key)
                        if old and old.get("end_ts", 0) > now_ts:
                            new_cache[key] = old
                await asyncio.sleep(0.3)
        _market_cache = new_cache
        sym_count = len({k.split("_")[0] for k in new_cache})
        addlog("info", f"Slug scan: {total} market ({sym_count} asset, {req_count} req)")
        app_state["connection_status"]["gamma_api"] = True
    except Exception as e:
        addlog("warn", f"Slug scan hata: {e}")
        app_state["connection_status"]["gamma_api"] = False


# ─── AUTO-DISCOVERY SCAN ─────────────────────────────────────────────────────
# Default icon/colors for auto-discovered coins
_AUTO_COLORS = ["#e74c3c","#3498db","#2ecc71","#e67e22","#9b59b6","#1abc9c","#f39c12","#e91e63"]
_AUTO_ICONS  = ["●","◉","◆","▲","★","◈","⬟","⬡"]

async def discovery_scan():
    """Broad Gamma scan: yeni coin VE yeni timeframe otomatik kesfeder.
    - Yeni coin bulursa COIN_REGISTRY'ye ekler
    - Yeni TF bulursa _discovered_timeframes'e ekler
    - Frontend'te yeni TF sekmesi otomatik olusur"""
    global ASSET_SEARCH_TERMS, SLUG_PREFIX, SLUG_FULLNAME, _discovered_timeframes
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{GAMMA_BASE}/markets?active=true&closed=false&limit=500&order=createdAt&ascending=false")
            if resp.status_code != 200:
                return
            raw = resp.json()
            markets = raw if isinstance(raw, list) else raw.get("markets", [])

        known_prefixes = set()
        for info in COIN_REGISTRY.values():
            known_prefixes.add(info["slug_prefix"])
            known_prefixes.add(info["slug_fullname"])
            known_prefixes.add(info["name"].lower())
        new_coins = 0
        new_tfs = 0

        for m in markets:
            q = m.get("question", "")
            slug = m.get("slug", "")
            if "up or down" not in q.lower():
                continue

            # ── TF KESFI: slug'dan timeframe tespit et ──
            tf = _detect_tf(slug, q)
            if tf not in _discovered_timeframes:
                # Yeni TF! Window seconds'i hesapla veya TF_SECONDS'ta var mi kontrol et
                if tf not in TF_SECONDS:
                    # Bilinmeyen TF — slug'dan window tahmin et
                    tf_lower = tf.lower()
                    if tf_lower.endswith('m'):
                        try: TF_SECONDS[tf] = int(tf_lower[:-1]) * 60
                        except: TF_SECONDS[tf] = 300
                    elif tf_lower.endswith('h'):
                        try: TF_SECONDS[tf] = int(tf_lower[:-1]) * 3600
                        except: TF_SECONDS[tf] = 3600
                    elif tf_lower.endswith('d'):
                        try: TF_SECONDS[tf] = int(tf_lower[:-1]) * 86400
                        except: TF_SECONDS[tf] = 86400
                    else:
                        TF_SECONDS[tf] = 300
                _discovered_timeframes.add(tf)
                new_tfs += 1
                addlog("success", f"Yeni timeframe kesfedildi: {tf} (window={TF_SECONDS.get(tf,0)}sn)")

            # ── COIN KESFI: slug prefix'inden yeni coin ──
            match = re.match(r'^(\w+)\s+[Uu]p or [Dd]own', q)
            if not match:
                continue
            coin_name = match.group(1)

            slug_prefix = ""
            if "-updown-" in slug:
                slug_prefix = slug.split("-updown-")[0]
            elif "-up-or-down" in slug:
                slug_prefix = slug.split("-up-or-down")[0]

            if not slug_prefix or slug_prefix in known_prefixes:
                continue

            sym = coin_name.upper()[:5]
            if sym in COIN_REGISTRY:
                continue

            idx = len(COIN_REGISTRY) % len(_AUTO_COLORS)
            COIN_REGISTRY[sym] = {
                "name": coin_name,
                "slug_prefix": slug_prefix,
                "slug_fullname": slug_prefix,
                "icon": _AUTO_ICONS[idx],
                "color": _AUTO_COLORS[idx],
            }
            known_prefixes.add(slug_prefix)

            if sym not in ASSETS:
                ASSETS[sym] = {"name": coin_name, "icon": _AUTO_ICONS[idx], "color": _AUTO_COLORS[idx]}
                if _asset_phases_ref is not None:
                    _asset_phases_ref[sym] = "entry"
                if _asset_phase_ticks_ref is not None:
                    _asset_phase_ticks_ref[sym] = 0

            new_coins += 1
            addlog("success", f"Yeni coin kesfedildi: {sym} ({coin_name}) prefix={slug_prefix}")

        if new_coins > 0:
            ASSET_SEARCH_TERMS = _build_search_terms()
            SLUG_PREFIX.update(_slug_prefix())
            SLUG_FULLNAME.update(_slug_fullname())
            _save_discovered()

        if new_coins > 0 or new_tfs > 0:
            addlog("info", f"Kesif: {new_coins} yeni coin, {new_tfs} yeni TF, toplam {len(COIN_REGISTRY)} coin / {len(_discovered_timeframes)} TF")

    except Exception as e:
        logger.warning(f"discovery_scan error: {e}")


async def scan_gamma_markets():
    """Fetch active 'up or down' crypto markets from Gamma API — all timeframes, all assets."""
    global _market_cache, _market_cache_update_ts
    url = f"{GAMMA_BASE}/markets?active=true&closed=false&limit=500&order=createdAt&ascending=false"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 60))
            addlog("error", f"Gamma API rate limit (429) — {retry_after}s bekleniyor")
            app_state["connection_status"]["gamma_api"] = False
            if _on_rate_limit_cb:
                await _on_rate_limit_cb(retry_after)
            await asyncio.sleep(retry_after)
            return
        if resp.status_code != 200:
            addlog("warn", f"Gamma scan HTTP {resp.status_code}")
            return
        raw = resp.json()
        markets = raw if isinstance(raw, list) else raw.get("markets", [])
        now_ts = time.time()
        new_cache: dict[str, dict] = {}
        # per_sym_tf: sym → tf → best candidate (earliest end_ts)
        per_sym_tf: dict[str, dict[str, dict]] = {sym: {} for sym in ASSET_SEARCH_TERMS}

        for m in markets:
            q = m.get("question", "").lower()
            if "up or down" not in q:
                continue
            end_date = m.get("endDate", "")
            try:
                end_ts = datetime.fromisoformat(end_date.replace("Z", "+00:00")).timestamp()
            except Exception:
                continue
            if end_ts <= now_ts:
                continue
            slug = m.get("slug", "")
            tf   = _detect_tf(slug, q)
            # outcomePrices / clobTokenIds may be JSON strings
            raw_prices = m.get("outcomePrices", ["0.5", "0.5"])
            if isinstance(raw_prices, str):
                try: raw_prices = json.loads(raw_prices)
                except Exception: raw_prices = ["0.5", "0.5"]
            up_price   = float(raw_prices[0]) if len(raw_prices) > 0 else 0.5
            down_price = float(raw_prices[1]) if len(raw_prices) > 1 else 0.5
            raw_tokens = m.get("clobTokenIds", [])
            if isinstance(raw_tokens, str):
                try: raw_tokens = json.loads(raw_tokens)
                except Exception: raw_tokens = []
            up_asset_id   = raw_tokens[0] if len(raw_tokens) > 0 else ""
            down_asset_id = raw_tokens[1] if len(raw_tokens) > 1 else ""
            candidate = {
                "conditionId":      m.get("conditionId", ""),
                "question":         m.get("question", ""),
                "slug":             slug,
                "tokens":           raw_tokens,
                "up_asset_id":      up_asset_id,
                "down_asset_id":    down_asset_id,
                "up_price":         up_price,
                "down_price":       down_price,
                "end_ts":           end_ts,
                "market_status":    "open",  # filtered to active above
                "verification_state": "unverified",
                "timeframe":        tf,
                "volume":           float(m.get("volume", 0) or 0),
                "liquidity":        float(m.get("liquidity", 0) or 0),
            }
            for sym, keywords in ASSET_SEARCH_TERMS.items():
                if not any(kw in q for kw in keywords):
                    continue
                # Keep the earliest-ending (most imminent) market per sym+tf
                existing = per_sym_tf[sym].get(tf)
                if existing is None or end_ts < existing["end_ts"]:
                    per_sym_tf[sym][tf] = candidate

        total_found = 0
        for sym, tf_map in per_sym_tf.items():
            for tf, pick in tf_map.items():
                key = f"{sym}_{tf}"
                old_cached = _market_cache.get(key, {})
                old_slug   = old_cached.get("slug", "")
                new_slug   = pick["slug"]
                slug_changed = old_slug and old_slug != new_slug

                new_cache[key] = pick

                # Slug degistiyse (yeni 5dk event basladiysa) _asset_market temizle
                # up_mid = 0.5 (tarafsiz baslangic) — 0.0 olsaydi EMA'siz ani ziplama olurdu
                if slug_changed or (_asset_market_ref is not None and key not in _asset_market_ref):
                    if _asset_market_ref is not None:
                        _asset_market_ref[key] = {
                            "up_bid": round(pick["up_price"] - 0.005, 3),
                            "up_ask": pick["up_price"],
                            "down_bid": round(pick["down_price"] - 0.005, 3),
                            "down_ask": pick["down_price"],
                            "slippage_pct": 1.2,
                            "up_mid": 0.5,    # tarafsiz baslangic — EMA buradan gercek degere kayar
                            "down_mid": 0.5,
                        }
                    if slug_changed:
                        addlog("info", f"Yeni event: {key} {old_slug} -> {new_slug} | market reset")
                        _market_cache_update_ts = time.time()
                        if _on_new_event_cb:
                            _on_new_event_cb(key, new_slug, old_slug)
                # NOT: mevcut CLOB WS/midpoint degerlerini ezme — onlar daha dogru
                total_found += 1

        _market_cache = new_cache
        sym_count = len({k.split("_")[0] for k in new_cache})
        addlog("info", f"Gamma scan: {total_found} market ({sym_count} asset, {len(new_cache)} sym_tf)")
        app_state["connection_status"]["gamma_api"] = True
    except Exception as e:
        addlog("warn", f"Gamma scan hata: {e}")
        app_state["connection_status"]["gamma_api"] = False


async def refresh_cached_slugs():
    """Fast refresh: update prices for each cached sym_tf market via slug fetch.
    Remove expired or missing markets so full scan picks them up."""
    global _market_cache
    if not _market_cache:
        return
    now_ts = time.time()
    to_remove = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for key, info in list(_market_cache.items()):
                slug = info.get("slug", "")
                if not slug:
                    to_remove.append(key)
                    continue
                if info.get("end_ts", 0) <= now_ts:
                    to_remove.append(key)
                    sym = key.split("_")[0]
                    addlog("info", f"{key} sona erdi, yeni market aranıyor...")
                    continue
                try:
                    resp = await client.get(f"{GAMMA_BASE}/markets?slug={slug}")
                    if resp.status_code == 429:
                        addlog("warn", "Slug refresh rate limit — atlanıyor")
                        return
                    if resp.status_code != 200:
                        continue
                    raw = resp.json()
                    markets = raw if isinstance(raw, list) else raw.get("markets", [])
                    if not markets:
                        to_remove.append(key)
                        addlog("info", f"{key} slug bulunamadı, yeniden taranıyor...")
                        continue
                    m = markets[0]
                    raw_prices = m.get("outcomePrices", ["0.5", "0.5"])
                    if isinstance(raw_prices, str):
                        try: raw_prices = json.loads(raw_prices)
                        except Exception: pass
                    up_price   = float(raw_prices[0]) if len(raw_prices) > 0 else info["up_price"]
                    down_price = float(raw_prices[1]) if len(raw_prices) > 1 else info["down_price"]
                    _market_cache[key]["up_price"]    = up_price
                    _market_cache[key]["down_price"]  = down_price
                    if _asset_market_ref is not None and key in _asset_market_ref:
                        _asset_market_ref[key]["up_ask"]   = up_price
                        _asset_market_ref[key]["down_ask"] = down_price
                        _asset_market_ref[key]["up_bid"]   = round(up_price   - 0.005, 3)
                        _asset_market_ref[key]["down_bid"] = round(down_price - 0.005, 3)
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"refresh_cached_slugs: {e}")
    for key in to_remove:
        _market_cache.pop(key, None)


async def gamma_scan_loop():
    """Primary: slug-based scan (slot-calculated slugs). Fallback: broad Gamma scan.
    Slug refresh every 10s, full re-discovery every 5 minutes or when cache is stale."""
    tick = 0
    while True:
        try:
            # Check for expired/missing markets → re-discover
            now_ts = time.time()
            expired = [k for k, v in _market_cache.items() if v.get("end_ts", 0) <= now_ts]
            cached_syms = {k.split("_")[0] for k in _market_cache}
            missing = [s for s in ASSET_SEARCH_TERMS if s not in cached_syms]
            if expired or missing or not _market_cache:
                await scan_slug_based()
            else:
                await refresh_cached_slugs()
        except Exception as e:
            logger.error(f"gamma_scan_loop: {e}")
        tick += 1
        # Full slug re-scan every 5 minutes + discovery scan for new coins
        if tick >= 30:
            tick = 0
            try:
                await discovery_scan()  # Find new coins first
                await scan_slug_based()  # Then scan all known coins
            except Exception as e:
                logger.error(f"gamma_scan_loop full-scan: {e}")
        await asyncio.sleep(5)
