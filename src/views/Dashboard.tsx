import { useEffect, useState } from 'react'
import { Activity, AlertCircle, ArrowRight, BookOpenText, CheckCircle2, CirclePause, CirclePlay, Inbox, Mail, RefreshCw, Square, UserRound, Users } from 'lucide-react'
import { api, onLog, onTask } from '../api'
import { formatClock, formatTime, statusLabel, taskTone } from '../format'
import { useNav } from '../nav'
import { useToast } from '../components/feedback'
import { Badge, Button, IconButton, RuntimeTrack } from '../components/ui'
import type { Dashboard, Task, TaskLog } from '../types'

const empty: Dashboard = {
  account_count: 0, manuscript_count: 0, editor_count: 0, sent_today: 0, failed_today: 0,
  running_tasks: 0, human_replies: 0, auto_replies: 0, tasks: [], logs: [],
}

export function DashboardView() {
  const [data, setData] = useState<Dashboard>(empty)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const toast = useToast()
  const { go } = useNav()

  const load = async () => {
    setLoading(true)
    try { setData(await api.dashboard()); setError('') }
    catch { setError('请用桌面应用启动（不要只开网页），才能连上本地数据。') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    let cancelled = false
    let un1: (() => void) | undefined
    let un2: (() => void) | undefined
    const seenLogIds = new Set<number>()
    onLog((log: TaskLog) => {
      if (cancelled || seenLogIds.has(log.id)) return
      seenLogIds.add(log.id)
      setData((d) => ({
        ...d,
        logs: [log, ...d.logs].slice(0, 50),
        sent_today: d.sent_today + (log.level === 'success' && log.category === 'send' ? 1 : 0),
        failed_today: d.failed_today + (log.level === 'error' && (log.category === 'network' || log.category === 'send') ? 1 : 0),
      }))
    }).then((u) => {
      if (cancelled) u()
      else un1 = u
    })
    onTask((task: Task) => {
      if (cancelled) return
      setData((d) => {
        const tasks = [task, ...d.tasks.filter((t) => t.id !== task.id)]
        const running = tasks.filter((t) => t.status === 'running').length
        return { ...d, tasks, running_tasks: running }
      })
    }).then((u) => {
      if (cancelled) u()
      else un2 = u
    })
    return () => {
      cancelled = true
      un1?.(); un2?.()
    }
  }, [])

  const control = async (id: number, action: 'pause' | 'resume' | 'stop') => {
    try {
      if (action === 'pause') await api.pauseTask(id)
      else if (action === 'resume') await api.resumeTask(id)
      else await api.stopTask(id)
    } catch (e) { toast(String(e), 'error') }
  }

  const stats: Array<{ label: string; value: number; unit: string; icon: typeof Mail; cls?: string; to: 'accounts' | 'editors' | 'plans' | 'logs' | 'replies' }> = [
    { label: '可用邮箱', value: data.account_count, unit: '个', icon: Mail, to: 'accounts' },
    { label: '编辑', value: data.editor_count, unit: '位', icon: Users, to: 'editors' },
    { label: '投稿计划', value: data.manuscript_count, unit: '个', icon: BookOpenText, to: 'plans' },
    { label: '发送中', value: data.running_tasks, unit: '个', icon: Activity, to: 'plans' },
    { label: '今日成功', value: data.sent_today, unit: '封', icon: CheckCircle2, cls: 'pos', to: 'logs' },
    { label: '今日失败', value: data.failed_today, unit: '封', icon: AlertCircle, cls: 'neg', to: 'logs' },
    { label: '人工回复', value: data.human_replies, unit: '封', icon: UserRound, cls: 'pos', to: 'replies' },
    { label: '自动回复', value: data.auto_replies, unit: '封', icon: Inbox, to: 'replies' },
  ]

  const activeTasks = data.tasks.filter((t) => t.status === 'running' || t.status === 'paused')
  const setupDone = data.account_count > 0 && data.manuscript_count > 0
  const nextStep = data.account_count === 0 ? 'accounts' as const
    : data.editor_count === 0 ? 'editors' as const
    : data.manuscript_count === 0 ? 'plans' as const
    : null

  return (
    <>
      {error && <div className="notice notice-error">{error}</div>}

      {!setupDone && !loading && !error && (
        <section className="setup-card" aria-label="开始使用">
          <div>
            <h2>按这几步开始投稿</h2>
            <p>先准备发件邮箱和常投编辑，再写投稿计划。保存后可以直接发送。</p>
          </div>
          <ol className="setup-steps">
            <li className={data.account_count > 0 ? 'done' : ''}>
              <button type="button" onClick={() => go('accounts')}>
                <span className="setup-index">{data.account_count > 0 ? '✓' : '1'}</span>
                <span>
                  <b>添加发件邮箱</b>
                  <small>{data.account_count > 0 ? `已有 ${data.account_count} 个可用` : 'QQ / 163 填授权码'}</small>
                </span>
              </button>
            </li>
            <li className={data.editor_count > 0 ? 'done' : ''}>
              <button type="button" onClick={() => go('editors')}>
                <span className="setup-index">{data.editor_count > 0 ? '✓' : '2'}</span>
                <span>
                  <b>添加常投编辑</b>
                  <small>{data.editor_count > 0 ? `已有 ${data.editor_count} 位` : '填邮箱、风格或作品类型即可'}</small>
                </span>
              </button>
            </li>
            <li className={data.manuscript_count > 0 ? 'done' : ''}>
              <button type="button" onClick={() => go('plans')}>
                <span className="setup-index">{data.manuscript_count > 0 ? '✓' : '3'}</span>
                <span>
                  <b>创建投稿计划</b>
                  <small>{data.manuscript_count > 0 ? `已有 ${data.manuscript_count} 个` : '按作品类型筛编辑'}</small>
                </span>
              </button>
            </li>
          </ol>
          {nextStep && (
            <Button variant="primary" onClick={() => go(nextStep)}>
              {nextStep === 'accounts' ? '去添加邮箱' : nextStep === 'editors' ? '去添加编辑' : '去创建计划'}
              <ArrowRight size={16} />
            </Button>
          )}
        </section>
      )}

      <section className="stat-strip" aria-label="今日概览">
        {stats.map(({ label, value, unit, icon: Icon, cls, to }) => (
          <button type="button" className="stat stat-click" key={label} onClick={() => go(to)}>
            <div className="stat-top">
              <span className="stat-label">{label}</span>
              <Icon size={16} className={`stat-icon ${cls === 'pos' ? 'success' : cls === 'neg' ? 'danger' : ''}`} />
            </div>
            <div className={`stat-value ${cls ?? ''}`}>{value}<small>{unit}</small></div>
          </button>
        ))}
      </section>

      {activeTasks.map((task) => (
        <div className="now-running" key={task.id}>
          <div className="nr-head">
            <p className="nr-title">{task.name}</p>
            <p className="nr-sub">{task.status === 'paused' ? '已暂停' : '正在发送'}</p>
          </div>
          <RuntimeTrack sent={task.sent} total={task.total} status={task.status}
            meta={task.schedule_type === 'loop' ? `已成功 ${task.sent} 封` : `${task.sent} / ${task.total || '—'}`} />
          <div className="nr-actions">
            {task.status === 'running' && <Button variant="ghost" onClick={() => void control(task.id, 'pause')}><CirclePause size={15} />暂停</Button>}
            {task.status === 'paused' && <Button variant="primary" onClick={() => void control(task.id, 'resume')}><CirclePlay size={15} />继续</Button>}
            <Button variant="ghost" onClick={() => void control(task.id, 'stop')}><Square size={13} />停止</Button>
          </div>
        </div>
      ))}

      <section className="workspace">
        <div className="panel">
          <div className="panel-heading">
            <div><h2>最近计划</h2><p>关掉窗口也不会中断正在发送的计划</p></div>
            <div className="heading-actions">
              <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
              <Button variant="ghost" onClick={() => go('plans')}>查看全部</Button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>计划</th><th>进度</th><th>状态</th><th>创建时间</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {data.tasks.map((task) => (
                  <tr key={task.id}>
                    <td><b>{task.name}</b><small>{task.schedule_type === 'loop' ? '循环发送' : task.schedule_type === 'scheduled' ? '定时发送' : '立即发送'}</small></td>
                    <td style={{ minWidth: 140 }}>
                      <RuntimeTrack sent={task.sent} total={task.total} status={task.status}
                        meta={task.schedule_type === 'loop' ? `已成功 ${task.sent} 封` : `${task.sent} / ${task.total || '—'}`} />
                    </td>
                    <td><Badge tone={taskTone[task.status]} dot>{statusLabel(task.status)}</Badge></td>
                    <td>{formatTime(task.created_at)}</td>
                    <td>
                      <div className="row-actions">
                        {task.status === 'running' && <Button size="sm" onClick={() => void control(task.id, 'pause')}>暂停</Button>}
                        {task.status === 'paused' && <Button size="sm" variant="primary" onClick={() => void control(task.id, 'resume')}>继续</Button>}
                        {(task.status === 'running' || task.status === 'paused') && <Button size="sm" onClick={() => void control(task.id, 'stop')}>停止</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {!data.tasks.length && (
                  <tr><td colSpan={5} className="empty">
                    {loading ? '正在读取…' : '还没有发送中的计划。到「投稿计划」里创建。'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <div><h2>最近记录</h2><p>后台正在发生的事</p></div>
            <span className="live"><i /> 实时</span>
          </div>
          <div className="logs">
            {data.logs.map((log) => (
              <div className="log" key={log.id}>
                <time>{formatClock(log.created_at)}</time><i className={log.level} /><p>{log.message}</p>
              </div>
            ))}
            {!data.logs.length && <p className="empty">还没有发送记录</p>}
          </div>
        </div>
      </section>
    </>
  )
}
