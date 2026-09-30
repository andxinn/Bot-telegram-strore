// src/db.js — Backend storage switchable: KV (CF KV / file lokal) vs Turso (libSQL).
// Semua akses data bot WAJIB lewat sini (via kv.js), jangan sentuh env.DB langsung.
//
// Mode: env.DB_MODE = 'kv' | 'turso' | 'auto' (default 'auto' → ikut BotConfig.db.mode).
// Kredensial: env TURSO_URL/TURSO_TOKEN menang atas setting bot (BotConfig.db),
// biar secret bisa di-rotate tanpa lewat chat. Setting via bot disimpan di BotConfig.db.
// ponytail: single-table kv compat; upgrade ke skema relasional (db-schema.md) bila butuh query.
let tursoClient = null
let tursoKey = ''
let tursoTableOk = false

function botDbFromRaw(raw) {
  try { const o = JSON.parse(raw); return (o && o.db) || null } catch { return null }
}

// TTL di-emulate seragam di kedua backend via envelope, karena:
// - LocalKV tidak dukung expirationTtl, - Turso tidak punya TTL kolom.
// Format envelope: {"__exp":<ms>,"__v":<string>}. Value lama (raw) tetap terbaca.
function wrap(value, opts) {
  const ttl = opts && opts.expirationTtl
  if (!ttl) return value
  return JSON.stringify({ __exp: Date.now() + ttl * 1000, __v: value })
}
function unwrap(stored) {
  if (stored === null || stored === undefined) return { value: null }
  if (typeof stored !== 'string') return { value: stored }
  try {
    const o = JSON.parse(stored)
    if (o && typeof o === 'object' && '__exp' in o) {
      if (Date.now() > Number(o.__exp)) return { value: null, expired: true }
      return { value: o.__v === undefined ? null : o.__v }
    }
  } catch {}
  return { value: stored }
}

async function resolveDb(env) {
  const force = String(env.DB_MODE || 'auto').toLowerCase()
  let botDb = null
  try { botDb = botDbFromRaw(await env.DB.get('BotConfig')) } catch {}
  const url = env.TURSO_URL || (botDb && botDb.url) || ''
  const token = env.TURSO_TOKEN || (botDb && botDb.token) || ''
  const wantTurso = force === 'turso' || (force !== 'kv' && botDb && botDb.mode === 'turso')
  if (!wantTurso) return { backend: 'kv', client: null, mode: (botDb && botDb.mode) || 'kv', force, degraded: false }
  if (!url) {
    console.error('[db] mode turso diminta tapi TURSO_URL kosong → fallback KV lokal')
    return { backend: 'kv', client: null, mode: (botDb && botDb.mode) || 'kv', force, degraded: true }
  }
  try {
    const key = url + '|' + token
    if (!tursoClient || tursoKey !== key) {
      const { createClient } = await import('@libsql/client/web')
      tursoClient = createClient({ url, authToken: token || undefined })
      tursoKey = key
      tursoTableOk = false
    }
    if (!tursoTableOk) {
      await tursoClient.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
      tursoTableOk = true
    }
    return { backend: 'turso', client: tursoClient, mode: 'turso', force, degraded: false,
      urlHost: url.replace(/^(libsql|https?):\/\//, '').split(/[/:?]/)[0],
      hasToken: !!token, credSource: env.TURSO_URL ? 'env' : 'bot' }
  } catch (e) {
    console.error('[db] konek Turso gagal → fallback KV lokal:', e.message)
    return { backend: 'kv', client: null, mode: (botDb && botDb.mode) || 'kv', force, degraded: true, dbError: e.message }
  }
}

async function initDb(env) {
  try { env._db = await resolveDb(env) }
  catch (e) { console.error('[db] init gagal, fallback KV:', e.message); env._db = { backend: 'kv', client: null, force: 'auto', degraded: true } }
  return env._db
}
function resetDbCache(env) { try { delete env._db } catch {} }
async function cur(env) { return env._db || await initDb(env) }

// ─── Operasi utama (plx TTL envelope) ───
async function dbGet(env, key) {
  const r = await cur(env)
  let stored = null
  if (r.backend === 'turso') {
    const rs = await r.client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] })
    stored = rs.rows.length ? rs.rows[0].value : null
  } else {
    stored = await env.DB.get(key)
  }
  const u = unwrap(stored)
  if (u.expired) { try { await dbDelete(env, key) } catch {} ; return null }
  return u.value
}
async function dbPut(env, key, value, opts) {
  const v = wrap(value, opts)
  return dbPutRaw(env, key, v)
}
async function dbDelete(env, key) {
  const r = await cur(env)
  if (r.backend === 'turso') await r.client.execute({ sql: 'DELETE FROM kv WHERE key = ?', args: [key] })
  else await env.DB.delete(key)
}
async function dbExists(env, key) { return await dbGet(env, key) !== null }

// ─── Raw (tanpa envelope): untuk /dev/kv + migrasi ───
async function dbGetRaw(env, key) {
  const r = await cur(env)
  if (r.backend === 'turso') {
    const rs = await r.client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] })
    return rs.rows.length ? String(rs.rows[0].value) : null
  }
  const v = await env.DB.get(key)
  return v === null || v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v))
}
async function dbPutRaw(env, key, rawString) {
  const r = await cur(env)
  if (r.backend === 'turso') await r.client.execute({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: [key, rawString] })
  else await env.DB.put(key, rawString)
}
async function dbList(env, prefix = '') {
  const r = await cur(env)
  if (r.backend === 'turso') {
    const rs = await r.client.execute({ sql: 'SELECT key FROM kv WHERE key LIKE ?', args: [prefix + '%'] })
    return rs.rows.map(x => String(x.key))
  }
  if (env.DB.data && typeof env.DB.data === 'object') {
    return Object.keys(env.DB.data).filter(k => k.startsWith(prefix))
  }
  const out = []
  let cursor = undefined
  for (;;) {
    const page = await env.DB.list({ prefix, cursor })
    for (const k of (page.keys || [])) out.push(k.name)
    if (page.list_complete) break
    cursor = page.cursor
    if (!cursor) break
  }
  return out
}
async function dbCount(env, which) {
  const r = await cur(env)
  const target = which || r.backend
  if (target === 'turso') return countTurso(env)
  return countKv(env)
}
// Hitung key backend KV (CF KV / file lokal) tanpa peduli backend aktif.
async function countKv(env) {
  if (env.DB.data && typeof env.DB.data === 'object') return Object.keys(env.DB.data).length
  try {
    let n = 0, cursor = undefined
    for (;;) {
      const page = await env.DB.list({ prefix: '', cursor })
      n += (page.keys || []).length
      if (page.list_complete) break
      cursor = page.cursor
      if (!cursor) break
    }
    return n
  } catch { return -1 }
}
// Hitung baris tabel kv di Turso tanpa ganggu backend aktif. -1 = belum dikonfigurasi / gagal.
async function countTurso(env) {
  const r = env._db && env._db.client ? env._db : null
  if (r) {
    try {
      const rs = await r.client.execute('SELECT COUNT(*) AS n FROM kv')
      return Number(rs.rows[0].n)
    } catch { return -1 }
  }
  let raw = null
  try { raw = await env.DB.get('BotConfig') } catch {}
  const botDb = botDbFromRaw(raw)
  const u = env.TURSO_URL || (botDb && botDb.url) || ''
  const t = env.TURSO_TOKEN || (botDb && botDb.token) || ''
  if (!u) return -1
  const { createClient } = await import('@libsql/client/web')
  const c = createClient({ url: u, authToken: t || undefined })
  try {
    const rs = await c.execute('SELECT COUNT(*) AS n FROM kv')
    return Number(rs.rows[0].n)
  } catch { return -1 } finally { try { c.close() } catch {} }
}

// ─── Info + test + migrasi (dipakai panel admin) ───
async function getDbInfo(env) {
  const r = await cur(env)
  return {
    backend: r.backend, mode: r.mode || 'kv', force: r.force || 'auto',
    degraded: !!r.degraded, dbError: r.dbError || null,
    urlHost: r.urlHost || null, hasToken: !!r.hasToken, credSource: r.credSource || null
  }
}
async function testTurso(url, token) {
  if (!url) return { ok: false, error: 'URL kosong' }
  const { createClient } = await import('@libsql/client/web')
  const c = createClient({ url, authToken: token || undefined })
  try {
    await c.execute('SELECT 1')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
  finally { try { c.close() } catch {} }
}
// dir 'up' = lokal→turso, 'down' = turso→lokal. Copy raw verbatim (TTL ikut).
async function migrateKeys(env, dir) {
  const r = await cur(env)
  const wantActive = dir === 'up' ? 'turso' : 'kv'
  let keys
  if (dir === 'up') {
    keys = (env.DB.data && typeof env.DB.data === 'object')
      ? Object.keys(env.DB.data)
      : (await dbList(env, ''))
  } else {
    if (!r.client) return { ok: false, error: 'Turso tidak terkoneksi' }
    const rs = await r.client.execute('SELECT key FROM kv')
    keys = rs.rows.map(x => String(x.key))
  }
  let moved = 0
  for (const k of keys) {
    let raw
    if (dir === 'up') {
      const v = (env.DB.data && typeof env.DB.data === 'object') ? env.DB.data[k] : await env.DB.get(k)
      if (v === null || v === undefined) continue
      raw = typeof v === 'string' ? v : JSON.stringify(v)
      if (!r.client) return { ok: false, error: 'Turso tidak terkoneksi' }
      await r.client.execute({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: [k, raw] })
    } else {
      const rs = await r.client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [k] })
      if (!rs.rows.length) continue
      await env.DB.put(k, String(rs.rows[0].value))
    }
    moved++
  }
  if (dir === 'down' && env.DB.save) { try { env.DB.save() } catch {} }
  return { ok: true, moved, total: keys.length, active: wantActive }
}

export { initDb, resetDbCache, getDbInfo, dbGet, dbPut, dbDelete, dbExists,
  dbGetRaw, dbPutRaw, dbList, dbCount, testTurso, migrateKeys }
