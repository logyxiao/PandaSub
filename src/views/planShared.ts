import { parseRecipient } from '../format'
import type { Delivery, Editor, MailTemplate, Manuscript, ManuscriptInput, Task } from '../types'

export const LENGTH_TAGS = ['短篇', '中短篇'] as const
export const LENGTH_TAG_SET = new Set<string>(LENGTH_TAGS)

export function isLengthTag(tag: string) {
  return LENGTH_TAG_SET.has(tag)
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
  '全品类', '追妻', '追夫', '世情', '爽文', '脑洞', '古言', '现言',
  '悬疑', '年代', '情绪流', '都市', '亲情虐', '大女主', '玄幻', '重生',
  '打脸', '种田', '末世', '甜宠', '宅斗', '宫斗', '萌宝',
  '校园', '仙侠', '穿越', '穿书', '总裁', '婚恋', '虐恋',
  '全员背叛', '言情', '性转', '死人文学', '系统', '女强', '信息差',
  '散文', '童话', '诗歌',
]
export const SOURCES = ['初始数据', '手动数据', '导入数据'] as const
const DROPPED_EDITOR_TAGS = new Set(['小程序', '知乎风', '番茄风', '男频', '女频'])

export function normalizeEditorTags<T extends Pick<Editor, 'work_type'>>(editor: T): T {
  const work_type: string[] = []
  const seen = new Set<string>()
  for (const raw of editor.work_type ?? []) {
    const tag = raw.trim()
    if (!tag || DROPPED_EDITOR_TAGS.has(tag) || seen.has(tag)) continue
    seen.add(tag)
    work_type.push(tag)
  }
  return { ...editor, work_type }
}

// 发送节奏：每封邮件间隔 2–4 分钟随机，偏向 3 分钟（平均按 3 分钟估算）。
export function estimateAutoMinutes(count: number) {
  return Math.max(1, Math.round((count * 3 * 60) / 60))
}

export const SCHEDULE_OPTIONS = [
  { value: 'immediate', label: '立即发送', description: '保存后马上开始投这一份名单' },
  { value: 'scheduled', label: '定时发送', description: '到选定时间再开始' },
  { value: 'loop', label: '循环本计划', description: '这份名单投完后再投一遍，需手动停止。不是等上一个计划结束' },
] as const


export const DEFAULT_MAIL_TEMPLATES: MailTemplate[] = [
  {
    id: 't1',
    name: '常规问候',
    subject: '投稿：《{{作品名}}》',
    body: '尊敬的{{编辑昵称}}：\n\n您好。现将作品《{{作品名}}》投至贵处，恳请审阅。\n\n篇幅：{{篇幅}}\n字数：{{字数}}\n类型：{{类型}}\n\n稿件已附上，辛苦了。',
  },
  {
    id: 't2',
    name: '书名开场',
    subject: '《{{作品名}}》投稿（{{字数}}）',
    body: '{{编辑昵称}} 您好：\n\n附上《{{作品名}}》，{{篇幅}}，{{类型}}。请您抽空看看是否合适。谢谢。',
  },
  {
    id: 't3',
    name: '短讯',
    subject: '《{{作品名}}》投稿',
    body: '{{编辑昵称}} 您好，投稿《{{作品名}}》。若方便，请帮忙看看。谢谢。',
  },
  {
    id: 't4',
    name: '恳请审阅',
    subject: '恳请审阅：《{{作品名}}》',
    body: '尊敬的{{编辑昵称}}，您好：\n\n我是一名作者，现将《{{作品名}}》投来，恳请审阅。如需完整稿件或作者简介，我可再行补充。\n\n此致\n敬礼',
  },
  {
    id: 't5',
    name: '附件说明',
    subject: '投稿附件：《{{作品名}}》',
    body: '{{编辑昵称}} 您好：\n\n作品《{{作品名}}》已作为附件发送，正文不另贴。{{篇幅}} / {{字数}} / {{类型}}。请查收。',
  },
  {
    id: 't6',
    name: '轻松口吻',
    subject: '投稿来了：《{{作品名}}》',
    body: '{{编辑昵称}}，您好呀。\n\n投一篇《{{作品名}}》过来，大概 {{字数}}，偏{{类型}}。不合适直接略过就好，谢谢您。',
  },
  {
    id: 't7',
    name: '类型自报',
    subject: '{{类型}} | 《{{作品名}}》',
    body: '编辑老师好：\n\n这篇是{{篇幅}}{{类型}}，《{{作品名}}》，{{字数}}。想问问贵处是否还收这类稿。附件里是全文。',
  },
  {
    id: 't8',
    name: '期待回复',
    subject: '《{{作品名}}》请您看看',
    body: '尊敬的{{编辑昵称}}：\n\n打扰了。作品《{{作品名}}》已附上，期待您的意见。若暂不合适，也完全理解。\n\n祝工作顺利。',
  },
  {
    id: 't9',
    name: '初次投稿',
    subject: '初次投稿：《{{作品名}}》',
    body: '{{编辑昵称}} 您好：\n\n第一次向贵处投稿，作品《{{作品名}}》，{{篇幅}}，{{字数}}。请多包涵，也请您审阅。谢谢。',
  },
  {
    id: 't10',
    name: '完整稿件',
    subject: '完整稿：《{{作品名}}》',
    body: '{{编辑昵称}} 您好：\n\n《{{作品名}}》全文已附，请查收。类型是{{类型}}，篇幅{{篇幅}}。给您添麻烦了。',
  },
]

export function defaultMailTemplates(): MailTemplate[] {
  return DEFAULT_MAIL_TEMPLATES.map((item) => ({ ...item }))
}

export function hydrateMailTemplates(
  stored: MailTemplate[] | undefined,
  subject: string,
  body: string,
): MailTemplate[] {
  if (stored?.length) return stored.map((item) => ({ ...item }))
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

export function createEmptyManuscript(): ManuscriptInput {
  const mail_templates = defaultMailTemplates()
  return {
    title: '', body: mail_templates[0].body, content_type: 'text/plain', recipients: [], sender_name: '',
    word_count: 0, category: '', reader_emotion: '', style: '',
    genres: [], excluded_types: [], account_ids: [],
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

export function toInput(m: Manuscript): ManuscriptInput {
  return {
    title: m.title, body: m.body, content_type: m.content_type, recipients: m.recipients,
    sender_name: m.sender_name, word_count: m.word_count, category: m.category,
    reader_emotion: m.reader_emotion, style: m.style,
    genres: m.genres ?? [], excluded_types: m.excluded_types ?? [], account_ids: m.account_ids ?? [],
    subject: m.subject, mail_templates: hydrateMailTemplates(m.mail_templates, m.subject, m.body),
    file_name: m.file_name, has_file: m.has_file,
  }
}

export function fillPlaceholders(
  text: string,
  recipient: string,
  title: string,
  extras: { wordCount?: number; genres?: string[]; category?: string } = {},
) {
  const { name, email } = parseRecipient(recipient || '编辑 <editor@example.com>')
  const { lengths, genres } = splitPlanTags(extras.genres ?? [])
  const length = lengths.join('、') || categoryLabel(extras.category ?? '')
  const words = extras.wordCount && extras.wordCount > 0 ? `${extras.wordCount}字` : '未填'
  return text
    .replaceAll('{{编辑昵称}}', name)
    .replaceAll('{{收件人}}', name)
    .replaceAll('{{邮箱}}', email)
    .replaceAll('{{作品名}}', title || '未命名作品')
    .replaceAll('{{字数}}', words)
    .replaceAll('{{篇幅}}', length || '未选')
    .replaceAll('{{类型}}', genres.join('、') || '未选')
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

export function editorMatchesPlan(
  editor: Editor,
  selected: string[],
  excluded: Iterable<string> = [],
) {
  const tags = normalizeEditorTags(editor).work_type
  const banned = new Set([...excluded].map((tag) => tag.trim()).filter(Boolean))
  if (tags.some((tag) => banned.has(tag))) return false
  const { lengths, genres } = splitPlanTags(selected)
  if (lengths.length && !lengths.some((tag) => tags.includes(tag))) return false
  if (genres.length && !genres.some((tag) => tags.includes(tag)) && !tags.includes('全品类')) return false
  return true
}

export function editorPlatformKey(editor: Pick<Editor, 'platform' | 'email'>) {
  return editor.platform.trim() || `__${editor.email.trim().toLowerCase()}`
}

export function pickOneEditorPerPlatform(
  editors: Editor[],
  genres: string[],
  sentMap: Map<string, number>,
  preferred: Record<string, string> = {},
  excludedWorkTypes: Iterable<string> = [],
) {
  const excluded = new Set([...excludedWorkTypes].map((t) => t.trim()).filter(Boolean))
  const matched = editors
    .map(normalizeEditorTags)
    .filter((e) => editorMatchesPlan(e, genres, excluded))
  const groups = new Map<string, Editor[]>()
  for (const editor of matched) {
    const key = editorPlatformKey(editor)
    const list = groups.get(key) ?? []
    list.push(editor)
    groups.set(key, list)
  }
  const picked: Editor[] = []
  for (const [key, list] of groups) {
    const prefer = preferred[key]?.toLowerCase()
    const chosen = list.find((e) => e.email.toLowerCase() === prefer) ?? list.slice().sort((a, b) => {
      const sentA = sentMap.get(a.email.toLowerCase()) ?? 0
      const sentB = sentMap.get(b.email.toLowerCase()) ?? 0
      if ((sentA === 0) !== (sentB === 0)) return sentA === 0 ? -1 : 1
      const overlapA = matchCount(a, genres)
      const overlapB = matchCount(b, genres)
      if (overlapA !== overlapB) return overlapB - overlapA
      return b.id - a.id
    })[0]
    if (chosen) picked.push(chosen)
  }
  return { picked, groups }
}

function matchCount(editor: Editor, genres: string[]) {
  const tags = normalizeEditorTags(editor)
  return genres.filter((g) => tags.work_type.includes(g)).length
}

export function estimateMinutes(count: number, intervalMin: number, intervalMax: number, batchMin: number, batchMax: number, pauseMin: number, pauseMax: number) {
  if (count <= 0) return 0
  const interval = (intervalMin + intervalMax) / 2
  const batch = Math.max(1, (batchMin + batchMax) / 2)
  const batches = Math.ceil(count / batch)
  const pause = Math.max(0, batches - 1) * ((pauseMin + pauseMax) / 2)
  return Math.max(1, Math.round((count * interval + pause) / 60))
}
