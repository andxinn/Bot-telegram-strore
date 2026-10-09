# PANDUAN-UPLOAD-CF.md — Upload Bot ke Cloudflare dari Nol (Lengkap)

> Untuk: yang baru pertama kali upload / mau pindah akun CF / worker kehapus.
> Prasyarat: Node.js ≥ 18.11, akun Cloudflare (Free cukup), repo ini sudah di-clone.
> Hasil akhir: bot `@tokopremkubot` (atau bot barumu) live via Worker + webhook.
> Waktu: ±15 menit.

---

## 0. Siapkan 3 bahan (dari HP)

1. **Token bot** — @BotFather → `/newbot` (atau `/mybots` → API Token untuk bot lama).
2. **ID Telegram kamu** — @userinfobot → angka (contoh `6242090623`).
3. **API Token Cloudflare** — Dashboard CF →右上 Manage Account → API Tokens → Create Token:
   - Template bebas, tapi WAJIB centang minimal:
     - `Workers Scripts: Write + Read`
     - `Workers KV Storage: Write + Read`
   - Account Resources: akunmu (Entire …).
   - Simpan tokennya (awalan `cfat_…`). Token read-only (tanpa Write) → deploy ditolak `9106`.

## 1. Login + install (PC, sekali saja)

```bash
npm i -g wrangler
wrangler --version
export CLOUDFLARE_API_TOKEN='cfat_TEMPEL_TOKEN_CF_KAMU'
wrangler whoami     # harus tampil nama akunmu
```

## 2. Buat KV namespace (database bot)

```bash
cd cf-worker-v9update18-flashsale
npx wrangler kv:namespace create DB
```

Output beri `id` — paste ke `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DB"
id = "PASTE_ID_DI_SINI"
```

> Tanpa ini → deploy error `KV namespace not found`.

## 3. Isi secrets (WAJIB sebelum deploy pertama)

```bash
wrangler secret put BOT_TOKEN       # tempel token dari @BotFather
wrangler secret put OWNER_ID        # tempel ID angka kamu
wrangler secret put WEBHOOK_SECRET  # string random bebas (wajib! guard webhook menolak tanpa ini)
wrangler secret put TURSO_URL       # opsional (mode Turso)
wrangler secret put TURSO_TOKEN     # opsional (mode Turso)
wrangler secret list                # cek: 5 nama harus ada
```

> JANGAN taruh token di `[vars]` wrangler.toml — selalu via `wrangler secret put`.

## 4. Deploy

```bash
npx wrangler deploy
```

Dapat URL misal `https://telegram-store-bot.<akun>.workers.dev`.
Cron trigger = 1 saja (`* * * * *`) — jangan tambah (Free plan maks 5/akun;
backup/SLA/cleanup/broadcast sudah di-gate di tick menit `src/index.js`).

## 5. Pasang webhook (sekali saja)

`/setup` butuh `?secret=` = isi WEBHOOK_SECRET tadi:

```bash
curl "https://telegram-store-bot.<akun>.workers.dev/setup?secret=ISI_WEBHOOK_SECRET"
# harap: {"telegram": {"ok":true,...}, ...}
```

Verifikasi:

```bash
curl "https://telegram-store-bot.<akun>.workers.dev/health?secret=ISI_WEBHOOK_SECRET"
# harap: {"ok":true,...}
```

Buka bot di Telegram → `/start` → bot balas + foto banner (bila sudah diset).

## 6. Isi toko dari HP (panel admin)

1. `/admin` → Sistem → Identitas & Info (nama toko & bot).
2. Media & Banner → kirim **foto langsung** per slot (Start/List/FS/Harga/LB/Stok).
3. Produk & Stok → tambah kategori → tambah stok.
4. Pembayaran → aktifkan 1 gateway → tes nominal kecil.
5. Backup → pilih Harian / 30 menit.

## 7. Update berikutnya

```bash
npx wrangler deploy     # kode naik; webhook TIDAK perlu di-set ulang (URL sama)
```

## 8. Troubleshooting (yang sudah kejadian nyata)

| Gejala | Penyebab | Fix |
|---|---|---|
| deploy `9106 Authentication failed` | token CF read-only / salah akun | buat token baru, centang Workers Scripts+KV Write |
| deploy `cron mentok limit Free plan` | >5 cron trigger per akun | cron cukup 1 (`* * * * *`), tambah di §4 |
| bot tidak balas, `getWebhookInfo` ada `last_error: 403` | secret Telegram ≠ WEBHOOK_SECRET worker | pasang ulang §5 dengan secret yang benar |
| `/setup` → `Forbidden` | `?secret=` salah / WEBHOOK_SECRET belum di-set | `secret put` → deploy ulang → §5 lagi |
| bot balas 2× | token dipakai 2 instance (dev + worker) | matikan `node dev-server.mjs` lokal |
| `kv key list` kosong padahal bot ada data | baca preview lokal | selalu tambah `--remote`: `wrangler kv key list --namespace-id <ID> --remote` |
| `/start` teks tanpa foto | banner belum diset | kirim foto via Media & Banner (§6.2) |

## 9. Push ke GitHub

```bash
git add -A
git commit -m "pesan jelas"
git push origin main
```

Yang wajib ter-ignore (jangan commit): `.dev.vars`, `dev-db.json`, `snapshots/`, `backup/`, `local.vars`.
