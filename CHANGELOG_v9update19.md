# CHANGELOG v9.19.0 — Tiket Forum P1–P10 (samakan STB v1.1)

**Rilis:** 2026-10-08
**Fokus:** overhaul sistem tiket bantuan — 1 renderer, auto-route, inbox admin,
SLA, umur + hapus otomatis, menu 1 pintu, notif forum.
**Basis:** STB v1.1 (`BOT STORE TELE V STB`), dialih-call ke KV (`readJSON`/`writeJSON`).
**Struktur CF monolit dipertahankan** — hanya modul tiket (`ticket.js`, `ticketCard.js`)
yang dipecah keluar `src/`.

## P0 — Audit (analisis, tanpa commit)

Dagangan CF = STB: `keyboard/constants/saweria/qris/kv` md5 identik;
`duitku/pakasir` fungsi SAMA beda wrapper; `payments` 7/7 SAMA;
`user` 24/24 SAMA; `commands` 4/4 SAMA. Menu utama SAMA persis.
Yang di-port hanya tiket-related: `stokLayakJual`, `safeBatchSend`,
`varianKat`, `nextId`, `channelTicket`, `ticketKeepDays/autoDel`.

## P1 — Renderer tunggal (`c96a022`)

- Baru: `src/ticketCard.js` — `renderTicketCard` (role user/admin),
  `renderUserTicketList`, `renderInboxKeyboard`, `inboxPreview`,
  `TICKET_CATS`, `ticketAge`, `escHtml`.
- Kartu user (`tk_view_`), kartu admin, cermin grup via renderer.
- Kartu closed user = 1 tombol `Buka Lagi` (`tk_reopen_`).

## P2 — Auto-route (`e01703e`)

- Baru: `src/ticket.js` KV murni — `appendTicketMessage`,
  `userAppendToTicket`, `forwardUserToForum`.
- Hook DM di `messages.js`: 1 aktif → masuk; 0 aktif + closed≤7hr → reopen;
  ≥2 aktif → tolak + sebut ID. Satu jalur `appendTicketMessage`.

## P3 — Inbox + Undo (`f1b860a`)

- Inbox admin: legenda dot + count via `renderInboxKeyboard`.
- Close admin → kartu penutupan + Undo 5dtk (`TicketUndo_<id>`) + pesan baru (F2).
- Sisa cermin grup dialihkan ke renderer; helper lama jadi wrapper kompat.

## P4 — Kategori + klaim (`8dd7049`)

- Buat tiket: 4 pilihan (`tk_new_<cat>`) + anti-spam 3 tiket aktif.
- Judul topik forum bawa kategori + emoji (`TKT [id] emoji label · user`).
- Klaim / ambil-alih dinamis (`assignedTo`, indikator — bukan kunci).

## P5 — SLA + anti-spam (`f10a669`)

- `flushTicketSla`: menunggu admin >30mnt → pengingat ke TOPIK, maks 1x/2jam.
- Cron `* * * * *` di `src/index.js`.

## P6 — Channel resmi (`39bc1c4`)

- `channelTicket` masuk allowlist `/set`; validasi `-100...` + `is_forum` via `tgGetChat`.
- Fallback env `CHANNEL_TICKET`. Hint baku `Balas langsung di sini — ketik saja.`

## P7 — Umur + hapus otomatis (`30a5772`)

- Panel `adm_ticket_keep`: 1/3/7/14/30/100 + ketik 1–100 + toggle
  `Hapus otomatis saat closed: YA (10 mnt)/TIDAK` + status AKTIF/NONAKTIF.
- `ticketKeepDays`/`ticketAutoDelTopic` di `config.js` + BotConfig.
- Close (user/admin) → `deleteTopicAt = +10mnt`. Sweeper `flushTopicDelete`
  nurut toggle. `ensureTopicAlive` recreate topik. `cleanupClosedTickets`
  nurut umur + toggle.

## P8 — Menu 1 pintu (`e3cb096`)

- `showTicketMenu` via `renderUserTicketList`: daftar + 1 tombol `Buat Tiket`.

## P9 — Notif forum (`69f3ad1`)

- Tiket baru: notif ke TOPIK + mention admin (`tg://user?id=`). DM admin mati.
- Diagnosis error topik ke Owner tetap DM.

## P10 — Pembersihan (`62545d8`)

- Hapus 3 wrapper (`buildTicketChatHtml`, `buildGroupTicketLog*`) — 0 pemakai live.
- Verifikasi: `node --check` semua `src/*.js` OK + render smoke OK.

## Catatan data

- 2 tiket contoh di dev-KV format lama (`TK-7414-2772`, tanpa kategori) —
  arsip dev, bukan bug. Tiket baru pakai format + field v9.19.
- `BotConfig.orderBotName=DIGI` vs nama bot `RAMZ STORE BOT` — setting dev,
  samakan via panel bila perlu.

## Regression check

Semua fitur ≤ v9.18 tetap intact (dagangan identik P0; flash sale, voucher,
broadcast, backup tidak tersentuh — diff P1–P10 hanya 9 file tiket).
