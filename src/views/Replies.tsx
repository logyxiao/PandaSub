import { createLatestRequestQueue } from '../lib/latestRequestQueue'
import { useEventSubscription } from '../hooks/useEventSubscription'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { mailIdentityKey } from '../lib/mailContentCache'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Inbox, Mail, MailCheck, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { api, onReply, onInboxStatus } from '../api'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Pager, Select } from '../components/ui'
import { Modal } from '../components/Modal'
const MailContent = lazy(() => import('../components/MailContent').then(module => ({ default: module.MailContent })))
import { formatTime, parseRecipient, replyKindLabel, replyKindTone } from '../format'
import { useNav } from '../nav'
import type { Account, Editor, Reply, Task, Settings, InboxStatus } from '../types'
import { isEditorFavorited } from './planShared'

function replyBodyPreview(reply: Reply) {
  return (reply.snippet || reply.body.slice(0, 180) || '').replace(/\s+/g, ' ').trim() || '（无正文）'
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
  const [syncStatuses, setSyncStatuses] = useState<InboxStatus[]>([])
  useEventSubscription(onInboxStatus, setSyncStatuses)
  useEffect(() => { let active = true; void api.getInboxStatus().then(states => { if (active) setSyncStatuses(states) }).catch(() => {}); return () => { active = false } }, [])
  const flagQueue = useRef<ReturnType<typeof createLatestRequestQueue<number[], Awaited<ReturnType<typeof api.syncReplyReadFlags>>>> | null>(null)
  useEffect(() => {
    const queue = createLatestRequestQueue(api.syncReplyReadFlags, () => ({ states: [], errors: [] }))
    flagQueue.current = queue
    return () => { queue.dispose(); flagQueue.current = null }
  }, [])
  const [items, setItems] = useState<Reply[]>([])
  const [editors, setEditors] = useState<Editor[]>([])
  const [savingEditors, setSavingEditors] = useState<Set<number>>(new Set())
  const editorWrites = useRef(new Set<number>())
  const [tasks, setTasks] = useState<Task[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [ruleDraft, setRuleDraft] = useState('')
  const [ruleSaving, setRuleSaving] = useState(false)
  const [kind, setKind] = useState(initialKind ?? '')
  const [taskFilter, setTaskFilter] = useState<number | ''>('')
  const [query, setQuery] = useState('')
  const search = useDebouncedValue(query, 200, () => setPage(1))
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  // Selection survives paging, but never leaks across filters or mailbox accounts.
  const selectionScope = JSON.stringify([accountFilter, kind, taskFilter, query])
  const [selection, setSelection] = useState<{ scope: string; entries: Map<string, number | null> }>({ scope: selectionScope, entries: new Map() })
  const selected = useMemo(() => selection.scope === selectionScope ? selection.entries : new Map<string, number | null>(), [selection, selectionScope])
  useEffect(() => { setSelection(current => current.scope === selectionScope ? current : { scope: selectionScope, entries: new Map() }) }, [selectionScope])
  const [batchBusy, setBatchBusy] = useState(false)
  const batchLock = useRef(false)

  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [readNotice, setReadNotice] = useState('')
  const [scanning, setScanning] = useState(false)
  const [preview, setPreview] = useState<Reply | null>(null)
  const previewOpener = useRef<HTMLButtonElement | null>(null)
  const closePreview = useCallback(() => {
    setPreview(null)
    if (previewOpener.current?.isConnected) previewOpener.current.focus({ preventScroll: true })
  }, [])
  const previewOpen = preview !== null
  useEffect(() => {
    if (!previewOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault()
        closePreview()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewOpen, closePreview])
  const updateSubject = useCallback((identity: string, subject: string) => {
    const update = (reply: Reply) => mailIdentityKey(reply) === identity && reply.subject !== subject ? { ...reply, subject } : reply
    setPreview(current => current ? update(current) : current)
    setItems(current => current.map(update))
  }, [])
  const [pendingReads, setPendingReads] = useState<Set<number>>(new Set())
  const [markingRead, setMarkingRead] = useState(false)
  const markReadLock = useRef(false)
  const readVersions = useRef(new Map<number, number>())
  const latestReads = useRef(new Map<number, { is_read: boolean; read_synced: boolean; identity: string }>())
  const openedInitialReply = useRef<Reply | undefined>(undefined)
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
    const versions = new Map(readVersions.current)
    setLoading(true)
    try {
      const next = await api.listRepliesPage(kind, taskFilter, search, pageSize, (page - 1) * pageSize, accountFilter)
      if (seq !== requestSeq.current) return
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize))
      if (page > lastPage) { setPage(lastPage); return }
      setItems(next.items.map((reply) => readOverrides.current.has(reply.id)
        ? { ...reply, is_read: readOverrides.current.get(reply.id)!, read_synced: true }
        : versions.get(reply.id) !== readVersions.current.get(reply.id) && latestReads.current.get(reply.id)?.identity === mailIdentityKey(reply)
          ? { ...reply, is_read: latestReads.current.get(reply.id)!.is_read, read_synced: latestReads.current.get(reply.id)!.read_synced } : reply)); setTotal(next.total); setNotice('')
      if (!next.items.length) setReadNotice('')
      if (next.items.length) {
        const syncVersions = new Map(readVersions.current)
        void flagQueue.current?.read(next.items.map((reply) => reply.id)).then(({ states, errors }) => {
          if (seq !== requestSeq.current || markReadLock.current) return
          setReadNotice(errors.length ? `部分邮箱已读状态暂未同步：${errors.map(error => `${error.email}：${error.message}`).join('；')}。可刷新列表重试。` : '')
          const byId = new Map(states.map((state) => [state.id, state]))
          const applyState = (reply: Reply) => {
            const state = byId.get(reply.id)
            return state && !readOverrides.current.has(reply.id) && syncVersions.get(reply.id) === readVersions.current.get(reply.id) ? { ...reply, ...state } : reply
          }
          setItems((current) => current.map(applyState))
          setPreview((current) => current ? applyState(current) : current)
          if (kind === 'unread' && states.some(state => syncVersions.get(state.id) === readVersions.current.get(state.id) && (state.is_read || !state.read_synced))) void latestLoad.current()
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

  useEventSubscription(onReply, () => { void load() }, 200)
  useEffect(() => { const sequence = requestSeq; return () => { sequence.current++ } }, [load])


  const scan = async () => {
    setScanning(true)
    try {
      const n = await api.scanReplies()
      await latestLoad.current()
      toast(n ? `新收到 ${n} 封邮件` : '没有新的邮件', n ? 'success' : 'info')
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

  const selectedEditors = useMemo(() => {
    const ids = new Set(selected.values())
    return editors.filter(editor => ids.has(editor.id))
  }, [selected, editors])
  const selectedEditorIds = new Set(selectedEditors.map(editor => editor.id))
  const unmatchedSelected = [...selected.values()].filter(id => id === null || !selectedEditorIds.has(id)).length
  const pageSelected = items.filter(reply => selected.has(mailIdentityKey(reply))).length
  const allPageSelected = items.length > 0 && pageSelected === items.length
  const selectionBusy = batchBusy || savingEditors.size > 0
  const selectReplies = (replies: Reply[], checked: boolean) => {
    if (batchLock.current || loading) return
    setSelection(current => {
      const entries = new Map(current.scope === selectionScope ? current.entries : [])
      for (const reply of replies) {
        const key = mailIdentityKey(reply)
        if (checked) entries.set(key, editorForReply(reply, editorsByEmail)?.id ?? null)
        else entries.delete(key)
      }
      return { scope: selectionScope, entries }
    })
  }
  const batchEditors = async (action: 'pause' | 'enable' | 'delete') => {
    if (batchLock.current || editorWrites.current.size || loading || !selectedEditors.length) return
    const targets = selectedEditors.filter(editor => action === 'delete' || editor.enabled !== (action === 'enable'))
    if (!targets.length) return
    const ids = targets.map(editor => editor.id)
    const idSet = new Set(ids)
    const snapshot = selection
    batchLock.current = true
    setBatchBusy(true)
    try {
      if (action === 'delete' && !await confirm({
        title: `删除 ${ids.length} 位编辑`,
        message: `将从编辑库及编辑组中删除以下 ${ids.length} 位编辑：\n${targets.map(editor => `${editorLabel(editor)} <${editor.email}>`).join('\n')}\n\n邮件与投递历史会保留。已有计划中的收件人不会自动删除，仍可能向这些邮箱发送；如需停止投递，请使用“批量暂停编辑”。`,
        confirmLabel: `删除 ${ids.length} 位编辑`, tone: 'danger',
      })) return
      const count = action === 'delete' ? await api.deleteEditors(ids) : await api.setEditorsEnabled(ids, action === 'enable')
      setEditors(list => action === 'delete' ? list.filter(editor => !idSet.has(editor.id)) : list.map(editor => idSet.has(editor.id) ? { ...editor, enabled: action === 'enable' } : editor))
      setSelection(current => current === snapshot ? { scope: current.scope, entries: new Map() } : current)
      toast(action === 'delete' ? `已删除 ${count} 位编辑，邮件已保留` : action === 'pause' ? `已暂停 ${count} 位编辑，后续投递将跳过这些邮箱` : `已启用 ${count} 位编辑，可重新安排投递`, 'success')
    } catch (error) { toast(`批量操作失败，未作更改：${String(error)}`, 'error') }
    finally { batchLock.current = false; setBatchBusy(false) }
  }

  const toggleEnabled = async (editor: Editor) => {
    if (batchLock.current || editorWrites.current.has(editor.id)) return
    editorWrites.current.add(editor.id)
    setSavingEditors(new Set(editorWrites.current))
    const enabled = !editor.enabled
    try {
      await api.setEditorEnabled(editor.id, enabled)
      setEditors(list => list.map(item => item.id === editor.id ? { ...item, enabled } : item))
      toast(enabled ? `${editorLabel(editor)} 已启用，可重新安排投递` : `${editorLabel(editor)} 已停用，后续投递将跳过该邮箱`, 'success')
    } catch (e) { toast(`编辑状态保存失败：${String(e)}`, 'error') }
    finally { editorWrites.current.delete(editor.id); setSavingEditors(new Set(editorWrites.current)) }
  }

  const toggleFavorite = async (editor: Editor) => {
    try {
      const saved = await api.toggleEditorFavorite(editor.id)
      setEditors((list) => list.map((item) => (item.id === editor.id ? { ...item, favorited: saved } : item)))
    } catch (e) { toast(String(e), 'error') }
  }

  const removeEditor = async (editor: Editor) => {
    if (batchLock.current) return
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
    if (markReadLock.current) return
    if (reply.kind === 'auto' || (reply.read_synced && reply.is_read === isRead && !readWrites.current.has(reply.id))) return
    readVersions.current.set(reply.id, (readVersions.current.get(reply.id) ?? 0) + 1)
    latestReads.current.set(reply.id, { identity: mailIdentityKey(reply), is_read: isRead, read_synced: true })
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
        readVersions.current.set(reply.id, (readVersions.current.get(reply.id) ?? 0) + 1)
        readOverrides.current.delete(reply.id)
        if (kind === 'unread') void latestLoad.current()
      }
    } catch (e) {
      if (readWrites.current.get(reply.id) !== write || readOverrides.current.get(reply.id) !== isRead) return
      readVersions.current.set(reply.id, (readVersions.current.get(reply.id) ?? 0) + 1)
      latestReads.current.set(reply.id, { identity: mailIdentityKey(reply), is_read: reply.is_read, read_synced: reply.read_synced })
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
  }, [toast, kind])
  const markAllRead = async () => {
    if (markReadLock.current || readWrites.current.size || loading || query !== search || !total) return
    markReadLock.current = true
    setMarkingRead(true)
    requestSeq.current++
    try {
      const result = await api.markRepliesRead(kind, taskFilter, search, accountFilter)
      const states = new Map(result.states.map(state => [state.id, state]))
      for (const state of result.states) {
        readVersions.current.set(state.id, (readVersions.current.get(state.id) ?? 0) + 1)
        latestReads.current.delete(state.id)
      }
      setItems(current => current.map(reply => states.has(reply.id) ? { ...reply, ...states.get(reply.id)! } : reply))
      setPreview(current => current && states.has(current.id) ? { ...current, ...states.get(current.id)! } : current)
      const count = result.states.length
      if (result.failed) {
        toast(`已标记 ${count} 封，${result.failed} 封未完成，请刷新后重试`, 'warning')
        setReadNotice(result.errors.map(error => `${error.email}：${error.message}`).join('；') || '部分邮件状态已变化或无法同步，请刷新后重试。')
      } else {
        setReadNotice('')
        toast(count ? `已将 ${count} 封邮件标为已读` : '当前筛选下没有未读邮件', count ? 'success' : 'info')
      }
    } catch (error) { toast(`一键已读失败：${String(error)}`, 'error') }
    finally {
      markReadLock.current = false
      setMarkingRead(false)
      await latestLoad.current()
    }
  }
  const openPreview = (reply: Reply, opener: HTMLButtonElement) => {
    previewOpener.current = opener
    setPreview(reply)
    void setReadState(reply, true)
  }
  useEffect(() => {
    if (openedInitialReply.current === initialReply) return
    openedInitialReply.current = initialReply
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
              { value: 'unread', label: '未读人工回复' },
              { value: 'paused', label: '暂停收稿' },
              { value: 'human', label: '人工邮件' },
              { value: 'submission', label: '投稿相关' },
              { value: 'unmatched', label: '普通来信' },
              { value: 'auto', label: '自动回复' },
              { value: 'accepted', label: '过稿回复' },
              { value: 'bounce', label: '退信' },
            ]} />
        </div>
        <div className="toolbar-actions">
          <Button disabled={markingRead || loading || pendingReads.size > 0 || query !== search || !total}
            title="将当前账号和筛选条件下的全部未读邮件标为已读（包括其他分页）"
            onClick={() => void markAllRead()}>
            <MailCheck size={16} />{markingRead ? '正在标记…' : '一键已读'}
          </Button>
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
      {readNotice && <div className="notice notice-error" role="status" aria-label="已读状态同步提示">{readNotice}</div>}
      <div className="inbox-sync-status" role="status" aria-label="收件同步状态">
        {syncStatuses.filter(state => !accountFilter || state.account_id === accountFilter).length
          ? syncStatuses.filter(state => !accountFilter || state.account_id === accountFilter).map(state => <span key={state.account_id}
              className={`inbox-sync-account is-${state.mode}`} title={`${state.detail}${state.last_sync ? ` · 上次检查 ${state.last_sync}` : ''}`}>
              <i aria-hidden="true" />{accountsById.get(state.account_id) || '邮箱'} · {({ idle: '实时监听', polling: '定时检查', syncing: '收取中', connecting: '连接中', retrying: '连接重试', ready: '已更新' })[state.mode]}
            </span>)
          : <span>启用邮箱的收件检查后，新邮件会自动同步。</span>}
      </div>
      <div className="inbox-rule-bar">
        <strong>自动回复识别</strong>
        <span>主题包含</span>
        {settings?.auto_reply_subject_keywords.length
          ? <span className="inbox-rule-keywords">{settings.auto_reply_subject_keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</span>
          : <span className="inbox-rule-empty">{settings ? '未设置关键词' : '正在读取规则…'}</span>}
        <Button size="sm" onClick={openRules} disabled={!settings}>编辑关键词</Button>
        <span className="inbox-rule-explain">退信单独识别</span>
      </div>

      {kind === 'paused' && <p className="hint">按邮件主题或正文中的“暂停收稿”筛选，包含历史邮件。勾选邮件可批量暂停对应编辑；恢复收稿后可批量启用。</p>}
      <div className="inbox-batch-bar" aria-label="批量编辑操作">
        <label className="inbox-select-all"><input type="checkbox" aria-label="全选本页邮件"
          checked={allPageSelected} ref={node => { if (node) node.indeterminate = pageSelected > 0 && !allPageSelected }}
          disabled={loading || batchBusy || !items.length} onChange={event => selectReplies(items, event.target.checked)} />全选本页</label>
        <span role="status">已选 {selected.size} 封邮件 / {selectedEditors.length} 位编辑{unmatchedSelected > 0 && `（${unmatchedSelected} 封未匹配，操作时跳过）`}</span>
        <div className="inbox-batch-actions">
          <Button size="sm" disabled={loading || selectionBusy || !selectedEditors.some(editor => editor.enabled)} onClick={() => void batchEditors('pause')}>批量暂停编辑</Button>
          <Button size="sm" disabled={loading || selectionBusy || !selectedEditors.some(editor => !editor.enabled)} onClick={() => void batchEditors('enable')}>批量启用编辑</Button>
          <Button size="sm" variant="danger" disabled={loading || selectionBusy || !selectedEditors.length} onClick={() => void batchEditors('delete')}>批量删除编辑</Button>
          <Button size="sm" disabled={batchBusy || !selected.size} onClick={() => setSelection({ scope: selectionScope, entries: new Map() })}>清空选择</Button>
        </div>
        {batchBusy && <span role="status">正在处理…</span>}
      </div>
      <div className={`inbox-workspace ${preview ? 'has-preview' : ''}`}>
        {!loading && !total && !search && !kind && !taskFilter && !accountFilter ? (
          <div className="panel">
            <EmptyState icon={Inbox} title="收件箱暂无邮件"
              desc="启用邮箱收件检查后，会接收普通来信和投稿回复；自动回复默认已读。"
              action={<Button variant="ghost" onClick={() => go('accounts')}>去检查邮箱 IMAP 设置</Button>} />
          </div>
        ) : (
          <div className="panel reply-inbox">
            <div className="reply-list" aria-label="邮件列表" aria-busy={loading}>
              <div className="reply-list-caption"><span>共 {total} 封邮件</span>{loading && <span>正在更新…</span>}{!loading && items.some((reply) => reply.kind === 'human' && !reply.read_synced) && <span>{items.filter((reply) => reply.kind === 'human' && !reply.read_synced).length} 封状态待同步</span>}{readNotice && <span title={readNotice}>邮箱连接异常</span>}</div>
              {items.map((reply) => {
                const editor = editorForReply(reply, editorsByEmail)
                const sender = editor ? editorLabel(editor) : reply.from_email
                const pending = reply.kind === 'human' && pendingReads.has(reply.id)
                const unread = reply.kind === 'human' && reply.read_synced && !reply.is_read
                const unverified = reply.kind === 'human' && !reply.read_synced
                return <div className={`reply-select-row ${selected.has(mailIdentityKey(reply)) ? 'is-selected' : ''}`} key={mailIdentityKey(reply)}>
                  <label className="reply-select-box"><input type="checkbox" aria-label={`选择邮件 ${reply.subject || '无主题'}`}
                    checked={selected.has(mailIdentityKey(reply))} disabled={loading || batchBusy}
                    onChange={event => selectReplies([reply], event.target.checked)} /></label>
                  <button type="button" className={`reply-list-item ${pending || unverified ? 'is-unverified' : unread ? 'is-unread' : 'is-read'}`}
                  aria-current={preview && mailIdentityKey(preview) === mailIdentityKey(reply) ? 'true' : undefined}
                  aria-controls={preview ? 'inbox-mail-preview' : undefined}
                  aria-label={`${reply.kind === 'bounce' ? '退信' : pending ? '正在同步已读状态' : unverified ? '已读状态未同步' : unread ? '未读' : '已读'}邮件 ${sender} ${reply.subject || '无主题'}`}
                  onClick={(event) => openPreview(reply, event.currentTarget)}>
                  <span className={reply.kind === 'human' ? 'reply-unread-dot' : 'reply-dot-spacer'} aria-hidden="true" />
                  <span className="reply-list-main">
                    <span className="reply-list-top"><b>{sender}</b><span className="reply-list-subject">{reply.subject || '无主题'}</span></span>
                    <span className="reply-list-excerpt">{replyBodyPreview(reply)}</span>
                  </span>
                  <span className="reply-list-side">
                    <time>{formatTime(reply.received_at)}</time>
                    <span className="reply-list-account" title={`接收账号：${receivingAccount(reply)}`}>{receivingAccount(reply)}</span>
                    <span className="reply-list-tags">
                      {reply.submissions_paused && <Badge tone="warning">暂停收稿</Badge>}
                      {editor && !editor.enabled && <Badge tone="neutral">编辑已停用</Badge>}
                      <Badge tone={reply.accepted ? 'success' : (replyKindTone[reply.kind] ?? 'neutral')}>
                        {reply.accepted ? '过稿回复' : (reply.kind === 'human' && reply.delivery_id === null ? '普通来信' : replyKindLabel[reply.kind] ?? reply.kind)}
                      </Badge>
                    </span>
                  </span>
                </button>
                </div>
              })}
              {!items.length && <p className="dashboard-empty">{loading ? '正在加载邮件…' : kind === 'unread' && !search && !taskFilter ? '暂无未读人工回复。' : '没有匹配的邮件，请调整账号或筛选条件。'}</p>}
            </div>
            <Pager page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} pageSize={pageSize}
              total={total} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1) }} />
          </div>
        )}
        {preview && (
          <aside id="inbox-mail-preview" className="panel inbox-preview" aria-label="邮件阅读">
            <header className="inbox-preview-head">
              <div><Mail size={15} /><h2>邮件预览</h2></div>
              <IconButton title="关闭预览" onClick={closePreview}><X size={16} /></IconButton>
            </header>
            <div className="inbox-preview-body" key={mailIdentityKey(preview)}>
              <div className="inbox-mail">
                <div className="inbox-mail-heading">
                  <div className="inbox-mail-heading-meta">
                    <Badge tone={preview.accepted ? 'success' : (replyKindTone[preview.kind] ?? 'neutral')}>
                      {preview.accepted ? '过稿回复' : (preview.kind === 'human' && preview.delivery_id === null ? '普通来信' : replyKindLabel[preview.kind] ?? preview.kind)}
                    </Badge>
                    {preview.submissions_paused && <Badge tone="warning">暂停收稿</Badge>}
                    <time>{preview.received_at}</time>
                  </div>
                  <h2>{preview.subject || '无主题'}</h2>
                </div>
                <div className="inbox-mail-sender">
                  <div className="inbox-mail-avatar"><Mail size={19} /></div>
                  <div className="inbox-mail-sender-copy">
                    <strong>{previewEditor ? editorLabel(previewEditor) : preview.from_email}</strong>
                    {previewEditor && <span>{preview.from_email}</span>}
                    <small>接收账号 {receivingAccount(preview)}</small>
                  </div>
                  {previewEditor && <div className="inbox-mail-editor-actions">
                    <ReplyFavStar editor={previewEditor} onToggle={(item) => void toggleFavorite(item)} />
                    <IconButton disabled={selectionBusy} className="danger" title="删除这位编辑" onClick={() => void removeEditor(previewEditor)}><Trash2 size={15} /></IconButton>
                  </div>}
                </div>
                <div className="inbox-editor-status" aria-label="编辑启用状态">
                  {previewEditor ? <>
                    <div><Badge tone={previewEditor.enabled ? 'success' : 'neutral'}>{previewEditor.enabled ? '编辑已启用' : '编辑已停用'}</Badge>
                      <span>{previewEditor.email}</span>
                      <Button size="sm" disabled={batchBusy || savingEditors.has(previewEditor.id)} onClick={() => void toggleEnabled(previewEditor)}>
                        {savingEditors.has(previewEditor.id) ? '保存中…' : previewEditor.enabled ? '停用编辑' : '启用编辑'}
                      </Button>
                    </div>
                    <p className="hint">停用会影响所有发件账号，后续投递将跳过此邮箱；已经开始发送的邮件无法撤回。启用后需重新安排未完成的投递。</p>
                  </> : <p className="hint">未匹配到编辑库中的邮箱，暂无法切换编辑启用状态。</p>}
                </div>
                <div className="inbox-mail-body"><Suspense fallback={<p className="hint">正在打开邮件…</p>}><MailContent key={preview.id} reply={preview} account={receivingAccount(preview)} onSubject={updateSubject} /></Suspense></div>
                <div className="inbox-mail-context">{preview.delivery_id === null && <span>普通来信，不计入投稿统计</span>}<span>关联计划：{replyDelivery(preview).plan}</span><span>对应收稿邮箱：{replyDelivery(preview).email}</span></div>
              </div>
            </div>
            <footer className="inbox-preview-foot">
              <span className="inbox-preview-footer-hint">{preview.kind === 'auto' ? '自动回复已默认阅读' : pendingReads.has(preview.id) ? '正在同步邮箱状态…' : preview.read_synced ? '已与邮箱同步' : '已读状态等待邮箱同步'}</span>
              {preview.kind !== 'auto' && <Button variant="ghost" disabled={markingRead || pendingReads.has(preview.id)} onClick={() => { void setReadState(preview, !preview.is_read); if (preview.is_read) closePreview() }}>
                {pendingReads.has(preview.id) ? '同步中…' : preview.is_read ? '标为未读' : '标为已读'}
              </Button>}
              <Button variant="primary" onClick={closePreview}>完成</Button>
            </footer>
          </aside>
        )}
      </div>

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
    </>
  )
}
