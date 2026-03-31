# POLYFLOW — Piyasaya Sürülebilir Ürün Master Planı
**Tarih:** 2026-03-31
**Referans kaynaklar:** ChatGPT Talimat + Öneri 1 + Öneri 2 + Plan Eleştirisi + Claude Analizi
**Durum:** Aktif geliştirme rehberi

---

## BÖLÜM 1 — 4 KAYNAK SENTEZİ

### ChatGPT'nin Haklı Olduğu Konular ✅
| Konu | Neden Doğru |
|------|-------------|
| Backend tek WS otoritesi | Şu an frontend de CLOB/RTDS'e bağlı → tutarsız state → yanlış fiyattan emir riski |
| Risk engine ayrı servis | "girmek istiyorum" → risk onayı → emir. Bu ayrım olmazsa duplicate/exposed pozisyonlar |
| decision_log erken gelsin | Bot çalışmaya başladığı anda "neden açtı/kapattı" görünmeli. Faz 5'e bırakmak hata |
| Min risk guard'lar Faz 1'de | Duplicate guard, max_positions, safe_mode, stale_data — bunlar olmadan paper bile yanıltıcı |
| Trading logic main.py'e gömülmemeli | entry_service ayrı modül olmalı, aksi halde tekrar god-file |
| Source ownership ayrımı | Trade kararları YALNIZCA backend verisiyle alınmalı |

### ChatGPT'nin Overkill Önerileri ❌
| Öneri | Neden Şimdi Değil |
|-------|-------------------|
| TokenState dataclass + BookLevel | Dict-based approach çalışıyor. Execution engine yazılırken gerekli olacak |
| PostgreSQL + Redis | SQLite + in-memory dict şu an yeterli. $1000+/gün volume geçince geç |
| React rewrite | Vanilla JS + modüler dosyalar yeterli, 0 fayda için büyük maliyet |
| 9 fazlı "discovery'den başla" planı | Discovery zaten çalışıyor. Sıfırdan başlamak çalışan kodu çöpe atar |
| 50ms → 200ms → 100ms tuning | Önce 100ms ile başla, stabil olunca 50ms |
| APScheduler + ayrı servis prosesleri | Asyncio task'lar şimdilik yeterli, microservice'e gerek yok |

### Sentez: 3 Temel Kural
```
1. live market state     = in-memory (dict + cache)  — DB'ye yazma, sadece oku
2. persistent data       = SQLite (order, fill, audit, config, bot_state)
3. execution decision    = BACKEND ONLY
   └─ raw WS ownership  = backend only (frontend sadece render eder)
   └─ trade kararı      = backend state'ten, frontend state'ten değil
```

---

## BÖLÜM 2 — MEVCUT DURUM (Tamamlanan Fixler)

### ✅ Tamamlanan Kritik Fixler
| # | Fix | Commit | Durum |
|---|-----|--------|-------|
| 1 | 25sn price lock kaldırıldı (3 lokasyon) | 997e090 | ✅ |
| 2 | 22%↔52% seesawing — `_wsMarketPrices` cache + `_mergeState` restore | cc0a4c5 | ✅ |
| 3 | event_type filtresi (book/book_delta orderbook level'ı fiyat gibi alma) | cc0a4c5 | ✅ |
| 4 | PTB/live_price/delta `updateCardsInPlace`'de güncellenmiyor | cc0a4c5 | ✅ |
| 5 | Event linkleri önceki event'e gidiyordu (Gamma API slug fix) | 997e090 | ✅ |
| 6 | 1G time column overflow (168px + `_fmtSec` helper) | 997e090 | ✅ |
| 7 | Startup timing — events görünmüyordu (lifespan'da initial scan) | 2d49231 | ✅ |
| 8 | Yeni event başlayınca eski `_asset_market` temizlenmiyordu | b696bad | ✅ |
| 9 | CLOB WS yeni event token'larında reconnect etmiyordu | b696bad | ✅ |
| 10 | Frontend `_wsMarketPrices` eski event slug değişince temizleniyordu | b696bad | ✅ |

### Mevcut Durum Özeti
```
✅ Market discovery (scan_slug_based + discovery_scan)
✅ Live price feed — CLOB WS + RTDS (backend)
✅ Rule evaluation (6 kural)
✅ Per-event settings (modal + DB)
✅ PTB fetch (__NEXT_DATA__ + Gamma fallback)
✅ BTC delta hesabı
✅ Event slug değişince tam reset (YENİ)
❌ Execution engine (live order)
❌ Position tracker
❌ TP/SL/Force sell exit loop
❌ Risk engine
❌ decision_log
❌ Frontend direkt WS kaldırılmadı
```

---

## BÖLÜM 3 — NİHAİ GELİŞTİRME PLANI

### FAZ 0 — Mini Mimari Stabilizasyon (1-2 gün)
**Hedef:** Yeni trading logic'in main.py'e gömülmesini engelle. God file'ı parçala.
**ChatGPT plan eleştirisiyle tam örtüşüyor.**

#### 0.1 main.py God File Split (Extract-then-Import)
Yöntem: Her fonksiyon yeni dosyaya taşınır → main.py'den import edilir → test edilir → eski kod silinir.

```
backend/
├── market_data/
│   ├── __init__.py
│   ├── discovery.py      ← scan_slug_based, discovery_scan, _calc_candidate_slugs
│   ├── registry.py       ← _market_cache, COIN_REGISTRY, SLUG_PREFIX, token_to_key
│   ├── clob_feed.py      ← clob_ws_connect, _update_token, _clob_prices
│   └── rtds_feed.py      ← _rtds_coin_loop, _rtds_prices, get_live_price
├── ptb/
│   └── manager.py        ← _ptb_loop, _fetch_ptb_*, get_ptb
├── engine/
│   ├── tick.py           ← simulation_tick
│   └── broadcast.py      ← broadcast_loop, _build_broadcast_payload
└── main.py               ← sadece FastAPI init + lifespan + API endpoints (~400 satır)
```

**Her extract adımı için test protokolü:**
1. Fonksiyon yeni dosyaya kopyalanır
2. main.py'de `from backend.market_data.discovery import scan_slug_based` ile import
3. Sunucu başlatılır → eventler görünür → 60sn izle → hata yok
4. Eski kod main.py'den silinir

#### 0.2 anomaly_check Fonksiyonu (Plan 2'den, 30 dakika)
```python
# backend/market_data/registry.py içine ekle
def anomaly_check(mp: dict) -> list:
    issues = []
    bid = mp.get("up_bid", 0)
    ask = mp.get("up_ask", 0)
    mid = mp.get("up_mid", 0)
    if bid > 0 and ask > 0 and bid > ask:
        issues.append("best_bid > best_ask")
    if mid > 0 and not (0.01 <= mid <= 0.99):
        issues.append("midpoint_out_of_range")
    if bid > 0 and ask > 0 and mid > 0:
        if abs(mid - (bid + ask) / 2) > 0.10:
            issues.append(f"mid_bid_ask_gap:{abs(mid-(bid+ask)/2):.3f}")
    return issues
```
simulation_tick'te çağır: `if anomaly_check(mp): addlog("warn", f"{key} anomali: {issues}")`

---

### FAZ 1 — Execution Engine + Min Risk Guards (3-5 gün)
**Hedef:** "Bot başlat → kural geçti → order açıldı → TP/SL kapandı → history'de göründü"
**ÖNEMLİ:** Entry + Exit AYNI fazda deploy edilmeli (exit yokken entry açılırsa USDC kilitlenir)

#### 1.1 Yeni Dosyalar (backend/execution/)
```
backend/execution/
├── __init__.py
├── entry_service.py      ← _try_open_position, event lock, entry trigger
├── position_tracker.py   ← DB + in-memory, UUID-based, PnL hesabı
└── sell_retry.py         ← 100ms TP/SL/force sell exit loop
```

#### 1.2 entry_service.py — Entry Trigger
**Race guard:** in-memory set `_open_events: set` — event key entry öncesi eklenir.

```python
# entry_service.py
_open_events: set = set()  # Aynı event'e çift girişi engelle

async def try_open_position(key, sym, mp, rules, settings):
    if key in _open_events:
        return  # Duplicate guard
    if settings.get("safe_mode"):
        return  # Safe mode guard
    if not is_data_fresh(key):
        return  # Stale data guard (son veri > 5sn ise)
    open_count = get_active_count()
    if open_count >= settings.get("max_open_positions", 3):
        return  # Max positions guard

    _open_events.add(key)
    try:
        side = "UP"  # rules'tan belirle
        entry_price = mp.get("up_ask", 0.5)
        amount = settings.get("order_amount", 25)
        await _execute_live_entry(key, side, entry_price, amount)
    finally:
        # Position kapatılınca entry_service'ten event_key temizlenir
        pass
```

#### 1.3 position_tracker.py — Position State
```python
# Status: OPEN | CLOSED | TP | SL | FORCE_SELL | HOLD_TO_RESOLUTION
# PnL: shares = amount / entry; pnl = shares × mark_price - amount
# DB tablosu: positions(id, key, side, entry_price, target, stop_loss,
#              amount, shares, status, close_reason, created_at, closed_at)
def get_active_count() -> int
def open_position(key, side, entry_price, amount, target, stop_loss) -> str  # returns position_id
def close_position(pos_id, exit_price, reason: str)
def get_open_positions() -> list
```

#### 1.4 sell_retry.py — Exit Loop (100ms)
```python
# Smart force sell logic (referans bottan alınan pattern):
# TP: up_ask >= target_exit_price → kapat ("TP")
# SL: up_ask <= stop_loss_price → kapat ("SL")
# Force sell (SMART):
#   countdown <= force_sell_seconds AND karda AND TP geçtiyse → HOLD_TO_RESOLUTION
#   countdown <= force_sell_seconds AND zararda → hemen kapat ("FORCE_SELL")
# Orderbook anomaly: tek tick >30% düşüş → önceki mark kullan, SL tetikleme
```

#### 1.5 Minimum Risk Guards (Faz 1'de zorunlu)
```python
# entry_service.try_open_position() içinde — ChatGPT plan eleştirisi haklı
def _check_risk(key, settings) -> tuple[bool, str]:
    if settings.get("safe_mode"): return False, "safe_mode"
    if key in _event_blacklist: return False, "blacklist"
    if _event_trade_count.get(key, 0) >= settings.get("event_trade_limit", 1):
        return False, "event_trade_limit"
    if get_active_count() >= settings.get("max_open_positions", 3):
        return False, "max_positions"
    if _is_duplicate(key, "UP"): return False, "duplicate"
    age = time.time() - _last_market_update.get(key, 0)
    if age > 5.0: return False, "stale_data"
    return True, "ok"
```

#### 1.6 decision_log.py (ChatGPT plan eleştirisi: Faz 2 değil Faz 1'e taşı)
```python
# backend/decision_log.py
# Her entry/skip/exit kararını sebepli logla
# DB: audit_log(event_key, decision, reason, rules_snapshot, entry_price, timestamp)
def log_entry(key, side, entry_price, rules, amount): ...
def log_skip(key, reason, rules): ...
def log_exit(pos_id, exit_price, reason, pnl): ...
```
Frontend → Logs sayfasında "Karar Günlüğü" sekmesi.

#### 1.7 Pozisyonlar Sayfası Gerçek Veri
- Canlı P&L (WebSocket güncelleme)
- Exit reason badge: TP / SL / FORCE / HOLD
- decision_log'dan "neden açıldı" tooltip

**Test:** Bot başlatılınca 60sn içinde ilk live order açılmalı. TP/SL manuel test. DB'de kayıt görünmeli.

---

### FAZ 2 — Güvenlik + Kontrol (2-3 gün)
**Hedef:** "Bir şeyler ters giderse bot kendini durduruyor ve ben paniklemiyor."

#### 2.1 Safe Mode Kalıcılığı
```sql
-- DB: bot_state tablosu
CREATE TABLE bot_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at REAL
);
-- Kayıtlar: safe_mode, exit_only, paused, session_start_balance, started_at
```
Restart'ta yükle → safe_mode=True ise bot auto-start etmesin.

#### 2.2 Emergency Stop
- Sidebar'a kırmızı "ACİL DURDUR" butonu
- `POST /api/bot/emergency-stop` → tüm açık pozisyonları FORCE_SELL → safe_mode=True DB'ye yaz → broadcast

#### 2.3 Session PnL
- Bot başladığında başlangıç balance sabitle
- Kapanan trade'lerin toplamı = Session PnL
- Sidebar'da `Session PnL: +$X.XX`

#### 2.4 Source Ownership Görünürlüğü
- Her kart üzerinde küçük badge: `BE` (backend) veya `FE` (frontend)
- Trade kararları YALNIZCA backend verisiyle alınır (execution engine backend state'i kullanıyor)
- Frontend direkt WS verileri sadece görsel (trade kararına girmez)

---

### FAZ 3 — Live Trading Altyapısı (2-4 gün)
**⚠️ Bu fazı başlamadan önce kullanıcıdan ayrıca onay al.**
**⚠️ Frontend direkt WS kaldırılmadan live mode açılmamalı.**

#### 3.1 Frontend Direkt WS Kaldır (Şart)
```javascript
// app.js'den çıkarılacak:
// - CLOB WS bağlantısı (_directReady, clob_ws_connect)
// - RTDS bağlantısı
// - _wsMarketPrices (artık gerekmiyor — backend otorite)
// - _wsLivePrices (aynı)
// Bunlar kaldırılınca:
// - seesawing problemi kalıcı olarak çözülür
// - _mergeState sadeleşir
// - trade kararları tek kaynaktan (backend) gelir
```

#### 3.2 order_executor.py (Live)
```python
# backend/execution/order_executor.py
# Referans: D:\polymarketminiclaude_NEWDASHBOARD\backend\order_executor.py
async def execute_live_entry(key, side, token_id, amount) -> dict:
    # MarketOrderArgs(token_id, amount, side=BUY)
    # client.create_market_order() → client.post_order(OrderType.FOK)
    # HTTP 425 retry: 5sn × 18 deneme (max 90sn)
    # Fill price parse: _parse_fill_price(resp)
    # HMAC: py-clob-client içinde — manuel signing gerekmez
```

#### 3.3 Live Balance
- `GET /clob-api.polymarket.com/balance-allowance`
- Bot başladığında fetch, her 60sn refresh
- Sidebar'da gerçek bakiye

#### 3.4 User Order WS
- Fill confirmation izleme
- Entry actual price güncelle (slippage gerçeği)
- On-chain tx hash logla

#### 3.5 İlk Test: $1 ile 1 Trade
```
□ Private key + API creds konfigüre
□ Wallet balance > $5
□ Bot LIVE moda geçir
□ Manuel olarak 1 event aktif et, ayar yap
□ $1 ile ilk order
□ Fill geldi mi kontrol et (terminal log + DB)
□ Exit otomatik tetiklendi mi
□ USDC geri döndü mü
```

---

### FAZ 4 — Auto-Claim + Gelişmiş Risk (1-2 gün)

#### 4.1 HOLD_TO_RESOLUTION Takibi
```python
# Event resolved olduğunda (countdown = 0) claim dene
# DB'de condition_id sütunu ekle
# relayer.py → auto_claim_hold_positions() → her 5sn
```

#### 4.2 Tam Risk Engine
```python
# backend/risk/engine.py
# Günlük toplam zarar limiti
# Timeframe başına max açık pozisyon
# Stale feed guard (her marketin son update zamanı)
# Spread guard (max spread aşılırsa no-trade)
# Wallet balance guard
# returns: {"approved": bool, "reasons": [str]}
```

---

### FAZ 5 — Performans + Üretim (Gelecekte)
- SQLite → PostgreSQL (gerekirse, $1000+/gün volume)
- in-memory → Redis (gerekirse)
- Strategy profilleri (preset konfigürasyonlar)
- Performans analitikleri (win rate, avg P&L, best/worst)
- Admin panel ayrı yüzey

---

## BÖLÜM 4 — DOSYA DURUMU HARİTASI

| Dosya | Mevcut Durum | Aksiyon |
|-------|-------------|---------|
| `backend/main.py` | God file (~1400 satır) | FAZ 0: Extract-then-import ile 400 satıra in |
| `frontend/js/app.js` | God file (~1600 satır) | FAZ 3 sonrası bölünür |
| `backend/strategy/` | ✅ İyi durumda | Dokunma |
| `backend/storage/db.py` | ✅ Çalışıyor | FAZ 1'de positions/audit tabloları ekle |
| `backend/config.py` | ✅ Çalışıyor | Küçük eklemeler yeterli |
| `backend/execution/` | ❌ Yok | FAZ 1'de oluştur |
| `backend/risk/` | ❌ Yok | FAZ 1 (min guards) → FAZ 4 (tam engine) |
| `backend/decision_log.py` | ❌ Yok | FAZ 1'de ekle |
| `frontend/css/polyflow.css` | ✅ Çalışıyor | Minimal değişiklik |

---

## BÖLÜM 5 — KRİTİK KURALLAR

### Asla Yapılmayanlar
```
❌ Entry açmadan exit kapat (hiçbir zaman)
❌ Frontend WS kaldırılmadan LIVE mode (fiyat tutarsızlığı riski)
❌ Execution logic'i main.py'e ekle (god file büyür)
❌ Her tick'te DB yaz (performance kill)
❌ Stale data (>5sn) ile trade aç
❌ Safe mode bypass (emergency stop işe yaramaz)
```

### Her Zaman Yapılanlar
```
✅ Her faz öncesi GitHub backup commit
✅ Extract yöntemi: taşı → import et → test et → eski kodu sil
✅ Entry + exit AYNI fazda deploy
✅ Live test: $1 ile başla
✅ decision_log: her karar sebepli loglanır
✅ Yeni event başlayınca: _asset_market sıfırla + WS reconnect + frontend cache temizle (ARTIK OTOMATİK)
```

---

## BÖLÜM 6 — SONRAKI ADIM

**Şu an yapılacak: FAZ 0.1 — main.py split, discovery.py extract**

Adım 1: `backend/market_data/` klasörü oluştur
Adım 2: `scan_slug_based` + `discovery_scan` + `_calc_candidate_slugs` → `discovery.py`
Adım 3: main.py'den import et
Adım 4: Sunucu çalış, eventler görün → onay
Adım 5: Eski kodu main.py'den sil
Adım 6: Commit
Adım 7: Sıradaki extract: `registry.py`

---

*Bu belge D:\POLYFLOW\docs\MASTER_PLAN.md olarak kaydedilmiştir.*
*Plan 2: D:\POLYFLOW\docs\PLAN_2_ARCHITECTURE_AUDIT.md (detaylı mimari audit)*
*Plan 1: D:\POLYFLOW\docs\DEVELOPMENT_ROADMAP.md (orijinal faz planı, tarihi referans)*
