"""
POLYFLOW Order Executor — LIVE FOK order + py-clob-client + HMAC signing.
Referans: D:/polymarketminiclaude_NEWDASHBOARD/backend/order_executor.py (adapte edildi)

LIVE only — paper mode yok (kullanıcı talebi).
HMAC signing: py-clob-client içinde hallediyor — manuel signing gerekmez.
"""
import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

logger = logging.getLogger("polyflow.executor")

# ── Singleton ClobClient ──────────────────────────────────────────────────────
_clob_client = None
_clob_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="clob")

CLOB_HOST        = "https://clob.polymarket.com"
POLYGON_CHAIN_ID = 137

# HTTP 425 retry parametreleri (matching engine restart için)
_425_RETRY_INTERVAL = 5
_425_MAX_RETRIES    = 18   # max 90 saniye


def _get_clob_client():
    """Singleton ClobClient. İlk çağrıda .env'den credentials okur."""
    global _clob_client
    if _clob_client is not None:
        return _clob_client

    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds

        _load_env()

        private_key = os.environ.get("POLYMARKET_PRIVATE_KEY", "")
        api_key     = os.environ.get("POLYMARKET_API_KEY", "")
        secret      = os.environ.get("POLYMARKET_SECRET", "")
        passphrase  = os.environ.get("POLYMARKET_PASSPHRASE", "")
        funder      = os.environ.get("POLYMARKET_FUNDER", "").strip()
        sig_type_str = os.environ.get("POLYMARKET_SIG_TYPE", "2").strip()

        # Fallback: settings.json'dan oku
        if not api_key:
            from backend.config import load_settings as _ls
            s = _ls()
            api_key    = s.get("polymarket_api_key", "")
            secret     = s.get("polymarket_secret", "")
            passphrase = s.get("polymarket_passphrase", "")

        if not private_key:
            logger.error("POLYMARKET_PRIVATE_KEY .env'de bulunamadı")
            return None
        if not api_key:
            logger.error("Polymarket API credentials eksik (.env veya settings)")
            return None

        if not private_key.startswith("0x"):
            private_key = "0x" + private_key

        sig_type     = int(sig_type_str) if sig_type_str.isdigit() else 2
        funder_addr  = funder if funder else None

        creds = ApiCreds(
            api_key=api_key,
            api_secret=secret,
            api_passphrase=passphrase
        )
        _clob_client = ClobClient(
            host=CLOB_HOST,
            chain_id=POLYGON_CHAIN_ID,
            key=private_key,
            creds=creds,
            signature_type=sig_type,
            funder=funder_addr,
        )
        mode_str = f"Proxy (funder={funder_addr[:8]}...)" if funder_addr else "EOA"
        logger.info(f"Polymarket ClobClient başlatıldı — sig_type={sig_type} ({mode_str})")
        return _clob_client

    except Exception as e:
        logger.error(f"ClobClient başlatma hatası: {e}")
        return None


def _reset_clob_client():
    """Hata sonrasında client sıfırla."""
    global _clob_client
    _clob_client = None


def _load_env():
    """.env dosyasını os.environ'a yükle (python-dotenv olmadan)."""
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip(); val = val.strip()
            if key:
                os.environ[key] = val


def _is_425(e: Exception) -> bool:
    """HTTP 425 Too Early — matching engine restart mı?"""
    if getattr(e, "status_code", None) == 425:
        return True
    return "425" in str(e) or "too early" in str(e).lower()


# ─── BUY (Entry) ─────────────────────────────────────────────────────────────

async def execute_entry(
    event_key: str,
    side: str,
    entry_price: float,
    amount: float,
    token_id: str,
    mode: str = "LIVE",
) -> Optional[float]:
    """
    Giriş emri gönder.
    Döner: gerçek fill fiyatı (float) veya None (başarısız)
    """
    if mode != "LIVE":
        # Gelecekte paper mode eklenirse burada simüle edilir
        logger.warning(f"execute_entry: mode={mode} — sadece LIVE destekleniyor")
        return None

    if not token_id:
        logger.error(f"execute_entry [{event_key}]: token_id boş")
        return None

    client = _get_clob_client()
    if not client:
        return None

    from py_clob_client.clob_types import MarketOrderArgs, OrderType

    attempt = 0
    while True:
        try:
            order_args = MarketOrderArgs(
                token_id=token_id,
                amount=amount,
                side="BUY",
                order_type=OrderType.FOK,
            )
            loop = asyncio.get_event_loop()
            t0   = loop.time()

            order = await loop.run_in_executor(
                _clob_executor,
                lambda: client.create_market_order(order_args)
            )
            resp = await loop.run_in_executor(
                _clob_executor,
                lambda: client.post_order(order, OrderType.FOK)
            )
            elapsed_ms = (loop.time() - t0) * 1000

            status   = resp.get("status", "")
            order_id = resp.get("orderID") or resp.get("order_id") or ""

            logger.info(
                f"CLOB BUY yanıt ({elapsed_ms:.0f}ms): "
                f"status={status} orderID={str(order_id)[:12]}"
            )

            if status in ("matched", "filled") or order_id:
                actual = _parse_fill_price(resp, entry_price)
                logger.info(
                    f"LIVE giriş OK [{event_key}] — {side} @ {actual:.4f} "
                    f"(hedef {entry_price:.4f}) | {elapsed_ms:.0f}ms"
                )
                return actual
            else:
                logger.warning(f"LIVE giriş dolmadı [{event_key}] — status: {status}")
                return None

        except Exception as e:
            if _is_425(e):
                attempt += 1
                if attempt > _425_MAX_RETRIES:
                    logger.error(f"Matching engine 90s içinde toparlanmadı [{event_key}] — iptal")
                    return None
                logger.warning(
                    f"Matching engine restart (425) [{event_key}] — "
                    f"{_425_RETRY_INTERVAL}s bekle ({attempt}/{_425_MAX_RETRIES})"
                )
                await asyncio.sleep(_425_RETRY_INTERVAL)
            else:
                logger.error(f"execute_entry hata [{event_key}]: {e}")
                _reset_clob_client()
                return None


# ─── SELL (Exit) ─────────────────────────────────────────────────────────────

async def execute_sell(
    event_key: str,
    trade_id: str,
    sell_price: float,
    shares: float,
    token_id: str,
    mode: str = "LIVE",
    use_market_order: bool = True,
) -> Optional[float]:
    """
    Çıkış emri gönder.
    use_market_order=True: FOK market (SL/force için hızlı)
    use_market_order=False: GTC limit (normal TP için)
    Döner: gerçek fill fiyatı veya None
    """
    if mode != "LIVE":
        logger.warning(f"execute_sell: mode={mode} — sadece LIVE destekleniyor")
        return None

    if not token_id:
        logger.error(f"execute_sell [{trade_id}]: token_id boş")
        return None

    client = _get_clob_client()
    if not client:
        return None

    # Gerçek token bakiyesini sorgula (precision hatası önlenir)
    real_shares = await _get_token_balance(client, token_id, shares)
    if real_shares is None or real_shares <= 0:
        logger.warning(f"Token bakiyesi sıfır [{trade_id}] — HOLD_TO_RESOLUTION")
        return None  # sell_retry HOLD_TO_RESOLUTION'a alacak

    from py_clob_client.clob_types import OrderArgs, OrderType

    try:
        loop = asyncio.get_event_loop()
        t0   = loop.time()

        if use_market_order:
            from py_clob_client.clob_types import MarketOrderArgs
            sell_amount = round(real_shares * sell_price, 4)
            order_args  = MarketOrderArgs(
                token_id=token_id,
                amount=sell_amount,
                side="SELL",
                order_type=OrderType.FOK,
            )
            order = await loop.run_in_executor(
                _clob_executor,
                lambda: client.create_market_order(order_args)
            )
            resp = await loop.run_in_executor(
                _clob_executor,
                lambda: client.post_order(order, OrderType.FOK)
            )
        else:
            # GTC Limit
            order_args = OrderArgs(
                token_id=token_id,
                price=round(sell_price, 4),
                size=real_shares,
                side="SELL",
            )
            resp = await loop.run_in_executor(
                _clob_executor,
                lambda: client.create_and_post_order(order_args)
            )

        elapsed_ms = (loop.time() - t0) * 1000
        status   = resp.get("status", "")
        order_id = resp.get("orderID") or resp.get("order_id") or ""

        logger.info(
            f"CLOB SELL yanıt ({elapsed_ms:.0f}ms): "
            f"status={status} orderID={str(order_id)[:12]}"
        )

        if status in ("matched", "filled", "live") or order_id:
            actual = _parse_fill_price(resp, sell_price)
            logger.info(
                f"LIVE çıkış OK [{event_key}] [{trade_id}] — @ {actual:.4f} | {elapsed_ms:.0f}ms"
            )
            return actual
        else:
            logger.warning(f"LIVE çıkış dolmadı [{trade_id}] — status: {status}")
            return None

    except Exception as e:
        if _is_425(e):
            logger.warning(f"Matching engine restart (425) [{trade_id}] — sell_retry tekrar dener")
            return None  # sell_retry zaten her 100ms'de tekrar dener
        logger.error(f"execute_sell hata [{trade_id}]: {e}")
        _reset_clob_client()
        return None


async def _get_token_balance(client, token_id: str, fallback: float) -> Optional[float]:
    """Gerçek token bakiyesini CLOB'dan sorgula."""
    try:
        from py_clob_client.clob_types import BalanceAllowanceParams, AssetType
        sig_type = int(os.environ.get("POLYMARKET_SIG_TYPE", "2"))
        params = BalanceAllowanceParams(
            asset_type=AssetType.CONDITIONAL,
            token_id=token_id,
            signature_type=sig_type,
        )
        loop = asyncio.get_event_loop()
        ba   = await loop.run_in_executor(None, client.get_balance_allowance, params)
        real = int(ba.get("balance", 0)) / 1_000_000
        return round(real, 6) if real > 0 else None
    except Exception:
        return fallback  # Bakiye sorgulanamadı → hesaplanan değeri kullan


def _parse_fill_price(resp: dict, fallback: float) -> float:
    """API yanıtından gerçek fill fiyatını çıkar."""
    try:
        for key in ("price", "average_price", "avg_price", "fillPrice"):
            v = resp.get(key)
            if v:
                return float(v)
        fills = resp.get("fills") or resp.get("trades") or []
        if fills:
            prices = [float(f.get("price", 0)) for f in fills if f.get("price")]
            if prices:
                return round(sum(prices) / len(prices), 4)
    except Exception:
        pass
    return fallback


async def fetch_usdc_balance() -> Optional[float]:
    """Anlık USDC bakiyesini çek."""
    client = _get_clob_client()
    if not client:
        return None
    try:
        from py_clob_client.clob_types import BalanceAllowanceParams, AssetType
        sig_type = int(os.environ.get("POLYMARKET_SIG_TYPE", "2"))
        params   = BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=sig_type,
        )
        loop = asyncio.get_event_loop()
        ba   = await loop.run_in_executor(_clob_executor, client.get_balance_allowance, params)
        if isinstance(ba, dict):
            raw = ba.get("balance", 0) or 0
            return round(float(raw) / 1_000_000, 4)
    except Exception:
        pass
    return None


def init_live_client():
    """Bot başlarken çağrılır — LIVE moddaysa client'ı önceden ısıt."""
    from backend.config import load_settings as _ls
    if _ls().get("mode") == "LIVE":
        _get_clob_client()
