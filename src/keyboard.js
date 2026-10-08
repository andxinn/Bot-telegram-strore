import { ButtonMenu, leaderboardEnabled } from './config.js'
import { ITEMS_PER_PAGE } from './constants.js'

// ─── Menu Utama (tanpa nomor produk) ──────────────────────────────────────
function getMainMenuKeyboard() {
  const keyboard = [
    [{ text: '🛍️ List Produk', style: 'primary' }, { text: '📦 Stok', style: 'primary' }],
    [{ text: '📜 Riwayat Transaksi', style: 'primary' }, { text: '🔍 Cek Transaksi', style: 'primary' }],
    [{ text: '💳 Deposit', style: 'success' }, { text: '👤 Profil', style: 'primary' }]
  ]

  const lbRow = [{ text: '🔥 Produk Populer', style: 'primary' }]
  if (leaderboardEnabled !== false) {
    lbRow.push({ text: '🏆 Leaderboard', style: 'primary' })
  }
  keyboard.push(lbRow)

  keyboard.push([{ text: '❓ Cara Order', style: 'primary' }, { text: '🎫 Tiket Bantuan', style: 'primary' }])

  return {
    keyboard,
    resize_keyboard: true
  }
}

// ─── Keyboard Nomor Produk (muncul setelah klik List Produk) ──────────────
function getProductNumberKeyboard(kategori = [], page = 1) {
  const totalPages = Math.max(1, Math.ceil(kategori.length / ITEMS_PER_PAGE))
  const pg = Math.min(Math.max(1, page), totalPages)
  const start = (pg - 1) * ITEMS_PER_PAGE
  const pageItems = kategori.slice(start, start + ITEMS_PER_PAGE)
  const rows = []
  for (let i = 0; i < pageItems.length; i += 3) {
    // Q2: nomor urut halaman (1,2,3...) — bukan ID asli (membingungkan bila ID tak berurutan).
    rows.push(pageItems.slice(i, i + 3).map((k, j) => ({ text: String(start + i + j + 1) })))
  }
  const nav = []
  if (pg > 1) nav.push({ text: '⬅️ Sebelumnya' })
  if (pg < totalPages) nav.push({ text: 'Selanjutnya ➡️' })
  if (nav.length) rows.push(nav)
  rows.push([{ text: '🔙 Kembali ke Menu Utama' }])
  return { keyboard: rows, resize_keyboard: true }
}

// ponytail: alias sisa untuk pemanggil di commands.js/callbacks.js; hapus saat file itu boleh disentuh.
function getReplyKeyboard() {
  return getMainMenuKeyboard()
}

function getManagePanel() {
  return {
    inline_keyboard: [
      [{ text: 'Produk Manager', callback_data: 'cad_backin' }, { text: 'Varian Manager', callback_data: 'cad_varian' }],
      [{ text: 'Config Editor', callback_data: 'edit_config' }],
      [{ text: 'Tutup Panel', callback_data: 'manage_tutup' }]
    ]
  }
}


export {
  getMainMenuKeyboard, getProductNumberKeyboard,
  getReplyKeyboard, getManagePanel
}
