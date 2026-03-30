"""Fiyat hareketi kurali — yeterli UP/DOWN sapma var mi?"""
from backend.strategy.rules.base import BaseRule


class MoveRule(BaseRule):
    key = "btc_move"
    name = "Fiyat Hareketi"
    description = "UP/DN orani 0.50'den yeterince sapmali"

    def evaluate(self, sym, cd, mp, positions):
        up_ask = mp.get("up_ask", 0.5)
        delta = abs(up_ask - 0.5)
        threshold = self.settings.get("min_move_delta", 0.02)
        return "pass" if delta >= threshold else "waiting"
