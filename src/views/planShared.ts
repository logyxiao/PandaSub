import { isValidEmail, parseRecipient } from '../format'
import type { Delivery, Editor, MailTemplate, Manuscript, ManuscriptInput, Task } from '../types'

export const LENGTH_TAGS = ['短篇', '中短篇'] as const
export const LENGTH_TAG_SET = new Set<string>(LENGTH_TAGS)

export function isLengthTag(tag: string) {
  return LENGTH_TAG_SET.has(tag)
}

/** 行上前两个胶囊优先作品类型；短篇 / 中短篇排到后面，多的进 +N。 */
export function editorRowTags(tags: Iterable<string> = []) {
  const main: string[] = []
  const lengths: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    if (isLengthTag(tag)) {
      if (!lengths.includes(tag)) lengths.push(tag)
    } else if (!main.includes(tag)) {
      main.push(tag)
    }
  }
  return [...main, ...lengths]
}

export function splitPlanTags(tags: Iterable<string>) {
  const lengths: string[] = []
  const genres: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    if (isLengthTag(tag)) {
      if (!lengths.includes(tag)) lengths.push(tag)
    } else if (!genres.includes(tag)) {
      genres.push(tag)
    }
  }
  return { lengths, genres }
}

export const GENRES = [
  ...LENGTH_TAGS,
  '女频', '男频',
  '全品类', '追妻', '追夫', '世情', '爽文', '脑洞', '古言', '现言',
  '悬疑', '年代', '情绪流', '都市', '亲情虐', '大女主', '玄幻', '重生',
  '打脸', '种田', '末世', '甜宠', '宅斗', '宫斗', '萌宝',
  '校园', '仙侠', '穿越', '穿书', '总裁', '婚恋', '虐恋',
  '全员背叛', '言情', '性转', '耽美', '百合', '同人', '死人文学', '系统', '女强', '信息差',
  '散文', '童话', '诗歌',
]
export const SOURCES = ['初始数据', '手动数据', '导入数据'] as const
const DROPPED_EDITOR_TAGS = new Set(['小程序', '知乎风', '番茄风'])

export function normalizeEditorTags<T extends Pick<Editor, 'work_type'> & Partial<Pick<Editor, 'rejected_types'>>>(editor: T): T {
  const work_type: string[] = []
  const seen = new Set<string>()
  for (const raw of editor.work_type ?? []) {
    const tag = raw.trim()
    if (!tag || DROPPED_EDITOR_TAGS.has(tag) || seen.has(tag)) continue
    seen.add(tag)
    work_type.push(tag)
  }
  const rejected_types: string[] = []
  const rejectedSeen = new Set<string>()
  for (const raw of editor.rejected_types ?? []) {
    const tag = raw.trim()
    if (!tag || DROPPED_EDITOR_TAGS.has(tag) || rejectedSeen.has(tag)) continue
    rejectedSeen.add(tag)
    rejected_types.push(tag)
  }
  return { ...editor, work_type, rejected_types }
}

export function editorMatchesPlan(
  editor: Editor,
  selected: string[],
  excluded: Iterable<string> = [],
) {
  const next = normalizeEditorTags(editor)
  const tags = next.work_type
  const banned = new Set([...excluded].map((tag) => tag.trim()).filter(Boolean))
  if (tags.some((tag) => banned.has(tag))) return false
  const rejected = new Set((next.rejected_types ?? []).map((tag) => tag.trim()).filter(Boolean))
  if (selected.some((tag) => rejected.has(tag.trim()))) return false
  const { lengths, genres } = splitPlanTags(selected)
  if (lengths.length && !lengths.some((tag) => tags.includes(tag))) return false
  if (genres.length && !genres.some((tag) => tags.includes(tag)) && !tags.includes('全品类')) return false
  return true
}

// 发送节奏：默认 3 分钟/次，沿用 2–4 分钟随机、偏向 3 分钟；其余选项按所选分钟数。
export const DEFAULT_SEND_INTERVAL_MIN = 3
export const ACCOUNT_DAILY_SEND_LIMIT = 80

export function accountTodayQuota(sentToday = 0) {
  const sent = Math.max(0, Math.floor(sentToday) || 0)
  return {
    sent,
    limit: ACCOUNT_DAILY_SEND_LIMIT,
    over: sent >= ACCOUNT_DAILY_SEND_LIMIT,
    label: `${sent}/${ACCOUNT_DAILY_SEND_LIMIT}`,
  }
}

export const SEND_INTERVAL_OPTIONS = [
  { minutes: 1, hint: '需配置3个投稿邮箱，同时投不同作品' },
  { minutes: 2, hint: '需配置2个投稿邮箱' },
  { minutes: 3, hint: '新邮箱第2篇作品开始可以3分钟' },
  { minutes: 5, hint: '新邮箱第1篇作品选5分钟预热邮箱' },
  { minutes: 8, hint: '邮箱被风控时，换成8分钟' },
] as const

export function normalizeSendIntervalMin(value: number | undefined | null) {
  return SEND_INTERVAL_OPTIONS.some((item) => item.minutes === value)
    ? value as (typeof SEND_INTERVAL_OPTIONS)[number]['minutes']
    : DEFAULT_SEND_INTERVAL_MIN
}

export function estimateAutoMinutes(count: number, intervalMin = DEFAULT_SEND_INTERVAL_MIN) {
  const minutes = normalizeSendIntervalMin(intervalMin)
  return Math.max(1, Math.round(count * minutes))
}

export function recipientEmailsForCopy(recipients: string[]) {
  return [...new Set(
    recipients
      .map((row) => parseRecipient(row).email.trim().toLowerCase())
      .filter((email) => isValidEmail(email)),
  )]
}

export const SCHEDULE_OPTIONS = [
  { value: 'immediate', label: '立即发送', description: '保存后马上开始投这一份名单' },
  { value: 'scheduled', label: '定时发送', description: '到选定时间再开始' },
  { value: 'loop', label: '循环本计划', description: '这份名单投完后再投一遍，需手动停止。不是等上一个计划结束' },
] as const


const OLD_DEFAULT_SUBJECTS = new Set([
  '投稿：《{{作品名}}》',
  '《{{作品名}}》投稿（{{字数}}）',
  '《{{作品名}}》投稿',
  '恳请审阅：《{{作品名}}》',
  '投稿附件：《{{作品名}}》',
  '投稿来了：《{{作品名}}》',
  '{{类型}} | 《{{作品名}}》',
  '《{{作品名}}》请您看看',
])

export const DEFAULT_MAIL_TEMPLATES: MailTemplate[] = [
  {
    id: 't1',
    name: '常规问候',
    subject: '投稿：《{{作品名}}》+{{字数}}+{{类型}}',
    body: '编辑老师您好：\n\n现将作品《{{作品名}}》投至贵处，恳请审阅。\n\n篇幅：{{篇幅}}\n字数：{{字数}}\n类型：{{类型}}\n\n完整稿件已随信附上，感谢您的时间。',
  },
  {
    id: 't2',
    name: '书名开场',
    subject: '《{{作品名}}》投稿+{{字数}}+{{类型}}',
    body: '您好：\n\n现投稿作品《{{作品名}}》，篇幅为{{篇幅}}，共{{字数}}。\n类型：{{类型}}\n\n正文见附件，烦请审阅，谢谢。',
  },
  {
    id: 't3',
    name: '简短投稿',
    subject: '《{{作品名}}》投稿+{{字数}}+{{类型}}',
    body: '编辑老师您好，现投稿《{{作品名}}》，{{篇幅}}，共{{字数}}。稿件已附上，烦请查收。',
  },
  {
    id: 't4',
    name: '恳请审阅',
    subject: '恳请审阅：《{{作品名}}》+{{字数}}+{{类型}}',
    body: '编辑老师您好：\n\n冒昧来信，现将作品《{{作品名}}》投稿至贵处。作品为{{篇幅}}，共{{字数}}，类型为{{类型}}。\n\n恳请审阅，若有修改建议，我会认真配合。\n\n祝工作顺利。',
  },
  {
    id: 't5',
    name: '附件说明',
    subject: '投稿附件：《{{作品名}}》+{{字数}}+{{类型}}',
    body: '编辑老师您好：\n\n作品《{{作品名}}》已作为附件发送，正文不在邮件中重复粘贴。\n\n篇幅：{{篇幅}}\n字数：{{字数}}\n类型：{{类型}}\n\n烦请查收。',
  },
  {
    id: 't6',
    name: '轻松口吻',
    subject: '投稿来了：《{{作品名}}》+{{字数}}+{{类型}}',
    body: '您好：\n\n投来一篇《{{作品名}}》，共{{字数}}，偏{{类型}}。全文放在附件里，方便时请帮忙看看，谢谢。',
  },
  {
    id: 't7',
    name: '类型自报',
    subject: '《{{作品名}}》+{{字数}}+{{类型}}',
    body: '编辑老师好：\n\n这篇是{{篇幅}}{{类型}}，《{{作品名}}》，{{字数}}。想问问贵处是否还收这类稿。附件里是全文。',
  },
  {
    id: 't8',
    name: '期待回复',
    subject: '《{{作品名}}》请您看看+{{字数}}+{{类型}}',
    body: '编辑老师您好：\n\n打扰了。作品《{{作品名}}》已附上，期待您的意见；若暂不合适，也完全理解。\n\n感谢阅读，祝工作顺利。',
  },
]

export function ensureSubjectMeta(subject: string) {
  let next = subject.trim() || '投稿：《{{作品名}}》'
  if (!next.includes('{{字数}}')) next = `${next}+{{字数}}`
  if (!next.includes('{{类型}}')) next = `${next}+{{类型}}`
  return next
}

export function upgradeMailSubject(item: MailTemplate) {
  const preset = DEFAULT_MAIL_TEMPLATES.find((entry) => entry.id === item.id)
  if (preset && OLD_DEFAULT_SUBJECTS.has(item.subject)) return preset.subject
  return ensureSubjectMeta(item.subject)
}

const DROPPED_MAIL_TEMPLATE_IDS = new Set(['t9', 't10'])
const DROPPED_MAIL_TEMPLATE_NAMES = new Set(['初次投稿', '完整稿件'])

export function isDroppedMailTemplate(item: MailTemplate) {
  return DROPPED_MAIL_TEMPLATE_IDS.has(item.id) || DROPPED_MAIL_TEMPLATE_NAMES.has(item.name.trim())
}

export function defaultMailTemplates(): MailTemplate[] {
  return DEFAULT_MAIL_TEMPLATES.map((item) => ({ ...item }))
}

function removeDefaultEditorNickname(body: string) {
  return body
    .replaceAll('尊敬的{{编辑昵称}}，您好：', '编辑老师您好：')
    .replaceAll('尊敬的{{编辑昵称}}：', '编辑老师您好：')
    .replaceAll('{{编辑昵称}}，您好呀。', '编辑老师您好。')
    .replaceAll('{{编辑昵称}} 您好：', '编辑老师您好：')
    .replaceAll('{{编辑昵称}} 您好，', '编辑老师您好，')
    .replaceAll('{{编辑昵称}}，', '编辑老师，')
    .replaceAll('{{编辑昵称}}', '编辑老师')
}

export function normalizeDefaultMailTemplates(stored?: MailTemplate[]) {
  const source = stored?.length ? stored : defaultMailTemplates()
  const normalized = source
    .filter((item) => !isDroppedMailTemplate(item))
    .map((item, index) => ({
      ...item,
      id: item.id.trim() || `default-${index + 1}`,
      name: item.name.trim() || `模板 ${index + 1}`,
      subject: upgradeMailSubject(item),
      body: removeDefaultEditorNickname(item.body),
    }))
  return normalized.length ? normalized : defaultMailTemplates()
}

export function hydrateMailTemplates(
  stored: MailTemplate[] | undefined,
  subject: string,
  body: string,
): MailTemplate[] {
  if (stored?.length) {
    const kept = stored
      .filter((item) => !isDroppedMailTemplate(item))
      .map((item) => ({ ...item, subject: upgradeMailSubject(item) }))
    if (kept.length) return kept
  }
  const defaults = defaultMailTemplates()
  if (subject.trim() || body.trim()) {
    defaults[0] = {
      ...defaults[0],
      subject: subject.trim() || defaults[0].subject,
      body: body.trim() || defaults[0].body,
    }
  }
  return defaults
}

export function syncMailFromTemplates(input: ManuscriptInput): ManuscriptInput {
  const mail_templates = hydrateMailTemplates(input.mail_templates, input.subject, input.body)
  const current = mail_templates.find((item) => item.body.trim()) ?? mail_templates[0]
  return {
    ...input,
    mail_templates,
    subject: current?.subject ?? input.subject,
    body: current?.body ?? input.body,
  }
}

export function createEmptyManuscript(templates?: MailTemplate[]): ManuscriptInput {
  const mail_templates = normalizeDefaultMailTemplates(templates)
  return {
    title: '', body: mail_templates[0].body, content_type: 'text/plain', recipients: [], sender_name: '',
    word_count: 0, category: '', reader_emotion: '', style: '',
    genres: [], excluded_types: [], account_ids: [], send_interval_min: DEFAULT_SEND_INTERVAL_MIN,
    subject: mail_templates[0].subject, mail_templates, file_name: '',
  }
}

export function countChars(text: string) {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
}

export function categoryFromWords(count: number) {
  if (count <= 0) return ''
  if (count < 12000) return '短篇'
  if (count < 50000) return '中短篇'
  return ''
}

export function lengthTagsFromWords(count: number) {
  const tag = categoryFromWords(count)
  return tag ? [tag] : []
}

export function categoryLabel(category: string) {
  if (category.includes('中短')) return '中短篇'
  if (category.includes('短篇')) return '短篇'
  return category
}

export function defaultSubject(input: Pick<ManuscriptInput, 'title' | 'word_count' | 'genres'>) {
  const { genres } = splitPlanTags(input.genres)
  return [
    input.title.trim(),
    input.word_count > 0 ? `${input.word_count}字` : '',
    genres.join('、'),
  ].filter(Boolean).join('+')
}

export function defaultBody(input: Pick<ManuscriptInput, 'title' | 'category' | 'genres'>) {
  const title = input.title.trim() || '未命名作品'
  const { lengths, genres } = splitPlanTags(input.genres)
  const length = lengths.join('、') || categoryLabel(input.category)
  return [
    '尊敬的编辑大大：',
    '',
    '辛苦审阅，期待您的意见！',
    `书名：《${title}》`,
    `篇幅：${length || '未选'}`,
    `类型：${genres.join('、') || '未选'}`,
  ].join('\n')
}

export function latestTask(id: number, tasks: Task[]) {
  return tasks.filter((t) => t.manuscript_ids.includes(id)).sort((a, b) => b.id - a.id)[0]
}

/** 本计划已成功投递且仍在收件名单里的人数 / 当前有效收件人数。 */
export function planSendProgress(manuscript: Pick<Manuscript, 'id' | 'recipients'>, deliveries: Delivery[]) {
  const recipients = manuscript.recipients.filter((row) => isValidEmail(row))
  const want = new Set(recipients.map((row) => parseRecipient(row).email.toLowerCase()))
  const sent = new Set<string>()
  for (const item of deliveries) {
    if (item.manuscript_id !== manuscript.id) continue
    const email = parseRecipient(item.recipient).email.toLowerCase()
    if (want.has(email)) sent.add(email)
  }
  return { sent: sent.size, total: want.size }
}

export function toInput(m: Manuscript): ManuscriptInput {
  return {
    title: m.title, body: m.body, content_type: m.content_type, recipients: m.recipients,
    sender_name: m.sender_name, word_count: m.word_count, category: m.category,
    reader_emotion: m.reader_emotion, style: m.style,
    genres: m.genres ?? [], excluded_types: m.excluded_types ?? [], account_ids: m.account_ids ?? [],
    send_interval_min: normalizeSendIntervalMin(m.send_interval_min),
    subject: m.subject, mail_templates: hydrateMailTemplates(m.mail_templates, m.subject, m.body),
    file_name: m.file_name, has_file: m.has_file,
  }
}

export function tidyMailSubject(subject: string) {
  return subject
    .replaceAll('未填', '')
    .replaceAll('未选', '')
    .replace(/（\s*）/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\+{2,}/g, '+')
    .replace(/^\++|\++$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function fillPlaceholders(
  text: string,
  recipient: string,
  title: string,
  extras: { wordCount?: number; genres?: string[]; category?: string; asSubject?: boolean } = {},
) {
  const { name, email } = parseRecipient(recipient || '编辑 <editor@example.com>')
  const { lengths, genres } = splitPlanTags(extras.genres ?? [])
  const length = lengths.join('、') || categoryLabel(extras.category ?? '')
  const words = extras.wordCount && extras.wordCount > 0 ? `${extras.wordCount}字` : extras.asSubject ? '' : '未填'
  const types = genres.join('、')
  const source = types.trim()
    ? text
    : text.replaceAll('偏{{类型}}', '').replaceAll('偏 {{类型}}', '')
  const filled = source
    .replaceAll('{{编辑昵称}}', name)
    .replaceAll('{{收件人}}', name)
    .replaceAll('{{邮箱}}', email)
    .replaceAll('{{作品名}}', title || '未命名作品')
    .replaceAll('{{字数}}', words)
    .replaceAll('{{篇幅}}', length)
    .replaceAll('{{类型}}', types)
  const omitted = extras.asSubject ? filled : omitEmptyTypeLabel(filled, types)
  return extras.asSubject ? tidyMailSubject(omitted) : omitted
}

function omitEmptyTypeLabel(text: string, types: string) {
  if (types.trim()) return text
  return text
    .split('\n')
    .filter((line) => !/^\s*类型[：:]/.test(line))
    .map((line) => line.replace(/[，,、]\s*(?=[。．.])/g, '').replace(/\s*\/\s*(?=[。．.])/g, ''))
    .join('\n')
}

export function sentCountByEmail(deliveries: Delivery[]) {
  const map = new Map<string, number>()
  for (const d of deliveries) {
    const email = parseRecipient(d.recipient).email.toLowerCase()
    map.set(email, (map.get(email) ?? 0) + 1)
  }
  return map
}

export function editorRecipient(editor: Editor) {
  const name = editor.name.trim()
  return name ? `${name} <${editor.email}>` : editor.email
}

export function editorWorkTypeOptions(editors: Editor[]) {
  const map = new Map<string, number>()
  for (const editor of editors) {
    for (const tag of normalizeEditorTags(editor).work_type) {
      map.set(tag, (map.get(tag) ?? 0) + 1)
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
}

export function editorPlatformKey(editor: Pick<Editor, 'platform' | 'email'>) {
  return editor.platform.trim() || `__${editor.email.trim().toLowerCase()}`
}

export function isEditorFavorited(editor: Pick<Editor, 'favorited'>) {
  return Boolean(editor.favorited)
}

export function compareEditorsByFavorite(a: Editor, b: Editor) {
  const fa = isEditorFavorited(a) ? 1 : 0
  const fb = isEditorFavorited(b) ? 1 : 0
  if (fa !== fb) return fb - fa
  const plat = a.platform.localeCompare(b.platform, 'zh')
  if (plat) return plat
  return (a.name || a.email).localeCompare(b.name || b.email, 'zh')
}

export function groupMatchingByPlatform(
  editors: Editor[],
  genres: string[],
  excludedWorkTypes: Iterable<string> = [],
) {
  const excluded = new Set([...excludedWorkTypes].map((t) => t.trim()).filter(Boolean))
  const groups = new Map<string, Editor[]>()
  for (const editor of editors.map(normalizeEditorTags)) {
    if (!editorMatchesPlan(editor, genres, excluded)) continue
    const key = editorPlatformKey(editor)
    const list = groups.get(key) ?? []
    list.push(editor)
    groups.set(key, list)
  }
  for (const list of groups.values()) list.sort(compareEditorsByFavorite)
  return groups
}

export function pickRandomPlatformEditor(list: Editor[], sentMap: Map<string, number> = new Map()) {
  if (!list.length) return undefined
  const unsent = list.filter((editor) => (sentMap.get(editor.email.toLowerCase()) ?? 0) === 0)
  const pool = unsent.length ? unsent : list
  const favored = pool.filter(isEditorFavorited)
  const pickFrom = favored.length ? favored : pool
  return pickFrom[Math.floor(Math.random() * pickFrom.length)]
}

export function pickOneEditorPerPlatform(
  editors: Editor[],
  genres: string[],
  sentMap: Map<string, number>,
  preferred: Record<string, string> = {},
  excludedWorkTypes: Iterable<string> = [],
) {
  const groups = groupMatchingByPlatform(editors, genres, excludedWorkTypes)
  const picked: Editor[] = []
  for (const [key, list] of groups) {
    const prefer = preferred[key]?.toLowerCase()
    const chosen = (prefer && list.find((e) => e.email.toLowerCase() === prefer))
      || pickRandomPlatformEditor(list, sentMap)
    if (chosen) picked.push(chosen)
  }
  return { picked, groups }
}

/** 按当前标签给每个匹配平台勾一位：已选且仍匹配的保留，缺的平台补上。 */
export function mergeEditorSelectionByPlatform(
  editors: Editor[],
  selectedIds: Iterable<number>,
  genres: string[],
  excludedWorkTypes: Iterable<string> = [],
) {
  const selected = new Set(selectedIds)
  const next = new Set<number>()
  for (const list of groupMatchingByPlatform(editors, genres, excludedWorkTypes).values()) {
    const kept = list.find((editor) => selected.has(editor.id))
    next.add((kept ?? list[0]).id)
  }
  return next
}

export function estimateMinutes(count: number, intervalMin: number, intervalMax: number, batchMin: number, batchMax: number, pauseMin: number, pauseMax: number) {
  if (count <= 0) return 0
  const interval = (intervalMin + intervalMax) / 2
  const batch = Math.max(1, (batchMin + batchMax) / 2)
  const batches = Math.ceil(count / batch)
  const pause = Math.max(0, batches - 1) * ((pauseMin + pauseMax) / 2)
  return Math.max(1, Math.round((count * interval + pause) / 60))
}
