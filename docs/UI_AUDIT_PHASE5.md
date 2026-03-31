# UI AUDIT & PHASE 5 RAPORU
Tarih: 2026-03-31
Versiyon: POLYFLOW v1.8.0

---

## 1. MİMARİ HÜKÜM (KISA)

### Backend/Frontend Ayrımı Şu An Doğru mu?
**Kısmen doğru, kısmen eksik.**

**Doğru:**
- `_BACKEND_ONLY_MODE = true` — frontend fiyat otoritesi backend'de ✓
- `execution/` modülleri ayrılmış: entry_service, position_tracker, sell_retry, order_executor, reconciler, user_ws ✓
- Strategy kuralları ayrı dosyalarda (6 rule class) ✓

**Eksik:**
- `backend/main.py` 2.132 satır — discovery, state tick, PTB, broadcast, API, orchestration hepsi tek dosyada
- `frontend/js/app.js` 2.791 satır — state, render, websocket, modal, page logic tek dosyada
- `backend/core/` ve `backend/collectors/` klasörleri boş (sadece `__init__.py`)

---

## 2. EN KRİTİK 10 EKSİK

| # | Eksik | Öncelik | Risk |
|---|-------|---------|------|
| 1 | main.py parçalanması | Yüksek | Bakım maliyeti, yeni bug üretme |
| 2 | app.js modülerleşmesi | Yüksek | Frontend değişiklik riski |
| 3 | CLOSED pozisyon bellekte kalma bug'ı | Kritik | Sonraki event'e giremiyor |
| 4 | Numeric mod kaldırılması | Orta | Semantik karmaşa |
| 5 | max_total_trades uygulanması | Orta | Limit çalışmıyor |
| 6 | Emergency stop canlı doğrulaması | Yüksek | Güvenlik açığı |
| 7 | Reconciler false-positive (residual token) | Orta | Yanlış alarm |
| 8 | User WS kopup-gelme testi | Orta | Gözlemlenebilirlik |
| 9 | Claim/redeem entegrasyonu | Düşük | HOLD_TO_RESOLUTION çözümlenemiyor |
| 10 | Performans/istatistik ekranı | Düşük | Alpha kalite için gerekli |

---

## 3. BACKEND ORGANİZASYON ANALİZİ

### main.py Sorumlulukları (2.132 satır)
| Sorumluluk | Taşınmalı mı? | Hedef |
|-----------|--------------|-------|
| FastAPI app oluşturma | Hayır | main.py'de kalır |
| REST API routes (20+) | Evet | `backend/api/` |
| simulation_tick() — 50ms döngü | Evet | `backend/state/tick.py` |
| broadcast_state() | Evet | `backend/state/broadcast.py` |
| PTB fetch + loop | Evet | `backend/market_data/ptb.py` |
| CLOB WS bağlantısı | Evet | `backend/market_data/clob_ws.py` |
| Midpoint poll | Evet | `backend/market_data/midpoint.py` |
| Market discovery (Gamma) | Evet | `backend/market_data/discovery.py` |
| Bot control logic | Evet | `backend/services/bot_control.py` |
| Settings load/save | Kısmen var | `backend/config.py`'ye taşın |
| Claim/redeem | Evet | `backend/services/claim.py` |

### Önerilen Backend Yapısı
```
backend/
├── main.py                 ← Sadece app oluşturma + wiring
├── config.py               ← Settings (mevcut)
├── decision_log.py         ← Audit (mevcut)
├── api/
│   ├── bot.py             ← /api/bot/* routes
│   ├── settings.py        ← /api/settings/* routes
│   ├── positions.py       ← /api/positions/* routes
│   └── market.py          ← /api/market/* routes
├── market_data/
│   ├── clob_ws.py         ← CLOB WebSocket
│   ├── midpoint.py        ← REST midpoint poll
│   ├── ptb.py             ← PTB fetch + loop
│   └── discovery.py       ← Gamma API discovery
├── state/
│   ├── app_state.py       ← app_state dict + helpers
│   ├── tick.py            ← simulation_tick (50ms)
│   └── broadcast.py       ← broadcast_state
├── services/
│   ├── bot_control.py     ← start/stop/safe-mode
│   └── claim.py           ← auto-claim/redeem
├── execution/             ← MEVCUT (korunmalı)
├── strategy/              ← MEVCUT (korunmalı)
└── storage/               ← MEVCUT (korunmalı)
```

---

## 4. FRONTEND ORGANİZASYON ANALİZİ

### app.js Sorumlulukları (2.791 satır)
| Sorumluluk | Satır tahmini | Taşınmalı mı? |
|-----------|--------------|--------------|
| Global state object | ~75 | `state.js` |
| WebSocket bağlantı | ~80 | `ws.js` |
| State merge/güncelleme | ~100 | `ws.js` |
| Event kartı render | ~200 | `render/cards.js` |
| Event ayarları modal | ~250 | `render/modals.js` |
| Positions sayfası | ~150 | `pages/positions.js` |
| History sayfası | ~100 | `pages/history.js` |
| Audit/log sayfası | ~80 | `pages/log.js` |
| Ayarlar sayfası | ~120 | `pages/settings.js` |
| API çağrıları | ~100 | `api.js` |
| Helper utils | ~100 | `utils.js` |

### Önerilen Frontend Yapısı
```
frontend/js/
├── app.js          ← Sadece init + bootstrap
├── state.js        ← Global state object
├── ws.js           ← WebSocket + state merge
├── api.js          ← fetch/POST wrappers
├── utils.js        ← formatUSD, numVal, setText vs
├── render/
│   ├── cards.js    ← renderEventCard, updateCardsInPlace
│   └── modals.js   ← openAssetSettings, showConfirmPopup
└── pages/
    ├── positions.js
    ├── history.js
    ├── log.js
    └── settings.js
```

---

## 5. UI/UX AUDİT

### Sidebar
| Bileşen | Durum | Not |
|---------|-------|-----|
| Safe Mode uyarısı | ✅ Görünür | Sarı badge ile belirgin |
| Bot Başlat/Duraklat/Durdur | ✅ Çalışıyor | API bağlı |
| ACİL DURDUR | ✅ Var | Canlıda test edilmeli |
| Oturum PnL | ✅ Görünür | Session başından itibaren |
| Bakiye | ⚠️ Kısmi | LIVE modda CLOB'dan çekiyor, PAPER'da 0 |

### Event Kartları
| Bileşen | Durum | Not |
|---------|-------|-----|
| Countdown | ✅ Canlı | 50ms güncelleme |
| Kural renkleri | ✅ pass/fail/waiting | Renk kodlu |
| PTB değeri | ✅ Gösteriliyor | Backend authoritative |
| Freshness badge | ✅ Var | <400ms = fresh |
| Ayar butonu ⚙ | ✅ Çalışıyor | Modal açıyor |
| Fiyat spread | ✅ Gösteriliyor | bid/ask/mid |

### Event Settings Modal (Önceki Durum)
- ❌ Tüm alanlar tek sütun dikey yığılı
- ❌ Min/Max entry ayrı satırlarda
- ❌ TP/SL ayrı satırlarda
- ❌ Limit alanları ayrı satırlarda
- ❌ PnL önizlemesi yok
- ❌ Gelişmiş ayarlar öne çıkmıyor

### Event Settings Modal (Bu Güncellemeden Sonra)
- ✅ Min/Max Entry → aynı satır (2-sütun grid)
- ✅ Zaman Kuralı / Min Kalan Süre → aynı satır
- ✅ Fiyat Hareketi / Max Spread → aynı satır
- ✅ Hedef Çıkış / Stop Loss → aynı satır
- ✅ Event Limit / Max Açık → aynı satır
- ✅ Gelişmiş ayarlar (Force Sell / Satış Deneme) → sarı "⚙ Gelişmiş" bloğunda
- ✅ Tahmini PnL Önizleme → yeşil kutu, dinamik güncelleme

---

## 6. EVENT SETTINGS PENCERESI — YENİ DÜZEN

### Wireframe
```
┌─ BTC · 5 Dk · Strateji Ayarları ─────────────────────────────┐
│ ₿  Bitcoin · 5 Dk  Strateji Ayarları                         │
│                                                                │
│ ─── GİRİŞ KOŞULLARI ───────────────────────────────────────── │
│ [Min Giriş   %  |  76  %] [Max Giriş   %  |  97  %]         │
│ [Zaman Kuralı sn| 290 sn] [Min Kalan   sn |  10  sn]        │
│ [Fiyat Hrt.  $  |  70  $] [Max Spread  %  |   3  %]         │
│                                                                │
│ ─── ÇIKIŞ STRATEJİSİ ───────────────────────────────────────  │
│ [Hedef Çıkış %  |  15  %] [Stop Loss   %  |   5  %]         │
│                                                                │
│ ─── LİMİTLER ───────────────────────────────────────────────  │
│ [İşlem Miktarı       $ |   1.0  $]                           │
│ [Event Başına Max ↺ |  1  ↺] [Toplam Max Açık ↺ |  1  ↺]   │
│                                                                │
│ ┌─ ⚙ GELİŞMİŞ (sarı çerçeve) ────────────────────────────┐  │
│ │ [Force Sell   sn|  15 sn] [Satış Deneme ↺ | 200 ↺]     │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                                │
│ ┌─ TAHMİNİ PnL ÖNİZLEME (yeşil çerçeve) ─────────────────┐  │
│ │ Referans Giriş: 76%                                      │  │
│ │ Tahmini Hisse: 1.3158                                    │  │
│ │ TP'de Tahmini Kâr:  +$0.0789                            │  │
│ │ SL'de Tahmini Zarar: -$0.0658                           │  │
│ │ * Gerçek fill/slippage farklı olabilir                  │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                                │
│ [🗑 Temizle]        [İptal] [Kaydet] [💸 Kaydet ve İşlem Aç] │
└────────────────────────────────────────────────────────────────┘
```

---

## 7. DEĞİŞİKLİKLER

### Değiştirilen Dosyalar
| Dosya | Değişiklik |
|-------|-----------|
| `frontend/js/app.js` | AS_LAYOUT eklendi, sectionsHTML güncellendi, fldPair/renderRow eklendi, PnL preview eklendi, onEventSettingInput PnL güncelleme eklendi |
| `frontend/css/polyflow.css` | `.as-row-pair`, `.as-section-adv`, `.as-pnl-preview`, `.as-pnl-row` sınıfları eklendi |
| `VERSIONS.md` | v1.8.0 kaydı eklendi |
| `docs/UI_AUDIT_PHASE5.md` | Bu dosya oluşturuldu |

### Test Sonuçları
- [x] Tüm 13 alan (EVENT_SETTING_FIELDS) hâlâ renderlaniyor
- [x] Field ID'leri (`esf-${key}-${fieldKey}`) değişmedi — validation ve save çalışıyor
- [x] Confirm popup (AS_SECTIONS.keys) dokunulmadı — eski davranış korundu
- [x] PnL önizleme tüm ilgili değerler dolduğunda dinamik güncelleniyor
- [x] Gelişmiş bölüm (force_sell, sell_retry) sarı çerçeveli ayrı blokta
- [x] Responsive: `.as-row-pair` grid 2 sütun — dar ekranda doğal wrap

### Davranış İyileştirmesi
- Önceki: 13 alan tek sütun, 13 scroll adımı
- Sonraki: Paired layout, ~8 görsel satır — %40 daha az scroll
- PnL önizlemesi: Kullanıcı ayar girerken anlık risk/kâr tahmini görüyor
- Gelişmiş blok: Riskli ayarlar dikkat çekici sarı çerçevede izole

---

## 8. BEKLEYEN İŞLER (Faz 5-8 İçin)

Faz 5: PTB testi, UP/DOWN değerleri, delta semantiği, yüzde semantiği, wired test
Faz 6: Numeric kaldırma, sadece PERCENT mod
Faz 7: Claim/redeem akışı
Faz 8: Final kapı kontrolleri
