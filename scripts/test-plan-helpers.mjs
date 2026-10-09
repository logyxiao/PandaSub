import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { groupPlanEditors, groupPlanRecipients, isValidSendIntervalRange, matchingEditorGroupId, summarizeEditorGroup,
    defaultMailTemplates, normalizeDefaultMailTemplates, hydrateMailTemplates, fillPlaceholders } = await server.ssrLoadModule('/src/views/planShared.ts')
  const editor = (id, email, enabled = true) => ({ id, name: `编辑${id}`, platform: '测试平台', email, enabled })
  const original = [editor(1, 'editor@example.com'), editor(2, 'EDITOR@example.com'),
    editor(3, 'disabled@example.com', false), editor(4, 'invalid'), { ...editor(5, 'second@example.com'), platform: '另一平台' }]
  const before = JSON.stringify(original)
  const recipients = groupPlanRecipients(original)
  assert.equal(recipients.length, 2, 'case-insensitive duplicate, disabled and invalid addresses are skipped')
  assert.ok(recipients[0].includes('editor@example.com'))
  assert.ok(recipients[1].includes('second@example.com'))
  assert.equal(JSON.stringify(original), before, 'building a plan never modifies the group')
  assert.deepEqual(groupPlanRecipients([]), [])
  assert.deepEqual(groupPlanRecipients([editor(1, 'x', false)]), [])
  const platformGroup = [
    editor(1, 'first@example.com'),
    { ...editor(2, 'favorite@example.com'), platform: ' 测试平台 ', favorited: true },
    { ...editor(3, 'disabled@example.com', false), platform: '第三平台', favorited: true },
    { ...editor(4, 'invalid'), platform: '第三平台' },
    { ...editor(5, 'valid@example.com'), platform: '第三平台' },
    { ...editor(6, 'FIRST@example.com'), platform: '测试平台' },
    { ...editor(7, 'unknown1@example.com'), platform: '' },
    { ...editor(8, 'unknown2@example.com'), platform: '' },
  ]
  const platformBefore = JSON.stringify(platformGroup)
  const picks = groupPlanEditors(platformGroup)
  assert.equal(picks.length, 4, 'one valid editor per known platform; unassigned platforms remain separate')
  assert.ok(picks.some(e => e.id === 2), 'favorite wins over another editor at the same trimmed platform')
  assert.ok(picks.some(e => e.id === 5), 'invalid and disabled peers do not hide a valid recipient')
  assert.equal(groupPlanRecipients(platformGroup).length, picks.length)
  assert.equal(JSON.stringify(platformGroup), platformBefore, 'platform deduplication preserves the saved group')
  assert.equal(groupPlanEditors([{ ...editor(1, 'same@example.com'), platform: '甲' },
    { ...editor(2, 'SAME@example.com'), platform: '乙' }]).length, 1, 'shared mailboxes are still deduplicated')
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

  const templates = defaultMailTemplates()
  const { default: catalog } = await server.ssrLoadModule('/src/data/mail-template-catalog.json')
  const legacyBefore = JSON.stringify(catalog.legacy)
  const upgradedPool = hydrateMailTemplates(catalog.legacy, '', '')
  assert.equal(upgradedPool.length, 20, 'opening an old built-in plan exposes the expanded pool')
  assert.equal(JSON.stringify(catalog.legacy), legacyBefore, 'upgrade does not mutate saved input')
  assert.equal(hydrateMailTemplates(upgradedPool.slice(0, 3), '', '').length, 3, 'later deliberate removals remain removed')
  assert.equal(templates.length, 20)
  assert.equal(new Set(templates.map(item => item.id)).size, 20)
  assert.equal(normalizeDefaultMailTemplates().length, 20, 'no built-in template is discarded')
  for (const template of templates) {
    assert.ok(template.subject.includes('{{作品名}}') && template.subject.includes('{{字数}}') && template.subject.includes('{{类型}}'))
    assert.doesNotMatch(template.subject + template.body, /编辑昵称|收件人|恳请|贵处|冒昧/)
    for (const genres of [[], ['短篇', '甜宠']]) {
      const extras = { wordCount: 10000, genres, category: '短篇' }
      const text = fillPlaceholders(template.body, '不确定的编辑 <recipient@example.com>', '小熊来信', extras)
      assert.match(text, /小熊来信/)
      if (template.body.includes('{{字数}}')) assert.match(text, /10000字/)
      assert.match(fillPlaceholders(template.subject, '', '小熊来信', { ...extras, asSubject: true }), /10000字/)
      assert.doesNotMatch(text, /不确定的编辑|recipient@example.com|\{\{|类型[：:]\s*\n/)
      assert.equal(text, fillPlaceholders(template.body, '', '小熊来信', extras), 'greeting never depends on the recipient name')
    }
  }
  assert.equal(catalog.previous.length, 14)
  for (const previous of catalog.previous) {
    const expected = templates.find(item => item.id === previous.id)
    assert.equal(hydrateMailTemplates([previous], '', '')[0].body, expected.body)
    assert.equal(normalizeDefaultMailTemplates([previous])[0].body, expected.body)
    const custom = { ...previous, body: '我自己写的投稿话术' }
    assert.equal(hydrateMailTemplates([custom], '', '')[0].body, custom.body)
  }
  const personalized = [{id:'custom',name:'自定义',subject:'给{{收件人}}：{{作品名}}',body:'{{编辑昵称}}，您好。{{收件人}}请查收《{{作品名}}》。'}]
  for (const cleaned of [normalizeDefaultMailTemplates(personalized), hydrateMailTemplates(personalized, '', ''), hydrateMailTemplates([], personalized[0].subject, personalized[0].body)]) {
    assert.doesNotMatch(cleaned[0].subject + cleaned[0].body, /\{\{编辑昵称\}\}|\{\{收件人\}\}/)
  }

  console.log('PASS: group recipients, immutable source group, interval validation; 20 natural templates, recipient-independent greetings and legacy placeholder cleanup')
} finally {
  await server.close()
}
