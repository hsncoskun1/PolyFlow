"""POLYFLOW - Main FastAPI Server v1.5 (Moduler Yapi + SQLite + RTDS)"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))  # POLYFLOW/ dizinini path'e ekle

import asyncio
import json
import logging
import math
import re
import random
import time
from datetime import datetime
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import load_settings, save_settings, get_wallet_config

logger = logging.getLogger("polyflow")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")

BASE_DIR = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

ws_clients: set[WebSocket] = set()

# ─── ASSET DEFINITIONS (başlangıç — keşif sistemi günceller) ─────────────────
ASSETS = {
    "BTC":  {"name": "Bitcoin",      "icon": "₿",  "color": "#f7931a"},
    "ETH":  {"name": "Ethereum",     "icon": "Ξ",  "color": "#627eea"},
    "SOL":  {"name": "Solana",       "icon": "◎",  "color": "#9945ff"},
    "XRP":  {"name": "XRP",          "icon": "✕",  "color": "#00aae4"},
    "DOGE": {"name": "Dogecoin",     "icon": "Ð",  "color": "#c2a633"},
    "BNB":  {"name": "BNB",          "icon": "◆",  "color": "#f3ba2f"},
    "HYPE": {"name": "Hyperliquid",  "icon": "⚡",  "color": "#4ade80"},
}

DEFAULT_PINNED = {"BTC_5M", "ETH_5M", "SOL_5M"}

# ─── AUTO-DISCOVERY: Polymarket coin keşif dosyası ───────────────────────────
DISCOVERED_FILE = BASE_DIR / "backend" / "discovered_assets.json"

# Known coin metadata — sym → {name, slug_prefix, slug_fullname, icon, color}
COIN_REGISTRY = {
    "BTC":  {"name": "Bitcoin",      "slug_prefix": "btc",      "slug_fullname": "bitcoin",     "icon": "₿", "color": "#f7931a"},
    "ETH":  {"name": "Ethereum",     "slug_prefix": "eth",      "slug_fullname": "ethereum",    "icon": "Ξ", "color": "#627eea"},
    "SOL":  {"name": "Solana",       "slug_prefix": "sol",      "slug_fullname": "solana",      "icon": "◎", "color": "#9945ff"},
    "XRP":  {"name": "XRP",          "slug_prefix": "xrp",      "slug_fullname": "xrp",         "icon": "✕", "color": "#00aae4"},
    "DOGE": {"name": "Dogecoin",     "slug_prefix": "doge",     "slug_fullname": "dogecoin",    "icon": "Ð", "color": "#c2a633"},
    "BNB":  {"name": "BNB",          "slug_prefix": "bnb",      "slug_fullname": "bnb",         "icon": "◆", "color": "#f3ba2f"},
    "HYPE": {"name": "Hyperliquid",  "slug_prefix": "hype",     "slug_fullname": "hype",        "icon": "⚡", "color": "#4ade80"},
}

def _save_discovered():
    """Save current COIN_REGISTRY to disk for persistence."""
    try:
        data = {sym: {k: v for k, v in info.items()} for sym, info in COIN_REGISTRY.items()}
        DISCOVERED_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"discovered_assets save error: {e}")

def _load_discovered():
    """Load discovered coins from disk, merge with defaults."""
    if not DISCOVERED_FILE.exists():
        return
    try:
        data = json.loads(DISCOVERED_FILE.read_text(encoding="utf-8"))
        for sym, info in data.items():
            if sym not in COIN_REGISTRY:
                COIN_REGISTRY[sym] = info
                logger.info(f"Discovered coin loaded: {sym} ({info.get('name','')})")
    except Exception as e:
        logger.warning(f"discovered_assets load error: {e}")

_load_discovered()

# ─── MARKET STATE (tüm veri Polymarket'ten) ──────────────────────────────────
_asset_phases: dict[str, str] = {}      # entry | position | exit
_asset_phase_ticks: dict[str, int] = {}
_asset_market: dict[str, dict] = {}     # key → {up_bid, up_ask, down_bid, down_ask, slippage_pct}

# ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
app_state = {
    "bot_running": True,
    "mode": "PAPER",
    "balance": 0.0,          # Gercek bakiye wallet'tan gelecek
    "session_pnl": 0.0,
    "session_start_balance": 0.0,
    "strategy_status": "SCANNING",
    "positions": [],
    "trade_history": [],
    "connection_status": {
        "clob_ws": True, "btc_ws": True,
        "user_ws": False, "gamma_api": True,
    },
    "ws_client_count": 0,
    # Multi-asset fields
    "assets": {},          # sym → asset state dict
    "pinned": list(DEFAULT_PINNED),
    "selected_asset": "BTC",
    # Legacy single-asset fields (filled from selected_asset)
    "btc_price": 84250.0,
    "btc_change": 0.0,
    "countdown": 200,
    "active_event": None,
    "events": [],
    "market_prices": {},
    "rules": {},
}

# ─── HELPERS ──────────────────────────────────────────────────────────────────
from backend.strategy.engine import evaluate_rules as _evaluate_rules

def _make_asset_rules(sym: str, cd: int = 150, mp: dict = None) -> dict:
    """Kural durumlarini hesapla — moduler engine'e yonlendirir."""
    if mp is None:
        mp = _asset_market.get(sym, {"up_ask": 0.5, "slippage_pct": 1.2})
    from backend.config import load_settings
    settings = load_settings()
    return _evaluate_rules(sym, cd, mp, app_state["positions"], settings)


# ─── LOG BUFFER ───────────────────────────────────────────────────────────────
_log_buffer: list[dict] = []

def addlog(level: str, message: str):
    e = {"time": datetime.now().strftime("%H:%M:%S"), "level": level, "message": message}
    _log_buffer.insert(0, e)
    if len(_log_buffer) > 300:
        _log_buffer.pop()


# ─── STATE UPDATE TICK (tüm veri Polymarket'ten) ────────────────────────────
async def simulation_tick():
    """Her saniye _market_cache'i okuyup app_state["assets"]'i gunceller."""
    while True:
        await asyncio.sleep(1.0)
        try:
            asset_states = {}
            now_ts = int(time.time())
            pinned_set = set(app_state["pinned"])

            for key, real in list(_market_cache.items()):
                sym = key.split("_")[0]
                info = ASSETS.get(sym) or COIN_REGISTRY.get(sym)
                if not info:
                    continue

                up_price   = real.get("up_price", 0.5)
                down_price = real.get("down_price", 0.5)
                tf    = real.get("timeframe", "5M")
                cd    = max(0, int(real["end_ts"]) - now_ts)
                mp    = _asset_market.get(key, {
                    "up_bid": round(up_price - 0.005, 3), "up_ask": up_price,
                    "down_bid": round(down_price - 0.005, 3), "down_ask": down_price,
                    "slippage_pct": round(abs(up_price - down_price) * 100, 2) if up_price > 0 else 1.0,
                })
                rules = _make_asset_rules(sym, cd, mp)

                # Event verisi (Polymarket'ten)
                real_event = {
                    "id":            real.get("conditionId") or real.get("slug", ""),
                    "slug":          real.get("slug", ""),
                    "conditionId":   real.get("conditionId", ""),
                    "title":         f"{info.get('name', sym)} Up or Down {tf}",
                    "question":      real.get("question", ""),
                    "subtitle":      datetime.fromtimestamp(int(real["end_ts"])).strftime("%b %d %H:%M") + " ET",
                    "asset":         sym,
                    "active":        True,
                    "remaining":     cd,
                    "up_price":      up_price,
                    "down_price":    down_price,
                    "up_bid":        mp.get("up_bid", up_price - 0.005),
                    "down_bid":      mp.get("down_bid", down_price - 0.005),
                    "slippage_pct":  mp.get("slippage_pct", 1.2),
                    "liquidity":     round(real.get("liquidity", 0)),
                    "volume":        round(real.get("volume", 0)),
                    "open_reference": round(up_price, 4),
                    "end_ts":        int(real["end_ts"]),
                    "tokens":        real.get("tokens", []),
                    "source":        "live",
                }

                asset_states[key] = {
                    "symbol":       sym,
                    "timeframe":    tf,
                    "name":         info.get("name", sym),
                    "icon":         info.get("icon", "●"),
                    "color":        info.get("color", "#888"),
                    "price":        up_price,
                    "change":       0,
                    "change_pct":   0,
                    "countdown":    cd,
                    "market":       mp,
                    "rules":        rules,
                    "event":        real_event,
                    "pinned":       key in pinned_set,
                    "has_position": any(p.get("asset") == sym for p in app_state["positions"]),
                    "phase":        _asset_phases.get(sym, "entry"),
                    "slug":         real.get("slug", ""),
                    "ptb":          get_ptb(key),
                    "live_price":   get_live_price(sym),
                }

            app_state["assets"] = asset_states
            app_state["events"] = [a["event"] for a in asset_states.values()]
            app_state["ws_client_count"] = len(ws_clients)

        except Exception as e:
            logger.error(f"simulation_tick hata: {e}")

        # Legacy fields
        sel = app_state.get("selected_asset", "BTC_5M")
        if sel in asset_states:
            s = asset_states[sel]
            app_state["btc_price"]    = s["price"]
            app_state["btc_change"]   = s["change"]
            app_state["countdown"]    = s["countdown"]
            app_state["market_prices"] = s["market"]
            app_state["rules"]        = s["rules"]
            app_state["active_event"] = s["event"]

            app_state["events"] = [a["event"] for a in asset_states.values()]
            app_state["ws_client_count"] = len(ws_clients)

            # FORCE_CLOSE: market kaybolmus pozisyonlari kapat
            active_syms = {k.split("_")[0] for k in asset_states}
            for pos in list(app_state["positions"]):
                if pos.get("asset") not in active_syms:
                    trade = {
                        "id": f"trade_{len(app_state['trade_history']):03d}",
                        "date": datetime.now().strftime("%H:%M:%S"),
                        "event_slug": pos.get("event_slug", ""),
                        "asset": pos["asset"], "side": pos.get("side", "UP"),
                        "entry_price": pos.get("entry_price", 0),
                        "exit_price": pos.get("current_price", 0),
                        "pnl": pos.get("pnl", 0), "amount": pos.get("amount", 0),
                        "status": "FORCE_CLOSE", "mode": "PAPER",
                    }
                    app_state["trade_history"].insert(0, trade)
                    app_state["positions"] = [p for p in app_state["positions"] if p["id"] != pos["id"]]
                    addlog("warn", f"FORCE_CLOSE {pos['asset']} — market kayboldu")


# ─── BROADCAST ────────────────────────────────────────────────────────────────
async def broadcast_state():
    if not ws_clients:
        return
    try:
        payload = json.dumps({"type": "state_update", "data": app_state})
    except Exception as e:
        logger.error(f"serialize error: {e}")
        return
    dead = set()
    for client in ws_clients:
        try:
            await client.send_text(payload)
        except Exception:
            dead.add(client)
    ws_clients.difference_update(dead)


async def broadcast_loop():
    while True:
        try:
            await broadcast_state()
        except Exception as e:
            logger.error(f"broadcast_loop: {e}")
        await asyncio.sleep(0.3)


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

def _detect_tf(slug: str, question: str) -> str:
    """Detect timeframe from Polymarket slug/question."""
    s = slug.lower()
    q = question.lower()
    if any(x in s for x in ("1d", "daily", "24h", "1-day")): return "1D"
    if any(x in s for x in ("4h", "4hour", "4-hour")):         return "4H"
    if any(x in s for x in ("1h", "1hour", "1-hour", "60min")): return "1H"
    if any(x in s for x in ("15m", "15min", "15-min")):         return "15M"
    if any(x in s for x in ("5m", "5min", "5-min")):            return "5M"
    if "1 day" in q or "24 hour" in q:  return "1D"
    if "4 hour" in q:                   return "4H"
    if "1 hour" in q or "60 min" in q:  return "1H"
    if "15 min" in q:                   return "15M"
    return "5M"

# Timeframe → window seconds (bilinen TF'ler — yenileri otomatik eklenir)
TF_SECONDS = {"5M": 300, "15M": 900, "1H": 3600, "4H": 14400, "1D": 86400,
              "1M": 60, "2M": 120, "3M": 180, "10M": 600, "30M": 1800,
              "2H": 7200, "3H": 10800, "6H": 21600, "8H": 28800, "12H": 43200}

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
        return {
            "conditionId": m.get("conditionId", ""),
            "question":    m.get("question", ""),
            "slug":        slug,
            "tokens":      raw_tokens,
            "up_price":    up_price,
            "down_price":  down_price,
            "end_ts":      end_ts,
            "volume":      float(m.get("volume", 0) or 0),
            "liquidity":   float(m.get("liquidity", 0) or 0),
        }
    except Exception:
        return None


async def scan_slug_based():
    """Slot-based discovery: try prev/current/next slugs and pick the CURRENTLY ACTIVE one.
    Rate-limited: max ~2 req/sec to avoid Gamma API 403/429."""
    global _market_cache
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
                            pick = min(active, key=lambda m: m["end_ts"]) if active else max(found_markets, key=lambda m: m["end_ts"])
                            new_cache[key] = pick
                            if key not in _asset_market:
                                _asset_market[key] = {"up_bid": 0.50, "up_ask": 0.51, "down_bid": 0.48, "down_ask": 0.49, "slippage_pct": 1.2}
                            _asset_market[key]["up_ask"]   = pick["up_price"]
                            _asset_market[key]["down_ask"] = pick["down_price"]
                            _asset_market[key]["up_bid"]   = round(pick["up_price"]  - 0.005, 3)
                            _asset_market[key]["down_bid"] = round(pick["down_price"] - 0.005, 3)
                            total += 1
                        else:
                            old = _market_cache.get(key)
                            if old and old.get("end_ts", 0) > now_ts:
                                new_cache[key] = old
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
                _init_single_asset(sym)

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


def _init_single_asset(sym: str):
    """Yeni kesfedilen asset icin durum baslat."""
    _asset_phases[sym] = "entry"
    _asset_phase_ticks[sym] = 0


# ─── PTB (Price to Beat) YÖNETİCİSİ ─────────────────────────────────────────
# Her event icin acilis referans fiyatini (openPrice) cekerler.
# Kaynak 1: Gamma API events endpoint → eventMetadata.priceToBeat
# Kaynak 2: __NEXT_DATA__ scraping → openPrice (fallback)
# PTB bir kez kilitlenir ve event boyunca degismez.

_ptb_cache: dict[str, float] = {}      # key (BTC_5M) → openPrice
_ptb_locked: dict[str, bool] = {}      # key → kilitlendi mi
_ptb_task = None

# Coin isimleri → RTDS subscription (canli fiyat icin)
# Topic: crypto_prices (Binance kaynakli), sembol formati: btcusdt
RTDS_SYMBOLS = {
    "BTC": "btcusdt", "ETH": "ethusdt", "SOL": "solusdt",
    "XRP": "xrpusdt", "DOGE": "dogeusdt", "BNB": "bnbusdt", "HYPE": "hypeusdt",
}

# Variant map (TF → Polymarket past-results variant)
PTB_VARIANT = {
    "5M": "fiveminute", "15M": "fifteen", "1H": "hourly",
    "4H": "fourhour", "1D": "daily",
}


async def _fetch_ptb_gamma(slug: str) -> float | None:
    """Gamma API events endpoint'inden eventMetadata.priceToBeat cek."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{GAMMA_BASE}/events", params={"slug": slug})
            if resp.status_code != 200:
                return None
            data = resp.json()
            if not data:
                return None
            ev = data[0] if isinstance(data, list) else data
            metadata = ev.get("eventMetadata")
            if metadata:
                if isinstance(metadata, str):
                    try: metadata = json.loads(metadata)
                    except: return None
                ptb = metadata.get("priceToBeat")
                if ptb and float(ptb) > 0:
                    return round(float(ptb), 2)
    except Exception as e:
        logger.warning(f"Gamma PTB hatasi ({slug}): {e}")
    return None


async def _fetch_ptb_next_data(slug: str, symbol: str, variant: str) -> float | None:
    """Polymarket event sayfasindan __NEXT_DATA__ ile openPrice cek."""
    try:
        url = f"https://polymarket.com/event/{slug}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html",
        }
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                return None
            html = resp.text

        match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if not match:
            return None

        root = json.loads(match.group(1))
        queries = root.get("props", {}).get("pageProps", {}).get("dehydratedState", {}).get("queries", [])

        for q in queries:
            key = q.get("queryKey", [])
            if (len(key) >= 5 and key[0] == "crypto-prices" and key[1] == "price"
                    and str(key[2]).upper() == symbol.upper()
                    and key[4] == variant):
                data = q.get("state", {}).get("data")
                if isinstance(data, dict):
                    op = data.get("openPrice")
                    cp = data.get("closePrice")
                    # Sadece aktif candle (closePrice=None)
                    if op and cp is None:
                        return round(float(op), 2)
    except Exception as e:
        logger.warning(f"__NEXT_DATA__ PTB hatasi ({slug}): {e}")
    return None


def get_ptb(key: str) -> float:
    """Belirli event key'i icin PTB degerini don."""
    return _ptb_cache.get(key, 0.0)


_ptb_slug_map: dict[str, str] = {}   # key → son kilitli slug (slug degisince sifirla)

async def _ptb_loop():
    """Her event icin PTB'yi dene — slug degisince sifirla, __NEXT_DATA__ birincil."""
    global _ptb_cache, _ptb_locked, _ptb_slug_map
    while True:
        try:
            now_ts = time.time()
            for key, real in list(_market_cache.items()):
                slug = real.get("slug", "")
                if not slug:
                    continue

                # Slug degistiyse (yeni event) → eski PTB'yi sifirla
                old_slug = _ptb_slug_map.get(key, "")
                if old_slug and old_slug != slug:
                    _ptb_locked.pop(key, None)
                    _ptb_cache.pop(key, None)
                    _ptb_slug_map[key] = slug

                # Zaten bu slug icin kilitliyse atla
                if _ptb_locked.get(key):
                    continue

                # Event bitmisse atla
                end_ts = real.get("end_ts", 0)
                if end_ts <= now_ts:
                    _ptb_locked.pop(key, None)
                    _ptb_cache.pop(key, None)
                    continue

                sym = key.split("_")[0]
                tf = key.split("_")[1] if "_" in key else "5M"

                ptb = None

                # Yontem 1 (birincil): __NEXT_DATA__ scraping — birebir dogru
                variant = PTB_VARIANT.get(tf, "fiveminute")
                ptb = await _fetch_ptb_next_data(slug, sym, variant)

                # Yontem 2 (fallback): Gamma API eventMetadata.priceToBeat
                if not ptb:
                    ptb = await _fetch_ptb_gamma(slug)

                if ptb and ptb > 0:
                    _ptb_cache[key] = ptb
                    _ptb_locked[key] = True
                    _ptb_slug_map[key] = slug
                    addlog("success", f"PTB kilitlendi: {key} = ${ptb:,.2f}")

                # Rate limit korumasi: her event arasi 0.5sn bekle
                await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"PTB dongusu hatasi: {e}")

        # Her 10 saniyede tekrar kontrol (yeni eventler icin)
        await asyncio.sleep(10)


async def broadcast_rate_limit(retry_after: int = 60):
    """Notify all connected dashboard clients about a rate limit hit."""
    if not ws_clients:
        return
    payload = json.dumps({"type": "rate_limit", "retry_after": retry_after})
    dead = set()
    for client in ws_clients:
        try:
            await client.send_text(payload)
        except Exception:
            dead.add(client)
    ws_clients.difference_update(dead)


async def scan_gamma_markets():
    """Fetch active 'up or down' crypto markets from Gamma API — all timeframes, all assets."""
    global _market_cache
    url = f"{GAMMA_BASE}/markets?active=true&closed=false&limit=500&order=createdAt&ascending=false"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 60))
            addlog("error", f"Gamma API rate limit (429) — {retry_after}s bekleniyor")
            app_state["connection_status"]["gamma_api"] = False
            await broadcast_rate_limit(retry_after)
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
            candidate = {
                "conditionId":  m.get("conditionId", ""),
                "question":     m.get("question", ""),
                "slug":         slug,
                "tokens":       raw_tokens,
                "up_price":     up_price,
                "down_price":   down_price,
                "end_ts":       end_ts,
                "timeframe":    tf,
                "volume":       float(m.get("volume", 0) or 0),
                "liquidity":    float(m.get("liquidity", 0) or 0),
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
                new_cache[key] = pick
                # Init or update _asset_market for this sym_tf
                if key not in _asset_market:
                    _asset_market[key] = {"up_bid": 0.50, "up_ask": 0.51, "down_bid": 0.48, "down_ask": 0.49, "slippage_pct": 1.2}
                _asset_market[key]["up_ask"]   = pick["up_price"]
                _asset_market[key]["down_ask"] = pick["down_price"]
                _asset_market[key]["up_bid"]   = round(pick["up_price"]  - 0.005, 3)
                _asset_market[key]["down_bid"] = round(pick["down_price"] - 0.005, 3)
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
                    if key in _asset_market:
                        _asset_market[key]["up_ask"]   = up_price
                        _asset_market[key]["down_ask"] = down_price
                        _asset_market[key]["up_bid"]   = round(up_price   - 0.005, 3)
                        _asset_market[key]["down_bid"] = round(down_price - 0.005, 3)
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
        await asyncio.sleep(10)


# ─── CLOB WEBSOCKET ──────────────────────────────────────────────────────────
CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
_clob_ws_task = None
_clob_prices: dict[str, dict] = {}  # token_id → {price, side, timestamp}

async def clob_ws_connect():
    """Connect to Polymarket CLOB WebSocket and subscribe to all matched tokens."""
    while True:
        try:
            # Gather token IDs from cached gamma markets
            subscribe_assets = []
            for sym, info in _market_cache.items():
                tokens = info.get("tokens", [])
                if tokens:
                    subscribe_assets.append({
                        "asset_id": tokens[0] if len(tokens) > 0 else "",
                    })

            if not subscribe_assets:
                addlog("info", "CLOB WS: Henuz token yok, Gamma scan bekleniyor...")
                app_state["connection_status"]["clob_ws"] = False
                await asyncio.sleep(10)
                continue

            addlog("info", f"CLOB WS baglaniyor... ({len(subscribe_assets)} token)")

            async with websockets.connect(CLOB_WS_URL, ping_interval=30) as ws:
                app_state["connection_status"]["clob_ws"] = True
                addlog("success", f"CLOB WS baglandi — {len(subscribe_assets)} token dinleniyor")

                # Subscribe to market updates
                sub_msg = json.dumps({
                    "auth": {},
                    "markets": [],
                    "assets_ids": [a["asset_id"] for a in subscribe_assets],
                    "type": "market",
                })
                await ws.send(sub_msg)

                async for raw_msg in ws:
                    try:
                        data = json.loads(raw_msg)
                        msg_type = data.get("event_type", "")
                        if msg_type in ("price_change", "book", "last_trade_price"):
                            asset_id = data.get("asset_id", "")
                            price = data.get("price") or data.get("last_trade_price")
                            if asset_id and price:
                                _clob_prices[asset_id] = {
                                    "price": float(price),
                                    "timestamp": time.time(),
                                }
                    except Exception:
                        pass

        except websockets.ConnectionClosed:
            addlog("warn", "CLOB WS baglanti koptu, yeniden baglaniyor...")
            app_state["connection_status"]["clob_ws"] = False
        except Exception as e:
            addlog("warn", f"CLOB WS hata: {e}")
            app_state["connection_status"]["clob_ws"] = False

        await asyncio.sleep(5)  # Reconnect delay


# ─── LIFESPAN ─────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app):
    settings = load_settings()
    app_state["mode"] = settings.get("mode", "PAPER")
    # Demo history kaldırıldı — gerçek trade geçmişi bot çalıştıkça oluşacak
    app_state["trade_history"] = []
    app_state["session_pnl"] = 0.0

    addlog("info", "POLYFLOW v1.7 basladi — Multi-Asset + CLOB WS + Gamma Scan")
    addlog("info", f"Izlenen: {len(ASSETS)} asset: {', '.join(ASSETS.keys())}")

    t1 = asyncio.create_task(broadcast_loop())
    t2 = asyncio.create_task(simulation_tick())
    t3 = asyncio.create_task(gamma_scan_loop())
    t4 = asyncio.create_task(clob_ws_connect())
    t5 = asyncio.create_task(relayer_health_loop())
    t6 = asyncio.create_task(_ptb_loop())
    await start_rtds()  # RTDS WebSocket — canli coin fiyatlari
    yield
    t1.cancel()
    t2.cancel()
    t3.cancel()
    t4.cancel()
    t5.cancel()
    t6.cancel()


RELAYER_HEALTH_URL = "https://clob.polymarket.com"

# ─── RTDS WEBSOCKET: Canli Coin Fiyatlari ────────────────────────────────────
RTDS_URL = "wss://ws-live-data.polymarket.com"
_rtds_prices: dict[str, float] = {}    # sym → canli fiyat (USD)
_rtds_running = False

def get_live_price(sym: str) -> float:
    """Belirli coin'in canli fiyatini don."""
    return _rtds_prices.get(sym, 0.0)

async def _rtds_coin_loop(sym: str, rtds_symbol: str):
    """Tek bir coin icin RTDS WebSocket baglantisi. Her coin ayri baglanti."""
    global _rtds_prices
    sub_msg = json.dumps({
        "action": "subscribe",
        "subscriptions": [{
            "topic": "crypto_prices",
            "type": "*",
            "filters": json.dumps({"symbol": rtds_symbol})
        }]
    })
    retry = 1
    while _rtds_running:
        try:
            async with websockets.connect(
                RTDS_URL, ping_interval=20, ping_timeout=20, close_timeout=5
            ) as ws:
                await ws.send(sub_msg)
                addlog("info", f"RTDS {sym} baglandi ({rtds_symbol})")
                retry = 1
                while _rtds_running:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=15.0)
                        if not raw or raw in ("PONG", "pong"):
                            continue
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8", errors="ignore")
                        if not raw.strip():
                            continue
                        data = json.loads(raw)
                        payload = data.get("payload", {})
                        if isinstance(payload, dict):
                            # Format 1: payload.value (Chainlink)
                            val = payload.get("value", 0)
                            if val and float(val) > 0:
                                _rtds_prices[sym] = round(float(val), 2)
                            # Format 2: payload.data array (Binance)
                            arr = payload.get("data", [])
                            if arr and isinstance(arr, list):
                                last = arr[-1]
                                if isinstance(last, dict) and last.get("value"):
                                    _rtds_prices[sym] = round(float(last["value"]), 2)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed:
                        break
                    except Exception:
                        break
        except Exception as e:
            if _rtds_running:
                await asyncio.sleep(retry)
                retry = min(retry * 2, 30)

async def start_rtds():
    """Tum coinler icin RTDS WebSocket baglantilari baslat."""
    global _rtds_running
    _rtds_running = True
    for sym, rtds_sym in RTDS_SYMBOLS.items():
        asyncio.create_task(_rtds_coin_loop(sym, rtds_sym))
    addlog("info", f"RTDS basladi: {len(RTDS_SYMBOLS)} coin izleniyor")


async def relayer_health_loop():
    """Ping Polymarket CLOB/Relayer API every 60s to update connection status."""
    while True:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(RELAYER_HEALTH_URL)
            ok = resp.status_code < 500
            app_state["connection_status"]["user_ws"] = ok
        except Exception:
            app_state["connection_status"]["user_ws"] = False
        await asyncio.sleep(60)


app = FastAPI(title="POLYFLOW", lifespan=lifespan)


# ─── WEBSOCKET ────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    for entry in _log_buffer[:15]:
        try:
            await ws.send_text(json.dumps({
                "type": "log", "level": entry["level"],
                "message": f"[{entry['time']}] {entry['message']}"
            }))
        except Exception:
            break
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
            elif msg.get("type") == "select_asset":
                sym = msg.get("asset", "BTC")
                if sym in ASSETS:
                    app_state["selected_asset"] = sym
            elif msg.get("type") == "toggle_pin":
                # Event bazli pin: "BTC_5M" gibi key kabul eder
                asset_key = msg.get("asset", "")
                pinned = set(app_state["pinned"])
                if asset_key in pinned:
                    pinned.discard(asset_key)
                    addlog("info", f"{asset_key} takipten cikarildi")
                else:
                    pinned.add(asset_key)
                    addlog("info", f"{asset_key} takibe alindi")
                app_state["pinned"] = list(pinned)
    except WebSocketDisconnect:
        ws_clients.discard(ws)


# ─── REST API ─────────────────────────────────────────────────────────────────
@app.get("/api/status")
async def get_status():
    return app_state

@app.get("/api/settings")
async def get_settings():
    return load_settings()

@app.post("/api/settings")
async def update_settings(body: dict):
    s = load_settings()
    s.update(body)
    save_settings(s)
    app_state["mode"] = s.get("mode", app_state["mode"])
    return {"ok": True, "settings": s}

@app.post("/api/bot/start")
async def start_bot():
    app_state["bot_running"] = True
    app_state["strategy_status"] = "SCANNING"
    addlog("info", "Bot STARTED")
    return {"ok": True}

@app.post("/api/bot/stop")
async def stop_bot():
    app_state["bot_running"] = False
    app_state["strategy_status"] = "IDLE"
    app_state["positions"] = []
    addlog("warn", "Bot STOPPED")
    return {"ok": True}

@app.get("/api/assets")
async def get_assets():
    return {"assets": app_state["assets"], "pinned": app_state["pinned"]}

@app.post("/api/assets/{sym}/pin")
async def toggle_pin_api(sym: str):
    """Event bazli pin toggle. sym = 'BTC_5M' gibi key."""
    pinned = set(app_state["pinned"])
    if sym in pinned:
        pinned.discard(sym)
    else:
        pinned.add(sym)
    app_state["pinned"] = list(pinned)
    return {"ok": True, "pinned": app_state["pinned"]}

@app.post("/api/assets/{sym}/select")
async def select_asset(sym: str):
    if sym in ASSETS:
        app_state["selected_asset"] = sym
    return {"ok": True, "selected": app_state["selected_asset"]}

@app.get("/api/positions")
async def get_positions():
    return {"positions": app_state["positions"]}

@app.get("/api/positions/history")
async def get_positions_history():
    """DB'den tum pozisyonlari getir (acik + kapali)."""
    from backend.storage.db import get_all_positions
    return {"positions": get_all_positions()}

@app.post("/api/positions/{pos_id}/close")
async def close_position(pos_id: str):
    app_state["positions"] = [p for p in app_state["positions"] if p["id"] != pos_id]
    from backend.storage.db import close_position as db_close
    db_close(pos_id, 0, "MANUAL")
    addlog("warn", f"Pozisyon {pos_id} manuel kapatildi")
    return {"ok": True}

@app.get("/api/trades")
async def get_trades():
    """DB'den trade gecmisini getir."""
    from backend.storage.db import get_trades
    return {"trades": get_trades()}

@app.get("/api/stats/daily")
async def get_daily_stats():
    """Gunluk istatistikler."""
    from backend.storage.db import get_daily_trade_count, get_daily_pnl
    return {"daily_trades": get_daily_trade_count(), "daily_pnl": get_daily_pnl()}

@app.get("/api/markets/matched")
async def get_matched_markets():
    """Return Gamma-matched markets and CLOB live prices."""
    result = {}
    for sym, info in _market_cache.items():
        tokens = info.get("tokens", [])
        live_price = None
        if tokens:
            cp = _clob_prices.get(tokens[0])
            if cp:
                live_price = cp["price"]
        result[sym] = {
            **info,
            "live_price": live_price,
            "has_clob_data": live_price is not None,
        }
    return {"markets": result, "clob_connected": app_state["connection_status"].get("clob_ws", False)}

@app.get("/api/coins")
async def get_coins():
    """Return all known coins from COIN_REGISTRY."""
    return {"coins": COIN_REGISTRY, "active_count": len(ASSET_SEARCH_TERMS)}

@app.get("/api/timeframes")
async def get_timeframes():
    """Kesfedilen tum timeframe'leri dondur."""
    tfs = get_active_timeframes()
    return {"timeframes": tfs, "count": len(tfs), "tf_seconds": {t: TF_SECONDS.get(t, 0) for t in tfs}}

@app.post("/api/coins/{sym}/add")
async def add_coin(sym: str, body: dict):
    """Manually add a new coin to track."""
    sym = sym.upper()
    if sym in COIN_REGISTRY:
        return {"ok": False, "error": f"{sym} zaten mevcut"}
    COIN_REGISTRY[sym] = {
        "name": body.get("name", sym),
        "slug_prefix": body.get("slug_prefix", sym.lower()),
        "slug_fullname": body.get("slug_fullname", sym.lower()),
        "icon": body.get("icon", "●"),
        "color": body.get("color", "#888888"),
    }
    if sym not in ASSETS:
        ASSETS[sym] = {"name": body.get("name", sym), "icon": body.get("icon", "●"), "color": body.get("color", "#888888")}
        _init_single_asset(sym)
    global ASSET_SEARCH_TERMS, SLUG_PREFIX, SLUG_FULLNAME
    ASSET_SEARCH_TERMS = _build_search_terms()
    SLUG_PREFIX.update(_slug_prefix())
    SLUG_FULLNAME.update(_slug_fullname())
    _save_discovered()
    addlog("success", f"Yeni coin eklendi: {sym}")
    return {"ok": True, "coins": COIN_REGISTRY}

@app.post("/api/coins/{sym}/remove")
async def remove_coin(sym: str):
    """Remove a coin from tracking."""
    sym = sym.upper()
    if sym not in COIN_REGISTRY:
        return {"ok": False, "error": f"{sym} bulunamadi"}
    if sym in DEFAULT_PINNED:
        return {"ok": False, "error": f"{sym} varsayilan coin, kaldirilamaz"}
    COIN_REGISTRY.pop(sym, None)
    ASSETS.pop(sym, None)
    ASSET_SEARCH_TERMS.pop(sym, None)
    # Remove from cache
    to_del = [k for k in _market_cache if k.startswith(sym + "_")]
    for k in to_del:
        _market_cache.pop(k, None)
    _save_discovered()
    addlog("warn", f"Coin kaldirildi: {sym}")
    return {"ok": True, "coins": COIN_REGISTRY}

@app.post("/api/debug/inject-demo-position")
async def inject_demo_position():
    """Dev endpoint: inject a demo PAPER position for UI testing."""
    demo_ts = int(time.time())
    demo_pos = {
        "id": f"pos_SOL_{demo_ts}",
        "asset": "SOL",
        "event_slug": f"sol-updown-5m-{(demo_ts // 300) * 300}",
        "side": "UP",
        "entry_price": 0.520,
        "current_price": round(_asset_market.get("SOL", {}).get("up_ask", 0.52), 3),
        "target_price": 0.570,
        "stop_loss": 0.460,
        "pnl": 0.069,
        "amount": 2.0,
        "status": "OPEN",
        "mode": "PAPER",
        "entry_time": datetime.now().strftime("%H:%M:%S"),
    }
    # Remove any existing SOL demo position first
    app_state["positions"] = [p for p in app_state["positions"] if p.get("asset") != "SOL"]
    app_state["positions"].append(demo_pos)
    addlog("success", "Demo position injected: SOL UP @ 0.520 (PAPER)")
    return {"ok": True, "position": demo_pos}

@app.get("/api/trades")
async def get_trades():
    return {"trades": app_state["trade_history"]}

@app.get("/api/logs")
async def get_logs():
    return {"logs": _log_buffer[:100]}

@app.get("/api/wallet")
async def get_wallet():
    cfg = get_wallet_config()
    configured = bool(cfg["private_key"] and cfg["api_key"])
    app_state["wallet_configured"] = configured
    return {
        "configured": configured,
        "private_key": cfg["private_key"],
        "api_key": cfg["api_key"],
        "secret": cfg["secret"],
        "passphrase": cfg["passphrase"],
        "funder": cfg["funder"],
        "sig_type": cfg["sig_type"],
    }


# ─── WALLET SAVE ──────────────────────────────────────────────────────────────
@app.post("/api/wallet/save")
async def save_wallet(body: dict):
    """Save wallet/API credentials to .env file (keeps DISABLED_ prefix on private key & funder)."""
    env_path = BASE_DIR / ".env"
    lines = []
    lines.append("## POLYFLOW .env")
    lines.append("## Olusturulma: " + datetime.now().strftime("%Y-%m-%d %H:%M"))
    lines.append("")

    pk = body.get("private_key", "")
    funder = body.get("funder", "")
    api_key = body.get("api_key", "")
    secret = body.get("secret", "")
    passphrase = body.get("passphrase", "")
    sig_type = body.get("sig_type", "2")

    # Private key & funder always DISABLED by default (safety)
    if pk:
        lines.append(f"DISABLED_POLYMARKET_PRIVATE_KEY={pk}")
    if funder:
        lines.append(f"DISABLED_POLYMARKET_FUNDER={funder}")
    lines.append("")

    # API keys: active
    if api_key:
        lines.append(f"POLYMARKET_API_KEY={api_key}")
    if secret:
        lines.append(f"POLYMARKET_SECRET={secret}")
    if passphrase:
        lines.append(f"POLYMARKET_PASSPHRASE={passphrase}")
    lines.append(f"POLYMARKET_SIG_TYPE={sig_type}")
    lines.append("")

    with open(env_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    addlog("success", "Cuzdan ayarlari kaydedildi (.env guncellendi)")
    # Reload env
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)

    return {"ok": True, "message": "Cuzdan ayarlari kaydedildi"}


# ─── MARKET DATA TEST ─────────────────────────────────────────────────────────
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API  = "https://clob.polymarket.com"

@app.get("/api/test/market")
async def test_market_fetch():
    """Test Polymarket Gamma API — crypto markets fetch speed & data."""
    url = f"{GAMMA_API}/markets?tag=crypto&limit=20&active=true&closed=false"
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        if resp.status_code != 200:
            return {"ok": False, "status_code": resp.status_code, "elapsed_ms": elapsed_ms}
        data = resp.json()
        markets = data if isinstance(data, list) else data.get("markets", [])
        sample = []
        for m in markets[:5]:
            sample.append({
                "question":      m.get("question", "")[:60],
                "conditionId":   m.get("conditionId", ""),
                "outcomePrices": m.get("outcomePrices", []),
                "volume":        m.get("volume", 0),
                "liquidity":     m.get("liquidity", 0),
                "endDate":       m.get("endDate", ""),
            })
        addlog("success", f"Gamma API test OK — {len(markets)} markets, {elapsed_ms}ms")
        return {
            "ok": True,
            "status_code": resp.status_code,
            "elapsed_ms": elapsed_ms,
            "market_count": len(markets),
            "sample": sample,
        }
    except httpx.TimeoutException:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        addlog("warn", f"Gamma API test TIMEOUT ({elapsed_ms}ms)")
        return {"ok": False, "error": "timeout", "elapsed_ms": elapsed_ms}
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        addlog("warn", f"Gamma API test ERROR: {e}")
        return {"ok": False, "error": str(e), "elapsed_ms": elapsed_ms}


@app.get("/api/test/prices")
async def test_prices_fetch():
    """Test CLOB API — fetch current bid/ask prices for a sample token."""
    # BTC Up/Down token IDs (example — real IDs change per event)
    sample_tokens = [
        "21742633143463906290569050155826241533067272736897614950488156847949938836455",  # BTC Yes
    ]
    url = f"{CLOB_API}/prices?token_ids={'%2C'.join(sample_tokens)}&side=BUY"
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        addlog("success", f"CLOB prices test OK — {elapsed_ms}ms")
        return {
            "ok": True,
            "status_code": resp.status_code,
            "elapsed_ms": elapsed_ms,
            "data": resp.json() if resp.status_code == 200 else None,
        }
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        return {"ok": False, "error": str(e), "elapsed_ms": elapsed_ms}


# ─── STATIC / FRONTEND ────────────────────────────────────────────────────────
app.mount("/css",    StaticFiles(directory=str(FRONTEND_DIR / "css")),    name="css")
app.mount("/js",     StaticFiles(directory=str(FRONTEND_DIR / "js")),     name="js")
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")

@app.get("/")
async def serve():
    return FileResponse(str(FRONTEND_DIR / "index.html"))

if __name__ == "__main__":
    import uvicorn
    settings = load_settings()
    uvicorn.run(app, host="0.0.0.0", port=settings.get("port", 8002), reload=False)
