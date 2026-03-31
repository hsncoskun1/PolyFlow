"""
POLYFLOW Entry Service — entry trigger, event lock, minimum risk guards.
Referans: D:/polymarketminiclaude_NEWDASHBOARD/backend/order_executor.py (adapte edildi)

Bu modül main.py'e GÖMÜLMEZ — simulation_tick'ten çağrılır, kendisi ayrı kalır.
"""
import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger("polyflow.entry")

# ─── Event lock (çift entry guard) ───────────────────────────────────────────
# key → kilitleme zamanı (timeout için)
_entry_locks: dict = {}   # event_key → lock_time (float)
_LOCK_TIMEOUT_SEC = 300   # 5 dakika sonra lock otomatik expire

# Son data güncellenme zamanı — stale guard için
_last_price_update: dict = {}  # event_key → timestamp
STALE_DATA_SEC = 8.0  # 8sn'den eski fiyat → trade açma


# ─── Lock yönetimi ───────────────────────────────────────────────────────────

def is_event_locked(event_key: str) -> bool:
    """Bu event için entry lock var mı?"""
    lock_time = _entry_locks.get(event_key)
    if lock_time is None:
        return False
    # Timeout kontrolü
    if time.time() - lock_time > _LOCK_TIMEOUT_SEC:
        _entry_locks.pop(event_key, None)
        return False
    return True


def lock_event(event_key: str):
    _entry_locks[event_key] = time.time()


def unlock_event(event_key: str):
    _entry_locks.pop(event_key, None)


def clear_lock_for_new_event(event_key: str, new_slug: str, old_slug: str = ""):
    """
    Yeni event slug gelince eski lock'u temizle.
    scan_slug_based/scan_gamma_markets'ta slug değişince çağrılmalı.
    """
    if old_slug and old_slug != new_slug and event_key in _entry_locks:
        _entry_locks.pop(event_key, None)
        logger.info(f"Entry lock temizlendi (yeni event): {event_key}")


# ─── Stale data guard ────────────────────────────────────────────────────────

def record_price_update(event_key: str):
    """CLOB WS veya midpoint poll'dan fiyat gelince çağrılır."""
    _last_price_update[event_key] = time.time()


def is_data_fresh(event_key: str) -> bool:
    """Son fiyat STALE_DATA_SEC'den yeni mi?"""
    last = _last_price_update.get(event_key, 0)
    return (time.time() - last) < STALE_DATA_SEC


# ─── Minimum risk kontrolleri ─────────────────────────────────────────────────

def check_entry_risk(
    event_key: str,
    settings: dict,
    open_position_count: int,
    event_trade_count: int = 0,
) -> tuple[bool, str]:
    """
    Entry öncesi minimum risk kontrolleri.
    Döner: (approved: bool, reason: str)

    ChatGPT plan eleştirisi: Bu guard'lar Faz 1'de olmalı (Faz 2'ye bırakılmamalı).
    """
    # 1. Safe mode
    if settings.get("safe_mode"):
        return False, "safe_mode_active"

    # 2. Exit-only mod
    if settings.get("exit_only"):
        return False, "exit_only_mode"

    # 3. Event lock (duplicate guard)
    if is_event_locked(event_key):
        return False, "event_locked_duplicate"

    # 4. Max açık pozisyon
    max_pos = int(settings.get("max_open_positions", 3))
    if max_pos > 0 and open_position_count >= max_pos:
        return False, f"max_positions_reached_{open_position_count}/{max_pos}"

    # 5. Event başına trade limiti
    event_limit = int(settings.get("event_trade_limit", 1))
    if event_limit > 0 and event_trade_count >= event_limit:
        return False, f"event_trade_limit_reached_{event_trade_count}/{event_limit}"

    # 6. Stale data guard
    if not is_data_fresh(event_key):
        return False, "stale_market_data"

    return True, "ok"


# ─── Entry trigger ────────────────────────────────────────────────────────────

async def try_open_position(
    event_key: str,
    sym: str,
    mp: dict,
    rules: dict,
    settings: dict,
    market_info: dict,  # slug, condition_id, end_ts, tokens
    open_position_count: int,
    event_trade_count: int = 0,
) -> bool:
    """
    Tüm rule'lar PASS → entry tetikleyici.
    Döner: True (pozisyon açıldı) / False (atlandı)
    """
    from backend.execution import position_tracker, order_executor

    # ─── Risk kontrolü ───────────────────────────────────────────────────────
    approved, reason = check_entry_risk(
        event_key, settings, open_position_count, event_trade_count
    )
    if not approved:
        logger.debug(f"Entry reddedildi [{event_key}]: {reason}")
        # Kural geçmişi varsa SKIP logla (rules-pass + risk-block durumları değerli)
        try:
            from backend.decision_log import log_skip
            log_skip(event_key, reason, rules, entry_price=mp.get("up_ask", 0))
        except Exception:
            pass
        return False

    # ─── Hangi taraf? ────────────────────────────────────────────────────────
    side = _determine_side(rules, mp, settings)
    if not side:
        return False

    entry_price = mp.get("up_ask", 0.5) if side == "UP" else mp.get("down_ask", 0.5)
    if entry_price <= 0.01 or entry_price >= 0.99:
        logger.debug(f"Entry fiyatı geçersiz [{event_key}]: {entry_price}")
        return False

    # ─── Lock'u hemen koy (race condition önleme) ─────────────────────────
    lock_event(event_key)

    # ─── Tutar hesapla ───────────────────────────────────────────────────────
    amount = float(settings.get("order_amount", 10.0))
    if amount < 1.0:
        unlock_event(event_key)
        return False

    # ─── TP/SL hesapla ───────────────────────────────────────────────────────
    exit_target, stop_loss_price = _calc_targets(entry_price, settings)

    # ─── Order gönder ────────────────────────────────────────────────────────
    try:
        token_id = _get_token_id(market_info, side)
        actual_price = await order_executor.execute_entry(
            event_key=event_key,
            side=side,
            entry_price=entry_price,
            amount=amount,
            token_id=token_id,
            mode=settings.get("mode", "LIVE"),
        )

        if actual_price is None:
            unlock_event(event_key)
            logger.error(f"Order execute başarısız [{event_key}]")
            # SKIP: order dolmadı
            try:
                from backend.decision_log import log_skip
                log_skip(event_key, "order_not_filled", rules, side, entry_price)
            except Exception:
                pass
            return False

        # PERCENT modda gerçek fill'den yeniden hesapla
        if settings.get("strategy_mode", "NUMERIC") == "PERCENT":
            exit_target, stop_loss_price = _calc_targets(actual_price, settings)

        # ─── Pozisyon aç ─────────────────────────────────────────────────
        pos = position_tracker.open_position(
            event_key=event_key,
            event_slug=market_info.get("slug", ""),
            side=side,
            entry_actual=actual_price,
            exit_target=exit_target,
            stop_loss_price=stop_loss_price if settings.get("stop_loss_enabled") else 0.0,
            amount=amount,
            condition_id=market_info.get("conditionId", ""),
            mode=settings.get("mode", "LIVE"),
        )

        # Fill detaylarını pozisyona ekle (order_id + actual_fill_shares) + DB güncelle
        try:
            from backend.execution.order_executor import get_last_entry_info, clear_entry_info
            from backend.storage import db
            fi = get_last_entry_info(event_key)
            if fi:
                pos.order_id = fi.get("order_id", "")
                fill_sz = fi.get("fill_size", 0.0)
                if fill_sz > 0:
                    pos.actual_fill_shares = fill_sz
                    # Gerçek shares'i fill_size / entry_price'dan güncelle
                    if actual_price > 0:
                        pos.shares = round(fill_sz / actual_price, 6)
                pos.fill_confirmed = True  # REST response fill sayılır
                # DB kaydını güncelle — restart recovery için kritik
                db.update_position_fill(
                    pos.trade_id,
                    pos.order_id,
                    pos.fill_confirmed,
                    pos.shares,
                )
                clear_entry_info(event_key)
        except Exception as exc:
            logger.warning(f"Fill detayı DB güncelleme hatası [{event_key}]: {exc}")

        logger.info(
            f"Entry başarılı [{event_key}] — {side} @ {actual_price:.4f} | "
            f"TP: {exit_target:.4f} | SL: {stop_loss_price:.4f} | ${amount}"
        )

        # Audit log — ENTRY
        try:
            from backend.decision_log import log_entry
            log_entry(event_key, side, actual_price, amount, rules, pos.trade_id)
        except Exception:
            pass

        return True

    except Exception as e:
        logger.error(f"try_open_position hata [{event_key}]: {e}")
        unlock_event(event_key)
        return False


# ─── Yardımcı fonksiyonlar ───────────────────────────────────────────────────

def _determine_side(rules: dict, mp: dict, settings: dict) -> Optional[str]:
    """
    Hangi taraf (UP/DOWN) alınacak?
    Şimdilik: tüm rule'lar PASS → UP tarafını tercih et.
    TODO: price_rule'da candidate_side kullan.
    """
    allowed = settings.get("allowed_side", "BOTH").upper()
    up_ask = mp.get("up_ask", 0)
    dn_ask = mp.get("down_ask", 0)

    # Hangi taraf mantıklı range'de?
    min_e = float(settings.get("min_entry_price", 0.80))
    max_e = float(settings.get("max_entry_price", 0.97))

    up_ok = (allowed in ("BOTH", "UP")) and (min_e <= up_ask <= max_e)
    dn_ok = (allowed in ("BOTH", "DOWN")) and (min_e <= dn_ask <= max_e)

    if up_ok and dn_ok:
        # İkisi de uygun → UP tercih et (referans bot davranışı)
        return "UP"
    elif up_ok:
        return "UP"
    elif dn_ok:
        return "DOWN"
    return None


def _calc_targets(entry_price: float, settings: dict) -> tuple[float, float]:
    """TP ve SL fiyatlarını hesapla (NUMERIC veya PERCENT mod)."""
    mode = settings.get("strategy_mode", "NUMERIC")
    if mode == "PERCENT":
        tp_pct = float(settings.get("target_exit_pct", 5.0))
        sl_pct = float(settings.get("stop_loss_pct", 10.0))
        raw_exit = round(entry_price * (1 + tp_pct / 100.0), 4)
        exit_target = min(raw_exit, 0.99)
        sl_price = max(round(entry_price * (1 - sl_pct / 100.0), 4), 0.01)
    else:
        exit_target = float(settings.get("target_exit_price", 0.95))
        sl_price    = float(settings.get("stop_loss_price",  0.80))
    return exit_target, sl_price


def _get_token_id(market_info: dict, side: str) -> str:
    """Market info'dan UP/DOWN token ID'si al."""
    tokens = market_info.get("tokens", [])
    if side == "UP" and len(tokens) > 0:
        return tokens[0]
    elif side == "DOWN" and len(tokens) > 1:
        return tokens[1]
    return ""
