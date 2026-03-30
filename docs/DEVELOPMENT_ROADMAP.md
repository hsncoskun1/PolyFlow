# POLYFLOW — Tam Geliştirme Yol Haritası
**Referans Kaynak:** `D:\polymarketminiclaude_NEWDASHBOARD` (üretim versiyonu, 6.182 satır)

---

## Mevcut Durum Özeti

### PolyFlow şu an ne yapıyor?
Bir **market scanner + görselleştirme** aracı. Kurallar evaluate ediyor, WebSocket ile frontend'e gönderiyor. **Hiçbir order açmıyor, kapamıyor.**

### Referans bot ne yapıyor?
BTC 5m eventlerinde tam otomatik trade: entry karar → FOK order → 50ms exit loop → force sell → auto-claim.

### Kritik Fark
| Bileşen | PolyFlow | Referans Bot |
|---------|----------|--------------|
| `order_executor.py` | ❌ Yok | ✅ FOK market + HMAC imzalı |
| `position_tracker.py` | ❌ Yok (demo inject) | ✅ DB + in-memory, UUID-based |
| `sell_retry.py` | ❌ Yok | ✅ TP/SL/Force/Retry 50ms döngü |
| `bot_orchestrator.py` | ❌ Yok | ✅ 50ms ana döngü koordinatörü |
| Entry trigger | ❌ Yok | ✅ 500ms'de kural → execute |
| HMAC signing | ❌ Yok | ✅ py-clob-client içinde |
| Auto-claim | ❌ Yok | ✅ Relayer v2 |
| Orderbook anomaly | ❌ Yok | ✅ >30% tek tick düşüş → ignore |
| % tabanlı mod | ❌ Yok | ✅ entry × (1 ± pct%) |

---

## KRİTİK RİSKLER

| Risk | Etki | Önlem |
|------|------|-------|
| Exit yokken entry açılırsa | Pozisyon sonsuza açık kalır, USDC kilitlenir | Entry + exit AYNI fazda deploy edilmeli |
| HMAC signing yanlış implement edilirse | Tüm live order'lar reddedilir | Referanstan birebir `py-clob-client` kullanımı kopyalanacak |
| Event lock olmadan çift entry | Aynı event'e 2x girilir | Referanstaki in-memory + DB dual lock pattern alınacak |
| `sell_retry` yokken force sell deadline geçerse | Token değersizleşir, USDC geri alınamaz | sell_retry.py paper'da da çalışacak |
| Multi-asset da aynı event'e çakışma | BTC_5M'in birden fazla kural geçmesi | `event_trade_limit` per-key zorunlu |
| Safe mode kalıcı değilse | Restart sonrası bot hemen trade açar | `bot_state` DB tablosu zorunlu |
| % mod yokken yanlış TP/SL | Fixed price event bazında çalışmaz | `PERCENT` ve `NUMERIC` mod paralel desteklenmeli |

---

## FAZ PLANI — Kullanıcı Deneyimi Sırasıyla

---

### FAZ 1 — Bot Gerçekten Çalışsın (Paper Mode)
**Kullanıcı ne hisseder:** *"Bot başlat'a bastım, dakika geçmeden ilk paper position açıldı, TP'ye geldi kapandı, trade history'de gördüm."*

**Referans dosyalar:** `bot_orchestrator.py`, `order_executor.py` (paper kısmı), `position_tracker.py`, `sell_retry.py`

#### 1.1 Entry Trigger (`main.py` → `simulation_tick`)
- Tüm 6 kural pass + event settings konfigüre + bot running → `_try_open_position(key, sym, mp, rules, st)`
- **Race guard:** in-memory set `_open_events: set` — event key entry öncesi eklenir
- Referans pattern (bot_orchestrator.py):
  ```python
  if final_decision == "READY" and not key in _open_events:
      _open_events.add(key)
      asyncio.create_task(_execute_paper_entry(key, side, entry_price))
  ```
- Position ID: `f"{key}_{int(time.time())}_{side}"` (referans format)
- Entry price: UP ask price'dan al
- Amount: `st.order_amount` (USD modu)

#### 1.2 Position Tracker (`position_tracker.py` yeni dosya → `backend/`)
- DB'ye yaz + `app_state["positions"]` güncelle
- Status: `OPEN | CLOSED | STOP_LOSS | FORCE_SELL | HOLD_TO_RESOLUTION | RETRY`
- PnL hesap: `shares = amount / entry; pnl = shares × mark - amount`
- `get_active_count()` → max_open_positions kontrolü için

#### 1.3 Exit Loop (`sell_retry.py` yeni dosya → `backend/`)
**50ms döngü** — referanstan alınan smart force sell logic:
- **TP:** `up_ask >= target_exit_price` → kapat ("TP")
- **SL:** `up_ask <= stop_loss_price` AND `stop_loss_enabled` → kapat ("SL")
- **Force sell (SMART):**
  - `countdown <= force_sell_seconds` ve **karda** ve **TP geçtiyse** → `HOLD_TO_RESOLUTION`
  - `countdown <= force_sell_seconds` ve **zararda** → hemen kapat ("FORCE_SELL")
- **Orderbook anomaly:** Tek tick'te >30% düşüş → önceki mark kullan, SL tetikleme
- **Stale event:** Pozisyon event_key ile aktif event uyuşmuyorsa → kapat
- Retry: `sell_retry_count` tükenirse → `HOLD_TO_RESOLUTION`
- Lifespan'a ekle: `tasks.append(asyncio.create_task(exit_loop()))`

#### 1.4 % Tabanlı Strateji Modu (Referanstan)
- `exit_mode: "PERCENT" | "NUMERIC"` — per-event settings'e ekle
- PERCENT: `target = entry × (1 + target_exit_pct/100)`, `sl = entry × (1 - stop_loss_pct/100)`
- NUMERIC: mevcut `target_exit_price`, `stop_loss_price`
- Per-event settings modal'a 2 yeni alan: `target_exit_pct`, `stop_loss_pct`

#### 1.5 Positions Sayfası Gerçek Veri
- Canlı P&L update (WebSocket ile 50ms geliyor)
- Exit reason badge: TP / SL / FORCE / HOLD
- `close_reason` sütunu DB'de zaten var

**Test:** Bot başlatılınca event ayarı olan kart için 60sn içinde paper position açılmalı. TP/SL manuel test edilmeli.

---

### FAZ 2 — Kontrol ve Güvenlik
**Kullanıcı ne hisseder:** *"Bir şeyler ters giderse bot kendini durduruyor ve ben paniklemiyor."*

#### 2.1 Safe Mode Kalıcılığı
- DB'ye `bot_state` tablosu: `safe_mode`, `exit_only`, `paused`, `started_at`, `session_start_balance`
- Restart'ta yükle → safe_mode=True ise bot auto-start etmesin
- Endpoint: `POST /api/bot/emergency-stop` → DB'ye yaz + broadcast

#### 2.2 Risk Kontrolleri (Referanstan — execute_entry öncesi 6 kontrol)
1. `safe_mode` aktif → blok
2. Event blacklist'te → blok
3. Aynı event'te `event_trade_limit` dolmuşsa → blok
4. `max_total_trades` aşıldıysa → blok (0 = sınırsız)
5. Duplicate position (key+side aynı) → blok
6. `exit_only` mod → blok (sadece kapatma)

#### 2.3 Session Balance ve PnL
- Bot başladığında PAPER mod için başlangıç "bakiye" sabitle
- Session P&L = kapanan tüm trade'lerin toplamı
- Sidebar'da `Session PnL: +$X.XX` göster

#### 2.4 Emergency Stop UI
- Sidebar'a kırmızı büyük "ACİL DURDUR" butonu
- Tüm açık pozisyonları FORCE_SELL yapar, safe_mode=True kaydeder

---

### FAZ 3 — Live Trading Altyapısı
**Kullanıcı ne hisseder:** *"LIVE moda geçtim, gerçek para ile ilk order açıldı."*

**⚠️ Bu faz kullanıcı ayrıca onayladıktan sonra başlamalı.**

#### 3.1 `order_executor.py` (Yeni dosya)
Referans `order_executor.py`'den alınan yapı:
```python
# Paper:
async def execute_paper_entry(key, side, entry_price, amount) → PositionState

# Live:
async def execute_live_entry(key, side, token_id, amount) → PositionState
  └─ MarketOrderArgs(token_id, amount, side=BUY)
  └─ client.create_market_order() → client.post_order(OrderType.FOK)
  └─ HTTP 425 retry: 5sn × 18 deneme (max 90sn)
  └─ Fill price parse: _parse_fill_price(resp)
```
HMAC: `py-clob-client` içinde hallediyor — manuel signing gerekmez.

#### 3.2 Live Balance (CLOB API)
- `GET /clob-api.polymarket.com/balance-allowance` — L1 auth header
- `app_state["balance"]` gerçek değer → sidebar'da göster
- Bot başladığında fetch, her 60sn'de refresh

#### 3.3 User Order WebSocket
- `clob_user_ws.py` → fill confirmation izleme
- Entry actual price güncelle (slippage gerçeği)
- On-chain tx hash logla

#### 3.4 Paper/Live Ayrımı
- Mode switch sadece 0 açık pozisyon varken
- LIVE seçilince wallet configured + private key aktif kontrolü
- Frontend → mode badge: kırmızı "LIVE" / gri "PAPER"

---

### FAZ 4 — Auto-Claim ve Relayer
**Kullanıcı ne hisseder:** *"Kazanan pozisyonlarım otomatik USDC'ye çevrildi."*

#### 4.1 HOLD_TO_RESOLUTION Takibi
- Event resolved olduğunda (countdown = 0) → condition_id ile claim dene
- DB'de `condition_id` sütunu ekle (trade kayıt edilirken saklansın)

#### 4.2 Relayer Integration
- `relayer.py` referanstan alınacak
- `auto_claim_hold_positions()` → her 5sn çalışır
- `auto_claim` ayarı per-global (event settings'e gerek yok)

---

### FAZ 5 — Gelişmiş Analiz ve UX
**Kullanıcı ne hisseder:** *"Dashboard bana her şeyi söylüyor, karar günlüğünü okuyorum."*

#### 5.1 Audit Trail (Decision Log)
- `decision_log.py` → her entry/skip/exit kararını sebepli logla
- DB'ye `audit_log` tablosu: `event_key, decision, reason, rules_snapshot, timestamp`
- Endpoint: `GET /api/audit?key=BTC_5M&limit=50`
- Frontend → Logs sayfasında "Karar Günlüğü" sekmesi

#### 5.2 Performance Analytics
- Win rate, avg P&L, best/worst trade, daily breakdown
- `GET /api/stats/performance`
- Frontend → Positions/History sayfasında istatistik kartları

#### 5.3 Liquidity ve Cooldown Kuralları (Referanstan)
- `backend/strategy/rules/cooldown_rule.py` → son 60sn'de aynı market'e girdiyse blok
- `backend/strategy/rules/liquidity_rule.py` → orderbook depth ≥ $100

#### 5.4 Strateji Profilleri
- `last_minute_high_prob` / `conservative_safe` gibi preset'ler
- Per-event settings'e "Profil Uygula" butonu

---

### FAZ 6 — Hız ve Optimizasyon
**Kullanıcı ne hisseder:** *"Gecikme yok, her şey anlık."*

#### 6.1 PTB Hızlı Fetch
- Yeni event açıldığında anında fetch (slug değişince cache sıfırla)
- Gamma API fallback + `__NEXT_DATA__` scrape (referans pattern)

#### 6.2 Dashboard Görsel Düzenlemeler
- Kart overflow sorunu: CSS `overflow: hidden` + tooltip
- Tüm kural pass → kart border yeşil
- Canlı P&L on-card (zaten var, test edilecek)

---

## UYGULAMA KURALLARI

1. Her faz öncesi GitHub backup commit
2. Her faz sonrası `VERSIONS.md` güncelle
3. Test agent → `docs/TEST_REPORTS/` klasörüne rapor
4. Kullanıcı onayı olmadan sonraki faza geçme
5. Faz 3 (LIVE) için ayrı onay zorunlu — test amount $1

---

## ETKİLENECEK DOSYALAR

| Faz | Yeni | Değiştirilecek |
|-----|------|----------------|
| 1 | `backend/position_tracker.py`, `backend/sell_retry.py` | `backend/main.py`, `backend/storage/db.py`, `frontend/js/app.js` |
| 2 | — | `backend/main.py`, `backend/storage/db.py`, `frontend/js/app.js` |
| 3 | `backend/order_executor.py` | `backend/main.py`, `backend/config.py` |
| 4 | `backend/relayer.py` | `backend/main.py`, `backend/storage/db.py` |
| 5 | `backend/strategy/rules/cooldown_rule.py`, `backend/strategy/rules/liquidity_rule.py` | `backend/storage/db.py`, `frontend/js/app.js` |
| 6 | — | `backend/main.py`, `frontend/js/app.js`, `frontend/css/polyflow.css` |

---

## SONUÇ: İLK ADIM

**Faz 1.1** ile başla: `_try_open_position()` fonksiyonu → paper entry → DB kayıt.
Referans: `D:\polymarketminiclaude_NEWDASHBOARD\backend\order_executor.py` (paper kısmı) + `position_tracker.py`

Bu yol haritası `D:/POLYFLOW/docs/DEVELOPMENT_ROADMAP.md` olarak kaydedilecek ve GitHub'a push edilecek.
