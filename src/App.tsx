import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Award, BarChart3, ChevronLeft, ChevronRight, FileText, FolderOpen, Inbox, Info, LayoutDashboard, ListChecks, Mail, Plus, Settings, Users,
} from 'lucide-react'
import type { Account, Reply } from './types'
import logo from './assets/logo.png'
import './App.css'
import './panda.css'
import { api, onTask } from './api'
import { ConfirmProvider, ToastProvider } from './components/feedback'
import { UpdateManager } from './components/UpdateManager'
import { NavContext, type LeaveGuard, type NavOptions, type ViewId } from './nav'
import { DashboardView } from './views/Dashboard'
import { AccountsView } from './views/Accounts'
import { PlansView } from './views/Plans'
import { LogsView } from './views/Logs'
import { RepliesView } from './views/Replies'
import { StatsView } from './views/Stats'
import { AcceptedView } from './views/Accepted'
import { SettingsView } from './views/Settings'
import { AboutView } from './views/About'
import { EditorsView, EditorGroupsLibrary } from './views/Editors'

interface NavItem { id: ViewId; label: string; icon: typeof LayoutDashboard }

const groups: Array<{ label?: string; items: NavItem[] }> = [
  {
    items: [
      { id: 'dashboard', label: '工作台', icon: LayoutDashboard },
    ],
  },
  {
    label: '投稿准备',
    items: [
      { id: 'accounts', label: '邮箱管理', icon: Mail },
      { id: 'editors', label: '编辑库', icon: Users },
      { id: 'groups', label: '编辑组', icon: FolderOpen },
    ],
  },
  {
    label: '投递与跟进',
    items: [
      { id: 'plans', label: '投稿计划', icon: ListChecks },
      { id: 'logs', label: '发送记录', icon: FileText },
      { id: 'replies', label: '收件箱', icon: Inbox },
      { id: 'accepted', label: '过稿统计', icon: Award },
      { id: 'stats', label: '投稿统计', icon: BarChart3 },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'settings', label: '设置', icon: Settings },
      { id: 'about', label: '关于', icon: Info },
    ],
  },
]

const pageDescriptions: Record<ViewId, string> = {
  dashboard: '把好故事，送到合适的人手中。',
  plans: '管理作品内容、收稿名单与每一次投递。',
  replies: '集中查看各账号的来信，及时跟进投稿反馈。',
  logs: '查看每封邮件的发送结果，核对异常与失败记录。',
  stats: '回看投递与反馈，为下一次投稿积累经验。',
  accepted: '确认过稿作品，记录文稿与交易信息。',
  accounts: '管理发件身份、邮箱连接与回复检查。',
  editors: '快速维护邮箱、收稿类型和备注。常投名单在「编辑组」管理。',
  groups: '把常投编辑整理成名单；移出组不会删除编辑资料。',
  settings: '按照自己的使用习惯设置投稿工具。',
  about: '为创作者，少一点琐碎，多一点专注。',
}

export default function App() {
  const [active, setActive] = useState<ViewId>('dashboard')
  const [initialReply, setInitialReply] = useState<Reply | undefined>(undefined)
  const [replyKind, setReplyKind] = useState<string | undefined>(undefined)
  const [inboxAccount, setInboxAccount] = useState<number | ''>('')
  const [inboxAccounts, setInboxAccounts] = useState<Account[]>([])
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('novelsub.sidebar') === '1')
  const [hideChrome, setHideChrome] = useState(false)
  const [running, setRunning] = useState(0)
  const [engineError, setEngineError] = useState(false)
  const [planRequest, setPlanRequest] = useState(0)
  const leaveGuard = useRef<LeaveGuard | null>(null)
  const navigating = useRef(false)
  const setLeaveGuard = useCallback((guard: LeaveGuard | null) => { leaveGuard.current = guard }, [])
  const go = useCallback((id: ViewId, options?: NavOptions) => {
    if (navigating.current || (id === active && !options && !(id === 'replies' && inboxAccount !== ''))) return
    void (async () => {
      navigating.current = true
      try {
        if (leaveGuard.current && !await leaveGuard.current()) return
        leaveGuard.current = null
        setHideChrome(false)
        setActive(id)
        setReplyKind(id === 'replies' ? options?.replyKind : undefined)
        setInitialReply(id === 'replies' ? options?.reply : undefined)
        if (id === 'replies') {
          setInboxAccount(options?.accountId ?? '')
          if (collapsed && window.innerWidth > 880) setCollapsed(false)
        }
        if (id === 'plans' && options?.createPlan) setPlanRequest(n => n + 1)
        else if (id !== 'plans') setPlanRequest(0)
      } finally { navigating.current = false }
    })()
  }, [active, inboxAccount, collapsed])
  const navigation = useMemo(() => ({ go, setChrome: setHideChrome, setLeaveGuard }), [go, setLeaveGuard])
  const currentLabel = groups.flatMap(g => g.items).find(item => item.id === active)?.label ?? ''

  useEffect(() => {
    if (active !== 'replies') return
    let cancelled = false
    void api.listAccounts().then((accounts) => {
      if (!cancelled) setInboxAccounts(accounts)
    }).catch(() => { if (!cancelled) setInboxAccounts([]) })
    return () => { cancelled = true }
  }, [active])

  useEffect(() => {
    let inFlight = false
    let cancelled = false
    let pending = false
    let eventTimer: number | undefined
    const refresh = () => {
      if (cancelled) return
      if (inFlight) { pending = true; return }
      inFlight = true
      api.runningTaskCount()
        .then((count) => { if (!cancelled) { setRunning(count); setEngineError(false) } })
        .catch(() => { if (!cancelled) setEngineError(true) })
        .finally(() => { inFlight = false; if (pending) { pending = false; refresh() } })
    }
    refresh()
    const timer = window.setInterval(refresh, 15000)
    let un: (() => void) | undefined
    onTask(() => {
      if (!cancelled && eventTimer === undefined) eventTimer = window.setTimeout(() => {
        eventTimer = undefined; refresh()
      }, 200)
    }).then((u) => { if (cancelled) u(); else un = u })
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(eventTimer)
      un?.()
    }
  }, [])

  const toggleCollapse = () => {
    setCollapsed((c) => {
      localStorage.setItem('novelsub.sidebar', c ? '0' : '1')
      return !c
    })
  }

  const engineTone = engineError ? 'error' : running > 0 ? 'running' : ''
  const engineLabel = engineError
    ? '未连接后端'
    : running > 0
      ? `${running} 个计划发送中`
      : '空闲'

  return (
    <ToastProvider>
      <ConfirmProvider>
        <UpdateManager />
        <NavContext.Provider value={navigation}>
          <div className={`app-shell ${hideChrome ? 'focus-mode' : ''}`} data-density="compact">
            <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
              <div className="brand">
                <span className="brand-mark"><img className="brand-logo" src={logo} alt="" /></span>
                {!collapsed && <strong>熊猫投稿<small>PANDA POST</small></strong>}
                <button className="collapse-btn" onClick={toggleCollapse}
                  title={collapsed ? '展开侧栏' : '收起侧栏'} aria-label={collapsed ? '展开侧栏' : '收起侧栏'}>
                  {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
                </button>
              </div>
              <nav className="nav" aria-label="主导航">
                {groups.map((g, gi) => (
                  <div className="nav-group" key={g.label ?? `g-${gi}`}>
                    {!collapsed && g.label && <div className="nav-group-label">{g.label}</div>}
                    {g.items.map(({ id, label, icon: Icon }) => (
                      <div key={id} className="nav-entry">
                      <button className={`nav-item ${active === id ? 'active' : ''}`}
                        onClick={() => go(id)}
                        title={collapsed ? label : undefined} aria-label={label}
                        aria-current={active === id ? 'page' : undefined}>
                        <Icon size={18} />
                        {!collapsed && <span>{label}</span>}
                      </button>
                      {id === 'replies' && active === 'replies' && !collapsed && (
                        <div className="inbox-nav-accounts" role="group" aria-label="收件箱账号">
                          <button type="button" className={`inbox-nav-account ${inboxAccount === '' ? 'active' : ''}`}
                            aria-pressed={inboxAccount === ''} onClick={() => go('replies', { accountId: '' })}>
                            <Inbox size={13} /><span>全部账号</span>
                          </button>
                          {inboxAccounts.map((account) => (
                            <button type="button" key={account.id} title={account.email}
                              className={`inbox-nav-account ${inboxAccount === account.id ? 'active' : ''}`}
                              aria-pressed={inboxAccount === account.id} onClick={() => go('replies', { accountId: account.id })}>
                              <Mail size={13} /><span>{account.email}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      </div>
                    ))}
                  </div>
                ))}
              </nav>
              <div className="sidebar-foot">
                <div className={`engine ${engineTone}`} title="后台服务状态">
                  <i className="dot" />
                  {!collapsed && <span>{engineLabel}</span>}
                </div>
                {!collapsed && <div className="foot-meta">数据只存在这台电脑</div>}
              </div>
            </aside>

            <main className="main">
              <div data-view={active} className={`page-body ${hideChrome ? 'is-flush' : ''}`}>
                {!hideChrome && <div className="page-heading"><div><h1>{currentLabel}</h1><p>{pageDescriptions[active]}</p></div>
                  {active === 'dashboard' && <button className="btn btn-primary" onClick={() => go('plans', { createPlan: true })}><Plus size={16} />新建投稿计划</button>}
                </div>}
                {active === 'dashboard' && <DashboardView />}
                {active === 'plans' && <PlansView newPlanRequest={planRequest} />}
                {active === 'logs' && <LogsView />}
                {active === 'replies' && <RepliesView initialKind={replyKind} initialReply={initialReply}
                  accountFilter={inboxAccount} onAccountChange={(accountId) => go('replies', { accountId })} />}
                {active === 'stats' && <StatsView />}
                {active === 'accepted' && <AcceptedView />}
                {active === 'accounts' && <AccountsView />}
                {active === 'editors' && <EditorsView />}
                {active === 'groups' && <EditorGroupsLibrary />}
                {active === 'settings' && <SettingsView />}
                {active === 'about' && <AboutView />}
              </div>
            </main>
          </div>
        </NavContext.Provider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
