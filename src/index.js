import { initDb } from './db.js'
import { initConfig, Mode } from './config.js'
import { tgSendMessage, tgSetMyCommands } from './telegram.js'
import { handleMessage } from './messages.js'
import { handleCallbackQuery } from './callbacks.js'
import { checkPendingPayments, processPaymentSuccess } from './payments.js'
import { autoBackup, cleanupClosedTickets } from './backup.js'
import { readJSON, writeJSON } from './kv.js'
import { pakasirDetail, getPayCfg } from './pakasir.js'
import { duitkuStatus, duitkuVerifyCallback } from './duitku.js'
import { acquireLock, releaseLock } from './user.js'

async function handleUpdate(env, update) {
  try {
    if (update.message) {
      await handleMessage(env, update.message)
    } else if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query)
    }
  } catch (err) {
    console.error('[handleUpdate ERROR]', err.message)
    console.error(err.stack?.split('\n').slice(0, 4).join('\n'))
    // Try notify owner of error
    try {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id
      if (chatId) {
        await tgSendMessage(env, chatId, '⚠️ Terjadi error. Coba lagi atau hubungi admin.', null, '')
      }
    } catch (e) {}
  }
}

async function handlePakasirWebhook(env, body) {
  const orderId = body && body.order_id
  if (!orderId) return { ok: false, reason: 'invalid_order_id' }
  const lockKey = 'pay_process_' + orderId
  const gotLock = await acquireLock(env, lockKey, 15)
  if (!gotLock) return { ok: false, reason: 'locked' }

  try {
    const status  = body && body.status
    const amount  = Number(body && body.amount)
    if (status !== 'completed') return { ok: false, reason: 'invalid_status' }
    const sessions = await readJSON(env, 'SessionDeposit', [])
    const session  = sessions.find(s => s.id === orderId && s.status === 'pending')
    if (!session) return { ok: false, reason: 'not_found' }
    const details = session.depositDetails || {}
    if (details.provider !== 'pakasir' || !details.pakasir_gw) return { ok: false, reason: 'provider_mismatch' }
    if (Number(details.pakasir_amount) !== amount) return { ok: false, reason: 'amount_mismatch' }
    const trxDetail = await pakasirDetail(details.pakasir_gw, orderId, amount)
    if (!trxDetail || trxDetail.status !== 'completed') return { ok: false, reason: 'not_completed' }
    await writeJSON(env, 'SessionDeposit', sessions.filter(s => s.id !== orderId))
    await processPaymentSuccess(env, session, trxDetail)
    return { ok: true }
  } catch (e) {
    console.error('[pakasir-webhook ERROR]', e.message)
    return { ok: false, reason: 'exception', error: e.message }
  } finally {
    await releaseLock(env, lockKey)
  }
}

async function handleDuitkuWebhook(env, params) {
  const orderId = params && (params.merchantOrderId || params.merchantorderid)
  if (!orderId) return { ok: false, reason: 'invalid_order_id' }
  const lockKey = 'pay_process_' + orderId
  const gotLock = await acquireLock(env, lockKey, 15)
  if (!gotLock) return { ok: false, reason: 'locked' }

  try {
    const resultCode = params && (params.resultCode || params.resultcode)
    const amount = Number(params && params.amount)
    if (String(resultCode) !== '00') return { ok: false, reason: 'not_success', code: String(resultCode) }
    const pay = await getPayCfg(env)
    const gwCfg = pay && pay.gateways && pay.gateways.duitku
    if (!gwCfg || !gwCfg.apiKey || !gwCfg.merchantCode) return { ok: false, reason: 'gateway_not_configured' }
    const okSig = await duitkuVerifyCallback(gwCfg, params)
    if (!okSig) return { ok: false, reason: 'bad_signature' }
    const sessions = await readJSON(env, 'SessionDeposit', [])
    const session = sessions.find(s => s.id === orderId && s.status === 'pending')
    if (!session) return { ok: false, reason: 'not_found' }
    const details = session.depositDetails || {}
    if (details.provider !== 'duitku' || !details.duitku_gw) return { ok: false, reason: 'provider_mismatch' }
    if (Number(details.duitku_amount) !== amount) return { ok: false, reason: 'amount_mismatch' }
    const trxStat = await duitkuStatus(details.duitku_gw, orderId)
    if (!trxStat || String(trxStat.statusCode) !== '00') return { ok: false, reason: 'status_not_success' }
    await writeJSON(env, 'SessionDeposit', sessions.filter(s => s.id !== orderId))
    await processPaymentSuccess(env, session, {
      status: 'completed', reference: params.reference,
      amount: amount, gateway: 'duitku'
    })
    return { ok: true }
  } catch (e) {
    console.error('[duitku-webhook ERROR]', e.message)
    return { ok: false, reason: 'exception', error: e.message }
  } finally {
    await releaseLock(env, lockKey)
  }
}

async function setupWebhook(env, url) {
  const token = env.BOT_TOKEN
  if (!token) return { ok: false, error: 'BOT_TOKEN not set' }
  const webhookUrl = url + '/webhook'
  const res = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] })
  })
  const data = await res.json()
  // Set bot commands
  await tgSetMyCommands(env, [
    { command: 'start', description: 'Mulai bot' },
    { command: 'redeem', description: 'Tukar kode voucher' },
    { command: 'list_tiket', description: 'Daftar Tiket Bantuan (Khusus Admin)' },
    { command: 'adminmenu', description: 'Menu Admin (Khusus Admin)' },
    { command: 'idgrup', description: 'Mendapatkan ID Grup (Khusus Admin)' }
  ])
  return data
}

export default {
  async fetch(request, env, ctx) {
    await initDb(env)
    await initConfig(env)
    const url = new URL(request.url)

    if (url.pathname === '/webhook') {
      try {
        const update = await request.json()
        ctx.waitUntil(handleUpdate(env, update))
        return new Response('OK', { status: 200 })
      } catch (e) {
        console.error('[webhook parse ERROR]', e.message)
        return new Response('Error: ' + e.message, { status: 500 })
      }
    }

    if (url.pathname === '/pakasir-webhook' && request.method === 'POST') {
      try {
        const body = await request.json()
        const res = await handlePakasirWebhook(env, body)
        return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } })
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    }

    if (url.pathname === '/duitku-webhook' && request.method === 'POST') {
      try {
        const ct = (request.headers.get('content-type') || '').toLowerCase()
        let params = {}
        if (ct.includes('application/json')) {
          params = await request.json()
        } else {
          const form = await request.formData()
          for (const [k, v] of form.entries()) params[k] = v
        }
        const res = await handleDuitkuWebhook(env, params)
        // Duitku expects HTTP 200 for success acknowledgement
        return new Response(res.ok ? 'OK' : ('IGNORED:' + (res.reason || 'error')),
          { status: 200, headers: { 'Content-Type': 'text/plain' } })
      } catch (e) {
        return new Response('ERROR:' + e.message, { status: 200, headers: { 'Content-Type': 'text/plain' } })
      }
    }

    if (url.pathname === '/duitku-return' && request.method === 'GET') {
      const merchantOrderId = url.searchParams.get('merchantOrderId') || ''
      const resultCode = url.searchParams.get('resultCode') || ''
      const reference  = url.searchParams.get('reference') || ''
      const html = '<!doctype html><meta charset="utf-8"><title>Kembali ke Bot</title>' +
        '<div style="font-family:system-ui;max-width:420px;margin:80px auto;text-align:center;padding:24px;border-radius:12px;background:#f5f7fb;color:#0f172a">' +
        '<h2>' + (resultCode === '00' ? '✅ Pembayaran diterima' : '⏳ Menunggu konfirmasi') + '</h2>' +
        '<p>Order ID: <b>' + merchantOrderId + '</b></p>' +
        (reference ? '<p>Reference: <code>' + reference + '</code></p>' : '') +
        '<p style="color:#64748b;font-size:13px;margin-top:20px">Silakan kembali ke Telegram dan tekan tombol "Cek Pembayaran" untuk melihat status.</p>' +
        '</div>'
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    if (url.pathname === '/setup') {
      const proto = request.headers.get('x-forwarded-proto') || 'https'
      const host = request.headers.get('host')
      const fullUrl = proto + '://' + host
      const result = await setupWebhook(env, fullUrl)
      return new Response(JSON.stringify({ telegram: result, pakasir_webhook: fullUrl + '/pakasir-webhook', duitku_webhook: fullUrl + '/duitku-webhook', duitku_return: fullUrl + '/duitku-return' }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({
        ok: true,
        mode: Mode || 'production',
        bot: !!env.BOT_TOKEN,
        owner: env.OWNER_ID
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    return new Response('Not found', { status: 404 })
  },

  async scheduled(event, env, ctx) {
    await initDb(env)
    await initConfig(env)
    if (event.cron === '* * * * *') {
      ctx.waitUntil(checkPendingPayments(env))
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(autoBackup(env))
      ctx.waitUntil(cleanupClosedTickets(env))
    }
  }
}
