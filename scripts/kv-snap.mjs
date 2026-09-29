#!/usr/bin/env node
/**
 * KV snapshot utility untuk dev-db.json
 *
 * Usage:
 *   node scripts/kv-snap.mjs save [label]         → simpan snapshot
 *   node scripts/kv-snap.mjs list                 → daftar snapshot
 *   node scripts/kv-snap.mjs load [nomor|substr]  → restore snapshot
 */
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(__dirname)
const DB   = path.join(ROOT, 'dev-db.json')
const SNAP = path.join(ROOT, 'snapshots')

if (!fs.existsSync(SNAP)) fs.mkdirSync(SNAP, { recursive: true })

function ts() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function listSnaps() {
  return fs.readdirSync(SNAP)
    .filter(f => f.startsWith('dev-db-') && f.endsWith('.json'))
    .sort().reverse()
}

function doLoad(name) {
  const src = path.join(SNAP, name)
  if (fs.existsSync(DB)) {
    const bak = path.join(SNAP, `dev-db-${ts()}-before-load.json`)
    fs.copyFileSync(DB, bak)
    console.log('💾 Backup dev-db saat ini: ' + path.basename(bak))
  }
  fs.copyFileSync(src, DB)
  console.log('✅ Restored dari: ' + name)
  console.log('⚠️  Restart dev-server (Ctrl+C → npm run dev) supaya berlaku.')
}

function cmdSave() {
  if (!fs.existsSync(DB)) {
    console.error('❌ dev-db.json belum ada. Jalankan `npm run dev` dulu.')
    process.exit(1)
  }
  const label = process.argv[3] ? '-' + process.argv[3].replace(/[^a-zA-Z0-9_-]/g, '') : ''
  const dest = path.join(SNAP, `dev-db-${ts()}${label}.json`)
  fs.copyFileSync(DB, dest)
  const size = (fs.statSync(dest).size / 1024).toFixed(1)
  console.log('✅ Snapshot: ' + path.basename(dest) + ' (' + size + ' KB)')
}

function cmdList() {
  const snaps = listSnaps()
  if (snaps.length === 0) {
    console.log('(belum ada snapshot)')
    return
  }
  console.log('Snapshot tersedia:')
  snaps.forEach((s, i) => {
    const sz = (fs.statSync(path.join(SNAP, s)).size / 1024).toFixed(1)
    console.log(`  ${String(i+1).padStart(3)}. ${s}  (${sz} KB)`)
  })
}

function cmdLoad() {
  const snaps = listSnaps()
  if (snaps.length === 0) {
    console.error('❌ Tidak ada snapshot.')
    process.exit(1)
  }
  const arg = process.argv[3]
  let target = null
  if (arg && /^\d+$/.test(arg)) target = snaps[parseInt(arg) - 1]
  else if (arg) target = snaps.find(s => s.includes(arg))
  if (target) {
    doLoad(target)
    return
  }
  console.log('Pilih snapshot untuk restore:')
  snaps.forEach((s, i) => console.log(`  ${i+1}. ${s}`))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question('Nomor: ', (ans) => {
    const t = snaps[parseInt(ans) - 1]
    if (!t) {
      console.error('❌ Nomor invalid.')
      process.exit(1)
    }
    doLoad(t)
    rl.close()
  })
}

const cmd = process.argv[2]
if (cmd === 'save') cmdSave()
else if (cmd === 'list') cmdList()
else if (cmd === 'load') cmdLoad()
else {
  console.log('Usage:')
  console.log('  npm run kv:snap [label]      → simpan snapshot')
  console.log('  npm run kv:list              → daftar snapshot')
  console.log('  npm run kv:load [nomor|kata] → restore snapshot')
}
