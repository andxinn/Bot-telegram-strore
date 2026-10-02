# Bot Jualan Telegram — Mulai dalam 10 Menit

Panduan ini cukup. Detail teknis ada di `setupbot.md`.

## 1. Bikin bot (3 menit)
1. Buka [@BotFather](https://t.me/BotFather) → `/newbot` → ikuti sampai dapat **token**.
2. Buka [@userinfobot](https://t.me/userinfobot) → catat **ID angka** kamu.

## 2. Isi 2 kolom (2 menit)
Buka file `.dev.vars`, isi persis 2 baris ini:
```
BOT_TOKEN=tempel-token-dari-BotFather
OWNER_ID=tempel-ID-angka-kamu
```
Jalankan: `node dev-server.mjs`. Buka bot kamu, ketik `/admin`.

## 3. Klik-klik dari HP (5 menit)
Di panel admin, tekan **❓ Panduan Setup** dan ikuti 3 langkahnya:
nama toko → banner → aktifkan bayar (mode *production*).

Selesai. Tambah kategori + produk + stok, bot siap jualan.

> ⚠️ Jangan nyalakan SIMULATE_PAYMENT di bot asli — order lunas tanpa bayar.
> Kalau panel admin menampilkan peringatan merah, ikuti tulisannya.
