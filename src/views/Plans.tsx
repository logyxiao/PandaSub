import { useEffect, useState } from 'react'
import { Copy, FileUp, Mail, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, onTask } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, RuntimeTrack } from '../components/ui'
import { Table } from '../components/Table'
import { formatTime, fromDbTime, isValidEmail, statusLabel, taskTone, toDbTime } from '../format'
import { useNav } from '../nav'
import type { Account, Delivery, Editor, Manuscript, ManuscriptInput, Settings, Task, TaskInput } from '../types'
import { PlanEditor } from './PlanEditor'
import { SendDetailModal } from './SendDetail'
import { categoryFromWords, countChars, createEmptyManuscript, latestTask, planSendProgress, syncMailFromTemplates, toInput } from './planShared'

const emptyTask: TaskInput = {
  name: '', manuscript_ids: [], account_ids: [], schedule_type: 'immediate', scheduled_at: null,
  retry_max: 3,
}

export function PlansView() {
  const [manuscripts, setManuscripts] = useState<Manuscript[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [editors, setEditors] = useState<Editor[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Manuscript | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [accountFor, setAccountFor] = useState<Manuscript | null>(null)
  const [draftIds, setDraftIds] = useState<number[]>([])
  const [detail, setDetail] = useState<Manuscript | null>(null)
  const [form, setForm] = useState<ManuscriptInput>(() => createEmptyManuscript())
  const [taskForm, setTaskForm] = useState<TaskInput>(emptyTask)
  const [scheduledInput, setScheduledInput] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const confirm = useConfirm()
  const { go, setChrome } = useNav()

  const load = async () => {
    setLoading(true)
    try {
      const [m, t, a, s, d, e] = await Promise.all([
        api.listManuscripts(), api.listTasks(), api.listAccounts(), api.getSettings(), api.listDeliveries(), api.listEditors(),
      ])
      setManuscripts(m); setTasks(t); setAccounts(a); setSettings(s); setDeliveries(d); setEditors(e); setNotice('')
    } catch (e) { setNotice(String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    onTask((task) => {
      if (cancelled) return
      setTasks((prev) => [task, ...prev.filter((x) => x.id !== task.id)])
      void api.listDeliveries().then((d) => {
        if (!cancelled) setDeliveries(d)
      })
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

  const enabledAccounts = accounts.filter((a) => a.enabled)

  const openAdd = () => {
    setEditing(null)
    setForm(createEmptyManuscript())
    setTaskForm({
      ...emptyTask,
      account_ids: enabledAccounts.map((a) => a.id),
      ...(settings ? { retry_max: settings.default_retry_max } : {}),
    })
    setScheduledInput('')
    setShowEditor(true)
  }

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
      await persistManuscript(form)
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
      if (current && current.status === 'stopped') {
        if (taskForm.account_ids.length) await api.updateTaskAccounts(current.id, taskForm.account_ids)
        await api.startTask(current.id)
      } else {
        await api.createTask({
          ...taskForm,
          name: form.title.trim(),
          manuscript_ids: [id],
          scheduled_at: taskForm.schedule_type === 'scheduled' ? toDbTime(scheduledInput) : null,
        })
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

  const openDetail = async (m: Manuscript) => {
    setDetail(m)
    // 打开详情时刷新一次投递记录和编辑库，保证发送状态是最新的。
    try {
      const [d, e] = await Promise.all([api.listDeliveries(), api.listEditors()])
      setDeliveries(d); setEditors(e)
    } catch { /* 忽略，使用已有数据 */ }
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
  }

  const toggleDraftAccount = (accountId: number) => {
    setDraftIds((cur) => cur.includes(accountId) ? cur.filter((x) => x !== accountId) : [...cur, accountId])
  }

  const saveAccount = async () => {
    if (!accountFor) return
    setSaving(true)
    try {
      const ids = draftIds.slice()
      const cur = planAccounts(accountFor)
      await api.updateManuscript(accountFor.id, { ...toInput(accountFor), account_ids: ids })
      const task = latestTask(accountFor.id, tasks)
      if (task && (cur.length !== ids.length || cur.some((x, i) => x !== ids[i]))) {
        await api.updateTaskAccounts(task.id, ids)
      }
      await load()
      setAccountFor(null)
      toast('邮箱配置已保存', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setSaving(false) }
  }

  if (showEditor) {
    return (
      <PlanEditor
        editing={editing}
        editors={editors}
        onReloadEditors={async () => { setEditors(await api.listEditors()) }}
        onFavoriteChange={(id, favorited) => {
          setEditors((list) => list.map((editor) => (editor.id === id ? { ...editor, favorited } : editor)))
        }}
        enabledAccounts={enabledAccounts}
        form={form}
        setForm={setForm}
        taskForm={taskForm}
        setTaskForm={setTaskForm}
        saving={saving}
        onClose={() => setShowEditor(false)}
        onSaveDraft={() => void saveDraft()}
        onSaveAndSend={() => void saveAndSend()}
        onImportFile={(file) => void importFile(file)}
      />
    )
  }

  return (
    <>
      <div className="toolbar">
        <p className="hint">一篇作品、一封邮件，收件人按作品类型匹配，每个平台只出一位编辑。</p>
        <div className="toolbar-actions">
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
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
        <div className="panel">
          <Table
            rowKey="id"
            dataSource={manuscripts}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            empty="还没有投稿计划"
            columns={[
              {
                key: 'title',
                title: '计划',
                render: (_value, m) => (
                  <>
                    <b>{m.title}</b>
                    <small>{[m.category, ...(m.genres ?? []).slice(0, 2)].filter(Boolean).join(' · ') || '未填写分类'}</small>
                  </>
                ),
              },
              {
                key: 'recipients',
                title: '收件人',
                width: 88,
                render: (_value, m) => {
                  const n = m.recipients.filter((r) => isValidEmail(r)).length
                  return n ? `${n} 家` : <span className="warn-text">未设置</span>
                },
              },
              {
                key: 'progress',
                title: '进度',
                width: 160,
                render: (_value, m) => {
                  const task = latestTask(m.id, tasks)
                  const n = m.recipients.filter((r) => isValidEmail(r)).length
                  const progress = planSendProgress(m, deliveries)
                  return task
                    ? <RuntimeTrack sent={progress.sent} total={progress.total || n} status={task.status}
                        meta={task.schedule_type === 'loop' ? `已成功 ${progress.sent} 封` : `${progress.sent} / ${progress.total || n || '—'}`} />
                    : <span className="hint">草稿</span>
                },
              },
              {
                key: 'status',
                title: '状态',
                width: 92,
                render: (_value, m) => {
                  const task = latestTask(m.id, tasks)
                  return task
                    ? <Badge tone={taskTone[task.status]} dot>{statusLabel(task.status)}</Badge>
                    : <Badge tone="neutral">草稿</Badge>
                },
              },
              {
                key: 'updated',
                title: '更新',
                width: 120,
                render: (_value, m) => formatTime(m.updated_at),
              },
              {
                key: 'actions',
                title: '',
                width: 220,
                render: (_value, m) => {
                  const task = latestTask(m.id, tasks)
                  return (
                    <div className="row-actions plan-row-actions">
                      <div className="plan-row-actions-text">
                        {task && ['stopped', 'completed', 'scheduled'].includes(task.status) && (
                          <Button size="sm" variant="primary" onClick={() => void startAgain(task)}>
                            {task.status === 'scheduled' ? '立即开始'
                              : task.status === 'completed' ? '重新发送'
                              : task.schedule_type === 'loop' ? (task.sent > 0 ? '重新循环' : '开始')
                              : task.sent > 0 ? '继续' : '开始'}
                          </Button>
                        )}
                        {task?.status === 'running' && <Button size="sm" onClick={() => void control(task.id, 'pause')}>暂停</Button>}
                        {task?.status === 'paused' && <Button size="sm" variant="primary" onClick={() => void control(task.id, 'resume')}>继续</Button>}
                        {task && ['running', 'paused'].includes(task.status) && <Button size="sm" onClick={() => void control(task.id, 'stop')}>停止</Button>}
                        <Button size="sm" onClick={() => void openDetail(m)}>记录</Button>
                        <Button size="sm" onClick={() => openEdit(m)}>编辑</Button>
                      </div>
                      <div className="plan-row-actions-icons">
                        <IconButton title="复制计划" onClick={() => openCopy(m)}><Copy size={15} /></IconButton>
                        <IconButton title="配置投稿邮箱" onClick={() => openAccountFor(m)}><Mail size={15} /></IconButton>
                        {!(task && ['running', 'paused'].includes(task.status)) && (
                          <IconButton title="删除" className="danger" onClick={() => void remove(m)}><Trash2 size={15} /></IconButton>
                        )}
                      </div>
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
          deliveries={deliveries}
          editors={editors}
          enabledAccounts={enabledAccounts}
          locked={(() => {
            const t = latestTask(detail.id, tasks)
            return Boolean(t && ['running', 'paused'].includes(t.status))
          })()}
          onChanged={() => void load()}
          onClose={() => setDetail(null)}
        />
      )}

      {accountFor && (
        <Modal title="配置投稿邮箱" width={560} onClose={() => setAccountFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAccountFor(null)}>取消</Button>
              <Button variant="primary" disabled={saving} onClick={() => void saveAccount()}>保存</Button>
            </>
          }>
          <p className="plan-acct-hint">为《{accountFor.title || '未命名'}》指定使用的投稿邮箱；留空表示使用全部启用邮箱。已发送的计划会同时更新对应的发送任务。</p>
          <div className="plan-acct-list">
            <div className="plan-acct-row">
              <div className="plan-accounts-list">
                {enabledAccounts.map((a) => {
                  const on = draftIds.includes(a.id)
                  return (
                    <label key={a.id} className={`plan-account-chip ${on ? 'on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleDraftAccount(a.id)} />
                      <span>{a.email}</span>
                    </label>
                  )
                })}
                {!enabledAccounts.length && <span className="hint">还没有启用邮箱，去「邮箱」页添加并启用</span>}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
