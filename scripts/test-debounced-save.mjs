import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
const tick = () => new Promise(resolve => setTimeout(resolve, 35))
try {
  const { createDebouncedSave } = await server.ssrLoadModule('/src/lib/debouncedSave.ts')
  const writes = [], errors = []
  let release
  const queue = createDebouncedSave(async value => {
    writes.push(value)
    if (value === 'slow') await new Promise(resolve => { release = resolve })
    if (value === 'failed') throw new Error('failure')
  }, error => errors.push(error), 10)
  for (let i = 0; i < 40; i++) queue.schedule(`draft-${i}`)
  await tick()
  assert.deepEqual(writes, ['draft-39'])
  queue.schedule('leave-page')
  await queue.flush()
  assert.deepEqual(writes, ['draft-39', 'leave-page'])
  queue.schedule('slow')
  const first = queue.flush()
  queue.schedule('intermediate')
  queue.schedule('latest')
  const second = queue.flush()
  assert.equal(writes.at(-1), 'slow')
  release()
  await Promise.all([first, second])
  assert.deepEqual(writes.slice(-2), ['slow', 'latest'])
  queue.schedule('failed')
  await tick()
  assert.equal(errors.length, 1)
  assert.equal(queue.isPending(), true)
  queue.schedule('recovered')
  await queue.flush()
  assert.equal(writes.at(-1), 'recovered')
  assert.equal(queue.isPending(), false)
  console.log('PASS: burst coalescing, navigation flush, serialized writes, newest draft and recovery after failure')
} finally { await server.close() }
