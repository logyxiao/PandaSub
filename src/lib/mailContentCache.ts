import { api } from '../api'
import type { MailContent, Reply } from '../types'

export type MailIdentity = Pick<Reply, 'id' | 'account_id' | 'imap_generation' | 'imap_uid_validity' | 'imap_uid' | 'message_id'>

// Keep immutable, fully fetched messages warm while bounding large inline images.
const entries = new Map<string, { content: MailContent; size: number; expires: number }>()
type Consumer = { resolve: (content: MailContent) => void; reject: (error: unknown) => void; local?: (content: MailContent) => void }
type Job = { key: string; reply: MailIdentity; version: number; phase: 'local' | 'queued' | 'network'; local?: MailContent; consumers: Set<Consumer> }
const pending = new Map<string, Job>()
const queued: Job[] = []
const MAX_ACTIVE = 2
let active = 0
const cancelled = () => new DOMException('邮件已关闭', 'AbortError')
const MAX_BYTES = 16 * 1024 * 1024
let bytes = 0
let generation = 0
export const mailIdentityKey = (reply: MailIdentity) => [reply.id, reply.account_id, reply.imap_generation, reply.imap_uid_validity, reply.imap_uid, reply.message_id].join(':')
function remove(key: string) { const entry = entries.get(key); if (entry) bytes -= entry.size; entries.delete(key) }
export function cachedMailContent(reply: MailIdentity): MailContent | null {
  const key = mailIdentityKey(reply), entry = entries.get(key)
  if (!entry) return null
  if (entry.expires < Date.now()) { remove(key); return null }
  entries.delete(key); entries.set(key, entry)
  return entry.content
}
function finish(job: Job, content: MailContent) {
  if (job.version === generation && content.complete && !content.warning) {
    const size = 2 * (content.text.length + content.html.length + Object.values(content.inline_images).reduce((total, image) => total + image.length, 0))
    if (size <= MAX_BYTES) {
      remove(job.key)
      entries.set(job.key, { content, size, expires: Date.now() + 10 * 60_000 }); bytes += size
      while (bytes > MAX_BYTES || entries.size > 12) remove(entries.keys().next().value!)
    }
  }
  if (pending.get(job.key) === job) pending.delete(job.key)
  for (const consumer of job.consumers) consumer.resolve(content)
}
function fail(job: Job, error: unknown) {
  if (pending.get(job.key) === job) pending.delete(job.key)
  for (const consumer of job.consumers) consumer.reject(error)
}
function pump() {
  while (active < MAX_ACTIVE && queued.length) {
    const job = queued.pop()!
    job.phase = 'network'
    active++
    void Promise.resolve().then(() => api.getReplyContent(job.reply.id))
      .then(content => finish(job, content)).catch(error => fail(job, error))
      .finally(() => { active--; pump() })
  }
}
async function readLocal(job: Job) {
  if (!job.consumers.size) { fail(job, cancelled()); return }
  try {
    const local = await api.getLocalReplyContent(job.reply.id)
    if (local.complete) { finish(job, local); return }
    job.local = local
    for (const consumer of job.consumers) consumer.local?.(local)
    if (!job.consumers.size) { fail(job, cancelled()); return }
    job.phase = 'queued'
    queued.push(job)
    queueMicrotask(pump)
  } catch (error) { fail(job, error) }
}

/** Coalesce identical requests, limit actual IPC, and discard closed readers from the queue. */
export function loadMailContent(reply: MailIdentity, signal?: AbortSignal, onLocal?: (content: MailContent) => void): Promise<MailContent> {
  if (signal?.aborted) return Promise.reject(cancelled())
  const cached = cachedMailContent(reply)
  if (cached) return Promise.resolve(cached)
  const key = mailIdentityKey(reply)
  let job = pending.get(key)
  if (!job) {
    job = { key, reply, version: generation, phase: 'local', consumers: new Set() }
    pending.set(key, job)
    const created = job
    queueMicrotask(() => { void readLocal(created) })
  } else if (job.phase === 'queued') {
    queued.splice(queued.indexOf(job), 1)
    queued.push(job)
  }
  const current = job
  const request = new Promise<MailContent>((resolve, reject) => {
    const detach = () => { signal?.removeEventListener('abort', abort); current.consumers.delete(consumer) }
    const consumer: Consumer = {
      local: onLocal,
      resolve: value => { detach(); resolve(value) },
      reject: error => { detach(); reject(error) },
    }
    const abort = () => {
      consumer.reject(cancelled())
      if (current.phase === 'queued' && !current.consumers.size) {
        queued.splice(queued.indexOf(current), 1)
        if (pending.get(key) === current) pending.delete(key)
      }
    }
    current.consumers.add(consumer)
    signal?.addEventListener('abort', abort, { once: true })
    if (current.local) onLocal?.(current.local)
  })
  return request
}
export function clearMailContentCache() {
  generation++; entries.clear(); bytes = 0
  for (const job of queued.splice(0)) {
    pending.delete(job.key)
    for (const consumer of job.consumers) consumer.reject(cancelled())
  }
  // Active calls retain their slots and remain coalesced, but cannot refill this cache generation.
}
