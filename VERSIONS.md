# POLYFLOW - Version History

---

## v2.4.0 — 2026-03-31

### Modülerleştirme — Refactor Faz 3 (Scan + WS + Positions)

**Backend:**
- `backend/market/registry.py` (69 satır): `COIN_REGISTRY`, `ASSETS`, `_save_discovered`, `_load_discovered` — main.py'den ayrıştırıldı
- `backend/market/scan.py` (596 satır): Tüm Gamma scan/discovery sistemi — `_market_cache`, `TF_SECONDS`, `_discovered_timeframes`, `get_active_timeframes`, `scan_slug_based`, `discovery_scan`, `scan_gamma_markets`, `refresh_cached_slugs`, `gamma_scan_loop`
- **Circular import çözümü:** `inject_scan_deps(asset_market, asset_phases, asset_phase_ticks, on_new_event, on_rate_limit)` — lifespan'da bir kez çağrılır
- **Rebinding sorunu çözümü:** `get_market_cache()` / `get_market_cache_ts()` getter'ları — `_market_cache = new_dict` reassignment lambda'ları bozmaz
- main.py: 1651 → 1091 satır (**−560**)

**Frontend:**
- `frontend/js/ws.js` (549 satır): Debug direkt feed (CLOB/RTDS), `connectWS`, `wsSend`, `_mergeState`, `handleStateUpdate` — app.js'den ayrıştırıldı
- `frontend/js/positions.js` (79 satır): `updatePositionsPage`, `updateHistoryPage` — app.js'den ayrıştırıldı
- app.js: 1752 → 1141 satır (**−611**)
- Script yükleme sırası: `utils.js` → `settings-modal.js` → `cards.js` → `ws.js` → `positions.js` → `app.js`
- Test: API ✓ syntax ✓ GitHub push ✓

---

## v2.3.0 — 2026-03-31

### Modülerleştirme — Refactor Faz 2b (Cards Extract) + Settings İyileştirme

**Frontend cards.js Extract**
- `frontend/js/cards.js` oluşturuldu (686 satır) — kart render fonksiyonları app.js'den ayrıştırıldı
  - Taşınan fonksiyonlar: `updateCardsInPlace`, `playGoAlert`, `showGoBanner`, `buildAssetChips`, `_makePriceFreshnessBadge`, `renderEventCard`, `renderEventBody`
  - Taşınan state: `_prevPrices`, `_goAlerted` (yalnızca cards fonksiyonları tarafından kullanılıyor)
  - `_prevCardVals` app.js'te kaldı (`_mergeState` da kullanıyor)
  - app.js satır sayısı: 2436 → 1752 (-684 satır)
- `index.html` script sırası: `utils.js` → `settings-modal.js` → `cards.js` → `app.js`
- Test: API ✓ syntax ✓

**Settings Modal — Alan İsimleri ve Sırası**
- `time_rule_threshold` etiketi: "Zaman Kuralı" → "Max Kalan Süre"
- Modal sırası: `min_entry_seconds` (Min Kalan) önce, `time_rule_threshold` (Max Kalan) sonra
- Mantıksal sıra: "en az X sn kalsın" → "en fazla X sn kaldığında giriş yap"

---

## v2.2.0 — 2026-03-31

### Modülerleştirme — Refactor Faz 2 (API Routes)

**Backend API Router Extract**
- `backend/api/__init__.py` + `backend/api/routes.py` oluşturuldu — FastAPI APIRouter ile 23 temiz route ayrıştırıldı
- Taşınan route'lar: `/api/status`, `/api/settings`, `/api/settings/{key}` (CRUD), `/api/settings-all`, `/api/bot/start`, `/api/bot/stop`, `/api/bot/safe-mode/disable`, `/api/assets`, `/api/assets/{sym}/pin`, `/api/positions`, `/api/positions/history`, `/api/positions/{pos_id}/close`, `/api/trades`, `/api/stats/daily`, `/api/audit`, `/api/logs`, `/api/wallet`, `/api/wallet/save`, `/api/test/market`, `/api/test/prices`
- `EVENT_SETTINGS_FIELDS` whitelist routes.py'ye taşındı
- main.py'de kalan 9 kompleks route: `emergency-stop`, `markets/matched`, `coins`, `timeframes`, `coins/{sym}/add+remove`, `debug/inject`, `verify` (module-level state bağımlı)
- main.py satır sayısı: 1945 → 1651 (-294 satır)
- Test: `/api/status` ✓ `/api/logs` ✓ `/api/settings` ✓ `/api/wallet` ✓

---

## v2.1.0 — 2026-03-31

### Modülerleştirme — Refactor Faz 1

**Backend Extract**
- `backend/state.py` oluşturuldu — `app_state`, `addlog`, `_log_buffer`, `DEFAULT_PINNED` merkezi depoda toplandı (circular import yok)
- `backend/market/__init__.py` + `backend/market/ptb.py` oluşturuldu — PTB yöneticisi (170 satır) main.py'den ayrıştırıldı
  - `RTDS_SYMBOLS`, `PTB_VARIANT`, `get_ptb`, `ptb_loop` (lambda `get_market_cache` parametresi ile)
  - main.py satır sayısı: 2100 → 1945 (-155 satır)

**Frontend Extract**
- `frontend/js/utils.js` oluşturuldu — saf yardımcı fonksiyonlar (baseSym, keyTF, fmtCD, formatUSD, formatAssetPrice, setText, numVal, checkVal, showToast) app.js'den ayrıştırıldı
- `frontend/js/settings-modal.js` oluşturuldu — event strateji modal tüm kod (EVENT_SETTING_FIELDS, AS_SECTIONS, AS_LAYOUT, _pctFields, openAssetSettings, onEventSettingInput, showConfirmPopup, saveEventSettings, clearEventSettings) app.js'den ayrıştırıldı
  - app.js satır sayısı: 2865 → 2437 (-428 satır)
- `frontend/index.html` güncellendi — yeni script tag'ler eklendi (utils.js → settings-modal.js → app.js)

**Test**: Backend restart ✓, /api/status 200 ✓, utils.js 200 ✓, settings-modal.js 200 ✓

---

## v2.0.0 — 2026-03-31

### Faz 7–8: Auto-Claim + Final Kapı Kontrolleri

**Faz 7 — Auto-Claim / Relayer**
- `backend/execution/relayer.py` oluşturuldu — Polymarket Relayer v2 gasless CTF token redemption
- `auto_claim_loop`: Her 5sn HOLD_TO_RESOLUTION pozisyonları tarar, event bitince redeem eder (sadece LIVE modda)
- EIP-712 Safe transaction inşa + imza, `_poll_tx_state` onay bekleme
- Başarılı claim → pozisyon CLOSED, PnL hesapla, session_pnl güncelle
- Lifespan'a entegre — `_EXEC_AVAILABLE` aktifse arka planda çalışır

**Faz 8 — Final Kapı Kontrolleri**
- `bot_running: False` default — restart sonrası bot otomatik başlamıyor
- `auto_start: True` ise lifespan'da otomatik başlama (ayarlanabilir)
- `max_total_trades` uygulandı — entry trigger'da `sum(_event_trade_counts.values())` kontrolü
- Tüm Faz 8 kontrolleri geçti: bot_running / safe_mode / mode / positions / connections ✓

---

## v1.9.0 — 2026-03-31

### Faz 5–6: Bug Düzeltmeleri + PERCENT Mod

**Bug Düzeltmeleri**
- **CLOSED pozisyon in-memory bug:** `to_app_state_positions()` CLOSED pozisyonları artık frontend listesinden filtreler. Önceden FORCE_SELL/SL sonrası pozisyon bellekte kalıyor, `event_limit` ve `max_positions` kurallarını bloke ediyordu.
- **app.js syntax hatası:** `ptbEl` duplicate `const` bildirimi (L1095) giderildi — tüm JS fonksiyonları artık yükleniyor.
- **strategy_mode wiring:** Modal üzerinden kayıt her zaman `strategy_mode: 'PERCENT'` gönderiyor; backend whitelist'e eklendi.

**Faz 5 — Test & Doğrulama**
- PTB değeri event bazında doğrulandı (`btc_delta = live_price - PTB`)
- UP/DOWN semantiği: delta pozitifken UP yüksek, DOWN düşük ✓
- Time rule semantiği: `min_entry_seconds < countdown ≤ time_rule_threshold` → "pass" ✓
- PERCENT mod: `entry × (1 ± pct%) `, clamp 0.99 / floor 0.01 ✓
- Wired UI: modal → `strategy_mode: PERCENT` backend'e ulaşıyor ✓

**Faz 6 — NUMERIC Mod Kaldırıldı**
- `_calc_targets()` NUMERIC branch silindi — her zaman % hesaplama
- `config.py`: global default `target_exit_pct: 20%`, `stop_loss_pct: 15%`
- `EVENT_SETTINGS_FIELDS`: `target_exit_price`/`stop_loss_price` whitelist'ten çıkarıldı
- `settings.json`: eski NUMERIC alanlar temizlendi

---

## v1.8.0 — 2026-03-31

### Event Settings Modal — UI/UX Optimizasyonu
- **Çiftli satır layout:** İlişkili alanlar aynı satırda (2-sütun grid)
  - Min/Max Giriş → aynı satır
  - Zaman Kuralı / Min Kalan Süre → aynı satır
  - Fiyat Hareketi / Max Spread → aynı satır
  - Hedef Çıkış / Stop Loss → aynı satır
  - Event Limit / Toplam Max Açık → aynı satır
- **Gelişmiş blok:** Force Sell ve Satış Deneme sarı çerçeveli "⚙ Gelişmiş" bölümüne izole edildi
- **Tahmini PnL Önizlemesi:** Ayarlar girilirken anlık kâr/zarar tahmini (yeşil kutu)
  - Referans giriş, tahmini hisse, TP kâr, SL zarar dinamik güncelleniyor
  - "Gerçek fill/slippage farklı olabilir" uyarısı eklendi
- **CSS:** `.as-row-pair`, `.as-section-adv`, `.as-pnl-preview`, `.as-pnl-row` sınıfları eklendi
- **Backward compat:** AS_SECTIONS (confirm popup) dokunulmadı, field ID'leri değişmedi

### Raporlar
- `docs/UI_AUDIT_PHASE5.md` oluşturuldu — mimari hüküm, backend/frontend analizi, UI audit
- Smoke Run #2 sonucu belgelendi (FORCE_SELL, PnL=-$0.0667, math ✓)
- CLOSED pozisyon bellekte kalma bug'ı tespit edildi (event_limit/max_positions false fail)

---

## v1.0.0 — 2026-03-29 (İlk Sürüm)

### Yeni Özellikler
- **Proje kurulumu:** D:/POLYFLOW/ klasör yapısı oluşturuldu
- **Backend:** FastAPI + asyncio sunucusu, port 8002
- **WebSocket:** 300ms aralıkla state broadcast; ping/pong sağlık kontrolü
- **Demo Simülasyon:** Gerçekçi BTC fiyat dalgası (sinüs + random yürüyüş), her saniye tick
- **Aktif Event:** Her 5 dakikada otomatik yeni event oluşturma + 2 upcoming event
- **Geri Sayım:** 300sn'den geriye sayan, kural motoru ile entegre
- **Strateji Motoru:** 6 kural (Time, Price, BTC Move, Slippage, Event Limit, Max Pos)
- **Pozisyon Simülasyonu:** Entry/Exit/Stop-Loss/Force-Sell otomatik döngüsü (PAPER)
- **Trade Geçmişi:** 12 rastgele başlangıç trade'i (win/loss karışık)
- **Polymarket Tasarımı:**
  - Koyu tema (#0d0d0f arka plan, #7b61ff mor, #00d26a yeşil, #ff4d6a kırmızı)
  - Inter + JetBrains Mono fontları
  - Animasyonlu toggle switch, pipeline adımları, event kartları
  - Geri sayım progress bar (renk: mor → sarı → kırmızı)
  - Flash animasyonu (BTC fiyat değişiminde yeşil/kırmızı)
  - Toast bildirimleri, pozisyon ilerleme çubuğu

### Sekmeler (8 adet)
| Sekme | İçerik |
|-------|--------|
| Dashboard | BTC fiyat, P&L, Win Rate, Balance, Aktif Event, Countdown, Pipeline, Market Prices, Open Positions |
| Events | 3 event kartı (1 LIVE + 2 upcoming), tab filtresi |
| Positions | Tablo, Close butonu, status badge |
| Trade History | 12 trade, Wins/Losses filtresi, özet bar |
| Strategy Rules | Entry + Exit kuralları formu, Force Sell / Auto Claim toggle |
| Settings | Mode, BTC Source, Port, Auto-start; Connection Status; System Info (uptime, WS clients) |
| Wallet | Şifreli form (güvenlik: tüm key'ler DISABLED_) |
| Logs | Renkli activity log (INFO/SUCCESS/WARN/ERROR), Clear butonu |

### Güvenlik
- `.env` dosyasındaki tüm Polymarket key'leri `DISABLED_` prefix ile devre dışı
- Bot gerçek API çağrısı yapamaz (sadece PAPER simülasyonu aktif)

### Teknik Yapı
```
POLYFLOW/
├── backend/
│   ├── main.py          — FastAPI + simülasyon döngüsü (~220 satır)
│   └── config.py        — Ayar yönetimi (.env + settings.json)
├── frontend/
│   ├── index.html       — 8 sayfalı SPA
│   ├── css/polyflow.css — Polymarket temalı CSS sistemi (~870 satır)
│   └── js/app.js        — Dashboard mantığı (~620 satır)
├── .env                 — Key'ler DISABLED (güvenli)
├── settings.json        — Strateji ayarları
└── VERSIONS.md          — Bu dosya
```

---

## OTBA Raporu v1.0.0

### Bağlı ve Çalışan Elementler ✅
| Element | Endpoint / Fonksiyon | Durum |
|---------|---------------------|-------|
| Bot Start/Stop butonu | `POST /api/bot/start` + `/stop` | ✅ |
| PAPER/LIVE toggle | `POST /api/settings {mode}` | ✅ |
| Strategy Rules formu → Save | `POST /api/settings` (tüm alanlar) | ✅ |
| Settings formu → Save | `POST /api/settings` | ✅ |
| Close Position | `POST /api/positions/{id}/close` | ✅ |
| WS state broadcast (300ms) | `/ws` → `broadcast_loop()` | ✅ |
| BTC fiyat simülasyonu | `simulation_tick()` her 1sn | ✅ |
| Countdown geri sayım | `app_state.countdown` → JS `updateCountdown()` | ✅ |
| Pipeline kurallar rengi | `app_state.rules` → `updatePipeline()` | ✅ |
| Uptime sayacı | `startUptimeCounter()` (JS) | ✅ |
| Toast bildirimleri | `showToast()` | ✅ |
| Log sistemi | `addLog()` + `/api/logs` | ✅ |
| BTC flash animasyon | `flashEl()` fiyat değişiminde | ✅ |
| Win rate hesaplama | JS `updateStats()` | ✅ |
| Sidebar P&L rengi | pozitif=yeşil, negatif=kırmızı | ✅ |
| History özet bar | `history-summary` → `updateHistoryPage()` | ✅ |
| Slippage gösterge rengi | yeşil < %2, sarı < %3, kırmızı ≥ %3 | ✅ |

### Bağlı Olmayan Elementler ⚠️ (v1.1 planı)
| Element | Mevcut Durum | Plan |
|---------|-------------|------|
| UP/DOWN tıklama (aktif event) | Sadece log yazıyor | v1.1: Manuel trade modal |
| Wallet Save butonu | Demo uyarısı, backend bağlantısı yok | v1.1: .env yazma endpoint |
| Events → Resolved tab | Filter logic eksik | v1.1 |
| History → CSV/Export | Yok | v1.2 |
| Claim/Redeem sayfası | Yok | v1.2 |
| Gerçek Polymarket API | Simülasyon (sahte veri) | v1.1 |
| Gerçek BTC WebSocket | Simülasyon | v1.1 |
| SQLite veritabanı | Yok (bellekte) | v1.1 |

### Bağlantı Haritası
```
[Browser] ←WS 300ms→ [FastAPI /ws]
                           ↕
                    [app_state dict]
                           ↕
                   [simulation_tick()]
                    (BTC, countdown,
                     rules, positions,
                     events, trades)

[Browser] ←REST→ [FastAPI /api/*]
  /api/status      → tüm state snapshot
  /api/settings    → GET ayarları yükle
  POST /api/settings → ayar kaydet + state güncelle
  POST /api/bot/start|stop → bot toggle
  POST /api/positions/{id}/close → pozisyon kapat
```

---

---

## v1.1.0 — 2026-03-29 (Multi-Asset Watchlist)

### Yeni Özellikler
- **8 Asset Simülasyonu:** BTC, ETH, SOL, XRP, DOGE, BNB, MATIC, LINK — bağımsız fiyat dalgaları
- **3-Panel Watchlist:** Sol panel (asset listesi) + sağ panel (seçili asset detayı)
- **Pin Sistemi:** Bot yalnızca takipli (pinned) asset'ları izler; WS ile toggle_pin
- **REST Fallback:** Sayfa açılışında `/api/status` fetch → WS bağlantısı beklenmez
- **WS Scoping Fix:** `ws_clients -= dead` → `ws_clients.difference_update(dead)` (UnboundLocalError düzeltildi)
- **Bağımsız Countdown:** Her asset kendi 5dk penceresini izler
- **Faz Yönetimi:** entry → position → exit per-asset (sadece pinned + bot running)
- **Demo Tarihçe:** 18 rastgele PAPER trade başlangıç verisi

### Teknik Değişiklikler
- `ASSETS` dict: 8 koin, renk, ikon, base_price, volatility
- `_asset_countdowns / _asset_phases / _asset_market` per-asset sim dicts
- `renderAssetRow()` + `updateDetailPanel()` watchlist JS fonksiyonları
- `.watchlist-panel` (340px) + `.detail-panel` (flex:1) CSS layout

---

## OTBA Raporu v1.1.0

### Bağlı ve Çalışan Elementler ✅
| Element | Endpoint / Fonksiyon | Durum |
|---------|---------------------|-------|
| 8 asset simülasyonu | `simulation_tick()` per-asset | ✅ |
| Pin sistemi | WS `toggle_pin` + `POST /api/assets/{sym}/pin` | ✅ |
| Asset seçimi | WS `select_asset` + `POST /api/assets/{sym}/select` | ✅ |
| 3-panel layout | `.watchlist-panel` + `.detail-panel` | ✅ |
| Fiyat flash animasyonu | `_prevPrices` diff → `flash-green/red` | ✅ |
| REST fallback polling | `fetch('/api/status')` her 2sn (WS kopuksa) | ✅ |

---

## v1.2.0 — 2026-03-29 (Accordion Event Layout + Notification Bell)

### Yeni Özellikler
- **Accordion Event List:** 8 asset kartı; tıklayınca genişler, diğerleri sıkışır
- **3-Kolon Expand Detayı:** Geri Sayım + Market Prices + Manuel Order (veya Pozisyon)
- **Asset Chip Filtresi:** "All" + BTC/ETH/SOL/... chip butonları → tek asset görünümü
- **Toolbar Stats Bar:** Balance, P&L, Win Rate, Trades — üst toolbar'da
- **Notification Bell 🔔:** Header'da çan ikonu, badge (okunmamış sayısı), dropdown liste
  - Demo bildirimler: BTC tracking başladı, SOL slippage uyarısı, ETH event açıldı
  - "Tümünü Oku" butonu, dışarı tıklayınca kapanır
- **Mini Pipeline Dots:** Her kapalı kartta 6 renkli nokta (pass/fail/waiting)
- **TRACKING / POS / READY badge:** Kapalı kartlarda inline durum göstergesi
- **Anlık Geri Sayım Barı:** Genişlemiş kartın üst kenarında renkli progress çubuğu
- **Polymarket Analizi Uygulandı:** polymarket.com/crypto/5M + event detail page yapısı referans alındı

### Teknik Değişiklikler
- `state.expandedAsset` — hangisi açık
- `state.chipFilter` — asset filtresi
- `state.notifications[]` + `state.notifOpen` — bildirim sistemi
- `renderEventsList()` — tüm accordion kartlarını render eder
- `renderEventCard(sym)` — tek kapalı/açık kart HTML
- `renderEventBody(sym)` — genişlemiş 3-kolon detay HTML
- `expandEvent(sym)` — toggle expand
- `filterEvents(sym)` — chip filtresi
- `pushNotification(level, msg)` — bell badge günceller
- CSS: `.eac`, `.eac-hdr`, `.eac-body`, `.eac-body-grid`, `.pd` (mini dots), `.badge-*`, `.notif-*`

---

## OTBA Raporu v1.2.0

### Bağlı ve Çalışan Elementler ✅
| Element | Endpoint / Fonksiyon | Durum |
|---------|---------------------|-------|
| Accordion expand/collapse | `expandEvent(sym)` → `renderEventsList()` | ✅ |
| Asset chip filtresi | `filterEvents(sym)` | ✅ |
| Toolbar stats (Balance, P&L, Win Rate, Trades) | `renderEventsList()` içinde | ✅ |
| Mini pipeline dots | `renderEventCard()` → `.pd.pass/fail/waiting` | ✅ |
| Notification bell dropdown | `toggleNotifDropdown()` + `pushNotification()` | ✅ |
| Badge sayacı (okunmamış) | `updateNotifBadge()` | ✅ |
| Dışarı tıklayınca kapat | `document.addEventListener('click', ...)` | ✅ |
| TRACKING/POS/READY badge | pinned + has_position + allPass kurallar | ✅ |
| Geri sayım color-coding | cd≤20=kırmızı, cd≤60=sarı, diğer=mor | ✅ |
| Countdown bar (genişlemiş kart) | `barPct` = (300-cd)/300*100 | ✅ |
| Manuel order (genişlemiş kart) | `placeOrder(sym, side)` | ✅ |
| Pozisyon kartı (genişlemiş, açıksa) | `closePosition(pos.id)` | ✅ |
| Live fiyat flash animasyonu | `_prevPrices` diff → `flash-green/red` | ✅ |
| Cache-bust hard refresh | Ctrl+Shift+R (eski JS cache sorunu çözüldü) | ✅ |

### Bağlantı Haritası v1.2
```
[Browser] ←WS 300ms→ [FastAPI /ws]
                           ↕
                    [app_state dict]
                           ↕
              [simulation_tick() per-asset]
              (price, countdown, market,
               rules, phase, event, pinned)

Accordion Flow:
  click eac-hdr → expandEvent(sym)
    → state.expandedAsset = sym
    → wsSend(select_asset)
    → renderEventsList()
      → renderEventCard(sym)     [header row]
        → renderEventBody(sym)   [expanded body]
          [Col1: countdown]
          [Col2: market prices]
          [Col3: order/position]
          [Pipeline: 6 rules]

Notification Flow:
  addLog(level, msg) → pushNotification()
    → state.notifications.unshift()
    → updateNotifBadge()
  toggleNotifDropdown()
    → renderNotifications()
```

---

---

## v1.7.0 — 2026-03-31 (Faz B Testi: Paper TP/SL döngüsü doğrulandı)

### Kritik Hata Düzeltmeleri (Faz B testinde keşfedildi)
1. **`execute_sell` PAPER mod eksikliği** — PAPER modda `execute_sell` her zaman `None` döndürüyordu → tüm çıkış girişimleri başarısız, pozisyon HOLD_TO_RESOLUTION'a gidiyordu. Fix: PAPER path eklendi (`return sell_price`).
2. **`_reason_to_status("SL")` terminal durum hatası** — `close_position(reason="SL")` sonrası durum STOP_LOSS kalıyordu → sell_retry her 100ms'de aynı pozisyonu tekrar satmaya çalışıyordu. Fix: "SL" ve "FORCE_SELL" artık CLOSED döndürüyor.
3. **`record_price_update` hiç çağrılmıyordu** — stale data guard her entry girişimini `stale_market_data` olarak reddediyordu. Fix: `simulation_tick` içinde her tick'te çağrılıyor.
4. **`execute_entry` PAPER modu yoktu** — PAPER modda order fill simülasyonu eksikti. Fix: fake `order_id` + `fill_size` üreten PAPER path eklendi.
5. **Restart sonrası duplicate entry** — `load_open_positions_from_db()` lock set etmiyordu → restart'ta aynı event'e çift giriliyordu. Fix: `lock_event(pos.event_key)` eklendi.

### Test Sonuçları
| Test | Durum | Kanıt |
|------|-------|-------|
| Faz A — Restart Recovery | PASS critical_changes=false | snapshot diff, 8/8 kriter |
| Faz B1 — Entry/TP döngüsü | PASS critical_changes=false | entry=0.465→exit=0.78 TP, pnl=13.04 |
| Faz B2 — Entry/SL döngüsü | PASS critical_changes=false | entry=0.495→SL, clean ENTRY→EXIT(SL) zinciri |

### Snapshot Kanıtları (`docs/snapshots/`)
- `snapshot_20260331_043852_faz_a_restart_oncesi.txt`
- `snapshot_20260331_043929_faz_a_restart_sonrasi.txt`
- `snapshot_20260331_044551_faz_b1_oncesi.txt`
- `snapshot_20260331_045439_faz_b1_tp_sonrasi.txt`
- `snapshot_20260331_050514_faz_b2_clean_oncesi.txt`
- `snapshot_20260331_050632_faz_b2_sl_sonrasi.txt`

---

## v1.6.0 — 2026-03-31 (Restart Recovery + Kanıt Altyapısı)

### Yeni Dosyalar
- **`backend/execution/entry_service.py`** — Fill detayları DB'ye sync edildi: `update_position_fill()` çağrısı eklendi
- **`backend/storage/db.py`** — `update_position_fill(pos_id, order_id, fill_confirmed, shares)` fonksiyonu
- **`tests/test_recovery.py`** — 9 test / 27 kontrol: fill recovery, duplicate guard, safe_mode, callback zinciri (27/27 PASS)
- **`tools/snapshot.py`** — 6 kanıt noktasını tek komutla `docs/snapshots/` altına yazar
- **`docs/SMOKE_TEST.md`** — $1 canlı test öncesi zorunlu kontrol listesi (Faz A/B/C/D)

### Kritik Düzeltme: DB Sync Zinciri
Önceki eksiklik: `open_position()` ilk DB kaydı yapıyor, fill detayları (`order_id`, `fill_confirmed`, `shares`) sonradan ekleniyor ama DB güncellenmiyordu.

Artık:
1. `open_position()` → initial DB kaydı (fill_confirmed=False, shares=tahmini)
2. `execute_entry()` fill doldurur → `_last_entry_info` side-channel
3. `entry_service.py` fill inject → **`db.update_position_fill()` DB'yi günceller**
4. `load_open_positions_from_db()` → restart sonrası tüm alanlar doğru geri yüklenir

### Kanıt Araçları
```bash
# Snapshot al
python tools/snapshot.py --label "restart_oncesi"

# İki snapshot arasındaki farkı gör (alan bazında, yapılandırılmış)
python tools/diff_snapshots.py --latest 2
python tools/diff_snapshots.py --label-a restart_oncesi --label-b restart_sonrasi
```

Diff çıktısı: fill_confirmed, order_id, shares değişimi | yeni audit kararlar | bot_state delta | PnL delta | kritik log satırları.

---

## Sonraki Versiyon Planı

### v1.1.0 (Tamamlandı — bkz. yukarıda)
- [ ] Gerçek Polymarket Gamma API → BTC 5m event çekme
- [ ] Binance WebSocket → gerçek BTC fiyatı
- [ ] CLOB WebSocket → UP/DOWN token fiyatları
- [ ] SQLite veritabanı (trades, events tabloları)
- [ ] Manuel trade modal (UP/DOWN seç → miktar → gönder)
- [ ] Wallet backend endpoint (güvenli .env yazma)
- [ ] Events → Resolved tab mantığı
- [ ] RAR yedeği: POLYFLOW_v1.1.0

### v1.2.0
- [ ] Gerçek PAPER order execution (py-clob-client, simüle imza)
- [ ] Claim/Redeem sayfası
- [ ] Trade History CSV export
- [ ] Strategy şablonları (kaydet/yükle)
- [ ] Çoklu event takibi (BTC + ETH + SOL)

### v1.3.0 (LIVE Trading)
- [ ] Gerçek order execution (FOK entry, GTC exit)
- [ ] Wallet key aktivasyonu (.env DISABLED_ kaldır)
- [ ] Gasless Relayer v2 entegrasyonu (auto-claim)
- [ ] Sell retry mekanizması
- [ ] Force sell (resolution öncesi)
