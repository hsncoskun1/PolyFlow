"""
POLYFLOW Reconciler — 30 sn'de bir CLOB token balansını kontrol eder.
Görevler:
  1. OPEN pozisyonların token bakiyesini doğrula
     - Bakiye 0 → pozisyon resolve olmuş → HOLD_TO_RESOLUTION
     - Bakiye beklenmeyenden %10+ farklıysa → RECONCILE_DISCREPANCY logla
  2. USDC bakiyesini sorgula ve app_state güncelle (opsiyonel)

Döngü: 30 saniye (async task)
"""
import asyncio
import logging
import time
from typing import Callable, Dict, Optional

logger = logging.getLogger("polyflow.reconciler")

_running = False
_task: Optional[asyncio.Task] = None

# Getter'lar — main.py tarafından inject edilir
_get_market_cache: Optional[Callable[[str], dict]] = None
_get_balance_updater: Optional[Callable[[float], None]] = None

# Son reconciliation zamanları — spam önleme
_last_reconcile_warn: Dict[str, float] = {}  # trade_id → last_warn_ts
_WARN_COOLDOWN_SEC = 120


def set_market_cache_getter(fn: Callable[[str], dict]):
    global _get_market_cache
    _get_market_cache = fn


def set_balance_updater(fn: Callable[[float], None]):
    """USDC bakiyesi güncellenince app_state'e yazmak için callback."""
    global _get_balance_updater
    _get_balance_updater = fn


async def start():
    global _running, _task
    _running = True
    _task = asyncio.create_task(_reconcile_loop())
    logger.info("Reconciler baslatildi (30s interval)")


async def stop():
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    logger.info("Reconciler durduruldu")


async def _reconcile_loop():
    """30 saniyede bir çalışan ana döngü."""
    # İlk çalışmada 60 saniye bekle (startup sırasında load olan pozisyonlar)
    await asyncio.sleep(60)
    while _running:
        try:
            await _run_reconciliation()
        except Exception as e:
            logger.error(f"Reconciler hata: {e}")
        await asyncio.sleep(30)


async def _run_reconciliation():
    """Tüm açık pozisyonların token bakiyesini CLOB'dan sorgula."""
    from backend.execution import position_tracker
    from backend.execution.models import TradeStatus
    from backend.execution.order_executor import _get_clob_client

    positions = position_tracker.get_active_positions()
    if not positions:
        return

    client = _get_clob_client()
    if not client:
        logger.debug("Reconciler: CLOB client yok — atlanıyor")
        return

    reconciled = 0
    discrepancies = 0

    for pos in positions:
        if pos.trade_status not in (TradeStatus.OPEN, TradeStatus.RETRY):
            continue
        if pos.shares <= 0:
            continue

        # Token ID'yi al
        token_id = ""
        if _get_market_cache:
            mc = _get_market_cache(pos.event_key)
            tokens = mc.get("tokens", [])
            idx = 0 if pos.side == "UP" else 1
            token_id = tokens[idx] if len(tokens) > idx else ""

        if not token_id:
            continue

        try:
            real_shares = await _query_token_balance(client, token_id)
        except Exception:
            continue

        reconciled += 1

        # Pozisyon resolve olmuş (bakiye = 0)
        if real_shares is None or real_shares <= 0.001:
            logger.warning(
                f"Reconciler: [{pos.trade_id}] token bakiyesi 0 — "
                f"HOLD_TO_RESOLUTION olarak isaretleniyor (event={pos.event_key})"
            )
            position_tracker.mark_hold_to_resolution(pos.trade_id)
            try:
                from backend.decision_log import log_reconcile_discrepancy
                log_reconcile_discrepancy(
                    pos.event_key, pos.trade_id,
                    pos.shares, 0.0,
                    reason="token_balance_zero"
                )
            except Exception:
                pass
            continue

        # Bakiye önemli ölçüde farklıysa uyar
        diff_pct = abs(real_shares - pos.shares) / max(pos.shares, 0.001)
        if diff_pct > 0.10:  # %10'dan fazla fark
            now = time.time()
            if now - _last_reconcile_warn.get(pos.trade_id, 0) > _WARN_COOLDOWN_SEC:
                _last_reconcile_warn[pos.trade_id] = now
                discrepancies += 1
                logger.warning(
                    f"Reconciler: [{pos.trade_id}] shares farki "
                    f"beklenen={pos.shares:.6f} gercek={real_shares:.6f} ({diff_pct*100:.1f}%) — "
                    f"shares guncelleniyor"
                )
                # Shares'i gerçek değerle güncelle
                pos.shares = real_shares
                try:
                    from backend.decision_log import log_reconcile_discrepancy
                    log_reconcile_discrepancy(
                        pos.event_key, pos.trade_id,
                        pos.shares, real_shares,
                        reason=f"shares_mismatch_{diff_pct*100:.0f}pct"
                    )
                except Exception:
                    pass

    if reconciled > 0:
        logger.debug(
            f"Reconciler: {reconciled} pozisyon kontrol edildi, "
            f"{discrepancies} tutarsizlik"
        )

    # USDC bakiyesi güncelle
    try:
        await _update_usdc_balance()
    except Exception:
        pass


async def _query_token_balance(client, token_id: str) -> Optional[float]:
    """CLOB'dan gerçek token bakiyesini sorgula."""
    import os
    try:
        from py_clob_client.clob_types import BalanceAllowanceParams, AssetType
        sig_type = int(os.environ.get("POLYMARKET_SIG_TYPE", "2"))
        params = BalanceAllowanceParams(
            asset_type=AssetType.CONDITIONAL,
            token_id=token_id,
            signature_type=sig_type,
        )
        loop = asyncio.get_event_loop()
        ba = await loop.run_in_executor(None, client.get_balance_allowance, params)
        raw = int(ba.get("balance", 0))
        return round(raw / 1_000_000, 6) if raw > 0 else None
    except Exception as e:
        logger.debug(f"Token bakiye sorgusu hatasi: {e}")
        return None


async def _update_usdc_balance():
    """USDC bakiyesini sorgula ve callback ile app_state'e yaz."""
    if not _get_balance_updater:
        return
    from backend.execution.order_executor import fetch_usdc_balance
    bal = await fetch_usdc_balance()
    if bal is not None:
        _get_balance_updater(bal)
