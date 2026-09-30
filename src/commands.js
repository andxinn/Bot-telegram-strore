import { showAdminPanel, recordStokBaru } from './admin.js'
import { NamaBot, StoreName, OwnerID, OwnerUsername, ChannelLog, InvoiceLogger, ChannelStore, CS, Mode, SimulatePayment, SimulateDelay, ButtonMenu, BannerFileId, bannerStartB64, initConfig } from './config.js'
import { readJSON, writeJSON, readText, writeText, deleteKey, existsKey } from './kv.js'
import { tgSendMessage, tgSendPhoto, tgSendPhotoFile, tgSendPhotoUrl, tgSendPhotoBase64, tgEditMessageText, tgDeleteMessage, tgAnswerCallbackQuery, tgSendDocument, tgSendChatAction, tgSetMyCommands } from './telegram.js'
import { escapeMarkdown, mdSafe, ParseIdr, formatrupiah, formatWIB, getDate, getTanggalJam, chunkArray, sleep, generateTrxId, boxFormat } from './helpers.js'
import { getUserList, getUser, addUser, addSaldo, minSaldo, cekSaldo, isOwner, isRegistered, getRole, addRole, demoteRole, isBanned, addBan, delBan } from './user.js'
import { getReplyKeyboard, getManagePanel } from './keyboard.js'
import { ITEMS_PER_PAGE } from './constants.js'

async function checkAdminCommand(env, msg) {
  const isAuthorized = isOwner(msg.from.id) || await getRole(env, msg.from.id) === 'admin'
  if (!isAuthorized && msg.chat.type === 'private') {
    await tgSendMessage(env, msg.chat.id, '🚫 Akses ditolak.')
  }
  return isAuthorized
}

async function checkOwnerCommand(env, msg) {
  const isAuthorized = isOwner(msg.from.id)
  if (!isAuthorized && msg.chat.type === 'private') {
    await tgSendMessage(env, msg.chat.id, '🚫 Akses ditolak.')
  }
  return isAuthorized
}

async function checkPromoterCommand(env, msg) {
  const isAuthorized = isOwner(msg.from.id) || await getRole(env, msg.from.id) === 'promoter'
  if (!isAuthorized && msg.chat.type === 'private') {
    await tgSendMessage(env, msg.chat.id, '❌ No Permission')
  }
  return isAuthorized
}

async function handleCommand(env, msg) {
  const text = msg.text || ''
  const chatId = msg.chat.id
  const fromId = msg.from.id
  const fromName = msg.from.first_name || msg.from.username || 'User'
  const fromUsername = msg.from.username || 'Tidak ada username'
  const [cmd, ...args] = text.trim().split(/\s+/)
  let command = cmd.toLowerCase()
  if (command.includes('@')) {
    command = command.split('@')[0]
  }

  if (await isBanned(env, fromId)) {
    return
  }

  if (command === '/close' || command === '/selesai') {
    const tid = msg.message_thread_id
    if (!tid) {
      if (msg.chat.type === 'private') {
        await tgSendMessage(env, chatId, '⚠️ Perintah ini hanya bisa digunakan di dalam grup topik tiket.')
      }
      return
    }
    const isAuthorized = isOwner(fromId) || (await getRole(env, fromId)) === 'admin'
    if (!isAuthorized) return

    const tickets = await readJSON(env, 'Tickets', [])
    const idx = tickets.findIndex(t => String(t.threadId) === String(tid))
    if (idx !== -1) {
      const t = tickets[idx]
      t.status = 'closed'
      t.closedAt = Date.now()
      await writeJSON(env, 'Tickets', tickets)

      const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const userMsg = '🔒 <b>Tiket Bantuan Selesai</b>\n🎫 Tiket: <code>' + t.ticketId + '</code>\n\nPercakapan tiket bantuan ini telah ditutup oleh Admin. Terima kasih.'
      const { getMainMenuKeyboard } = await import('./keyboard.js')
      await tgSendMessage(env, t.userId, userMsg, getMainMenuKeyboard(), 'HTML')

      const { tgDeleteForumTopic } = await import('./telegram.js')
      try {
        await tgDeleteForumTopic(env, msg.chat.id, tid)
      } catch (e) {}
    }
    return
  }

  if (command === '/idgrup' || command === '/idgroup') {
    const isAuthorized = isOwner(fromId) || (await getRole(env, fromId)) === 'admin'
    if (!isAuthorized) {
      if (msg.chat.type === 'private') {
        await tgSendMessage(env, chatId, '🚫 Akses ditolak.')
      }
      return
    }
    const title = msg.chat.title || 'Private Chat'
    const cap = 
      '╭───〔 👥 ID GRUP TELEGRAM 〕───\n' +
      '┊ Nama Grup : ' + mdSafe(title) + '\n' +
      '┊ ID Grup   : `' + chatId + '`\n' +
      '╰──────────────────\n\n' +
      '📌 Salin ID di atas untuk dimasukkan ke Admin Settings -> 👥 Setting Grup Support Tiket.'
    await tgSendMessage(env, chatId, cap, null, 'Markdown')
    return
  }

  if (command === '/start') {
    const user = await addUser(env, chatId, fromName)
    const kategori = await readJSON(env, 'Kategori', [])
    const trx = await readJSON(env, 'Trx', [])
    const userTrx = trx.filter(t => String(t.user_id) === String(chatId))
    const totalQty = userTrx.reduce((s, t) => s + (t.jumlah || 0), 0)
    const totalUsers = (await getUserList(env)).length
    const jamNow = getTanggalJam()
    const jamNum = parseInt(String(jamNow.jam).split(':')[0], 10) || 0
    let salam = '🌙 Selamat Malam'
    if (jamNum >= 5 && jamNum <= 10) salam = '🌅 Selamat Pagi'
    else if (jamNum >= 11 && jamNum <= 14) salam = '☀️ Selamat Siang'
    else if (jamNum >= 15 && jamNum <= 18) salam = '🌇 Selamat Sore'
    const jamHM = String(jamNow.jam).slice(0, 5)
    const uname = (fromUsername && fromUsername !== 'Tidak ada username') ? ('`@' + fromUsername + '`') : '(belum diatur)'
    const caption = escapeMarkdown(
      '╭───〔 ' + salam + ' 〕───\n' +
      '┊ 👋 Hai, ' + mdSafe(user.name) + '!\n' +
      '┊ 👤 ' + uname + '\n' +
      '├──────────────────\n' +
      '┊ *ID*\n' +
      '┊ └ `' + user.chatId + '`\n' +
      '┊ *Saldo*\n' +
      '┊ └ ' + formatrupiah(user.balance || 0) + '\n' +
      '┊ *Tanggal*\n' +
      '┊ └ ' + jamNow.tanggal + '\n' +
      '┊ *Jam*\n' +
      '┊ └ ' + jamHM + ' WIB\n' +
      '├──────────────────\n' +
      '┊ *Total Transaksi*\n' +
      '┊ └ ' + totalQty + 'x\n' +
      '┊ *Total User Bot*\n' +
      '┊ └ ' + totalUsers + '\n' +
      '╰──────────────────\n' +
      '\nSilakan pilih menu di bawah 👇'
    )
    const keyboard = getReplyKeyboard(kategori)
    if (bannerStartB64 && bannerStartB64.length > 50) {
      await tgSendPhotoBase64(env, chatId, bannerStartB64, caption, keyboard)
    } else if (BannerFileId && BannerFileId !== '-') {
      await tgSendPhotoFile(env, chatId, BannerFileId, caption, keyboard)
    } else {
      await tgSendMessage(env, chatId, caption, keyboard)
    }
    return
  }

  if (command === '/pm') {
    if (String(fromId) === String(OwnerID)) {
      await tgSendMessage(env, chatId, 'Owner tidak dapat message ke diri sendiri.')
      return
    }
    const keyboard = {
      inline_keyboard: [[
        { text: 'Ya', callback_data: 'acceptcallyes_' + chatId },
        { text: 'Tidak', callback_data: 'staff_call_cancel' }
      ]]
    }
    await tgSendMessage(env, chatId, 'Apakah Kamu Ingin menghubungi admin? jika iya silahkan klik tombol dibawah ini', keyboard)
    return
  }

  if (command === '/list_tiket' || command === '/listtiket') {
    if (!(await checkAdminCommand(env, msg))) return
    const { showAdminTicketCategory } = await import('./admin.js')
    await showAdminTicketCategory(env, chatId)
    return
  }

  if (command === '/adminmenu' || command === '/admin') {
    if (!(await checkAdminCommand(env, msg))) return
    await showAdminPanel(env, chatId)
    return
  }

  if (command === '/manager') {
    if (!(await checkAdminCommand(env, msg))) return
    await tgSendMessage(env, chatId, 'Pilih opsi pengaturan yang ingin kamu lakukan', getManagePanel())
    return
  }

  // /addstock tanpa args -> buka panel interaktif
  if (command === '/addstock' && args.length === 0) {
    if (!(await checkAdminCommand(env, msg))) return
    await showAdminPanel(env, chatId)
    return
  }

  if (command === '/addstock') {
    if (!(await checkAdminCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) {
      await tgSendMessage(env, chatId, 'Format salah! Gunakan: /addstock <id>|<data_akun>|<expired_days>', null, 'Markdown')
      return
    }
    const [id, info, expiredDays] = input.split('|').map(s => s.trim())
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(id))
    if (!p) { await tgSendMessage(env, chatId, 'ID tidak ditemukan.'); return }
    let expiredAt = null
    if (expiredDays && !isNaN(parseInt(expiredDays))) {
      const d = new Date()
      d.setDate(d.getDate() + parseInt(expiredDays))
      expiredAt = d.toISOString().slice(0, 19).replace('T', ' ')
    }
    if (!p.stok) p.stok = []
    p.stok.push({ info, expired_at: expiredAt })
    await writeJSON(env, 'Produk', produk)
    await recordStokBaru(env, id, 1)
    await tgSendMessage(env, chatId, '\u2705 Item berhasil ditambahkan\n\nID: ' + id + '\nInfo: ' + info + (expiredAt ? '\nExpired: ' + expiredAt : ''), null, 'Markdown')
    return
  }

  if (command === '/editharga') {
    if (!(await checkAdminCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) {
      await tgSendMessage(env, chatId, 'Format salah! Gunakan: /editharga id|harga_baru', null, 'Markdown')
      return
    }
    const [id, price] = input.split('|').map(s => s.trim())
    if (isNaN(price)) { await tgSendMessage(env, chatId, 'Harga harus angka!'); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(id))
    if (p) { p.price = parseInt(price); await writeJSON(env, 'Produk', produk); await tgSendMessage(env, chatId, '\u2705 Harga ID ' + id + ' diperbarui menjadi ' + price) }
    else { await tgSendMessage(env, chatId, 'ID tidak ditemukan.') }
    return
  }

  if (command === '/editsnk') {
    if (!(await checkAdminCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) {
      await tgSendMessage(env, chatId, 'Format salah! Gunakan: /editsnk id|syarat_dan_ketentuan', null, 'Markdown')
      return
    }
    const [ids, snk] = input.split('|').map(s => s.trim())
    const id = parseInt(ids)
    const snkList = await readJSON(env, 'SnK', [])
    const find = snkList.find(s => s.id === id)
    if (find) { find.snk = snk } else { snkList.push({ id, snk }) }
    await writeJSON(env, 'SnK', snkList)
    await tgSendMessage(env, chatId, '\u2705 SnK ID ' + id + ' diperbarui.')
    return
  }

  if (command === '/addlist') {
    if (!(await checkOwnerCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) {
      await tgSendMessage(env, chatId, 'Format: /addlist namaproduk|deskripsi', null, 'Markdown')
      return
    }
    const [name, desc] = input.split('|').map(s => s.trim())
    const kategori = await readJSON(env, 'Kategori', [])
    const newId = kategori.length > 0 ? Math.max(...kategori.map(k => k.id)) + 1 : 1
    const produkId = name.toLowerCase().replace(/\s+/g, '_') + '_' + newId
    kategori.push({ id: newId, produkName: name, produkId, produkXuid: 'X' + String(newId).padStart(3, '0') })
    await writeJSON(env, 'Kategori', kategori)
    await tgSendMessage(env, chatId, '\u2705 Produk ditambahkan: ' + name + ' (ID: ' + newId + ')')
    return
  }

  if (command === '/editnama') {
    if (!(await checkOwnerCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) {
      await tgSendMessage(env, chatId, 'Format: /editnama id|nama_baru', null, 'Markdown')
      return
    }
    const [id, name] = input.split('|').map(s => s.trim())
    const kategori = await readJSON(env, 'Kategori', [])
    const k = kategori.find(kat => String(kat.id) === String(id))
    if (k) { k.produkName = name; await writeJSON(env, 'Kategori', kategori); await tgSendMessage(env, chatId, '\u2705 Nama diperbarui: ' + name) }
    else { await tgSendMessage(env, chatId, 'ID tidak ditemukan.') }
    return
  }

  if (command === '/editdesc') {
    if (!(await checkAdminCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) {
      await tgSendMessage(env, chatId, 'Format: /editdesc id|deskripsi_baru', null, 'Markdown')
      return
    }
    const [id, desc] = input.split('|').map(s => s.trim())
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(id))
    if (p) { p.desc = desc; await writeJSON(env, 'Produk', produk); await tgSendMessage(env, chatId, '\u2705 Deskripsi diperbarui.') }
    else { await tgSendMessage(env, chatId, 'ID tidak ditemukan.') }
    return
  }

  if (command === '/drop') {
    if (!(await checkOwnerCommand(env, msg))) return
    const input = args.join(' ')
    const parts = input.split(/\s+/)
    const id = parseInt(parts[0])
    const jumlah = parts[1] === 'all' ? 'all' : parseInt(parts[1])
    if (isNaN(id)) { await tgSendMessage(env, chatId, 'Format: /drop <id> <jumlah|all>'); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(id))
    if (!p || !p.stok || p.stok.length === 0) { await tgSendMessage(env, chatId, 'Stok tidak ditemukan.'); return }
    const take = jumlah === 'all' ? p.stok.length : Math.min(jumlah, p.stok.length)
    const dropped = p.stok.slice(0, take)
    p.stok = p.stok.slice(take)
    await writeJSON(env, 'Produk', produk)
    const stokKeluar = await readJSON(env, 'StokKeluar', [])
    stokKeluar.push({ id, total: take, stok_dibeli: dropped, tanggal: getDate('Asia/Jakarta'), user: fromName, chat_id: chatId, status: 'Dropped' })
    await writeJSON(env, 'StokKeluar', stokKeluar)
    await tgSendMessage(env, chatId, '```\n' + dropped.map(s => s.info || s).join('\n') + '\n```', null, 'Markdown')
    return
  }

  if (command === '/redeem') {
    const kode = args.join(' ').toUpperCase().replace(/\s+/g, '').trim()
    if (!kode) {
      let helpText = '*🎁 CARA TUKAR KODE VOUCHER*\n\n'
      helpText += 'Ketik: `/redeem <KODE>`\n\n'
      helpText += 'Contoh: `/redeem RMZ-K3P9-8FZW`\n\n'
      helpText += '💡 Kamu bisa dapat kode dari:\n'
      helpText += '• Broadcast dari admin\n'
      helpText += '• Event / promo khusus\n'
      helpText += '• Reward member setia'
      await tgSendMessage(env, chatId, helpText, null, 'Markdown')
      return
    }
    if (await isBanned(env, fromId)) {
      await tgSendMessage(env, chatId, '🚫 Akun kamu dibatasi. Redeem tidak diperbolehkan.')
      return
    }
    const { redeemVoucher } = await import('./user.js')
    const { getUser } = await import('./user.js')
    const reg = await getUser(env, fromId)
    if (!reg) {
      await tgSendMessage(env, chatId, '👋 Silakan tekan /start terlebih dahulu, lalu redeem ulang kodenya.')
      return
    }
    const result = await redeemVoucher(env, fromId, kode)
    if (result.ok) {
      const oldBal = result.newBalance - result.amount
      let sucText = '*✅ VOUCHER BERHASIL DITUKAR!*\n\n'
      sucText += '🎫 Kode  : `' + result.code + '`\n'
      sucText += '💰 Bonus : *+ ' + ParseIdr(result.amount) + '*\n'
      sucText += '💵 Saldo : ' + ParseIdr(oldBal) + ' → *' + ParseIdr(result.newBalance) + '*\n\n'
      sucText += 'Terima kasih! 🎉'
      await tgSendMessage(env, chatId, sucText, null, 'Markdown')
      if (InvoiceLogger) {
        const uname = msg.from && msg.from.username ? '@' + msg.from.username : ((msg.from && msg.from.first_name) || 'user')
        let logText = '🎁 *Redeem Voucher*\n'
        logText += 'User : ' + uname + ' (`' + fromId + '`)\n'
        logText += 'Kode : `' + result.code + '`\n'
        logText += 'Bonus: ' + ParseIdr(result.amount) + '\n'
        logText += 'Saldo baru: ' + ParseIdr(result.newBalance)
        try { await tgSendMessage(env, InvoiceLogger, logText, null, 'Markdown') } catch (e) {}
      }
      return
    }
    const err = result.error
    let errText = ''
    if (err === 'format') errText = '⚠️ Format kode salah. Contoh: `/redeem RMZ-K3P9-8FZW`'
    else if (err === 'notfound') errText = '❌ Kode tidak valid. Cek kembali format kode.'
    else if (err === 'used') errText = '❌ Kode sudah pernah ditukar' + (result.usedAt ? ' pada ' + formatWIB(new Date(result.usedAt).toISOString()) : '') + '.'
    else if (err === 'expired') errText = '⏰ Kode sudah kadaluarsa sejak ' + formatWIB(new Date(result.expiresAt).toISOString()) + '.'
    else if (err === 'revoked') errText = '🚫 Kode ini sudah dibatalkan oleh admin.'
    else if (err === 'locked') errText = '⏳ Coba lagi sebentar (proses redeem lain sedang berjalan).'
    else errText = '❌ Gagal redeem: ' + (result.message || err)
    await tgSendMessage(env, chatId, errText, null, 'Markdown')
    return
  }

  if (command === '/bc') {
    if (!(await checkPromoterCommand(env, msg))) return
    const reply = msg.reply_to_message
    if (!reply) { await tgSendMessage(env, chatId, 'ℹ️ Cara pakai: reply pesan yang mau dibroadcast lalu ketik /bc'); return }
    const rtext = reply.text || reply.caption || ''
    const rphoto = (reply.photo && reply.photo.length) ? reply.photo[reply.photo.length - 1].file_id : null
    if (!rtext && !rphoto) { await tgSendMessage(env, chatId, '⚠️ Pesan yang di-reply tidak berisi teks/gambar yang bisa dibroadcast.'); return }
    const bcusers = await getUserList(env)
    let bcsent = 0
    for (const u of bcusers) {
      try {
        if (rphoto) { await tgSendPhoto(env, u.chatId, rphoto, rtext, null, '') }
        else { await tgSendMessage(env, u.chatId, rtext, null, '') }
        bcsent++; await sleep(50)
      } catch (e) {}
    }
    await tgSendMessage(env, chatId, '✅ Broadcast (reply) terkirim ke ' + bcsent + '/' + bcusers.length + ' user.')
    return
  }

  if (command === '/bct') {
    if (!(await checkPromoterCommand(env, msg))) return
    const message = args.join(' ')
    if (!message) { await tgSendMessage(env, chatId, 'Format: /bct <pesan>'); return }
    const users = await getUserList(env)
    let sent = 0
    for (const user of users) {
      try { await tgSendMessage(env, user.chatId, escapeMarkdown(message)); sent++; await sleep(50) } catch (e) {}
    }
    await tgSendMessage(env, chatId, '\u2705 Broadcast terkirim ke ' + sent + '/' + users.length + ' user.')
    return
  }

  if (command === '/bci') {
    if (!(await checkPromoterCommand(env, msg))) return
    const state = { action: 'bci', status: true, chatId }
    await writeJSON(env, 'manageState_' + fromId, state)
    await tgSendMessage(env, chatId, 'Silahkan kirimkan Gambar dan Caption yang diinginkan.')
    return
  }

  if (command === '/ban') {
    if (!(await checkOwnerCommand(env, msg))) return
    const targetId = parseInt(args[0])
    if (!targetId) { await tgSendMessage(env, chatId, 'Format: /ban <userId>'); return }
    const result = await addBan(env, targetId)
    await tgSendMessage(env, chatId, result ? '\u2705 User ' + targetId + ' dibanned.' : 'User sudah dibanned.')
    return
  }

  if (command === '/unban') {
    if (!(await checkOwnerCommand(env, msg))) return
    const targetId = parseInt(args[0])
    if (!targetId) { await tgSendMessage(env, chatId, 'Format: /unban <userId>'); return }
    const result = await delBan(env, targetId)
    await tgSendMessage(env, chatId, result ? '\u2705 User ' + targetId + ' diunban.' : 'User tidak ditemukan.')
    return
  }

  if (command === '/addrole') {
    if (!(await checkOwnerCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) { await tgSendMessage(env, chatId, 'Format: /addrole id|role'); return }
    const [id, role] = input.split('|').map(s => s.trim())
    await addRole(env, id, role)
    await tgSendMessage(env, chatId, '\u2705 Role ' + role + ' ditambahkan untuk ' + id)
    return
  }

  if (command === '/delstock') {
    if (!(await checkOwnerCommand(env, msg))) return
    const id = parseInt(args[0])
    if (!id) { await tgSendMessage(env, chatId, 'Format: /delstock <id>'); return }
    const produk = await readJSON(env, 'Produk', [])
    const p = produk.find(pr => String(pr.id) === String(id))
    if (p) { p.stok = []; await writeJSON(env, 'Produk', produk); await tgSendMessage(env, chatId, '\u2705 Semua stok ID ' + id + ' dihapus.') }
    else { await tgSendMessage(env, chatId, 'ID tidak ditemukan.') }
    return
  }

  if (command === '/exportstock') {
    if (!(await checkOwnerCommand(env, msg))) return
    const id = parseInt(args[0])
    const produk = await readJSON(env, 'Produk', [])
    let exportData = ''
    if (id) {
      const p = produk.find(pr => String(pr.id) === String(id))
      if (p && p.stok) { exportData = p.stok.map(s => s.info || s).join('\n'); await tgSendDocument(env, chatId, exportData, 'stock_' + id + '.txt', 'Stok ID ' + id) }
      else { await tgSendMessage(env, chatId, 'ID tidak ditemukan.') }
    } else {
      for (const p of produk) {
        if (p.stok && p.stok.length > 0) { exportData += '=== ' + p.nameproduct + ' (ID:' + p.id + ') ===\n' + p.stok.map(s => s.info || s).join('\n') + '\n\n' }
      }
      await tgSendDocument(env, chatId, exportData, 'all_stock.txt', 'Semua Stok')
    }
    return
  }

  if (command === '/config') {
    if (!(await checkOwnerCommand(env, msg))) return
    const config = await readJSON(env, 'BotConfig', {})
    let text = '\u2699\ufe0f *Config*\n\n```\nNamaBot: ' + NamaBot + '\nStoreName: ' + StoreName + '\nOwnerID: ' + OwnerID + '\nInvoiceLogger: ' + (InvoiceLogger || '(kosong)') + '\nMode: ' + Mode + '\nSimulatePayment: ' + SimulatePayment + '\n\nKV Config: ' + JSON.stringify(config, null, 2) + '\n```'
    await tgSendMessage(env, chatId, text, null, 'Markdown')
    return
  }

  if (command === '/setconfig') {
    if (!(await checkOwnerCommand(env, msg))) return
    const input = args.join(' ')
    if (!input.includes('|')) { await tgSendMessage(env, chatId, 'Format: /setconfig Key|Value'); return }
    const [key, ...valueParts] = input.split('|')
    const value = valueParts.join('|').trim()
    const config = await readJSON(env, 'BotConfig', {})
    if (key === 'JamBackup' || key === 'OwnerID') config[key.trim()] = parseInt(value)
    else config[key.trim()] = value
    await writeJSON(env, 'BotConfig', config)
    await initConfig(env)
    await tgSendMessage(env, chatId, '\u2705 Config ' + key.trim() + ' = ' + value)
    return
  }

  if (command === '/resetconfig') {
    if (!(await checkOwnerCommand(env, msg))) return
    await deleteKey(env, 'BotConfig')
    await initConfig(env)
    await tgSendMessage(env, chatId, '\u2705 Config direset.')
    return
  }

  if (command === '/batalorder') {
 const sessions = await readJSON(env, 'SessionDeposit', [])
 const userSession = sessions.find(s => String(s.depositDetails?.userId) === String(fromId) && s.status === 'pending')
 if (userSession) {
   userSession.status = 'cancelled'
   await writeJSON(env, 'SessionDeposit', sessions.filter(s => s.id !== userSession.id))
   await tgSendMessage(env, chatId, 'Transaksi berhasil dibatalkan.')
 } else {
   await tgSendMessage(env, chatId, 'Kamu tidak memiliki transaksi aktif.')
 }
 return
  }
}

export { handleCommand }
