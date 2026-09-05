import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Inbox, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, onReply } from '../api'
import { Table } from '../components/Table'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Pager, Select } from '../components/ui'
import { Modal } from '../components/Modal'
import { formatTime, parseRecipient, replyKindLabel, replyKindTone } from '../format'
import { useNav } from '../nav'
import type { Editor, Reply, Task } from '../types'
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

function editorLabel(editor?: Editor) {
  if (!editor) return '未匹配编辑'
  return [editor.platform, editor.name].map((value) => value.trim()).filter(Boolean).join(' · ') || editor.email
}

function ReplyFavStar({ editor, onToggle }: {
  editor?: Editor
  onToggle: (editor: Editor) => void
}) {
  if (!editor) return null
  const on = isEditorFavorited(editor)
  return (
    <IconButton
      className={`favorite-toggle ${on ? 'on' : ''}`}
      title={on ? '取消收藏这位编辑' : '收藏这位编辑'}
      onClick={() => onToggle(editor)}>
      <Heart size={13} fill={on ? 'currentColor' : 'none'} />
    </IconButton>
  )
}

export function RepliesView({ initialKind }: { initialKind?: string }) {
  const [items, setItems] = useState<Reply[]>([])
  const [editors, setEditors] = useState<Editor[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [kind, setKind] = useState(initialKind ?? '')
  const [taskFilter, setTaskFilter] = useState<number | ''>('')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query); setPage(1) }, 200)
    return () => window.clearTimeout(timer)
  }, [query])
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<Reply | null>(null)
  const [reclassifying, setReclassifying] = useState(false)
  const requestSeq = useRef(0)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const next = await api.listRepliesPage(kind, taskFilter, search, pageSize, (page - 1) * pageSize)
      if (seq !== requestSeq.current) return
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize))
      if (page > lastPage) { setPage(lastPage); return }
      setItems(next.items); setTotal(next.total); setNotice('')
    } catch (e) { if (seq === requestSeq.current) setNotice(String(e)) }
    finally { if (seq === requestSeq.current) setLoading(false) }
  }, [kind, taskFilter, search, page, pageSize])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    setKind(initialKind ?? ''); setPage(1)
  }, [initialKind])
  useEffect(() => {
    void Promise.all([api.listEditors(), api.listTasks()])
      .then(([nextEditors, nextTasks]) => { setEditors(nextEditors); setTasks(nextTasks) })
      .catch((e) => setNotice(String(e)))
  }, [])

  useEffect(() => {
    let cancelled = false
    const sequence = requestSeq
    let timer: number | undefined
    let un: (() => void) | undefined
    onReply(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { if (!cancelled) void load() }, 200)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; window.clearTimeout(timer); un?.(); sequence.current++ }
  }, [load])

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
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索回复、编辑或邮箱" />
          </label>
          <Select value={taskFilter} onChange={(value) => { setTaskFilter(value); setPage(1) }} ariaLabel="按计划筛选" className="filter-select"
            searchable searchPlaceholder="搜索计划"
            options={[{ value: '' as const, label: '全部计划' }, ...tasks.map((task) => ({ value: task.id, label: task.name }))]} />
          <Select value={kind} onChange={(value) => { setKind(value); setPage(1) }} ariaLabel="按类型筛选" className="filter-select"
            options={[
              { value: '', label: '全部回复' },
              { value: 'human', label: '人工回复' },
              { value: 'auto', label: '自动回复' },
              { value: 'accepted', label: '过稿回复' },
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

      {!loading && !total && !search && !kind && !taskFilter ? (
        <div className="panel">
          <EmptyState icon={Inbox} title="还没有识别到回复"
            desc="发出投稿后，后台会定期检查收件箱，并把回复分成人工、自动或退信。"
            action={<Button variant="ghost" onClick={() => go('accounts')}>去检查邮箱 IMAP 设置</Button>} />
        </div>
      ) : (
        <div className="panel">
          <Table
            rowKey="id"
            dataSource={items}
            resetKey={`${kind}\0${taskFilter}\0${query}`}
            pagination={false}
            empty={loading ? '正在加载回复…' : '没有匹配的回复，换个内容或邮箱关键词试试。'}
            columns={[
              {
                key: 'kind',
                title: '类型',
                width: 92,
                render: (_value, r) => (
                  <Badge tone={r.accepted ? 'success' : (replyKindTone[r.kind] ?? 'neutral')} dot>
                    {r.accepted ? '过稿回复' : (replyKindLabel[r.kind] ?? r.kind)}
                  </Badge>
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
                  const editor = editorForReply(r, editorsByEmail)
                  return (
                    <div className="reply-delivery">
                      <b title={editorLabel(editor)}>{editorLabel(editor)}</b>
                      <small title={email}>{email}</small>
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
          <Pager page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} pageSize={pageSize}
            total={total} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1) }} />
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
