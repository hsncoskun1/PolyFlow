"""
POLYFLOW Sell Retry — 100ms TP/SL/force sell exit loop.
Referans: D:/polymarketminiclaude_NEWDASHBOARD/backend/sell_retry.py (adapte edildi)

Multi-asset: her pozisyon kendi event_key'inden fiyat okur.
Smart force sell: karda+TP geçtiyse → HOLD_TO_RESOLUTION, zararda → hemen sat.
Orderbook anomaly: tek tick >30% düşüş → son bilinen fiyatı kullan, SL tetikleme.
"""
import asyncio
import logging
import time
from typing import Callable, Dict, Optional

from backend.execution.models import TradeStatus
from backend.execution import position_tracker, order_executor

logger = logging.getLogger("polyflow.sell_retry")

# Orderbook anomali uyarısı verilen trade_id'ler (tekrar loglamayı önle)
_orderbook_warned: set = set()
# Force sell "bekliyorum" uyarısı verilen trade_id'ler
_force_wait_warned: set = set()

# Dışarıdan inject edilecek market data getter
# main.py tarafından set edilir: set_market_data_getter(fn)
_get_market_data: Optional[Callable[[str], dict]] = None
_get_event_countdown: Optional[Callable[[str], int]] = None
_get_event_token_id: Optional[Callable[[str, str], str]] = None  # (key, side) → token_id


def set_market_data_getter(fn: Callable[[str], dict]):
    """main.py → _asset_market.get(key, {}) fonksiyonunu inject eder."""
    global _get_market_data
    _get_market_data = fn


def set_countdown_getter(fn: Callable[[str], int]):
    """main.py → event countdown getter."""
    global _get_event_countdown
    _get_event_countdown = fn


def set_token_id_getter(fn: Callable[[str, str], str]):
    """main.py → token_id getter: (event_key, side) → token_id"""
    global _get_token_id
    global _get_event_token_id
    _get_event_token_id = fn


# ─── Ana döngü ───────────────────────────────────────────────────────────────

_running = False
_task: Optional[asyncio.Task] = None


async def start():
    """Lifespan'dan çağrılır — exit loop'u başlat."""
    global _running, _task
    _running = True
    _task = asyncio.create_task(_exit_loop())
    logger.info("Sell retry loop başlatıldı (100ms)")


async def stop():
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    logger.info("Sell retry loop durduruldu")


async def _exit_loop():
    """Ana 100ms döngü — tüm açık pozisyonları kontrol eder."""
    global _running
    while _running:
        await asyncio.sleep(0.10)  # 100ms
        positions = position_tracker.get_active_positions()
        if not positions:
            continue

        from backend.config import load_settings as _ls
        global_settings = _ls()

        for pos in positions:
            try:
                await _handle_position(pos, global_settings)
            except Exception as e:
                logger.error(f"Exit loop hata [{pos.trade_id}]: {e}")


# ─── Pozisyon yönetimi ────────────────────────────────────────────────────────

async def _handle_position(pos, global_settings: dict):
    """Tek pozisyon için TP/SL/force sell kontrolü."""
    from backend.storage.db import get_event_settings

    # Event'e özgü ayarları al (yoksa global)
    ev_settings = get_event_settings(pos.event_key) or {}
    settings = {**global_settings, **ev_settings}

    # Market fiyatı
    mp = _get_market_data(pos.event_key) if _get_market_data else {}
    raw_mark = mp.get("up_ask" if pos.side == "UP" else "down_ask", 0)
    remaining = _get_event_countdown(pos.event_key) if _get_event_countdown else 9999

    # ── Orderbook anomaly guard ───────────────────────────────────────────────
    prev_mark = pos.current_mark or pos.entry_actual
    orderbook_anomaly = False
    if raw_mark > 0 and prev_mark > 0:
        drop_pct = (prev_mark - raw_mark) / prev_mark
        if drop_pct > 0.30:  # Tek tick'te >%30 düşüş = anormal
            orderbook_anomaly = True
            if pos.trade_id not in _orderbook_warned:
                _orderbook_warned.add(pos.trade_id)
                logger.warning(
                    f"Orderbook anomali [{pos.trade_id}] — "
                    f"{prev_mark:.4f} → {raw_mark:.4f} (-%{drop_pct*100:.0f}) | "
                    f"Son bilinen fiyat kullanılıyor"
                )

    mark = prev_mark if orderbook_anomaly else (raw_mark if raw_mark > 0 else prev_mark)

    # Mark güncelle
    if mark > 0:
        position_tracker.update_mark(pos.trade_id, mark)

    # Satış devam ediyorsa bekle
    if pos.sell_in_progress:
        return

    # ── STOP LOSS ────────────────────────────────────────────────────────────
    if (settings.get("stop_loss_enabled") and
            not pos.stop_loss_triggered and
            pos.trade_status == TradeStatus.OPEN):

        stop_price = pos.stop_loss_price if pos.stop_loss_price > 0 else float(settings.get("stop_loss_price", 0.80))

        # Orderbook kapanma koruması: fiyat 0.05 altındaysa SL tetikleme
        if mark <= 0.05:
            if pos.trade_id not in _orderbook_warned:
                _orderbook_warned.add(pos.trade_id)
                logger.warning(f"Fiyat anormal düşük ({mark:.4f}) — SL atlanıyor [{pos.trade_id}]")
        elif mark > 0 and mark <= stop_price:
            position_tracker.mark_stop_loss(pos.trade_id)
            logger.warning(
                f"Stop loss tetiklendi [{pos.trade_id}] — mark: {mark:.4f} <= SL: {stop_price:.4f}"
            )

    # ── TAKE PROFIT ──────────────────────────────────────────────────────────
    if (pos.trade_status == TradeStatus.OPEN and
            pos.exit_target > 0 and
            mark >= pos.exit_target):
        # TP hedefine ulaşıldı — sat
        success = await _do_sell(pos, mark, settings, reason="TP")
        if success:
            return

    # ── STOP LOSS SATIŞ ──────────────────────────────────────────────────────
    if pos.trade_status == TradeStatus.STOP_LOSS and not pos.sell_in_progress:
        success = await _do_sell(pos, mark, settings, reason="SL")
        if not success:
            position_tracker.mark_retry(pos.trade_id)
        return

    # ── FORCE SELL (Akıllı) ──────────────────────────────────────────────────
    if settings.get("force_sell_enabled") and not pos.force_sell_triggered:
        force_secs = int(settings.get("force_sell_before_resolution_seconds", 30))
        if remaining <= force_secs and pos.trade_status in (
            TradeStatus.OPEN, TradeStatus.RETRY, TradeStatus.STOP_LOSS
        ):
            if remaining <= 0:
                # Event bitti → HOLD_TO_RESOLUTION
                position_tracker.mark_force_sell(pos.trade_id)
                position_tracker.mark_hold_to_resolution(pos.trade_id)
                logger.warning(f"Event bitti — HOLD_TO_RESOLUTION [{pos.trade_id}] mark: {mark:.4f}")
                return
            elif mark >= pos.entry_actual and mark >= pos.exit_target:
                # KARDA + TP GEÇİLDİ → HOLD_TO_RESOLUTION (1.0 al)
                position_tracker.mark_force_sell(pos.trade_id)
                position_tracker.mark_hold_to_resolution(pos.trade_id)
                logger.warning(
                    f"Force sell atlandı (karda+TP) [{pos.trade_id}] — "
                    f"mark: {mark:.4f} >= TP: {pos.exit_target:.4f} | HOLD_TO_RESOLUTION"
                )
                return
            elif mark >= pos.entry_actual:
                # KARDA ama henüz TP'ye ulaşmadı → bekle
                if pos.trade_id not in _force_wait_warned:
                    _force_wait_warned.add(pos.trade_id)
                    logger.warning(
                        f"Force sell bekleniyor [{pos.trade_id}] — "
                        f"karda ({mark:.4f} >= {pos.entry_actual:.4f}), TP bekleniyor ({pos.exit_target:.4f})"
                    )
            else:
                # ZARARDA → hemen kapat
                position_tracker.mark_force_sell(pos.trade_id)
                success = await _do_sell(pos, mark, settings, reason="FORCE_SELL")
                if not success:
                    position_tracker.mark_retry(pos.trade_id)
                return

    # ── RETRY ────────────────────────────────────────────────────────────────
    if pos.trade_status == TradeStatus.RETRY:
        max_retry = int(settings.get("sell_retry_count", 5))
        if pos.retry_count >= max_retry:
            # Retry tükendi → HOLD_TO_RESOLUTION
            position_tracker.mark_hold_to_resolution(pos.trade_id)
            logger.warning(f"Retry tükendi [{pos.trade_id}] → HOLD_TO_RESOLUTION")
            return
        success = await _do_sell(pos, mark, settings, reason="RETRY_SELL")
        if not success:
            position_tracker.mark_retry(pos.trade_id)


async def _do_sell(pos, sell_price: float, settings: dict, reason: str) -> bool:
    """Satış emrini çalıştır ve pozisyonu kapat."""
    if pos.sell_in_progress:
        return False
    pos.sell_in_progress = True

    try:
        # Token ID'yi al
        token_id = _get_event_token_id(pos.event_key, pos.side) if _get_event_token_id else ""

        actual_exit = await order_executor.execute_sell(
            event_key=pos.event_key,
            trade_id=pos.trade_id,
            sell_price=sell_price,
            shares=pos.shares,
            token_id=token_id,
            mode=settings.get("mode", "LIVE"),
            use_market_order=True,  # Her zaman FOK market (hız önemli)
        )

        if actual_exit is None:
            # Token bakiyesi sıfır — claim bekle
            if "HOLD" not in reason:
                position_tracker.mark_hold_to_resolution(pos.trade_id)
            pos.sell_in_progress = False
            return False

        # Pozisyonu kapat
        close_reason = reason if reason in ("TP", "SL", "FORCE_SELL") else "CLOSED"
        position_tracker.close_position(pos.trade_id, actual_exit, close_reason)
        pos.sell_in_progress = False
        return True

    except Exception as e:
        logger.error(f"_do_sell hata [{pos.trade_id}]: {e}")
        pos.sell_in_progress = False
        return False
