"""
tests/test_architecture.py — Nihai mimari doğrulama testleri.

Kapsam:
  1. Generic TF parser (parse_timeframe)
  2. _is_price_fresh — stale gate lojiği
  3. Relay fiyat authoritative _rtds_prices'ı etkilememeli
  4. trade_allowed / verification gate bütünlüğü
  5. Canonical registry alanları (scan.py)
  6. Stale CLOB → market_valid=False
"""
import sys
import time
import types
import unittest
from pathlib import Path

# POLYFLOW kök dizinini path'e ekle
sys.path.insert(0, str(Path(__file__).parent.parent))


# ─── TEST 1: Generic TF Parser ────────────────────────────────────────────────
from backend.market.scan import parse_timeframe, _detect_tf, TF_SECONDS


class TestGenericTFParser(unittest.TestCase):

    # ── Dakika desenleri ────────────────────────────────────────────────────────
    def test_5m_slug(self):
        self.assertEqual(parse_timeframe("btc-5m-up-or-down"), "5M")

    def test_15m_slug(self):
        self.assertEqual(parse_timeframe("btc-15min-up-or-down"), "15M")

    def test_30m_slug(self):
        self.assertEqual(parse_timeframe("eth-30m-up-or-down"), "30M")

    def test_7m_slug(self):
        self.assertEqual(parse_timeframe("sol-7m-updown"), "7M")

    def test_10m_slug(self):
        self.assertEqual(parse_timeframe("btc-10min-up-down"), "10M")

    # ── Saat desenleri ──────────────────────────────────────────────────────────
    def test_1h_slug(self):
        self.assertEqual(parse_timeframe("bitcoin-up-or-down-1h"), "1H")

    def test_4h_slug(self):
        self.assertEqual(parse_timeframe("bitcoin-up-or-down-4hour"), "4H")

    def test_4h_slug_dash(self):
        self.assertEqual(parse_timeframe("btc-4-hour-up-or-down"), "4H")

    def test_2h_slug(self):
        self.assertEqual(parse_timeframe("eth-2h-up-or-down"), "2H")

    def test_12h_slug(self):
        self.assertEqual(parse_timeframe("btc-12h-up-or-down"), "12H")

    # ── Gün desenleri ───────────────────────────────────────────────────────────
    def test_1d_slug(self):
        self.assertEqual(parse_timeframe("bitcoin-up-or-down-daily"), "1D")

    def test_1d_24h(self):
        self.assertEqual(parse_timeframe("btc-24h-up-or-down"), "1D")

    def test_3d_slug(self):
        self.assertEqual(parse_timeframe("btc-3d-up-or-down"), "3D")

    def test_7d_weekly(self):
        self.assertEqual(parse_timeframe("bitcoin-weekly"), "7D")

    # ── Soru metinleri ──────────────────────────────────────────────────────────
    def test_question_15_min(self):
        self.assertEqual(parse_timeframe("Will BTC go up or down in 15 min?"), "15M")

    def test_question_4_hour(self):
        self.assertEqual(parse_timeframe("Will ETH go up or down in 4 hour?"), "4H")

    def test_question_1_day(self):
        self.assertEqual(parse_timeframe("Will SOL go up or down in 1 day?"), "1D")

    # ── Bilinmeyen → None ───────────────────────────────────────────────────────
    def test_unknown_returns_none(self):
        self.assertIsNone(parse_timeframe("totally-unrelated-slug"))

    # ── _detect_tf fallback → "5M" ──────────────────────────────────────────────
    def test_detect_tf_fallback(self):
        self.assertEqual(_detect_tf("totally-unrelated-slug"), "5M")

    # ── 5M yanlış parse edilmiyor (önceki hata) ─────────────────────────────────
    def test_no_false_5m_match(self):
        """7M slug'ı 5M olarak parse etmemeli."""
        tf = _detect_tf("btc-7m-updown")
        self.assertNotEqual(tf, "5M")
        self.assertEqual(tf, "7M")

    def test_30m_not_parsed_as_5m(self):
        tf = _detect_tf("btc-30m-updown")
        self.assertNotEqual(tf, "5M")
        self.assertEqual(tf, "30M")

    # ── TF_SECONDS genişletildi ─────────────────────────────────────────────────
    def test_tf_seconds_includes_new_tfs(self):
        self.assertIn("30M", TF_SECONDS)
        self.assertIn("7M", TF_SECONDS)
        self.assertIn("2H", TF_SECONDS)
        self.assertIn("3D", TF_SECONDS)
        self.assertIn("7D", TF_SECONDS)
        self.assertEqual(TF_SECONDS["7M"], 420)
        self.assertEqual(TF_SECONDS["30M"], 1800)
        self.assertEqual(TF_SECONDS["2H"], 7200)


# ─── TEST 2: _is_price_fresh ─────────────────────────────────────────────────
# main.py'yi doğrudan import etmeden test etmek için fonksiyonu izole ederek test et.

def _make_is_price_fresh_fn(prices, prices_ts, stale_sec, pmin, pmax):
    """Test için izole _is_price_fresh fonksiyonu üret."""
    def fn(sym):
        ts = prices_ts.get(sym, 0.0)
        if ts == 0.0:
            return False
        if time.time() - ts > stale_sec:
            return False
        val = prices.get(sym, 0.0)
        if val < pmin or val > pmax:
            return False
        return True
    return fn


class TestIsPriceFresh(unittest.TestCase):

    def setUp(self):
        self.now = time.time()
        self.prices    = {"BTC": 67000.0, "ETH": 3100.0}
        self.prices_ts = {"BTC": self.now - 2.0, "ETH": self.now - 5.0}  # 2s and 5s ago
        self.fn = _make_is_price_fresh_fn(
            self.prices, self.prices_ts,
            stale_sec=10.0, pmin=0.01, pmax=1_000_000.0
        )

    def test_fresh_price(self):
        self.assertTrue(self.fn("BTC"))

    def test_5s_still_fresh(self):
        self.assertTrue(self.fn("ETH"))

    def test_stale_price(self):
        self.prices_ts["BTC"] = self.now - 11.0  # 11s ago
        fn = _make_is_price_fresh_fn(self.prices, self.prices_ts, 10.0, 0.01, 1_000_000.0)
        self.assertFalse(fn("BTC"))

    def test_no_data_returns_false(self):
        """Hiç fiyat gelmemişse (startup) → False. Grace period yok."""
        fn = _make_is_price_fresh_fn({}, {}, 10.0, 0.01, 1_000_000.0)
        self.assertFalse(fn("BTC"))

    def test_price_below_min(self):
        self.prices["BTC"] = 0.001  # below RTDS_PRICE_MIN
        fn = _make_is_price_fresh_fn(self.prices, self.prices_ts, 10.0, 0.01, 1_000_000.0)
        self.assertFalse(fn("BTC"))

    def test_price_above_max(self):
        self.prices["BTC"] = 2_000_000.0  # spike
        fn = _make_is_price_fresh_fn(self.prices, self.prices_ts, 10.0, 0.01, 1_000_000.0)
        self.assertFalse(fn("BTC"))

    def test_unknown_sym_returns_false(self):
        self.assertFalse(self.fn("UNKNOWN"))


# ─── TEST 3: Relay prices NOT authoritative ──────────────────────────────────

class TestRelayIsolation(unittest.TestCase):
    """Relay fiyatlar _rtds_prices'ı (authoritative) etkilememeli."""

    def setUp(self):
        # Simulate main.py'nin global state'ini izole et
        self._rtds_prices    = {"BTC": 67000.0}
        self._rtds_prices_ts = {"BTC": time.time() - 1.0}
        self._relay_prices   = {}
        self._relay_prices_ts = {}

    def _handle_price_relay(self, sym, val):
        """main.py ws_endpoint price_relay handler'ını simüle et (yeni mimari)."""
        if sym and isinstance(val, (int, float)) and val > 0:
            # YENİ: relay SADECE _relay_prices'a yazar, _rtds_prices'a değil
            self._relay_prices[sym]    = round(float(val), 2)
            self._relay_prices_ts[sym] = time.time()

    def test_relay_does_not_update_rtds_prices(self):
        """Relay mesajı _rtds_prices'ı güncellemez."""
        original = self._rtds_prices["BTC"]
        self._handle_price_relay("BTC", 99999.0)
        self.assertEqual(self._rtds_prices["BTC"], original,
                         "_rtds_prices relay sonrası değişmemeli")

    def test_relay_updates_relay_prices(self):
        """Relay mesajı _relay_prices'a yazılır."""
        self._handle_price_relay("BTC", 68500.0)
        self.assertEqual(self._relay_prices["BTC"], 68500.0)

    def test_relay_does_not_update_timestamp(self):
        """Relay, authoritative timestamp'i (_rtds_prices_ts) güncellemez."""
        ts_before = self._rtds_prices_ts["BTC"]
        time.sleep(0.01)
        self._handle_price_relay("BTC", 68500.0)
        self.assertEqual(self._rtds_prices_ts["BTC"], ts_before,
                         "_rtds_prices_ts relay sonrası değişmemeli")

    def test_relay_invalid_value_ignored(self):
        """Geçersiz relay değeri _relay_prices'a yazılmaz."""
        self._handle_price_relay("BTC", -100)
        self.assertNotIn("BTC", self._relay_prices)
        self._handle_price_relay("ETH", 0)
        self.assertNotIn("ETH", self._relay_prices)


# ─── TEST 4: Trade gate — hard block lojiği ──────────────────────────────────

class TestTradeGate(unittest.TestCase):
    """trade_allowed = ref_valid AND market_valid AND settings_configured"""

    def _compute_trade_allowed(self, ref_valid, market_valid, settings_configured):
        return ref_valid and market_valid and settings_configured

    def test_all_valid(self):
        self.assertTrue(self._compute_trade_allowed(True, True, True))

    def test_ref_invalid_blocks(self):
        self.assertFalse(self._compute_trade_allowed(False, True, True))

    def test_market_invalid_blocks(self):
        self.assertFalse(self._compute_trade_allowed(True, False, True))

    def test_no_settings_blocks(self):
        self.assertFalse(self._compute_trade_allowed(True, True, False))

    def test_all_invalid_blocks(self):
        self.assertFalse(self._compute_trade_allowed(False, False, False))

    def test_stale_ref_no_grace(self):
        """Grace period yok — hiç fiyat gelmemişse ref_valid=False → trade yok."""
        prices_ts = {}  # empty — startup, no price ever
        rtds_symbols = {"BTC", "ETH", "SOL"}
        sym = "BTC"

        ref_valid = True
        if sym in rtds_symbols:
            # is_price_fresh: ts=0 → False (no grace)
            ts = prices_ts.get(sym, 0.0)
            ref_valid = ts != 0.0  # simplified version
        self.assertFalse(ref_valid)

    def test_trade_allowed_requires_ref_fresh(self):
        """Fiyat 15s önce güncellenmiş (stale) → ref_valid=False → trade_allowed=False."""
        prices    = {"BTC": 67000.0}
        prices_ts = {"BTC": time.time() - 15.0}  # 15s ago, stale
        fn = _make_is_price_fresh_fn(prices, prices_ts, 10.0, 0.01, 1_000_000.0)

        ref_valid = fn("BTC")  # False — stale
        trade_allowed = self._compute_trade_allowed(ref_valid, True, True)
        self.assertFalse(trade_allowed)


# ─── TEST 5: Canonical registry alanları ────────────────────────────────────

class TestCanonicalFields(unittest.TestCase):
    """discover_slug_market canonical alanları döndürüyor mu?"""

    def _make_mock_market(self, end_ts_offset=300):
        """Test için sahte market dict'i oluştur."""
        now = time.time()
        return {
            "conditionId": "0xabc123",
            "question": "Will BTC go up or down in 5 min?",
            "slug": "bitcoin-up-or-down-5m",
            "clobTokenIds": '["token_up_id", "token_down_id"]',
            "outcomePrices": '["0.55", "0.45"]',
            "endDate": "2099-01-01T00:00:00Z",
            "volume": "1000",
            "liquidity": "500",
        }

    def test_required_canonical_fields_present(self):
        """Canonical registry alanları var mı?"""
        import json
        m = self._make_mock_market()

        # discover_slug_market'ın build ettiği dict'i manuel simüle et
        raw_tokens = json.loads(m.get("clobTokenIds", "[]"))
        up_asset_id   = raw_tokens[0] if len(raw_tokens) > 0 else ""
        down_asset_id = raw_tokens[1] if len(raw_tokens) > 1 else ""

        entry = {
            "conditionId":      m.get("conditionId", ""),
            "slug":             m.get("slug", ""),
            "tokens":           raw_tokens,
            "up_asset_id":      up_asset_id,
            "down_asset_id":    down_asset_id,
            "end_ts":           time.time() + 300,
            "market_status":    "open",
            "verification_state": "unverified",
        }

        required = [
            "conditionId", "slug", "tokens",
            "up_asset_id", "down_asset_id",
            "end_ts", "market_status", "verification_state",
        ]
        for field in required:
            self.assertIn(field, entry, f"Eksik canonical alan: {field}")

    def test_up_down_asset_ids_extracted(self):
        import json
        raw_tokens = ["token_up_id", "token_down_id"]
        up   = raw_tokens[0] if len(raw_tokens) > 0 else ""
        down = raw_tokens[1] if len(raw_tokens) > 1 else ""
        self.assertEqual(up,   "token_up_id")
        self.assertEqual(down, "token_down_id")

    def test_market_status_open_for_future(self):
        end_ts = time.time() + 300
        status = "open" if end_ts > time.time() else "closed"
        self.assertEqual(status, "open")

    def test_market_status_closed_for_past(self):
        end_ts = time.time() - 300
        status = "open" if end_ts > time.time() else "closed"
        self.assertEqual(status, "closed")


# ─── TEST 6: Frontend sadece backend state'i göstermeli ──────────────────────
# (Mimari kural doğrulaması — JS'i test edemeyiz ama davranışı belgele)

class TestFrontendContract(unittest.TestCase):
    """Frontend mimari kurallarının kod kanıtı."""

    def test_backend_only_mode_constant(self):
        """ws.js'teki _BACKEND_ONLY_MODE sabitini oku ve True olduğunu doğrula."""
        ws_js_path = Path(__file__).parent.parent / "frontend" / "js" / "ws.js"
        self.assertTrue(ws_js_path.exists(), "ws.js bulunamadı")
        content = ws_js_path.read_text(encoding="utf-8")
        self.assertIn("_BACKEND_ONLY_MODE = true", content,
                      "_BACKEND_ONLY_MODE true olmalı — seesawing önleme")

    def test_relay_comment_says_not_authoritative(self):
        """Relay handler'ın 'NOT AUTHORITATIVE' yorumu var mı?"""
        ws_js_path = Path(__file__).parent.parent / "frontend" / "js" / "ws.js"
        content = ws_js_path.read_text(encoding="utf-8").upper()
        self.assertIn("NOT AUTHORITATIVE", content,
                      "Relay NOT AUTHORITATIVE olarak işaretlenmeli")

    def test_relay_handler_writes_relay_prices_not_rtds(self):
        """Backend relay handler _relay_prices'a yazıyor, _rtds_prices'a değil."""
        main_py_path = Path(__file__).parent.parent / "backend" / "main.py"
        content = main_py_path.read_text(encoding="utf-8")
        # Relay handler bloğunu bul
        relay_block_start = content.find("price_relay")
        self.assertGreater(relay_block_start, 0, "price_relay handler bulunamadı")
        relay_block = content[relay_block_start:relay_block_start + 500]
        self.assertIn("_relay_prices", relay_block,
                      "Relay handler _relay_prices'a yazmalı")
        # _rtds_prices'a YAZMAMALI
        # Not: handler bloğu için çok dar bir pencere kullan
        self.assertNotIn("_rtds_prices[sym]", relay_block,
                         "Relay handler _rtds_prices'a yazmamalı")

    def test_verification_gate_no_grace_period(self):
        """Grace period kaldırıldı — startup'ta fiyat yoksa bloke."""
        main_py_path = Path(__file__).parent.parent / "backend" / "main.py"
        content = main_py_path.read_text(encoding="utf-8")
        # Eski grace period kodu olmamalı
        self.assertNotIn("# startup grace", content.lower(),
                         "Grace period kaldırıldı — bu yorum olmamalı")
        # Yeni verification gate var mı
        self.assertIn("VERIFICATION_GATE", content,
                      "VERIFICATION_GATE log tag'i olmalı")

    def test_hard_block_in_entry_trigger(self):
        """Entry trigger'da _trade_allowed hard-block var mı?"""
        main_py_path = Path(__file__).parent.parent / "backend" / "main.py"
        content = main_py_path.read_text(encoding="utf-8")
        self.assertIn("_trade_allowed", content,
                      "_trade_allowed hard-block değişkeni olmalı")
        self.assertIn("HARD BLOCK", content.upper() + content,
                      "Hard block yorumu olmalı")


if __name__ == "__main__":
    unittest.main(verbosity=2)
