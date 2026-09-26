import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { createResourceCache } = await server.ssrLoadModule('/src/lib/resourceCache.ts')
  const pending = []
  const cache = createResourceCache(() => new Promise((resolve, reject) => pending.push({ resolve, reject })))
  const first = cache.read()
  assert.equal(cache.read(), first, 'concurrent callers share one request')
  cache.invalidate()
  const second = cache.read()
  pending[1].resolve('new'); assert.equal(await second, 'new')
  pending[0].resolve('old'); await first
  assert.equal(await cache.read(), 'new', 'old pending request cannot overwrite invalidated data')
  const refreshed = cache.read(true)
  pending[2].reject(new Error('offline'))
  await assert.rejects(refreshed)
  const retry = cache.read(); pending[3].resolve('recovered')
  assert.equal(await retry, 'recovered', 'failed request does not poison retries')
  const refresh = cache.read(true)
  assert.equal(cache.read(true), refresh, 'simultaneous forced refreshes share one request')
  cache.invalidate()
  const afterMutation = cache.read(true)
  assert.notEqual(afterMutation, refresh, 'mutation invalidation supersedes an in-flight refresh')
  pending[5].resolve('after mutation'); await afterMutation
  pending[4].resolve('before mutation'); await refresh
  assert.equal(await cache.read(), 'after mutation')
  const coldCache = createResourceCache(() => new Promise(resolve => pending.push({ resolve })))
  const cold = coldCache.read()
  const forced = coldCache.read(true)
  assert.notEqual(forced, cold, 'forced refresh supersedes a normal read')
  pending[7].resolve('fresh'); await forced
  pending[6].resolve('stale'); await cold
  assert.equal(await coldCache.read(), 'fresh')
  let attempt = 0
  const throwing = createResourceCache(() => { if (!attempt++) throw new Error('sync failure'); return Promise.resolve('ok') })
  await assert.rejects(throwing.read(), /sync failure/)
  assert.equal(await throwing.read(), 'ok')
  console.log('resource cache tests passed')
} finally { await server.close() }
