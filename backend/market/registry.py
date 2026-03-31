"""
backend/market/registry.py — Coin registry (COIN_REGISTRY, ASSETS) ve disk persistence.

Importlanabilir: main.py, scan.py, route'lar — circular import riski yok.
"""
import json
import logging
from pathlib import Path

logger = logging.getLogger("polyflow")

# POLYFLOW kök dizini (backend/market/registry.py → backend/market → backend → POLYFLOW)
_BASE_DIR = Path(__file__).parent.parent.parent

DISCOVERED_FILE = _BASE_DIR / "backend" / "discovered_assets.json"

# Başlangıç asset tanımları (display için)
ASSETS: dict[str, dict] = {
    "BTC":  {"name": "Bitcoin",      "icon": "₿",  "color": "#f7931a"},
    "ETH":  {"name": "Ethereum",     "icon": "Ξ",  "color": "#627eea"},
    "SOL":  {"name": "Solana",       "icon": "◎",  "color": "#9945ff"},
    "XRP":  {"name": "XRP",          "icon": "✕",  "color": "#00aae4"},
    "DOGE": {"name": "Dogecoin",     "icon": "Ð",  "color": "#c2a633"},
    "BNB":  {"name": "BNB",          "icon": "◆",  "color": "#f3ba2f"},
    "HYPE": {"name": "Hyperliquid",  "icon": "⚡",  "color": "#4ade80"},
}

# Coin metadata — sym → {name, slug_prefix, slug_fullname, icon, color}
COIN_REGISTRY: dict[str, dict] = {
    "BTC":  {"name": "Bitcoin",      "slug_prefix": "btc",      "slug_fullname": "bitcoin",     "icon": "₿", "color": "#f7931a"},
    "ETH":  {"name": "Ethereum",     "slug_prefix": "eth",      "slug_fullname": "ethereum",    "icon": "Ξ", "color": "#627eea"},
    "SOL":  {"name": "Solana",       "slug_prefix": "sol",      "slug_fullname": "solana",      "icon": "◎", "color": "#9945ff"},
    "XRP":  {"name": "XRP",          "slug_prefix": "xrp",      "slug_fullname": "xrp",         "icon": "✕", "color": "#00aae4"},
    "DOGE": {"name": "Dogecoin",     "slug_prefix": "doge",     "slug_fullname": "dogecoin",    "icon": "Ð", "color": "#c2a633"},
    "BNB":  {"name": "BNB",          "slug_prefix": "bnb",      "slug_fullname": "bnb",         "icon": "◆", "color": "#f3ba2f"},
    "HYPE": {"name": "Hyperliquid",  "slug_prefix": "hype",     "slug_fullname": "hype",        "icon": "⚡", "color": "#4ade80"},
}


def _save_discovered() -> None:
    """COIN_REGISTRY'yi diske kaydet (kalıcılık için)."""
    try:
        data = {sym: {k: v for k, v in info.items()} for sym, info in COIN_REGISTRY.items()}
        DISCOVERED_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"discovered_assets save error: {e}")


def _load_discovered() -> None:
    """Diskten keşfedilen coin'leri yükle, varsayılanlarla birleştir."""
    if not DISCOVERED_FILE.exists():
        return
    try:
        data = json.loads(DISCOVERED_FILE.read_text(encoding="utf-8"))
        for sym, info in data.items():
            if sym not in COIN_REGISTRY:
                COIN_REGISTRY[sym] = info
                ASSETS[sym] = {
                    "name": info.get("name", sym),
                    "icon": info.get("icon", "●"),
                    "color": info.get("color", "#888"),
                }
                logger.info(f"Discovered coin loaded: {sym} ({info.get('name','')})")
    except Exception as e:
        logger.warning(f"discovered_assets load error: {e}")


# Modül yüklenince otomatik yükle
_load_discovered()
