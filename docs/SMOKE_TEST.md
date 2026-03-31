# POLYFLOW — Smoke Test Senaryosu
**$1 Canlı Test Öncesi Zorunlu Kontrol Listesi**
Son güncelleme: 2026-03-31

---

## Snapshot ve Diff Araçları

Her kritik noktada sistem durumunu kaydet:

```bash
python tools/snapshot.py --label "etiket_adi"
```

İki snapshot arasındaki farkı gör:

```bash
python tools/diff_snapshots.py --latest 2                          # son 2 snapshot
python tools/diff_snapshots.py --label-a restart_oncesi --label-b restart_sonrasi
python tools/diff_snapshots.py snapshot_A.txt snapshot_B.txt      # tam yol
```

Diff çıktısı alan bazında karşılaştırır: `fill_confirmed`, `order_id`, `shares`, `status`, audit log yeni kararlar, bot_state değişiklikleri, PnL delta, kritik log satırları.

Çıktı dosyaları: `docs/snapshots/snapshot_YYYYMMDD_HHMMSS_<etiket>.txt`

---

## Ön Koşullar

Smoke test başlamadan önce aşağıdakiler hazır olmalı:

- [ ] `.env` dosyasında `CLOB_API_KEY`, `CLOB_API_SECRET`, `CLOB_API_PASSPHRASE`, `POLY_PRIVATE_KEY` dolu
- [ ] Polymarket hesabında USDC bakiyesi ≥ $5 (test + gas için)
- [ ] `python tests/test_recovery.py` çalıştırıldı — tüm testler PASS
- [ ] Backend logs klasörü temizlendi: `backend.log` ve `backend_err.log` sıfırlandı
- [ ] Bot DB sıfırlandı veya yedeklendi (`bot.db` → `bot_backup_YYYYMMDD.db`)
- [ ] Başlangıç snapshot alındı: `python tools/snapshot.py --label "baslangic"`

---

## FAZ A — Restart Recovery Doğrulama (PAPER mod)

### A1. Fixture Pozisyon Yükle

1. Botu `PAPER` modda başlat
2. Bir event için settings yapılandır (BTC_5M veya istediğin event)
3. Kuralların PASS etmesini bekle — ya da entry_price'ı manuel olarak kural koşullarına uygun ayarla
4. İlk paper pozisyon açılsın

**Beklenen:**
- `[INFO] Pozisyon açıldı [pf_xxxx]` logu görünmeli
- Positions sekmesinde pozisyon görünmeli

### A2. Bot'u Durdur ve Yeniden Başlat

**Restart öncesi snapshot al:**
```bash
python tools/snapshot.py --label "restart_oncesi"
```

1. Botu durdur (`■ Durdur` butonu)
2. Sayfayı yenile (F5)
3. Botu yeniden başlat

**Beklenen loglar:**
```
[INFO] DB'den 1 acik pozisyon yuklendi (X fill_confirmed)
[INFO] sell_retry başladı — 1 pozisyon izleniyor
```

**Restart sonrası snapshot al:**
```bash
python tools/snapshot.py --label "restart_sonrasi"
```

**İki snapshot karşılaştır → aynı olmalı:**
- [ ] `entry_actual` değişmedi
- [ ] `shares` değişmedi (DB'den geldi)
- [ ] `fill_confirmed` değişmedi (0 veya 1 aynı kaldı)
- [ ] `order_id` değişmedi
- [ ] `condition_id` değişmedi

**Operasyonel kontrol:**
- [ ] Pozisyon Positions sekmesinde hâlâ görünüyor
- [ ] Aynı event'e ikinci bir position açılmadı (duplicate entry yok)
- [ ] sell_retry exit loop restart sonrası çift başlamadı

### A3. safe_mode Persistence

1. Emergency Stop butonuna bas
2. Botu durdur
3. Backend'i tamamen kapat (terminal kapat veya Ctrl+C)
4. Backend'i yeniden başlat
5. Frontend'e bak

**Beklenen:**
- [ ] Sidebar'da sarı `⚠ SAFE MODE` uyarısı görünüyor
- [ ] "Bot Başlat" butonu disabled
- [ ] Log: `[WARNING] safe_mode DB'den yüklendi — bot durduruldu`
- [ ] Disable Safe Mode linkine tıklanınca uyarı gizleniyor ve bot başlatılabilir hale geliyor

---

## FAZ B — Paper Trade Tam Döngüsü

### B1. Entry → TP Döngüsü

1. `PAPER` mod, `strategy_mode: PERCENT`, `target_exit_pct: 3`, `stop_loss_pct: 5`
2. `order_amount: 1.0`
3. Bot başlat, entry bekle

**Entry sonrası snapshot:**
```bash
python tools/snapshot.py --label "paper_entry_sonrasi"
```

**Kontrol (snapshot Section 2'ye bak):**
- [ ] `[INFO] Pozisyon açıldı` logu
- [ ] Positions sekmesinde `OPEN` durumunda kart
- [ ] Audit log (`/api/audit`) → `ENTRY` kaydı var
- [ ] `fill_confirmed` durumu doğru (PAPER → True veya False, tutarlı mı?)

Şimdi `target_exit_price`'ı anlık mark fiyatına eşitle (ya da sell_retry'da TP koşulunu geçici olarak düşür):

**TP close sonrası snapshot:**
```bash
python tools/snapshot.py --label "paper_tp_sonrasi"
```

**Beklenen TP close:**
- [ ] `[INFO] Pozisyon kapandı [TP]` logu
- [ ] Positions kartı kayboldu veya `CLOSED` badge'i gösteriyor
- [ ] Trade History sekmesinde kayıt var
- [ ] Audit log → `EXIT (TP)` kaydı var
- [ ] Snapshot Section 5 → trade PnL pozitif
- [ ] Snapshot Section 4 → `session_pnl` artı değerde

### B2. Entry → SL Döngüsü

1. `stop_loss_enabled: true`, düşük stop_loss_price ayarla (entry'nin biraz altında)
2. Entry bekle
3. mark fiyatı stop_loss_price'a gelene kadar bekle (veya stop_loss_price'ı geçici olarak yükselt)

**Beklenen SL close:**
- [ ] `[INFO] Pozisyon kapandı [SL]` logu
- [ ] Audit log → `EXIT (SL)` kaydı
- [ ] Session PnL negatif güncellendi

### B3. Force Sell (Countdown 0)

1. Kısa countdown'lu bir event seç (15-30 saniyelik)
2. Pozisyon açık olsun, countdown sıfıra gelsin

**Beklenen:**
- [ ] Karda ise: `HOLD_TO_RESOLUTION` — `[WARNING] HOLD_TO_RESOLUTION` logu
- [ ] Zararda ise: `FORCE_SELL` — `[INFO] Pozisyon kapandı [FORCE_SELL]` logu

---

## FAZ C — Backend Fiyat Otoritesi Doğrulama

### C1. Price Freshness Badge

1. Frontend açık, bot çalışıyor
2. Her event kartında Market Prices bölümünde badge var mı?

**Beklenen:**
- [ ] `⚡BE` (yeşil) — son 5sn içinde fiyat güncellendi
- [ ] Badge sınıfı `fresh` → CSS rengi yeşil
- [ ] Backend logları sıkça `update_mark` çağırıyor (50ms döngü)

### C2. Frontend Doğrudan WS Yok

1. Tarayıcı DevTools → Network sekmesi → WS bağlantıları
2. `clob.polymarket.com` veya `polymarket.com/ws` gibi adreslere doğrudan bağlantı ARAMALIDo NOT exist

**Beklenen:**
- [ ] Frontend sadece `ws://localhost:8765` (veya backend URL) ile konuşuyor
- [ ] Polymarket servislerine frontend'den doğrudan WS bağlantısı yok

---

## FAZ D — $1 Canlı Test (Sadece Bu Noktaya Kadar Gelinirse)

> **UYARI:** Bu test gerçek para harcar. Yukarıdaki tüm PAPER testler geçmeden yapma.

### D1. Ön Hazırlık

- [ ] `.env` dolu ve doğru wallet adresi
- [ ] `mode: LIVE` olarak settings güncellendi
- [ ] `order_amount: 1.0` (sadece $1)
- [ ] `max_open_positions: 1` (tek pozisyon)
- [ ] `event_trade_limit: 1` (event başına 1 trade)

### D2. İlk Live Order

1. Bot başlat
2. Uygun event bekle (kurallar PASS)
3. Entry tetiklensin

**Doğrulanacaklar:**
- [ ] Log: `[INFO] execute_entry LIVE — token_id=xxx`
- [ ] Log: `[INFO] Pozisyon açıldı [pf_xxxx] — LIVE`
- [ ] Polymarket'ta gerçekten order açıldı mı? (polymarket.com/activity kontrol)
- [ ] `fill_confirmed: True` — REST response fill aldı
- [ ] `order_id` dolu — CLOB'dan gerçek order ID geldi

### D3. Exit Doğrulama

TP veya SL tetiklensin (küçük range ayarla):

- [ ] Polymarket'ta sell order görüntülendi
- [ ] Log: `[INFO] Pozisyon kapandı [TP/SL] — LIVE`
- [ ] USDC bakiyesi güncellendi (kazanç veya kayıp)
- [ ] Audit log'da tam lifecycle: `ENTRY → EXIT`

**Exit sonrası final snapshot:**
```bash
python tools/snapshot.py --label "live_exit_sonrasi"
```

### D4. Reconciler Kontrolü (30-60sn sonra)

- [ ] Reconciler logu: `reconciler çalıştı — X pozisyon kontrol edildi`
- [ ] HOLD_TO_RESOLUTION yanlışlıkla tetiklenmedi
- [ ] Herhangi bir `RECONCILE_DISCREPANCY` logu var mı? (varsa araştır)

**Reconcile sonrası snapshot:**
```bash
python tools/snapshot.py --label "reconcile_sonrasi"
```

Snapshot Section 6'da `RECONCILE_DISCREPANCY` satırı yoksa temiz.

---

## Başarı Kriterleri Özeti

| Test | Kriter | Durum |
|------|--------|-------|
| Restart Recovery | Tüm alanlar doğru geri yüklendi | ⬜ |
| safe_mode | Restart sonrası korundu | ⬜ |
| Paper Entry | Pozisyon açıldı, logda görünüyor | ⬜ |
| Paper TP | Kapandı, PnL pozitif | ⬜ |
| Paper SL | Kapandı, PnL negatif | ⬜ |
| Force Sell | Countdown 0'da tetiklendi | ⬜ |
| Price Badge | ⚡BE yeşil görünüyor | ⬜ |
| No Direct WS | Frontend doğrudan bağlanmıyor | ⬜ |
| Live Entry $1 | Gerçek order açıldı | ⬜ |
| Live Exit | Order kapandı, USDC güncellendi | ⬜ |
| Reconciler | 60sn sonra yanlış HOLD yok | ⬜ |

**Tüm satırlar ✅ olmadan live trading artırılmamalıdır.**

---

## Hata Durumunda

- **"order_not_filled"** logu → CLOB bağlantısı kontrol et, token_id doğru mu?
- **"stale_market_data"** logu → CLOB WS bağlantısı kopmuş, backend logundan takip et
- **RECONCILE_DISCREPANCY** → Shares hesabı veya token_id yanlış — hemen $0 mode'a geç
- **Çift pozisyon açıldı** → entry_locks veya is_event_locked() arızası — acil durdur
- **safe_mode yüklenmedi** → DB'de bot_state tablosu var mı kontrol et: `SELECT * FROM bot_state`
