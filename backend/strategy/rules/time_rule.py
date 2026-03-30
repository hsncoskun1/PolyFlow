"""Zaman penceresi kurali — event bitimine uygun zamanda mi?"""
from backend.strategy.rules.base import BaseRule


class TimeRule(BaseRule):
    key = "time"
    name = "Zaman Penceresi"
    description = "Event bitimine uygun zamanda islem aranir"

    def evaluate(self, sym, cd, mp, positions):
        min_sec = self.settings.get("min_entry_seconds", 10)
        max_sec = self.settings.get("time_rule_threshold", 90)
        if min_sec < cd <= max_sec:
            return "pass"
        return "fail" if cd <= min_sec else "waiting"
