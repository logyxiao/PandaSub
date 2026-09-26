import { api } from '../api'
import type { MailContent, Reply } from '../types'

export type MailIdentity = Pick<Reply, 'id' | 'account_id' | 'imap_generation' | 'imap_uid_validity' | 'imap_uid' | 'message_id'>

// Keep immutable, fully fetched messages warm while bounding large inline images.
const entries = new Map<string, { content: MailContent; size: number; expires: number }>()
const pending = new Map<string, Promise<MailContent>>()
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
export function loadMailContent(reply: MailIdentity): Promise<MailContent> {
  const cached = cachedMailContent(reply)
  if (cached) return Promise.resolve(cached)
  const key = mailIdentityKey(reply), inflight = pending.get(key)
  if (inflight) return inflight
  const version = generation
  const request = Promise.resolve().then(() => api.getReplyContent(reply.id)).then(content => {
    if (version === generation && content.complete && !content.warning) {
      const size = 2 * (content.text.length + content.html.length + Object.values(content.inline_images).reduce((total, image) => total + image.length, 0))
      if (size <= MAX_BYTES) {
        remove(key)
        entries.set(key, { content, size, expires: Date.now() + 10 * 60_000 }); bytes += size
        while (bytes > MAX_BYTES || entries.size > 12) remove(entries.keys().next().value!)
      }
    }
    return content
  }).finally(() => { if (pending.get(key) === request) pending.delete(key) })
  pending.set(key, request)
  return request
}
export function clearMailContentCache() { generation++; entries.clear(); pending.clear(); bytes = 0 }
