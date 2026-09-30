// src/db.js — Backend storage switchable: KV (CF KV / file lokal) vs Turso (libSQL).
// Semua akses data bot WAJIB lewat sini (via kv.js), jangan sentuh env.DB langsung.
//
// Mode: env.DB_MODE = 'kv' | 'turso' | 'auto' (default 'auto' → ikut BotConfig.db.mode).
// Kredensial: env TURSO_URL/TURSO_TOKEN menang atas setting bot (BotConfig.db),
// biar secret bisa di-rotate tanpa lewat chat. Setting via bot disimpan di BotConfig.db.
// ponytail: single-table kv compat; upgrade ke skema relasional (db-schema.md) bila butuh query.
const tursoClients = new Map()

function tursoEntry(url, token) {
  const key = url + '|' + token
  let e = tursoClients.get(key)
  if (!e) { e = { client: null, tableOk: false }; tursoClients.set(key, e) }
  return e
}

async function getTurso(env, url, token) {
  const e = tursoEntry(url, token)
  if (!e.client) {
    const { createClient } = await import('@libsql/client/web')
    e.client = createClient({ url, authToken: token || undefined })
    e.tableOk = false
  }
  if (!e.tableOk) {
    await e.client.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
    e.tableOk = true
  }
  return e.client
}

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
    if (o && typeof o === 'object' && !Array.isArray(o)
      && Object.keys(o).length === 2 && '__exp' in o && '__v' in o
      && typeof o.__exp === 'number' && Number.isFinite(o.__exp)) {
      if (Date.now() > Number(o.__exp)) return { value: null, expired: true }
      return { value: o.__v === undefined ? null : o.__v }
    }
  } catch {}
  return { value: stored }
}

async function resolveDb(env) {
  const force = String(env.DB_MODE || 'auto').trim().toLowerCase()
  let botDb = null
  try {
    botDb = botDbFromRaw(await env.DB.get('BotConfig'))
  } catch (e) {
    return { backend: 'kv', client: null, mode: 'kv', force, degraded: true, dbError: e && e.message ? e.message : String(e) }
  }
  const url = env.TURSO_URL || (botDb && botDb.url) || ''
  const token = env.TURSO_TOKEN || (botDb && botDb.token) || ''
  const wantTurso = force === 'turso' || (force !== 'kv' && botDb && botDb.mode === 'turso')
  if (!wantTurso) return { backend: 'kv', client: null, mode: (botDb && botDb.mode) || 'kv', force, degraded: false }
  if (!url) {
    console.error('[db] mode turso diminta tapi TURSO_URL kosong → fallback KV lokal')
    return { backend: 'kv', client: null, mode: (botDb && botDb.mode) || 'kv', force, degraded: true }
  }
  try {
    const client = await getTurso(env, url, token)
    return { backend: 'turso', client, mode: 'turso', force, degraded: false,
      urlHost: url.replace(/^(libsql|https?):\/\//, '').split(/[/:?]/)[0],
      hasToken: !!token, credSource: env.TURSO_URL ? 'env' : 'bot' }
  } catch (e) {
    console.error('[db] konek Turso gagal → fallback KV lokal:', e.message)
    return { backend: 'kv', client: null, mode: (botDb && botDb.mode) || 'kv', force, degraded: true, dbError: e.message }
  }
}

// Selector mode tinggal di KV lokal (BotConfig.db.mode). Tulis ke KEDUA backend
// agar flip Turso↔KV menempel apa pun backend aktifnya; gagal satu sisi tidak fatal.
async function saveDbMode(env, mode) {
  let raw = null
  try { raw = await env.DB.get('BotConfig') } catch (e) { console.error('[db] saveDbMode baca BotConfig gagal:', e.message) }
  let cfg = {}
  try { cfg = raw ? JSON.parse(raw) : {} } catch { cfg = {} }
  if (!cfg || typeof cfg !== 'object') cfg = {}
  cfg.db = { ...(cfg.db || {}), mode }
  const out = JSON.stringify(cfg)
  try { await env.DB.put('BotConfig', out) } catch (e) { console.error('[db] saveDbMode tulis KV gagal:', e.message) }
  try {
    const url = env.TURSO_URL || (cfg.db && cfg.db.url) || ''
    const token = env.TURSO_TOKEN || (cfg.db && cfg.db.token) || ''
    if (url) {
      const client = await getTurso(env, url, token)
      await client.execute({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: ['BotConfig', out] })
    }
  } catch (e) { console.error('[db] saveDbMode tulis Turso gagal:', e.message) }
  try { if (env._db) env._db.mode = mode } catch {}
  return true
}

async function getDbMode(env) {
  try {
    const botDb = botDbFromRaw(await env.DB.get('BotConfig'))
    return (botDb && botDb.mode) || 'kv'
  } catch { return 'kv' }
}

async function initDb(env) {
  try { env._db = await resolveDb(env) }
  catch (e) { console.error('[db] init gagal, fallback KV:', e.message); env._db = { backend: 'kv', client: null, force: 'auto', degraded: true } }
  return env._db
}
function resetDbCache(env) { try { delete env._db } catch {} }
async function cur(env) { return env._db || await initDb(env) }

// Failover per-request: Turso gagal di tengah request → tandai degraded,
// ulangi operasi itu di KV lokal. Request berikut initDb ulang dari selector.
function failover(env, r, e) {
  const msg = e && e.message ? e.message : String(e)
  console.error('[db] Turso gagal tengah request → failover KV lokal:', msg)
  env._db = { backend: 'kv', client: null, force: r.force || 'auto', degraded: true, dbError: msg }
}
async function kvGetRaw(env, key) {
  const v = await env.DB.get(key)
  return v === null || v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v))
}

// ─── Operasi utama (plx TTL envelope) ───
async function dbGet(env, key) {
  const r = await cur(env)
  let stored = null
  if (r.backend === 'turso') {
    try {
      const rs = await r.client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] })
      stored = rs.rows.length ? rs.rows[0].value : null
    } catch (e) { failover(env, r, e); stored = await kvGetRaw(env, key) }
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
  if (r.backend === 'turso') {
    try { await r.client.execute({ sql: 'DELETE FROM kv WHERE key = ?', args: [key] }) }
    catch (e) { failover(env, r, e); await env.DB.delete(key) }
  }
  else await env.DB.delete(key)
}
async function dbExists(env, key) { return await dbGet(env, key) !== null }

// Tulis hanya bila key belum ada. Turso: atomic via WHERE NOT EXISTS;
// KV: check-then-act best-effort (BUKAN CAS — race antar worker bisa dobel tulis).
async function dbPutIfAbsent(env, key, value, opts) {
  const v = wrap(value, opts)
  const r = await cur(env)
  if (r.backend === 'turso') {
    try {
      const rs = await r.client.execute(
        { sql: 'INSERT INTO kv(key,value) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM kv WHERE key=?)', args: [key, v, key] })
      const n = Number(rs.rowsAffected ?? rs.rows_affected ?? NaN)
      if (Number.isFinite(n)) return n > 0
      // Driver tak lapor changes → verifikasi manual via SELECT value.
      const chk = await r.client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] })
      return chk.rows.length === 1 && String(chk.rows[0].value) === String(v)
    } catch (e) {
      failover(env, r, e)
      if ((await kvGetRaw(env, key)) !== null) return false
      await env.DB.put(key, v)
      return true
    }
  }
  if ((await kvGetRaw(env, key)) !== null) return false
  await env.DB.put(key, v)
  return true
}

// ─── Raw (tanpa envelope): untuk /dev/kv + migrasi ───
async function dbGetRaw(env, key) {
  const r = await cur(env)
  if (r.backend === 'turso') {
    try {
      const rs = await r.client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] })
      return rs.rows.length ? String(rs.rows[0].value) : null
    } catch (e) { failover(env, r, e); return kvGetRaw(env, key) }
  }
  return kvGetRaw(env, key)
}
async function dbPutRaw(env, key, rawString) {
  const r = await cur(env)
  if (r.backend === 'turso') {
    try { await r.client.execute({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: [key, rawString] }) }
    catch (e) { failover(env, r, e); await env.DB.put(key, rawString) }
  }
  else await env.DB.put(key, rawString)
}
function escapeLike(s) { return s.replace(/[\\%_]/g, c => '\\' + c) }
async function dbList(env, prefix = '') {
  const r = await cur(env)
  if (r.backend === 'turso') {
    try {
      const rs = await r.client.execute({ sql: "SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'", args: [escapeLike(prefix) + '%'] })
      return rs.rows.map(x => String(x.key))
    } catch (e) {
      failover(env, r, e)
      // jatuh ke list KV lokal di bawah
    }
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
    await c.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)')
    await c.execute({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: ['__db_test__', '1'] })
    await c.execute({ sql: 'DELETE FROM kv WHERE key = ?', args: ['__db_test__'] })
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
  finally {
    try { await c.execute({ sql: 'DELETE FROM kv WHERE key = ?', args: ['__db_test__'] }) } catch {}
    try { c.close() } catch {}
  }
}
// dir 'up' = lokal→turso, 'down' = turso→lokal. Copy raw verbatim (TTL ikut).
// Dua fase: (1) baca SEMUA sumber ke memori — gagal = tanpa tulis satupun;
// (2) tulis semua ke tujuan — gagal = tanpa flip mode (pemanggil gate flip pada ok).
function skipKey(k) { return k.startsWith('lock_') || k.startsWith('__DEV_') }
function skipValue(raw) {
  if (typeof raw !== 'string') return false
  return unwrap(raw).expired === true
}
async function listKvDirect(env) {
  if (env.DB.data && typeof env.DB.data === 'object') return Object.keys(env.DB.data)
  const out = []
  let cursor = undefined
  for (;;) {
    const page = await env.DB.list({ prefix: '', cursor })
    for (const k of (page.keys || [])) out.push(k.name)
    if (page.list_complete) break
    cursor = page.cursor
    if (!cursor) break
  }
  return out
}
async function migrateKeys(env, dir) {
  const r = await cur(env)
  const wantActive = dir === 'up' ? 'turso' : 'kv'
  // ── Fase 1: baca semua sumber ke memori ──
  let pairs
  try {
    if (dir === 'up') {
      // SELALU dari KV lokal langsung — jangan pernah dari backend aktif.
      const keys = await listKvDirect(env)
      pairs = []
      for (const k of keys) {
        const v = (env.DB.data && typeof env.DB.data === 'object') ? env.DB.data[k] : await env.DB.get(k)
        if (v === null || v === undefined) continue
        pairs.push([k, typeof v === 'string' ? v : JSON.stringify(v)])
      }
    } else {
      if (!r.client) return { ok: false, error: 'Turso tidak terkoneksi', moved: 0, total: 0, skipped: 0, active: wantActive }
      const rs = await r.client.execute('SELECT key, value FROM kv')
      pairs = rs.rows.map(x => [String(x.key), String(x.value)])
    }
  } catch (e) { return { ok: false, error: e.message, moved: 0, total: 0, skipped: 0, active: wantActive } }
  const total = pairs.length
  // ── Fase 2: tulis semua ke tujuan ──
  let moved = 0, skipped = 0
  try {
    if (dir === 'up') {
      if (!r.client) return { ok: false, error: 'Turso tidak terkoneksi', moved, total, skipped, active: wantActive }
      for (const [k, raw] of pairs) {
        if (skipKey(k) || skipValue(raw)) { skipped++; continue }
        await r.client.execute({ sql: 'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', args: [k, raw] })
        moved++
      }
    } else {
      for (const [k, raw] of pairs) {
        if (skipKey(k) || skipValue(raw)) { skipped++; continue }
        await env.DB.put(k, raw)
        moved++
      }
      if (env.DB.save) { try { env.DB.save() } catch {} }
    }
  } catch (e) { return { ok: false, error: e.message, moved, total, skipped, active: wantActive } }
  return { ok: true, moved, total, skipped, active: wantActive }
}

export { initDb, resetDbCache, getDbInfo, dbGet, dbPut, dbDelete, dbExists, dbPutIfAbsent,
  saveDbMode, getDbMode, dbGetRaw, dbPutRaw, dbList, dbCount, testTurso, migrateKeys }
