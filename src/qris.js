import { toCRC16, generateKodeUnik } from './helpers.js'
import { DataQris } from './config.js'

function qrisDinamis(qrisStatic, nominal) {
  const qr = qrisStatic.replace('010211', '010212')
  let i = 0
  let beforeCRC = ''
  while (i < qr.length) {
    const id = qr.slice(i, i + 2)
    const len = parseInt(qr.slice(i + 2, i + 4))
    if (isNaN(len) || len <= 0) break
    const val = qr.slice(i + 4, i + 4 + len)
    if (id === '63') break
    beforeCRC += id + String(len).padStart(2, '0') + val
    i += 4 + len
  }
  const nominalStr = String(nominal)
  const tag54 = '54' + String(nominalStr.length).padStart(2, '0') + nominalStr
  beforeCRC += tag54 + '6304'
  const crc = toCRC16(beforeCRC)
  return beforeCRC + crc
}

async function generateQris(env, totalPrice) {
  const kodeUnik = generateKodeUnik()
  const total = totalPrice + kodeUnik
  const src = env.DATA_QRIS || DataQris || env.QR_STRING || ''
  const qrisString = src ? qrisDinamis(src, total) : ''
  return { qrisString, total, kodeUnik }
}

export { qrisDinamis, generateQris }
