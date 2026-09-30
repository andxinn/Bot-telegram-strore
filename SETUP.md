# SETUP — dari nol sampai bot balas (5 menit)

> Detail lanjutan: `DEV.md` (dev harian) dan `setupbot.md` (referensi env lengkap).

## 1. Lokal (coba-coba)

```bash
cp .dev.vars.example .dev.vars
```

Isi minimal di `.dev.vars` (sisanya boleh kosong):

| Var | Dari mana |
|---|---|
| `BOT_TOKEN` | @BotFather → `/newbot` (buat bot DEV terpisah!) |
| `OWNER_ID` | @userinfobot (angka, bukan username) |

Jalankan:

```bash
node dev-server.mjs
```

Buka Telegram → chat bot dev → `/start`. Beres.

## 2. Isi toko via panel admin

Di chat bot: `/admin` (atau tombol Admin). Urutan yang disarankan:

1. **Sistem → Identitas & Info** — nama toko & bot
2. **Produk & Stok** — tambah kategori → tambah stok
3. **Pembayaran** — aktifkan 1 gateway dulu (Pakasir/Duitku/Saweria), test dengan nominal kecil
4. **Komunikasi** — broadcast & tiket (opsional, bisa nanti)
5. **Pengguna** — daftar user & saldo manual (saat dibutuhkan)

Payment, Turso, banner: SEMUA via panel bot, tidak perlu env.

## 3. Simulasi bayar (tanpa uang asli)

Di `.dev.vars`: `SIMULATE_PAYMENT=true`, restart. Semua payment langsung sukses.

## 4. Deploy production (Cloudflare)

```bash
npx wrangler kv:namespace create DB   # paste id ke wrangler.toml
wrangler secret put BOT_TOKEN         # token bot PRODUCTION (beda dari dev!)
wrangler secret put OWNER_ID
npx wrangler deploy
```

Non-sensitif (`NAMA_BOT`, `STORE_NAME`) boleh di `[vars]` wrangler.toml.
Jangan taruh token/API key di `[vars]` — selalu via `wrangler secret put`.

## 5. Aturan yang sering dilanggar

- Token dev ≠ token production (`IS_PROD_TOKEN=true` = warning).
- Jangan commit `.dev.vars`, `dev-db.json`, `snapshots/`, `backup/` (sudah di `.gitignore`).
- Satu token = satu instance. Bot balas 2× = ada 2 server jalan.
