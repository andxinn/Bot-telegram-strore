import { readJSON, writeJSON } from './kv.js'
import { OwnerID } from './config.js'

async function getUserList(env) {
  return await readJSON(env, 'UserList', [])
}

async function saveUserList(env, users) {
  await writeJSON(env, 'UserList', users)
}

async function getUser(env, chatId) {
  const users = await getUserList(env)
  return users.find(u => String(u.chatId) === String(chatId))
}

async function addUser(env, chatId, username) {
  const users = await getUserList(env)
  let user = users.find(u => String(u.chatId) === String(chatId))
  if (!user) {
    user = {
      name: username || 'Pengguna',
      chatId: chatId,
      age: new Date().toISOString().split('T')[0],
      balance: 0,
      whatsapp_number: '-',
      bankid: Math.floor(100000 + Math.random() * 900000).toString(),
      is_verified: false
    }
    users.push(user)
    await saveUserList(env, users)
  }
  return user
}

async function addSaldo(env, chatId, amount) {
  const users = await getUserList(env)
  const user = users.find(u => String(u.chatId) === String(chatId))
  if (user) {
    user.balance = (user.balance || 0) + amount
    await saveUserList(env, users)
    return user.balance
  }
  return null
}

async function minSaldo(env, chatId, amount) {
  const users = await getUserList(env)
  const user = users.find(u => String(u.chatId) === String(chatId))
  if (user) {
    const currentBalance = user.balance || 0
    if (currentBalance < amount) return null // saldo tidak cukup
    user.balance = currentBalance - amount
    await saveUserList(env, users)
    return user.balance
  }
  return null
}

async function cekSaldo(env, chatId) {
  const user = await getUser(env, chatId)
  return user ? (user.balance || 0) : 0
}

function isOwner(fromId) {
  return String(fromId) === String(OwnerID)
}

async function isRegistered(env, chatId) {
  const user = await getUser(env, chatId)
  return !!user
}

async function getRole(env, fromId) {
  const roles = await readJSON(env, 'Role', [])
  const find = roles.find(r => String(r.id) === String(fromId))
  return find ? find.role : false
}

async function addRole(env, id, role) {
  const roles = await readJSON(env, 'Role', [])
  const find = roles.find(r => String(r.id) === String(id))
  if (find) {
    find.role = role
  } else {
    roles.push({ id: parseInt(id), role })
  }
  await writeJSON(env, 'Role', roles)
}

async function demoteRole(env, id) {
  const roles = await readJSON(env, 'Role', [])
  const idx = roles.findIndex(r => String(r.id) === String(id))
  if (idx !== -1) {
    roles.splice(idx, 1)
    await writeJSON(env, 'Role', roles)
    return true
  }
  return false
}

async function isBanned(env, sender) {
  const banned = await readJSON(env, 'BannedUser', [])
  return banned.some(b => String(b.sender) === String(sender))
}

async function addBan(env, sender) {
  const banned = await readJSON(env, 'BannedUser', [])
  if (banned.some(b => String(b.sender) === String(sender))) return false
  banned.push({ sender })
  await writeJSON(env, 'BannedUser', banned)
  return true
}

async function delBan(env, sender) {
  const banned = await readJSON(env, 'BannedUser', [])
  const idx = banned.findIndex(b => String(b.sender) === String(sender))
  if (idx === -1) return false
  banned.splice(idx, 1)
  await writeJSON(env, 'BannedUser', banned)
  return true
}

// --- Action Lock System: cegah double-submit ---
async function acquireLock(env, key, ttlSeconds = 5) {
  const lockKey = 'lock_' + key
  const existing = await env.DB.get(lockKey)
  if (existing !== null) return false
  await env.DB.put(lockKey, '1', { expirationTtl: ttlSeconds })
  return true
}

async function releaseLock(env, key) {
  try { await env.DB.delete('lock_' + key) } catch (e) {}
}

// ─── v9update17: Voucher redeem helper (atomic via lock + claim-verify) ───
async function redeemVoucher(env, userId, rawCode) {
  const code = (rawCode || '').toUpperCase().trim().replace(/\s+/g, '')
  // Format: XXX-XXXX-XXXX (allow any 2 to 5-char prefix, then 8 chars from A-Z 0-9 excluding I O 0 1)
  if (!/^[A-Z0-9]{2,5}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)) {
    return { ok: false, error: 'format' }
  }
  const lockKey = 'redeem_' + userId
  const gotLock = await acquireLock(env, lockKey, 10)
  if (!gotLock) return { ok: false, error: 'locked' }
  // Lock per-kode: cegah 2 user berbeda redeem kode yang sama bersamaan (FCFS broadcast)
  const codeLockKey = 'redeem_code_' + code
  const gotCodeLock = await acquireLock(env, codeLockKey, 10)
  if (!gotCodeLock) {
    await releaseLock(env, lockKey)
    return { ok: false, error: 'locked' }
  }
  try {
    const vouchers = await readJSON(env, 'Voucher', {})
    const v = vouchers[code]
    if (!v) return { ok: false, error: 'notfound' }
    if (v.status === 'used') return { ok: false, error: 'used', usedAt: v.usedAt, usedBy: v.usedBy }
    if (v.status === 'revoked') return { ok: false, error: 'revoked' }
    if (v.expiresAt && Date.now() > v.expiresAt) return { ok: false, error: 'expired', expiresAt: v.expiresAt }
    // CLAIM: cap klaim unik per percobaan (bukan sekadar userId) — pemenang diputuskan saat re-read
    const claim = crypto.randomUUID()
    v.claim = claim
    v.usedBy = userId
    v.usedAt = Date.now()
    v.status = 'used'
    vouchers[code] = v
    await writeJSON(env, 'Voucher', vouchers)
    // VERIFY: baca ulang; kredit saldo hanya jika klaim KITA yang bertahan di store.
    // Kalau klaim lain menimpa (race FCFS / double-submit), gagalkan tanpa kredit —
    // hasil akhir sama dengan rejection 'used' biasa, tanpa saldo dobel.
    const verify = await readJSON(env, 'Voucher', {})
    const vv = verify[code]
    if (!vv || vv.claim !== claim) {
      return { ok: false, error: 'used', usedAt: vv ? vv.usedAt : undefined, usedBy: vv ? vv.usedBy : undefined }
    }
    const newBalance = await addSaldo(env, userId, v.amount)
    if (v.batchId) {
      const batches = await readJSON(env, 'VoucherBatch', {})
      if (batches[v.batchId]) {
        batches[v.batchId].used = (batches[v.batchId].used || 0) + 1
        await writeJSON(env, 'VoucherBatch', batches)
      }
    }
    const audit = await readJSON(env, 'VoucherAudit', [])
    audit.unshift({ code, userId, amount: v.amount, at: Date.now() })
    if (audit.length > 500) audit.length = 500
    await writeJSON(env, 'VoucherAudit', audit)
    return { ok: true, amount: v.amount, newBalance, code }
  } catch (e) {
    return { ok: false, error: 'exception', message: e.message }
  } finally {
    await releaseLock(env, lockKey)
    await releaseLock(env, codeLockKey)
  }
}



// ═══════════════════════════════════════════════════════
// v9update18: Flash Sale helpers (append to src/user.js)
// ═══════════════════════════════════════════════════════

async function flashSaleMoveToHistory(env, fs, reason) {
  const hist = await readJSON(env, 'FlashSaleHistory', [])
  hist.unshift({ ...fs, endedAt: Date.now(), endReason: reason })
  await writeJSON(env, 'FlashSaleHistory', hist.slice(0, 100))
}

async function flashSaleGetActive(env, variantId) {
  const all = await readJSON(env, 'FlashSale', {})
  const key = String(variantId)
  const fs = all[key]
  if (!fs) return null
  if (fs.expiresAt && Date.now() > Number(fs.expiresAt)) {
    // lazy expiry: pindahkan ke history + hapus
    delete all[key]
    await writeJSON(env, 'FlashSale', all)
    await flashSaleMoveToHistory(env, fs, 'expired')
    return null
  }
  return fs
}

async function getEffectivePrice(env, variantId, rawPrice) {
  const fs = await flashSaleGetActive(env, variantId)
  if (!fs) {
    return { price: rawPrice, isSale: false, originalPrice: null, salePrice: null, flashSaleExpiresAt: null }
  }
  return {
    price: fs.salePrice,
    isSale: true,
    originalPrice: fs.originalPrice,
    salePrice: fs.salePrice,
    flashSaleExpiresAt: fs.expiresAt
  }
}

async function flashSaleCleanupAll(env) {
  const all = await readJSON(env, 'FlashSale', {})
  const now = Date.now()
  let changed = false
  for (const k of Object.keys(all)) {
    if (all[k].expiresAt && now > Number(all[k].expiresAt)) {
      await flashSaleMoveToHistory(env, all[k], 'expired')
      delete all[k]
      changed = true
    }
  }
  if (changed) await writeJSON(env, 'FlashSale', all)
}

async function flashSaleSetActive(env, variantId, fs) {
  const all = await readJSON(env, 'FlashSale', {})
  all[String(variantId)] = fs
  await writeJSON(env, 'FlashSale', all)
}

async function flashSaleCancel(env, variantId, reason) {
  const all = await readJSON(env, 'FlashSale', {})
  const key = String(variantId)
  const fs = all[key]
  if (!fs) return null
  delete all[key]
  await writeJSON(env, 'FlashSale', all)
  await flashSaleMoveToHistory(env, fs, reason || 'cancelled')
  return fs
}

export {
  getUserList, saveUserList, getUser, addUser, addSaldo, minSaldo, cekSaldo,
  isOwner, isRegistered, getRole, addRole, demoteRole, isBanned, addBan, delBan, acquireLock, releaseLock,
  redeemVoucher, flashSaleGetActive, getEffectivePrice, flashSaleCleanupAll, flashSaleSetActive, flashSaleCancel
}
