import { useCallback, useEffect, useState } from 'react'
import { Inbox, RefreshCw } from 'lucide-react'
import { api, onReply } from '../api'
import { useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Select } from '../components/ui'
import { Modal } from '../components/Modal'
import { formatTime, replyKindLabel, replyKindTone } from '../format'
import { useNav } from '../nav'
import type { Reply } from '../types'

export function RepliesView() {
  const [items, setItems] = useState<Reply[]>([])
  const [kind, setKind] = useState('')
  const [notice, setNotice] = useState('')
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<Reply | null>(null)
  const toast = useToast()
  const { go } = useNav()

  const load = useCallback(async () => {
    try {
      setItems(await api.listReplies(kind || undefined))
      setNotice('')
    } catch (e) { setNotice(String(e)) }
  }, [kind])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let un: (() => void) | undefined
    onReply((reply) => {
      if (kind && reply.kind !== kind) return
      setItems((prev) => [reply, ...prev.filter((r) => r.id !== reply.id)].slice(0, 300))
    }).then((u) => { un = u })
    return () => un?.()
  }, [kind])

  const scan = async () => {
    setScanning(true)
    try {
      const n = await api.scanReplies()
      await load()
      toast(n ? `新发现 ${n} 封回复` : '没有新的相关回复', n ? 'success' : 'info')
    } catch (e) { toast(String(e), 'error') }
    finally { setScanning(false) }
  }

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <Select value={kind} onChange={setKind} ariaLabel="按类型筛选" className="filter-select"
            options={[
              { value: '', label: '全部回复' },
              { value: 'human', label: '人工回复' },
              { value: 'auto', label: '自动回复' },
              { value: 'bounce', label: '退信' },
            ]} />
        </div>
        <div className="toolbar-actions">
          <IconButton title="刷新列表" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" disabled={scanning} onClick={() => void scan()}>
            {scanning ? '正在检查…' : '立即检查收件箱'}
          </Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}
      <p className="hint" style={{ marginBottom: 14 }}>
        只统计与已发出投稿对应的回复。判定先看邮件头（如 Auto-Submitted），再看主题和正文。
        请确认发件邮箱已开启 IMAP，授权码与 SMTP 相同。
      </p>

      {!items.length ? (
        <div className="panel">
          <EmptyState icon={Inbox} title="还没有识别到回复"
            desc="发出投稿后，后台会定期检查收件箱，并把回复分成人工、自动或退信。"
            action={<Button variant="ghost" onClick={() => go('accounts')}>去检查邮箱 IMAP 设置</Button>} />
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>类型</th><th>来自</th><th>主题</th><th>对应投递</th><th>判定</th><th>时间</th><th aria-label="操作" /></tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td><Badge tone={replyKindTone[r.kind] ?? 'neutral'} dot>{replyKindLabel[r.kind] ?? r.kind}</Badge></td>
                    <td><b>{r.from_email || '—'}</b></td>
                    <td className="log-msg">{r.subject || '（无主题）'}<small>{r.snippet}</small></td>
                    <td>{r.recipient || '—'}{r.task_name ? <small>{r.task_name}</small> : null}</td>
                    <td><small>{r.reason}</small></td>
                    <td className="mono">{formatTime(r.received_at)}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" onClick={() => setPreview(r)}>查看</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview && (
        <Modal title={preview.subject || '回复正文'} onClose={() => setPreview(null)} width={680}
          footer={<Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button>}>
          <div className="preview-body">
            <p className="hint">
              {replyKindLabel[preview.kind]} · {preview.from_email}
              {preview.recipient ? ` → 原收件人 ${preview.recipient}` : ''}
            </p>
            <p className="hint">{preview.reason}</p>
            <pre>{preview.body || preview.snippet || '（无正文）'}</pre>
          </div>
        </Modal>
      )}
    </>
  )
}
