import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { filterEditorText, pickPlatformEditors, matchEditorResults, changeEditorSelection, buildEditorSearchIndex, searchEditorIndex } = await server.ssrLoadModule('/src/lib/editorListModel.ts')
  const { createRequestGuard } = await server.ssrLoadModule('/src/lib/requestGuard.ts')
  const editor = (id, platform, extra = {}) => ({ id, platform, email: `e${id}@example.com`, name: `编辑${id}`, source: '手动数据', notes: '', work_type: ['短篇', '古言'], rejected_types: [], favorited: false, enabled: true, ...extra })
  const items = [editor(1, '同平台'), editor(2, '同平台', { favorited: true }), editor(3, '另一平台', { work_type: ['古言'], rejected_types: ['重生'] })]
  const original = JSON.stringify(items)
  assert.deepEqual(filterEditorText(items, ' E1@EXAMPLE.COM ').map(e => e.id), [1])
  assert.deepEqual(filterEditorText(items, '重生').map(e => e.id), [3], 'search includes rejection tags in both lists')
  assert.equal(filterEditorText(items, '', '同平台').length, 2)
  const tags = { included: ['短篇', '古言'], excluded: [], match: 'any' }
  assert.equal(matchEditorResults(items, tags).length, 3)
  assert.equal(matchEditorResults(items, { ...tags, match: 'all' }).length, 2)
  assert.equal(matchEditorResults(items, tags, true).length, 2, 'plan keeps separate length and genre requirements')
  assert.equal(matchEditorResults(items, { ...tags, included: ['重生'] }, true).length, 0)
  assert.equal(matchEditorResults(items, { ...tags, excluded: ['古言'] }).length, 0)
  const sorted = matchEditorResults(items, tags)
  assert.equal(sorted[0].id, 2)
  assert.deepEqual(pickPlatformEditors(sorted, new Set([1])).map(e => e.id), [1, 3], 'existing platform choice wins over favorite ordering')
  const selected = new Set([1, 9])
  assert.deepEqual([...changeEditorSelection(selected, [items[1]], true)], [1, 9, 2])
  assert.deepEqual([...changeEditorSelection(selected, [items[0]], false)], [9], 'off-page selection survives')
  assert.deepEqual([...selected], [1, 9]); assert.equal(JSON.stringify(items), original)
  const index = buildEditorSearchIndex(items)
  for (const query of ['', '编辑', 'E1@EXAMPLE.COM', '重生', '不存在']) {
    for (const platform of ['', '同平台']) {
      assert.deepEqual(matchEditorResults(searchEditorIndex(index, query, platform), tags, false, true),
        matchEditorResults(filterEditorText(items, query, platform), tags))
    }
  }
  const updated = items.map(e => e.id === 1 ? { ...e, notes: '新增关键词' } : e)
  assert.equal(searchEditorIndex(buildEditorSearchIndex(updated), '新增关键词')[0].id, 1)
  assert.equal(searchEditorIndex(index, '新增关键词').length, 0)
  const many = Array.from({ length: 10000 }, (_, i) => editor(i, `平台${i % 30}`, { notes: '收稿说明，欢迎现代、古言、悬疑等作品。'.repeat(12) }))
  const queries = ['编辑', 'example.com', '悬疑', '平台1', '古言', '没有匹配', '编辑99', 'e99@', '平台20', '欢迎']
  const clock = fn => { const start = performance.now(); const result = fn(); return { ms: performance.now() - start, result } }
  const old = clock(() => queries.map(q => matchEditorResults(filterEditorText(many, q), tags).map(e => e.id)))
  const built = clock(() => buildEditorSearchIndex(many))
  const warm = clock(() => queries.map(q => matchEditorResults(searchEditorIndex(built.result, q), tags, false, true).map(e => e.id)))
  assert.deepEqual(warm.result, old.result)
  console.log(`10000 editors / 10 searches: ${old.ms.toFixed(1)} ms -> ${warm.ms.toFixed(1)} ms; one-time index ${built.ms.toFixed(1)} ms (calculation only)`)
  const requests = createRequestGuard(), first = requests.begin(), second = requests.begin()
  assert.equal(requests.isCurrent(first), false); assert.equal(requests.isCurrent(second), true)
  requests.invalidate(); assert.equal(requests.isCurrent(second), false)
  console.log('PASS: shared search, any/all and plan tags, immutable platform choices, scoped selection, stale/closed request rejection')
} finally { await server.close() }
