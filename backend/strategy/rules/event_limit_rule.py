"""Event limiti kurali — bu event'te zaten pozisyon var mi?"""
from backend.strategy.rules.base import BaseRule


class EventLimitRule(BaseRule):
    key = "event_limit"
    name = "Event Limiti"
    description = "Ayni event'te max pozisyon sayisi"

    def evaluate(self, sym, cd, mp, positions):
        limit = self.settings.get("event_trade_limit", 1)
        count = sum(1 for p in positions if p.get("asset") == sym)
        return "fail" if count >= limit else "pass"
