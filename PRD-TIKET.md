# PRD — Sistem Tiket Bantuan v9.19 (P1–P10) + Parity Q1–Q5

> Status: **LIVE production — `@tokopremkubot` via Cloudflare Worker `telegram-store-bot`.**
> Versi: **9.20.0** · Repo: `andxinn/Bot-telegram-strore` (`cf-worker-v9update18-flashsale/`)
> Cakupan: samakan tampilan + fitur tiket bot STB v1.1 ke bot Cloudflare (+ parity non-tiket Q1–Q5, lihat `CHANGELOG_v9update20.md`).
> Live: `@tokopremkubot` (Worker `https://telegram-store-bot.manulsinul99.workers.dev`, webhook `/webhook`, cron tunggal `* * * * *`).

## 1. Ringkasan

Satu renderer kartu (`src/ticketCard.js`), satu jalur pesan (`src/ticket.js`),
notifikasi admin pindah ke topik forum (DM admin dimatikan), umur arsip +
hapus topik otomatis yang bisa disetel admin. 10 fase, 1 fase = 1 commit.

| Fase | Isi | Commit |
|---|---|---|
| P0 | Audit CF vs STB (dagangan SAMA, port hanya tiket-related) | — (analisis) |
| P1 | Renderer tunggal `ticketCard.js` + kartu user/admin via `renderTicketCard` + reopen user | `c96a022` |
| P2 | Auto-route ketik langsung (1 aktif masuk, closed≤7hr reopen, ≥2 tolak) | `e01703e` |
| P3 | Inbox dot+count via renderer, close admin Undo 5dtk + pesan baru, helper lama jadi wrapper | `f1b860a` |
| P4 | Kategori 4 pilihan + judul topik kategori + klaim/ambil-alih dinamis | `8dd7049` |
| P5 | SLA cron (pengingat 30mnt ke topik, 1x/2jam) + anti-spam 3 tiket | `f10a669` |
| P6 | `channelTicket` resmi (allowlist + validasi forum + env fallback) + hint baku | `39bc1c4` |
| P7 | Umur topik 1–100hr default 7 + hapus otomatis 10mnt (sweeper + recreate + cleanup nurut toggle) | `30a5772` |
| P8 | Menu tiket 1 pintu via renderer (daftar + 1 tombol Buat Tiket) | `e3cb096` |
| P9 | Notif admin pindah ke topik forum + mention (DM admin dimatikan) | `69f3ad1` |
| P10 | F5: hapus 3 wrapper lama + verifikasi akhir (syntax all + render smoke OK) | `62545d8` |

## 2. Arsitektur

```
user DM ──ketik──▶ userAppendToTicket ──▶ forwardUserToForum ──▶ topik forum
     │                      │                        │
     │                      ▼                        ▼
     │              renderTicketCard          renderTicketCard
     │              (role user)               (role admin)
     ▼
showTicketMenu = renderUserTicketList (1 pintu: daftar + Buat Tiket)
```

- `src/ticketCard.js` — murni, tanpa KV/Telegram. Bisa diuji `node -e import(...)`.
- `src/ticket.js` — helper KV: `appendTicketMessage`, `userAppendToTicket`,
  `forwardUserToForum`, `flushTopicDelete` (sweeper 10mnt), `ensureTopicAlive`
  (recreate topik), `flushTicketSla` (pengingat 30mnt, 1x/2jam).
- Cron (`src/index.js`): `* * * * *` → SLA + sweeper topik + `cleanupClosedTickets`.

## 3. Aturan final (jangan diubah tanpa ACC)

1. **Auto-route (F1/P2):** 1 tiket aktif → pesan masuk; 0 aktif + closed≤7hr →
   reopen; ≥2 aktif → tolak + sebut ID. Command (`/...`) dan state aktif
   (order/deposit/admin) tidak pernah di-route.
2. **Tanpa emoji di tombol** (revisi 3 STB). Emoji hanya di judul topik forum.
3. **Tutup = jadwal hapus topik 10mnt** (`deleteTopicAt = closed + 600000`),
   user & admin sama. Undo admin 5dtk (`TicketUndo_<id>`) membatalkan jadwal.
   Sweeper `flushTopicDelete` nurut toggle `ticketAutoDelTopic`.
4. **Umur arsip 1–100 hari, default 7** (`ticketKeepDays`). 0 ditolak.
   `cleanupClosedTickets` hapus topik (bila toggle YA) + buang arsip.
5. **Data tiket TIDAK ikut hapus saat topik hilang** — hanya `deleteForumTopic`
   + putus `threadId`. Reopen setelah topik hilang → `ensureTopicAlive` buat
   topik baru.
6. **Notif admin = ke topik forum + mention** (`tg://user?id=`), bukan DM.
   Diagnosis error topik ke Owner tetap DM.
7. **Menu user 1 pintu:** daftar tiket + 1 tombol `Buat Tiket`. Kartu closed =
   1 tombol `Buka Lagi`.
8. **Anti-spam:** maks 3 tiket aktif per user.
9. **Kategori:** `pesanan | pembayaran | akun | lainnya` (`TICKET_CATS`).
   Klaim = indikator penangan (`assignedTo`), bukan kunci.
10. **Satu jalur ID tiket** — format live `TK-XXXX-XXXX` (data lama);
    tiket baru ikut generator aktif repo ini.

## 4. Panel admin

`Admin → Channel & Log → Umur Topik Tiket`:

- Pilihan: 1 / 3 / 7 / 14 / 30 / 100 hari + ketik manual 1–100.
- Toggle: `Hapus otomatis saat closed: YA (10 mnt) / TIDAK`.
- Status tampil `AKTIF (10 mnt)` / `NONAKTIF` + penjelasan umur vs hapus.
- Peringatan bila umur < 7 hari (bisa habis sebelum window reopen).

`channelTicket` diset via `/set channelTicket -100...` — wajib awalan `-100`
+ bot admin + Topics ON (divalidasi via `tgGetChat` + `is_forum`).

## 5. Callback reference (tiket)

User (`src/callbacks.js`): `tk_create`, `tk_new_<cat>`, `tk_view_<id>[_<pg>]`,
`tk_list`, `tk_follow_<id>`, `tk_close_<id>`, `tk_close_yes_<id>`,
`tk_reopen_<id>`, `tk_media_<id>_<i>`, `tk_media_close`, `tk_back_menu`.

Admin (`src/admin.js`): `tk_adm_view_<id>`, `tk_adm_reply_<id>`,
`tk_adm_cancel_reply_<id>`, `tk_adm_close_<id>`, `tk_adm_undo_close_<id>`,
`tk_adm_claim_<id>`, `tk_adm_takeover_<id>`, `tk_adm_page_<id>_<pg>`,
`tk_adm_cat_proses`, `tk_adm_cat_selesai`, `tk_adm_back_cat`,
`adm_ticket_keep[_<n>|_custom|_topic]`.

## 6. Verifikasi

- `node --check src/*.js` — semua OK.
- Render smoke: `renderTicketCard` role user/admin/closed + `renderUserTicketList` OK.
- Live production: webhook aktif pending 0, KV remote (`BotConfig`, `UserList`), banner Start foto file_id tersimpan.
- Sisa manual: 1 skenario HP penuh (buat → balas → tutup → 10mnt hilang → reopen ≤7hr).
