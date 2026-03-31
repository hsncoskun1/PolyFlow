"""
POLYFLOW Decision Log — Her giriş/atlama/çıkış kararını sebepli logla.
ChatGPT plan eleştirisi: Faz 5 değil Faz 1'de olmalı.

DB: audit_log(event_key, decision, reason, side, entry_price, exit_price,
              pnl, amount, rules_snapshot, trade_id, timestamp)

Kullanım:
  entry_service.py  → log_entry(), log_skip()
  position_tracker.py → log_exit()
"""
import json
import logging
import time
from datetime import datetime

logger = logging.getLogger("polyflow.decision_log")

# SKIP debounce — aynı (event_key, reason) her 60sn'de 1 kez loglanır
# (rules-pass + risk-block senaryolarında spam önler)
_skip_cooldowns: dict = {}   # (event_key, reason) → last_log_ts
_SKIP_COOLDOWN_SEC = 60


def log_entry(
    event_key: str,
    side: str,
    entry_price: float,
    amount: float,
    rules: dict,
    trade_id: str = "",
):
    """Başarılı giriş kararını audit_log'a kaydet."""
    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      event_key,
            "decision":       "ENTRY",
            "reason":         "all_rules_passed",
            "side":           side,
            "entry_price":    entry_price,
            "exit_price":     0.0,
            "pnl":            0.0,
            "amount":         amount,
            "rules_snapshot": json.dumps(rules),
            "trade_id":       trade_id,
            "timestamp":      datetime.now().isoformat(),
        })
        logger.info(
            f"[AUDIT] ENTRY [{event_key}] {side} @ {entry_price:.4f} | "
            f"${amount:.2f} | trade_id={trade_id}"
        )
    except Exception as e:
        logger.error(f"log_entry hata [{event_key}]: {e}")


def log_skip(
    event_key: str,
    reason: str,
    rules: dict = None,
    side: str = "",
    entry_price: float = 0.0,
):
    """
    Atlanan entry kararını logla.
    Debounce: aynı (event_key, reason) 60sn'de 1 kez yazılır.
    """
    ck = (event_key, reason)
    now = time.time()
    if now - _skip_cooldowns.get(ck, 0) < _SKIP_COOLDOWN_SEC:
        return  # Cooldown'da — spam önleme
    _skip_cooldowns[ck] = now

    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      event_key,
            "decision":       "SKIP",
            "reason":         reason,
            "side":           side,
            "entry_price":    entry_price,
            "exit_price":     0.0,
            "pnl":            0.0,
            "amount":         0.0,
            "rules_snapshot": json.dumps(rules or {}),
            "trade_id":       "",
            "timestamp":      datetime.now().isoformat(),
        })
        logger.debug(f"[AUDIT] SKIP [{event_key}] reason={reason}")
    except Exception as e:
        logger.error(f"log_skip hata [{event_key}]: {e}")


def log_exit(
    event_key: str,
    trade_id: str,
    exit_price: float,
    reason: str,
    pnl: float,
    side: str = "",
    entry_price: float = 0.0,
    amount: float = 0.0,
):
    """Çıkış kararını logla (TP/SL/FORCE_SELL/HOLD_TO_RESOLUTION/MANUAL)."""
    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      event_key,
            "decision":       "EXIT",
            "reason":         reason,
            "side":           side,
            "entry_price":    entry_price,
            "exit_price":     exit_price,
            "pnl":            pnl,
            "amount":         amount,
            "rules_snapshot": "{}",
            "trade_id":       trade_id,
            "timestamp":      datetime.now().isoformat(),
        })
        pnl_str = f"+{pnl:.4f}" if pnl >= 0 else f"{pnl:.4f}"
        logger.info(
            f"[AUDIT] EXIT [{event_key}] reason={reason} @ {exit_price:.4f} | "
            f"PnL={pnl_str} | trade_id={trade_id}"
        )
    except Exception as e:
        logger.error(f"log_exit hata [{event_key}]: {e}")


def log_bot_event(event_type: str, detail: str = ""):
    """
    Bot düzeyinde olayları logla (start, stop, emergency, safe_mode, etc.)
    decision = 'BOT_EVENT'
    """
    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      "__bot__",
            "decision":       "BOT_EVENT",
            "reason":         event_type,
            "side":           "",
            "entry_price":    0.0,
            "exit_price":     0.0,
            "pnl":            0.0,
            "amount":         0.0,
            "rules_snapshot": json.dumps({"detail": detail}) if detail else "{}",
            "trade_id":       "",
            "timestamp":      datetime.now().isoformat(),
        })
        logger.info(f"[AUDIT] BOT_EVENT: {event_type} — {detail}")
    except Exception as e:
        logger.error(f"log_bot_event hata: {e}")


def log_order_reject(
    event_key: str,
    reason: str,
    side: str = "",
    order_id: str = "",
):
    """Order reject/cancel/timeout durumunu logla."""
    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      event_key,
            "decision":       "ORDER_REJECT",
            "reason":         reason,
            "side":           side,
            "entry_price":    0.0,
            "exit_price":     0.0,
            "pnl":            0.0,
            "amount":         0.0,
            "rules_snapshot": json.dumps({"order_id": order_id}) if order_id else "{}",
            "trade_id":       order_id,
            "timestamp":      datetime.now().isoformat(),
        })
        logger.warning(f"[AUDIT] ORDER_REJECT [{event_key}] reason={reason} order_id={order_id}")
    except Exception as e:
        logger.error(f"log_order_reject hata [{event_key}]: {e}")


def log_partial_fill(
    event_key: str,
    expected_amount: float,
    actual_amount: float,
    order_id: str = "",
):
    """Partial fill durumunu logla."""
    fill_pct = round(actual_amount / max(expected_amount, 0.001) * 100, 1)
    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      event_key,
            "decision":       "PARTIAL_FILL",
            "reason":         f"fill_pct:{fill_pct}",
            "side":           "",
            "entry_price":    0.0,
            "exit_price":     0.0,
            "pnl":            0.0,
            "amount":         actual_amount,
            "rules_snapshot": json.dumps({"expected": expected_amount, "actual": actual_amount, "pct": fill_pct}),
            "trade_id":       order_id,
            "timestamp":      datetime.now().isoformat(),
        })
        logger.warning(
            f"[AUDIT] PARTIAL_FILL [{event_key}] expected={expected_amount:.4f} "
            f"actual={actual_amount:.4f} ({fill_pct}%) order_id={order_id}"
        )
    except Exception as e:
        logger.error(f"log_partial_fill hata [{event_key}]: {e}")


def log_reconcile_discrepancy(
    event_key: str,
    trade_id: str,
    expected_shares: float,
    actual_shares: float,
    reason: str = "",
):
    """Reconciler tarafından tespit edilen tutarsızlığı logla."""
    diff_pct = round(abs(expected_shares - actual_shares) / max(expected_shares, 0.001) * 100, 1)
    try:
        from backend.storage.db import save_audit_log
        save_audit_log({
            "event_key":      event_key,
            "decision":       "RECONCILE_DISCREPANCY",
            "reason":         reason or f"shares_diff:{diff_pct}pct",
            "side":           "",
            "entry_price":    0.0,
            "exit_price":     0.0,
            "pnl":            0.0,
            "amount":         0.0,
            "rules_snapshot": json.dumps({
                "expected_shares": expected_shares,
                "actual_shares":   actual_shares,
                "diff_pct":        diff_pct,
            }),
            "trade_id":       trade_id,
            "timestamp":      datetime.now().isoformat(),
        })
        logger.warning(
            f"[AUDIT] RECONCILE_DISCREPANCY [{event_key}] [{trade_id}] "
            f"expected={expected_shares:.6f} actual={actual_shares:.6f} ({diff_pct}%) reason={reason}"
        )
    except Exception as e:
        logger.error(f"log_reconcile_discrepancy hata [{event_key}]: {e}")
