# v9update16 — Nomor Urut Stock + Admin Menu Identitas Bot + Bug Fixes

**Tanggal:** 2026-07-23
**Base:** v9update15

## Fitur baru
1. **Nomor urut stock** di file txt purchase (Bagian `PRODUK:` sekarang `1. ...`, `2. ...`, dst).
2. **Admin menu 🏷️ Identitas Bot** — ganti Nama Bot / Nama Toko / Prefix ID Order langsung dari bot, tanpa restart / redeploy.
3. **Tombol ♻️ Reset ke Env** — hapus override KV, balik ke env var.

## Bug fixes dari deep review (2 pass, 6 bug)

### Pass 1
- **FIX-1** (medium) — `adm_set_botname` Batal button sekarang balik ke `adm_identity` (submenu), bukan `adm_settings` (2 level ke atas). Juga label diubah `🤖 Nama Bot di ID Order` → `🆔 Prefix ID Order`.
- **FIX-2** (medium) — Nilai `cur` di prompt input dibungkus backtick `` ` ` `` (safe untuk nama yang mengandung `*` / `_` / `[`).
- **FIX-3** (low) — `payments.js` fallback `s.info || s` diperkeras dengan `JSON.stringify` (hindari `[object Object]` di file txt).

### Pass 2
- **FIX-4** (medium) — Input validation di `settings_namabot`/`settings_storename` sekarang strip control chars (`\r \n \t \v \f`) dan collapse whitespace. Cegah newline-injection yang bisa buat file txt & caption pecah lines.
- **FIX-5** (low) — `payments.js:131` `+ NamaBot` diberi fallback `|| ''` (konsisten dengan `callbacks.js:361` yang sudah defensive).
- **FIX-6** (medium) — `/config` command di `commands.js` wrap output dalam code block (triple-backtick), sehingga karakter Markdown special di NamaBot/StoreName/BotConfig JSON tidak break parsing (`edit_config` di callbacks.js sudah aman dgn `escapeMarkdown`).

## File touched
- `src/payments.js` (+2 line: nomor urut hardened + NamaBot fallback)
- `src/callbacks.js` (+1 line: nomor urut)
- `src/admin.js` (+~92 line: menu identitas + 2 state handler + FIX-1 + FIX-2 + FIX-4)
- `src/commands.js` (FIX-6 code block wrap)
- `AGENTS.md`, `setupbot.md`, `.dev.vars.example`

## Verifikasi
- ✅ Syntax check: 20/20 file JS pass
- ✅ No TODO/FIXME/XXX di src/
- ✅ Semua callback_data / state.action reference valid (no orphan)
- ✅ ES module live binding `NamaBot`/`StoreName` propagate ke semua importer setelah `initConfig`
- ✅ Cron scheduled event panggil `initConfig(env)` sebelum autoBackup
