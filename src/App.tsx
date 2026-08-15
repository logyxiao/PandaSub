import { useEffect, useState } from 'react'
import {
  BarChart3, ChevronLeft, ChevronRight, FileText, Inbox, LayoutDashboard, ListChecks, Mail, Settings, Users,
} from 'lucide-react'
import logo from './assets/logo.png'
import './App.css'
import { api, onTask } from './api'
import { ConfirmProvider, ToastProvider } from './components/feedback'
import { NavContext, type ViewId } from './nav'
import { DashboardView } from './views/Dashboard'
import { AccountsView } from './views/Accounts'
import { PlansView } from './views/Plans'
import { LogsView } from './views/Logs'
import { RepliesView } from './views/Replies'
import { StatsView } from './views/Stats'
import { SettingsView } from './views/Settings'
import { EditorsView } from './views/Editors'

interface NavItem { id: ViewId; label: string; icon: typeof LayoutDashboard }

const groups: Array<{ label?: string; items: NavItem[] }> = [
  {
    items: [
      { id: 'dashboard', label: '工作台', icon: LayoutDashboard },
    ],
  },
  {
    label: '准备',
    items: [
      { id: 'accounts', label: '邮箱', icon: Mail },
      { id: 'editors', label: '编辑', icon: Users },
    ],
  },
  {
    label: '投递',
    items: [
      { id: 'plans', label: '投稿计划', icon: ListChecks },
      { id: 'logs', label: '记录', icon: FileText },
      { id: 'replies', label: '回复', icon: Inbox },
      { id: 'stats', label: '统计', icon: BarChart3 },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'settings', label: '设置', icon: Settings },
    ],
  },
]

const pageCopy: Record<ViewId, { title: string; sub: string }> = {
  dashboard: { title: '工作台', sub: '看今天发了多少、哪些计划在跑、下一步该做什么。' },
  accounts: { title: '邮箱', sub: '添加用来发稿的邮箱。QQ / 163 请填 SMTP 授权码，不是登录密码。' },
  editors: { title: '编辑', sub: '至少填邮箱和风格或作品类型。写计划时按风格和作品类型筛选要投的人。' },
  plans: { title: '投稿计划', sub: '写好作品和邮件，收件人按风格、作品类型从编辑库筛出。保存后可以直接发送。' },
  logs: { title: '记录', sub: '每封邮件的发送结果。失败时可以按计划筛选排查。' },
  replies: { title: '回复', sub: '检查收件箱，区分编辑人工回复、网站自动回复和退信。' },
  stats: { title: '统计', sub: '按日、周、月查看投递、回复与过稿情况。' },
  settings: { title: '设置', sub: '发送节奏、内容保护，以及备份。改完请点保存。' },
}

export default function App() {
  const [active, setActive] = useState<ViewId>('dashboard')
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('novelsub.sidebar') === '1')
  const [hideChrome, setHideChrome] = useState(false)
  const [running, setRunning] = useState(0)
  const [engineError, setEngineError] = useState(false)

  const current = pageCopy[active]

  useEffect(() => {
    const refresh = () => {
      api.dashboard()
        .then((d) => { setRunning(d.running_tasks); setEngineError(false) })
        .catch(() => setEngineError(true))
    }
    refresh()
    const timer = window.setInterval(refresh, 6000)
    let cancelled = false
    let un: (() => void) | undefined
    onTask(() => { if (!cancelled) refresh() }).then((u) => {
      if (cancelled) u()
      else un = u
    })
    return () => {
      cancelled = true
      window.clearInterval(timer)
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
        <NavContext.Provider value={{ go: (id) => { setHideChrome(false); setActive(id) }, setChrome: setHideChrome }}>
          <div className={`app-shell ${hideChrome ? 'focus-mode' : ''}`}>
            <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
              <div className="brand">
                <span className="brand-mark"><img className="brand-logo" src={logo} alt="" /></span>
                {!collapsed && <strong>熊猫投稿</strong>}
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
                      <button key={id} className={`nav-item ${active === id ? 'active' : ''}`}
                        onClick={() => setActive(id)}
                        title={collapsed ? label : undefined}
                        aria-current={active === id ? 'page' : undefined}>
                        <Icon size={18} />
                        {!collapsed && <span>{label}</span>}
                      </button>
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
              {!hideChrome && (
                <header className="page-head">
                  <div>
                    <h1 className="page-title">{current.title}</h1>
                    <p className="page-sub">{current.sub}</p>
                  </div>
                </header>
              )}
              <div className={`page-body ${hideChrome ? 'is-flush' : ''}`}>
                {active === 'dashboard' && <DashboardView />}
                {active === 'plans' && <PlansView />}
                {active === 'logs' && <LogsView />}
                {active === 'replies' && <RepliesView />}
                {active === 'stats' && <StatsView />}
                {active === 'accounts' && <AccountsView />}
                {active === 'editors' && <EditorsView />}
                {active === 'settings' && <SettingsView />}
              </div>
            </main>
          </div>
        </NavContext.Provider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
