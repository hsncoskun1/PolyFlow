# POLYFLOW — Plan 2: Mimari Denetim & Kaynak Değerlendirmesi
**Tarih:** 2026-03-31
**Kaynaklar:** ChatGPT Talimat + Öneri 1 (güncellenmiş) + Öneri 2
**Durum:** Aktif referans — tüm geliştirme kararları bu belgeye göre alınır

---

## BÖLÜM 1 — MEVCUT DURUM VERDİKTİ

### Proje Kategorisi
**Advanced Prototype / Demo Dashboard**
- Market scanner + görselleştirme aracı
- Kurallar değerlendiriliyor, hiçbir order açılmıyor
- Live trading için **hazır değil**
- Paper trading altyapısı **mevcut değil**
- Müşteriye sunulabilir ürün için kritik eksikler var

### Mevcut Sistem Ne Yapıyor?
```
✅ Market discovery (scan_slug_based, discovery_scan)
✅ Live price feed — CLOB WS + RTDS WS (backend + frontend)
✅ Rule evaluation (6 kural: time, price, btc_move, slippage, event_limit, max_positions)
✅ Per-event settings (modal, DB'de kayıt)
✅ Multi-asset, multi-timeframe dashboard
✅ PTB fetch (__NEXT_DATA__ scraping + Gamma fallback)
✅ BTC delta hesabı (live_price - PTB)
❌ Order execution (paper veya live)
❌ Position tracker
❌ TP/SL/Force sell exit loop
❌ Risk engine
❌ HMAC signing / py-clob-client
❌ Auto-claim
```

---

## BÖLÜM 2 — MİMARİ DEĞERLENDİRME (3 Kaynak Analizi)

### 2.1 ChatGPT Talimat.txt — Audit Prompt

**Değerlendirme:** %95 doğru, %90 uygulanabilir.

Bu talimat profesyonel bir trading platform audit'i için doğru soruları soruyor:
- "God file tespiti" → `main.py` (~1400 satır), `app.js` (~1600 satır) god file
- "Tightly coupled modules" → market data + strategy + broadcast hepsi `main.py`'de
- "Safe for simulation only" → şu an demo/simulation bile değil, sadece scanner
- "Race conditions, stale state" → async global dict'ler lock'suz

**Performans hakkında (talimatın son bölümü):**
ChatGPT doğru söylüyor: **mimariyi düzeltmek = hız düşmez.**
Şu an hem frontend hem backend Polymarket WS'e bağlanıyor (çift kaynak).
Doğru yapı: backend tek otorite → frontend hafif render.
Bu ayrım yapıldığında hız korunur, tutarsız state azalır.

**Talimatın 5 Temel Kuralı (bizim için geçerli):**
```
live market state     = memory/cache (Redis değil, şimdilik in-memory dict yeterli)
persistent data       = database (order, fill, audit)
raw websocket owner   = backend ONLY (frontend sadece backend'den almalı)
rendering             = frontend
execution decision    = backend only
```

---

### 2.2 ChatGPT Öneri 1 — Token State / Data Model

**Değerlendirme:** %85 doğru, %70 şimdi uygulanabilir.

#### Doğru ve Uygulanan Öneriler
| Öneri | Durum |
|-------|-------|
| `best_bid`, `best_ask`, `midpoint`, `last_trade` ayrı field | ✅ Zaten var (`up_ask`, `up_bid`, `up_mid` vs.) |
| event_type bazlı ayrım (book/trade/price_change) | ✅ Eklendi (Format 3 filtresi) |
| YES/NO token ayrımı | ✅ Doğru: `tokens[0]=up`, `tokens[1]=down` |
| UI için midpoint, entry için best_ask | ✅ `up_mid` (REST) + `up_ask` (WS) ayrımı var |
| Tek `price` değişkeni kullanma | ✅ `_wsMarketPrices` cache ile çözüldü |
| anomaly_check | ⏳ Henüz eklenmedi — EKLENM ALI |
| Debug log formatı | ⏳ Geçici olarak eklenebilir |

#### Şimdilik Overkill (Gelecekte Değerlendir)
- `TokenState` dataclass + `BookLevel` + tam orderbook: Execution engine yazılırken gerekli
- `apply_snapshot`, `apply_book_delta`, `recompute_top_levels`: Tick-level market making için

#### Önerilen `anomaly_check` (backend'e eklenecek)
```python
def anomaly_check(ts_data: dict) -> list:
    issues = []
    bid = ts_data.get("up_bid", 0)
    ask = ts_data.get("up_ask", 0)
    mid = ts_data.get("up_mid", 0)
    if bid > 0 and ask > 0 and bid > ask:
        issues.append("best_bid > best_ask")
    if mid > 0 and not (0.01 <= mid <= 0.99):
        issues.append("midpoint_out_of_range")
    if bid > 0 and ask > 0 and mid > 0:
        if abs(mid - (bid + ask) / 2) > 0.10:
            issues.append(f"mid_bid_ask_gap:{abs(mid - (bid+ask)/2):.3f}")
    return issues
```

---

### 2.3 ChatGPT Öneri 2 — 8 Katmanlı Mimari

**Değerlendirme:** %90 doğru, %60 şimdi uygulanabilir.

#### 8 Katman — Mevcut Durum Matrisi

| Katman | Önerilen | Bizim Durumu | Öncelik |
|--------|----------|--------------|---------|
| Market discovery | Ayrı servis | `scan_slug_based` main.py'de | Orta — extract edilebilir |
| Market registry | Normalize, DB'ye | `_market_cache` in-memory dict | Orta — iyi çalışıyor |
| Live data ingestion | Backend tek otorite | Frontend DE direkt WS'e bağlı | **Yüksek — uzun vadede düzeltilmeli** |
| Strategy engine | Event-bazlı config | `backend/strategy/rules/` ✅ iyi | Düşük — zaten iyi |
| Risk engine | Ayrı servis, approval object | **YOK** | **Kritik — Faz 2** |
| Execution engine | Paper + Live | **YOK** | **Kritik — Faz 3** |
| Portfolio/order sync | Reconciliation | **YOK** | Kritik — Faz 3 sonrası |
| Admin/User UI | İki yüzey | Tek karışık dashboard | Orta — Faz 4-5 |

#### Teknoloji Önerileri — Uygulanabilirlik
| Öneri | Değerlendirme |
|-------|---------------|
| FastAPI | ✅ Zaten kullanıyoruz |
| asyncio | ✅ Zaten kullanıyoruz |
| SQLAlchemy + PostgreSQL | ⏳ Şimdi değil — SQLite yeterli, üretim öncesi geç |
| Redis | ⏳ Şimdi değil — in-memory dict yeterli |
| Pydantic | ✅ Config validation için eklenebilir |
| React rewrite | ❌ Gereksiz — vanilla JS + modülerleştirme yeterli |

---

## BÖLÜM 3 — KRİTİK BULGULAR

### 3.1 God File Sorunu (Acil)
```
backend/main.py (~1400 satır):
  market discovery + registry + CLOB WS + RTDS WS + REST poll
  + PTB loop + simulation_tick + broadcast_loop
  + TÜM API endpoints + WebSocket server + state yönetimi

frontend/js/app.js (~1600 satır):
  global state + CLOB WS + RTDS WS + backend WS
  + card rendering + settings modal + navigation
  + price formatting + strategy logic kopyası + token map
```

### 3.2 Çift Kaynak Sorunu (Yüksek Risk)
```
Şu an hem backend hem frontend Polymarket CLOB+RTDS'e bağlanıyor.
Backend'in kural hesabı: up_ask = 0.52 (backend WS'den)
Frontend'in gösterimi: up_ask = 0.22 (frontend WS'den, ayrı bağlantı)
→ Execution engine eklenince: YANLIŞ FİYATTAN EMİR açılabilir.
Geçici fix: _wsMarketPrices cache (yapıldı)
Kalıcı fix: frontend direkt WS bağlantısı kaldırılmalı (Faz 3 öncesi şart)
```

### 3.3 Execution Engine Yok (Blocker)
```
order_executor.py  → YOK
position_tracker.py → YOK
sell_retry.py       → YOK
bot_orchestrator.py → YOK
→ Bot "AL" kararı veriyor ama hiçbir şey yapmıyor
→ Live trading başlamadan önce bunlar yazılmalı
```

### 3.4 Race Condition Riski (Async Global Dict'ler)
```python
# main.py'deki global dict'ler lock'suz:
_market_cache: dict         # scan_slug_based + simulation_tick aynı anda yazıyor
_asset_market: dict         # clob_ws + midpoint_poll + simulation_tick yazıyor
_ptb_cache: dict            # _ptb_loop yazıyor, simulation_tick okuyor
app_state: dict             # birden fazla coroutine yazıyor

# asyncio single-threaded olduğu için şimdi güvenli,
# ancak ThreadPoolExecutor veya multiprocessing eklenirse tehlikeli.
```

---

## BÖLÜM 4 — REFACTOR PLANI (Aşamalı)

### Faz A — God File'ı Böl (Önce Bu, Kod Eklemeden)
**Hedef:** `main.py` 400 satırın altına in
**Yöntem:** Extract-then-import (davranış değişmez, test edilir)

```
backend/
├── market_data/
│   ├── __init__.py
│   ├── discovery.py       ← scan_slug_based, discovery_scan, _calc_candidate_slugs
│   ├── registry.py        ← _market_cache, COIN_REGISTRY, SLUG_PREFIX, token_to_key
│   ├── clob_feed.py       ← clob_ws_connect, _update_token, _clob_prices
│   └── rtds_feed.py       ← _rtds_coin_loop, start_rtds, get_live_price, _rtds_prices
├── ptb/
│   └── manager.py         ← _ptb_loop, _fetch_ptb_next_data, _fetch_ptb_gamma, get_ptb
├── engine/
│   ├── tick.py            ← simulation_tick
│   └── broadcast.py       ← broadcast_loop, broadcast_state, _build_broadcast_payload
└── main.py                ← sadece FastAPI init + lifespan + API endpoints (~400 satır)
```

**Test protokolü her extract için:**
1. Fonksiyon yeni dosyaya taşınır
2. `main.py`'den `from backend.market_data.discovery import scan_slug_based` ile import edilir
3. Sunucu başlatılır, tüm eventler görünür → onaylanır
4. Eski kod silinir

### Faz B — Execution Engine (Live Trading)
**Hedef:** Gerçek HMAC imzalı order açma/kapama
**Önemli:** Entry + Exit AYNI fazda deploy edilmeli

```
backend/
├── execution/
│   ├── order_executor.py  ← FOK order + py-clob-client + HMAC (referans bottan)
│   ├── position_tracker.py ← DB + in-memory, UUID-based (referans bottan)
│   └── sell_retry.py      ← 50ms TP/SL/Force exit loop (referans bottan)
└── engine/
    └── orchestrator.py    ← 500ms entry trigger, event lock, max_open_positions
```

**Referans:** `D:\polymarketminiclaude_NEWDASHBOARD\backend\`

### Faz C — Risk Engine
```
backend/
└── risk/
    └── engine.py          ← 6 kontrol: safe_mode, blacklist, event_trade_limit,
                              max_total_trades, duplicate, exit_only
                              → returns {"approved": bool, "reasons": []}
```

### Faz D — Frontend Temizliği
- Frontend direkt CLOB/RTDS WS kaldırılır (backend tek otorite)
- `app.js` → `ui/`, `ws/`, `state/`, `components/` modüllerine bölünür
- Admin panel ayrı yüzey

### Faz E — Üretim Hazırlığı
- SQLite → PostgreSQL
- in-memory cache → Redis
- Auto-claim (relayer.py)
- Reconciliation loop
- Kill switch kalıcı DB kaydı

---

## BÖLÜM 5 — HEDEF MİMARİ

```
┌─────────────────────────────────────────────────────────────┐
│                         POLYFLOW                            │
├──────────────────────┬──────────────────────────────────────┤
│   BACKEND (Python)   │         FRONTEND (Vanilla JS)        │
│                      │                                      │
│  FastAPI + asyncio   │  ┌─────────────┬──────────────────┐  │
│                      │  │  User Panel  │  Admin Panel     │  │
│  market_data/        │  │  (trading)   │  (config/debug)  │  │
│  ├─ discovery        │  └─────────────┴──────────────────┘  │
│  ├─ registry         │          ▲                           │
│  ├─ clob_feed ───────┼──────────┘  WebSocket (backend only) │
│  └─ rtds_feed        │                                      │
│                      │                                      │
│  strategy/           │                                      │
│  └─ rules/ ✅        │                                      │
│                      │                                      │
│  risk/               │                                      │
│  └─ engine           │                                      │
│                      │                                      │
│  execution/          │                                      │
│  ├─ order_executor   │                                      │
│  ├─ position_tracker │                                      │
│  └─ sell_retry       │                                      │
│                      │                                      │
│  storage/ ✅         │                                      │
│  └─ db.py            │                                      │
└──────────────────────┴──────────────────────────────────────┘
         │                           │
         ▼                           ▼
   Polymarket CLOB API         Polymarket UI
   (WS + REST)                 (event links)
```

---

## BÖLÜM 6 — UYGULAMA SIRASI (Öncelikli)

### Hemen Yapılabilir (Mevcut Kod Üstünde)
1. **anomaly_check** — backend'e ekle (30 dakika)
2. **main.py extract** — Faz A refactor (2-3 gün, test ederek)
3. **Live execution engine** — Faz B (referans bottan alınan 3 dosya)

### Paper Modu Hakkında Karar
Kullanıcı paper modu istemediğini belirtti. Gerçek durum:
- Şu an ne paper ne live çalışıyor (sadece scanner)
- Paper vs live farkı sadece `order_executor.py`'nin son 20 satırı
- **Öneri:** Execution engine'i direkt live için yaz, ama `$1 test amount` ile ilk testi yap
- Entry + exit AYNI anda deploy et (exit yokken entry açılırsa USDC kilitlenir)

### Live Trading İçin Minimum Gereksinimler
```
□ order_executor.py (py-clob-client + HMAC)
□ position_tracker.py (DB + in-memory)
□ sell_retry.py (TP/SL + force sell)
□ bot_orchestrator.py (entry trigger + event lock)
□ risk/engine.py (safe_mode + duplicate guard)
□ Frontend direkt WS kaldır (backend tek otorite)
□ Wallet konfigürasyonu (private key, API creds)
□ İlk test: $1 ile 1 trade
```

---

## BÖLÜM 7 — TEST VE DOĞRULAMA GEREKSİNİMLERİ

Her implementasyon adımı için:

| Adım | Test Edilecek | Doğrulama Yöntemi | Regresyon Kontrolü |
|------|---------------|-------------------|-------------------|
| Faz A: Her extract | Sunucu başlar, eventler görünür | Dashboard 30sn izle | Önceki commit ile karşılaştır |
| Execution engine | Kural pass → order açılır | Terminal log + DB kaydı | |
| Position tracker | Position DB'ye yazılır, kapanır | DB sorgula | |
| Sell retry | TP/SL tetiklenir | Fiyatı manuel simüle et | |
| Risk engine | safe_mode bloklar, duplicate bloklar | API test | |
| Live $1 test | Gerçek fill gelir, kapanır | User WS fill event | |

---

## BÖLÜM 8 — ÖNEMLİ HATIRLATMALAR

1. **Her faz öncesi GitHub backup commit**
2. **Extract yöntemi:** taşı → import et → test et → eski kodu sil
3. **Live trading öncesi:** wallet config + private key aktif + $1 test
4. **Entry + Exit aynı anda:** hiçbir zaman entry açık exit kapalı deploy etme
5. **Frontend direkt WS:** live trading öncesi mutlaka kaldırılmalı
6. **SQLite → PostgreSQL:** acele değil, $100+ volume geçince düşün

---

*Bu belge D:\POLYFLOW\docs\PLAN_2_ARCHITECTURE_AUDIT.md olarak kaydedilmiştir.*
*Plan 1: D:\POLYFLOW\docs\DEVELOPMENT_ROADMAP.md (Faz 1-6 detay planı)*
