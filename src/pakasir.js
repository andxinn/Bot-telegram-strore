import { readJSON, writeJSON } from './kv.js'

// ─── Pakasir Payment Gateway ─────────────────────────────────────────
// Multi-gateway ready. Semua konfigurasi disimpan di KV BotConfig.payment
// dan dapat diatur sepenuhnya dari dalam bot (tanpa edit kode).

const PAKASIR_BASE = 'https://app.pakasir.com'

const PAYMENT_METHODS = [
  'qris', 'bri_va', 'bni_va', 'permata_va', 'cimb_niaga_va',
  'maybank_va', 'sampoerna_va', 'bnc_va', 'atm_bersama_va', 'artha_graha_va'
]

const METHOD_LABELS = {
  qris: 'QRIS',
  bri_va: 'BRI VA',
  bni_va: 'BNI VA',
  permata_va: 'Permata VA',
  cimb_niaga_va: 'CIMB Niaga VA',
  maybank_va: 'Maybank VA',
  sampoerna_va: 'Sampoerna VA',
  bnc_va: 'BNC VA',
  atm_bersama_va: 'ATM Bersama VA',
  artha_graha_va: 'Artha Graha VA'
}

function defaultPayCfg() {
  return {
    active: 'pakasir',
    gateways: {
      pakasir: {
        enabled: false,
        mode: 'sandbox',
        slug: '',
        apiKey: '',
        method: 'qris',
        feePercent: 0,
        feeNominal: 0
      },
      duitku: {
        enabled: false,
        mode: 'sandbox',
        merchantCode: '',
        apiKey: '',
        qrisProvider: 'SP',
        expiryPeriod: 30,
        feePercent: 0,
        feeNominal: 0,
        verifyIp: false
      },
      saweria: {
        enabled: false,
        username: '',
        userId: '',
        expiryPeriod: 10,
        feePercent: 0,
        feeNominal: 0
      }
    }
  }
}

async function getPayCfg(env) {
  const cfg = await readJSON(env, 'BotConfig', {})
  const def = defaultPayCfg()
  const pay = cfg.payment || def
  if (!pay.active) pay.active = 'pakasir'
  if (!pay.gateways) pay.gateways = {}
  pay.gateways.pakasir = { ...def.gateways.pakasir, ...(pay.gateways.pakasir || {}) }
  pay.gateways.duitku  = { ...def.gateways.duitku,  ...(pay.gateways.duitku  || {}) }
  pay.gateways.saweria = { ...def.gateways.saweria, ...(pay.gateways.saweria || {}) }
  // legacy: konfigurasi orkut lama tidak lagi dipakai, pastikan tidak aktif
  if (pay.gateways.orkut) {
    if (pay.active === 'orkut') pay.active = 'pakasir'
    delete pay.gateways.orkut
  }
  return pay
}

async function savePayCfg(env, pay) {
  const cfg = await readJSON(env, 'BotConfig', {})
  cfg.payment = pay
  await writeJSON(env, 'BotConfig', cfg)
  return pay
}

function getGateway(pay, name) {
  return pay && pay.gateways ? pay.gateways[name] : null
}

function pakasirConfigured(gw) {
  return !!(gw && gw.enabled && gw.slug && gw.apiKey)
}

async function getActiveGateway(env) {
  const pay = await getPayCfg(env)
  const name = pay.active || 'pakasir'
  return { pay, name, gw: getGateway(pay, name) }
}

function calcFee(gw, base) {
  if (!gw) return 0
  const pct = Number(gw.feePercent || 0)
  const nom = Number(gw.feeNominal || 0)
  let fee = 0
  if (pct > 0) fee += Math.round(base * pct / 100)
  if (nom > 0) fee += nom
  return fee
}

function feeLabel(gw) {
  const pct = Number(gw && gw.feePercent || 0)
  const nom = Number(gw && gw.feeNominal || 0)
  const parts = []
  if (pct > 0) parts.push(pct + '%')
  if (nom > 0) parts.push('Rp' + nom.toLocaleString('id-ID'))
  return parts.length ? parts.join(' + ') : 'Tanpa fee'
}

function methodLabel(m) {
  return METHOD_LABELS[m] || (m || 'QRIS')
}

function qrImageUrl(qrString) {
  return 'https://quickchart.io/qr?text=' + encodeURIComponent(qrString) + '&size=400'
}

async function pakasirCreate(gw, orderId, amount) {
  try {
    const url = PAKASIR_BASE + '/api/transactioncreate/' + (gw.method || 'qris')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: gw.slug, order_id: orderId, amount: amount, api_key: gw.apiKey })
    })
    const data = await res.json().catch(() => null)
    if (data && data.payment) return { ok: true, payment: data.payment }
    return { ok: false, error: (data && (data.message || data.error)) || ('HTTP ' + res.status), raw: data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function pakasirDetail(gw, orderId, amount) {
  try {
    const url = PAKASIR_BASE + '/api/transactiondetail?project=' + encodeURIComponent(gw.slug) +
      '&amount=' + encodeURIComponent(amount) +
      '&order_id=' + encodeURIComponent(orderId) +
      '&api_key=' + encodeURIComponent(gw.apiKey)
    const res = await fetch(url)
    const data = await res.json().catch(() => null)
    if (data && data.transaction) return data.transaction
    return null
  } catch (e) {
    return null
  }
}

async function pakasirCancel(gw, orderId, amount) {
  try {
    const res = await fetch(PAKASIR_BASE + '/api/transactioncancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: gw.slug, order_id: orderId, amount: amount, api_key: gw.apiKey })
    })
    return await res.json().catch(() => null)
  } catch (e) {
    return null
  }
}

async function pakasirSimulate(gw, orderId, amount) {
  try {
    const res = await fetch(PAKASIR_BASE + '/api/paymentsimulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: gw.slug, order_id: orderId, amount: amount, api_key: gw.apiKey })
    })
    return await res.json().catch(() => null)
  } catch (e) {
    return null
  }
}

export {
  PAKASIR_BASE, PAYMENT_METHODS, METHOD_LABELS, defaultPayCfg,
  getPayCfg, savePayCfg, getGateway, pakasirConfigured, getActiveGateway,
  calcFee, feeLabel, methodLabel, qrImageUrl,
  pakasirCreate, pakasirDetail, pakasirCancel, pakasirSimulate
}
