import { InvoiceLogger, SimulatePayment, NamaBot } from './config.js'
import { readJSON, writeJSON, writeText, deleteKey, existsKey } from './kv.js'
import { tgSendMessage, tgSendDocument, tgDeleteMessage, tgEditMessageCaption, tgSendSticker } from './telegram.js'
import { escapeMarkdown, ParseIdr, formatWIB, getDate, getTanggalJam, generateTrxId, parseExpiredWIB, sansBold, escHtml, stokLayakJual } from './helpers.js'
import { pakasirDetail } from './pakasir.js'
import { duitkuStatus } from './duitku.js'
import { getMainMenuKeyboard } from './keyboard.js'
import { acquireLock, releaseLock } from './user.js'

async function resolveGw(env, provider, snap) {
  // Ambil apiKey dari config live — tidak disimpan di KV bersama sesi
  try {
    const { getPayCfg, getGateway } = await import('./pakasir.js')
    const live = getGateway(await getPayCfg(env), provider) || {}
    return { ...(snap || {}), ...live }
  } catch (e) { return snap }
}

async function clearOwnerOrderState(env, session) {
  try {
    const d = session.depositDetails
    if (!d || d.type !== 'purchase' || d.userId === undefined) return
    const cur = await readJSON(env, 'orderState_' + d.userId, null)
    if (cur && cur.trxId && String(cur.trxId) !== String(session.id)) return
    await deleteKey(env, 'orderState_' + d.userId)
  } catch (e) {}
}

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
      const expiredDate = parseExpiredWIB(details.expired)
      if (expiredDate instanceof Date ? isNaN(expiredDate.getTime()) : !expiredDate) {
        console.warn('[cron] expired invalid, anggap kedaluwarsa: ' + session.id)
        await handleExpiredPayment(env, session)
        continue
      }
      try {
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
          if (trxStat.amount === undefined || trxStat.amount === null) {
            // Fail-closed: nominal tak terbaca → jangan fulfill
            console.warn('[cron] Saweria PAID tanpa nominal, tolak: ' + session.id)
            stillPending.push(session)
            continue
          } else if (Number(trxStat.amount) !== Number(details.total_amount)) {
            console.warn('[cron] Saweria nominal mismatch, skip: ' + session.id)
            stillPending.push(session)
            continue
          }
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
        const { amountsMatch } = await import('./pakasir.js')
        const trxDetail = await pakasirDetail(await resolveGw(env, 'pakasir', details.pakasir_gw), session.id, details.pakasir_amount)
        if (trxDetail && trxDetail.status === 'completed') {
          if (!amountsMatch(trxDetail.total_payment ?? details.pakasir_amount, details.pakasir_amount)) {
            console.warn('[cron] Pakasir nominal mismatch, skip: ' + session.id)
            stillPending.push(session)
            continue
          }
          await processPaymentSuccess(env, session, trxDetail)
          processed = true
        }
      }
      if (details.provider === 'duitku' && details.duitku_gw) {
        const trxStat = await duitkuStatus(await resolveGw(env, 'duitku', details.duitku_gw), session.id)
        if (trxStat && String(trxStat.statusCode) === '00') {
          if (trxStat.amount === undefined || trxStat.amount === null) {
            // Fail-closed: nominal tak terbaca → jangan fulfill
            console.warn('[cron] Duitku success tanpa nominal, tolak: ' + session.id)
            stillPending.push(session)
            continue
          }
          if (Number(trxStat.amount) !== Number(details.duitku_amount)) {
            console.warn('[cron] Duitku nominal mismatch, skip: ' + session.id)
            stillPending.push(session)
            continue
          }
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
  // Merge: sesi yang lahir saat cron polling jangan ikut terhapus oleh snapshot basi
  try {
    const fresh = await readJSON(env, 'SessionDeposit', [])
    const keep = new Set(stillPending.map(s => s.id))
    for (const s of fresh) {
      if (!keep.has(s.id) && s.status === 'pending') { stillPending.push(s); keep.add(s.id) }
    }
  } catch (e) {}
  await writeJSON(env, 'SessionDeposit', stillPending)
}

async function handleExpiredPayment(env, session) {
  const details = session.depositDetails
  if (!details) return
  // QRIS purchase: kembalikan stok yang di-reserve saat QR dibuat
  if (details.type === 'purchase' && details.reserved && Array.isArray(details.reserved) && details.reserved.length > 0) {
    try { await releaseReservedStock(env, details.id, details.reserved) } catch (e) {}
  }
  if (details.provider === 'pakasir' && details.pakasir_gw) {
    try { const { pakasirCancel } = await import('./pakasir.js'); await pakasirCancel(await resolveGw(env, 'pakasir', details.pakasir_gw), session.id, details.pakasir_amount) } catch (e) {}
  }
  // duitku: tidak ada API cancel/void — invoice tetap hidup di sisi Duitku; pembayaran telat
  // masuk berstatus not_found (dana nyangkut, perlu refund manual). Catat agar terlacak.
  if (details.provider === 'duitku') {
    console.warn('[expired] invoice Duitku tak bisa di-void, sesi dibuang: ' + session.id + ' amount=' + details.duitku_amount)
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

// ─── Reserve stok QRIS: ambil fisik saat QR dibuat, lepas di batal/expired ───
// Sukses tidak melepas (stok sudah jadi milik pembeli). Idempoten via flag di sesi.
async function reserveStock(env, variantId, qty) {
  const lock = 'pay_stock_' + variantId
  if (!(await acquireLock(env, lock, 15))) return null
  try {
    const produk = await readJSON(env, 'Produk', [])
    const idx = produk.findIndex(pr => String(pr.id) === String(variantId))
    if (idx === -1) return null
    // Q2: reserve dari stok layak jual dulu — kadaluarsa tak ikut terjual.
    const raw = produk[idx].stok || []
    const layak = stokLayakJual(raw)
    if (layak.length < qty) return null
    const taken = layak.slice(0, qty)
    const takenSet = new Set(taken)
    produk[idx].stok = raw.filter(s => !takenSet.has(s))
    await writeJSON(env, 'Produk', produk)
    return taken
  } finally {
    await releaseLock(env, lock)
  }
}
async function releaseReservedStock(env, variantId, items) {
  if (!items || items.length === 0) return
  const lock = 'pay_stock_' + variantId
  if (!(await acquireLock(env, lock, 15))) { console.warn('[reserve] release lock gagal: ' + variantId); return }
  try {
    const produk = await readJSON(env, 'Produk', [])
    const idx = produk.findIndex(pr => String(pr.id) === String(variantId))
    if (idx === -1) {
      console.warn('[reserve] varian hilang saat release, stok reserve hangus: ' + variantId)
      return
    }
    produk[idx].stok = items.concat(produk[idx].stok || [])
    await writeJSON(env, 'Produk', produk)
  } finally {
    await releaseLock(env, lock)
  }
}

async function processPaymentSuccess(env, session, matchData) {
  const details = session.depositDetails
  if (!details) return

  const doneKey = 'pay_done_' + session.id
  // Klaim atomik: dbPutIfAbsent menang sekali; fallback: lock pay_done_ sebelum check-then-set
  let claimed = false
  try {
    const { dbPutIfAbsent } = await import('./db.js')
    if (typeof dbPutIfAbsent === 'function') claimed = await dbPutIfAbsent(env, doneKey, '1', { expirationTtl: 30 * 24 * 3600 })
  } catch (e) {}
  if (!claimed) {
    const claimLock = 'claim_' + session.id
    if (!(await acquireLock(env, claimLock, 10))) return
    try {
      if (await existsKey(env, doneKey)) return
      await writeText(env, doneKey, '1', { expirationTtl: 30 * 24 * 3600 })
    } finally {
      await releaseLock(env, claimLock)
    }
  }
  if (details.type === 'deposit') {
    const { addSaldo, cekSaldo } = await import('./user.js')
    await addSaldo(env, details.userId, details.amount)
    const saldo = await cekSaldo(env, details.userId)
    try { if (details.key) await tgDeleteMessage(env, details.userId, details.key) } catch (e) {}
    const wkt = getTanggalJam().tanggal + ' ' + getTanggalJam().jam
    const depMsg = sansBold('TRANSAKSI ANDA SUKSES') + '\n'
      + '<blockquote>Saldo ' + ParseIdr(details.amount) + ' masuk ke akun kamu</blockquote>\n'
      + '<pre>\u00bb Jumlah : ' + ParseIdr(details.amount) + '\n\u00bb Saldo  : ' + ParseIdr(saldo) + '\n\u00bb Waktu  : ' + wkt + '</pre>\n'
      + 'ID: <code>' + escHtml(session.id) + '</code>'
      await tgSendMessage(env, details.userId, depMsg, getMainMenuKeyboard(), 'HTML')
    try {
      const dtrx = await readJSON(env, 'Trx', [])
      dtrx.push({
        trxid: session.id, user_id: details.userId, tipe: 'deposit',
        produk: 'Deposit Saldo', varian: '-', jumlah: 1,
        total: details.amount, saldo: saldo, payment_method: 'QRIS',
        tanggal: new Date().toISOString(), status: 'Lunas'
      })
      await writeJSON(env, 'Trx', dtrx)
    } catch (e) {}
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
      // Stok reserve kembali ke etalase (refund uang di bawah)
      if (details.reserved && Array.isArray(details.reserved) && details.reserved.length > 0) {
        try { await releaseReservedStock(env, details.id, details.reserved) } catch (e) {}
      }
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
      await clearOwnerOrderState(env, session)
      return
    }
  }

  // SUKSES QRIS: stok sudah di-reserve saat QR dibuat → alur bawah pakai reserve (bukan ambil ulang)

  // Lock stok produk (samakan jalur saldo): cegah 2 buyer QRIS oversell snapshot basi
  const stockLock = 'pay_stock_' + details.id
  if (!(await acquireLock(env, stockLock, 15))) { console.warn('[pay] stok lock gagal: ' + session.id); return }
  let produk
  try {
    produk = await readJSON(env, 'Produk', [])
  } catch (e) { await releaseLock(env, stockLock); return }
  const releaseStock = async () => { try { await releaseLock(env, stockLock) } catch (e) {} }
  const p = produk.find(pr => pr.id === details.id)
  if (!p) {
    const { addSaldo, cekSaldo } = await import('./user.js')
    const refundAmt = Number(details.total_amount) || 0
    // Kembalikan stok reserve ke gudang darurat (StokYatim) agar tidak hilang tanpa tercatat
    if (details.reserved && Array.isArray(details.reserved) && details.reserved.length > 0) {
      try {
        const yatim = await readJSON(env, 'StokYatim', [])
        yatim.push({ variantId: details.id, varian: details.produk_nama || '-', items: details.reserved, trx: session.id, tanggal: new Date().toISOString(), sebab: 'Produk dihapus admin saat pembayaran lunas' })
        await writeJSON(env, 'StokYatim', yatim)
      } catch (e) {}
    }
    const newBal = await addSaldo(env, details.userId, refundAmt)
    let msg = '*⚠️ TRANSAKSI GAGAL (PRODUK HILANG)*\n\n'
    msg += 'Pembayaran Anda berhasil, namun produk sudah dihapus dari toko.\n\n'
    msg += '💵 *' + ParseIdr(refundAmt) + ' otomatis dikembalikan ke SALDO*\n'
    msg += 'Saldo baru: ' + ParseIdr(newBal || 0)
    if (details.reserved && Array.isArray(details.reserved) && details.reserved.length > 0) {
      msg += '\n\n📦 Stok pesanan Anda (' + details.reserved.length + ' item) diamankan admin — hubungi admin untuk pengiriman manual.'
    }
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
    await clearOwnerOrderState(env, session)
    await releaseStock()
    return
  }
  const produkIdx = produk.findIndex(pr => pr.id === details.id)
  const stokList = stokLayakJual(produk[produkIdx].stok)
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
    await clearOwnerOrderState(env, session)
    await releaseStock()
    return
  }
  const ambilStok = (details.reserved && details.reserved.length >= jumlahPesanan)
    ? details.reserved.slice(0, jumlahPesanan) // reserve saat QR dibuat — bukan ambil ulang
    : stokList.slice(0, jumlahPesanan)
  // Stok fisik sudah berkurang saat reserve; kurangi hanya bila sesi lama tanpa reserve
  if (!(details.reserved && details.reserved.length >= jumlahPesanan)) {
    produk[produkIdx].stok = stokList.slice(jumlahPesanan)
    await writeJSON(env, 'Produk', produk)
  } else {
    const sisaR = details.reserved.slice(jumlahPesanan)
    if (sisaR.length > 0) { try { await releaseReservedStock(env, details.id, sisaR) } catch (e) {} }
  }
  await releaseStock()
  // OrderCounter: lindungi increment dengan lock
  if (await acquireLock(env, 'order_counter', 10)) {
    try {
      let orderCounter = await readJSON(env, 'OrderCounter', 0)
      orderCounter++
      await writeJSON(env, 'OrderCounter', orderCounter)
    } finally {
      await releaseLock(env, 'order_counter')
    }
  }
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
  let suc = 'PEMBAYARAN TERKONFIRMASI ✅\n'
  + 'Terima kasih, pembayaran Anda telah diterima!\n\n'
  + 'Rincian Pesanan:\n'
  + '╭ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ╮\n'
  + '┊ Produk: ' + escapeMarkdown(details.produk) + '\n'
  + '┊ Variasi: ' + escapeMarkdown(details.produk_nama) + '\n'
  + '┊ Jumlah Pesanan: x' + jumlahPesanan + '\n'
  + '┊ Total Pembayaran: ' + ParseIdr(details.total_amount) + '\n'
  + '╰ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ╯\n\n'
  + 'ID Transaksi:\n'
  + '`' + session.id + '`\n\n'
  + 'Terimakasih Sudah Membeli Di Toko Kami\n'
  + '🔗 Akun dikirim di file .txt di bawah 👇'
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
  // 1) kirim caption dulu, 2) file .txt dikirim setelahnya (tombol menu melekat di file)
  await tgSendMessage(env, details.userId, suc, null, 'Markdown')
  const cfg = await readJSON(env, 'BotConfig', {})
  if (cfg.successSticker) {
    await tgSendDocument(env, details.userId, fileContent, session.id + '.txt', '')
    await tgSendSticker(env, details.userId, cfg.successSticker, getMainMenuKeyboard())
  } else {
    await tgSendDocument(env, details.userId, fileContent, session.id + '.txt', '', getMainMenuKeyboard())
  }
  if (InvoiceLogger) {
    // Dihapus: duplikat. Notif sukses tunggal dikirim via sendTxLog di bawah
    // (target = BotConfig.ChannelLog dgn dukungan thread topik grup).
  }
  const { sendTxLog } = await import('./messages.js')
  const { isOwner, getRole } = await import('./user.js')
  await sendTxLog(env, {
    type: 'success',
    user: { username: details.nama, id: details.userId },
    produk: details.produk,
    varian: details.produk_nama,
    total: details.total_amount,
    qty: jumlahPesanan,
    provider: details.provider || 'qris',
    role: (isOwner(details.userId) ? 'Owner' : ((await getRole(env, details.userId)) ? 'Admin' : 'User')),
    fileTxtContent: fileContent,
    fileName: session.id + '.txt'
  })
  await clearOwnerOrderState(env, session)
}

export { checkPendingPayments, processPaymentSuccess, handleExpiredPayment, reserveStock, releaseReservedStock }
