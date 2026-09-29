# DEV.md — Panduan Lengkap Dev Mode di VS Code

> **Tujuan:** ngoding bot ini di VS Code tanpa perlu `wrangler deploy` setiap kali edit.
> Cukup **save file → auto-restart → langsung uji di Telegram**.
>
> Production tetap pakai `wrangler deploy` — hanya saat kamu memang siap deploy.

---

## Daftar isi

1. [Prasyarat](#1-prasyarat)
2. [Setup awal (sekali saja)](#2-setup-awal-sekali-saja)
3. [Cara jalanin dev mode di VS Code](#3-cara-jalanin-dev-mode-di-vs-code)
4. [Alur dev sehari-hari](#4-alur-dev-sehari-hari)
5. [Setting Pakasir untuk dev](#5-setting-pakasir-untuk-dev)
6. [Dev-only endpoints](#6-dev-only-endpoints)
7. [KV snapshot (backup/restore data dev)](#7-kv-snapshot)
8. [Uji webhook Pakasir asli dari lokal (opsional)](#8-uji-webhook-real)
9. [Debugging dengan breakpoint](#9-debugging)
10. [SWITCH ke production](#10-switch-ke-production)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prasyarat

| Yang dibutuhkan | Cara cek | Kalau belum |
|---|---|---|
| **Node.js ≥ 18.11** | `node -v` | Install dari <https://nodejs.org> (LTS) |
| **VS Code** | — | <https://code.visualstudio.com> |
| **Bot Telegram dev terpisah** | Chat @BotFather → `/newbot` | Wajib. Jangan pakai token production. |
| **Wrangler CLI** (hanya untuk deploy) | `npx wrangler --version` | `npm i -g wrangler` (opsional) |

**Tidak ada** dependency npm lain. Zero `npm install` untuk dev.

---

## 2. Setup awal (sekali saja)

### 2.1 Clone / extract project
```bash
unzip telegram-store-bot-v9update14.zip
cd cf-worker
code .            # buka di VS Code
```

### 2.2 Buat file `.dev.vars`
```bash
cp .dev.vars.example .dev.vars
```
Edit `.dev.vars` di VS Code. Isi minimal:
```env
BOT_TOKEN=<token bot DEV dari @BotFather>
OWNER_ID=<ID Telegram kamu>
OWNER_USERNAME=@usernameanda
STORE_NAME=DEV STORE
NAMA_BOT=DEV STORE BOT
MODE=development
SIMULATE_PAYMENT=false
IS_PROD_TOKEN=false
```

> 🔐 `.dev.vars` sudah masuk `.gitignore`. Tidak akan ke-commit.

### 2.3 Buat bot dev di @BotFather
1. Chat @BotFather → `/newbot`
2. Nama (misal: **My Store Dev Bot**), username (misal: `mystore_dev_bot`)
3. Copy token → paste ke `BOT_TOKEN` di `.dev.vars`

> **Kenapa harus bot terpisah?** Karena `dev-server` akan **melepas webhook** dari bot itu untuk pakai long-polling. Kalau kamu pakai token production, bot production di server akan berhenti terima pesan.

---

## 3. Cara jalanin dev mode di VS Code

### Cara A — Terminal (paling simpel)
Buka terminal VS Code (`` Ctrl+` ``):
```bash
npm run dev
```
Output sukses:
```
╭─────────────────────────────────────────────╮
│   DEV SERVER v14  (Standalone, no CF)       │
╰─────────────────────────────────────────────╯
  HTTP     : http://localhost:8787
  Bot      : @mystore_dev_bot
  ✅ Bot siap! Kirim pesan di Telegram.
```
Chat bot dev kamu di Telegram → `/start`. Bot merespon dari komputer kamu. Stop: `Ctrl+C`.

### Cara B — F5 (debug mode)
1. `Ctrl+Shift+P` → `Debug: Select and Start Debugging` → `Dev Server (watch + debug)`
2. Selanjutnya cukup tekan **F5**

Keuntungan: **breakpoint bekerja** di `src/*.js`.

### Cara C — Task runner (Ctrl+Shift+B)
`Ctrl+Shift+B` → pilih `Dev: Start (watch)`

---

## 4. Alur dev sehari-hari

```
1. Jalankan dev (Cara A/B/C)  → sekali per sesi
2. Buka Telegram → chat bot dev
3. Edit src/*.js di VS Code
4. Ctrl+S  → dev-server RESTART OTOMATIS (~1 detik)
5. Uji lagi di Telegram
6. Ulang step 3–5
7. Selesai? → git commit → section 10 (deploy production)
```

- ✅ Data dev tersimpan di `dev-db.json` (auto). Restart tidak hilang.
- ✅ Long-polling offset di-persist — restart tidak double-process pesan.
- ❌ **Jangan edit `dev-db.json` manual** saat dev-server jalan. Pakai `/dev/kv/:key` atau stop dulu.

---

## 5. Setting Pakasir untuk dev

Pakasir punya **mode sandbox** untuk testing (transaksi tidak real).

1. Di Telegram (bot dev), ketik `/admin`
2. **⚙️ Settings** → **💳 Setting Payment** → **Pakasir**
3. Isi:
   - **🔑 Slug** → slug project Pakasir sandbox
   - **🔐 API Key** → API key sandbox
   - **🔄 Mode** → `SANDBOX`
   - **💳 Metode** → `QRIS`
   - **💰 Fee** → 0 dulu
4. **🧪 Test Koneksi** → harus `✅ Koneksi OK`
5. **🟢 Aktifkan**

**Uji beli produk:**
1. `/start` → pilih produk → konfirmasi
2. Muncul QR + tombol:
   - **↻ Cek Pembayaran**
   - **🧪 Simulasi Bayar** ← hanya muncul di mode sandbox
   - **❌ Batal**
3. Klik **🧪 Simulasi Bayar** → langsung `completed` → bot kirim stok

> Ini cara **paling cepat** untuk uji flow lengkap tanpa webhook publik.

---

## 6. Dev-only endpoints

Hanya aktif di `npm run dev` (worker CF tidak tahu route ini).

### Lihat isi KV
```bash
curl http://localhost:8787/dev/info
curl http://localhost:8787/dev/kv
curl http://localhost:8787/dev/kv/BotConfig
curl http://localhost:8787/dev/kv/SessionDeposit
```

### Edit KV cepat
```bash
curl -X POST http://localhost:8787/dev/kv/some-key \
  -H "Content-Type: application/json" -d '{"foo":"bar"}'

curl -X DELETE http://localhost:8787/dev/kv/some-key
```

### Simulasi webhook Pakasir (tanpa tunnel)
```bash
# Auto-detect session pending terakhir
curl -X POST http://localhost:8787/dev/simulate-pakasir-webhook -d '{}'

# Atau specify order_id
curl -X POST http://localhost:8787/dev/simulate-pakasir-webhook \
  -H "Content-Type: application/json" \
  -d '{"order_id":"TRX-12345","amount":5000}'
```

---

## 7. KV snapshot

```bash
npm run kv:snap              # backup dev-db.json
npm run kv:snap sebelum-uji  # dengan label
npm run kv:list              # daftar semua
npm run kv:load              # restore interaktif
npm run kv:load 1            # restore snapshot no. 1
npm run kv:load sebelum-uji  # restore by nama
```
Disimpan di `snapshots/` (gitignore). Sebelum restore, dev-db lama otomatis di-backup.

> Setelah `kv:load`, **restart dev-server** (Ctrl+C → `npm run dev`) supaya data baru dibaca.

---

## 8. Uji webhook real

Kalau kamu mau simulate webhook Pakasir asli dari lokal, butuh **tunnel** yang expose `localhost:8787` ke internet.

### Opsi A — Cloudflare Tunnel (gratis, tanpa akun)
```bash
# Install
brew install cloudflared           # macOS/Linux
winget install --id Cloudflare.cloudflared   # Windows

# Jalankan (setelah `npm run dev` jalan di terminal lain)
cloudflared tunnel --url http://localhost:8787
```
Output:
```
Your quick tunnel: https://abcd-xyz.trycloudflare.com
```
Set di dashboard Pakasir sandbox → **Webhook URL** = `https://abcd-xyz.trycloudflare.com/pakasir-webhook`

### Opsi B — ngrok
```bash
ngrok http 8787
```
Copy `https://xxx.ngrok-free.app` → + `/pakasir-webhook`.

**Catatan:** URL tunnel berubah tiap restart. Untuk dev sehari-hari, **🧪 Simulasi Bayar** lebih praktis.

---

## 9. Debugging

1. Jalankan dengan **F5** (bukan `npm run dev` di terminal)
2. Buka file, misal `src/callbacks.js`
3. Klik kiri nomor baris → dot merah = breakpoint
4. Trigger action di Telegram
5. VS Code stop di breakpoint → lihat variable, step-over, dsb.

**Tips:**
- Pakai `Dev Server (once, no watch)` saat debugging — auto-restart bikin bingung.
- Debug Console (`Ctrl+Shift+Y`) bisa eval expression saat berhenti.

---

## 10. SWITCH ke production

### 10.1 Setup CF (sekali saja)

**a) Install wrangler & login**
```bash
npm i -g wrangler
wrangler login       # buka browser → login akun CF
```

**b) Buat KV namespace**
```bash
wrangler kv:namespace create "DB"
```
Output:
```
[[kv_namespaces]]
binding = "DB"
id = "abcd1234efgh5678...."
```
Copy `id` → paste ke `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "DB"
id = "abcd1234efgh5678...."   # ← ganti
```

**c) Set secret production** (JANGAN pakai `.dev.vars` di production!)
```bash
wrangler secret put BOT_TOKEN         # token bot PRODUCTION
wrangler secret put OWNER_ID
wrangler secret put OWNER_USERNAME
wrangler secret put STORE_NAME
wrangler secret put NAMA_BOT
wrangler secret put INVOICE_LOGGER
wrangler secret put SIMULATE_PAYMENT  # false
```
> Env non-sensitif (`MODE`, dll) taruh di `[vars]` `wrangler.toml`.

### 10.2 Deploy setiap update
```bash
npm run deploy:dry    # dry-run (cek build)
npm run deploy        # deploy sesungguhnya
```
Output:
```
Deployed telegram-store-bot triggers (0.53 sec)
  https://telegram-store-bot.<user>.workers.dev
```

### 10.3 Setup webhook production (sekali setelah deploy pertama)
Buka di browser:
```
https://telegram-store-bot.<user>.workers.dev/setup
```
Output:
```json
{
  "telegram": { "ok": true, "result": true },
  "pakasir_webhook": "https://telegram-store-bot.<user>.workers.dev/pakasir-webhook"
}
```
Copy URL `pakasir_webhook` → taruh di dashboard Pakasir **production** sebagai Webhook URL.

### 10.4 Setting Pakasir production di bot
Sama seperti section 5, tapi bot production:
- Mode: **PRODUCTION**
- Slug + API Key **production** (bukan sandbox)
- Test Koneksi → Aktifkan

### 10.5 Monitor production
```bash
npm run tail    # live log dari CF
```

### Checklist switch dev → production

- [ ] Semua fitur baru diuji di dev
- [ ] `git commit` semua perubahan
- [ ] `npm run deploy:dry` sukses
- [ ] `npm run deploy` sukses
- [ ] Buka `/setup` di browser (kalau ada perubahan webhook route)
- [ ] Update webhook URL di dashboard Pakasir (kalau URL berubah)
- [ ] Test 1 transaksi kecil di production (Rp1.000)
- [ ] `npm run tail` pantau realtime

---

## 11. Troubleshooting

### `Cannot find module` saat `npm run dev`
Pastikan Node ≥ 18.11: `node -v`. Versi lama belum ada `--watch`.

### Bot tidak merespon di dev
1. Cek terminal ada log `[TEXT] username: /start`. Kalau tidak ada:
   - BOT_TOKEN salah / bot dev berbeda dari yang di-chat
   - Ada dev-server lain jalan dengan token yang sama
2. `curl http://localhost:8787/dev/info` — harus tampil bot_username

### `Webhook lama dilepas` tapi bot production mati
Berarti kamu pakai token production di dev. Ganti ke bot dev terpisah, lalu di production jalankan `/setup` lagi untuk re-register webhook.

### File edit tapi tidak auto-restart
Pastikan pakai `npm run dev` (bukan `dev:once`). Cek Node ≥ 18.11.

### `dev-db.json` corrupt
```bash
npm run kv:list       # cari snapshot bagus
npm run kv:load 1     # restore
```
Atau fresh:
```bash
rm dev-db.json
```

### Pakasir `❌ Gagal membuat transaksi`
- Cek **Slug + API Key** (🧪 Test Koneksi)
- Cek mode sandbox vs production — API Key beda
- Cek firewall / network

### Deploy `KV namespace not found`
Id KV di `wrangler.toml` salah / belum di-create. Ulangi step 10.1b.

### Webhook Pakasir tidak dipanggil di production
- Cek `/setup` sudah dijalankan setelah deploy
- Cek URL webhook di dashboard Pakasir sama persis dengan output `/setup`
- `npm run tail` — harus ada log `[pakasir-webhook]`

---

## Ringkasan perintah

```bash
# Dev
npm run dev              # jalan (hot-reload)
npm run dev:once         # jalan sekali

# KV
npm run kv:snap          # backup dev-db.json
npm run kv:list          # daftar
npm run kv:load          # restore

# Production
npm run deploy:dry       # dry-run build
npm run deploy           # deploy ke CF
npm run tail             # live log production
```

Selesai. Selamat ngoding.

## v9update15 — Duitku Gateway (QRIS-only)

Gateway kedua di samping Pakasir. Hanya menyediakan opsi QRIS (4 provider Duitku).

### Endpoint tambahan
- `POST /duitku-webhook` — callback dari Duitku (x-www-form-urlencoded). Verifikasi HMAC_SHA256.
- `GET  /duitku-return` — halaman info untuk user setelah bayar (UX only).
- `POST /dev/simulate-duitku-webhook` (dev only) — build signature dari apiKey di KV `BotConfig`, POST ke `/duitku-webhook`. Body opsional: `{ merchantOrderId, amount, merchantCode, reference, resultCode }`; kalau kosong pakai session pending terakhir.

### Quick test (dev-server)
```bash
curl -s -X POST http://localhost:8787/dev/simulate-duitku-webhook \
     -H 'Content-Type: application/json' -d '{}'
```

### KV path
`BotConfig.payment.gateways.duitku` = `{ enabled, mode, merchantCode, apiKey, qrisProvider, expiryPeriod, feePercent, feeNominal, verifyIp }`.
Set lewat bot: Admin → Settings → 💳 Setting Payment → 🅳 Duitku.

### Switch active gateway
Tombol “✅ Jadikan Active Gateway” di menu Duitku. Session lama tetap pakai gateway lama (snapshot di session `.duitku_gw` / `.pakasir_gw`).
