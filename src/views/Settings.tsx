import { StorageManager } from '../components/StorageManager'
import { useRequestGuard } from '../hooks/useRequestGuard'
import { useBusyAction } from '../hooks/useBusyAction'
import { applyPreparedUpdate, runUpdateFlow, useUpdateFlow } from '../lib/updateFlow'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Check, Coffee, DatabaseBackup, Download, Inbox, Palette, Power, RefreshCw, Save, Send, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { SupportAuthor } from '../components/SupportAuthor'
import { useConfirm, useToast } from '../components/feedback'
import { Button, Switch } from '../components/ui'
import type { Settings } from '../types'
import { currentVersion } from '../update'
import { useNav } from '../nav'
import { setTheme, themes, useTheme } from '../theme'

const defaults: Settings = {
  default_retry_max: 3,
  anti_spam_mutation: true, auto_start: false, close_to_tray: true, auto_backup: false,
  update_feed_url: '', reply_poll_minutes: 2,
  auto_reply_subject_keywords: ['自动回复', '自動回覆', 'AutoReply', 'Auto-Reply'],
}

const sections = [
  { id: 'theme', label: '主题', icon: Palette },
  { id: 'send', label: '发送', icon: Send },
  { id: 'guard', label: '内容保护', icon: ShieldCheck },
  { id: 'replies', label: '回复检查', icon: Inbox },
  { id: 'system', label: '开关机', icon: Power },
  { id: 'data', label: '备份与空间', icon: DatabaseBackup },
  { id: 'update', label: '更新', icon: RefreshCw },
  { id: 'support', label: '支持作者', icon: Coffee },
] as const

type SectionId = typeof sections[number]['id']

export function SettingsView() {
  const [form, setForm] = useState<Settings>(defaults)
  const [saved, setSaved] = useState<Settings>(defaults)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const requests = useRequestGuard()
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const [notice, setNotice] = useState('')
  const [version, setVersion] = useState('')
  const [versionError, setVersionError] = useState(false)
  const { state: updateState, progress: updateProgress } = useUpdateFlow()
  const backupAction = useBusyAction()
  const autostartAction = useBusyAction()
  const [section, setSection] = useState<SectionId>('theme')
  const theme = useTheme()
  const toast = useToast()
  const confirm = useConfirm()
  const { restart } = useNav()

  const load = useCallback(async () => {
    const request = requests.begin()
    setLoading(true); setNotice('')
    try {
      const settings = await api.getSettings()
      if (requests.isCurrent(request)) { setForm(settings); setSaved(settings); setLoaded(true) }
    } catch (error) { if (requests.isCurrent(request)) setNotice(String(error)) }
    finally { if (requests.isCurrent(request)) setLoading(false) }
  }, [requests])
  useEffect(() => { void load() }, [load])
  useEffect(() => { currentVersion().then(setVersion).catch(() => setVersionError(true)) }, [])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved])

  useUnsavedChanges(dirty, saving || autostartAction.busy, '设置尚未保存，继续会丢弃修改。')
  const save = async () => {
    if (busy.current || !loaded || autostartAction.busy) return
    busy.current = true; setSaving(true)
    try {
      await api.updateSettings(form)
      setSaved(form)
      toast('设置已保存', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { busy.current = false; setSaving(false) }
  }

  const toggleAutostart = async (enabled: boolean) => {
    try {
      await api.setAutostart(enabled)
      setForm(current => ({ ...current, auto_start: enabled }))
      setSaved((s) => ({ ...s, auto_start: enabled }))
      toast(enabled ? '已开启开机自启' : '已关闭开机自启', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const backup = () => backupAction.run(async () => {
    try { toast(`已备份到 ${await api.backup()}`, 'success') } catch (e) { toast(String(e), 'error') }
  })

  const checkUpdate = () => runUpdateFlow(confirm, toast, restart)

  const num = (key: keyof Settings) => ({
    value: form[key] as number,
    disabled: !loaded || saving,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(e.target.value) }),
  })

  return (
    <>
      <div className="toolbar">
        <p className="hint">{dirty ? '有未保存的修改。' : section === 'theme' ? '主题切换后立即生效，并自动保存到本机。' : '新计划默认在 100–240 秒之间随机等待，也可以为每个计划自定义秒数区间。'}</p>
        <div className="toolbar-actions">
          <Button variant="primary" disabled={!dirty || saving || !loaded || autostartAction.busy} onClick={() => void save()}><Save size={15} />保存设置</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error" role="alert">{notice}<Button size="sm" disabled={loading} onClick={() => void load()}>重新读取设置</Button></div>}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分组">
          {sections.map(({ id, label, icon: Icon }) => (
            <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}
              aria-current={section === id ? 'page' : undefined}>
              <Icon size={16} />{label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'theme' && (
            <section className="panel settings-section" aria-label="主题设置">
              <div className="panel-heading"><div><h2>主题</h2><p>选择喜欢的配色，整个应用会一起切换。</p></div></div>
              <div className="theme-options" role="group" aria-label="选择主题">
                {themes.map((option) => (
                  <button type="button" key={option.id} className={`theme-option ${theme === option.id ? 'is-selected' : ''}`}
                    aria-label={option.name} aria-pressed={theme === option.id}
                    onClick={() => {
                      if (!setTheme(option.id)) toast('主题已应用，但未能保存到本机，下次启动可能恢复默认配色。', 'warning')
                    }}>
                    <span className="theme-preview" data-theme={option.id} aria-hidden="true">
                      <span className="theme-preview-sidebar"><i /><i /><i /><i /></span>
                      <span className="theme-preview-main">
                        <span className="theme-preview-title" />
                        <span className="theme-preview-metrics"><i /><i /><i /></span>
                        <span className="theme-preview-content"><i /><i /><i /></span>
                      </span>
                    </span>
                    <span className="theme-option-heading"><strong>{option.name}</strong><small>{option.id === 'panda' ? '默认配色' : '原有配色'}</small><span className="theme-option-check"><Check size={14} /></span></span>
                    <span className="theme-option-description">{option.description}</span>
                  </button>
                ))}
              </div>
              <p className="theme-setting-note">已选：{themes.find((option) => option.id === theme)?.name}。下次启动时沿用。</p>
            </section>
          )}

          {section === 'send' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>发送</h2><p>新计划默认每封间隔 100–240 秒随机。单个计划可在「选择邮箱」或计划编辑器里自行设置最短和最长秒数。</p></div></div>
              <div className="form-grid pad">
                <label className="field span2">发送失败后重试几次
                  <input type="number" min={1} {...num('default_retry_max')} />
                  <span className="field-hint">网络或服务器临时错误会按这个次数重试，重试仍失败则跳过该收件人。</span></label>
              </div>
            </div>
          )}

          {section === 'guard' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>内容保护</h2><p>降低「内容完全重复」被拦截的概率。</p></div></div>
              <div className="form-grid pad">
                <div className="field span2">
                  <Switch checked={form.anti_spam_mutation} label="发送时微调正文（插入看不见的空格）" disabled={!loaded || saving}
                    onChange={(v) => setForm({ ...form, anti_spam_mutation: v })} />
                </div>
              </div>
            </div>
          )}

          {section === 'replies' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>回复检查</h2><p>优先实时监听收件箱，接收普通来信与投稿回复；不支持实时通知时使用定时检查。</p></div></div>
              <div className="form-grid pad">
                <label className="field span2">兜底检查间隔（分钟）
                  <input type="number" min={1} {...num('reply_poll_minutes')} />
                  <span className="field-hint">至少 1 分钟。实时通知到达时立即收取，不等待这个间隔；也可在收件箱手动检查。</span></label>

              </div>
            </div>
          )}

          {section === 'system' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>开关机</h2><p>开机自启会马上生效；关闭窗口行为需要点保存。</p></div></div>
              <div className="form-grid pad">
                <div className="field span2">
                  <p className="hint" style={{ marginBottom: 10 }}>登录电脑后自动在后台启动，方便定时计划到点发送。</p>
                  <Switch checked={form.auto_start} label="开机后自动启动" onChange={(v) => { void autostartAction.run(() => toggleAutostart(v)) }} disabled={autostartAction.busy || !loaded || saving} />
                </div>
                <div className="field span2">
                  <Switch checked={form.close_to_tray} label="点关闭时藏到托盘，计划继续跑" disabled={!loaded || saving}
                    onChange={(v) => setForm({ ...form, close_to_tray: v })} />
                </div>
              </div>
            </div>
          )}

          {section === 'data' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>备份</h2><p>备份包含邮箱、投稿计划和记录，保存在本机。</p></div></div>
              <div className="form-grid pad">
                <div className="field span2">
                  <Switch checked={form.auto_backup} label="开启自动备份" disabled={!loaded || saving}
                    onChange={(v) => setForm({ ...form, auto_backup: v })} />
                </div>
              </div>
              <div className="settings-actions">
                <Button variant="ghost" disabled={backupAction.busy} onClick={() => void backup()}><DatabaseBackup size={15} />立即备份</Button>
              </div>
              <StorageManager />
            </div>
          )}

          {section === 'update' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>更新</h2><p>后台检查并下载官方更新，签名验证通过后可一键更新重启；不会自动中断编辑或发送。</p></div></div>
              <div className="update-status pad">
                <Download size={18} />
                <div>
                  <b>{updateState === 'checking' ? '正在检查更新'
                    : updateState === 'downloading' ? `正在下载${updateProgress === null ? '' : ` ${updateProgress}%`}`
                      : updateState === 'ready' ? '更新已下载，等待空闲时安装'
                        : updateState === 'installing' ? '正在安装更新'
                      : updateState === 'installed' ? '更新已安装，等待重启'
                        : '熊猫投稿桌面版'}</b>
                  <span>{version ? `当前版本 v${version}` : versionError ? '版本读取失败' : '正在读取当前版本'}</span>
                </div>
              </div>
              <div className="settings-actions">
                <Button variant="ghost" disabled={updateState !== 'idle'} onClick={() => void checkUpdate()}>
                  <RefreshCw size={15} className={updateState === 'checking' ? 'is-spinning' : ''} />检查更新
                </Button>
                {['ready', 'installed'].includes(updateState) && <Button onClick={() => void applyPreparedUpdate(restart, toast)}>{updateState === 'ready' ? '更新并重启' : '重启使用新版本'}</Button>}
              </div>
            </div>
          )}

          {section === 'support' && (
            <div className="panel settings-section">
              <div className="panel-heading">
                <div>
                  <h2>支持作者</h2>
                  <p>熊猫投稿完全开源免费。赞助完全自愿，不会解锁或锁定任何功能。</p>
                </div>
              </div>
              <div className="pad">
                <SupportAuthor compact />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
