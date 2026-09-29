# CHANGELOG v9update17 — Voucher & Redeem System

**Tanggal:** 2026-07-23
**Base:** v9update16 (dengan 6 fix pass 1 & 2)

## 🎯 Ringkasan

Sistem voucher/kupon lengkap dengan generator batch, redeem atomic, broadcast privat (1 kode unik per user), revoke, dan audit log.

## 🆕 Fitur baru

### Untuk Admin (`/admin` → `🎫 Voucher & Redeem`)

- **Generate wizard 4-step** — semua input diketik (no preset):
  - Step 1: Prefix kode (2-5 huruf/angka, default auto dari `NamaBot`)
  - Step 2: Nominal bonus (Rp 100 – Rp 1.000.000)
  - Step 3: Jumlah kode (1 – 500)
  - Step 4: Masa berlaku (fleksibel: `30m`, `2h`, `7d`, `24 jam`, `3 hari`, atau tanpa expired)
- **Daftar batch** — list 20 batch terbaru dengan status ikon
- **Detail batch** — total, terpakai, sisa, tgl expired, status broadcast
- **Download file .txt** — file berisi semua kode + cara redeem (bisa didownload ulang kapan saja)
- **Broadcast privat** — kirim 1 kode unik ke tiap user (semua kode dipakai, fair)
- **Revoke batch aktif** — non-aktifkan kode sisa (yang sudah dipakai tidak terpengaruh)
- **Statistik global** — total aktif/terpakai/expired/revoked + total nominal terpakai + 3 redeem terakhir

### Untuk User

- **`/redeem <KODE>`** — tukar kode voucher jadi saldo
- **`/redeem`** (tanpa argumen) — tampilkan bantuan format
- Notifikasi bonus + saldo baru saat sukses

## 🔒 Keamanan

1. **Format kode ketat**: regex `[A-Z0-9]{3}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}` (exclude ambigu I/O/0/1)
2. **Entropi tinggi**: 36⁸ ≈ 2,8 triliun kemungkinan per prefix
3. **Atomic redeem via lock**: `acquireLock('redeem_' + userId, 10s)` mencegah double-spend saat user click cepat 2x
4. **Status transition**: `active → used/revoked/expired` (tidak bisa kembali)
5. **Cek `isBanned`**: user yang di-ban tidak bisa redeem
6. **Audit log**: 500 entri terakhir tersimpan di KV `VoucherAudit`
7. **Log ke InvoiceLogger**: tiap redeem sukses dikirim ke channel log admin
8. **Retry collision**: kalau kode kebetulan sama dengan existing, generator retry (max 5× count)

## 📦 Data Model (KV)

```
Voucher       : { [code]: { code, amount, batchId, createdAt, createdBy, expiresAt, usedBy, usedAt, status } }
VoucherBatch  : { [batchId]: { batchId, prefix, amount, total, used, expiresAt, codes[], broadcasted, broadcastAt, broadcastSent, revoked, createdAt, createdBy, expiryLabel } }
VoucherAudit  : [ { code, userId, amount, at } ] (max 500)
```

## 📁 File yang diubah

| File | Delta |
|---|---|
| `src/user.js` | +48 baris — `redeemVoucher(env, userId, code)` helper atomic |
| `src/admin.js` | +603 baris — 5 helper + menu + 13 callback + 4 state handler |
| `src/commands.js` | +48 baris — `/redeem` command handler |
| `src/index.js` | +1 baris — register `/redeem` di `tgSetMyCommands` |

## 🎨 UI/UX highlights

- Wizard step counter (`STEP 1/4`, `STEP 2/4`, dst)
- Konfirmasi terakhir menampilkan total nilai batch
- File .txt hasil generate langsung dikirim ke chat admin
- Broadcast progress bar ("Terkirim 20/125 user")
- Warning otomatis kalau kode < user
- Status ikon di daftar batch: 🟢 aktif, ⚪ habis, ⚠️ expired, 🔴 revoked

## 🐞 Edge case handled

- Kode < user pada broadcast → prioritas user pertama di UserList, warn admin
- User bot-blocked → skip, kode tetap tersimpan untuk broadcast ulang
- Kode sudah dipakai saat direvoke → tidak terpengaruh (saldo user aman)
- Batch expired → tampil warning di detail, redeem otomatis reject dengan pesan tanggal
- Kolisi random kode → auto retry sampai unik (max 5× count attempts)
- Session state expired di tengah wizard → tampil pesan "mulai ulang"

## ⏭️ Yang tidak diimplement (per keputusan user)

- Rate limit per user (dianggap tidak perlu — entropi tinggi cukup aman)
- Fitur search kode manual
- Menu button `🎁 Tukar Kode` di keyboard user (user pakai command only)
- Mode broadcast public (race 1 kode) — hanya private yang dipakai
