import { parseRecipient } from '../format'
import type { Delivery, Editor, Manuscript, ManuscriptInput, Task } from '../types'

export const GENRES = ['古风', '现代', '都市', '校园', '玄幻', '仙侠', '科幻', '悬疑', '恐怖', '民间', '脑洞', '重生', '穿越', '甜宠', '虐恋', '社会', '性转', '女主', '男主']
export const CATEGORIES = ['短篇（8000字以下）', '短篇（8000-12000字）', '中篇（1.2-5万字）', '长篇（5万字以上）', '微小说']
export const READERS = ['女频', '男频', '不限']
export const EMOTIONS = ['纯爽', '甜宠', '虐恋', '治愈', '悬疑', '轻松', '其他']
export const STYLES = ['网文', '文学', '小品', '剧本', '小程序文', '其他']

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
  word_count: 0, category: '', reader_category: '', reader_emotion: '', style: '',
  genres: [], subject: '', file_name: '',
}

export function countChars(text: string) {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
}

export function latestTask(id: number, tasks: Task[]) {
  return tasks.filter((t) => t.manuscript_ids.includes(id)).sort((a, b) => b.id - a.id)[0]
}

export function toInput(m: Manuscript): ManuscriptInput {
  return {
    title: m.title, body: m.body, content_type: m.content_type, recipients: m.recipients,
    sender_name: m.sender_name, word_count: m.word_count, category: m.category,
    reader_category: m.reader_category, reader_emotion: m.reader_emotion, style: m.style,
    genres: m.genres ?? [], subject: m.subject, file_name: m.file_name,
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

export function editorMatchesGenres(editor: Editor, genres: string[]) {
  if (!genres.length || !editor.directions.length) return false
  return editor.directions.some((d) => genres.includes(d))
}

export function estimateMinutes(count: number, intervalMin: number, intervalMax: number, batchMin: number, batchMax: number, pauseMin: number, pauseMax: number) {
  if (count <= 0) return 0
  const interval = (intervalMin + intervalMax) / 2
  const batch = Math.max(1, (batchMin + batchMax) / 2)
  const batches = Math.ceil(count / batch)
  const pause = Math.max(0, batches - 1) * ((pauseMin + pauseMax) / 2)
  return Math.max(1, Math.round((count * interval + pause) / 60))
}
