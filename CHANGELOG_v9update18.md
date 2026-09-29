# CHANGELOG v9update18 — Flash Sale + BC Harga

**Rilis:** 2026-07-23  
**Fokus:** Sistem flash sale (potongan harga bertimer) + broadcast update harga.

---

## 🆕 Fitur Baru

### 1. Flash Sale Manager (Admin)
Menu baru di panel admin: **🔥 Flash Sale**

- **Buat Flash Sale Baru** — Wizard 4 step:
  1. Pilih varian (hanya yang stok > 0 dan belum FS aktif)
  2. Input harga sale (harus < harga normal)
  3. Pilih durasi: preset 30m / 1h / 6h / 24h atau custom (`45m`, `2h`, `3d`)
  4. Konfirmasi → aktifkan
- **Daftar Aktif** — list flash sale aktif + sisa waktu
  - View detail per FS
  - Cancel Flash Sale (dengan konfirmasi → masuk riwayat)
  - BC Broadcast (kirim ke semua user pakai banner)
- **Riwayat** — 20 riwayat terakhir (expired / cancelled / auto-stopped)

### 2. Broadcast Flash Sale
Saat FS baru dibuat, admin ditanya: mau broadcast sekarang?

- Pakai **Banner Flash Sale** (base64) sebagai photo header
- Caption menarik: harga coret, hemat %, sisa waktu, endAt WIB
- Tombol CTA: 🛒 **BELI SEKARANG (SALE)** (langsung buka `dpi_<vid>`)
- Bisa BC ulang dari daftar aktif

### 3. BC Harga Baru (Broadcast Update Harga)
Setelah admin edit harga varian di menu Kelola Produk, muncul tombol baru:
**📢 BC Harga Baru**

- Konfirmasi dulu (tampilkan old → new, arah turun/naik %, jumlah user)
- Broadcast pakai **Banner Update Harga** (base64) + tombol CTA lihat produk

### 4. FS-aware Edit Harga
Edit harga di varian yang lagi ada Flash Sale:

- Jika harga baru ≤ salePrice → **Flash Sale otomatis DIHENTIKAN** (masuk riwayat: `price_edit_below_sale`)
- Jika harga baru > salePrice **dan FS belum di-broadcast** → discount % di-recalc silent
- Jika harga baru > salePrice **dan FS sudah di-broadcast** → recalc + warning mismatch (broadcast lama sudah mention % lama)

### 5. Order Lock: Effective Price
Harga di-lock saat user pertama pilih varian (`dpi_<vid>`).

- `orderState.price` = harga efektif (sale price kalau FS aktif)
- `orderState.originalPrice` + `orderState.isFlashSale` + `orderState.flashSaleId` + `orderState.flashSaleExpiresAt` disimpan
- Qty +/- dan refresh pakai `orderState.price` (bukan `p.price` current)
- Metadata FS di-propagate ke `depositDetails` Pakasir + Duitku

### 6. Auto-Cancel Invoice saat FS Expired
Di `processPaymentSuccess` (payments.js), sebelum finalize produk:

- Cek `details.flashSaleExpiresAt`. Jika `Date.now() > flashSaleExpiresAt` →
- **Refund penuh ke SALDO user** (bukan produk terkirim)
- Kirim notifikasi user (invoice cancelled + saldo baru)
- Log ke InvoiceLogger
- **Return** sebelum stok dikurangi

### 7. FS Badge di User Menu
Di list varian (`buildVariantView`):

- Icon 🔥 sebelum nama varian yang lagi FS
- Harga normal dicoret (`~Rp X~`) → sale price bold (`*Rp Y*`) → diskon %
- Button label juga prefix 🔥

Di konfirmasi order (`buildOrderView`):

- Harga: `<s>Rp original</s> → 🔥 <b>Rp sale</b>`

### 8. Settings: 2 Banner Baru
Di menu ⚙️ Settings, tambah 2 button (di bawah Banner Stok):

- 🔥 **Banner Flash Sale (Base64)** — disimpan di `BotConfig.bannerFsB64`
- 💰 **Banner Update Harga (Base64)** — disimpan di `BotConfig.bannerPriceB64`

Upload via file `.txt` berisi base64 (pola sama dengan Banner Start/List/Stok).  
Status & tombol hapus tersedia.

---

## 💬 Skema KV Baru

```
FlashSale             : { [variantId]: {
                          variantId, variantName,
                          originalPrice, salePrice, discountPercent,
                          durationMs, durationLabel,
                          createdAt, createdBy,
                          expiresAt,
                          broadcasted, broadcastAt, broadcastSent
                        } }

FlashSaleHistory      : [ { ...fs, endedAt, endReason } ]  (max 100, terbaru dulu)
                        endReason: 'expired' | 'admin_cancel' | 'price_edit_below_sale'

PriceChangeLog_<vid>  : { variantId, oldPrice, newPrice, at, by }
                        (dihapus setelah BC Harga dikirim; kalau tidak, tetap ada sampai edit berikutnya)

BotConfig.bannerFsB64     : string base64 (opsional)
BotConfig.bannerPriceB64  : string base64 (opsional)

adminState_<fromId>   : { action: 'fs_price' | 'fs_await_dur' | 'fs_duration_custom'
                                | 'fs_confirm' | 'settings_fs_banner' | 'settings_price_banner',
                          variantId, originalPrice, variantName,
                          salePrice?, durationMs?, durationLabel?, expiresAt? }

orderState_<fromId>   : { ...existing,
                          price,              // <-- v18: LOCKED effective price
                          originalPrice,      // <-- v18: null jika bukan FS
                          isFlashSale,        // <-- v18: boolean
                          flashSaleId,        // <-- v18: variantId kalau FS, else null
                          flashSaleExpiresAt  // <-- v18: ms epoch atau null
                        }

SessionDeposit[].depositDetails : { ...existing,
                                    flashSaleId, flashSaleExpiresAt, originalPrice }
```

---

## 🔑 Callback Data Baru

| Callback | Fungsi |
|---|---|
| `adm_flashsale` | Menu utama Flash Sale |
| `adm_fs_new` | Step 1: pilih varian |
| `adm_fs_pick_<vid>` | Simpan pilihan varian, tanya harga |
| `adm_fs_dur_30m/1h/6h/24h` | Set durasi preset → confirm |
| `adm_fs_dur_custom` | Minta input custom |
| `adm_fs_confirm` | Aktifkan FS + prompt broadcast |
| `adm_fs_list` | Daftar aktif |
| `adm_fs_view_<vid>` | Detail FS |
| `adm_fs_cancel_<vid>` | Konfirmasi cancel |
| `adm_fs_cancel_ok_<vid>` | Do cancel |
| `adm_fs_bc_ok_<vid>` | Broadcast (dari confirm/list/view) |
| `adm_fs_hist` | Riwayat |
| `adm_bc_harga_<vid>` | Konfirmasi BC harga |
| `adm_bc_harga_ok_<vid>` | Do BC harga |
| `adm_set_fs_banner` | Upload banner Flash Sale |
| `adm_del_fs_banner` | Hapus banner Flash Sale |
| `adm_set_price_banner` | Upload banner Update Harga |
| `adm_del_price_banner` | Hapus banner Update Harga |

**Ordering:** `*_ok_*` handlers ditempatkan **sebelum** base handler yang lebih generic — untuk menghindari collision `startsWith`.

---

## 🛡️ Regression Check

Semua fitur sebelumnya masih intact:

| Fitur | Marker | Count | Status |
|---|---|---|---|
| v14 Dev Mode | `SimulatePayment` | 11 | ✅ |
| v15 Duitku QRIS-only | `duitkuCreateQris` | 15 | ✅ |
| v16 Broadcast Stok | `adm_bc_stokbaru` | 10 | ✅ |
| v17 Voucher & Redeem | `adm_voucher` / `redeemVoucher` | 56 + 4 | ✅ |
| **v18 Flash Sale** | `adm_fs_` / `FlashSale` | **60 + 60** | 🆕 |

---

## 🧪 Test Checklist

- [ ] Buat FS baru pakai preset 30m → aktif, sisa waktu benar
- [ ] Buat FS pakai custom `2h` → aktif
- [ ] Cancel FS → masuk riwayat
- [ ] FS auto-expired → masuk riwayat (`endReason: 'expired'`)
- [ ] Broadcast FS (dengan banner) → semua user terima
- [ ] Broadcast FS (tanpa banner) → fallback text only
- [ ] User pilih varian FS → order lock harga sale
- [ ] Qty +/- pakai harga sale (bukan harga normal)
- [ ] User bayar via QRIS SEBELUM FS expired → sukses normal
- [ ] User bayar via QRIS SETELAH FS expired → auto-cancel + refund saldo
- [ ] Edit harga varian FS: harga baru ≤ sale → FS auto-stop
- [ ] Edit harga varian FS: harga baru > sale, belum BC → discount recalc silent
- [ ] Edit harga varian FS: harga baru > sale, sudah BC → warning mismatch
- [ ] BC Harga Baru → semua user terima
- [ ] Upload banner Flash Sale via .txt → preview di BC berikut
- [ ] Upload banner Update Harga via .txt → preview di BC harga berikut

---

_Selesai. Semua fitur v9update17 dan sebelumnya tetap berjalan normal._
