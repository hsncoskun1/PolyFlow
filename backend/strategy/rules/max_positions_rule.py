"""Max pozisyon kurali — toplam acik pozisyon limiti."""
from backend.strategy.rules.base import BaseRule


class MaxPositionsRule(BaseRule):
    key = "max_positions"
    name = "Max Pozisyon"
    description = "Toplam acik pozisyon sayisi limiti"

    def evaluate(self, sym, cd, mp, positions):
        max_pos = self.settings.get("max_open_positions", 1)
        return "fail" if len(positions) >= max_pos else "pass"
