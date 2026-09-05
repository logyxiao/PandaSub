import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { GroupMemberPicker } = await server.ssrLoadModule('/src/components/GroupMemberPicker.tsx')
  const editors = Array.from({ length: 5000 }, (_, index) => ({
    id: index + 1, name: `编辑${index + 1}`, platform: `平台${index % 100}`,
    email: `editor${index + 1}@example.com`, enabled: true,
    work_type: ['短篇', index % 2 ? '古言' : '现言'], rejected_types: [], favorited: false,
  }))
  const before = JSON.stringify(editors)
  for (const count of [0, 1, 2500, 5000]) {
    const selectedIds = new Set(editors.slice(0, count).map((editor) => editor.id))
    const html = renderToStaticMarkup(createElement(GroupMemberPicker, {
      editors, selectedIds, onChange: () => assert.fail('render must not change selection'),
      header: createElement('span', null, '编辑组名称'),
    }))
    const renderedRows = [...html.matchAll(/data-editor-id=/g)].length
    assert.equal(renderedRows, Math.min(80, count) + Math.min(80, editors.length - count))
    assert.equal([...html.matchAll(/<input/g)].length, 1, 'both panes share one search input')
    assert.ok(html.includes('编辑组名称'))
    assert.equal(selectedIds.size, count)
  }
  assert.equal(JSON.stringify(editors), before, 'sorting must not mutate the source library')
  console.log('PASS: 5000-member lists render at most 160 rows; shared search and immutable inputs')
} finally {
  await server.close()
}
