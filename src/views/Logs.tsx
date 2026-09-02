import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, RefreshCw, Search, Trash2 } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api, onLog } from '../api'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Select } from '../components/ui'
import { Table } from '../components/Table'
import { logCategoryLabel, type Tone } from '../format'
import { useNav } from '../nav'
import type { Account, Manuscript, Task, TaskLog } from '../types'

const levelMeta: Record<string, { label: string; tone: Tone }> = {
  info: { label: '信息', tone: 'info' },
  success: { label: '成功', tone: 'success' },
  warning: { label: '警告', tone: 'warning' },
  error: { label: '失败', tone: 'danger' },
}

function logTimeParts(value: string) {
  const date = new Date(`${value.replace(' ', 'T')}`)
  if (Number.isNaN(date.getTime())) return { day: '—', clock: '' }
  return {
    day: date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }),
    clock: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  }
}

export function LogsView() {
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [manuscripts, setManuscripts] = useState<Manuscript[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [taskFilter, setTaskFilter] = useState<number | ''>('')
  const [levelFilter, setLevelFilter] = useState<string>('')
  const [emailQuery, setEmailQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const requestSeq = useRef(0)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const [l, t, m, a] = await Promise.all([api.listLogs(taskFilter || undefined), api.listTasks(), api.listManuscripts(), api.listAccounts()])
      if (seq !== requestSeq.current) return
      setLogs(l); setTasks(t); setManuscripts(m); setAccounts(a); setNotice('')
    } catch (e) { if (seq === requestSeq.current) setNotice(String(e)) }
    finally { if (seq === requestSeq.current) setLoading(false) }
  }, [taskFilter])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    onLog((log) => {
      if (cancelled) return
      if (taskFilter && log.task_id !== taskFilter) return
      setLogs((prev) => (prev.some((x) => x.id === log.id) ? prev : [log, ...prev].slice(0, 300)))
    }).then((u) => {
      if (cancelled) u()
      else un = u
    })
    return () => {
      cancelled = true
      un?.()
    }
  }, [taskFilter])

  const accountEmail = (id: number | null) =>
    id ? accounts.find((a) => a.id === id)?.email ?? '—' : '—'

  const planName = (log: TaskLog) => {
    if (log.task_id) return tasks.find((task) => task.id === log.task_id)?.name ?? `#${log.task_id}`
    if (log.manuscript_id) return manuscripts.find((manuscript) => manuscript.id === log.manuscript_id)?.title ?? `#${log.manuscript_id}`
    return '—'
  }

  const filtered = useMemo(() => {
    const q = emailQuery.trim().toLowerCase()
    return logs.filter((l) => {
      if (levelFilter && l.level !== levelFilter) return false
      if (!q) return true
      const sender = (l.account_id ? accounts.find((a) => a.id === l.account_id)?.email ?? '' : '').toLowerCase()
      const recipient = (l.recipient ?? '').toLowerCase()
      return sender.includes(q) || recipient.includes(q)
    })
  }, [logs, levelFilter, emailQuery, accounts])

  const toggleMsg = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exportLogs = async () => {
    const path = await saveDialog({
      title: '导出投稿记录',
      defaultPath: '投稿记录.xlsx',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
    })
    if (!path) return
    try {
      const saved = await api.exportLogs(path, taskFilter || undefined)
      toast(`已导出到 ${saved}`, 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const clear = async () => {
    const ok = await confirm({
      title: '清空记录？',
      message: taskFilter ? '将清空当前这个计划的发送记录，无法恢复。' : '将清空全部发送记录，无法恢复。',
      confirmLabel: '清空',
      tone: 'danger',
    })
    if (!ok) return
    try { await api.clearLogs(taskFilter || undefined); await load(); toast('记录已清空', 'success') } catch (e) { toast(String(e), 'error') }
  }

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <label className="plan-search editor-search">
            <Search size={14} />
            <input value={emailQuery} onChange={(e) => setEmailQuery(e.target.value)} placeholder="搜索发件 / 编辑邮箱" />
          </label>
          <Select value={taskFilter} onChange={setTaskFilter} ariaLabel="按计划筛选" className="filter-select"
            options={[{ value: '' as const, label: '全部计划' }, ...tasks.map((t) => ({ value: t.id, label: t.name }))]} />
          <Select value={levelFilter} onChange={setLevelFilter} ariaLabel="按结果筛选" className="filter-select"
            options={[
              { value: '', label: '全部结果' },
              { value: 'success', label: '成功' },
              { value: 'warning', label: '警告' },
              { value: 'error', label: '失败' },
              { value: 'info', label: '信息' },
            ]} />
        </div>
        <div className="toolbar-actions">
          <Button variant="ghost" onClick={() => void exportLogs()}><Download size={15} />导出 Excel</Button>
          <Button variant="ghost" onClick={() => void clear()}><Trash2 size={15} />清空</Button>
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !filtered.length ? (
        <div className="panel">
          {logs.length ? (
            <EmptyState icon={Search} title="没有匹配的记录"
              desc="换个发件 / 编辑邮箱，或调整筛选条件试试。" />
          ) : (
            <EmptyState icon={FileText} title="还没有发送记录"
              desc={tasks.length ? '计划开始后，每封邮件的结果会显示在这里。' : '创建计划并开始发送后，这里会出现结果。'}
              action={!tasks.length ? <Button variant="primary" onClick={() => go('plans')}>去创建计划</Button> : undefined} />
          )}
        </div>
      ) : (
        <div className="panel">
          <Table
            className="logs-table"
            rowKey="id"
            dataSource={filtered}
            empty={loading ? '正在加载记录…' : '暂无记录'}
            resetKey={`${emailQuery}\0${taskFilter}\0${levelFilter}`}
            pagination={{ pageSize: 20 }}
            columns={[
              {
                key: 'time',
                title: '时间',
                width: 88,
                render: (_value, log) => {
                  const { day, clock } = logTimeParts(log.created_at)
                  return (
                    <>
                      <b>{day}</b>
                      <small>{clock || '—'}</small>
                    </>
                  )
                },
              },
              {
                key: 'level',
                title: '结果',
                width: 76,
                render: (_value, log) => {
                  const meta = levelMeta[log.level] ?? levelMeta.info
                  return <Badge tone={meta.tone} dot>{meta.label}</Badge>
                },
              },
              {
                key: 'task',
                title: '计划',
                width: 168,
                ellipsis: true,
                render: (_value, log) => planName(log),
              },
              {
                key: 'mail',
                title: '邮箱',
                width: 220,
                render: (_value, log) => {
                  const from = accountEmail(log.account_id)
                  const to = (log.recipient ?? '').trim() || '—'
                  return (
                    <>
                      <b title={from}>{from}</b>
                      <small title={to}>{to}</small>
                    </>
                  )
                },
              },
              {
                key: 'category',
                title: '类型',
                width: 64,
                render: (_value, log) => (
                  <span className="log-cat">{logCategoryLabel[log.category] ?? log.category}</span>
                ),
              },
              {
                key: 'message',
                title: '详情',
                className: 'log-msg-cell',
                render: (_value, log) => {
                  const open = expanded.has(log.id)
                  return (
                    <span
                      className={`log-msg ${open ? 'is-open' : ''}`}
                      title={open ? '点击收起' : log.message}
                      onClick={() => toggleMsg(log.id)}>
                      {log.message}
                    </span>
                  )
                },
              },
            ]}
          />
        </div>
      )}
    </>
  )
}
