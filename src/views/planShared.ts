import { parseRecipient } from '../format'
import type { Delivery, Editor, Manuscript, ManuscriptInput, Task } from '../types'

export const GENRES = ['女频', '古风', '现代', '都市', '校园', '玄幻', '仙侠', '科幻', '悬疑', '恐怖', '民间', '脑洞', '重生', '穿越', '甜宠', '虐恋', '社会', '性转', '女主', '男主']
export const CATEGORIES = ['短篇（8000字以下）', '短篇（8000-12000字）', '中篇（1.2-5万字）', '长篇（5万字以上）', '微小说']
export const STYLES = ['小程序', '知乎风', '番茄风'] as const
export type PlanStyle = (typeof STYLES)[number]

export function isPlanStyle(value: string): value is PlanStyle {
  return (STYLES as readonly string[]).includes(value)
}

export function normalizeEditorTags<T extends Pick<Editor, 'style' | 'work_type'>>(editor: T): T {
  const style: string[] = []
  const work_type: string[] = []
  const seenStyle = new Set<string>()
  const seenType = new Set<string>()
  for (const raw of [...(editor.style ?? []), ...(editor.work_type ?? [])]) {
    const tag = raw.trim()
    if (!tag) continue
    if (isPlanStyle(tag)) {
      if (!seenStyle.has(tag)) { seenStyle.add(tag); style.push(tag) }
    } else if (!seenType.has(tag)) {
      seenType.add(tag)
      work_type.push(tag)
    }
  }
  return { ...editor, style, work_type }
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


export const TEMPLATES = [
  {
    id: 'formal',
    name: '常规投稿',
    subject: '投稿：《{{作品名}}》',
    body: '尊敬的{{编辑昵称}}，您好：\n\n我是一名作者，现将作品《{{作品名}}》投至贵刊 / 贵站，恳请审阅。\n\n正文如下，如需完整稿件或作者简介，我可再行补充。\n\n此致\n敬礼',
  },
  {
    id: 'short',
    name: '短讯投稿',
    subject: '《{{作品名}}》投稿',
    body: '{{编辑昵称}} 您好，投稿《{{作品名}}》。若方便，请帮忙看看是否合适。谢谢。',
  },
  {
    id: 'follow',
    name: '补档说明',
    subject: '补寄：《{{作品名}}》',
    body: '{{编辑昵称}} 您好：\n\n此前曾投《{{作品名}}》，现补上完整正文，请查收。给您添麻烦了。',
  },
]

export const emptyManuscript: ManuscriptInput = {
  title: '', body: '', content_type: 'text/plain', recipients: [], sender_name: '',
  word_count: 0, category: '', reader_emotion: '', style: '',
  genres: [], excluded_types: [], subject: '', file_name: '',
}

export function countChars(text: string) {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
}

export function categoryFromWords(count: number) {
  if (count <= 0) return ''
  if (count < 1500) return '微小说'
  if (count < 8000) return '短篇（8000字以下）'
  if (count <= 12000) return '短篇（8000-12000字）'
  if (count < 50000) return '中篇（1.2-5万字）'
  return '长篇（5万字以上）'
}

export function categoryLabel(category: string) {
  if (category.startsWith('短篇')) return '短篇'
  if (category.startsWith('中篇')) return '中篇'
  if (category.startsWith('长篇')) return '长篇'
  return category
}

export function defaultSubject(input: Pick<ManuscriptInput, 'title' | 'word_count' | 'genres'>) {
  return [
    input.title.trim(),
    input.word_count > 0 ? `${input.word_count}字` : '',
    input.genres.join('、'),
  ].filter(Boolean).join('+')
}

export function defaultBody(input: Pick<ManuscriptInput, 'title' | 'category' | 'genres'>) {
  const title = input.title.trim() || '未命名作品'
  return [
    '尊敬的编辑大大：',
    '',
    '辛苦审阅，期待您的意见！',
    `书名：《${title}》`,
    `分类：${categoryLabel(input.category) || '未选'}`,
    `类型：${input.genres.join('、') || '未选'}`,
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
    genres: m.genres ?? [], excluded_types: m.excluded_types ?? [], subject: m.subject,
    file_name: m.file_name, has_file: m.has_file,
  }
}

export function fillPlaceholders(text: string, recipient: string, title: string) {
  const { name, email } = parseRecipient(recipient || '编辑 <editor@example.com>')
  return text
    .replaceAll('{{编辑昵称}}', name)
    .replaceAll('{{收件人}}', name)
    .replaceAll('{{邮箱}}', email)
    .replaceAll('{{作品名}}', title || '未命名作品')
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

export function editorMatchesPlan(editor: Editor, style: string, genres: string[]) {
  const tags = normalizeEditorTags(editor)
  if (style && tags.style.includes(style)) return true
  if (genres.some((g) => tags.work_type.includes(g))) return true
  return false
}

export function editorPlatformKey(editor: Pick<Editor, 'platform' | 'email'>) {
  return editor.platform.trim() || `__${editor.email.trim().toLowerCase()}`
}

export function pickOneEditorPerPlatform(
  editors: Editor[],
  style: string,
  genres: string[],
  sentMap: Map<string, number>,
  preferred: Record<string, string> = {},
  excludedWorkTypes: Iterable<string> = [],
) {
  const excluded = new Set([...excludedWorkTypes].map((t) => t.trim()).filter(Boolean))
  const matched = editors
    .map(normalizeEditorTags)
    .filter((e) => editorMatchesPlan(e, style, genres))
    .filter((e) => !e.work_type.some((tag) => excluded.has(tag)))
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
      const overlapA = matchCount(a, style, genres)
      const overlapB = matchCount(b, style, genres)
      if (overlapA !== overlapB) return overlapB - overlapA
      return b.id - a.id
    })[0]
    if (chosen) picked.push(chosen)
  }
  return { picked, groups }
}

function matchCount(editor: Editor, style: string, genres: string[]) {
  const tags = normalizeEditorTags(editor)
  let count = 0
  if (style && tags.style.includes(style)) count += 1
  count += genres.filter((g) => tags.work_type.includes(g)).length
  return count
}

export function estimateMinutes(count: number, intervalMin: number, intervalMax: number, batchMin: number, batchMax: number, pauseMin: number, pauseMax: number) {
  if (count <= 0) return 0
  const interval = (intervalMin + intervalMax) / 2
  const batch = Math.max(1, (batchMin + batchMax) / 2)
  const batches = Math.ceil(count / batch)
  const pause = Math.max(0, batches - 1) * ((pauseMin + pauseMax) / 2)
  return Math.max(1, Math.round((count * interval + pause) / 60))
}
