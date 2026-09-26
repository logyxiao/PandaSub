import assert from 'node:assert/strict'
import { createServer } from 'vite'
const fixture = { checks: 0, installs: 0, closes: 0, fail: true }
globalThis.__updateFixture = fixture
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} }
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', plugins: [{
  name: 'isolated-update-api', enforce: 'pre',
  load(id) { if (id.endsWith('/src/update.ts')) return `
    export const availableUpdate=async()=>{const f=globalThis.__updateFixture;f.checks++;if(f.fail)throw new Error('offline');return new Promise(resolve=>f.finishCheck=resolve)};
    export const installUpdate=async()=>{const f=globalThis.__updateFixture;f.installs++;await new Promise(resolve=>f.finishInstall=resolve)};
    export const restartApp=async()=>{throw new Error('No restart expected in regression')};
  ` },
}] })
try {
  const { runUpdateFlow } = await server.ssrLoadModule('/src/lib/updateFlow.ts')
  const prompts = [], notices = []
  const confirm = async opts => { prompts.push(opts); return opts.confirmLabel === '下载并安装' }
  const toast = (...args) => notices.push(args)
  const restart = async () => { throw new Error('Unexpected restart') }
  await runUpdateFlow(confirm, toast, restart)
  assert.match(notices[0][0], /offline/)
  fixture.fail = false
  const update = { version: '9.0.0', close: async () => { fixture.closes++ } }
  const cancelled = runUpdateFlow(confirm, toast, restart, true, () => false)
  fixture.finishCheck(update); await cancelled
  assert.equal(fixture.closes, 1, 'late cancelled checks release their update handle')
  const first = runUpdateFlow(confirm, toast, restart, true)
  await runUpdateFlow(confirm, toast, restart)
  assert.equal(fixture.checks, 3, 'automatic and manual entry points share one active flow')
  fixture.finishCheck(update)
  while (!fixture.finishInstall) await new Promise(resolve => setTimeout(resolve, 0))
  await runUpdateFlow(confirm, toast, restart)
  assert.equal(fixture.installs, 1)
  fixture.finishInstall(); await first
  await runUpdateFlow(confirm, toast, restart)
  assert.equal(fixture.checks, 3, 'installed updates do not install again before restart')
  assert.equal(fixture.closes, 2)
  assert.equal(prompts.length, 2, 'only one install prompt and one restart prompt')
  console.log('PASS shared update flow: failure recovery, cancelled handle cleanup, concurrent checks/downloads, installed state')
} finally {
  await server.close(); delete globalThis.__updateFixture; delete globalThis.sessionStorage
}
