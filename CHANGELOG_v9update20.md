# CHANGELOG v9.20.0 — Parity Non-Tiket Q1–Q5 (samakan STB v1.1)

**Rilis:** 2026-10-09
**Fokus:** samakan sisa beda CF vs STB di luar tiket — broadcast anti-banned,
stok/varian/nextId/keyboard, banner file_id, jadwal backup, UI tiket sisa.
**Basis:** STB v1.1, dialih-call ke KV (`readJSON`/`writeJSON`).
**Live:** `@tokopremkubot` via Cloudflare Worker `telegram-store-bot`
(`https://telegram-store-bot.manulsinul99.workers.dev`),
KV `DB`, Turso opsional (DB_MODE auto), cron 1x `* * * * *` (Free plan).

## Q1 — Broadcast anti-banned (`1ba5f0e`)

- Baru: `safeBatchSend` di `src/helpers.js` (±15/dtk, 429 tunggu penuh, stop 5x beruntun).
- Baru: `bcStart`/`bcFlush`/`bcFinish` di `src/admin.js` (resumable, cron lanjutkan sisa) + `flushBcStates`.
- FS/harga/voucher/stok dialihkan ke `bcStart`. Helper lama `fsBroadcastToAllUsers` dihapus.

## Q2 — Stok + varian + nextId + keyboard (`c45b4a0`)

- Baru: `stokLayakJual`, `varianKat`, `nextId` di `src/helpers.js`.
- Stok kadaluarsa tidak ikut dijual (callbacks/messages/payments).
- Varian dukung 3 format kategori, `nextId` anti-NaN, keyboard nomor urut.

## Q3 — Banner foto file_id + leaderboard (`f830ae9`)

- Baru: `tgSendBanner` di `src/telegram.js` (file_id ringan dulu, fallback base64).
- Baru: `saveBannerFromMsg` di `src/admin.js` (kirim foto langsung / base64 via txt).
- Slot: start/list/FS/harga/leaderboard/stok. LB pakai `leaderboardId`.
- Kirim stok manual via `safeBatchSend`.

## Q4 — Jadwal auto-backup (`003fb26`)

- `backupMode`: `daily` (jam JamBackup) / `30m` (tiap 30 menit) + panel `adm_backup_sched`.
- Cron + tick dev-server `backup30m`. Scrub `apiKey` gateway di file backup.

## Q5 — UI tiket sisa (`caed6dd`)

- `tk_list` + `tk_back_menu` via renderer tunggal `renderUserTicketList`.
- Balas admin di forum via satu jalur `appendTicketMessage` (PRD-TIKET §3.2.1).

## Deploy (`0f22986`, `2a1601c`, merge `bbf7da2`)

- `wrangler.toml`: KV namespace `DB` live + cron tunggal `* * * * *`
  (Free plan: maks 5 cron/akun; backup/cleanup di-gate di tick menit).
- Secrets live: BOT_TOKEN, OWNER_ID, TURSO_URL, TURSO_TOKEN (+ DEV_TOKEN, WEBHOOK_SECRET lama).
- Webhook: `https://telegram-store-bot.manulsinul99.workers.dev/webhook` aktif, pending 0.

## Tambahan pasca-rilis (`7c196ce`)

- Panel Media & Banner disamakan STB: hapus label `(Base64)` di 4 tombol banner, samakan prompt FS/harga.
- Banner Start production terisi via foto langsung (file_id, bukan base64) — `/start` tampil foto.
- Secrets live final: BOT_TOKEN, OWNER_ID, TURSO_URL, TURSO_TOKEN, WEBHOOK_SECRET (DEV_TOKEN lama dihapus).
- Catatan: `wrangler kv key list` tanpa `--remote` baca KV preview lokal (kosong) — selalu pakai `--remote` untuk data production.
