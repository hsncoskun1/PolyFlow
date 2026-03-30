"""Fiyat hareketi kurali — BTC yeterince hareket etti mi? (USD delta)"""
from backend.strategy.rules.base import BaseRule


class MoveRule(BaseRule):
    key = "btc_move"
    name = "BTC Hareketi"
    description = "BTC fiyati acilis referansindan yeterince uzakmali (USD)"

    def evaluate(self, sym, cd, mp, positions):
        # btc_delta = live_price - ptb (USD cinsinden, backend tarafindan hesaplanip mp'ye eklenir)
        # Referans bot: min_btc_move_up = 70$ (varsayilan)
        btc_delta = mp.get("btc_delta", None)
        if btc_delta is None:
            # Fallback: eski token-price-delta yontemi
            up_ask = mp.get("up_ask", 0.5)
            token_delta = abs(up_ask - 0.5)
            threshold_pct = self.settings.get("min_move_delta", 2.0)  # % cinsinden
            return "pass" if token_delta * 100 >= threshold_pct else "waiting"

        # Ana yontem: BTC USD delta
        threshold_usd = self.settings.get("min_move_delta", 70.0)  # USD
        return "pass" if abs(btc_delta) >= threshold_usd else "waiting"
