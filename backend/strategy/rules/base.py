"""Kural base class — tum kurallar bundan turetilir."""


class BaseRule:
    key: str = ""
    name: str = ""
    description: str = ""

    def __init__(self, settings: dict = None):
        self.settings = settings or {}

    def evaluate(self, sym: str, cd: int, mp: dict, positions: list) -> str:
        """'pass', 'fail' veya 'waiting' dondur."""
        raise NotImplementedError
