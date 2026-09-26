import type { AccountInput } from '../types'

// Domains, rather than provider families, determine connection endpoints.
const providers: Record<string, string> = { 'qq.com': 'qq', '163.com': '163', '126.com': '126', 'yeah.net': 'yeah' }
export const detectProvider = (email: string) => providers[email.trim().toLowerCase().split('@')[1] ?? ''] ?? 'other'
export function serverPreset(email: string) {
  const domain = email.trim().toLowerCase().split('@')[1] ?? ''
  return {
    provider: detectProvider(email),
    smtp_host: domain ? `smtp.${domain}` : '', smtp_port: 465,
    imap_host: domain ? `imap.${domain}` : '', imap_port: 993,
  }
}
export function normalizeAccountForm(form: AccountInput): AccountInput {
  return { ...form, email: form.email.trim(), sender_name: form.sender_name.trim(),
    smtp_host: form.smtp_host.trim(), imap_host: form.imap_host.trim(), provider: detectProvider(form.email) }
}
