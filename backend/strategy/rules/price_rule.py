"""Fiyat araligi kurali — UP token fiyati uygun aralikta mi?"""
from backend.strategy.rules.base import BaseRule


class PriceRule(BaseRule):
    key = "price"
    name = "Giris Fiyati"
    description = "UP token fiyati min-max araliginda olmali"

    def evaluate(self, sym, cd, mp, positions):
        up_ask = mp.get("up_ask", 0.5)
        min_p = self.settings.get("min_entry_price", 0.75)
        max_p = self.settings.get("max_entry_price", 0.98)
        return "pass" if min_p <= up_ask <= max_p else "fail"
