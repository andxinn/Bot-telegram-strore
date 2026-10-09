# Panduan Setup Cloudflare Lengkap — Bot Telegram Store

> Repo: `andxinn/Bot-telegram-strore` • Worker: `telegram-store-bot` • Entry: `src/index.js`
> Dokumen ini FOKUS ke sisi **Cloudflare** saja (akun → Workers → KV → domain + SSL → cron → deploy).
> Untuk cara pakai bot (admin panel, payment, voucher, flash sale) baca: `MULAI.md` (10 menit) → `SETUP.md` → `setupbot.md` (referensi lengkap) → `DEV.md` (dev lokal).

---

## 1. Alur besar (5 kotak)

```
Akun Cloudflare ──▶ Worker telegram-store-bot ──▶ KV binding DB
       │                      │                          │
       │                      ├── POST /webhook (Telegram) 
       │                      ├── GET /setup (pasang webhook sekali)
       │                      ├── GET /health (cek hidup)
       │                      └── cron: tiap menit (cek bayar) + tiap jam (backup)
       │
       └── Custom domain + SSL gratis (bot.<domain-kamu> ganti workers.dev)
```

---

## 2. Persiapan (sekali saja)

1. Akun Cloudflare: https://dash.cloudflare.com/sign-up (Free cukup).
2. Node.js ≥ 18.11: `node -v` untuk cek.
3. Install Wrangler:
   ```bash
   npm i -g wrangler
   wrangler --version
   ```
4. Login:
   ```bash
   wrangler login
   # browser terbuka → Allow → terminal: "Successfully logged in"
   ```
5. Clone repo ini:
   ```bash
   git clone https://github.com/andxinn/Bot-telegram-strore.git
   cd Bot-telegram-strore
   ```

---

## 3. Buat KV namespace (database bot)

Bot ini simpan SEMUA data di KV dengan binding `DB` (lihat `wrangler.toml` + `src/kv.js`).

```bash
npx wrangler kv:namespace create DB
```

Output contoh:
```
[[kv_namespaces]]
binding = "DB"
id = "abc123..."
```

Copy `id` tersebut ke `wrangler.toml` gantikan `your-kv-namespace-id`:

```toml
[[kv_namespaces]]
binding = "DB"
id = "abc123..."   # ← paste dari output di atas
```

> Kalau deploy tanpa ganti ini → error `KV namespace not found`. Wajib!

Preview lokal (opsional, untuk `wrangler dev`):
```bash
npx wrangler kv:namespace create DB --preview
# tambahkan preview_id yang keluar ke wrangler.toml bila perlu
```

---

## 4. Isi `wrangler.toml` repo ini (yang penting)

File sudah ada, yang perlu kamu pahami:

```toml
name = "telegram-store-bot"
main = "src/index.js"
compatibility_date = "2024-01-01"

[vars]
MODE = "production"
DB_MODE = "auto"     # auto = ikut setting bot (Admin → Sistem → Kelola Database)
JAM_BACKUP = "6"      # backup otomatis jam 6 WIB

[[kv_namespaces]]
binding = "DB"
id = "ISI-ID-DARI-LANGKAH-3"

[triggers]
crons = ["* * * * *"]   # TUNGGAL (Free plan: maks 5 cron per AKUN)
# tick menit-1 → src/index.js putuskan di dalam: SLA tiket + sweeper topik +
# lanjutkan broadcast (flushBcStates) + cek bayar + backup (gate jam/mode) + cleanup.
```

Aturan secret vs vars (JANGAN tertukar):
- **Secret** (sensitif, via `wrangler secret put`): `BOT_TOKEN`, `OWNER_ID`, API key gateway, `TURSO_TOKEN`.
- **Vars** (non-sensitif, di `[vars]`): `MODE`, `NAMA_BOT`, `STORE_NAME`, `JAM_BACKUP`.

---

## 5. Set secrets production

Minimal 2 ini WAJIB sebelum deploy pertama (token bot PRODUCTION, beda dari bot dev!):

```bash
wrangler secret put BOT_TOKEN
# paste token dari @BotFather → Enter

wrangler secret put OWNER_ID
# paste ID angka kamu dari @userinfobot → Enter
```

Opsional (bisa juga diisi belakangan via panel admin bot):
```bash
wrangler secret put WEBHOOK_SECRET   # string random WAJIB (guard webhook tolak request tanpa secret)
wrangler secret put TURSO_URL       # kalau pakai mode Turso
wrangler secret put TURSO_TOKEN
```

Cek:
```bash
wrangler secret list
```

---

## 6. Deploy + pasang webhook (WAJIB sekali)

```bash
npx wrangler deploy
```

Dapat URL misal:
```
https://telegram-store-bot.<akun-kamu>.workers.dev
```

Langsung pasang webhook Telegram (sekali setelah deploy pertama).
`/setup` butuh `?secret=` = isi WEBHOOK_SECRET (tanpa ini → `Forbidden`):

```bash
curl "https://telegram-store-bot.<akun-kamu>.workers.dev/setup?secret=ISI_WEBHOOK_SECRET"
# harap: {"telegram": {"ok":true,...}, ...}
```

Verifikasi:
1. `curl "https://telegram-store-bot.<akun-kamu>.workers.dev/health?secret=ISI_WEBHOOK_SECRET"` → `{"ok":true,...}`.
2. Buka bot di Telegram → `/start` → bot balas.
3. Live log bila error:
   ```bash
   wrangler tail
   # kirim pesan ke bot, lihat request masuk real-time. Ctrl+C untuk stop.
   ```

Update berikutnya cukup `npx wrangler deploy` — webhook TIDAK perlu di-set ulang (URL sama).

---

## 7. Custom domain + SSL gratis (ganti workers.dev)

`*.workers.dev` sudah HTTPS otomatis, tapi untuk branding (misal `bot.tokomu.id`) ikuti ini:

### 7.1. Domain masuk ke Cloudflare dulu
1. Dashboard → **Add domain** → masukkan domain kamu → nameserver diarahkan ke Cloudflare (ikut wizard, ±5 menit).
2. **SSL/TLS → Overview → Full (strict)**.
3. **SSL/TLS → Edge Certificates → Always Use HTTPS = ON**.

### 7.2. Sambungkan Worker ke domain
1. Dashboard → **Workers & Pages → telegram-store-bot → Settings → Domains & Routes → Add → Custom Domain**.
2. Isi misal `bot.tokomu.id` → Activate. Cloudflare otomatis buatkan record DNS + sertifikat (±2 menit).
3. Set ulang webhook ke domain baru (WAJIB, karena URL berubah):
   ```bash
   curl "https://bot.tokomu.id/setup?secret=ISI_WEBHOOK_SECRET"
   ```
4. Update juga di dashboard gateway:
   - Pakasir → Webhook URL: `https://bot.tokomu.id/pakasir-webhook`
   - Duitku → Callback URL: `https://bot.tokomu.id/duitku-webhook`, Return URL: `https://bot.tokomu.id/duitku-return`
   - (Detail tiap gateway ada di `setupbot.md` bagian 7.)

### 7.3. Cek SSL
Buka `https://bot.tokomu.id/health` di browser → harus gembok hijau, tanpa warning. Kalau masih error 525/526 → tunggu 5 menit (sertifikat masih provisioning) lalu `curl` ulang.

---

## 8. Cron & KV — cek sudah jalan

Dashboard → **Workers & Pages → telegram-store-bot**:
- **Triggers → Cron Triggers** harus ada 1: `* * * * *`. Kalau kosong → kamu deploy dari folder yang salah; redeploy dari root repo (tempat `wrangler.toml` berada).
  Jangan tambah trigger (Free plan maks 5 per akun; backup/cleanup/SLA/BC sudah di-gate di tick menit).
- **Bindings → KV** harus ada `DB` dengan ID yang sama seperti di `wrangler.toml`.
- **Logs → Live** atau `wrangler tail` untuk lihat cron tiap menit (`checkPendingPayments`) tanpa error.

Catatan Free plan: cron 1 menit didukung, jadi setting repo ini aman.

---

## 9. Deploy otomatis via GitHub (opsional)

Detail penuh ada di `setupbot.md` bagian 10. Ringkasnya:
1. Push repo ini ke GitHub (sudah: `andxinn/Bot-telegram-strore`).
2. Cloudflare → **Manage Account → API Tokens → Create** (template `Edit Cloudflare Workers`).
3. Salin **Account ID** (dashboard kanan bawah).
4. GitHub repo → **Settings → Secrets → Actions**, tambah:
   - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN` (opsional).
5. Tambah file `.github/workflows/deploy.yml` yang jalankan `wrangler deploy` tiap push ke `main`.

---

## 10. Troubleshooting Cloudflare (tersering di repo ini)

| Gejala | Penyebab | Fix |
|---|---|---|
| `KV namespace not found` saat deploy | `id` di `wrangler.toml` masih `your-kv-namespace-id` | Langkah 3: create KV lalu paste id |
| Bot tidak balas setelah deploy | Webhook belum dipasang / secret salah | `curl .../setup?secret=...` (langkah 6); `secret_token` Telegram harus = WEBHOOK_SECRET worker |
| `/setup` → `Forbidden` | `?secret=` salah / WEBHOOK_SECRET belum di-set | `wrangler secret put WEBHOOK_SECRET` → deploy ulang → `/setup?secret=` lagi |
| Bot balas 2× | Token dipakai 2 instance (dev + production jalan bareng) | Matikan `npm run dev`, pakai bot/token dev terpisah |
| `BOT_TOKEN not set` di `/setup` | Secret belum di-set | `wrangler secret put BOT_TOKEN` lalu deploy ulang |
| Cron tidak jalan | Trigger hilang / deploy dari folder salah | Redeploy dari root repo, cek tab Triggers |
| 525/526 setelah custom domain | Sertifikat belum jadi | Tunggu 5 menit, cek ulang `/health` |
| `.../workers.dev` kena blokir Telegram di HP tertentu | Filter operator | Pakai custom domain (langkah 7) |
| Data dev ikut ke production | `dev-db.json` ke-commit / token sama | Jangan commit `dev-db.json`, token dev ≠ production |

Cheatsheet harian:
```bash
npx wrangler deploy      # update production
wrangler tail            # log live
wrangler secret list     # cek secrets
wrangler kv key list --namespace-id <ID> --remote   # data production (tanpa --remote = preview lokal!)
curl "https://<worker>/health?secret=..."   # cek hidup
curl "https://<worker>/setup?secret=..."    # pasang ulang webhook
```
