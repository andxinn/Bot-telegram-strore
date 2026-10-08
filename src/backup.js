import { OwnerID, InvoiceLogger, NamaBot, channelBackup } from './config.js'
import { readJSON, writeJSON } from './kv.js'
import { tgSendMessage, tgSendDocument } from './telegram.js'
import { getDate } from './helpers.js'

async function autoBackup(env) {
  try {
    const cfg = await readJSON(env, 'BotConfig', {}).catch(() => ({}))
    // Jadwal: backupMode 'daily' (default, jam JamBackup) atau '30m' (tiap 30 menit).
    const mode = (cfg && cfg.backupMode) || 'daily'
    if (mode !== '30m') {
      const want = Number((cfg && cfg.JamBackup) ?? env.JAM_BACKUP ?? 6)
      if (Number.isFinite(want) && (new Date().getUTCHours() + 7) % 24 !== want) return
    }
    const keys = [
      'Kategori', 'Produk', 'SnK', 'Trx', 'UserList', 'Role', 
      'BannedUser', 'Voucher', 'VoucherBatch', 'VoucherAudit', 
      'OrderCounter', 'BotConfig', 'StokKeluar', 'StokBaru', 
      'FlashSale', 'FlashSaleHistory', 'Tickets', 'SessionDeposit'
    ]
    const backup = {}
    for (const key of keys) {
      backup[key] = await readJSON(env, key, null)
    }
    // Jangan bocorkan secret: token Turso & apiKey gateway tidak ikut backup
    if (backup.BotConfig && typeof backup.BotConfig === 'object') {
      if (backup.BotConfig.db) backup.BotConfig = { ...backup.BotConfig, db: { ...backup.BotConfig.db, token: undefined } }
      if (backup.BotConfig.payment && typeof backup.BotConfig.payment === 'object') {
        const gw = backup.BotConfig.payment.gateways || {}
        const scrub = {}
        for (const [k, v] of Object.entries(gw)) scrub[k] = { ...v, apiKey: undefined }
        backup.BotConfig = { ...backup.BotConfig, payment: { ...backup.BotConfig.payment, gateways: scrub } }
      }
    }
    const dateStr = getDate('Asia/Jakarta').replace(/[^0-9]/g, '_')
    const content = JSON.stringify(backup, null, 2)
    
    // Send backup file to Owner
    await tgSendDocument(env, OwnerID, content, 'backup_' + dateStr + '.json', 'Auto Backup - ' + getDate('Asia/Jakarta'))
    
    // Send backup file to Channel Backup DB if configured
    const bChannel = channelBackup || InvoiceLogger
    if (bChannel && String(bChannel) !== String(OwnerID)) {
      let bChatId = bChannel
      let bThreadId = null
      if (String(bChannel).includes(':')) {
        const parts = String(bChannel).split(':')
        bChatId = parts[0]
        bThreadId = parts[1]
      }
      await tgSendDocument(env, bChatId, content, 'backup_' + dateStr + '.json', 'Auto Backup - ' + getDate('Asia/Jakarta'), null, 'Markdown', bThreadId)
    }
  } catch (e) {
    console.error('autoBackup error: ' + e.message)
  }
}

async function cleanupClosedTickets(env) {
  try {
    const tickets = await readJSON(env, 'Tickets', [])
    if (tickets.length === 0) return

    // P7: umur simpan dari setting admin (1-100 hari, default 7).
    let keepDays = 7
    let autoDel = true
    try {
      const cfg = await readJSON(env, 'BotConfig', null)
      if (cfg) {
        const kd = parseInt(cfg.ticketKeepDays, 10)
        if (Number.isFinite(kd) && kd >= 1 && kd <= 100) keepDays = kd
        if (cfg.ticketAutoDelTopic === false) autoDel = false
      }
    } catch {}
    const now = Date.now()
    const keepMs = keepDays * 24 * 60 * 60 * 1000
    let changed = false

    const activeTickets = []
    for (const t of tickets) {
      if (t.status === 'closed') {
        if (t.closedAt) {
          const age = now - t.closedAt
          if (age >= keepMs) {
            changed = true
            if (autoDel && t.logChatId && t.threadId) {
              try {
                const { tgDeleteForumTopic } = await import('./telegram.js')
                await tgDeleteForumTopic(env, t.logChatId, t.threadId)
              } catch (e) {
                console.error('cleanupClosedTickets delTopic: ' + e.message)
              }
            }
            continue // Delete it
          }
          activeTickets.push(t)
        } else {
          t.closedAt = now
          changed = true
          activeTickets.push(t)
        }
      } else {
        activeTickets.push(t)
      }
    }

    if (changed) {
      await writeJSON(env, 'Tickets', activeTickets)
    }
  } catch (e) {
    console.error('cleanupClosedTickets error: ' + e.message)
  }
}

export { autoBackup, cleanupClosedTickets }
