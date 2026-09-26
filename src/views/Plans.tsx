import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, FileX2, FileUp, Mail, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { api, onLog, onTask } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton } from '../components/ui'
import { Table } from '../components/Table'
import { formatTime, fromDbTime, isValidEmail, statusLabel, taskTone, toDbTime } from '../format'
import { useNav } from '../nav'
import type { Account, Editor, EditorGroup, MailTemplate, Manuscript, ManuscriptInput, Settings, Task, TaskInput } from '../types'
import { PlanEditor } from './PlanEditor'
import { SendDetailModal } from './SendDetail'
import {
  categoryFromWords, countChars, createEmptyManuscript, DEFAULT_SEND_INTERVAL_FROM_SEC,
  DEFAULT_SEND_INTERVAL_TO_SEC, isValidSendIntervalRange, latestTask, normalizeSendIntervalRange, taskSendProgress,
  syncMailFromTemplates, toInput, accountTodayQuota, defaultMailTemplates, normalizeDefaultMailTemplates,
  MAX_SEND_INTERVAL_SEC,
} from './planShared'

const emptyTask: TaskInput = {
  name: '', manuscript_ids: [], account_ids: [], schedule_type: 'immediate', scheduled_at: null,
  retry_max: 3,
}

type PlanAction = { label: string; icon: typeof Copy; onClick: () => void; disabled?: boolean; danger?: boolean }

function PlanProgress({ sent, total, status, loop, title }: {
  sent: number; total: number; status: Task['status']; loop: boolean; title: string
}) {
  const percent = total > 0 ? Math.min(100, Math.max(0, sent / total * 100)) : 0
  return (
    <div className="plan-progress" data-status={status}>
      <div className="plan-progress-head">
        <span>{loop ? '已成功' : '已发送'}</span>
        <strong className="plan-progress-count">{loop ? `${sent} 封` : `${sent} / ${total || '—'}`}</strong>
      </div>
      <div className="plan-progress-bar" role="progressbar" aria-label={`《${title}》发送进度`}
        aria-valuemin={0} aria-valuemax={total || undefined} aria-valuenow={total ? Math.min(total, Math.max(0, sent)) : undefined}
        aria-valuetext={`已发送 ${sent} 封，共 ${total || '未知'} 封`}>
        <span className="plan-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function PlanMoreMenu({ actions, planTitle }: { actions: PlanAction[]; planTitle: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const place = useCallback((measuredHeight?: number) => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const menuHeight = measuredHeight ?? actions.length * 34 + 16
    setPosition({
      top: rect.bottom + 6 + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 6) : rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    })
  }, [actions.length])

  useLayoutEffect(() => {
    if (!open) return
    const updatePlace = () => place(menuRef.current?.offsetHeight)
    const dismiss = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    updatePlace()
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    window.addEventListener('resize', updatePlace)
    window.addEventListener('scroll', updatePlace, true)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', updatePlace)
      window.removeEventListener('scroll', updatePlace, true)
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, place])

  return <>
    <button ref={triggerRef} type="button" className="plan-more-trigger" title={`更多操作：${planTitle}`} aria-label={`更多操作：${planTitle}`}
      aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) place(); setOpen((current) => !current) }}>
      <MoreHorizontal size={17} />
    </button>
    {open && position && createPortal(
      <div ref={menuRef} className="plan-more-menu" role="menu" aria-label={`${planTitle}的操作`} style={position}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          if (!items.length) return
          event.preventDefault()
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        }}>
        {actions.map(({ label, icon: Icon, onClick, disabled, danger }) => (
          <button key={label} type="button" role="menuitem" disabled={disabled}
            className={danger ? 'is-danger' : undefined}
            onClick={() => { setOpen(false); onClick() }}>
            <Icon size={15} /><span>{label}</span>
          </button>
        ))}
      </div>, document.body,
    )}
  </>
}

export function PlansView({ newPlanRequest = 0 }: { newPlanRequest?: number }) {
  const consumedPlanRequest = useRef(0)
  const [manuscripts, setManuscripts] = useState<Manuscript[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [detailRevision, setDetailRevision] = useState(0)
  const [editors, setEditors] = useState<Editor[]>([])
  const [editorGroups, setEditorGroups] = useState<EditorGroup[]>([])
  const [defaultTemplates, setDefaultTemplates] = useState<MailTemplate[]>(() => defaultMailTemplates())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'draft' | 'done'>('all')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Manuscript | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [accountFor, setAccountFor] = useState<Manuscript | null>(null)
  const [draftIds, setDraftIds] = useState<number[]>([])
  const [draftSendInterval, setDraftSendInterval] = useState({
    fromSec: DEFAULT_SEND_INTERVAL_FROM_SEC,
    toSec: DEFAULT_SEND_INTERVAL_TO_SEC,
  })
  const [draftSendIntervalTouched, setDraftSendIntervalTouched] = useState(false)
  const [creatingWasteFor, setCreatingWasteFor] = useState<number | null>(null)
  const [detail, setDetail] = useState<Manuscript | null>(null)
  const [form, setForm] = useState<ManuscriptInput>(() => createEmptyManuscript())
  const [taskForm, setTaskForm] = useState<TaskInput>(emptyTask)
  const [scheduledInput, setScheduledInput] = useState('')
  const [saving, setSaving] = useState(false)
  const pendingDefaultTemplates = useRef<MailTemplate[] | null>(null)
  const savingDefaultTemplates = useRef(false)
  const toast = useToast()
  const confirm = useConfirm()
  const { go, setChrome } = useNav()

  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const [m, t, a, s, e, g, templates] = await Promise.all([
        api.listManuscripts(), api.listTasks(), api.listAccounts(), api.getSettings(), api.listEditors(), api.listEditorGroups(), api.getDefaultMailTemplates(),
      ])
      if (seq !== loadSeq.current) return
      const normalizedTemplates = normalizeDefaultMailTemplates(templates)
      setManuscripts(m); setTasks(t); setAccounts(a); setSettings(s); setEditors(e); setEditorGroups(g); setDefaultTemplates(normalizedTemplates); setNotice('')
      setDetail((current) => current ? m.find((item) => item.id === current.id) ?? null : null)
      if (JSON.stringify(normalizedTemplates) !== JSON.stringify(templates)) {
        void api.saveDefaultMailTemplates(normalizedTemplates).catch((error) => {
          toast(`默认模板初始化失败：${String(error)}`, 'error')
        })
      }
    } catch (e) { if (seq === loadSeq.current) setNotice(String(e)) }
    finally { if (seq === loadSeq.current) setLoading(false) }
  }, [toast])
  useEffect(() => {
    const sequence = loadSeq
    void load()
    return () => { sequence.current++ }
  }, [load])
  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    onTask((task) => {
      if (cancelled) return
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)])
    }).then((u) => {
      if (cancelled) u()
      else un = u
    })
    return () => {
      cancelled = true
      un?.()
    }
  }, [])
  useEffect(() => {
    setChrome(showEditor)
    return () => setChrome(false)
  }, [showEditor, setChrome])

  const detailId = detail?.id
  useEffect(() => {
    if (detailId === undefined) return
    let cancelled = false
    let timer: number | undefined
    let un: (() => void) | undefined
    onLog((log) => {
      if (log.manuscript_id !== detailId) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { if (!cancelled) setDetailRevision(v => v + 1) }, 150)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; window.clearTimeout(timer); un?.() }
  }, [detailId])

  const enabledAccounts = accounts.filter((a) => a.enabled)

  const taskByManuscript = useMemo(() => {
    const map = new Map<number, Task>()
    for (const task of tasks) {
      for (const manuscriptId of task.manuscript_ids) {
        const current = map.get(manuscriptId)
        if (!current || task.id > current.id) map.set(manuscriptId, task)
      }
    }
    return map
  }, [tasks])

  const progressByManuscript = useMemo(
    () => new Map(manuscripts.map((m) => [m.id, taskSendProgress(m, taskByManuscript.get(m.id))])),
    [manuscripts, taskByManuscript],
  )

  const visibleManuscripts = useMemo(() => manuscripts.filter((m) => {
    const task = taskByManuscript.get(m.id)
    const matchesFilter = filter === 'all'
      || (filter === 'active' && task && ['running', 'paused', 'scheduled'].includes(task.status))
      || (filter === 'draft' && !task)
      || (filter === 'done' && task && ['completed', 'stopped'].includes(task.status))
    const query = search.trim().toLocaleLowerCase()
    return matchesFilter && (!query || [m.title, m.category, ...(m.genres ?? [])].join(' ').toLocaleLowerCase().includes(query))
  }), [manuscripts, taskByManuscript, filter, search])

  const saveDefaultTemplates = (templates: MailTemplate[]) => {
    const next = normalizeDefaultMailTemplates(templates)
    setDefaultTemplates(next)
    pendingDefaultTemplates.current = next
    if (savingDefaultTemplates.current) return
    savingDefaultTemplates.current = true
    void (async () => {
      try {
        while (pendingDefaultTemplates.current) {
          const current = pendingDefaultTemplates.current
          pendingDefaultTemplates.current = null
          await api.saveDefaultMailTemplates(current)
        }
      } catch (error) {
        pendingDefaultTemplates.current = null
        toast(`默认模板自动保存失败：${String(error)}`, 'error')
      } finally {
        savingDefaultTemplates.current = false
      }
    })()
  }

  const openAdd = () => {
    setEditing(null)
    setForm(createEmptyManuscript(defaultTemplates))
    setTaskForm({
      ...emptyTask,
      account_ids: enabledAccounts.map((a) => a.id),
      ...(settings ? { retry_max: settings.default_retry_max } : {}),
    })
    setScheduledInput('')
    setShowEditor(true)
  }

  useEffect(() => {
    if (!loading && newPlanRequest > 0 && consumedPlanRequest.current !== newPlanRequest) {
      consumedPlanRequest.current = newPlanRequest
      openAdd()
    }
  }, [loading, newPlanRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  const openEdit = (m: Manuscript) => {
    const task = latestTask(m.id, tasks)
    setEditing(m)
    setForm(toInput(m))
    setTaskForm({
      name: task?.name || m.title,
      manuscript_ids: [m.id],
      account_ids: (m.account_ids?.length ? m.account_ids : task?.account_ids) ?? [],
      schedule_type: task?.schedule_type ?? 'immediate',
      scheduled_at: task?.scheduled_at ?? null,
      retry_max: task?.retry_max ?? settings?.default_retry_max ?? 3,
    })
    setScheduledInput(task?.scheduled_at ? fromDbTime(task.scheduled_at) : '')
    setShowEditor(true)
  }

  const openCopy = (m: Manuscript) => {
    const task = latestTask(m.id, tasks)
    const copied = toInput(m)
    const title = copied.title.trim()
    setEditing(null)
    setForm({
      ...copied,
      title: title ? `${title.replace(/（副本）$/, '')}（副本）` : '未命名计划（副本）',
      file_name: '',
      has_file: false,
      file_data: undefined,
    })
    setTaskForm({
      ...emptyTask,
      account_ids: (copied.account_ids?.length ? copied.account_ids : task?.account_ids) ?? enabledAccounts.map((a) => a.id),
      retry_max: task?.retry_max ?? settings?.default_retry_max ?? 3,
    })
    setScheduledInput('')
    setShowEditor(true)
  }

  const persistManuscript = async (payload: ManuscriptInput) => {
    if (!payload.title.trim()) { toast('请填写作品名称', 'warning'); return null }
    if (!isValidSendIntervalRange(payload.send_interval_from_sec, payload.send_interval_to_sec)) {
      toast('请填写有效的发送频率：最短和最长均为 1–86400 秒，且最短需小于或等于最长', 'warning')
      return null
    }
    const next = syncMailFromTemplates({
      ...payload,
      word_count: payload.word_count || countChars(payload.body),
    })
    if (!next.mail_templates.some((item) => item.body.trim())) {
      toast('请至少填写一套邮件正文', 'warning')
      return null
    }
    if (editing) {
      await api.updateManuscript(editing.id, next)
      return editing.id
    }
    return api.addManuscript(next)
  }

  const saveDraft = async () => {
    setSaving(true)
    try {
      const id = await persistManuscript(form)
      if (!id) return
      setShowEditor(false)
      await load()
      toast('计划已保存', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setSaving(false) }
  }

  const saveAndSend = async () => {
    if (!enabledAccounts.length) { toast('请先添加并启用发件邮箱', 'warning'); return }
    const selectedAccounts = taskForm.account_ids.length
      ? enabledAccounts.filter((a) => taskForm.account_ids.includes(a.id))
      : enabledAccounts
    if (!selectedAccounts.length) { toast('请至少勾选一个参与发送的邮箱', 'warning'); return }
    const current = editing ? latestTask(editing.id, tasks) : undefined
    if (current && ['running', 'paused'].includes(current.status)) {
      toast('这个计划正在发送，请先停止再重新发送', 'warning')
      return
    }
    const sending = form.recipients.filter((r) => isValidEmail(r))
    if (!sending.length) { toast('还没有可发送的编辑', 'warning'); return }
    if (taskForm.schedule_type === 'scheduled') {
      if (!scheduledInput) { toast('请选择发送时间', 'warning'); return }
      if (new Date(scheduledInput).getTime() <= Date.now()) { toast('定时时间必须晚于现在', 'warning'); return }
    }
    setSaving(true)
    try {
      const id = await persistManuscript(form)
      if (!id) return
      const input = {
        ...taskForm,
        name: form.title.trim(),
        manuscript_ids: [id],
        scheduled_at: taskForm.schedule_type === 'scheduled' ? toDbTime(scheduledInput) : null,
      }
      if (current && ['stopped', 'scheduled'].includes(current.status)) {
        await api.updateTask(current.id, input)
      } else {
        await api.createTask(input)
      }
      setShowEditor(false)
      await load()
      toast(taskForm.schedule_type === 'scheduled' ? '已预约，到点会自动开始' : '计划已开始发送', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setSaving(false) }
  }

  const importFile = async (file: File | null) => {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['docx', 'txt', 'md', 'html', 'htm'].includes(ext)) {
      toast('请导入 DOCX、TXT、MD 或 HTML 格式的稿件', 'warning')
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const text = ext === 'docx'
        ? await api.extractDocx(Array.from(bytes))
        : new TextDecoder('utf-8').decode(bytes)
      setForm((f) => {
        const title = f.title.trim() || file.name.replace(/\.[^.]+$/, '')
        const word_count = countChars(text)
        const category = categoryFromWords(word_count)
        // 保留文件内容，保存后会作为附件随邮件发送。
        return { ...f, title, file_name: file.name, word_count, category, content_type: 'text/plain' as const, file_data: Array.from(bytes) }
      })
      toast('已读入作品，文件将作为附件发送', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const control = async (id: number, action: 'start' | 'pause' | 'resume' | 'stop') => {
    try {
      if (action === 'start') await api.startTask(id)
      else if (action === 'pause') await api.pauseTask(id)
      else if (action === 'resume') await api.resumeTask(id)
      else await api.stopTask(id)
    } catch (e) { toast(String(e), 'error') }
  }

  const startAgain = async (task: Task) => {
    // 已完成的重新发送、循环任务重新循环，都会从头投递，需要确认；停止后继续发送是跳过已投、无副作用，直接继续。
    if (task.status === 'completed' || (task.schedule_type === 'loop' && task.sent > 0)) {
      const ok = await confirm({
        title: '重新发送？',
        message: '会从第一封重新投递。已经发出去的邮件不会撤回。',
        confirmLabel: '重新发送',
      })
      if (!ok) return
    }
    await control(task.id, 'start')
  }

  const openDetail = (m: Manuscript) => {
    setDetailRevision(v => v + 1)
    setDetail(m)
  }

  const remove = async (m: Manuscript) => {
    const task = latestTask(m.id, tasks)
    if (task && ['running', 'paused'].includes(task.status)) {
      toast('请先停止发送，再删除计划', 'warning')
      return
    }
    const ok = await confirm({ title: '删除投稿计划', message: '作品、收件人和对应发送记录会一起删掉，无法恢复。', confirmLabel: '删除', tone: 'danger' })
    if (!ok) return
    try { await api.deleteManuscript(m.id); await load(); toast('计划已删除', 'success') } catch (e) { toast(String(e), 'error') }
  }

  const planAccounts = (m: Manuscript) => {
    const task = latestTask(m.id, tasks)
    return (m.account_ids?.length ? m.account_ids : task?.account_ids) ?? []
  }

  const openAccountFor = (m: Manuscript) => {
    setAccountFor(m)
    setDraftIds(planAccounts(m))
    setDraftSendInterval(normalizeSendIntervalRange(
      m.send_interval_from_sec,
      m.send_interval_to_sec,
      m.send_interval_min,
    ))
    setDraftSendIntervalTouched(false)
  }

  const toggleDraftAccount = (accountId: number) => {
    setDraftIds((cur) => cur.includes(accountId) ? cur.filter((x) => x !== accountId) : [...cur, accountId])
  }

  const saveAccount = async () => {
    if (!accountFor) return
    if (!isValidSendIntervalRange(draftSendInterval.fromSec, draftSendInterval.toSec)) {
      toast('请填写有效的发送频率：最短和最长均为 1–86400 秒，且最短需小于或等于最长', 'warning')
      return
    }
    setSaving(true)
    try {
      const ids = draftIds.slice()
      const cur = planAccounts(accountFor)
      await api.updateManuscript(accountFor.id, {
        ...toInput(accountFor),
        account_ids: ids,
        send_interval_from_sec: draftSendInterval.fromSec,
        send_interval_to_sec: draftSendInterval.toSec,
      })
      const task = latestTask(accountFor.id, tasks)
      if (task && (cur.length !== ids.length || cur.some((x, i) => x !== ids[i]))) {
        await api.updateTaskAccounts(task.id, ids)
      }
      await load()
      setAccountFor(null)
      toast('邮箱和发送频率已保存', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setSaving(false) }
  }

  const createWasteDraft = async (manuscript: Manuscript) => {
    const wasteEditors = new Set(
      editors
        .filter((editor) => editor.enabled && editor.work_type.includes('废稿'))
        .map((editor) => editor.email.trim().toLowerCase())
        .filter(Boolean),
    )
    if (!wasteEditors.size) {
      toast('没有启用且带有「废稿」标签的编辑', 'warning')
      return
    }
    if (!enabledAccounts.length) {
      toast('请先添加并启用至少一个投稿邮箱', 'warning')
      return
    }
    const ok = await confirm({
      title: '创建废稿计划？',
      message: `将复制《${manuscript.title}》的正文、邮件模板和附件，并立即发送给 ${wasteEditors.size} 位废稿编辑。`,
      confirmLabel: '创建并发送',
    })
    if (!ok) return

    setCreatingWasteFor(manuscript.id)
    try {
      const count = await api.createWasteDraftTask(manuscript.id)
      await load()
      toast(`废稿计划已创建，开始发送给 ${count} 位编辑`, 'success')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setCreatingWasteFor(null)
    }
  }

  if (showEditor) {
    return (
      <PlanEditor
        editing={editing}
        editors={editors}
        editorGroups={editorGroups}
        onReloadEditors={async () => { setEditors(await api.listEditors()) }}
        onReloadEditorGroups={async () => { setEditorGroups(await api.listEditorGroups()) }}
        onFavoriteChange={(id, favorited) => {
          setEditors((list) => list.map((editor) => (editor.id === id ? { ...editor, favorited } : editor)))
        }}
        onDefaultTemplatesChange={saveDefaultTemplates}
        enabledAccounts={enabledAccounts}
        form={form}
        setForm={setForm}
        taskForm={taskForm}
        setTaskForm={setTaskForm}
        saving={saving}
        onClose={() => setShowEditor(false)}
        onSaveDraft={() => void saveDraft()}
        onSaveAndSend={() => void saveAndSend()}
        onImportFile={importFile}
      />
    )
  }

  return (
    <>
      <div className="toolbar plans-page-toolbar">
        <div className="toolbar-actions">
          <IconButton title="刷新计划" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" onClick={openAdd}><Plus size={16} />新建计划</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}
      {!enabledAccounts.length && (
        <div className="notice notice-info">还没有可用发件邮箱。可以先写计划，发送前再去 <button type="button" className="text-link" onClick={() => go('accounts')}>邮箱</button> 里添加。</div>
      )}

      {!loading && !manuscripts.length ? (
        <div className="panel">
          <EmptyState icon={FileUp} title="还没有投稿计划"
            desc="写好作品和邮件，收件人按作品类型匹配，每个平台只出一位。"
            action={<Button variant="primary" onClick={openAdd}><Plus size={16} />新建计划</Button>} />
        </div>
      ) : (
        <div className="panel plans-list-panel">
          <div className="plans-list-header">
            <div className="plans-list-heading">
              <h2>全部计划 <span>{manuscripts.length}</span></h2>
              <p>每篇作品对应一份计划，点击记录可查看投递详情。</p>
            </div>
            <label className="plans-search">
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索作品或类型" aria-label="搜索投稿计划" />
            </label>
          </div>
          <div className="plans-filters" aria-label="筛选投稿计划">
            {([
              ['all', '全部'], ['active', '进行中'], ['draft', '草稿'], ['done', '已结束'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className={filter === value ? 'on' : ''}
                aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
            ))}
            <span>{visibleManuscripts.length} 个结果</span>
          </div>
          <Table
            className="plans-table"
            minWidth={850}
            rowKey="id"
            dataSource={visibleManuscripts}
            resetKey={`${filter}:${search}`}
            pagination={{ pageSize: 6, pageSizeOptions: [6, 10, 20, 50], hideOnSinglePage: true }}
            empty="没有符合条件的计划，试试其他关键词或状态。"
            columns={[
              {
                key: 'title',
                title: '计划',
                render: (_value, m) => {
                  const task = taskByManuscript.get(m.id)
                  const isWastePlan = m.title.trim().endsWith('（废稿）') || task?.name.trim().endsWith('（废稿）')
                  const wasteLabel = task?.status === 'running' ? '废稿发送中'
                    : task?.status === 'paused' ? '废稿已暂停'
                    : task?.status === 'completed' ? '废稿已完成'
                    : '废稿计划'
                  return (
                    <>
                      <div className="plan-list-title">
                        <b>{m.title}</b>
                        {isWastePlan && <Badge tone={task ? taskTone[task.status] : 'neutral'} dot>{wasteLabel}</Badge>}
                      </div>
                      <small>{[m.category, ...(m.genres ?? []).slice(0, 2)].filter(Boolean).join(' · ') || '未填写分类'}</small>
                    </>
                  )
                },
              },
              {
                key: 'progress',
                title: '进度',
                width: 160,
                render: (_value, m) => {
                  const task = taskByManuscript.get(m.id)
                  const n = m.recipients.filter((r) => isValidEmail(r)).length
                  const progress = progressByManuscript.get(m.id) ?? { sent: 0, total: 0 }
                  return task
                    ? <PlanProgress sent={progress.sent} total={progress.total || n} status={task.status}
                        loop={task.schedule_type === 'loop'} title={m.title} />
                    : <span className="hint">草稿</span>
                },
              },
              {
                key: 'status',
                title: '状态',
                width: 92,
                render: (_value, m) => {
                  const task = taskByManuscript.get(m.id)
                  return task
                    ? <Badge tone={taskTone[task.status]} dot>{statusLabel(task.status)}</Badge>
                    : <Badge tone="neutral">草稿</Badge>
                },
              },
              {
                key: 'updated',
                title: '最近更新',
                width: 112,
                render: (_value, m) => formatTime(m.updated_at),
              },
              {
                key: 'actions',
                title: '操作',
                width: 280,
                render: (_value, m) => {
                  const task = taskByManuscript.get(m.id)
                  const isWastePlan = m.title.trim().endsWith('（废稿）') || task?.name.trim().endsWith('（废稿）')
                  const active = Boolean(task && ['running', 'paused'].includes(task.status))
                  const primaryLabel = !task ? '编辑计划'
                    : task.status === 'running' ? '暂停'
                    : task.status === 'paused' ? '继续'
                    : task.status === 'scheduled' ? '立即开始'
                    : task.status === 'completed' ? '重新发送'
                    : task.schedule_type === 'loop' ? (task.sent > 0 ? '重新循环' : '开始')
                    : task.sent > 0 ? '继续发送' : '开始发送'
                  const primaryIcon = !task ? null : task.status === 'running' ? <Pause size={14} /> : <Play size={14} />
                  const actionTone = task?.status === 'paused' ? 'resume'
                    : task?.status === 'completed' || (task?.schedule_type === 'loop' && task.sent > 0) ? 'repeat'
                    : task?.status === 'stopped' && task.sent > 0 ? 'continue' : ''
                  const moreActions: PlanAction[] = [
                    ...(active && task ? [{ label: '停止发送', icon: Square, onClick: () => void control(task.id, 'stop') }] : []),
                    { label: '复制计划', icon: Copy, onClick: () => openCopy(m) },
                    { label: '配置投稿邮箱', icon: Mail, onClick: () => openAccountFor(m), disabled: active },
                    { label: isWastePlan ? '已是废稿计划' : creatingWasteFor === m.id ? '废稿发送中' : '创建废稿计划',
                      icon: FileX2, onClick: () => void createWasteDraft(m), disabled: isWastePlan || creatingWasteFor === m.id },
                    ...(!active ? [{ label: '删除计划', icon: Trash2, onClick: () => void remove(m), danger: true }] : []),
                  ]
                  return (
                    <div className="row-actions plan-row-actions">
                      <Button size="sm" variant={!task || task?.status === 'running' || actionTone ? 'ghost' : 'primary'}
                        className={actionTone ? `plan-action-${actionTone}` : undefined}
                        onClick={() => {
                          if (!task) openEdit(m)
                          else if (task.status === 'running') void control(task.id, 'pause')
                          else if (task.status === 'paused') void control(task.id, 'resume')
                          else void startAgain(task)
                        }}>{primaryIcon}{primaryLabel}</Button>
                      {task && <Button size="sm" variant="subtle" onClick={() => openDetail(m)}>记录</Button>}
                      {task && <Button size="sm" variant="subtle" disabled={active} onClick={() => openEdit(m)}>
                        <Pencil size={14} />编辑计划
                      </Button>}
                      <PlanMoreMenu actions={moreActions} planTitle={m.title} />
                    </div>
                  )
                },
              },
            ]}
          />
        </div>
      )}

      {detail && (
        <SendDetailModal
          manuscript={detail}
          revision={detailRevision}
          editors={editors}
          enabledAccounts={enabledAccounts}
          locked={(() => {
            return tasks.some(t => t.manuscript_ids.includes(detail.id) && ['running', 'paused'].includes(t.status))
          })()}
          onChanged={() => { setDetailRevision(v => v + 1); void load() }}
          onClose={() => setDetail(null)}
        />
      )}

      {accountFor && (
        <Modal title="配置投稿邮箱" width={640} onClose={() => setAccountFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAccountFor(null)}>取消</Button>
              <Button variant="primary" disabled={saving} onClick={() => void saveAccount()}>保存</Button>
            </>
          }>
          <p className="plan-acct-hint">为《{accountFor.title || '未命名'}》指定投稿邮箱和发送频率；邮箱留空表示使用全部启用邮箱。运行或暂停中的计划请先停止，再修改配置。</p>
          <div className="plan-acct-list">
            <div className="plan-acct-row">
              <div className="plan-acct-title"><b>投稿邮箱</b><small>可多选</small></div>
              <div className="plan-accounts-list">
                {enabledAccounts.map((a) => {
                  const on = draftIds.includes(a.id)
                  const quota = accountTodayQuota(a.sent_today)
                  return (
                    <label key={a.id} className={`plan-account-chip ${on ? 'on' : ''} ${quota.over ? 'is-over' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleDraftAccount(a.id)} />
                      <span className="plan-account-chip-text">
                        <b>{a.email}</b>
                        <small>今日 {quota.label}{quota.over ? ' · 建议今天不要再发' : ''}</small>
                      </span>
                    </label>
                  )
                })}
                {!enabledAccounts.length && <span className="hint">还没有启用邮箱，去「邮箱」页添加并启用</span>}
              </div>
            </div>
            <div className="plan-acct-row">
              <div className="plan-acct-title"><b>发送频率</b><small>每封邮件之间的间隔</small></div>
              <div className="send-interval-range" aria-label="随机发送间隔">
                <label className="send-interval-field">
                  <span>最短</span>
                  <span className="send-interval-input-wrap">
                    <input type="number" min={1} max={MAX_SEND_INTERVAL_SEC} step={1}
                      value={draftSendInterval.fromSec || ''}
                      aria-invalid={draftSendIntervalTouched && !isValidSendIntervalRange(draftSendInterval.fromSec, draftSendInterval.toSec)}
                      onBlur={() => setDraftSendIntervalTouched(true)}
                      onChange={(event) => {
                        const value = event.target.value === '' ? 0 : Math.round(Number(event.target.value))
                        setDraftSendInterval((current) => ({ ...current, fromSec: value }))
                      }} />
                    <em>秒</em>
                  </span>
                </label>
                <span className="send-interval-separator">至</span>
                <label className="send-interval-field">
                  <span>最长</span>
                  <span className="send-interval-input-wrap">
                    <input type="number" min={1} max={MAX_SEND_INTERVAL_SEC} step={1}
                      value={draftSendInterval.toSec || ''}
                      aria-invalid={draftSendIntervalTouched && !isValidSendIntervalRange(draftSendInterval.fromSec, draftSendInterval.toSec)}
                      onBlur={() => setDraftSendIntervalTouched(true)}
                      onChange={(event) => {
                        const value = event.target.value === '' ? 0 : Math.round(Number(event.target.value))
                        setDraftSendInterval((current) => ({ ...current, toSec: value }))
                      }} />
                    <em>秒</em>
                  </span>
                </label>
              </div>
              {isValidSendIntervalRange(draftSendInterval.fromSec, draftSendInterval.toSec) ? (
                <p className="hint">每封发送后随机等待 {draftSendInterval.fromSec}–{draftSendInterval.toSec} 秒。</p>
              ) : draftSendIntervalTouched ? (
                <p className="warn-text">请填写 1–86400 秒，且最短时间需小于或等于最长时间。</p>
              ) : (
                <p className="hint">完成两个时间输入后会校验发送区间。</p>
              )}
              {isValidSendIntervalRange(draftSendInterval.fromSec, draftSendInterval.toSec) && draftSendInterval.fromSec < 30 && (
                <p className="warn-text">最短间隔低于 30 秒，可能更容易触发邮箱发送频率限制。</p>
              )}
              <div className="plan-send-rules">
                <b>发送规则与建议</b>
                <ol>
                  <li>只选一个邮箱时，全部邮件都由该邮箱发送；多选时，按列表顺序在可用邮箱之间轮换。</li>
                  <li>整个计划串行发送。每发完一封，再按上方区间随机等待，然后切换邮箱发送下一封；各邮箱不会并发或各自单独计时。</li>
                  <li>未勾选邮箱表示使用全部启用邮箱；已禁用邮箱会跳过，认证失败的邮箱会自动停用并切换下一个。</li>
                  <li>“今日 80 封”是发送建议和提醒，不会自动停止该邮箱。</li>
                </ol>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
