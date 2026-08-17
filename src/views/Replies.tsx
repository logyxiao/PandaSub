import { useCallback, useEffect, useMemo, useState } from 'react'
import { Inbox, RefreshCw, Search, Star, Trash2 } from 'lucide-react'
import { api, onReply } from '../api'
import { Table } from '../components/Table'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Select } from '../components/ui'
import { Modal } from '../components/Modal'
import { formatTime, parseRecipient, replyKindLabel, replyKindTone } from '../format'
import { useNav } from '../nav'
import type { Editor, Reply } from '../types'
import { isEditorFavorited } from './planShared'

function replyBodyPreview(reply: Reply) {
  return (reply.body || reply.snippet || '').replace(/\s+/g, ' ').trim() || '（无正文）'
}

function replyDelivery(reply: Reply) {
  return {
    email: parseRecipient(reply.recipient).email || reply.recipient.trim() || '—',
    plan: reply.task_name.trim() || '未关联计划',
  }
}

function replyEditorEmails(reply: Reply) {
  return [...new Set([
    parseRecipient(reply.recipient).email,
    parseRecipient(reply.from_email).email,
    reply.from_email,
  ].map((value) => value.trim().toLowerCase()).filter(Boolean))]
}

function editorForReply(reply: Reply, byEmail: Map<string, Editor>) {
  for (const email of replyEditorEmails(reply)) {
    const editor = byEmail.get(email)
    if (editor) return editor
  }
}

function ReplyFavStar({ editor, onToggle }: {
  editor?: Editor
  onToggle: (editor: Editor) => void
}) {
  if (!editor) return null
  const on = isEditorFavorited(editor)
  return (
    <IconButton
      className={on ? 'is-fav' : ''}
      title={on ? '取消收藏这位编辑' : '收藏这位编辑'}
      onClick={() => onToggle(editor)}>
      <Star size={15} fill={on ? 'currentColor' : 'none'} />
    </IconButton>
  )
}

export function RepliesView() {
  const [items, setItems] = useState<Reply[]>([])
  const [editors, setEditors] = useState<Editor[]>([])
  const [kind, setKind] = useState('')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<Reply | null>(null)
  const [reclassifying, setReclassifying] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = useCallback(async () => {
    try {
      setItems(await api.listReplies(kind || undefined))
      setNotice('')
    } catch (e) { setNotice(String(e)) }
  }, [kind])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void api.listEditors().then(setEditors).catch((e) => setNotice(String(e)))
  }, [])

  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    onReply((reply) => {
      if (cancelled) return
      if (kind && reply.kind !== kind) return
      setItems((prev) => [reply, ...prev.filter((r) => r.id !== reply.id)].slice(0, 300))
    }).then((u) => {
      if (cancelled) u()
      else un = u
    })
    return () => {
      cancelled = true
      un?.()
    }
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

  const reclassify = async () => {
    setReclassifying(true)
    try {
      const n = await api.reclassifyReplies()
      await load()
      toast(n ? `已按当前规则重新判定 ${n} 封回复` : '所有回复都符合当前规则', n ? 'success' : 'info')
    } catch (e) { toast(String(e), 'error') }
    finally { setReclassifying(false) }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((r) => {
      const { email, plan } = replyDelivery(r)
      return replyBodyPreview(r).toLowerCase().includes(q)
        || email.toLowerCase().includes(q)
        || plan.toLowerCase().includes(q)
        || (r.subject ?? '').toLowerCase().includes(q)
        || (r.from_email ?? '').toLowerCase().includes(q)
    })
  }, [items, query])

  const editorsByEmail = useMemo(() => {
    const map = new Map<string, Editor>()
    for (const editor of editors) {
      const email = editor.email.trim().toLowerCase()
      if (email) map.set(email, editor)
    }
    return map
  }, [editors])

  const toggleFavorite = async (editor: Editor) => {
    try {
      const saved = await api.toggleEditorFavorite(editor.id)
      setEditors((list) => list.map((item) => (item.id === editor.id ? { ...item, favorited: saved } : item)))
    } catch (e) { toast(String(e), 'error') }
  }

  const removeEditor = async (editor: Editor) => {
    const label = editor.name.trim() || editor.email
    const ok = await confirm({
      title: '删除编辑',
      message: `将「${label}」从编辑库去掉。已经写进计划的收件人不会自动删除。`,
      confirmLabel: '删除',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteEditor(editor.id)
      setEditors((list) => list.filter((item) => item.id !== editor.id))
      toast('编辑已删除', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const previewEditor = preview ? editorForReply(preview, editorsByEmail) : undefined

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <label className="plan-search editor-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索回复内容或邮箱" />
          </label>
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
          <Button variant="ghost" disabled={reclassifying} onClick={() => void reclassify()}>
            {reclassifying ? '正在重判…' : '按当前规则重新判定'}
          </Button>
          <Button variant="primary" disabled={scanning} onClick={() => void scan()}>
            {scanning ? '正在检查…' : '立即检查收件箱'}
          </Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}
      <p className="hint" style={{ marginBottom: 14 }}>
        主题包含「自动回复 / 自動回覆 / AutoReply」判为自动回复，其余按人工回复；退信按投递失败标记识别。
      </p>

      {!items.length ? (
        <div className="panel">
          <EmptyState icon={Inbox} title="还没有识别到回复"
            desc="发出投稿后，后台会定期检查收件箱，并把回复分成人工、自动或退信。"
            action={<Button variant="ghost" onClick={() => go('accounts')}>去检查邮箱 IMAP 设置</Button>} />
        </div>
      ) : (
        <div className="panel">
          <Table
            rowKey="id"
            dataSource={visible}
            resetKey={`${kind}\0${query}`}
            pagination={{ pageSize: 10 }}
            empty="没有匹配的回复，换个内容或邮箱关键词试试。"
            columns={[
              {
                key: 'kind',
                title: '类型',
                width: 92,
                render: (_value, r) => (
                  <Badge tone={replyKindTone[r.kind] ?? 'neutral'} dot>{replyKindLabel[r.kind] ?? r.kind}</Badge>
                ),
              },
              {
                key: 'accepted',
                title: '过稿',
                width: 52,
                align: 'center',
                render: (_value, r) => (
                  r.kind === 'human' && r.accepted ? <span className="reply-accepted-mark">过稿</span> : null
                ),
              },
              {
                key: 'body',
                title: '回复内容',
                ellipsis: { rows: 4 },
                render: (_value, r) => replyBodyPreview(r),
              },
              {
                key: 'delivery',
                title: '对应投递',
                width: 220,
                render: (_value, r) => {
                  const { email, plan } = replyDelivery(r)
                  return (
                    <div className="reply-delivery">
                      <b title={email}>{email}</b>
                      <small title={plan}>{plan}</small>
                    </div>
                  )
                },
              },
              {
                key: 'time',
                title: '时间',
                width: 120,
                className: 'mono',
                render: (_value, r) => formatTime(r.received_at),
              },
              {
                key: 'actions',
                title: '',
                width: 148,
                render: (_value, r) => {
                  const editor = editorForReply(r, editorsByEmail)
                  return (
                    <div className="row-actions">
                      <ReplyFavStar editor={editor} onToggle={(item) => void toggleFavorite(item)} />
                      {editor && (
                        <IconButton className="danger" title="删除这位编辑"
                          onClick={() => void removeEditor(editor)}>
                          <Trash2 size={15} />
                        </IconButton>
                      )}
                      <Button size="sm" onClick={() => setPreview(r)}>查看</Button>
                    </div>
                  )
                },
              },
            ]}
          />
        </div>
      )}

      {preview && (
        <Modal title={preview.subject || '回复正文'} onClose={() => setPreview(null)} width={680}
          footer={
            <>
              {previewEditor && (
                <div className="reply-preview-editor-actions">
                  <ReplyFavStar editor={previewEditor} onToggle={(item) => void toggleFavorite(item)} />
                  <IconButton className="danger" title="删除这位编辑"
                    onClick={() => void removeEditor(previewEditor)}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              )}
              <Button variant="ghost" onClick={() => setPreview(null)}>关闭</Button>
            </>
          }>
          <div className="preview-body">
            <p className="hint">
              {replyKindLabel[preview.kind]} · {preview.from_email}
              {preview.accepted ? ' · 过稿' : ''}
              {preview.recipient ? ` → 原收件人 ${preview.recipient}` : ''}
            </p>
            <pre>{preview.body || preview.snippet || '（无正文）'}</pre>
          </div>
        </Modal>
      )}
    </>
  )
}
