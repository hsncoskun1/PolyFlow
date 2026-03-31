"""
POLYFLOW Position Tracker — açık pozisyonları DB + in-memory tutar.
Referans: D:/polymarketminiclaude_NEWDASHBOARD/backend/position_tracker.py (adapte edildi)
Multi-asset: her key (BTC_5M, ETH_5M...) kendi pozisyonuna sahip olabilir.
"""
import logging
import uuid
from datetime import datetime
from typing import Optional, Dict

from backend.execution.models import PositionState, TradeStatus
from backend.storage import db

logger = logging.getLogger("polyflow.positions")

# In-memory storage — trade_id → PositionState
_positions: Dict[str, PositionState] = {}


# ─── Sorgu fonksiyonları ──────────────────────────────────────────────────────

def get_active_count() -> int:
    """OPEN veya RETRY durumdaki pozisyon sayısı."""
    return sum(1 for p in _positions.values()
               if p.trade_status in (TradeStatus.OPEN, TradeStatus.RETRY))


def get_active_positions() -> list:
    """Tüm aktif (OPEN/RETRY/STOP_LOSS/FORCE_SELL) pozisyonlar."""
    return [p for p in _positions.values()
            if p.trade_status in (
                TradeStatus.OPEN, TradeStatus.RETRY,
                TradeStatus.STOP_LOSS, TradeStatus.FORCE_SELL
            )]


def get_all_positions() -> list:
    return list(_positions.values())


def get_position_for_key(event_key: str) -> Optional[PositionState]:
    """Belirli bir event_key için açık pozisyon. Yoksa None."""
    for p in _positions.values():
        if p.event_key == event_key and p.trade_status in (
            TradeStatus.OPEN, TradeStatus.RETRY, TradeStatus.STOP_LOSS, TradeStatus.FORCE_SELL
        ):
            return p
    return None


def is_key_locked(event_key: str) -> bool:
    """Bu event key'de aktif pozisyon var mı? (Duplicate entry guard)"""
    return get_position_for_key(event_key) is not None


# ─── Mark ve PnL güncelleme ──────────────────────────────────────────────────

def update_mark(trade_id: str, mark_price: float):
    """Mark fiyatını ve PnL'yi güncelle (50ms'de çağrılır, DB yazımı yok)."""
    if trade_id in _positions and mark_price > 0:
        pos = _positions[trade_id]
        pos.current_mark = mark_price
        pos.current_pnl = pos.calc_pnl(mark_price)


# ─── Pozisyon açma ───────────────────────────────────────────────────────────

def open_position(
    event_key: str,
    event_slug: str,
    side: str,
    entry_actual: float,
    exit_target: float,
    stop_loss_price: float,
    amount: float,
    condition_id: str = "",
    mode: str = "LIVE",
) -> PositionState:
    """
    Yeni pozisyon aç. In-memory + DB'ye yaz.
    Döner: PositionState (trade_id içerir)
    """
    trade_id = f"pf_{uuid.uuid4().hex[:10]}"
    shares = round(amount / entry_actual, 6) if entry_actual > 0 else 0.0

    pos = PositionState(
        trade_id=trade_id,
        event_key=event_key,
        event_slug=event_slug,
        condition_id=condition_id,
        side=side,
        entry_price=entry_actual,
        entry_actual=entry_actual,
        exit_target=exit_target,
        stop_loss_price=stop_loss_price,
        amount=amount,
        shares=shares,
        trade_status=TradeStatus.OPEN,
        current_mark=entry_actual,
        current_pnl=0.0,
        mode=mode,
        created_at=datetime.now().isoformat(),
    )
    _positions[trade_id] = pos

    # DB'ye kaydet (mevcut positions tablosuna uyumlu)
    try:
        db.save_position({
            "id":           trade_id,
            "asset":        event_key.split("_")[0],
            "event_key":    event_key,
            "event_slug":   event_slug,
            "side":         side,
            "entry_price":  entry_actual,
            "current_price": entry_actual,
            "target_price": exit_target,
            "stop_loss":    stop_loss_price,
            "amount":       amount,
            "pnl":          0.0,
            "status":       "OPEN",
            "mode":         mode,
            "entry_time":   pos.created_at,
        })
    except Exception as e:
        logger.error(f"open_position DB kayıt hatası [{trade_id}]: {e}")

    sym = event_key.split("_")[0]
    logger.info(
        f"Pozisyon açıldı [{trade_id}] — {sym} {side} @ {entry_actual:.4f} | "
        f"Hedef: {exit_target:.4f} | SL: {stop_loss_price:.4f} | ${amount}"
    )
    return pos


# ─── Pozisyon kapatma ────────────────────────────────────────────────────────

def close_position(
    trade_id: str,
    exit_price: float,
    reason: str,  # TP | SL | FORCE_SELL | HOLD_TO_RESOLUTION | MANUAL
) -> Optional[PositionState]:
    """
    Pozisyonu kapat. In-memory + DB'ye yaz.
    Döner: kapatılan PositionState veya None
    """
    if trade_id not in _positions:
        return None

    pos = _positions[trade_id]
    final_pnl = pos.calc_pnl(exit_price)
    pos.current_pnl = final_pnl
    pos.trade_status = _reason_to_status(reason)

    # DB güncelle
    try:
        db.close_position(trade_id, exit_price, reason)
    except Exception as e:
        logger.error(f"close_position DB güncelleme hatası [{trade_id}]: {e}")

    # Trade geçmişine ekle
    try:
        db.save_trade({
            "id":          f"t_{trade_id}",
            "asset":       pos.event_key.split("_")[0],
            "event_key":   pos.event_key,
            "event_slug":  pos.event_slug,
            "side":        pos.side,
            "entry_price": pos.entry_actual,
            "exit_price":  exit_price,
            "amount":      pos.amount,
            "pnl":         final_pnl,
            "status":      reason,
            "mode":        pos.mode,
            "date":        datetime.now().isoformat(),
        })
    except Exception as e:
        logger.error(f"close_position trade kayıt hatası [{trade_id}]: {e}")

    pnl_str = f"+{final_pnl:.4f}" if final_pnl >= 0 else f"{final_pnl:.4f}"
    logger.info(
        f"Pozisyon kapandı [{reason}] [{trade_id}] — "
        f"{pos.side} @ {pos.entry_actual:.4f} → {exit_price:.4f} | PnL: {pnl_str}"
    )

    # Audit log — EXIT
    try:
        from backend.decision_log import log_exit
        log_exit(
            event_key=pos.event_key,
            trade_id=trade_id,
            exit_price=exit_price,
            reason=reason,
            pnl=final_pnl,
            side=pos.side,
            entry_price=pos.entry_actual,
            amount=pos.amount,
        )
    except Exception:
        pass

    return pos


def _reason_to_status(reason: str) -> TradeStatus:
    m = {
        "TP":               TradeStatus.CLOSED,
        "SL":               TradeStatus.STOP_LOSS,
        "FORCE_SELL":       TradeStatus.FORCE_SELL,
        "HOLD_TO_RESOLUTION": TradeStatus.HOLD_TO_RESOLUTION,
        "MANUAL":           TradeStatus.CLOSED,
        "STALE_EVENT":      TradeStatus.CLOSED,
    }
    return m.get(reason, TradeStatus.CLOSED)


# ─── Durum değiştirme ────────────────────────────────────────────────────────

def mark_stop_loss(trade_id: str):
    if trade_id in _positions:
        _positions[trade_id].stop_loss_triggered = True
        _positions[trade_id].trade_status = TradeStatus.STOP_LOSS


def mark_force_sell(trade_id: str):
    if trade_id in _positions:
        _positions[trade_id].force_sell_triggered = True
        _positions[trade_id].trade_status = TradeStatus.FORCE_SELL


def mark_hold_to_resolution(trade_id: str):
    if trade_id in _positions:
        _positions[trade_id].trade_status = TradeStatus.HOLD_TO_RESOLUTION
        logger.warning(f"HOLD_TO_RESOLUTION: {trade_id} — claim beklenecek")


def mark_retry(trade_id: str):
    if trade_id in _positions:
        _positions[trade_id].trade_status = TradeStatus.RETRY
        _positions[trade_id].retry_count += 1


# ─── Startup: DB'den açık pozisyonları yükle ─────────────────────────────────

def load_open_positions_from_db():
    """Bot restart sonrası DB'deki açık pozisyonları in-memory'e yükle."""
    try:
        open_rows = db.get_open_positions()
        for row in open_rows:
            trade_id = row.get("id", "")
            if not trade_id or trade_id in _positions:
                continue
            pos = PositionState(
                trade_id=trade_id,
                event_key=row.get("event_key", ""),
                event_slug=row.get("event_slug", ""),
                side=row.get("side", "UP"),
                entry_price=row.get("entry_price", 0),
                entry_actual=row.get("entry_price", 0),
                exit_target=row.get("target_price", 0),
                stop_loss_price=row.get("stop_loss", 0),
                amount=row.get("amount", 0),
                current_mark=row.get("current_price", 0),
                current_pnl=row.get("pnl", 0),
                trade_status=TradeStatus.OPEN,
                mode=row.get("mode", "LIVE"),
                created_at=row.get("created_at", ""),
            )
            pos.shares = round(pos.amount / pos.entry_actual, 6) if pos.entry_actual > 0 else 0
            _positions[trade_id] = pos
        if open_rows:
            logger.info(f"DB'den {len(open_rows)} açık pozisyon yüklendi")
    except Exception as e:
        logger.error(f"load_open_positions_from_db hata: {e}")


# ─── app_state uyumluluğu ─────────────────────────────────────────────────────

def to_app_state_positions() -> list:
    """
    app_state["positions"] formatına dönüştür — frontend uyumlu.
    Frontend: id, asset, side, entry_price, current_price, pnl, status, amount, event_key
    """
    result = []
    for pos in get_all_positions():
        if pos.trade_status not in (TradeStatus.CLOSED, TradeStatus.STOP_LOSS):
            # Sadece açık/aktif pozisyonları göster
            pass
        result.append({
            "id":            pos.trade_id,
            "asset":         pos.event_key.split("_")[0],
            "event_key":     pos.event_key,
            "event_slug":    pos.event_slug,
            "side":          pos.side,
            "entry_price":   pos.entry_actual,
            "current_price": pos.current_mark,
            "target_price":  pos.exit_target,
            "stop_loss":     pos.stop_loss_price,
            "pnl":           pos.current_pnl,
            "amount":        pos.amount,
            "status":        pos.trade_status.value,
            "mode":          pos.mode,
            "created_at":    pos.created_at,
        })
    return result
