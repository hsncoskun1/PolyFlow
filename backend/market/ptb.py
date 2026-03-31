"""
backend/market/ptb.py — PTB (Price to Beat) Yöneticisi

Her event için açılış referans fiyatını (openPrice) yönetir.
  Kaynak 1: __NEXT_DATA__ scraping → openPrice (birincil)
  Kaynak 2: Gamma API eventMetadata.priceToBeat (fallback)

PTB bir kez kilitlenir ve event boyunca değişmez.
Yeni slug gelince eski değer sıfırlanır.
"""
import asyncio
import json
import logging
import re
import time
from typing import Callable

import httpx

from backend.state import app_state, addlog

logger = logging.getLogger("polyflow.ptb")

GAMMA_BASE = "https://gamma-api.polymarket.com"

# Coin isimleri → RTDS subscription (canlı fiyat için)
# Topic: crypto_prices (Binance kaynaklı), sembol formatı: btcusdt
RTDS_SYMBOLS = {
    "BTC": "btcusdt", "ETH": "ethusdt", "SOL": "solusdt",
    "XRP": "xrpusdt", "DOGE": "dogeusdt", "BNB": "bnbusdt", "HYPE": "hypeusdt",
}

# Variant map (TF → Polymarket past-results variant)
PTB_VARIANT = {
    "5M": "fiveminute", "15M": "fifteen", "1H": "hourly",
    "4H": "fourhour", "1D": "daily",
}

# ─── Module-level PTB state ───────────────────────────────────────────────────
_ptb_cache: dict[str, float] = {}     # key (BTC_5M) → openPrice
_ptb_locked: dict[str, bool] = {}     # key → kilitlendi mi
_ptb_slug_map: dict[str, str] = {}    # key → son kilitli slug


# ─── Fetch Helpers ────────────────────────────────────────────────────────────

async def _fetch_ptb_gamma(slug: str) -> float | None:
    """Gamma API events endpoint'inden eventMetadata.priceToBeat çek."""
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
                    try:
                        metadata = json.loads(metadata)
                    except Exception:
                        return None
                ptb = metadata.get("priceToBeat")
                if ptb and float(ptb) > 0:
                    return round(float(ptb), 2)
    except Exception as e:
        logger.warning(f"Gamma PTB hatası ({slug}): {e}")
    return None


async def _fetch_ptb_next_data(slug: str, symbol: str, variant: str) -> float | None:
    """Polymarket event sayfasından __NEXT_DATA__ ile openPrice çek."""
    try:
        url = f"https://polymarket.com/event/{slug}"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
            ),
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
        queries = (
            root.get("props", {})
                .get("pageProps", {})
                .get("dehydratedState", {})
                .get("queries", [])
        )

        for q in queries:
            key = q.get("queryKey", [])
            if (
                len(key) >= 5
                and key[0] == "crypto-prices"
                and key[1] == "price"
                and str(key[2]).upper() == symbol.upper()
                and key[4] == variant
            ):
                data = q.get("state", {}).get("data")
                if isinstance(data, dict):
                    op = data.get("openPrice")
                    cp = data.get("closePrice")
                    # Sadece aktif candle (closePrice=None)
                    if op and cp is None:
                        return round(float(op), 2)
    except Exception as e:
        logger.warning(f"__NEXT_DATA__ PTB hatası ({slug}): {e}")
    return None


# ─── Public API ───────────────────────────────────────────────────────────────

def get_ptb(key: str) -> float:
    """Belirli event key'i için PTB değerini döndür."""
    return _ptb_cache.get(key, 0.0)


# ─── PTB Loop ─────────────────────────────────────────────────────────────────

async def ptb_loop(get_market_cache: Callable[[], dict]) -> None:
    """
    Her event için PTB'yi dene — slug değişince sıfırla, __NEXT_DATA__ birincil.

    Args:
        get_market_cache: Callable, çağrıldığında güncel _market_cache dict'ini döndürür.
    """
    global _ptb_cache, _ptb_locked, _ptb_slug_map

    while True:
        try:
            now_ts = time.time()
            market_cache = get_market_cache()

            # Öncelik: pinned eventler (işlem açılacaklar) first
            _all_market_keys = list(market_cache.keys())
            _pinned_set = set(app_state.get("pinned", []))
            _ordered_market_keys = (
                [k for k in _all_market_keys if k in _pinned_set]
                + [k for k in _all_market_keys if k not in _pinned_set]
            )

            for key in _ordered_market_keys:
                real = market_cache.get(key)
                if real is None:
                    continue
                slug = real.get("slug", "")
                if not slug:
                    continue

                # Slug değiştiyse (yeni event) → eski PTB'yi sıfırla, hemen yeni fetch
                old_slug = _ptb_slug_map.get(key, "")
                slug_changed = (not old_slug) or (old_slug != slug)
                if slug_changed and old_slug and old_slug != slug:
                    _ptb_locked.pop(key, None)
                    _ptb_cache.pop(key, None)
                    _ptb_slug_map[key] = slug
                    addlog("info", f"Yeni slug: {key} — PTB sıfırlandı, anında fetch deneniyor")

                # Zaten bu slug için kilitliyse atla
                if _ptb_locked.get(key):
                    continue

                # Event bitmişse atla
                end_ts = real.get("end_ts", 0)
                if end_ts <= now_ts:
                    _ptb_locked.pop(key, None)
                    _ptb_cache.pop(key, None)
                    continue

                sym = key.split("_")[0]
                tf = key.split("_")[1] if "_" in key else "5M"
                variant = PTB_VARIANT.get(tf, "fiveminute")

                ptb = None

                # Yöntem 1 (birincil): __NEXT_DATA__ scraping — birebir doğru
                ptb = await _fetch_ptb_next_data(slug, sym, variant)

                # Yöntem 2 (fallback): Gamma API eventMetadata.priceToBeat
                if not ptb:
                    ptb = await _fetch_ptb_gamma(slug)

                if ptb and ptb > 0:
                    _ptb_cache[key] = ptb
                    _ptb_locked[key] = True
                    _ptb_slug_map[key] = slug
                    addlog("success", f"PTB kilitlendi: {key} = ${ptb:,.2f}")
                elif slug_changed:
                    # Yeni event PTB'si henüz hazır değil — 2sn sonra hemen tekrar dene
                    await asyncio.sleep(2)
                    ptb2 = await _fetch_ptb_next_data(slug, sym, variant)
                    if not ptb2:
                        ptb2 = await _fetch_ptb_gamma(slug)
                    if ptb2 and ptb2 > 0:
                        _ptb_cache[key] = ptb2
                        _ptb_locked[key] = True
                        _ptb_slug_map[key] = slug
                        addlog("success", f"PTB 2. deneme başarılı: {key} = ${ptb2:,.2f}")
                    else:
                        addlog("info", f"PTB bekleniyor: {key} (sonraki döngü deneyecek)")

                # Rate limit koruması: her event arası 0.5sn bekle
                await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"PTB döngüsü hatası: {e}")

        # Her 10 saniyede tekrar kontrol (yeni eventler için)
        await asyncio.sleep(10)
