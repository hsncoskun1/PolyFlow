"""
backend/api/routes.py — Temiz API route'ları (APIRouter)

Bağımlılıklar:
  - backend.state   : app_state, addlog, _log_buffer
  - config          : load_settings, save_settings, get_wallet_config
  - backend.storage.db : inline import (her route kendi ihtiyacını import eder)
"""
import time
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import APIRouter

from backend.state import app_state, addlog, _log_buffer
from config import load_settings, save_settings, get_wallet_config

router = APIRouter()

# POLYFLOW kök dizini (backend/api/routes.py → backend/api → backend → POLYFLOW)
_BASE_DIR = Path(__file__).parent.parent.parent

# Dış API sabit adresler (test endpoint'leri için)
_GAMMA_API = "https://gamma-api.polymarket.com"
_CLOB_API  = "https://clob.polymarket.com"

# ─── Per-Event Ayar Alanları (whitelist) ────────────────────────────────────
EVENT_SETTINGS_FIELDS = [
    "min_entry_price", "max_entry_price",
    "time_rule_threshold", "min_entry_seconds",
    "min_move_delta", "max_slippage_pct",
    "event_trade_limit", "max_open_positions",
    "stop_loss_enabled", "force_sell_enabled",
    "force_sell_before_resolution_seconds",
    "sell_retry_count", "order_amount",
    "target_exit_pct", "stop_loss_pct", "exit_mode", "strategy_mode",
    "order_amount_pct", "amount_mode",
]


# ─── Status ───────────────────────────────────────────────────────────────────

@router.get("/api/status")
async def get_status():
    return app_state


# ─── Global Settings ──────────────────────────────────────────────────────────

@router.get("/api/settings")
async def get_settings():
    return load_settings()


@router.post("/api/settings")
async def update_settings(body: dict):
    s = load_settings()
    s.update(body)
    save_settings(s)
    app_state["mode"] = s.get("mode", app_state["mode"])
    return {"ok": True, "settings": s}


# ─── Per-Event Settings ───────────────────────────────────────────────────────

@router.get("/api/settings/{key}")
async def get_event_settings_ep(key: str):
    from backend.storage.db import get_event_settings
    data = get_event_settings(key)
    if data is None:
        return {"ok": False, "key": key, "settings": None, "configured": False}
    return {"ok": True, "key": key, "settings": data, "configured": True}


@router.post("/api/settings/{key}")
async def save_event_settings_ep(key: str, body: dict):
    from backend.storage.db import save_event_settings
    filtered = {k: v for k, v in body.items() if k in EVENT_SETTINGS_FIELDS}
    if not filtered:
        return {"ok": False, "error": "Geçerli alan bulunamadı"}
    saved = save_event_settings(key, filtered)
    if saved is None:
        return {"ok": False, "error": "Veritabanına yazılamadı"}
    addlog("success", f"Event ayarları kaydedildi: {key}")
    return {"ok": True, "key": key, "settings": saved}


@router.delete("/api/settings/{key}")
async def delete_event_settings_ep(key: str):
    from backend.storage.db import delete_event_settings
    deleted = delete_event_settings(key)
    if not deleted:
        return {"ok": False, "error": "Silinemedi veya kayıt bulunamadı"}
    addlog("info", f"Event ayarları silindi: {key}")
    return {"ok": True, "key": key}


@router.get("/api/settings-all")
async def get_all_event_settings_ep():
    from backend.storage.db import get_all_event_settings
    return get_all_event_settings()


# ─── Bot Kontrol ──────────────────────────────────────────────────────────────

@router.post("/api/bot/start")
async def start_bot():
    if app_state.get("safe_mode"):
        addlog("warn", "Bot baslatma reddedildi — safe_mode aktif")
        return {"ok": False, "error": "safe_mode_active",
                "message": "Safe mode aktif — once /api/bot/safe-mode/disable ile devre disi birakin"}
    app_state["bot_running"] = True
    app_state["strategy_status"] = "SCANNING"
    app_state["session_pnl"] = 0.0
    addlog("info", "Bot STARTED")
    try:
        from backend.decision_log import log_bot_event
        log_bot_event("BOT_START", "Bot manuel olarak baslatildi")
    except Exception:
        pass
    return {"ok": True}


@router.post("/api/bot/stop")
async def stop_bot():
    app_state["bot_running"] = False
    app_state["strategy_status"] = "IDLE"
    addlog("warn", "Bot STOPPED")
    try:
        from backend.decision_log import log_bot_event
        log_bot_event("BOT_STOP", "Bot manuel olarak durduruldu")
    except Exception:
        pass
    return {"ok": True}


@router.post("/api/bot/safe-mode/disable")
async def disable_safe_mode():
    """Safe mode'u devre dışı bırak (acil durdur sonrası yeniden başlatmak için)."""
    app_state["safe_mode"] = False
    from backend.storage.db import set_bot_state as _sbs
    _sbs("safe_mode", "false")
    addlog("info", "Safe mode devre disi birakildi — bot baslatilabilir")
    try:
        from backend.decision_log import log_bot_event
        log_bot_event("SAFE_MODE_DISABLED", "Safe mode kullanici tarafindan devre disi birakildi")
    except Exception:
        pass
    return {"ok": True}


# ─── Assets ───────────────────────────────────────────────────────────────────

@router.get("/api/assets")
async def get_assets():
    return {"assets": app_state["assets"], "pinned": app_state["pinned"]}


@router.post("/api/assets/{sym}/pin")
async def toggle_pin_api(sym: str):
    """Event bazlı pin toggle. sym = 'BTC_5M' gibi key."""
    pinned = set(app_state["pinned"])
    if sym in pinned:
        pinned.discard(sym)
    else:
        pinned.add(sym)
    app_state["pinned"] = list(pinned)
    return {"ok": True, "pinned": app_state["pinned"]}


# ─── Pozisyonlar ──────────────────────────────────────────────────────────────

@router.get("/api/positions")
async def get_positions():
    return {"positions": app_state["positions"]}


@router.get("/api/positions/history")
async def get_positions_history():
    """DB'den tüm pozisyonları getir (açık + kapalı)."""
    from backend.storage.db import get_all_positions
    return {"positions": get_all_positions()}


@router.post("/api/positions/{pos_id}/close")
async def close_position(pos_id: str):
    app_state["positions"] = [p for p in app_state["positions"] if p["id"] != pos_id]
    from backend.storage.db import close_position as db_close
    db_close(pos_id, 0, "MANUAL")
    addlog("warn", f"Pozisyon {pos_id} manuel kapatildi")
    return {"ok": True}


# ─── Trade / İstatistik ───────────────────────────────────────────────────────

@router.get("/api/trades")
async def get_trades():
    """DB'den trade geçmişini getir."""
    from backend.storage.db import get_trades
    return {"trades": get_trades()}


@router.get("/api/stats/daily")
async def get_daily_stats():
    """Günlük istatistikler."""
    from backend.storage.db import get_daily_trade_count, get_daily_pnl
    return {"daily_trades": get_daily_trade_count(), "daily_pnl": get_daily_pnl()}


@router.get("/api/audit")
async def get_audit_log(key: str = "", limit: int = 100):
    """Karar günlüğü — her entry/skip/exit kararının sebepleri."""
    from backend.storage.db import get_audit_log, get_audit_stats
    entries = get_audit_log(event_key=key, limit=min(limit, 500))
    stats   = get_audit_stats()
    return {"logs": entries, "stats": stats, "count": len(entries)}


# ─── Log Buffer ───────────────────────────────────────────────────────────────

@router.get("/api/logs")
async def get_logs():
    return {"logs": _log_buffer[:100]}


# ─── Wallet ───────────────────────────────────────────────────────────────────

@router.get("/api/wallet")
async def get_wallet():
    cfg = get_wallet_config()
    configured = bool(cfg["private_key"] and cfg["api_key"])
    app_state["wallet_configured"] = configured

    def _mask(val: str, show: int = 4) -> str:
        """Hassas değerleri maskele: ilk/son show karakter görünür."""
        if not val:
            return ""
        if len(val) <= show * 2:
            return "*" * len(val)
        return val[:show] + "****" + val[-show:]

    return {
        "configured":      configured,
        "private_key":     _mask(cfg["private_key"], 6),
        "api_key":         cfg["api_key"],
        "secret":          _mask(cfg["secret"], 4),
        "passphrase":      _mask(cfg["passphrase"], 4),
        "funder":          cfg["funder"],
        "sig_type":        cfg["sig_type"],
        "relayer_api_key": _mask(cfg.get("relayer_api_key", ""), 4),
        "relayer_address": cfg.get("relayer_address", ""),
    }


@router.post("/api/wallet/save")
async def save_wallet(body: dict):
    """Cüzdan/API kimlik bilgilerini .env dosyasına kaydet."""
    env_path = _BASE_DIR / ".env"
    lines = []
    lines.append("## POLYFLOW .env")
    lines.append("## Olusturulma: " + datetime.now().strftime("%Y-%m-%d %H:%M"))
    lines.append("")

    pk              = body.get("private_key", "")
    funder          = body.get("funder", "")
    api_key         = body.get("api_key", "")
    secret          = body.get("secret", "")
    passphrase      = body.get("passphrase", "")
    sig_type        = body.get("sig_type", "2")
    relayer_api_key = body.get("relayer_api_key", "")
    relayer_address = body.get("relayer_address", "")

    if pk:
        lines.append(f"POLYMARKET_PRIVATE_KEY={pk}")
    if funder:
        lines.append(f"POLYMARKET_FUNDER={funder}")
    lines.append("")

    if api_key:
        lines.append(f"POLYMARKET_API_KEY={api_key}")
    if secret:
        lines.append(f"POLYMARKET_SECRET={secret}")
    if passphrase:
        lines.append(f"POLYMARKET_PASSPHRASE={passphrase}")
    lines.append(f"POLYMARKET_SIG_TYPE={sig_type}")
    lines.append("")

    if relayer_api_key:
        lines.append(f"POLYMARKET_RELAYER_API_KEY={relayer_api_key}")
    if relayer_address:
        lines.append(f"POLYMARKET_RELAYER_ADDRESS={relayer_address}")
    if relayer_api_key or relayer_address:
        lines.append("")

    with open(env_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    addlog("success", "Cuzdan ayarlari kaydedildi (.env guncellendi)")
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    return {"ok": True, "message": "Cuzdan ayarlari kaydedildi"}


# ─── Bağlantı Test ────────────────────────────────────────────────────────────

@router.get("/api/test/market")
async def test_market_fetch():
    """Test Polymarket Gamma API — crypto markets fetch speed & data."""
    url = f"{_GAMMA_API}/markets?tag=crypto&limit=20&active=true&closed=false"
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
            "ok": True, "status_code": resp.status_code,
            "elapsed_ms": elapsed_ms, "market_count": len(markets), "sample": sample,
        }
    except httpx.TimeoutException:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        addlog("warn", f"Gamma API test TIMEOUT ({elapsed_ms}ms)")
        return {"ok": False, "error": "timeout", "elapsed_ms": elapsed_ms}
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        addlog("warn", f"Gamma API test ERROR: {e}")
        return {"ok": False, "error": str(e), "elapsed_ms": elapsed_ms}


@router.get("/api/test/prices")
async def test_prices_fetch():
    """Test CLOB API — fetch current bid/ask prices for a sample token."""
    sample_tokens = [
        "21742633143463906290569050155826241533067272736897614950488156847949938836455",
    ]
    url = f"{_CLOB_API}/prices?token_ids={'%2C'.join(sample_tokens)}&side=BUY"
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        addlog("success", f"CLOB prices test OK — {elapsed_ms}ms")
        return {
            "ok": True, "status_code": resp.status_code,
            "elapsed_ms": elapsed_ms,
            "data": resp.json() if resp.status_code == 200 else None,
        }
    except Exception as e:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        return {"ok": False, "error": str(e), "elapsed_ms": elapsed_ms}
