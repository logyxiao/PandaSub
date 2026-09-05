import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { taskSendProgress, planSendProgress } = await server.ssrLoadModule('/src/views/planShared.ts')
  const manuscript = { id: 1, recipients: ['a@example.com', 'b@example.com', 'c@example.com'] }
  assert.deepEqual(taskSendProgress(manuscript, { sent: 0, total: 3 }), { sent: 0, total: 3 })
  assert.deepEqual(taskSendProgress(manuscript, { sent: 1, total: 3 }), { sent: 1, total: 3 })
  assert.deepEqual(taskSendProgress(manuscript, { sent: 9, total: 0 }), { sent: 9, total: 3 })
  assert.deepEqual(taskSendProgress({ recipients: ['A@example.com', 'a@example.com', 'bad'] }), { sent: 0, total: 1 })
  const plans = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, recipients: Array.from({ length: 100 }, (_, j) => `e${j}@example.com`) }))
  const deliveries = plans.flatMap((m) => m.recipients.map((recipient) => ({ manuscript_id: m.id, recipient })))
  const tasks = new Map(plans.map((m) => [m.id, { sent: 100, total: 100 }]))
  const time = (fn) => { const start = performance.now(); const result = fn(); return { ms: performance.now() - start, result } }
  const before = time(() => plans.map((m) => planSendProgress(m, deliveries)))
  const after = time(() => plans.map((m) => taskSendProgress(m, tasks.get(m.id))))
  assert.deepEqual(after.result, before.result)
  console.log(`PASS: current-round, draft, loop and duplicate recipient progress; 1000 plans / 100000 historical deliveries: ${before.ms.toFixed(2)} ms -> ${after.ms.toFixed(2)} ms (calculation only)`)
} finally {
  await server.close()
}
