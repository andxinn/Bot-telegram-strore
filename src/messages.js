import { NamaBot, StoreName, OwnerID, ChannelLog, InvoiceLogger, ChannelStore, CS, Mode, SimulatePayment, SimulateDelay, ButtonMenu, BannerFileId, bannerStartB64, bannerListB64, orderBotName, caraOrderText, leaderboardEnabled, leaderboardBanner, channelTicket } from './config.js'
import { readJSON, writeJSON, readText, writeText, deleteKey, existsKey } from './kv.js'
import { tgSendMessage, tgSendPhoto, tgSendPhotoFile, tgSendPhotoUrl, tgSendPhotoBase64, tgEditMessageText, tgEditMessageCaption, tgDeleteMessage, tgAnswerCallbackQuery, tgSendDocument, tgSendChatAction, tgCreateForumTopic, tgReopenForumTopic, tgSendDocumentFile } from './telegram.js'
import { escapeMarkdown, mdSafe, ParseIdr, formatrupiah, formatWIB, getDate, getTanggalJam, chunkArray, sleep, generateTrxId, generateOrderId, expiredTime, boxFormat, loadingBar, generateTicketId } from './helpers.js'
import { getUserList, getUser, addUser, addSaldo, minSaldo, cekSaldo, isOwner, isRegistered, getRole, isBanned } from './user.js'
import { getMainMenuKeyboard, getProductNumberKeyboard, getReplyKeyboard } from './keyboard.js'
import { handleCommand } from './commands.js'
import { handleAdminState, showAdminPanel, recordStokBaru } from './admin.js'
import { ITEMS_PER_PAGE } from './constants.js'
import { generateQris } from './qris.js'
import { getActiveGateway, pakasirConfigured, calcFee, feeLabel, methodLabel, pakasirCreate, qrImageUrl } from './pakasir.js'
import { duitkuConfigured, duitkuCreateQris, providerLabel } from './duitku.js'

const pmSessions = {}

async function handleMessage(env, msg) {
  if (msg.chat.type !== 'private') {
    const tid = msg.message_thread_id

    // ── Admin membalas di dalam forum topic: teruskan ke user ──
    if (tid) {
      const tickets = await readJSON(env, 'Tickets', [])
      const tk = tickets.find(t => String(t.threadId) === String(tid))
      if (tk) {
        const m = msg
        const isCmd = m.text && m.text.trim().startsWith('/')
        if (!isCmd) {
          let textVal = (m.text || '').trim()
          let photoFileId = null
          let docFileId = null
          let docName = null
          if (m.photo && m.photo.length > 0) {
            photoFileId = m.photo[m.photo.length - 1].file_id
            textVal = m.caption ? m.caption.trim() : '[Foto]'
          } else if (m.document) {
            docFileId = m.document.file_id
            docName = m.document.file_name || 'file'
            textVal = m.caption ? m.caption.trim() : '[Dokumen: ' + docName + ']'
          }
          if (!textVal && !photoFileId && !docFileId) return

          const jamNow = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' })
          const jamHM = String(jamNow).slice(0, 5) + ' WIB'
          const msgObj = { sender: 'admin', text: textVal, time: jamHM, username: 'ADMIN' }
          if (photoFileId) msgObj.photoFileId = photoFileId
          if (docFileId) { msgObj.docFileId = docFileId; msgObj.docName = docName }

          tk.messages.push(msgObj)
          tk.status = 'answered'
          tk.lastAdminAt = Date.now()
          await writeJSON(env, 'Tickets', tickets)

          // Teruskan ke user
          const userChatId = tk.userId
          const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          let userMsg = '🔔 <b>Tanggapan Admin Baru!</b>\n'
          userMsg += '🎫 Tiket: <code>' + tk.ticketId + '</code>\n\n'
          userMsg += '💬 <b>Admin:</b> <i>"' + escH(textVal) + '"</i>\n'
          userMsg += '— ' + jamHM
          
          const kb = {
            inline_keyboard: [
              [
                { text: '✓ Selesai', callback_data: 'tk_close_' + tk.ticketId, style: 'success' },
                { text: '💬 Balas Pesan', callback_data: 'tk_follow_' + tk.ticketId, style: 'primary' }
              ]
            ]
          }

          let forwardOk = false
          if (photoFileId) {
            forwardOk = !!(await tgSendPhoto(env, userChatId, photoFileId, userMsg, kb, 'HTML'))?.ok
          } else if (docFileId) {
            forwardOk = !!(await tgSendDocumentFile(env, userChatId, docFileId, userMsg, kb, 'HTML'))?.ok
          } else {
            forwardOk = !!(await tgSendMessage(env, userChatId, userMsg, kb, 'HTML'))?.ok
          }

          // Kirim feedback status pengiriman ke admin (reply-to pesan admin)
          try {
            const feedback = forwardOk
              ? '✓ Pesan terkirim'
              : '✕ Gagal mengirim: Pengguna memblokir bot atau akun tidak aktif.'
            await tgSendMessage(env, msg.chat.id, feedback, null, 'Markdown', tid, msg.message_id)
          } catch (e) { console.error('[forum reply feedback]', e.message) }

          // Update label topik
          try {
            const { buildGroupTicketLogText, buildGroupTicketLogKeyboard } = await import('./admin.js')
            const newLogText = buildGroupTicketLogText(tk, '')
            const newLogKb = buildGroupTicketLogKeyboard(tk)
            if (tk.logChatId && tk.logMessageId) {
              await tgEditMessageText(env, tk.logChatId, tk.logMessageId, newLogText, newLogKb, 'HTML')
            }
          } catch (e) { console.error('[forum admin reply update log]', e.message) }
          return
        }
      }
    }

    // Pesan non-topic di grup tanpa thread → abaikan, KECUALI jika itu command (seperti /idgrup)
    const isCmd = msg.text && msg.text.trim().startsWith('/')
    if (!isCmd && !tid) return
  }
  if (!msg.text && !msg.document && !msg.photo && !msg.sticker) return
  const text = msg.text ? msg.text.trim() : ''
  const chatId = msg.chat.id
  const fromId = msg.from.id
  const fromName = msg.from.first_name || msg.from.username || 'User'
  const fromUsername = msg.from.username || 'Tidak ada username'

  if (await isBanned(env, fromId)) return

  if (text.startsWith('/') && text.toLowerCase() !== '/batal') {
    await handleCommand(env, msg)
    return
  }

  const pmSession = await readJSON(env, 'PMSessions', [])
  const mySession = pmSession.find(s => String(s.userChatId) === String(fromId) || String(s.ownerChatId) === String(fromId))
  if (mySession) {
    const targetId = String(mySession.userChatId) === String(fromId) ? mySession.ownerChatId : mySession.userChatId
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1].file_id
      await tgSendPhoto(env, targetId, photo, escapeMarkdown(fromName + ': ' + (msg.caption || '[photo]')))
    } else if (msg.document) {
      await tgSendDocument(env, targetId, '[document forwarded]', msg.document.file_name, escapeMarkdown(fromName + ': ' + (msg.caption || '[document]')))
    } else {
      await tgSendMessage(env, targetId, escapeMarkdown(fromName + ': ' + text))
    }
    return
  }

  // Reset semua state aktif jika user menekan tombol menu utama
  // agar klik tombol lain tidak terjebak di flow deposit/order/manage
  const MAIN_BUTTONS = [
    'List Produk', 'Stock', 'Riwayat Transaksi', 'Deposit',
    'Profil', 'Cara Order', 'Tiket Bantuan',
    '☰ List Produk', '☰ Stok',
    '📜 Riwayat Transaksi', '🔍 Cek Transaksi', '💳 Deposit',
    '👤 Profil', '❓ Cara Order',
    '🎫 Tiket Bantuan', '🔙 Kembali ke Menu Utama',
    '✧ Produk Populer', '🔥 Produk Populer', '🏆 Leaderboard'
  ]
  if (MAIN_BUTTONS.includes(text)) {
    await deleteKey(env, 'depositState_' + fromId)
    await deleteKey(env, 'manageState_' + fromId)
    await deleteKey(env, 'orderState_' + fromId)
    await deleteKey(env, 'adminState_' + fromId)
    await deleteKey(env, 'cekTrxState_' + fromId)
    await deleteKey(env, 'ticketState_' + fromId)
  }

  // Auto-delete user's manual input message in private chat to keep chat history clean
  if (msg.chat.type === 'private') {
    const hasInputState =
      (await existsKey(env, 'depositState_' + fromId)) ||
      (await existsKey(env, 'cekTrxState_' + fromId)) ||
      (await existsKey(env, 'ticketState_' + fromId)) ||
      (await existsKey(env, 'adminState_' + fromId)) ||
      (await existsKey(env, 'manageState_' + fromId))
    if (hasInputState) {
      try { await tgDeleteMessage(env, chatId, msg.message_id) } catch (e) {}
    }
  }

  // Cek Transaksi input state
  const cekTrxSt = await readJSON(env, 'cekTrxState_' + fromId, null)
  if (cekTrxSt && cekTrxSt.step === 'waiting') {
    await deleteKey(env, 'cekTrxState_' + fromId)
    if (cekTrxSt.promptMid) { try { await tgDeleteMessage(env, chatId, cekTrxSt.promptMid) } catch (e) {} }
    const inputId = text.trim().slice(0, 60)
    const trxList = await readJSON(env, 'Trx', [])
    // SECURITY: hanya tampilkan trx milik user sendiri
    const found = trxList.find(t => t.trxid === inputId && String(t.user_id) === String(fromId))
    if (!found) {
      await tgSendMessage(env, chatId, '✕ *Transaksi tidak ditemukan.*\n\nPastikan ID benar dan transaksi adalah milik Anda.', null, 'Markdown')
      return
    }
    const tgl2 = found.tanggal ? formatWIB(found.tanggal) : '-'
    let det = '☰ *Detail Transaksi*\n'
    det += '┌' + '─'.repeat(20) + '\n'
    det += '│ *ID:* `' + found.trxid + '`\n'
    det += '│ *Produk:* ' + (found.produk||'-') + '\n'
    det += '│ *Variasi:* ' + (found.varian||'-') + '\n'
    det += '│ *Jumlah:* x' + (found.jumlah||1) + '\n'
    det += '│ *Total:* Rp ' + (found.total||0).toLocaleString('id-ID') + '\n'
    det += '│ *Tanggal:* ' + tgl2 + '\n'
    det += '│ *Metode:* ' + (found.payment_method||'QRIS') + '\n'
    det += '│ *Status:* ' + (found.status==='Lunas'?'✓ Lunas':found.status||'-') + '\n'
    det += '└' + '─'.repeat(20)
    await tgSendMessage(env, chatId, det, null, 'Markdown')
    return
  }

  const adminState = await readJSON(env, 'adminState_' + fromId, null)
  if (adminState) {
    await handleAdminState(env, msg, adminState)
    return
  }

  const manageState = await readJSON(env, 'manageState_' + fromId, null)
  if (manageState) {
    await handleManageState(env, msg, manageState)
    return
  }

  const depositState = await readJSON(env, 'depositState_' + fromId, null)
  if (depositState) {
    await handleDepositState(env, msg, depositState)
    return
  }

  const ticketState = await readJSON(env, 'ticketState_' + fromId, null)
  if (ticketState) {
    await handleTicketState(env, msg, ticketState)
    return
  }

  if (text && (text === ButtonMenu.list || text.includes('List Produk'))) {
    await showProductList(env, chatId, fromId, fromName)
    return
  }

  if (text && (text === ButtonMenu.stock || text.includes('Stok') || text.toLowerCase().includes('stock'))) {
    await showStockInfo(env, chatId)
    return
  }

  if (text === 'Riwayat Transaksi' || text === '📜 Riwayat Transaksi') {
    await showRiwayat(env, chatId, fromId)
    return
  }

  if (text === 'Deposit' || text === '\ud83d\udcb3 Deposit') {
    const sent = await tgSendMessage(env, chatId, escapeMarkdown('💳 *Deposit Saldo*\n\nMasukkan jumlah deposit (angka):'))
    const promptMid = sent?.result?.message_id
    await writeJSON(env, 'depositState_' + fromId, { step: 'amount', promptMid })
    return
  }

  if (text === 'Profil' || text === '👤 Profil') {
    await showProfil(env, chatId, fromId)
    return
  }

  if (text === 'Cara Order' || text === '\u2753 Cara Order') {
    await showCaraOrder(env, chatId)
    return
  }

  if (text === '✧ Produk Populer' || text === '🔥 Produk Populer') {
    await showPopularProducts(env, chatId, fromId)
    return
  }

  if (text === '🏆 Leaderboard') {
    await showLeaderboard(env, chatId, fromId)
    return
  }

  if (text === '🎫 Tiket Bantuan' || text === 'Tiket Bantuan') {
    await showTicketMenu(env, chatId, fromId)
    return
  }

  if (text === '\ud83d\udd34 Disconnect') {
    const sessions = await readJSON(env, 'PMSessions', [])
    const idx = sessions.findIndex(s => String(s.userChatId) === String(fromId) || String(s.ownerChatId) === String(fromId))
    if (idx !== -1) {
      const session = sessions[idx]
      await tgSendMessage(env, session.userChatId, '\u23b1 Sesi telah berakhir')
      await tgSendMessage(env, session.ownerChatId, '\u23b1 Sesi telah berakhir')
      sessions.splice(idx, 1)
      await writeJSON(env, 'PMSessions', sessions)
      const kategori = await readJSON(env, 'Kategori', [])
      const user = await getUser(env, chatId)
      const keyboard = getMainMenuKeyboard()
      await tgSendMessage(env, chatId, 'Halo Kak *' + (user?.name || fromName) + '* \ud83d\ude0a\n\nPilih produk dengan menekan nomor berikut:', keyboard, 'Markdown')
    }
    return
  }

  if (text === '🔙 Kembali ke Menu Utama') {
    const kmbUser = await getUser(env, chatId) || await addUser(env, chatId, fromName)
    const mainKb = getMainMenuKeyboard()
    await tgSendMessage(env, chatId, 'Halo Kak *' + (kmbUser?.name || fromName) + '* 😊\n\nSilakan pilih menu:', mainKb, 'Markdown')
    return
  }

  if (text === '🔍 Cek Transaksi' || text === 'Cek Transaksi') {
    const bcfg = await readJSON(env, 'BotConfig', {})
    const rawPrefix = bcfg.orderBotName || bcfg.NamaBot || orderBotName || NamaBot || 'BOT'
    const prefix = (rawPrefix || 'BOT').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'BOT'
    const sent = await tgSendMessage(env, chatId,
      '🔍 *Cek Status Transaksi*\n\nMasukkan ID Pesanan kamu (contoh: `' + prefix + '-ORDERID-220726064513`):',
      null, 'Markdown')
    const promptMid = sent?.result?.message_id
    await writeJSON(env, 'cekTrxState_' + fromId, { step: 'waiting', promptMid })
    return
  }

  if (text.includes('Selanjutnya') || text.includes('Sebelumnya')) {
    const curPage = await readJSON(env, 'listPage_' + fromId, 1)
    const newPage = text.includes('Selanjutnya') ? curPage + 1 : curPage - 1
    await showProductList(env, chatId, fromId, fromName, newPage)
    return
  }

  if (/^\d+$/.test(text)) {
    try { await tgDeleteMessage(env, chatId, msg.message_id) } catch (e) {}
    await showVariants(env, chatId, parseInt(text), fromId)
    return
  }

  const fbUser = await getUser(env, chatId) || await addUser(env, chatId, fromName)
  const mainKbFb = getMainMenuKeyboard()
  await tgSendMessage(env, chatId, 'Halo Kak *' + mdSafe(fbUser.name) + '*' + ' 😊\n\nSilakan pilih menu:', mainKbFb, 'Markdown')
}

async function showProductList(env, chatId, fromId, fromName, page = 1) {
  const kategori = await readJSON(env, 'Kategori', [])
  if (kategori.length === 0) {
    await tgSendMessage(env, chatId, 'Belum ada produk tersedia.')
    return
  }
  let user = await getUser(env, chatId)
  if (!user) user = await addUser(env, chatId, fromName)
  const totalPages = Math.max(1, Math.ceil(kategori.length / ITEMS_PER_PAGE))
  const pg = Math.min(Math.max(1, page), totalPages)
  await writeJSON(env, 'listPage_' + fromId, pg)
  const caption = buildProductListCaption(kategori, pg)
  const replyKb = getProductNumberKeyboard(kategori, pg)
  await sendListCard(env, chatId, caption, replyKb, fromId)
}

function buildProductListCaption(kategori, page) {
  const totalPages = Math.max(1, Math.ceil(kategori.length / ITEMS_PER_PAGE))
  const pg = Math.min(Math.max(1, page), totalPages)
  const start = (pg - 1) * ITEMS_PER_PAGE
  const pageItems = kategori.slice(start, start + ITEMS_PER_PAGE)
  let cap = '╭───〔 ☰ LIST PRODUK 〕\n'
  cap += '┊ Halaman ' + pg + ' / ' + totalPages + '\n'
  cap += '├──────────────────\n'
  pageItems.forEach(k => { cap += '┊ *' + k.id + '* · ' + mdSafe(k.produkName) + '\n' })
  cap += '╰──────────────────\n\n'
  cap += ' Pilih nomor produk pada tombol di bawah'
  return cap
}

function buildLoadingText(percent) {
  return '⏳ *Memuat...*\n\n' + loadingBar(percent)
}

// Kirim teks dengan aman: kalau Markdown gagal di-parse, ulangi tanpa Markdown.
async function safeSendText(env, chatId, text, keyboard) {
  let r = null
  try { r = await tgSendMessage(env, chatId, text, keyboard) } catch (e) { r = null }
  if (r && r.ok) return r
  try { return await tgSendMessage(env, chatId, text, keyboard, '') } catch (e) { return r }
}
// Kirim kartu final sebagai PESAN BARU (tidak pernah meng-edit caption foto).
// - Pakai banner foto bila ada DAN caption <= 1000 char (batas caption foto 1024)
// - Kalau foto gagal / caption panjang / Markdown error -> fallback ke teks biasa
// Dengan begini kartu TIDAK PERNAH macet di "10%".
async function sendFinalCard(env, chatId, caption, keyboard, useBanner, customBannerB64 = null) {
  const activeBanner = customBannerB64 || bannerListB64
  const hasBanner = (activeBanner && activeBanner.length > 50) || (BannerFileId && BannerFileId !== '-')
  if (useBanner && hasBanner && caption.length <= 1000) {
    let sent = null
    try {
      if (activeBanner && activeBanner.length > 50) sent = await tgSendPhotoBase64(env, chatId, activeBanner, caption, keyboard)
      else sent = await tgSendPhotoFile(env, chatId, BannerFileId, caption, keyboard)
    } catch (e) { sent = null }
    if (sent && sent.ok && sent.result && sent.result.message_id) return sent.result.message_id
    // Foto gagal (mis. Markdown) -> coba lagi tanpa Markdown
    try {
      if (activeBanner && activeBanner.length > 50) sent = await tgSendPhotoBase64(env, chatId, activeBanner, caption, keyboard, '')
      else sent = await tgSendPhotoFile(env, chatId, BannerFileId, caption, keyboard, '')
    } catch (e) { sent = null }
    if (sent && sent.ok && sent.result && sent.result.message_id) return sent.result.message_id
  }
  const t = await safeSendText(env, chatId, caption, keyboard)
  return (t && t.result) ? t.result.message_id : null
}

// Kartu + animasi loading ANTI-STUCK.
// Loading ditampilkan sebagai PESAN TEKS (edit teks paling andal), lalu kartu
// final dikirim sebagai pesan baru dan pesan loading dihapus. Tidak ada lagi
// edit caption foto yang rapuh, jadi tidak pernah berhenti di "10%".
async function sendCardWithLoading(env, chatId, caption, keyboard, useBanner, fromId, customBannerB64 = null) {
  // Single-card flow: hapus kartu flow sebelumnya agar pesan tidak menumpuk
  if (fromId) {
    const prev = await readJSON(env, 'flowMsg_' + fromId, null)
    if (prev) { try { await tgDeleteMessage(env, chatId, prev) } catch (e) {} }
  }
  // 1) Loading sebagai teks
  let loadingMid = null
  try {
    const l = await tgSendMessage(env, chatId, buildLoadingText(10))
    loadingMid = (l && l.result) ? l.result.message_id : null
  } catch (e) {}
  // 2) Animasi loading berjalan SAMPAI 100% (edit teks -> andal, dibungkus try/catch)
  if (loadingMid) {
    for (const pct of [40, 70, 100]) {
      try { await tgEditMessageText(env, chatId, loadingMid, buildLoadingText(pct)) } catch (e) {}
      await sleep(250)
    }
  }
  // 3) Setelah loading 100%, kirim kartu final (foto + list produk) sebagai pesan baru
  const finalMid = await sendFinalCard(env, chatId, caption, keyboard, useBanner, customBannerB64)
  // 4) Hapus pesan loading -> tinggal foto + list produk yang tampil
  if (loadingMid) { try { await tgDeleteMessage(env, chatId, loadingMid) } catch (e) {} }
  if (fromId && finalMid) await writeJSON(env, 'flowMsg_' + fromId, finalMid)
  return finalMid
}
async function sendListCard(env, chatId, caption, replyKeyboard, fromId) {
  return await sendCardWithLoading(env, chatId, caption, replyKeyboard, true, fromId)
}

async function sendBannerCard(env, chatId, caption, keyboard, fromId) {
  return await sendCardWithLoading(env, chatId, caption, keyboard, true, fromId)
}

async function sendTextCard(env, chatId, caption, keyboard, fromId) {
  return await sendCardWithLoading(env, chatId, caption, keyboard, false, fromId)
}

function buildProductListView(kategori, page) {
  const totalPages = Math.max(1, Math.ceil(kategori.length / ITEMS_PER_PAGE))
  const pg = Math.min(Math.max(1, page), totalPages)
  const start = (pg - 1) * ITEMS_PER_PAGE
  const pageItems = kategori.slice(start, start + ITEMS_PER_PAGE)
  let cap = '╭───〔 ☰ LIST PRODUK 〕\n'
  cap += '┊ Halaman ' + pg + ' / ' + totalPages + '\n'
  cap += '├──────────────────\n'
  pageItems.forEach(k => { cap += '┊ *' + k.id + '* · ' + mdSafe(k.produkName) + '\n' })
  cap += '╰──────────────────\n\n'
  cap += 'Pilih produk lewat tombol di bawah '
  const rows = []
  let row = []
  for (const k of pageItems) {
    row.push({ text: String(k.id), callback_data: 'cat_' + k.id })
    if (row.length === 3) { rows.push(row); row = [] }
  }
  if (row.length) rows.push(row)
  const nav = []
  if (pg > 1) nav.push({ text: '⬅️ Prev', callback_data: 'prev_' + (pg - 1) })
  if (pg < totalPages) nav.push({ text: 'Next ➡️', callback_data: 'next_' + (pg + 1) })
  if (nav.length) rows.push(nav)
  rows.push([{ text: '🔙 Menu Utama', callback_data: 'to_menu' }])
  return { caption: cap, keyboard: { inline_keyboard: rows } }
}

function buildVariantView(kat, variants, fsMap = {}) {
  // v9update18: fsMap = { [variantId]: { salePrice, originalPrice, discountPercent, expiresAt } }
  let cap = '╭───〔 ☰ ' + mdSafe(kat.produkName) + ' 〕\n│\n'
  if (kat.desc) cap += '│ ' + mdSafe(String(kat.desc)) + '\n│\n'
  variants.forEach(v => {
    const st = v.stok ? v.stok.length : 0
    const fs = fsMap[String(v.id)]
    if (fs) {
      cap += '│ ' + v.id + ' ✧ *Varian* → ' + mdSafe(v.nameproduct) + '  ← FLASH SALE\n'
      cap += '│ ├ *Harga*  → ~Rp ' + (v.price || 0).toLocaleString('id-ID') + '~ → ✧ Rp ' + Number(fs.salePrice).toLocaleString('id-ID') + ' (-' + (fs.discountPercent || 0) + '%)\n'
      cap += '│ └ *Stok*   → ' + (st === 0 ? 'HABIS ✕' : st + ' tersedia ✓') + '\n│\n'
    } else {
      cap += '│ ' + v.id + ' *Varian* → ' + mdSafe(v.nameproduct) + '\n'
      cap += '│ ├ *Harga*  → Rp ' + (v.price || 0).toLocaleString('id-ID') + '\n'
      cap += '│ └ *Stok*   → ' + (st === 0 ? 'HABIS ✕' : st + ' tersedia ✓') + '\n│\n'
    }
  })
  cap += '╰───────────────────────\nPilih varian di bawah '
  const rows = []
  let row = []
  for (const v of variants) {
    const fs = fsMap[String(v.id)]
    const prefix = fs ? '✧ ' : ''
    row.push({ text: prefix + '[' + v.id + '] ' + v.nameproduct + ((v.stok ? v.stok.length : 0) === 0 ? ' · Habis' : ''), callback_data: 'dpi_' + v.id })
    if (row.length === 2) { rows.push(row); row = [] }
  }
  if (row.length) rows.push(row)
  rows.push([{ text: '🔙 Kembali', callback_data: 'back_to_list' }])
  return { caption: cap, keyboard: { inline_keyboard: rows } }
}

function buildOrderView(os, p) {
  const htmlEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const stock = p.stok ? p.stok.length : 0
  const qty = os.jumlahPesanan
  // v9update18: use locked effective price from orderState (falls back to p.price)
  const effPrice = (os && os.price != null) ? Number(os.price) : (p.price || 0)
  const total = effPrice * qty
  const jam = getTanggalJam().jam
  let cap = '╭───〔 ▤ KONFIRMASI ORDER 〕\n'
  cap += '<pre>'
  if (p.desc) cap += 'Detail : ' + htmlEsc(String(p.desc)) + '\n\n'
  cap += 'Produk : ' + htmlEsc(os.produk) + '\n'
  cap += 'Varian : ' + htmlEsc(os.varian) + '\n'
  // v9update18: FS badge in harga line
  if (os && os.isFlashSale && os.originalPrice) {
    cap += 'Harga  : Rp ' + effPrice.toLocaleString('id-ID') + ' (SALE)\n'
  } else {
    cap += 'Harga  : Rp ' + effPrice.toLocaleString('id-ID') + '\n'
  }
  cap += 'Stok   : ' + stock + ' tersedia\n'
  cap += '─────────────────\n'
  cap += 'Jumlah : x' + qty + '\n'
  cap += 'Total  : Rp ' + total.toLocaleString('id-ID') + '\n'
  cap += '</pre>\n'
  cap += '<blockquote>Diperbarui pada ' + jam + ' WIB</blockquote>'
  const kb = { inline_keyboard: [
    [{ text: '-1', callback_data: 'decrease_' + p.id, style: 'danger' }, { text: '+1', callback_data: 'increase_' + p.id, style: 'success' }, { text: '-5', callback_data: 'dec5_' + p.id, style: 'danger' }, { text: '+5', callback_data: 'inc5_' + p.id, style: 'success' }],
    [{ text: '✓ Konfirmasi Pesanan', callback_data: 'confirm_' + p.id + '_' + qty, style: 'primary' }],
    [{ text: '\u21bb Refresh Stok', callback_data: 'refresh_' + p.id }],
    [{ text: '🔙 Kembali', callback_data: 'back_to_variants' }]
  ] }
  return { caption: cap, keyboard: kb, parseMode: 'HTML' }
}

function buildPaymentView(os, saldo, payInfo) {
  const total = os.totalPrice
  const cukup = saldo >= total
  let cap = '╭───〔 💳 PEMBAYARAN 〕\n'
  cap += '<pre>'
  cap += 'Produk : ' + mdSafe(os.produk) + '\n'
  cap += 'Varian : ' + mdSafe(os.varian) + '\n'
  cap += 'Jumlah : x' + os.jumlahPesanan + '\n'
  cap += '─────────────────\n'
  cap += 'Total  : Rp ' + total.toLocaleString('id-ID') + '\n'
  cap += 'Saldo  : Rp ' + saldo.toLocaleString('id-ID') + '\n'
  cap += '</pre>\n'
  cap += 'Pilih metode pembayaran di bawah '
  payInfo = payInfo || { enabled: true, label: 'Bayar via QRIS' }
  const rows = []
  if (payInfo.enabled) rows.push([{ text: '💳 ' + payInfo.label, callback_data: 'pay_qris_' + os.productId + '_' + os.jumlahPesanan, style: 'primary' }])
  if (cukup) rows.push([{ text: '💰 Bayar via Saldo (Rp' + total.toLocaleString('id-ID') + ')', callback_data: 'pay_saldo_' + os.productId + '_' + os.jumlahPesanan, style: 'success' }])
  else rows.push([{ text: '✕ Saldo Kurang (Rp' + saldo.toLocaleString('id-ID') + ')', callback_data: 'pay_saldo_insufficient', style: 'danger' }])
  rows.push([{ text: '🔙 Batal', callback_data: 'pay_cancel_' + os.productId, style: 'danger' }])
  return { caption: cap, keyboard: { inline_keyboard: rows }, parseMode: 'HTML' }
}

async function sendProductListPage(env, chatId, kategori, page) {
  const view = buildProductListView(kategori, page)
  await sendBannerCard(env, chatId, view.caption, view.keyboard)
}

async function showVariants(env, chatId, kategoriId, fromId) {
  const kategori = await readJSON(env, 'Kategori', [])
  const kat = kategori.find(k => k.id === kategoriId)
  if (!kat) {
    await tgSendMessage(env, chatId, 'Produk tidak ditemukan. Ketik nomor yang benar.')
    return
  }
  const produk = await readJSON(env, 'Produk', [])
  const variants = produk.filter(p => p.category === kat.produkId)
  if (variants.length === 0) {
    await tgSendMessage(env, chatId, 'Belum ada varian untuk produk ini.')
    return
  }
  // v9update18: build fsMap dari FlashSale KV utk tampilkan badge
  const fsAll = await readJSON(env, 'FlashSale', {})
  const _nowFs = Date.now()
  const fsMap = {}
  for (const _v of variants) {
    const _fs = fsAll[String(_v.id)]
    if (_fs && _fs.expiresAt && _nowFs < Number(_fs.expiresAt)) fsMap[String(_v.id)] = _fs
  }
  const view = buildVariantView(kat, variants, fsMap)
  await sendBannerCard(env, chatId, view.caption, view.keyboard, fromId)
}

async function showStockInfo(env, chatId) {
  const produk = await readJSON(env, 'Produk', [])
  const withStock = produk
  if (withStock.length === 0) {
    await tgSendMessage(env, chatId, 'Maaf, toko ini tidak memiliki stok yang tersedia.')
    return
  }
  let cap = '╭───〔 ☰ INFO STOK 〕\n'
  cap += '┊ ⌚ ' + getDate('Asia/Jakarta') + ' WIB\n'
  cap += '├──────────────────\n'
  for (const v of withStock) {
    const cnt = (v.stok ? v.stok.length : 0)
    const mark = cnt > 0 ? '✓' : '✕'
    cap += '┊ ' + mark + ' *' + v.id + '* · ' + mdSafe(v.nameproduct) + ' ➜ ' + cnt + 'x\n'
  }
  cap += '╰──────────────────\n\n👉 Ketik nomor produk untuk membeli'
  const keyboard = { inline_keyboard: [[{ text: '↻ Refresh', callback_data: 'refreshh' }]] }
  await sendTextCard(env, chatId, cap, keyboard)
}

async function showRiwayat(env, chatId, fromId) {
  const trx = await readJSON(env, 'Trx', [])
  const userTrx = trx.filter(t => String(t.user_id) === String(fromId))
  if (userTrx.length === 0) {
    await tgSendMessage(env, chatId, '📜 Belum ada riwayat transaksi.')
    return
  }
  const PER_PAGE = 5
  const totalPages = Math.ceil(userTrx.length / PER_PAGE)
  const view = buildRiwayatView(userTrx, 1, totalPages)
  await sendTextCard(env, chatId, view.text, view.keyboard)
}

function buildRiwayatView(userTrx, page, totalPages) {
  const PER_PAGE = 5
  const pg = Math.min(Math.max(1, page), totalPages)
  const start = (pg - 1) * PER_PAGE
  const items = userTrx.slice().reverse().slice(start, start + PER_PAGE)
  let text = '╭───〔 📜 RIWAYAT TRANSAKSI 〕\n'
  text += '┊ 📊 Halaman *' + pg + '* dari *' + totalPages + '* (Total ' + userTrx.length + ' Trx)\n'
  let itemNum = start + 1
  for (const t of items) {
    const tgl = t.tanggal ? formatWIB(t.tanggal) : '-'
    const status = t.status === 'Lunas' ? '✓ *Lunas*' : (t.status ? ('⚠️ *' + mdSafe(t.status) + '*') : '-')
    const method = t.payment_method ? mdSafe(t.payment_method) : 'Saldo'
    text += '├───────────────────\n'
    text += '┊ *' + (itemNum++) + '.* 🆔 `' + (t.trxid || '-') + '`\n'
    text += '┊ ☰ *' + mdSafe(t.produk || '-') + '* (' + mdSafe(t.varian || '-') + ')\n'
    text += '┊ 💵 *Rp ' + (t.total || 0).toLocaleString('id-ID') + '* (' + (t.jumlah || 1) + ' pcs)\n'
    text += '┊ 📅 ' + tgl + '\n'
    text += '┊ 💳 ' + method + ' · ' + status + '\n'
  }
  text += '╰───────────────────'
  const nav = []
  if (pg > 1) nav.push({ text: '⬅️ Sebelum', callback_data: 'riwayat_page_' + (pg - 1) })
  if (pg < totalPages) nav.push({ text: 'Lanjut ➡️', callback_data: 'riwayat_page_' + (pg + 1) })
  const rows = []
  if (nav.length) rows.push(nav)
  return { text: text, keyboard: { inline_keyboard: rows }, parseMode: 'Markdown' }
}

async function sendRiwayatPage(env, chatId, userTrx, page, totalPages) {
  const view = buildRiwayatView(userTrx, page, totalPages)
  await tgSendMessage(env, chatId, view.text, view.keyboard, 'Markdown')
}

async function showProfil(env, chatId, fromId) {
  const user = await getUser(env, chatId)
  if (!user) { await tgSendMessage(env, chatId, 'Belum terdaftar. /start untuk mendaftar.'); return }
  const trx = await readJSON(env, 'Trx', [])
  const userTrx = trx.filter(t => String(t.user_id) === String(chatId))
  const totalQty = userTrx.reduce((acc, t) => acc + (t.jumlah || 0), 0)
  const totalAmount = userTrx.reduce((acc, t) => acc + (t.total || 0), 0)
  let tglGabung = user.age || '-'
  try {
    if (user.age) {
      const bulanID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
      const p = String(user.age).split('T')[0].split('-')
      if (p.length === 3) tglGabung = parseInt(p[2], 10) + ' ' + bulanID[parseInt(p[1], 10) - 1] + ' ' + p[0]
    }
  } catch (e) {}
  let cap = '╭───〔 👤 PROFIL 〕───\n'
  cap += '┊ 👋 ' + mdSafe(user.name) + '\n'
  cap += '├──────────────────\n'
  cap += '┊ 🆔 ID        : `' + user.chatId + '`\n'
  cap += '┊ 🏦 Bank ID   : `' + (user.bankid || '-') + '`\n'
  cap += '├──────────────────\n'
  cap += '┊ 💰 Saldo     : ' + ParseIdr(user.balance || 0) + '\n'
  cap += '┊ ✦ Transaksi : ' + totalQty + 'x\n'
  cap += '┊ 💸 Belanja   : ' + ParseIdr(totalAmount) + '\n'
  cap += '├──────────────────\n'
  cap += '┊ 📅 Bergabung : ' + tglGabung + '\n'
  cap += '╰──────────────────\n'
  cap += '\n💡 Isi saldo lewat 💳 Deposit'
  await sendTextCard(env, chatId, cap, null)
}

async function showCaraOrder(env, chatId) {
  if (caraOrderText && caraOrderText.trim().length > 0) {
    await tgSendMessage(env, chatId, caraOrderText, null, 'Markdown')
    return
  }
  let pesan = '📖 *CARA ORDER*\n' + '━'.repeat(21) + '\n\n'
  pesan += '1️⃣ Klik *List Produk*\n'
  pesan += '2️⃣ Tekan nomor produk\n'
  pesan += '3️⃣ Pilih varian\n'
  pesan += '4️⃣ Atur jumlah pesanan\n'
  pesan += '5️⃣ Klik *Confirm Order* ✓\n'
  pesan += '6️⃣ Pilih metode bayar (QRIS / Saldo)\n'
  pesan += '7️⃣ Bayar & produk dikirim otomatis\n\n'
  pesan += '*🗝️ Catatan:*\n'
  pesan += '• Transfer tepat sesuai nominal\n'
  pesan += '• Transaksi kadaluarsa 5 menit\n'
  pesan += '• Hubungi admin jika ada kendala'
  await tgSendMessage(env, chatId, pesan, null, 'Markdown')
}

async function handleDepositState(env, msg, state) {
  const text = msg.text ? msg.text.trim() : ''
  const chatId = msg.chat.id
  const fromId = msg.from.id
  if (text === '/batal') {
    if (state.promptMid) { try { await tgDeleteMessage(env, chatId, state.promptMid) } catch (e) {} }
    await deleteKey(env, 'depositState_' + fromId)
    await tgSendMessage(env, chatId, 'Deposit dibatalkan.', getMainMenuKeyboard())
    return
  }
  if (state.step === 'amount') {
    const amount = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(amount) || amount < 5000) {
      if (state.promptMid) { try { await tgDeleteMessage(env, chatId, state.promptMid) } catch (e) {} }
      const warningSent = await tgSendMessage(env, chatId, 'Minimal deposit Rp5.000. Masukkan angka:')
      state.promptMid = warningSent?.result?.message_id
      await writeJSON(env, 'depositState_' + fromId, state)
      return
    }
    if (state.promptMid) { try { await tgDeleteMessage(env, chatId, state.promptMid) } catch (e) {} }
    if (SimulatePayment) {
      await addSaldo(env, chatId, amount)
      await deleteKey(env, 'depositState_' + fromId)
      const saldo = await cekSaldo(env, chatId)
      await tgSendMessage(env, chatId, escapeMarkdown('╭───〔 ▤ DEPOSIT BERHASIL ✓ 〕──\n┊ *Jumlah :* ' + ParseIdr(amount) + '\n┊ *Saldo  :* ' + ParseIdr(saldo) + '\n╰──────────────────\n\n_(Simulasi - langsung sukses)_'), getMainMenuKeyboard())
      return
    }
    const agD = await getActiveGateway(env)
    const gwD = agD.gw
    // ─── Orkut branch (QRIS-only Private Gateway) ───
    if (agD.name === 'orkut') {
      const { orkutConfigured, orkutCreateQris } = await import('./orkut.js')
      if (!orkutConfigured(gwD)) {
        await deleteKey(env, 'depositState_' + fromId)
        await tgSendMessage(env, chatId, '⚠️ Payment gateway deposit (Orkut) belum aktif. Hubungi admin.')
        return
      }
      const depoFeeOk = calcFee(gwD, amount)
      const depoChargeOk = amount + depoFeeOk
      const trxIdOk = generateTrxId()
      const createdOk = await orkutCreateQris(gwD, trxIdOk, depoChargeOk, gwD.expiryPeriod || 10)
      if (!createdOk.ok) {
        await deleteKey(env, 'depositState_' + fromId)
        await tgSendMessage(env, chatId, '✕ Gagal membuat transaksi Orkut: ' + (createdOk.error || 'coba lagi'))
        return
      }
      const finalTotalOk = Number(createdOk.totalBayar || depoChargeOk)
      const orkutUnique = Math.max(0, finalTotalOk - depoChargeOk)
      const orkutDepoExpMin = Number(gwD.expiryPeriod || 10)
      const expiredOk = expiredTime(orkutDepoExpMin)
      const sessionOk = {
        id: trxIdOk, status: 'pending', depositDetails: {
          userId: chatId, depo_id: trxIdOk, type: 'deposit',
          total_amount: finalTotalOk, amount: amount,
          expired: expiredOk, key: null, nama: msg.from.first_name, username: msg.from.username,
          provider: 'orkut', orkut_amount: finalTotalOk,
          orkut_reference: createdOk.reference, orkut_qr: createdOk.qrString, orkut_qrLink: createdOk.qrLink,
          orkut_ref: createdOk.reference,
          orkut_gw: { baseUrl: gwD.baseUrl, apiKey: gwD.apiKey, expiryPeriod: gwD.expiryPeriod },
          expiryMinutes: orkutDepoExpMin,
          display_total: finalTotalOk
        }
      }
      const sesOk = await readJSON(env, 'SessionDeposit', [])
      sesOk.push(sessionOk)
      await writeJSON(env, 'SessionDeposit', sesOk)
      await deleteKey(env, 'depositState_' + fromId)
      let pesanOk = '╭───〔 ▤ DEPOSIT via QRIS 〕───\n'
      pesanOk += '┊ *Jumlah     :* ' + ParseIdr(amount) + '\n'
      if (depoFeeOk > 0) pesanOk += '┊ *Fee (' + feeLabel(gwD) + '):* ' + ParseIdr(depoFeeOk) + '\n'
      if (orkutUnique > 0) pesanOk += '┊ *Kode Unik  :* ' + ParseIdr(orkutUnique) + '\n'
      pesanOk += '┊ *Total Bayar :* ' + ParseIdr(finalTotalOk) + '\n'
      pesanOk += '├──────────────────\n'
      pesanOk += '┊ *ID Trx     :* ' + trxIdOk + '\n'
      pesanOk += '┊ *Reference  :* `' + (createdOk.reference || '-') + '`\n'
      pesanOk += '╰──────────────────\n\n'
      pesanOk += '⏰ Kadaluwarsa dalam *' + orkutDepoExpMin + ' menit*\n'
      pesanOk += '📲 Scan QRIS di bawah untuk membayar'
      const depoRowsOk = [[{ text: '✕ Batalkan', callback_data: 'batal_deposit_' + trxIdOk, style: 'danger' }]]
      const keyboardOk = { inline_keyboard: depoRowsOk }
      const qrImgOk = createdOk.qrString
        ? ('https://quickchart.io/qr?text=' + encodeURIComponent(createdOk.qrString) + '&size=400')
        : createdOk.qrLink
      if (qrImgOk) {
        const sentOk = await tgSendPhotoUrl(env, chatId, qrImgOk, pesanOk, keyboardOk)
        try {
          const keyMsgOk = sentOk && sentOk.result && sentOk.result.message_id
          if (keyMsgOk) {
            const sesOk2 = await readJSON(env, 'SessionDeposit', [])
            const idxOk = sesOk2.findIndex(s => s.id === trxIdOk)
            if (idxOk >= 0) { sesOk2[idxOk].depositDetails.key = keyMsgOk; await writeJSON(env, 'SessionDeposit', sesOk2) }
          }
        } catch (e) {}
      } else {
        await tgSendMessage(env, chatId, pesanOk, keyboardOk, 'Markdown')
      }
      return
    }
    // ─── Duitku branch (QRIS-only) ───
    if (agD.name === 'duitku') {
      if (!duitkuConfigured(gwD)) {
        await deleteKey(env, 'depositState_' + fromId)
        await tgSendMessage(env, chatId, '⚠️ Payment gateway deposit (Duitku) belum aktif. Hubungi admin.')
        return
      }
      const depoFeeDk = calcFee(gwD, amount)
      const depoChargeDk = amount + depoFeeDk
      const trxIdDk = generateTrxId()
      const createdDk = await duitkuCreateQris(gwD, trxIdDk, depoChargeDk, {
        productDetails: 'Deposit ' + (msg.from.first_name || 'user'),
        customerName: msg.from.first_name || 'Customer',
        email: (msg.from.username ? msg.from.username : ('u' + chatId)) + '@bot.local',
        callbackUrl: '', returnUrl: ''
      })
      if (!createdDk.ok) {
        await deleteKey(env, 'depositState_' + fromId)
        await tgSendMessage(env, chatId, '✕ Gagal membuat transaksi Duitku: ' + (createdDk.error || 'coba lagi'))
        return
      }
      // Duitku mengembalikan expiry yang dipakai (sudah di-clamp per provider)
      const dkDepoExpMin = Number(createdDk && createdDk.expiry) > 0 ? Number(createdDk.expiry) : Number(gwD.expiryPeriod || 5)
      const expiredDk = expiredTime(dkDepoExpMin)
      const sessionDk = {
        id: trxIdDk, status: 'pending', depositDetails: {
          userId: chatId, depo_id: trxIdDk, type: 'deposit',
          total_amount: depoChargeDk, amount: amount,
          expired: expiredDk, key: null, nama: msg.from.first_name, username: msg.from.username,
          provider: 'duitku', duitku_amount: depoChargeDk, duitku_provider: gwD.qrisProvider,
          duitku_reference: createdDk.reference, duitku_qr: createdDk.qrString,
          duitku_paymentUrl: createdDk.paymentUrl,
          duitku_gw: { merchantCode: gwD.merchantCode, apiKey: gwD.apiKey, mode: gwD.mode, qrisProvider: gwD.qrisProvider },
          expiryMinutes: dkDepoExpMin,
          display_total: depoChargeDk
        }
      }
      const sesDk = await readJSON(env, 'SessionDeposit', [])
      sesDk.push(sessionDk)
      await writeJSON(env, 'SessionDeposit', sesDk)
      await deleteKey(env, 'depositState_' + fromId)
      let pesanDk = '╭───〔 ▤ DEPOSIT via ' + providerLabel(gwD.qrisProvider) + ' 〕───\n'
      pesanDk += '┊ *Jumlah     :* ' + ParseIdr(amount) + '\n'
      if (depoFeeDk > 0) pesanDk += '┊ *Fee (' + feeLabel(gwD) + '):* ' + ParseIdr(depoFeeDk) + '\n'
      pesanDk += '┊ *Total Bayar :* ' + ParseIdr(depoChargeDk) + '\n'
      pesanDk += '├──────────────────\n'
      pesanDk += '┊ *ID Trx     :* ' + trxIdDk + '\n'
      pesanDk += '┊ *Reference  :* `' + (createdDk.reference || '-') + '`\n'
      pesanDk += '╰──────────────────\n\n'
      pesanDk += '⏰ Kadaluwarsa dalam *' + dkDepoExpMin + ' menit*\n'
      pesanDk += '📲 Scan QRIS di bawah untuk membayar'
      const depoRowsDk = [[{ text: '✕ Batalkan', callback_data: 'batal_deposit_' + trxIdDk, style: 'danger' }]]
      if (gwD.mode === 'sandbox') depoRowsDk.unshift([{ text: '🧪 Simulasi Bayar', callback_data: 'simulbayar_' + trxIdDk, style: 'primary' }])
      const keyboardDk = { inline_keyboard: depoRowsDk }
      if (createdDk.qrString) {
        const { qrImageUrl: dkQr } = await import('./duitku.js')
        const sentDk = await tgSendPhotoUrl(env, chatId, dkQr(createdDk.qrString), pesanDk, keyboardDk)
        try {
          const keyMsgDk = sentDk && sentDk.result && sentDk.result.message_id
          if (keyMsgDk) {
            const sesDk2 = await readJSON(env, 'SessionDeposit', [])
            const idxDk = sesDk2.findIndex(s => s.id === trxIdDk)
            if (idxDk >= 0) { sesDk2[idxDk].depositDetails.key = keyMsgDk; await writeJSON(env, 'SessionDeposit', sesDk2) }
          }
        } catch (e) {}
      } else {
        await tgSendMessage(env, chatId, pesanDk, keyboardDk, 'Markdown')
      }
      return
    }
    // ─── Pakasir branch (default) ───
    if (!pakasirConfigured(gwD)) {
      await deleteKey(env, 'depositState_' + fromId)
      await tgSendMessage(env, chatId, '⚠️ Payment gateway deposit belum aktif. Hubungi admin.')
      return
    }
    const depoFee = calcFee(gwD, amount)
    const depoCharge = amount + depoFee
    const trxId = generateTrxId()
    const createdD = await pakasirCreate(gwD, trxId, depoCharge)
    if (!createdD.ok) {
      await deleteKey(env, 'depositState_' + fromId)
      await tgSendMessage(env, chatId, '✕ Gagal membuat transaksi Pakasir: ' + (createdD.error || 'coba lagi'))
      return
    }
    const payD = createdD.payment
    const paymentNumberD = payD.payment_number || ''
    const displayTotalD = Number(payD.total_payment || depoCharge)
    const isQrisD = (gwD.method || 'qris') === 'qris'
    const expired = expiredTime()
    const session = {
      id: trxId, status: 'pending', depositDetails: {
        userId: chatId, depo_id: trxId, type: 'deposit',
        total_amount: depoCharge, amount: amount,
        expired, key: null, nama: msg.from.first_name, username: msg.from.username,
        provider: 'pakasir', pakasir_amount: depoCharge, pakasir_method: gwD.method,
        pakasir_gw: { slug: gwD.slug, apiKey: gwD.apiKey, method: gwD.method, mode: gwD.mode },
        expiryMinutes: 5,
        display_total: displayTotalD
      }
    }
    const sessions = await readJSON(env, 'SessionDeposit', [])
    sessions.push(session)
    await writeJSON(env, 'SessionDeposit', sessions)
    await deleteKey(env, 'depositState_' + fromId)
    let pesan = '╭───〔 ▤ DEPOSIT via ' + methodLabel(gwD.method) + ' 〕───\n'
    pesan += '┊ *Jumlah      :* ' + ParseIdr(amount) + '\n'
    if (depoFee > 0) pesan += '┊ *Fee (' + feeLabel(gwD) + ') :* ' + ParseIdr(depoFee) + '\n'
    pesan += '┊ *Total Bayar :* ' + ParseIdr(displayTotalD) + '\n'
    pesan += '├──────────────────\n'
    pesan += '┊ *ID Trx      :* ' + trxId + '\n'
    pesan += '╰──────────────────\n\n'
    if (!isQrisD) pesan += '🏦 Nomor VA: `' + paymentNumberD + '`\n(ketuk untuk menyalin)\n'
    pesan += '⏰ Kadaluwarsa dalam *5 menit*\n' + (isQrisD ? '📲 Scan QRIS di bawah untuk membayar' : '💸 Bayar ke Virtual Account di atas')
    const depoRows = [[{ text: '\u274c Batalkan', callback_data: 'batal_deposit_' + trxId, style: 'danger' }]]
    if (gwD.mode === 'sandbox') depoRows.unshift([{ text: '🧪 Simulasi Bayar', callback_data: 'simulbayar_' + trxId, style: 'primary' }])
    const keyboard = { inline_keyboard: depoRows }
    let keyMsgP = null
    if (isQrisD && paymentNumberD) {
      const qrUrl = qrImageUrl(paymentNumberD)
      const sentP = await tgSendPhotoUrl(env, chatId, qrUrl, escapeMarkdown(pesan), keyboard)
      keyMsgP = sentP && sentP.result && sentP.result.message_id
    } else {
      const sentP = await tgSendMessage(env, chatId, escapeMarkdown(pesan), keyboard)
      keyMsgP = sentP && sentP.result && sentP.result.message_id
    }
    if (keyMsgP) {
      const sesP = await readJSON(env, 'SessionDeposit', [])
      const idxP = sesP.findIndex(s => s.id === trxId)
      if (idxP >= 0) { sesP[idxP].depositDetails.key = keyMsgP; await writeJSON(env, 'SessionDeposit', sesP) }
    }
    const total = displayTotalD
    if (InvoiceLogger) {
      const tj = getTanggalJam()
      let logPesan = '\ud83d\udcb3 *Deposit Dibuat*\n\n'
      logPesan += '\u279c *Nama:* ' + msg.from.first_name + '\n'
      logPesan += '\u279c *Username:* @' + (msg.from.username || '-') + '\n'
      logPesan += '\u2792 *Amount:* ' + ParseIdr(total) + '\n'
      logPesan += '\u2792 *Trx ID:* ' + trxId + '\n'
      logPesan += '\u2792 *Tanggal:* ' + tj.tanggal + ' ' + tj.jam
      const logKeyboard = { inline_keyboard: [[{ text: 'Link to user', url: 'tg://user?id=' + chatId }]] }
      await tgSendMessage(env, InvoiceLogger, escapeMarkdown(logPesan), logKeyboard)
    }
  }
}

async function handleManageState(env, msg, state) {
  const text = msg.text ? msg.text.trim() : ''
  const chatId = msg.chat.id
  const fromId = msg.from.id
  const { action, step, data, kode } = state

  if (text === '/selesai' || text === '/batal') {
    await deleteKey(env, 'manageState_' + fromId)
    await tgSendMessage(env, chatId, 'Dibatalkan.')
    return
  }

  if (action === 'bci') {
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1].file_id
      const caption = msg.caption || ''
      const users = await getUserList(env)
      let sent = 0
      for (const user of users) {
        try { await tgSendPhoto(env, user.chatId, photo, escapeMarkdown(caption)); sent++; await sleep(50) } catch (e) {}
      }
      await deleteKey(env, 'manageState_' + fromId)
      await tgSendMessage(env, chatId, '\u2705 Broadcast image terkirim ke ' + sent + '/' + users.length + ' user.')
    } else {
      await tgSendMessage(env, chatId, 'Kirim gambar dengan caption!')
    }
    return
  }

  if (action === 'addproduk') {
    const kategori = await readJSON(env, 'Kategori', [])
    if (step === 'nama') {
      state.step = 'desc'; state.data = { nama: text }
      await writeJSON(env, 'manageState_' + fromId, state)
      await tgSendMessage(env, chatId, 'Nama: ' + text + '\n\nMasukkan deskripsi (atau - untuk skip):')
      return
    }
    if (step === 'desc') {
      state.data.desc = text === '-' ? '' : text
      const newId = kategori.length > 0 ? Math.max(...kategori.map(k => k.id)) + 1 : 1
      const produkId = state.data.nama.toLowerCase().replace(/\s+/g, '_') + '_' + newId
      kategori.push({ id: newId, produkName: state.data.nama, produkId, produkXuid: 'X' + String(newId).padStart(3, '0'), desc: state.data.desc })
      await writeJSON(env, 'Kategori', kategori)
      await deleteKey(env, 'manageState_' + fromId)
      await tgSendMessage(env, chatId, '\u2705 Produk ditambahkan: ' + state.data.nama + ' (ID: ' + newId + ')')
      return
    }
  }

  if (action === 'addvarian') {
    const produk = await readJSON(env, 'Produk', [])
    if (step === 'nama') {
      state.step = 'harga'; state.data = { nama: text }
      await writeJSON(env, 'manageState_' + fromId, state)
      await tgSendMessage(env, chatId, 'Nama varian: ' + text + '\n\nMasukkan harga (angka):')
      return
    }
    if (step === 'harga') {
      const harga = parseInt(text.replace(/[^0-9]/g, ''))
      if (isNaN(harga) || harga <= 0) { await tgSendMessage(env, chatId, 'Harga tidak valid.'); return }
      state.step = 'kategori'; state.data.harga = harga
      await writeJSON(env, 'manageState_' + fromId, state)
      const kategori = await readJSON(env, 'Kategori', [])
      let text2 = 'Pilih kategori (ketik nomor):\n'
      kategori.forEach(k => text2 += k.id + '. ' + k.produkName + '\n')
      await tgSendMessage(env, chatId, text2, null, 'Markdown')
      return
    }
    if (step === 'kategori') {
      const kategori = await readJSON(env, 'Kategori', [])
      const kat = kategori.find(k => k.id === parseInt(text))
      if (!kat) { await tgSendMessage(env, chatId, 'Nomor tidak valid.'); return }
      const newId = produk.length > 0 ? Math.max(...produk.map(p => p.id)) + 1 : 1
      produk.push({ id: newId, nameproduct: state.data.nama, price: state.data.harga, category: kat.produkId, desc: '', stok: [] })
      await writeJSON(env, 'Produk', produk)
      await deleteKey(env, 'manageState_' + fromId)
      await tgSendMessage(env, chatId, '\u2705 Varian ditambahkan: ' + state.data.nama + ' (ID: ' + newId + ') - ' + ParseIdr(state.data.harga))
      return
    }
  }

  if (action === 'addstock') {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    if (lines.length === 0) { await tgSendMessage(env, chatId, 'Tidak ada data.'); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.kode))
    if (!p) { await deleteKey(env, 'manageState_' + fromId); await tgSendMessage(env, chatId, 'Produk tidak ditemukan.'); return }
    if (!p.stok) p.stok = []
    for (const line of lines) {
      p.stok.push({ info: line, expired_at: null })
    }
    await writeJSON(env, 'Produk', produk)
    await recordStokBaru(env, state.kode, lines.length)
    await deleteKey(env, 'manageState_' + fromId)
    await tgSendMessage(env, chatId, '\u2705 ' + lines.length + ' stok ditambah ke ' + p.nameproduct + '. Total: ' + p.stok.length)
    return
  }

  if (action === 'addstock_multi') {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    if (lines.length === 0) { await tgSendMessage(env, chatId, 'Tidak ada data.'); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.kode))
    if (!p) { await deleteKey(env, 'manageState_' + fromId); return }
    if (!p.stok) p.stok = []
    for (const line of lines) {
      const parts = line.split('|')
      p.stok.push({ info: parts[0], expired_at: parts[1] || null })
    }
    await writeJSON(env, 'Produk', produk)
    await recordStokBaru(env, state.kode, lines.length)
    await deleteKey(env, 'manageState_' + fromId)
    await tgSendMessage(env, chatId, '\u2705 ' + lines.length + ' stok ditambah. Total: ' + p.stok.length)
    return
  }

  if (action === 'editnama_varian') {
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.kode))
    if (p) { p.nameproduct = text; await writeJSON(env, 'Produk', produk); await tgSendMessage(env, chatId, '\u2705 Nama varian diubah: ' + text) }
    await deleteKey(env, 'manageState_' + fromId)
    return
  }

  if (action === 'editharga_varian') {
    const harga = parseInt(text.replace(/[^0-9]/g, ''))
    if (isNaN(harga) || harga <= 0) { await tgSendMessage(env, chatId, 'Harga tidak valid.'); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(state.kode))
    if (p) { p.price = harga; await writeJSON(env, 'Produk', produk); await tgSendMessage(env, chatId, '\u2705 Harga diubah: ' + ParseIdr(harga)) }
    await deleteKey(env, 'manageState_' + fromId)
    return
  }

  if (action === 'editnama_produk') {
    const kategori = await readJSON(env, 'Kategori', [])
    const k = kategori.find(kat => String(kat.id) === String(state.kode))
    if (k) { k.produkName = text; await writeJSON(env, 'Kategori', kategori); await tgSendMessage(env, chatId, '\u2705 Nama produk diubah: ' + text) }
    await deleteKey(env, 'manageState_' + fromId)
    return
  }
}

async function showPopularProducts(env, chatId, fromId) {
  const trx = await readJSON(env, 'Trx', [])
  const now = Date.now()
  const oneWeek = 7 * 24 * 60 * 60 * 1000
  const oneMonth = 30 * 24 * 60 * 60 * 1000

  const getPopularList = (sinceMs) => {
    const list = {}
    for (const t of trx) {
      if (t.status !== 'Lunas') continue
      if (sinceMs) {
        const tMs = new Date(t.tanggal).getTime()
        if (tMs < now - sinceMs) continue
      }
      const key = (t.produk && t.varian) ? `${t.produk} - ${t.varian}` : (t.varian || t.produk || 'Produk')
      list[key] = (list[key] || 0) + (t.jumlah || 0)
    }
    return Object.entries(list)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5)
  }

  const wList = getPopularList(oneWeek)
  const mList = getPopularList(oneMonth)
  const aList = getPopularList(null)

  let cap = '╭───〔 ✧ PRODUK POPULER 〕───\n'
  cap += '├──────────────────\n'
  
  cap += '⚡ *Rame Dibeli Minggu Ini*\n'
  if (wList.length === 0) {
    cap += '┊ _Belum ada penjualan minggu ini_\n'
  } else {
    wList.forEach((item, index) => {
      cap += '┊ ' + (index + 1) + '. ' + mdSafe(item.name) + ' (' + item.qty + 'x) ✧\n'
    })
  }
  cap += '├──────────────────\n'

  cap += '📅 *Rame Dibeli Bulan Ini*\n'
  if (mList.length === 0) {
    cap += '┊ _Belum ada penjualan bulan ini_\n'
  } else {
    mList.forEach((item, index) => {
      cap += '┊ ' + (index + 1) + '. ' + mdSafe(item.name) + ' (' + item.qty + 'x) ✧\n'
    })
  }
  cap += '├──────────────────\n'

  cap += '🏆 *Paling Banyak Dibeli (All-Time)*\n'
  if (aList.length === 0) {
    cap += '┊ _Belum ada penjualan_\n'
  } else {
    aList.forEach((item, index) => {
      cap += '┊ ' + (index + 1) + '. ' + mdSafe(item.name) + ' (' + item.qty + 'x)\n'
    })
  }
  cap += '╰──────────────────\n\n'
  cap += 'Silakan pilih menu di bawah '

  await sendTextCard(env, chatId, cap, getMainMenuKeyboard(), fromId)
}

async function showLeaderboard(env, chatId, fromId) {
  if (leaderboardEnabled === false) {
    await tgSendMessage(env, chatId, '⚠️ *Menu Leaderboard saat ini sedang dinonaktifkan oleh Admin.*', getMainMenuKeyboard(), 'Markdown')
    return
  }

  const trx = await readJSON(env, 'Trx', [])
  const users = await getUserList(env)
  
  const stats = {}
  for (const t of trx) {
    if (t.status !== 'Lunas') continue
    const uid = String(t.user_id)
    if (!stats[uid]) {
      stats[uid] = { total: 0, count: 0 }
    }
    stats[uid].total += (t.total || 0)
    stats[uid].count += 1
  }

  const sorted = Object.entries(stats)
    .map(([uid, data]) => {
      const u = users.find(usr => String(usr.chatId) === uid)
      return {
        name: u ? u.name : 'User',
        total: data.total,
        count: data.count
      }
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)

  let cap = '╭───〔 🏆 LEADERBOARD 〕───\n'
  cap += '┊ *Top 10 Pembeli Terbanyak*\n'
  cap += '├──────────────────\n'

  if (sorted.length === 0) {
    cap += '┊ _Belum ada data peringkat_\n'
  } else {
    const medals = ['🥇', '🥈', '🥉']
    sorted.forEach((item, index) => {
      const prefix = medals[index] || (index + 1) + '.'
      const formattedTotal = ParseIdr(item.total)
      cap += '┊ ' + prefix + ' *' + mdSafe(item.name) + '*\n'
      cap += '┊   ├ Belanja : `' + formattedTotal + '`\n'
      cap += '┊   └ Order   : `' + item.count + ' kali`\n'
    })
  }
  cap += '╰──────────────────\n\n'
  cap += 'Silakan pilih menu di bawah '

  const hasLbBanner = leaderboardBanner && leaderboardBanner.length > 50
  if (hasLbBanner) {
    await sendCardWithLoading(env, chatId, cap, getMainMenuKeyboard(), true, fromId, leaderboardBanner)
  } else {
    await sendTextCard(env, chatId, cap, getMainMenuKeyboard(), fromId)
  }
}

async function showTicketMenu(env, chatId, fromId) {
  let cap = '╭───〔 🎫 TIKET BANTUAN 〕───\n'
  cap += '┊ Punya masalah atau butuh bantuan?\n'
  cap += '┊ Silakan buat tiket baru atau cek\n'
  cap += '┊ daftar tiket aktif Anda di bawah.\n'
  cap += '╰──────────────────\n\n'
  cap += ' Pilih opsi di bawah:'
  
  const kb = {
    inline_keyboard: [
      [{ text: '➕ Buat Tiket Baru', callback_data: 'tk_create' }],
      [{ text: '📋 Daftar Tiket Saya', callback_data: 'tk_list' }],
      [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'to_menu' }]
    ]
  }
  await sendTextCard(env, chatId, cap, kb, fromId)
}

async function handleTicketState(env, msg, state) {
  const text = msg.text ? msg.text.trim() : ''
  const chatId = msg.chat.id
  const fromId = msg.from.id
  const fromName = msg.from.first_name || msg.from.username || 'User'
  const fromUsername = msg.from.username || 'Tidak ada username'

  if (text === '/batal' || text === '🔙 Kembali ke Menu Utama') {
    if (state.cardMessageId) { try { await tgDeleteMessage(env, chatId, state.cardMessageId) } catch (e) {} }
    await deleteKey(env, 'ticketState_' + fromId)
    await tgSendMessage(env, chatId, 'Pembuatan tiket dibatalkan.', getMainMenuKeyboard(), 'Markdown')
    return
  }

  if (state.step === 'input_msg') {
    let textVal = text
    let photoFileId = null
    let docFileId = null
    let docName = null

    if (msg.photo && msg.photo.length > 0) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id
      textVal = msg.caption ? msg.caption.trim() : '[Foto]'
    } else if (msg.document) {
      docFileId = msg.document.file_id
      docName = msg.document.file_name || 'file'
      textVal = msg.caption ? msg.caption.trim() : '[Dokumen: ' + docName + ']'
    }

    if (!photoFileId && !docFileId && textVal.length < 5) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '📝 *BUAT TIKET BARU*\n\n⚠️ *Detail laporan terlalu pendek (minimal 5 karakter).* Silakan ketik kembali:\n\n_Ketik /batal jika ingin membatalkan._',
          null, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Detail laporan terlalu pendek. Tulis minimal 5 karakter:')
      }
      return
    }

    if (state.cardMessageId) { try { await tgDeleteMessage(env, chatId, state.cardMessageId) } catch (e) {} }
    await deleteKey(env, 'ticketState_' + fromId)

    const tickets = await readJSON(env, 'Tickets', [])
    const ticketId = generateTicketId(msg.from.username, fromName)
    const jamNow = getTanggalJam()
    const jamHM = String(jamNow.jam).slice(0, 5) + ' WIB'
    const userUsn = msg.from.username ? '@' + msg.from.username : fromName
    
    const msgObj = { sender: 'user', text: textVal, time: jamHM, username: userUsn }
    if (photoFileId) msgObj.photoFileId = photoFileId
    if (docFileId) {
      msgObj.docFileId = docFileId
      msgObj.docName = docName
    }

    const newTicket = {
      ticketId,
      userId: fromId,
      userName: fromName,
      userUsername: msg.from.username || '',
      status: 'open',
      createdAt: new Date().toISOString(),
      messages: [msgObj]
    }

    const logger = channelTicket || InvoiceLogger
    if (logger) {
      let isTopicSuccess = false
      let threadId = null
      let apiErrorDesc = ''
      
      try {
        const shortId = ticketId.split('-')[1] || 'TKT'
        const topicRes = await tgCreateForumTopic(env, logger, '🎫 [' + shortId + '] ' + fromName)
        if (topicRes && topicRes.ok && topicRes.result) {
          isTopicSuccess = true
          threadId = topicRes.result.message_thread_id
          newTicket.threadId = threadId
        } else {
          apiErrorDesc = topicRes?.description || 'Unknown API Error'
          console.error('[tgCreateForumTopic FAILED]', topicRes)
        }
      } catch (e) {
        apiErrorDesc = e.message
        console.error('[tgCreateForumTopic CATCH ERROR]', e)
      }

      if (!isTopicSuccess) {
        try {
          await tgSendMessage(env, OwnerID, '🚫 *DIAGNOSIS ERROR TOPIC*\n\nBot gagal membuat topik otomatis di Grup Support. Balasan dari server Telegram:\n`' + apiErrorDesc + '`\n\nPastikan:\n1. ID Grup (`'+logger+'`) diawali `-100`\n2. Grup tersebut di-upgrade ke Supergroup (buat jadi grup publik sebentar atau atur histori terlihat)\n3. Fitur "Topics" / "Topik" dinyalakan\n4. Bot adalah admin dengan izin Manage Topics.', null, 'Markdown')
        } catch(e) {}
      }

      try {
        const { buildGroupTicketLogText, buildGroupTicketLogKeyboard } = await import('./admin.js')
        let logText = buildGroupTicketLogText(newTicket)
        if (!isTopicSuccess) {
          logText = '⚠️ <b>SISTEM TOPIK GAGAL AKTIF</b>\n<i>Tiket masuk tanpa kamar topik karena penolakan Telegram. Cek chat owner untuk detail error.</i>\n\n' + logText
        }
        
        const logKb = buildGroupTicketLogKeyboard(newTicket)
        const logRes = await tgSendMessage(env, logger, logText, logKb, 'HTML', threadId)
        
        if (logRes && logRes.result && logRes.result.message_id) {
          newTicket.logChatId = logger
          newTicket.logMessageId = logRes.result.message_id
        }

        if (photoFileId) {
          await tgSendPhoto(env, logger, photoFileId, '🖼️ Foto Lampiran dari User', null, 'Markdown', threadId)
        } else if (docFileId) {
          await tgSendDocumentFile(env, logger, docFileId, '📄 Berkas Lampiran dari User: ' + docName, null, 'Markdown', threadId)
        }
      } catch (e) {
        console.error('[Fallback Send Ticket CATCH ERROR]', e)
      }
    }

    tickets.push(newTicket)
    await writeJSON(env, 'Tickets', tickets)
    await tgSendMessage(env, chatId, '✓ *Tiket Berhasil Dibuat!*\n\nID Tiket: `' + ticketId + '`\nAdmin akan segera menjawab laporan Anda.', getMainMenuKeyboard(), 'Markdown')
    return
  }

  if (state.step === 'follow_up') {
    let textVal = text
    let photoFileId = null
    let docFileId = null
    let docName = null

    if (msg.photo && msg.photo.length > 0) {
      photoFileId = msg.photo[msg.photo.length - 1].file_id
      textVal = msg.caption ? msg.caption.trim() : '[Foto]'
    } else if (msg.document) {
      docFileId = msg.document.file_id
      docName = msg.document.file_name || 'file'
      textVal = msg.caption ? msg.caption.trim() : '[Dokumen: ' + docName + ']'
    }

    if (!photoFileId && !docFileId && textVal.length < 2) {
      if (state.cardMessageId) {
        await tgEditMessageText(env, chatId, state.cardMessageId,
          '📝 *FOLLOW UP TIKET: ' + state.ticketId + '*\n\n⚠️ *Pesan terlalu pendek.* Silakan ketik kembali:\n\n_Ketik /batal jika batal._',
          null, 'Markdown'
        )
      } else {
        await tgSendMessage(env, chatId, '⚠️ Pesan follow up terlalu pendek. Silakan ketik kembali:')
      }
      return
    }

    if (state.cardMessageId) { try { await tgDeleteMessage(env, chatId, state.cardMessageId) } catch (e) {} }
    await deleteKey(env, 'ticketState_' + fromId)

    const tickets = await readJSON(env, 'Tickets', [])
    const tIdx = tickets.findIndex(t => t.ticketId === state.ticketId)
    if (tIdx === -1) {
      await tgSendMessage(env, chatId, '⚠️ Tiket tidak ditemukan.', getMainMenuKeyboard())
      return
    }

    const jamNow = getTanggalJam()
    const jamHM = String(jamNow.jam).slice(0, 5) + ' WIB'
    const userUsn = msg.from.username ? '@' + msg.from.username : fromName

    const msgObj = { sender: 'user', text: textVal, time: jamHM, username: userUsn }
    if (photoFileId) msgObj.photoFileId = photoFileId
    if (docFileId) {
      msgObj.docFileId = docFileId
      msgObj.docName = docName
    }

    tickets[tIdx].status = 'open'
    tickets[tIdx].messages.push(msgObj)
    await writeJSON(env, 'Tickets', tickets)

    const t = tickets[tIdx]
    // Teruskan follow-up user ke dalam forum topic
    if (t.logChatId && t.threadId) {
      try {
        const usn = t.userUsername ? '@' + t.userUsername : (t.userName || 'User')
        let fMsg = '<b>' + escH(usn) + '</b> (' + jamHM + ')\npesan : ' + escH(textVal)
        if (photoFileId) {
          await tgSendPhoto(env, t.logChatId, photoFileId, fMsg, null, 'HTML', t.threadId)
        } else if (docFileId) {
          await tgSendDocumentFile(env, t.logChatId, docFileId, fMsg, null, 'HTML', t.threadId)
        } else {
          await tgSendMessage(env, t.logChatId, fMsg, null, 'HTML', t.threadId)
        }
      } catch (e) {
        console.error('[forum follow up send]', e.message)
      }
    }

    await tgSendMessage(env, chatId, '✓ *Follow up terkirim!* Harap tunggu tanggapan admin.', getMainMenuKeyboard(), 'Markdown')

    if (t.logChatId && t.logMessageId) {
      try {
        const { buildGroupTicketLogText, buildGroupTicketLogKeyboard } = await import('./admin.js')
        const logText = buildGroupTicketLogText(t)
        const logKb = buildGroupTicketLogKeyboard(t)
        const logRes = await tgEditMessageText(env, t.logChatId, t.logMessageId, logText, logKb, 'HTML')
        if (logRes && !logRes.ok) {
          console.error('[tgEditMessageText FOLLOW UP ERROR]', logRes)
        }
      } catch (e) {
        console.error('[tgEditMessageText FOLLOW UP CATCH ERROR]', e)
      }
    }
  }
}

function escH(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function sendTxLog(env, { type, user, produk, varian, total, reason, fileTxtContent, fileName }) {
  const targetChannel = ChannelLog || InvoiceLogger
  if (!targetChannel) return

  let targetChatId = targetChannel
  let targetThreadId = null
  if (String(targetChannel).includes(':')) {
    const parts = String(targetChannel).split(':')
    targetChatId = parts[0]
    targetThreadId = parts[1]
  }

  const username = user.username ? '@' + String(user.username).replace(/@/g, '') : 'Tidak ada username'
  const userId = user.id || user.chatId || '0'
  const cleanTotal = ParseIdr(total)
  
  const d = new Date()
  const jakartaTime = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }))
  const dd = ('0' + jakartaTime.getDate()).slice(-2)
  const mm = ('0' + (jakartaTime.getMonth() + 1)).slice(-2)
  const yyyy = jakartaTime.getFullYear()
  const hh = ('0' + jakartaTime.getHours()).slice(-2)
  const mi = ('0' + jakartaTime.getMinutes()).slice(-2)
  const waktu = `${dd}-${mm}-${yyyy} ${hh}:${mi} WIB`

  if (type === 'success') {
    let logText = '🟩 <b>LOG TRANSAKSI SUKSES</b> 🟩\n'
    logText += '━━━━━━━━━━━━━━━━━━━━━━━\n'
    logText += '• Pembeli : ' + escH(username) + ' (<code>' + userId + '</code>)\n'
    logText += '• Produk  : ' + escH(produk) + ' (' + escH(varian || '-') + ')\n'
    logText += '• Waktu   : ' + waktu + '\n'
    logText += '• Total   : ' + cleanTotal + ' (Lunas)\n'
    logText += '━━━━━━━━━━━━━━━━━━━━━━━\n'
    
    try {
      if (fileTxtContent && fileName) {
        await tgSendDocument(env, targetChatId, fileTxtContent, fileName, logText, null, 'HTML', targetThreadId)
      } else {
        await tgSendMessage(env, targetChatId, logText, null, 'HTML', targetThreadId)
      }
    } catch (e) {
      console.error('[sendTxLog success error]', e.message)
    }
  } else {
    let logText = '🟥 <b>LOG TRANSAKSI GAGAL</b> 🟥\n'
    logText += '━━━━━━━━━━━━━━━━━━━━━━━\n'
    logText += '• Pembeli : ' + escH(username) + ' (<code>' + userId + '</code>)\n'
    logText += '• Produk  : ' + escH(produk) + ' (' + escH(varian || '-') + ')\n'
    logText += '• Waktu   : ' + waktu + '\n'
    logText += '• Total   : ' + cleanTotal + '\n'
    logText += '• Alasan  : ' + escH(reason || 'Dibatalkan') + '\n'
    logText += '━━━━━━━━━━━━━━━━━━━━━━━\n'
    
    try {
      await tgSendMessage(env, targetChatId, logText, null, 'HTML', targetThreadId)
    } catch (e) {
      console.error('[sendTxLog failed error]', e.message)
    }
  }
}

export { handleMessage, showProductList, sendProductListPage, showVariants, sendRiwayatPage, sendBannerCard, sendTextCard, buildProductListView, buildVariantView, buildOrderView, buildPaymentView, buildRiwayatView, showPopularProducts, showLeaderboard, showTicketMenu, handleTicketState, sendTxLog }
