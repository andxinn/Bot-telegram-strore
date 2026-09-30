// ─── Saweria Payment Gateway ─────────────────────────────────────────
// Donasi/QRIS via Saweria (API internal tidak resmi — endpoints dapat berubah).
// Kredensial: username (slug saweria.co/username) + user_id (UUID).
// Semua fungsi dibungkus {ok, ...} — bot tidak crash kalau API berubah.

// QRIS via Saweria. Endpoint diverifikasi dari library open-source terbukti
// (nindtz/saweriaqris) + uji langsung.
//   Create : POST https://backend.saweria.co/donations/{user_id}
//   Status : GET https://backend.saweria.co/donations/qris/{trx_id}
//            -> data.qr_string == "" berarti SUDAH DIBAYAR
//   UserID : GET https://saweria.co/{username} -> parse __NEXT_DATA__
//
// user_id bisa diinput manual ATAU di-resolve otomatis dari username publik,
// jadi admin cukup set username saja.

import { feeLabel } from './pakasir.js'
import { ParseIdr, expiredTime } from './helpers.js'

const SAWERIA_BACKEND = 'https://backend.saweria.co'
const SAWERIA_FRONTEND = 'https://saweria.co'

function saweriaConfigured(gw) {
  return !!(gw && gw.enabled && gw.username && gw.userId)
}

// Resolve user_id dari halaman publik saweria.co/{username}
async function saweriaResolveUserId(username) {
  try {
    const res = await fetch(SAWERIA_FRONTEND + '/' + encodeURIComponent(username), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }
    })
    const html = await res.text()
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!m) return { ok: false, error: 'halaman tidak berisi __NEXT_DATA__ (akun tidak ditemukan?)' }
    const data = JSON.parse(m[1])
    const userId = data?.props?.pageProps?.data?.id
    if (!userId) return { ok: false, error: 'user_id tidak ditemukan di __NEXT_DATA__' }
    return { ok: true, userId: String(userId) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Create QRIS. Returns { ok, id, qrString, amount }
async function saweriaCreate(gw, orderId, amount, opts = {}) {
  try {
    const userId = gw.userId
    if (!userId) return { ok: false, error: 'userId belum diset', stage: 'create' }
    const body = {
      agree: true,
      notUnderage: true,
      message: String(orderId).slice(0, 100),
      amount: Number(amount),
      payment_type: 'qris',
      vote: '',
      currency: 'IDR',
      customer_info: {
        first_name: (opts.customerName || 'Customer').slice(0, 50),
        email: opts.email || 'customer@bot.local',
        phone: ''
      }
    }
    const res = await fetch(SAWERIA_BACKEND + '/donations/' + encodeURIComponent(userId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      },
      body: JSON.stringify(body)
    })
    const data = await res.json().catch(() => null)
    if (!data) return { ok: false, error: 'HTTP ' + res.status, stage: 'create' }
    const det = data.data || data
    const qr = det.qr_string || det.qrString
    const id = det.id || det.donation_id
    if (id && qr) return { ok: true, id: String(id), qrString: String(qr), amount: Number(amount) }
    return { ok: false, error: String(data.message || data.error || 'tidak ada qr_string').slice(0, 150), stage: 'create' }
  } catch (e) {
    return { ok: false, error: e.message, stage: 'create' }
  }
}

// Check status: qr_string kosong = sudah dibayar
async function saweriaStatus(gw, trxId) {
  try {
    const res = await fetch(SAWERIA_BACKEND + '/donations/qris/' + encodeURIComponent(trxId), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }
    })
    if (res.status === 404) return { ok: false, error: 'transaction not found', stage: 'status' }
    const data = await res.json().catch(() => null)
    if (!data) return { ok: false, error: 'HTTP ' + res.status, stage: 'status' }
    const det = data.data || {}
    if (!det.qr_string) return { ok: true, status: 'PAID', amount: det.amount || det.amount_raw, raw: data }
    if (det.status === 'expired' || det.expired) return { ok: true, status: 'EXPIRED', raw: data }
    return { ok: true, status: 'PENDING', raw: data }
  } catch (e) {
    return { ok: false, error: e.message, stage: 'status' }
  }
}

// Test koneksi: resolve user_id dari username saja (tanpa create donasi,
// jadi tidak meninggalkan transaksi pending di akun).
async function saweriaTest(gw) {
  if (!gw.username) return { ok: false, error: 'username belum diset', stage: 'resolve' }
  const r = await saweriaResolveUserId(gw.username)
  if (!r.ok) return { ok: false, error: r.error, stage: 'resolve' }
  const match = !gw.userId || String(gw.userId) === String(r.userId)
  return { ok: true, userId: r.userId, userIdMatch: match }
}

// ─── Session builder (dipakai deposit + purchase) ─────────────────────
// Saweria tidak punya unique-amount; QR sama persis dgn nominal, cek via status.
// Session pakai provider 'saweria' + saweria_id (snap id).
function saweriaSession({ trxId, userId, type, amount, charge, gw, nama, username, extra = {} }) {
  return {
    id: trxId, status: 'pending',
    depositDetails: {
      userId, type,
      total_amount: charge, amount,
      expired: expiredTime(Number(gw.expiryPeriod) || 10), key: null,
      nama, username,
      provider: 'saweria', saweria_amount: charge, saweria_message: trxId,
      expiryMinutes: Number(gw.expiryPeriod) || 10,
      display_total: charge,
      ...extra
    }
  }
}

// ─── Caption QRIS (dipakai deposit + purchase) ────────────────────────
function saweriaCaption(title, amount, charge, fee, gw, expMin, trxId) {
  let p = '╭───〔 💳 ' + title + ' 〕───\n'
  p += '┊ *Jumlah      :* ' + ParseIdr(amount) + '\n'
  if (fee > 0) p += '┊ *Fee (' + feeLabel(gw) + ') :* ' + ParseIdr(fee) + '\n'
  p += '┊ *Total Bayar :* ' + ParseIdr(charge) + '\n'
  p += '├──────────────────\n'
  p += '┊ *ID Trx      :* `' + trxId + '`\n'
  p += '╰──────────────────\n\n'
  p += '⏰ Kadaluwarsa dalam *' + expMin + ' menit*\n'
  p += '📲 Scan QR di bawah untuk membayar'
  return p
}

export {
  SAWERIA_BACKEND,
  saweriaConfigured,
  saweriaResolveUserId,
  saweriaCreate,
  saweriaStatus,
  saweriaTest,
  saweriaSession,
  saweriaCaption
}
