# POLYFLOW — Claude Code Bağlam Dosyası

Bu dosya her yeni sohbette Claude'un projeyi anlaması için okunmalıdır.

---

## Proje Amacı

**POLYFLOW**, Polymarket tahmin piyasasında kripto "Up or Down" eventlerinde otomatik işlem yapan çok-varlıklı (multi-asset) bir trading botudur.

- Tek bir coin'i (BTC) izleyen eski **Polymarketmini** projesinin gelişmiş, çok coinli versiyonudur
- Şu an **PAPER modda** çalışıyor (gerçek para kullanılmıyor)
- Hedef: Faz 4'te LIVE trading (HMAC auth + gerçek CLOB order execution)

---

## Sistem Özeti

| Bileşen | Detay |
|---|---|
| Backend | FastAPI + asyncio, port **8002**, `D:/POLYFLOW/backend/main.py` |
| Frontend | Vanilla JS SPA, `D:/POLYFLOW/frontend/index.html` |
| Veritabanı | SQLite (`bot.db`), positions/trades/events_log/settings_history |
| Mevcut versiyon | **v1.5.4** |

### Veri Kaynakları (Hepsi Polymarket'ten)
| Kaynak | URL | Ne için |
|---|---|---|
| Gamma API | `https://gamma-api.polymarket.com` | Market/event keşfi, PTB |
| CLOB WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | UP/DOWN token fiyatları ~100ms |
| RTDS WebSocket | `wss://ws-live-data.polymarket.com` | Canlı coin fiyatları ~100ms (Polymarket'in kendi soketi) |
| CLOB API | `https://clob.polymarket.com` | Order execution, bakiye |

### Strateji Motoru
6 modüler kural: `Time`, `Price`, `Move`, `Spread`, `EventLimit`, `MaxPositions`
Kurallar `D:/POLYFLOW/backend/strategy/rules/` altında ayrı dosyalarda.

---

## Önemli Mimari Kararlar

- **RTDS "Binance kaynaklı"** ifadesi Polymarket'in bu veriyi Binance'ten beslediği anlamına gelir; biz **Polymarket'in kendi WebSocket'ine** bağlanıyoruz, Binance'e değil
- **Simülasyon kapatılmıştır** — `simulation_tick()` fonksiyonu artık sadece `_market_cache`'i (Gamma API verisi) okuyup state'i güncelliyor, sahte fiyat üretmiyor
- **Her event kartının kendi ayarları olacak** — BTC_5M ve BTC_15M farklı strateji parametrelerine sahip olmalı
- **FOK order** girişlerde kullanılacak (GTC değil) — "ya gir ya hiç" prensibi
- **Paper trade execution henüz yok** — bot şu an karar veriyor ama otomatik order açmıyor

---

## Geliştirme Planı (Öncelik Sırası)

### Faz 1 — Güvenlik & UI (Aktif)
1. `/api/wallet` endpoint auth
2. `/health` endpoint
3. Dashboard fiyat gecikmesi — `renderEventsList()` full re-render kaldır, in-place güncelle
4. Settings: Exit paneli (Force sell, TP%, SL%, retry)
5. Tooltip açıklamaları
6. **Per-event ayarlar** — her kart kendi stratej ayarlarına sahip (SQLite'ta `event_settings` tablosu)

### Faz 2 — Bot Davranışı
7. Bakiye çekme (CLOB `/balance-allowance`)
8. Decisions sayfası
9. SQLite'a pozisyon/trade yazımı

### Faz 3 — Risk & Exit
10. 5 katmanlı exit stratejisi (Polymarketmini'den adapte)
11. Trailing stop mekanizması

### Faz 4 — Live Trade
12. FOK order execution (py-clob-client)
13. HMAC L2 imzalama
14. Gasless Relayer auto-claim

---

## Referans Kaynaklar

### Polymarket Resmi
- Döküman: https://docs.polymarket.com/
- API Referans: https://docs.polymarket.com/api-reference
- Python SDK: https://github.com/Polymarket/py-clob-client
- AI Agents repo: https://github.com/Polymarket/agents (superforecaster prompt, CLOB wrapper desenleri)

### Kullanıcının Projeleri
- **Polymarketmini** (eski bot, referans): https://github.com/hsncoskun1/Polymarketmini
  - Order composer/executor, exit engine (4 katman), risk engine (6 kontrol), HMAC imzalama buradan alınacak
- **PolyFlow** (bu proje): https://github.com/hsncoskun1/PolyFlow

### Referans Botlar
- Polyclaw (Chainstack): https://github.com/chainstacklabs/polyclaw — Half-Kelly, 5 katmanlı exit
- Polyclaw (haber odaklı): https://github.com/arkyu2077/polyclaw — fuzzy logic, 90s döngü

---

## Çalışma Kuralları

- Tüm yanıtlar **Türkçe** olmalı
- Her değişiklik öncesi kullanıcı onayı alınmalı
- Büyük geliştirmelere başlamadan önce GitHub'a commit/push yapılmalı
- Güvenlik açıkları (private key, API key) asla plaintext döndürülmemeli
