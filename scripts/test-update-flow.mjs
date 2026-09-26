import assert from 'node:assert/strict'
import { createServer } from 'vite'
const fixture = { checks: 0, downloads: 0, installs: 0, closes: 0, fail: true }
globalThis.__updateFixture = fixture
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom', plugins: [{
  name: 'isolated-update-api', enforce: 'pre',
  load(id) { if (id.endsWith('/src/update.ts')) return `
    export const availableUpdate=async()=>{const f=globalThis.__updateFixture;f.checks++;if(f.fail)throw new Error('offline');return new Promise(resolve=>f.finishCheck=resolve)};
    export const downloadUpdate=async()=>{const f=globalThis.__updateFixture;f.downloads++;await new Promise(resolve=>f.finishDownload=resolve)};
    export const installUpdate=async()=>{const f=globalThis.__updateFixture;f.installs++;if(f.failInstall)throw new Error('install failed')};
  ` },
}] })
try {
  const { runUpdateFlow, applyPreparedUpdate } = await server.ssrLoadModule('/src/lib/updateFlow.ts')
  const notices = []
  const confirm = async () => { throw new Error('Background updates must not prompt') }
  const toast = (...args) => notices.push(args)
  const restart = async () => { throw new Error('Downloads must not restart') }
  await runUpdateFlow(confirm, toast, restart)
  assert.match(notices[0][0], /offline/)
  fixture.fail = false
  const update = { version: '9.0.0', close: async () => { fixture.closes++ } }
  const cancelled = runUpdateFlow(confirm, toast, restart, true, () => false)
  fixture.finishCheck(update); await cancelled
  assert.equal(fixture.closes, 1)
  const first = runUpdateFlow(confirm, toast, restart, true)
  await runUpdateFlow(confirm, toast, restart)
  assert.equal(fixture.checks, 3)
  fixture.finishCheck(update)
  while (!fixture.finishDownload) await new Promise(resolve => setTimeout(resolve, 0))
  await runUpdateFlow(confirm, toast, restart)
  assert.equal(fixture.downloads, 1)
  assert.equal(fixture.installs, 0)
  fixture.finishDownload(); await first
  await runUpdateFlow(confirm, toast, restart)
  assert.equal(fixture.checks, 3)
  assert.equal(fixture.closes, 1, 'ready package remains available')
  await applyPreparedUpdate(async () => {}, toast)
  assert.equal(fixture.installs, 0, 'cancelled leave guard runs before install')
  await applyPreparedUpdate(async () => { throw new Error('mail sending') }, toast)
  assert.equal(fixture.installs, 0, 'native sending guard runs before install')
  fixture.failInstall = true
  await applyPreparedUpdate(async before => { await before() }, toast)
  assert.equal(fixture.installs, 1)
  assert.equal(fixture.closes, 1, 'failed install can retry the same verified package')
  fixture.failInstall = false
  await applyPreparedUpdate(async before => { await before(); throw new Error('relaunch failed') }, toast)
  assert.equal(fixture.installs, 2)
  assert.equal(fixture.closes, 2)
  let restarted = false
  await applyPreparedUpdate(async before => { assert.equal(before, undefined); restarted = true }, toast)
  assert.ok(restarted)
  assert.equal(fixture.installs, 2, 'relaunch retry must not reinstall')
  console.log('PASS background update coalescing, handle cleanup, safe install guards, install/relaunch retry')
} finally { await server.close(); delete globalThis.__updateFixture }
