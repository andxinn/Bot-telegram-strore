import { dbGet, dbPut, dbDelete, dbExists } from './db.js'

async function readJSON(env, key, fallback = []) {
  const val = await dbGet(env, key)
  if (val === null || val === undefined) return fallback
  try { return JSON.parse(val) } catch { return fallback }
}
async function writeJSON(env, key, data, opts) {
  await dbPut(env, key, JSON.stringify(data, null, 2), opts)
}
async function readText(env, key, fallback = '') {
  const val = await dbGet(env, key)
  if (val === null || val === undefined) return fallback
  return val
}
async function writeText(env, key, text, opts) {
  await dbPut(env, key, text, opts)
}
async function deleteKey(env, key) {
  await dbDelete(env, key)
}
async function existsKey(env, key) {
  return await dbExists(env, key)
}

export { readJSON, writeJSON, readText, writeText, deleteKey, existsKey }
