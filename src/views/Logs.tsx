import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FileText, RefreshCw, Search, Trash2 } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api, onLog } from '../api'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Pager, Select } from '../components/ui'
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
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(emailQuery); setPage(1) }, 200)
    return () => window.clearTimeout(timer)
  }, [emailQuery])
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
      const next = await api.listLogsPage(taskFilter, levelFilter, search, pageSize, (page - 1) * pageSize)
      if (seq !== requestSeq.current) return
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize))
      if (page > lastPage) { setPage(lastPage); return }
      setLogs(next.items); setTotal(next.total); setExpanded(new Set()); setNotice('')
    } catch (e) { if (seq === requestSeq.current) setNotice(String(e)) }
    finally { if (seq === requestSeq.current) setLoading(false) }
  }, [taskFilter, levelFilter, search, page, pageSize])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let cancelled = false
    void Promise.all([api.listTasks(), api.listManuscripts(), api.listAccounts()])
      .then(([t, m, a]) => { if (!cancelled) { setTasks(t); setManuscripts(m); setAccounts(a) } })
      .catch((e) => { if (!cancelled) setNotice(String(e)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let un: (() => void) | undefined
    const sequence = requestSeq
    onLog((log) => {
      if (cancelled || (taskFilter && log.task_id !== taskFilter)) return
      // Throttle rather than continuously postpone under a stream of log events.
      if (timer === undefined) timer = window.setTimeout(() => {
        timer = undefined
        if (!cancelled) void load()
      }, 200)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => { cancelled = true; window.clearTimeout(timer); un?.(); sequence.current++ }
  }, [taskFilter, load])

  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.email])), [accounts])
  const taskNames = useMemo(() => new Map(tasks.map((t) => [t.id, t.name])), [tasks])
  const manuscriptNames = useMemo(() => new Map(manuscripts.map((m) => [m.id, m.title])), [manuscripts])
  const accountEmail = (id: number | null) => id ? accountNames.get(id) ?? '—' : '—'
  const planName = (log: TaskLog) => {
    if (log.task_id) return taskNames.get(log.task_id) ?? `#${log.task_id}`
    if (log.manuscript_id) return manuscriptNames.get(log.manuscript_id) ?? `#${log.manuscript_id}`
    return '—'
  }

  const toggleMsg = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exportLogs = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const path = await saveDialog({
        title: '导出当前筛选的全部投稿记录', defaultPath: '投稿记录.xlsx',
        filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
      })
      if (!path) return
      const saved = await api.exportLogs(path, taskFilter || undefined, levelFilter, emailQuery.trim())
      toast(`已导出到 ${saved}`, 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setExporting(false) }
  }

  const clear = async () => {
    const ok = await confirm({
      title: '清空记录？',
      message: `${taskFilter ? '将清空当前计划的全部日志' : '将清空全部计划的日志'}，忽略结果和邮箱筛选。此操作不可撤销；投递历史、成功数量和去重记录保留，对应的失败统计会随日志清除。`,
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
          <Select value={taskFilter} onChange={(value) => { setTaskFilter(value); setPage(1) }} ariaLabel="按计划筛选" className="filter-select"
            options={[{ value: '' as const, label: '全部计划' }, ...tasks.map((t) => ({ value: t.id, label: t.name }))]} />
          <Select value={levelFilter} onChange={(value) => { setLevelFilter(value); setPage(1) }} ariaLabel="按结果筛选" className="filter-select"
            options={[
              { value: '', label: '全部结果' },
              { value: 'success', label: '成功' },
              { value: 'warning', label: '警告' },
              { value: 'error', label: '失败' },
              { value: 'info', label: '信息' },
            ]} />
        </div>
        <div className="toolbar-actions">
          <Button variant="ghost" disabled={exporting} onClick={() => void exportLogs()}><Download size={15} />{exporting ? '正在导出…' : '导出 Excel'}</Button>
          <Button variant="ghost" onClick={() => void clear()}><Trash2 size={15} />清空</Button>
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !logs.length ? (
        <div className="panel">
          {taskFilter || levelFilter || search.trim() ? (
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
            dataSource={logs}
            empty={loading ? '正在加载记录…' : '暂无记录'}
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
          <Pager page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} pageSize={pageSize}
            total={total} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1) }} />
        </div>
      )}
    </>
  )
}
