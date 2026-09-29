import { readJSON, writeJSON } from './kv.js'

// ─── Orkut Payment Gateway (QRIS-only Private Gateway) ───────────
// Referensi: Kustom API buatan User
// Semua konfigurasi disimpan di KV BotConfig.payment.gateways.orkut

function defaultOrkutCfg() {
  return {
    enabled: false,
    baseUrl: 'https://justice-trades-cities-groundwater.trycloudflare.com',
    apiKey: '',
    expiryPeriod: 10,
    feePercent: 0,
    feeNominal: 0
  }
}

function orkutConfigured(gw) {
  return !!(gw && gw.enabled && gw.baseUrl && gw.apiKey)
}

async function orkutCreateQris(gw, orderId, amount, expMinutes) {
  try {
    const baseUrl = (gw.baseUrl || '').replace(/\/$/, '')
    const exp = expMinutes || gw.expiryPeriod || 10
    const url = `${baseUrl}/create_payment?amount=${amount}&exp=${exp}&api_key=${gw.apiKey}`
    const res = await fetch(url)
    const data = await res.json().catch(() => null)
    if (data && data.success && data.results) {
      return {
        ok: true,
        reference: data.results.ref,
        qrString: data.results.qr_string || '',
        qrLink: data.results.qr_link || `${baseUrl}/pay/?ref=${data.results.ref}`,
        totalBayar: data.results.total_bayar || amount,
        raw: data
      }
    }
    return {
      ok: false,
      error: (data && data.message) || ('HTTP ' + res.status),
      raw: data
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function orkutStatus(gw, ref) {
  try {
    const baseUrl = (gw.baseUrl || '').replace(/\/$/, '')
    const url = `${baseUrl}/transactions?ref=${ref}&api_key=${gw.apiKey}`
    const res = await fetch(url)
    const data = await res.json().catch(() => null)
    if (data && data.success) {
      return {
        ok: true,
        status: data.status, // PENDING | PAID | EXPIRED
        raw: data
      }
    }
    return { ok: false, error: (data && data.message) || 'HTTP ' + res.status }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function orkutTest(gw) {
  const testRef = 'TEST-ORKUT-' + Date.now()
  const created = await orkutCreateQris(gw, testRef, 1000, 5)
  if (!created.ok) {
    return { ok: false, stage: 'create_payment', error: created.error, raw: created.raw }
  }
  const status = await orkutStatus(gw, created.reference)
  if (!status.ok) {
    return { ok: false, stage: 'status', error: status.error, raw: status.raw }
  }
  return {
    ok: true,
    reference: created.reference,
    status: status.status,
    qrLink: created.qrLink
  }
}

async function orkutCancel(gw, ref) {
  try {
    const baseUrl = (gw.baseUrl || '').replace(/\/$/, '')
    const url = `${baseUrl}/cancel_payment?ref=${ref}&api_key=${gw.apiKey}`
    const res = await fetch(url)
    const data = await res.json().catch(() => null)
    if (data && data.success) {
      return { ok: true, raw: data }
    }
    return { ok: false, error: (data && data.message) || 'HTTP ' + res.status, raw: data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function ensureOrkutInCfg(env) {
  const cfg = await readJSON(env, 'BotConfig', {})
  cfg.payment = cfg.payment || {}
  cfg.payment.gateways = cfg.payment.gateways || {}
  if (!cfg.payment.gateways.orkut) {
    cfg.payment.gateways.orkut = defaultOrkutCfg()
    await writeJSON(env, 'BotConfig', cfg)
  } else {
    const o = cfg.payment.gateways.orkut
    const def = defaultOrkutCfg()
    let changed = false
    for (const k of Object.keys(def)) {
      if (o[k] === undefined) { o[k] = def[k]; changed = true }
    }
    if (changed) await writeJSON(env, 'BotConfig', cfg)
  }
}

export {
  defaultOrkutCfg, orkutConfigured, orkutCreateQris, orkutStatus, orkutCancel, orkutTest, ensureOrkutInCfg
}
