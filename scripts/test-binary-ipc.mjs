import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
const calls = []
globalThis.window = { __TAURI_INTERNALS__: { invoke: async (...args) => { calls.push(args); return 'ok' } } }
try {
  const { api } = await server.ssrLoadModule('/src/api.ts')
  const { readFileBytes, binaryMetadataHeader, MAX_ATTACHMENT_BYTES, MAX_EDITOR_GROUP_BYTES } = await server.ssrLoadModule('/src/lib/binaryIpc.ts')
  const bytes = new Uint8Array([0, 127, 128, 255])
  await api.stageAttachment(bytes, 'txt')
  await api.importEditors(bytes, '编辑库（新版）.xlsx')
  await api.importEditorGroups(bytes, '编辑组.json')
  await api.saveAcceptedShareImage('/tmp/分享 图.png', bytes)
  const expected = [
    ['stage_attachment', { extension: 'txt' }],
    ['import_editors', { file_name: '编辑库（新版）.xlsx' }],
    ['import_editor_groups', { file_name: '编辑组.json' }],
    ['save_accepted_share_image', { path: '/tmp/分享 图.png' }],
  ]
  for (let i = 0; i < expected.length; i++) {
    const [command, payload, options] = calls[i]
    assert.equal(command, expected[i][0])
    assert.equal(payload, bytes, 'pass the original binary buffer to Tauri without JSON conversion or copying')
    const metadata = JSON.parse(Buffer.from(options.headers['x-file-metadata'], 'base64').toString('utf8'))
    assert.deepEqual(metadata, expected[i][1])
  }
  assert.throws(() => binaryMetadataHeader({ path: '稿'.repeat(3000) }), /过长/)
  for (const limit of [MAX_ATTACHMENT_BYTES, MAX_EDITOR_GROUP_BYTES]) {
    for (const size of [0, limit + 1]) {
      await assert.rejects(readFileBytes({ size, arrayBuffer() { assert.fail('invalid files must not be read') } }, limit, '文件'), /不能为空/)
    }
  }
  const { invalidateStats } = await server.ssrLoadModule('/src/api.ts')
  await Promise.all([api.getStats('2026-01-01', '2026-01-31', 'day'), api.getStats('2026-01-01', '2026-01-31', 'day')])
  assert.equal(calls.filter(c => c[0] === 'get_stats').length, 1)
  await api.getStats('2026-01-01', '2026-01-31', 'day')
  assert.equal(calls.filter(c => c[0] === 'get_stats').length, 1, 'repeat navigation uses the cached report')
  invalidateStats()
  await api.getStats('2026-01-01', '2026-01-31', 'day')
  assert.equal(calls.filter(c => c[0] === 'get_stats').length, 2, 'data mutation invalidates statistics')
  await api.getStats('2026-01-01', '2026-01-31', 'day', true)
  assert.equal(calls.filter(c => c[0] === 'get_stats').length, 3, 'manual refresh bypasses cached statistics')
  const file = new File([bytes], '有效.txt')
  assert.deepEqual(await readFileBytes(file, MAX_ATTACHMENT_BYTES, '文件'), bytes)
  console.log('binary IPC tests passed: real API call sites, Unicode metadata, no payload copying, pre-read size limits')
} finally {
  delete globalThis.window
  await server.close()
}
