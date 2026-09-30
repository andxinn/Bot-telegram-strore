#!/usr/bin/env node

/**
 * STANDALONE DEV SERVER v14 - No Cloudflare needed!
 *
 * Jalankan: npm run dev  (hot-reload otomatis)
 * Sekali:   npm run dev:once
 *
 * Fitur:
 * - HTTP server lokal (port 8787)
 * - KV storage simulasi (file dev-db.json)
 * - Telegram long-polling (tidak perlu webhook publik)
 * - Cron simulasi otomatis (setiap 60 detik + 1 jam)
 * - Dev-only endpoints: /dev/kv, /dev/simulate-pakasir-webhook, /dev/simulate-duitku-webhook
 * - Persist polling offset (aman restart)
 * - Warning kalau BOT_TOKEN sama dengan production
 *
 * Ctrl+C untuk stop.
 * Last triggered watch restart: 2026-07-25T10:03:40
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.DEV_PORT || '8787')
const SNAP_DIR = path.join(__dirname, 'snapshots')
if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true })

// Offset polling Telegram disimpan di file lokal (bukan di KV) agar tidak
// ikut bocor ke migrasi/Turso. ponytail: JSON satu angka; pindah ke SQLite bila butuh histori.
const OFFSET_FILE = path.join(__dirname, 'dev-offset.json')
function loadOffset() {
  try {
    const n = Number(JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf-8')))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}
function saveOffset(v) {
  try { fs.writeFileSync(OFFSET_FILE, JSON.stringify(v)) } catch {}
}

// ─── Load env dari .dev.vars ────────────────────────────────────────────
const env = {}
const devVarsPath = path.join(__dirname, '.dev.vars')
if (fs.existsSync(devVarsPath)) {
  const content = fs.readFileSync(devVarsPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    env[key] = value
  }
} else {
  console.error('❌ File .dev.vars tidak ditemukan!')
  console.error('   Copy dari template: cp .dev.vars.example .dev.vars')
  process.exit(1)
}

// ─── Local KV storage (simulasi Cloudflare KV) ──────────────────────────
class LocalKV {
  constructor(filePath) {
    this.filePath = filePath
    this.data = {}
    this.load()
  }
  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
        console.log('📦 KV loaded: ' + Object.keys(this.data).length + ' keys')
      } catch (e) { this.data = {} }
    }
  }
  save() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2)) } catch (e) {}
  }
  async get(key) { return this.data[key] ?? null }
  async put(key, value) { this.data[key] = value; this.save() }
  async delete(key) { delete this.data[key]; this.save() }
  async list({ prefix = '' } = {}) {
    return { keys: Object.keys(this.data).filter(k => k.startsWith(prefix)).map(k => ({ name: k })) }
  }
}

env.DB = new LocalKV(path.join(__dirname, 'dev-db.json'))
const { initDb } = await import('./src/db.js')
await initDb(env)

// Force dev mode indicator
env.MODE = env.MODE || 'development'
env.DEV_MODE = 'true'

// ─── Import worker ──────────────────────────────────────────────────────
const worker = await import('./src/index.js')

// ─── Dev-only HTTP handlers ─────────────────────────────────────────────
async function handleDevRoute(req, res, url, body) {
  const p = url.pathname
  // GET /dev/kv         → list semua key (backend AKTIF: lokal atau Turso)
  if (p === '/dev/kv' && req.method === 'GET') {
    const { dbList, getDbInfo } = await import('./src/db.js')
    const keys = (await dbList(env, '')).sort()
    return json(res, 200, { ...(await getDbInfo(env)), count: keys.length, keys })
  }
  // GET /dev/kv/:key    → isi key (backend aktif, raw tanpa envelope)
  if (p.startsWith('/dev/kv/') && req.method === 'GET') {
    const key = decodeURIComponent(p.replace('/dev/kv/', ''))
    const { dbGetRaw } = await import('./src/db.js')
    const raw = await dbGetRaw(env, key)
    if (raw === null) return json(res, 404, { error: 'not_found', key })
    let value
    try { value = JSON.parse(raw) } catch { value = raw }
    return json(res, 200, { key, value })
  }
  // POST /dev/kv/:key   → set value (body = JSON apa saja)
  if (p.startsWith('/dev/kv/') && req.method === 'POST') {
    const key = decodeURIComponent(p.replace('/dev/kv/', ''))
    let val
    try { val = JSON.parse(body || 'null') } catch { return json(res, 400, { error: 'invalid_json' }) }
    const raw = typeof val === 'string' ? val : JSON.stringify(val)
    const { dbPutRaw } = await import('./src/db.js')
    await dbPutRaw(env, key, raw)
    return json(res, 200, { ok: true, key })
  }
  // DELETE /dev/kv/:key → hapus key
  if (p.startsWith('/dev/kv/') && req.method === 'DELETE') {
    const key = decodeURIComponent(p.replace('/dev/kv/', ''))
    const { dbDelete } = await import('./src/db.js')
    await dbDelete(env, key)
    return json(res, 200, { ok: true, key })
  }
  // POST /dev/simulate-pakasir-webhook  → kirim payload webhook palsu ke /pakasir-webhook
  if (p === '/dev/simulate-pakasir-webhook' && req.method === 'POST') {
    let payload
    try { payload = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'invalid_json' }) }
    // Cari session pending terakhir kalau tidak dikirim order_id
    if (!payload.order_id) {
      const { readJSON: readJ1 } = await import('./src/kv.js')
      const sessions = await readJ1(env, 'SessionDeposit', [])
      const pending = sessions.filter(s => s.status === 'pending' && s.depositDetails?.provider === 'pakasir').pop()
      if (!pending) return json(res, 400, { error: 'no_pending_pakasir_session' })
      payload.order_id = pending.id
      payload.amount = pending.depositDetails.pakasir_amount
      payload.project = pending.depositDetails.pakasir_gw?.slug || 'dev'
    }
    payload.status = payload.status || 'completed'
    payload.payment_method = payload.payment_method || 'qris'
    payload.completed_at = payload.completed_at || new Date().toISOString()
    const whReq = new Request('http://localhost:' + PORT + '/pakasir-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const ctx = { waitUntil: (pr) => pr.catch(e => console.error('waitUntil:', e.message)) }
    const wr = await worker.default.fetch(whReq, env, ctx)
    const wtxt = await wr.text()
    return json(res, wr.status, { simulated_payload: payload, worker_response: safeJson(wtxt) })
  }
  // POST /dev/simulate-duitku-webhook  → kirim payload webhook palsu ke /duitku-webhook (x-www-form-urlencoded)
  if (p === '/dev/simulate-duitku-webhook' && req.method === 'POST') {
    let payload
    try { payload = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'invalid_json' }) }
    if (!payload.merchantOrderId) {
      const { readJSON: readJ2 } = await import('./src/kv.js')
      const sessions = await readJ2(env, 'SessionDeposit', [])
      const pending = sessions.filter(s => s.status === 'pending' && s.depositDetails?.provider === 'duitku').pop()
      if (!pending) return json(res, 400, { error: 'no_pending_duitku_session' })
      payload.merchantOrderId = pending.id
      payload.amount          = String(pending.depositDetails.duitku_amount)
      payload.merchantCode    = pending.depositDetails.duitku_gw?.merchantCode || 'DEV'
      payload.reference       = pending.depositDetails.duitku_reference || ('DEV-REF-' + Date.now())
    }
    payload.resultCode = payload.resultCode || '00'
    // Sign HMAC-SHA256 hex lowercase (merchantCode + amount + merchantOrderId, apiKey)
    const { readJSON: readJ3 } = await import('./src/kv.js')
    const cfg = await readJ3(env, 'BotConfig', {})
    const apiKey = cfg?.payment?.gateways?.duitku?.apiKey || ''
    if (!apiKey) return json(res, 400, { error: 'duitku_apikey_not_set' })
    const { createHmac } = await import('node:crypto')
    const sig = createHmac('sha256', apiKey)
      .update(String(payload.merchantCode) + String(payload.amount) + String(payload.merchantOrderId))
      .digest('hex')
    payload.signature = sig
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(payload)) form.append(k, String(v))
    const whReq = new Request('http://localhost:' + PORT + '/duitku-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
    const ctx = { waitUntil: (pr) => pr.catch(e => console.error('waitUntil:', e.message)) }
    const wr = await worker.default.fetch(whReq, env, ctx)
    const wtxt = await wr.text()
    return json(res, wr.status, { simulated_payload: payload, worker_response: wtxt })
  }
  // GET /dev/info → info dev server
  if (p === '/dev/info' && req.method === 'GET') {
    const { dbCount: devCount, getDbInfo: devInfo } = await import('./src/db.js')
    return json(res, 200, {
      ...(await devInfo(env)),
      mode: env.MODE, bot_username: BOT_INFO.username, kv_keys: await devCount(env, 'kv'),
      polling: polling, offset, port: PORT,
      pakasir_webhook_url: 'http://localhost:' + PORT + '/pakasir-webhook',
      pakasir_simulate_url: 'http://localhost:' + PORT + '/dev/simulate-pakasir-webhook',
      duitku_webhook_url: 'http://localhost:' + PORT + '/duitku-webhook',
      duitku_simulate_url: 'http://localhost:' + PORT + '/dev/simulate-duitku-webhook',
      duitku_return_url: 'http://localhost:' + PORT + '/duitku-return',
    })
  }
  return null // bukan dev route
}

function json(res, status, obj) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj, null, 2))
  return true
}
function safeJson(t) { try { return JSON.parse(t) } catch { return t } }

// ─── HTTP server ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let body = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = Buffer.concat(chunks).toString()
  }
  const url = new URL(req.url, 'http://localhost:' + PORT)

  // Dev routes dulu
  try {
    const handled = await handleDevRoute(req, res, url, body)
    if (handled) return
  } catch (err) {
    console.error('❌ Dev route error:', err.message)
    return json(res, 500, { error: err.message })
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(v => headers.append(key, v))
    else headers.set(key, value)
  }
  const request = new Request(url, { method: req.method, headers, body: body || undefined })
  const ctx = { waitUntil: (p) => p.catch(e => console.error('waitUntil error:', e.message)) }
  try {
    const response = await worker.default.fetch(request, env, ctx)
    res.statusCode = response.status
    response.headers.forEach((v, k) => res.setHeader(k, v))
    res.end(await response.text())
  } catch (err) {
    console.error('❌ HTTP error:', err.message)
    if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'))
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: err.message }, null, 2))
  }
})

// ─── Startup banner ─────────────────────────────────────────────────────
const BOT_INFO = { username: '(unknown)', first_name: '' }

server.listen(PORT, () => {
  console.log('')
  console.log('╭─────────────────────────────────────────────╮')
  console.log('│   DEV SERVER v14  (Standalone, no CF)       │')
  console.log('╰─────────────────────────────────────────────╯')
  console.log('  HTTP     : http://localhost:' + PORT)
  console.log('  KV file  : dev-db.json')
  console.log('  Snapshot : ./snapshots/')
  console.log('  Mode     : ' + env.MODE)
  console.log('  Bot name : ' + (env.NAMA_BOT || env.STORE_NAME || 'Store Bot'))
  console.log('  Simulate : ' + (env.SIMULATE_PAYMENT === 'true' ? 'ON' : 'OFF (Pakasir real)'))
  console.log('  Cron     : 60s (check payment) + 1h (backup)')
  console.log('─────────────────────────────────────────────')
  console.log('  Dev endpoints:')
  console.log('    GET  /dev/info')
  console.log('    GET  /dev/kv                (list keys)')
  console.log('    GET  /dev/kv/:key           (baca)')
  console.log('    POST /dev/kv/:key           (set, body=JSON)')
  console.log('    DEL  /dev/kv/:key           (hapus)')
  console.log('    POST /dev/simulate-pakasir-webhook')
  console.log('    POST /dev/simulate-duitku-webhook')
  console.log('─────────────────────────────────────────────')
  if (!env.BOT_TOKEN) {
    console.log('⚠️  BOT_TOKEN belum diisi di .dev.vars')
  } else {
    if (env.IS_PROD_TOKEN === 'true') {
      console.log('')
      console.log('🚨 ══════════════════════════════════════════ 🚨')
      console.log('   PERINGATAN: BOT_TOKEN adalah TOKEN PRODUCTION')
      console.log('   Long-polling akan MELEPAS webhook production!')
      console.log('   Gunakan bot Telegram terpisah untuk dev.')
      console.log('   Baca DEV.md > "Bot dev terpisah"')
      console.log('🚨 ══════════════════════════════════════════ 🚨')
      console.log('')
    }
    setupPolling()
  }
  console.log('  Ctrl+C untuk stop.')
  console.log('')
})

// ─── Telegram long-polling ──────────────────────────────────────────────
let polling = false
let offset = 0

async function setupPolling() {
  const BOT_TOKEN = env.BOT_TOKEN
  if (!BOT_TOKEN) return
  // Restore offset (file lokal, bukan KV)
  offset = loadOffset()
  if (offset > 0) console.log('  Resume polling offset: ' + offset)
  try {
    const delRes = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/deleteWebhook', { method: 'POST' })
    const delData = await delRes.json()
    if (delData.ok) console.log('  Webhook lama dilepas (mode long-polling)')
    // Set bot commands for dev bot
    try {
      await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setMyCommands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'start', description: 'Mulai bot' },
            { command: 'redeem', description: 'Tukar kode voucher' },
            { command: 'list_tiket', description: 'Daftar Tiket Bantuan (Khusus Admin)' },
            { command: 'adminmenu', description: 'Menu Admin (Khusus Admin)' }
          ]
        })
      })
    } catch (e) {}
    const meRes = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getMe')
    const meData = await meRes.json()
    if (meData.ok) {
      BOT_INFO.username = meData.result.username
      BOT_INFO.first_name = meData.result.first_name
      console.log('  Bot: @' + meData.result.username + ' (' + meData.result.first_name + ')')
    }
    console.log('  ✅ Bot siap! Kirim pesan di Telegram.\n')
    polling = true
    pollUpdates()
  } catch (err) {
    console.error('  ❌ Gagal setup polling:', err.message)
    console.log('     Mencoba ulang dalam 5 detik...')
    setTimeout(setupPolling, 5000)
  }
}

async function pollUpdates() {
  const BOT_TOKEN = env.BOT_TOKEN
  if (!BOT_TOKEN) return
  while (polling) {
    try {
      const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates?offset=' + offset + '&timeout=30')
      const data = await res.json()
      if (!data.ok) {
        console.error('Polling error:', data.description)
        await new Promise(r => setTimeout(r, 5000))
        continue
      }
      if (data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1
          if (update.message) {
            const msgType = update.message.text ? 'TEXT' : update.message.photo ? 'PHOTO' : update.message.document ? 'DOC' : 'OTHER'
            console.log('[' + msgType + '] ' + (update.message.from.username || update.message.from.first_name) + ' (' + update.message.from.id + '): ' + (update.message.text || '').slice(0, 60))
          } else if (update.callback_query) {
            console.log('[CB] ' + (update.callback_query.from.username || update.callback_query.from.first_name) + ': ' + update.callback_query.data)
          }
          const webhookRequest = new Request('http://localhost/webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update)
          })
          const ctx = { waitUntil: (p) => p.catch(e => console.error('waitUntil:', e.message)) }
          try {
            await worker.default.fetch(webhookRequest, env, ctx)
          } catch (err) {
            console.error('❌ Handler error:', err.message)
            if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'))
          }
        }
        // Persist offset (file lokal, bukan KV)
        saveOffset(offset)
      }
    } catch (err) {
      console.error('Polling network error:', err.message)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// ─── Cron simulation ────────────────────────────────────────────────────
let cronInterval = setInterval(async () => {
  const ctx = { waitUntil: (p) => p.catch(e => console.error('Cron error:', e.message)) }
  try {
    await worker.default.scheduled({ cron: '* * * * *' }, env, ctx)
  } catch (err) {
    console.error('Cron 60s error:', err.message)
  }
}, 60000)

let backupInterval = setInterval(async () => {
  const ctx = { waitUntil: (p) => p.catch(e => console.error('Backup error:', e.message)) }
  try {
    console.log('[' + new Date().toLocaleTimeString() + '] Cron: auto backup...')
    await worker.default.scheduled({ cron: '0 * * * *' }, env, ctx)
  } catch (err) {
    console.error('Backup error:', err.message)
  }
}, 3600000)

// ─── Graceful shutdown ──────────────────────────────────────────────────
function shutdown() {
  console.log('\n👋 Shutting down...')
  polling = false
  clearInterval(cronInterval)
  clearInterval(backupInterval)
  server.close(() => {
    env.DB.save()
    console.log('   KV disimpan ke dev-db.json')
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
