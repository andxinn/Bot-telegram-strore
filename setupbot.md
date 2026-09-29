# 🚀 SETUP BOT — Telegram Store Bot

> **Panduan lengkap dari nol sampai bot live** — dari develop lokal di komputermu, deploy ke Cloudflare Workers, sampai atur payment gateway dari dalam bot.

---

## 📋 Daftar Isi

1. [Peta Perjalanan Setup](#-peta-perjalanan-setup)
2. [Persiapan Awal](#1️⃣-persiapan-awal-5-menit)
3. [Bikin Bot di Telegram](#2️⃣-bikin-bot-di-telegram-5-menit)
4. [Setup Cloudflare](#3️⃣-setup-cloudflare-10-menit)
5. [⭐ Konfigurasi Variables (Paling Penting)](#4️⃣-konfigurasi-variables--paling-penting)
6. [Jalankan Dev Mode](#5️⃣-jalankan-dev-mode-5-menit)
7. [Deploy ke Production](#6️⃣-deploy-ke-production-10-menit)
8. [Setup Payment Gateway](#7️⃣-setup-payment-gateway)
9. [Setup Channel Log](#8️⃣-setup-channel-log-detail)
10. [Setup Backup Otomatis](#9️⃣-setup-backup-otomatis)
11. [Deploy via GitHub Actions (CI/CD)](#🔟-deploy-via-github-actions-cicd)
12. [Troubleshooting](#1️⃣1️⃣-troubleshooting)
13. [Command Cheat Sheet](#1️⃣2️⃣-command-cheat-sheet)
14. [FAQ + Glosarium](#1️⃣3️⃣-faq--glosarium)
15. [Next Steps](#1️⃣4️⃣-next-steps)

---

## 🗺️ Peta Perjalanan Setup

```
┌─────────────────────────────────────────────────────────────┐
│  START                                                       │
│    ↓                                                         │
│  [1] Persiapan (install Node, Wrangler, extract project)    │
│    ↓                                                         │
│  [2] Bikin bot di Telegram (@BotFather) → dapat BOT_TOKEN   │
│    ↓                                                         │
│  [3] Setup Cloudflare (login Wrangler, bikin KV namespace)  │
│    ↓                                                         │
│  [4] Isi .dev.vars (untuk dev lokal)                         │
│    ↓                                                         │
│  [5] Jalankan DEV MODE → test bot di Telegram                │
│    ↓                                                         │
│  [6] Set secrets production → DEPLOY → set webhook           │
│    ↓                                                         │
│  [7] Setup Payment (Pakasir / Duitku) dari admin panel      │
│    ↓                                                         │
│  [8] Setup Channel Log (opsional tapi disarankan)           │
│    ↓                                                         │
│  [9] Aktifkan Backup Otomatis (opsional)                    │
│    ↓                                                         │
│  [10] (Opsional) Deploy otomatis via GitHub Actions          │
│    ↓                                                         │
│  FINISH — Bot live 🎉                                        │
└─────────────────────────────────────────────────────────────┘
```

**Estimasi waktu total:** ~45–60 menit kalau lancar (belum termasuk daftar akun).

### Yang kamu butuh sebelum mulai

| Kebutuhan | Versi/Detail | Cara dapat |
|---|---|---|
| Node.js | ≥ 18.11 | https://nodejs.org/download |
| npm | otomatis ikut Node | ikut Node |
| Akun Cloudflare | Free tier OK | https://dash.cloudflare.com/sign-up |
| Akun Telegram | Nomor HP aktif | Install Telegram, daftar |
| Terminal / Command Prompt | Bawaan OS | Sudah ada |
| (Opsional) Git + akun GitHub | Kalau mau pakai CI/CD | https://github.com/signup |

---

## 1️⃣ Persiapan Awal (5 menit)

### 1.1 Install Node.js

Buka https://nodejs.org/en/download → pilih **LTS**, install seperti biasa.

Verifikasi di terminal:
```bash
node --version    # harus v18.11.0 atau lebih baru
npm --version     # harus 8.x atau lebih baru
```

> ⚠️ **Kalau Node < 18.11**, dev-server tidak jalan karena butuh flag `--watch`. Update dulu.

### 1.2 Install Wrangler CLI

Wrangler = CLI resmi Cloudflare untuk deploy Workers.

```bash
npm install -g wrangler
wrangler --version    # verifikasi
```

> Kalau muncul error permission di Mac/Linux, tambahkan `sudo`: `sudo npm install -g wrangler`.

### 1.3 Extract project

Ekstrak `telegram-store-bot-v9update15.zip` ke folder pilihanmu. Lalu:

```bash
cd telegram-store-bot-v9update15    # atau folder tempat kamu ekstrak
npm install                          # install dependency (sedikit, cepat)
```

### 1.4 Verifikasi struktur folder

Setelah `npm install`, folder harus punya:
```
cf-worker/
├── src/                       # source code bot (19 file .js)
├── scripts/                   # utility scripts (KV snapshot)
├── dev-server.mjs             # dev server (Node local)
├── package.json               # dependency & npm scripts
├── wrangler.toml              # config Cloudflare Workers
├── .dev.vars.example          # template variables untuk dev
├── AGENTS.md                  # changelog fitur
├── DEV.md                     # panduan dev mode
└── setupbot.md                # file yang sedang kamu baca
```

✅ Kalau semua ada → siap ke step 2.

---

## 2️⃣ Bikin Bot di Telegram (5 menit)

### 2.1 Chat @BotFather

1. Buka Telegram, cari **@BotFather** (centang biru resmi)
2. Klik `/start` atau ketik `/newbot`
3. Isi **nama tampilan bot** (bebas, contoh: `Tehtarik Store`)
4. Isi **username bot** (harus akhiran `bot`, contoh: `tehtarik_store_bot`)
5. BotFather balas dengan token seperti ini:
   ```
   1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
   ```

> 🔐 **SIMPAN TOKEN INI!** Ini adalah `BOT_TOKEN`. Jangan share ke siapa pun. Kalau bocor, orang lain bisa kontrol bot kamu.

### 2.2 (Rekomendasi) Bikin 2 bot terpisah: DEV & PRODUCTION

Alasan: kalau kamu test di bot yang sama dengan production, user asli akan melihat bug/error saat kamu develop.

```
@tehtarik_dev_bot        ← untuk testing (pakai token ini di .dev.vars)
@tehtarik_store_bot      ← untuk live (pakai token ini di production)
```

**Ulangi step 2.1 dua kali** untuk bikin 2 bot dengan username berbeda.

### 2.3 Ambil OWNER_ID kamu

OWNER_ID = User ID Telegram numerik kamu, dipakai bot untuk kenali siapa admin.

**Cara paling mudah:**
1. Buka Telegram, cari **@userinfobot**
2. Klik `/start`
3. Bot balas dengan ID kamu, contoh:
   ```
   Id: 6242090623
   First: Nama
   Username: @usernameanda
   ```
4. **Simpan angka `6242090623`** — ini `OWNER_ID`.

### 2.4 Optional — personalisasi bot

Di @BotFather, ketik `/mybots` → pilih bot → **Edit Bot**:
- **Description** — deskripsi panjang, muncul di halaman bot
- **About** — deskripsi pendek, muncul di profil
- **Botpic** — foto profil bot
- **Commands** — daftar command yang muncul di menu autocomplete (contoh: `start - Mulai`, `menu - Buka menu utama`)

---

## 3️⃣ Setup Cloudflare (10 menit)

### 3.1 Daftar akun

Buka https://dash.cloudflare.com/sign-up → daftar dengan email → verifikasi email → login.

**Free tier cukup** untuk bot ini (Workers gratis 100.000 request/hari, KV gratis 100.000 read + 1.000 write/hari).

### 3.2 Login Wrangler ke akun Cloudflare

```bash
wrangler login
```

Browser akan buka otomatis → klik **Allow** → kembali ke terminal, muncul "Successfully logged in."

### 3.3 Bikin KV Namespace

KV = database key-value tempat bot simpan data (produk, user, config, dst).

```bash
wrangler kv namespace create "DB"
```

Output contoh:
```
🌀 Creating namespace with title "telegram-store-bot-DB"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "DB"
id = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
```

**Copy `id` yang panjang itu**, kamu butuh di step berikutnya.

### 3.4 Edit wrangler.toml

Buka file `wrangler.toml`, ganti `your-kv-namespace-id` dengan id dari step 3.3:

```toml
name = "telegram-store-bot"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
MODE = "production"

[[kv_namespaces]]
binding = "DB"
id = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"    ← PASTE DI SINI

[triggers]
crons = ["* * * * *", "0 * * * *"]
```

> 💡 **Info:** `crons` menjalankan job berkala. Yang pertama (`* * * * *`) tiap menit untuk cek payment pending. Yang kedua (`0 * * * *`) tiap jam untuk backup otomatis (kalau JAM_BACKUP di-set).

---

## 4️⃣ Konfigurasi Variables — Paling Penting

> ⚠️ **Section ini yang biasanya bikin bingung.** Baca pelan-pelan, jangan skip.

### 4.1 Konsep: 2 tempat berbeda untuk 2 mode berbeda

> 📌 **`.dev.vars`** → HANYA untuk **DEV MODE** (lokal, `npm run dev`).
> File ini di-`.gitignore`, tidak pernah di-upload ke Cloudflare.
>
> 📌 **`wrangler secret` + `wrangler.toml [vars]`** → HANYA untuk **PRODUCTION** (`wrangler deploy`).
> Dikelola via CLI Wrangler, disimpan di server Cloudflare.
>
> 🚫 **KEDUANYA TIDAK OVERLAP.** Kalau kamu ubah `.dev.vars`, production tidak berubah. Kalau kamu `wrangler secret put`, dev lokal tidak berubah.

Analogi:
- `.dev.vars` = catatan pribadi di laptop kamu
- `wrangler secret` = catatan yang dikirim ke server Cloudflare

Mereka **file & tempat berbeda**, harus di-set dua kali kalau mau nilainya sama di dev & prod.

### 4.2 Tabel referensi SEMUA variable

| Variable | Wajib? | Contoh Nilai | Fungsi | Lokasi Dev | Lokasi Production |
|---|---|---|---|---|---|
| `BOT_TOKEN` | ✅ WAJIB | `1234567890:ABC...` | Token bot dari BotFather | `.dev.vars` plain | `wrangler secret put` |
| `OWNER_ID` | ✅ WAJIB | `6242090623` | User ID admin/owner | `.dev.vars` plain | `wrangler secret put` |
| `OWNER_USERNAME` | opsional | `@usernameanda` | Username owner (untuk display) | `.dev.vars` plain | `[vars]` di wrangler.toml |
| `NAMA_BOT` | opsional | `Tehtarik Bot` | Nama panggilan bot di pesan | `.dev.vars` plain | `[vars]` |
| `STORE_NAME` | opsional | `Tehtarik Store` | Nama toko di header | `.dev.vars` plain | `[vars]` |
| `MODE` | opsional | `development` / `production` | Mode operasi | `development` (auto) | `production` (auto di `[vars]`) |
| `SIMULATE_PAYMENT` | opsional | `false` / `true` | Skip payment gateway (auto-sukses) | `false` biasanya | **`false` WAJIB** di prod |
| `SIMULATE_DELAY` | opsional | `5` | Detik delay sebelum simulate sukses | `5` | `0` di prod |
| `IS_PROD_TOKEN` | opsional | `false` / `true` | Set `true` kalau token dev = token prod | `.dev.vars` plain | tidak dipakai |
| `DEV_TOKEN` | dev-only | `random-string` | Auth untuk endpoint `/dev/*` | `.dev.vars` plain | ❌ jangan di-set |
| `INVOICE_LOGGER` | opsional | `-1001234567890` | Channel/group ID untuk log transaksi | `.dev.vars` plain | `[vars]` atau secret |
| `CHANNEL_LOG` | opsional | `-1001234567890` | Channel general log (jarang dipakai) | `.dev.vars` plain | `[vars]` |
| `CHANNEL_STORE` | opsional | `-1001234567890` | Channel promosi toko | `.dev.vars` plain | `[vars]` |
| `CS` | opsional | `@usernya_cs` | Username customer service | `.dev.vars` plain | `[vars]` |
| `JAM_BACKUP` | opsional | `6` | Jam auto-backup harian (0–23 WIB) | `.dev.vars` plain | `[vars]` |
| `BANNER_FILE_ID` | opsional | `AgACAg...` | Telegram file_id untuk banner | `.dev.vars` plain | `[vars]` |
| `WEBHOOK_SECRET` | opsional | `random-string` | Rahasia webhook Telegram | `.dev.vars` plain | `wrangler secret put` |

> 💡 **Rule sederhana:**
> - **Sensitif** (token, API key) → **`secret`** di production, plain di `.dev.vars`
> - **Non-sensitif** (nama, ID channel) → boleh `[vars]` di `wrangler.toml`

### 4.3 Template `.dev.vars` — copy-paste siap pakai

Di terminal (di dalam folder cf-worker):

```bash
cp .dev.vars.example .dev.vars
```

Buka `.dev.vars` di editor, isi seperti ini:

```bash
# ═══ WAJIB ═══
BOT_TOKEN=1234567890:ABCdef...GHIJKL              # dari @BotFather (bot DEV)
OWNER_ID=6242090623                               # dari @userinfobot
OWNER_USERNAME=@usernameanda

# ═══ Identitas Bot ═══
NAMA_BOT=Tehtarik Bot
STORE_NAME=Tehtarik Store
CS=@usernya_cs

# ═══ Mode ═══
MODE=development
IS_PROD_TOKEN=false        # true = warning kalau token = token production
SIMULATE_PAYMENT=false     # true = payment auto-sukses (skip gateway)
SIMULATE_DELAY=5

# ═══ Dev-only ═══
DEV_TOKEN=any-random-string-min-8-char

# ═══ Channel Log (isi setelah bikin channel — lihat Section 8) ═══
INVOICE_LOGGER=                # -1001234567890
CHANNEL_LOG=
CHANNEL_STORE=

# ═══ Backup Otomatis (isi setelah baca Section 9) ═══
JAM_BACKUP=6                   # jam WIB backup harian (0-23)

# ═══ Banner (opsional) ═══
BANNER_FILE_ID=
```

> 🔒 **JANGAN** commit file `.dev.vars` ke git. Sudah di `.gitignore` secara default, jangan diubah.

### 4.4 Cara set variable di PRODUCTION (Cloudflare)

Ada **2 cara** tergantung tipe variable:

#### A. Secret (untuk data sensitif — token, API key)

```bash
wrangler secret put BOT_TOKEN
# Terminal minta input: paste token, tekan Enter
# → "Success! Uploaded secret BOT_TOKEN"

wrangler secret put OWNER_ID
# → paste OWNER_ID kamu

wrangler secret put WEBHOOK_SECRET
# → paste random string
```

**Lihat daftar secret yang sudah di-set:**
```bash
wrangler secret list
```
Output:
```json
[
  { "name": "BOT_TOKEN", "type": "secret_text" },
  { "name": "OWNER_ID", "type": "secret_text" }
]
```

> Nilai secret **tidak ditampilkan** setelah di-set (keamanan). Kalau lupa, harus `put` ulang.

**Hapus secret:**
```bash
wrangler secret delete BOT_TOKEN
```

#### B. Plain vars (untuk data non-sensitif)

Edit `wrangler.toml`, tambah baris di `[vars]` block:

```toml
[vars]
MODE = "production"
SIMULATE_PAYMENT = "false"
NAMA_BOT = "Tehtarik Bot"
STORE_NAME = "Tehtarik Store"
OWNER_USERNAME = "@usernameanda"
CS = "@usernya_cs"
JAM_BACKUP = "6"
INVOICE_LOGGER = "-1001234567890"
CHANNEL_LOG = ""
CHANNEL_STORE = ""
BANNER_FILE_ID = ""
```

Semua nilai di `[vars]` **kelihatan di file** (jadi jangan taruh token di sini).

Atur ulang perlu **redeploy**:
```bash
wrangler deploy
```

### 4.5 Verifikasi konfigurasi

**Untuk dev:**
```bash
cat .dev.vars    # cek isi (jangan share output ini!)
```

**Untuk production:**
```bash
wrangler secret list       # cek secret yang sudah di-set
cat wrangler.toml          # cek [vars] block
```

---

## 5️⃣ Jalankan Dev Mode (5 menit)

### 5.1 Start dev server

```bash
npm run dev
```

Output yang muncul di terminal:
```
🤖 Bot @tehtarik_dev_bot online (dev mode)
📡 Listening on http://localhost:8787
📚 Dev endpoints:
   GET  /dev/info
   GET  /dev/kv                (list keys)
   GET  /dev/kv/:key           (read value)
   POST /dev/kv/:key           (set value)
   DELETE /dev/kv/:key         (delete)
   POST /dev/simulate-pakasir-webhook
   POST /dev/simulate-duitku-webhook
⚡ Polling started, offset=0
```

> ⚠️ Kalau muncul warning **"IS_PROD_TOKEN=true"** → kamu pakai token production di dev. STOP dulu, ganti ke token bot dev, restart. Ini untuk cegah update tidak sengaja ke bot live.

### 5.2 Test bot di Telegram

1. Buka Telegram, cari bot **DEV** kamu (`@tehtarik_dev_bot`)
2. Kirim `/start`
3. Bot harus balas dengan sapaan

**Kalau bot tidak balas:**
- Cek terminal: ada error apa?
- Cek `.dev.vars`: `BOT_TOKEN` benar? (test paste ke browser: `https://api.telegram.org/bot<TOKEN>/getMe` — harus balas JSON info bot)
- Restart: `Ctrl+C` → `npm run dev` lagi

### 5.3 Test admin panel

Kirim `/adminmenu` dari akun Telegram yang OWNER_ID-nya sama dengan yang di `.dev.vars`.

Harus muncul menu admin dengan tombol Settings, Statistik, dst.

**Kalau muncul "Kamu bukan owner":**
- OWNER_ID salah. Cek lagi via @userinfobot, update `.dev.vars`, restart.

### 5.4 Hot-reload (auto-restart)

Dev server pakai `node --watch`. Kalau kamu edit file `src/*.js`, server restart otomatis. Buka bot lagi, langsung update.

**Tidak auto-restart** untuk:
- Ubah `.dev.vars` → harus manual `Ctrl+C` → `npm run dev`
- Ubah `wrangler.toml` → tidak berpengaruh di dev (dev-server tidak baca wrangler.toml)

### 5.5 Utility dev

```bash
# Lihat semua data KV lokal
curl http://localhost:8787/dev/kv

# Baca 1 key
curl http://localhost:8787/dev/kv/BotConfig

# Set value (test data)
curl -X POST http://localhost:8787/dev/kv/Voucher \
     -H 'Content-Type: application/json' \
     -d '[{"code":"HEMAT10","discount":10}]'

# Hapus key
curl -X DELETE http://localhost:8787/dev/kv/Voucher

# Snapshot semua KV ke file JSON (backup lokal)
npm run kv:snap

# List snapshot yang ada
npm run kv:list

# Restore snapshot
npm run kv:load
```

### 5.6 Simulate payment webhook di dev

Saat testing deposit/purchase, kamu tidak perlu bayar beneran. Pakai simulate:

```bash
# Simulate Pakasir sukses (pakai session pending terakhir)
curl -X POST http://localhost:8787/dev/simulate-pakasir-webhook \
     -H 'Content-Type: application/json' -d '{}'

# Simulate Duitku sukses
curl -X POST http://localhost:8787/dev/simulate-duitku-webhook \
     -H 'Content-Type: application/json' -d '{}'
```

Atau langsung dari bot: pas ada QR pembayaran, tekan tombol **🧪 Simulasi Bayar** (hanya muncul di mode sandbox).

---

## 6️⃣ Deploy ke Production (10 menit)

### 6.1 Pre-deploy checklist

Sebelum `wrangler deploy`, pastikan:

- [ ] `wrangler.toml` sudah punya KV `id` production (bukan `your-kv-namespace-id`)
- [ ] `wrangler secret list` menampilkan **minimal** `BOT_TOKEN` dan `OWNER_ID`
- [ ] `[vars]` di `wrangler.toml` **TIDAK** berisi `BOT_TOKEN` (harus secret, bukan var!)
- [ ] `MODE = "production"` di `[vars]`
- [ ] `SIMULATE_PAYMENT = "false"` di `[vars]` (jangan `true` di prod!)
- [ ] Sudah pakai **BOT_TOKEN production** (bot yang berbeda dari dev)

### 6.2 Deploy

```bash
wrangler deploy
```

Output contoh:
```
Total Upload: 145.32 KiB / gzip: 42.11 KiB
Uploaded telegram-store-bot (3.4 sec)
Published telegram-store-bot (0.5 sec)
  https://telegram-store-bot.your-account.workers.dev
Current Deployment ID: abc-def-123
```

**Copy URL** yang muncul (`https://telegram-store-bot.your-account.workers.dev`). Kamu butuh untuk step berikutnya.

### 6.3 Set Telegram webhook (WAJIB setelah deploy pertama)

Buka URL ini di browser (ganti dengan URL kamu):

```
https://telegram-store-bot.your-account.workers.dev/setup
```

Response JSON:
```json
{
  "ok": true,
  "telegram": { "ok": true, "result": true, "description": "Webhook was set" },
  "pakasir_webhook": "https://telegram-store-bot.your-account.workers.dev/pakasir-webhook",
  "duitku_webhook":  "https://telegram-store-bot.your-account.workers.dev/duitku-webhook",
  "duitku_return":   "https://telegram-store-bot.your-account.workers.dev/duitku-return"
}
```

**Simpan URL webhook** (pakasir & duitku). Kamu butuh saat setup gateway di Section 7.

### 6.4 Verifikasi bot production

1. Buka Telegram, cari bot **PRODUCTION** kamu
2. Kirim `/start` → harus balas
3. Kirim `/adminmenu` dari akun owner → muncul admin panel
4. Test health endpoint:
   ```
   https://telegram-store-bot.your-account.workers.dev/health
   ```
   Harus balas `OK` atau JSON status.

### 6.5 Live log production

Untuk lihat log real-time (debugging error):

```bash
wrangler tail
```

Setiap request ke worker akan tampil di terminal. `Ctrl+C` untuk stop.

### 6.6 Update / redeploy

Setiap kali kamu edit code, jalankan lagi:
```bash
wrangler deploy
```

Webhook **tidak perlu** di-set ulang (URL sama). Cukup deploy → langsung live.

---

## 7️⃣ Setup Payment Gateway

Semua config gateway diatur **dari dalam bot**, bukan dari env var atau file. Alasan: gampang ganti tanpa redeploy.

### 7.1 Pakasir

1. Buka bot production di Telegram
2. Kirim `/adminmenu` (dari akun owner)
3. Klik **💠 Settings → 💳 Setting Payment → 🅿️ Pakasir**
4. Isi berurutan:
   - **Toggle Enable** → jadi 🟢 Aktif
   - **Mode** → `Sandbox` (untuk testing) atau `Production` (untuk live)
   - **Slug** → dari dashboard Pakasir (contoh: `mytoko`)
   - **API Key** → dari dashboard Pakasir
   - **Metode** → `QRIS` atau `VA` (Virtual Account)
   - **Fee** → set persen + nominal (opsional; default 0)
5. Klik **🧪 Test Koneksi** → harus tampil `✅ Koneksi OK`
6. Klik **✅ Jadikan Active Gateway**

**Set webhook di dashboard Pakasir:**

Buka https://pakasir.zone.id/ → Setting Project → Webhook URL → paste:
```
https://telegram-store-bot.your-account.workers.dev/pakasir-webhook
```

### 7.2 Duitku (QRIS-only)

1. `/adminmenu → 💠 Settings → 💳 Setting Payment → 🅳 Duitku (QRIS)`
2. Isi:
   - **Toggle Enable** → 🟢 Aktif
   - **Mode** → `Sandbox` / `Production`
   - **Merchant Code** → dari dashboard Duitku (contoh: `D14042`)
   - **API Key** → dari dashboard Duitku
   - **QRIS Provider** → pilih salah satu:
     - **SP** (Shopee QRIS) — ⭐ default, expiry max 60 menit
     - **NQ** (Nobu QRIS) — expiry max 1440 menit (24 jam)
     - **GQ** (Gudang Voucher QRIS) — expiry max 60 menit
     - **SQ** (Nusapay QRIS) — expiry max 60 menit
   - **Fee** → **independen** dari Pakasir; set persen + nominal (opsional)
   - **Expiry** → menit; auto-clamp ke max provider
   - **Verify IP** → biarkan `OFF` kecuali kamu tahu Cloudflare Workers punya IP tetap
3. **🧪 Test Koneksi** → harus `✅ Koneksi OK`
4. **✅ Jadikan Active Gateway** (kalau mau ganti dari Pakasir ke Duitku)

**Set di dashboard Duitku:**
- **Callback URL**: `https://telegram-store-bot.your-account.workers.dev/duitku-webhook`
- **Return URL**: `https://telegram-store-bot.your-account.workers.dev/duitku-return`

### 7.3 Switch active gateway

Cuma **1 gateway** yang bisa active sekaligus. User yang deposit/beli akan pakai gateway itu.

Ganti active kapan saja lewat menu Pakasir/Duitku → **✅ Jadikan Active Gateway**.

> 💡 Session pembayaran **lama** tetap pakai gateway lama (snapshot per session). Jadi user yang lagi bayar tidak terganggu waktu kamu ganti gateway.

---

## 8️⃣ Setup Channel Log (Detail)

> ⚠️ **Kenapa perlu channel log?**
> Bot ini bikin log transaksi (deposit sukses, purchase, invoice) yang kamu perlu untuk audit & rekonsiliasi. Kalau tidak di-set, log hilang di ether — hanya console log yang bisa kamu lihat via `wrangler tail`.

### 8.1 Apa itu channel log?

Channel Telegram (bisa channel atau group) tempat bot **kirim otomatis** ringkasan aktivitas penting:
- 🧾 Setiap deposit sukses → pesan ke channel
- 🛒 Setiap purchase sukses → pesan ke channel
- ⏱ Transaksi kadaluwarsa → notifikasi
- ⚠ Error stok / produk hilang saat payment sukses → alert
- 📡 Notifikasi backup terkirim (kalau backup aktif)

Ada **2 channel log** yang bisa kamu setup:

| Variable | Fungsi | Rekomendasi |
|---|---|---|
| `INVOICE_LOGGER` | Log transaksi (deposit, purchase, invoice) | **Wajib** kalau kamu jualan beneran |
| `CHANNEL_LOG` | Log general (opsional, jarang dipakai) | Skip kalau bingung |
| `CHANNEL_STORE` | Channel promosi toko (bukan log) | Skip kalau tidak punya channel promo |

### 8.2 Bikin channel Telegram untuk log

1. Di Telegram, klik **New Channel** (menu tiga garis → New Channel)
2. Nama channel: `Tehtarik Bot Logs` (bebas)
3. Type: **Private** (rekomendasi — biar hanya kamu yang bisa lihat)
4. Skip "Add Subscribers" (kamu sudah otomatis admin)
5. Channel dibuat.

### 8.3 Add bot sebagai admin ke channel

1. Buka channel yang baru dibuat
2. Klik **nama channel** di atas → **Administrators → Add Admin**
3. Cari bot production kamu (`@tehtarik_store_bot`) → pilih
4. Aktifkan permission minimal:
   - ✅ **Post Messages**
5. Klik **Save**

> 🚫 Kalau bot bukan admin channel, dia tidak bisa kirim pesan. Log akan silent gagal.

### 8.4 Ambil Channel ID

Channel ID Telegram formatnya `-100XXXXXXXXX` (angka negatif diawali `-100`).

**Cara ambil:**
1. Di channel, kirim pesan sembarang (dari akun kamu sendiri)
2. Klik/tap pesan itu → **Copy Link**
3. Link berbentuk: `https://t.me/c/1234567890/1`
4. Ambil angka `1234567890` → tambah prefix `-100` → jadi `-1001234567890`

**Atau pakai bot** @userinfobot: forward salah satu pesan dari channel ke @userinfobot, dia tampilkan Chat ID.

### 8.5 Set variable INVOICE_LOGGER

**Dev:**
```bash
# Edit .dev.vars
INVOICE_LOGGER=-1001234567890
```
Lalu restart `npm run dev`.

**Production:**
```bash
# Opsi A: sebagai secret (kalau kamu anggap channel ID sensitif)
wrangler secret put INVOICE_LOGGER
# → paste -1001234567890

# Opsi B: sebagai plain var di wrangler.toml
[vars]
INVOICE_LOGGER = "-1001234567890"
```
Lalu `wrangler deploy`.

### 8.6 Test channel log

Di dev:
1. `npm run dev` sudah jalan
2. Test deposit → tekan **🧪 Simulasi Bayar** untuk trigger sukses
3. Buka channel → harus muncul pesan `*DEPOSIT BERHASIL ✅ ...*`

Di production:
1. Lakukan deposit test (nominal kecil, misal Rp 1.000)
2. Setelah bayar, buka channel log → pesan muncul dalam < 5 detik

### 8.7 Contoh pesan yang muncul di channel

**Deposit sukses:**
```
*DEPOSIT BERHASIL ✅*

User: Andi
Amount: Rp 50.000
Tanggal: 23/07/2026 14:32
```

**Transaksi kadaluwarsa:**
```
*⏱ Transaksi Kadaluwarsa*
ID: DPXXXX
User: Andi
Amount: Rp 50.000
```

**Alert stok kosong saat sukses:**
```
*⚠ Stok tidak cukup!
User: Andi
Trx: TRXXX
```

---

## 9️⃣ Setup Backup Otomatis

> 💡 **Kenapa perlu backup?**
> KV Cloudflare cukup reliable, tapi kalau kamu tidak sengaja delete data (misal salah command wrangler kv), tidak ada undo. Backup otomatis kirim JSON snapshot semua data ke Telegram kamu, jadi kamu punya salinan yang bisa di-restore manual.

### 9.1 Cara kerja

Bot punya cron job yang jalan setiap jam (`0 * * * *`). Kalau jam saat ini sama dengan `JAM_BACKUP` (dalam WIB), bot akan:

1. Baca semua key penting dari KV: `Kategori`, `Produk`, `SnK`, `Trx`, `UserList`, `Role`, `BannedUser`, `Voucher`, `OrderCounter`, `BotConfig`, `StokKeluar`, `StokBaru`
2. Serialisasi jadi 1 file JSON: `backup_YYYY_MM_DD_HH_mm.json`
3. Kirim file itu ke **owner Telegram (DM)** via `tgSendDocument`
4. Kirim notifikasi ke `INVOICE_LOGGER` kalau di-set: `📡 Auto backup terkirim ke owner: 2026_07_23_...`

Jadi backup **tidak** ke channel — ke DM kamu langsung sebagai file JSON.

### 9.2 Set JAM_BACKUP

**Dev:**
```bash
# .dev.vars
JAM_BACKUP=6                # jam 06:00 WIB
```

**Production:**
```toml
# wrangler.toml
[vars]
JAM_BACKUP = "6"
```
Lalu `wrangler deploy`.

> Range valid: `0` (jam 00:00) sampai `23` (jam 23:00). Kalau kosong / tidak di-set, backup **tidak jalan**.

### 9.3 Test backup manual

Backup cron production hanya jalan pas jamnya cocok. Untuk test tanpa nunggu:

**Cara 1 — set JAM_BACKUP ke jam saat ini + 1**

Kalau sekarang jam 14 WIB, set `JAM_BACKUP=15`, deploy, tunggu 1 jam. File masuk ke DM kamu.

**Cara 2 — test di dev**

Di dev, buka file `src/backup.js`, panggil `autoBackup(env)` manual dari console. Atau bisa dari dev endpoint (kalau kamu tambahin) — belum ada by default.

### 9.4 Restore dari backup

Backup file adalah JSON dengan struktur:
```json
{
  "Kategori": [...],
  "Produk": [...],
  "UserList": [...],
  ...
}
```

Untuk restore:
1. Download file backup dari DM Telegram
2. Pakai script:
   ```bash
   npm run kv:load -- --file=backup_2026_07_23_06_00.json
   ```
   (Ini restore ke KV **lokal dev**, bukan production. Untuk production butuh custom script — belum built-in.)

**Untuk restore ke production**, sementara harus manual per key:
```bash
wrangler kv key put --binding=DB "Kategori" "$(cat backup.json | jq '.Kategori')"
wrangler kv key put --binding=DB "Produk"  "$(cat backup.json | jq '.Produk')"
# ... dst per key
```

---

## 🔟 Deploy via GitHub Actions (CI/CD)

> 🤖 **Section ini opsional.** Skip kalau kamu deploy manual sudah cukup. Baca kalau kamu mau setiap `git push` otomatis deploy ke production.

### 10.1 Apa yang dicapai section ini?

Setelah setup selesai:

```
Kamu edit code → git push origin main
                        ↓
            GitHub terima push
                        ↓
         GitHub Actions jalan otomatis
                        ↓
              wrangler deploy
                        ↓
              Bot production update dalam ~30 detik
```

Tanpa kamu ketik `wrangler deploy` manual.

### 10.2 Prasyarat

- [ ] Punya akun GitHub (https://github.com/signup)
- [ ] Punya Git terinstall (https://git-scm.com/downloads)
- [ ] Sudah familiar `git init`, `git commit`, `git push` (kalau belum, baca https://docs.github.com/en/get-started/quickstart)
- [ ] Bot sudah pernah di-deploy manual (Section 6) minimal 1× — untuk pastikan konfigurasi benar

### 10.3 Push project ke GitHub

**Kalau project belum di GitHub:**

1. Buka https://github.com/new
2. Repository name: `telegram-store-bot` (atau bebas)
3. Visibility: **Private** (rekomendasi kuat! karena code punya struktur bot kamu)
4. Klik **Create repository**
5. Di terminal (dalam folder cf-worker):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/USERNAME/telegram-store-bot.git
   git push -u origin main
   ```

> ⚠️ **PENTING:** Pastikan `.gitignore` sudah include `.dev.vars`, `node_modules/`, `.wrangler/`. Kalau tidak, secret bocor ke repo publik.
>
> Cek: `cat .gitignore` — harus ada baris `.dev.vars`.

### 10.4 Bikin Cloudflare API Token

GitHub Actions butuh **API Token Cloudflare** untuk bisa deploy. Ini beda dari `wrangler login` (yang cuma di komputer kamu).

1. Buka https://dash.cloudflare.com/profile/api-tokens
2. Klik **Create Token**
3. Pilih template **"Edit Cloudflare Workers"** → klik **Use template**
4. Scroll ke bawah, klik **Continue to summary** → **Create Token**
5. **COPY TOKEN** yang muncul (formatnya panjang, ~40 karakter). Ini muncul **hanya sekali**.

> 🔐 Token ini adalah kunci akses ke akun Cloudflare kamu untuk Workers. Kalau bocor, orang bisa deploy code jahat ke worker kamu. **Jangan pernah share atau commit ke git.**

### 10.5 Ambil Cloudflare Account ID

1. Buka https://dash.cloudflare.com
2. Di sidebar kanan, ada **Account ID** — copy nilainya (32 karakter hex).

### 10.6 Add secrets ke GitHub repo

1. Buka repo GitHub kamu → **Settings** (tab paling kanan)
2. Sidebar kiri: **Secrets and variables → Actions**
3. Klik **New repository secret**
4. Add 2 secret ini:

   | Name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | (token dari step 10.4) |
   | `CLOUDFLARE_ACCOUNT_ID` | (account ID dari step 10.5) |

5. Save.

### 10.7 Bikin file workflow

Di komputer kamu (folder cf-worker), bikin folder + file:

```bash
mkdir -p .github/workflows
```

Bikin file `.github/workflows/deploy.yml` isi:

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]     # deploy tiap push ke branch main
  workflow_dispatch:      # bisa trigger manual dari UI GitHub

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

### 10.8 Test deploy otomatis

```bash
git add .github/workflows/deploy.yml
git commit -m "Add CI/CD workflow"
git push
```

1. Buka repo GitHub → tab **Actions**
2. Kamu lihat workflow **Deploy to Cloudflare Workers** lagi jalan (bulatan kuning)
3. Klik untuk lihat log real-time
4. Kalau hijau ✅ → berhasil, cek bot production sudah update
5. Kalau merah ❌ → klik untuk lihat error, kemungkinan:
   - Secret salah / tidak ada → cek Settings → Secrets
   - `wrangler.toml` KV id salah → cek konfigurasi

### 10.9 Trigger manual (tanpa push)

Kadang kamu mau redeploy tanpa perubahan code (misal setelah update secret):

1. Repo GitHub → tab **Actions**
2. Pilih workflow **Deploy to Cloudflare Workers**
3. Klik **Run workflow** → pilih branch `main` → **Run workflow**

### 10.10 Best practices CI/CD

- **Branch protection:** Di GitHub → Settings → Branches → Add rule → protect `main`. Nonaktifkan direct push, require pull request. Deploy hanya jalan pas PR di-merge.
- **Preview deployment:** Bikin workflow kedua yang deploy branch `dev` ke worker terpisah (`telegram-store-bot-dev`). Butuh 2 wrangler.toml atau `--env` flag.
- **Rollback:** Kalau deploy bikin bug, `wrangler rollback` atau revert commit + push ulang.
- **Notifikasi:** Add step di workflow yang kirim pesan ke Telegram/Slack kalau deploy sukses/gagal.
- **Test dulu:** Selalu `npm run dev` + test lokal SEBELUM push ke main. CI/CD tidak menggantikan testing manual.

---

## 1️⃣1️⃣ Troubleshooting

| Gejala | Kemungkinan Penyebab | Solusi |
|---|---|---|
| Bot tidak balas `/start` (dev) | Token salah / dev-server tidak jalan | Cek `.dev.vars` BOT_TOKEN; restart `npm run dev`; cek terminal error |
| Bot tidak balas (production) | Webhook belum di-set setelah deploy | Buka `https://your-bot.../setup` di browser |
| `/adminmenu` bilang "bukan owner" | `OWNER_ID` salah | Verifikasi via @userinfobot, update env, restart/redeploy |
| KV "Namespace not found" saat deploy | KV `id` di wrangler.toml belum di-isi | `wrangler kv namespace create "DB"`, paste `id` ke wrangler.toml |
| Payment gagal (production) | Gateway belum aktif / config salah | `/adminmenu → Settings → Payment → gateway → Test Koneksi` |
| Webhook Pakasir/Duitku tidak nyampe | URL salah di dashboard gateway | Copy URL dari response `/setup`, paste ke dashboard gateway |
| "Invalid signature" di webhook Duitku | API Key tidak sinkron antara bot & Duitku | Sinkronkan API Key di admin panel bot dan dashboard Duitku |
| Log tidak muncul di channel | Bot bukan admin channel / ID channel salah | Add bot sebagai admin channel (Section 8.3); verifikasi ID |
| Backup otomatis tidak jalan | `JAM_BACKUP` kosong atau jam salah | Set `JAM_BACKUP=6` (jam WIB, 0-23), redeploy |
| Bot balas 2× tiap pesan | Ada 2 instance jalan (dev + prod pakai token sama) | Set `IS_PROD_TOKEN=false`, pastikan bot dev ≠ bot prod |
| `wrangler deploy` error "unauthorized" | Belum `wrangler login` atau token expired | `wrangler login` ulang |
| GitHub Actions gagal "401 Unauthorized" | `CLOUDFLARE_API_TOKEN` di secret GitHub salah | Regenerate token di dashboard Cloudflare, update secret GitHub |
| Duitku QR tidak muncul di bot | Provider di-set salah / expiry > max | Ganti ke SP (default), set expiry ≤ 60 menit |
| Fee muncul beda antara Pakasir & Duitku | **Normal** — fee independen per gateway | Set fee terpisah di masing-masing menu gateway |
| Bot dev balas tapi bot prod diam | Webhook prod belum di-register | Buka `/setup` production di browser |

---

## 1️⃣2️⃣ Command Cheat Sheet

```bash
# ═══════ DEV ═══════
npm run dev                              # start dev server (polling + hot-reload)
npm run dev:once                         # start dev tanpa watch mode
npm run kv:snap                          # snapshot KV lokal ke JSON
npm run kv:list                          # list snapshot yang ada
npm run kv:load                          # restore snapshot ke KV lokal
curl http://localhost:8787/dev/info      # info dev server
curl http://localhost:8787/dev/kv        # list KV keys
curl http://localhost:8787/dev/kv/BotConfig    # baca 1 key
curl -X POST http://localhost:8787/dev/simulate-pakasir-webhook -d '{}'
curl -X POST http://localhost:8787/dev/simulate-duitku-webhook -d '{}'

# ═══════ PRODUCTION ═══════
wrangler deploy                          # deploy ke Cloudflare Workers
wrangler deploy:dry                      # simulate deploy (tidak beneran)
wrangler secret put BOT_TOKEN            # set secret (prompt paste value)
wrangler secret list                     # list nama secret
wrangler secret delete BOT_TOKEN         # hapus secret
wrangler tail                            # live log production (real-time)
wrangler kv namespace list               # list KV namespaces
wrangler kv key list --binding=DB        # list KV keys production
wrangler kv key get "BotConfig" --binding=DB   # baca 1 key
wrangler kv key put "KeyName" "value" --binding=DB   # tulis 1 key
wrangler kv key delete "KeyName" --binding=DB  # hapus 1 key
curl https://your-bot.../setup           # register webhook Telegram
curl https://your-bot.../health          # health check

# ═══════ GIT + CI/CD ═══════
git add . && git commit -m "..." && git push    # trigger auto-deploy
# ...atau trigger manual di GitHub → Actions → Run workflow
```

---

## 1️⃣3️⃣ FAQ + Glosarium

### FAQ

**Q: `.dev.vars` sama dengan `.env`?**
A: Konsep sama, format sama (baris `KEY=VALUE`), tapi khusus untuk Wrangler / dev-server bot ini. Bukan `.env` standar Node.

**Q: Kalau saya set BOT_TOKEN di `[vars]` bukan `secret`, kenapa?**
A: Bisa jalan, **tapi tidak aman.** `wrangler.toml` di-track git; kalau repo public/dibagikan, token bocor. Pakai `wrangler secret put` untuk data sensitif.

**Q: KV di dev sama dengan production?**
A: **Tidak.** Dev pakai file lokal di `.wrangler/state/v3/kv/`. Prod pakai KV di server Cloudflare. Datanya terpisah.

**Q: Perlu ngrok / port-forward untuk dev?**
A: **Tidak.** Dev-server pakai polling ke Telegram (bot minta update tiap detik), tidak butuh URL public.

**Q: Bot production perlu polling atau webhook?**
A: **Webhook** (auto-set via `/setup`). Lebih cepat, hemat quota, dan skalable.

**Q: Bisa jalankan dev + prod bersamaan dengan bot token sama?**
A: **Tidak.** Telegram cuma boleh 1 mode per token (webhook ATAU polling). Kalau dev polling + prod webhook di token yang sama, bot akan balas 2×. Pakai bot berbeda untuk dev & prod.

**Q: Berapa harga Cloudflare Workers untuk bot ini?**
A: **Gratis** untuk pemakaian normal (< 100.000 request/hari). Paid plan mulai $5/bulan untuk 10 juta request. KV free 100.000 read + 1.000 write/hari.

**Q: Kalau saya salah delete data di production, bisa restore?**
A: **Hanya kalau backup otomatis aktif** (Section 9). Cloudflare KV tidak punya trash / undo.

**Q: Perlu domain sendiri (`your-bot.com`)?**
A: **Tidak wajib.** URL `.workers.dev` sudah cukup untuk bot Telegram (Telegram tidak butuh domain custom, hanya butuh HTTPS).

**Q: Bot bisa auto-jual produk digital?**
A: **Ya**, itu tujuan utama bot ini. Set produk + varian + stok dari admin panel, user beli via QRIS, auto-kirim item dari stok.

### Glosarium

- **Cloudflare Workers** — platform serverless tempat bot ini dijalankan (JavaScript di-execute di edge server global)
- **KV (Key-Value)** — database sederhana Cloudflare (mirip Redis kecil), tempat bot simpan produk/user/config
- **Wrangler** — CLI resmi Cloudflare untuk kelola Workers (deploy, secret, KV)
- **Webhook** — URL yang menerima push update dari Telegram (production pakai ini)
- **Polling** — bot minta update ke Telegram tiap detik (dev-server pakai ini)
- **Secret vs Var** — secret disembunyikan (dilihat cuma nama), var terlihat di wrangler.toml
- **Sandbox** (payment) — mode testing gateway, transaksi tidak beneran ditagih
- **Production** (payment) — mode live, transaksi asli dan uang beneran masuk
- **BotFather** — bot resmi Telegram (@BotFather) untuk bikin & manage bot
- **CI/CD** — Continuous Integration / Continuous Deployment, otomatisasi test & deploy
- **Cron trigger** — jadwal berkala yang dijalankan Cloudflare Workers (contoh: cek payment tiap menit)

---

## 1️⃣4️⃣ Next Steps

Setelah bot live, kamu bisa:

1. **Baca `AGENTS.md`** untuk paham semua fitur & changelog
2. **Baca `DEV.md`** untuk detail dev workflow yang lebih dalam
3. **Setup kategori & produk pertama** via admin panel: `/adminmenu → 📦 Produk → ➕ Tambah Kategori`
4. **Broadcast pertama** ke user: `/adminmenu → 📢 Broadcast → 📝 Text` atau `/bc` reply pesan
5. **Test end-to-end** — deposit → beli produk → kirim ke buyer
6. **Aktifkan role admin lain** kalau butuh: `/adminmenu → 👥 Role`
7. **Monitor via `wrangler tail`** untuk lihat error real-time
8. **Setup Backup Otomatis** (Section 9) — WAJIB kalau kamu jualan beneran
9. **Setup channel promosi** (kalau `CHANNEL_STORE` di-set) untuk umumkan restock/promo

### Link berguna

- Cloudflare Workers Docs: https://developers.cloudflare.com/workers/
- Wrangler CLI Docs: https://developers.cloudflare.com/workers/wrangler/
- Telegram Bot API: https://core.telegram.org/bots/api
- Pakasir Dashboard: https://pakasir.zone.id/
- Duitku Dashboard: https://dashboard.duitku.com/
- Duitku API Docs (Indonesia): https://docs.duitku.com/api/id/

---

### 🎉 Selamat!

Kalau kamu sudah sampai sini dan semua step berjalan, botmu sudah **live dan siap terima order**. Semoga sukses jualannya!

> Kalau ada masalah, cek [Troubleshooting](#1️⃣1️⃣-troubleshooting) atau lihat error di `wrangler tail` (production) atau terminal `npm run dev` (lokal).


---

### 4.6 🏷️ Ganti Nama Bot / Nama Toko tanpa Restart (v9update16+)

Mulai v9update16, kamu bisa ganti `NamaBot` dan `StoreName` **langsung dari dalam bot** tanpa perlu restart `npm run dev` atau `wrangler deploy`.

**Cara:**
1. Chat bot kamu → kirim `/admin`
2. Pilih `⚙️ Settings` → `🏷️ Identitas Bot (Nama)`
3. Klik `🤖 Ganti Nama Bot` atau `🏪 Ganti Nama Toko`
4. Kirim nama baru → langsung aktif di semua tempat (file txt, ID order, footer)

**Prioritas nilai:** override KV (dari admin menu) > env var (`.dev.vars` / secret) > default `"Tehtarik Store"`.

**Reset ke env:** klik `♻️ Reset ke Env` — hapus override KV, balik ambil dari `NAMA_BOT` env.

> 💡 Kalau kamu cuma test-test, pakai admin menu (metode ini). Kalau nama final permanen, tetap update `NAMA_BOT` di env supaya konsisten kalau KV di-flush.

---

## 5. Voucher & Redeem System (v9update17)

Sistem kupon bonus saldo. Admin buat batch kode, user tukar via `/redeem`.

### 5.1 Buka Menu Voucher

1. Chat bot → `/admin`
2. Klik `🎫 Voucher & Redeem`
3. Tampil ringkasan: kode aktif, terpakai, total batch

### 5.2 Generate Kode Baru (Wizard 4-Step)

Klik `➕ Generate Kode Baru`:

**STEP 1/4 — Prefix**
- Ketik 2-5 huruf/angka (A-Z, 0-9) untuk 3-4 karakter pertama kode
- Contoh: `RMZ`, `TOKO`, `GIFT`, `PROMO`
- Atau klik `✅ Pakai Default` (otomatis dari `NamaBot`)

**STEP 2/4 — Nominal**
- Ketik angka Rp bonus per kode
- Min Rp 100, Max Rp 1.000.000
- Contoh: `5000`, `10000`, `50000`

**STEP 3/4 — Jumlah**
- Ketik berapa kode yang mau dibuat
- Min 1, Max 500 per generate
- Contoh: `10`, `50`, `100`

**STEP 4/4 — Masa Berlaku (Fleksibel)**
- `30m` atau `30 menit` → 30 menit
- `2h`  atau `2 jam`   → 2 jam
- `7d`  atau `7 hari`  → 7 hari
- Klik `♾️ Tanpa Expired` untuk kode selamanya
- Min 1 menit, Max 365 hari

**Konfirmasi**
- Lihat total nilai (`Bonus × Jumlah = Total Rp`)
- Klik `✅ Ya, Generate!` → bot buat kode acak semua unik
- Hasil dikirim sebagai file `voucher_<batchId>.txt` (bisa didownload)

### 5.3 Broadcast Kode ke User

Setelah generate, atau dari detail batch, klik `📢 Broadcast Kode`:

- **Mode:** Privat (1 kode unik per user, semua terpakai fair)
- Konfirmasi menampilkan: kode siap vs jumlah user aktif
- Warning otomatis kalau kode < user (sebagian tidak dapat)
- Klik `✅ Ya, Kirim Sekarang` → bot loop kirim ke UserList
- User dapat message: bonus, kode unik, cara redeem (`/redeem <KODE>`)

### 5.4 Daftar & Detail Batch

Menu `📋 Daftar Batch`:
- List 20 batch terbaru
- Format: `<icon> <prefix> • <nominal> • <used>/<total>`
- Icon: 🟢 aktif, ⚪ habis (semua dipakai), ⚠️ expired, 🔴 revoked

Klik salah satu batch → detail:
- Info: ID, prefix, tgl dibuat, bonus, total, terpakai, sisa, expired, broadcast status
- Action: `📄 Download File`, `📢 Broadcast`, `❌ Revoke Sisa`

### 5.5 Revoke Batch

Untuk membatalkan kode sisa (mis. salah generate):

1. Buka detail batch → klik `❌ Revoke Sisa Kode`
2. Konfirmasi → kode aktif sisa jadi status `revoked`
3. **Kode yang sudah dipakai TIDAK terpengaruh** (saldo user aman)

### 5.6 Statistik

Menu `📊 Statistik`:
- Total kode aktif / terpakai / expired / revoked
- Total nominal saldo yang sudah dibagikan
- 3 redeem terakhir (tanggal + userId + nominal)

### 5.7 Cara User Redeem

User chat bot → ketik:
```
/redeem RMZ-K3P9-8FZW
```

Respons sukses:
- Menampilkan kode, bonus, saldo sebelum & sesudah
- Bonus langsung masuk saldo
- Log terkirim ke `InvoiceLogger` channel

Respons gagal (7 jenis error):
- `format` — format kode salah
- `notfound` — kode tidak ada
- `used` — sudah dipakai user lain (tampil tanggalnya)
- `expired` — kadaluarsa (tampil sejak kapan)
- `revoked` — dibatalkan admin
- `locked` — concurrent redeem (coba lagi 10 detik)
- `banned` — user diblokir dari sistem

Tanpa argumen (`/redeem`) → tampilkan bantuan format.

### 5.8 Kode Random & Keamanan

**Format kode:**
```
<PREFIX>-XXXX-XXXX
```

- Prefix: 2-5 karakter (custom per batch)
- XXXX: 4 karakter dari set `[A-HJ-NP-Z2-9]` (32 char, exclude I O 0 1 supaya tidak ambigu saat baca)
- Total entropi: 32⁸ ≈ 1,1 triliun kemungkinan per prefix

**Layer keamanan:**
1. Regex validation pas parsing
2. `acquireLock('redeem_' + userId, 10s)` — atomic (cegah double-click double-claim)
3. Status transition satu arah (`active → used/revoked/expired`)
4. `isBanned` check di command handler
5. Retry random kalau collision (max 5× count)
6. Audit log 500 entri di KV `VoucherAudit`
7. Log ke channel `InvoiceLogger` tiap redeem sukses
8. Kode expired auto-reject di redeem

### 5.9 Edge Case Handling

| Kondisi | Perilaku |
|---|---|
| Kode < User (mis. 100 kode, 125 user) | Warn admin, kirim ke 100 user pertama (urutan UserList) |
| Kode = User | Kirim semua, batch habis |
| Kode > User (mis. 500 kode, 125 user) | Kirim ke semua, sisa 375 aman untuk broadcast lain |
| User blocked bot | Skip, kode tetap valid untuk broadcast ulang |
| Batch expired | Warning di detail; user coba redeem → error `expired` |
| Kode di-revoke lalu user coba | Error `revoked` |
| Session state expired tengah wizard | Bot warn "mulai ulang" |
| Concurrent redeem 1 user | Lock 10s → error `locked` untuk request kedua |


---

## 6. Flash Sale & BC Harga (v9update18)

Fitur baru untuk **potongan harga bertimer** (flash sale) dan **broadcast update harga** dengan banner khusus.

### 6.1 Menu Admin — `🔥 Flash Sale`

Baris baru muncul di panel `/admin` sebelum baris Voucher.

**Wizard buat Flash Sale (4 step):**
1. **Pilih Varian** — hanya varian dengan stok > 0 dan belum ada FS aktif
2. **Harga Sale** — ketik angka, harus < harga normal (min Rp 100)
3. **Durasi** — preset (30 menit / 1 jam / 6 jam / 24 jam) atau custom (`45m`, `2h`, `3d`, maksimal 30 hari)
4. **Konfirmasi** — cek detail (hemat %, kapan berakhir WIB) → Aktifkan

Setelah aktif, admin ditanya: **broadcast sekarang atau nanti?**

**Daftar Aktif:** list semua FS aktif + sisa waktu. Klik untuk detail (Cancel, BC Ulang).
**Riwayat:** 20 riwayat terakhir dengan reason (expired / admin_cancel / price_edit_below_sale).

### 6.2 BC Harga Baru

Setelah admin edit harga varian di menu Kelola Produk, muncul **tombol tambahan**: `📢 BC Harga Baru`.

1. Klik → konfirmasi (tampilkan old → new, arah turun/naik %, jumlah user)
2. Klik `✅ Ya, Broadcast` → kirim ke semua user pakai banner Update Harga
3. Bisa dilewati (klik `⏭️ Tidak Perlu`)

### 6.3 FS-aware Edit Harga

Edit harga di varian yang lagi ada Flash Sale:

- Harga baru **≤** sale price → **FS otomatis DIHENTIKAN** (masuk riwayat)
- Harga baru **>** sale price, FS **belum** di-broadcast → discount recalc silent (info aja)
- Harga baru **>** sale price, FS **sudah** di-broadcast → recalc + **warning mismatch** (broadcast lama sudah mention % lama)

### 6.4 Order Lock — Harga Terkunci

Harga di-lock saat user pertama pilih varian (`dpi_<vid>`). Perubahan harga admin **tidak** mempengaruhi order yang sudah dimulai. Qty +/- dan refresh pakai harga terkunci.

**Auto-cancel invoice saat FS expired:** kalau user bayar QRIS setelah FS berakhir (invoice belum expired 5 menit tapi FS sudah lewat), sistem otomatis:
- Batalkan order (stok tidak dikurangi)
- **Refund penuh ke SALDO user**
- Notifikasi user + log ke InvoiceLogger

### 6.5 Banner Base64 (2 banner baru)

Menu `⚙️ Settings` → di bawah "Gambar Broadcast Stok":

- 🔥 **Banner Flash Sale (Base64)** → dipakai header broadcast Flash Sale
- 💰 **Banner Update Harga (Base64)** → dipakai header BC Harga Baru

Upload via file `.txt` berisi base64 (recommended: 1200x600 landscape). Tanpa banner, broadcast tetap terkirim sebagai teks murni.

### 6.6 KV Keys Baru

| Key | Isi |
|---|---|
| `FlashSale` | `{ [variantId]: {...FS metadata...} }` — aktif |
| `FlashSaleHistory` | Array 100 riwayat terbaru |
| `PriceChangeLog_<vid>` | Info edit harga terakhir untuk BC Harga button |
| `BotConfig.bannerFsB64` | Banner Flash Sale |
| `BotConfig.bannerPriceB64` | Banner Update Harga |

### 6.7 User Experience

Di list varian (menu Stok / kategori):
- Varian FS diberi icon 🔥
- Harga: `~Rp Normal~ → *Rp Sale* (-XX%)`
- Button label prefix 🔥

Di konfirmasi order:
- Baris Harga: `Rp Original (dicoret) → 🔥 Rp Sale`

Baca **`CHANGELOG_v9update18.md`** untuk detail lengkap, callback map, KV schema, dan test checklist.
