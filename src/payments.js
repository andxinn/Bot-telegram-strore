import { InvoiceLogger, SimulatePayment, NamaBot } from './config.js'
import { readJSON, writeJSON, writeText, deleteKey, existsKey } from './kv.js'
import { tgSendMessage, tgSendDocument, tgDeleteMessage, tgEditMessageCaption, tgSendSticker } from './telegram.js'
import { escapeMarkdown, ParseIdr, formatWIB, getDate, getTanggalJam, generateTrxId, parseExpiredWIB } from './helpers.js'
import { pakasirDetail } from './pakasir.js'
import { duitkuStatus } from './duitku.js'
import { getMainMenuKeyboard } from './keyboard.js'
import { acquireLock, releaseLock } from './user.js'

async function checkPendingPayments(env) {
  const sessions = await readJSON(env, 'SessionDeposit', [])
  if (sessions.length === 0) return
  const stillPending = []
  const now = new Date()
  for (const session of sessions) {
    if (session.status !== 'pending') continue
    const details = session.depositDetails
    if (!details) { continue }
    const lockKey = 'pay_process_' + session.id
    const gotLock = await acquireLock(env, lockKey, 15)
    if (!gotLock) {
      stillPending.push(session)
      continue
    }

    try {
      try {
        const expiredDate = parseExpiredWIB(details.expired)
        if (now > expiredDate) {
          await handleExpiredPayment(env, session)
          continue
        }
      } catch (e) {}
      if (SimulatePayment) {
        await processPaymentSuccess(env, session, {})
        continue
      }
      let processed = false
      if (details.provider === 'saweria' && details.saweria_id) {
        const { saweriaStatus } = await import('./saweria.js')
        const trxStat = await saweriaStatus(null, details.saweria_id)
        if (trxStat && trxStat.ok && trxStat.status === 'PAID') {
          await processPaymentSuccess(env, session, {
            status: 'completed', reference: details.saweria_id,
            amount: Number(details.total_amount), gateway: 'saweria'
          })
          processed = true
        } else if (trxStat && trxStat.ok && trxStat.status === 'EXPIRED') {
          await handleExpiredPayment(env, session)
          processed = true
        }
      }
      if (details.provider === 'pakasir' && details.pakasir_gw) {
        const trxDetail = await pakasirDetail(details.pakasir_gw, session.id, details.pakasir_amount)
        if (trxDetail && trxDetail.status === 'completed') {
          await processPaymentSuccess(env, session, trxDetail)
          processed = true
        }
      }
      if (details.provider === 'duitku' && details.duitku_gw) {
        const trxStat = await duitkuStatus(details.duitku_gw, session.id)
        if (trxStat && String(trxStat.statusCode) === '00') {
          await processPaymentSuccess(env, session, {
            status: 'completed', reference: trxStat.reference,
            amount: Number(trxStat.amount || details.duitku_amount), gateway: 'duitku'
          })
          processed = true
        }
      }
      if (!processed) {
        stillPending.push(session)
      }
    } finally {
      await releaseLock(env, lockKey)
    }
  }
  await writeJSON(env, 'SessionDeposit', stillPending)
}

async function handleExpiredPayment(env, session) {
  const details = session.depositDetails
  if (!details) return
  if (details.provider === 'pakasir' && details.pakasir_gw) {
    try { const { pakasirCancel } = await import('./pakasir.js'); await pakasirCancel(details.pakasir_gw, session.id, details.pakasir_amount) } catch (e) {}
  }
  // saweria: tidak ada API cancel — donasi pending akan expired sendiri di sisi Saweria
  try {
    if (details.key) {
      await tgDeleteMessage(env, details.userId, details.key)
    }
  } catch (e) {}
  const expMin = Number(details.expiryMinutes) > 0 ? Number(details.expiryMinutes) : 5
  await tgSendMessage(env, details.userId, escapeMarkdown('╭───〔 ⏱️ KADALUWARSA 〕──\n┊ *ID     :* ' + session.id + '\n┊ *Jumlah :* ' + ParseIdr(details.total_amount) + '\n╰──────────────────\n\nTransaksi dibatalkan karena tidak dibayar dalam ' + expMin + ' menit.'), getMainMenuKeyboard())
  if (InvoiceLogger) {
    await tgSendMessage(env, InvoiceLogger, escapeMarkdown('*\u23b1 Transaksi Kadaluwarsa*\nID: ' + session.id + '\nUser: ' + details.nama + '\nAmount: ' + ParseIdr(details.total_amount)))
  }
  const { sendTxLog } = await import('./messages.js')
  await sendTxLog(env, {
    type: 'failed',
    user: { username: details.nama, id: details.userId },
    produk: details.produk || '-',
    varian: details.produk_nama || '-',
    total: details.total_amount,
    reason: 'Kedaluwarsa (Tidak dibayar)'
  })
}

async function processPaymentSuccess(env, session, matchData) {
  const details = session.depositDetails
  if (!details) return

  const doneKey = 'pay_done_' + session.id
  if (await existsKey(env, doneKey)) return
  await writeText(env, doneKey, '1', { expirationTtl: 30 * 24 * 3600 })
  if (details.type === 'deposit') {
    const { addSaldo, cekSaldo } = await import('./user.js')
    await addSaldo(env, details.userId, details.amount)
    const saldo = await cekSaldo(env, details.userId)
    try { if (details.key) await tgDeleteMessage(env, details.userId, details.key) } catch (e) {}
    await tgSendMessage(env, details.userId, escapeMarkdown('*\ud83e\uddfe DEPOSIT BERHASIL \u2705*\n\nJumlah: ' + ParseIdr(details.amount) + '\nSaldo: ' + ParseIdr(saldo) + '\n\nID: ' + session.id), getMainMenuKeyboard())
    if (InvoiceLogger) {
      const tj = getTanggalJam()
      await tgSendMessage(env, InvoiceLogger, escapeMarkdown('*DEPOSIT BERHASIL \u2705*\n\nUser: ' + details.nama + '\nAmount: ' + ParseIdr(details.amount) + '\nTanggal: ' + tj.tanggal + ' ' + tj.jam))
    }
    return
  }

  // ══ v9update18: auto-cancel if flash sale expired ══
  if (details.type === 'purchase' && details.flashSaleExpiresAt) {
    const nowMs = Date.now()
    if (nowMs > Number(details.flashSaleExpiresAt)) {
      const { addSaldo } = await import('./user.js')
      const refundAmt = Number(details.total_amount) || 0
      const newBal = await addSaldo(env, details.userId, refundAmt)
      try { if (details.key) await tgDeleteMessage(env, details.userId, details.key) } catch (e) {}
      let msg = '*⚠️ ORDER DIBATALKAN*\n\n'
      msg += 'Maaf, flash sale sudah berakhir sebelum pembayaran kamu masuk.\n\n'
      msg += '🆔 Order : `' + session.id + '`\n'
      msg += '📦 Produk: ' + (details.produk_nama || details.produk || '-') + '\n'
      msg += '💰 Total : ' + ParseIdr(refundAmt) + '\n\n'
      msg += '💵 *' + ParseIdr(refundAmt) + ' dikembalikan ke SALDO*\n'
      msg += 'Saldo baru: ' + ParseIdr(newBal || 0) + '\n\n'
      msg += '_Silakan order ulang dengan harga normal._'
      await tgSendMessage(env, details.userId, msg, getMainMenuKeyboard(), 'Markdown')
      if (InvoiceLogger) {
        await tgSendMessage(env, InvoiceLogger,
          '*⚠️ FS EXPIRED — AUTO CANCEL*\nUser: ' + (details.nama || '-') + '\nTrx: ' + session.id + '\nAmount: ' + ParseIdr(refundAmt) + '\nRefund → saldo user (baru: ' + ParseIdr(newBal || 0) + ')'
        )
      }
      const { sendTxLog } = await import('./messages.js')
      await sendTxLog(env, {
        type: 'failed',
        user: { username: details.nama, id: details.userId },
        produk: details.produk || '-',
        varian: details.produk_nama || '-',
        total: refundAmt,
        reason: 'Flash Sale berakhir sebelum pembayaran (refund)'
      })
      return
    }
  }

  const produk = await readJSON(env, 'Produk', [])
  const p = produk.find(pr => pr.id === details.id)
  if (!p) {
    const { addSaldo, cekSaldo } = await import('./user.js')
    const refundAmt = Number(details.total_amount) || 0
    const newBal = await addSaldo(env, details.userId, refundAmt)
    let msg = '*⚠️ TRANSAKSI GAGAL (PRODUK HILANG)*\n\n'
    msg += 'Pembayaran Anda berhasil, namun produk sudah dihapus dari toko.\n\n'
    msg += '💵 *' + ParseIdr(refundAmt) + ' otomatis dikembalikan ke SALDO*\n'
    msg += 'Saldo baru: ' + ParseIdr(newBal || 0)
    await tgSendMessage(env, details.userId, msg, getMainMenuKeyboard(), 'Markdown')
    if (InvoiceLogger) {
      await tgSendMessage(env, InvoiceLogger, escapeMarkdown('*\u26a0 PRODUK HILANG saat pembayaran sukses!*\nUser: ' + details.nama + '\nTrx: ' + session.id + '\nAmount: ' + ParseIdr(details.total_amount) + '\nRefund otomatis ke saldo.'))
    }
    const { sendTxLog } = await import('./messages.js')
    await sendTxLog(env, {
      type: 'failed',
      user: { username: details.nama, id: details.userId },
      produk: details.produk || '-',
      varian: details.produk_nama || '-',
      total: details.total_amount,
      reason: 'Produk dihapus admin saat pembayaran lunas (Auto-refund)'
    })
    return
  }
  const produkIdx = produk.findIndex(pr => pr.id === details.id)
  const stokList = produk[produkIdx].stok || []
  const jumlahPesanan = details.cart
  if (stokList.length < jumlahPesanan) {
    const { addSaldo } = await import('./user.js')
    const refundAmt = Number(details.total_amount) || 0
    const newBal = await addSaldo(env, details.userId, refundAmt)
    let msg = '*⚠️ TRANSAKSI GAGAL (STOK HABIS)*\n\n'
    msg += 'Pembayaran Anda berhasil, namun stok produk tidak mencukupi (Tersisa: ' + stokList.length + ', Pesanan: ' + jumlahPesanan + ').\n\n'
    msg += '💵 *' + ParseIdr(refundAmt) + ' otomatis dikembalikan ke SALDO*\n'
    msg += 'Saldo baru: ' + ParseIdr(newBal || 0)
    await tgSendMessage(env, details.userId, msg, getMainMenuKeyboard(), 'Markdown')
    if (InvoiceLogger) {
      await tgSendMessage(env, InvoiceLogger, escapeMarkdown('*\u26a0 Stok tidak cukup saat pembayaran sukses!*\nUser: ' + details.nama + '\nTrx: ' + session.id + '\nRefund otomatis ke saldo.'))
    }
    const { sendTxLog } = await import('./messages.js')
    await sendTxLog(env, {
      type: 'failed',
      user: { username: details.nama, id: details.userId },
      produk: details.produk || '-',
      varian: details.produk_nama || '-',
      total: details.total_amount,
      reason: 'Stok tidak cukup saat pembayaran lunas (Auto-refund)'
    })
    return
  }
  const ambilStok = stokList.slice(0, jumlahPesanan)
  produk[produkIdx].stok = stokList.slice(jumlahPesanan)
  await writeJSON(env, 'Produk', produk)
  let orderCounter = await readJSON(env, 'OrderCounter', 0)
  orderCounter++
  await writeJSON(env, 'OrderCounter', orderCounter)
  const trx = await readJSON(env, 'Trx', [])
  trx.push({
    trxid: session.id, user_id: details.userId, produk: details.produk,
    varian: details.produk_nama, jumlah: jumlahPesanan, total: details.total_amount,
    tanggal: new Date().toISOString(), status: 'Lunas',
    stok_dibeli: ambilStok.map(s => s.info || s)
  })
  await writeJSON(env, 'Trx', trx)
  // Sukses: hapus pesan QR agar kode QR hilang otomatis; detail dikirim di bawah
  try { if (details.key) await tgDeleteMessage(env, details.userId, details.key) } catch (e) {}
  const snkList = await readJSON(env, 'SnK', [])
  const kategoriList = await readJSON(env, 'Kategori', [])
  const katMatch = kategoriList.find(k => String(k.produkId) === String(p.category))
  const snkData = katMatch ? snkList.find(s => String(s.id) === String(katMatch.id)) : null
  const snkText = snkData ? snkData.snk : 'Tidak ada syarat dan ketentuan'
  let suc = '*PEMBELIAN BERHASIL \u2705*\nTerima kasih, telah melakukan pembelian produk kami!\n\n*Rincian Pesanan:*\n\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e  \n\u2502 *Produk:* ' + details.produk + '\n\u2502 *Variasi:* ' + details.produk_nama + '\n\u2502 *Jumlah Pesanan:* x' + jumlahPesanan + '  \n\u2502 *Total Pembayaran:* ' + ParseIdr(details.total_amount) + ' \n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f  \n\nID Transaksi:\n`' + session.id + '`'
  let fileContent = 'INFO ORDER\n'
  fileContent += 'Nomor: ' + session.id + '\n'
  fileContent += 'Tanggal: ' + formatWIB(new Date().toISOString()) + '\n'
  fileContent += 'Produk: ' + details.produk + '\n'
  fileContent += 'Variasi: ' + details.produk_nama + '\n'
  fileContent += 'Jumlah: ' + jumlahPesanan + '\n'
  fileContent += 'Total: ' + ParseIdr(details.total_amount) + '\n\n'
  fileContent += 'PRODUK:\n'
  fileContent += ambilStok.map(s => s.info || (typeof s === 'string' ? s : JSON.stringify(s))).map((item, i) => (i + 1) + '. ' + item).join('\n')
  fileContent += '\n\nSYARAT & KETENTUAN:\n' + snkText
  fileContent += '\n\nTerima kasih sudah berbelanja!\n' + (NamaBot || '')
  const cfg = await readJSON(env, 'BotConfig', {})
  if (cfg.successSticker) {
    await tgSendDocument(env, details.userId, fileContent, session.id + '.txt', escapeMarkdown(suc))
    await tgSendSticker(env, details.userId, cfg.successSticker, getMainMenuKeyboard())
  } else {
    await tgSendDocument(env, details.userId, fileContent, session.id + '.txt', escapeMarkdown(suc), getMainMenuKeyboard())
  }
  if (InvoiceLogger) {
    const tj = getTanggalJam()
    let logPesan = '*PRODUK DIBELI \u2705*\n\n\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e  \n\u2502 *Nama:* ' + details.nama + '\n\u2502 *Produk:* ' + details.produk + '\n\u2502 *Variasi:* ' + details.produk_nama + '\n\u2502 *Jumlah:* x' + jumlahPesanan + '\n\u2502 *Total:* ' + ParseIdr(details.total_amount) + '\n\u2502 *Tanggal:* ' + tj.tanggal + ' ' + tj.jam + '\n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f  \n\nID Transaksi:\n`' + session.id + '`'
    const logKeyboard = { inline_keyboard: [[{ text: 'Chat User \ud83d\udce9', url: 'tg://user?id=' + details.userId }]] }
    await tgSendMessage(env, InvoiceLogger, escapeMarkdown(logPesan), logKeyboard)
  }
  const { sendTxLog } = await import('./messages.js')
  await sendTxLog(env, {
    type: 'success',
    user: { username: details.nama, id: details.userId },
    produk: details.produk,
    varian: details.produk_nama,
    total: details.total_amount,
    fileTxtContent: fileContent,
    fileName: session.id + '.txt'
  })
}

export { checkPendingPayments, processPaymentSuccess, handleExpiredPayment }
