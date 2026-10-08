import { providerPrefixes } from './constants.js'
import { readJSON } from './kv.js'


// Untuk Telegram Markdown V1 - escape _ * ` [ dengan backslash (valid di V1); teks biasa tampil identik.
function escapeMarkdown(text) {
  if (!text && text !== 0) return ''
  return String(text).replace(/([_*`\[\]])/g, '\\$1')
}

// Sanitasi nilai dinamis (nama produk/varian/user) agar tidak merusak Markdown V1
function mdSafe(text) {
  if (!text && text !== 0) return ''
  return String(text).replace(/[_*`\[\]]/g, '')
}

function ParseIdr(number) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(number)
}

function formatrupiah(nominal) {
  return new Intl.NumberFormat('id', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(nominal)
}

function formatWIB(isoString) {
  const date = new Date(isoString)
  const options = { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }
  const timeOptions = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }
  const formattedDate = new Intl.DateTimeFormat('id-ID', options).format(date)
  const formattedTime = new Intl.DateTimeFormat('id-ID', timeOptions).format(date)
  return formattedDate + ' ' + formattedTime + ' WIB'
}

function getDate(zone) {
  return new Date().toLocaleString('id-ID', { timeZone: zone || 'Asia/Jakarta' })
}

function getTanggalJam() {
  const now = new Date()
  const tanggal = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' })
  const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' })
  return { tanggal, jam }
}

function chunkArray(array, size) {
  const result = []
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size))
  return result
}

const sleep = async (ms) => new Promise(resolve => setTimeout(resolve, ms))

function loadingBar(percent) {
  const total = 12
  const filled = Math.max(0, Math.min(total, Math.round((percent / 100) * total)))
  return '▰'.repeat(filled) + '▱'.repeat(total - filled) + '  ' + percent + '%'
}

function toCRC16(str) {
  let crc = 0xFFFF
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)
    }
  }
  let hex = (crc & 0xFFFF).toString(16).toUpperCase()
  hex = hex.padStart(4, '0')
  return hex
}

function generateTrxId(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let trxId = ''
  for (let i = 0; i < length; i++) {
    trxId += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return 'NXB' + trxId
}

function generateTicketId(username, name) {
  let baseName = (username || name || 'User').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  if (!baseName) baseName = 'user'
  baseName = baseName.substring(0, 10)
  
  const d = new Date()
  // Waktu Jakarta
  const jakartaTime = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }))
  const dd = ('0' + jakartaTime.getDate()).slice(-2)
  const mm = ('0' + (jakartaTime.getMonth() + 1)).slice(-2)
  const yyyy = jakartaTime.getFullYear()
  const rand = Math.floor(1000 + Math.random() * 9000)
  
  return `${baseName}-${dd}-${mm}-${yyyy}-${rand}`
}

function generateKodeUnik() {
  return Math.floor(Math.random() * 999) + 1
}

function expiredTime(minutes = 5) {
  const mins = Number(minutes) > 0 ? Number(minutes) : 5
  const now = new Date()
  const expired = new Date(now.getTime() + mins * 60 * 1000)
  return expired.toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })
}

// Decode 'expired' WIB wall-clock (diproduksi expiredTime) -> Date.
// Pemilik tunggal regex + offset: tanpa offset, Workers (UTC) akan salah ~7 jam.
// Invalid/missing -> Invalid Date (NaN) — dipakai bersama try/catch pemanggil.
function parseExpiredWIB(expiredStr) {
  return new Date(String(expiredStr || '').replace(/(\d{2})\/(\d{2})\/(\d{4}), (\d{2}:\d{2}:\d{2})/, '$3-$2-$1T$4+07:00'))
}

function generateRandomPhone() {
  const providers = Object.keys(providerPrefixes)
  const provider = providers[Math.floor(Math.random() * providers.length)]
  const prefix = providerPrefixes[provider][Math.floor(Math.random() * providerPrefixes[provider].length)]
  const randomNum = Math.floor(1000000 + Math.random() * 9000000).toString()
  return prefix + randomNum
}

function generateRandomEmail() {
  const names = ['user', 'buyer', 'cust', 'member', 'shop']
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'mail.com']
  return names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 10000) + '@' + domains[Math.floor(Math.random() * domains.length)]
}

function generateRandomDonationMessage() {
  const words = ['Terima kasih', 'atas', 'donasi', 'Anda', 'Kami', 'sangat', 'menghargai', 'dukungan', 'anda', 'setiap', 'bantuan', 'berarti', 'untuk', 'kami', 'semoga', 'kebaikan', 'dibalas', 'berkah']
  const shuffled = words.sort(() => Math.random() - 0.5)
  return shuffled.slice(0, 5).join(' ')
}

// Header sans-serif bold kapital (Mathematical Alphanumeric Symbols, U+1D5D4+A).
// Full kapital saja — huruf kecil blok ini pecah di sebagian HP.
function sansBold(s) {
  const base = 0x1D5D4
  let out = ''
  for (const c of String(s || '')) {
    const n = c.charCodeAt(0)
    out += (n >= 65 && n <= 90) ? String.fromCodePoint(base + n - 65) : c
  }
  return out
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function boxFormat(title, lines) {
  let text = '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2727\n'
  text += '\u250a ' + title + '\n'
  text += '\u250a\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
  for (const line of lines) {
    text += '\u250a ' + line + '\n'
  }
  text += '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2727'
  return text
}

// --- generateOrderId: format PREFIX-DDMMYY-XXXX (WIB), anti-duplikat ---
// Pendek (14-17 char); cek unik sebelum dipakai via orderIdUnique()
// SATU JALUR ID: prefix selalu dibaca dari KV BotConfig (live, tanpa perlu restart)
async function getOrderPrefix(env) {
  try {
    const bcfg = await readJSON(env, 'BotConfig', {})
    const clean = String(bcfg.orderBotName || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
    if (clean) return clean
  } catch (e) {}
  return null
}
function generateOrderId(namaBot) {
  const clean = (namaBot || 'BOT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'BOT'
  const now = new Date()
  const wibMs = now.getTime() + (7 * 60 * 60 * 1000)
  const wib = new Date(wibMs)
  const dd = String(wib.getUTCDate()).padStart(2, '0')
  const mo = String(wib.getUTCMonth() + 1).padStart(2, '0')
  const yy = String(wib.getUTCFullYear()).slice(2)
  const rand = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')
  return clean + '-' + dd + mo + yy + '-' + rand
}

// Cek ID tidak bentrok dengan Trx maupun SessionDeposit lama (semua format)
async function orderIdUnique(env, id) {
  try {
    const trx = await readJSON(env, 'Trx', [])
    if (trx.some(t => t.trxid === id)) return false
  } catch (e) {}
  try {
    const ses = await readJSON(env, 'SessionDeposit', [])
    if (ses.some(s => s.id === id)) return false
  } catch (e) {}
  return true
}

// Buat ID unik (retry bila tabrakan, peluang sangat kecil)
async function generateUniqueOrderId(env, namaBot, tries = 5) {
  const prefix = await getOrderPrefix(env)
  for (let i = 0; i < tries; i++) {
    const id = generateOrderId(prefix || namaBot)
    if (await orderIdUnique(env, id)) return id
  }
  return generateOrderId(prefix || namaBot) + '-' + Math.floor(Math.random() * 900 + 100)
}


// Anti-banned batch send: 15/dtk, 429 tunggu retry_after PENUH, 5x beruntun stop.
// Sisa kembali ke pemanggil (rest[]) — lanjut tick berikutnya, bukan spam retry.
async function safeBatchSend(list, sendOne) {
  let sent = 0, failed = 0, streak429 = 0, stopped429 = false
  const done = new Set()
  for (let i = 0; i < list.length; i += 15) {
    const batch = list.slice(i, i + 15)
    const results = await Promise.allSettled(batch.map(async (uid) => {
      try {
        const r = await sendOne(uid)
        if (r && r.ok === false && r.error_code === 429) {
          const wait = Math.max(Number((r.parameters && r.parameters.retry_after) || 1), 1)
          await sleep(wait * 1000)
          const r2 = await sendOne(uid)
          if (r2 && r2.ok === false && r2.error_code === 429) throw new Error('429')
          if (r2 && !r2.ok) throw new Error('tg ' + r2.error_code)
          return true
        }
        if (r && r.ok === false) throw new Error('tg ' + r.error_code)
        return true
      } catch (e) { throw e }
    }))
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') { sent++; streak429 = 0; done.add(batch[j]) }
      else {
        done.add(batch[j])
        if (/^429/.test(String(results[j].reason && results[j].reason.message || ''))) {
          streak429++
          if (streak429 >= 5) { stopped429 = true; break }
        } else { failed++; streak429 = 0 }
      }
    }
    if (stopped429) break
    if (i + 15 < list.length) await sleep(1000)
  }
  return { sent, failed, stopped429, rest: list.filter(u => !done.has(u)) }
}

// Q2: varian cocok 3 format (produkId | 'c'+id | id) — data lama campur.
// Q2: stok layak jual — buang kadaluarsa (< hari ini WIB); null = tanpa expired.
// Q2: ID numerik berikut — abaikan id non-numerik (Math.max mentah = NaN).
function varianKat(produk, kat) {
  if (!Array.isArray(produk) || !kat) return []
  const pid = String((kat && kat.produkId) || '')
  const cid = String((kat && kat.id) || '')
  return produk.filter(p => {
    const c = String((p && p.category) || '')
    return c === pid || c === 'c' + cid || c === cid
  })
}
function stokLayakJual(list) {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
  if (!Array.isArray(list)) return []
  return list.filter(s => !s || !s.expired_at || String(s.expired_at) >= today)
}
function nextId(list) {
  let mx = 0
  if (Array.isArray(list)) for (const x of list) {
    const n = Number(x && x.id)
    if (Number.isFinite(n) && n > mx) mx = Math.floor(n)
  }
  return mx + 1
}

export {
  escapeMarkdown, mdSafe, ParseIdr, formatrupiah, formatWIB, getDate, getTanggalJam,
  chunkArray, sleep, toCRC16, generateTrxId, generateOrderId, generateKodeUnik, expiredTime, parseExpiredWIB,
  generateRandomPhone, generateRandomEmail, generateRandomDonationMessage, boxFormat, loadingBar, sansBold, escHtml,
  generateTicketId, orderIdUnique, generateUniqueOrderId, safeBatchSend,
  varianKat, stokLayakJual, nextId
}
