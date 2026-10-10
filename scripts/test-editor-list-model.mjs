import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { filterEditorText, pickPlatformEditors, matchEditorResults, changeEditorSelection, buildEditorSearchIndex, searchEditorIndex } = await server.ssrLoadModule('/src/lib/editorListModel.ts')
  const { createRequestGuard } = await server.ssrLoadModule('/src/lib/requestGuard.ts')
  const { editorFilterTagOptions } = await server.ssrLoadModule('/src/views/editorLibraryShared.ts')
  const { additionalPlanEditors } = await server.ssrLoadModule('/src/views/planShared.ts')
  const tagCandidates = [
    { work_type: ['甜宠', '甜宠', ' 悬疑 ', ''], rejected_types: ['百合'] },
    { work_type: ['甜宠', '知乎风'], rejected_types: ['古言'] },
  ]
  assert.deepEqual(editorFilterTagOptions(tagCandidates), [
    { label: '甜宠', count: 2 }, { label: '悬疑', count: 1 }, { label: '知乎风', count: 1 },
  ], 'only active receipt tags appear, counted once per editor; rejection-only labels stay out')
  assert.deepEqual(editorFilterTagOptions(tagCandidates.slice(1)), [
    { label: '甜宠', count: 1 }, { label: '知乎风', count: 1 },
  ], 'narrowing candidates removes tags that now have no editors')
  assert.deepEqual(editorFilterTagOptions([]), [], 'empty lists offer no zero-count tags')
  const editor = (id, platform, extra = {}) => ({ id, platform, email: `e${id}@example.com`, name: `编辑${id}`, source: '手动数据', notes: '', work_type: ['短篇', '古言'], rejected_types: [], favorited: false, enabled: true, ...extra })
  const items = [editor(1, '同平台'), editor(2, '同平台', { favorited: true }), editor(3, '另一平台', { work_type: ['古言'], rejected_types: ['重生'] })]
  const additions = [
    editor(10, ' 同平台 '), editor(11, '新平台'), editor(12, '新平台', { favorited: true }),
    editor(13, '新平台B', { enabled: false }), editor(14, '新平台C', { email: 'invalid' }),
    editor(15, 'DREAME'), editor(16, 'Dreame', { favorited: true }),
    editor(17, '', { email: 'unknown1@example.com' }), editor(18, '', { email: 'unknown2@example.com' }),
    editor(19, '共享邮箱平台', { email: 'E1@EXAMPLE.COM' }),
  ]
  const recipients = ['编辑甲 <E1@EXAMPLE.COM>', 'manual@example.com']
  const recipientsBefore = JSON.stringify(recipients), additionsBefore = JSON.stringify(additions)
  const picks = additionalPlanEditors(additions, recipients, items)
  assert.deepEqual(new Set(picks.map(e => e.id)), new Set([12, 16, 17, 18]),
    'batch skips existing emails and platforms, invalid/disabled editors; favorites win and English platform case is ignored')
  assert.equal(JSON.stringify(recipients), recipientsBefore)
  assert.equal(JSON.stringify(additions), additionsBefore)
  assert.deepEqual(additionalPlanEditors(additions, [...recipients, ...picks.map(e => e.email)], [...items, ...additions]), [],
    'repeated batch adds no editor or platform again')
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
