import { OwnerID, InvoiceLogger, NamaBot, channelBackup } from './config.js'
import { readJSON, writeJSON } from './kv.js'
import { tgSendMessage, tgSendDocument } from './telegram.js'
import { getDate } from './helpers.js'

async function autoBackup(env) {
  try {
    const keys = [
      'Kategori', 'Produk', 'SnK', 'Trx', 'UserList', 'Role', 
      'BannedUser', 'Voucher', 'VoucherBatch', 'VoucherAudit', 
      'OrderCounter', 'BotConfig', 'StokKeluar', 'StokBaru', 
      'FlashSale', 'FlashSaleHistory'
    ]
    const backup = {}
    for (const key of keys) {
      backup[key] = await readJSON(env, key, null)
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
    
    const now = Date.now()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    let changed = false
    
    const activeTickets = tickets.filter(t => {
      if (t.status === 'closed') {
        if (t.closedAt) {
          const age = now - t.closedAt
          if (age >= sevenDaysMs) {
            changed = true
            return false // Delete it
          }
          return true
        }
        // Initialize closedAt for old tickets so they get deleted in 7 days
        t.closedAt = now
        changed = true
        return true
      }
      return true
    })
    
    if (changed) {
      await writeJSON(env, 'Tickets', activeTickets)
    }
  } catch (e) {
    console.error('cleanupClosedTickets error: ' + e.message)
  }
}

export { autoBackup, cleanupClosedTickets }
