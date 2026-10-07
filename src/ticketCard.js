// src/admin/ticketCard.js — SATU renderer kartu tiket (PRD-TIKET §4).
// Dipakai: kartu user (callbacks tk_view_), kartu admin DM, cermin grup, kartu follow-up.
// Fungsi murni: tidak menyentuh KV/Telegram, jadi bisa diuji tanpa jaringan.

export const TICKET_CATS = {
  pesanan: 'Pesanan',
  pembayaran: 'Pembayaran',
  akun: 'Akun',
  lainnya: 'Lainnya'
}

// Emoji hanya untuk judul topik forum (bukan tombol/pesan).
export const TICKET_CAT_EMOJI = {
  pesanan: '📦', pembayaran: '💳', akun: '👤', lainnya: '❓'
}
export function catEmoji(c) {
  return TICKET_CAT_EMOJI[c] || TICKET_CAT_EMOJI.lainnya
}

export function catLabel(c) {
  return TICKET_CATS[c] || TICKET_CATS.lainnya
}

export function escHtml(str) {
  if (!str && str !== 0) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Umur tiket. Referensi waktu tunggu = AKTIVITAS USER TERAKHIR (bukan pesan pertama;
// rumus lama memakai firstUserPush sehingga tiket dengan follow-up tampak lebih tua dari kenyataan).
export function ticketAge(t) {
  const msgs = t.messages || []
  const last = msgs.length ? msgs[msgs.length - 1] : null
  const ref = (t.status === 'closed' && t.closedAt) ? t.closedAt : Date.now()
  const waitingAdmin = !!last && last.sender === 'user' && t.status !== 'closed'
  const createdAt = Date.parse(t.createdAt || '') || ref
  const userRef = t.lastUserAt || t.lastActivityAt || createdAt
  const start = waitingAdmin ? userRef : (t.lastActivityAt || createdAt)
  const ms = Math.max(0, ref - start)
  const m = Math.floor(ms / 60000)
  const label = m < 60 ? m + 'm' : (Math.floor(m / 60) + 'j ' + (m % 60) + 'm')
  return { ms, label, waitingAdmin }
}

// Titik status inbox: 🔴 >1j belum dijawab · 🟡 menunggu admin · 🔵 menunggu user · 🟢 selesai
export function ticketDot(t) {
  if (t.status === 'closed') return '🟢'
  const age = ticketAge(t)
  if (age.waitingAdmin && age.ms > 3600000) return '🔴'
  return age.waitingAdmin ? '🟡' : '🔵'
}

// Nama lawyer/penanya dalam riwayat
function senderName(m, t, role) {
  const own = t.userUsername ? '@' + t.userUsername : (t.userName || 'User')
  if (role === 'user') return 'Kamu'
  return m.username ? m.username.replace(/^🙋\s*/, '') : own
}

function mediaTags(m) {
  let out = ''
  if (m.photoFileId) out += '\n📎 <i>Foto</i>'
  if (m.docFileId) out += '\n📎 <i>' + escHtml(m.docName || 'Berkas') + '</i>'
  return out
}

export function renderTicketBody(t, { role = 'user', page = null, limit = 5 } = {}) {
  const msgs = t.messages || []
  const totalPages = Math.max(1, Math.ceil(msgs.length / limit))
  let activePage = (page === null || page === undefined) ? totalPages : Number(page) || totalPages
  activePage = Math.max(1, Math.min(activePage, totalPages))
  const startIdx = (activePage - 1) * limit
  const visible = msgs.slice(startIdx, startIdx + limit)

  let html = ''
  let prevSender = null
  for (const m of visible) {
    if (prevSender && prevSender !== m.sender) html += '<code>──────────────────</code>\n'
    const timeStr = m.time ? ' (' + escHtml(m.time) + ')' : ''
    if (m.sender === 'user') {
      html += '<b>🙋 ' + escHtml(senderName(m, t, role)) + '</b><i>' + timeStr + '</i>\n' + escHtml(m.text) + mediaTags(m) + '\n'
    } else {
      html += '<blockquote><b>🎧 ADMIN</b><i>' + timeStr + '</i>\n' + escHtml(m.text) + mediaTags(m) + '</blockquote>'
    }
    prevSender = m.sender
  }
  return { html, activePage, totalPages, startIdx }
}

function truncate(str, n) {
  const s = String(str || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Kartu tiket lengkap: { text, keyboard, activePage, totalPages, startIdx }
export function renderTicketCard(t, { role = 'user', page = null, limit = 5, typing = '', viewerId = null } = {}) {
  const age = ticketAge(t)
  const isAdmin = role === 'admin'
  const uname = t.userUsername ? '@' + t.userUsername : (t.userName || 'User')

  let head = '🎫 <b>' + escHtml(t.ticketId) + '</b> · ' + catLabel(t.category)
  if (t.status === 'closed') head += ' · ✅ Selesai (' + age.label + ')'
  else if (age.waitingAdmin) head += ' · ⏳ Menunggu admin (' + age.label + ')'
  else head += ' · 🔵 Menunggu Anda (' + age.label + ')'
  if (isAdmin) {
    head = '🎫 <b>' + escHtml(t.ticketId) + '</b> · ' + catLabel(t.category) +
      ' · ' + (t.status === 'closed' ? '✅ selesai' : ticketDot(t) + ' ' + age.label) +
      ' · 🙋 ' + escHtml(uname)
  }

  const body = renderTicketBody(t, { role, page, limit })
  let text = head + '\n\n' + body.html

  const lines = []
  if (isAdmin && t.assignedName && t.status !== 'closed') lines.push('🎧 ditangani <b>' + escHtml(t.assignedName) + '</b>')
  if (typing) lines.push('✍️ <b>[ Sedang dibalas... ]</b>')
  if (lines.length) text += '\n' + lines.join(' · ') + '\n'

  const paging = body.totalPages > 1
  text += '\n<code>──────────────────</code>\n'
  const n = (t.messages || []).length
  text += paging ? 'Halaman ' + body.activePage + '/' + body.totalPages + ' · ' + n + ' pesan' : 'Total ' + n + ' pesan'
  if (!isAdmin && t.status !== 'closed') text += '\n💬 <i>Balas langsung di sini — ketik saja.</i>'

  return { text, keyboard: renderTicketKeyboard(t, role, body, { viewerId }), ...body }
}

export function renderTicketKeyboard(t, role, body, { viewerId = null } = {}) {
  const id = t.ticketId
  const rows = []
  const paging = body.totalPages > 1
  const closed = t.status === 'closed'

  if (role === 'user') {
    const row1 = []
    if (!closed) row1.push({ text: 'Selesai', callback_data: 'tk_close_' + id })
    if (paging) {
      if (body.activePage > 1) row1.push({ text: '◀️', callback_data: 'tk_view_' + id + '_' + (body.activePage - 1) })
      if (body.activePage < body.totalPages) row1.push({ text: '▶️', callback_data: 'tk_view_' + id + '_' + (body.activePage + 1) })
    }
    if (row1.length) rows.push(row1)
    if (closed) rows.push([{ text: 'Buka Lagi', callback_data: 'tk_reopen_' + id }])
    else rows.push([{ text: 'Daftar Tiket', callback_data: 'tk_list' }, { text: 'Menu Utama', callback_data: 'to_menu' }])
    return { inline_keyboard: rows }
  }

  // Admin (DM panel & cermin grup): maks 2 baris
  const row1 = []
  if (!closed) row1.push({ text: 'Balas', callback_data: 'tk_adm_reply_' + id })
  row1.push({ text: closed ? 'Buka Lagi' : 'Tutup', callback_data: closed ? 'tk_adm_reopen_' + id : 'tk_adm_close_' + id })
  if (paging) {
    if (body.activePage > 1) row1.push({ text: '◀️', callback_data: 'tk_adm_page_' + id + '_' + (body.activePage - 1) })
    if (body.activePage < body.totalPages) row1.push({ text: '▶️', callback_data: 'tk_adm_page_' + id + '_' + (body.activePage + 1) })
  }
  if (row1.length) rows.push(row1)

  const row2 = [{ text: 'Antrean', callback_data: 'tk_adm_cat_proses' }]
  if (!closed) {
    // F3: belum dipegang → 🎧 Ambil · dipegang saya → sembunyikan (sudah jelas di header)
    // · dipegang admin lain → ↩️ Ambil alih (indikator saja, tanpa kunci).
    const heldBy = t.assignedTo ? String(t.assignedTo) : null
    const me = viewerId !== null && viewerId !== undefined ? String(viewerId) : null
    if (!heldBy) row2.push({ text: 'Ambil', callback_data: 'tk_adm_claim_' + id })
    else if (me && heldBy !== me) row2.push({ text: 'Ambil alih', callback_data: 'tk_adm_takeover_' + id })
  }
  rows.push(row2)
  return { inline_keyboard: rows }
}

// Daftar tiket user 1 pintu: teks + tombol per tiket + 1 tombol Buat Tiket.
export function renderUserTicketList(allTickets, userId, { limit = 10 } = {}) {
  const mine = (allTickets || [])
    .filter(t => String(t.userId) === String(userId))
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  let text = '<b>Tiket Bantuan</b>\n\n'
  if (!mine.length) {
    text += 'Belum ada tiket. Buat di bawah.'
  } else {
    for (const t of mine.slice(0, limit)) {
      const dot = t.status === 'closed' ? '🟢' : (t.status === 'answered' ? '🔵' : '🟡')
      text += dot + ' <b>' + escHtml(t.ticketId) + '</b> · ' + catLabel(t.category) + ' · ' + ticketAge(t).label + '\n'
    }
  }
  text += '\n<i>Balas langsung di sini — ketik saja, otomatis masuk tiket aktif.</i>'
  const rows = mine.slice(0, limit).map(t => [{ text: t.ticketId, callback_data: 'tk_view_' + t.ticketId }])
  rows.push([{ text: 'Buat Tiket', callback_data: 'tk_create' }])
  return { text, keyboard: { inline_keyboard: rows }, mine }
}

// Baris tombol inbox admin: satu tombol per tiket + navigasi kategori.
export function renderInboxKeyboard(rows, { proses = true, prosesCount = null, selesaiCount = null } = {}) {
  const kb = rows.map(r => [{ text: r.label, callback_data: r.cb }])
  const pLbl = prosesCount === null || prosesCount === undefined ? 'Proses' : 'Proses (' + prosesCount + ')'
  const sLbl = selesaiCount === null || selesaiCount === undefined ? 'Selesai' : 'Selesai (' + selesaiCount + ')'
  kb.push([
    { text: pLbl, callback_data: 'tk_adm_cat_proses' },
    { text: sLbl, callback_data: 'tk_adm_cat_selesai' }
  ])
  kb.push([{ text: 'Tutup Menu', callback_data: 'adm_tutup' }])
  return { inline_keyboard: kb }
}

export function inboxPreview(t) {
  const msgs = t.messages || []
  const last = msgs.length ? msgs[msgs.length - 1] : null
  if (!last) return '(kosong)'
  if (last.sender === 'admin' && t.status !== 'closed') return '(menunggu user)'
  return truncate(last.text, 42)
}