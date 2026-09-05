import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { groupPlanRecipients, isValidSendIntervalRange, matchingEditorGroupId, summarizeEditorGroup } = await server.ssrLoadModule('/src/views/planShared.ts')
  const editor = (id, email, enabled = true) => ({ id, name: `编辑${id}`, platform: '测试平台', email, enabled })
  const original = [editor(1, 'editor@example.com'), editor(2, 'EDITOR@example.com'),
    editor(3, 'disabled@example.com', false), editor(4, 'invalid'), editor(5, 'second@example.com')]
  const before = JSON.stringify(original)
  const recipients = groupPlanRecipients(original)
  assert.equal(recipients.length, 2, 'case-insensitive duplicate, disabled and invalid addresses are skipped')
  assert.ok(recipients[0].includes('editor@example.com'))
  assert.ok(recipients[1].includes('second@example.com'))
  assert.equal(JSON.stringify(original), before, 'building a plan never modifies the group')
  assert.deepEqual(groupPlanRecipients([]), [])
  assert.deepEqual(groupPlanRecipients([editor(1, 'x', false)]), [])
  assert.equal(isValidSendIntervalRange(100, 240), true)
  assert.equal(isValidSendIntervalRange(240, 100), false)
  assert.equal(isValidSendIntervalRange(0, 240), false)
  assert.equal(isValidSendIntervalRange(1.5, 240), false)
  assert.equal(isValidSendIntervalRange(100, 86401), false)
  assert.equal(isValidSendIntervalRange(100, 100), true)

  const groups = [
    { id: 1, name: '短篇', editor_ids: [1, 2, 2] },
    { id: 2, name: '重点', editor_ids: [1, 5] },
  ]
  const library = [editor(1, 'a@x.com'), editor(2, 'b@x.com'), editor(5, 'c@x.com')]
  assert.equal(matchingEditorGroupId(groups, library, new Set([1, 2])), 1)
  assert.equal(matchingEditorGroupId(groups, library, new Set([1, 5])), 2)
  assert.equal(matchingEditorGroupId(groups, library, new Set([1])), null)
  assert.equal(matchingEditorGroupId(groups, library, new Set()), null)
  assert.deepEqual(summarizeEditorGroup([]).platformsLabel, '还没有成员')
  assert.equal(summarizeEditorGroup([editor(1, 'a@x.com'), { ...editor(2, 'b@x.com'), platform: '晋江' }]).count, 2)

  console.log('PASS: group recipients, immutable source group, empty/invalid groups and interval validation')
} finally {
  await server.close()
}
