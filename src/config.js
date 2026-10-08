import { readJSON } from './kv.js'

let NamaBot = 'Tehtarik Store'
let StoreName = 'Tehtarik Store'
let OwnerID = 6242090623
let OwnerUsername = ''
let ChannelLog = ''
let InvoiceLogger = ''
let ChannelStore = ''
let CS = ''
let JamBackup = 6
let Mode = 'production'
let SimulatePayment = false
let SimulateDelay = 30
let WebhookSecret = ''
let DevToken = ''
let BannerFileId = ''
let DataQris = ''
let bannerStartB64 = ''
let bannerStartId = ''
let bannerListB64 = ''
let bannerListId = ''
let bannerFsId = ''
let bannerPriceId = ''
let leaderboardId = ''
let stokBcId = ''
let orderBotName = ''
let caraOrderText = ''
let leaderboardEnabled = true
let leaderboardBanner = ''
let channelTicket = ''
let ticketKeepDays = 7
let ticketAutoDelTopic = true
let ButtonMenu = {
  informasi: 'Information',
  deposit: 'Deposit',
  list: 'List Produk',
  stock: 'Stock'
}

let channelBackup = ''
let backupMode = 'daily'

async function initConfig(env) {
  NamaBot = env.NAMA_BOT || 'Tehtarik Store'
  StoreName = env.STORE_NAME || env.NAMA_BOT || 'Tehtarik Store'
  OwnerID = parseInt(env.OWNER_ID || '6242090623')
  OwnerUsername = env.OWNER_USN || ''
  ChannelLog = env.CHANNEL_LOG || ''
  InvoiceLogger = env.INVOICE_LOGGER || ''
  channelBackup = env.CHANNEL_BACKUP || ''
  ChannelStore = env.CHANNEL_STORE || ''
  CS = env.CS || ''
  JamBackup = parseInt(env.JAM_BACKUP || '6')
  Mode = (env.MODE || 'production').toLowerCase()
  SimulatePayment = (env.SIMULATE_PAYMENT || 'false').toLowerCase() === 'true'
  SimulateDelay = parseInt(env.SIMULATE_DELAY || '30')
  WebhookSecret = env.WEBHOOK_SECRET || ''
  DevToken = env.DEV_TOKEN || ''
  BannerFileId = env.BANNER_FILE_ID || env.STIKER_START_FILEID || ''
  DataQris = env.DATA_QRIS || ''
  try {
    const kvConfig = await readJSON(env, 'BotConfig', null)
    if (kvConfig) {
      if (kvConfig.NamaBot) NamaBot = kvConfig.NamaBot
      if (kvConfig.StoreName) StoreName = kvConfig.StoreName
      if (kvConfig.OwnerID) OwnerID = kvConfig.OwnerID
      if (kvConfig.InvoiceLogger !== undefined) InvoiceLogger = kvConfig.InvoiceLogger
      if (kvConfig.channelBackup !== undefined) channelBackup = kvConfig.channelBackup
      if (kvConfig.backupMode === '30m' || kvConfig.backupMode === 'daily') backupMode = kvConfig.backupMode
      if (kvConfig.ChannelStore) ChannelStore = kvConfig.ChannelStore
      if (kvConfig.CS) CS = kvConfig.CS
      if (kvConfig.DataQris) DataQris = kvConfig.DataQris
      if (kvConfig.BannerFileId) BannerFileId = kvConfig.BannerFileId
      if (kvConfig.ButtonMenu) ButtonMenu = kvConfig.ButtonMenu
      if (kvConfig.bannerStartB64 !== undefined) bannerStartB64 = kvConfig.bannerStartB64
      if (kvConfig.bannerStartId !== undefined) bannerStartId = kvConfig.bannerStartId
      if (kvConfig.bannerListB64 !== undefined) bannerListB64 = kvConfig.bannerListB64
      if (kvConfig.bannerListId !== undefined) bannerListId = kvConfig.bannerListId
      if (kvConfig.bannerFsId !== undefined) bannerFsId = kvConfig.bannerFsId
      if (kvConfig.bannerPriceId !== undefined) bannerPriceId = kvConfig.bannerPriceId
      if (kvConfig.leaderboardId !== undefined) leaderboardId = kvConfig.leaderboardId
      if (kvConfig.stokBcId !== undefined) stokBcId = kvConfig.stokBcId
      if (kvConfig.orderBotName) orderBotName = kvConfig.orderBotName
      if (kvConfig.caraOrderText) caraOrderText = kvConfig.caraOrderText
      if (kvConfig.leaderboardEnabled !== undefined) leaderboardEnabled = kvConfig.leaderboardEnabled
      if (kvConfig.leaderboardBanner !== undefined) leaderboardBanner = kvConfig.leaderboardBanner
      if (env.CHANNEL_TICKET) channelTicket = env.CHANNEL_TICKET
      if (kvConfig.channelTicket !== undefined) channelTicket = kvConfig.channelTicket
      if (kvConfig.ticketKeepDays !== undefined) { const kd = parseInt(kvConfig.ticketKeepDays, 10); if (Number.isFinite(kd) && kd >= 1 && kd <= 100) ticketKeepDays = kd }
      if (kvConfig.ticketAutoDelTopic !== undefined) ticketAutoDelTopic = kvConfig.ticketAutoDelTopic !== false
      if (kvConfig.ChannelLog !== undefined) ChannelLog = kvConfig.ChannelLog
      if (kvConfig.JamBackup !== undefined && kvConfig.JamBackup !== null && kvConfig.JamBackup !== '') {
        const jb = Number(kvConfig.JamBackup)
        if (Number.isFinite(jb) && jb >= 0 && jb <= 23) JamBackup = Math.trunc(jb)
      }
    }
  } catch (e) {}
}

export {
  NamaBot, StoreName, OwnerID, OwnerUsername, ChannelLog, InvoiceLogger, channelBackup, backupMode,
  ChannelStore, CS, JamBackup, Mode, SimulatePayment, SimulateDelay,
  WebhookSecret, DevToken, BannerFileId, DataQris,
  bannerStartB64, bannerStartId, bannerListB64, bannerListId, bannerFsId, bannerPriceId, leaderboardId, stokBcId, orderBotName, caraOrderText,
  ButtonMenu, initConfig, leaderboardEnabled, leaderboardBanner, channelTicket,
  ticketKeepDays, ticketAutoDelTopic
}
