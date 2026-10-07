// src/ticket.js — helper tiket CF (P2, pola KV murni readJSON/writeJSON).
// Port dari STB src/admin/ticket.js, dialih-call ke KV (tanpa stb-table-*.js).
import { readJSON, writeJSON } from './kv.js'
import { tgSendMessage, tgSendPhoto, tgSendDocumentFile, tgReopenForumTopic, tgCreateForumTopic } from './telegram.js'
import { getTanggalJam } from './helpers.js'

export async function appendTicketMessage(env, ticketId, msgObj, { by = 'admin', status = 'answered' } = {}) {
  const tickets = await readJSON(env, 'Tickets', [])
  const idx = tickets.findIndex(t => t.ticketId === ticketId)
  if (idx === -1) return null
  const t = tickets[idx]
  t.messages.push(msgObj)
  t.status = status
  t.lastActivityAt = Date.now()
  if (by === 'user') t.lastUserAt = Date.now()
  else t.lastAdminAt = Date.now()
  await writeJSON(env, 'Tickets', tickets)
  return t
}

export function extractMsgMedia(msg) {
  let textVal = msg.text ? msg.text.trim() : ''
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
  return { textVal, photoFileId, docFileId, docName }
}

export function buildUserMsgObj(msg, jamHM, fromLabel) {
  const { textVal, photoFileId, docFileId, docName } = extractMsgMedia(msg)
  const o = { sender: 'user', text: textVal, time: jamHM, username: fromLabel }
  if (photoFileId) o.photoFileId = photoFileId
  if (docFileId) { o.docFileId = docFileId; o.docName = docName }
  return { msgObj: o, textVal, photoFileId, docFileId, docName }
}

// Auto-route: 1 aktif→masuk, 0 aktif+closed≤7hr→reopen, ≥2 aktif→tolak sebut ID.
export async function userAppendToTicket(env, msg) {
  try {
    if (!msg || !msg.chat || msg.chat.type !== 'private') return null
    if (msg.text && msg.text.trim().startsWith('/')) return null
    const fromId = msg.from.id
    for (const k of ['adminState_', 'manageState_', 'depositState_', 'ticketState_', 'cekTrxState_']) {
      try { if (await readJSON(env, k + fromId, null)) return null } catch {}
    }
    try {
      if (await readJSON(env, 'orderState_' + fromId, null)) return null
    } catch {}
    const { textVal, photoFileId, docFileId } = extractMsgMedia(msg)
    if (!photoFileId && !docFileId && textVal.length < 2) return null
    const tickets = await readJSON(env, 'Tickets', [])
    const active = tickets.filter(t => String(t.userId) === String(fromId) && t.status !== 'closed')
    const jamNow = getTanggalJam()
    const jamHM = String(jamNow.jam).slice(0, 5) + ' WIB'
    const fromLabel = msg.from.username ? '@' + msg.from.username : (msg.from.first_name || 'User')
    if (active.length === 1) {
      const { msgObj } = buildUserMsgObj(msg, jamHM, fromLabel)
      return await appendTicketMessage(env, active[0].ticketId, msgObj, { by: 'user', status: 'open' })
    }
    if (active.length === 0) {
      const week = 7 * 24 * 3600000
      const recent = tickets
        .filter(t => String(t.userId) === String(fromId) && t.status === 'closed' && t.closedAt && (Date.now() - t.closedAt) <= week)
        .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))[0]
      if (!recent) return null
      const { msgObj } = buildUserMsgObj(msg, jamHM, fromLabel)
      const reopened = await appendTicketMessage(env, recent.ticketId, msgObj, { by: 'user', status: 'open' })
      if (!reopened) return null
      const all = await readJSON(env, 'Tickets', [])
      const idx = all.findIndex(t => t.ticketId === recent.ticketId)
      if (idx !== -1) {
        all[idx].closedAt = null
        all[idx].deleteTopicAt = null
        await writeJSON(env, 'Tickets', all)
        try { await tgReopenForumTopic(env, all[idx].logChatId, all[idx].threadId) } catch (e) {}
        return all[idx]
      }
      return reopened
    }
    if (active.length >= 2) {
      const { getMainMenuKeyboard } = await import('./keyboard.js')
      const ids = active.map(t => t.ticketId).join(', ')
      await tgSendMessage(env, msg.chat.id, 'Anda punya ' + active.length + ' tiket aktif: ' + ids + '. Ketik di kartu tiketnya masing-masing / tutup salah satu.', getMainMenuKeyboard(), 'Markdown')
    }
    return null
  } catch {
    return null
  }
}

// Teruskan pesan user ke topik forum (follow-up & auto-route).
export async function forwardUserToForum(env, t, { textVal, photoFileId = null, docFileId = null, jamHM = '' } = {}) {
  if (!t || !t.logChatId || !t.threadId) return
  try {
    const usn = t.userUsername ? '@' + t.userUsername : (t.userName || 'User')
    const fMsg = '<b>USER ' + escH(usn) + '</b><i> (' + escH(jamHM) + ')</i>\n' + escH(textVal)
    if (photoFileId) {
      await tgSendPhoto(env, t.logChatId, photoFileId, fMsg, null, 'HTML', t.threadId)
    } else if (docFileId) {
      await tgSendDocumentFile(env, t.logChatId, docFileId, fMsg, null, 'HTML', t.threadId)
    } else {
      await tgSendMessage(env, t.logChatId, fMsg, null, 'HTML', t.threadId)
    }
    try { await tgReopenForumTopic(env, t.logChatId, t.threadId) } catch (e) {}
  } catch (e) {
    console.error('[forum follow up send]', e.message)
  }
}

function escH(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// SLA: tiket menunggu admin >30 mnt -> pengingat ke TOPIK tiketnya, maks 1x/2 jam.
export async function flushTicketSla(env) {
  try {
    const { ticketAge } = await import('./ticketCard.js')
    const tickets = await readJSON(env, 'Tickets', [])
    let changed = false
    for (const t of tickets) {
      if (t.status === 'closed') continue
      const age = ticketAge(t)
      if (!age.waitingAdmin || age.ms < 30 * 60000) continue
      const key = 'SlaNotif_' + t.ticketId
      const last = Number(await readJSON(env, key, 0)) || 0
      if (Date.now() - last < 2 * 3600000) continue
      await writeJSON(env, key, Date.now())
      if (t.logChatId && t.threadId) {
        const text = 'SLA <b>' + escH(t.ticketId) + '</b> · menunggu admin <b>' + age.label + '</b> — mohon ditanggapi.'
        try { await tgSendMessage(env, t.logChatId, text, null, 'HTML', t.threadId) } catch (e) {}
      }
      changed = true
    }
    return changed
  } catch (e) {
    console.error('[flushTicketSla]', e.message)
    return false
  }
}
