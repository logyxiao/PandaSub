import assert from 'node:assert/strict'
import { createServer } from 'vite'
const calls = []
globalThis.__detailCalls = calls
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', plugins: [{
  name: 'isolated-mail-api', enforce: 'pre',
  load(id) { if (id.endsWith('/src/api.ts')) return `export const api={getLocalReplyContent:async id=>globalThis.__localDetails?.get(id)??{text:"local "+id,html:"",inline_images:{},attachments:[],complete:false},getReplyContent:id=>new Promise((resolve,reject)=>globalThis.__detailCalls.push({id,resolve,reject}))}` },
}] })
const reply = id => ({ id, account_id: 1, imap_generation: 0, imap_uid_validity: 10, imap_uid: id, message_id: String(id) })
const content = { text: 'body', html: '', inline_images: {}, attachments: [], complete: true }
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
try {
  const cache = await server.ssrLoadModule('/src/lib/mailContentCache.ts')
  const controllers = Array.from({ length: 10 }, () => new AbortController())
  const requests = controllers.map((controller, id) => cache.loadMailContent(reply(id), controller.signal).catch(error => error.name))
  await tick()
  assert.deepEqual(calls.map(call => call.id), [9, 8], 'latest readers get the two available slots')
  for (let i = 0; i < 8; i++) controllers[i].abort()
  globalThis.__localDetails = new Map([[20, content]])
  const beforeLocal = calls.length
  assert.equal(await cache.loadMailContent(reply(20)), content)
  assert.equal(calls.length, beforeLocal, 'complete disk cache bypasses occupied network slots')
  let localText
  const latest = cache.loadMailContent(reply(10), undefined, local => { localText = local.text })
  await tick()
  assert.equal(localText, 'local 10', 'local text is published before a network slot is available')
  const sharedController = new AbortController()
  const shared = cache.loadMailContent(reply(9), sharedController.signal).catch(error => error.name)
  sharedController.abort()
  assert.equal(await shared, 'AbortError')
  controllers[9].abort()
  calls[0].resolve(content)
  await tick()
  assert.deepEqual(calls.map(call => call.id), [9, 8, 10], 'closed queued readers never reach IPC')
  calls[1].reject(new Error('offline'))
  calls[2].resolve(content)
  assert.equal(await latest, content)
  await Promise.all(requests)
  await tick()
  const retry = cache.loadMailContent(reply(8)); await tick()
  assert.equal(calls.at(-1).id, 8)
  calls.at(-1).resolve({ ...content, complete: false, warning: 'partial' })
  await retry
  const second = cache.loadMailContent(reply(8)); await tick()
  assert.equal(calls.length, 5, 'partial results can be retried immediately')
  calls.at(-1).resolve(content); await second
  await tick()
  cache.clearMailContentCache()
  const beforeClear = cache.loadMailContent(reply(50)); await tick()
  cache.clearMailContentCache()
  calls.at(-1).resolve(content); await beforeClear
  assert.equal(cache.cachedMailContent(reply(50)), null, 'old requests cannot refill a cleared generation')
  console.log('PASS mail request admission, latest priority, per-reader cancellation, shared loads, retry and cache generation')
} finally { await server.close(); delete globalThis.__detailCalls; delete globalThis.__localDetails }
