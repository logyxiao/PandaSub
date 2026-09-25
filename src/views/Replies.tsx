import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Inbox, Mail, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, onReply } from '../api'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Pager, Select } from '../components/ui'
import { Modal } from '../components/Modal'
import { formatTime, parseRecipient, replyKindLabel, replyKindTone } from '../format'
import { useNav } from '../nav'
import type { Account, Editor, Reply, Task, Settings } from '../types'
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

export function RepliesView({ initialKind, initialReply, accountFilter, onAccountChange }: {
  initialKind?: string
  initialReply?: Reply
  accountFilter: number | ''
  onAccountChange: (accountId: number | '') => void
}) {
  const [items, setItems] = useState<Reply[]>([])
  const [editors, setEditors] = useState<Editor[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [ruleDraft, setRuleDraft] = useState('')
  const [ruleSaving, setRuleSaving] = useState(false)
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
  const [readNotice, setReadNotice] = useState('')
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<Reply | null>(null)
  const [pendingReads, setPendingReads] = useState<Set<number>>(new Set())
  const readOverrides = useRef(new Map<number, boolean>())
  const readWrites = useRef(new Map<number, Promise<void>>())
  const [loadedAccount, setLoadedAccount] = useState(accountFilter)
  const [reclassifying, setReclassifying] = useState(false)
  const requestSeq = useRef(0)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  useEffect(() => {
    if (loadedAccount === accountFilter) return
    requestSeq.current++
    setLoadedAccount(accountFilter)
    setPage(1)
    setItems([])
    setTotal(0)
    setPreview(null)
    setLoading(true)
  }, [accountFilter, loadedAccount])

  const load = useCallback(async () => {
    if (loadedAccount !== accountFilter) return
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const next = await api.listRepliesPage(kind, taskFilter, search, pageSize, (page - 1) * pageSize, accountFilter)
      if (seq !== requestSeq.current) return
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize))
      if (page > lastPage) { setPage(lastPage); return }
      setItems(next.items.map((reply) => readOverrides.current.has(reply.id)
        ? { ...reply, is_read: readOverrides.current.get(reply.id)!, read_synced: true } : reply)); setTotal(next.total); setNotice('')
      setReadNotice('')
      if (next.items.length) {
        void api.syncReplyReadFlags(next.items.map((reply) => reply.id)).then((states) => {
          if (seq !== requestSeq.current) return
          const byId = new Map(states.map((state) => [state.id, state]))
          setItems((current) => current.map((reply) => {
            const state = byId.get(reply.id)
            return state && !readOverrides.current.has(reply.id) ? { ...reply, ...state } : reply
          }))
        }).catch((error) => {
          if (seq === requestSeq.current) setReadNotice(`已读状态暂未同步：${String(error)}`)
        })
      }
    } catch (e) { if (seq === requestSeq.current) setNotice(String(e)) }
    finally { if (seq === requestSeq.current) setLoading(false) }
  }, [kind, taskFilter, search, page, pageSize, accountFilter, loadedAccount])
  const latestLoad = useRef(load)
  useEffect(() => { latestLoad.current = load; void load() }, [load])
  useEffect(() => {
    setKind(initialKind ?? ''); setPage(1)
  }, [initialKind])
  useEffect(() => {
    void Promise.all([api.listEditors(), api.listTasks(), api.listAccounts(), api.getSettings()])
      .then(([nextEditors, nextTasks, nextAccounts, nextSettings]) => { setEditors(nextEditors); setTasks(nextTasks); setAccounts(nextAccounts); setSettings(nextSettings) })
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
      await latestLoad.current()
      toast(n ? `新发现 ${n} 封回复` : '没有新的相关回复', n ? 'success' : 'info')
    } catch (e) { toast(String(e), 'error') }
    finally { setScanning(false) }
  }

  const reclassify = async () => {
    setReclassifying(true)
    try {
      const n = await api.reclassifyReplies()
      await latestLoad.current()
      toast(n ? `已按当前规则重新判定 ${n} 封回复` : '所有回复都符合当前规则', n ? 'success' : 'info')
    } catch (e) { toast(String(e), 'error') }
    finally { setReclassifying(false) }
  }

  const openRules = () => {
    if (!settings) return
    setRuleDraft(settings.auto_reply_subject_keywords.join('\n'))
    setRuleOpen(true)
  }
  const saveRules = async () => {
    if (!settings || ruleSaving) return
    const seen = new Set<string>()
    const keywords = ruleDraft.split(/\r?\n/).map((value) => value.trim()).filter((value) => {
      const key = value.toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (keywords.length > 30 || keywords.some((value) => Array.from(value).length > 80)) {
      toast('最多 30 个关键词，每个最多 80 字', 'error')
      return
    }
    setRuleSaving(true)
    try {
      const next = { ...settings, auto_reply_subject_keywords: keywords }
      await api.updateSettings(next)
      setSettings(next)
      setRuleOpen(false)
      toast('自动回复识别关键词已保存', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setRuleSaving(false) }
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

  const setReadState = useCallback(async (reply: Reply, isRead: boolean) => {
    setPendingReads((current) => new Set(current).add(reply.id))
    readOverrides.current.set(reply.id, isRead)
    setItems((current) => current.map((item) => item.id === reply.id ? { ...item, is_read: isRead, read_synced: true } : item))
    setPreview((current) => current?.id === reply.id ? { ...current, is_read: isRead, read_synced: true } : current)
    const previous = readWrites.current.get(reply.id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(() => api.setReplyRead(reply.id, isRead))
    readWrites.current.set(reply.id, write)
    try {
      await write
      if (readWrites.current.get(reply.id) === write && readOverrides.current.get(reply.id) === isRead) {
        readOverrides.current.delete(reply.id)
      }
    } catch (e) {
      if (readOverrides.current.get(reply.id) !== isRead) return
      readOverrides.current.delete(reply.id)
      setItems((current) => current.map((item) => item.id === reply.id ? { ...item, is_read: reply.is_read, read_synced: reply.read_synced } : item))
      setPreview((current) => current?.id === reply.id ? { ...current, is_read: reply.is_read, read_synced: reply.read_synced } : current)
      toast(String(e), 'error')
    } finally {
      if (readWrites.current.get(reply.id) === write) {
        readWrites.current.delete(reply.id)
        setPendingReads((current) => {
          const next = new Set(current)
          next.delete(reply.id)
          return next
        })
      }
    }
  }, [toast])
  const openPreview = (reply: Reply) => {
    setPreview(reply)
    void setReadState(reply, true)
  }
  useEffect(() => {
    if (!initialReply) return
    setPreview(initialReply)
    void setReadState(initialReply, true)
  }, [initialReply, setReadState]) // dashboard deep link opens the same preview

  const accountsById = useMemo(() => new Map(accounts.map(account => [account.id, account.email])), [accounts])
  const receivingAccount = (reply: Reply) => reply.account_id === null
    ? '未关联账号'
    : accountsById.get(reply.account_id) ?? '已删除账号'
  const previewEditor = preview ? editorForReply(preview, editorsByEmail) : undefined

  return (
    <>
      <div className="toolbar inbox-toolbar">
        <div className="filters">
          <Select value={accountFilter} onChange={onAccountChange} ariaLabel="按账号筛选" className="filter-select inbox-account-select"
            searchable searchPlaceholder="搜索邮箱账号"
            options={[{ value: '' as const, label: '全部账号' }, ...accounts.map(account => ({ value: account.id, label: account.email }))]} />
          <label className="plan-search editor-search">
            <Search size={14} />
            <input value={query} onChange={(e) => { setQuery(e.target.value) }} placeholder="搜索邮件、编辑或邮箱" />
          </label>
          <Select value={taskFilter} onChange={(value) => { setTaskFilter(value); setPage(1) }} ariaLabel="按计划筛选" className="filter-select"
            searchable searchPlaceholder="搜索计划"
            options={[{ value: '' as const, label: '全部计划' }, ...tasks.map((task) => ({ value: task.id, label: task.name }))]} />
          <Select value={kind} onChange={(value) => { setKind(value); setPage(1) }} ariaLabel="按类型筛选" className="filter-select"
            options={[
              { value: '', label: '全部类型' },
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
      <div className="inbox-rule-bar">
        <strong>自动回复识别</strong>
        <span>主题包含</span>
        {settings?.auto_reply_subject_keywords.length
          ? <span className="inbox-rule-keywords">{settings.auto_reply_subject_keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</span>
          : <span className="inbox-rule-empty">{settings ? '未设置关键词' : '正在读取规则…'}</span>}
        <Button size="sm" onClick={openRules} disabled={!settings}>编辑关键词</Button>
        <span className="inbox-rule-explain">退信单独识别</span>
      </div>

      {!loading && !total && !search && !kind && !taskFilter && !accountFilter ? (
        <div className="panel">
          <EmptyState icon={Inbox} title="收件箱暂无邮件"
            desc="发出投稿后，后台会定期检查收件箱，并把回复分成人工、自动或退信。"
            action={<Button variant="ghost" onClick={() => go('accounts')}>去检查邮箱 IMAP 设置</Button>} />
        </div>
      ) : (
        <div className="panel reply-inbox">
          <div className="reply-list" aria-label="邮件列表" aria-busy={loading}>
            <div className="reply-list-caption"><span>共 {total} 封邮件</span>{loading && <span>正在更新…</span>}{!loading && items.some((reply) => !reply.read_synced) && <span>{items.filter((reply) => !reply.read_synced).length} 封状态待同步</span>}{readNotice && <span title={readNotice}>邮箱连接异常</span>}</div>
            {items.map((reply) => {
              const editor = editorForReply(reply, editorsByEmail)
              const sender = editor ? editorLabel(editor) : reply.from_email
              const pending = pendingReads.has(reply.id)
              return <button type="button" key={reply.id} className={`reply-list-item ${pending || !reply.read_synced ? 'is-unverified' : reply.is_read ? 'is-read' : 'is-unread'}`}
                aria-label={`${pending ? '正在同步已读状态' : !reply.read_synced ? '已读状态未同步' : reply.is_read ? '已读' : '未读'}邮件 ${sender} ${reply.subject || '无主题'}`}
                onClick={() => openPreview(reply)}>
                <span className="reply-unread-dot" aria-hidden="true" />
                <span className="reply-list-main">
                  <span className="reply-list-top"><b>{sender}</b><span className="reply-list-subject">{reply.subject || '无主题'}</span></span>
                  <span className="reply-list-excerpt">{replyBodyPreview(reply)}</span>
                </span>
                <span className="reply-list-side">
                  <time>{formatTime(reply.received_at)}</time>
                  <span className="reply-list-account" title={`接收账号：${receivingAccount(reply)}`}>{receivingAccount(reply)}</span>
                  <Badge tone={reply.accepted ? 'success' : (replyKindTone[reply.kind] ?? 'neutral')}>
                    {reply.accepted ? '过稿回复' : (replyKindLabel[reply.kind] ?? reply.kind)}
                  </Badge>
                </span>
              </button>
            })}
            {!items.length && <p className="dashboard-empty">{loading ? '正在加载邮件…' : '没有匹配的邮件，请调整账号或筛选条件。'}</p>}
          </div>
          <Pager page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} pageSize={pageSize}
            total={total} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1) }} />
        </div>
      )}

      {ruleOpen && (
        <Modal title="自动回复识别关键词" onClose={() => { if (!ruleSaving) setRuleOpen(false) }} width={540}
          footer={<><Button variant="ghost" disabled={ruleSaving} onClick={() => setRuleOpen(false)}>取消</Button>
            <Button variant="primary" disabled={ruleSaving} onClick={() => void saveRules()}>{ruleSaving ? '保存中…' : '保存规则'}</Button></>}>
          <div className="inbox-rule-editor">
            <label className="field">主题包含以下任意关键词时，判为自动回复
              <textarea aria-label="自动回复主题关键词" rows={6} value={ruleDraft}
                placeholder="每行一个关键词" onChange={(event) => setRuleDraft(event.target.value)} />
            </label>
            <p className="hint">每行一个关键词，不区分英文大小写。清空后不再按关键词识别自动回复；退信仍单独识别。保存后点击“按当前规则重新判定”可更新已有邮件。</p>
          </div>
        </Modal>
      )}

      {preview && (
        <Modal title="邮件阅读" onClose={() => setPreview(null)} width={780} className="inbox-preview-modal"
          footer={<>
            <span className="inbox-preview-footer-hint">{pendingReads.has(preview.id) ? '正在同步邮箱状态…' : preview.read_synced ? '已与邮箱同步' : '已读状态等待邮箱同步'}</span>
            <Button variant="ghost" disabled={pendingReads.has(preview.id)} onClick={() => { void setReadState(preview, !preview.is_read); if (preview.is_read) setPreview(null) }}>
              {pendingReads.has(preview.id) ? '同步中…' : preview.is_read ? '标为未读' : '标为已读'}
            </Button>
            <Button variant="primary" onClick={() => setPreview(null)}>完成</Button>
          </>}>
          <div className="inbox-mail">
            <div className="inbox-mail-heading">
              <div className="inbox-mail-heading-meta">
                <Badge tone={preview.accepted ? 'success' : (replyKindTone[preview.kind] ?? 'neutral')}>
                  {preview.accepted ? '过稿回复' : (replyKindLabel[preview.kind] ?? preview.kind)}
                </Badge>
                <time>{preview.received_at}</time>
              </div>
              <h2>{preview.subject || '无主题'}</h2>
            </div>
            <div className="inbox-mail-sender">
              <div className="inbox-mail-avatar"><Mail size={19} /></div>
              <div className="inbox-mail-sender-copy">
                <strong>{previewEditor ? editorLabel(previewEditor) : preview.from_email}</strong>
                {previewEditor && <span>{preview.from_email}</span>}
                <small>发送至 {receivingAccount(preview)}</small>
              </div>
              {previewEditor && <div className="inbox-mail-editor-actions">
                <ReplyFavStar editor={previewEditor} onToggle={(item) => void toggleFavorite(item)} />
                <IconButton className="danger" title="删除这位编辑" onClick={() => void removeEditor(previewEditor)}><Trash2 size={15} /></IconButton>
              </div>}
            </div>
            <div className="inbox-mail-body"><ReplyText key={preview.id} body={preview.body || preview.snippet || '（无正文）'} /></div>
            <div className="inbox-mail-context"><span>关联计划：{replyDelivery(preview).plan}</span><span>对应收稿邮箱：{replyDelivery(preview).email}</span></div>
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
