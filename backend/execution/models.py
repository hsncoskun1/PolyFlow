"""
POLYFLOW Execution Models — Position ve Trade durum modelleri.
Referans: D:/polymarketminiclaude_NEWDASHBOARD/backend/models.py (adapte edildi)
"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class TradeStatus(str, Enum):
    OPEN               = "OPEN"
    CLOSED             = "CLOSED"       # TP veya normal çıkış
    STOP_LOSS          = "STOP_LOSS"    # SL tetiklendi
    FORCE_SELL         = "FORCE_SELL"   # Event bitimine yakın zorla satış
    HOLD_TO_RESOLUTION = "HOLD_TO_RESOLUTION"  # Karda + TP geçildi → claim bekle
    RETRY              = "RETRY"        # Satış başarısız, tekrar deneniyor


@dataclass
class PositionState:
    """Tek bir açık pozisyonun tüm durumu."""
    trade_id:             str   = ""
    event_key:            str   = ""    # BTC_5M, ETH_5M, ...
    event_slug:           str   = ""    # polymarket slug
    condition_id:         str   = ""    # CTF condition ID (claim için)
    side:                 str   = "UP"  # UP | DOWN

    entry_price:          float = 0.0   # Target entry (emir fiyatı)
    entry_actual:         float = 0.0   # Gerçek fill fiyatı
    exit_target:          float = 0.0   # TP hedefi
    stop_loss_price:      float = 0.0   # SL fiyatı (0 = devre dışı)

    amount:               float = 0.0   # Yatırılan USD
    shares:               float = 0.0   # amount / entry_actual

    trade_status:         TradeStatus = TradeStatus.OPEN
    retry_count:          int   = 0

    stop_loss_triggered:  bool  = False
    force_sell_triggered: bool  = False
    sell_in_progress:     bool  = False
    _force_wait_warned:   bool  = field(default=False, repr=False)

    current_mark:         float = 0.0   # Son bilinen piyasa fiyatı
    current_pnl:          float = 0.0   # amount × (mark/entry - 1)

    mode:                 str   = "LIVE"
    created_at:           str   = ""

    # Fill confirmation
    order_id:             str   = ""    # Entry order_id (CLOB'dan)
    fill_confirmed:       bool  = False # User WS veya reconciler doğruladı
    actual_fill_shares:   float = 0.0   # Gerçek fill miktarı (partial fill için)

    def calc_pnl(self, mark_price: float) -> float:
        """Gerçek PnL: shares × mark - amount  (shares = amount / entry_actual)"""
        if self.entry_actual <= 0:
            return 0.0
        sh = self.shares if self.shares > 0 else self.amount / self.entry_actual
        return round(sh * mark_price - self.amount, 4)
