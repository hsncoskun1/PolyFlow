"""
backend/state.py — Merkezi uygulama durumu ve log buffer.

main.py ve API route'ları bu modülden import yapar.
Circular import olmaz çünkü bu modül başka backend modülü import etmez.
"""
from datetime import datetime

# ─── DEFAULT PINNED SET ───────────────────────────────────────────────────────
DEFAULT_PINNED = {"BTC_5M", "ETH_5M", "SOL_5M"}

# ─── GLOBAL APP STATE ─────────────────────────────────────────────────────────
app_state: dict = {
    "bot_running":          False,
    "mode":                 "PAPER",
    "balance":              0.0,
    "session_pnl":          0.0,
    "session_start_balance": 0.0,
    "safe_mode":            False,
    "strategy_status":      "SCANNING",
    "positions":            [],
    "trade_history":        [],
    "connection_status": {
        "clob_ws": True, "btc_ws": True,
        "user_ws": False, "gamma_api": True,
    },
    "ws_client_count": 0,
    # Multi-asset
    "assets":           {},
    "pinned":           list(DEFAULT_PINNED),
    "selected_asset":   "BTC",
    # Legacy single-asset (selected_asset'tan doldurulur)
    "btc_price":        84250.0,
    "btc_change":       0.0,
    "countdown":        200,
    "active_event":     None,
    "events":           [],
    "market_prices":    {},
    "rules":            {},
}

# ─── LOG BUFFER ───────────────────────────────────────────────────────────────
_log_buffer: list[dict] = []


def addlog(level: str, message: str) -> None:
    """Anlık log mesajını belleğe ekle (max 300 satır LIFO)."""
    entry = {
        "time":    datetime.now().strftime("%H:%M:%S"),
        "level":   level,
        "message": message,
    }
    _log_buffer.insert(0, entry)
    if len(_log_buffer) > 300:
        _log_buffer.pop()
