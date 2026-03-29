"""POLYFLOW - Configuration Manager"""
import json
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent.parent
SETTINGS_FILE = BASE_DIR / "settings.json"
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE)

DEFAULT_SETTINGS = {
    "mode": "PAPER",
    "port": 8002,
    "time_rule_threshold": 90,
    "min_entry_seconds": 10,
    "min_entry_price": 0.75,
    "max_entry_price": 0.98,
    "target_exit_price": 0.90,
    "stop_loss_price": 0.80,
    "target_exit_pct": 20.0,
    "stop_loss_pct": 15.0,
    "exit_mode": "NUMERIC",
    "min_btc_move_up": 70.0,
    "min_btc_move_down": 70.0,
    "max_slippage_pct": 0.03,
    "order_amount": 2.0,
    "order_amount_pct": 10.0,
    "amount_mode": "USD",
    "event_trade_limit": 1,
    "max_open_positions": 1,
    "sell_retry_count": 200,
    "sell_retry_interval": 1,
    "auto_start": False,
    "auto_claim": True,
    "force_sell_enabled": True,
    "force_sell_before_resolution_seconds": 15,
    "btc_price_source": "BINANCE",
    "theme": "polymarket",
}


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE, "r") as f:
            saved = json.load(f)
        merged = {**DEFAULT_SETTINGS, **saved}
        return merged
    return dict(DEFAULT_SETTINGS)


def save_settings(settings: dict):
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


def get_wallet_config() -> dict:
    return {
        "private_key": os.getenv("POLYMARKET_PRIVATE_KEY", ""),
        "api_key": os.getenv("POLYMARKET_API_KEY", ""),
        "secret": os.getenv("POLYMARKET_SECRET", ""),
        "passphrase": os.getenv("POLYMARKET_PASSPHRASE", ""),
        "funder": os.getenv("POLYMARKET_FUNDER", ""),
        "sig_type": int(os.getenv("POLYMARKET_SIG_TYPE", "2")),
    }
