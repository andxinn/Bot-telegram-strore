import { OkeMerchantId, OkeSignature, KropaApi, SaweriaUserId, KropaApiKey, PaymentSaweria } from './config.js'
import { generateRandomPhone, generateRandomEmail, generateRandomDonationMessage } from './helpers.js'

async function checkMutasiQRIS(env) {
  const merchantId = OkeMerchantId || env.OKE_MERCHANTID || ''
  const signature = OkeSignature || env.OKE_SIGNATURE || ''
  if (!merchantId || !signature) return []
  try {
    const url = 'https://gateway.okeconnect.com/api/mutasi/qris/' + merchantId + '/' + signature
    const res = await fetch(url)
    const data = await res.json()
    if (!data || !data.data || !Array.isArray(data.data)) return []
    return data.data.filter(t => t.type === 'CR')
  } catch (e) {
    console.error('checkMutasiQRIS error: ' + e.message)
    return []
  }
}

function matchPayment(mutasiData, expectedAmount, maxMinutesOld = 5) {
  const now = new Date()
  for (const trx of mutasiData) {
    if (Number(trx.amount) === Number(expectedAmount)) {
      try {
        const trxDate = new Date(trx.date)
        const diffMs = Math.abs(now - trxDate)
        const diffMin = Math.floor(diffMs / 60000)
        if (diffMin <= maxMinutesOld) {
          return trx
        }
      } catch (e) {}
    }
  }
  return null
}

async function createSaweria(env, amount, username) {
  try {
    const apiUrl = 'http://api.kropatopup.cloud:2061/createSaweria'
    const donationData = {
      amount: amount,
      message: generateRandomDonationMessage(),
      anonymous: true,
      payment_type: 'qris',
      customer_info: {
        name: username || 'User',
        email: generateRandomEmail(),
        phone: generateRandomPhone()
      }
    }
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: SaweriaUserId || env.SAWERIA_USERID || '',
        apikey: KropaApiKey || env.KROPA_APIKEY || '',
        data: donationData
      })
    })
    const data = await res.json()
    if (data.status === true) {
      return { ok: true, id: data.data.data.id, qrString: data.data.data.qr_string, amount: data.data.data.amount }
    }
    return { ok: false, error: data.message || 'Unknown error' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function cekStatusSaweria(env, donationId) {
  try {
    const url = 'http://api.kropatopup.cloud:2061/cekStatus?donationId=' + donationId
    const res = await fetch(url)
    const data = await res.json()
    return data
  } catch (e) {
    return { status: false, msg: e.message }
  }
}

export { checkMutasiQRIS, matchPayment, createSaweria, cekStatusSaweria }
