"""
Strateji motoru — kural degerlendirmesi.
Tum veri Polymarket'ten gelir, simulasyon yok.
"""
from backend.strategy.rules.time_rule import TimeRule  # noqa
from backend.strategy.rules.price_rule import PriceRule  # noqa
from backend.strategy.rules.move_rule import MoveRule  # noqa
from backend.strategy.rules.spread_rule import SpreadRule  # noqa
from backend.strategy.rules.event_limit_rule import EventLimitRule  # noqa
from backend.strategy.rules.max_positions_rule import MaxPositionsRule  # noqa


ALL_RULES = [TimeRule, PriceRule, MoveRule, SpreadRule, EventLimitRule, MaxPositionsRule]


def evaluate_rules(sym: str, cd: int, mp: dict, positions: list, settings: dict = None) -> dict:
    """Tum kurallari degerlendir ve sonuc dict'i don."""
    results = {}
    for rule_cls in ALL_RULES:
        rule = rule_cls(settings or {})
        results[rule.key] = rule.evaluate(sym, cd, mp, positions)
    return results
