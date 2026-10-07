# Desain Skema Turso (Opsi B — Relasional Penuh)

Target: menggantikan Cloudflare KV dengan Turso (libSQL/SQLite) — ACID, SQL, dan
memperbaiki race read-modify-write yang ada di KV.

Dialek: **SQLite** (libSQL). Semua via `@libsql/client` — kompatibel Workers & Node.

## Prinsip migrasi

- `src/kv.js` diganti `src/db.js` — eksport function bentuk sama (readJSON/writeJSON)
  agar transisi bertahap, TAPI internalnya query SQL ke tabel di bawah.
- Data ephemeral (state input, lock) pindah ke tabel `kv` dengan `expires_at` —
  TTL KV native tidak ada di SQL; cron yang prune.
- Pola read-modify-write (saldo, stok, voucher) diganti **transaksi + FOR UPDATE**
  (SQLite: `BEGIN IMMEDIATE` untuk lock di-level write).

## Tabel

```sql
-- users: ganti UserList JSON (race addSaldo/minSaldo → transaksi)
CREATE TABLE users (
  user_id      INTEGER PRIMARY KEY,
  username     TEXT DEFAULT '',
  first_name   TEXT DEFAULT '',
  balance      INTEGER DEFAULT 0,        -- saldo dalam rupiah penuh
  role         TEXT DEFAULT 'user',      -- user | admin | owner
  is_banned    INTEGER DEFAULT 0,
  total_belanja INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- categories: ganti KV 'Kategori'
CREATE TABLE categories (
  id           INTEGER PRIMARY KEY,
  produk_name  TEXT NOT NULL,
  produk_id    TEXT UNIQUE NOT NULL,     -- dipakai relasi ke products.category
  desc         TEXT DEFAULT ''
);

-- products: ganti KV 'Produk' (varian)
CREATE TABLE products (
  id           INTEGER PRIMARY KEY,
  nameproduct  TEXT NOT NULL,
  price        INTEGER NOT NULL,
  category     TEXT NOT NULL,            -- = categories.produk_id
  desc         TEXT DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_category ON products(category);

-- stock: satu baris = 1 item fisik (bisa diklaim tepat 1×)
CREATE TABLE stock (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  info         TEXT DEFAULT '',          -- isi item yang dikirim ke user
  expired_at   TEXT,                     -- masa aktif item (bisa NULL)
  is_sold      INTEGER DEFAULT 0,        -- 0 tersedia, 1 sudah terjual
  order_trxid  TEXT,                     -- order pemilik (audit)
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_stock_product ON stock(product_id, is_sold);

-- orders: ganti KV 'Trx'
CREATE TABLE orders (
  trxid         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(user_id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  jumlah        INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  tanggal       TEXT,
  payment_method TEXT,
  provider      TEXT,                    -- pakasir | duitku | orkut | saldo
  status        TEXT DEFAULT 'pending',  -- pending | paid | cancelled | refunded
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);

-- order_items: relasi order ↔ stock — exactly-once assignment (UNIQUE stock_id)
CREATE TABLE order_items (
  id           INTEGER PRIMARY KEY,
  order_trxid  TEXT NOT NULL REFERENCES orders(trxid),
  stock_id     INTEGER NOT NULL REFERENCES stock(id),
  price        INTEGER NOT NULL,
  UNIQUE(stock_id)                       -- 1 stock hanya milik 1 order
);

-- sessions: ganti KV 'SessionDeposit' (deposit & purchase pending)
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,         -- id sesi = order/invoice id
  user_id      INTEGER NOT NULL,
  type         TEXT NOT NULL,            -- purchase | deposit
  status       TEXT DEFAULT 'pending',   -- pending | paid | expired | cancelled
  provider     TEXT,
  total_amount INTEGER NOT NULL,
  detail       TEXT DEFAULT '{}',        -- JSON snapshot gateway (gw, ref, amount)
  cart         TEXT DEFAULT '{}',        -- JSON cart (produk, varian, jumlah)
  expired      TEXT,                     -- waktu wall WIB 'dd/mm/yyyy, HH:mm:ss'
  expiry_minutes INTEGER,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_status ON sessions(status, expired);

-- vouchers (v17): ganti Voucher/VoucherBatch/VoucherAudit
CREATE TABLE voucher_batch (
  id         INTEGER PRIMARY KEY,
  prefix     TEXT NOT NULL,
  nominal    INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE vouchers (
  code       TEXT PRIMARY KEY,           -- format XXX-XXXX-XXXX
  batch_id   INTEGER NOT NULL REFERENCES voucher_batch(id) ON DELETE CASCADE,
  status     TEXT DEFAULT 'active',      -- active | used | revoked
  claim_token TEXT,                      -- anti double-spend (v18.30)
  claimed_by INTEGER,
  claimed_at TEXT,
  UNIQUE(batch_id, code)
);
CREATE INDEX idx_vouchers_status ON vouchers(status, batch_id);
CREATE TABLE voucher_audit (
  id         INTEGER PRIMARY KEY,
  code       TEXT, user_id INTEGER, action TEXT, at TEXT
);

-- flashsale: ganti KV 'FlashSale' + 'FlashSaleHistory'
CREATE TABLE flash_sale (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sale_price   INTEGER NOT NULL,
  original_price INTEGER NOT NULL,
  expires_at   TEXT NOT NULL,
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE TABLE flash_sale_history (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER, sale_price INTEGER, sold_count INTEGER, at TEXT
);

-- tickets (v9.19, KV 'Tickets' JSON — live, bukan SQL):
--   [{ ticketId, userId, userName, userUsername, status: open|answered|closed,
--      category: pesanan|pembayaran|akun|lainnya, assignedTo, assignedName,
--      createdAt (ISO), closedAt (ms|null), deleteTopicAt (ms|null),
--      lastActivityAt, lastUserAt, lastAdminAt, lastSlaAt,
--      logChatId, threadId, logMessageId,
--      messages: [{ sender: user|admin, text, time, username,
--                   photoFileId?, docFileId?, docName?, at? }] }]
-- config tiket di KV 'BotConfig': channelTicket (-100...),
--   ticketKeepDays (1-100, default 7), ticketAutoDelTopic (true/false).
-- state ephemeral: 'TicketUndo_<id>' (5 dtk), 'ticketState_<uid>',
--   'adminState_<uid>' (action admin_reply_ticket / settings_ticket_keep).
-- (Skema SQL di bawah = opsi Turso masa depan, belum dipakai untuk tiket.)

-- config: ganti KV 'BotConfig' (nama bot, banner base64, channel, dll)
CREATE TABLE config (
  key   TEXT PRIMARY KEY,                -- misal 'NamaBot', 'bannerListB64'
  value TEXT                             -- string atau JSON string
);
-- payment gateway config terpisah (struktur tetap BotConfig.payment)
CREATE TABLE payment_config (
  name   TEXT PRIMARY KEY,               -- pakasir | duitku | orkut
  enabled INTEGER DEFAULT 0,
  config TEXT DEFAULT '{}'               -- JSON gateway (apiKey, fee, mode...)
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,                  -- active_gateway, OrderCounter, dll
  value TEXT
);

-- kv: escape hatch — state ephemeral + TTL substitute
--    isi: orderState_<u>, adminState_<u>, flowMsg_<u>, lock_<k>, done_<k>
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  expires_at INTEGER                     -- epoch detik; NULL = tidak expired
);
CREATE INDEX idx_kv_expires ON kv(expires_at);
```

## TTL substitute (pengganti KV expirationTtl)

`payments.js:114` (idempotency done key, 30 hari) dan `user.js:127` (lock anti
double-submit) memakai `env.DB.put(key, '1', { expirationTtl })`.

Pengganti: tulis `expires_at = now + ttl` → cron menitan hapus row expired
(`DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?`).
Release lock tetap `DELETE` eksplisit (tidak tunggu TTL).

## Fix race (nilai utama opsi B)

| Race KV | Fix Turso |
|---|---|
| `addSaldo`/`minSaldo` (UserList last-write-wins) | `UPDATE users SET balance = balance + ? WHERE user_id = ?` dalam `BEGIN IMMEDIATE` |
| Klaim stok ganda (push-filter-push) | `BEGIN IMMEDIATE` + `UPDATE stock SET is_sold=1, order_trxid=? WHERE id IN (...) AND is_sold=0` — cek `changes() == jumlah` |
| Voucher double-spend | `UPDATE vouchers SET status='used', claim_token=? WHERE code=? AND (claim_token IS NULL OR claim_token=?)` — cek `changes()==1` |
| SessionDeposit konkuren | `UPDATE sessions SET status='paid' WHERE id=? AND status='pending'` — 0 row = sudah diproses |

Semua dalam transaksi — pemenang ditentukan di DB, bukan di aplikasi.

## Plan implementasi (bertahap, tidak break)

1. **Fase DB-1**: `src/db.js` — client Turso (env `TURSO_URL`/`TURSO_TOKEN`,
   bisa di-set dari panel admin bot), migration runner (CREATE TABLE IF NOT EXISTS),
   wrapper readJSON/writeJSON ke tabel `kv` untuk state ephemeral.
2. **Fase DB-2**: patch `payments.js` + `user.js` — lock & done key → `kv` TTL.
3. **Fase DB-3**: gateway config (`BotConfig.payment`) → `payment_config` +
   `config` — pakasir.js/duitku.js/orkut.js baca dari sini (signature fungsi tetap).
4. **Fase DB-4**: migrasi core read-modify-write → transaksi (saldo, stok, voucher).
5. **Fase DB-5**: builder tabel relasional penuh + migrasi data dari KV dump
   (`scripts/migrate-kv-to-turso.mjs`) + update messages/callbacks/admin yang
   query langsung.
6. **Fase DB-6**: dev-server.mjs pakai Turso yang sama (bukan LocalKV) —
   satu sumber data untuk lokal & Workers.

Setiap fase diakhiri bot bisa jalan — tidak ada "big bang rewrite".

## Untuk deploy lokal (PC, tanpa STB)

`npm run dev` (dev-server.mjs) + Turso remote via env. Client `@libsql/client`
supported Workers (HTTP) & Node — kode sama, no fork.

## Catatan: WAL / performa

- libSQL default journal aman untuk akses HTTP; tidak perlu setting khusus.
- Index sudah dibuat untuk pola query padat (stok per produk, order per user).
- Untuk data besar (banner base64), simpan di `config.value` — TEXT SQLite
  batasnya sangat longgar ( GB).
