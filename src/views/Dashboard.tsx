import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  Inbox,
  Mail,
  RefreshCw,
  Send,
  Square,
  UserRound,
  Users,
} from 'lucide-react'
import { api, onLog, onReply, onTask } from '../api'
import {
  formatTime,
  replyKindLabel,
  replyKindTone,
  statusLabel,
} from '../format'
import { useNav } from '../nav'
import { useToast } from '../components/feedback'
import {
  Badge,
  Button,
  IconButton,
  RuntimeTrack,
  Select,
} from '../components/ui'
import { DashboardTrend } from './DashboardTrend'
import type { Dashboard } from '../types'

const empty: Dashboard = {
  account_count: 0,
  manuscript_count: 0,
  editor_count: 0,
  sent_today: 0,
  failed_today: 0,
  running_tasks: 0,
  human_replies: 0,
  auto_replies: 0,
  accepted_replies: 0,
  tasks: [],
  recent_replies: [],
}

export function DashboardView() {
  const [data, setData] = useState<Dashboard>(empty)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [replyKind, setReplyKind] = useState('')
  const [revision, setRevision] = useState(0)
  const [taskId, setTaskId] = useState<number | null>(null)
  const [controlling, setControlling] = useState(false)
  const controlBusy = useRef(false)
  const toast = useToast()
  const { go } = useNav()

  const requestSeq = useRef(0)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const pending = useRef(false)
  const load = useCallback(async function refresh(silent = false) {
    if (!mounted.current) return
    if (inFlight.current) {
      pending.current = true
      return
    }
    inFlight.current = true
    const seq = ++requestSeq.current
    if (!silent) setLoading(true)
    try {
      const snapshot = await api.dashboard()
      if (seq === requestSeq.current) {
        setData(snapshot)
        setError('')
        setRevision((value) => value + 1)
      }
    } catch (e) {
      if (seq === requestSeq.current) setError(String(e))
    } finally {
      inFlight.current = false
      if (seq === requestSeq.current) setLoading(false)
      if (mounted.current && pending.current) {
        pending.current = false
        void refresh(true)
      }
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
      if (timer === undefined)
        timer = window.setTimeout(() => {
          timer = undefined
          if (!cancelled) void load(true)
        }, 200)
    }
    for (const subscribe of [onLog, onTask, onReply]) {
      void subscribe(schedule).then((un) => {
        if (cancelled) un()
        else unlisteners.push(un)
      })
    }
    const interval = window.setInterval(schedule, 60_000)
    return () => {
      cancelled = true
      mounted.current = false
      pending.current = false
      sequence.current++
      window.clearTimeout(timer)
      window.clearInterval(interval)
      unlisteners.forEach((un) => un())
    }
  }, [load])

  const control = async (id: number, action: 'pause' | 'resume' | 'stop') => {
    if (controlBusy.current) return
    controlBusy.current = true
    setControlling(true)
    try {
      if (action === 'pause') await api.pauseTask(id)
      else if (action === 'resume') await api.resumeTask(id)
      else await api.stopTask(id)
      void load(true)
    } catch (e) {
      toast(String(e), 'error')
    } finally {
      controlBusy.current = false
      setControlling(false)
    }
  }

  const stats = [
    {
      label: '今日成功',
      value: data.sent_today,
      unit: '封',
      icon: Send,
      to: 'logs' as const,
      note: data.failed_today
        ? `今日另有 ${data.failed_today} 条失败记录`
        : '今天已成功发出的投稿邮件',
    },
    {
      label: '作品与计划',
      value: data.manuscript_count,
      unit: '篇',
      icon: BookOpenText,
      to: 'plans' as const,
      note: '管理作品、收稿名单与投递安排',
    },
    {
      label: '编辑资料库',
      value: data.editor_count,
      unit: '位',
      icon: Users,
      to: 'editors' as const,
      note: '维护收稿方向与常投编辑',
    },
    {
      label: '发件邮箱',
      value: data.account_count,
      unit: '个',
      icon: Mail,
      to: 'accounts' as const,
      note: '已启用的投稿邮箱',
    },
  ]

  const activeTasks = data.tasks.filter(
    (t) => t.status === 'running' || t.status === 'paused',
  )
  const activeTask =
    activeTasks.find((task) => task.id === taskId) ?? activeTasks[0]
  const recentReplies = useMemo(
    () =>
      data.recent_replies.filter((reply) =>
        replyKind === 'accepted'
          ? reply.accepted
          : replyKind
            ? reply.kind === replyKind
            : true,
      ),
    [data.recent_replies, replyKind],
  )
  const setupDone = data.account_count > 0 && data.manuscript_count > 0
  const nextStep =
    data.account_count === 0
      ? ('accounts' as const)
      : data.editor_count === 0
        ? ('editors' as const)
        : data.manuscript_count === 0
          ? ('plans' as const)
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
                <span className="setup-index">
                  {data.account_count > 0 ? '✓' : '1'}
                </span>
                <span>
                  <b>添加发件邮箱</b>
                  <small>
                    {data.account_count > 0
                      ? `已有 ${data.account_count} 个可用`
                      : 'QQ / 163 填授权码'}
                  </small>
                </span>
              </button>
            </li>
            <li className={data.editor_count > 0 ? 'done' : ''}>
              <button type="button" onClick={() => go('editors')}>
                <span className="setup-index">
                  {data.editor_count > 0 ? '✓' : '2'}
                </span>
                <span>
                  <b>添加常投编辑</b>
                  <small>
                    {data.editor_count > 0
                      ? `已有 ${data.editor_count} 位`
                      : '填邮箱和作品类型即可'}
                  </small>
                </span>
              </button>
            </li>
            <li className={data.manuscript_count > 0 ? 'done' : ''}>
              <button type="button" onClick={() => go('plans')}>
                <span className="setup-index">
                  {data.manuscript_count > 0 ? '✓' : '3'}
                </span>
                <span>
                  <b>创建投稿计划</b>
                  <small>
                    {data.manuscript_count > 0
                      ? `已有 ${data.manuscript_count} 个`
                      : '按作品类型筛编辑'}
                  </small>
                </span>
              </button>
            </li>
          </ol>
          {nextStep && (
            <Button variant="primary" onClick={() => go(nextStep)}>
              {nextStep === 'accounts'
                ? '去添加邮箱'
                : nextStep === 'editors'
                  ? '去添加编辑'
                  : '去创建计划'}
              <ArrowRight size={16} />
            </Button>
          )}
        </section>
      )}

      <div className="dashboard-reference">
        <section className="stat-strip" aria-label="今日概览">
          {stats.map(({ label, value, unit, icon: Icon, to, note }) => (
            <button
              type="button"
              className="stat stat-click"
              key={label}
              onClick={() => go(to)}
            >
              <div className="stat-top">
                <span className="stat-label">{label}</span>
                <span className="dashboard-metric-icon">
                  <Icon size={17} />
                </span>
              </div>
              <div className="stat-value">
                {loading ? '—' : value}
                <small>{unit}</small>
              </div>
              <span className="dashboard-metric-note">{note}</span>
            </button>
          ))}
        </section>
        <div className="dashboard-reference-upper">
          <section className="panel dashboard-live-panel">
            <div className="panel-heading">
              <div className="dashboard-section-title">
                <h2>正在投递</h2>
                {activeTasks.length > 1 ? (
                  <div className="dashboard-other-tasks">
                    <Select
                      value={activeTask?.id ?? activeTasks[0].id}
                      onChange={setTaskId}
                      ariaLabel="切换投递计划"
                      options={activeTasks.map((task) => ({
                        value: task.id,
                        label: `${task.name} · ${statusLabel(task.status)}`,
                      }))}
                    />
                  </div>
                ) : (
                  <span className="dashboard-count">
                    {activeTasks.length} 个计划
                  </span>
                )}
              </div>
              <Button variant="subtle" size="sm" onClick={() => go('plans')}>
                查看全部
                <ArrowRight size={13} />
              </Button>
            </div>
            {activeTask ? (
              <div className="dashboard-live">
                <div className="dashboard-live-top">
                  <span className="dashboard-book">
                    <BookOpenText size={20} />
                  </span>
                  <div>
                    <h3>{activeTask.name}</h3>
                    <small>
                      {activeTask.schedule_type === 'loop'
                        ? '循环投递'
                        : '单次投递'}{' '}
                      · {activeTask.total} 个投递目标
                    </small>
                  </div>
                  <Badge
                    tone={activeTask.status === 'paused' ? 'warning' : 'brand'}
                    dot
                  >
                    {statusLabel(activeTask.status)}
                  </Badge>
                </div>
                <RuntimeTrack
                  sent={activeTask.sent}
                  total={activeTask.total}
                  status={activeTask.status}
                  meta={
                    activeTask.schedule_type === 'loop'
                      ? `已成功 ${activeTask.sent} 封`
                      : `${activeTask.sent} / ${activeTask.total || '—'}`
                  }
                />
                <div className="dashboard-live-bottom">
                  <span>
                    {activeTask.status === 'paused'
                      ? '计划已暂停，可继续投递'
                      : '正在按照计划设置的间隔投递'}
                  </span>
                  <div>
                    {activeTask.status === 'running' ? (
                      <Button
                        size="sm"
                        disabled={controlling}
                        onClick={() => void control(activeTask.id, 'pause')}
                      >
                        <CirclePause size={13} />
                        暂停
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={controlling}
                        onClick={() => void control(activeTask.id, 'resume')}
                      >
                        <CirclePlay size={13} />
                        继续
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={controlling}
                      onClick={() => void control(activeTask.id, 'stop')}
                    >
                      <Square size={12} />
                      停止
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="dashboard-live-empty">
                <Send size={23} />
                <div>
                  <b>{loading ? '正在读取计划…' : '当前没有正在投递的计划'}</b>
                  <p>准备好作品后，即可开始下一次投稿。</p>
                </div>
                <Button size="sm" onClick={() => go('plans')}>
                  查看计划
                </Button>
              </div>
            )}
          </section>
          <section className="panel dashboard-attention-panel">
            <div className="panel-heading">
              <h2>需要关注</h2>
              <span className="hint">及时跟进投稿反馈</span>
            </div>
            <div className="dashboard-attention-list">
              <button onClick={() => go('logs')}>
                <span className="dashboard-attention-icon rose">
                  <AlertCircle size={17} />
                </span>
                <span>
                  <b>{data.failed_today} 条今日失败记录</b>
                  <small>核对发送结果与异常原因</small>
                </span>
                <ArrowRight size={14} />
              </button>
              <button onClick={() => go('replies', { replyKind: 'human' })}>
                <span className="dashboard-attention-icon amber">
                  <UserRound size={17} />
                </span>
                <span>
                  <b>累计 {data.human_replies} 封人工回复</b>
                  <small>查看编辑意见，跟进投稿进展</small>
                </span>
                <ArrowRight size={14} />
              </button>
              <button onClick={() => go('replies', { replyKind: 'accepted' })}>
                <span className="dashboard-attention-icon mint">
                  <CheckCircle2 size={17} />
                </span>
                <span>
                  <b>累计 {data.accepted_replies} 封过稿回复</b>
                  <small>按回复判定规则识别</small>
                </span>
                <ArrowRight size={14} />
              </button>
            </div>
          </section>
        </div>
        <div className="dashboard-reference-lower">
          <DashboardTrend revision={revision} />
          <section className="panel dashboard-latest-panel">
            <div className="panel-heading">
              <h2>最新回复</h2>
              <div className="heading-actions">
                <Select
                  value={replyKind}
                  onChange={setReplyKind}
                  ariaLabel="回复类型"
                  options={[
                    { value: '', label: '全部回复' },
                    { value: 'human', label: '人工回复' },
                    { value: 'accepted', label: '过稿回复' },
                    { value: 'auto', label: '自动回复' },
                    { value: 'bounce', label: '退信' },
                  ]}
                />
                <IconButton title="刷新工作台" onClick={() => void load(true)}>
                  <RefreshCw size={14} />
                </IconButton>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => go('replies')}
                >
                  全部回复
                  <ArrowRight size={13} />
                </Button>
              </div>
            </div>
            <div className="dashboard-reply-list">
              {recentReplies.slice(0, 3).map((reply) => (
                <button
                  type="button"
                  key={reply.id}
                  onClick={() => go('replies', { replyKind, reply })}
                >
                  <span className="dashboard-reply-avatar">
                    <Inbox size={16} />
                  </span>
                  <span className="dashboard-reply-copy">
                    <span className="dashboard-reply-top">
                      <b>{reply.from_email || '未填写发件人'}</b>
                      <time>{formatTime(reply.received_at)}</time>
                    </span>
                    <p>{reply.body || reply.snippet || '（无正文）'}</p>
                    <span className="dashboard-reply-source">
                      <Badge
                        tone={
                          reply.accepted
                            ? 'success'
                            : (replyKindTone[reply.kind] ?? 'neutral')
                        }
                      >
                        {reply.accepted
                          ? '过稿回复'
                          : (replyKindLabel[reply.kind] ?? reply.kind)}
                      </Badge>
                      <small>{reply.task_name || '未关联计划'}</small>
                    </span>
                  </span>
                </button>
              ))}
              {!recentReplies.length && (
                <p className="dashboard-empty">
                  {loading ? '正在读取回复…' : '暂无符合条件的回复'}
                </p>
              )}
            </div>
          </section>
        </div>
        <section className="panel dashboard-recent-panel">
          <div className="panel-heading">
            <h2>最近投稿计划</h2>
            <Button variant="subtle" size="sm" onClick={() => go('plans')}>
              全部计划
              <ArrowRight size={13} />
            </Button>
          </div>
          <div className="dashboard-recent-table-wrap">
            <table className="dashboard-recent-table">
              <thead>
                <tr>
                  <th>计划名称</th>
                  <th>计划状态</th>
                  <th>投递进度</th>
                  <th>最近活动</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.tasks.slice(0, 3).map((task) => (
                  <tr key={task.id}>
                    <td>
                      <span className="dashboard-table-title">
                        <BookOpenText size={17} />
                        <b>{task.name}</b>
                      </span>
                    </td>
                    <td>
                      <Badge
                        tone={
                          task.status === 'completed'
                            ? 'success'
                            : task.status === 'running'
                              ? 'brand'
                              : 'neutral'
                        }
                      >
                        {statusLabel(task.status)}
                      </Badge>
                    </td>
                    <td>
                      <RuntimeTrack
                        sent={task.sent}
                        total={task.total}
                        status={task.status}
                      />
                    </td>
                    <td>
                      {formatTime(
                        task.finished_at || task.started_at || task.created_at,
                      )}
                    </td>
                    <td>
                      <button className="text-link" onClick={() => go('plans')}>
                        查看计划
                      </button>
                    </td>
                  </tr>
                ))}
                {!data.tasks.length && (
                  <tr>
                    <td colSpan={5} className="dashboard-empty">
                      {loading
                        ? '正在读取…'
                        : '尚无投递记录，可以从新建投稿计划开始。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  )
}
