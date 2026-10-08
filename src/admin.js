import { readJSON, writeJSON, deleteKey } from './kv.js'
import { tgSendMessage, tgSendPhotoBase64, tgEditMessageText as tgEditMessageTextRaw, tgAnswerCallbackQuery, tgSendDocument, tgGetFile, tgDownloadFile, tgDeleteMessage, tgCloseForumTopic, tgEditForumTopic } from './telegram.js'
import { escapeMarkdown, ParseIdr, formatWIB, getDate, generateOrderId, sleep, getTanggalJam, mdSafe } from './helpers.js'
import { isOwner, getRole, acquireLock, releaseLock } from './user.js'
import { getPayCfg, savePayCfg, pakasirConfigured, PAYMENT_METHODS, methodLabel, feeLabel, pakasirCreate, pakasirCancel, defaultPayCfg } from './pakasir.js'
import { duitkuConfigured, duitkuTest, DUITKU_QRIS_PROVIDERS, providerLabel } from './duitku.js'
import { renderTicketCard } from './ticketCard.js'

// Shadow tgEditMessageText to handle cases where we edit a media/document message (deleting it and sending a new text message instead)
async function tgEditMessageText(env, chatId, messageId, text, keyboard = null, parseMode = 'Markdown') {
  const res = await tgEditMessageTextRaw(env, chatId, messageId, text, keyboard, parseMode)
  if (res && !res.ok && (!res.description || res.description.indexOf('not modified') === -1)) {
    try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
    return await tgSendMessage(env, chatId, text, keyboard, parseMode)
  }
  return res
}

// --- Helper: hitung tanggal expired berdasarkan WIB (UTC+7) ---
function getExpiredDateWIB(days) {
  const now = new Date()
  // Konversi ke WIB dengan offset +7 jam
  const wibMs = now.getTime() + (7 * 60 * 60 * 1000)
  const wibNow = new Date(wibMs)
  // Tambah hari
  wibNow.setUTCDate(wibNow.getUTCDate() + days)
  // Return YYYY-MM-DD
  return wibNow.toISOString().slice(0, 10)
}

// --- Format tampilan expired yang informatif ---
function formatExpiredDisplay(expiredAt, days) {
  if (!expiredAt) return 'Tidak ada expired ♾️'
  // expiredAt disimpan sebagai tanggal kalender WIB (YYYY-MM-DD) — tampilkan polos
  // tanpa konversi zona agar tidak mundur 1 hari di worker UTC
  const d = new Date(expiredAt + 'T00:00:00Z')
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
  const tgl = d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear()
  return tgl + (days ? ' (' + days + ' hari)' : '')
}


// ─── Keyboard Helpers ──────────────────────────────────────────────

// ─── v9update17: Voucher helpers ───
function voucherRandomCode(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let a = '', b = ''
  for (let i = 0; i < 4; i++) a += chars.charAt(Math.floor(Math.random() * chars.length))
  for (let i = 0; i < 4; i++) b += chars.charAt(Math.floor(Math.random() * chars.length))
  return prefix + '-' + a + '-' + b
}

function voucherGetDefaultPrefix(namaBot) {
  const clean = (namaBot || 'VCH').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean.length >= 3) return clean.slice(0, 3)
  return (clean + 'VCH').slice(0, 3)
}

function voucherValidatePrefix(input) {
  const clean = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean.length < 2 || clean.length > 5) return null
  return clean
}

function voucherParseExpiry(input) {
  const s = (input || '').toLowerCase().trim()
  if (s === '0' || s === 'none' || s === 'tanpa' || s === '♾️') return { ms: 0, label: 'Tanpa Expired' }
  const m = s.match(/^(\d+)\s*(m|min|menit|h|hour|jam|d|day|hari)$/)
  if (!m) return null
  const n = parseInt(m[1])
  if (n < 1) return null
  const unit = m[2]
  let ms = 0, label = ''
  if (unit === 'm' || unit === 'min' || unit === 'menit') {
    if (n > 525600) return null
    ms = n * 60 * 1000
    label = n + ' menit'
  } else if (unit === 'h' || unit === 'hour' || unit === 'jam') {
    if (n > 8760) return null
    ms = n * 60 * 60 * 1000
    label = n + ' jam'
  } else if (unit === 'd' || unit === 'day' || unit === 'hari') {
    if (n > 365) return null
    ms = n * 24 * 60 * 60 * 1000
    label = n + ' hari'
  }
  return { ms, label }
}

async function voucherBuildTxt(env, batch, codes) {
  const { NamaBot: nb } = await import('./config.js')
  const expStr = batch.expiresAt ? formatWIB(new Date(batch.expiresAt).toISOString()) : 'Tanpa expired'
  let txt = '╭─────────────────────────────────╮\n'
  txt += ' VOUCHER ' + (nb || 'BOT').toUpperCase() + '\n'
  txt += ' Bonus: ' + ParseIdr(batch.amount) + ' / kode\n'
  txt += ' Total: ' + batch.total + ' kode\n'
  txt += ' Berlaku sampai: ' + expStr + '\n'
  txt += '╰─────────────────────────────────╯\n\n'
  codes.forEach((c, i) => { txt += String(i + 1).padStart(4, ' ') + '. ' + c + '\n' })
  txt += '\nCARA REDEEM:\n'
  txt += '1. Chat bot ini\n'
  txt += '2. Ketik: /redeem <KODE>\n'
  txt += '   Contoh: /redeem ' + (codes[0] || 'XXX-XXXX-XXXX') + '\n\n'
  txt += 'SYARAT:\n'
  txt += '- 1 kode = 1 user (tidak bisa dipakai ulang)\n'
  if (batch.expiresAt) txt += '- Kadaluarsa: ' + expStr + '\n'
  return txt
}

// ═══════════════════════════════════════════════════════
// v9update18: Flash Sale helpers for admin.js
// (insert before `function adminMainPanel()`)
// ═══════════════════════════════════════════════════════

// Preset durasi flash sale (ms)
const FS_PRESETS = {
  '30m': { ms: 30 * 60 * 1000,        label: '30 menit' },
  '1h':  { ms: 60 * 60 * 1000,        label: '1 jam' },
  '6h':  { ms: 6 * 60 * 60 * 1000,    label: '6 jam' },
  '24h': { ms: 24 * 60 * 60 * 1000,   label: '24 jam' }
}

// Format sisa waktu (ms) -> human string
function fsFormatRemaining(msLeft) {
  if (msLeft <= 0) return 'berakhir'
  const s = Math.floor(msLeft / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return d + ' hari ' + h + ' jam'
  if (h > 0) return h + ' jam ' + m + ' menit'
  if (m > 0) return m + ' menit'
  return '< 1 menit'
}

// Format timestamp -> WIB dd MMM HH:MM
function fsFormatEndsAtWIB(tsMs) {
  try {
    const d = new Date(Number(tsMs) + 7 * 3600 * 1000)
    const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + hh + '.' + mm + ' WIB'
  } catch (e) { return '-' }
}

// Hitung persen discount (rounded)
function fsDiscountPercent(orig, sale) {
  if (!orig || orig <= 0) return 0
  return Math.round((orig - sale) / orig * 100)
}

// Build caption broadcast Flash Sale (format baru: header + quote + <pre>).
// HTML: caption dikirim dgn parse_mode HTML (blockquote/pre didukung).
function fsBcWaktu(tsMs) {
  try {
    const d = new Date(Number(tsMs) + 7 * 3600 * 1000)
    const p2 = (n) => String(n).padStart(2, '0')
    return p2(d.getUTCDate()) + '-' + p2(d.getUTCMonth() + 1) + '-' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' WIB'
  } catch (e) { return '-' }
}
async function fsBuildBcCaption(env, fs, variantName, kategoriName) {
  const pct = fsDiscountPercent(fs.originalPrice, fs.salePrice)
  const hemat = fs.originalPrice - fs.salePrice
  const endsWib = fsBcWaktu(fs.expiresAt)
  const remaining = fsFormatRemaining(fs.expiresAt - Date.now())
  const p = (await readJSON(env, 'Produk', [])).find(pr => String(pr.id) === String(fs.variantId))
  const stokN = p && p.stok ? p.stok.length : 0
  const S = '━━━━━━━━━━━━━━━━━━━━'
  const judul = [kategoriName, variantName].filter(v => v && v !== '-').join(' - ') || '-'
  const rows =
    '» Normal : ' + ParseIdr(fs.originalPrice) + '\n' +
    '» Sale   : ' + ParseIdr(fs.salePrice) + '\n' +
    '» Hemat  : ' + pct + '% (' + ParseIdr(hemat) + ')\n' +
    '» Stok   : ' + stokN + 'x\n' +
    '» Sisa   : ' + remaining + '\n' +
    '» Akhir  : ' + endsWib
  return { text: S + '\n𝗙𝗟𝗔𝗦𝗛 𝗦𝗔𝗟𝗘\n' + S + '\n<blockquote>' + escHtml(judul) + '</blockquote>\n<pre>' + escHtml(rows) + '</pre>\n' + S, parseMode: 'HTML' }
}

// Build caption broadcast Update Harga (turun/naik)
function fsBuildBcPriceCaption(variantName, kategoriName, oldPrice, newPrice) {
  const turun = oldPrice > newPrice
  const delta = Math.abs(oldPrice - newPrice)
  const pct = oldPrice > 0 ? Math.round(delta / oldPrice * 100) : 0
  let cap = (turun ? '💰 *UPDATE HARGA — TURUN* 💰' : 'ℹ️ *UPDATE HARGA*') + '\n'
  cap += '╭──────────────────────╮\n'
  cap += '┊ 📦 *' + (variantName || 'Produk') + '*\n'
  if (kategoriName) cap += '┊ _' + kategoriName + '_\n'
  cap += '├──────────────────────\n'
  cap += '┊ Harga Lama : ~' + ParseIdr(oldPrice) + '~\n'
  cap += '┊ Harga Baru : *' + ParseIdr(newPrice) + '*\n'
  if (turun) {
    cap += '┊ Selisih    : 🟢 *TURUN ' + ParseIdr(delta) + '* (' + pct + '%)\n'
  } else if (newPrice > oldPrice) {
    cap += '┊ Selisih    : 🔴 Naik ' + ParseIdr(delta) + ' (' + pct + '%)\n'
  }
  cap += '╰──────────────────────\n'
  cap += (turun ? '🛒 _Kesempatan bagus buat order sekarang!_' : '_Silakan cek harga terbaru di menu bot._')
  return cap
}

// ─── Q1: BC generik resumable anti-banned (port STB broadcast.js, alih-call KV).
// State 'BcState_<tag>': { targets, idx, sent, fail, payload, retry429[] }.
// payload: { text, mode, banner:{id,b64}|null, button|undefined }.
// Tutup-tengah-jalan → cron lanjutkan; tolak dobel bila sudah jalan.
const BC_CHUNK = 500
function bcTag(tag) { return String(tag == null ? '' : tag).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) }
async function bcStateKeys(env) {
  try { const { readJSON: rq } = await import('./kv.js'); const ix = await rq(env, 'BcStateIndex', []); return Array.isArray(ix) ? ix : [] }
  catch { return [] }
}
async function bcIndexAdd(env, key) {
  try {
    const { readJSON: rq, writeJSON: wq } = await import('./kv.js')
    const ix = await bcStateKeys(env)
    if (!ix.includes(key)) { ix.push(key); await wq(env, 'BcStateIndex', ix) }
  } catch {}
}
async function bcIndexDel(env, key) {
  try {
    const { readJSON: rq, writeJSON: wq } = await import('./kv.js')
    const ix = await bcStateKeys(env)
    if (ix.includes(key)) await wq(env, 'BcStateIndex', ix.filter(k => k !== key))
  } catch {}
}
async function bcSourceAlive(env, stateKey) {
  try {
    const { readJSON: rq } = await import('./kv.js')
    if (stateKey.startsWith('BcState_fs_')) {
      const { flashSaleGetActive } = await import('./user.js')
      return !!(await flashSaleGetActive(env, stateKey.replace('BcState_fs_', '')))
    }
    if (stateKey.startsWith('BcState_harga_')) {
      return (await rq(env, 'PriceChangeLog_' + stateKey.replace('BcState_harga_', ''), null)) !== null
    }
    if (stateKey.startsWith('BcState_vou_')) {
      const b = await rq(env, 'VoucherBatch', null)
      return !!(b && b[stateKey.replace('BcState_vou_', '')])
    }
  } catch {}
  return true
}
async function bcFinish(env, stateKey, st) {
  try {
    const { readJSON: rq, writeJSON: wq, deleteKey: dq } = await import('./kv.js')
    if (stateKey.startsWith('BcState_fs_')) {
      const { flashSaleGetActive, flashSaleSetActive } = await import('./user.js')
      const fs = await flashSaleGetActive(env, stateKey.replace('BcState_fs_', ''))
      if (fs) { fs.broadcasted = true; fs.broadcastAt = Date.now(); fs.broadcastSent = st.sent; await flashSaleSetActive(env, stateKey.replace('BcState_fs_', ''), fs) }
    } else if (stateKey.startsWith('BcState_harga_')) {
      await dq(env, 'PriceChangeLog_' + stateKey.replace('BcState_harga_', ''))
    } else if (stateKey.startsWith('BcState_vou_')) {
      const bid = stateKey.replace('BcState_vou_', '')
      const batches = await rq(env, 'VoucherBatch', null)
      if (batches && batches[bid]) { batches[bid].broadcasted = true; batches[bid].broadcastAt = Date.now(); batches[bid].broadcastSent = st.sent; await wq(env, 'VoucherBatch', batches) }
    }
  } catch {}
  try { const { deleteKey: dq2 } = await import('./kv.js'); await dq2(env, stateKey) } catch {}
  await bcIndexDel(env, stateKey)
  console.log('[cron] BC ' + stateKey + ' SELESAI: ' + st.sent + '/' + st.targets.length + (st.fail ? ' (' + st.fail + ' gagal)' : ''))
}
export async function bcFlush(env, stateKey) {
  const { acquireLock, releaseLock } = await import('./user.js')
  const gotLock = await acquireLock(env, 'bc_' + stateKey, 300)
  if (!gotLock) return { ok: false, reason: 'locked' }
  try {
    const { readJSON: rq, writeJSON: wq } = await import('./kv.js')
    const { safeBatchSend: sbs } = await import('./helpers.js')
    const st = await rq(env, stateKey, null)
    if (!st || !Array.isArray(st.targets)) { await bcIndexDel(env, stateKey); return { ok: true, done: true, sent: 0, total: 0 } }
    if (!(await bcSourceAlive(env, stateKey))) {
      try { const { deleteKey: dq } = await import('./kv.js'); await dq(env, stateKey) } catch {}
      await bcIndexDel(env, stateKey)
      console.log('[cron] BC ' + stateKey + ' dibuang: sumber hilang')
      return { ok: true, done: true, skipped: true, sent: st.sent || 0, total: st.targets.length }
    }
    const { tgSendMessage: sendMsg, tgSendPhotoBase64: sendPhotoB64, tgSendPhoto: sendPhotoId } = await import('./telegram.js')
    const p = st.payload || {}
    const kb = p.button ? { inline_keyboard: [[p.button]] } : undefined
    const sendOne = (uid) => {
      if (p.banner && p.banner.id) return sendPhotoId(env, uid, p.banner.id, p.text, kb, p.mode || 'Markdown')
      if (p.banner && p.banner.b64) return sendPhotoB64(env, uid, p.banner.b64, p.text, kb, p.mode || 'Markdown')
      return sendMsg(env, uid, p.text, kb, p.mode || 'Markdown')
    }
    const freshEnd = Math.min((st.idx || 0) + BC_CHUNK, st.targets.length)
    const todo = (st.retry429 || []).concat(st.targets.slice(st.idx || 0, freshEnd))
    const r = await sbs(todo, sendOne)
    st.idx = freshEnd
    st.sent = (st.sent || 0) + r.sent
    st.fail = (st.fail || 0) + r.failed
    st.retry429 = r.rest
    if (st.idx >= st.targets.length && st.retry429.length === 0) {
      await bcFinish(env, stateKey, st)
      return { ok: true, done: true, sent: st.sent, total: st.targets.length, fail: st.fail }
    }
    await wq(env, stateKey, st)
    console.log('[cron] BC ' + stateKey + ' chunk: ' + st.sent + '/' + st.targets.length)
    return { ok: true, done: false, sent: st.sent, total: st.targets.length }
  } finally {
    try { const { releaseLock: rl } = await import('./user.js'); await rl(env, 'bc_' + stateKey) } catch {}
  }
}
export async function flushBcStates(env) {
  const keys = await bcStateKeys(env)
  let n = 0
  for (const k of keys) {
    try { const r = await bcFlush(env, k); if (r && r.ok) n++ } catch (e) { console.error('[cron bc] ' + k + ': ' + e.message) }
  }
  return { ok: true, flushed: n }
}
export async function bcStart(env, tag, targets, payload) {
  const stateKey = 'BcState_' + bcTag(tag)
  const { readJSON: rq, writeJSON: wq } = await import('./kv.js')
  const cur = await rq(env, stateKey, null)
  if (cur && Array.isArray(cur.targets) && ((cur.idx || 0) < cur.targets.length || (cur.retry429 || []).length > 0)) {
    return { ok: false, reason: 'running', sent: cur.sent || 0, total: cur.targets.length }
  }
  if (!targets || targets.length === 0) return { ok: false, reason: 'empty' }
  await wq(env, stateKey, { targets, idx: 0, sent: 0, fail: 0, payload, retry429: [] })
  await bcIndexAdd(env, stateKey)
  return await bcFlush(env, stateKey)
}

// Ambil banner Flash Sale dari BotConfig
async function fsGetBanner(env, key) {
  const cfg = await readJSON(env, 'BotConfig', {})
  return cfg[key] || null
}

// ═══════════════════════════════════════════════════════
// v9update18: fsShowConfirm helper + state handlers
// helper: goes BEFORE adminMainPanel() (with other v18 helpers)
// state handlers: go INSIDE handleAdminState, BEFORE `if (state.action === 'editharga')`
// ═══════════════════════════════════════════════════════

// -- HELPER: fsShowConfirm (dipakai callback dur_ dan state handler fs_duration_custom) --
async function fsShowConfirm(env, chatId, messageId, fromId) {
  const st = await readJSON(env, 'adminState_' + fromId, null)
  if (!st || st.action !== 'fs_confirm') return
  const pct = Math.round((st.originalPrice - st.salePrice) / st.originalPrice * 100)
  const hemat = st.originalPrice - st.salePrice
  let cap = '⚠️ *Flash Sale — STEP 4/4: KONFIRMASI*\n'
  cap += '╭──────────────────────╮\n'
  cap += '┊ Produk   : 📦 *' + st.variantName + '*\n'
  cap += '├──────────────────────\n'
  cap += '┊ Normal   : ~' + ParseIdr(st.originalPrice) + '~\n'
  cap += '┊ Sale     : 🔥 *' + ParseIdr(st.salePrice) + '*\n'
  cap += '┊ Hemat    : 🎯 *' + pct + '%* (' + ParseIdr(hemat) + ')\n'
  cap += '├──────────────────────\n'
  cap += '┊ Durasi   : ⏰ *' + st.durationLabel + '*\n'
  cap += '┊ Berakhir : 🏁 ' + fsFormatEndsAtWIB(st.expiresAt) + '\n'
  cap += '╰──────────────────────\n'
  cap += '_Setelah aktif, kamu akan ditanya apakah mau broadcast._'
  const kb = {
    inline_keyboard: [
      [{ text: '✅ Aktifkan Sekarang', callback_data: 'adm_fs_confirm' }],
      [{ text: '❌ Batal', callback_data: 'adm_flashsale' }]
    ]
  }
  if (messageId) {
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
  } else {
    await tgSendMessage(env, chatId, cap, kb, 'Markdown')
  }
}

// ═══════════════════════════════════════════════════════

function adminMainPanel() {
  return {
    inline_keyboard: [
      [{ text: '📦 Produk & Stok', callback_data: 'adm_cat_produk' }, { text: '🔥 Promo', callback_data: 'adm_cat_promo' }],
      [{ text: '💳 Pembayaran', callback_data: 'adm_cat_bayar' }, { text: '📢 Komunikasi', callback_data: 'adm_cat_komunikasi' }],
      [{ text: '👥 Pengguna', callback_data: 'adm_cat_user' }, { text: '⚙️ Sistem', callback_data: 'adm_cat_sistem' }],
      [{ text: '❓ Panduan Setup', callback_data: 'adm_panduan' }],
      [{ text: '❌ Tutup', callback_data: 'adm_tutup' }]
    ]
  }
}

// ─── v9update18+: submenu kategori admin (max 2 klik ke aksi) ───
export function adminCatPanel(cat) {
  const back = [[{ text: '🔙 Kembali', callback_data: 'adm_panel' }]]
  const menus = {
    produk: {
      text: '*📦 PRODUK & STOK*\n\nKelola produk, varian & stok harian:',
      rows: [
        [{ text: '📦 Tambah Stok', callback_data: 'adm_addstock' }, { text: '🗑 Hapus Stok', callback_data: 'adm_delstock' }],
        [{ text: '💲 Edit Harga', callback_data: 'adm_editharga' }, { text: '✏️ Edit Nama', callback_data: 'adm_editnama' }],
        [{ text: '📝 Desk. Varian', callback_data: 'adm_editdesc' }, { text: '📝 Desk. Kategori', callback_data: 'adm_editkatdesc' }],
        [{ text: '📋 SnK', callback_data: 'adm_editsnk' }, { text: '👁 Lihat Stok', callback_data: 'adm_lihatstok' }],
        [{ text: '➕ Kategori', callback_data: 'adm_addkat' }, { text: '❌ Hapus Kat.', callback_data: 'adm_delkat' }],
        [{ text: '📤 Export Stok', callback_data: 'adm_export' }],
      ],
    },
    promo: {
      text: '*🔥 PROMO*\n\nFlash sale & voucher:',
      rows: [
        [{ text: '🔥 Flash Sale', callback_data: 'adm_flashsale' }],
        [{ text: '🎫 Voucher & Redeem', callback_data: 'adm_voucher' }],
      ],
    },
    bayar: {
      text: '*💳 PEMBAYARAN*\n\nGateway & pantauan transaksi:',
      rows: [
        [{ text: '💳 Payment Gateway', callback_data: 'adm_payment' }],
        [{ text: '📊 Log Transaksi', callback_data: 'adm_txlog_info' }],
      ],
    },
    komunikasi: {
      text: '*📢 KOMUNIKASI*\n\nBroadcast & tiket bantuan user:',
      rows: [
        [{ text: '📢 Broadcast', callback_data: 'adm_broadcast' }, { text: '🆕 BC Stok Baru', callback_data: 'adm_bc_stokbaru' }],
        [{ text: '🎫 Tiket User', callback_data: 'tk_adm_back_cat' }],
      ],
    },
    user: {
      text: '*👥 PENGGUNA*\n\nUser, admin & saldo manual:',
      rows: [
        [{ text: '👥 Daftar User', callback_data: 'adm_userlist' }, { text: '💰 Saldo Manual', callback_data: 'adm_saldo' }],
        [{ text: '👑 Kelola Admin', callback_data: 'adm_manage_admin' }],
      ],
    },
    sistem: {
      text: '*⚙️ SISTEM*\n\nIdentitas, media, channel & database:',
      rows: [
        [{ text: '🏷️ Identitas & Info', callback_data: 'adm_setfolder_identitas' }, { text: '🖼️ Media & Banner', callback_data: 'adm_setfolder_media' }],
        [{ text: '📢 Channel & Log', callback_data: 'adm_setfolder_channel' }, { text: '🏆 Fitur Tambahan', callback_data: 'adm_setfolder_fitur' }],
        [{ text: '💾 Kelola Database', callback_data: 'adm_setfolder_db' }],
        [{ text: '⚙️ Pengaturan Lain', callback_data: 'adm_settings_legacy' }],
      ],
    },
  }
  const m = menus[cat]
  if (!m) return adminMainPanel()
  return { inline_keyboard: [...m.rows, ...back], _text: m.text }
}

function expiredButtons() {
  return {
    inline_keyboard: [
      [{ text: '⏱️ 30 Hari', callback_data: 'adm_exp_30' }, { text: '⏱️ 60 Hari', callback_data: 'adm_exp_60' }],
      [{ text: '⏱️ 90 Hari', callback_data: 'adm_exp_90' }, { text: '⏱️ 365 Hari', callback_data: 'adm_exp_365' }],
      [{ text: '✏️ Custom (Ketik Sendiri)', callback_data: 'adm_exp_custom' }],
      [{ text: '♾️ Tanpa Expired', callback_data: 'adm_exp_skip' }]
    ]
  }
}

function kategoriButtons(kategori, prefix, extra = []) {
  const rows = kategori.map(k => [{
    text: '🗂️ [' + k.id + '] ' + k.produkName,
    callback_data: prefix + k.id
  }])
  rows.push(...extra)
  rows.push([{ text: '🔙 Kembali ke Panel', callback_data: 'adm_panel' }])
  return { inline_keyboard: rows }
}

function variantButtons(variants, prefix, backCallback = 'adm_panel') {
  const rows = variants.map(v => [{
    text: '📦 [' + v.id + '] ' + v.nameproduct + ' (' + (v.stok ? v.stok.length : 0) + ' stok)',
    callback_data: prefix + v.id
  }])
  rows.push([{ text: '🔙 Kembali', callback_data: backCallback }])
  return { inline_keyboard: rows }
}

function confirmButtons(yes_data, no_data = 'adm_panel') {
  return {
    inline_keyboard: [
      [{ text: '✅ Ya, Lanjutkan', callback_data: yes_data }, { text: '❌ Batal', callback_data: no_data }]
    ]
  }
}

function afterAddStockButtons(katId) {
  return {
    inline_keyboard: [
      [{ text: '📦 Add Stock Lagi', callback_data: 'adm_addstock' }],
      [{ text: '🔙 Ke Panel', callback_data: 'adm_panel' }]
    ]
  }
}

function afterAddKatButtons(katId) {
  return {
    inline_keyboard: [
      [{ text: '📁 Pakai Varian', callback_data: 'adm_addvarian_kat_' + katId }],
      [{ text: '📦 Tanpa Varian (langsung)', callback_data: 'adm_single_kat_' + katId }],
      [{ text: '⏭️ Skip — Ke Panel', callback_data: 'adm_panel' }]
    ]
  }
}

function afterAddVarianButtons(katId) {
  return {
    inline_keyboard: [
      [{ text: '➕ Tambah Varian Lagi', callback_data: 'adm_tambah_varian_lagi_' + katId }],
      [{ text: '⏹️ Selesai — Ke Panel', callback_data: 'adm_panel' }]
    ]
  }
}

// ─── Admin Access Check ────────────────────────────────────────────
async function checkAdmin(env, fromId, chatId) {
  if (isOwner(fromId)) return true
  const role = await getRole(env, fromId)
  if (role === 'admin') return true
  await tgSendMessage(env, chatId, '🚫 Akses ditolak. Hanya admin yang dapat menggunakan fitur ini.')
  return false
}

// ─── Show Admin Panel ────────────────────────────────────────────
export async function showAdminPanel(env, chatId) {
  // Peringatan konfigurasi bahaya — orang awam tidak tahu SimulatePayment/sandbox = auto-lunas
  try {
    const { SimulatePayment, Mode } = await import('./config.js')
    const { getActiveGateway } = await import('./pakasir.js')
    const dangers = []
    if (SimulatePayment) dangers.push('🚨 *SIMULASI BAYAR AKTIF* — semua order lunas tanpa bayar. Matikan via env SIMULATE_PAYMENT=false.')
    try {
      const ag = await getActiveGateway(env)
      if (ag && ag.gw && String(ag.gw.mode || '').toLowerCase() === 'sandbox' && String(Mode || '').toLowerCase() === 'production')
        dangers.push('⚠️ Gateway *' + ag.name + '* masih mode *sandbox* di production — tombol 🧪 Simulasi Bayar tampil ke user.')
    } catch (e) {}
    if (dangers.length > 0) await tgSendMessage(env, chatId, dangers.join('\n'), null, 'Markdown')
  } catch (e) {}
  await tgSendMessage(env, chatId,
    '*🛠️ ADMIN PANEL*\n\nPilih menu yang ingin dikelola:',
    adminMainPanel(), 'Markdown'
  )
}

// ─── Helper: simpan stok ke DB ───────────────────────────────────
async function doSaveStock(env, chatId, fromId, state, expiredAt, days) {
  const produk = await readJSON(env, 'Produk', [])
  const p = produk.find(pr => String(pr.id) === String(state.variantId))
  if (!p) {
    await tgSendMessage(env, chatId, '⚠️ Produk tidak ditemukan.')
    await deleteKey(env, 'adminState_' + fromId)
    return
  }
  if (!p.stok) p.stok = []
  const lines = state.stokLines || []
  for (const line of lines) {
    p.stok.push({ info: line, expired_at: expiredAt })
  }
  await writeJSON(env, 'Produk', produk)
  await recordStokBaru(env, state.variantId, lines.length)
  await deleteKey(env, 'adminState_' + fromId)
  const expStr = expiredAt ? '\nExpired: *' + formatExpiredDisplay(expiredAt, days) + '*' : '\nExpired: *Tidak ada ♾️*'
  await tgSendMessage(env, chatId,
    '✅ *' + lines.length + ' stok* berhasil ditambahkan ke *' + p.nameproduct + '*\n' +
    'Total stok: *' + p.stok.length + '*' + expStr,
    afterAddStockButtons(), 'Markdown'
  )
}

// ─── Handle adminState (step-by-step text input) ──────────────────────
// ─── v9update10: catat & broadcast stok terbaru ───
export async function recordStokBaru(env, variantId, count) {
  try {
    if (!count || count <= 0) return
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) return
    const kategori = await readJSON(env, 'Kategori', [])
    const kat = kategori.find(k => String(k.produkId) === String(p.category))
    const productName = kat ? kat.produkName : (p.nameproduct || '-')
    const list = await readJSON(env, 'StokBaru', [])
    const existing = list.find(e => String(e.id) === String(variantId))
    if (existing) { existing.count += count; existing.notifyPending = true; if (existing.excluded === undefined) existing.excluded = false }
    else { list.push({ id: variantId, variant: p.nameproduct || '-', product: productName, count, notifyPending: true, excluded: false }) }
    await writeJSON(env, 'StokBaru', list)
  } catch (e) {}
}

// Rakit pesan broadcast dari subset entri (default: pending && ikut).
// onlyIds: batasi ke ID tertentu (dipakai kirim manual per snapshot).
async function buildStokBaruBroadcast(env, onlyPending = true, onlyIds = null) {
  const list = await readJSON(env, 'StokBaru', [])
  let items = onlyPending ? (list || []).filter(e => e.notifyPending) : (list || [])
  items = items.filter(e => !e.excluded)
  if (onlyIds) {
    const seen = new Set(onlyIds.map(String))
    items = items.filter(e => seen.has(String(e.id)))
  }
  if (!items || items.length === 0) return null
  const groups = {}
  const order = []
  for (const e of items) {
    const key = e.product || '-'
    if (!groups[key]) { groups[key] = []; order.push(key) }
    groups[key].push(e)
  }
  const pad = (s, n) => String(s).padEnd(n, ' ')
  const wib = new Date(Date.now() + 7 * 3600 * 1000)
  const h = wib.getUTCHours()
  const salam = (h >= 5 && h <= 10) ? '🌅 Selamat Pagi' : (h >= 11 && h <= 14) ? '☀️ Selamat Siang' : (h >= 15 && h <= 18) ? '🌇 Selamat Sore' : '🌙 Selamat Malam'
  const bln = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'][wib.getUTCMonth()]
  const tgl = wib.getUTCDate() + ' ' + bln + ' ' + wib.getUTCFullYear()
  let msg = '╭───〔 🆕 *STOK TERBARU* 〕───\n'
  msg += '┊ ' + salam + ', kak! 👋\n'
  msg += '┊ Kabar baik, stok favoritmu\n'
  msg += '┊ restock 🛍️\n'
  msg += '┊ ──────────────────\n'
  for (const prod of order) {
    msg += '┊ 📦 ' + mdSafe(String(prod).toUpperCase()) + '\n'
    for (const v of groups[prod]) {
      const total = await countSisaStok(env, v.id)
      msg += '┊ `' + pad('Varian', 6) + ' : ' + mdSafe(v.variant) + '`\n'
      msg += '┊ `' + pad('Masuk', 6) + ' : +' + v.count + ' stok`\n'
      msg += '┊ `' + pad('Sisa', 6) + ' : ' + total + ' stok`\n'
    }
    msg += '┊ ──────────────────\n'
  }
  msg += '┊ 📅 ' + tgl + '\n'
  msg += '┊ 🙏 Buruan diorder ya kak,\n'
  msg += '┊ stok terbatas!\n'
  msg += '╰──────────────────'
  return msg
}

async function countSisaStok(env, variantId) {
  try {
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(variantId))
    return p && p.stok ? p.stok.length : 0
  } catch (e) { return 0 }
}

// ─── BC STOK MANUAL: render panel antrian (10/halaman) ───
const BC_STOK_PER_PAGE = 10
async function bcStokPanel(env, chatId, messageId, page) {
  const { tgEditMessageText } = await import('./telegram.js')
  const cfg = await readJSON(env, 'BotConfig', {})
  const autoOn = cfg.stokAutoNotif !== false
  const list = await readJSON(env, 'StokBaru', [])
  const pending = (list || []).filter(e => e.notifyPending)
  const ikut = pending.filter(e => !e.excluded).length
  const jangan = pending.length - ikut
  const pages = Math.max(1, Math.ceil(pending.length / BC_STOK_PER_PAGE))
  const pg = Math.min(Math.max(0, page || 0), pages - 1)
  let txt = '*🆕 BC STOK BARU — MANUAL*\n\n'
  txt += '*Mode Otomatis :* ' + (autoOn ? '🔔 AKTIF' : '🔕 MATI (manual)') + '\n'
  if (autoOn) txt += '_Add stok langsung terkirim sendiri tiap 1 menit (1 pesan = 1 varian)._\n'
  else txt += '_Add stok menumpuk di bawah, tidak terkirim sendiri._\n'
  txt += '\n*Antrian (' + pending.length + '):* ' + ikut + ' ikut, ' + jangan + ' jangan'
  if (pages > 1) txt += ' — Hal ' + (pg + 1) + '/' + pages
  txt += '\n'
  const rows = []
  if (pending.length === 0) {
    txt += '\n_Kosong. Tambahkan stok dulu lewat 📦 Add Stock._\n'
  } else {
    const start = pg * BC_STOK_PER_PAGE
    const slice = pending.slice(start, start + BC_STOK_PER_PAGE)
    slice.forEach((e, i) => {
      const no = start + i + 1
      const st = e.excluded ? 'JANGAN' : 'IKUT'
      txt += no + '. ' + (e.variant || '-') + ' — *+' + (e.count || 0) + ' stok* [' + st + ']\n'
    })
    // Tombol toggle 3 per baris
    for (let i = 0; i < slice.length; i += 3) {
      const brow = slice.slice(i, i + 3).map((e, j) => {
        const no = start + i + j + 1
        const aksi = e.excluded ? 'IKUT' : 'JANGAN'
        return { text: no + ' → ' + aksi, callback_data: 'adm_bc_stokbaru_tg_' + (start + i + j) + '_pg' + pg }
      })
      rows.push(brow)
    }
    if (pages > 1) {
      const nav = []
      if (pg > 0) nav.push({ text: '‹ Prev', callback_data: 'adm_bc_stokbaru_pg_' + (pg - 1) })
      if (pg < pages - 1) nav.push({ text: 'Next ›', callback_data: 'adm_bc_stokbaru_pg_' + (pg + 1) })
      rows.push(nav)
    }
  }
  txt += '\n*Fungsi tombol:*\n'
  txt += 'Nomor → IKUT/JANGAN — pilih produk yang ikut broadcast, tekan 1x berubah.\n'
  txt += 'Ikut Semua / Jangan Semua — 1x tekan untuk semua antrian.\n'
  txt += '👁 Preview — lihat pesan user tanpa mengirim.\n'
  txt += '✅ Kirim Sekarang — kirim hanya yang IKUT.\n'
  txt += '🔔/🔕 Auto — ON = add stok langsung terkirim sendiri.\n'
  txt += '🗑 Hapus Antrian — buang semua tanpa mengirim, stok aman.'
  rows.push([{ text: '✅ Ikut Semua', callback_data: 'adm_bc_stokbaru_all_1_pg' + pg }, { text: '❌ Jangan Semua', callback_data: 'adm_bc_stokbaru_all_0_pg' + pg }])
  if (ikut > 0) rows.push([{ text: '👁 Preview Pesan User', callback_data: 'adm_bc_stokbaru_prev' }])
  if (ikut > 0) rows.push([{ text: '✅ Kirim Sekarang (' + ikut + ' produk)', callback_data: 'adm_bc_stokbaru_go' }])
  rows.push([{ text: (autoOn ? '🔔 Auto : ON' : '🔕 Auto : OFF'), callback_data: 'adm_bc_stokbaru_auto_pg' + pg }, { text: '🗑 Hapus Antrian', callback_data: 'adm_bc_stokbaru_clear' }])
  rows.push([{ text: '🔙 Kembali', callback_data: 'adm_broadcast' }])
  await tgEditMessageText(env, chatId, messageId, txt, { inline_keyboard: rows }, 'Markdown')
}

// ─── Notif stok otomatis (cron tiap menit) ───
// Chunked + resumable: state disimpan di StokNotifState (cursor idx) supaya
// ribuan user pun pasti terkirim semua walau satu tick cron dibatasi waktunya.
// Flag notifyPending di StokBaru HANYA di-reset setelah broadcast benar-benar
// selesai → cegah kirim ganda bila tick terpotong di tengah.
// ponytail: user yang sudah blokir bot (403) di-skip, tidak bisa dipaksa kirim.
const STOK_NOTIF_CHUNK = 500

async function stokSendOne(env, sendMsg, sendPhoto, bcImg, uid, msg) {
  if (bcImg) return await sendPhoto(env, uid, bcImg, msg, null, 'Markdown')
  return await sendMsg(env, uid, msg, null, 'Markdown')
}

export async function flushStokBaruNotif(env) {
  const gotLock = await acquireLock(env, 'cron_stoknotif', 55)
  if (!gotLock) return { ok: false, reason: 'locked' }
  try {
    const cfg = await readJSON(env, 'BotConfig', {})
    if (cfg.stokAutoNotif === false) return { ok: false, reason: 'disabled' }

    let st = await readJSON(env, 'StokNotifState', null)
    const list = await readJSON(env, 'StokBaru', [])

    if (!st) {
      const pending = (list || []).filter(e => e.notifyPending && !e.excluded)
      if (pending.length === 0) return { ok: true, sent: 0 }
      // AUTO: 1 pesan = 1 varian (ambil antrian pertama saja, sisanya tick berikutnya)
      const first = pending[0]
      const msg = await buildStokBaruBroadcast(env, true, [first.id])
      if (!msg) return { ok: false, reason: 'empty' }
      const banned = await readJSON(env, 'BannedUser', [])
      const banSet = new Set((banned || []).map(b => String(b.sender)))
      const { getUserList } = await import('./user.js')
      const users = await getUserList(env)
      const targets = (users || []).map(u => u.chatId).filter(id => Number(id) > 0 && !banSet.has(String(id)))
      if (targets.length === 0) {
        const rest0 = (list || []).map(e => (e.notifyPending ? { ...e, notifyPending: false } : e))
        await writeJSON(env, 'StokBaru', rest0)
        return { ok: true, sent: 0, total: 0 }
      }
      // Snapshot HANYA varian yang dikirim sekarang (first). Entri lain
      // (tambah tengah jalan / antrian berikut) tetap pending → siklus berikut.
      st = { msg, targets, idx: 0, sent: 0, retry429: [], snapshot: [{ id: first.id }] }
    }

    const { tgSendMessage: sendMsg, tgSendPhotoBase64: sendPhoto } = await import('./telegram.js')
    const { safeBatchSend: sbs } = await import('./helpers.js')
    const bcImg = cfg.stokBcImg || null
    // Tick ini: kirim chunk dari idx, ditambah retry user 429 dari tick sebelumnya.
    // Q1: via safeBatchSend (±15/dtk, 429 tunggu penuh, stop 5x beruntun).
    const freshStart = st.idx
    const freshEnd = Math.min(st.idx + STOK_NOTIF_CHUNK, st.targets.length)
    const todo = st.retry429.concat(st.targets.slice(freshStart, freshEnd))
    const r = await sbs(todo, (uid) => stokSendOne(env, sendMsg, sendPhoto, bcImg, uid, st.msg))
    const chunkOk = r.sent
    const hardFail = r.failed
    const failed429 = r.rest
    st.idx = freshEnd
    st.sent += chunkOk
    st.retry429 = failed429

    const done = st.idx >= st.targets.length && st.retry429.length === 0
    if (done) {
      // Hanya reset entri yang ada SAAT broadcast mulai. Entrri yang ditambah admin
      // tengah jalan (snapshot baru) tetap pending → dikirim di siklus berikutnya.
      const snapshot = st.snapshot || []
      const seen = new Set(snapshot.map(e => String(e.id)))
      const rest = (list || []).map(e => (seen.has(String(e.id)) ? { ...e, notifyPending: false } : e))
      await writeJSON(env, 'StokBaru', rest)
      await deleteKey(env, 'StokNotifState')
      console.log('[cron] StokBaru auto-notif SELESAI: ' + st.sent + '/' + st.targets.length + (hardFail ? ' (' + hardFail + ' gagal)' : ''))
      return { ok: true, sent: st.sent, total: st.targets.length, done: true }
    }
    await writeJSON(env, 'StokNotifState', st)
    console.log('[cron] StokBaru auto-notif chunk: ' + st.sent + '/' + st.targets.length + (st.retry429.length ? ' (retry ' + st.retry429.length + ' rate-limit)' : ''))
    return { ok: true, sent: st.sent, total: st.targets.length, done: false }
  } finally {
    await releaseLock(env, 'cron_stoknotif')
  }
}

export async function handleAdminState(env, msg, state) {
  const chatId = msg.chat.id
  const fromId = msg.from.id

  // Support kirim base64 via file .txt
  let text = msg.text ? msg.text.trim() : ''
  let isTxtFile = false
  if (!text && msg.document) {
    const doc = msg.document
    const fname = (doc.file_name || '').toLowerCase()
    const isLoadDb = state && state.action === 'settings_load_db'
    if (isLoadDb) {
      if (!fname.endsWith('.json')) {
        await tgSendMessage(env, chatId, '⚠️ Hanya file .json yang didukung untuk memulihkan database.')
        return
      }
    } else {
      if (fname.endsWith('.txt') || doc.mime_type === 'text/plain') {
        try {
          const fileInfo = await tgGetFile(env, doc.file_id)
          if (fileInfo && fileInfo.file_path) {
            const content = await tgDownloadFile(env, fileInfo.file_path)
            if (content) { text = content.trim(); isTxtFile = true }
          }
        } catch(e) {
          await tgSendMessage(env, chatId, '❌ Gagal membaca file: ' + e.message)
          return
        }
      } else {
        await tgSendMessage(env, chatId, '⚠️ Hanya file .txt yang didukung. Kirim teks atau file .txt.')
        return
      }
    }
  }

  if (!(await checkAdmin(env, fromId, chatId))) {
    await deleteKey(env, 'adminState_' + fromId)
    return
  }

  if (text.toLowerCase() === '/batal') {
    if (state.promptMid) { try { await tgDeleteMessage(env, chatId, state.promptMid) } catch (e) {} }
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '❌ Perintah dibatalkan.', adminMainPanel(), 'Markdown')
    return
  }

  // ── DB: kredensial Turso via bot (token dihapus otomatis setelah disimpan) ──
  if (state.action === 'db_turso_url') {
    const v = (text||'').trim()
    if (!v || v.length < 8 || !/^(libsql|https?):\/\//i.test(v)) { await tgSendMessage(env, chatId, '⚠️ URL tidak valid. Contoh: `libsql://xxx.turso.io`'); return }
    const cfg = await readJSON(env, 'BotConfig', {}); cfg.db = { ...(cfg.db || {}), url: v }; await writeJSON(env, 'BotConfig', cfg)
    const { resetDbCache } = await import('./db.js')
    resetDbCache(env)
    try { if (msg.message_id) await tgDeleteMessage(env, chatId, msg.message_id) } catch (e) {}
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Turso URL disimpan.', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'db_turso_token') {
    const v = (text||'').trim()
    if (!v || v.length < 8) { await tgSendMessage(env, chatId, '⚠️ Token tidak valid.'); return }
    const cfg = await readJSON(env, 'BotConfig', {}); cfg.db = { ...(cfg.db || {}), token: v }; await writeJSON(env, 'BotConfig', cfg)
    const { resetDbCache } = await import('./db.js')
    resetDbCache(env)
    try { if (msg.message_id) await tgDeleteMessage(env, chatId, msg.message_id) } catch (e) {}
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Turso token disimpan (tersembunyi).', adminMainPanel(), 'Markdown'); return
  }

  // ── SALDO MANUAL: pilih user ──
  if (state.action === 'saldo_pick_user') {
    const q = (text || '').trim()
    const { getUserList } = await import('./user.js')
    const users = await getUserList(env)
    const u = users.find(x => String(x.chatId) === q || (x.name && x.name.toLowerCase().includes(q.toLowerCase())))
    if (!u) { await tgSendMessage(env, chatId, '⚠️ User tidak ditemukan. Kirim ID atau nama (harus /start dulu).\n_Ketik /batal jika tidak jadi._'); return }
    await writeJSON(env, 'adminState_' + fromId, { action: 'saldo_amount', targetId: u.chatId, targetName: u.name })
    await tgSendMessage(env, chatId, '*💰 Saldo Manual: ' + (u.name || u.chatId) + '*\nSaldo saat ini: ' + ParseIdr(u.balance || 0) + '\n\nKirim nominal dengan tanda:\n`+50000` tambah · `-20000` kurangi\n_Ketik /batal jika tidak jadi._', null, 'Markdown')
    return
  }
  // ── SALDO MANUAL: nominal +/-, max 2jt/tx ──
  if (state.action === 'saldo_amount') {
    const m = (text || '').trim().match(/^([+-])\s?(\d+)$/)
    if (!m) { await tgSendMessage(env, chatId, '⚠️ Format salah. Contoh: `+50000` atau `-20000`.'); return }
    const amt = parseInt(m[2])
    if (!amt || amt <= 0 || amt > 2000000) { await tgSendMessage(env, chatId, '⚠️ Nominal 1–2.000.000 per transaksi.'); return }
    const delta = m[1] === '+' ? amt : -amt
    const { getUser, addSaldo, minSaldo, cekSaldo } = await import('./user.js')
    const target = await getUser(env, state.targetId)
    if (!target) { await deleteKey(env, 'adminState_' + fromId); await tgSendMessage(env, chatId, '⚠️ User hilang.'); return }
    if (delta < 0 && (Number(target.balance) || 0) < amt) { await tgSendMessage(env, chatId, '⚠️ Saldo user tidak cukup (' + ParseIdr(target.balance || 0) + ').'); return }
    const newBal = delta > 0 ? await addSaldo(env, state.targetId, amt) : await minSaldo(env, state.targetId, amt)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Saldo *' + (target.name || state.targetId) + '* diubah ' + (delta > 0 ? '+' : '-') + ParseIdr(amt) + '.\nSaldo baru: ' + ParseIdr(newBal || 0), adminMainPanel(), 'Markdown')
    try { await tgSendMessage(env, state.targetId, '💰 *Saldo Anda diubah admin* ' + (delta > 0 ? '+' : '-') + ParseIdr(amt) + '\nSaldo baru: ' + ParseIdr(newBal || 0), null, 'Markdown') } catch (e) {}
    return
  }

  // ── ADD STOCK: kirim data stok ──
  if (state.action === 'addstock_data') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) {
      await tgSendMessage(env, chatId, '⚠️ Tidak ada data. Kirim ulang (setiap baris = 1 item) atau /batal.')
      return
    }
    const newState = { ...state, action: 'addstock_waiting_expired', stokLines: lines }
    await writeJSON(env, 'adminState_' + fromId, newState)
    await tgSendMessage(env, chatId,
      '✅ *' + lines.length + ' item terdeteksi.*\n\nPilih masa expired stok:\n\n_Ketik /batal jika tidak jadi._',
      expiredButtons(), 'Markdown'
    )
    return
  }

  // ── ADD STOCK: custom expired input ──
  if (state.action === 'addstock_custom_expired') {
    const days = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(days) || days <= 0) {
      await tgSendMessage(env, chatId, '⚠️ Masukkan angka hari yang valid. Contoh: *45*', null, 'Markdown')
      return
    }
    const expiredAt = getExpiredDateWIB(days)
    await doSaveStock(env, chatId, fromId, state, expiredAt, days)
    return
  }

  // ── EDIT HARGA ──
// ═══════════════════════════════════════════════════════

  // ══ FS STEP 2: input harga sale ══
  if (state.action === 'fs_price') {
    const harga = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(harga) || harga < 100) {
      await tgSendMessage(env, chatId, '⚠️ Harga tidak valid. Ketik angka minimal 100. Contoh: `25000`', null, 'Markdown')
      return
    }
    if (harga >= Number(state.originalPrice)) {
      await tgSendMessage(env, chatId, '⚠️ Harga sale harus < harga normal (' + ParseIdr(state.originalPrice) + ').')
      return
    }
    // transisi ke await_dur (tunggu pilih preset/custom)
    await writeJSON(env, 'adminState_' + fromId, { ...state, action: 'fs_await_dur', salePrice: harga })
    const pct = Math.round((state.originalPrice - harga) / state.originalPrice * 100)
    const kb = {
      inline_keyboard: [
        [{ text: '⏰ 30 menit', callback_data: 'adm_fs_dur_30m' },
         { text: '⏰ 1 jam',    callback_data: 'adm_fs_dur_1h' }],
        [{ text: '⏰ 6 jam',    callback_data: 'adm_fs_dur_6h' },
         { text: '⏰ 24 jam',   callback_data: 'adm_fs_dur_24h' }],
        [{ text: '✏️ Custom (ketik)', callback_data: 'adm_fs_dur_custom' }],
        [{ text: '🔙 Batal', callback_data: 'adm_flashsale' }]
      ]
    }
    let cap = '*⏰ Flash Sale — STEP 3/4: Durasi*\n\n'
    cap += '📦 ' + state.variantName + '\n'
    cap += '💰 ' + ParseIdr(state.originalPrice) + ' → *' + ParseIdr(harga) + '*\n'
    cap += '🎯 Hemat ' + pct + '%\n\n'
    cap += 'Pilih durasi:'
    await tgSendMessage(env, chatId, cap, kb, 'Markdown')
    return
  }

  // ══ FS STEP 3 (custom): parse durasi text ══
  if (state.action === 'fs_duration_custom') {
    const parsed = voucherParseExpiry(text)
    if (!parsed || parsed.ms <= 0) {
      await tgSendMessage(env, chatId, '⚠️ Durasi tidak valid. Contoh: `45m`, `2h`, `3d`\n\n_Ketik /batal jika tidak jadi._', null, 'Markdown')
      return
    }
    if (parsed.ms > 30 * 24 * 3600 * 1000) {
      await tgSendMessage(env, chatId, '⚠️ Durasi maksimal 30 hari untuk flash sale.')
      return
    }
    const expiresAt = Date.now() + parsed.ms
    await writeJSON(env, 'adminState_' + fromId, {
      ...state, action: 'fs_confirm', durationMs: parsed.ms, durationLabel: parsed.label, expiresAt
    })
    await fsShowConfirm(env, chatId, null, fromId)
    return
  }

  // ══ SETTINGS: banner Flash Sale (base64 upload via txt) ══
  if (state.action === 'settings_fs_banner') {
    const b64 = text.trim().replace(/^data:image\/[a-z]+;base64,/i, '')
    if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 100) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*🔥 Banner Flash Sale*\n\n⚠️ *Isi tidak terlihat seperti base64 gambar valid.* Coba lagi:\n\nKirim file *.txt* berisi *base64* gambar banner Flash Sale.\n\n_Ketik /batal jika tidak jadi._',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Isi tidak terlihat seperti base64 gambar valid. Coba lagi.')
      }
      return
    }
    const cfgB = await readJSON(env, 'BotConfig', {})
    cfgB.bannerFsB64 = b64
    await writeJSON(env, 'BotConfig', cfgB)
    await deleteKey(env, 'adminState_' + fromId)
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId,
        '✅ Banner Flash Sale disimpan (' + b64.length + ' chars).',
        { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
      )
    } else {
      await tgSendMessage(env, chatId,
        '✅ Banner Flash Sale disimpan (' + b64.length + ' chars). Preview akan muncul di broadcast berikutnya.',
        { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
      )
    }
    return
  }

  // ══ SETTINGS: banner Update Harga (base64 upload via txt) ══
  if (state.action === 'settings_price_banner') {
    const b64 = text.trim().replace(/^data:image\/[a-z]+;base64,/i, '')
    if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 100) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*💰 Banner Update Harga*\n\n⚠️ *Isi tidak terlihat seperti base64 gambar valid.* Coba lagi:\n\nKirim file *.txt* berisi *base64* gambar banner Update Harga.',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Isi tidak terlihat seperti base64 gambar valid. Coba lagi.')
      }
      return
    }
    const cfgB = await readJSON(env, 'BotConfig', {})
    cfgB.bannerPriceB64 = b64
    await writeJSON(env, 'BotConfig', cfgB)
    await deleteKey(env, 'adminState_' + fromId)
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId,
        '✅ Banner Update Harga disimpan (' + b64.length + ' chars).',
        { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
      )
    } else {
      await tgSendMessage(env, chatId,
        '✅ Banner Update Harga disimpan (' + b64.length + ' chars). Preview akan muncul di BC Harga berikutnya.',
        { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
      )
    }
    return
  }

  // ══ SETTINGS: success sticker ══
  if (state.action === 'settings_success_sticker') {
    if (!msg.sticker) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*✨ UPLOAD STIKER SUKSES*\n\nSilakan kirimkan sebuah stiker langsung (bukan gambar/base64/teks) untuk ditampilkan saat transaksi sukses.\n\n⚠️ *Kirimkan sebuah stiker langsung (bukan teks/gambar/file)!*',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Kirimkan sebuah stiker langsung (bukan teks/gambar/file).')
      }
      return
    }
    const stickerFileId = msg.sticker.file_id
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.successSticker = stickerFileId
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId,
        '✅ *Sticker Sukses berhasil disimpan!*',
        { inline_keyboard: [[{ text: '🔙 Kembali ke Settings', callback_data: 'adm_setfolder_media' }]] }, 'Markdown'
      )
    } else {
      await tgSendMessage(env, chatId, '✅ *Sticker Sukses berhasil disimpan!*', {
        inline_keyboard: [[{ text: '🔙 Kembali ke Settings', callback_data: 'adm_setfolder_media' }]]
      }, 'Markdown')
    }
    return
  }

// ─── STOK YATIM: eksekusi kembalikan ke varian (state handler) ───
  if (state.action === 'yatim_restore') {
    const vid = text.trim()
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(vid))
    if (!p) { await tgSendMessage(env, chatId, '⚠️ ID varian tidak ditemukan. Cek di 👁 Lihat Stok.'); return }
    let yatim = []
    try { yatim = await readJSON(env, 'StokYatim', []) } catch (e) {}
    const y = yatim[state.yatimIdx]
    if (!y || !y.items || y.items.length === 0) { await deleteKey(env, 'adminState_' + fromId); await tgSendMessage(env, chatId, '⚠️ Data sudah kosong.'); return }
    p.stok = (y.items || []).concat(p.stok || [])
    await writeJSON(env, 'Produk', produk)
    yatim.splice(state.yatimIdx, 1)
    await writeJSON(env, 'StokYatim', yatim)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ *' + y.items.length + ' item* dikembalikan ke *' + p.nameproduct + '* (stok sekarang: ' + p.stok.length + ')',
      adminMainPanel(), 'Markdown'
    )
    return
  }

  if (state.action === 'editharga') {
    const harga = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(harga) || harga <= 0) {
      await tgSendMessage(env, chatId, '⚠️ Harga tidak valid. Masukkan angka. Contoh: 25000')
      return
    }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.variantId))
    if (!p) { await deleteKey(env, 'adminState_' + fromId); return }
    const hargaLama = p.price
    p.price = harga
    await writeJSON(env, 'Produk', produk)
    await deleteKey(env, 'adminState_' + fromId)

    // ══ v9update18: FS-aware recalc ══
    let fsWarn = ''
    const allFs = await readJSON(env, 'FlashSale', {})
    const fsCur = allFs[String(state.variantId)]
    if (fsCur) {
      if (harga <= Number(fsCur.salePrice)) {
        const { flashSaleCancel } = await import('./user.js')
        await flashSaleCancel(env, state.variantId, 'price_edit_below_sale')
        fsWarn = '\n\n⚠️ _Flash Sale otomatis DIHENTIKAN karena harga baru ≤ harga sale (' + ParseIdr(fsCur.salePrice) + ')._'
      } else {
        const oldPct = fsCur.discountPercent || 0
        fsCur.originalPrice = harga
        fsCur.discountPercent = Math.round((harga - fsCur.salePrice) / harga * 100)
        const { flashSaleSetActive } = await import('./user.js')
        await flashSaleSetActive(env, state.variantId, fsCur)
        if (fsCur.broadcasted) {
          fsWarn = '\n\n⚠️ _Flash Sale sudah di-BROADCAST dengan hemat ' + oldPct + '%. Sekarang discount jadi ' + fsCur.discountPercent + '% (mismatch dengan broadcast lama)._'
        } else {
          fsWarn = '\n\nℹ️ _Flash Sale aktif: discount dihitung ulang jadi ' + fsCur.discountPercent + '%._'
        }
      }
    }

    // ══ v9update18: log price change utk BC Harga button ══
    await writeJSON(env, 'PriceChangeLog_' + state.variantId, {
      variantId: state.variantId, oldPrice: hargaLama, newPrice: harga, at: Date.now(), by: fromId
    })

    const delta = Math.abs(harga - hargaLama)
    const pct = hargaLama > 0 ? Math.round(delta / hargaLama * 100) : 0
    let arah = ''
    if (harga < hargaLama) arah = ' (turun ' + pct + '%)'
    else if (harga > hargaLama) arah = ' (naik ' + pct + '%)'
    const kb = {
      inline_keyboard: [
        [{ text: '📢 BC Harga Baru', callback_data: 'adm_bc_harga_' + state.variantId }],
        [{ text: '⏭️ Tidak Perlu', callback_data: 'adm_panel' }]
      ]
    }
    await tgSendMessage(env, chatId,
      '✅ *Harga berhasil diubah*\n\n📦 ' + p.nameproduct + '\n💰 ' + ParseIdr(hargaLama) + ' → *' + ParseIdr(harga) + '*' + arah + fsWarn + '\n\n_Mau BC harga baru ke user?_',
      kb, 'Markdown'
    )
    return
  }

  // ── EDIT NAMA VARIAN ──
  if (state.action === 'editnama_variant') {
    if (text.length < 2) {
      await tgSendMessage(env, chatId, '⚠️ Nama terlalu pendek.')
      return
    }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.variantId))
    if (!p) { await deleteKey(env, 'adminState_' + fromId); return }
    const namaLama = p.nameproduct
    p.nameproduct = text
    await writeJSON(env, 'Produk', produk)
    // Sync nama ke FlashSale aktif (snapshot dibuat sekali saat FS dibuat)
    try {
      const { flashSaleGetActive, flashSaleSetActive } = await import('./user.js')
      const fsCur = await flashSaleGetActive(env, state.variantId)
      if (fsCur) {
        fsCur.variantName = text
        await flashSaleSetActive(env, state.variantId, fsCur)
      }
    } catch (e) { /* FS tidak aktif — abaikan */ }
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ Nama varian diperbarui\nSebelum: *' + namaLama + '*\nSekarang: *' + text + '*',
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ── EDIT DESKRIPSI VARIAN ──
  if (state.action === 'editdesc') {
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.variantId))
    if (!p) { await deleteKey(env, 'adminState_' + fromId); return }
    const lower = text.trim().toLowerCase()
    if (lower === '-/hapus' || lower === 'hapus' || lower === 'kosong' || lower === '-') p.desc = ''
    else p.desc = text
    await writeJSON(env, 'Produk', produk)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ Deskripsi *' + p.nameproduct + '* berhasil ' + (p.desc === '' ? 'dihapus.' : 'diperbarui.'),
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ── EDIT DESKRIPSI KATEGORI ──
  if (state.action === 'editkatdesc') {
    const kategori = await readJSON(env, 'Kategori', [])
    const k = kategori.find(kk => String(kk.id) === String(state.katId))
    if (!k) { await deleteKey(env, 'adminState_' + fromId); return }
    const lower = text.trim().toLowerCase()
    if (lower === '-/hapus' || lower === 'hapus' || lower === 'kosong' || lower === '-') k.desc = ''
    else k.desc = text
    await writeJSON(env, 'Kategori', kategori)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ Deskripsi kategori *' + k.produkName + '* berhasil ' + (k.desc === '' ? 'dihapus.' : 'diperbarui.'),
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ── EDIT SNK ──
  if (state.action === 'editsnk') {
    const snkList = await readJSON(env, 'SnK', [])
    const find = snkList.find(s => String(s.id) === String(state.kategoriId))
    if (find) { find.snk = text } else { snkList.push({ id: parseInt(state.kategoriId), snk: text }) }
    await writeJSON(env, 'SnK', snkList)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ Syarat & Ketentuan berhasil diperbarui.',
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ── DEL STOCK: konfirmasi jumlah ──
  if (state.action === 'delstock_jumlah') {
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.variantId))
    if (!p) { await deleteKey(env, 'adminState_' + fromId); return }
    const isAll = text.toLowerCase() === 'semua' || text.toLowerCase() === 'all'
    const stokLen = p.stok ? p.stok.length : 0
    const jumlah = isAll ? stokLen : parseInt(text)
    if (!isAll && (isNaN(jumlah) || jumlah <= 0)) {
      await tgSendMessage(env, chatId, '⚠️ Input tidak valid. Ketik angka 1-' + stokLen + ' atau *semua*.', null, 'Markdown')
      return
    }
    if (jumlah > stokLen) {
      await tgSendMessage(env, chatId, '⚠️ Stok hanya tersisa *' + stokLen + '*. Ketik angka 1-' + stokLen + ' atau *semua*.', null, 'Markdown')
      return
    }
    const newState = { ...state, action: 'delstock_konfirmasi', jumlah }
    await writeJSON(env, 'adminState_' + fromId, newState)
    await tgSendMessage(env, chatId,
      '⚠️ Yakin hapus *' + jumlah + ' stok* dari *' + p.nameproduct + '*?\n\n_Ketik /batal jika tidak jadi._',
      confirmButtons('adm_konfirmasi_delstock'), 'Markdown'
    )
    return
  }

  // ── ADD KATEGORI: step nama ──
  if (state.action === 'single_price') {
    const hargaS = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(hargaS) || hargaS <= 0) { await tgSendMessage(env, chatId, '⚠️ Harga tidak valid. Contoh: 25000'); return }
    const kategoriS = await readJSON(env, 'Kategori', [])
    const katS = kategoriS.find(k => String(k.id) === String(state.katId))
    if (!katS) { await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.'); await deleteKey(env, 'adminState_' + fromId); return }
    await writeJSON(env, 'adminState_' + fromId, { action: 'single_desc', katId: state.katId, hargaS, namaS: katS.produkName })
    await tgSendMessage(env, chatId,
      '*Nama:* ' + katS.produkName + '\n*Harga:* ' + ParseIdr(hargaS) + '\n\nMasukkan deskripsi produk, atau klik tombol skip:\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '⏭️ Skip — Lewati Deskripsi', callback_data: 'adm_skip_desc_single' }]] },
      'Markdown'
    )
    return
  }

  if (state.action === 'single_desc') {
    const kategoriS = await readJSON(env, 'Kategori', [])
    const katS = kategoriS.find(k => String(k.id) === String(state.katId))
    if (!katS) { await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.'); await deleteKey(env, 'adminState_' + fromId); return }
    const produkS = await readJSON(env, 'Produk', [])
    const newIdS = produkS.length > 0 ? Math.max(...produkS.map(p => p.id)) + 1 : 1
    const descS = text === '-' ? '' : text
    produkS.push({ id: newIdS, nameproduct: katS.produkName, price: state.hargaS, category: katS.produkId, desc: descS, stok: [], single: true })
    await writeJSON(env, 'Produk', produkS)
    await writeJSON(env, 'adminState_' + fromId, { action: 'addstock_data', variantId: newIdS, variantName: katS.produkName })
    await tgSendMessage(env, chatId,
      '✅ Produk tunggal *' + katS.produkName + '* dibuat (ID: ' + newIdS + ', ' + ParseIdr(state.hargaS) + ').\n\n📦 Sekarang kirim data stok (tiap baris 1 item). /batal untuk membatalkan.\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  if (state.action === 'addkat_nama') {
    if (text.length < 2) { await tgSendMessage(env, chatId, '⚠️ Nama terlalu pendek. Minimal 2 huruf.'); return }
    // Tolak nama kategori duplikat (case-insensitive)
    const kategori = await readJSON(env, 'Kategori', [])
    if (kategori.some(k => (k.produkName || '').toLowerCase().trim() === text.toLowerCase().trim())) {
      await tgSendMessage(env, chatId, '⚠️ Kategori *' + text + '* sudah ada. Pakai nama lain.', null, 'Markdown')
      return
    }
    const newState = { action: 'addkat_desc', namaKat: text }
    await writeJSON(env, 'adminState_' + fromId, newState)
    await tgSendMessage(env, chatId,
      '*Nama:* ' + text + '\n\nMasukkan deskripsi kategori, atau klik tombol skip:\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '⏭️ Skip — Lewati Deskripsi', callback_data: 'adm_skip_desc' }]] },
      'Markdown'
    )
    return
  }

  // ── ADD KATEGORI: step desc (jika ketik manual, bukan klik Skip) ──
  if (state.action === 'addkat_desc') {
    await _saveKategori(env, chatId, fromId, state.namaKat, text)
    return
  }

  // ── ADD VARIAN: step nama ──
  if (state.action === 'addvarian_nama') {
    if (text.length < 1) { await tgSendMessage(env, chatId, '⚠️ Nama varian tidak boleh kosong.'); return }
    // Tolak nama varian duplikat dalam kategori yang sama (case-insensitive)
    const produk = await readJSON(env, 'Produk', [])
    const kategori = await readJSON(env, 'Kategori', [])
    const kat = kategori.find(k => String(k.id) === String(state.katId))
    if (kat && produk.some(p => p.category === kat.produkId && (p.nameproduct || '').toLowerCase().trim() === text.toLowerCase().trim())) {
      await tgSendMessage(env, chatId, '⚠️ Varian *' + text + '* sudah ada di kategori ini. Pakai nama lain.', null, 'Markdown')
      return
    }
    const newState = { action: 'addvarian_harga', katId: state.katId, varianNama: text }
    await writeJSON(env, 'adminState_' + fromId, newState)
    await tgSendMessage(env, chatId,
      '📦 Nama varian: *' + text + '*\n\nMasukkan harga (angka saja, contoh: 25000):\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ── ADD VARIAN: step harga ──
  if (state.action === 'addvarian_harga') {
    const harga = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(harga) || harga <= 0) {
      await tgSendMessage(env, chatId, '⚠️ Harga tidak valid. Masukkan angka. Contoh: 25000')
      return
    }
    await writeJSON(env, 'adminState_' + fromId, { action: 'addvarian_desc', katId: state.katId, varianNama: state.varianNama, harga })
    await tgSendMessage(env, chatId,
      '📦 Nama varian: *' + state.varianNama + '*\n💵 Harga: *' + ParseIdr(harga) + '*\n\nMasukkan deskripsi varian, atau klik tombol skip:\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '⏭️ Skip — Lewati Deskripsi', callback_data: 'adm_skip_desc_varian' }]] },
      'Markdown'
    )
    return
  }

  // ── ADD VARIAN: step desc ──
  if (state.action === 'addvarian_desc') {
    const kategori = await readJSON(env, 'Kategori', [])
    const kat = kategori.find(k => String(k.id) === String(state.katId))
    if (!kat) {
      await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.')
      await deleteKey(env, 'adminState_' + fromId)
      return
    }
    const produk = await readJSON(env, 'Produk', [])
    const newId = produk.length > 0 ? Math.max(...produk.map(p => p.id)) + 1 : 1
    const desc = text === '-' ? '' : text
    produk.push({
      id: newId,
      nameproduct: state.varianNama,
      price: state.harga,
      category: kat.produkId,
      desc: desc,
      stok: []
    })
    await writeJSON(env, 'Produk', produk)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ Varian *' + state.varianNama + '* ditambahkan ke *' + kat.produkName + '*\n' +
      'Harga: *' + ParseIdr(state.harga) + '*\nID Varian: *' + newId + '*\n\nMau tambah varian lagi?',
      afterAddVarianButtons(state.katId), 'Markdown'
    )
    return
  }


  // --- SETTINGS STATES ---
  if (state.action === 'settings_caraorder') {
    if (text.length > 2000) { await tgSendMessage(env, chatId, '⚠️ Max 2000 karakter.'); return }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.caraOrderText = text
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Pesan Cara Order diperbarui!', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_namabot') {
    const clean = text.replace(/[\r\n\t\v\f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (clean.length < 2) { await tgSendMessage(env, chatId, '⚠️ Min 2 karakter.'); return }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.NamaBot = clean
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Nama Bot diperbarui: `' + clean + '`\n_Berlaku otomatis di semua tempat (file txt, ID order, footer)._', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_storename') {
    const clean = text.replace(/[\r\n\t\v\f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (clean.length < 2) { await tgSendMessage(env, chatId, '⚠️ Min 2 karakter.'); return }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.StoreName = clean
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Nama Toko diperbarui: `' + clean + '`', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_botname') {
    const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
    if (clean.length < 2) { await tgSendMessage(env, chatId, '⚠️ Min 2 karakter.'); return }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.orderBotName = clean
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Nama Bot diperbarui: *' + clean + '*\nContoh ID: `' + clean + '-241026-A1B2`', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_banner_start') {
    const b64 = text.trim()
    if (b64.length < 100) { await tgSendMessage(env, chatId, '⚠️ String base64 terlalu pendek.'); return }
    if (!/^[A-Za-z0-9+\/=]+$/.test(b64.replace(/^data:image\/\w+;base64,/, ''))) {
      await tgSendMessage(env, chatId, '⚠️ Format base64 tidak valid.'); return
    }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.bannerStartB64 = b64
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Banner Start disimpan!', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_banner_list') {
    const b64l = text.trim()
    if (b64l.length < 100) { await tgSendMessage(env, chatId, '⚠️ String base64 terlalu pendek.'); return }
    if (!/^[A-Za-z0-9+\/=]+$/.test(b64l.replace(/^data:image\/\w+;base64,/, ''))) {
      await tgSendMessage(env, chatId, '⚠️ Format base64 tidak valid.'); return
    }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.bannerListB64 = b64l
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Banner List Produk disimpan!', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_bcstok_img') {
    const b64s = text.trim()
    if (b64s.length < 100) { await tgSendMessage(env, chatId, '⚠️ String base64 terlalu pendek.'); return }
    if (!/^[A-Za-z0-9+\/=]+$/.test(b64s.replace(/^data:image\/\w+;base64,/, ''))) {
      await tgSendMessage(env, chatId, '⚠️ Format base64 tidak valid.'); return
    }
    const cfgb = await readJSON(env, 'BotConfig', {})
    cfgb.stokBcImg = b64s
    await writeJSON(env, 'BotConfig', cfgb)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Gambar Broadcast Stok disimpan! Akan disertakan saat broadcast stok terbaru.', adminMainPanel(), 'Markdown')
    return
  }
  if (state.action === 'settings_lb_banner') {
    const b64lb = text.trim()
    if (b64lb.length < 100 || !/^[A-Za-z0-9+\/=]+$/.test(b64lb.replace(/^data:image\/\w+;base64,/, ''))) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*🖼️ UPLOAD BANNER LEADERBOARD*\n\nSilakan kirimkan string gambar base64 untuk banner Leaderboard.\n\n⚠️ *Format base64 tidak valid atau terlalu pendek.*',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Format base64 tidak valid atau terlalu pendek.')
      }
      return
    }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.leaderboardBanner = b64lb
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId, '✅ Banner Leaderboard disimpan!', adminMainPanel(), 'Markdown')
    } else {
      await tgSendMessage(env, chatId, '✅ Banner Leaderboard disimpan!', adminMainPanel(), 'Markdown')
    }
    return
  }
  if (state.action === 'settings_ticket_channel') {
    const clean = text.trim()
    if (!/^-?\d+$/.test(clean)) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*🎫 SETTING LOG TIKET (GRUP/CHANNEL)*\n\n⚠️ *ID Channel tidak valid. Harus berupa angka.* Coba lagi:',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ ID Channel tidak valid. Harus berupa angka. Coba lagi:')
      }
      return
    }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.channelTicket = clean
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId, '✅ Channel Tiket diperbarui ke: `' + clean + '`', adminMainPanel(), 'Markdown')
    } else {
      await tgSendMessage(env, chatId, '✅ Channel Tiket diperbarui ke: `' + clean + '`', adminMainPanel(), 'Markdown')
    }
    return
  }
  if (state.action === 'settings_channel_log') {
    const input = text.trim()
    let cleanId = ''
    let threadId = null

    // 1. Cek link t.me
    const linkRegex = /(?:https?:\/\/)?t\.me\/([^\s\/]+)(?:\/(\d+))?/i
    const match = input.match(linkRegex)
    if (match) {
      const chatPart = match[1]
      const threadPart = match[2]
      if (chatPart === 'c' && input.includes('/c/')) {
        const privateMatch = input.match(/\/c\/(\d+)(?:\/(\d+))?/i)
        if (privateMatch) {
          cleanId = '-100' + privateMatch[1]
          threadId = privateMatch[2] || null
        }
      } else {
        cleanId = '@' + chatPart
        threadId = threadPart || null
      }
    } else {
      // 2. Cek format manual ChatID:ThreadID
      if (input.includes(':')) {
        const parts = input.split(':')
        cleanId = parts[0].trim()
        threadId = parts[1].trim()
      } else {
        cleanId = input
      }
    }

    const isValidId = /^-?\d+$/.test(cleanId) || /^@[a-zA-Z0-9_]+$/.test(cleanId)
    const isValidThread = threadId === null || /^\d+$/.test(threadId)

    if (!isValidId || !isValidThread) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*📢 SETTING CHANNEL LOG TRANSAKSI*\n\n⚠️ *ID/Link tidak valid!* Coba lagi dengan memasukkan ID Channel, format `GrupID:ThreadID`, atau paste Link Topik:\nContoh: `-1001234567890:5` atau `https://t.me/c/1234567890/5`',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ ID/Link tidak valid! Masukkan ID, format `ID:Thread`, atau paste Link Topik.')
      }
      return
    }

    const finalVal = threadId ? `${cleanId}:${threadId}` : cleanId
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.ChannelLog = finalVal
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    const { initConfig } = await import('./config.js')
    await initConfig(env)
    
    const displayVal = threadId ? `Chat ID: \`${cleanId}\` & Thread ID: \`${threadId}\`` : `\`${cleanId}\``
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId, '✅ Channel Log Transaksi diperbarui ke: ' + displayVal, adminMainPanel(), 'Markdown')
    } else {
      await tgSendMessage(env, chatId, '✅ Channel Log Transaksi diperbarui ke: ' + displayVal, adminMainPanel(), 'Markdown')
    }
    return
  }

  if (state.action === 'settings_channel_backup') {
    const input = text.trim()
    let cleanId = ''
    let threadId = null

    const linkRegex = /(?:https?:\/\/)?t\.me\/([^\s\/]+)(?:\/(\d+))?/i
    const match = input.match(linkRegex)
    if (match) {
      const chatPart = match[1]
      const threadPart = match[2]
      if (chatPart === 'c' && input.includes('/c/')) {
        const privateMatch = input.match(/\/c\/(\d+)(?:\/(\d+))?/i)
        if (privateMatch) {
          cleanId = '-100' + privateMatch[1]
          threadId = privateMatch[2] || null
        }
      } else {
        cleanId = '@' + chatPart
        threadId = threadPart || null
      }
    } else {
      if (input.includes(':')) {
        const parts = input.split(':')
        cleanId = parts[0].trim()
        threadId = parts[1].trim()
      } else {
        cleanId = input
      }
    }

    const isValidId = /^-?\d+$/.test(cleanId) || /^@[a-zA-Z0-9_]+$/.test(cleanId)
    const isValidThread = threadId === null || /^\d+$/.test(threadId)

    if (!isValidId || !isValidThread) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*💾 SETTING CHANNEL BACKUP DB*\n\n⚠️ *ID/Link tidak valid!* Coba lagi dengan memasukkan ID Channel, format `GrupID:ThreadID`, atau paste Link Topik:\nContoh: `-1001234567890:5` atau `https://t.me/c/1234567890/5`',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ ID/Link tidak valid! Masukkan ID, format `ID:Thread`, atau paste Link Topik.')
      }
      return
    }

    const finalVal = threadId ? `${cleanId}:${threadId}` : cleanId
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.channelBackup = finalVal
    await writeJSON(env, 'BotConfig', cfg)
    await deleteKey(env, 'adminState_' + fromId)
    const { initConfig } = await import('./config.js')
    await initConfig(env)
    
    const displayVal = threadId ? `Chat ID: \`${cleanId}\` & Thread ID: \`${threadId}\`` : `\`${cleanId}\``
    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId, '✅ Channel Backup DB diperbarui ke: ' + displayVal, adminMainPanel(), 'Markdown')
    } else {
      await tgSendMessage(env, chatId, '✅ Channel Backup DB diperbarui ke: ' + displayVal, adminMainPanel(), 'Markdown')
    }
    return
  }
  if (state.action === 'add_admin_id') {
    const targetId = parseInt(text)
    if (!targetId || isNaN(targetId)) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*👑 TAMBAH ADMIN BARU*\n\n⚠️ *User ID tidak valid! Harus berupa angka.*\n\nSilakan masukkan Telegram User ID calon admin yang baru:\n\n_Ketik /batal jika batal._',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ User ID tidak valid. Harus berupa angka. Coba lagi:')
      }
      return
    }

    if (String(targetId) === String(fromId) || isOwner(targetId)) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*👑 TAMBAH ADMIN BARU*\n\n⚠️ *ID ini adalah milik Owner.*\n\nSilakan masukkan Telegram User ID calon admin yang baru:\n\n_Ketik /batal jika batal._',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ ID tersebut adalah milik Owner.')
      }
      return
    }

    const roles = await readJSON(env, 'Role', [])
    const currentAdmins = roles.filter(r => r.role === 'admin')
    if (currentAdmins.length >= 10) {
      await deleteKey(env, 'adminState_' + fromId)
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '⚠️ *Kuota admin sudah penuh (Maksimal 10)!*',
          { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Kuota admin sudah penuh (Maksimal 10)!')
      }
      return
    }

    if (currentAdmins.some(r => String(r.id) === String(targetId))) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*👑 TAMBAH ADMIN BARU*\n\n⚠️ *User ID tersebut sudah menjadi Admin!*\n\nSilakan masukkan Telegram User ID lain:\n\n_Ketik /batal jika batal._',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ User ID tersebut sudah menjadi Admin.')
      }
      return
    }

    const { isRegistered, addRole } = await import('./user.js')
    const isReg = await isRegistered(env, targetId)
    if (!isReg) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*👑 TAMBAH ADMIN BARU*\n\n⚠️ *User ID tersebut belum terdaftar / belum pernah menekan /start di bot ini!*\n\nMinta calon admin memulai bot terlebih dahulu.\n\n_Ketik /batal jika batal._',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ User ID tersebut belum terdaftar di bot ini!')
      }
      return
    }

    await addRole(env, targetId, 'admin')

    try {
      await tgSendMessage(env, targetId, '🎉 *Selamat! Anda telah diangkat menjadi Admin Bot oleh Owner.*', null, 'Markdown')
    } catch (e) {}

    await deleteKey(env, 'adminState_' + fromId)

    if (state.cardMessageId) {
      await tgEditMessageText(env, chatId, state.cardMessageId,
        '✅ *User ID `' + targetId + '` berhasil diangkat menjadi Admin Bot!*',
        { inline_keyboard: [[{ text: '🔙 Kembali ke Kelola Admin', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
      )
    } else {
      await tgSendMessage(env, chatId, '✅ User ID `' + targetId + '` berhasil diangkat menjadi Admin Bot!', {
        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_manage_admin' }]]
      }, 'Markdown')
    }
    return
  }

  if (state.action === 'settings_load_db') {
    if (!msg.document || !(msg.document.file_name || '').toLowerCase().endsWith('.json')) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*💾 LOAD DATABASE*\n\n⚠️ *Berkas tidak valid! Harap kirim berkas file .json.*\n\nSilakan kirimkan berkas file backup (`.json`) yang valid ke bot ini.\n\n⚠️ *PERINGATAN: Seluruh database bot saat ini akan ditimpa!*',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Harap kirimkan berkas file .json backup yang valid!')
      }
      return
    }

    try {
      const doc = msg.document
      const maxSize = 5 * 1024 * 1024
      if (doc.file_size && doc.file_size > maxSize) {
        throw new Error('File backup terlalu besar (maks 5MB).')
      }
      const fileInfo = await tgGetFile(env, doc.file_id)
      if (!fileInfo || !fileInfo.file_path) {
        throw new Error('Gagal mendapatkan informasi file dari Telegram.')
      }
      const fileContent = await tgDownloadFile(env, fileInfo.file_path)
      if (!fileContent) {
        throw new Error('File kosong atau gagal diunduh.')
      }
      if (fileContent.length > maxSize) {
        throw new Error('File backup terlalu besar (maks 5MB).')
      }
      const data = JSON.parse(fileContent)

      // Overwrite HANYA key yang tervalidasi; token rahasia tidak ikut dipulihkan
      const ALLOWED_RESTORE = ['Kategori', 'Produk', 'SnK', 'Trx', 'UserList', 'Role', 'BannedUser', 'Voucher', 'VoucherBatch', 'VoucherAudit', 'OrderCounter', 'BotConfig', 'StokKeluar', 'StokBaru', 'FlashSale', 'FlashSaleHistory', 'Tickets', 'SessionDeposit']
      if (!data || typeof data !== 'object') throw new Error('Format database backup tidak dikenali.')
      if (!Array.isArray(data.Kategori) && !Array.isArray(data.Produk) && !Array.isArray(data.UserList)) {
        throw new Error('Format database backup tidak dikenali.')
      }
      if (data.BotConfig && typeof data.BotConfig === 'object' && data.BotConfig.db) {
        delete data.BotConfig.db.token
      }
      for (const key of ALLOWED_RESTORE) {
        if (data[key] !== undefined && data[key] !== null) {
          await writeJSON(env, key, data[key])
        }
      }

      // Re-initialize config + backend hasil restore langsung aktif
      const { initConfig } = await import('./config.js')
      await initConfig(env)
      const { resetDbCache, initDb } = await import('./db.js')
      resetDbCache(env)
      await initDb(env)

      await deleteKey(env, 'adminState_' + fromId)

      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '✅ *Database berhasil dipulihkan dari file backup!*',
          { inline_keyboard: [[{ text: '🔙 Kembali ke Settings', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '✅ *Database berhasil dipulihkan dari file backup!*', {
          inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_panel' }]]
        }, 'Markdown')
      }
    } catch (e) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '*💾 LOAD DATABASE*\n\n❌ *Gagal memulihkan database: ' + e.message + '*\n\nSilakan kirimkan berkas file backup (`.json`) yang valid ke bot ini.',
          { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '❌ Gagal memulihkan database: ' + e.message)
      }
    }
    return
  }

  // P7: input ketik umur 1-100
  if (state.action === 'settings_ticket_keep') {
    const n = parseInt(String(text || '').replace(/[^0-9]/g, ''), 10)
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      await tgSendMessage(env, chatId, 'Angka harus 1-100. Coba lagi / ketik /batal bila tidak jadi.')
      return
    }
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.ticketKeepDays = n
    await writeJSON(env, 'BotConfig', cfg)
    try { const { initConfig } = await import('./config.js'); await initConfig(env) } catch {}
    await deleteKey(env, 'adminState_' + fromId)
    if (state.cardMessageId) { try { await tgDeleteMessage(env, chatId, state.cardMessageId) } catch (e) {} }
    await tgSendMessage(env, chatId, 'Umur topik tiket: ' + n + ' hari.')
    return
  }

  if (state.action === 'admin_reply_ticket') {
    const hasMedia = (msg.photo && msg.photo.length > 0) || msg.document
    if (!hasMedia && text.length < 2) {
      if (state.promptMid) { try { await tgDeleteMessage(env, chatId, state.promptMid) } catch (e) {} }
      const newPrompt = await tgSendMessage(env, chatId, '⚠️ Pesan jawaban terlalu pendek. Coba lagi:')
      state.promptMid = newPrompt?.result?.message_id
      await writeJSON(env, 'adminState_' + fromId, state)
      return
    }
    if (state.promptMid) { try { await tgDeleteMessage(env, chatId, state.promptMid) } catch (e) {} }
    await deleteKey(env, 'adminState_' + fromId)
    const tickets = await readJSON(env, 'Tickets', [])
    const tIdx = tickets.findIndex(t => t.ticketId === state.ticketId)
    if (tIdx === -1) {
      await tgSendMessage(env, chatId, '⚠️ Tiket tidak ditemukan atau sudah dihapus.')
      return
    }

    let textVal = text
    let photoFileId = null
    let docFileId = null
    let docName = null

    if (msg.photo && msg.photo.length > 0) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id
      textVal = msg.caption ? msg.caption.trim() : '[Foto]'
    } else if (msg.document) {
      docFileId = msg.document.file_id
      docName = msg.document.file_name || 'file'
      textVal = msg.caption ? msg.caption.trim() : '[Dokumen: ' + docName + ']'
    }

    const jamNow = getTanggalJam()
    const jamHM = String(jamNow.jam).slice(0, 5) + ' WIB'

    const msgObj = { sender: 'admin', text: textVal, time: jamHM, username: 'ADMIN' }
    if (photoFileId) msgObj.photoFileId = photoFileId
    if (docFileId) {
      msgObj.docFileId = docFileId
      msgObj.docName = docName
    }

    tickets[tIdx].status = 'answered'
    tickets[tIdx].lastActivityAt = Date.now()
    tickets[tIdx].messages.push(msgObj)
    await writeJSON(env, 'Tickets', tickets)

    const t = tickets[tIdx]
    const { renderTicketCard: rtcReply } = await import('./ticketCard.js')
    const replyCard = rtcReply(t, { role: 'user' })

    let userMsg = '🔔 <b>Tanggapan Admin Baru!</b>\n\n' + replyCard.text
    const userKb = replyCard.keyboard

    try {
      const res = await tgSendMessage(env, t.userId, userMsg, userKb, 'HTML')
      if (res && !res.ok) {
        console.error('[tgSendMessage TICKET REPLY ERROR]', res)
      }
    } catch (e) {
      console.error('[tgSendMessage TICKET REPLY CATCH ERROR]', e)
    }

    if (msg.chat.type !== 'private') {
      try {
        await tgDeleteMessage(env, msg.chat.id, msg.message_id)
      } catch (e) {}
    }

    if (state.logChatId && state.logMessageId) {
      try {
        const t = tickets[tIdx]
        const { renderTicketCard: rtcLog } = await import('./ticketCard.js')
        const logCard = rtcLog(t, { role: 'admin', viewerId: fromId })
        await tgEditMessageText(env, state.logChatId, state.logMessageId, logCard.text, logCard.keyboard, 'HTML')
      } catch (e) {}
    }

    try {
      await tgSendMessage(env, msg.from.id, '✅ Tanggapan berhasil dikirim ke user!')
    } catch (e) {}
    await deleteKey(env, 'adminState_' + fromId)
    return
  }
  // ─── v9update17: Voucher wizard state handlers ───
  if (state.action === 'voucher_prefix') {
    const prefix = voucherValidatePrefix(text)
    if (!prefix) {
      await tgSendMessage(env, chatId, '⚠️ Prefix harus 2-5 huruf/angka (A-Z, 0-9). Coba lagi.')
      return
    }
    await writeJSON(env, 'adminState_' + fromId, { action: 'voucher_nominal', prefix })
    await tgSendMessage(env, chatId,
      '*💰 STEP 2/4 — Nominal Bonus*\nPrefix terpilih: `' + prefix + '`\n\nKetik nominal saldo bonus per kode (min Rp 100, max Rp 1.000.000).\n\nContoh: `5000`, `10000`, `50000`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_voucher' }]] }, 'Markdown')
    return
  }

  if (state.action === 'voucher_nominal') {
    const n = parseInt((text || '').replace(/[^0-9]/g, ''))
    if (!n || n < 100 || n > 1000000) {
      await tgSendMessage(env, chatId, '⚠️ Nominal harus angka 100 - 1.000.000. Coba lagi.')
      return
    }
    state.amount = n
    state.action = 'voucher_count'
    await writeJSON(env, 'adminState_' + fromId, state)
    await tgSendMessage(env, chatId,
      '*🔢 STEP 3/4 — Jumlah Kode*\nBonus: ' + ParseIdr(n) + '/kode\n\nKetik berapa kode yang mau dibuat (min 1, max 500).\n\nContoh: `10`, `50`, `100`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_voucher' }]] }, 'Markdown')
    return
  }

  if (state.action === 'voucher_count') {
    const n = parseInt((text || '').replace(/[^0-9]/g, ''))
    if (!n || n < 1 || n > 500) {
      await tgSendMessage(env, chatId, '⚠️ Jumlah harus angka 1-500. Coba lagi.')
      return
    }
    state.count = n
    state.action = 'voucher_expiry'
    await writeJSON(env, 'adminState_' + fromId, state)
    await tgSendMessage(env, chatId,
      '*⏰ STEP 4/4 — Masa Berlaku*\nBonus ' + ParseIdr(state.amount) + ' × ' + n + ' kode\n\nKetik masa berlaku:\n• `30m` atau `30 menit`\n• `2h` atau `2 jam`\n• `7d` atau `7 hari`\n\nContoh valid: `30m`, `2h`, `7d`, `24 jam`, `3 hari`\n\nMin 1 menit • Max 365 hari\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [
        [{ text: '♾️ Tanpa Expired', callback_data: 'adm_voucher_exp_none' }],
        [{ text: '🔙 Batal', callback_data: 'adm_voucher' }]
      ] }, 'Markdown')
    return
  }

  if (state.action === 'voucher_expiry') {
    const parsed = voucherParseExpiry(text)
    if (!parsed) {
      await tgSendMessage(env, chatId, '⚠️ Format expiry salah. Contoh: `30m`, `2h`, `7d`. Coba lagi.')
      return
    }
    state.expiryMs = parsed.ms
    state.expiryLabel = parsed.label
    state.action = 'voucher_review'
    await writeJSON(env, 'adminState_' + fromId, state)
    const totalNilai = state.amount * state.count
    const expDate = parsed.ms > 0 ? formatWIB(new Date(Date.now() + parsed.ms).toISOString()) : 'Tanpa Expired'
    let rev = '*⚠️ KONFIRMASI GENERATE*\n\n'
    rev += '🏷️ Prefix     : `' + state.prefix + '`\n'
    rev += '💰 Bonus/kode : ' + ParseIdr(state.amount) + '\n'
    rev += '🔢 Jumlah     : *' + state.count + '* kode\n'
    rev += '⏰ Expired    : ' + parsed.label + '\n'
    if (parsed.ms > 0) rev += '  ↳ ' + expDate + '\n'
    rev += '💵 Total nilai: *' + ParseIdr(totalNilai) + '*'
    await tgSendMessage(env, chatId, rev, {
      inline_keyboard: [
        [{ text: '✅ Ya, Generate!', callback_data: 'adm_voucher_confirm' }],
        [{ text: '❌ Batal', callback_data: 'adm_voucher' }]
      ]
    }, 'Markdown')
    return
  }

  if (state.action === 'pay_pk_slug') {
    const slug = (text||'').trim()
    if (!slug || slug.length < 2) { await tgSendMessage(env, chatId, '⚠️ Slug tidak valid.'); return }
    const pay = await getPayCfg(env); pay.gateways.pakasir.slug = slug; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Slug disimpan: *' + slug + '*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_pk_apikey') {
    const key = (text||'').trim()
    if (!key || key.length < 8) { await tgSendMessage(env, chatId, '⚠️ API Key terlalu pendek.'); return }
    const pay = await getPayCfg(env); pay.gateways.pakasir.apiKey = key; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ API Key disimpan (tersembunyi).', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_pk_feepct') {
    const v = parseFloat((text||'').trim().replace(',', '.'))
    if (isNaN(v) || v < 0 || v > 100) { await tgSendMessage(env, chatId, '⚠️ Masukkan angka 0–100.'); return }
    const pay = await getPayCfg(env); pay.gateways.pakasir.feePercent = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Fee persen: *' + v + '%*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_pk_feenom') {
    const v = parseInt((text||'').trim().replace(/[^0-9]/g, ''))
    if (isNaN(v) || v < 0) { await tgSendMessage(env, chatId, '⚠️ Masukkan nominal Rupiah (angka).'); return }
    const pay = await getPayCfg(env); pay.gateways.pakasir.feeNominal = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Fee nominal: *Rp' + v.toLocaleString('id-ID') + '*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_dk_merch') {
    const v = (text||'').trim()
    if (!v || v.length < 3) { await tgSendMessage(env, chatId, '⚠️ Merchant Code tidak valid.'); return }
    const pay = await getPayCfg(env); pay.gateways.duitku.merchantCode = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Merchant Code disimpan: *' + v + '*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_dk_apikey') {
    const v = (text||'').trim()
    if (!v || v.length < 8) { await tgSendMessage(env, chatId, '⚠️ API Key terlalu pendek.'); return }
    const pay = await getPayCfg(env); pay.gateways.duitku.apiKey = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ API Key Duitku disimpan (tersembunyi).', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_dk_feepct') {
    const v = parseFloat((text||'').trim().replace(',', '.'))
    if (isNaN(v) || v < 0 || v > 100) { await tgSendMessage(env, chatId, '⚠️ Masukkan angka 0–100.'); return }
    const pay = await getPayCfg(env); pay.gateways.duitku.feePercent = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Fee persen Duitku: *' + v + '%*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_dk_feenom') {
    const v = parseInt((text||'').trim().replace(/[^0-9]/g, ''))
    if (isNaN(v) || v < 0) { await tgSendMessage(env, chatId, '⚠️ Masukkan nominal Rupiah (angka).'); return }
    const pay = await getPayCfg(env); pay.gateways.duitku.feeNominal = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Fee nominal Duitku: *Rp' + v.toLocaleString('id-ID') + '*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_dk_expiry') {
    const v = parseInt((text||'').trim().replace(/[^0-9]/g, ''))
    if (isNaN(v) || v < 1) { await tgSendMessage(env, chatId, '⚠️ Masukkan angka menit (minimal 1).'); return }
    const pay = await getPayCfg(env); pay.gateways.duitku.expiryPeriod = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Expiry Duitku: *' + v + ' menit*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_sw_username') {
    const u = (text||'').trim().replace(/^@/, '')
    if (!u || u.length < 2) { await tgSendMessage(env, chatId, '⚠️ Username tidak valid.'); return }
    const pay = await getPayCfg(env); pay.gateways.saweria.username = u; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Username Saweria disimpan: *' + u + '*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_sw_userid') {
    const uid = (text||'').trim()
    if (!uid || uid.length < 8) { await tgSendMessage(env, chatId, '⚠️ User ID tidak valid (harus UUID).'); return }
    const pay = await getPayCfg(env); pay.gateways.saweria.userId = uid; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ User ID Saweria disimpan: *' + uid.slice(0,8) + '…*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_sw_expiry') {
    const v = parseInt((text||'').trim().replace(/[^0-9]/g, ''))
    if (isNaN(v) || v < 1) { await tgSendMessage(env, chatId, '⚠️ Masukkan angka menit (minimal 1).'); return }
    const pay = await getPayCfg(env); pay.gateways.saweria.expiryPeriod = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Expiry Saweria: *' + v + ' menit*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_sw_feepct') {
    const v = parseFloat((text||'').trim().replace(',', '.'))
    if (isNaN(v) || v < 0 || v > 100) { await tgSendMessage(env, chatId, '⚠️ Masukkan angka 0–100.'); return }
    const pay = await getPayCfg(env); pay.gateways.saweria.feePercent = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Fee persen Saweria: *' + v + '%*', adminMainPanel(), 'Markdown'); return
  }
  if (state.action === 'pay_sw_feenom') {
    const v = parseInt((text||'').trim().replace(/[^0-9]/g, ''))
    if (isNaN(v) || v < 0) { await tgSendMessage(env, chatId, '⚠️ Masukkan nominal Rupiah (angka).'); return }
    const pay = await getPayCfg(env); pay.gateways.saweria.feeNominal = v; await savePayCfg(env, pay)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId, '✅ Fee nominal Saweria: *Rp' + v.toLocaleString('id-ID') + '*', adminMainPanel(), 'Markdown'); return
  }
  // fallback
  await tgSendMessage(env, chatId, 'Ketik /batal untuk membatalkan.')
}

// ─── Internal: simpan kategori ke KV ──────────────────────────────────
async function _saveKategori(env, chatId, fromId, namaKat, desc) {
  const kategori = await readJSON(env, 'Kategori', [])
  const newId = kategori.length > 0 ? Math.max(...kategori.map(k => k.id)) + 1 : 1
  const produkId = namaKat.toLowerCase().replace(/\s+/g, '_') + '_' + newId
  kategori.push({
    id: newId,
    produkName: namaKat,
    produkId,
    desc: desc || '',
    produkXuid: 'X' + String(newId).padStart(3, '0')
  })
  await writeJSON(env, 'Kategori', kategori)
  await deleteKey(env, 'adminState_' + fromId)
  await tgSendMessage(env, chatId,
    '✅ Kategori *' + namaKat + '* berhasil dibuat! (ID: ' + newId + ')\n\nPilih tipe produk:',
    afterAddKatButtons(newId), 'Markdown'
  )
}

// ─── Handle Admin Callbacks ───────────────────────────────────────────
export async function handleAdminCallback(env, cq) {
  let data = cq.data
  const cqId = cq.id
  const chatId = cq.message.chat.id
  const fromId = cq.from.id
  const messageId = cq.message.message_id
  if (!(await checkAdmin(env, fromId, chatId))) {
    try { await tgAnswerCallbackQuery(env, cqId, '🚫 Akses ditolak.', true) } catch (e) {}
    return
  }

  // ─ Tutup panel ─
  if (data === 'adm_tutup') {
    await tgAnswerCallbackQuery(env, cqId, '❌ Panel admin ditutup', false)
    const { tgDeleteMessage } = await import('./telegram.js')
    await tgDeleteMessage(env, chatId, messageId)
    return
  }

  // ─ Panduan setup 3 langkah (orang awam) ─
  if (data === 'adm_panduan') {
    await tgAnswerCallbackQuery(env, cqId, '❓ Membuka panduan', false)
    await tgEditMessageText(env, chatId, messageId,
      '*❓ PANDUAN SETUP — 3 LANGKAH*\n\n' +
      '*Langkah 1 — Isi toko:*\nSistem → Identitas & Info (nama toko, CS)\n\n' +
      '*Langkah 2 — Pasang banner:*\nSistem → Media & Banner (foto sambutan)\n\n' +
      '*Langkah 3 — Aktifkan bayar:*\n💳 Pembayaran → pilih gateway → isi API key → mode *production*\n\n' +
      '_Lalu tambah kategori + produk + stok, bot siap jualan._',
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_panel' }]] }, 'Markdown'
    )
    return
  }

  // ─ Kembali ke panel ─
  if (data === 'adm_panel') {
    await tgAnswerCallbackQuery(env, cqId, '🏠 Membuka menu utama Admin', false)
    await deleteKey(env, 'adminState_' + fromId)
    await tgEditMessageText(env, chatId, messageId,
      '*🛠️ ADMIN PANEL*\n\nPilih menu yang ingin dikelola:',
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ─ Router kategori (panel 6 kategori, max 2 klik ke aksi) ─
  if (data.startsWith('adm_cat_')) {
    const cat = data.replace('adm_cat_', '')
    const panel = adminCatPanel(cat)
    await tgEditMessageText(env, chatId, messageId, panel._text || '*🛠️ ADMIN PANEL*', { inline_keyboard: panel.inline_keyboard }, 'Markdown')
    return
  }

  // ─ Saldo manual: minta ID/nama user ─
  if (data === 'adm_saldo') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'saldo_pick_user' })
    await tgEditMessageText(env, chatId, messageId,
      '*💰 Saldo Manual*\n\nKirim ID Telegram atau nama user (tambah `+` / kurang `-` di langkah berikut).\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_panel' }]] }, 'Markdown')
    return
  }

  // ─ Log transaksi: status channel + pintasan setting ─
  if (data === 'adm_txlog_info') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const cur = cfg.ChannelLog || env.CHANNEL_LOG || ''
    await tgEditMessageText(env, chatId, messageId,
      '*📊 Log Transaksi*\n\nSetiap transaksi sukses/gagal otomatis terkirim ke channel log.\n\nChannel saat ini: `' + (cur || 'belum diset') + '`\n\n' +
      (cur ? 'Pantau semua transaksi di channel tersebut.' : 'Set channel dulu agar log tercatat.'),
      { inline_keyboard: [[{ text: '📢 Setting Channel Log', callback_data: 'adm_set_channel_log_tx' }], [{ text: '🔙 Kembali', callback_data: 'adm_panel' }]] }, 'Markdown')
    return
  }

  // ─ Pengaturan lain (legacy adm_settings, isi lama dipertahankan) ─
  if (data === 'adm_settings_legacy') {
    data = 'adm_settings'
  }

  const produk = await readJSON(env, 'Produk', [])
  const kategori = await readJSON(env, 'Kategori', [])

  // ───────── ADD STOCK ─────────
  if (data === 'adm_addstock') {
    await tgAnswerCallbackQuery(env, cqId, '📦 Membuka kelola stok produk', false)
    if (kategori.length === 0) {
      await tgEditMessageText(env, chatId, messageId,
        '⚠️ Belum ada kategori. Tambah kategori dulu.',
        { inline_keyboard: [[{ text: '➕ Tambah Kategori', callback_data: 'adm_addkat' }, { text: '🔙 Kembali', callback_data: 'adm_panel' }]] },
        'Markdown'
      )
      return
    }
    const rows = kategori.map(k => {
      const vs = produk.filter(p => p.category === k.produkId)
      const sv = vs.find(v => v.single)
      const lbl = sv ? ('📦 ' + k.produkName + ' · langsung') : ('🗂️ ' + k.produkName + ' (' + vs.length + ' varian)')
      return [{ text: lbl, callback_data: 'adm_addstock_kat_' + k.id }]
    })
    rows.push([{ text: '🔙 Kembali ke Panel', callback_data: 'adm_panel' }])
    await tgEditMessageText(env, chatId, messageId,
      '*📦 Add Stock*\n\nPilih kategori:',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  // Pilih kategori → tampilkan varian
  if (data.startsWith('adm_addstock_kat_')) {
    const katId = data.replace('adm_addstock_kat_', '')
    const kat = kategori.find(k => String(k.id) === String(katId))
    if (!kat) return
    const singleVar = produk.find(p => p.category === kat.produkId && p.single)
    if (singleVar) {
      await writeJSON(env, 'adminState_' + fromId, { action: 'addstock_data', variantId: singleVar.id, variantName: singleVar.nameproduct })
      await tgEditMessageText(env, chatId, messageId,
        '*📦 Add Stock: ' + kat.produkName + '*\n\nKirim data stok (bisa banyak baris, tiap baris 1 item).\nKetik /batal untuk membatalkan.',
        null, 'Markdown')
      return
    }
    const variants = produk.filter(p => p.category === kat.produkId)
    const rows = variants.map(v => [{
      text: '📦 [' + v.id + '] ' + v.nameproduct + ' (' + (v.stok ? v.stok.length : 0) + ' stok)',
      callback_data: 'adm_addstock_' + v.id
    }])
    rows.push([{ text: '➕ Tambah Varian Baru', callback_data: 'adm_addvarian_kat_' + katId }])
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_addstock' }])
    await tgEditMessageText(env, chatId, messageId,
      '*📦 Add Stock — ' + kat.produkName + '*\n\nPilih varian tujuan:',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  // Pilih varian → minta data stok
  if (data.startsWith('adm_addstock_') && !data.startsWith('adm_addstock_kat_')) {
    const variantId = data.replace('adm_addstock_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) return
    const state = { action: 'addstock_data', variantId, variantName: p.nameproduct }
    await writeJSON(env, 'adminState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId,
      '*📦 Add Stock: ' + p.nameproduct + '*\n\n' +
      'Kirim data stok (bisa banyak baris sekaligus).\n' +
      'Setiap baris = 1 item.\n\n' +
      'Contoh:\n`user1:pass1`\n`user2:pass2`\n\n' +
      'Ketik /batal untuk membatalkan.',
      null, 'Markdown'
    )
    return
  }

  // ── Expired Buttons ──
  if (data === 'adm_exp_30' || data === 'adm_exp_60' || data === 'adm_exp_90' || data === 'adm_exp_365') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'addstock_waiting_expired') {
      await tgSendMessage(env, chatId, '⚠️ Sesi expired. Ulangi add stock.')
      return
    }
    const daysMap = { adm_exp_30: 30, adm_exp_60: 60, adm_exp_90: 90, adm_exp_365: 365 }
    const days = daysMap[data]
    const expiredAt = getExpiredDateWIB(days)
    await tgEditMessageText(env, chatId, messageId,
      '⏳ Menyimpan stok, expired: ' + formatExpiredDisplay(expiredAt, days) + '...',
      null, 'Markdown'
    )
    await doSaveStock(env, chatId, fromId, state, expiredAt, days)
    return
  }

  if (data === 'adm_exp_custom') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'addstock_waiting_expired') {
      await tgSendMessage(env, chatId, '⚠️ Sesi expired. Ulangi add stock.')
      return
    }
    const newState = { ...state, action: 'addstock_custom_expired' }
    await writeJSON(env, 'adminState_' + fromId, newState)
    await tgEditMessageText(env, chatId, messageId,
      '✏️ *Custom Expired*\n\nKetik jumlah hari (angka saja).\nContoh: *45* untuk 45 hari\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  if (data === 'adm_exp_skip') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'addstock_waiting_expired') {
      await tgSendMessage(env, chatId, '⚠️ Sesi expired. Ulangi add stock.')
      return
    }
    await tgEditMessageText(env, chatId, messageId,
      '♾️ Menyimpan stok tanpa expired...',
      null, 'Markdown'
    )
    await doSaveStock(env, chatId, fromId, state, null, null)
    return
  }

  // ───────── DEL STOCK ─────────
  if (data === 'adm_delstock') {
    const kb = variantButtons(produk, 'adm_delstock_')
    await tgEditMessageText(env, chatId, messageId,
      '*🗑 Del Stock*\n\nPilih varian yang ingin dihapus stoknya:',
      kb, 'Markdown'
    )
    return
  }

  if (data.startsWith('adm_delstock_')) {
    const variantId = data.replace('adm_delstock_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) return
    const stokCount = p.stok ? p.stok.length : 0
    const state = { action: 'delstock_jumlah', variantId, variantName: p.nameproduct }
    await writeJSON(env, 'adminState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId,
      '*🗑 Del Stock: ' + p.nameproduct + '*\n\n' +
      'Stok saat ini: *' + stokCount + ' item*\n\n' +
      'Hapus berapa? Ketik angka atau ketik *semua*.\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  if (data === 'adm_konfirmasi_delstock') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'delstock_konfirmasi') return
    const p = produk.find(pr => String(pr.id) === String(state.variantId))
    if (!p) { await deleteKey(env, 'adminState_' + fromId); return }
    const jumlah = state.jumlah
    const stokLen = p.stok ? p.stok.length : 0
    if (!Number.isInteger(jumlah) || jumlah <= 0 || jumlah > stokLen) { await deleteKey(env, 'adminState_' + fromId); return }
    const stokKeluar = await readJSON(env, 'StokKeluar', [])
    const dropped = (p.stok || []).slice(0, jumlah)
    p.stok = (p.stok || []).slice(jumlah)
    await writeJSON(env, 'Produk', produk)
    stokKeluar.push({ id: p.id, total: jumlah, stok_dibeli: dropped, tanggal: getDate('Asia/Jakarta'), status: 'Deleted' })
    await writeJSON(env, 'StokKeluar', stokKeluar)
    await deleteKey(env, 'adminState_' + fromId)
    await tgEditMessageText(env, chatId, messageId,
      '✅ *' + jumlah + ' stok* berhasil dihapus dari *' + p.nameproduct + '*\nSisa stok: *' + p.stok.length + '*',
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ───────── EDIT HARGA ─────────
  if (data === 'adm_editharga') {
    const kb = variantButtons(produk, 'adm_editharga_')
    await tgEditMessageText(env, chatId, messageId, '*✏️ Edit Harga*\n\nPilih varian:', kb, 'Markdown')
    return
  }

  if (data.startsWith('adm_editharga_')) {
    const variantId = data.replace('adm_editharga_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) return
    await writeJSON(env, 'adminState_' + fromId, { action: 'editharga', variantId })
    await tgEditMessageText(env, chatId, messageId,
      '*✏️ Edit Harga: ' + p.nameproduct + '*\n\nHarga saat ini: *' + ParseIdr(p.price) + '*\n\nKirim harga baru:\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ───────── EDIT NAMA VARIAN ─────────
  if (data === 'adm_editnama') {
    const kb = variantButtons(produk, 'adm_editnama_')
    await tgEditMessageText(env, chatId, messageId, '*✏️ Edit Nama Varian*\n\nPilih varian:', kb, 'Markdown')
    return
  }

  if (data.startsWith('adm_editnama_')) {
    const variantId = data.replace('adm_editnama_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) return
    await writeJSON(env, 'adminState_' + fromId, { action: 'editnama_variant', variantId })
    await tgEditMessageText(env, chatId, messageId,
      '*✏️ Edit Nama: ' + p.nameproduct + '*\n\nKirim nama varian baru:\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ───────── EDIT DESC VARIAN ─────────
  if (data === 'adm_editdesc') {
    const kb = variantButtons(produk, 'adm_editdesc_')
    await tgEditMessageText(env, chatId, messageId, '*📝 Edit Desk. Varian*\n\nPilih varian:', kb, 'Markdown')
    return
  }

  if (data.startsWith('adm_editdesc_')) {
    const variantId = data.replace('adm_editdesc_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) return
    await writeJSON(env, 'adminState_' + fromId, { action: 'editdesc', variantId })
    await tgEditMessageText(env, chatId, messageId,
      '*📝 Edit Deskripsi Varian: ' + p.nameproduct + '*\n\nDeskripsi saat ini:\n' + (p.desc || '(kosong)') + '\n\nKirim deskripsi baru (atau ketik `-` / `hapus` untuk menghapus):\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ───────── EDIT DESC KATEGORI ─────────
  if (data === 'adm_editkatdesc') {
    const kb = kategoriButtons(kategori, 'adm_editkatdesc_')
    await tgEditMessageText(env, chatId, messageId, '*📝 Edit Desk. Kategori*\n\nPilih kategori:', kb, 'Markdown')
    return
  }

  if (data.startsWith('adm_editkatdesc_')) {
    const katId = data.replace('adm_editkatdesc_', '')
    const k = kategori.find(kk => String(kk.id) === String(katId))
    if (!k) return
    await writeJSON(env, 'adminState_' + fromId, { action: 'editkatdesc', katId })
    await tgEditMessageText(env, chatId, messageId,
      '*📝 Edit Deskripsi Kategori: ' + k.produkName + '*\n\nDeskripsi saat ini:\n' + (k.desc || '(kosong)') + '\n\nKirim deskripsi baru (atau ketik `-` / `hapus` untuk menghapus):\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ───────── EDIT SNK ─────────
  if (data === 'adm_editsnk') {
    const kb = kategoriButtons(kategori, 'adm_editsnk_')
    await tgEditMessageText(env, chatId, messageId, '*📋 Edit Syarat & Ketentuan*\n\nPilih kategori:', kb, 'Markdown')
    return
  }

  if (data.startsWith('adm_editsnk_')) {
    const kategoriId = data.replace('adm_editsnk_', '')
    const k = kategori.find(kt => String(kt.id) === String(kategoriId))
    if (!k) return
    const snkList = await readJSON(env, 'SnK', [])
    const existing = snkList.find(s => String(s.id) === String(kategoriId))
    await writeJSON(env, 'adminState_' + fromId, { action: 'editsnk', kategoriId })
    await tgEditMessageText(env, chatId, messageId,
      '*📋 Edit SnK: ' + k.produkName + '*\n\nSnK saat ini:\n' + (existing ? existing.snk : '(kosong)') + '\n\nKirim SnK baru:\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ───────── EXPORT STOK ─────────
  if (data === 'adm_export') {
    const rows = [[{ text: '📤 Export Semua', callback_data: 'adm_export_all' }]]
    for (const p of produk) {
      rows.push([{ text: '[' + p.id + '] ' + p.nameproduct + ' (' + (p.stok ? p.stok.length : 0) + ')', callback_data: 'adm_export_' + p.id }])
    }
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_panel' }])
    await tgEditMessageText(env, chatId, messageId,
      '*📤 Export Stok*\n\nPilih produk atau export semua:',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  if (data === 'adm_export_all') {
    let txt = ''
    for (const p of produk) {
      if (p.stok && p.stok.length > 0) {
        txt += '=== ' + p.nameproduct + ' (ID:' + p.id + ') ===\n'
        txt += p.stok.map(s => s.info || s).join('\n') + '\n\n'
      }
    }
    if (!txt) { await tgSendMessage(env, chatId, 'Semua stok kosong.'); return }
    await tgSendDocument(env, chatId, txt, 'all_stock.txt', 'Semua Stok')
    return
  }

  if (data.startsWith('adm_export_')) {
    const variantId = data.replace('adm_export_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p || !p.stok || p.stok.length === 0) {
      await tgSendMessage(env, chatId, '⚠️ Stok kosong.')
      return
    }
    const txt = p.stok.map(s => s.info || s).join('\n')
    await tgSendDocument(env, chatId, txt, 'stock_' + p.id + '.txt', p.nameproduct + ' — ' + p.stok.length + ' item')
    return
  }

  // ───────── LIHAT STOK ─────────
  if (data === 'adm_lihatstok') {
    let txt = '*📊 Ringkasan Stok*\n\n'
    let total = 0
    for (const p of produk) {
      const count = p.stok ? p.stok.length : 0
      total += count
      const icon = count === 0 ? '🔴' : count <= 5 ? '🟡' : '🟢'
      txt += icon + ' [' + p.id + '] ' + p.nameproduct + ': *' + count + '*\n'
    }
    txt += '\n📦 Total semua stok: *' + total + '*'
    // Gudang darurat: stok reserve yang produknya dihapus admin (bug-5 fix)
    let yatimKb = null
    try {
      const yatim = await readJSON(env, 'StokYatim', [])
      if (yatim && yatim.length > 0) {
        const yatimCount = yatim.reduce((n, y) => n + (y.items ? y.items.length : 0), 0)
        txt += '\n\n📦 *Stok diamankan:* ' + yatimCount + ' item (' + yatim.length + ' trx) — produk dihapus saat pembayaran lunas'
        yatimKb = { inline_keyboard: [
          [{ text: '📦 Lihat Stok Diamankan', callback_data: 'adm_yatim_list' }],
          [{ text: '🔙 Kembali', callback_data: 'adm_panel' }]
        ] }
      }
    } catch (e) {}
    await tgEditMessageText(env, chatId, messageId, txt,
      yatimKb || { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_panel' }]] },
      'Markdown'
    )
    return
  }

  // ─── STOK YATIM: daftar + kembalikan ke varian lain ───
  if (data === 'adm_yatim_list') {
    let yatim = []
    try { yatim = await readJSON(env, 'StokYatim', []) } catch (e) {}
    if (!yatim || yatim.length === 0) {
      await tgAnswerCallbackQuery(env, cqId, 'Tidak ada stok diamankan', true)
      return
    }
    let txt = '*📦 Stok Diamankan (' + yatim.length + ' trx)*\n\n'
    const rows = []
    yatim.slice(0, 10).forEach((y, i) => {
      txt += (i + 1) + '. ' + (y.varian || '-') + ' — *' + (y.items ? y.items.length : 0) + ' item* (trx ' + (y.trx || '-') + ')\n'
      rows.push([{ text: '↩️ Kembalikan #' + (i + 1) + ' ke varian...', callback_data: 'adm_yatim_pick_' + i }])
    })
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_panel' }])
    await tgEditMessageText(env, chatId, messageId, txt, { inline_keyboard: rows }, 'Markdown')
    return
  }

  // ─── STOK YATIM: pilih varian tujuan ───
  if (data.startsWith('adm_yatim_pick_')) {
    const idx = parseInt(data.replace('adm_yatim_pick_', ''))
    let yatim = []
    try { yatim = await readJSON(env, 'StokYatim', []) } catch (e) {}
    if (isNaN(idx) || !yatim[idx]) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Data tidak ada', true); return }
    await writeJSON(env, 'adminState_' + fromId, { action: 'yatim_restore', yatimIdx: idx })
    let txt = '📦 Kembalikan *' + (yatim[idx].items ? yatim[idx].items.length : 0) + ' item* (' + (yatim[idx].varian || '-') + ') ke varian mana?\n\nKetik *ID varian* tujuan (lihat di 👁 Lihat Stok).\n\n_Ketik /batal jika tidak jadi._'
    await tgEditMessageText(env, chatId, messageId, txt, null, 'Markdown')
    return
  }

  // ───────── ADD KATEGORI ─────────
  if (data === 'adm_addkat') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'addkat_nama' })
    await tgEditMessageText(env, chatId, messageId,
      '*➕ Tambah Kategori Produk*\n\nMasukkan nama kategori baru:\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // Skip deskripsi kategori
  if (data === 'adm_skip_desc') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'addkat_desc') {
      await tgSendMessage(env, chatId, '⚠️ Tidak ada proses tambah kategori aktif.')
      return
    }
    await _saveKategori(env, chatId, fromId, state.namaKat, '')
    return
  }

  // Skip deskripsi produk single
  if (data === 'adm_skip_desc_single') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'single_desc') {
      await tgSendMessage(env, chatId, '⚠️ Tidak ada proses pembuatan produk aktif.')
      return
    }
    const kategoriS = await readJSON(env, 'Kategori', [])
    const katS = kategoriS.find(k => String(k.id) === String(state.katId))
    if (!katS) { await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.'); await deleteKey(env, 'adminState_' + fromId); return }
    const produkS = await readJSON(env, 'Produk', [])
    const newIdS = produkS.length > 0 ? Math.max(...produkS.map(p => p.id)) + 1 : 1
    produkS.push({ id: newIdS, nameproduct: katS.produkName, price: state.hargaS, category: katS.produkId, desc: '', stok: [], single: true })
    await writeJSON(env, 'Produk', produkS)
    await writeJSON(env, 'adminState_' + fromId, { action: 'addstock_data', variantId: newIdS, variantName: katS.produkName })
    await tgSendMessage(env, chatId,
      '✅ Produk tunggal *' + katS.produkName + '* dibuat (ID: ' + newIdS + ', ' + ParseIdr(state.hargaS) + ').\n\n📦 Sekarang kirim data stok (tiap baris 1 item). /batal untuk membatalkan.\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // Skip deskripsi varian
  if (data === 'adm_skip_desc_varian') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state || state.action !== 'addvarian_desc') {
      await tgSendMessage(env, chatId, '⚠️ Tidak ada proses tambah varian aktif.')
      return
    }
    const kategori = await readJSON(env, 'Kategori', [])
    const kat = kategori.find(k => String(k.id) === String(state.katId))
    if (!kat) {
      await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.')
      await deleteKey(env, 'adminState_' + fromId)
      return
    }
    const produk = await readJSON(env, 'Produk', [])
    const newId = produk.length > 0 ? Math.max(...produk.map(p => p.id)) + 1 : 1
    produk.push({
      id: newId,
      nameproduct: state.varianNama,
      price: state.harga,
      category: kat.produkId,
      desc: '',
      stok: []
    })
    await writeJSON(env, 'Produk', produk)
    await deleteKey(env, 'adminState_' + fromId)
    await tgSendMessage(env, chatId,
      '✅ Varian *' + state.varianNama + '* ditambahkan ke *' + kat.produkName + '*\n' +
      'Harga: *' + ParseIdr(state.harga) + '*\nID Varian: *' + newId + '*\n\nMau tambah varian lagi?',
      afterAddVarianButtons(state.katId), 'Markdown'
    )
    return
  }

  // ───────── ADD VARIAN dari tombol ─────────
  if (data.startsWith('adm_single_kat_')) {
    const katId = data.replace('adm_single_kat_', '')
    const kat = kategori.find(k => String(k.id) === String(katId))
    if (!kat) { await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.'); return }
    const existing = produk.find(p => p.category === kat.produkId && p.single)
    if (existing) {
      await writeJSON(env, 'adminState_' + fromId, { action: 'addstock_data', variantId: existing.id, variantName: existing.nameproduct })
      await tgSendMessage(env, chatId, '*📦 Add Stock: ' + kat.produkName + '*\n\nKirim data stok (bisa banyak baris). /batal untuk membatalkan.\n\n_Ketik /batal jika tidak jadi._', null, 'Markdown')
      return
    }
    await writeJSON(env, 'adminState_' + fromId, { action: 'single_price', katId })
    await tgSendMessage(env, chatId, '*📦 Produk Tanpa Varian — ' + kat.produkName + '*\n\nMasukkan harga produk (angka, contoh: 25000):\n\n_Ketik /batal jika tidak jadi._', null, 'Markdown')
    return
  }

  if (data.startsWith('adm_addvarian_kat_')) {
    const katId = data.replace('adm_addvarian_kat_', '')
    const kat = kategori.find(k => String(k.id) === String(katId))
    if (!kat) {
      await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.')
      return
    }
    await writeJSON(env, 'adminState_' + fromId, { action: 'addvarian_nama', katId })
    await tgSendMessage(env, chatId,
      '*➕ Tambah Varian — ' + kat.produkName + '*\n\nMasukkan nama varian baru:\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  if (data.startsWith('adm_tambah_varian_lagi_')) {
    const katId = data.replace('adm_tambah_varian_lagi_', '')
    const kat = kategori.find(k => String(k.id) === String(katId))
    if (!kat) {
      await tgSendMessage(env, chatId, '⚠️ Kategori tidak ditemukan.')
      return
    }
    await writeJSON(env, 'adminState_' + fromId, { action: 'addvarian_nama', katId })
    await tgSendMessage(env, chatId,
      '*➕ Tambah Varian Lagi — ' + kat.produkName + '*\n\nMasukkan nama varian:\n\n_Ketik /batal jika tidak jadi._',
      null, 'Markdown'
    )
    return
  }

  // ───────── DEL KATEGORI ─────────
  if (data === 'adm_delkat') {
    const kb = kategoriButtons(kategori, 'adm_konfirmasi_delkat_')
    await tgEditMessageText(env, chatId, messageId,
      '*❌ Hapus Kategori*\n\nPilih kategori yang ingin dihapus:',
      kb, 'Markdown'
    )
    return
  }

  if (data.startsWith('adm_konfirmasi_delkat_')) {
    const katId = data.replace('adm_konfirmasi_delkat_', '')
    const k = kategori.find(kt => String(kt.id) === String(katId))
    if (!k) return
    await writeJSON(env, 'adminState_' + fromId, { action: 'delkat', katId })
    await tgEditMessageText(env, chatId, messageId,
      '⚠️ Yakin hapus kategori *' + k.produkName + '*?\nSemua varian di kategori ini juga akan terhapus!\n\n_Ketik /batal jika tidak jadi._',
      confirmButtons('adm_eksekusi_delkat'), 'Markdown'
    )
    return
  }

  if (data === 'adm_eksekusi_delkat') {
    const state = await readJSON(env, 'adminState_' + fromId, null)
    if (!state) return
    const k = kategori.find(kt => String(kt.id) === String(state.katId))
    if (!k) return
    const deletedVids = produk.filter(pr => pr.category === k.produkId).map(pr => String(pr.id))
    const newKat = kategori.filter(kt => String(kt.id) !== String(state.katId))
    const newProduk = produk.filter(pr => pr.category !== k.produkId)
    await writeJSON(env, 'Kategori', newKat)
    await writeJSON(env, 'Produk', newProduk)

    // Cleanup SnK
    const snkList = await readJSON(env, 'SnK', [])
    const newSnk = snkList.filter(s => String(s.id) !== String(state.katId))
    await writeJSON(env, 'SnK', newSnk)

    // Cleanup FlashSale
    const fsMap = await readJSON(env, 'FlashSale', {})
    let fsChanged = false
    for (const vid of deletedVids) {
      if (fsMap[vid]) {
        delete fsMap[vid]
        fsChanged = true
      }
    }
    if (fsChanged) await writeJSON(env, 'FlashSale', fsMap)

    // Cleanup StokBaru (arsip broadcast) — varian yang dihapus jangan tampil lagi
    try {
      const stokBaru = await readJSON(env, 'StokBaru', [])
      const sisaBaru = stokBaru.filter(e => !deletedVids.includes(String(e.id)))
      if (sisaBaru.length !== stokBaru.length) await writeJSON(env, 'StokBaru', sisaBaru)
    } catch (e) {}

    // Cleanup PriceChangeLogs
    for (const vid of deletedVids) {
      await deleteKey(env, 'PriceChangeLog_' + vid)
    }

    await deleteKey(env, 'adminState_' + fromId)
    await tgEditMessageText(env, chatId, messageId,
      '✅ Kategori *' + k.produkName + '* berhasil dihapus beserta semua data terkait.',
      adminMainPanel(), 'Markdown'
    )
    return
  }

  // ───────── USER LIST ─────────
  if (data === 'adm_userlist') {
    const { getUserList } = await import('./user.js')
    const users = await getUserList(env)
    let txt = '*👥 Daftar User (' + users.length + ')*\n\n'
    for (const u of users.slice(0, 20)) {
      txt += '• ' + (u.name || '-') + ' — ID: ' + u.chatId + ' — Saldo: ' + ParseIdr(u.balance || 0) + '\n'
    }
    if (users.length > 20) txt += '\n...dan ' + (users.length - 20) + ' user lainnya.'
    await tgEditMessageText(env, chatId, messageId, txt,
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_panel' }]] },
      'Markdown'
    )
    return
  }

  // ───────── BROADCAST ─────────
  if (data === 'adm_broadcast') {
    await tgEditMessageText(env, chatId, messageId,
      '*📢 Broadcast*\n\nGunakan command:\n`/bct <pesan>` — broadcast teks\n`/bci` — broadcast gambar',
      { inline_keyboard: [
        [{ text: '🆕 Broadcast Stok Terbaru', callback_data: 'adm_bc_stokbaru' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_panel' }]
      ] },
      'Markdown'
    )
    return
  }

  // ─── BC STOK MANUAL: panel antrian + seleksi ikut/jangan (10/halaman) ───
  if (data === 'adm_bc_stokbaru' || data.startsWith('adm_bc_stokbaru_pg_')) {
    const page = data.startsWith('adm_bc_stokbaru_pg_') ? (parseInt(data.replace('adm_bc_stokbaru_pg_', '')) || 0) : 0
    await bcStokPanel(env, chatId, messageId, page)
    return
  }

  // ─── BC STOK MANUAL: toggle ikut/jangan per baris ───
  if (data.startsWith('adm_bc_stokbaru_tg_')) {
    const parts = data.replace('adm_bc_stokbaru_tg_', '').split('_pg')
    const idx = parseInt(parts[0])
    const page = parseInt(parts[1] || '0') || 0
    try {
      const list = await readJSON(env, 'StokBaru', [])
      const pending = (list || []).filter(e => e.notifyPending)
      if (!isNaN(idx) && pending[idx]) {
        const target = list.find(e => String(e.id) === String(pending[idx].id))
        if (target) { target.excluded = !target.excluded; await writeJSON(env, 'StokBaru', list) }
      }
    } catch (e) {}
    await bcStokPanel(env, chatId, messageId, page)
    return
  }

  // ─── BC STOK MANUAL: ikut semua / jangan semua ───
  if (data.startsWith('adm_bc_stokbaru_all_')) {
    const parts = data.replace('adm_bc_stokbaru_all_', '').split('_pg')
    const val = parts[0] === '1'
    const page = parseInt(parts[1] || '0') || 0
    try {
      const list = await readJSON(env, 'StokBaru', [])
      for (const e of (list || [])) { if (e.notifyPending) e.excluded = !val }
      await writeJSON(env, 'StokBaru', list)
    } catch (e) {}
    await bcStokPanel(env, chatId, messageId, page)
    return
  }

  // ─── BC STOK MANUAL: toggle auto ON/OFF ───
  if (data.startsWith('adm_bc_stokbaru_auto')) {
    const page = data.includes('_pg') ? (parseInt(data.split('_pg')[1]) || 0) : 0
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.stokAutoNotif = (cfg.stokAutoNotif !== false) ? false : true
    await writeJSON(env, 'BotConfig', cfg)
    await tgAnswerCallbackQuery(env, cqId, cfg.stokAutoNotif ? '🔔 Auto AKTIF' : '🔕 Auto MATI (manual)')
    await bcStokPanel(env, chatId, messageId, page)
    return
  }

  // ─── BC STOK MANUAL: hapus antrian (pending=false, stok aman) ───
  if (data === 'adm_bc_stokbaru_clear') {
    try {
      const list = await readJSON(env, 'StokBaru', [])
      await writeJSON(env, 'StokBaru', (list || []).map(e => ({ ...e, notifyPending: false })))
    } catch (e) {}
    await tgAnswerCallbackQuery(env, cqId, '🗑 Antrian dibuang (stok aman)')
    await bcStokPanel(env, chatId, messageId, 0)
    return
  }

  // ─── BC STOK MANUAL: preview ke admin saja ───
  if (data === 'adm_bc_stokbaru_prev') {
    const bcMsg = await buildStokBaruBroadcast(env)
    if (!bcMsg) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tidak ada yang ikut (semua JANGAN/kosong)', true); return }
    await tgSendMessage(env, chatId, '👁 *Preview — persis yang diterima user:*\n\n' + bcMsg, null, 'Markdown')
    await tgAnswerCallbackQuery(env, cqId, '👁 Preview terkirim')
    return
  }

  // ─── BC STOK MANUAL: kirim sekarang (snapshot + lock cron yang sama) ───
  if (data === 'adm_bc_stokbaru_go') {
    const gotLock = await acquireLock(env, 'cron_stoknotif', 55)
    if (!gotLock) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Broadcast lain sedang jalan, tunggu selesai', true); return }
    try {
      const list = await readJSON(env, 'StokBaru', [])
      const ikut = (list || []).filter(e => e.notifyPending && !e.excluded)
      if (ikut.length === 0) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tidak ada yang ikut', true); return }
      const bcMsg = await buildStokBaruBroadcast(env)
      if (!bcMsg) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Pesan kosong', true); return }
      const bcUsers = await readJSON(env, 'UserList', [])
      const bcCfg = await readJSON(env, 'BotConfig', {})
      const bcImg = bcCfg.stokBcImg || null
      const banned = await readJSON(env, 'BannedUser', [])
      const banSet = new Set((banned || []).map(b => String(b.sender)))
      const targets = (bcUsers || []).map(u => u.chatId).filter(id => Number(id) > 0 && !banSet.has(String(id)))
      const snapIds = new Set(ikut.map(e => String(e.id)))
      let bcSent = 0
      for (let i = 0; i < targets.length; i += 25) {
        const batch = targets.slice(i, i + 25)
        const results = await Promise.allSettled(batch.map(async (uid) => {
          try {
            const r = bcImg
              ? await tgSendPhotoBase64(env, uid, bcImg, bcMsg, null, 'Markdown')
              : await tgSendMessage(env, uid, bcMsg, null, 'Markdown')
            if (r && r.ok === false && r.error_code === 429 && r.parameters && r.parameters.retry_after) {
              await new Promise(rr => setTimeout(rr, Math.min(Number(r.parameters.retry_after) || 1, 30) * 1000))
              const r2 = bcImg
                ? await tgSendPhotoBase64(env, uid, bcImg, bcMsg, null, 'Markdown')
                : await tgSendMessage(env, uid, bcMsg, null, 'Markdown')
              if (r2 && r2.ok === false) throw new Error('tg ' + r2.error_code)
            } else if (r && r.ok === false) throw new Error('tg ' + r.error_code)
            return true
          } catch (e) { throw e }
        }))
        for (const r of results) { if (r.status === 'fulfilled') bcSent++ }
        if ((i + 25) < targets.length) await sleep(800)
      }
      // Reset HANYA yang ikut snapshot — add baru tengah jalan tetap pending
      try {
        const curList = await readJSON(env, 'StokBaru', [])
        await writeJSON(env, 'StokBaru', (curList || []).map(e => (snapIds.has(String(e.id)) ? { ...e, notifyPending: false } : e)))
      } catch (e) {}
      await tgEditMessageText(env, chatId, messageId,
        '✅ Broadcast terkirim ke ' + bcSent + '/' + targets.length + ' user (' + ikut.length + ' produk).\nStatus notif direset (arsip tetap tersimpan).',
        { inline_keyboard: [[{ text: '🔙 Ke Panel', callback_data: 'adm_panel' }]] }, '')
    } finally {
      await releaseLock(env, 'cron_stoknotif')
    }
    return
  }

  // ======= SETTINGS CALLBACKS =======
// ═══════════════════════════════════════════════════════
// v9update18: Flash Sale + BC Harga callback handlers
// (insert INSIDE handleAdminCallback, BEFORE `if (data === 'adm_settings')`)
// Ordering: place *_ok_* handlers BEFORE their less-specific base to avoid
// startsWith collisions (e.g. adm_fs_bc_ok_ must come before adm_fs_bc_).
// ═══════════════════════════════════════════════════════

  // ═════ v9update18: FLASH SALE MAIN MENU ═════
  if (data === 'adm_flashsale') {
    await readJSON(env, 'FlashSale', {})  // trigger no-op read
    const { flashSaleCleanupAll } = await import('./user.js')
    await flashSaleCleanupAll(env)
    const all = await readJSON(env, 'FlashSale', {})
    const active = Object.keys(all).length
    const hist = await readJSON(env, 'FlashSaleHistory', [])
    const cfgB = await readJSON(env, 'BotConfig', {})
    const bStatus = cfgB.bannerFsB64 ? '✅ sudah diset' : '❌ belum diset'
    let cap = '*🔥 FLASH SALE MANAGER*\n'
    cap += '═══════════════════════════\n\n'
    cap += '🟢 Aktif    : *' + active + '* flash sale\n'
    cap += '📊 Riwayat  : ' + hist.length + ' selesai\n'
    cap += '🔥 Banner   : ' + bStatus + '\n\n'
    cap += '_Pilih aksi di bawah:_'
    const kb = {
      inline_keyboard: [
        [{ text: '➕ Buat Flash Sale Baru', callback_data: 'adm_fs_new' }],
        [{ text: '📋 Daftar Aktif (' + active + ')', callback_data: 'adm_fs_list' },
         { text: '📊 Riwayat', callback_data: 'adm_fs_hist' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_panel' }]
      ]
    }
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
    return
  }

  // ═════ STEP 1: pilih kategori → varian (single langsung lanjut) ═════
  if (data === 'adm_fs_new') {
    const produk = await readJSON(env, 'Produk', [])
    const kategori = await readJSON(env, 'Kategori', [])
    const fsAll = await readJSON(env, 'FlashSale', {})
    // filter kategori: ada varian eligible (stok > 0, belum FS)
    const rows = []
    for (const k of kategori) {
      const vs = produk.filter(p => p.category === k.produkId)
      const elig = vs.filter(p => (p.stok || []).length > 0 && !fsAll[String(p.id)])
      if (elig.length === 0) continue
      const sv = vs.find(v => v.single)
      const lbl = sv ? ('📦 ' + k.produkName + ' · langsung') : ('🗂️ ' + k.produkName + ' (' + elig.length + ' varian)')
      rows.push([{ text: lbl, callback_data: 'adm_fs_kat_' + k.id }])
    }
    if (rows.length === 0) {
      rows.push([{ text: 'ℹ️ Tidak ada produk eligible', callback_data: 'adm_flashsale' }])
    }
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_flashsale' }])
    await tgEditMessageText(env, chatId, messageId,
      '*🔥 Flash Sale — STEP 1/4*\n\nPilih produk yang mau flash sale:\n_(hanya produk dengan stok > 0 dan belum ada FS aktif)_',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  // ═════ STEP 1b: pilih varian (hanya kategori multi-varian) ═════
  if (data.startsWith('adm_fs_kat_')) {
    const produk = await readJSON(env, 'Produk', [])
    const kategori = await readJSON(env, 'Kategori', [])
    const katId = data.replace('adm_fs_kat_', '')
    const k = kategori.find(kt => String(kt.id) === String(katId))
    if (!k) return
    const fsAll = await readJSON(env, 'FlashSale', {})
    const vs = produk.filter(p => p.category === k.produkId)
    const sv = vs.find(v => v.single)
    if (sv && (sv.stok || []).length > 0 && !fsAll[String(sv.id)]) {
      // produk langsung — lompat ke STEP 2 tanpa tanya varian
      await writeJSON(env, 'adminState_' + fromId, {
        action: 'fs_price', variantId: sv.id, originalPrice: sv.price, variantName: sv.nameproduct
      })
      await tgEditMessageText(env, chatId, messageId,
        '*💰 Flash Sale — STEP 2/4*\n\n📦 ' + sv.nameproduct + ' (harga normal ' + ParseIdr(sv.price) + ')\n\nMasukkan *harga sale* (angka saja):',
        null, 'Markdown'
      )
      return
    }
    const rows = []
    for (const p of vs) {
      const stokCount = (p.stok || []).length
      if (stokCount <= 0) continue
      if (fsAll[String(p.id)]) continue
      rows.push([{ text: p.nameproduct + ' (Rp ' + Number(p.price).toLocaleString('id-ID') + ' | stok ' + stokCount + ')', callback_data: 'adm_fs_pick_' + p.id }])
    }
    if (rows.length === 0) {
      rows.push([{ text: 'ℹ️ Tidak ada varian eligible', callback_data: 'adm_fs_new' }])
    }
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_fs_new' }])
    await tgEditMessageText(env, chatId, messageId,
      '*🔥 Flash Sale — ' + k.produkName + '*\n\nPilih varian yang mau flash sale:',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  // ═════ STEP 1 lama (fallback): list mentah — dipertahankan untuk kompatibilitas ═════
  if (data === 'adm_fs_pick') {
    const { flashSaleCleanupAll } = await import('./user.js')
    await flashSaleCleanupAll(env)
    const fsAll = await readJSON(env, 'FlashSale', {})
    // filter: varian dgn stok > 0 dan blm ada FS aktif
    const rows = []
    for (const p of produk) {
      const stokCount = (p.stok || []).length
      if (stokCount <= 0) continue
      if (fsAll[String(p.id)]) continue
      rows.push([{ text: p.nameproduct + ' (Rp ' + Number(p.price).toLocaleString('id-ID') + ' | stok ' + stokCount + ')', callback_data: 'adm_fs_pick_' + p.id }])
    }
    if (rows.length === 0) {
      rows.push([{ text: 'ℹ️ Tidak ada varian eligible', callback_data: 'adm_flashsale' }])
    }
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_flashsale' }])
    await tgEditMessageText(env, chatId, messageId,
      '*🔥 Flash Sale — STEP 1/4*\n\nPilih varian yang mau flash sale:\n_(hanya varian dengan stok > 0 dan belum ada FS aktif)_',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  // ═════ STEP 2: input harga sale ═════
  if (data.startsWith('adm_fs_pick_')) {
    const variantId = data.replace('adm_fs_pick_', '')
    const p = produk.find(pr => String(pr.id) === String(variantId))
    if (!p) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Varian tidak ditemukan', true); return }
    await writeJSON(env, 'adminState_' + fromId, {
      action: 'fs_price', variantId, originalPrice: p.price, variantName: p.nameproduct
    })
    await tgEditMessageText(env, chatId, messageId,
      '*💰 Flash Sale — STEP 2/4*\n\n' +
      'Produk       : *' + p.nameproduct + '*\n' +
      'Harga normal : *' + ParseIdr(p.price) + '*\n\n' +
      'Ketik *harga sale* (angka saja, min 100).\n' +
      'Harus < harga normal.\n\n' +
      '_Contoh: 25000_\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_flashsale' }]] },
      'Markdown'
    )
    return
  }

  // ═════ STEP 3: pilih durasi (preset atau custom) ═════
  if (data === 'adm_fs_dur_custom') {
    const st = await readJSON(env, 'adminState_' + fromId, null)
    if (!st || st.action !== 'fs_await_dur') { await tgAnswerCallbackQuery(env, cqId, '⚠️ Sesi habis', true); return }
    await writeJSON(env, 'adminState_' + fromId, { ...st, action: 'fs_duration_custom' })
    await tgEditMessageText(env, chatId, messageId,
      '*⏰ Flash Sale — STEP 3/4*\n\nKetik durasi custom.\n\n' +
      'Format: `<angka><satuan>`\n' +
      'Satuan: `m` (menit), `h` (jam), `d` (hari)\n\n' +
      '_Contoh: 45m, 2h, 3d_\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_flashsale' }]] },
      'Markdown'
    )
    return
  }

  if (data.startsWith('adm_fs_dur_') && FS_PRESETS[data.replace('adm_fs_dur_', '')]) {
    const preset = data.replace('adm_fs_dur_', '')
    const st = await readJSON(env, 'adminState_' + fromId, null)
    if (!st || st.action !== 'fs_await_dur') { await tgAnswerCallbackQuery(env, cqId, '⚠️ Sesi habis', true); return }
    const info = FS_PRESETS[preset]
    const expiresAt = Date.now() + info.ms
    await writeJSON(env, 'adminState_' + fromId, {
      ...st, action: 'fs_confirm', durationMs: info.ms, durationLabel: info.label, expiresAt
    })
    await fsShowConfirm(env, chatId, messageId, fromId)
    return
  }

  // ═════ STEP 4: KONFIRMASI ═════
  if (data === 'adm_fs_confirm') {
    const st = await readJSON(env, 'adminState_' + fromId, null)
    if (!st || st.action !== 'fs_confirm') { await tgAnswerCallbackQuery(env, cqId, '⚠️ Sesi habis', true); return }
    const p = produk.find(pr => String(pr.id) === String(st.variantId))
    if (!p) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Varian hilang', true); return }
    const fs = {
      variantId: st.variantId,
      variantName: p.nameproduct,
      originalPrice: st.originalPrice,
      salePrice: st.salePrice,
      discountPercent: Math.round((st.originalPrice - st.salePrice) / st.originalPrice * 100),
      durationMs: st.durationMs,
      durationLabel: st.durationLabel,
      createdAt: Date.now(),
      createdBy: fromId,
      expiresAt: st.expiresAt,
      broadcasted: false,
      broadcastAt: null
    }
    const { flashSaleSetActive } = await import('./user.js')
    await flashSaleSetActive(env, st.variantId, fs)
    await deleteKey(env, 'adminState_' + fromId)
    // Prompt broadcast (format baru: header + quote + <pre>)
    const kategoriList2 = await readJSON(env, 'Kategori', [])
    const kat2 = kategoriList2.find(k => String(k.produkId) === String(p.category))
    const S2 = '━━━━━━━━━━━━━━━━━━━━'
    const judul2 = (kat2 ? kat2.produkName + ' - ' : '') + p.nameproduct
    const rows2 =
      '» Normal : ' + ParseIdr(fs.originalPrice) + '\n' +
      '» Sale   : ' + ParseIdr(fs.salePrice) + '\n' +
      '» Hemat  : ' + fs.discountPercent + '%\n' +
      '» Durasi : ' + fs.durationLabel + '\n' +
      '» Akhir  : ' + fsFormatEndsAtWIB(fs.expiresAt) + '\n' +
      '» Status : Belum broadcast'
    let cap = S2 + '\n𝗙𝗟𝗔𝗦𝗛 𝗦𝗔𝗟𝗘 𝗔𝗞𝗧𝗜𝗙\n' + S2 +
      '\n<blockquote>' + escHtml(judul2) + '</blockquote>\n<pre>' + escHtml(rows2) + '</pre>\n' + S2 +
      '\n\nBroadcast ke semua user sekarang?'
    const kb = {
      inline_keyboard: [
        [{ text: '📢 Ya, Broadcast Sekarang', callback_data: 'adm_fs_bc_ok_' + st.variantId }],
        [{ text: '⏭️ Nanti Saja', callback_data: 'adm_flashsale' },
         { text: '📋 Daftar Aktif', callback_data: 'adm_fs_list' }]
      ]
    }
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'HTML')
    return
  }

  // ═════ DAFTAR AKTIF ═════
  if (data === 'adm_fs_list') {
    const { flashSaleCleanupAll } = await import('./user.js')
    await flashSaleCleanupAll(env)
    const all = await readJSON(env, 'FlashSale', {})
    const keys = Object.keys(all)
    const rows = []
    for (const vid of keys) {
      const fs = all[vid]
      const remaining = fsFormatRemaining(fs.expiresAt - Date.now())
      const label = fs.variantName + ' — ' + fs.discountPercent + '% — ' + remaining
      rows.push([{ text: label, callback_data: 'adm_fs_view_' + vid }])
    }
    if (rows.length === 0) rows.push([{ text: 'ℹ️ Tidak ada flash sale aktif', callback_data: 'adm_flashsale' }])
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_flashsale' }])
    await tgEditMessageText(env, chatId, messageId,
      '*📋 Flash Sale Aktif* (' + keys.length + ')\n\nPilih untuk detail:',
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  // ═════ VIEW DETAIL ═════
  if (data.startsWith('adm_fs_view_')) {
    const vid = data.replace('adm_fs_view_', '')
    const { flashSaleGetActive } = await import('./user.js')
    const fs = await flashSaleGetActive(env, vid)
    if (!fs) { await tgAnswerCallbackQuery(env, cqId, 'ℹ️ Flash sale sudah tidak aktif', true); return }
    const remaining = fsFormatRemaining(fs.expiresAt - Date.now())
    const hemat = fs.originalPrice - fs.salePrice
    let cap = '🔥 *DETAIL FLASH SALE*\n'
    cap += '╭──────────────────────╮\n'
    cap += '┊ 📦 *' + fs.variantName + '*\n'
    cap += '├──────────────────────\n'
    cap += '┊ Normal    : ~' + ParseIdr(fs.originalPrice) + '~\n'
    cap += '┊ Sale      : 🔥 *' + ParseIdr(fs.salePrice) + '*\n'
    cap += '┊ Hemat     : 🎯 *' + (fs.discountPercent || 0) + '%* (' + ParseIdr(hemat) + ')\n'
    cap += '├──────────────────────\n'
    cap += '┊ Durasi    : ⏰ ' + fs.durationLabel + '\n'
    cap += '┊ Berakhir  : 📅 ' + fsFormatEndsAtWIB(fs.expiresAt) + '\n'
    cap += '┊ Sisa      : ⏳ *' + remaining + '*\n'
    cap += '├──────────────────────\n'
    cap += '┊ Broadcast : 📢 ' + (fs.broadcasted ? ('✅ sudah (' + fsFormatEndsAtWIB(fs.broadcastAt) + ')') : '❌ belum') + '\n'
    cap += '╰──────────────────────'
    const kb = {
      inline_keyboard: [
        [{ text: (fs.broadcasted ? '📢 BC Ulang' : '📢 Broadcast Sekarang'), callback_data: 'adm_fs_bc_ok_' + vid }],
        [{ text: '❌ Cancel Flash Sale', callback_data: 'adm_fs_cancel_' + vid }],
        [{ text: '🔙 Daftar', callback_data: 'adm_fs_list' }]
      ]
    }
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
    return
  }

  // ═════ CANCEL FS (konfirm dulu) ═════
  if (data.startsWith('adm_fs_cancel_ok_')) {
    const vid = data.replace('adm_fs_cancel_ok_', '')
    const { flashSaleCancel } = await import('./user.js')
    const fs = await flashSaleCancel(env, vid, 'admin_cancel')
    if (!fs) { await tgAnswerCallbackQuery(env, cqId, 'ℹ️ Flash sale tidak ditemukan', true); return }
    await tgAnswerCallbackQuery(env, cqId, '✅ Flash sale dibatalkan')
    // kembali ke daftar
    await tgEditMessageText(env, chatId, messageId,
      '✅ *Flash Sale dibatalkan*\n\n' + fs.variantName + '\nDicatat di riwayat.',
      { inline_keyboard: [[{ text: '🔙 Daftar', callback_data: 'adm_fs_list' }, { text: '🏠 Menu', callback_data: 'adm_flashsale' }]] },
      'Markdown'
    )
    return
  }

  if (data.startsWith('adm_fs_cancel_')) {
    const vid = data.replace('adm_fs_cancel_', '')
    const { flashSaleGetActive } = await import('./user.js')
    const fs = await flashSaleGetActive(env, vid)
    if (!fs) { await tgAnswerCallbackQuery(env, cqId, 'ℹ️ Sudah tidak aktif', true); return }
    await tgEditMessageText(env, chatId, messageId,
      '*⚠️ Cancel Flash Sale?*\n\n' + fs.variantName + '\n_' + fs.discountPercent + '% — sisa ' + fsFormatRemaining(fs.expiresAt - Date.now()) + '_\n\nHarga akan kembali normal untuk pesanan baru.',
      { inline_keyboard: [
        [{ text: '✅ Ya, Cancel', callback_data: 'adm_fs_cancel_ok_' + vid }],
        [{ text: '🔙 Batal', callback_data: 'adm_fs_view_' + vid }]
      ] }, 'Markdown'
    )
    return
  }

  // ═════ BROADCAST FS (do it) ═════
  if (data.startsWith('adm_fs_bc_ok_')) {
    const vid = data.replace('adm_fs_bc_ok_', '')
    const { flashSaleGetActive, flashSaleSetActive } = await import('./user.js')
    const fs = await flashSaleGetActive(env, vid)
    if (!fs) { await tgAnswerCallbackQuery(env, cqId, 'ℹ️ Sudah tidak aktif', true); return }
    await tgAnswerCallbackQuery(env, cqId, '📢 Broadcast dimulai...')
    const p = produk.find(pr => String(pr.id) === String(vid))
    const kategoriList = await readJSON(env, 'Kategori', [])
    const kat = p ? kategoriList.find(k => String(k.produkId) === String(p.category)) : null
    const banner = await fsGetBanner(env, 'bannerFsB64')
    const cap = await fsBuildBcCaption(env, fs, p ? p.nameproduct : fs.variantName, kat ? kat.produkName : null)
    const buyBtn = { text: '🛒 BELI SEKARANG (SALE)', callback_data: 'dpi_' + vid }
    // Q1: via bcStart resumable anti-banned (cron lanjutkan sisa).
    const targets = (await readJSON(env, 'UserList', [])).map(u => u.chatId).filter(id => Number(id) > 0)
    const capObj = cap
    const res = await bcStart(env, 'fs_' + vid, targets, {
      text: (capObj && capObj.text) || capObj, mode: (capObj && capObj.parseMode) || 'HTML',
      banner: banner ? { id: null, b64: banner } : null,
      button: buyBtn,
    })
    if (res.reason === 'running') {
      await tgSendMessage(env, chatId,
        '⏳ *Broadcast FS ini sedang jalan* (' + res.sent + '/' + res.total + '). Tunggu selesai — cron otomatis melanjutkan.',
        { inline_keyboard: [[{ text: '📋 Daftar Aktif', callback_data: 'adm_fs_list' }, { text: '🏠 Menu', callback_data: 'adm_flashsale' }]] },
        'Markdown'
      )
      return
    }
    await tgSendMessage(env, chatId,
      (res.done ? '✅ *Broadcast Flash Sale selesai*' : '⏳ *Broadcast FS dimulai*') + '\n\nTerkirim: *' + res.sent + '/' + res.total + '*\nGagal: ' + (res.fail || 0) + (res.done ? '' : '\nSisa otomatis dilanjutkan cron tiap menit.') + (banner ? '' : '\n\n_(tanpa banner — belum diset)_'),
      { inline_keyboard: [[{ text: '📋 Daftar Aktif', callback_data: 'adm_fs_list' }, { text: '🏠 Menu', callback_data: 'adm_flashsale' }]] },
      'Markdown'
    )
    return
  }

  // ═════ RIWAYAT ═════
  if (data === 'adm_fs_hist') {
    const hist = await readJSON(env, 'FlashSaleHistory', [])
    let cap = '*📊 Riwayat Flash Sale* (' + hist.length + ')\n\n'
    if (hist.length === 0) {
      cap += '_Belum ada riwayat._'
    } else {
      const show = hist.slice(0, 20)
      show.forEach((h, i) => {
        cap += (i + 1) + '. *' + (h.variantName || '-') + '*\n'
        cap += '   ' + ParseIdr(h.originalPrice) + ' → ' + ParseIdr(h.salePrice) + ' (' + (h.discountPercent || 0) + '%)\n'
        cap += '   ' + fsFormatEndsAtWIB(h.endedAt || h.createdAt) + ' — _' + (h.endReason || 'ended') + '_\n\n'
      })
      if (hist.length > 20) cap += '_...' + (hist.length - 20) + ' lainnya_'
    }
    await tgEditMessageText(env, chatId, messageId, cap,
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_flashsale' }]] }, 'Markdown'
    )
    return
  }

  // ═════ BC HARGA BARU (setelah edit harga) ═════
  if (data.startsWith('adm_bc_harga_ok_')) {
    const vid = data.replace('adm_bc_harga_ok_', '')
    const chg = await readJSON(env, 'PriceChangeLog_' + vid, null)
    if (!chg) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Info harga hilang. Edit ulang.', true); return }
    const p = produk.find(pr => String(pr.id) === String(vid))
    if (!p) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Varian hilang', true); return }
    await tgAnswerCallbackQuery(env, cqId, '📢 Broadcast dimulai...')
    const kategoriList = await readJSON(env, 'Kategori', [])
    const kat = kategoriList.find(k => String(k.produkId) === String(p.category))
    const banner = await fsGetBanner(env, 'bannerPriceB64')
    const cap = fsBuildBcPriceCaption(p.nameproduct, kat ? kat.produkName : null, chg.oldPrice, chg.newPrice)
    const buyBtn = { text: '🛒 Lihat Produk', callback_data: 'dpi_' + vid }
    // Q1: via bcStart (tuntas → bcFinish hapus PriceChangeLog + tandai).
    const targets = (await readJSON(env, 'UserList', [])).map(u => u.chatId).filter(id => Number(id) > 0)
    const res = await bcStart(env, 'harga_' + vid, targets, {
      text: cap, mode: 'Markdown',
      banner: banner ? { id: null, b64: banner } : null,
      button: buyBtn,
    })
    if (res.reason === 'running') {
      await tgSendMessage(env, chatId,
        '⏳ *BC harga ini sedang jalan* (' + res.sent + '/' + res.total + '). Tunggu selesai — cron otomatis melanjutkan.',
        adminMainPanel(), 'Markdown'
      )
      return
    }
    await tgSendMessage(env, chatId,
      (res.done ? '✅ *BC Harga Baru selesai*' : '⏳ *BC Harga dimulai*') + '\n\nTerkirim: *' + res.sent + '/' + res.total + '*\nGagal: ' + (res.fail || 0) + (res.done ? '' : '\nSisa otomatis dilanjutkan cron tiap menit.') + (banner ? '' : '\n\n_(tanpa banner — belum diset)_'),
      adminMainPanel(), 'Markdown'
    )
    return
  }

  if (data.startsWith('adm_bc_harga_')) {
    const vid = data.replace('adm_bc_harga_', '')
    const chg = await readJSON(env, 'PriceChangeLog_' + vid, null)
    if (!chg) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Info harga hilang. Edit ulang.', true); return }
    const p = produk.find(pr => String(pr.id) === String(vid))
    if (!p) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Varian hilang', true); return }
    const pct = chg.oldPrice > 0 ? Math.round(Math.abs(chg.oldPrice - chg.newPrice) / chg.oldPrice * 100) : 0
    const arah = chg.newPrice < chg.oldPrice ? 'TURUN' : 'NAIK'
    let cap = '*📢 Konfirmasi BC Harga Baru*\n\n'
    cap += '📦 ' + p.nameproduct + '\n'
    cap += '💰 ' + ParseIdr(chg.oldPrice) + ' → *' + ParseIdr(chg.newPrice) + '* (' + arah + ' ' + pct + '%)\n\n'
    cap += 'Broadcast ke *' + ((await readJSON(env, 'UserList', [])).length) + '* user?'
    await tgEditMessageText(env, chatId, messageId, cap,
      { inline_keyboard: [
        [{ text: '✅ Ya, Broadcast', callback_data: 'adm_bc_harga_ok_' + vid }],
        [{ text: '⏭️ Batal', callback_data: 'adm_panel' }]
      ] }, 'Markdown'
    )
    return
  }

  // ═════ BANNER FLASH SALE (upload / hapus) ═════
  if (data === 'adm_del_fs_banner') {
    const cfgB = await readJSON(env, 'BotConfig', {})
    delete cfgB.bannerFsB64
    await writeJSON(env, 'BotConfig', cfgB)
    await tgAnswerCallbackQuery(env, cqId, '✅ Banner Flash Sale dihapus')
    await tgEditMessageText(env, chatId, messageId,
      '✅ Banner Flash Sale dihapus.',
      { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_fs_banner') {
    const cfgB = await readJSON(env, 'BotConfig', {})
    const has = !!cfgB.bannerFsB64
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_fs_banner', cardMessageId: messageId })
    let cap = '*🔥 Banner Flash Sale*\n\n'
    cap += 'Status: ' + (has ? '✅ sudah diset' : '❌ belum diset') + '\n\n'
    cap += 'Kirim file *.txt* berisi *base64* gambar banner Flash Sale.\n'
    cap += '_(Recommended: 1200x600 landscape, tema merah/oranye, format PNG/JPG di-encode base64)_\n\n'
    cap += 'Banner ini akan dipakai sebagai header broadcast Flash Sale.'
    const kb = has
      ? { inline_keyboard: [[{ text: '🗑 Hapus Banner', callback_data: 'adm_del_fs_banner' }], [{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
      : { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
    return
  }

  // ═════ BANNER UPDATE HARGA (upload / hapus) ═════
  if (data === 'adm_del_price_banner') {
    const cfgB = await readJSON(env, 'BotConfig', {})
    delete cfgB.bannerPriceB64
    await writeJSON(env, 'BotConfig', cfgB)
    await tgAnswerCallbackQuery(env, cqId, '✅ Banner Update Harga dihapus')
    await tgEditMessageText(env, chatId, messageId,
      '✅ Banner Update Harga dihapus.',
      { inline_keyboard: [[{ text: '🔙 Settings', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_price_banner') {
    const cfgB = await readJSON(env, 'BotConfig', {})
    const has = !!cfgB.bannerPriceB64
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_price_banner', cardMessageId: messageId })
    let cap = '*💰 Banner Update Harga*\n\n'
    cap += 'Status: ' + (has ? '✅ sudah diset' : '❌ belum diset') + '\n\n'
    cap += 'Kirim file *.txt* berisi *base64* gambar banner Update Harga.\n'
    cap += '_(Recommended: 1200x600 landscape, tema hijau/biru, format PNG/JPG di-encode base64)_\n\n'
    cap += 'Banner ini akan dipakai sebagai header broadcast "BC Harga Baru".'
    const kb = has
      ? { inline_keyboard: [[{ text: '🗑 Hapus Banner', callback_data: 'adm_del_price_banner' }], [{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
      : { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
    return
  }

// === END v9update18 callbacks ===

  if (data === 'adm_toggle_leaderboard') {
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.leaderboardEnabled = (cfg.leaderboardEnabled !== false) ? false : true
    await writeJSON(env, 'BotConfig', cfg)
    data = 'adm_setfolder_fitur'
  }

  if (data === 'adm_toggle_stoknotif') {
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.stokAutoNotif = (cfg.stokAutoNotif !== false) ? false : true
    await writeJSON(env, 'BotConfig', cfg)
    await tgAnswerCallbackQuery(env, cqId, cfg.stokAutoNotif ? '🔔 Notif stok otomatis AKTIF' : '🔕 Notif stok otomatis NONAKTIF')
    data = 'adm_setfolder_fitur'
  }

  if (data === 'adm_set_lb_banner') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const lbHasBanner = !!(cfg.leaderboardBanner && cfg.leaderboardBanner.length > 50)
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_lb_banner', cardMessageId: messageId })
    const kb = lbHasBanner
      ? { inline_keyboard: [[{ text: '🗑 Hapus Banner', callback_data: 'adm_del_lb_banner' }], [{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
      : { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
    await tgEditMessageText(env, chatId, messageId,
      '*🖼️ UPLOAD BANNER LEADERBOARD*\n\nSilakan kirimkan string gambar base64 untuk banner Leaderboard.\n\n_Ketik /batal jika tidak jadi._',
      kb, 'Markdown'
    )
    return
  }

  if (data === 'adm_del_lb_banner') {
    const cfg = await readJSON(env, 'BotConfig', {})
    cfg.leaderboardBanner = ''
    await writeJSON(env, 'BotConfig', cfg)
    data = 'adm_settings'
  }

  if (data === 'adm_set_success_sticker') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const stHasSticker = !!cfg.successSticker
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_success_sticker', cardMessageId: messageId })
    const kb = stHasSticker
      ? { inline_keyboard: [[{ text: '🗑️ Hapus Stiker', callback_data: 'adm_del_success_sticker' }], [{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
      : { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }
    await tgEditMessageText(env, chatId, messageId,
      '*✨ UPLOAD STIKER SUKSES*\n\nSilakan kirimkan sebuah stiker langsung (bukan gambar/base64/teks) untuk ditampilkan saat transaksi sukses.\n\n_Ketik /batal jika tidak jadi._',
      kb, 'Markdown'
    )
    return
  }

  if (data === 'adm_del_success_sticker') {
    const cfg = await readJSON(env, 'BotConfig', {})
    delete cfg.successSticker
    await writeJSON(env, 'BotConfig', cfg)
    data = 'adm_settings'
  }

  // P7: panel umur topik tiket (1-100 hari + hapus otomatis 10 mnt).
  if (data === 'adm_ticket_keep' || data.startsWith('adm_ticket_keep_')) {
    const KEEP_OPTS = [1, 3, 7, 14, 30, 100]
    let cfg = await readJSON(env, 'BotConfig', {})
    if (cfg.ticketKeepDays === undefined) cfg.ticketKeepDays = 7
    if (cfg.ticketAutoDelTopic === undefined) cfg.ticketAutoDelTopic = true
    if (data.startsWith('adm_ticket_keep_') && data !== 'adm_ticket_keep_custom' && data !== 'adm_ticket_keep_topic') {
      const n = parseInt(data.replace('adm_ticket_keep_', ''), 10)
      if (KEEP_OPTS.includes(n)) {
        cfg.ticketKeepDays = n
        await writeJSON(env, 'BotConfig', cfg)
        try { const { initConfig } = await import('./config.js'); await initConfig(env) } catch {}
        await tgAnswerCallbackQuery(env, cqId, 'Umur topik: ' + n + ' hari', false)
      } else {
        await tgAnswerCallbackQuery(env, cqId, 'Nilai tidak valid', true)
      }
      cfg = await readJSON(env, 'BotConfig', {})
    }
    if (data === 'adm_ticket_keep_topic') {
      cfg.ticketAutoDelTopic = cfg.ticketAutoDelTopic === false ? true : false
      await writeJSON(env, 'BotConfig', cfg)
      try { const { initConfig } = await import('./config.js'); await initConfig(env) } catch {}
      await tgAnswerCallbackQuery(env, cqId, cfg.ticketAutoDelTopic ? 'Hapus otomatis: YA (10 mnt)' : 'Hapus otomatis: TIDAK', false)
      cfg = await readJSON(env, 'BotConfig', {})
    }
    if (data === 'adm_ticket_keep_custom') {
      await writeJSON(env, 'adminState_' + fromId, { action: 'settings_ticket_keep', cardMessageId: messageId })
      await tgEditMessageText(env, chatId, messageId,
        '*UMUR TOPIK TIKET*\n\nKetik angka *1-100* (hari).\n\n_Ketik /batal jika tidak jadi._',
        { inline_keyboard: [[{ text: 'Batal', callback_data: 'adm_ticket_keep' }]] }, 'Markdown'
      )
      return
    }
    const keep2 = cfg.ticketKeepDays !== undefined ? cfg.ticketKeepDays : 7
    const autoDel = cfg.ticketAutoDelTopic !== false
    const warn = (keep2 < 7) ? '\n\nUmur < 7 hari: tiket bisa terhapus sebelum window reopen 7 hari habis.' : ''
    const statusLine = autoDel ? 'Status hapus otomatis: *AKTIF (10 mnt)*' : 'Status hapus otomatis: *NONAKTIF*'
    const explain = '\n\nUmur ' + keep2 + ' hari = arsip tiket di database.\nHapus otomatis ' + (autoDel ? 'YA = topik forum hilang 10 mnt setelah tiket ditutup (user/admin sama).' : 'TIDAK = topik forum tidak dihapus otomatis.') + warn
    const rows = [
      [{ text: '1 hari', callback_data: 'adm_ticket_keep_1' }, { text: '3 hari', callback_data: 'adm_ticket_keep_3' }, { text: '7 hari', callback_data: 'adm_ticket_keep_7' }],
      [{ text: '14 hari', callback_data: 'adm_ticket_keep_14' }, { text: '30 hari', callback_data: 'adm_ticket_keep_30' }, { text: '100 hari', callback_data: 'adm_ticket_keep_100' }],
      [{ text: 'Ketik angka (1-100)', callback_data: 'adm_ticket_keep_custom' }],
      [{ text: 'Hapus otomatis saat closed: ' + (autoDel ? 'YA (10 mnt)' : 'TIDAK'), callback_data: 'adm_ticket_keep_topic' }],
      [{ text: 'Kembali ke Channel & Log', callback_data: 'adm_setfolder_channel' }]
    ]
    await tgEditMessageText(env, chatId, messageId,
      '*UMUR TOPIK TIKET*\n\nTiket selesai disimpan: *' + keep2 + ' hari*\n' + statusLine + explain,
      { inline_keyboard: rows }, 'Markdown'
    )
    return
  }

  if (data === 'adm_set_channel_ticket') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const cur = cfg.channelTicket || '-'
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_ticket_channel', cardMessageId: messageId })
    await tgEditMessageText(env, chatId, messageId,
      '*👥 SETTING GRUP SUPPORT TIKET*\n\n' +
      'ID Grup saat ini: `' + cur + '`\n\n' +
      'Silakan ketik dan kirimkan ID *Grup Telegram (Supergrup)* yang akan menjadi tempat masuknya tiket baru.\n\n_Ketik /batal jika ingin membatalkan._' +
      '_Disarankan grup ini mengaktifkan fitur "Topics" (Topik/Forum) agar tiap tiket otomatis dibuatkan kamar tersendiri._\n\n' +
      'Contoh ID: `-1001234567890`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_channel_log_tx') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const cur = cfg.ChannelLog || '-'
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_channel_log', cardMessageId: messageId })
    await tgEditMessageText(env, chatId, messageId,
      '*📢 SETTING CHANNEL LOG TRANSAKSI*\n\n' +
      'ID/Link saat ini: `' + cur + '`\n\n' +
      'Silakan kirimkan ID Channel, format `ID_Grup:ThreadID`, atau **paste langsung Link Topik Grup** tempat bot mengirimkan log transaksi sukses/gagal.\n\n_Ketik /batal jika ingin membatalkan._' +
      'Contoh ID: `-1001234567890`\n' +
      'Contoh Format Topic: `-1001234567890:5` (untuk topik ID 5)\n' +
      'Contoh Link Topic: `https://t.me/c/1234567890/5`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }

  if (data === 'adm_set_channel_backup') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const cur = cfg.channelBackup || '-'
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_channel_backup', cardMessageId: messageId })
    await tgEditMessageText(env, chatId, messageId,
      '*💾 SETTING CHANNEL BACKUP DB*\n\n' +
      'ID/Link saat ini: `' + cur + '`\n\n' +
      'Silakan kirimkan ID Channel, format `ID_Grup:ThreadID`, atau **paste langsung Link Topik Grup** tempat bot mengirimkan file Backup Database JSON.\n\n_Ketik /batal jika ingin membatalkan._' +
      'Contoh ID: `-1001234567890`\n' +
      'Contoh Format Topic: `-1001234567890:5`\n' +
      'Contoh Link Topic: `https://t.me/c/1234567890/5`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }


  if (data.startsWith('tk_adm_page_')) {
    const parts = data.replace('tk_adm_page_', '').split('_')
    const tkId = parts[0]
    const page = parseInt(parts[1]) || 1
    
    const tickets = await readJSON(env, 'Tickets', [])
    const t = tickets.find(ticket => ticket.ticketId === tkId)
    if (!t) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true); return }

    const adminSt = await readJSON(env, 'adminState_' + fromId, null)
    const isReplying = adminSt && adminSt.action === 'admin_reply_ticket' && adminSt.ticketId === tkId
    const fromName = cq.from.first_name || cq.from.username || 'Admin'

    const { renderTicketCard: rtcPage } = await import('./ticketCard.js')
    const pcard = rtcPage(t, { role: 'admin', page, typing: isReplying ? fromName : '', viewerId: fromId })
    try {
      await tgEditMessageText(env, chatId, messageId, pcard.text, pcard.keyboard, 'HTML')
    } catch (e) {}
    return
  }

  if (data.startsWith('tk_adm_reply_')) {
    const tkId = data.replace('tk_adm_reply_', '')
    const fromName = cq.from.first_name || cq.from.username || 'Admin'
    
    const tickets = await readJSON(env, 'Tickets', [])
    const t = tickets.find(ticket => ticket.ticketId === tkId)
    if (!t) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true); return }

    await writeJSON(env, 'adminState_' + fromId, { 
      action: 'admin_reply_ticket', 
      ticketId: tkId,
      logChatId: chatId,
      logMessageId: messageId
    })
    
    const { renderTicketCard: rtcRep } = await import('./ticketCard.js')
    const newText = rtcRep(t, { role: 'admin', typing: fromName, viewerId: fromId }).text
    const kb = rtcRep(t, { role: 'admin', typing: fromName, viewerId: fromId }).keyboard
    try {
      await tgEditMessageText(env, chatId, messageId, newText, kb, 'HTML')
    } catch (e) {}

    try {
      await tgSendMessage(env, fromId, 
        '📝 *BALAS TIKET: ' + tkId + '*\n\n' +
        'Silakan ketik pesan jawaban Anda untuk dikirim ke user.\n' +
        '_(Ketik /batal untuk membatalkan)_', 
        null, 'Markdown'
      )
    } catch (e) {}
    return
  }

  if (data.startsWith('tk_adm_cancel_reply_')) {
    const tkId = data.replace('tk_adm_cancel_reply_', '')
    await deleteKey(env, 'adminState_' + fromId)
    
    const tickets = await readJSON(env, 'Tickets', [])
    const t = tickets.find(ticket => ticket.ticketId === tkId)
    if (!t) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true); return }

    const { renderTicketCard: rtcCancel } = await import('./ticketCard.js')
    const ccard = rtcCancel(t, { role: 'admin', viewerId: fromId })
    try {
      await tgEditMessageText(env, chatId, messageId, ccard.text, ccard.keyboard, 'HTML')
    } catch (e) {}
    return
  }

  if (data.startsWith('tk_adm_close_')) {
    const tkId = data.replace('tk_adm_close_', '')
    const tickets = await readJSON(env, 'Tickets', [])
    const idx = tickets.findIndex(ticket => ticket.ticketId === tkId)
    if (idx === -1) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true); return }

    tickets[idx].status = 'closed'
    tickets[idx].closedAt = Date.now()
    tickets[idx].lastActivityAt = Date.now()
    await writeJSON(env, 'Tickets', tickets)

    const t = tickets[idx]
    // F2 CF: Undo kedaluwarsa 5 detik dari sekarang.
    t.deleteTopicAt = Date.now() + 10 * 60 * 1000
    await writeJSON(env, 'TicketUndo_' + tkId, Date.now())
    const { renderTicketCard: rtcClose } = await import('./ticketCard.js')
    const closeCard = rtcClose(t, { role: 'admin', viewerId: fromId })
    try {
      await tgEditMessageText(env, chatId, messageId,
        '🔒 <b>Tiket ditutup</b> — ' + tkId + '\n\n' + closeCard.text,
        { inline_keyboard: [[{ text: 'Undo tutup (5 dtk)', callback_data: 'tk_adm_undo_close_' + tkId }], ...closeCard.keyboard.inline_keyboard] },
        'HTML')
    } catch (e) {}

    // Tutup (bukan hapus) forum topic, arsip tetap terjaga
    if (t.logChatId && t.threadId) {
      try { await tgCloseForumTopic(env, t.logChatId, t.threadId) } catch (e) {}
    }

    // Update judul topik: tanpa umur, tandai selesai
    if (t.logChatId && t.threadId) {
      try {
        const shortId = t.ticketId.split('-')[1] || 'TKT'
        const uname = t.userUsername ? t.userUsername : (t.userName || 'User')
        await tgEditForumTopic(env, t.logChatId, t.threadId, '🎫 [' + shortId + '] ' + uname + ' • ✅')
      } catch (e) {}
    }

    try {
      const { getMainMenuKeyboard } = await import('./keyboard.js')
      await tgSendMessage(env, t.userId, '🎫 *Tiket Bantuan Anda (' + tkId + ') telah dinyatakan Selesai oleh Admin.*', getMainMenuKeyboard(), 'Markdown')
    } catch (e) {}

    // Lanjut ke tiket tertua berikutnya — PESAN BARU (kartu Undo tetap utuh).
    const next = tickets
      .filter(x => x.status === 'open' || x.status === 'answered')
      .sort((a, b) => (a.lastActivityAt || 0) - (b.lastActivityAt || 0))[0]
    if (next && next.ticketId !== tkId) {
      await tgAnswerCallbackQuery(env, cqId, '🔒 Ditutup. Lanjut: ' + next.ticketId, false)
      try {
        const { renderTicketCard: rtcNext } = await import('./ticketCard.js')
        const ncard = rtcNext(next, { role: 'admin', viewerId: fromId })
        await tgSendMessage(env, chatId, ncard.text, ncard.keyboard, 'HTML')
      } catch (e) {}
      return
    }
    await tgAnswerCallbackQuery(env, cqId, '🔒 Tiket ditutup. Tidak ada antrian lain.', false)
    return
  }

  if (data.startsWith('tk_adm_undo_close_')) {
    const tkId = data.replace('tk_adm_undo_close_', '')
    const tickets = await readJSON(env, 'Tickets', [])
    const idx = tickets.findIndex(ticket => ticket.ticketId === tkId)
    if (idx === -1) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true); return }
    const undoAt = Number(await readJSON(env, 'TicketUndo_' + tkId, 0)) || 0
    if (Date.now() - undoAt > 5000) {
      await deleteKey(env, 'TicketUndo_' + tkId)
      await tgAnswerCallbackQuery(env, cqId, '⏰ Masa Undo habis — pakai Buka Lagi bila perlu.', true)
      return
    }
    await deleteKey(env, 'TicketUndo_' + tkId)
    const { ensureTopicAlive: etaUndo } = await import('./ticket.js')
    await etaUndo(env, tickets[idx])
    tickets[idx].status = 'answered'
    tickets[idx].closedAt = null
    tickets[idx].deleteTopicAt = null
    tickets[idx].lastActivityAt = Date.now()
    await writeJSON(env, 'Tickets', tickets)
    const t = tickets[idx]
    await tgAnswerCallbackQuery(env, cqId, '↩️ Penutupan dibatalkan', false)
    if (t.logChatId && t.threadId) { try { const { tgReopenForumTopic: rt } = await import('./telegram.js'); await rt(env, t.logChatId, t.threadId) } catch (e) {} }
    try {
      const { renderTicketCard: rtcUndo } = await import('./ticketCard.js')
      const card = rtcUndo(t, { role: 'admin', viewerId: fromId })
      await tgEditMessageText(env, chatId, messageId, card.text, card.keyboard, 'HTML')
    } catch (e) {}
    return
  }

  // P4: klaim + ambil-alih tiket (tanpa kunci, hanya indikator penangan).
  if (data.startsWith('tk_adm_takeover_') || data.startsWith('tk_adm_claim_')) {
    const tkId = data.replace('tk_adm_takeover_', '').replace('tk_adm_claim_', '')
    const tickets = await readJSON(env, 'Tickets', [])
    const idx = tickets.findIndex(ticket => ticket.ticketId === tkId)
    if (idx === -1) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true); return }
    tickets[idx].assignedTo = fromId
    tickets[idx].assignedName = cq.from.first_name || cq.from.username || 'Admin'
    await writeJSON(env, 'Tickets', tickets)
    const t = tickets[idx]
    await tgAnswerCallbackQuery(env, cqId, data.startsWith('tk_adm_takeover_') ? '↩️ Diambil alih' : '🎧 Dipegang', false)
    try {
      const card = renderTicketCard(t, { role: 'admin', viewerId: fromId })
      await tgEditMessageText(env, chatId, messageId, card.text, card.keyboard, 'HTML')
    } catch (e) {}
    return
  }

  if (data === 'tk_adm_cat_proses' || data === 'tk_adm_cat_selesai') {
    const isProses = data === 'tk_adm_cat_proses'
    const tickets = await readJSON(env, 'Tickets', [])
    let filtered = tickets.filter(t => isProses ? (t.status === 'open' || t.status === 'answered') : (t.status === 'closed'))

    // Antrean: paling lama menunggu di atas (tiket baru di bawah)
    if (isProses) {
      filtered = filtered.sort((a, b) => (a.lastActivityAt || 0) - (b.lastActivityAt || 0))
    } else {
      filtered = filtered.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    }

    if (filtered.length === 0) {
      await tgEditMessageText(env, chatId, messageId, '📭 Tidak ada tiket dalam kategori ini.', {
        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'tk_adm_back_cat' }]]
      })
      return
    }

    const { ticketDot: tDot, catLabel: cLbl, ticketAge: tAge } = await import('./ticketCard.js')
    let cap = isProses
      ? '🎫 <b>ANTREAN TIKET</b> · ' + filtered.length + ' perlu ditangani\n'
      : '🎫 <b>TIKET SELESAI</b> · ' + filtered.length + '\n'
    cap += '<i>🔴 &gt;1 jam · 🟡 menunggu admin · 🔵 menunggu user</i>\n\n'
    filtered.slice(0, 20).forEach(t => {
      const age = tAge(t)
      cap += tDot(t) + ' <b>' + t.ticketId + '</b> · ' + cLbl(t.category) + ' · ' + age.label + '\n'
    })

    const rows = []
    filtered.slice(0, 20).forEach(t => {
      rows.push([{ text: tDot(t) + ' ' + t.ticketId + ' · ' + (t.userUsername ? '@' + t.userUsername : t.userName), callback_data: 'tk_adm_view_' + t.ticketId }])
    })
    rows.push([{ text: '🔙 Kembali', callback_data: 'tk_adm_back_cat' }])

    await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: rows }, 'Markdown')
    return
  }

  if (data === 'tk_adm_back_cat') {
    const tickets = await readJSON(env, 'Tickets', [])
    const openCount = tickets.filter(t => t.status === 'open' || t.status === 'answered').length
    const closedCount = tickets.filter(t => t.status === 'closed').length
    let cap = '╭───〔 🎫 DAFTAR TIKET BOT 〕───\n'
    cap += '┊ Pilih status tiket di bawah:\n'
    cap += '╰──────────────────\n'
    const kb = {
      inline_keyboard: [
        [{ text: '🔵 PROSES (' + openCount + ')', callback_data: 'tk_adm_cat_proses' }],
        [{ text: '🟢 SELESAI (' + closedCount + ')', callback_data: 'tk_adm_cat_selesai' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_cat_komunikasi' }],
        [{ text: '❌ Tutup Menu', callback_data: 'adm_tutup' }]
      ]
    }
    await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
    return
  }

  if (data.startsWith('tk_adm_view_')) {
    const tkId = data.replace('tk_adm_view_', '')
    const tickets = await readJSON(env, 'Tickets', [])
    const t = tickets.find(ticket => ticket.ticketId === tkId)
    if (!t) {
      await tgAnswerCallbackQuery(env, cq.id, '⚠️ Tiket tidak ditemukan.', true)
      return
    }

    const { renderTicketCard: rtcView } = await import('./ticketCard.js')
    const vcard = rtcView(t, { role: 'admin', viewerId: fromId })
    await tgEditMessageText(env, chatId, messageId, vcard.text, vcard.keyboard, 'HTML')
    return
  }

  if (data === 'adm_noop') {
    await tgAnswerCallbackQuery(env, cqId)
    return
  }

  if (data === 'adm_manage_admin') {
    if (!isOwner(fromId)) {
      await tgAnswerCallbackQuery(env, cqId, '🚫 Hanya Owner yang dapat mengelola Admin!', true)
      return
    }
    const roles = await readJSON(env, 'Role', [])
    const admins = roles.filter(r => r.role === 'admin')
    const users = await readJSON(env, 'UserList', [])

    const rows = []
    for (const adm of admins) {
      const u = users.find(usr => String(usr.chatId) === String(adm.id))
      rows.push([
        { text: '👤 ' + (u ? u.name : ('ID: ' + adm.id)), callback_data: 'adm_noop' },
        { text: '❌ Hapus', callback_data: 'adm_del_admin_' + adm.id }
      ])
    }

    if (admins.length < 10) {
      rows.push([{ text: '➕ Tambah Admin Baru', callback_data: 'adm_add_admin_start' }])
    }
    rows.push([{ text: '🔙 Kembali ke Panel', callback_data: 'adm_panel' }])

    let cap = '╭───〔 👑 KELOLA ADMIN BOT 〕───\n'
    cap += '┊ Total Admin : *' + admins.length + ' / 10*\n'
    cap += '├──────────────────\n'
    if (admins.length === 0) {
      cap += '┊ _Belum ada admin tambahan._\n'
    } else {
      cap += '┊ Daftar admin aktif saat ini:\n'
    }
    cap += '╰──────────────────'

    await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: rows }, 'Markdown')
    return
  }

  if (data.startsWith('adm_del_admin_')) {
    if (!isOwner(fromId)) {
      await tgAnswerCallbackQuery(env, cqId, '🚫 Hanya Owner yang dapat mengelola Admin!', true)
      return
    }
    const targetId = data.replace('adm_del_admin_', '')
    const { demoteRole } = await import('./user.js')
    await demoteRole(env, targetId)

    try {
      await tgSendMessage(env, targetId, 'ℹ️ *Akses Admin Bot Anda telah dinonaktifkan oleh Owner.*', null, 'Markdown')
    } catch (e) {}

    await tgAnswerCallbackQuery(env, cqId, '✅ Admin berhasil dihapus!')
    
    cq.data = 'adm_manage_admin'
    await handleAdminCallback(env, cq)
    return
  }

  if (data === 'adm_add_admin_start') {
    if (!isOwner(fromId)) {
      await tgAnswerCallbackQuery(env, cqId, '🚫 Hanya Owner yang dapat mengelola Admin!', true)
      return
    }
    const roles = await readJSON(env, 'Role', [])
    const admins = roles.filter(r => r.role === 'admin')
    if (admins.length >= 10) {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Kuota admin sudah penuh (Maksimal 10)!', true)
      return
    }

    await writeJSON(env, 'adminState_' + fromId, { action: 'add_admin_id', cardMessageId: messageId })
    await tgEditMessageText(env, chatId, messageId,
      '*👑 TAMBAH ADMIN BARU*\n\nSilakan masukkan Telegram User ID calon admin yang baru:\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_manage_admin' }]] }, 'Markdown'
    )
    return
  }

  if (data === 'adm_settings') {
    await tgEditMessageText(env, chatId, messageId,
      '*⚙️ PENGATURAN BOT*\n\nPilih kategori pengaturan:',
      {
        inline_keyboard: [
          [{ text: '🏷️ Identitas & Info', callback_data: 'adm_setfolder_identitas' }, { text: '🖼️ Media & Banner', callback_data: 'adm_setfolder_media' }],
          [{ text: '📢 Channel & Log', callback_data: 'adm_setfolder_channel' }, { text: '💳 Payment Gateway', callback_data: 'adm_payment' }],
          [{ text: '🏆 Fitur Tambahan', callback_data: 'adm_setfolder_fitur' }, { text: '💾 Kelola Database', callback_data: 'adm_setfolder_db' }],
          [{ text: '🔙 Kembali ke Panel Admin', callback_data: 'adm_panel' }]
        ]
      }, 'Markdown'
    )
    return
  }

  // 📂 SUBFOLDER: Identitas & Info
  if (data === 'adm_setfolder_identitas') {
    await tgEditMessageText(env, chatId, messageId,
      '*🏷️ IDENTITAS & INFORMASI*\nPengaturan identitas bot dan pesan bantuan:',
      {
        inline_keyboard: [
          [{ text: '🏷️ Identitas Bot (Nama)', callback_data: 'adm_identity' }],
          [{ text: '📝 Pesan Cara Order', callback_data: 'adm_set_caraorder' }],
          [{ text: '🔙 Kembali ke Settings', callback_data: 'adm_settings' }]
        ]
      }, 'Markdown'
    )
    return
  }

  // 📂 SUBFOLDER: Media & Banner
  if (data === 'adm_setfolder_media') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const stStatus = cfg.successSticker ? ' (✅)' : ' (❌)'
    await tgEditMessageText(env, chatId, messageId,
      '*🖼️ MEDIA & BANNER*\nPengaturan gambar banner dan stiker bot:',
      {
        inline_keyboard: [
          [{ text: '🖼️ Banner Start (Base64)', callback_data: 'adm_set_banner_start' }],
          [{ text: '🖼️ Banner List Produk (Base64)', callback_data: 'adm_set_banner_list' }],
          [{ text: '🔥 Banner Flash Sale (Base64)', callback_data: 'adm_set_fs_banner' }],
          [{ text: '💰 Banner Update Harga (Base64)', callback_data: 'adm_set_price_banner' }],
          [{ text: '🖼️ Gambar Broadcast Stok', callback_data: 'adm_set_bcstok_img' }],
          [{ text: '🎯 Sticker Sukses' + stStatus, callback_data: 'adm_set_success_sticker' }],
          [{ text: '🔙 Kembali ke Settings', callback_data: 'adm_settings' }]
        ]
      }, 'Markdown'
    )
    return
  }

  // 📂 SUBFOLDER: Channel & Log
  if (data === 'adm_setfolder_channel') {
    await tgEditMessageText(env, chatId, messageId,
      '*📢 CHANNEL & LOG*\nPengaturan integrasi grup dan log otomatis:',
      {
        inline_keyboard: [
          [{ text: '🔔 Kelola Notifikasi Transaksi', callback_data: 'adm_notif' }],
          [{ text: '📢 Setting Channel Log Transaksi', callback_data: 'adm_set_channel_log_tx' }],
          [{ text: '🎫 Setting Log Tiket (Grup/Ch)', callback_data: 'adm_set_channel_ticket' }],
          [{ text: 'Umur Topik Tiket', callback_data: 'adm_ticket_keep' }],
          [{ text: '💾 Setting Channel Backup DB', callback_data: 'adm_set_channel_backup' }],
          [{ text: '🔙 Kembali ke Settings', callback_data: 'adm_settings' }]
        ]
      }, 'Markdown'
    )
    return
  }

  // 🔔 Panel: Kelola Notifikasi Transaksi
  // (adm_notif_set ditangani terpisah di bawah — jangan masuk startsWith ini)
  if (data === 'adm_notif' || (data.startsWith('adm_notif_') && data !== 'adm_notif_set')) {
    const cfg = await readJSON(env, 'BotConfig', {})
    const cur = cfg.ChannelLog || '-'
    const sOk = cfg.txlogSuccess !== false ? '✅ Aktif' : '❌ Nonaktif'
    const fOk = cfg.txlogFailed !== false ? '✅ Aktif' : '❌ Nonaktif'
    const mOk = cfg.txlogMask !== false ? '🙈 Sensor ID' : '👁 ID Full'

    if (data === 'adm_notif_test') {
      await tgAnswerCallbackQuery(env, cqId, '🧪 Mengirim tes ke target', false)
      const { sendTxLog } = await import('./messages.js')
      await sendTxLog(env, {
        type: 'success',
        user: { username: 'tester', id: fromId },
        produk: 'Produk Contoh', varian: 'Varian Contoh',
        total: 15000, qty: 1, provider: 'qris', role: 'User',
        fileTxtContent: null, fileName: null
      })
      return
    }

    let next = {}
    if (data === 'adm_notif_success') { cfg.txlogSuccess = cfg.txlogSuccess !== false ? false : true; next = { a: 'success', v: cfg.txlogSuccess } }
    if (data === 'adm_notif_failed') { cfg.txlogFailed = cfg.txlogFailed !== false ? false : true; next = { a: 'failed', v: cfg.txlogFailed } }
    if (data === 'adm_notif_mask') { cfg.txlogMask = cfg.txlogMask !== false ? false : true; next = { a: 'mask', v: cfg.txlogMask } }
    if (next.a) {
      await writeJSON(env, 'BotConfig', cfg)
      await tgAnswerCallbackQuery(env, cqId, next.v ? 'Dihidupkan ✅' : 'Dimatikan ❌', false)
      const { initConfig } = await import('./config.js')
      await initConfig(env)
    }

    const cur2 = (await readJSON(env, 'BotConfig', {})).ChannelLog || '-'
    const sOk2 = (await readJSON(env, 'BotConfig', {})).txlogSuccess !== false ? '✅ Aktif' : '❌ Nonaktif'
    const fOk2 = (await readJSON(env, 'BotConfig', {})).txlogFailed !== false ? '✅ Aktif' : '❌ Nonaktif'
    const mOk2 = (await readJSON(env, 'BotConfig', {})).txlogMask !== false ? '🙈 Sensor ID' : '👁 ID Full'
    await tgEditMessageText(env, chatId, messageId,
      '*🔔 NOTIFIKASI TRANSAKSI*\n' +
      '━━━━━━━━━━━━\n' +
      'Setiap pembelian otomatis dikirim ke grup/topik.\n\n' +
      'Target : `' + cur2 + '`\n' +
      'Notif Sukses : ' + sOk2 + '\n' +
      'Notif Gagal : ' + fOk2 + '\n' +
      'Sensor ID : ' + mOk2,
      {
        inline_keyboard: [
          [{ text: '1️⃣ Atur Target Grup/Topik', callback_data: 'adm_notif_set' }],
          [{ text: '2️⃣ Notif Sukses : ' + sOk2, callback_data: 'adm_notif_success' }],
          [{ text: '3️⃣ Notif Gagal : ' + fOk2, callback_data: 'adm_notif_failed' }],
          [{ text: '4️⃣ ' + mOk2, callback_data: 'adm_notif_mask' }],
          [{ text: '5️⃣ Kirim Tes 🧪', callback_data: 'adm_notif_test' }],
          [{ text: '🔙 Kembali ke Channel & Log', callback_data: 'adm_setfolder_channel' }]
        ]
      }, 'Markdown'
    )
    return
  }

  // 🔔 Tombol 1: masuk mode input target (3 langkah)
  if (data === 'adm_notif_set') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_channel_log', cardMessageId: messageId })
    await tgEditMessageText(env, chatId, messageId,
      '*ATUR TARGET NOTIFIKASI*\n' +
      'LANGKAH 1/3 - Aktifkan Topik di Grup\n' +
      'Buka grup kamu, ketuk nama grup di atas, pilih Pengaturan Grup, lalu aktifkan Topik. ' +
      'Kalau grup kamu sudah ada topiknya, lewati langkah ini.\n\n' +
      'LANGKAH 2/3 - Masukkan Bot ke Grup\n' +
      'Tambahkan bot ini ke grup, lalu jadikan admin agar bisa kirim pesan. ' +
      'Cara: buka info grup, Tambah Anggota, cari nama bot ini, setelah masuk buka Admin lalu aktifkan Izin Kirim Pesan.\n\n' +
      'LANGKAH 3/3 - Salin dan Tempel Tautan Topik\n' +
      'Buka topik yang kamu mau, ketuk nama topik di atas, ketuk ikon titik tiga, pilih Salin Tautan. ' +
      'Tempel tautan itu ke sini. Contoh: `-1001234567890:5`\n\n' +
      '_Ketik /batal bila tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_notif' }]] }, 'Markdown'
    )
    return
  }

  // 📂 SUBFOLDER: Fitur Tambahan
  if (data === 'adm_setfolder_fitur') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const lbEnabled = cfg.leaderboardEnabled !== false
    const lbHasBanner = !!(cfg.leaderboardBanner && cfg.leaderboardBanner.length > 50)
    const stokNotif = cfg.stokAutoNotif !== false
    await tgEditMessageText(env, chatId, messageId,
      '*🏆 FITUR TAMBAHAN*\nPengaturan fitur-fitur opsional bot:',
      {
        inline_keyboard: [
          [{ text: '🏆 Leaderboard: ' + (lbEnabled ? '✅ Aktif' : '❌ Nonaktif'), callback_data: 'adm_toggle_leaderboard' }],
          [{ text: '🖼️ Banner Leaderboard (' + (lbHasBanner ? 'Sudah Ada' : 'Belum Ada') + ')', callback_data: 'adm_set_lb_banner' }],
          [{ text: '🔔 Notif Stok Otomatis: ' + (stokNotif ? '✅ Aktif' : '❌ Nonaktif'), callback_data: 'adm_toggle_stoknotif' }],
          [{ text: '🔙 Kembali ke Settings', callback_data: 'adm_settings' }]
        ]
      }, 'Markdown'
    )
    return
  }

  // 📂 SUBFOLDER: Kelola Database
  if (data === 'adm_setfolder_db') {
    await showDbMenu(env, chatId, messageId)
    return
  }

  // ─── DB: switch backend ───
  if (data === 'adm_db_mode_kv' || data === 'adm_db_mode_turso') {
    const to = data === 'adm_db_mode_turso' ? 'turso' : 'kv'
    const { saveDbMode, testTurso: testConn } = await import('./db.js')
    if (to === 'turso') {
      const cfgT = await readJSON(env, 'BotConfig', {})
      const bT = (cfgT && cfgT.db) || {}
      const urlT = env.TURSO_URL || bT.url || ''
      if (!urlT) { await tgAnswerCallbackQuery(env, cqId, '⚠️ URL Turso kosong. Isi dulu via menu database.', true); return }
      const tokenT = env.TURSO_TOKEN || bT.token || ''
      const t = await testConn(urlT, tokenT)
      if (!t.ok) { await tgAnswerCallbackQuery(env, cqId, '❌ Turso tak terjangkau: ' + (t.error || 'gagal').slice(0, 70), true); return }
    }
    await saveDbMode(env, to)
    const { resetDbCache } = await import('./db.js')
    resetDbCache(env)
    await showDbMenu(env, chatId, messageId)
    await tgAnswerCallbackQuery(env, cqId, to === 'turso' ? '🗄️ Mode: Turso' : '💾 Mode: Lokal/KV')
    return
  }
  if (data === 'adm_db_url') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'db_turso_url' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔗 Turso URL*\nKirim URL database, contoh:\n`libsql://bot-store-xxx.turso.io`\n\n_Didapat dari dashboard turso.tech → database → Connect._\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_setfolder_db' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_db_token') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'db_turso_token' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔑 Turso Auth Token*\nKirim token (`turso db tokens create <nama-db>`).\nPesan Anda akan dihapus otomatis untuk keamanan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_setfolder_db' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_db_test') {
    const cfg = await readJSON(env, 'BotConfig', {})
    const b = (cfg && cfg.db) || {}
    const url = env.TURSO_URL || b.url || ''
    const token = env.TURSO_TOKEN || b.token || ''
    const { testTurso } = await import('./db.js')
    const r = await testTurso(url, token)
    await tgAnswerCallbackQuery(env, cqId, r.ok ? '✅ Turso OK' : '❌ ' + (r.error || 'gagal').slice(0, 80), !r.ok)
    await showDbMenu(env, chatId, messageId)
    return
  }
  // migrasi dua fase (db.js): baca penuh dulu, tulis setelahnya.
  // Mode di-flip HANYA bila migrateKeys return ok.
  if (data === 'adm_db_mig_up' || data === 'adm_db_mig_down') {
    const dir = data === 'adm_db_mig_up' ? 'up' : 'down'
    try {
      const { migrateKeys, saveDbMode, resetDbCache } = await import('./db.js')
      const r = await migrateKeys(env, dir)
      if (!r.ok) { await tgAnswerCallbackQuery(env, cqId, '❌ ' + (r.error || 'gagal').slice(0, 80), true); return }
      await saveDbMode(env, r.active)
      resetDbCache(env)
      await showDbMenu(env, chatId, messageId)
      const skipTxt = r.skipped ? ' (lewati ' + r.skipped + ')' : ''
      await tgAnswerCallbackQuery(env, cqId, '✅ Migrasi ok: ' + r.moved + '/' + r.total + ' key' + skipTxt)
    } catch (e) {
      await tgAnswerCallbackQuery(env, cqId, '❌ Migrasi gagal: ' + e.message.slice(0, 80), true)
    }
    return
  }

  if (data === 'adm_backup_db') {
    try {
      const keys = ['Kategori', 'Produk', 'SnK', 'Trx', 'UserList', 'Role', 'BannedUser', 'Voucher', 'VoucherBatch', 'VoucherAudit', 'OrderCounter', 'BotConfig', 'StokKeluar', 'StokBaru', 'FlashSale', 'FlashSaleHistory', 'Tickets', 'SessionDeposit']
      const backup = {}
      for (const key of keys) {
        backup[key] = await readJSON(env, key, null)
      }
      // Jangan bocorkan secret: token Turso tidak ikut backup
      if (backup.BotConfig && typeof backup.BotConfig === 'object' && backup.BotConfig.db) {
        backup.BotConfig = { ...backup.BotConfig, db: { ...backup.BotConfig.db, token: undefined } }
      }
      const { getDate } = await import('./helpers.js')
      const dateStr = getDate('Asia/Jakarta').replace(/[^0-9]/g, '_')
      const content = JSON.stringify(backup, null, 2)
      await tgSendDocument(env, chatId, content, 'backup_' + dateStr + '.json', 'Manual Backup - ' + getDate('Asia/Jakarta'))
      await tgAnswerCallbackQuery(env, cqId, '✅ Backup berhasil dikirim!')
    } catch (e) {
      await tgAnswerCallbackQuery(env, cqId, '❌ Gagal backup: ' + e.message, true)
    }
    return
  }

  if (data === 'adm_load_db') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_load_db', cardMessageId: messageId })
    await tgEditMessageText(env, chatId, messageId,
      '*💾 LOAD DATABASE*\n\nSilakan kirimkan berkas file backup (`.json`) yang valid ke bot ini.\n\n⚠️ *PERINGATAN: Seluruh database bot saat ini akan ditimpa!*\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_payment') {
    const pay = await getPayCfg(env)
    const gwPk = pay.gateways.pakasir
    const gwDk = pay.gateways.duitku
    const gwSw = pay.gateways.saweria
    const onPk = gwPk.enabled ? '🟢' : '⚪'
    const onDk = gwDk.enabled ? '🟢' : '⚪'
    const onSw = gwSw.enabled ? '🟢' : '⚪'
    const actPk = (pay.active === 'pakasir') ? ' ⭐' : ''
    const actDk = (pay.active === 'duitku')  ? ' ⭐' : ''
    const actSw = (pay.active === 'saweria') ? ' ⭐' : ''
    let activeName = '🅿️ Pakasir'
    if (pay.active === 'duitku') activeName = '🅳 Duitku'
    if (pay.active === 'saweria') activeName = '🍧 Saweria'
    let cap = '*💳 SETTING PAYMENT*\n'
    cap += 'Active gateway: *' + activeName + '*\n\n'
    cap += 'Pilih gateway untuk dikonfigurasi:\n\n'
    cap += '_Fee tiap gateway independen — set beda sesuai channel biaya._'
    await tgEditMessageText(env, chatId, messageId, cap,
      { inline_keyboard: [
        [{ text: onPk + ' Pakasir ' + (gwPk.enabled ? '(aktif)' : '(nonaktif)') + actPk, callback_data: 'adm_pay_pakasir' }],
        [{ text: onDk + ' Duitku (QRIS) '   + (gwDk.enabled ? '(aktif)' : '(nonaktif)') + actDk, callback_data: 'adm_pay_duitku'  }],
        [{ text: onSw + ' Saweria (QRIS) '  + (gwSw.enabled ? '(aktif)' : '(nonaktif)') + actSw, callback_data: 'adm_pay_saweria'  }],
        [{ text: '🔙 Kembali', callback_data: 'adm_settings' }]
      ] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_pay_pakasir') {
    await showPakasirMenu(env, chatId, messageId)
    return
  }
  if (data === 'adm_pay_pk_toggle') {
    const pay = await getPayCfg(env); pay.gateways.pakasir.enabled = !pay.gateways.pakasir.enabled
    await savePayCfg(env, pay); await showPakasirMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_pk_mode') {
    const pay = await getPayCfg(env)
    pay.gateways.pakasir.mode = (pay.gateways.pakasir.mode === 'sandbox') ? 'production' : 'sandbox'
    await savePayCfg(env, pay); await showPakasirMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_pk_slug') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_pk_slug' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔑 Slug Project Pakasir*\nKirim slug project (contoh: `tokosaya`).\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_pakasir' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_pk_apikey') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_pk_apikey' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔐 API Key Pakasir*\nKirim API Key project. Pesan Anda akan dihapus otomatis untuk keamanan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_pakasir' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_pk_method') {
    const rows = PAYMENT_METHODS.map(m => [{ text: methodLabel(m), callback_data: 'adm_pay_pk_setm_' + m }])
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_pay_pakasir' }])
    await tgEditMessageText(env, chatId, messageId,
      '*💳 Pilih Metode Pembayaran*',
      { inline_keyboard: rows }, 'Markdown'
    ); return
  }
  if (data.startsWith('adm_pay_pk_setm_')) {
    const m = data.replace('adm_pay_pk_setm_', '')
    if (!PAYMENT_METHODS.includes(m)) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Metode invalid', true); return }
    const pay = await getPayCfg(env); pay.gateways.pakasir.method = m; await savePayCfg(env, pay)
    await showPakasirMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_pk_fee') {
    const pay = await getPayCfg(env); const gw = pay.gateways.pakasir
    await tgEditMessageText(env, chatId, messageId,
      '*💰 Setting Fee Transaksi*\n' +
      'Fee saat ini: *' + feeLabel(gw) + '*\n\n' +
      'Fee bisa persen, nominal Rp, atau gabungan keduanya.\n' +
      'Set 0 untuk menonaktifkan salah satu.',
      { inline_keyboard: [
        [{ text: '📊 Fee Persen (' + Number(gw.feePercent||0) + '%)', callback_data: 'adm_pay_pk_feepct' }],
        [{ text: '💵 Fee Nominal (Rp' + Number(gw.feeNominal||0).toLocaleString('id-ID') + ')', callback_data: 'adm_pay_pk_feenom' }],
        [{ text: '↻ Reset Fee (0)', callback_data: 'adm_pay_pk_feereset' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_pay_pakasir' }]
      ] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_pk_feepct') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_pk_feepct' })
    await tgEditMessageText(env, chatId, messageId,
      '*📊 Fee Persen*\nKirim angka 0–100 (contoh: `2.5` untuk 2.5%). Kirim `0` untuk menonaktifkan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_pk_fee' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_pk_feenom') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_pk_feenom' })
    await tgEditMessageText(env, chatId, messageId,
      '*💵 Fee Nominal (Rp)*\nKirim nominal fee dalam Rupiah (contoh: `1000`). Kirim `0` untuk menonaktifkan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_pk_fee' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_pk_feereset') {
    const pay = await getPayCfg(env); pay.gateways.pakasir.feePercent = 0; pay.gateways.pakasir.feeNominal = 0
    await savePayCfg(env, pay); await showPakasirMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_pk_test') {
    const pay = await getPayCfg(env); const gw = pay.gateways.pakasir
    if (!gw.slug || !gw.apiKey) {
      await tgEditMessageText(env, chatId, messageId,
        '*❌ Uji Koneksi Gagal*\n\n⚠️ Silakan isi **Slug** dan **API Key** terlebih dahulu sebelum melakukan uji koneksi.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_pakasir' }]] }, 'Markdown'
      ); return
    }
    const testOrder = 'TEST-' + Date.now()
    const c = await pakasirCreate(gw, testOrder, 1000)
    let out
    if (c.ok) { try { await pakasirCancel(gw, testOrder, 1000) } catch (e) {}; out = '✅ Koneksi OK. Payment number: `' + (c.payment.payment_number||'-').toString().slice(0,32) + '...`' }
    else out = '❌ Gagal: ' + (c.error || 'unknown')
    await tgEditMessageText(env, chatId, messageId, '*🧪 Test Koneksi Pakasir*\n\n' + out,
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_pakasir' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_pk_activate') {
    const pay = await getPayCfg(env)
    const gw = pay.gateways.pakasir
    if (!gw.slug || !gw.apiKey) {
      await tgEditMessageText(env, chatId, messageId,
        '*⚠️ Gagal Mengaktifkan*\n\nSilakan isi **Slug** dan **API Key** terlebih dahulu sebelum menjadikannya active gateway.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_pakasir' }]] }, 'Markdown'
      ); return
    }
    gw.enabled = true
    pay.active = 'pakasir'; await savePayCfg(env, pay)
    await tgAnswerCallbackQuery(env, cqId, '⭐ Pakasir dijadikan active gateway!', true)
    await showPakasirMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_duitku') {
    await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_toggle') {
    const pay = await getPayCfg(env); pay.gateways.duitku.enabled = !pay.gateways.duitku.enabled
    await savePayCfg(env, pay); await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_mode') {
    const pay = await getPayCfg(env)
    pay.gateways.duitku.mode = (pay.gateways.duitku.mode === 'sandbox') ? 'production' : 'sandbox'
    await savePayCfg(env, pay); await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_merch') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_dk_merch' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔑 Merchant Code Duitku*\nKirim Merchant Code dari dashboard Duitku (contoh: `D14042`).\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_duitku' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_apikey') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_dk_apikey' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔐 API Key Duitku*\nKirim API Key project. Pesan Anda akan dihapus otomatis untuk keamanan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_duitku' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_qris') {
    const pay = await getPayCfg(env); const gw = pay.gateways.duitku
    const current = gw.qrisProvider || 'SP'
    const rows = Object.keys(DUITKU_QRIS_PROVIDERS).map(code => {
      const mark = (code === current) ? '● ' : '○ '
      const label = DUITKU_QRIS_PROVIDERS[code].label + '  (' + code + ')'
      const extra = (code === 'SP') ? ' ⭐' : ''
      return [{ text: mark + label + extra, callback_data: 'adm_pay_dk_qris_' + code }]
    })
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_pay_duitku' }])
    await tgEditMessageText(env, chatId, messageId,
      '*🔲 Pilih QRIS Provider*\nSemua provider menghasilkan QR standar QRIS.id — bisa di-scan dari app apapun.\nDefault: *SP (Shopee QRIS)*.',
      { inline_keyboard: rows }, 'Markdown'
    ); return
  }
  if (data.startsWith('adm_pay_dk_qris_')) {
    const code = data.replace('adm_pay_dk_qris_', '')
    if (!DUITKU_QRIS_PROVIDERS[code]) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Provider invalid', true); return }
    const pay = await getPayCfg(env); pay.gateways.duitku.qrisProvider = code; await savePayCfg(env, pay)
    await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_fee') {
    const pay = await getPayCfg(env); const gw = pay.gateways.duitku
    await tgEditMessageText(env, chatId, messageId,
      '*💰 Fee Transaksi Duitku*\nFee saat ini: *' + feeLabel(gw) + '*\n\n_Fee ini independen dari Pakasir._ Set beda-beda sesuai bank/channel biaya.',
      { inline_keyboard: [
        [{ text: '📊 Fee Persen (' + Number(gw.feePercent||0) + '%)', callback_data: 'adm_pay_dk_feepct' }],
        [{ text: '💵 Fee Nominal (Rp' + Number(gw.feeNominal||0).toLocaleString('id-ID') + ')', callback_data: 'adm_pay_dk_feenom' }],
        [{ text: '↻ Reset Fee (0)', callback_data: 'adm_pay_dk_feereset' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_pay_duitku' }]
      ] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_feepct') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_dk_feepct' })
    await tgEditMessageText(env, chatId, messageId,
      '*📊 Fee Persen Duitku*\nKirim angka 0–100 (contoh: `2.5` untuk 2.5%). Kirim `0` untuk menonaktifkan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_dk_fee' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_feenom') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_dk_feenom' })
    await tgEditMessageText(env, chatId, messageId,
      '*💵 Fee Nominal Duitku (Rp)*\nKirim nominal fee dalam Rupiah (contoh: `1000`). Kirim `0` untuk menonaktifkan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_dk_fee' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_feereset') {
    const pay = await getPayCfg(env); pay.gateways.duitku.feePercent = 0; pay.gateways.duitku.feeNominal = 0
    await savePayCfg(env, pay); await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_expiry') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_dk_expiry' })
    await tgEditMessageText(env, chatId, messageId,
      '*⏱️ Expiry Duitku (menit)*\nKirim angka menit untuk masa berlaku QRIS (contoh: `30`).\nRange per provider berbeda, sistem akan auto-clamp ke max.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_duitku' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_vipt') {
    const pay = await getPayCfg(env); pay.gateways.duitku.verifyIp = !pay.gateways.duitku.verifyIp
    await savePayCfg(env, pay); await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_test') {
    const pay = await getPayCfg(env); const gw = pay.gateways.duitku
    if (!gw.merchantCode || !gw.apiKey) {
      await tgEditMessageText(env, chatId, messageId,
        '*❌ Uji Koneksi Gagal*\n\n⚠️ Silakan isi **Merchant Code** dan **API Key** terlebih dahulu sebelum melakukan uji koneksi.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_duitku' }]] }, 'Markdown'
      ); return
    }
    const r = await duitkuTest(gw)
    let out
    if (r.ok) out = '✅ Koneksi OK\nProvider : *' + r.provider + '*\nReference: `' + r.reference + '`\nQR (40ch): `' + r.qrPreview + '`'
    else out = '❌ Gagal (' + r.stage + '): ' + (r.error || 'unknown')
    await tgEditMessageText(env, chatId, messageId, '*🧪 Test Koneksi Duitku*\n\n' + out,
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_duitku' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_dk_activate') {
    const pay = await getPayCfg(env)
    const gw = pay.gateways.duitku
    if (!gw.merchantCode || !gw.apiKey) {
      await tgEditMessageText(env, chatId, messageId,
        '*⚠️ Gagal Mengaktifkan*\n\nSilakan isi **Merchant Code** dan **API Key** terlebih dahulu sebelum menjadikannya active gateway.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_duitku' }]] }, 'Markdown'
      ); return
    }
    gw.enabled = true
    pay.active = 'duitku'; await savePayCfg(env, pay)
    await tgAnswerCallbackQuery(env, cqId, '⭐ Duitku dijadikan active gateway!', true)
    await showDuitkuMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_dk_reset') {
    const pay = await getPayCfg(env)
    const def = defaultPayCfg()
    pay.gateways.duitku = def.gateways.duitku
    if (pay.active === 'duitku') pay.active = 'pakasir'
    await savePayCfg(env, pay); await showDuitkuMenu(env, chatId, messageId)
    await tgAnswerCallbackQuery(env, cqId, '♻️ Duitku config di-reset.', true); return
  }
  if (data === 'adm_pay_saweria') {
    await showSaweriaMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_sw_toggle') {
    const pay = await getPayCfg(env); pay.gateways.saweria.enabled = !pay.gateways.saweria.enabled
    await savePayCfg(env, pay); await showSaweriaMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_sw_username') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_sw_username' })
    await tgEditMessageText(env, chatId, messageId,
      '*🔑 Username Saweria*\nKirim username Saweria (slug di URL, contoh: `tokoanda` — dari saweria.co/tokoanda).\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_saweria' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_userid') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_sw_userid' })
    await tgEditMessageText(env, chatId, messageId,
      '*🆔 User ID Saweria*\nKirim User ID Saweria (UUID, contoh: `595ace77-9e88-493b-acae-e9752b0cd829`).\nAmbil dari saweria.co → Settings/API atau DevTools halaman donasi.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_saweria' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_fee') {
    const pay = await getPayCfg(env); const gw = pay.gateways.saweria
    await tgEditMessageText(env, chatId, messageId,
      '*💰 Fee Transaksi Saweria*\nFee saat ini: *' + feeLabel(gw) + '*\n\n_Fee ini independen dari gateway lain._ Set beda-beda sesuai biaya.',
      { inline_keyboard: [
        [{ text: '📊 Fee Persen (' + Number(gw.feePercent||0) + '%)', callback_data: 'adm_pay_sw_feepct' }],
        [{ text: '💵 Fee Nominal (Rp' + Number(gw.feeNominal||0).toLocaleString('id-ID') + ')', callback_data: 'adm_pay_sw_feenom' }],
        [{ text: '↻ Reset Fee (0)', callback_data: 'adm_pay_sw_feereset' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_pay_saweria' }]
      ] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_feepct') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_sw_feepct' })
    await tgEditMessageText(env, chatId, messageId,
      '*📊 Fee Persen Saweria*\nKirim angka 0–100 (contoh: `2.5` untuk 2.5%). Kirim `0` untuk menonaktifkan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_sw_fee' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_feenom') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_sw_feenom' })
    await tgEditMessageText(env, chatId, messageId,
      '*💵 Fee Nominal Saweria (Rp)*\nKirim nominal fee dalam Rupiah (contoh: `1000`). Kirim `0` untuk menonaktifkan.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_sw_fee' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_feereset') {
    const pay = await getPayCfg(env); pay.gateways.saweria.feePercent = 0; pay.gateways.saweria.feeNominal = 0
    await savePayCfg(env, pay); await showSaweriaMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_sw_expiry') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'pay_sw_expiry' })
    await tgEditMessageText(env, chatId, messageId,
      '*⏱️ Expiry Saweria (menit)*\nKirim angka menit untuk masa berlaku QRIS (contoh: `10`).\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_pay_saweria' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_test') {
    const pay = await getPayCfg(env); const gw = pay.gateways.saweria
    if (!gw.username || !gw.userId) {
      await tgEditMessageText(env, chatId, messageId,
        '*❌ Uji Koneksi Gagal*\n\n⚠️ Silakan isi **Username** dan **User ID** terlebih dahulu sebelum melakukan uji koneksi.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_saweria' }]] }, 'Markdown'
      ); return
    }
    const { saweriaTest } = await import('./saweria.js')
    const r = await saweriaTest(gw)
    let out
    if (r.ok) out = '✅ Koneksi OK\nUser ID ter-resolve: `' + r.userId + '`\nCocok dengan config: *' + (r.userIdMatch ? 'YA' : 'TIDAK — update?') + '*'
    else out = '❌ Gagal (' + r.stage + '): ' + (r.error || 'unknown')
    await tgEditMessageText(env, chatId, messageId, '*🧪 Test Koneksi Saweria*\n\n' + out,
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_saweria' }]] }, 'Markdown'
    ); return
  }
  if (data === 'adm_pay_sw_autoid') {
    // resolve user_id otomatis dari username publik
    const pay = await getPayCfg(env); const gw = pay.gateways.saweria
    if (!gw.username) {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Isi username dulu.', true); return
    }
    const { saweriaResolveUserId } = await import('./saweria.js')
    const r = await saweriaResolveUserId(gw.username)
    if (!r.ok) {
      await tgAnswerCallbackQuery(env, cqId, '❌ ' + (r.error || 'gagal'), true); return
    }
    gw.userId = r.userId
    await savePayCfg(env, pay)
    await tgAnswerCallbackQuery(env, cqId, '✅ User ID otomatis: ' + r.userId.slice(0, 8) + '…', true)
    await showSaweriaMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_sw_activate') {
    const pay = await getPayCfg(env)
    const gw = pay.gateways.saweria
    if (!gw.username || !gw.userId) {
      await tgEditMessageText(env, chatId, messageId,
        '*⚠️ Gagal Mengaktifkan*\n\nSilakan isi **Username** dan **User ID** terlebih dahulu sebelum menjadikannya active gateway.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_pay_saweria' }]] }, 'Markdown'
      ); return
    }
    gw.enabled = true
    pay.active = 'saweria'; await savePayCfg(env, pay)
    await tgAnswerCallbackQuery(env, cqId, '⭐ Saweria dijadikan active gateway!', true)
    await showSaweriaMenu(env, chatId, messageId); return
  }
  if (data === 'adm_pay_sw_reset') {
    const pay = await getPayCfg(env)
    const def = defaultPayCfg()
    pay.gateways.saweria = def.gateways.saweria
    if (pay.active === 'saweria') pay.active = 'pakasir'
    await savePayCfg(env, pay); await showSaweriaMenu(env, chatId, messageId)
    await tgAnswerCallbackQuery(env, cqId, '♻️ Saweria config di-reset.', true); return
  }
  if (data === 'adm_set_bcstok_img') {
    const cfgimg = await readJSON(env, 'BotConfig', {})
    const statusImg = cfgimg.stokBcImg ? '✅ Gambar sudah diset' : '❌ Belum ada gambar'
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_bcstok_img' })
    await tgEditMessageText(env, chatId, messageId,
      '*🖼️ Gambar Broadcast Stok*\nStatus: ' + statusImg + '\n\nKirim string base64 gambar untuk disertakan saat Broadcast Stok Terbaru.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [
        [{ text: '🗑️ Hapus Gambar', callback_data: 'adm_del_bcstok_img' }],
        [{ text: '🔙 Batal', callback_data: 'adm_settings' }]
      ] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_del_bcstok_img') {
    const cfgd = await readJSON(env, 'BotConfig', {})
    delete cfgd.stokBcImg
    await writeJSON(env, 'BotConfig', cfgd)
    await deleteKey(env, 'adminState_' + fromId)
    await tgEditMessageText(env, chatId, messageId,
      '✅ Gambar broadcast stok dihapus. Broadcast akan dikirim sebagai teks biasa.',
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_caraorder') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_caraorder' })
    await tgEditMessageText(env, chatId, messageId,
      '*📝 Edit Cara Order*\nKirim teks baru (Markdown, max 2000 karakter):\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_identity') {
    const bcfg = await readJSON(env, 'BotConfig', {})
    const curNamaBot   = bcfg.NamaBot   || (env.NAMA_BOT   || '(default: Tehtarik Store)')
    const curStoreName = bcfg.StoreName || (env.STORE_NAME || env.NAMA_BOT || '(default: Tehtarik Store)')
    const curPrefix    = bcfg.orderBotName || '(pakai Nama Bot)'
    let cap = '*🏷️ IDENTITAS BOT*\n\n'
    cap += '│ 🤖 *Nama Bot* : `' + curNamaBot + '`\n'
    cap += '│ 🏪 *Nama Toko*: `' + curStoreName + '`\n'
    cap += '│ 🆔 *Prefix ID*: `' + curPrefix + '`\n\n'
    cap += '_Ubah nama dari sini tanpa perlu restart / redeploy._\n'
    cap += '_Prioritas: nilai di sini > env var > default._'
    await tgEditMessageText(env, chatId, messageId, cap,
      {
        inline_keyboard: [
          [{ text: '🤖 Ganti Nama Bot',   callback_data: 'adm_set_namabot' }],
          [{ text: '🏪 Ganti Nama Toko',  callback_data: 'adm_set_storename' }],
          [{ text: '🆔 Prefix ID Order',  callback_data: 'adm_set_botname' }],
          [{ text: '♻️ Reset ke Env',      callback_data: 'adm_reset_identity' }],
          [{ text: '🔙 Kembali',           callback_data: 'adm_settings' }]
        ]
      }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_namabot') {
    const bcfg = await readJSON(env, 'BotConfig', {})
    const cur = bcfg.NamaBot || env.NAMA_BOT || '(default)'
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_namabot' })
    await tgEditMessageText(env, chatId, messageId,
      '*🤖 Ganti Nama Bot*\nSaat ini: `' + cur + '`\n\nKirim nama baru (max 40 karakter).\nContoh: `RAMZ STORE BOT`, `Warung Andi`.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_identity' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_storename') {
    const bcfg = await readJSON(env, 'BotConfig', {})
    const cur = bcfg.StoreName || env.STORE_NAME || env.NAMA_BOT || '(default)'
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_storename' })
    await tgEditMessageText(env, chatId, messageId,
      '*🏪 Ganti Nama Toko*\nSaat ini: `' + cur + '`\n\nKirim nama toko baru (max 40 karakter).\nContoh: `RAMZ STORE`, `Toko Andi`.\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_identity' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_reset_identity') {
    const cfg = await readJSON(env, 'BotConfig', {})
    delete cfg.NamaBot
    delete cfg.StoreName
    delete cfg.orderBotName
    await writeJSON(env, 'BotConfig', cfg)
    await tgEditMessageText(env, chatId, messageId,
      '✅ *Identitas bot direset*\nNama bot & toko sekarang mengikuti env `NAMA_BOT` / `STORE_NAME`.',
      { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_identity' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_botname') {
    const bcfg = await readJSON(env, 'BotConfig', {})
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_botname' })
    await tgEditMessageText(env, chatId, messageId,
      '*🆔 Prefix ID Order*\nSaat ini: *' + (bcfg.orderBotName || 'Belum diset') + '*\nKirim prefix baru (huruf/angka, 2–4 karakter):\n\n_Contoh ID: `' + (bcfg.orderBotName || 'BOT') + '-241026-A1B2`_\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_identity' }]] }, 'Markdown'
    )
    return
  }
  // ─── v9update17: Voucher & Redeem ───
  if (data === 'adm_voucher') {
    await deleteKey(env, 'adminState_' + fromId)
    const vouchers = await readJSON(env, 'Voucher', {})
    const batches = await readJSON(env, 'VoucherBatch', {})
    let active = 0, used = 0
    for (const k in vouchers) {
      const v = vouchers[k]
      if (v.status === 'used') used++
      else if (v.status === 'active' && (!v.expiresAt || Date.now() <= v.expiresAt)) active++
    }
    const batchCount = Object.keys(batches).length
    let cap = '*🎫 VOUCHER & REDEEM*\n\n'
    cap += '╭───────────────────────╮\n'
    cap += '│ 🟢 Kode aktif  : *' + active + '*\n'
    cap += '│ ✅ Terpakai    : *' + used + '*\n'
    cap += '│ 📦 Total batch : *' + batchCount + '*\n'
    cap += '╰───────────────────────╯'
    await tgEditMessageText(env, chatId, messageId, cap, {
      inline_keyboard: [
        [{ text: '➕ Generate Kode Baru', callback_data: 'adm_voucher_gen' }],
        [{ text: '📋 Daftar Batch', callback_data: 'adm_voucher_list' }],
        [{ text: '📊 Statistik', callback_data: 'adm_voucher_stat' }],
        [{ text: '🔙 Kembali', callback_data: 'adm_panel' }]
      ]
    }, 'Markdown')
    return
  }

  if (data === 'adm_voucher_gen') {
    const { NamaBot: nb } = await import('./config.js')
    const defaultPrefix = voucherGetDefaultPrefix(nb)
    await writeJSON(env, 'adminState_' + fromId, { action: 'voucher_prefix', defaultPrefix })
    await tgEditMessageText(env, chatId, messageId,
      '*🏷️ STEP 1/4 — Prefix Kode*\n\nKetik prefix 2-5 huruf/angka (A-Z, 0-9).\nDefault dari Nama Bot: `' + defaultPrefix + '`\n\nContoh: `RMZ`, `TOKO`, `GIFT`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [
        [{ text: '✅ Pakai Default (' + defaultPrefix + ')', callback_data: 'adm_voucher_prefix_def' }],
        [{ text: '🔙 Batal', callback_data: 'adm_voucher' }]
      ] }, 'Markdown')
    return
  }

  if (data === 'adm_voucher_prefix_def') {
    const state1 = await readJSON(env, 'adminState_' + fromId, {})
    const prefix = state1.defaultPrefix || voucherGetDefaultPrefix('')
    await writeJSON(env, 'adminState_' + fromId, { action: 'voucher_nominal', prefix })
    await tgEditMessageText(env, chatId, messageId,
      '*💰 STEP 2/4 — Nominal Bonus*\nPrefix terpilih: `' + prefix + '`\n\nKetik nominal saldo bonus per kode (min Rp 100, max Rp 1.000.000).\n\nContoh: `5000`, `10000`, `50000`\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_voucher' }]] }, 'Markdown')
    return
  }

  if (data === 'adm_voucher_exp_none') {
    const state2 = await readJSON(env, 'adminState_' + fromId, {})
    if (state2.action !== 'voucher_expiry') return
    state2.expiryMs = 0
    state2.expiryLabel = 'Tanpa Expired'
    state2.action = 'voucher_review'
    await writeJSON(env, 'adminState_' + fromId, state2)
    const totalNilai = state2.amount * state2.count
    let rev = '*⚠️ KONFIRMASI GENERATE*\n\n'
    rev += '🏷️ Prefix     : `' + state2.prefix + '`\n'
    rev += '💰 Bonus/kode : ' + ParseIdr(state2.amount) + '\n'
    rev += '🔢 Jumlah     : *' + state2.count + '* kode\n'
    rev += '⏰ Expired    : Tanpa Expired\n'
    rev += '💵 Total nilai: *' + ParseIdr(totalNilai) + '*'
    await tgEditMessageText(env, chatId, messageId, rev, {
      inline_keyboard: [
        [{ text: '✅ Ya, Generate!', callback_data: 'adm_voucher_confirm' }],
        [{ text: '❌ Batal', callback_data: 'adm_voucher' }]
      ]
    }, 'Markdown')
    return
  }

  if (data === 'adm_voucher_confirm') {
    const state3 = await readJSON(env, 'adminState_' + fromId, {})
    if (state3.action !== 'voucher_review') {
      await tgEditMessageText(env, chatId, messageId, '⚠️ Sesi generate expired. Mulai ulang.', {
        inline_keyboard: [[{ text: '🔙 Ke Voucher', callback_data: 'adm_voucher' }]]
      }, 'Markdown')
      return
    }
    await tgEditMessageText(env, chatId, messageId, '⏳ Generating ' + state3.count + ' kode...', null, 'Markdown')
    const vouchers = await readJSON(env, 'Voucher', {})
    const codes = []
    const now = Date.now()
    const expiresAt = state3.expiryMs > 0 ? now + state3.expiryMs : 0
    const batchId = 'batch_' + now
    let attempts = 0
    while (codes.length < state3.count && attempts < state3.count * 5) {
      attempts++
      const c = voucherRandomCode(state3.prefix)
      if (vouchers[c]) continue
      vouchers[c] = {
        code: c, amount: state3.amount, batchId,
        createdAt: now, createdBy: fromId,
        expiresAt, usedBy: null, usedAt: null, status: 'active'
      }
      codes.push(c)
    }
    await writeJSON(env, 'Voucher', vouchers)
    const batches = await readJSON(env, 'VoucherBatch', {})
    batches[batchId] = {
      batchId, prefix: state3.prefix, amount: state3.amount,
      total: codes.length, used: 0, expiresAt,
      createdAt: now, createdBy: fromId, codes,
      expiryLabel: state3.expiryLabel,
      broadcasted: false, broadcastAt: null, broadcastSent: 0, revoked: false
    }
    await writeJSON(env, 'VoucherBatch', batches)
    await deleteKey(env, 'adminState_' + fromId)
    const txt = await voucherBuildTxt(env, batches[batchId], codes)
    let cap = '*✅ ' + codes.length + ' KODE BERHASIL DIBUAT*\n\n'
    cap += '📄 Batch: `' + batchId + '`\n'
    cap += '🏷️ Prefix: `' + state3.prefix + '`\n'
    cap += '💰 Bonus: ' + ParseIdr(state3.amount) + '/kode\n'
    cap += '⏰ Expired: ' + state3.expiryLabel + '\n'
    cap += '💵 Total nilai: *' + ParseIdr(state3.amount * codes.length) + '*'
    await tgSendDocument(env, chatId, txt, 'voucher_' + batchId + '.txt', cap, {
      inline_keyboard: [
        [{ text: '📢 Broadcast Kode ke User', callback_data: 'adm_voucher_bc_' + batchId }],
        [{ text: '📋 Ke Daftar Batch', callback_data: 'adm_voucher_list' }],
        [{ text: '🎫 Ke Menu Voucher', callback_data: 'adm_voucher' }]
      ]
    })
    try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
    return
  }

  if (data === 'adm_voucher_list') {
    const batches = await readJSON(env, 'VoucherBatch', {})
    const ids = Object.keys(batches).sort((a, b) => (batches[b].createdAt || 0) - (batches[a].createdAt || 0))
    if (ids.length === 0) {
      await tgEditMessageText(env, chatId, messageId,
        '📋 *DAFTAR BATCH*\n\n_Belum ada batch voucher._\nGenerate dulu di menu utama.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_voucher' }]] }, 'Markdown')
      return
    }
    let cap = '*📋 DAFTAR BATCH VOUCHER*\n\n'
    const rows = []
    const now = Date.now()
    ids.slice(0, 20).forEach(id => {
      const b = batches[id]
      let icon = '🟢'
      if (b.revoked) icon = '🔴'
      else if (b.expiresAt && now > b.expiresAt) icon = '⚠️'
      else if (b.used >= b.total) icon = '⚪'
      const label = icon + ' ' + b.prefix + ' • ' + ParseIdr(b.amount) + ' • ' + b.used + '/' + b.total
      rows.push([{ text: label, callback_data: 'adm_voucher_batch_' + id }])
    })
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_voucher' }])
    if (ids.length > 20) cap += '_Menampilkan 20 batch terbaru dari ' + ids.length + '._\n\n'
    cap += '🟢 aktif  ⚪ habis  ⚠️ expired  🔴 revoked'
    await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: rows }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_batch_')) {
    const bid = data.replace('adm_voucher_batch_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (!b) {
      await tgEditMessageText(env, chatId, messageId, '⚠️ Batch tidak ditemukan.', {
        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_voucher_list' }]]
      }, 'Markdown')
      return
    }
    const now = Date.now()
    const isExpired = b.expiresAt && now > b.expiresAt
    const sisa = b.total - (b.used || 0)
    let status = '🟢 Aktif'
    if (b.revoked) status = '🔴 Revoked'
    else if (isExpired) status = '⚠️ Expired'
    else if (sisa === 0) status = '⚪ Habis'
    let cap = '*📄 DETAIL BATCH*\n\n'
    cap += '🆔 ID       : `' + bid + '`\n'
    cap += '🏷️ Prefix   : `' + b.prefix + '`\n'
    cap += '📅 Dibuat   : ' + formatWIB(new Date(b.createdAt).toISOString()) + '\n'
    cap += '💰 Bonus    : ' + ParseIdr(b.amount) + '/kode\n'
    cap += '🔢 Total    : *' + b.total + '* kode\n'
    cap += '✅ Terpakai : *' + (b.used || 0) + '* kode\n'
    cap += '📦 Sisa     : *' + sisa + '* kode\n'
    cap += '⏰ Expired  : ' + (b.expiresAt ? formatWIB(new Date(b.expiresAt).toISOString()) : 'Tanpa expired') + '\n'
    cap += '📢 Broadcast: ' + (b.broadcasted ? '✅ (' + (b.broadcastSent || 0) + ' user)' : '❌ Belum') + '\n'
    cap += '🔹 Status   : ' + status
    const rows = []
    rows.push([{ text: '📄 Download File Kode', callback_data: 'adm_voucher_dl_' + bid }])
    if (!b.revoked && !isExpired && sisa > 0) {
      rows.push([{ text: (b.broadcasted ? '📢 Broadcast Ulang' : '📢 Broadcast Kode'), callback_data: 'adm_voucher_bc_' + bid }])
      rows.push([{ text: '❌ Revoke Sisa Kode', callback_data: 'adm_voucher_rev_' + bid }])
    }
    rows.push([{ text: '🗑️ Hapus Batch', callback_data: 'adm_voucher_del_' + bid }])
    rows.push([{ text: '🔙 Kembali', callback_data: 'adm_voucher_list' }])
    await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: rows }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_dl_')) {
    const bid = data.replace('adm_voucher_dl_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (!b) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Batch tidak ditemukan', true); return }
    const vouchers = await readJSON(env, 'Voucher', {})
    const activeCodes = (b.codes || []).filter(c => vouchers[c] && vouchers[c].status === 'active')
    const txt = await voucherBuildTxt(env, b, b.codes || [])
    const cap = '📄 Batch: `' + bid + '`\n' + b.total + ' kode total, ' + activeCodes.length + ' masih aktif'
    await tgSendDocument(env, chatId, txt, 'voucher_' + bid + '.txt', cap)
    return
  }

  if (data.startsWith('adm_voucher_bc_ok_')) {
    const bid = data.replace('adm_voucher_bc_ok_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (!b) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Batch tidak ditemukan', true); return }
    const vouchers = await readJSON(env, 'Voucher', {})
    const users = await readJSON(env, 'UserList', [])
    const available = (b.codes || []).filter(c => vouchers[c] && vouchers[c].status === 'active')
    if (available.length === 0) {
      await tgEditMessageText(env, chatId, messageId, '⚠️ Tidak ada kode aktif untuk di-broadcast.', {
        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_voucher_batch_' + bid }]]
      }, 'Markdown')
      return
    }
    await tgEditMessageText(env, chatId, messageId, '⏳ Broadcasting ke ' + users.length + ' user...', null, 'Markdown')
    const expStr = b.expiresAt ? formatWIB(new Date(b.expiresAt).toISOString()) : 'Tanpa expired'
    
    // Build FCFS broadcast text
    let bcText = '🎁 *PROMO VOUCHER SPESIAL!* (Siapa Cepat Dia Dapat)\n\n'
    bcText += '💰 Bonus: *' + ParseIdr(b.amount) + '* per kode\n'
    bcText += '⏰ Berlaku sampai: ' + expStr + '\n\n'
    bcText += '🎟️ *Daftar Kode Voucher:* (Salin kode untuk redeem)\n'
    let codesList = ''
    for (const c of available) {
      const line = '• `' + c + '`\n'
      if (bcText.length + codesList.length + line.length + 50 > 4096) {
        codesList += '... dan beberapa kode lainnya\n'
        break
      }
      codesList += line
    }
    bcText += codesList
    bcText += '\nCara tukar:\n`/redeem <KODE>`'

    // Q1: BC resumable — state BcState_vou_<bid>, cron lanjutkan bila terpotong.
    const uids = users.map(u => u.chatId).filter(id => Number(id) > 0)
    const bcRes = await bcStart(env, 'vou_' + bid, uids, { text: bcText, mode: 'Markdown', banner: null })
    if (bcRes.reason === 'running') {
      await tgSendMessage(env, chatId, '⏳ *Broadcast batch ini sedang jalan* (' + bcRes.sent + '/' + bcRes.total + '). Tunggu selesai — cron otomatis melanjutkan.', {
        inline_keyboard: [
          [{ text: '📄 Detail Batch', callback_data: 'adm_voucher_batch_' + bid }],
          [{ text: '🎫 Menu Voucher', callback_data: 'adm_voucher' }]
        ]
      }, 'Markdown')
      return
    }
    let resCap = (bcRes.done ? '*✅ BROADCAST SELESAI*' : '*⏳ BROADCAST DIMULAI*') + '\n\n'
    resCap += 'Terkirim : *' + bcRes.sent + '* user\n'
    resCap += 'Gagal    : ' + (bcRes.fail || 0) + ' user\n'
    if (!bcRes.done) resCap += '\nSisa otomatis dilanjutkan cron tiap menit.'
    await tgSendMessage(env, chatId, resCap, {
      inline_keyboard: [
        [{ text: '📄 Detail Batch', callback_data: 'adm_voucher_batch_' + bid }],
        [{ text: '🎫 Menu Voucher', callback_data: 'adm_voucher' }]
      ]
    }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_bc_')) {
    const bid = data.replace('adm_voucher_bc_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (!b) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Batch tidak ditemukan', true); return }
    const vouchers = await readJSON(env, 'Voucher', {})
    const users = await readJSON(env, 'UserList', [])
    const available = (b.codes || []).filter(c => vouchers[c] && vouchers[c].status === 'active')
    let cap = '*⚠️ KONFIRMASI BROADCAST*\n\n'
    cap += 'Batch     : `' + bid + '`\n'
    cap += 'Kode siap : *' + available.length + '* kode\n'
    cap += 'User aktif: *' + users.length + '* user\n\n'
    if (available.length === 0) {
      cap += '❌ Tidak ada kode aktif.'
      await tgEditMessageText(env, chatId, messageId, cap, {
        inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_voucher_batch_' + bid }]]
      }, 'Markdown')
      return
    }
    cap += 'Sistem: *Siapa Cepat Dia Dapat (FCFS)*\n'
    cap += 'Semua *' + available.length + '* kode voucher aktif akan dikirimkan ke semua *' + users.length + '* user.'
    cap += '\n\n_Broadcast tidak bisa dibatalkan setelah mulai._'
    await tgEditMessageText(env, chatId, messageId, cap, {
      inline_keyboard: [
        [{ text: '✅ Ya, Kirim Sekarang', callback_data: 'adm_voucher_bc_ok_' + bid }],
        [{ text: '❌ Batal', callback_data: 'adm_voucher_batch_' + bid }]
      ]
    }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_del_ok_')) {
    const bid = data.replace('adm_voucher_del_ok_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (b) {
      const vouchers = await readJSON(env, 'Voucher', {})
      if (b.codes) {
        for (const c of b.codes) {
          delete vouchers[c]
        }
      }
      await writeJSON(env, 'Voucher', vouchers)
      delete batches[bid]
      await writeJSON(env, 'VoucherBatch', batches)
    }
    await tgSendMessage(env, chatId, '✅ Batch `' + bid + '` dan semua kodenya berhasil dihapus.', {
      inline_keyboard: [
        [{ text: '🎫 Ke Menu Voucher', callback_data: 'adm_voucher' }]
      ]
    })
    
    // Redirect to batch list
    const ids = Object.keys(batches).sort((a, b) => (batches[b].createdAt || 0) - (batches[a].createdAt || 0))
    if (ids.length === 0) {
      await tgEditMessageText(env, chatId, messageId,
        '📋 *DAFTAR BATCH*\n\n_Belum ada batch voucher._\nGenerate dulu di menu utama.',
        { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_voucher' }]] }, 'Markdown')
      return
    }
    let cap = '*📋 DAFTAR BATCH VOUCHER*\n\n'
    const listRows = []
    const now = Date.now()
    ids.slice(0, 20).forEach(id => {
      const batchItem = batches[id]
      let icon = '🟢'
      if (batchItem.revoked) icon = '🔴'
      else if (batchItem.expiresAt && now > batchItem.expiresAt) icon = '⚠️'
      else if (batchItem.used >= batchItem.total) icon = '⚪'
      const label = icon + ' ' + batchItem.prefix + ' • ' + ParseIdr(batchItem.amount) + ' • ' + batchItem.used + '/' + batchItem.total
      listRows.push([{ text: label, callback_data: 'adm_voucher_batch_' + id }])
    })
    listRows.push([{ text: '🔙 Kembali', callback_data: 'adm_voucher' }])
    await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: listRows }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_del_')) {
    const bid = data.replace('adm_voucher_del_', '')
    let cap = '⚠️ *KONFIRMASI HAPUS BATCH*\n\n'
    cap += 'Apakah Anda yakin ingin menghapus Batch `' + bid + '`?\n'
    cap += 'Tindakan ini akan menghapus batch beserta semua kodenya secara permanen dari database.'
    await tgEditMessageText(env, chatId, messageId, cap, {
      inline_keyboard: [
        [{ text: '🗑️ Ya, Hapus Permanen!', callback_data: 'adm_voucher_del_ok_' + bid }],
        [{ text: '❌ Batal', callback_data: 'adm_voucher_batch_' + bid }]
      ]
    }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_rev_ok_')) {
    const bid = data.replace('adm_voucher_rev_ok_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (!b) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Batch tidak ditemukan', true); return }
    const vouchers = await readJSON(env, 'Voucher', {})
    let revoked = 0
    for (const c of (b.codes || [])) {
      if (vouchers[c] && vouchers[c].status === 'active') {
        vouchers[c].status = 'revoked'
        revoked++
      }
    }
    await writeJSON(env, 'Voucher', vouchers)
    b.revoked = true
    batches[bid] = b
    await writeJSON(env, 'VoucherBatch', batches)
    await tgEditMessageText(env, chatId, messageId,
      '*✅ REVOKE SELESAI*\n\n' + revoked + ' kode sisa di-revoke.\nKode yang sudah dipakai tidak terpengaruh.',
      { inline_keyboard: [[{ text: '🔙 Ke Detail Batch', callback_data: 'adm_voucher_batch_' + bid }]] }, 'Markdown')
    return
  }

  if (data.startsWith('adm_voucher_rev_')) {
    const bid = data.replace('adm_voucher_rev_', '')
    const batches = await readJSON(env, 'VoucherBatch', {})
    const b = batches[bid]
    if (!b) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Batch tidak ditemukan', true); return }
    const vouchers = await readJSON(env, 'Voucher', {})
    const active = (b.codes || []).filter(c => vouchers[c] && vouchers[c].status === 'active').length
    await tgEditMessageText(env, chatId, messageId,
      '*⚠️ KONFIRMASI REVOKE*\n\nBatch: `' + bid + '`\nKode aktif yang akan di-revoke: *' + active + '*\n\n_Kode yang sudah dipakai TIDAK terpengaruh (saldo user tetap aman)._\n\nLanjutkan?',
      { inline_keyboard: [
        [{ text: '✅ Ya, Revoke', callback_data: 'adm_voucher_rev_ok_' + bid }],
        [{ text: '❌ Batal', callback_data: 'adm_voucher_batch_' + bid }]
      ] }, 'Markdown')
    return
  }

  if (data === 'adm_voucher_stat') {
    const vouchers = await readJSON(env, 'Voucher', {})
    const batches = await readJSON(env, 'VoucherBatch', {})
    const audit = await readJSON(env, 'VoucherAudit', [])
    let active = 0, used = 0, expired = 0, revoked = 0, totalNominalUsed = 0
    const now = Date.now()
    for (const k in vouchers) {
      const v = vouchers[k]
      if (v.status === 'used') { used++; totalNominalUsed += (v.amount || 0) }
      else if (v.status === 'revoked') revoked++
      else if (v.expiresAt && now > v.expiresAt) expired++
      else active++
    }
    let cap = '*📊 STATISTIK VOUCHER*\n\n'
    cap += '🟢 Aktif        : *' + active + '*\n'
    cap += '✅ Terpakai     : *' + used + '*\n'
    cap += '⚠️ Expired      : ' + expired + '\n'
    cap += '🔴 Revoked      : ' + revoked + '\n'
    cap += '📦 Total batch  : ' + Object.keys(batches).length + '\n'
    cap += '💵 Total saldo terpakai: *' + ParseIdr(totalNominalUsed) + '*\n'
    cap += '📜 Audit entries: ' + audit.length + '\n\n'
    if (audit.length > 0) {
      cap += '_Redeem terakhir:_\n'
      audit.slice(0, 3).forEach(a => {
        cap += '• ' + formatWIB(new Date(a.at).toISOString()) + ' — user `' + a.userId + '` +' + ParseIdr(a.amount) + '\n'
      })
    }
    await tgEditMessageText(env, chatId, messageId, cap, {
      inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'adm_voucher' }]]
    }, 'Markdown')
    return
  }

  if (data === 'adm_set_banner_start') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_banner_start' })
    await tgEditMessageText(env, chatId, messageId,
      '*🖼️ Banner Start (Base64)*\nKirim string base64 gambar.\nCara convert: base64.guru/converter/encode/image\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }
  if (data === 'adm_set_banner_list') {
    await writeJSON(env, 'adminState_' + fromId, { action: 'settings_banner_list' })
    await tgEditMessageText(env, chatId, messageId,
      '*🖼️ Banner List Produk (Base64)*\nKirim string base64 gambar untuk banner List Produk:\n\n_Ketik /batal jika tidak jadi._',
      { inline_keyboard: [[{ text: '🔙 Batal', callback_data: 'adm_settings' }]] }, 'Markdown'
    )
    return
  }

  try { await tgAnswerCallbackQuery(env, cqId) } catch (e) {}
}


// ─── Helper: Database Menu (switch lokal ⇄ Turso) ─────────────────────
async function showDbMenu(env, chatId, messageId) {
  const { getDbInfo, dbCount } = await import('./db.js')
  const info = await getDbInfo(env)
  const cfg = await readJSON(env, 'BotConfig', {})
  const b = (cfg && cfg.db) || {}
  const isTurso = info.backend === 'turso'
  const want = (b.mode === 'turso') ? 'turso' : 'kv'
  let kvN = -1, tN = -1
  try { kvN = await dbCount(env, 'kv') } catch {}
  try { tN = await dbCount(env, 'turso') } catch {}
  const urlTxt = b.url ? '`' + String(b.url).slice(0, 42) + '`' : '_(belum diset)_'
  const tokTxt = b.token ? '✅ Terisi' : (env.TURSO_TOKEN ? '✅ via ENV' : '❌ Kosong')
  let cap = '*💾 KELOLA DATABASE*\n'
  cap += 'Aktif     : *' + (isTurso ? '🗄️ Turso' : '💾 Lokal/KV') + '*\n'
  cap += 'Mode set  : ' + (want === 'turso' ? 'Turso' : 'Lokal/KV')
  if (info.degraded) cap += '  ⚠️ _fallback KV (Turso gagal)_'
  cap += '\n'
  cap += 'Key lokal : ' + (kvN >= 0 ? kvN : '?') + '  |  Key Turso: ' + (tN >= 0 ? tN : '?') + '\n'
  cap += 'URL       : ' + urlTxt + '\n'
  cap += 'Token     : ' + tokTxt + (info.credSource ? ' (' + info.credSource + ')' : '') + '\n'
  if (info.dbError) cap += '⚠️ _' + String(info.dbError).slice(0, 90) + '_\n'
  cap += '\n_Pilih backend, lalu migrasi agar data ikut pindah._'
  const kb = { inline_keyboard: [
    [{ text: (!isTurso ? '✅ ' : '') + '💾 Lokal/KV', callback_data: 'adm_db_mode_kv' },
     { text: (isTurso ? '✅ ' : '') + '🗄️ Turso', callback_data: 'adm_db_mode_turso' }],
    [{ text: '🔗 Set URL', callback_data: 'adm_db_url' }, { text: '🔑 Set Token', callback_data: 'adm_db_token' }],
    [{ text: '🧪 Test Koneksi', callback_data: 'adm_db_test' }],
    [{ text: '⬆️ Migrasi → Turso', callback_data: 'adm_db_mig_up' }],
    [{ text: '⬇️ Migrasi → Lokal', callback_data: 'adm_db_mig_down' }],
    [{ text: '📤 Backup (Download)', callback_data: 'adm_backup_db' }],
    [{ text: '💾 Restore (JSON)', callback_data: 'adm_load_db' }],
    [{ text: '🔙 Kembali', callback_data: 'adm_settings' }]
  ] }
  await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
}

// ─── Helper: Pakasir Menu ─────────────────────────────────────────────
async function showPakasirMenu(env, chatId, messageId) {
  const pay = await getPayCfg(env); const gw = pay.gateways.pakasir
  const isActive = (pay.active === 'pakasir')
  const onOff = gw.enabled ? '🟢 AKTIF' : '⚪ NONAKTIF'
  const slugTxt = gw.slug ? '`' + gw.slug + '`' : '_(belum diset)_'
  const keyTxt  = gw.apiKey ? '••••• (' + gw.apiKey.slice(-4) + ')' : '_(belum diset)_'
  const feeTxt  = feeLabel(gw)
  const activeBadge = isActive ? '  ⭐ (active gateway)' : ''
  let cap = '*💳 PAKASIR GATEWAY*' + activeBadge + '\n'
  cap += '┊ Status  : ' + onOff + '\n'
  cap += '┊ Mode    : *' + (gw.mode||'sandbox').toUpperCase() + '*\n'
  cap += '┊ Slug    : ' + slugTxt + '\n'
  cap += '┊ API Key : ' + keyTxt + '\n'
  cap += '┊ Metode  : *' + methodLabel(gw.method) + '*\n'
  cap += '┊ Fee     : *' + feeTxt + '*\n'
  cap += '\nAtur konfigurasi di bawah:'
  const kb = { inline_keyboard: [
    [{ text: (gw.enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan'), callback_data: 'adm_pay_pk_toggle' }],
    [{ text: '🔄 Mode: ' + (gw.mode||'sandbox').toUpperCase(), callback_data: 'adm_pay_pk_mode' }],
    [{ text: '🔑 Set Slug', callback_data: 'adm_pay_pk_slug' }, { text: '🔐 Set API Key', callback_data: 'adm_pay_pk_apikey' }],
    [{ text: '💳 Metode: ' + methodLabel(gw.method), callback_data: 'adm_pay_pk_method' }],
    [{ text: '💰 Fee Transaksi', callback_data: 'adm_pay_pk_fee' }],
    [{ text: '🧪 Test Koneksi', callback_data: 'adm_pay_pk_test' }],
    [{ text: (isActive ? '⭐ Sudah Active' : '✅ Jadikan Active Gateway'), callback_data: 'adm_pay_pk_activate' }],
    [{ text: '🔙 Kembali', callback_data: 'adm_payment' }]
  ] }
  await tgEditMessageText(env, chatId, messageId, cap, kb, 'Markdown')
}

// ─── Helper: Duitku Menu (QRIS-only) ────────────────────────
async function showDuitkuMenu(env, chatId, messageId) {
  const pay = await getPayCfg(env); const gw = pay.gateways.duitku
  const isActive = (pay.active === 'duitku')
  const status = gw.enabled ? '🟢 Aktif' : '⚪ Nonaktif'
  const mode = (gw.mode || 'sandbox').toUpperCase()
  const merch = gw.merchantCode ? gw.merchantCode : '(belum di-set)'
  const apiSet = gw.apiKey ? '✅ Terisi' : '❌ Kosong'
  const prov = providerLabel(gw.qrisProvider)
  const feeTxt = feeLabel(gw)
  const exp = Number(gw.expiryPeriod || 30) + ' menit'
  const verifyIp = gw.verifyIp ? 'ON' : 'OFF'
  const activeBadge = isActive ? '  ⭐ (active gateway)' : ''
  let cap = '*🅳 DUITKU — QRIS Payment*' + activeBadge + '\n\n'
  cap += 'Status         : ' + status + '\n'
  cap += 'Mode           : ' + mode + '\n'
  cap += 'Merchant Code  : `' + merch + '`\n'
  cap += 'API Key        : ' + apiSet + '\n'
  cap += 'QRIS Provider  : *' + prov + '*\n'
  cap += 'Fee (Duitku)   : *' + feeTxt + '*  _(independen)_\n'
  cap += 'Expiry         : ' + exp + '\n'
  cap += 'Verify IP      : ' + verifyIp + '\n'
  const rows = [
    [{ text: (gw.enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan'), callback_data: 'adm_pay_dk_toggle' }],
    [{ text: '🔄 Mode: ' + mode, callback_data: 'adm_pay_dk_mode' }],
    [{ text: '🔑 Merchant Code', callback_data: 'adm_pay_dk_merch' }, { text: '🔐 API Key', callback_data: 'adm_pay_dk_apikey' }],
    [{ text: '🔲 QRIS Provider (' + (gw.qrisProvider || 'SP') + ')', callback_data: 'adm_pay_dk_qris' }],
    [{ text: '💰 Fee Duitku (' + feeTxt + ')', callback_data: 'adm_pay_dk_fee' }, { text: '⏱️ Expiry (' + exp + ')', callback_data: 'adm_pay_dk_expiry' }],
    [{ text: '🛡️ Verify IP: ' + verifyIp, callback_data: 'adm_pay_dk_vipt' }],
    [{ text: '🧪 Test Koneksi', callback_data: 'adm_pay_dk_test' }],
    [{ text: (isActive ? '⭐ Sudah Active' : '✅ Jadikan Active Gateway'), callback_data: 'adm_pay_dk_activate' }],
    [{ text: '♻️ Reset Config', callback_data: 'adm_pay_dk_reset' }, { text: '🔙 Kembali', callback_data: 'adm_payment' }]
  ]
  await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: rows }, 'Markdown')
}

// ─── Helper: Saweria Menu (QRIS-only) ───────────────────────────────
async function showSaweriaMenu(env, chatId, messageId) {
  const pay = await getPayCfg(env); const gw = pay.gateways.saweria
  const isActive = (pay.active === 'saweria')
  const status = gw.enabled ? '🟢 Aktif' : '⚪ Nonaktif'
  const usernameTxt = gw.username ? '`' + gw.username + '`' : '(belum di-set)'
  const userIdTxt = gw.userId ? '`' + String(gw.userId).slice(0, 8) + '…`' : '(belum di-set)'
  const feeTxt = feeLabel(gw)
  const exp = Number(gw.expiryPeriod || 10) + ' menit'
  const activeBadge = isActive ? '  ⭐ (active gateway)' : ''
  let cap = '*🍧 SAWERIA — QRIS Payment*' + activeBadge + '\n\n'
  cap += 'Status         : ' + status + '\n'
  cap += 'Username       : ' + usernameTxt + '\n'
  cap += 'User ID        : ' + userIdTxt + '\n'
  cap += 'Fee (Saweria)  : *' + feeTxt + '*  _(independen)_\n'
  cap += 'Expiry         : ' + exp + '\n'
  cap += '\n_Ambil kredensial: saweria.co → Settings/API_'
  const rows = [
    [{ text: (gw.enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan'), callback_data: 'adm_pay_sw_toggle' }],
    [{ text: '🔑 Username', callback_data: 'adm_pay_sw_username' }, { text: '🆔 User ID', callback_data: 'adm_pay_sw_userid' }],
    [{ text: '🪄 Auto-Resolve User ID', callback_data: 'adm_pay_sw_autoid' }],
    [{ text: '💰 Fee Saweria (' + feeTxt + ')', callback_data: 'adm_pay_sw_fee' }, { text: '⏱️ Expiry (' + exp + ')', callback_data: 'adm_pay_sw_expiry' }],
    [{ text: '🧪 Test Koneksi', callback_data: 'adm_pay_sw_test' }],
    [{ text: (isActive ? '⭐ Sudah Active' : '✅ Jadikan Active Gateway'), callback_data: 'adm_pay_sw_activate' }],
    [{ text: '♻️ Reset Config', callback_data: 'adm_pay_sw_reset' }, { text: '🔙 Kembali', callback_data: 'adm_payment' }]
  ]
  await tgEditMessageText(env, chatId, messageId, cap, { inline_keyboard: rows }, 'Markdown')
}

export async function showAdminTicketCategory(env, chatId) {
  const tickets = await readJSON(env, 'Tickets', [])
  const openCount = tickets.filter(t => t.status === 'open' || t.status === 'answered').length
  const closedCount = tickets.filter(t => t.status === 'closed').length

  let cap = '╭───〔 🎫 DAFTAR TIKET BOT 〕───\n'
  cap += '┊ Pilih status tiket di bawah:\n'
  cap += '╰──────────────────\n'

  const kb = {
    inline_keyboard: [
      [{ text: '🔵 PROSES (' + openCount + ')', callback_data: 'tk_adm_cat_proses' }],
      [{ text: '🟢 SELESAI (' + closedCount + ')', callback_data: 'tk_adm_cat_selesai' }],
      [{ text: '❌ Tutup Menu', callback_data: 'adm_tutup' }]
    ]
  }
  await tgSendMessage(env, chatId, cap, kb, 'Markdown')
}

function escHtml(str) {
  if (!str && str !== 0) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── v9update18: render chat tiket shared (user 🙋 polos / admin 🎧 blockquote, tanpa nama akun admin) ───
export function ticketAge(t) {
  const last = (t.messages && t.messages.length) ? t.messages[t.messages.length - 1] : null
  const ref = (t.status === 'closed' && t.closedAt) ? t.closedAt : Date.now()
  const waitingAdmin = !!last && last.sender === 'user' && t.status !== 'closed'
  // waitingAdmin: hitung sejak pesan terakhir USER (createdAt), bukan lastActivityAt yang ke-reset tiap follow-up
  const firstUserPush = (t.messages || []).find(m => m.sender === 'user')
  const sinceUser = firstUserPush && firstUserPush.at ? Number(firstUserPush.at) : Date.parse(t.createdAt || '')
  const start = (waitingAdmin && sinceUser) ? sinceUser : (t.lastActivityAt || Date.parse(t.createdAt || '') || ref)
  const ms = Math.max(0, ref - start)
  const m = Math.floor(ms / 60000)
  const label = m < 60 ? m + 'm' : (Math.floor(m / 60) + 'j ' + (m % 60) + 'm')
  return { ms, label, waitingAdmin }
}

