import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertCircle, ArrowRight, BookOpenText, CheckCircle2, CirclePause, CirclePlay, Inbox, Mail, RefreshCw, Square, UserRound, Users } from 'lucide-react'
import { api, onLog, onReply, onTask } from '../api'
import { formatTime, replyKindLabel, replyKindTone } from '../format'
import { useNav } from '../nav'
import { useToast } from '../components/feedback'
import { Badge, Button, IconButton, RuntimeTrack, Select } from '../components/ui'
import { Table } from '../components/Table'
import type { Dashboard } from '../types'

const empty: Dashboard = {
  account_count: 0, manuscript_count: 0, editor_count: 0, sent_today: 0, failed_today: 0,
  running_tasks: 0, human_replies: 0, auto_replies: 0, accepted_replies: 0, tasks: [], recent_replies: [],
}

export function DashboardView() {
  const [data, setData] = useState<Dashboard>(empty)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [replyKind, setReplyKind] = useState('human')
  const toast = useToast()
  const { go } = useNav()

  const requestSeq = useRef(0)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const pending = useRef(false)
  const load = useCallback(async function refresh(silent = false) {
    if (!mounted.current) return
    if (inFlight.current) { pending.current = true; return }
    inFlight.current = true
    const seq = ++requestSeq.current
    if (!silent) setLoading(true)
    try {
      const snapshot = await api.dashboard()
      if (seq === requestSeq.current) { setData(snapshot); setError('') }
    } catch (e) { if (seq === requestSeq.current) setError(String(e)) }
    finally {
      inFlight.current = false
      if (seq === requestSeq.current) setLoading(false)
      if (mounted.current && pending.current) { pending.current = false; void refresh(true) }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    let cancelled = false
    let timer: number | undefined
    const sequence = requestSeq
    const unlisteners: Array<() => void> = []
    const schedule = () => {
      if (cancelled) return
      // Coalesce events into a persisted snapshot, without additive counters or
      // overlapping queries when a large database takes longer than the throttle.
      if (timer === undefined) timer = window.setTimeout(() => {
        timer = undefined
        if (!cancelled) void load(true)
      }, 200)
    }
    for (const subscribe of [onLog, onTask, onReply]) {
      void subscribe(schedule).then((un) => { if (cancelled) un(); else unlisteners.push(un) })
    }
    const interval = window.setInterval(schedule, 60_000)
    return () => {
      cancelled = true; mounted.current = false; pending.current = false; sequence.current++
      window.clearTimeout(timer); window.clearInterval(interval)
      unlisteners.forEach((un) => un())
    }
  }, [load])

  const control = async (id: number, action: 'pause' | 'resume' | 'stop') => {
    try {
      if (action === 'pause') await api.pauseTask(id)
      else if (action === 'resume') await api.resumeTask(id)
      else await api.stopTask(id)
    } catch (e) { toast(String(e), 'error') }
  }

  const stats: Array<{ label: string; value: number; unit: string; icon: typeof Mail; cls?: string; to: 'accounts' | 'editors' | 'plans' | 'logs' | 'replies'; replyKind?: string }> = [
    { label: '可用邮箱', value: data.account_count, unit: '个', icon: Mail, to: 'accounts' },
    { label: '编辑', value: data.editor_count, unit: '位', icon: Users, to: 'editors' },
    { label: '投稿计划', value: data.manuscript_count, unit: '个', icon: BookOpenText, to: 'plans' },
    { label: '发送中', value: data.running_tasks, unit: '个', icon: Activity, to: 'plans' },
    { label: '今日成功', value: data.sent_today, unit: '封', icon: CheckCircle2, cls: 'pos', to: 'logs' },
    { label: '今日失败', value: data.failed_today, unit: '封', icon: AlertCircle, cls: 'neg', to: 'logs' },
    { label: '人工回复', value: data.human_replies, unit: '封', icon: UserRound, cls: 'pos', to: 'replies', replyKind: 'human' },
    { label: '自动回复', value: data.auto_replies, unit: '封', icon: Inbox, to: 'replies', replyKind: 'auto' },
    { label: '过稿回复', value: data.accepted_replies, unit: '封', icon: CheckCircle2, cls: 'pos', to: 'replies', replyKind: 'accepted' },
  ]

  const activeTasks = data.tasks.filter((t) => t.status === 'running' || t.status === 'paused')
  const recentReplies = useMemo(() => data.recent_replies.filter((reply) => (
    replyKind === 'accepted' ? reply.accepted : replyKind ? reply.kind === replyKind : true
  )), [data.recent_replies, replyKind])
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
                  <small>{data.editor_count > 0 ? `已有 ${data.editor_count} 位` : '填邮箱和作品类型即可'}</small>
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
        {stats.map(({ label, value, unit, icon: Icon, cls, to, replyKind: targetReplyKind }) => (
          <button type="button" className="stat stat-click" key={label} onClick={() => void go(to, targetReplyKind ? { replyKind: targetReplyKind } : undefined)}>
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
        <div className="panel dashboard-replies-panel">
          <div className="panel-heading">
            <div><h2>最近回复</h2><p>默认展示人工回复，可切换其他类型</p></div>
            <div className="heading-actions">
              <Select value={replyKind} onChange={setReplyKind} ariaLabel="回复类型" className="filter-select"
                options={[
                  { value: 'human', label: '人工回复' },
                  { value: 'accepted', label: '过稿回复' },
                  { value: 'auto', label: '自动回复' },
                  { value: 'bounce', label: '退信' },
                  { value: '', label: '全部回复' },
                ]} />
              <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
              <Button variant="ghost" onClick={() => go('replies')}>查看全部</Button>
            </div>
          </div>
          <Table
            rowKey="id"
            dataSource={recentReplies}
            empty={loading ? '正在读取…' : '没有符合条件的回复。'}
            columns={[
              {
                key: 'kind',
                title: '类型',
                width: 104,
                render: (_value, reply) => (
                  <Badge tone={reply.accepted ? 'success' : (replyKindTone[reply.kind] ?? 'neutral')} dot>
                    {reply.accepted ? '过稿回复' : (replyKindLabel[reply.kind] ?? reply.kind)}
                  </Badge>
                ),
              },
              {
                key: 'body',
                title: '回复内容',
                ellipsis: { rows: 2 },
                render: (_value, reply) => reply.body || reply.snippet || '（无正文）',
              },
              {
                key: 'delivery',
                title: '来源 / 计划',
                width: 240,
                render: (_value, reply) => (
                  <div className="reply-delivery">
                    <b title={reply.from_email}>{reply.from_email || '—'}</b>
                    <small title={reply.task_name}>{reply.task_name || '未关联计划'}</small>
                  </div>
                ),
              },
              {
                key: 'time',
                title: '时间',
                width: 120,
                render: (_value, reply) => formatTime(reply.received_at),
              },
            ]}
          />
        </div>
      </section>
    </>
  )
}
