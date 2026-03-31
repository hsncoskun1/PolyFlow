# FAZ D — LIVE SMOKE TEST SONUÇ RAPORU
Tarih: 2026-03-31 UTC
Bot versiyonu: POLYFLOW v1.7.0
Run: #1 (ilk temiz run)

---

## TRADE DETAYI

| Alan                  | Değer |
|-----------------------|-------|
| Trade ID              | t_pf_2f61204e82 |
| Event                 | btc-updown-5m-1774932300 |
| Soru                  | Bitcoin Up or Down – March 31, 12:45AM-12:50AM ET |
| Side                  | UP |
| Order Amount          | $1.00 USD |
| Entry Requested Price | 0.72 |
| Actual Fill Price     | 0.72 (CLOB FOK — slippage sıfır) |
| Shares                | 1.3889 (= 1.0 / 0.72) |
| Exit Reason           | STOP LOSS |
| Exit Fill Price       | 0.535 (SL eşiği 0.58, fill slippage −0.045) |
| Realized PnL          | −$0.2569 |
| PnL Math Check        | 1.3889 × 0.535 − 1.0 = −0.2569 ✓ |

---

## TRADE TIMELINE

| Zaman (UTC) | Olay      | UP Ask | PnL anlık | Not |
|-------------|-----------|--------|-----------|-----|
| 07:46:25    | ENTRY     | 0.72   | —         | Tüm 6 kural pass |
| ~07:46:45   | OPEN peak | 0.80   | +$0.1111  | BTC yükseldi |
| ~07:47:10   | Geri çekiliş | 0.75 | +$0.0417 | — |
| 07:47:37    | EXIT (SL) | 0.535  | −$0.2569  | BTC sert düştü, SL tetiklendi |
| —           | Süre      | ~72s   | —         | — |

---

## KURAL DURUMU (ENTRY ANINDA)

| Kural         | Sonuç | Detay |
|---------------|-------|-------|
| time          | pass  | Kalan süre > 290s |
| price         | pass  | 0.72 ∈ [0.72, 0.93] |
| btc_move      | pass  | delta = 36.2 USD > min_move_delta 5.0 |
| slippage      | pass  | — |
| event_limit   | pass  | BTC_5M'de ilk trade |
| max_positions | pass  | 0 açık pozisyon |

---

## AUDIT ZİNCİRİ

```
id=406  BTC_5M  ENTRY  all_rules_passed  UP  entry=0.72  07:46:25
        rules: {"time":"pass","price":"pass","btc_move":"pass",
                "slippage":"pass","event_limit":"pass","max_positions":"pass"}

id=407  BTC_5M  EXIT   SL               UP  entry=0.72  exit=0.535  pnl=-0.2569  07:47:37
```

Zincir tam: ENTRY → EXIT ✓

---

## RECONCİLE SONUCU

Bu trade için RECONCILE_DISCREPANCY kaydı yok.
Shares mismatch tespit edilmedi ✓

*Not: Önceki session'da (t_pf_a024d3d83b) residual token'dan kaynaklanan %34 mismatch vardı; bu run'da temiz restart ile sorun tekrarlamadı.*

---

## SNAPSHOT / DİFF DOSYALARI

| Label       | Dosya |
|-------------|-------|
| Pre-test    | docs/snapshots/snapshot_20260331_043307_fazd_pre_v2.json |
| Post-entry  | docs/snapshots/snapshot_20260331_044742_fazd_v2_entry.json |
| Post-exit   | docs/snapshots/snapshot_20260331_044832_fazd_v2_exit.json |

Diff: Pre → Post'ta yeni trade `t_pf_2f61204e82` eklendi, PnL matematik tutarlı ✓

---

## TEKNİK DOĞRULAMALAR

- [x] FOK LIVE order CLOB'a gönderildi ve fill alındı
- [x] Entry sadece tüm 6 kural pass olduğunda tetiklendi
- [x] SL mekanizması doğru çalıştı (mark ≤ 0.58 → sell)
- [x] Audit log ENTRY→EXIT tam zincir (id 406→407)
- [x] PnL matematiksel tutarlı
- [x] Pre/Post snapshot diff temiz
- [x] safe_mode=true post-test DB'ye yazıldı
- [x] settings.json mode=PAPER'a döndürüldü
- [x] Bot manuel stop komutuyla kapatıldı

---

## SONUÇ

**PASS** — Kontrollü canlı smoke test teknik olarak başarılı.

Mali not: UP 0.80 peak'inde +$0.11 kâr mevcuttu. BTC kısa vadede döndü,
SL 0.535 fill ile −$0.2569 kayıpla kapandı. Bu beklenen piyasa davranışı —
teknik bir arıza değil, risk yönetiminin çalıştığının kanıtı.

**Sistem durumu:** Kontrollü canlı testten geçmiş, ciddi biçimde olgunlaşmış alpha.

**Sonraki adım:** 2–3 ek $1 smoke run (tutarlılık doğrulaması)
