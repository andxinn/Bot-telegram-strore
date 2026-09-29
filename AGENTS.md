# AGENTS.md — Telegram Store Bot (Cloudflare Workers)

> Dokumen ini ditujukan untuk **AI agent / developer lain** yang akan melanjutkan proyek ini.
> Bacalah seluruhnya sebelum mengubah kode. Tujuannya: kamu paham proyek ini _tentang apa_,
> _bagaimana strukturnya_, dan _aturan main_ saat mengedit.

---

## 1. Apa Proyek Ini

Bot **toko otomatis (auto-order) Telegram** yang berjalan di **Cloudflare Workers**.
Pembeli memesan produk digital (mis. akun/voucher/stok teks) langsung dari chat Telegram,
membayar via **QRIS** atau **Saldo**, lalu produk dikirim otomatis sebagai file `.txt`.

Fitur utama:
- Katalog produk berkategori + varian, dengan pagination.
- Alur order: pilih produk -> pilih varian -> atur jumlah -> pilih metode bayar -> bayar -> terima produk.
- Pembayaran **QRIS dinamis** (OkeConnect / Saweria) dengan pengecekan mutasi otomatis via cron.
- **Saldo/deposit** internal per user.
- Panel **Admin** (kelola produk, varian, stok, harga, S&K, role, ban, broadcast).
- **Auto-backup** data KV per jam.
- UI “single-card” dengan animasi loading dan **Reply Keyboard** menu utama yang selalu tampil.

Runtime & bahasa: **JavaScript ESM** (`"type": "module"` di `package.json`), Node 24 untuk tooling lokal,
target eksekusi = Cloudflare Workers (V8 isolate, `fetch` + `scheduled` handler).

---

## 2. Struktur Proyek

```
cf-worker/
├─ package.json         # type: module; scripts: dev, deploy, start
├─ wrangler.toml        # config Workers: KV binding "DB", cron triggers
├─ dev-server.mjs       # server lokal untuk dev/uji tanpa deploy
├─ README.md
├─ AGENTS.md            # (file ini)
└─ src/
   ├─ index.js          # ENTRY POINT: export default { fetch, scheduled }
   ├─ config.js         # konfigurasi & env (initConfig, banner, nama bot, dsb)
   ├─ constants.js      # konstanta (ITEMS_PER_PAGE, expiry, prefix provider)
   ├─ telegram.js       # semua wrapper Telegram Bot API (tg*)
   ├─ kv.js             # helper KV (readJSON/writeJSON/readText/deleteKey/...)
   ├─ helpers.js        # util (format rupiah, tanggal WIB, markdown-safe, QRIS CRC16, id, loadingBar)
   ├─ keyboard.js       # definisi keyboard (menu utama, nomor produk, panel admin)
   ├─ commands.js       # handler perintah /start /menu dll + entry pesan teks
   ├─ messages.js       # semua tampilan/kartu untuk user (list, varian, order, bayar, riwayat)
   ├─ callbacks.js      # handler semua tombol inline (callback_query)
   ├─ payments.js       # siklus hidup pembayaran (cek pending, sukses, expired)
   ├─ payment.js        # integrasi provider (OkeConnect mutasi, Saweria)
   ├─ qris.js           # generate QRIS dinamis dari QRIS statis
   ├─ user.js           # user, saldo, role, ban, lock (anti double-submit)
   ├─ admin.js           # panel admin + state machine admin
   └─ backup.js         # auto-backup data KV
```

> Catatan penamaan yang membingungkan: **`payment.js`** = integrasi provider (mutasi/donasi),
> **`payments.js`** = orkestrasi status pembayaran (sukses/expired/cron). Jangan tertukar.

---

## 3. Entry Point & Routing (`index.js`)

`export default { fetch, scheduled }`.

**HTTP (`fetch`)**
- `POST /webhook` — menerima update Telegram. Diproses async: `ctx.waitUntil(handleUpdate(env, update))`
  lalu langsung balas `200` (penting agar Telegram tidak retry).
- `GET /setup` — set webhook Telegram ke `<url>/webhook`.
- `GET /health` atau `/` — health check.

`handleUpdate` mengarahkan:
- `update.message` -> `handleCommand` / `handleMessage` (teks, tombol reply keyboard, state admin).
- `update.callback_query` -> `handleCallbackQuery` (tombol inline).

**Cron (`scheduled`)** — dari `wrangler.toml` `crons = ["* * * * *", "0 * * * *"]`:
- `* * * * *` (tiap menit) -> `checkPendingPayments` (cek pembayaran QRIS/Saweria & expired).
- `0 * * * *` (tiap jam) -> `autoBackup`.

---

## 4. Penyimpanan Data (Cloudflare KV, binding `DB`)

Semua state disimpan di KV sebagai JSON via `kv.js`. Key penting:

| Key | Isi |
|---|---|
| `Kategori` | array kategori produk `{ id, produkName, produkId, desc }` |
| `Produk` | array varian `{ id, nameproduct, price, category(=produkId), desc, stok:[{info,expired_at}] }` |
| `Trx` | riwayat transaksi `{ trxid, user_id, produk, varian, jumlah, total, tanggal, payment_method, status }` |
| `SnK` | syarat & ketentuan per kategori `[{ id(=kategori.id), snk }]` |
| `SessionDeposit` | sesi pembayaran pending `{ id, status, depositDetails:{ userId, type('purchase'|'deposit'), id, cart, produk, produk_nama, total_amount, expired, expiryMinutes, key(=message_id QR), nama, username, amount? } }` |
| `OrderCounter` | penghitung order untuk generate ID |
| `BotConfig` | konfigurasi runtime (banner base64, file id, nama bot, dll) |
| `flowMsg_<userId>` | message_id kartu “single-card” aktif (agar tidak menumpuk pesan) |
| `orderState_<userId>` | state order berjalan `{ produk, varian, kategoriId, produkId, jumlahPesanan, totalPrice, userId, payment_method, trxId }` — `price` = harga terkunci saat `dpi_` (v9update18), wajib dipakai `confirm_` |
| `listPage_<userId>` | halaman list produk aktif |
| `depositState_/adminState_/manageState_/cekTrxState_<userId>` | state input multi-langkah |
| user & role & ban & lock keys | dikelola di `user.js` |

---

## 5. Alur Utama Pengguna

1. **/start** -> registrasi user + tampil menu utama (Reply Keyboard).
2. **🛒 List Produk** -> `showProductList`: kartu banner + caption daftar kategori + Reply Keyboard berisi **nomor** kategori (+ navigasi halaman).
3. Pilih nomor -> `showVariants` -> kartu varian (inline keyboard varian).
4. Pilih varian (`dpi_<id>`) -> `buildOrderView`: atur jumlah (`increase_/decrease_/refresh_`), lalu `confirm_`.
5. `confirm_` -> `buildPaymentView`: pilih **QRIS** (`pay_qris_`) atau **Saldo** (`pay_saldo_`), atau **Batal** (`pay_cancel_`).
6. **QRIS**: tampilkan foto QR + tombol `Cek Pembayaran` / `Batal`. Cron/tombol cek -> `processPaymentSuccess` bila mutasi cocok.
7. **Saldo**: langsung potong saldo -> sukses.
8. **Sukses**: kirim struk `.txt` (`tgSendDocument`) + hapus foto QR.

### Aturan UI penting (JANGAN dilanggar)
- **Single-card flow**: satu kartu aktif dilacak lewat `flowMsg_<userId>`; kartu lama dihapus sebelum kirim yang baru.
- **Animasi loading anti-macet** (`messages.js` -> `sendCardWithLoading`): loading dikirim sebagai **pesan teks** dan dianimasikan **sampai 100%** (edit teks itu andal), lalu kartu final (foto+konten) dikirim sebagai **pesan baru** dan pesan loading dihapus. **JANGAN** kembali ke pola edit caption foto (rapuh: batas caption 1024 char + gagal jika base64 fallback jadi teks -> dulu bikin macet di “10%”).
- **Reply Keyboard menu utama harus SELALU tampil.** Karena reply keyboard “menempel” pada pesan dan hilang saat pesan itu dihapus, setiap **titik akhir** (sukses/batal/expired) harus mengirim pesan yang membawa `getMainMenuKeyboard()`. Jangan memakai pesan terpisah “Menu utama siap digunakan” — tempelkan keyboard pada pesan struk/pembatalan itu sendiri.
- **Batal / expired**: **hapus** kartu/foto/QR, cukup tampilkan **teks** notifikasi (dengan keyboard menu utama menempel).

---

## 6. Pembayaran

- **QRIS dinamis** (`qris.js` `generateQris`): membentuk payload EMV dari QRIS statis (`DATA_QRIS`) + nominal + kode unik, hitung ulang CRC16 (`helpers.toCRC16`). Gambar QR dirender via `quickchart.io/qr`.
- **Provider cek pembayaran** (`payment.js`):
  - `checkMutasiQRIS` + `matchPayment` (OkeConnect) — cocokkan nominal & waktu (default 5 menit).
  - `createSaweria` / `cekStatusSaweria` (Saweria).
- **Orkestrasi** (`payments.js`):
  - `checkPendingPayments` (cron/menit): loop `SessionDeposit` pending -> expired? sukses? masih pending.
  - `processPaymentSuccess`: cabang `deposit` (tambah saldo) & `purchase` (ambil stok, catat `Trx`, hapus QR, kirim struk `.txt` + keyboard menu).
  - `handleExpiredPayment`: hapus QR + kirim teks kadaluwarsa (+ keyboard menu). Expiry = `PAYMENT_EXPIRY_MINUTES` (5).
- **`SimulatePayment`** (config): jika true, pembayaran dianggap sukses otomatis (untuk testing).
- **Anti double-submit**: `acquireLock/releaseLock` (`user.js`) sebelum proses saldo/qris/confirm.

---

## 7. Admin (`admin.js`)

- Akses dibatasi `isOwner(fromId)` (OwnerID di config) atau role `admin` (`getRole`).
- Panel via inline keyboard; alur input bertahap disimpan di `adminState_<id>` / `manageState_<id>`.
- Fitur: tambah/edit kategori, varian, stok (dengan masa aktif/expired), harga, deskripsi, S&K, kelola role & ban, broadcast.

---

## 8. Konfigurasi & Env

- `wrangler.toml`: `name`, `main=src/index.js`, `[[kv_namespaces]] binding="DB"`, `[triggers] crons`.
- `.dev.vars` (lokal) / Workers secrets: `BOT_TOKEN`, `DATA_QRIS`/`QR_STRING`, `BANNER_FILE_ID`, dan flag lain.
- `config.js` `initConfig` memuat nilai dari `env` + `BotConfig` KV. Ekspor a.l.: `NamaBot`, `OwnerID`,
  `InvoiceLogger`, `BannerFileId`, `bannerListB64`, `orderBotName`, `SimulatePayment`, `PaymentSaweria`,
  `PaymentOkeConnect` (= kebalikan Saweria).
  - Banner: jika `bannerListB64` (base64 > 50 char) ada -> kirim foto via `tgSendPhotoBase64`;
    else jika `BannerFileId !== '-'` -> `tgSendPhotoFile`; else teks biasa.

---

## 9. Menjalankan & Deploy

```bash
npm run dev      # jalankan dev-server.mjs (uji lokal)
npm run start    # wrangler dev
npm run deploy   # wrangler deploy ke Cloudflare
```
Setelah deploy, panggil `GET /setup` sekali untuk memasang webhook Telegram.

---

## 10. Konvensi & Catatan Penting untuk Editor AI

1. **ESM wajib.** `package.json` `"type":"module"`. Validasi tiap file dengan:
   ```bash
   cd src && for f in *.js; do node --input-type=module --check < "$f" || echo "FAIL $f"; done
   ```
   (Jangan `node --check file.js` karena akan diperlakukan CommonJS.)
2. **Semua panggilan Telegram lewat `telegram.js`.** Fungsi `tg*` selalu mengirim `parse_mode` (default `Markdown`).
   Untuk teks dinamis (nama produk dari user), bungkus dengan `mdSafe()` agar Markdown tidak rusak;
   jika parse gagal, kirim ulang dengan `parseMode=''` (tanpa Markdown).
3. **Batas caption foto Telegram = 1024 char.** Jangan menaruh konten panjang sebagai caption foto;
   pakai teks biasa (limit 4096) atau logika `sendFinalCard` yang sudah menangani ini.
4. **`editMessageCaption` hanya untuk pesan foto/media.** Memanggilnya pada pesan teks akan gagal.
   Inilah sumber bug “stuck 10%” lama — hindari mengedit caption untuk alur loading.
5. **Reply keyboard bersifat chat-level** tapi hilang bila pesan pembawanya dihapus — selalu pasang ulang
   `getMainMenuKeyboard()` pada pesan terminal (sukses/batal/expired).
6. **Bot boleh menghapus pesan** (incoming maupun miliknya) di private chat — dipakai untuk single-card & hapus QR.
7. **`escapeMarkdown` bersifat pass-through** (tidak mengubah); `mdSafe` yang benar-benar menyaring `_ * ` [ ]`.
8. **Jangan hardcode ID/URL Notion**; proyek ini murni Cloudflare Worker + Telegram, tidak terkait Notion.
9. Simpan artefak build (zip) dengan penamaan versi berurutan (lihat riwayat di bawah).
10. **Tombol berwarna (Bot API 9.4, 9 Feb 2026):** objek `InlineKeyboardButton`/`KeyboardButton` mendukung field `style` dengan nilai `"danger"` (merah), `"success"` (hijau), `"primary"` (biru). Warna tidak butuh Premium (yang butuh Premium hanya `icon_custom_emoji_id`). Karena `telegram.js` mengirim `reply_markup` sebagai JSON penuh, cukup tambahkan `style` pada objek tombol. Warna hanya tampak di aplikasi Telegram yang sudah dukung 9.4; app lama memakai gaya default (fungsi tetap jalan).
11. **Kutipan ungu = blockquote**, hanya didukung parse mode **HTML/MarkdownV2** (bukan `Markdown` legacy). Kartu Konfirmasi (`buildOrderView`) memakai `parseMode: 'HTML'` dengan `<blockquote>` + `<b>`, dan teks dinamis di-escape HTML (`&`,`<`,`>`). `editCard(env, cq, caption, keyboard, parseMode)` menerima parseMode; builder yang mengembalikan `parseMode` harus meneruskannya.

---

## 11. Riwayat Versi (ringkas)

- **v7/v8**: base64 banner via file txt, upload txt, perombakan UI, tombol nomor produk pindah ke Reply Keyboard bawah.
- **v9**: perbaikan List Produk stuck, model kartu tunggal (single-card), QR hilang otomatis saat sukses,
  animasi loading dipertahankan & anti rate-limit, perbaikan pilih varian tidak merespon (mdSafe + fallback plain text).
- **v9update**: menemukan akar “stuck 10%” = fragilitas edit caption foto; diganti pola “loading teks -> kirim kartu baru -> hapus loading”.
- **v9update2**: animasi loading berjalan sampai 100% dulu, baru kartu foto+list dikirim, lalu loading dihapus.
- **v9update3**: Reply Keyboard menu utama dipasang ulang di semua titik akhir agar tidak hilang.
- **v9update4**: saat **batal (QRIS/Saldo)** dan **expired > 5 menit**, foto/QR dihapus dan hanya menampilkan teks;
  pesan “🏠 Menu utama siap digunakan.” dihapus — keyboard menu ditempelkan langsung pada pesan pembatalan/expired.
- **v9update5**: rapikan tampilan — perbaikan divider rusak (❓❓❓) di kartu varian; tombol jumlah jadi `-1/+1/-5/+5`
  dengan **warna asli** (`style` danger/success) + `dec5_`/`inc5_` (loncat 5, clamp 1…stok); tombol Konfirmasi `style: primary`;
  catatan **“Diperbarui pada HH:MM:SS WIB”** bergaya **kutipan ungu** (blockquote HTML) di kartu Konfirmasi.
- **v9update6**: warna tombol via `style` — kartu Pembayaran (QRIS biru, Saldo hijau, Batal merah), kartu QRIS (Cek hijau, Batal merah), reply keyboard menu utama semua biru kecuali Deposit hijau; rapikan kartu Deposit & pesan kadaluwarsa/batal jadi box seragam.
- **v9update7**: notifikasi stok — varian habis ditandai "❌ HABIS" + label tombol "· Habis", alert saat pilih varian kosong; tombol +1/+5 kirim peringatan saat stok tidak mencukupi (bukan diam-diam), dan proteksi minimal 1 pcs diperjelas.
- **v9update8**: kartu /start baru — salam sesuai jam WIB (pagi/siang/sore/malam + emoji), baris username, tanggal & jam WIB, ID Telegram dibungkus monospace agar bisa disalin; tata letak box dirapikan.
- **v9update9**: kartu Profil dirombak — dikelompokkan (Identitas · Dompet · Riwayat), ID & Bank ID dibungkus monospace agar bisa disalin, tanggal gabung diformat "22 Juli 2026", nilai saldo & belanja format Rupiah, tanpa baris verifikasi.
- **v9update10**: fitur Broadcast Stok Terbaru — tombol baru di panel Broadcast → preview → kirim ke semua user. Pesan berisi salam sesuai jam WIB + daftar bernomor produk induk beserta varian & jumlah stok yang baru di-add. Ditambah pencatatan KV StokBaru di semua jalur Add Stock (direset setelah broadcast).
- **v9update11**: (1) produk tanpa varian — saat Tambah Kategori ada pilihan "Tanpa Varian (langsung)" yang buat produk tunggal & bisa langsung Add Stock; (2) menu Stok kini menandai ✅ stok tersedia / ❌ stok kosong (menampilkan semua produk); (3) command /bc — reply sebuah pesan lalu ketik /bc untuk broadcast teks/gambar itu ke semua user; (4) menu Settings "Gambar Broadcast Stok" (base64) yang disertakan saat Broadcast Stok Terbaru.
- **v9update12**: pesan Broadcast Stok Terbaru kini menampilkan baris waktu 🕒 Update: <tgl> <bulan-ID> <tahun>, <HH.MM> WIB (otomatis dari waktu WIB saat broadcast) di bawah sapaan.

- **v9update13:** Sistem payment diganti total dengan **Pakasir**. Menu Admin → Settings → 💳 Setting Payment untuk konfigurasi Slug/API Key/Mode (sandbox/production)/Metode/Fee (persen + nominal). Multi-gateway ready. Webhook: `/pakasir-webhook`. Deposit & Purchase memakai `pakasir_gw` snapshot per-sesi.

## v9update14 (2026-07-23) — Dev Mode Enhancement
- Hot-reload: `npm run dev` pakai `node --watch` (zero dep, butuh Node ≥ 18.11)
- Dev-only endpoints: /dev/info, /dev/kv, /dev/kv/:key (GET/POST/DELETE), /dev/simulate-pakasir-webhook
- Polling offset di-persist ke KV (`__DEV_POLL_OFFSET__`) — aman restart
- Warning besar saat startup kalau IS_PROD_TOKEN=true di .dev.vars
- KV snapshot utility: `npm run kv:snap|list|load`
- VS Code integration: .vscode/{launch,tasks,settings,extensions}.json
- Template: .dev.vars.example
- Panduan lengkap: DEV.md (dev workflow + switch ke production)
- Kode src/ TIDAK DISENTUH — dev vs production identik

## v9update15 (2026-07-23) — Duitku Payment Gateway (QRIS-only)
- Payment gateway kedua: **Duitku** ditambahkan berdampingan dengan Pakasir (multi-gateway).
- Hanya opsi **QRIS** (4 provider Duitku): SP (Shopee QRIS, default), NQ (Nobu), GQ (Gudang Voucher), SQ (Nusapay).
- Menu: Admin → Settings → 💳 Setting Payment → 🅳 Duitku (QRIS).
- Config: Merchant Code, API Key, QRIS Provider, Fee (persen + nominal), Expiry (menit, auto-clamp), Verify IP (default OFF), Mode (sandbox/production), Test Koneksi, Aktifkan sebagai Active Gateway, Reset.
- Webhook: `/duitku-webhook` (menerima `application/x-www-form-urlencoded` maupun JSON). Signature: HMAC_SHA256 hex lowercase.
- Return URL: `/duitku-return` (halaman info sederhana, user diarahkan kembali ke Telegram).
- Cron 1 menit poll `transactionStatus` per sesi Duitku (kalau webhook telat).
- Fee **independen** per gateway (`gateways.pakasir.fee*` vs `gateways.duitku.fee*`).
- Modul baru: `src/duitku.js` (Web Crypto HMAC, QRIS-only exports).
- Tombol "🌐 Bayar via Halaman Duitku" **DIHILANGKAN** (paymentUrl tetap disimpan di session utk log/debug).
- Dev-only: `POST /dev/simulate-duitku-webhook` (auto-generate signature dari apiKey di BotConfig KV).

## 📘 Setup Guide

Untuk setup bot dari nol (install → dev mode → production → payment → backup → CI/CD), baca **`setupbot.md`** di root project. File ini panduan step-by-step lengkap untuk user pemula.

## v9update16 (2026-07-23) — Nomor Urut Stock + Admin Menu Identitas

**Fitur baru:**
1. **Nomor urut stock** di file `.txt` purchase (bagian `PRODUK:`). Format `1. item`, `2. item`, dst. Applied di `payments.js:129` (QRIS Pakasir/Duitku) dan `callbacks.js:360` (bayar saldo). Fallback diperkeras dengan `JSON.stringify` supaya object stock aneh tetap terbaca.
2. **Admin menu `🏷️ Identitas Bot`** di `Admin → Settings`. Ganti Nama Bot, Nama Toko, Prefix ID Order langsung dari bot tanpa restart/redeploy. Data disimpan ke `BotConfig` KV (priority: KV > env > default).
3. Tombol `♻️ Reset ke Env` untuk hapus override KV.

**Bug fixes dalam v9update16 (dari deep review):**
- FIX-1: `adm_set_botname` (Prefix ID Order) tombol Batal sekarang balik ke submenu Identitas, bukan Settings.
- FIX-2: Nilai `cur` di prompt input dibungkus backtick (safe untuk nama yang mengandung `*`/`_`).
- FIX-3: `payments.js` fallback `s.info || s` diperkeras jadi `s.info || (typeof s === 'string' ? s : JSON.stringify(s))` agar tidak dump `[object Object]`.
- FIX-4: Input validation di `settings_namabot`/`settings_storename` strip control chars (`\r \n \t \v \f`) dan collapse whitespace untuk cegah newline injection.
- FIX-5: `payments.js:131` `+ NamaBot` diberi fallback `|| ''` (konsisten dgn callbacks.js).
- FIX-6: `/config` command wrap output di code block supaya Markdown special char di NamaBot/StoreName/BotConfig JSON tidak break parsing.

**File touched:** `src/payments.js` (+1), `src/callbacks.js` (+1), `src/admin.js` (+~90), `setupbot.md` (+section 4.6), `.dev.vars.example` (comment).

Baca **`CHANGELOG_v9update16.md`** untuk detail lengkap + preview file txt.

## v9update17 (2026-07-23) — Voucher & Redeem System

Sistem voucher/kupon lengkap: admin generate batch, user redeem via `/redeem <KODE>`.

**Admin flow:** `/admin` → `🎫 Voucher & Redeem`:
1. `➕ Generate Kode Baru` — wizard 4-step (Prefix → Nominal → Jumlah → Expiry). Expiry parser fleksibel: `30m`, `2h`, `7d`, `24 jam`, `3 hari`, atau tanpa expired.
2. `📋 Daftar Batch` — list 20 batch terbaru, klik untuk detail. Ikon: 🟢 aktif / ⚪ habis / ⚠️ expired / 🔴 revoked.
3. Di detail batch: 📄 Download file .txt, 📢 Broadcast (private — 1 kode unik per user), ❌ Revoke sisa kode.
4. `📊 Statistik` — total aktif/terpakai/expired/revoked + total nominal + 3 redeem terakhir.

**User flow:** ketik `/redeem <KODE>` (mis. `/redeem RMZ-K3P9-8FZW`). Bonus langsung masuk saldo. Ketik `/redeem` tanpa argumen untuk lihat bantuan.

**Keamanan:**
- Format kode: `^[A-Z0-9]{3}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$` (exclude I/O/0/1, entropi 36⁸ ≈ 2,8 triliun)
- Redeem atomic via `acquireLock('redeem_' + userId, 10s)` — cegah double-spend
- Status transition satu arah: `active → used/revoked/expired`
- User `isBanned` diblokir redeem
- Audit log 500 entri terakhir di KV `VoucherAudit`
- Log ke `InvoiceLogger` channel tiap redeem sukses

**KV keys:** `Voucher`, `VoucherBatch`, `VoucherAudit`.

Baca **`CHANGELOG_v9update17.md`** untuk detail lengkap, edge cases, dan alasan keputusan design.

## v9update18 — Flash Sale + BC Harga (2026-07-23)

**Fitur besar:**
- **Flash Sale Manager**: wizard 4-step (varian → harga sale → durasi → konfirm), preset durasi 30m/1h/6h/24h + custom (`45m`, `2h`, `3d`)
- **Broadcast Flash Sale** dengan banner base64 + tombol CTA 🛒 BELI SEKARANG (langsung `dpi_<vid>`)
- **BC Harga Baru**: tombol muncul setelah edit harga; broadcast pakai banner khusus
- **Order lock**: harga di-lock saat `dpi_` (di `orderState.price`), qty +/- pakai harga terkunci, propagate ke Duitku/Pakasir `depositDetails`
- **Auto-cancel invoice** saat FS expired sebelum bayar: refund penuh ke saldo di `processPaymentSuccess`
- **FS-aware edit harga**: harga baru ≤ sale → auto-stop; harga baru > sale + FS sudah BC → warning mismatch; else → recalc silent
- **2 banner baru** di Settings: `bannerFsB64` + `bannerPriceB64` (pola sama dengan banner stok)
- **FS badge** di user menu: 🔥 di list varian + coret harga original + `🔥 <b>Rp sale</b>` di konfirmasi order

**KV baru:** `FlashSale`, `FlashSaleHistory` (max 100), `PriceChangeLog_<vid>`, `BotConfig.bannerFsB64`, `BotConfig.bannerPriceB64`.

**Callback prefix baru:** `adm_flashsale`, `adm_fs_*`, `adm_bc_harga_*`, `adm_set_fs_banner`, `adm_del_fs_banner`, `adm_set_price_banner`, `adm_del_price_banner`. **Ordering critical**: `*_ok_*` handlers ditempatkan sebelum base handler untuk hindari `startsWith` collision.

**Regression check (semua intact):** v17 voucher (56 adm_voucher + 4 redeemVoucher), v16 bcstok (10), v15 duitku (15), v14 devmode (11). Plus 60 flashsale refs + 60 adm_fs_ callbacks baru.

Baca `CHANGELOG_v9update18.md` untuk detail lengkap.

## v18.1 (2026-07-23) — Voucher Deletion, FCFS Broadcast & Menu Commands
- **Tombol Hapus Batch Voucher**: Menambahkan tombol `🗑️ Hapus Batch` di inline keyboard detail batch beserta alur konfirmasi hapus data dari KV `Voucher` dan `VoucherBatch`.
- **FCFS Broadcast**: Mengubah broadcast voucher ke semua user dari 1 kode unik per user menjadi sistem First-Come First-Served (FCFS) berisi satu pesan daftar kode yang dikirim ke semua user (dengan proteksi limit karakter Telegram 4096).
- **Perbaikan Bug Expiry Voucher**: Memperbaiki crash `ReferenceError: formatWIB is not defined` di `admin.js` saat inisialisasi tanggal expired voucher.
- **Pembersihan Pesan Sementara**: Menambahkan `tgDeleteMessage` untuk menghapus teks "Generating..." setelah file voucher berhasil dikirim.
- **Navigasi Tombol Dokumen**: Menambahkan wrapper lokal `tgEditMessageText` untuk menangani transisi dari pesan media/file ke teks menu baru dengan cara otomatis menghapus pesan dokumen agar navigasi admin tidak stuck.
- **Pintasan Menu Commands**: Membatasi command list Telegram (pojok kiri bawah) hanya untuk `/start` dan `/redeem`.

## v18.2 (2026-07-24) — UI Polish, Alignment Titik Dua & Command /adminmenu
- **Perbaikan Validasi Format Redeem**: Mengubah regex validasi redeem voucher di `src/user.js` agar mendukung prefix dengan panjang dinamis antara **2 hingga 5 karakter** (seperti `AS-5E5S-9EXK`) yang sebelumnya dibatasi kaku di tepat 3 karakter.
- **Tombol Kembali Ke Menu Voucher**: Menambahkan tombol `🎫 Ke Menu Voucher` pada pesan notifikasi sukses ketika batch voucher dihapus agar navigasi admin lebih lancar.
- **UI Alignment Polish (Fokus Kerapian)**:
  - Menyederhanakan header kartu-kartu admin dan user menggunakan box unicode `╭ ┊ ╰` dan pembatas `├` yang konsisten.
  - Memperbaiki ketidaksejajaran tanda titik dua (`:`) akibat perbedaan lebar emoji pada font proporsional Telegram. Solusi: Emoji dipindahkan dari depan label teks ke belakang nominal/nilai (misal: `Harga SALE : *Rp 1.000* 🔥` atau `Produk : kurma 📦`). Teks label kemudian diberi spasi padding tetap agar tanda titik dua sejajar rapi secara vertikal.
  - Menghapus tanda coret `~...~` (strikethrough) pada visual `Harga Normal` di pesan broadcast Flash Sale sesuai preferensi kerapihan visual.
- **Command /adminmenu**: Mendaftarkan `/adminmenu` ke menu popup commands Telegram client (baik untuk bot production di `index.js` maupun dev lokal di `dev-server.mjs`) untuk mempercepat akses panel admin bagi admin/owner bot (dengan proteksi keamanan hak akses `isOwner`/`admin` tetap di-evaluasi ketat sebelum panel dibuka).

## v18.3 (2026-07-24) — Produk Populer, Leaderboard & Admin Settings Toggle
- **Fitur Produk Populer (Real-time)**: Tombol `🔥 Produk Populer` di menu utama untuk menampilkan penjualan terlaris mingguan (7 hari terakhir), bulanan (30 hari terakhir) dengan emoji api 🔥 di akhir kuantitas terjual, serta data terlaris sepanjang waktu (tanpa emoji api).
- **Leaderboard Top 10**: Tombol `🏆 Leaderboard` untuk menampilkan 10 pembeli dengan total belanja (nominal) & frekuensi order terbanyak. Peringkat dibedakan dengan emoji medali (🥇, 🥈, 🥉) untuk 3 besar.
- **Pengaturan Admin**:
  - Toggle ON/OFF untuk tombol Leaderboard langsung dari bot (`Admin -> Settings -> 🏆 Leaderboard: [ON/OFF]`).
  - Banner kustom untuk menu Leaderboard (`Admin -> Settings -> 🖼️ Banner Leaderboard (Base64)`), disimpan dalam `BotConfig.leaderboardBanner`.
- **Kepatuhan UI**: Mematuhi Single-card flow, loading animation anti-stuck, dan penempelan reply keyboard menu utama pada titik akhir.
- **Bug Fix**: Menghapus pemanggilan `tgAnswerCallbackQuery` ganda di `adm_toggle_leaderboard` dan `adm_del_lb_banner` yang memicu error `400 Bad Request: query is already answered` dari API Telegram.

## v18.4 (2026-07-24) — Helpdesk Tiket Bantuan (WhatsApp Style)
- **Penggantian Tombol Utama**: Tombol `📞 Hubungi Admin` digantikan oleh `🎫 Tiket Bantuan` pada Reply Keyboard Menu Utama.
- **Sistem Tiket Helpdesk**:
  - User dapat membuat tiket baru (`ticketState_<userId>` step `input_msg`) dan tiket baru langsung dikirim ke Channel Log Tiket.
  - User dapat memantau tiket aktif di `📋 Daftar Tiket Saya` dengan indikasi status warna (Biru/`primary` untuk open/answered, Hijau/`success` untuk closed).
  - Tampilan visual chat history menggunakan gaya WhatsApp: Pesan User ditandai Kuning (`💛 [USER]`) dan Pesan Admin ditandai Pink (`🩷 [ADMIN]`) dengan pembatas unicode box yang rapi.
  - Ketika admin menjawab tiket, user menerima 2 tombol inline: `✅ Selesai` (mengubah status closed dan tombol daftar hijau) dan `❌ Belum Selesai` (memandu follow up chat).
- **Alur & Command Admin**:
  - Tombol log tiket admin `💬 Balas Tiket` mengarahkan admin ke private session chat (`admin_reply_ticket`) agar chat lebih teratur.
  - Perintah `/list_tiket` atau `/listtiket` untuk admin menampilkan ringkasan jumlah tiket dalam kategori `PROSES` dan `SELESAI` lengkap dengan detail chat history & aksi balas.
  - Menu Admin Settings memiliki opsi `🎫 Setting Channel Tiket` untuk memasukkan/mengganti ID channel log tiket (`BotConfig.channelTicket`).

## v18.5 (2026-07-25) — Media Ticket Reply & Silent Admin Rejections
- **Validasi Media Tiket Bantuan**: Memperbaiki bug loop balas tiket dengan membolehkan berkas media (foto/dokumen) dari admin melewati validasi panjang teks di status `admin_reply_ticket`.
- **Silent Penolakan Hak Akses**: Memodifikasi respons perintah khusus admin agar pesan penolakan (`Akses ditolak`) hanya dikirimkan di chat pribadi (private chat), sedangkan di grup/channel logbot perintah dari non-admin akan diabaikan secara silent untuk menjaga kebersihan log.

## v18.6 (2026-07-25) — Clean Workspace (Auto-delete User Inputs)
- **Auto-Delete Masukan Manual Pengguna**: Pesan masukan manual (seperti nominal deposit, ID transaksi, isi laporan tiket, dan berkas upload admin) di chat pribadi otomatis dihapus setelah diproses guna menyisakan antarmuka yang bersih.
- **Pembersihan Prompt Sementara**: Pesan petunjuk sementara dan pesan peringatan kesalahan di alur Deposit, Cek Transaksi, dan Tiket otomatis terhapus saat berpindah ke langkah selanjutnya.
- **Bypass /batal di Mesin State**: Memperbaiki routing `/batal` agar tidak terintersepsi di `commands.js` melainkan diproses oleh state handler aktif untuk memicu reset status dan membersihkan card petunjuk di layar.
- **Card Edit In-Place**: Memperbarui menu pengaturan admin (unggah stiker sukses, log tiket, banner) agar memodifikasi pesan kartu utama secara langsung (`tgEditMessageText`) menggunakan `cardMessageId`.

## v18.7 (2026-07-25) — Backup & Load Database (Migrasi Bot)
- **Auto Backup per 1 Jam**: Cron trigger `0 * * * *` di `src/backup.js` kini membackup seluruh data KV lengkap (termasuk Voucher & Flash Sale) dan mengirimkannya langsung ke log channel (`InvoiceLogger`) dan juga owner (`OwnerID`).
- **Tombol Backup Database (Manual)**: Ditambahkan di Admin Settings untuk membuat cadangan JSON lengkap dan langsung mengirimkannya ke private chat admin bersangkutan.
- **Tombol Load Database (Restore)**: Ditambahkan di Admin Settings untuk memulihkan seluruh data KV dari file JSON backup. Ditambahkan bypass khusus berkas `.json` pada validator dokumen `handleAdminState` agar tidak terhambat aturan berkas `.txt` umum. Setelah dipulihkan, bot memicu inisialisasi ulang konfigurasi runtime (`initConfig`) secara dinamis.

## v18.8 (2026-07-25) — Auto-Hapus Tiket Selesai (7 Hari)
- **Pencatatan Timestamp Tutup**: Menyimpan `closedAt: Date.now()` pada tiket saat ditutup oleh user di `src/callbacks.js` maupun admin di `src/admin.js`.
- **Hourly Cron Cleanup**: Menambahkan fungsi `cleanupClosedTickets` di `src/backup.js` yang memotong tiket berstatus `closed` yang berusia lebih dari 7 hari, dipicu berkala setiap 1 jam via scheduled cron `0 * * * *` di `src/index.js`.

## v18.9 (2026-07-25) — Kelola Admin Bot (Maksimal 10 Akun)
- **Tombol Kelola Admin**: Menambahkan tombol `👑 Kelola Admin` di menu utama Admin (`src/admin.js`) khusus untuk Owner (`isOwner`).
- **Daftar & Pemecatan Admin**: Menampilkan daftar admin aktif beserta tombol `❌ Hapus` untuk mencabut akses admin secara instan dengan notifikasi otomatis ke user bersangkutan.
- **Pengangkatan Admin (Kuota Max 10)**: Menambahkan tombol `➕ Tambah Admin Baru` dengan alur penginputan User ID, validasi status registrasi (`isRegistered`), serta penguncian kuota maksimal 10 akun admin.

## v18.10 (2026-07-26) — Integrasi Payment Gateway Orkut (Private QRIS)
- **Modul Baru `src/orkut.js`**: Integrasi pemanggilan API Orkut (buat QRIS, status check, cancel payment, connectivity testing).
- **Admin Setup Panel**: Menu setelan Orkut di `💳 Setting Payment` untuk edit Base URL, API Key, Expiry, Fee, serta Test Koneksi & Jadikan Active Gateway.
- **Alur Deposit & Purchase**: Mendukung gateway `orkut` secara penuh dengan menampilkan `total_bayar` asli dari API Orkut (termasuk deteksi nominal *Kode Unik*).
- **Status Checking & Pembatalan**: Integrasi pengecekan manual via tombol cek pembayaran, cron check berkala, dan pemanggilan otomatis `orkutCancel` (`/cancel_payment?ref=REF`) saat pengguna membatalkan order atau saat transaksi kadaluwarsa.
- **Bulletproof QR Rendering**: Mengalihkan rendering QR code menggunakan `quickchart.io` dari string EMV `qr_string` asli guna mencegah bug caching gambar `/pay` pada server Orkut.
- **Uji Koneksi & Aktivasi Gateway**: Memperbaiki validasi Uji Koneksi dan Tombol Aktifkan di panel admin (Pakasir, Duitku, Orkut) agar dapat diproses meskipun status gateway masih dinonaktifkan.
## v18.11 (2026-08-20) — UI Stack Layout & Transient Toast Notifications
- **Format Baris Baru (Key-Value Stack) `/start`**: Mengubah desain tata letak informasi akun pada perintah `/start` dari kolom titik dua sejajar (yang berantakan di perangkat non-monospace) menjadi bentuk *stack* vertikal tebal bertingkat dengan penanda cabang unicode siku pohon (`└`). Desain ini dipastikan rapi 100% di semua ukuran layar Telegram (HP, Desktop, Web).
- **Toast Notifikasi Refresh Stok**: Menambahkan pop-up notifikasi sementara (*toast* via `tgAnswerCallbackQuery` dengan `showAlert = false`) yang bertuliskan "🔄 Stok diperbarui" ketika user menekan tombol `↻ Refresh` pada papan informasi stok.
- **Perbaikan Kerapian Stok**: Menyelaraskan muatan `refreshh` di handler callback agar mengembalikan struktur emoji ✅/❌ yang utuh sama seperti tampilan awal informasi stok.

## v18.12 (2026-08-20) — Telegram Forum Topics (Native Live Chat)
- **Arsitektur Forum Topics:** Memigrasikan sistem tiket bantuan dari *one-off reply state* menjadi **Sesi Obrolan Supergrup (Forum Topics)**. Setiap tiket baru otomatis membuatkan kamar (topik) terpisah di Grup Support menggunakan API `createForumTopic`.
- **Zero-State Native Reply:** Admin tidak perlu lagi menekan tombol "Balas Tiket" atau memicu state bot. Admin cukup membalas pesan secara langsung (native) di dalam kamar topik tiket, dan bot (`message_thread_id`) otomatis meneruskan balasan (teks, gambar, maupun berkas) ke *private chat* user.
- **Kerapian Otomatis:** Saat tiket ditutup via tombol atau perintah `/close` di dalam kamar, bot memanggil `closeForumTopic` untuk mengunci dan memindahkan topik tersebut ke Arsip Telegram, sehingga layar grup utama admin tidak menumpuk.
- **Auto-Reopen:** Jika user membalas lagi pada tiket yang sudah berstatus selesai/closed, bot memanggil `reopenForumTopic` sehingga kamar admin otomatis aktif kembali.

## v18.13 (2026-08-20) — Admin Delivery Feedback & Bug Fix
- **Feedback Terkirim Otomatis:** Saat admin mengetik balasan di dalam kamar topik, bot akan otomatis membalas (*reply-to-message*) pesan admin tersebut dengan status pengiriman (`✅ Pesan terkirim` jika sukses, atau `❌ Gagal mengirim: Pengguna memblokir bot...` jika gagal).
- **Penanganan EADDRINUSE:** Menambahkan panduan membebaskan port 8787 dari tabrakan proses terminal ganda saat mode debugging aktif.

## v18.14 (2026-08-20) — Format ID Tiket Username-Tanggal & Permanen Delete Forum Topic
- **Format ID Tiket Baru (`generateTicketId`):** Format ID tiket kini bergaya `username-DD-MM-YYYY-4DigitAcak` (misal: `mythahgg-20-08-2026-4829`). Sanitasi nama otomatis memotong username max 10 karakter agar tetap aman di bawah batas 64 byte Telegram API (`callback_data`).
- **Hapus Topik Permanen (`deleteForumTopic`):** Saat tiket di-close oleh pembeli (tombol `✅ Selesai`) maupun penjual/admin (tombol admin atau perintah `/close`/`/selesai`), bot memanggil `deleteForumTopic` untuk menghapus kamar topik di grup secara permanen sehingga grup support selalu bersih 100%.

## v18.15 (2026-08-20) — Admin Panel Close Bug Fix
- **Perbaikan ReferenceError `cqId`:** Memperbaiki crash saat admin menekan tombol "❌ Tutup" atau "❌ Tutup Menu" di panel admin. Bug disebabkan oleh variabel `cqId` yang digunakan tetapi belum dideklarasikan di dalam cakupan fungsi `handleAdminCallback` di `src/admin.js`. Telah diperbaiki dengan mendefinisikan `const cqId = cq.id` di baris awal fungsi.

## v18.16 (2026-08-20) — Support Link Topik Grup untuk Log Transaksi
- **Parsing Link Topik (`settings_channel_log`):** Menu `📢 Setting Channel Log Transaksi` kini secara cerdas mendukung **Link Kamar Topik** Telegram (misal: `https://t.me/c/1234567890/5` atau `https://t.me/grup/5`), format manual `ChatID:ThreadID`, maupun ID channel biasa.
- **Pengiriman Spesifik per Topik (`sendTxLog`):** Fungsi pengiriman log transaksi di `src/messages.js` otomatis memecah konfigurasi `ChatID:ThreadID` dan meneruskan `message_thread_id` ke fungsi Telegram (`tgSendMessage` & `tgSendDocument`), sehingga log transaksi sukses/gagal beserta berkas `.txt` terkirim tepat di kamar topik grup yang Anda tentukan.

## v18.17 (2026-08-20) — Perapian Layout Kartu & Posisi Emoji
- **Kartu Varian (`buildVariantView`):** Dirombak total ke desain "Solid Box" — garis vertikal `│` penuh, baris `├ Harga` dan `└ Stok` dipisah, titik dua disejajarkan (`Harga :` vs `Stok  :`), dan emoji status dipindah ke akhir teks (`HABIS ❌` / `5 tersedia ✅`). Teks petunjuk diakhiri `👇`.
- **Kartu Pembayaran (`buildPaymentView`):** Teks petunjuk diubah menjadi `Pilih metode pembayaran di bawah 👇`, dan pemanggilan `editCard` di `src/callbacks.js` kini meneruskan `parseMode: 'HTML'` agar blok `<pre>` dirender dengan benar sebagai monospace (bukan teks mentah).
- **Menu Utama & Produk (`buildProductListView`, `/start`, dll):** Semua teks petunjuk kini menempatkan emoji panah `👇` di akhir kalimat agar tidak menabrak tulisan.

## v18.18 (2026-08-20) — Penebalan Label Kartu Varian & Presisi Titik Dua
- **Label Tebal & Spasi Penyelaras (`buildVariantView`):** Memperbarui data baris varian sehingga tulisan label `*Varian*`, `*Harga*`, dan `*Stok*` dicetak tebal, sedangkan isinya tetap normal. Penyelarasan titik dua diatur presisi menggunakan spasi penolong (`*Varian* :`, `*Harga*  :`, `*Stok*   :`). Teks varian kurma kini diawali dengan label `Varian`.

## v18.19 (2026-08-21) — Wizard Input Deskripsi Varian & Produk Tunggal
- **Alur Tambah Varian (`addvarian_desc`):** Menambahkan langkah input deskripsi (beserta tombol Skip) setelah menginput harga varian di panel Admin.
- **Alur Tambah Produk Tunggal (`single_desc`):** Menambahkan langkah input deskripsi (beserta tombol Skip) setelah menginput harga produk tunggal di panel Admin.
- **Konsistensi DB:** Data deskripsi kini tidak lagi di-hardcode `''` secara default, melainkan diisi dari input state (kecuali jika Admin memilih Skip).

## v18.20 (2026-08-21) — Petunjuk /batal pada Seluruh Menu Input Pengaturan Admin
- **Instruksi Batal di Semua Prompt:** Menambahkan petunjuk `_Ketik /batal jika tidak jadi._` pada setiap pesan input konfigurasi di panel Admin, yaitu seluruh menu Setting Payment (Pakasir/Duitku/Orkut), Identitas Bot (Nama Bot, Nama Toko, Prefix ID), Media (Banner Start/List/Flash Sale/Harga/Stok, Stiker Sukses), Channel Log & Grup Tiket, Wizard Voucher, Load Database, Tambah Admin, Edit Harga/Nama/Deskripsi/SnK, Add Stock, dan Wizard Flash Sale.
- **Perintah `/batal` sudah aktif:** Membatalkan proses, menghapus state input, dan kembali ke panel Admin utama.

## v18.21 (2026-08-21) — Integrasi Tampilan Deskripsi di Bawah Header
- **Deskripsi Kategori (`buildVariantView`):** Menampilkan deskripsi kategori tepat di bawah judul box, diawali `│ ` agar lurus di dalam kotak (tanpa emoji).
- **Deskripsi Varian (`buildOrderView`):** Menampilkan detail deskripsi varian di dalam blok monospace `<pre>` (tanpa emoji, label `Detail : `) tepat di bawah judul konfirmasi order.

## v18.22 (2026-08-21) — Menu Edit Deskripsi Kategori & Dukungan Hapus (`/hapus` / `-`)
- **Pemisahan Menu Edit Deskripsi:** Tombol `📝 Edit Deskripsi` di Admin Panel dipecah menjadi dua: `📝 Edit Desk. Varian` (`adm_editdesc`) dan `📝 Edit Desk. Kategori` (`adm_editkatdesc`).
- **Dukungan Hapus Deskripsi:** Admin kini dapat menghapus deskripsi Kategori maupun Varian secara permanen dengan mengetik `-`, `hapus`, atau `kosong` saat mode input deskripsi. Teks "roditest" pada kategori kini bisa dihapus sepenuhnya dari layar.

## v18.23 (2026-08-21) — Pengaturan Khusus Channel Backup DB & Support Topik
- **Tombol Pengaturan Baru (`adm_set_channel_backup`):** Menambahkan opsi `💾 Setting Channel Backup DB` di menu Admin → Settings untuk menyalurkan berkas `.json` cadangan database.
- **Dukungan Kamar Topik Forum:** Mendukung pemisahan `ChatID:ThreadID` dan link topik langsung (seperti `https://t.me/c/1234567890/5`).
- **Penyempurnaan Auto-Backup (`backup.js`):** Modul auto-backup per jam kini mengirim berkas cadangan ke `channelBackup` (dengan parsing `bThreadId` yang valid), sehingga file rahasia database terpisah dari notifikasi notulensi transaksi.

## v18.24 (2026-08-21) — Sistem Folder Menu Settings Admin
- **Struktur Menu Settings Baru:** Mengelompokkan 16 tombol pengaturan admin yang sebelumnya menumpuk vertikal ke dalam 6 folder utama: `🏷️ Identitas & Info`, `🖼️ Media & Banner`, `📢 Channel & Log`, `💳 Payment Gateway`, `🏆 Fitur Tambahan`, dan `💾 Kelola Database`.
- **Navigasi Kembali Presisi:** Tombol `Batal`/`Kembali` di setiap form dan submenu disesuaikan agar kembali ke folder induk masing-masing, bukan langsung keluar ke menu settings utama.

## v18.28 (2026-08-24) — Penambalan Bug Kritis Dataclean & Auto-Refund QRIS
- **Pembersihan Data Yatim (`adm_eksekusi_delkat`):** Saat kategori dihapus, bot kini otomatis memicu pembersihan (*cleanup*) terhadap data `SnK` terkait, entri `FlashSale` aktif dari varian yang ikut terhapus, serta menghapus seluruh berkas log `PriceChangeLog_<vid>` dari memori KV agar tidak meninggalkan sampah data.
- **Auto-Refund Stok Habis / Produk Hilang (`payments.js`):** Jika pembayaran QRIS/E-Wallet pengguna sukses namun stok produk habis atau dihapus admin saat detik transaksi pelunasan, bot kini secara otomatis mengembalikan (*auto-refund*) nominal pembayaran pengguna secara instan ke dalam **Saldo Bot** (`addSaldo`) pengguna, alih-alih membiarkan transaksi tersangkut.

## v18.29 (2026-08-24) — Penghapusan Emoji Jam pada Teks Blok Kutipan
- **Tampilan Minimalis Konfirmasi Order:** Menghapus emoji jam tangan (`⌚`) pada bagian *blockquote* catatan waktu (`Diperbarui pada ... WIB`) di kartu Konfirmasi Order agar terlihat lebih bersih.

## v18.30 (2026-09-15) — Bugfix Expiry WIB, Price Lock Order & Klaim Voucher Anti Double-Spend

**Perbaikan bug dari deep review + audit race:**
- **Sesi pembayaran tidak pernah tepat waktu kadaluarsa (timezone):** `expiredTime()` menyimpan waktu dinding WIB (`dd/mm/yyyy, HH:mm:ss`), tetapi cron (`payments.js`) dan tombol Cek Pembayaran (`callbacks.js`) mem-parse-nya sebagai UTC (Workers berjalan di UTC), sehingga sesi tampak "lebih muda" ~7 jam dan tidak pernah expired tepat waktu. Kini decode dilakukan satu fungsi pemilik `parseExpiredWIB()` di `helpers.js` (regex + append `+07:00`), dipakai kedua call site — behavior byte-identical (invalid/missing → NaN → dilewati try/catch cron).
- **Expiry gateway vs bot tidak sinkron:** QRIS Orkut (10 menit) dan Duitku (expiry per-provider, di-clamp) sebelumnya tetap dianggap mati di menit ke-5. `expiredTime(minutes)` kini menerima parameter; branch Orkut/Duitku/Pakasir pada Deposit & Purchase menyimpan `expiryMinutes` per sesi, pesan kadaluarsa (`handleExpiredPayment`) menampilkan durasi sesungguhnya, dan teks hardcoded "Kadaluwarsa dalam 5 menit" pada Duitku kini menampilkan nilai asli.
- **Flash Sale price lock bocor di Konfirmasi:** `confirm_` sebelumnya menghitung ulang `total = p.price * jumlah` dari harga live, menimpa harga yang dikunci saat `dpi_` (invariant v9update18). Kini `orderState.price` yang terkunci dipakai bila ada.
- **Tombol "🔥 Produk Populer" mati:** Reply Keyboard mengirim `🔥 Produk Populer` sedangkan handler hanya mengenali `✧ Produk Populer`, sehingga tombol jatuh ke fallback generik. Kedua label kini diterima dan label 🔥 ditambahkan ke daftar reset state `MAIN_BUTTONS`.
- **Redeem voucher anti double-spend (claim-verify):** Lock per-kode (`redeem_code_<KODE>`) saja terbukti tidak menutup race FCFS (audit `Promise.all`: dua caller sama-sama menerima `ok:true`, satu kredit saldo hilang karena last-write-wins pada `UserList`). Kini tiap percobaan men-cap token klaim unik (`crypto.randomUUID()`) pada record voucher, saldo hanya dikredit setelah re-read mengonfirmasi klaimnya yang bertahan; pihak yang kalah mendapat rejection `used` biasa tanpa kredit dan tanpa lock tertinggal. Perilaku sequential tidak berubah.

**Keterbatasan yang diketahui (dokumentasi):**
- Race read-modify-write KV masih ada di jalur pembayaran (`UserList` via `addSaldo`/`minSaldo`, serta push-filter-push `SessionDeposit`) — bersifat arsitektural dan butuh Durable Objects untuk atomic penuh; klaim-verify di atas hanya menutup jalur voucher. Verifikasi re-read pada KV eventual-consistency bersifat fail-safe: pemenang tidak mungkin salah kredit, yang kalah bisa sesaat melihat `used` untuk kode yang sebenarnya masih tersedia.
