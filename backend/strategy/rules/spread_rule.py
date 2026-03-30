"""Spread kurali — alis-satis farki kabul edilebilir mi?"""
from backend.strategy.rules.base import BaseRule


class SpreadRule(BaseRule):
    key = "slippage"
    name = "Spread"
    description = "Alis-satis farki max slippage altinda olmali"

    def evaluate(self, sym, cd, mp, positions):
        slip = mp.get("slippage_pct", 0)
        max_slip = self.settings.get("max_slippage_pct", 0.03) * 100
        return "pass" if slip < max_slip else "fail"
