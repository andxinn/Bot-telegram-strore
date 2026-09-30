import { NamaBot, StoreName, OwnerID, InvoiceLogger, BannerFileId, SimulatePayment, SimulateDelay, orderBotName } from './config.js'
import { readJSON, writeJSON, deleteKey, readText, writeText, existsKey } from './kv.js'
import { tgSendMessage, tgSendPhoto, tgSendPhotoFile, tgSendPhotoUrl, tgEditMessageText, tgEditMessageMedia, tgEditMessageCaption, tgDeleteMessage, tgAnswerCallbackQuery, tgSendDocument, tgSendDocumentFile, tgSendSticker, tgCloseForumTopic, tgDeleteForumTopic } from './telegram.js'
import { escapeMarkdown, mdSafe, ParseIdr, formatrupiah, formatWIB, getDate, getTanggalJam, generateTrxId, generateOrderId, expiredTime, parseExpiredWIB } from './helpers.js'
import { getUser, addUser, addSaldo, cekSaldo, minSaldo, isOwner, getRole, acquireLock, releaseLock } from './user.js'
import { getManagePanel, getMainMenuKeyboard } from './keyboard.js'
import { generateQris } from './qris.js'
import { getActiveGateway, pakasirConfigured, calcFee, feeLabel, methodLabel, pakasirCreate, pakasirCancel, pakasirDetail, pakasirSimulate, qrImageUrl } from './pakasir.js'
import { duitkuConfigured, duitkuCreateQris, providerLabel, qrImageUrl as dkQrImageUrl } from './duitku.js'
import { handleAdminCallback } from './admin.js'

async function editCard(env, cq, caption, keyboard, parseMode = 'Markdown') {
  const chatId = cq.message.chat.id
  const messageId = cq.message.message_id
  const isPhoto = !!cq.message.photo
  let res = null
  try {
    res = isPhoto
      ? await tgEditMessageCaption(env, chatId, messageId, caption, keyboard, parseMode)
      : await tgEditMessageText(env, chatId, messageId, caption, keyboard, parseMode)
  } catch (e) { res = null }
  if (res && (res.ok || (res.description && res.description.indexOf('not modified') !== -1))) return res
  // Fallback tanpa Markdown agar transisi kartu tidak pernah macet karena parse-error
  try {
    return isPhoto
      ? await tgEditMessageCaption(env, chatId, messageId, caption, keyboard, '')
      : await tgEditMessageText(env, chatId, messageId, caption, keyboard, '')
  } catch (e) { return res }
}

async function handleCallbackQuery(env, cq) {
  const data = cq.data
  const chatId = cq.message.chat.id
  const fromId = cq.from.id
  const messageId = cq.message.message_id
  const cqId = cq.id
  const fromName = cq.from.first_name || cq.from.username || 'User'
  const fromUsername = cq.from.username || 'Tidak ada username'

  // Admin panel callbacks
  if (data.startsWith('adm_') || data.startsWith('tk_adm_')) {
    await handleAdminCallback(env, cq)
    return
  }

  // ─── TICKETING CALLBACKS ───
  if (data === 'tk_create') {
    await tgAnswerCallbackQuery(env, cqId, '📝 Membuka formulir tiket bantuan', false)
    await writeJSON(env, 'ticketState_' + fromId, { step: 'input_msg', cardMessageId: messageId })
    await editCard(env, cq, '📝 *BUAT TIKET BARU*\n\nSilakan ketik dan kirimkan rincian kendala/masalah Anda secara lengkap (minimal 5 karakter).\n\n_Ketik /batal jika ingin membatalkan._', null)
    return
  }

  if (data === 'tk_list') {
    await tgAnswerCallbackQuery(env, cqId, '📋 Membuka daftar tiket Anda', false)
    const tickets = await readJSON(env, 'Tickets', [])
    const myTickets = tickets.filter(t => String(t.userId) === String(fromId))
    if (myTickets.length === 0) {
      await editCard(env, cq, '📭 Anda belum memiliki tiket laporan bantuan.', {
        inline_keyboard: [
          [{ text: '➕ Buat Tiket Baru', callback_data: 'tk_create' }],
          [{ text: '🔙 Menu Tiket', callback_data: 'tk_back_menu' }]
        ]
      })
      return
    }

    let cap = '╭───〔 📋 DAFTAR TIKET SAYA 〕───\n'
    cap += '┊ Berikut adalah riwayat tiket Anda.\n'
    cap += '┊ Klik salah satu tiket untuk detail.\n'
    cap += '╰──────────────────\n'

    const rows = []
    for (const t of myTickets.slice(0, 15)) {
      const stStyle = t.status === 'closed' ? 'success' : 'primary'
      const label = (t.status === 'closed' ? '🟢 ' : (t.status === 'answered' ? '🔵 [Balasan] ' : '🟡 ')) + t.ticketId
      rows.push([{ text: label, callback_data: 'tk_view_' + t.ticketId, style: stStyle }])
    }
    rows.push([{ text: '➕ Buat Tiket Baru', callback_data: 'tk_create' }])
    rows.push([{ text: '🔙 Menu Tiket', callback_data: 'tk_back_menu' }])

    await editCard(env, cq, cap, { inline_keyboard: rows })
    return
  }

  if (data.startsWith('tk_view_')) {
    const parts = data.replace('tk_view_', '').split('_')
    const tkId = parts[0]
    const page = parts[1] ? parseInt(parts[1]) : null

    const tickets = await readJSON(env, 'Tickets', [])
    const t = tickets.find(ticket => ticket.ticketId === tkId)
    if (!t) {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true)
      return
    }
    if (String(t.userId) !== String(fromId) && !isOwner(fromId) && await getRole(env, fromId) !== 'admin') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan tiket Anda.', true)
      return
    }
    await tgAnswerCallbackQuery(env, cqId, '🎫 Membuka rincian tiket', false)

    const escH = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const userUsn = t.userUsername ? '@' + t.userUsername : (t.userName || 'User')
    const statusLabel = t.status === 'closed' ? '✅ Selesai' : (t.status === 'answered' ? '🔵 Ada Balasan' : '⏳ Menunggu Admin')

    let cap = '╭───〔 🎫 TIKET: ' + t.ticketId + ' 〕───\n'
    cap += '┊ Status: ' + statusLabel + '\n'
    cap += '╰──────────────────\n\n'

    const msgs = t.messages || []
    const limit = 5
    const totalPages = Math.ceil(msgs.length / limit) || 1
    
    let activePage = page
    if (activePage === null) {
      activePage = totalPages
    }
    activePage = Math.max(1, Math.min(activePage, totalPages))

    const startIdx = (activePage - 1) * limit
    const visibleMsgs = msgs.slice(startIdx, startIdx + limit)

    visibleMsgs.forEach((m, idx) => {
      const timeStr = m.time ? ' (' + m.time + ')' : ''
      if (m.sender === 'user') {
        const sn = m.username || ('@' + userUsn)
        cap += '<b>' + escH(sn) + '</b>' + escH(timeStr) + '\npesan : ' + escH(m.text) + '\n'
      } else {
        cap += '<blockquote><b>ADMIN</b>' + escH(timeStr) + '\npesan : ' + escH(m.text) + '</blockquote>'
      }
      if (idx < visibleMsgs.length - 1) {
        cap += '<code>──────────────────</code>\n'
      }
    })

    if (totalPages > 1) {
      cap += '\n📖 <i>Halaman ' + activePage + ' dari ' + totalPages + '</i>\n'
    }

    const rows = []
    
    // Navigation row
    if (totalPages > 1) {
      const navRow = []
      if (activePage > 1) {
        navRow.push({ text: '◀️ Sebelumnya', callback_data: 'tk_view_' + t.ticketId + '_' + (activePage - 1) })
      }
      navRow.push({ text: 'Hal ' + activePage + '/' + totalPages, callback_data: 'noop' })
      if (activePage < totalPages) {
        navRow.push({ text: 'Selanjutnya ▶️', callback_data: 'tk_view_' + t.ticketId + '_' + (activePage + 1) })
      }
      rows.push(navRow)
    }

    // Media buttons row
    visibleMsgs.forEach((m, idx) => {
      const globalIdx = startIdx + idx
      if (m.photoFileId) {
        rows.push([{ text: '🖼️ Lihat Foto (Pesan ' + (globalIdx + 1) + ')', callback_data: 'tk_media_' + t.ticketId + '_' + globalIdx }])
      } else if (m.docFileId) {
        rows.push([{ text: '📄 Unduh ' + (m.docName || 'File') + ' (Pesan ' + (globalIdx + 1) + ')', callback_data: 'tk_media_' + t.ticketId + '_' + globalIdx }])
      }
    })

    if (t.status === 'answered') {
      cap += '\nApakah masalah ini sudah selesai?'
      rows.push([
        { text: '✅ Selesai', callback_data: 'tk_close_' + t.ticketId, style: 'success' },
        { text: '💬 Balas Pesan', callback_data: 'tk_follow_' + t.ticketId, style: 'primary' }
      ])
    } else if (t.status === 'open') {
      rows.push([{ text: '➕ Follow Up Chat', callback_data: 'tk_follow_' + t.ticketId }])
    }
    rows.push([{ text: '🔙 Daftar Tiket', callback_data: 'tk_list' }, { text: '🔙 Menu Tiket', callback_data: 'tk_back_menu' }])

    await editCard(env, cq, cap, { inline_keyboard: rows }, 'HTML')
    return
  }

  if (data === 'tk_media_close') {
    try {
      await tgDeleteMessage(env, chatId, messageId)
    } catch (e) {}
    await tgAnswerCallbackQuery(env, cqId, 'Dihapus', false)
    return
  }

  if (data.startsWith('tk_media_')) {
    const parts = data.replace('tk_media_', '').split('_')
    const tkId = parts[0]
    const msgIdx = parseInt(parts[1])

    const tickets = await readJSON(env, 'Tickets', [])
    const t = tickets.find(ticket => ticket.ticketId === tkId)
    if (!t || !t.messages || !t.messages[msgIdx]) {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Media tidak ditemukan.', true)
      return
    }
    if (String(t.userId) !== String(fromId) && !isOwner(fromId) && await getRole(env, fromId) !== 'admin') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan tiket Anda.', true)
      return
    }

    const m = t.messages[msgIdx]
    if (m.photoFileId) {
      await tgAnswerCallbackQuery(env, cqId, '🖼️ Mengirimkan foto...', false)
      const kb = { inline_keyboard: [[{ text: '❌ Tutup Gambar', callback_data: 'tk_media_close' }]] }
      const res = await tgSendPhoto(env, chatId, m.photoFileId, 'Gambar dari Tiket ' + tkId, kb)
      if (!res.ok) {
        await tgSendMessage(env, chatId, '⚠️ Gagal mengirimkan foto. File mungkin sudah kedaluwarsa di server Telegram.')
      }
    } else if (m.docFileId) {
      await tgAnswerCallbackQuery(env, cqId, '📄 Mengirimkan file...', false)
      const kb = { inline_keyboard: [[{ text: '❌ Tutup Berkas', callback_data: 'tk_media_close' }]] }
      const res = await tgSendDocumentFile(env, chatId, m.docFileId, 'Berkas dari Tiket ' + tkId, kb)
      if (!res.ok) {
        await tgSendMessage(env, chatId, '⚠️ Gagal mengirimkan berkas. File mungkin sudah kedaluwarsa di server Telegram.')
      }
    } else {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Tidak ada media di pesan ini.', true)
    }
    return
  }

  if (data.startsWith('tk_close_')) {
    const tkId = data.replace('tk_close_', '')
    const tickets = await readJSON(env, 'Tickets', [])
    const idx = tickets.findIndex(ticket => ticket.ticketId === tkId)
    if (idx === -1) {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true)
      return
    }
    const ownT = tickets[idx]
    if (String(ownT.userId) !== String(fromId) && !isOwner(fromId) && await getRole(env, fromId) !== 'admin') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan tiket Anda.', true)
      return
    }
    await tgAnswerCallbackQuery(env, cqId, '🔒 Tiket bantuan berhasil ditutup', false)
    if (idx !== -1) {
      const t = tickets[idx]
      t.status = 'closed'
      t.closedAt = Date.now()
      await writeJSON(env, 'Tickets', tickets)

      if (t.logChatId && t.threadId) {
        try {
          await tgDeleteForumTopic(env, t.logChatId, t.threadId)
        } catch (e) {}

        if (t.logMessageId) {
          try {
            const { buildGroupTicketLogText, buildGroupTicketLogKeyboard } = await import('./admin.js')
            const newText = buildGroupTicketLogText(t)
            const kb = buildGroupTicketLogKeyboard(t)
            await tgEditMessageText(env, t.logChatId, t.logMessageId, newText, kb, 'HTML')
          } catch (e) {}
        }
      }
    }
    cq.data = 'tk_view_' + tkId
    await handleCallbackQuery(env, cq)
    return
  }

  if (data.startsWith('tk_follow_')) {
    const tkId = data.replace('tk_follow_', '')
    const tickets = await readJSON(env, 'Tickets', [])
    const ft = tickets.find(ticket => ticket.ticketId === tkId)
    if (!ft) {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Tiket tidak ditemukan.', true)
      return
    }
    if (String(ft.userId) !== String(fromId) && !isOwner(fromId) && await getRole(env, fromId) !== 'admin') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan tiket Anda.', true)
      return
    }
    await tgAnswerCallbackQuery(env, cqId, '📝 Membuka formulir pesan tambahan', false)
    await writeJSON(env, 'ticketState_' + fromId, { step: 'follow_up', ticketId: tkId, cardMessageId: messageId })
    await editCard(env, cq, '📝 *FOLLOW UP TIKET: ' + tkId + '*\n\nSilakan ketik dan kirimkan pesan tambahan Anda untuk dikirim ke admin.\n\n_Ketik /batal jika batal._', null)
    return
  }

  if (data === 'tk_back_menu') {
    await tgAnswerCallbackQuery(env, cqId, '🔙 Kembali ke menu tiket', false)
    let cap = '╭───〔 🎫 TIKET BANTUAN 〕───\n'
    cap += '┊ Punya masalah atau butuh bantuan?\n'
    cap += '┊ Silakan buat tiket baru atau cek\n'
    cap += '┊ daftar tiket aktif Anda di bawah.\n'
    cap += '╰──────────────────\n\n'
    cap += 'Pilih opsi di bawah 👇:'
    const kb = {
      inline_keyboard: [
        [{ text: '➕ Buat Tiket Baru', callback_data: 'tk_create' }],
        [{ text: '📋 Daftar Tiket Saya', callback_data: 'tk_list' }],
        [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'to_menu' }]
      ]
    }
    await editCard(env, cq, cap, kb)
    return
  }

  if (data === 'noop') { await tgAnswerCallbackQuery(env, cqId, '', false); return }

  if (data === 'back_to_list') {
    await tgAnswerCallbackQuery(env, cqId, '📄 Membuka daftar produk', false)
    const listPage = await readJSON(env, 'listPage_' + fromId, 1)
    const { showProductList } = await import('./messages.js')
    try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
    await showProductList(env, chatId, fromId, fromName, listPage)
    return
  }

  if (data === 'main_menu' || data === 'to_menu') {
    await tgAnswerCallbackQuery(env, cqId, '🏠 Kembali ke menu utama', false)
    const user = await getUser(env, chatId) || await addUser(env, chatId, fromName)
    const kategori = await readJSON(env, 'Kategori', [])
    const { getReplyKeyboard } = await import('./keyboard.js')
    const keyboard = getReplyKeyboard(kategori)
    try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
    await tgSendMessage(env, chatId, 'Halo Kak *' + user.name + '* 😊\n\nSilakan pilih menu di bawah:', keyboard, 'Markdown')
    return
  }

  if (data.startsWith('cat_')) {
    const catId = parseInt(data.replace('cat_', ''))
    const kategori = await readJSON(env, 'Kategori', [])
    const kat = kategori.find(k => k.id === catId)
    if (!kat) { await tgAnswerCallbackQuery(env, cqId, 'Produk tidak ditemukan.', true); return }
    await tgAnswerCallbackQuery(env, cqId, '🛒 Membuka kategori ' + kat.produkName, false)
    const produk = await readJSON(env, 'Produk', [])
    const variants = produk.filter(pr => pr.category === kat.produkId)
    if (variants.length === 0) { await tgAnswerCallbackQuery(env, cqId, 'Belum ada varian.', true); return }
    const { buildVariantView } = await import('./messages.js')
    const fsAll = await readJSON(env, 'FlashSale', {})
    const nowFs = Date.now()
    const fsMap = {}
    for (const vv of variants) {
      const f = fsAll[String(vv.id)]
      if (f && f.expiresAt && nowFs < Number(f.expiresAt)) fsMap[String(vv.id)] = f
    }
    const trxAll = await readJSON(env, 'Trx', [])
    const sold = trxAll.filter(t => t.status === 'Lunas' && String(t.produk) === String(kat.produkName)).reduce((a, t) => a + (Number(t.jumlah) || 0), 0)
    const view = buildVariantView(kat, variants, fsMap, sold)
    await editCard(env, cq, view.caption, view.keyboard, view.parseMode)
    return
  }

  if (data === 'staff_call_cancel') {
    await tgAnswerCallbackQuery(env, cqId, 'Baik, panggilan dibatalkan.', false)
    await tgSendMessage(env, chatId, 'Baik kak, Admin tidak dipanggil ke session chat 😊.')
    return
  }

  if (data.startsWith('acceptcallyes_')) {
    const callerLock = 'staffcall_' + fromId
    if (!(await acquireLock(env, callerLock, 30))) { await tgAnswerCallbackQuery(env, cqId, '⏳ Tunggu sebentar sebelum memanggil lagi.', true); return }
    await tgAnswerCallbackQuery(env, cqId, '📞 Memanggil admin...', false)
    const userId = data.replace('acceptcallyes_', '')
    if (String(userId) === String(OwnerID)) {
      await tgSendMessage(env, chatId, 'Owner tidak dapat message ke diri sendiri.')
      return
    }
    const pendingKey = 'PMpending_' + userId
    if (await readJSON(env, pendingKey, null)) {
      await tgSendMessage(env, chatId, 'Kamu sudah meminta request chat ke admin. Harap tunggu.')
      return
    }
    await writeJSON(env, pendingKey, { userId })
    await tgSendMessage(env, chatId, '\ud83d\udcde Memanggil admin bot ke session chat...')
    const keyboard = { inline_keyboard: [[{ text: 'Ya', callback_data: 'accept_' + userId }, { text: 'Tidak', callback_data: 'reject_' + userId }]] }
    const user = await getUser(env, userId)
    let pmText = '\ud83d\udce9 Kami menerima private message dari : @' + (cq.from.username || 'Pengguna') + ' (' + userId + ')\nApakah kamu ingin menerima chat ini?'
    await tgSendMessage(env, OwnerID, escapeMarkdown(pmText), keyboard)
    return
  }

  if (data.startsWith('accept_')) {
    if (!isOwner(fromId) && await getRole(env, fromId) !== 'admin') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Akses ditolak.', true)
      return
    }
    const userId = data.replace('accept_', '')
    const user = await getUser(env, userId)
    const pendingKey = 'PMpending_' + userId
    const pending = await readJSON(env, pendingKey, null)
    if (!user || !pending) { await tgSendMessage(env, chatId, 'Terjadi kesalahan, user tidak ditemukan atau sudah kadaluarsa.'); return }
    await deleteKey(env, pendingKey)
    const sessions = await readJSON(env, 'PMSessions', [])
    sessions.push({ userChatId: parseInt(userId), ownerChatId: chatId })
    await writeJSON(env, 'PMSessions', sessions)
    const disconnectKeyboard = { keyboard: [[{ text: '🔴 Disconnect' }]], resize_keyboard: true }
    await tgSendMessage(env, userId, '🔗 *Kamu Terhubung Ke Chat Private!*\n\nSemua pesan kamu akan di forward ke owner bot ini.', disconnectKeyboard, 'Markdown')
    let ps = 'Kamu Terhubung Ke *' + user.name + '*\n\n• Username: ' + user.name + '\n• Bank ID: ' + (user.bankid || '-') + '\n• ID USER: ' + userId + '\n• Link: [User](tg://user?id=' + userId + ')\n\nChat kamu akan di forward kepada user tersebut'
    await tgSendMessage(env, chatId, escapeMarkdown(ps), disconnectKeyboard)
    return
  }

  if (data.startsWith('reject_')) {
    if (!isOwner(fromId) && await getRole(env, fromId) !== 'admin') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Akses ditolak.', true)
      return
    }
    const userId = data.replace('reject_', '')
    await deleteKey(env, 'PMpending_' + userId)
    await tgSendMessage(env, chatId, 'Permintaan chat ditolak.')
    await tgSendMessage(env, userId, 'Admin sedang sibuk dan tidak dapat menerima chat saat ini. 🙇')
    return
  }

  if (data.startsWith('prev_') || data.startsWith('next_')) {
    const page = parseInt(data.split('_')[1])
    await tgAnswerCallbackQuery(env, cqId, '📄 Halaman ' + page, false)
    const kategori = await readJSON(env, 'Kategori', [])
    const { buildProductListView } = await import('./messages.js')
    const view = buildProductListView(kategori, page)
    await editCard(env, cq, view.caption, view.keyboard)
    return
  }

  if (data === 'refreshh') {
    const produk = await readJSON(env, 'Produk', [])
    if (produk.length === 0) { await editCard(env, cq, 'Maaf, tidak ada produk tersedia.', null); return }
    await tgAnswerCallbackQuery(env, cq.id, '🔄 Stok diperbarui', false)
    let text = '╭───〔 📦 INFO STOK 〕\n'
    text += '┊ 🕒 ' + getDate('Asia/Jakarta') + ' WIB\n'
    text += '├──────────────────\n'
    for (const v of produk) {
      const cnt = (v.stok ? v.stok.length : 0)
      const mark = cnt > 0 ? '✅' : '❌'
      text += '┊ ' + mark + ' *' + v.id + '* · ' + mdSafe(v.nameproduct) + ' ➜ ' + cnt + 'x\n'
    }
    text += '╰──────────────────\n\n👉 Ketik nomor produk untuk membeli'
    const keyboard = { inline_keyboard: [[{ text: '↻ Refresh', callback_data: 'refreshh' }]] }
    await editCard(env, cq, text, keyboard)
    return
  }

  if (data.startsWith('dpi_')) {
    const variantId = parseInt(data.replace('dpi_', ''))
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => pr.id === variantId)
    if (!p) { await tgAnswerCallbackQuery(env, cqId, 'Varian tidak ditemukan.', true); return }
    const kategori = await readJSON(env, 'Kategori', [])
    const kat = kategori.find(k => k.produkId === p.category)
    const stockCount = p.stok ? p.stok.length : 0
    if (stockCount === 0) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Stok produk "' + p.nameproduct + '" sedang KOSONG.\nSilakan pilih varian lain.', true); return }
    // v9update18: effective price (Flash Sale aware) — locks the price at order time
    const { getEffectivePrice } = await import('./user.js')
    const ep = await getEffectivePrice(env, p.id, p.price)
    const orderState = { productId: p.id, produkId: p.category, kategoriId: kat ? kat.id : 0, jumlahPesanan: 1, totalPrice: ep.price, produk: kat ? kat.produkName : 'Produk', varian: p.nameproduct, price: ep.price, stock_count: stockCount, userId: fromId, isFlashSale: ep.isSale, originalPrice: ep.originalPrice, flashSaleId: ep.isSale ? p.id : null, flashSaleExpiresAt: ep.flashSaleExpiresAt }
    await writeJSON(env, 'orderState_' + fromId, orderState)
    await tgAnswerCallbackQuery(env, cqId, '🛒 Varian ' + p.nameproduct + ' dipilih', false)
    const { buildOrderView } = await import('./messages.js')
    const view = buildOrderView(orderState, p)
    await editCard(env, cq, view.caption, view.keyboard, view.parseMode)
    return
  }

  if (data === 'back_to_variants') {
    const orderState = await readJSON(env, 'orderState_' + fromId, null)
    await deleteKey(env, 'orderState_' + fromId)
    const kategori = await readJSON(env, 'Kategori', [])
    let kat = null
    if (orderState) kat = kategori.find(k => k.id === (orderState.kategoriId || 0)) || kategori.find(k => k.produkId === orderState.produkId)
    if (!kat) { await tgAnswerCallbackQuery(env, cqId, 'Sesi habis, silakan mulai ulang.', true); return }
    const produk = await readJSON(env, 'Produk', [])
    const variants = produk.filter(pr => pr.category === kat.produkId)
    const { buildVariantView } = await import('./messages.js')
    const fsAll = await readJSON(env, 'FlashSale', {})
    const nowFs = Date.now()
    const fsMap = {}
    for (const vv of variants) {
      const f = fsAll[String(vv.id)]
      if (f && f.expiresAt && nowFs < Number(f.expiresAt)) fsMap[String(vv.id)] = f
    }
    const trxAll = await readJSON(env, 'Trx', [])
    const sold = trxAll.filter(t => t.status === 'Lunas' && String(t.produk) === String(kat.produkName)).reduce((a, t) => a + (Number(t.jumlah) || 0), 0)
    const view = buildVariantView(kat, variants, fsMap, sold)
    await editCard(env, cq, view.caption, view.keyboard, view.parseMode)
    return
  }

  if (data.startsWith('increase_') || data.startsWith('decrease_') || data.startsWith('inc5_') || data.startsWith('dec5_')) {
    let delta = 1, prefix = 'increase_'
    if (data.startsWith('decrease_')) { delta = -1; prefix = 'decrease_' }
    else if (data.startsWith('inc5_')) { delta = 5; prefix = 'inc5_' }
    else if (data.startsWith('dec5_')) { delta = -5; prefix = 'dec5_' }
    const productId = data.replace(prefix, '')
    const orderState = await readJSON(env, 'orderState_' + fromId, null)
    if (!orderState) { await tgAnswerCallbackQuery(env, cqId, 'Sesi order tidak ditemukan.', true); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(productId))
    if (!p) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Produk tidak ditemukan.', true); return }
    const stockCount = p.stok ? p.stok.length : 0
    if (stockCount === 0) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Stok produk ini sedang KOSONG.', true); return }
    // Cap 50: confirm_ menolak qty > 50, jadi increase_ tidak boleh lewat 50
    const maxQty = Math.min(50, Math.max(1, stockCount))
    const current = orderState.jumlahPesanan || 1
    const requested = current + delta
    let next = requested
    if (next < 1) next = 1
    if (next > maxQty) next = maxQty
    if (delta > 0 && requested > maxQty) {
      if (next === current) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Maksimal ' + maxQty + ' pcs. Tidak bisa menambah lagi.', true); return }
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Stok tidak mencukupi! Stok hanya ' + maxQty + ' pcs. Jumlah disetel ke maksimal.', true)
    } else if (delta < 0 && requested < 1) {
      await tgAnswerCallbackQuery(env, cqId, 'ℹ️ Minimal pemesanan 1 pcs.', true); return
    } else if (next === current) {
      await tgAnswerCallbackQuery(env, cqId, delta > 0 ? '⚠️ Sudah maksimal.' : 'ℹ️ Minimal 1 pcs.', true); return
    }
    orderState.jumlahPesanan = next
    orderState.totalPrice = (orderState.price || p.price) * next  // v9update18: use locked price
    orderState.stock_count = stockCount
    await writeJSON(env, 'orderState_' + fromId, orderState)

    let toastMsg = ''
    if (delta > 0) toastMsg = '➕ Jumlah ditambah ' + Math.abs(delta) + ' pcs (Total: ' + next + ' pcs)'
    else toastMsg = '➖ Jumlah dikurangi ' + Math.abs(delta) + ' pcs (Total: ' + next + ' pcs)'
    await tgAnswerCallbackQuery(env, cqId, toastMsg, false)

    const { buildOrderView } = await import('./messages.js')
    const view = buildOrderView(orderState, p)
    await editCard(env, cq, view.caption, view.keyboard, view.parseMode)
    return
  }

  if (data.startsWith('refresh_')) {
    const productId = data.replace('refresh_', '')
    const orderState = await readJSON(env, 'orderState_' + fromId, null)
    if (!orderState) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Sesi order tidak ditemukan.', true); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(productId))
    if (!p) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Produk tidak ditemukan.', true); return }
    const stockCount = p.stok ? p.stok.length : 0
    if (orderState.jumlahPesanan > stockCount) orderState.jumlahPesanan = Math.max(1, stockCount)
    orderState.stock_count = stockCount
    orderState.totalPrice = (orderState.price || p.price) * orderState.jumlahPesanan  // v9update18: use locked price
    await writeJSON(env, 'orderState_' + fromId, orderState)

    await tgAnswerCallbackQuery(env, cqId, '↻ Stok diperbarui! Tersedia: ' + stockCount + ' pcs', false)

    const { buildOrderView } = await import('./messages.js')
    const view = buildOrderView(orderState, p)
    await editCard(env, cq, view.caption, view.keyboard, view.parseMode)
    return
  }

  if (data.startsWith('confirm_')) {
    await tgAnswerCallbackQuery(env, cqId, '⏳ Menyiapkan opsi pembayaran...', false)
    const parts = data.split('_')
    const productId = parts[1]
    const jumlahPesanan = parseInt(parts[2])
    if (isNaN(jumlahPesanan) || jumlahPesanan < 1 || jumlahPesanan > 50) {
      await tgSendMessage(env, chatId, '❌ Jumlah pesanan tidak valid.')
      return
    }
    const lockKey = 'confirm_' + fromId + '_' + productId
    const locked = await acquireLock(env, lockKey, 5)
    if (!locked) {
      await tgAnswerCallbackQuery(env, cqId, '⏳ Sedang diproses, harap tunggu...', true)
      return
    }
    try {
      const orderState = await readJSON(env, 'orderState_' + fromId, null)
      if (!orderState) { await releaseLock(env, lockKey); await tgSendMessage(env, chatId, '⚠️ Pesanan tidak ditemukan!'); return }
      if (orderState.userId !== undefined && String(orderState.userId) !== String(fromId)) {
        await releaseLock(env, lockKey); return
      }
      const produk = await readJSON(env, 'Produk', [])
      const p = produk.find(pr => String(pr.id) === String(productId))
      if (!p) { await releaseLock(env, lockKey); await tgSendMessage(env, chatId, '❌ Produk tidak ditemukan.'); return }
      const stockCount = p.stok ? p.stok.length : 0
      if (stockCount < jumlahPesanan) {
        await releaseLock(env, lockKey)
        await tgSendMessage(env, chatId, '❌ Stok tidak mencukupi. Tersedia: ' + stockCount)
        return
      }
      // v9update18: pakai harga terkunci saat dpi_ (jangan baca ulang harga live)
      const total = (orderState.price != null ? Number(orderState.price) : p.price) * jumlahPesanan
      const saldo = await cekSaldo(env, fromId)
      orderState.jumlahPesanan = jumlahPesanan
      orderState.totalPrice = total
      orderState.userId = fromId
      await writeJSON(env, 'orderState_' + fromId, orderState)
      const { buildPaymentView } = await import('./messages.js')
      const agC = await getActiveGateway(env)
      const { saweriaConfigured } = await import('./saweria.js')
      let payInfoC
      if (agC.name === 'saweria') {
        payInfoC = { enabled: saweriaConfigured(agC.gw), label: 'Bayar via QRIS' }
      } else if (agC.name === 'duitku') {
        payInfoC = { enabled: duitkuConfigured(agC.gw), label: 'Bayar via QRIS' }
      } else {
        const mLabel = (agC.gw && agC.gw.method === 'qris') ? 'QRIS' : methodLabel(agC.gw && agC.gw.method)
        payInfoC = { enabled: pakasirConfigured(agC.gw), label: 'Bayar via ' + mLabel }
      }
      const pview = buildPaymentView(orderState, saldo, payInfoC)
      await editCard(env, cq, pview.caption, pview.keyboard, pview.parseMode || 'HTML')
      await releaseLock(env, lockKey)
    } catch(e) {
      await releaseLock(env, lockKey)
      await tgSendMessage(env, chatId, '❌ Kesalahan: ' + e.message)
    }
    return
  }

  // ======= PAY_CANCEL =======
  if (data.startsWith('pay_cancel_')) {
    await tgAnswerCallbackQuery(env, cqId, '❌ Pesanan dibatalkan', false)
    await deleteKey(env, 'orderState_' + fromId)
    // Batal: hapus kartu/foto pesanan, cukup tampilkan teks + menu utama tetap ada
    try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
    await tgSendMessage(env, chatId, '❌ *Pesanan dibatalkan.*', getMainMenuKeyboard())
    return
  }

  // ======= SALDO TIDAK CUKUP =======
  if (data === 'pay_saldo_insufficient') {
    await tgAnswerCallbackQuery(env, cqId, '❌ Saldo tidak cukup. Top up terlebih dahulu.', true)
    return
  }

  // ======= PAY VIA SALDO =======
  if (data.startsWith('pay_saldo_')) {
    await tgAnswerCallbackQuery(env, cqId, '💰 Memproses pembayaran via Saldo...', false)
    const psParts = data.replace('pay_saldo_', '').split('_')
    const psProductId = psParts[0]
    const psJumlah = parseInt(psParts[1])
    const saldoLock = 'pay_saldo_' + fromId
    const sLocked = await acquireLock(env, saldoLock, 8)
    if (!sLocked) { await tgAnswerCallbackQuery(env, cqId, '⏳ Sedang diproses...', true); return }
    // Product-level lock: cegah 2 user checkout stok terakhir bersamaan
    const stockLock = 'pay_stock_' + psProductId
    const gLocked = await acquireLock(env, stockLock, 10)
    if (!gLocked) { await releaseLock(env, saldoLock); await tgAnswerCallbackQuery(env, cqId, '⏳ Stok sedang diproses user lain, coba lagi.', true); return }
    try {
      const os = await readJSON(env, 'orderState_' + fromId, null)
      if (!os) { await releaseLock(env, saldoLock); await releaseLock(env, stockLock); await tgSendMessage(env, chatId, '⚠️ Sesi habis. Mulai ulang.'); return }
      if (os.userId !== undefined && String(os.userId) !== String(fromId)) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan sesi Anda.', true); await releaseLock(env, saldoLock); await releaseLock(env, stockLock); return }
      const allP = await readJSON(env, 'Produk', [])
      const prod = allP.find(pr => String(pr.id) === String(psProductId))
      if (!prod) { await releaseLock(env, saldoLock); await releaseLock(env, stockLock); await tgSendMessage(env, chatId, '❌ Produk tidak ditemukan.'); return }
      const jml = psJumlah || os.jumlahPesanan || 1
      const tot = (os.price || prod.price) * jml
      if (!prod.stok || prod.stok.length < jml) {
        const { sendTxLog } = await import('./messages.js')
        await sendTxLog(env, {
          type: 'failed', user: { username: fromUsername, id: fromId },
          produk: os.produk || '-', varian: os.varian || '-', total: tot,
          reason: 'Stok habis'
        })
        await releaseLock(env, saldoLock); await releaseLock(env, stockLock); await tgSendMessage(env, chatId, '❌ Stok habis saat proses pembayaran.'); return
      }
      const newBal = await minSaldo(env, fromId, tot)
      if (newBal === null) {
        await releaseLock(env, saldoLock); await releaseLock(env, stockLock); await tgSendMessage(env, chatId, '❌ Saldo tidak cukup.'); return
      }
      const freshP = await readJSON(env, 'Produk', [])
      const pFresh = freshP.find(pr => String(pr.id) === String(psProductId))
      if (!pFresh || !pFresh.stok || pFresh.stok.length < jml) {
        const { sendTxLog } = await import('./messages.js')
        await sendTxLog(env, {
          type: 'failed', user: { username: fromUsername, id: fromId },
          produk: os.produk || '-', varian: os.varian || '-', total: tot,
          reason: 'Stok habis'
        })
        await minSaldo(env, fromId, -tot)
        await releaseLock(env, saldoLock); await releaseLock(env, stockLock); await tgSendMessage(env, chatId, '❌ Stok habis. Saldo dikembalikan.'); return
      }
      const taken = pFresh.stok.splice(0, jml)
      await writeJSON(env, 'Produk', freshP)
      const botNm = orderBotName || NamaBot || 'BOT'
      const trxId = generateOrderId(botNm)
      const now = new Date().toISOString()
      const trxList = await readJSON(env, 'Trx', [])
      trxList.push({ trxid: trxId, user_id: fromId, username: fromUsername, produk: os.produk, varian: os.varian, jumlah: jml, total: tot, tanggal: now, payment_method: 'Saldo', status: 'Lunas' })
      await writeJSON(env, 'Trx', trxList)
      await deleteKey(env, 'orderState_' + fromId)
      try { await editCard(env, cq, '✅ *Pembayaran via Saldo berhasil!*\n\nDetail pesanan dikirim di bawah 👇', null) } catch (e) {}
      let sucFileS = 'INFO ORDER\n'
      sucFileS += 'Nomor: ' + trxId + '\n'
      sucFileS += 'Tanggal: ' + formatWIB(now) + '\n'
      sucFileS += 'Produk: ' + os.produk + '\n'
      sucFileS += 'Variasi: ' + os.varian + '\n'
      sucFileS += 'Jumlah: ' + jml + '\n'
      sucFileS += 'Total: Rp' + tot.toLocaleString('id-ID') + '\n'
      sucFileS += 'Metode: Saldo\n'
      sucFileS += 'Sisa Saldo: Rp' + newBal.toLocaleString('id-ID') + '\n\n'
      sucFileS += 'PRODUK:\n'
      sucFileS += taken.map(s => s.info || s.akun || s.isi || (typeof s === 'string' ? s : JSON.stringify(s))).map((item, i) => (i + 1) + '. ' + item).join('\n')
      sucFileS += '\n\nTerima kasih sudah berbelanja!\n' + (NamaBot || '')
      let sucCapS = '*PEMBELIAN BERHASIL* \u2705\n\n'
      sucCapS += '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'
      sucCapS += '\u2502 *Produk:* ' + os.produk + '\n'
      sucCapS += '\u2502 *Variasi:* ' + os.varian + '\n'
      sucCapS += '\u2502 *Jumlah:* x' + jml + '\n'
      sucCapS += '\u2502 *Total:* Rp' + tot.toLocaleString('id-ID') + '\n'
      sucCapS += '\u2502 *Sisa Saldo:* Rp' + newBal.toLocaleString('id-ID') + '\n'
      sucCapS += '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n'
      sucCapS += 'ID Transaksi:\n`' + trxId + '`'
      const cfg = await readJSON(env, 'BotConfig', {})
      if (cfg.successSticker) {
        await tgSendDocument(env, chatId, sucFileS, trxId + '.txt', escapeMarkdown(sucCapS))
        await tgSendSticker(env, chatId, cfg.successSticker, getMainMenuKeyboard())
      } else {
        await tgSendDocument(env, chatId, sucFileS, trxId + '.txt', escapeMarkdown(sucCapS), getMainMenuKeyboard())
      }
      if (InvoiceLogger) {
        await tgSendMessage(env, InvoiceLogger,
          '💳 *BAYAR SALDO*\nUser: @' + fromUsername + ' (' + fromId + ')\nID: `' + trxId + '`\nProduk: ' + os.varian + ' x' + jml + '\nTotal: Rp ' + tot.toLocaleString('id-ID'),
          null, 'Markdown')
      }
      const { sendTxLog } = await import('./messages.js')
      await sendTxLog(env, {
        type: 'success',
        user: { username: fromUsername, id: fromId },
        produk: os.produk,
        varian: os.varian,
        total: tot,
        fileTxtContent: sucFileS,
        fileName: trxId + '.txt'
      })
      await releaseLock(env, saldoLock)
      await releaseLock(env, stockLock)
    } catch(e) { await releaseLock(env, saldoLock); await releaseLock(env, stockLock); await tgSendMessage(env, chatId, '❌ Error saldo: ' + e.message) }
    return
  }

  // ======= PAY VIA QRIS =======
  if (data.startsWith('pay_qris_')) {
    await tgAnswerCallbackQuery(env, cqId, '💳 Menyiapkan QRIS pembayaran...', false)
    const pqParts = data.replace('pay_qris_', '').split('_')
    const pqProductId = pqParts[0]
    const pqJumlah = parseInt(pqParts[1])
    const qrisLock = 'pay_qris_' + fromId
    const qLocked = await acquireLock(env, qrisLock, 8)
    if (!qLocked) { await tgAnswerCallbackQuery(env, cqId, '⏳ Sedang proses QRIS...', true); return }
    try {
      const os2 = await readJSON(env, 'orderState_' + fromId, null)
      if (!os2) { await releaseLock(env, qrisLock); await tgSendMessage(env, chatId, '⚠️ Sesi habis. Mulai ulang.'); return }
      if (os2.userId !== undefined && String(os2.userId) !== String(fromId)) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan sesi Anda.', true); await releaseLock(env, qrisLock); return }
      const allP2 = await readJSON(env, 'Produk', [])
      const prod2 = allP2.find(pr => String(pr.id) === String(pqProductId))
      if (!prod2) { await releaseLock(env, qrisLock); await tgSendMessage(env, chatId, '❌ Produk tidak ditemukan.'); return }
      const jml2 = pqJumlah || os2.jumlahPesanan || 1
      const tot2 = (os2.price || prod2.price) * jml2
      if (!prod2.stok || prod2.stok.length < jml2) {
        await releaseLock(env, qrisLock); await tgSendMessage(env, chatId, '❌ Stok habis.'); return
      }
      const botNm2 = orderBotName || NamaBot || 'BOT'
      const trxId2 = generateOrderId(botNm2)
      const agQ = await getActiveGateway(env)
      const gwQ = agQ.gw
      // ─── Saweria branch (QRIS-only) ───
      if (agQ.name === 'saweria') {
        const { saweriaConfigured, saweriaCreate, saweriaSession } = await import('./saweria.js')
        if (!saweriaConfigured(gwQ)) {
          await releaseLock(env, qrisLock)
          await tgSendMessage(env, chatId, '⚠️ Payment gateway (Saweria) belum aktif. Silakan bayar via Saldo atau hubungi admin.', getMainMenuKeyboard())
          return
        }
        const merchantFeeSw = calcFee(gwQ, tot2)
        const chargeAmtSw = tot2 + merchantFeeSw
        const createdSw = await saweriaCreate(gwQ, trxId2, chargeAmtSw, {
          customerName: fromName || 'Customer',
          email: (fromUsername ? fromUsername : ('u' + fromId)) + '@bot.local'
        })
        if (!createdSw.ok) {
          await releaseLock(env, qrisLock)
          await tgSendMessage(env, chatId, '❌ Gagal membuat transaksi Saweria: ' + (createdSw.error || 'coba lagi'), getMainMenuKeyboard())
          return
        }
        const swExpMin = Number(gwQ.expiryPeriod) || 10

        os2.jumlahPesanan = jml2; os2.totalPrice = tot2; os2.payment_method = 'Saweria:QRIS'; os2.userId = fromId; os2.trxId = trxId2
        await writeJSON(env, 'orderState_' + fromId, os2)
        let qMsgSw = '╭───〔 💳 SAWERIA QRIS 〕───\n'
        qMsgSw += '┊ *ID Pesanan  :* `' + trxId2 + '`\n'
        qMsgSw += '┊ *Produk      :* ' + mdSafe(os2.varian) + '\n'
        qMsgSw += '┊ *Jumlah      :* x' + jml2 + '\n'
        qMsgSw += '┊ *Harga       :* Rp' + tot2.toLocaleString('id-ID') + '\n'
        if (merchantFeeSw > 0) qMsgSw += '┊ *Fee (' + feeLabel(gwQ) + ') :* Rp' + merchantFeeSw.toLocaleString('id-ID') + '\n'
        qMsgSw += '┊ *Total Bayar :* Rp' + chargeAmtSw.toLocaleString('id-ID') + '\n'
        qMsgSw += '┊ *Reference   :* `' + (createdSw.id || '-') + '`\n'
        qMsgSw += '╰──────────────────\n\n'
        qMsgSw += '⏰ Kadaluarsa dalam *' + swExpMin + ' menit*\n'
        qMsgSw += '📲 Scan QR di bawah untuk membayar'
        const pkRowsSw = [[{ text: '↻ Cek Pembayaran', callback_data: 'cekbayar_' + trxId2, style: 'success' }]]
        pkRowsSw.push([{ text: '❌ Batal', callback_data: 'batal_qris_' + trxId2, style: 'danger' }])
        const qkbSw = { inline_keyboard: pkRowsSw }
        let qMsgKeySw = null
        const qrImgSw = 'https://quickchart.io/qr?text=' + encodeURIComponent(createdSw.qrString) + '&size=400'
        if (cq.message && cq.message.photo) {
          try {
            const qEdSw = await tgEditMessageMedia(env, chatId, messageId, qrImgSw, qMsgSw, qkbSw)
            if (qEdSw && qEdSw.ok) { qMsgKeySw = messageId }
          } catch (e) {}
        }
        if (qMsgKeySw === null) {
          try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
          const sentQSw = await tgSendPhotoUrl(env, chatId, qrImgSw, qMsgSw, qkbSw)
          qMsgKeySw = (sentQSw && sentQSw.result && sentQSw.result.message_id) ? sentQSw.result.message_id : null
        }
        const sessionsSw = await readJSON(env, 'SessionDeposit', [])
        sessionsSw.push(saweriaSession({
          trxId: trxId2, userId: fromId, type: 'purchase', amount: tot2, charge: chargeAmtSw,
          gw: gwQ, nama: fromName, username: fromUsername,
          extra: {
            id: Number(pqProductId), cart: jml2, produk: os2.produk, produk_nama: os2.varian,
            saweria_id: createdSw.id,
            flashSaleId: os2.flashSaleId || null,
            flashSaleExpiresAt: os2.flashSaleExpiresAt || null,
            originalPrice: os2.originalPrice || null
          }
        }))
        await writeJSON(env, 'SessionDeposit', sessionsSw)
        await releaseLock(env, qrisLock)
        return
      }
      // ─── Duitku branch (QRIS-only) ───
      if (agQ.name === 'duitku') {
        if (!duitkuConfigured(gwQ)) {
          await releaseLock(env, qrisLock)
          await tgSendMessage(env, chatId, '⚠️ Payment gateway (Duitku) belum aktif. Silakan bayar via Saldo atau hubungi admin.', getMainMenuKeyboard())
          return
        }
      const merchantFeeDk = calcFee(gwQ, tot2)
      const chargeAmtDk = tot2 + merchantFeeDk
      const createdDk = await duitkuCreateQris(gwQ, trxId2, chargeAmtDk, {
          productDetails: os2.varian || os2.produk || 'Order',
          customerName: fromName || 'Customer',
          email: (fromUsername ? fromUsername : ('u' + fromId)) + '@bot.local',
          callbackUrl: '', returnUrl: ''
        })
        // Duitku mengembalikan expiry yang dipakai (sudah di-clamp per provider)
        const dkExpMin = Number(createdDk && createdDk.expiry) > 0 ? Number(createdDk.expiry) : Number(gwQ.expiryPeriod || 5)
        if (!createdDk.ok) {
          await releaseLock(env, qrisLock)
          await tgSendMessage(env, chatId, '❌ Gagal membuat transaksi Duitku: ' + (createdDk.error || 'coba lagi'), getMainMenuKeyboard())
          return
        }
        os2.jumlahPesanan = jml2; os2.totalPrice = tot2; os2.payment_method = 'Duitku:' + (gwQ.qrisProvider || 'SP'); os2.userId = fromId; os2.trxId = trxId2
        await writeJSON(env, 'orderState_' + fromId, os2)
        let qMsgDk = '╭───〔 💳 ' + providerLabel(gwQ.qrisProvider) + ' 〕───\n'
        qMsgDk += '┊ *ID Pesanan  :* `' + trxId2 + '`\n'
        qMsgDk += '┊ *Produk      :* ' + mdSafe(os2.varian) + '\n'
        qMsgDk += '┊ *Jumlah      :* x' + jml2 + '\n'
        qMsgDk += '┊ *Harga       :* Rp' + tot2.toLocaleString('id-ID') + '\n'
        if (merchantFeeDk > 0) qMsgDk += '┊ *Fee (' + feeLabel(gwQ) + ') :* Rp' + merchantFeeDk.toLocaleString('id-ID') + '\n'
        qMsgDk += '┊ *Total Bayar :* Rp' + chargeAmtDk.toLocaleString('id-ID') + '\n'
        qMsgDk += '┊ *Reference   :* `' + (createdDk.reference || '-') + '`\n'
        qMsgDk += '╰──────────────────\n\n'
        qMsgDk += '⏰ Kadaluarsa dalam *' + dkExpMin + ' menit*\n'
        qMsgDk += '📲 Scan QR di bawah untuk membayar'
        const pkRowsDk = [[{ text: '↻ Cek Pembayaran', callback_data: 'cekbayar_' + trxId2, style: 'success' }]]
        if (gwQ.mode === 'sandbox') pkRowsDk.push([{ text: '🧪 Simulasi Bayar', callback_data: 'simulbayar_' + trxId2, style: 'primary' }])
        pkRowsDk.push([{ text: '❌ Batal', callback_data: 'batal_qris_' + trxId2, style: 'danger' }])
        const qkbDk = { inline_keyboard: pkRowsDk }
        let qMsgKeyDk = null
        if (createdDk.qrString) {
          const qrImgUrlDk = dkQrImageUrl(createdDk.qrString)
          let qEditedDk = false
          if (cq.message && cq.message.photo) {
            try {
              const qEdDk = await tgEditMessageMedia(env, chatId, messageId, qrImgUrlDk, qMsgDk, qkbDk)
              if (qEdDk && qEdDk.ok) { qMsgKeyDk = messageId; qEditedDk = true }
            } catch (e) {}
          }
          if (!qEditedDk) {
            try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
            const sentQDk = await tgSendPhotoUrl(env, chatId, qrImgUrlDk, qMsgDk, qkbDk)
            qMsgKeyDk = (sentQDk && sentQDk.result && sentQDk.result.message_id) ? sentQDk.result.message_id : null
          }
        } else {
          const sentTDk = await tgSendMessage(env, chatId, qMsgDk, qkbDk, 'Markdown')
          qMsgKeyDk = (sentTDk && sentTDk.result && sentTDk.result.message_id) ? sentTDk.result.message_id : null
        }
        const sessionsDk = await readJSON(env, 'SessionDeposit', [])
        sessionsDk.push({
          id: trxId2,
          status: 'pending',
          depositDetails: {
            userId: fromId, type: 'purchase', id: Number(pqProductId),
            cart: jml2, produk: os2.produk, produk_nama: os2.varian,
            total_amount: chargeAmtDk, expired: expiredTime(dkExpMin), key: qMsgKeyDk,
            nama: fromName, username: fromUsername,
            provider: 'duitku', duitku_amount: chargeAmtDk, duitku_provider: gwQ.qrisProvider,
            duitku_reference: createdDk.reference, duitku_qr: createdDk.qrString,
            duitku_paymentUrl: createdDk.paymentUrl,
            duitku_gw: { merchantCode: gwQ.merchantCode, apiKey: gwQ.apiKey, mode: gwQ.mode, qrisProvider: gwQ.qrisProvider },
            expiryMinutes: dkExpMin,
            display_total: chargeAmtDk,
            // v9update18: flash sale metadata (utk auto-cancel di processPaymentSuccess)
            flashSaleId: os2.flashSaleId || null,
            flashSaleExpiresAt: os2.flashSaleExpiresAt || null,
            originalPrice: os2.originalPrice || null
          }
        })
        await writeJSON(env, 'SessionDeposit', sessionsDk)
        await releaseLock(env, qrisLock)
        return
      }
      // ─── Pakasir branch (default) ───
      if (!pakasirConfigured(gwQ)) {
        await releaseLock(env, qrisLock)
        await tgSendMessage(env, chatId, '⚠️ Payment gateway belum aktif. Silakan bayar via Saldo atau hubungi admin.', getMainMenuKeyboard())
        return
      }
      const merchantFee = calcFee(gwQ, tot2)
      const chargeAmt = tot2 + merchantFee
      const createdQ = await pakasirCreate(gwQ, trxId2, chargeAmt)
      if (!createdQ.ok) {
        await releaseLock(env, qrisLock)
        await tgSendMessage(env, chatId, '❌ Gagal membuat transaksi Pakasir: ' + (createdQ.error || 'coba lagi'), getMainMenuKeyboard())
        return
      }
      const payQ = createdQ.payment
      const paymentNumber = payQ.payment_number || ''
      // Session pakai total_payment API (sama dgn caption) — compare via amountsMatch (toleransi Rp1)
      const displayTotal = Number(payQ.total_payment || chargeAmt)
      const isQrisQ = (gwQ.method || 'qris') === 'qris'
      os2.jumlahPesanan = jml2; os2.totalPrice = tot2; os2.payment_method = 'Pakasir:' + (gwQ.method || 'qris'); os2.userId = fromId; os2.trxId = trxId2
      await writeJSON(env, 'orderState_' + fromId, os2)
      let qMsg = '╭───〔 💳 ' + methodLabel(gwQ.method) + ' 〕───\n'
      qMsg += '┊ *ID Pesanan  :* `' + trxId2 + '`\n'
      qMsg += '┊ *Produk      :* ' + mdSafe(os2.varian) + '\n'
      qMsg += '┊ *Jumlah      :* x' + jml2 + '\n'
      qMsg += '┊ *Harga       :* Rp' + tot2.toLocaleString('id-ID') + '\n'
      if (merchantFee > 0) qMsg += '┊ *Fee (' + feeLabel(gwQ) + ') :* Rp' + merchantFee.toLocaleString('id-ID') + '\n'
      qMsg += '┊ *Total Bayar :* Rp' + displayTotal.toLocaleString('id-ID') + '\n'
      qMsg += '╰──────────────────\n\n'
      if (!isQrisQ) qMsg += '🏦 Nomor VA: `' + paymentNumber + '`\n(ketuk untuk menyalin)\n'
      qMsg += '⏰ Kadaluarsa dalam *5 menit*\n'
      qMsg += isQrisQ ? '📲 Scan QR di bawah untuk membayar' : '💸 Bayar ke Virtual Account di atas'
      const pkRows = [[{ text: '↻ Cek Pembayaran', callback_data: 'cekbayar_' + trxId2, style: 'success' }]]
      if (gwQ.mode === 'sandbox') pkRows.push([{ text: '🧪 Simulasi Bayar', callback_data: 'simulbayar_' + trxId2, style: 'primary' }])
      pkRows.push([{ text: '❌ Batal', callback_data: 'batal_qris_' + trxId2, style: 'danger' }])
      const qkb = { inline_keyboard: pkRows }
      let qMsgKey = null
      if (isQrisQ && paymentNumber) {
        const qrImgUrl = qrImageUrl(paymentNumber)
        let qEdited = false
        if (cq.message && cq.message.photo) {
          try {
            const qEd = await tgEditMessageMedia(env, chatId, messageId, qrImgUrl, qMsg, qkb)
            if (qEd && qEd.ok) { qMsgKey = messageId; qEdited = true }
          } catch (e) {}
        }
        if (!qEdited) {
          try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
          const sentQ = await tgSendPhotoUrl(env, chatId, qrImgUrl, qMsg, qkb)
          qMsgKey = (sentQ && sentQ.result && sentQ.result.message_id) ? sentQ.result.message_id : null
        }
      } else {
        try {
          const tEd = await tgEditMessageCaption(env, chatId, messageId, qMsg, qkb)
          if (tEd && tEd.ok) { qMsgKey = messageId }
        } catch (e) {}
        if (!qMsgKey) {
          try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
          const sentT = await tgSendMessage(env, chatId, qMsg, qkb, 'Markdown')
          qMsgKey = (sentT && sentT.result && sentT.result.message_id) ? sentT.result.message_id : null
        }
      }
      const sessions2 = await readJSON(env, 'SessionDeposit', [])
      sessions2.push({
        id: trxId2,
        status: 'pending',
        depositDetails: {
          userId: fromId, type: 'purchase', id: Number(pqProductId),
          cart: jml2, produk: os2.produk, produk_nama: os2.varian,
          total_amount: displayTotal, expired: expiredTime(), key: qMsgKey,
          nama: fromName, username: fromUsername,
          provider: 'pakasir', pakasir_amount: displayTotal, pakasir_method: gwQ.method,
          pakasir_gw: { slug: gwQ.slug, apiKey: gwQ.apiKey, method: gwQ.method, mode: gwQ.mode },
          display_total: displayTotal,
          // v9update18: flash sale metadata (utk auto-cancel di processPaymentSuccess)
          flashSaleId: os2.flashSaleId || null,
          flashSaleExpiresAt: os2.flashSaleExpiresAt || null,
          originalPrice: os2.originalPrice || null
        }
      })
      await writeJSON(env, 'SessionDeposit', sessions2)
      await releaseLock(env, qrisLock)
    } catch(e) { await releaseLock(env, qrisLock); await tgSendMessage(env, chatId, '❌ Gagal generate QRIS: ' + e.message) }
    return
  }

  // ======= BATAL QRIS =======
  if (data.startsWith('batal_qris_')) {
    const qTrxId = data.replace('batal_qris_', '')
    const cancelSessions = await readJSON(env, 'SessionDeposit', [])
    const qCancelSes = cancelSessions.find(ss => ss.id === qTrxId)
    if (qCancelSes && qCancelSes.depositDetails) {
      const d = qCancelSes.depositDetails
      if (d.provider === 'pakasir' && d.pakasir_gw) {
        try { await pakasirCancel(d.pakasir_gw, qTrxId, d.pakasir_amount) } catch (e) {}
      }
      // saweria: tidak ada API cancel — session expired di cron, donasi pending expired sendiri
      const { sendTxLog } = await import('./messages.js')
      await sendTxLog(env, {
        type: 'failed',
        user: { username: d.username || fromUsername, id: d.userId || fromId },
        produk: d.produk || '-',
        varian: d.produk_nama || '-',
        total: d.total_amount || 0,
        reason: 'Dibatalkan oleh Pembeli'
      })
    }
    await writeJSON(env, 'SessionDeposit', cancelSessions.filter(ss => ss.id !== qTrxId))
    await deleteKey(env, 'orderState_' + fromId)
    try { await tgDeleteMessage(env, chatId, messageId) } catch (e) {}
    await tgSendMessage(env, chatId, '❌ *Pesanan QRIS dibatalkan.*', getMainMenuKeyboard())
    return
  }

  // ======= SIMULASI BAYAR (sandbox) =======
  if (data.startsWith('simulbayar_')) {
    const smTrxId = data.replace('simulbayar_', '')
    const smSessions = await readJSON(env, 'SessionDeposit', [])
    const smSession = smSessions.find(s => s.id === smTrxId)
    if (!smSession) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Sesi tidak ditemukan.', true); return }
    const smDetails = smSession.depositDetails
    if (!smDetails || String(smDetails.userId) !== String(fromId)) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan sesi Anda.', true); return }
    // ─── Duitku branch: self-settle di sandbox ───
    if (smDetails.provider === 'duitku' && smDetails.duitku_gw && smDetails.duitku_gw.mode === 'sandbox') {
      await writeJSON(env, 'SessionDeposit', smSessions.filter(s => s.id !== smTrxId))
      const { processPaymentSuccess } = await import('./payments.js')
      await processPaymentSuccess(env, smSession, {
        status: 'completed', reference: smDetails.duitku_reference || 'SIM-DK-' + Date.now(),
        amount: smDetails.duitku_amount, gateway: 'duitku'
      })
      await tgAnswerCallbackQuery(env, cqId, '✅ Simulasi Duitku sukses! Pesanan diproses.', true)
      return
    }
    if (!smDetails || smDetails.provider !== 'pakasir' || !smDetails.pakasir_gw || smDetails.pakasir_gw.mode !== 'sandbox') {
      await tgAnswerCallbackQuery(env, cqId, '⚠️ Simulasi hanya untuk mode sandbox.', true); return
    }
    await pakasirSimulate(smDetails.pakasir_gw, smTrxId, smDetails.pakasir_amount)
    const smTrx = await pakasirDetail(smDetails.pakasir_gw, smTrxId, smDetails.pakasir_amount)
    if (smTrx && smTrx.status === 'completed') {
      await writeJSON(env, 'SessionDeposit', smSessions.filter(s => s.id !== smTrxId))
      const { processPaymentSuccess } = await import('./payments.js')
      await processPaymentSuccess(env, smSession, smTrx)
      await tgAnswerCallbackQuery(env, cqId, '✅ Simulasi sukses! Pesanan diproses.', true)
    } else {
      await tgAnswerCallbackQuery(env, cqId, '⏳ Simulasi terkirim, status belum completed. Coba Cek Pembayaran.', true)
    }
    return
  }

  // ======= CEK PEMBAYARAN QRIS (manual) =======
  if (data.startsWith('cekbayar_')) {
    const ckTrxId = data.replace('cekbayar_', '')
    const lockKey = 'pay_process_' + ckTrxId
    const gotLock = await acquireLock(env, lockKey, 15)
    if (!gotLock) {
      await tgAnswerCallbackQuery(env, cqId, '⏳ Pembayaran sedang diverifikasi oleh sistem, mohon tunggu...', true)
      return
    }

    try {
      const ckSessions = await readJSON(env, 'SessionDeposit', [])
      const ckSession = ckSessions.find(s => s.id === ckTrxId)
      if (!ckSession) {
        await tgAnswerCallbackQuery(env, cqId, '⚠️ Sesi tidak ditemukan atau sudah selesai diproses.', true)
        return
      }
      const ckDetails = ckSession.depositDetails
      if (!ckDetails || String(ckDetails.userId) !== String(fromId)) {
        await tgAnswerCallbackQuery(env, cqId, '⚠️ Ini bukan sesi Anda.', true)
        return
      }
      try {
        const expiredDate = parseExpiredWIB(ckDetails.expired)
        if (new Date() > expiredDate) {
          const { handleExpiredPayment } = await import('./payments.js')
          await handleExpiredPayment(env, ckSession)
          await writeJSON(env, 'SessionDeposit', ckSessions.filter(s => s.id !== ckTrxId))
          await tgAnswerCallbackQuery(env, cqId, '⏱️ Sesi ini sudah kadaluarsa.', true)
          return
        }
      } catch (e) {}
      if (SimulatePayment) {
        const { processPaymentSuccess } = await import('./payments.js')
        await processPaymentSuccess(env, ckSession, {})
        await writeJSON(env, 'SessionDeposit', ckSessions.filter(s => s.id !== ckTrxId))
        await tgAnswerCallbackQuery(env, cqId, '✅ Pembayaran terkonfirmasi (simulasi).', true)
        return
      }
      let ckOk = false
      const { amountsMatch } = await import('./pakasir.js')
      // ─── Saweria branch: cek via status ───
      if (ckDetails.provider === 'saweria' && ckDetails.saweria_id) {
        const { saweriaStatus } = await import('./saweria.js')
        const stat = await saweriaStatus(null, ckDetails.saweria_id)
        if (stat && stat.ok && stat.status === 'PAID') {
          if (stat.amount === undefined) {
            console.warn('[cekbayar] Saweria PAID tanpa nominal, terima berdasar session: ' + ckTrxId)
          } else if (Number(stat.amount) !== Number(ckDetails.total_amount)) {
            await tgAnswerCallbackQuery(env, cqId, '⚠️ Nominal tidak cocok. Hubungi admin.', true)
            return
          }
          await writeJSON(env, 'SessionDeposit', ckSessions.filter(s => s.id !== ckTrxId))
          const { processPaymentSuccess } = await import('./payments.js')
          await processPaymentSuccess(env, ckSession, {
            status: 'completed', reference: ckDetails.saweria_id,
            amount: Number(ckDetails.total_amount), gateway: 'saweria'
          })
          ckOk = true
        }
      }
      // ─── Duitku branch: cek via transactionStatus ───
      if (ckDetails.provider === 'duitku' && ckDetails.duitku_gw) {
        const { duitkuStatus } = await import('./duitku.js')
        const stat = await duitkuStatus(ckDetails.duitku_gw, ckTrxId)
        if (stat && String(stat.statusCode) === '00') {
          if (stat.amount !== undefined && stat.amount !== null && Number(stat.amount) !== Number(ckDetails.duitku_amount)) {
            await tgAnswerCallbackQuery(env, cqId, '⚠️ Nominal tidak cocok. Hubungi admin.', true)
            return
          }
          await writeJSON(env, 'SessionDeposit', ckSessions.filter(s => s.id !== ckTrxId))
          const { processPaymentSuccess } = await import('./payments.js')
          await processPaymentSuccess(env, ckSession, {
            status: 'completed', reference: stat.reference || ckDetails.duitku_reference,
            amount: Number(stat.amount || ckDetails.duitku_amount), gateway: 'duitku'
          })
          ckOk = true
        }
      }
      if (ckDetails.provider === 'pakasir' && ckDetails.pakasir_gw) {
        const ckTrx = await pakasirDetail(ckDetails.pakasir_gw, ckTrxId, ckDetails.pakasir_amount)
        if (ckTrx && ckTrx.status === 'completed') {
          if (!amountsMatch(ckTrx.total_payment ?? ckDetails.pakasir_amount, ckDetails.pakasir_amount)) {
            await tgAnswerCallbackQuery(env, cqId, '⚠️ Nominal tidak cocok. Hubungi admin.', true)
            return
          }
          await writeJSON(env, 'SessionDeposit', ckSessions.filter(s => s.id !== ckTrxId))
          const { processPaymentSuccess } = await import('./payments.js')
          await processPaymentSuccess(env, ckSession, ckTrx)
          ckOk = true
        }
      }
      if (ckOk) {
        await tgAnswerCallbackQuery(env, cqId, '✅ Pembayaran ditemukan! Pesanan sedang diproses.', true)
      } else {
        await tgAnswerCallbackQuery(env, cqId, '⏳ Pembayaran belum terdeteksi. Coba lagi beberapa saat.', true)
      }
    } finally {
      await releaseLock(env, lockKey)
    }
    return
  }

  // ======= RIWAYAT PAGE =======
  if (data.startsWith('riwayat_page_')) {
    const rwPage = parseInt(data.replace('riwayat_page_', ''))
    const allTrx = await readJSON(env, 'Trx', [])
    const myTrx = allTrx.filter(t => String(t.user_id) === String(fromId))
    const PER_PAGE = 5
    const totalPg = Math.ceil(myTrx.length / PER_PAGE)
    if (rwPage < 1 || rwPage > totalPg) { await tgAnswerCallbackQuery(env, cqId, '⚠️ Halaman tidak tersedia.', true); return }
    const { buildRiwayatView } = await import('./messages.js')
    const view = buildRiwayatView(myTrx, rwPage, totalPg)
    await editCard(env, cq, view.text, view.keyboard, view.parseMode || 'Markdown')
    return
  }

  if (data.startsWith('batal_order_')) {
    const trxId = data.replace('batal_order_', '')
    const sessions = await readJSON(env, 'SessionDeposit', [])
    const session = sessions.find(s => s.id === trxId && String(s.depositDetails?.userId) === String(fromId))
    if (session) {
      session.status = 'cancelled'
      const d = session.depositDetails
      if (d && d.type !== 'deposit') {
        const { sendTxLog } = await import('./messages.js')
        await sendTxLog(env, {
          type: 'failed',
          user: { username: d.username || fromUsername, id: d.userId || fromId },
          produk: d.produk || '-',
          varian: d.produk_nama || '-',
          total: d.total_amount || 0,
          reason: 'Dibatalkan oleh Pembeli'
        })
      }
      await writeJSON(env, 'SessionDeposit', sessions.filter(s => s.id !== trxId))
      await tgDeleteMessage(env, chatId, messageId)
      await tgSendMessage(env, chatId, 'Transaksi berhasil dibatalkan.', getMainMenuKeyboard())
    } else {
      await tgSendMessage(env, chatId, 'Transaksi tidak ditemukan.')
    }
    return
  }

  if (data.startsWith('batal_deposit_')) {
    const trxId = data.replace('batal_deposit_', '')
    const sessions = await readJSON(env, 'SessionDeposit', [])
    const session = sessions.find(s => s.id === trxId && String(s.depositDetails?.userId) === String(fromId))
    if (session) {
      if (session.depositDetails) {
        const d = session.depositDetails
        if (d.provider === 'pakasir' && d.pakasir_gw) {
          try { await pakasirCancel(d.pakasir_gw, trxId, d.pakasir_amount) } catch (e) {}
        }
        // saweria: tidak ada API cancel — biarkan expired
      }
      await writeJSON(env, 'SessionDeposit', sessions.filter(s => s.id !== trxId))
      await tgDeleteMessage(env, chatId, messageId)
      await tgSendMessage(env, chatId, 'Deposit dibatalkan.', getMainMenuKeyboard())
    }
    return
  }

  if (!isOwner(fromId) && await getRole(env, fromId) !== 'admin') return

  if (data === 'manage_tutup') { await tgDeleteMessage(env, chatId, messageId); return }
  if (data === 'manage_batal') { await deleteKey(env, 'manageState_' + fromId); await tgEditMessageText(env, chatId, messageId, 'Dibatalkan.', getManagePanel()); return }

  if (data === 'cad_backin') {
    const kategori = await readJSON(env, 'Kategori', [])
    let text = '\ud83d\udce6 *Daftar Produk:*\n\n'
    const buttons = []
    if (kategori.length === 0) {
      text += 'Belum ada produk.'
      buttons.push([{ text: '\u2795 Tambah Produk', callback_data: 'cad_add' }])
    } else {
      for (const k of kategori) {
        text += '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2727\n'
        text += '\u250a\u30fb *Produk :* ' + k.produkName + '\n'
        text += '\u250a\u30fb *ID :* ' + k.id + '\n'
        text += '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2727\n\n'
        buttons.push([{ text: k.produkName, callback_data: 'cad_info_' + k.produkId }])
      }
      buttons.push([{ text: '\u2795 Tambah Produk', callback_data: 'cad_add' }])
    }
    buttons.push([{ text: '\u2b05 Kembali', callback_data: 'manage' }])
    await tgEditMessageText(env, chatId, messageId, escapeMarkdown(text), { inline_keyboard: buttons })
    return
  }

  if (data === 'cad_add') {
    const state = { action: 'addproduk', step: 'nama', data: {} }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Silahkan masukkan nama Produk Dan Deskripsi yang ingin ditambahkan\nContoh: NAMAPRODUK|DESKRIPSI')
    return
  }

  if (data.startsWith('cad_info_')) {
    const produkId = data.replace('cad_info_', '')
    const kategori = await readJSON(env, 'Kategori', [])
    const k = kategori.find(kat => kat.produkId === produkId)
    if (!k) { await tgSendMessage(env, chatId, 'Produk tidak ditemukan'); return }
    await tgEditMessageText(env, chatId, messageId, 'Apa yang ingin kamu lakukan?\n\n*produkName:* ' + k.produkName + '\n*produkId:* ' + k.produkId, {
      inline_keyboard: [
        [{ text: 'Edit Nama', callback_data: 'cad_edit_' + k.id }, { text: 'Hapus Produk', callback_data: 'cad_del_' + k.produkId }],
        [{ text: 'Kembali', callback_data: 'cad_backin' }]
      ]
    }, 'Markdown')
    return
  }

  if (data.startsWith('cad_edit_')) {
    const id = data.replace('cad_edit_', '')
    const state = { action: 'editnama_produk', step: 'data', kode: id }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Silahkan masukkan nama produk yang baru')
    return
  }

  if (data.startsWith('cad_del_')) {
    const produkId = data.replace('cad_del_', '')
    const kategori = await readJSON(env, 'Kategori', [])
    const idx = kategori.findIndex(k => k.produkId === produkId)
    if (idx !== -1) {
      kategori.splice(idx, 1)
      await writeJSON(env, 'Kategori', kategori)
      const produk = await readJSON(env, 'Produk', [])
      const filtered = produk.filter(p => p.category !== produkId)
      await writeJSON(env, 'Produk', filtered)
      await tgEditMessageText(env, chatId, messageId, 'Produk berhasil dihapus', { inline_keyboard: [[{ text: 'Kembali', callback_data: 'cad_backin' }]] })
    }
    return
  }

  if (data === 'cad_varian') {
    const produk = await readJSON(env, 'Produk', [])
    const kategori = await readJSON(env, 'Kategori', [])
    let text = '\ud83d\udce6 *Daftar Varian :*\n\n'
    const buttons = []
    const grouped = {}
    for (const v of produk) {
      if (!grouped[v.category]) grouped[v.category] = []
      grouped[v.category].push(v)
    }
    for (const cat in grouped) {
      const kat = kategori.find(k => k.produkId === cat)
      text += '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2727\n'
      text += '\u250a\u30fb *Produk :* ' + (kat ? kat.produkName : cat) + '\n'
      text += '\u250a\u30fb *Varian :*\n'
      for (const v of grouped[cat]) {
        const sc = v.stok ? v.stok.length : 0
        text += '\u250a\u30fb [' + v.id + '] ' + v.nameproduct + ': Rp. ' + (v.price || 0).toLocaleString() + ' - Stock: ' + sc + '\n'
        buttons.push([{ text: v.nameproduct, callback_data: 'varian_' + v.id }])
      }
      text += '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2727\n\n'
    }
    buttons.push([{ text: '\u2795 Tambah Varian', callback_data: 'cad_add_varian' }])
    buttons.push([{ text: '\u2b05 Kembali', callback_data: 'manage' }])
    await tgEditMessageText(env, chatId, messageId, escapeMarkdown(text), { inline_keyboard: buttons })
    return
  }

  if (data === 'cad_add_varian') {
    const state = { action: 'addvarian', step: 'nama', data: {} }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Silahkan masukkan nama varian dan harga\nContoh: NAMAVARIAN|HARGA')
    return
  }

  if (data.startsWith('varian_')) {
    const varianId = data.replace('varian_', '')
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(varianId))
    if (!p) return
    await tgEditMessageText(env, chatId, messageId, '\ud83d\udd27 *Kelola Varian:* ' + p.nameproduct, {
      inline_keyboard: [
        [{ text: '\u2795 Add Stock', callback_data: 'add_stock_' + p.id }, { text: '\ud83d\udce6 Add Stock Multi', callback_data: 'add_stock_multi_' + p.id }],
        [{ text: 'Delete Varian', callback_data: 'delete_varian_' + p.id }, { text: 'Edit Harga', callback_data: 'edit_harga_' + p.id }],
        [{ text: 'Edit Nama', callback_data: 'edit_nama_varian_' + p.id }],
        [{ text: '\u2b05 Kembali', callback_data: 'cad_varian' }]
      ],
    }, 'Markdown')
    return
  }

  if (data.startsWith('add_stock_')) {
    const kode = data.replace('add_stock_', '')
    const state = { action: 'addstock', step: 'data', kode }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Kirim data stok (1 per baris).\nKetik /selesai jika sudah.')
    return
  }

  if (data.startsWith('add_stock_multi_')) {
    const kode = data.replace('add_stock_multi_', '')
    const state = { action: 'addstock_multi', step: 'data', kode }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Kirim data stok (1 per baris, format: info|expired_days).\nKetik /selesai jika sudah.')
    return
  }

  if (data.startsWith('delete_varian_')) {
    const varianId = parseInt(data.replace('delete_varian_', ''))
    const produk = await readJSON(env, 'Produk', [])
    const idx = produk.findIndex(p => p.id === varianId)
    if (idx !== -1) {
      produk.splice(idx, 1)
      await writeJSON(env, 'Produk', produk)
      await tgEditMessageText(env, chatId, messageId, 'Varian berhasil dihapus', { inline_keyboard: [[{ text: 'Kembali', callback_data: 'cad_varian' }]] })
    }
    return
  }

  if (data.startsWith('edit_harga_')) {
    const kode = data.replace('edit_harga_', '')
    const state = { action: 'editharga_varian', step: 'data', kode }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Silahkan kirimkan harga baru')
    return
  }

  if (data.startsWith('edit_nama_varian_')) {
    const kode = data.replace('edit_nama_varian_', '')
    const state = { action: 'editnama_varian', step: 'data', kode }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgEditMessageText(env, chatId, messageId, 'Silahkan kirimkan nama varian baru')
    return
  }

  if (data === 'edit_config') {
    const config = await readJSON(env, 'BotConfig', {})
    let text = '\u2699\ufe0f *Config Editor*\n\n'
    text += 'NamaBot: ' + NamaBot + '\n'
    text += 'StoreName: ' + StoreName + '\n'
    text += 'InvoiceLogger: ' + (InvoiceLogger || '(kosong)') + '\n'
    text += 'BannerFileId: ' + (BannerFileId || '(kosong)') + '\n'
    text += '\nGunakan /setconfig Key|Value untuk mengubah.'
    await tgEditMessageText(env, chatId, messageId, escapeMarkdown(text), { inline_keyboard: [[{ text: '\u2b05 Kembali', callback_data: 'manage' }]] })
    return
  }

  if (data === 'manage') {
    await tgSendMessage(env, chatId, 'Pilih opsi pengaturan:', getManagePanel())
    return
  }

  try { await tgAnswerCallbackQuery(env, cqId) } catch (e) {}
}

export { handleCallbackQuery }
