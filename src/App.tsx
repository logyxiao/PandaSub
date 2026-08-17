import { useEffect, useState } from 'react'
import {
  BarChart3, ChevronLeft, ChevronRight, FileText, Inbox, Info, LayoutDashboard, ListChecks, Mail, Settings, Users,
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
import { AboutView } from './views/About'
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
      { id: 'about', label: '关于', icon: Info },
    ],
  },
]

export default function App() {
  const [active, setActive] = useState<ViewId>('dashboard')
  const [replyKind, setReplyKind] = useState<string | undefined>(undefined)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('novelsub.sidebar') === '1')
  const [hideChrome, setHideChrome] = useState(false)
  const [running, setRunning] = useState(0)
  const [engineError, setEngineError] = useState(false)

  useEffect(() => {
    let inFlight = false
    const refresh = () => {
      if (inFlight) return
      inFlight = true
      api.dashboard()
        .then((d) => { setRunning(d.running_tasks); setEngineError(false) })
        .catch(() => setEngineError(true))
        .finally(() => { inFlight = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 15000)
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
        <NavContext.Provider value={{
          go: (id, options) => {
            setHideChrome(false)
            setActive(id)
            setReplyKind(id === 'replies' ? options?.replyKind : undefined)
          },
          setChrome: setHideChrome,
        }}>
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
                        onClick={() => { setReplyKind(undefined); setActive(id) }}
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
              <div className={`page-body ${hideChrome ? 'is-flush' : ''}`}>
                {active === 'dashboard' && <DashboardView />}
                {active === 'plans' && <PlansView />}
                {active === 'logs' && <LogsView />}
                {active === 'replies' && <RepliesView initialKind={replyKind} />}
                {active === 'stats' && <StatsView />}
                {active === 'accounts' && <AccountsView />}
                {active === 'editors' && <EditorsView />}
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
