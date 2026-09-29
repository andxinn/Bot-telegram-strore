async function readJSON(env, key, fallback = []) {
  const val = await env.DB.get(key)
  if (val === null || val === undefined) return fallback
  try { return JSON.parse(val) } catch { return fallback }
}
async function writeJSON(env, key, data) {
  await env.DB.put(key, JSON.stringify(data, null, 2))
}
async function readText(env, key, fallback = '') {
  const val = await env.DB.get(key)
  if (val === null || val === undefined) return fallback
  return val
}
async function writeText(env, key, text) {
  await env.DB.put(key, text)
}
async function deleteKey(env, key) {
  await env.DB.delete(key)
}
async function existsKey(env, key) {
  const val = await env.DB.get(key)
  return val !== null && val !== undefined
}

export { readJSON, writeJSON, readText, writeText, deleteKey, existsKey }
