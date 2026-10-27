import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
try {
  const { groupPlanEditors, groupPlanRecipients, randomGroupPlanEditors, toInput, isValidSendIntervalRange, matchingEditorGroupId, summarizeEditorGroup,
    defaultMailTemplates, normalizeDefaultMailTemplates, hydrateMailTemplates, fillPlaceholders, syncMailFromTemplates, createEmptyManuscript,
    normalizeEditorTags, editorMatchesPlan, mergeEditorSelectionByPlatform, pickRandomPlatformEditor } = await server.ssrLoadModule('/src/views/planShared.ts')
  const reviewedStyle = { enabled: true, work_type: ['知乎风', '知乎风', '小程序'], rejected_types: ['知乎风', '番茄风'] }
  assert.deepEqual(normalizeEditorTags(reviewedStyle).work_type, ['知乎风'])
  assert.deepEqual(normalizeEditorTags(reviewedStyle).rejected_types, ['知乎风'])
  assert.equal(editorMatchesPlan({ enabled: true, work_type: ['知乎风'] }, ['知乎风']), true)
  const editor = (id, email, enabled = true) => ({ id, name: `编辑${id}`, platform: '测试平台', email, enabled })
  const original = [editor(1, 'editor@example.com'), editor(2, 'EDITOR@example.com'),
    editor(3, 'disabled@example.com', false), editor(4, 'invalid'), { ...editor(5, 'second@example.com'), platform: '另一平台' }]
  const before = JSON.stringify(original)
  const mixedCasePlatforms = [
    { ...editor(31, 'a@example.com'), platform: 'dreame' },
    { ...editor(32, 'b@example.com'), platform: ' Dreame ', favorited: true },
    { ...editor(33, 'c@example.com'), platform: 'goodnovel' },
    { ...editor(34, 'd@example.com'), platform: 'GoodNovel', favorited: true },
  ]
  assert.deepEqual(groupPlanEditors(mixedCasePlatforms).map(e => e.id), [32, 34],
    'platform casing cannot select two recipients from one platform')
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
  const randomGroup = [
    editor(1, 'ordinary@example.com'),
    { ...editor(2, 'favorite1@example.com'), favorited: true },
    { ...editor(3, 'favorite2@example.com'), favorited: true },
    { ...editor(4, 'disabled@example.com', false), favorited: true },
    { ...editor(5, 'invalid'), favorited: true },
    { ...editor(6, 'normal1@example.com'), platform: '另一平台' },
    { ...editor(7, 'normal2@example.com'), platform: '另一平台' },
    { ...editor(8, 'disabled2@example.com', false), platform: '另一平台', favorited: true },
    { ...editor(9, ' FAVORITE1@example.com '), favorited: true },
  ]
  const randomBefore = JSON.stringify(randomGroup)
  const eligible = [
    { ...editor(20, 'used@example.com'), work_type: ['短篇'], favorited: true, plan_sent_count: 5 },
    { ...editor(21, 'unused1@example.com'), work_type: ['短篇'], plan_sent_count: 0 },
    { ...editor(22, 'unused2@example.com'), work_type: ['短篇'], plan_sent_count: 0 },
    { ...editor(23, 'queued@example.com'), work_type: ['短篇'], favorited: true, plan_queued_count: 1 },
    { ...editor(24, 'disabled@example.com', false), work_type: ['短篇'], favorited: true },
    { ...editor(25, 'invalid'), work_type: ['短篇'], favorited: true },
    { ...editor(26, 'other@example.com'), work_type: ['长篇'], favorited: true },
    { ...editor(27, 'rejected@example.com'), work_type: ['短篇'], rejected_types: ['短篇'], favorited: true },
  ]
  const realRandom = Math.random
  try {
    Math.random = () => 0
    assert.deepEqual([...mergeEditorSelectionByPlatform(eligible, [], ['短篇'])], [21], 'type matching skips sent/queued favorites, invalid/disabled/wrong-type/rejecting candidates')
    Math.random = () => 0.999
    assert.deepEqual([...mergeEditorSelectionByPlatform(eligible, [], ['短篇'])], [22], 'type matching really draws a different eligible peer')
    Math.random = () => { throw new Error('manual selection must not draw again') }
    assert.deepEqual([...mergeEditorSelectionByPlatform(eligible, [20], ['短篇'])], [20], 'manual choice survives history and favorite priority')
    Math.random = () => 0
    assert.equal(pickRandomPlatformEditor([
      { ...eligible[0], plan_sent_count: 3 },
      { ...eligible[1], plan_sent_count: 2, plan_queued_count: 1 },
      { ...eligible[2], plan_sent_count: 2 },
    ]).id, 22, 'when everyone has history, least combined usage wins')
    assert.equal(pickRandomPlatformEditor([
      { ...eligible[1], plan_queued_count: 1 }, { ...eligible[0], plan_sent_count: 1, plan_queued_count: 0 },
    ]).id, 21, 'never-sent still precedes already-sent, even if reserved once')
    assert.equal(pickRandomPlatformEditor([{ ...eligible[1], favorited: false }, { ...eligible[2], favorited: true }]).id, 22, 'favorite wins among equally unused candidates')
    assert.equal(pickRandomPlatformEditor(eligible.slice(4, 6)), undefined)
    const first = randomGroupPlanEditors(randomGroup)
    assert.deepEqual(first.map(e => e.id), [2, 6], 'only valid favorites are eligible when available')
    Math.random = () => 0.999
    const second = randomGroupPlanEditors(randomGroup)
    assert.deepEqual(second.map(e => e.id), [3, 7], 'both favorites and all usable nonfavorites can be drawn on the next use')
    const fixed = groupPlanRecipients(second)
    Math.random = () => { throw new Error('fixed recipients must not draw again') }
    assert.deepEqual(groupPlanRecipients(second), fixed)
    const reopened = toInput({ recipients: fixed, lock_recipients: true, subject: '', body: '' })
    assert.deepEqual(reopened.recipients, fixed)
    assert.equal(reopened.lock_recipients, true)
    assert.deepEqual(randomGroupPlanEditors([]), [])
    assert.deepEqual(randomGroupPlanEditors([editor(1, 'invalid')]), [])
  } finally {
    Math.random = realRandom
  }
  assert.equal(JSON.stringify(randomGroup), randomBefore, 'drawing leaves group membership unchanged')
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
  for (const template of templates) {
    for (const subject of [template.subject.replace('+{{字数}}', ''), template.subject.replace(/\+\{\{(?:字数|类型)\}\}/g, ''), '自定义标题']) {
      const custom = { ...template, subject, body: '您好，请查收《{{作品名}}》。' }
      const before = JSON.stringify(custom)
      const defaults = normalizeDefaultMailTemplates([custom])
      assert.equal(defaults[0].subject, subject, 'saving defaults must not restore deleted metadata')
      const saved = syncMailFromTemplates({ ...createEmptyManuscript(defaults), title: '小熊来信', word_count: 12345 })
      assert.equal(saved.subject, subject, 'saving a plan must preserve its custom subject')
      const reopened = toInput(JSON.parse(JSON.stringify(saved)))
      assert.equal(reopened.mail_templates[0].subject, subject, 'reopening must not restore deleted metadata')
      const extras = { wordCount: saved.word_count, genres: ['短篇', '甜宠'], asSubject: true }
      const preview = fillPlaceholders(reopened.mail_templates[0].subject, '', saved.title, extras)
      assert.doesNotMatch(preview, /12345|\{\{/, 'preview only fills placeholders still in the template')
      assert.equal(reopened.mail_templates[0].body, custom.body)
      assert.equal(JSON.stringify(custom), before)
    }
  }
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
