import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Inbox, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, onReply } from '../api'
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

export function RepliesView({ initialKind, initialReply }: { initialKind?: string; initialReply?: Reply }) {
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
  const [selectedId, setSelectedId] = useState<number | null>(initialReply?.id ?? null)
  const [preview, setPreview] = useState<Reply | null>(null)
  useEffect(() => { setSelectedId(initialReply?.id ?? null) }, [initialReply])
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

  const selectedReply = items.find(reply => reply.id === selectedId) ?? (initialReply?.id === selectedId ? initialReply : undefined) ?? items[0]
  const selectedEditor = selectedReply ? editorForReply(selectedReply, editorsByEmail) : undefined
  const previewEditor = preview ? editorForReply(preview, editorsByEmail) : undefined

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <label className="plan-search editor-search">
            <Search size={14} />
            <input value={query} onChange={(e) => { setQuery(e.target.value); setSelectedId(null) }} placeholder="搜索回复、编辑或邮箱" />
          </label>
          <Select value={taskFilter} onChange={(value) => { setTaskFilter(value); setPage(1); setSelectedId(null) }} ariaLabel="按计划筛选" className="filter-select"
            searchable searchPlaceholder="搜索计划"
            options={[{ value: '' as const, label: '全部计划' }, ...tasks.map((task) => ({ value: task.id, label: task.name }))]} />
          <Select value={kind} onChange={(value) => { setKind(value); setPage(1); setSelectedId(null) }} ariaLabel="按类型筛选" className="filter-select"
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
        <div className="panel reply-inbox">
          <div className="reply-split">
            <div className="reply-list" aria-label="回复列表" aria-busy={loading}>
              <div className="reply-list-caption">共 {total} 封回复{loading && <span>正在更新…</span>}</div>
              {items.map(reply => <button type="button" key={reply.id} aria-pressed={reply.id === selectedReply?.id} className={`reply-list-item ${reply.id === selectedReply?.id ? 'on' : ''}`} onClick={() => setSelectedId(reply.id)}>
                <span className="reply-list-meta"><Badge tone={reply.accepted ? 'success' : (replyKindTone[reply.kind] ?? 'neutral')}>{reply.accepted ? '过稿回复' : (replyKindLabel[reply.kind] ?? reply.kind)}</Badge><time>{formatTime(reply.received_at)}</time></span>
                <b>{editorLabel(editorForReply(reply, editorsByEmail)) === '未匹配编辑' ? reply.from_email : editorLabel(editorForReply(reply, editorsByEmail))}</b>
                <span className="reply-list-subject">{reply.subject || '无主题'}</span><p>{replyBodyPreview(reply)}</p><small>{reply.task_name || '未关联计划'}</small>
              </button>)}
              {!items.length && <p className="dashboard-empty">{loading ? '正在加载回复…' : '没有匹配的回复，请调整筛选。'}</p>}
            </div>
            <article className="reply-reader" aria-label="回复阅读区">
              {selectedReply ? <>
                <header><div><Badge tone={selectedReply.accepted ? 'success' : (replyKindTone[selectedReply.kind] ?? 'neutral')}>{selectedReply.accepted ? '过稿回复' : (replyKindLabel[selectedReply.kind] ?? selectedReply.kind)}</Badge><h2>{selectedReply.subject || '无主题'}</h2></div><Button size="sm" onClick={() => setPreview(selectedReply)}>展开阅读</Button></header>
                <div className="reply-reader-meta"><div><b>{editorLabel(selectedEditor)}</b><span>{selectedReply.from_email}</span><span>{formatTime(selectedReply.received_at)} · {replyDelivery(selectedReply).plan}</span><small>对应收稿邮箱：{replyDelivery(selectedReply).email}</small></div><div className="row-actions"><ReplyFavStar editor={selectedEditor} onToggle={editor => void toggleFavorite(editor)}/>{selectedEditor && <IconButton className="danger" title="删除这位编辑" onClick={() => void removeEditor(selectedEditor)}><Trash2 size={15}/></IconButton>}</div></div>
                <ReplyText key={selectedReply.id} body={selectedReply.body || selectedReply.snippet || '（无正文）'}/>
              </> : <div className="reply-reader-empty"><Inbox size={30}/><p>选择一封回复，在这里阅读</p></div>}
            </article>
          </div>
          <Pager page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} pageSize={pageSize}
            total={total} onPage={value => { setPage(value); setSelectedId(null) }} onPageSize={(size) => { setPageSize(size); setPage(1); setSelectedId(null) }} />
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

function ReplyText({ body }: { body: string }) {
  const lines = body.split('\n')
  const quoteStart = lines.findIndex((line, index) => index > 0 && (/^\s*>/.test(line) || /^\s*[-—]{2,}.*(原始邮件|Original Message|转发邮件)/i.test(line) || /^On .+wrote:\s*$/i.test(line)))
  if (quoteStart < 0) return <pre className="reply-body-text">{body}</pre>
  return <><pre className="reply-body-text">{lines.slice(0,quoteStart).join('\n')}</pre><details className="reply-quoted"><summary>展开引用的原邮件</summary><pre className="reply-body-text">{lines.slice(quoteStart).join('\n')}</pre></details></>
}
