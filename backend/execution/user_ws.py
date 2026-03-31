"""
POLYFLOW User WebSocket — CLOB fill event takibi.
Görevler:
  - Polymarket CLOB user kanalına bağlan (L2 auth)
  - TRADE event gelince: ilgili pozisyonu fill_confirmed = True yap
  - ORDER_CANCELLED/REJECTED event: decision_log'a ORDER_REJECT yaz
  - ORDER event: logla

Auth: API key + secret + passphrase (py-clob-client ile aynı credentials)
Endpoint: wss://clob.polymarket.com/  — type: "User"
"""
import asyncio
import json
import logging
import os
import time
from typing import Optional

logger = logging.getLogger("polyflow.user_ws")

_running = False
_task: Optional[asyncio.Task] = None
_connected = False

# trade_id (order_id) → callback — _do_sell ve execute_entry tarafından kaydedilir
_pending_order_callbacks: dict = {}  # order_id → callable(event)


def is_connected() -> bool:
    return _connected


async def start():
    global _running, _task
    _running = True
    _task = asyncio.create_task(_user_ws_loop())
    logger.info("User WS servisi baslatildi")


async def stop():
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    logger.info("User WS servisi durduruldu")


async def _user_ws_loop():
    """Yeniden bağlanan ana döngü."""
    global _connected
    retry_delay = 5.0

    while _running:
        try:
            await _connect_and_listen()
        except asyncio.CancelledError:
            break
        except Exception as e:
            _connected = False
            logger.warning(f"User WS baglanti koptu: {e} — {retry_delay:.0f}s sonra tekrar")
        await asyncio.sleep(retry_delay)
        retry_delay = min(retry_delay * 1.5, 60)


async def _connect_and_listen():
    """CLOB user WS'e bağlan ve dinle."""
    global _connected

    try:
        import websockets
    except ImportError:
        logger.error("websockets paketi yuklu degil")
        return

    # Credentials
    _load_env()
    api_key    = os.environ.get("POLYMARKET_API_KEY", "")
    secret     = os.environ.get("POLYMARKET_SECRET", "")
    passphrase = os.environ.get("POLYMARKET_PASSPHRASE", "")

    if not api_key or not secret:
        logger.warning("User WS: API credentials eksik — baglanti atlanıyor")
        await asyncio.sleep(30)
        return

    WS_URL = "wss://clob.polymarket.com/"

    # L2 Auth subscription message
    sub_msg = json.dumps({
        "auth": {
            "apiKey":     api_key,
            "secret":     secret,
            "passphrase": passphrase,
        },
        "markets":   [],
        "assets_ids": [],
        "type": "User",
    })

    logger.info("User WS baglanıyor...")

    async with websockets.connect(
        WS_URL,
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
    ) as ws:
        await ws.send(sub_msg)
        _connected = True
        logger.info("User WS baglandi — fill eventi bekleniyor")

        async for raw in ws:
            if not _running:
                break
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="ignore")
            if not raw or raw in ("PONG", "pong"):
                continue
            try:
                _handle_user_event(json.loads(raw))
            except Exception as e:
                logger.debug(f"User WS event isleme hatasi: {e}")

    _connected = False


def _handle_user_event(event: dict):
    """User WS event işleyici."""
    from backend.execution import position_tracker
    from backend.execution.models import TradeStatus

    event_type = event.get("event_type", "").upper()

    if event_type == "TRADE":
        _handle_trade_event(event, position_tracker)
    elif event_type in ("ORDER",):
        _handle_order_event(event)
    else:
        logger.debug(f"User WS bilinmeyen event: {event_type}")


def _handle_trade_event(event: dict, position_tracker):
    """Fill eventi — ilgili pozisyonu güncelle."""
    order_id   = event.get("maker_order_id") or event.get("taker_order_id") or ""
    price_str  = event.get("price", "0")
    size_str   = event.get("size", "0")
    asset_id   = event.get("asset_id", "")
    side       = event.get("side", "").upper()

    try:
        fill_price = float(price_str)
        fill_size  = float(size_str)
    except (ValueError, TypeError):
        return

    logger.info(
        f"User WS TRADE: order_id={str(order_id)[:12]} "
        f"asset={asset_id[:8]}... price={fill_price:.4f} size={fill_size:.4f} side={side}"
    )

    # Matching order_id ile pozisyon bul
    matched = False
    for pos in position_tracker.get_all_positions():
        if pos.order_id and pos.order_id == str(order_id)[:32]:
            pos.fill_confirmed = True
            # Gerçek fill price ile güncelle (REST'ten fark varsa)
            if fill_price > 0 and abs(fill_price - pos.entry_actual) > 0.005:
                logger.info(
                    f"User WS fill price duzeltmesi [{pos.trade_id}]: "
                    f"{pos.entry_actual:.4f} -> {fill_price:.4f}"
                )
                pos.entry_actual = fill_price
                # TP/SL'yi gerçek fill üzerinden yeniden hesapla
                # (entry_service hesapladı ama fill price farklıysa)
            matched = True
            logger.info(
                f"User WS fill confirmed [{pos.trade_id}] "
                f"order_id={str(order_id)[:12]} @ {fill_price:.4f}"
            )
            break

    if not matched and order_id:
        logger.debug(f"User WS: eslesen pozisyon bulunamadi order_id={str(order_id)[:12]}")

    # Pending callback varsa tetikle
    cb = _pending_order_callbacks.pop(str(order_id), None)
    if cb:
        try:
            cb(event)
        except Exception:
            pass


def _handle_order_event(event: dict):
    """Order status event (cancelled, rejected vs.)"""
    order_id = event.get("id") or event.get("order_id") or ""
    status   = event.get("status", "").upper()

    if status in ("CANCELLED", "REJECTED", "EXPIRED"):
        logger.warning(
            f"User WS ORDER {status}: order_id={str(order_id)[:12]}"
        )
        # decision_log'a yaz
        try:
            # event_key: asset_id'den bul (best effort)
            from backend.decision_log import log_order_reject
            asset_id = event.get("asset_id", "")
            log_order_reject(
                event_key=asset_id[:20],
                reason=f"order_{status.lower()}",
                order_id=str(order_id)[:32],
            )
        except Exception:
            pass
    else:
        logger.debug(f"User WS ORDER: status={status} order_id={str(order_id)[:12]}")


def _load_env():
    """Credentials'ı .env'den yükle (zaten yüklüyse skip)."""
    if os.environ.get("POLYMARKET_API_KEY"):
        return
    env_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
    )
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
