# Telegram Store Bot - Cloudflare Workers

Bot toko Telegram otomatis, berjalan di Cloudflare Workers.
Desain & flow mengikuti **autorderxnew** (OkeConnect QRIS, reply keyboard, box format).

## Struktur File

```
src/
  config.js      - Konfigurasi utama (env + KV override)
  constants.js   - Konstanta (expiry, interval, dll)
  kv.js          - KV Storage helper
  helpers.js     - Utility functions (escapeMarkdownV2, ParseIdr, dll)
  telegram.js    - Telegram API calls
  qris.js        - QRIS dinamis generator
  payment.js     - OkeConnect mutation API + Saweria
  user.js        - User management (balance, roles, ban)
  keyboard.js    - Keyboard builder (reply + inline)
  commands.js    - Command handlers (/start, /pm, /manager, dll)
  messages.js    - Message handler (product numbers, deposit, PM)
  callbacks.js   - Callback query handler (order flow, admin panel, tiket user)
  payments.js    - Cron payment checker
  backup.js      - Auto backup + cleanup tiket closed
  index.js       - Entry point (webhook + cron)
  ticket.js      - Helper tiket (auto-route, SLA, sweeper 10mnt, forward forum)
  ticketCard.js  - SATU renderer kartu tiket (user/admin/forum/list)
dev-server.mjs   - Standalone dev server (long-polling, no Cloudflare)
```

## Setup

### 1. Dev Mode (VSCode Terminal)
```bash
npm run dev
```
- Baca .dev.vars otomatis
- KV lokal di dev-db.json
- Telegram long-polling (tanpa webhook)
- Cron simulasi otomatis setiap 60 detik

### 2. Production (Cloudflare Workers)
```bash
# Deploy ke CF Workers
wrangler deploy

# Setup webhook (jalankan sekali setelah deploy)
curl https://your-worker.workers.dev/setup
```

## Env Variables (.dev.vars / wrangler secret)

| Key | Keterangan |
|-----|------------|
| BOT_TOKEN | Token bot Telegram |
| OWNER_ID | Chat ID owner |
| STORE_NAME | Nama toko |
| INVOICE_LOGGER | Chat ID channel log invoice |
| DATA_QRIS | String QRIS statis |
| PAYMENT_OKECONNECT | on/off |
| OKE_MERCHANTID | Merchant ID OkeConnect |
| OKE_SIGNATURE | Signature OkeConnect |
| PAYMENT_SAWERIA | on/off |
| SAWERIA_USERID | User ID Saweria |
| KROPA_API | API Key Kropa |
| KROPA_APIKEY | API Key Kropa secondary |
| BANNER_FILE_ID | File ID foto banner (atau - untuk skip) |
| SIMULATE_PAYMENT | true/false (dev mode) |
| SIMULATE_DELAY | Detik delay simulasi (default 5) |

## Fitur

- Reply keyboard dengan nomor produk
- 2-level produk: Kategori → Varian
- QRIS dinamis dengan kode unik
- OkeConnect mutation checking (setiap 1 menit via cron)
- Produk dikirim sebagai file .txt
- SnK (Syarat & Ketentuan) per produk
- Invoice ke channel log
- PM system (user ↔ admin)
- Parity non-tiket v9.20 (Q1-Q5, lihat CHANGELOG_v9update20.md): broadcast anti-banned
  (`safeBatchSend` + `bcStart` resumable), stok kadaluarsa tak terjual, varian 3-format,
  `nextId` anti-NaN, keyboard nomor urut, banner foto file_id semua slot,
  jadwal backup Harian/30mnt, `tk_list` via renderer tunggal.
- Tiket bantuan forum-topik v9.19 (P1-P10, lihat PRD-TIKET.md):
  renderer tunggal, auto-route ketik langsung, inbox dot+count,
  Undo tutup 5 dtk, kategori 4 + klaim, SLA 30mnt, channelTicket
  resmi + validasi forum, umur 1-100hr default 7 + hapus otomatis
  10mnt, menu 1 pintu, notif ke topik + mention (DM admin mati)
- Roles: owner, admin, promoter
- Ban/unban user
- Auto backup setiap jam
- /manager panel interaktif
Versi: **9.20.0** (tiket P1-P10 + parity Q1-Q5) — lihat `PRD-TIKET.md` + `CHANGELOG_v9update19.md` + `CHANGELOG_v9update20.md`.
# Bot-telegram-strore
