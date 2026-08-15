import { useCallback, useEffect, useState } from 'react'
import { Download, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { api, onLog } from '../api'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Select } from '../components/ui'
import { formatTime, logCategoryLabel, type Tone } from '../format'
import { useNav } from '../nav'
import type { Account, Task, TaskLog } from '../types'

const levelMeta: Record<string, { label: string; tone: Tone }> = {
  info: { label: '信息', tone: 'info' },
  success: { label: '成功', tone: 'success' },
  warning: { label: '警告', tone: 'warning' },
  error: { label: '失败', tone: 'danger' },
}

export function LogsView() {
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [taskFilter, setTaskFilter] = useState<number | ''>('')
  const [levelFilter, setLevelFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState('')
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = useCallback(async () => {
    try {
      const [l, t, a] = await Promise.all([api.listLogs(taskFilter || undefined), api.listTasks(), api.listAccounts()])
      setLogs(l); setTasks(t); setAccounts(a); setNotice('')
    } catch (e) { setNotice(String(e)) }
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

  const filtered = levelFilter ? logs.filter((l) => l.level === levelFilter) : logs
  const taskName = (id: number | null) => {
    if (!id) return '—'
    return tasks.find((t) => t.id === id)?.name ?? `#${id}`
  }
  const accountEmail = (id: number | null) =>
    id ? accounts.find((a) => a.id === id)?.email ?? '—' : '—'

  const toggleMsg = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 详情默认只展示前 6 个字，点击可展开/收起完整消息。
  const shortMessage = (msg: string) => {
    const chars = Array.from(msg)
    return chars.length > 6 ? `${chars.slice(0, 6).join('')}…` : msg
  }

  const exportLogs = async () => {
    try {
      const path = await api.exportLogs(taskFilter || undefined)
      toast(`已导出到 ${path}`, 'success')
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

      {!filtered.length ? (
        <div className="panel">
          <EmptyState icon={FileText} title="还没有发送记录"
            desc={tasks.length ? '计划开始后，每封邮件的结果会显示在这里。' : '创建计划并开始发送后，这里会出现结果。'}
            action={!tasks.length ? <Button variant="primary" onClick={() => go('plans')}>去创建计划</Button> : undefined} />
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>结果</th><th>计划</th><th>发件邮箱</th><th>编辑邮箱</th><th>类型</th><th>详情</th></tr></thead>
              <tbody>
                {filtered.map((log) => {
                  const meta = levelMeta[log.level] ?? levelMeta.info
                  const full = expanded.has(log.id)
                  return (
                    <tr key={log.id}>
                      <td className="mono">{formatTime(log.created_at)}</td>
                      <td><Badge tone={meta.tone} dot>{meta.label}</Badge></td>
                      <td>{taskName(log.task_id)}</td>
                      <td className="mono">{accountEmail(log.account_id)}</td>
                      <td className="mono">{log.recipient || '—'}</td>
                      <td>{logCategoryLabel[log.category] ?? log.category}</td>
                      <td className="log-msg" title={log.message} onClick={() => toggleMsg(log.id)}>
                        {full ? log.message : shortMessage(log.message)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
