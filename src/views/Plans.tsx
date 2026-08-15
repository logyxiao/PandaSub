import { useEffect, useState } from 'react'
import { FileUp, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, onTask } from '../api'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, RuntimeTrack } from '../components/ui'
import { formatTime, fromDbTime, isValidEmail, parseRecipient, statusLabel, taskTone, toDbTime } from '../format'
import { useNav } from '../nav'
import type { Account, Delivery, Editor, Manuscript, ManuscriptInput, Settings, Task, TaskInput } from '../types'
import { PlanEditor } from './PlanEditor'
import { SendDetailModal } from './SendDetail'
import { categoryFromWords, countChars, defaultBody, defaultSubject, emptyManuscript, latestTask, toInput } from './planShared'

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
  const [detail, setDetail] = useState<Manuscript | null>(null)
  const [form, setForm] = useState<ManuscriptInput>(emptyManuscript)
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
    setForm(emptyManuscript)
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
      account_ids: task?.account_ids ?? [],
      schedule_type: task?.schedule_type ?? 'immediate',
      scheduled_at: task?.scheduled_at ?? null,
      retry_max: task?.retry_max ?? settings?.default_retry_max ?? 3,
    })
    setScheduledInput(task?.scheduled_at ? fromDbTime(task.scheduled_at) : '')
    setShowEditor(true)
  }

  const persistManuscript = async (payload: ManuscriptInput) => {
    if (!payload.title.trim()) { toast('请填写作品名称', 'warning'); return null }
    if (!payload.body.trim()) { toast('请填写邮件正文', 'warning'); return null }
    const next = { ...payload, word_count: payload.word_count || countChars(payload.body) }
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
    const sent = new Set(deliveries.map((d) => parseRecipient(d.recipient).email.toLowerCase()))
    // 默认跳过已投过的编辑。
    const sending = form.recipients.filter((r) => {
      if (!isValidEmail(r)) return false
      if (sent.has(parseRecipient(r).email.toLowerCase())) return false
      return true
    })
    if (!sending.length) { toast('去掉已投过的之后，没有可发的编辑了', 'warning'); return }
    if (taskForm.schedule_type === 'scheduled') {
      if (!scheduledInput) { toast('请选择发送时间', 'warning'); return }
      if (new Date(scheduledInput).getTime() <= Date.now()) { toast('定时时间必须晚于现在', 'warning'); return }
    }
    setSaving(true)
    try {
      const id = await persistManuscript({ ...form, recipients: sending })
      if (!id) return
      await api.createTask({
        ...taskForm,
        name: form.title.trim(),
        manuscript_ids: [id],
        scheduled_at: taskForm.schedule_type === 'scheduled' ? toDbTime(scheduledInput) : null,
      })
      if (sending.length !== form.recipients.length && taskForm.schedule_type !== 'scheduled') {
        await api.updateManuscript(id, { ...form, word_count: form.word_count || countChars(form.body) })
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
        const next = { ...f, title, file_name: file.name, word_count, category, content_type: 'text/plain' as const, file_data: Array.from(bytes) }
        return { ...next, subject: defaultSubject(next), body: defaultBody(next) }
      })
      toast('已读入作品，主题和正文已填好，文件将作为附件发送', 'success')
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

  if (showEditor) {
    return (
      <PlanEditor
        editing={editing}
        editors={editors}
        onReloadEditors={async () => { setEditors(await api.listEditors()) }}
        deliveries={deliveries}
        enabledAccounts={enabledAccounts}
        form={form}
        setForm={setForm}
        taskForm={taskForm}
        setTaskForm={setTaskForm}
        scheduledInput={scheduledInput}
        setScheduledInput={setScheduledInput}
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
      ) : (        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>计划</th><th>收件人</th><th>进度</th><th>状态</th><th>更新</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {manuscripts.map((m) => {
                  const task = latestTask(m.id, tasks)
                  const n = m.recipients.filter((r) => isValidEmail(r)).length
                  return (
                    <tr key={m.id}>
                      <td>
                        <b>{m.title}</b>
                        <small>{[m.category, m.reader_category, ...(m.genres ?? []).slice(0, 2)].filter(Boolean).join(' · ') || '未填写分类'}</small>
                      </td>
                      <td>{n ? `${n} 家` : <span className="warn-text">未设置</span>}</td>
                      <td style={{ minWidth: 140 }}>
                        {task
                          ? <RuntimeTrack sent={task.sent} total={task.total} status={task.status}
                              meta={task.schedule_type === 'loop' ? `已成功 ${task.sent} 封` : `${task.sent} / ${task.total || '—'}`} />
                          : <span className="hint">草稿</span>}
                      </td>
                      <td>
                        {task
                          ? <Badge tone={taskTone[task.status]} dot>{statusLabel(task.status)}</Badge>
                          : <Badge tone="neutral">草稿</Badge>}
                      </td>
                      <td>{formatTime(m.updated_at)}</td>
                      <td>
                        <div className="row-actions">
                          {task && ['stopped', 'completed', 'scheduled'].includes(task.status) && (
                            <Button size="sm" variant="primary" onClick={() => void startAgain(task)}>
                              {task.status === 'scheduled' ? '立即开始'
                                : task.status === 'completed' ? '重新发送'
                                : task.schedule_type === 'loop' ? (task.sent > 0 ? '重新循环' : '开始')
                                : task.sent > 0 ? '继续发送' : '开始'}
                            </Button>
                          )}
                          {task?.status === 'running' && <Button size="sm" onClick={() => void control(task.id, 'pause')}>暂停</Button>}
                          {task?.status === 'paused' && <Button size="sm" variant="primary" onClick={() => void control(task.id, 'resume')}>继续</Button>}
                          {task && ['running', 'paused'].includes(task.status) && <Button size="sm" onClick={() => void control(task.id, 'stop')}>停止</Button>}
                          <Button size="sm" onClick={() => void openDetail(m)}>发送详情</Button>
                          <Button size="sm" onClick={() => openEdit(m)}>编辑</Button>
                          {!(task && ['running', 'paused'].includes(task.status)) && (
                            <IconButton title="删除" className="danger" onClick={() => void remove(m)}><Trash2 size={15} /></IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
    </>
  )
}
