import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, onLog } from '../api'
import { useEventSubscription } from '../hooks/useEventSubscription'
import type { EditorBlock } from '../types'
import { useConfirm, useToast } from './feedback'
import { Modal } from './Modal'
import { Button, Select } from './ui'

export function EditorBlockBadge({ senders, onClick }: { senders?: string[]; onClick?: () => void }) {
  if (!senders?.length) return null
  const text = `已拉黑 ${senders.length} 个发件邮箱`
  const title = `被这位编辑拉黑的发件邮箱：\n${senders.join('\n')}`
  return onClick ? <button type="button" className="editor-block-badge" title={title} onClick={onClick}>{text}</button>
    : <span className="editor-block-badge" title={title}>{text}</span>
}

/** Visible on every page; the durable evidence remains in the editor library/logs. */
export function EditorBlockNotifications() {
  const toast = useToast()
  useEventSubscription(onLog, log => {
    if (log.category === 'blacklist' || log.category === 'editor_replacement') toast(log.message, 'warning')
  })
  return null
}

export function EditorBlocksDialog({ recipient, onClose, onChanged }: { recipient: string; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<EditorBlock[]>([])
  const [query, setQuery] = useState(recipient)
  const [sender, setSender] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const toast = useToast()
  const load = useCallback(async () => {
    setLoading(true)
    try { setItems(await api.listEditorBlocks()); setError('') }
    catch (error) { setError(String(error)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEventSubscription(onLog, () => { void load() }, 200, log => ['blacklist', 'editor_replacement'].includes(log.category))
  const senders = useMemo(() => [...new Set(items.map(item => item.sender_email))].sort(), [items])
  const rows = useMemo(() => items.filter(item => (!sender || item.sender_email === sender)
    && [item.sender_email, item.recipient_email, item.editor_name, item.platform].some(value => value.toLowerCase().includes(query.trim().toLowerCase()))), [items, query, sender])
  const clear = async (item: EditorBlock) => {
    if (busy || !await confirm({ title: '标记拉黑已解除？', message: `仅清除「${item.sender_email} → ${item.recipient_email}」在本软件中的标记，不会解除对方邮箱的实际拦截。请在确认对方已解除后操作；再次收到明确拒收时会重新记录。`, confirmLabel: '确认已解除' })) return
    setBusy(true)
    try { await api.clearEditorBlock(item.sender_email, item.recipient_email); await load(); onChanged(); toast('已清除这对邮箱的拉黑标记', 'success') }
    catch (error) { toast(String(error), 'error') }
    finally { setBusy(false) }
  }
  return <Modal title="编辑拉黑记录" width={920} onClose={() => { if (!busy) onClose() }}>
    <p className="hint">按发件邮箱分别记录，仅依据服务器明确的 550 拉黑回复。未列出代表未发现记录，不保证对方没有拦截。清空发送日志不会清除这里的记录。</p>
    <div className="notice">自动投递遇到拉黑时，会保持发件邮箱不变，改投符合稿件类型的同平台编辑；跳过已选、已投递和待确认的收件人。没有可用编辑则跳过并提示，替换不会修改你的原始名单。</div>
    <div className="toolbar editor-block-filters">
      <input aria-label="搜索拉黑记录" placeholder="搜索编辑、平台或邮箱" value={query} onChange={e => setQuery(e.target.value)} />
      <Select ariaLabel="拉黑记录发件邮箱" value={sender} onChange={setSender} options={[{value:'',label:'全部发件邮箱'},...senders.map(value=>({value,label:value}))]} />
      <Button size="sm" disabled={loading} onClick={() => void load()}>刷新</Button>
    </div>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    <div className="editor-block-list" aria-busy={loading}>
      {rows.map(item => <article className="editor-block-entry" key={`${item.sender_email}:${item.recipient_email}`}>
        <div><strong>{item.platform || '未知平台'} · {item.editor_name || '未命名编辑'}</strong><span>编辑邮箱：{item.recipient_email}</span><b>被拉黑的发件邮箱：{item.sender_email}</b><small>首次：{item.first_seen} · 最近：{item.last_seen}</small><details><summary>查看服务器拒收原因</summary><p>{item.reason}</p></details></div>
        <Button size="sm" disabled={busy} onClick={() => void clear(item)}>标记已解除</Button>
      </article>)}
      {!rows.length && <p className="hint">{loading ? '正在读取拉黑记录…' : '没有匹配的拉黑记录'}</p>}
    </div>
    <p className="hint">共 {rows.length} 条拉黑关系</p>
  </Modal>
}
