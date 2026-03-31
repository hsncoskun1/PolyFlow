"""POLYFLOW - Main FastAPI Server v2.0 (Moduler Yapi + SQLite + RTDS)"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))  # POLYFLOW/ dizinini path'e ekle
sys.path.insert(0, str(Path(__file__).parent))        # backend/ dizinini path'e ekle (config.py)

import asyncio
import json
import logging
import math
import re
import random
import threading
import time
from datetime import datetime
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import load_settings, save_settings, get_wallet_config

# ─── MERKEZİ DURUM (app_state, addlog, _log_buffer) ─────────────────────────
from backend.state import app_state, addlog, _log_buffer, DEFAULT_PINNED

# ─── PTB YÖNETİCİSİ ──────────────────────────────────────────────────────────
from backend.market.ptb import get_ptb, ptb_loop, RTDS_SYMBOLS

# ─── MARKET REGISTRY & SCAN ───────────────────────────────────────────────────
from backend.market.registry import ASSETS, COIN_REGISTRY, DISCOVERED_FILE, _save_discovered, _load_discovered
from backend.market.scan import (
    inject_scan_deps, get_market_cache, get_market_cache_ts,
    gamma_scan_loop, scan_slug_based, discovery_scan,
    get_active_timeframes, ASSET_SEARCH_TERMS, TF_SECONDS,
    SLUG_PREFIX, SLUG_FULLNAME,
)

# ─── API ROUTER (temiz route'lar) ─────────────────────────────────────────────
from backend.api.routes import router as api_router

logger = logging.getLogger("polyflow")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")

# ─── EXECUTION ENGINE (FAZ 1 + FAZ 3) ───────────────────────────────────────
try:
    from backend.execution import entry_service as _entry_svc
    from backend.execution import position_tracker as _pos_tracker
    from backend.execution import sell_retry as _sell_retry
    from backend.execution import order_executor as _order_exec
    from backend.execution import reconciler as _reconciler
    from backend.execution import user_ws as _user_ws
    _EXEC_AVAILABLE = True
except ImportError as _e:
    logger.warning(f"Execution engine import hatasi: {_e} — trading devre disi")
    _EXEC_AVAILABLE = False

# Event başına trade sayacı (entry_service.try_open_position için)
_event_trade_counts: dict = {}  # event_key → int

BASE_DIR = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

ws_clients: set[WebSocket] = set()

# ASSETS, COIN_REGISTRY, DISCOVERED_FILE, _save_discovered, _load_discovered
# → backend/market/registry.py

# ─── MARKET STATE (tüm veri Polymarket'ten) ──────────────────────────────────
_asset_phases: dict[str, str] = {}      # entry | position | exit
_asset_phase_ticks: dict[str, int] = {}
_asset_market: dict[str, dict] = {}     # key → {up_bid, up_ask, down_bid, down_ask, slippage_pct}

# ─── HELPERS ──────────────────────────────────────────────────────────────────
from backend.strategy.engine import evaluate_rules as _evaluate_rules

_NO_SETTINGS = {"time":"no_settings","price":"no_settings","btc_move":"no_settings",
                "slippage":"no_settings","event_limit":"no_settings","max_positions":"no_settings"}

def _make_asset_rules(sym: str, cd: int = 150, mp: dict = None, key: str = None,
                      _cached_global: dict = None, _cached_events: dict = None) -> dict:
    """Kural durumlarini hesapla — moduler engine'e yonlendirir.
    ONEMLI: key icin event ayari YOKSA tum kurallar 'no_settings' doner → islem acilmaz.
    _cached_global: onceden yuklenmis global ayarlar (dosya okuma atlama)
    _cached_events: onceden yuklenmis tum event ayarlari {key: dict} (DB okuma atlama)."""
    if mp is None:
        mp = _asset_market.get(key or sym, {"up_ask": 0.5, "slippage_pct": 1.2})
    if _cached_global is None:
        from backend.config import load_settings
        global_settings = load_settings()
    else:
        global_settings = _cached_global
    if key:
        if _cached_events is not None:
            event_s = _cached_events.get(key)
        else:
            from backend.storage.db import get_event_settings
            event_s = get_event_settings(key)
        if event_s:
            merged = {**global_settings, **event_s}
        else:
            # Ayar yok → tum kurallar bloke, bot bu event'te islem acamaz
            return dict(_NO_SETTINGS)
    else:
        merged = global_settings
    return _evaluate_rules(sym, cd, mp, app_state["positions"], merged)



# ─── STATE UPDATE TICK (tüm veri Polymarket'ten) ────────────────────────────
async def simulation_tick():
    """Her 50ms _market_cache'i okuyup app_state["assets"]'i gunceller."""
    while True:
        await asyncio.sleep(0.05)
        try:
            asset_states = {}
            now_ts_f  = time.time()           # float — milisaniye hassasiyeti için
            now_ts    = int(now_ts_f)
            pinned_set = set(app_state["pinned"])
            # Pozisyon lookuplarını ön hesapla — her event için linear scan yapmamak için
            open_sym_set = {p.get("asset") for p in app_state["positions"]}

            # Tüm ayarları bir kez oku — her event için tekrar DB/dosya okuma yapma
            from backend.config import load_settings as _ls_tick
            from backend.storage.db import get_all_event_settings as _get_all_es
            _tick_global_settings = _ls_tick()
            _tick_event_settings  = _get_all_es()  # {key: settings_dict} — tek SQL sorgusu

            for i, (key, real) in enumerate(list(get_market_cache().items())):
                # Her 4 event'te bir event loop'a yield — broadcast_loop ve CLOB WS'in çalışmasına izin ver
                if i > 0 and i % 4 == 0:
                    await asyncio.sleep(0)
                sym = key.split("_")[0]
                info = ASSETS.get(sym) or COIN_REGISTRY.get(sym)
                if not info:
                    continue

                tf    = real.get("timeframe", "5M")
                cd    = max(0.0, real["end_ts"] - now_ts_f)   # float: 145.3sn hassasiyeti
                mp    = _asset_market.get(key, {})

                # Fiyat kaynagi onceligine gore:
                # 1) CLOB midpoint (REST poll — EMA yumusatmali, her 3sn)
                # 2) CLOB WS best_ask (anlık ama stale / spike olabilir)
                # 3) Gamma outcomePrices (en stale — son care)
                # NOT: Son 20sn price lock aktif — WS ve REST poll guncelleme yapmaz
                clob_up_mid  = mp.get("up_mid",   0)
                clob_dn_mid  = mp.get("down_mid", 0)
                clob_up_ask  = mp.get("up_ask",   0)
                clob_dn_ask  = mp.get("down_ask", 0)
                gamma_up     = real.get("up_price", 0.5)
                gamma_dn     = real.get("down_price", 0.5)
                # Aralik: 0.02 – 0.98 (genis — EMA zaten yumusatıyor, lock zaten koruyuyor)
                def _valid(v): return v is not None and 0.02 <= v <= 0.98
                up_price   = clob_up_mid if _valid(clob_up_mid) else (clob_up_ask if _valid(clob_up_ask) else gamma_up)
                down_price = clob_dn_mid if _valid(clob_dn_mid) else (clob_dn_ask if _valid(clob_dn_ask) else gamma_dn)

                if not mp:
                    mp = {
                        "up_bid": round(up_price - 0.005, 3), "up_ask": up_price,
                        "down_bid": round(down_price - 0.005, 3), "down_ask": down_price,
                        "slippage_pct": round(abs(up_price - down_price) * 100, 2) if up_price > 0 else 1.2,
                    }

                # BTC delta: live kripto fiyati - PTB (USD cinsinden)
                # current_slug ile stale PTB koruması — slug değişince 0 döner
                current_slug = real.get("slug", "")
                ptb_val = get_ptb(key, current_slug=current_slug)
                live_val = _rtds_prices.get(sym, 0)
                if ptb_val > 0 and live_val > 0:
                    mp["btc_delta"] = round(live_val - ptb_val, 2)
                else:
                    mp.pop("btc_delta", None)

                rules = _make_asset_rules(sym, cd, mp, key=key,
                                          _cached_global=_tick_global_settings,
                                          _cached_events=_tick_event_settings)
                settings_configured = rules.get("time") != "no_settings"

                # Stale data guard — market fiyatı her tick'te güncel işaretle
                if _EXEC_AVAILABLE and mp.get("up_ask", 0) > 0:
                    _entry_svc.record_price_update(key)

                # ── VERIFICATION HARD GATE ───────────────────────────────────
                # GRACE PERIOD YOK. Sym RTDS_SYMBOLS'ta ise → fiyat zorunlu.
                # Fiyat hiç gelmemişse (startup) veya stale ise → ENTRY BLOKE.
                # "Muhtemelen doğrudur" / "startup grace" kabul edilmez.
                # btc_delta kuralı aktif olmasa bile authoritative price olmadan trade yok.
                _ref_valid = True  # varsayılan: RTDS feed'i olmayan coinler için
                _ref_reason = ""
                if sym in RTDS_SYMBOLS:  # Bu coin için canlı fiyat feed'i bekleniyor
                    _ref_valid = _is_price_fresh(sym)
                    if not _ref_valid:
                        ts_known = _rtds_prices_ts.get(sym, 0.0)
                        if ts_known == 0.0:
                            _ref_reason = f"{sym} icin hic fiyat alinmadi (poll loop henuz calismadi?)"
                        else:
                            _age_s = round(time.time() - ts_known, 1)
                            _ref_reason = f"{sym} fiyati {_age_s}s eski (>{RTDS_STALE_SEC}s = stale)"
                        logger.debug(f"[VERIFICATION_GATE] {key}: {_ref_reason} — entry bloke")

                # ── MARKET VALIDITY CHECK ─────────────────────────────────────
                # CLOB verisi taze mi? entry_service'in stale guard'ı ile tutarlı.
                _market_valid = True
                _market_reason = ""
                if _EXEC_AVAILABLE:
                    _market_valid = _entry_svc.is_data_fresh(key)
                    if not _market_valid:
                        _market_reason = f"{key} CLOB verisi stale (>{_entry_svc.STALE_DATA_SEC}s)"

                # ── TRADE ALLOWED (combined verification result) ───────────────
                # Her iki kaynak da taze olmali: reference (RTDS) + market (CLOB)
                _trade_allowed = _ref_valid and _market_valid and settings_configured
                _trade_block_reason = _ref_reason or _market_reason or ("settings_missing" if not settings_configured else "")

                # ── ENTRY TRIGGER — HARD BLOCK ────────────────────────────────
                # trade_allowed = False ise entry kesinlikle yapilmaz. Soft warning yok.
                if (_EXEC_AVAILABLE
                        and app_state.get("bot_running")
                        and _trade_allowed                # HARD BLOCK: ref + market + settings
                        and not _entry_svc.is_event_locked(key)
                        and all(v == "pass" for v in rules.values())):
                    from backend.config import load_settings as _ls
                    from backend.storage.db import get_event_settings as _ges
                    ev_s = _ges(key) or {}
                    merged_s = {**_ls(), **ev_s}
                    trade_count = _event_trade_counts.get(key, 0)
                    open_count  = _pos_tracker.get_active_count()
                    # max_total_trades: bot başlatılırken app_state'e set edilir (0 = sonsuz)
                    # app_state değeri öncelikli; yoksa merged_s'ten oku
                    max_total = int(app_state.get("max_total_trades",
                                    merged_s.get("max_total_trades", 0)))
                    if max_total > 0 and sum(_event_trade_counts.values()) >= max_total:
                        # Max işlem sayısına ulaşıldı — botu otomatik durdur
                        if app_state.get("bot_running"):
                            app_state["bot_running"] = False
                            app_state["strategy_status"] = "IDLE"
                            addlog("info", f"Bot otomatik durdu — {max_total} işlem tamamlandı")
                        continue
                    asyncio.create_task(entry_service_task(
                        key, sym, mp, rules, merged_s, real, open_count, trade_count
                    ))

                # Event verisi (Polymarket'ten)
                # ── VERIFICATION STATE (canonical registry field update) ───────
                # simulation_tick dogrulamayi gerceklestirdi — market_cache entry guncelle
                _v_state = "verified" if (_ref_valid and _market_valid) else ("stale" if not _ref_valid else "market_stale")
                real["verification_state"] = _v_state

                real_event = {
                    "id":            real.get("conditionId") or real.get("slug", ""),
                    "slug":          real.get("slug", ""),
                    "conditionId":   real.get("conditionId", ""),
                    "up_asset_id":   real.get("up_asset_id", real.get("tokens", [""])[0] if real.get("tokens") else ""),
                    "down_asset_id": real.get("down_asset_id", real.get("tokens", ["",""])[1] if len(real.get("tokens", [])) > 1 else ""),
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
                    "market_status": real.get("market_status", "open"),
                    "source":        "live",
                }

                # Fiyat tazeliği — entry_service.record_price_update() zamanı
                price_ts = 0
                if _EXEC_AVAILABLE:
                    price_ts = int(_entry_svc._last_price_update.get(key, 0) * 1000)  # ms

                # ── REFERENCE STATE FRESHNESS ─────────────────────────────────
                _ref_st = _reference_state.get(sym, {})
                _lp_age_ms = int((now_ts_f - _rtds_prices_ts[sym]) * 1000) if sym in _rtds_prices_ts else -1

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
                    "has_position": sym in open_sym_set,
                    "settings_configured": settings_configured,
                    "phase":        _asset_phases.get(sym, "entry"),
                    "slug":         current_slug,
                    "ptb":          get_ptb(key, current_slug=current_slug),
                    "live_price":   get_live_price(sym),
                    "price_ts":     price_ts,
                    "price_source": "backend",
                    # ── EVENT STATE (verification fields) ───────────────────
                    "reference_valid":     _ref_valid,
                    "market_valid":        _market_valid,
                    "trade_allowed":       _trade_allowed,
                    "verification_status": _v_state,
                    "invalid_reason":      _trade_block_reason,
                    # ── LIVE PRICE METADATA (per-asset health) ───────────────
                    "live_price_age_ms":   _lp_age_ms,
                    "live_price_verified": _ref_valid,
                    # ── RELAY PRICE (display-only, NOT authoritative) ────────
                    "relay_price":         _relay_prices.get(sym, 0),
                }

            app_state["assets"] = asset_states
            app_state["ws_client_count"] = len(ws_clients)

            # ── POSITION TRACKER SYNC ─────────────────────────────────────────
            # Açık pozisyonların mark fiyatlarını güncelle + app_state'e yaz
            if _EXEC_AVAILABLE:
                for pos in _pos_tracker.get_active_positions():
                    k = pos.event_key
                    m = _asset_market.get(k, {})
                    mark = m.get("up_ask" if pos.side == "UP" else "down_ask", 0)
                    if mark > 0:
                        _pos_tracker.update_mark(pos.trade_id, mark)
                app_state["positions"] = _pos_tracker.to_app_state_positions()

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


# ─── ENTRY SERVICE TASK WRAPPER ──────────────────────────────────────────────
async def entry_service_task(key, sym, mp, rules, settings, market_info, open_count, trade_count):
    """entry_service.try_open_position'ı asyncio task olarak çalıştıran wrapper."""
    if not _EXEC_AVAILABLE:
        return
    try:
        success = await _entry_svc.try_open_position(
            event_key=key,
            sym=sym,
            mp=mp,
            rules=rules,
            settings=settings,
            market_info=market_info,
            open_position_count=open_count,
            event_trade_count=trade_count,
        )
        if success:
            _event_trade_counts[key] = _event_trade_counts.get(key, 0) + 1
            addlog("success", f"Pozisyon açıldı: {key} | toplam: {_event_trade_counts[key]}")
    except Exception as e:
        logger.error(f"entry_service_task hata [{key}]: {e}")
        _entry_svc.unlock_event(key)


# ─── BROADCAST ────────────────────────────────────────────────────────────────

def _build_broadcast_payload() -> str:
    """Sadece hızlı değişen alanları gönder — events alanı assets.event ile aynı, duplicate."""
    now_ts = time.time()
    # Countdown'ı broadcast anında hesapla — simulation_tick gecikmesinden bağımsız
    raw_assets = app_state.get("assets", {})
    assets_out = {}
    for key, a in raw_assets.items():
        end_ts = a.get("event", {}).get("end_ts", 0)
        cd = round(max(0.0, end_ts - now_ts), 1) if end_ts else a.get("countdown", 0)
        # Countdown broadcast anında hesaplanır — simulation_tick gecikmesinden bağımsız
        # Verification fields simulation_tick'te hesaplanmış; sadece countdown güncelle
        assets_out[key] = {**a, "countdown": cd}
    # Sistem geneli veri sağlığı — frontend data health badge için
    fresh_syms     = [s for s, ts in _rtds_prices_ts.items() if now_ts - ts <= RTDS_STALE_SEC]
    stale_syms     = [s for s, ts in _rtds_prices_ts.items() if now_ts - ts >  RTDS_STALE_SEC]
    no_data_syms   = [s for s in RTDS_SYMBOLS if s not in _rtds_prices_ts]
    data_health = {
        "rtds_fresh_count":  len(fresh_syms),
        "rtds_stale_syms":   stale_syms,
        "rtds_no_data_syms": no_data_syms,  # hiç fiyat gelmeyen (startup veya poll fail)
        "verified":          len(stale_syms) == 0 and len(fresh_syms) > 0 and len(no_data_syms) == 0,
        "stale_threshold_s": RTDS_STALE_SEC,
        # Authoritative reference state özeti
        "reference_state": {
            sym: {
                "last_price":     st.get("last_price", 0),
                "source":         st.get("source", ""),
                "valid":          st.get("valid", False),
                "age_ms":         int((now_ts - st.get("last_update_ts", 0)) * 1000) if st.get("last_update_ts") else -1,
            }
            for sym, st in _reference_state.items()
        },
    }
    fast = {
        "bot_running":       app_state["bot_running"],
        "mode":              app_state.get("mode", "LIVE"),
        "balance":           app_state.get("balance", 0.0),
        "session_pnl":       app_state.get("session_pnl", 0.0),
        "assets":            assets_out,
        "pinned":            app_state.get("pinned", []),
        "positions":         app_state.get("positions", []),
        "trade_history":     app_state.get("trade_history", []),
        "connection_status": app_state.get("connection_status", {}),
        "strategy_status":   app_state.get("strategy_status", "SCANNING"),
        "safe_mode":         app_state.get("safe_mode", False),
        "ws_client_count":   app_state.get("ws_client_count", 0),
        "asset_settings":    app_state.get("asset_settings", {}),
        "max_total_trades":  app_state.get("max_total_trades", 0),
        "data_health":       data_health,
        "_tick":             int(now_ts * 1000),
    }
    return json.dumps({"type": "state_update", "data": fast})


async def broadcast_state(force: bool = False):
    if not ws_clients:
        return
    try:
        payload = _build_broadcast_payload()
    except Exception as e:
        logger.error(f"serialize error: {e}")
        return

    # _tick alanı her çağrıda farklı olduğundan hash check gereksiz — her 50ms'de direkt gönder
    dead = set()
    for client in ws_clients:
        try:
            await client.send_text(payload)
        except Exception as e:
            logger.debug(f"ws_client kopuk, temizleniyor: {e}")
            dead.add(client)
    ws_clients.difference_update(dead)


async def broadcast_loop():
    """Asyncio task — arka plan thread tarafından tetiklenir; kendi içinde sleep yok."""
    # Bu fonksiyon artık doğrudan çağrılmıyor — _broadcast_timer_thread tetikliyor.
    # Eski uyumluluk için boş bırakıldı; lifespan'de task olarak başlatılmaz.
    pass


# broadcast debug — app_state aracılığıyla routes.py'den erişilebilir
app_state["_dbg_thread_count"] = 0
app_state["_dbg_loop_count"]   = 0

async def _send_prebuilt(payload: str) -> None:
    """Önceden hazırlanmış payload'ı tüm WS istemcilerine gönder (hızlı — sadece network I/O)."""
    app_state["_dbg_loop_count"] = app_state.get("_dbg_loop_count", 0) + 1
    dead = set()
    for client in ws_clients:
        try:
            await client.send_text(payload)
        except Exception:
            dead.add(client)
    ws_clients.difference_update(dead)


def _broadcast_timer_thread(loop: asyncio.AbstractEventLoop) -> None:
    """Gerçek OS thread'i — asyncio scheduler'dan bağımsız, 50ms'de bir broadcast tetikler.
    JSON serializasyonu burada yapılır (event loop'u bloklamaz), sadece send event loop'ta çalışır."""
    INTERVAL = 0.05  # 50ms
    while True:
        time.sleep(INTERVAL)
        if not ws_clients:
            continue
        # User WS durumunu thread-safe güncelle
        if _EXEC_AVAILABLE:
            try:
                app_state["connection_status"]["user_ws"] = _user_ws.is_connected()
            except Exception:
                pass
        # JSON serializasyonu thread'de yap — event loop'u bloklamaz
        try:
            payload = _build_broadcast_payload()
        except Exception:
            continue
        # Sadece network send'i event loop'a yolla — çok hızlı, <1ms
        app_state["_dbg_thread_count"] = app_state.get("_dbg_thread_count", 0) + 1
        asyncio.run_coroutine_threadsafe(_send_prebuilt(payload), loop)


# GAMMA MARKET SCAN: _build_search_terms, _market_cache, _detect_tf, TF_SECONDS,
# _discovered_timeframes, get_active_timeframes, _slug_prefix, _slug_fullname,
# _calc_candidate_slugs, discover_slug_market, scan_slug_based, discovery_scan,
# scan_gamma_markets, refresh_cached_slugs, gamma_scan_loop
# _init_single_asset, broadcast_rate_limit
# → backend/market/scan.py


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
            token_to_key = {}  # token_id → (market_key, "up"/"down")
            for key, info in get_market_cache().items():
                tokens = info.get("tokens", [])
                if tokens:
                    if len(tokens) > 0:
                        subscribe_assets.append({"asset_id": tokens[0]})
                        token_to_key[tokens[0]] = (key, "up")
                    if len(tokens) > 1:
                        subscribe_assets.append({"asset_id": tokens[1]})
                        token_to_key[tokens[1]] = (key, "down")

            if not subscribe_assets:
                addlog("info", "CLOB WS: Henuz token yok, Gamma scan bekleniyor...")
                app_state["connection_status"]["clob_ws"] = False
                await asyncio.sleep(10)
                continue

            addlog("info", f"CLOB WS baglaniyor... ({len(subscribe_assets)} token)")
            # Bağlantı anındaki cache versiyonunu kaydet — slug değişince reconnect tetiklenecek
            ts_at_connect = get_market_cache_ts()

            async with websockets.connect(CLOB_WS_URL, ping_interval=30) as ws:
                app_state["connection_status"]["clob_ws"] = True
                addlog("success", f"CLOB WS baglandi — {len(subscribe_assets)} token dinleniyor")

                # Subscribe to market updates
                sub_msg = json.dumps({
                    "assets_ids": [a["asset_id"] for a in subscribe_assets],
                    "type": "market",
                    "custom_feature_enabled": True,
                })
                await ws.send(sub_msg)

                async for raw_msg in ws:
                    # Yeni event geldi mi? Token ID'ler degistiyse reconnect yap
                    if get_market_cache_ts() > ts_at_connect:
                        addlog("info", "CLOB WS: Yeni event token'lari tespit edildi — yeniden baglaniliyor")
                        break  # inner for loop'u kir → yukarida yeni token_to_key ile reconnect olur
                    try:
                        if not raw_msg or raw_msg in ("PONG", "pong"):
                            continue
                        data = json.loads(raw_msg)

                        def _update_token(tid: str, bid=None, ask=None, price=None):
                            """Tek token icin fiyat guncelle — midpoint = (bid+ask)/2."""
                            if not tid:
                                return
                            if tid not in _clob_prices:
                                _clob_prices[tid] = {}
                            if bid is not None:
                                _clob_prices[tid]["best_bid"] = float(bid)
                            if ask is not None:
                                _clob_prices[tid]["best_ask"] = float(ask)
                            # Midpoint: bid+ask ortasi en gercek fiyat
                            b_val = _clob_prices[tid].get("best_bid")
                            a_val = _clob_prices[tid].get("best_ask")
                            if b_val is not None and a_val is not None and b_val > 0 and a_val > 0:
                                _clob_prices[tid]["price"] = round((b_val + a_val) / 2.0, 4)
                            elif price is not None:
                                _clob_prices[tid]["price"] = float(price)
                            _clob_prices[tid]["timestamp"] = time.time()

                            # _asset_market'a yaz
                            mapping = token_to_key.get(tid)
                            if not mapping:
                                return
                            mkey, side = mapping
                            if mkey not in _asset_market:
                                _asset_market[mkey] = {}
                            p = _clob_prices[tid].get("price", 0)
                            b = _clob_prices[tid].get("best_bid", 0)
                            a = _clob_prices[tid].get("best_ask", 0)
                            if not p:
                                return
                            # Stale data guard için son fiyat zamanını kaydet
                            if _EXEC_AVAILABLE:
                                _entry_svc.record_price_update(mkey)
                            # NOT: up_mid sadece REST midpoint poll tarafindan yazilir
                            # WS bid/ask event sonunda 0.01/0.99 spike yapabilir
                            if side == "up":
                                _asset_market[mkey]["up_ask"] = round(a if a > 0 else p, 4)
                                _asset_market[mkey]["up_bid"] = round(b if b > 0 else p - 0.005, 4)
                            else:
                                _asset_market[mkey]["down_ask"] = round(a if a > 0 else p, 4)
                                _asset_market[mkey]["down_bid"] = round(b if b > 0 else p - 0.005, 4)
                            # Spread — REST poll'dan gelen up_mid/down_mid ile
                            um = _asset_market[mkey].get("up_mid", 0)
                            dm = _asset_market[mkey].get("down_mid", 0)
                            if um > 0 and dm > 0:
                                _asset_market[mkey]["slippage_pct"] = round(max(0, (um + dm - 1) * 100), 2)

                        # ── Format 1: {price_changes: [{asset_id, price, best_bid, best_ask}]}
                        # ── Format 2: [{asset_id, price, best_bid, best_ask}] (array snapshot)
                        # ── Format 3: {asset_id, price, best_bid, best_ask} (single object)
                        if isinstance(data, list):
                            for ch in data:
                                _update_token(
                                    str(ch.get("asset_id", "")),
                                    bid=ch.get("best_bid"), ask=ch.get("best_ask"),
                                    price=ch.get("price") or ch.get("last_trade_price"),
                                )
                        elif "price_changes" in data:
                            for ch in (data["price_changes"] or []):
                                _update_token(
                                    str(ch.get("asset_id", "")),
                                    bid=ch.get("best_bid"), ask=ch.get("best_ask"),
                                    price=ch.get("price") or ch.get("last_trade_price"),
                                )
                        elif "asset_id" in data:
                            _update_token(
                                str(data["asset_id"]),
                                bid=data.get("best_bid"), ask=data.get("best_ask"),
                                price=data.get("price") or data.get("last_trade_price"),
                            )

                    except json.JSONDecodeError:
                        continue
                    except Exception:
                        pass

        except websockets.ConnectionClosed:
            addlog("warn", "CLOB WS baglanti koptu, yeniden baglaniyor...")
            app_state["connection_status"]["clob_ws"] = False
        except Exception as e:
            addlog("warn", f"CLOB WS hata: {e}")
            app_state["connection_status"]["clob_ws"] = False

        await asyncio.sleep(5)  # Reconnect delay


# ─── CLOB PRICE POLL (Sadece /midpoint — stabil, event sonu seesawing olmaz) ──
async def clob_midpoint_poll():
    """Her 3 saniyede CLOB REST'ten UP/DOWN midpoint fiyati cek.
    /midpoint → (best_bid + best_ask) / 2 — Stabil, event sonu spike olmaz.
    NOT: /price?side=buy event sonunda 0.01↔0.75 arasin da seesiyor — kullanilmiyor."""
    CLOB_BASE = "https://clob.polymarket.com"
    # Tek bir kalıcı istemci — her market için SSL handshake overhead'i kaldırır
    async with httpx.AsyncClient(timeout=4.0) as c:
        while True:
            try:
                pinned_set = set(app_state.get("pinned", []))
                keys_ordered = list(pinned_set) + [k for k in get_market_cache() if k not in pinned_set]
                for key in keys_ordered[:20]:
                    info = get_market_cache().get(key)
                    if not info:
                        continue

                    tokens = info.get("tokens", [])
                    if len(tokens) < 2:
                        continue
                    up_tid, dn_tid = tokens[0], tokens[1]
                    try:
                        # Sadece midpoint — 2 request/market, kalıcı bağlantı üzerinden
                        r_up_mid  = await c.get(f"{CLOB_BASE}/midpoint", params={"token_id": up_tid})
                        r_dn_mid  = await c.get(f"{CLOB_BASE}/midpoint", params={"token_id": dn_tid})

                        up_mid_val = float(r_up_mid.json().get("mid", 0)) if r_up_mid.status_code == 200 else 0
                        dn_mid_val = float(r_dn_mid.json().get("mid", 0)) if r_dn_mid.status_code == 200 else 0

                        def _mid_valid(v): return 0.02 <= v <= 0.98

                        if _mid_valid(up_mid_val) and _mid_valid(dn_mid_val):
                            if key not in _asset_market:
                                _asset_market[key] = {}
                            old_up  = _asset_market[key].get("up_mid", 0)
                            old_dn  = _asset_market[key].get("down_mid", 0)
                            alpha   = 0.5
                            sm_up   = round(old_up * (1-alpha) + up_mid_val * alpha, 4) if old_up > 0.01 else round(up_mid_val, 4)
                            sm_dn   = round(old_dn * (1-alpha) + dn_mid_val * alpha, 4) if old_dn > 0.01 else round(dn_mid_val, 4)

                            _asset_market[key]["up_ask"]    = sm_up
                            _asset_market[key]["up_mid"]    = sm_up
                            _asset_market[key]["down_ask"]  = sm_dn
                            _asset_market[key]["down_mid"]  = sm_dn
                            _asset_market[key]["up_bid"]    = round(sm_up - 0.005, 4)
                            _asset_market[key]["down_bid"]  = round(sm_dn - 0.005, 4)
                            _asset_market[key]["slippage_pct"] = round(max(0, (sm_up + sm_dn - 1) * 100), 2)
                    except Exception:
                        pass
                    await asyncio.sleep(0.5)  # 0.15→0.5sn: event loop yükü azaltır
            except Exception as e:
                logger.debug(f"midpoint poll hata: {e}")
            await asyncio.sleep(3)


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

    # ─── STARTUP: İlk scan henüz tasklist başlamadan tamamlanır ──
    # Background task olarak bırakılırsa kullanıcı 10-30sn boyunca boş dashboard görür.
    # Burada bekleyerek sunucu açılır açılmaz eventler hazır olur.
    # ─── Scan bağımlılıklarını enjekte et ──────────────────────────────────────
    def _on_new_event_handler(key: str, new_slug: str, old_slug: str) -> None:
        _event_trade_counts.pop(key, None)
        if _EXEC_AVAILABLE:
            _entry_svc.clear_lock_for_new_event(key, new_slug, old_slug)

    inject_scan_deps(
        asset_market=_asset_market,
        asset_phases=_asset_phases,
        asset_phase_ticks=_asset_phase_ticks,
        on_new_event=_on_new_event_handler,
        on_rate_limit=broadcast_rate_limit,
    )

    addlog("info", "Ilk market taramasi basliyor (baglanti hazir olmadan once)...")
    try:
        await scan_slug_based()
        addlog("success", f"Ilk tarama tamamlandi: {len(get_market_cache())} market bulundu")
        if not get_market_cache():
            addlog("warn", "Ilk tarama bos geldi — discovery scan deneniyor...")
            await discovery_scan()
            await scan_slug_based()
            addlog("info", f"Discovery sonrasi: {len(get_market_cache())} market")
    except Exception as e:
        addlog("warn", f"Startup scan hatasi: {e} — arka planda devam edilecek")

    # ─── SAFE MODE KALICILIĞI — DB'den yükle ────────────────────────────────
    from backend.storage.db import get_bot_state as _gbs
    _saved_safe = _gbs("safe_mode", "false")
    if _saved_safe == "true":
        app_state["safe_mode"] = True
        app_state["bot_running"] = False
        app_state["strategy_status"] = "SAFE_MODE"
        addlog("warn", "SAFE MODE kalici olarak aktif — bot baslatmak icin devre disi birakin")
        try:
            from backend.decision_log import log_bot_event
            log_bot_event("SAFE_MODE_RESTORE", "Restart sonrasi safe_mode DB'den yuklendi")
        except Exception:
            pass
    else:
        app_state["safe_mode"] = False
        # auto_start ayarı True ise bot restart'ta otomatik başlasın
        if settings.get("auto_start", False):
            app_state["bot_running"] = True
            app_state["strategy_status"] = "SCANNING"
            addlog("info", "auto_start=True — bot otomatik basladi")

    # ─── EXECUTION ENGINE BAŞLAT ─────────────────────────────────────────────
    if _EXEC_AVAILABLE:
        # Sell retry'ye market data getter'larını inject et
        _sell_retry.set_market_data_getter(lambda k: _asset_market.get(k, {}))
        _sell_retry.set_countdown_getter(
            lambda k: max(0, int(get_market_cache().get(k, {}).get("end_ts", 0)) - int(time.time()))
        )
        _sell_retry.set_token_id_getter(
            lambda k, side: (
                (get_market_cache().get(k, {}).get("tokens", []) or ["", ""])[0 if side == "UP" else 1]
            )
        )
        # DB'den önceki açık pozisyonları yükle (restart recovery)
        _pos_tracker.load_open_positions_from_db()
        # Session PnL callback — pozisyon kapanınca app_state["session_pnl"] güncellenir
        def _session_pnl_callback(trade_id: str, pnl: float, reason: str):
            if reason != "HOLD_TO_RESOLUTION":
                app_state["session_pnl"] = round(
                    app_state.get("session_pnl", 0.0) + pnl, 4
                )
        _pos_tracker.set_close_callback(_session_pnl_callback)
        # LIVE modda client'ı önceden ısıt
        _order_exec.init_live_client()
        # Reconciler getter'larını inject et
        _reconciler.set_market_cache_getter(lambda k: get_market_cache().get(k, {}))
        _reconciler.set_balance_updater(lambda bal: app_state.update({"balance": bal}))
        addlog("success", "Execution engine hazir — FAZ 1+3 aktif")

    tasks = []
    try:
        # Broadcast: asyncio task yerine OS thread — 50ms zamanlama garantisi
        _loop = asyncio.get_event_loop()
        _bt = threading.Thread(target=_broadcast_timer_thread, args=(_loop,), daemon=True)
        _bt.start()
        tasks.append(asyncio.create_task(simulation_tick()))
        tasks.append(asyncio.create_task(gamma_scan_loop()))
        tasks.append(asyncio.create_task(clob_ws_connect()))
        tasks.append(asyncio.create_task(clob_midpoint_poll()))
        tasks.append(asyncio.create_task(relayer_health_loop()))
        tasks.append(asyncio.create_task(ptb_loop(get_market_cache)))
        await start_rtds()  # RTDS WebSocket — canli coin fiyatlari

        # Execution servisleri başlat
        if _EXEC_AVAILABLE:
            await _sell_retry.start()      # TP/SL/Force 100ms loop
            await _reconciler.start()      # 30s token balance reconciliation
            await _user_ws.start()         # CLOB user fill events
            # Auto-claim: HOLD_TO_RESOLUTION pozisyonları event resolve sonrası redeem
            from backend.execution.relayer import auto_claim_loop
            def _claim_close_cb(trade_id, exit_price, pnl, reason):
                _pos_tracker.close_position(trade_id, exit_price, reason)
                app_state["positions"] = _pos_tracker.to_app_state_positions()
                app_state["session_pnl"] = round(app_state.get("session_pnl", 0.0) + pnl, 4)
                addlog("success", f"Auto-claim tamamlandı: {trade_id} | pnl: {pnl:+.4f}")
            tasks.append(asyncio.create_task(auto_claim_loop(
                pos_tracker=_pos_tracker,
                countdown_getter=lambda k: max(0, int(get_market_cache().get(k, {}).get("end_ts", 0)) - int(time.time())),
                close_callback=_claim_close_cb,
                mode_getter=lambda: app_state.get("mode", "PAPER"),
            )))

        yield
    finally:
        if _EXEC_AVAILABLE:
            await _sell_retry.stop()
            await _reconciler.stop()
            await _user_ws.stop()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


RELAYER_HEALTH_URL = "https://clob.polymarket.com"

# ─── RTDS WEBSOCKET: Canli Coin Fiyatlari ────────────────────────────────────
# Not: wss://ws-live-data.polymarket.com sadece tarihsel batch gonderir (streaming yok).
# Dis kaynaklar (Binance, Kraken) bu agda SSL hatasi veriyor.
# Cozum: Tek RTDS baglantisinda 7 coin subscribe → batch al → kapat → hemen tekrar.
# Boylece ~500ms guncelleme hizi elde edilir (baglanti overhead = ~470ms).
RTDS_URL = "wss://ws-live-data.polymarket.com"
_RTDS_HEADERS = {
    "Origin": "https://polymarket.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
}
_rtds_prices: dict[str, float] = {}    # sym → canli fiyat (USD) — SADECE backend poll loop yazar
_rtds_prices_ts: dict[str, float] = {} # sym → son poll guncelleme zamani (time.time())
_rtds_running = False

# ─── RELAY PRICES (browser → backend, display-only, NOT authoritative) ────────
# Browser RTDS streaming fiyatlarini buraya yazar — trade kararlarinda KULLANILMAZ.
# Sadece broadcast'te supplemental display bilgisi olarak yer alabilir.
# Authoritative kaynak: _rtds_prices (sadece backend Python poll loop'tan)
_relay_prices:    dict[str, float] = {}  # sym → browser-relayed fiyat (display-only)
_relay_prices_ts: dict[str, float] = {}  # sym → relay guncelleme zamani

# ─── REFERENCE STATE (authoritative RTDS per-symbol state) ────────────────────
# Backend'in karar icin kullandigi fiyat state'i. Sadece _rtds_poll_loop gunceller.
# Frontend'e broadcast edilir, trade gate bu state'e gore karar verir.
_reference_state: dict[str, dict] = {}  # sym → ReferenceState dict

def _make_reference_state(sym: str, val: float, source: str) -> dict:
    """Authoritative fiyat state'i olustur."""
    now = time.time()
    valid = RTDS_PRICE_MIN <= val <= RTDS_PRICE_MAX
    return {
        "symbol":           sym,
        "last_price":       val,
        "last_update_ts":   now,
        "last_verified_ts": now if valid else _reference_state.get(sym, {}).get("last_verified_ts", 0),
        "source":           source,   # "poll" | "relay"
        "freshness":        "fresh",  # set at creation; recomputed in verification check
        "valid":            valid,
        "invalid_reason":   "" if valid else f"price {val} out of range [{RTDS_PRICE_MIN}, {RTDS_PRICE_MAX}]",
    }

# ─── VERİFİCATION LAYER ───────────────────────────────────────────────────────
RTDS_STALE_SEC  = 10.0       # Bu kadar saniye guncelleme gelmezse fiyat "stale"
RTDS_PRICE_MIN  = 0.01       # Makul alt sinir (USD)
RTDS_PRICE_MAX  = 1_000_000.0  # Makul ust sinir (USD) — daha buyuk = invalid spike

def get_live_price(sym: str) -> float:
    """Belirli coin'in canli fiyatini don. Sadece authoritative poll prices."""
    return _rtds_prices.get(sym, 0.0)

def _is_price_fresh(sym: str) -> bool:
    """Authoritative RTDS fiyati taze ve gecerli mi?
    False → trade ACILMAZ. Grace period YOK — once fiyat, sonra trade."""
    ts = _rtds_prices_ts.get(sym, 0.0)
    if ts == 0.0:
        return False  # Hic guncelleme gelmedi (startup veya poll faili)
    age = time.time() - ts
    if age > RTDS_STALE_SEC:
        return False  # Stale
    val = _rtds_prices.get(sym, 0.0)
    if val < RTDS_PRICE_MIN or val > RTDS_PRICE_MAX:
        return False  # Aralik disi
    return True

async def _rtds_poll_loop():
    """Tek RTDS baglantisinda tum coinleri subscribe — batch al — hemen tekrar.
    ~500ms/cycle ile tum coinleri gunceller (agdaki SSL kisitlari nedeniyle Binance WS kullanilamiyor)."""
    global _rtds_prices
    # Her coin icin subscribe mesaji hazirla
    _sub_msgs = []
    _sym_lookup: dict[str, str] = {}  # rtds_symbol → "BTC" etc.
    for sym, rtds_sym in RTDS_SYMBOLS.items():
        _sub_msgs.append(json.dumps({
            "action": "subscribe",
            "subscriptions": [{
                "topic": "crypto_prices",
                "type": "*",
                "filters": json.dumps({"symbol": rtds_sym})
            }]
        }))
        _sym_lookup[rtds_sym] = sym

    fail_count = 0
    while _rtds_running:
        try:
            async with websockets.connect(
                RTDS_URL, ping_interval=None, close_timeout=3,
                additional_headers=_RTDS_HEADERS
            ) as ws:
                # Tum coinleri tek anda subscribe et
                for msg in _sub_msgs:
                    await ws.send(msg)
                fail_count = 0
                # Her batch: 1 bos + 1 veri mesaji (coin basina)
                received = 0
                deadline = time.time() + 1.5  # max 1.5s bekle
                while received < len(RTDS_SYMBOLS) and time.time() < deadline:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8", errors="ignore")
                        if not raw or not raw.strip():
                            continue
                        data = json.loads(raw)
                        payload = data.get("payload", {})
                        if not isinstance(payload, dict):
                            continue
                        # payload.symbol = hangi coin
                        rtds_sym = payload.get("symbol", "")
                        sym = _sym_lookup.get(rtds_sym)
                        arr = payload.get("data", [])
                        if arr and sym:
                            last = arr[-1]
                            v = last.get("value") or last.get("v") if isinstance(last, dict) else None
                            if v and float(v) > 0:
                                _val = round(float(v), 2)
                                _rtds_prices[sym]     = _val
                                _rtds_prices_ts[sym]  = time.time()
                                _reference_state[sym] = _make_reference_state(sym, _val, "poll")
                                received += 1
                        elif payload.get("value") and sym:
                            _val = round(float(payload["value"]), 2)
                            _rtds_prices[sym]     = _val
                            _rtds_prices_ts[sym]  = time.time()
                            _reference_state[sym] = _make_reference_state(sym, _val, "poll")
                            received += 1
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed:
                        break
                    except Exception:
                        continue
        except Exception as e:
            fail_count += 1
            if fail_count <= 3:
                addlog("warn", f"RTDS poll hata: {type(e).__name__}: {e}")
            if _rtds_running:
                await asyncio.sleep(min(fail_count, 5))
                continue
        # Hemen bir sonraki cycle — bekleme yok

async def start_rtds():
    """RTDS polling baslat — tek baglantida 7 coin ~500ms guncelleme."""
    global _rtds_running
    _rtds_running = True
    asyncio.create_task(_rtds_poll_loop())
    addlog("success", f"RTDS polling baslatildi — {len(RTDS_SYMBOLS)} coin ~500ms guncelleme")


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

# API Router — temiz route'lar (state/db bağımlıları)
app.include_router(api_router)

# CORS: sadece localhost kaynaklarına izin ver (local bot)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8002", "http://127.0.0.1:8002", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


# ─── WEBSOCKET ────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)

    # Anlık state'i yeni istemciye hemen gönder (broadcast_loop'u bekleme)
    try:
        await ws.send_text(_build_broadcast_payload())
    except Exception:
        pass

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
            try:
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    continue
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
            elif msg.get("type") == "price_relay":
                # Browser RTDS streaming → backend relay.
                # ÖNEMLI: Bu veri authoritative DEĞIL — trade kararlarında kullanılmaz.
                # Sadece _relay_prices'a yazılır (display-only supplemental data).
                # Authoritative kaynak: _rtds_prices (sadece _rtds_poll_loop'tan).
                sym = msg.get("sym", "")
                val = msg.get("val", 0)
                if sym and isinstance(val, (int, float)) and val > 0:
                    _relay_prices[sym]    = round(float(val), 2)
                    _relay_prices_ts[sym] = time.time()
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
# ─── /api/status, /api/settings, /api/settings/{key}, /api/settings-all ──────
# → backend/api/routes.py (api_router)

# ─── /api/bot/start, /api/bot/stop → backend/api/routes.py ──────────────────

@app.post("/api/bot/emergency-stop")
async def emergency_stop():
    """ACIL DURDUR — tum pozisyonlari force sell olarak isaretler + safe_mode kalici aktif."""
    app_state["bot_running"] = False
    app_state["strategy_status"] = "EMERGENCY_STOP"
    app_state["safe_mode"] = True

    # DB'ye kalici yaz
    from backend.storage.db import set_bot_state as _sbs
    _sbs("safe_mode", "true")

    # Acik pozisyonlari force sell olarak isaretler (sell_retry kapatir)
    force_count = 0
    if _EXEC_AVAILABLE:
        for pos in _pos_tracker.get_active_positions():
            _pos_tracker.mark_force_sell(pos.trade_id)
            force_count += 1
        app_state["positions"] = _pos_tracker.to_app_state_positions()

    addlog("warn", f"ACIL DURDUR — safe_mode kalici, {force_count} pozisyon FORCE_SELL isaretlendi")
    try:
        from backend.decision_log import log_bot_event
        log_bot_event("EMERGENCY_STOP",
                      f"Acil durdur: {force_count} pozisyon force_sell olarak isaretlendi")
    except Exception:
        pass
    return {"ok": True, "force_sold": force_count}


# ─── /api/bot/safe-mode/disable, /api/assets, /api/assets/{sym}/pin ──────────
# → backend/api/routes.py

@app.post("/api/assets/{sym}/select")
async def select_asset(sym: str):
    if sym in ASSETS:
        app_state["selected_asset"] = sym
    return {"ok": True, "selected": app_state["selected_asset"]}

# ─── /api/positions, /api/trades, /api/stats/daily, /api/audit ───────────────
# → backend/api/routes.py

@app.get("/api/markets/matched")
async def get_matched_markets():
    """Return Gamma-matched markets and CLOB live prices."""
    result = {}
    for sym, info in get_market_cache().items():
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
        _asset_phases[sym] = "entry"
        _asset_phase_ticks[sym] = 0
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
    to_del = [k for k in get_market_cache() if k.startswith(sym + "_")]
    for k in to_del:
        get_market_cache().pop(k, None)
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

# ─── /api/logs → backend/api/routes.py ──────────────────────────────────────


@app.get("/api/verify")
async def verify_data():
    """Dashboard verilerini Polymarket REST API ile karşılaştır — veri doğruluğu kontrolü."""
    results = {}
    now_ts = time.time()
    async with httpx.AsyncClient(timeout=10.0) as client:
        for key, cached in list(get_market_cache().items()):
            slug = cached.get("slug", "")
            if not slug:
                continue
            try:
                r = await client.get(f"https://gamma-api.polymarket.com/markets?slug={slug}")
                if r.status_code != 200:
                    continue
                data = r.json()
                m = data[0] if isinstance(data, list) and data else data
                if not m:
                    continue
                prices = json.loads(m.get("outcomePrices", "[]"))
                pm_up   = float(prices[0]) if len(prices) > 0 else None
                pm_down = float(prices[1]) if len(prices) > 1 else None
                dash_up   = cached.get("up_price", 0)
                dash_down = cached.get("down_price", 0)
                mp = _asset_market.get(key, {})
                results[key] = {
                    "polymarket": {"up": round(pm_up*100, 2) if pm_up else None, "down": round(pm_down*100, 2) if pm_down else None},
                    "dashboard":  {"up": round(dash_up*100, 2), "down": round(dash_down*100, 2)},
                    "clob_live":  {"up_ask": round(mp.get("up_ask",0)*100,2), "up_bid": round(mp.get("up_bid",0)*100,2),
                                   "down_ask": round(mp.get("down_ask",0)*100,2), "spread_pct": round(mp.get("slippage_pct",0),2)},
                    "diff_up":    round(abs(pm_up - dash_up)*100, 3) if pm_up else None,
                    "match":      abs((pm_up or 0) - dash_up) < 0.03 if pm_up else None,
                    "end_ts":     cached.get("end_ts"), "cd_sn": max(0, int(cached.get("end_ts",0) - now_ts))
                }
            except Exception as ex:
                results[key] = {"error": str(ex)}
    return {"ok": True, "verified_at": int(now_ts), "results": results}

# ─── /api/wallet, /api/wallet/save → backend/api/routes.py ──────────────────


# ─── /api/test/market, /api/test/prices → backend/api/routes.py ──────────────


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
