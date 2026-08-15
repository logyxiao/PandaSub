import type { TaskStatus } from './types'

export type Tone = 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'neutral'

export const formatTime = (value?: string | null) =>
  value ? new Date(`${value.replace(' ', 'T')}`).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }) : '—'

export const formatClock = (value?: string | null) =>
  value ? new Date(`${value.replace(' ', 'T')}`).toLocaleTimeString('zh-CN', { hour12: false }) : '—'

export const formatDuration = (seconds: number) => {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${seconds} 秒`
}

export const formatDurationRange = (min: number, max: number) =>
  min === max ? formatDuration(min) : `${formatDuration(min)} – ${formatDuration(max)}`

export const toDbTime = (dt: string) => {
  if (!dt) return null
  const withSeconds = dt.length === 16 ? `${dt}:00` : dt
  return withSeconds.replace('T', ' ')
}

export const fromDbTime = (value: string) => value.replace(' ', 'T').slice(0, 16)

export const statusLabel = (s: TaskStatus): string =>
  ({ running: '发送中', paused: '已暂停', stopped: '已停止', completed: '已完成', scheduled: '等待定时' })[s]

export const taskTone: Record<TaskStatus, Tone> = {
  running: 'brand', paused: 'warning', stopped: 'neutral', completed: 'success', scheduled: 'info',
}

export const scheduleLabel: Record<string, string> = {
  immediate: '立即发送', scheduled: '定时发送', loop: '循环发送',
}

export const providerName: Record<string, string> = {
  qq: 'QQ 邮箱', '163': '163 邮箱', other: '其他',
}

export const logCategoryLabel: Record<string, string> = {
  task: '计划',
  send: '发送',
  limit: '限流',
  auth: '认证',
  network: '网络',
  batch: '批次',
  reply: '回复',
}

export const replyKindLabel: Record<string, string> = {
  human: '人工回复',
  auto: '自动回复',
  bounce: '退信',
}

export const replyKindTone: Record<string, Tone> = {
  human: 'success',
  auto: 'neutral',
  bounce: 'danger',
}

export function parseRecipient(raw: string): { name: string; email: string } {
  const text = raw.trim()
  const wrapped = text.match(/^(.*?)<\s*([^>]+)\s*>$/)
  if (wrapped) {
    const email = wrapped[2].trim()
    const name = wrapped[1].trim() || email.split('@')[0] || email
    return { name, email }
  }
  return { name: text.split('@')[0] || text, email: text }
}

export const isValidEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parseRecipient(value).email)
