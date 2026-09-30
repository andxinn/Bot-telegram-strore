import { readJSON, writeJSON } from './kv.js'

// ─── Duitku Payment Gateway (QRIS-only) ────────────────────
// Referensi: https://docs.duitku.com/api/id/
// Semua konfigurasi disimpan di KV BotConfig.payment.gateways.duitku
// dan dapat diatur sepenuhnya dari dalam bot (tanpa edit kode).
// Sesuai keputusan v9update15:
//   • Hanya opsi QRIS (4 provider)
//   • Default provider = SP (Shopee QRIS)
//   • Tombol "Bayar via Halaman Duitku" DIHILANGKAN (paymentUrl hanya disimpan utk log)
//   • Verify IP callback default OFF
//   • Fee independen per gateway

const DUITKU_BASE_SANDBOX    = 'https://sandbox.duitku.com'
const DUITKU_BASE_PRODUCTION = 'https://passport.duitku.com'

const DUITKU_QRIS_PROVIDERS = {
  SP: { label: 'Shopee QRIS',        expiryDefault: 10, expiryMax: 60 },
  NQ: { label: 'Nobu QRIS',          expiryDefault: 24, expiryMax: 1440 },
  GQ: { label: 'Gudang Voucher QRIS',expiryDefault: 10, expiryMax: 60 },
  SQ: { label: 'Nusapay QRIS',       expiryDefault: 10, expiryMax: 60 }
}

function duitkuBase(mode) {
  return (mode === 'production') ? DUITKU_BASE_PRODUCTION : DUITKU_BASE_SANDBOX
}

function defaultDuitkuCfg() {
  return {
    enabled: false,
    mode: 'sandbox',
    merchantCode: '',
    apiKey: '',
    qrisProvider: 'SP',   // default per keputusan #1
    expiryPeriod: 30,
    feePercent: 0,        // independen (keputusan #4)
    feeNominal: 0,
    verifyIp: false       // default OFF (keputusan #3)
  }
}

function duitkuConfigured(gw) {
  return !!(gw && gw.enabled && gw.merchantCode && gw.apiKey && gw.qrisProvider)
}

function providerLabel(code) {
  const p = DUITKU_QRIS_PROVIDERS[code]
  return p ? (p.label + ' (' + code + ')') : (code || 'SP')
}

// ─── HMAC helper (Web Crypto, tersedia di CF Workers) ──────────────

function _toHex(buf) {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) {
    const h = b[i].toString(16)
    s += (h.length < 2 ? '0' : '') + h
  }
  return s
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return _toHex(sig)
}

// Signature Inquiry:  HMAC( merchantCode + merchantOrderId + paymentAmount, apiKey )
async function signInquiry(gw, merchantOrderId, paymentAmount) {
  return hmacSha256Hex(gw.apiKey, String(gw.merchantCode) + String(merchantOrderId) + String(paymentAmount))
}

// Signature Callback: HMAC( merchantCode + amount + merchantOrderId, apiKey )
async function signCallback(gw, amount, merchantOrderId) {
  return hmacSha256Hex(gw.apiKey, String(gw.merchantCode) + String(amount) + String(merchantOrderId))
}

// Signature Status:   HMAC( merchantCode + merchantOrderId, apiKey )
async function signStatus(gw, merchantOrderId) {
  return hmacSha256Hex(gw.apiKey, String(gw.merchantCode) + String(merchantOrderId))
}

// ─── API: Buat transaksi QRIS ───────────────────────────

async function duitkuCreateQris(gw, merchantOrderId, paymentAmount, meta) {
  try {
    const signature = await signInquiry(gw, merchantOrderId, paymentAmount)
    const provider  = gw.qrisProvider || 'SP'
    const providerInfo = DUITKU_QRIS_PROVIDERS[provider] || DUITKU_QRIS_PROVIDERS.SP
    let expiry = Number(gw.expiryPeriod || providerInfo.expiryDefault)
    if (expiry < 1) expiry = providerInfo.expiryDefault
    if (expiry > providerInfo.expiryMax) expiry = providerInfo.expiryMax
    const body = {
      merchantCode:       gw.merchantCode,
      paymentAmount:      Number(paymentAmount),
      paymentMethod:      provider,
      merchantOrderId:    String(merchantOrderId),
      productDetails:     (meta && meta.productDetails) || 'Order',
      customerVaName:     (meta && meta.customerName)   || 'Customer',
      email:              (meta && meta.email)          || 'noreply@bot.local',
      phoneNumber:        (meta && meta.phone)          || '',
      callbackUrl:        (meta && meta.callbackUrl)    || '',
      returnUrl:          (meta && meta.returnUrl)      || '',
      signature:          signature,
      expiryPeriod:       expiry
    }
    const url = duitkuBase(gw.mode) + '/webapi/api/merchant/v2/inquiry'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json().catch(() => null)
    // Sukses: statusCode "00" + reference + qrString
    if (data && data.statusCode === '00' && data.reference) {
      return {
        ok: true,
        reference:  data.reference,
        qrString:   data.qrString || '',
        paymentUrl: data.paymentUrl || '',
        expiry:     expiry,
        raw:        data
      }
    }
    return {
      ok: false,
      error: (data && (data.statusMessage || data.Message)) || ('HTTP ' + res.status),
      raw: data
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ─── API: Cek status transaksi ─────────────────────────

async function duitkuStatus(gw, merchantOrderId) {
  try {
    const signature = await signStatus(gw, merchantOrderId)
    const url = duitkuBase(gw.mode) + '/webapi/api/merchant/transactionStatus'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        merchantCode: gw.merchantCode,
        merchantOrderId: String(merchantOrderId),
        signature: signature
      })
    })
    const data = await res.json().catch(() => null)
    if (!data) return null
    // statusCode:  "00" = SUCCESS, "01" = FAILED, "02" = PROCESSING
    return data
  } catch (e) {
    return null
  }
}

// ─── Verify webhook callback signature ────────────────────

async function duitkuVerifyCallback(gw, params) {
  if (!gw || !gw.apiKey || !gw.merchantCode) return false
  const merchantCode    = params.merchantCode || params.merchantcode
  const amount          = params.amount
  const merchantOrderId = params.merchantOrderId || params.merchantorderid
  const sig             = (params.signature || '').toLowerCase()
  if (!merchantCode || !amount || !merchantOrderId || !sig) return false
  if (String(merchantCode) !== String(gw.merchantCode)) return false
  const expected = await signCallback(gw, amount, merchantOrderId)
  return expected.toLowerCase() === sig
}

// ─── Test koneksi (buat + status dummy) ─────────────────────

async function duitkuTest(gw) {
  const { calcFee } = await import('./pakasir.js')
  const fee = calcFee(gw, 10000)
  const charge = 10000 + fee
  const testOrder = 'TEST-DK-' + Date.now()
  const created = await duitkuCreateQris(gw, testOrder, charge, {
    productDetails: 'Test Koneksi', customerName: 'Tester', email: 'test@bot.local'
  })
  if (!created.ok) return { ok: false, stage: 'inquiry', error: created.error, raw: created.raw }
  return {
    ok: true,
    reference:  created.reference,
    qrPreview:  (created.qrString || '').slice(0, 40) + '...',
    paymentUrl: created.paymentUrl || null,
    provider:   gw.qrisProvider,
    fee, charge
  }
}

// ─── QR image URL (share dengan Pakasir via quickchart) ─────────────

function qrImageUrl(qrString) {
  return 'https://quickchart.io/qr?text=' + encodeURIComponent(qrString) + '&size=400'
}

// ─── Ensure duitku entry ada di BotConfig.payment (helper util) ──────

async function ensureDuitkuInCfg(env) {
  const cfg = await readJSON(env, 'BotConfig', {})
  cfg.payment = cfg.payment || {}
  cfg.payment.gateways = cfg.payment.gateways || {}
  if (!cfg.payment.gateways.duitku) {
    cfg.payment.gateways.duitku = defaultDuitkuCfg()
    await writeJSON(env, 'BotConfig', cfg)
  } else {
    // migrasi field yg mungkin belum ada
    const d = cfg.payment.gateways.duitku
    const def = defaultDuitkuCfg()
    let changed = false
    for (const k of Object.keys(def)) {
      if (d[k] === undefined) { d[k] = def[k]; changed = true }
    }
    if (changed) await writeJSON(env, 'BotConfig', cfg)
  }
}

export {
  DUITKU_BASE_SANDBOX, DUITKU_BASE_PRODUCTION, DUITKU_QRIS_PROVIDERS,
  duitkuBase, defaultDuitkuCfg, duitkuConfigured, providerLabel,
  hmacSha256Hex, signInquiry, signCallback, signStatus,
  duitkuCreateQris, duitkuStatus, duitkuVerifyCallback, duitkuTest,
  qrImageUrl, ensureDuitkuInCfg
}
