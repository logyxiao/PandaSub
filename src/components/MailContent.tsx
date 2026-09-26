import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import type { MailAddress, MailAttachment, MailContent as Content, Reply } from '../types'
import { Button } from './ui'
import { useToast } from './feedback'
import { prepareMailHtml } from '../lib/mailHtml'
import { cachedMailContent, loadMailContent, mailIdentityKey } from '../lib/mailContentCache'

const preparedMessages = new WeakMap<Content, ReturnType<typeof prepareMailHtml>>()
function preparedMessage(content: Content) {
  let value = preparedMessages.get(content)
  if (!value) { value = prepareMailHtml(content.html, content.inline_images); preparedMessages.set(content, value) }
  return value
}

const addresses = (values: MailAddress[]) => values.map(v => v.name ? `${v.name} <${v.email}>` : v.email).join('；')
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function MailContent({ reply, account }: { reply: Reply; account: string }) {
  return <MailContentView key={mailIdentityKey(reply)} reply={reply} account={account} />
}
function MailContentView({ reply, account }: { reply: Reply; account: string }) {
  const { id, account_id, imap_generation, imap_uid_validity, imap_uid, message_id } = reply
  const identity = useMemo(() => ({ id, account_id, imap_generation, imap_uid_validity, imap_uid, message_id }), [id, account_id, imap_generation, imap_uid_validity, imap_uid, message_id])
  const [content, setContent] = useState<Content | null>(() => cachedMailContent(identity))
  const [loading, setLoading] = useState(() => !cachedMailContent(identity))
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [plain, setPlain] = useState(false)
  const [saving, setSaving] = useState<number | null>(null)
  const toast = useToast()
  useEffect(() => {
    let active = true
    if (!cachedMailContent(identity)) setLoading(true)
    setError('')
    void Promise.resolve().then(() => active ? loadMailContent(identity) : null).then(value => { if (active && value) { setContent(value); setError(value.warning || '') } })
      .catch(e => { if (active) setError(String(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [identity, attempt])
  const save = async (file: MailAttachment) => {
    setSaving(file.index)
    try {
      const path = await saveDialog({ title: '保存邮件附件', defaultPath: file.name.split(/[\\/]/).pop() || '附件' })
      if (path) { await api.saveReplyAttachment(reply.id, file.index, path); toast('附件已保存', 'success') }
    } catch (e) { toast(String(e), 'error') }
    finally { setSaving(null) }
  }
  const fields = [
    ['发件人', content?.from.length ? addresses(content.from) : reply.from_email],
    ['收件人', content?.to.length ? addresses(content.to) : (content ? '原邮件未提供收件人字段' : account)],
    ['抄送', content?.cc.length ? addresses(content.cc) : ''],
    ['密送', content?.bcc.length ? addresses(content.bcc) : ''],
    ['回复至', content?.reply_to.length ? addresses(content.reply_to) : ''],
    ['发送时间', content?.sent_at ? new Date(content.sent_at).toLocaleString('zh-CN', { hour12: false }) : ''],
    ['接收时间', reply.received_at], ['接收账号', account], ['邮件标识', reply.message_id],
  ]
  return <section className="mail-content" aria-label="邮件详情内容">
    <details className="mail-envelope">
      <summary><span>收件人：{content?.to.length ? addresses(content.to) : account}</span><b>查看邮件详情</b></summary>
      <dl>{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </details>
    {loading && <div className="mail-content-notice" role="status">正在加载完整邮件…</div>}
    {error && <div className="mail-content-notice" role="status"><span>完整内容暂未加载，以下显示已保存的正文。{error}</span><Button size="sm" onClick={() => setAttempt(n => n + 1)}>重试加载</Button></div>}
    <div className="mail-reading-toolbar"><span>{content?.html && !plain ? '原始排版' : '纯文本正文'}</span>{content?.html && <Button size="sm" variant="ghost" onClick={() => setPlain(v => !v)}>{plain ? '查看原始排版' : '查看纯文本'}</Button>}</div>
    {content?.html && !plain
      ? <HtmlBody content={content} />
      : <ReplyText body={content?.text || reply.body || reply.snippet || '（无正文）'} />}
    {!!content?.attachments.length && <section className="mail-attachments" aria-label="邮件附件"><h3>附件 <span>{content.attachments.length}</span></h3><div className="mail-attachment-grid">
      {content.attachments.map(file => <div className="mail-attachment" key={file.index}><FileText size={20} /><div><strong title={file.name}>{file.name}</strong><small>{fileSize(file.size)}{file.content_id ? ' · 内嵌附件' : ''}</small></div><Button size="sm" variant="ghost" disabled={saving !== null} onClick={() => void save(file)}><Download size={14} />{saving === file.index ? '保存中' : '保存'}</Button></div>)}
    </div></section>}
  </section>
}

function HtmlBody({ content }: { content: Content }) {
  const prepared = useMemo(() => preparedMessage(content), [content])
  const frame = useRef<HTMLIFrameElement>(null)
  const toast = useToast()
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== 'mail-body' || event.data?.token !== prepared.token) return
      if (event.data.type === 'height' && typeof event.data.value === 'number' && Number.isFinite(event.data.value)) {
        const height = `${Math.max(120, Math.min(20000, event.data.value))}px`
        if (frame.current!.style.height !== height) frame.current!.style.height = height
      } else if (event.data.type === 'link' && typeof event.data.value === 'string' && /^(https?:\/\/|mailto:)/i.test(event.data.value)) {
        void api.openMailLink(event.data.value).catch(error => toast(String(error), 'error'))
      }
    }
    window.addEventListener('message', receive)
    frame.current?.contentWindow?.postMessage({ token: prepared.token, type: 'measure' }, '*')
    return () => window.removeEventListener('message', receive)
  }, [prepared.token, toast])
  return <>
    <iframe ref={frame} className="mail-html-frame" title="邮件 HTML 正文" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={prepared.document} onLoad={() => frame.current?.contentWindow?.postMessage({ token: prepared.token, type: 'measure' }, '*')} />
  </>
}

export function ReplyText({ body }: { body: string }) {
  const lines = body.split('\n')
  const quoteStart = lines.findIndex((line, index) => index > 0 && (/^\s*>/.test(line) || /^\s*[-—]{2,}.*(原始邮件|Original Message|转发邮件)/i.test(line) || /^On .+wrote:\s*$/i.test(line)))
  if (quoteStart < 0) return <pre className="reply-body-text">{body}</pre>
  return <><pre className="reply-body-text">{lines.slice(0,quoteStart).join('\n')}</pre><details className="reply-quoted"><summary>展开引用的原邮件</summary><pre className="reply-body-text">{lines.slice(quoteStart).join('\n')}</pre></details></>
}
