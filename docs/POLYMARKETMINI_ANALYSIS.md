# Polymarketmini Tam Kod Analiz Raporu
> Tarih: 2026-03-30 | PolyFlow geliştirmesi için referans kaynak

Bu rapor `hsncoskun1/Polymarketmini` reposunun tüm dosyalarının detaylı incelemesine dayanır.
PolyFlow geliştirilirken buraya bakılacak — tekrar taratmaya gerek yok.

---

## 1. UYGULANAN ÖZELLİKLER

### Trading Logic
- BTC 5-dakikalık Polymarket marketlerini sürekli tarama ve discovery
- Strateji motoru: 7 kural pipeline → sinyal üretme
- Risk motoru: 6 sıralı pre-trade kontrol → onay/red
- Paper modda order composer + executor
- Canlı modda HMAC-SHA256 imzalı gerçek CLOB API order gönderimi
- Pozisyon açma, P&L takibi, snapshot alma (10sn aralık)
- Exit engine: 4 çıkış koşulu, öncelik sıralı
- TradingLoop: 5sn aralık | PositionTracker: 10sn aralık

### API Endpoint'leri (Tam Liste)

| Method | Path | Ne Yapar |
|--------|------|----------|
| GET | `/health` | DB latansı, sistem sağlığı |
| GET | `/api/v1/markets/` | Aktif BTC5m marketler |
| GET | `/api/v1/markets/tradeable` | Trade penceresindeki marketler |
| GET | `/api/v1/markets/scan` | Gamma API anlık tarama |
| GET | `/api/v1/markets/collector-health` | Gamma + CLOB bağlantı durumu |
| GET | `/api/v1/signals/` | Sinyal listesi |
| GET | `/api/v1/signals/stats` | Sinyal istatistikleri |
| GET | `/api/v1/signals/profiles` | Strateji profil listesi |
| POST | `/api/v1/signals/evaluate` | Manuel sinyal değerlendirme |
| GET | `/api/v1/orders/` | Order listesi |
| GET | `/api/v1/orders/stats` | Günlük order istatistikleri |
| GET | `/api/v1/positions/` | Pozisyon listesi |
| GET | `/api/v1/positions/open` | Açık pozisyonlar |
| GET | `/api/v1/positions/summary` | P&L özeti |
| POST | `/api/v1/trading/start` | Trading loop + tracker başlat |
| POST | `/api/v1/trading/stop` | Durdur |
| GET | `/api/v1/trading/status` | Loop + tracker + registry durumu |
| POST | `/api/v1/interventions/blacklist/{slug}` | Marketi kara listeye al |
| POST | `/api/v1/interventions/whitelist/{slug}` | Kara listeden çıkar |
| POST | `/api/v1/interventions/pause` | Sistemi duraklat (safe mode) |
| POST | `/api/v1/interventions/resume` | Devam ettir |
| POST | `/api/v1/interventions/exit-only` | Sadece çıkış moduna geç |
| POST | `/api/v1/interventions/emergency-stop` | Acil dur + tüm pozisyonları kapat |
| GET | `/api/v1/interventions/flags` | Sistem bayraklarını göster |
| GET | `/api/v1/dashboard/` | Tek çağrıda tam sistem durumu |
| GET | `/api/v1/logs/audit` | Trade audit trail |
| GET | `/api/v1/logs/health-metrics` | Sağlık metrikleri |

---

## 2. ORDER EXECUTION AKIŞI

### Giriş (Entry) — GTC Limit Order
1. `TradingLoop.tick()` → `StrategyEngine.evaluate()` → `RiskEngine.check()`
2. `OrderComposer.compose()`:
   - Token ID alınır (UP/DOWN)
   - Slippage: `price = base_price + (base_price * 50/10000)` (+50bps)
   - `size_shares = size_usdc / price`
   - `client_order_id = sha256(market_id + side + timestamp)`
3. **Paper**: DB'ye `filled, simulated=True` → `PositionMonitor.open_position()`
4. **Live**: HMAC imzalı `POST /order` → `{"orderType": "GTC", side: "BUY"}`

### HMAC İmzalama (Live)
```python
message = timestamp + "POST" + "/order" + json_body
signature = hmac.new(api_secret.encode(), message.encode(), sha256).hexdigest()
headers = {
    "POLY-API-KEY": api_key,
    "POLY-SIGNATURE": signature,
    "POLY-TIMESTAMP": timestamp,
    "POLY-PASSPHRASE": passphrase
}
```

### Çıkış (Exit) — KRİTİK EKSİK
- **Paper**: `PositionMonitor.close_position()` direkt çağrılır ✅
- **Live**: `"Live exit not yet implemented"` — **TAMAMLANMAMIŞ** ⚠️

---

## 3. EXIT STRATEJİSİ (4 Katman, Öncelik Sırası)

| Öncelik | Koşul | Default Eşik |
|---------|-------|--------------|
| 1 | EVENT_EXPIRED | `seconds_remaining <= 0` |
| 2 | TIME_CUTOFF | `seconds_remaining <= cutoff_sec` (60sn) |
| 3 | TAKE_PROFIT | `current_price >= entry_price * (1 + 0.25)` → %25 kâr |
| 4 | STOP_LOSS | `current_price <= entry_price * (1 - 0.40)` → %40 zarar |

**Eksik:** Trailing stop, kısmi çıkış, exit retry mekanizması.

---

## 4. RİSK MOTORU (6 Kontrol, Sıralı)

| Sıra | Kontrol | Default |
|------|---------|---------|
| 1 | Safe mode / exit-only aktif mi? | — |
| 2 | Market kara listede mi? | — |
| 3 | Pozisyon boyutu $1–$100 aralığında mı? | 1–100 USDC |
| 4 | Eş zamanlı açık pozisyon < max? | 3 |
| 5 | Günlük order sayısı < cap? | 20 |
| 6 | Günlük zarar < limit? | $20 |

---

## 5. STRATEJİ KURALLARI (7 Adet)

| # | Kural | Kontrol |
|---|-------|---------|
| 1 | ProbabilityRule | dominant taraf fiyatı ≥ min_probability (0.68) |
| 2 | TimeWindowRule | event bitişine `last_entry_window_sec` içinde mi? |
| 3 | SpreadRule | spread ≤ `spread_ceiling` (%5) |
| 4 | LiquidityRule | orderbook derinliği ≥ `liquidity_min_depth` ($100) |
| 5 | DuplicateRule | aynı market+side için `duplicate_lock_window` içinde tekrar sinyal yok |
| 6 | CooldownRule | son işlemden `cooldown_sec` geçti mi? |
| 7 | MomentumRule | BTC fiyat deltası eşiği (opsiyonel) |

---

## 6. AYARLAR — TÜM ALANLAR VE DEFAULT'LAR

### Kimlik Bilgileri (.env)
- `POLYMARKET_PRIVATE_KEY` — 0x + 64 hex (Ethereum private key)
- `POLYMARKET_API_KEY` — CLOB API key
- `POLYMARKET_API_SECRET` — HMAC imzalama için
- `POLYMARKET_API_PASSPHRASE` — header için
- `POLYMARKET_FUNDER_ADDRESS` — cüzdan adresi
- `POLYMARKET_CHAIN_ID` — 137 (Polygon mainnet)

### Strateji Parametreleri
- `DEFAULT_MIN_PROBABILITY` = 0.90
- `DEFAULT_LAST_ENTRY_WINDOW_SEC` = 60
- `DEFAULT_POSITION_SIZE_USDC` = 5.0
- `DEFAULT_MAX_CONCURRENT_POSITIONS` = 3
- `DEFAULT_TAKE_PROFIT_PCT` = 0.25
- `DEFAULT_STOP_PCT` = 0.40
- `DEFAULT_COOLDOWN_SEC` = 60
- `DEFAULT_SPREAD_CEILING` = 0.05
- `DEFAULT_LIQUIDITY_MIN_DEPTH` = 100.0

### Risk Limitleri
- `DAILY_LOSS_LIMIT_USDC` = 20.0
- `DAILY_TRADE_CAP` = 20
- `SLIPPAGE_TOLERANCE` = 0.02 (%2)

### 4 Hazır Strateji Profili
| Profil | Prob Eşiği | Entry Window | Spread | Pozisyon | Max Açık |
|--------|-----------|--------------|--------|----------|----------|
| last_minute_high_prob | 0.68 | 90sn | 0.05 | $5 | 2 |
| spread_sensitive_scalp | 0.62 | 60sn | 0.03 | $5 | 3 |
| conservative_safe | 0.72 | 120sn | 0.07 | $5 | 2 |
| paper_simulation | 0.51 | 180sn | 0.15 | $5 | 10 |

---

## 7. KALICILIK — RESTART'TA NE HAYATTA KALIR

### ✅ SQLite'ta Kalıcı
- signals, orders, order_fills, positions, position_snapshots
- markets, strategy_profiles, interventions
- system_logs, trade_audit_logs, health_metrics

### ❌ RAM'de — Restart'ta Sıfırlanır (KRİTİK RİSK)
- `safe_mode`, `exit_only_mode` bayrakları → **acil durumda set edilip restart olursa normale döner**
- Market blacklist (registry'de in-memory; DB'de alan var ama yükleniyor mu belirsiz)
- TradingLoop ve PositionTracker istatistik sayaçları

---

## 8. HATA YÖNETİMİ

- Rate limit koruması: Gamma 120/dk, CLOB 100/dk (sliding window)
- Retry: 3 deneme, exponential backoff, max 30sn
- HTTP 429 → `retry-after` header'ına uyar
- 60sn içinde 5+ hata → `error_storm = True` (dashboard'da görünür, otomatik durdurma yok)
- Exit başarısız → sadece loglama, **retry yok**
- Order başarısız → `status="failed"` DB'ye, **retry yok**

---

## 9. POLYFLow İÇİN KRİTİK EKSIKLER

| Özellik | Polymarketmini | PolyFlow Durumu | Öncelik |
|---------|---------------|-----------------|---------|
| Canlı exit emri | Eksik | Eksik | KRİTİK |
| Safe mode kalıcılığı | RAM'de kaybolur | Yok | KRİTİK |
| Emergency stop | ✅ Var | Yok | Yüksek |
| Position tracker (auto-exit) | ✅ Var | Yok | Yüksek |
| Health monitoring / error storm | ✅ Var | Yok | Yüksek |
| Intervention service (blacklist) | ✅ Var | Yok | Orta |
| Audit trail (karar defteri) | ✅ Var | Yok | Orta |
| Liquidity rule | ✅ Var | Yok | Orta |
| Duplicate/cooldown rule | ✅ Var | Yok | Orta |
| Trailing stop | Yok | Yok | Orta |
| HMAC signing (live) | ✅ Var | Eksik | Faz 4 |
| Strateji profilleri (UI) | Sabit kodlanmış | Yok | Düşük |
| Kısmi çıkış (partial close) | Altyapı var | Yok | Düşük |
