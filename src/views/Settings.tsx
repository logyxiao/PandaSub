import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { DatabaseBackup, Inbox, Power, RefreshCw, Save, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { api } from '../api'
import { useToast } from '../components/feedback'
import { Button, Switch } from '../components/ui'
import type { Settings } from '../types'

const defaults: Settings = {
  default_interval_min: 5, default_interval_max: 20,
  default_batch_size_min: 6, default_batch_size_max: 8,
  default_batch_pause_min: 180, default_batch_pause_max: 300,
  default_retry_max: 3, limit_cooldown_minutes: 60,
  anti_spam_mutation: true, auto_start: false, close_to_tray: true, auto_backup: false,
  update_feed_url: '', reply_poll_minutes: 2,
}

const sections = [
  { id: 'defaults', label: '发送节奏', icon: SlidersHorizontal },
  { id: 'guard', label: '限流保护', icon: ShieldCheck },
  { id: 'replies', label: '回复检查', icon: Inbox },
  { id: 'system', label: '开关机', icon: Power },
  { id: 'data', label: '备份', icon: DatabaseBackup },
  { id: 'update', label: '更新', icon: RefreshCw },
] as const

type SectionId = typeof sections[number]['id']

export function SettingsView() {
  const [form, setForm] = useState<Settings>(defaults)
  const [saved, setSaved] = useState<Settings>(defaults)
  const [notice, setNotice] = useState('')
  const [version, setVersion] = useState('')
  const [section, setSection] = useState<SectionId>('defaults')
  const toast = useToast()

  useEffect(() => {
    api.getSettings().then((s) => { setForm(s); setSaved(s) }).catch((e) => setNotice(String(e)))
    api.checkUpdate().then((u) => setVersion(u.current)).catch(() => {})
  }, [])

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved])

  const save = async () => {
    try {
      await api.updateSettings(form)
      setSaved(form)
      toast('设置已保存', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const toggleAutostart = async (enabled: boolean) => {
    try {
      await api.setAutostart(enabled)
      const next = { ...form, auto_start: enabled }
      setForm(next)
      setSaved((s) => ({ ...s, auto_start: enabled }))
      toast(enabled ? '已开启开机自启' : '已关闭开机自启', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const backup = async () => {
    try { toast(`已备份到 ${await api.backup()}`, 'success') } catch (e) { toast(String(e), 'error') }
  }

  const checkUpdate = async () => {
    try {
      const u = await api.checkUpdate()
      toast(u.feed ? `当前版本 ${u.current}，更新源：${u.feed}` : `当前版本 ${u.current}，还没填写更新源`, 'info')
    } catch (e) { toast(String(e), 'error') }
  }

  const num = (key: keyof Settings) => ({
    value: form[key] as number,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(e.target.value) }),
  })

  return (
    <>
      <div className="toolbar">
        <p className="hint">{dirty ? '有未保存的修改。' : '这里改的是新建计划时的默认节奏，已经在跑的计划不会变。'}</p>
        <div className="toolbar-actions">
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}><Save size={15} />保存设置</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

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
          {section === 'defaults' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>发送节奏</h2><p>发送间隔由系统按本计划累计发送量自动分档，无需手动设置。</p></div></div>
              <div className="form-grid pad">
                <div className="field span2">
                  <p className="hint" style={{ marginBottom: 10 }}>自动分档：前 11 封 3 分钟 → 12–19 封 30 秒 → 20–51 封 1 分钟 → 52 封起 2 分钟。到点才发下一封。</p>
                </div>
                <label className="field span2">失败后重试几次<input type="number" min={1} {...num('default_retry_max')} /></label>
              </div>
            </div>
          )}

          {section === 'guard' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>限流保护</h2><p>某个邮箱被判定连发时，先停用一段时间再继续。</p></div></div>
              <div className="form-grid pad">
                <label className="field span2">被限流后等待多久再试（分钟）
                  <input type="number" min={1} {...num('limit_cooldown_minutes')} /></label>
                <div className="field span2">
                  <p className="hint" style={{ marginBottom: 10 }}>在正文里插入看不见的空格，降低「内容完全重复」被拦截的概率。不影响阅读。</p>
                  <Switch checked={form.anti_spam_mutation} label="发送时微调正文"
                    onChange={(v) => setForm({ ...form, anti_spam_mutation: v })} />
                </div>
              </div>
            </div>
          )}

          {section === 'replies' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>回复检查</h2><p>定期用 IMAP 查看发件箱对应的收件箱，判断是自动回复还是人工回复。</p></div></div>
              <div className="form-grid pad">
                <label className="field span2">每隔几分钟检查一次
                  <input type="number" min={1} {...num('reply_poll_minutes')} />
                  <span className="field-hint">至少 1 分钟。也可在「回复」页随时点立即检查。</span></label>
              </div>
            </div>
          )}

          {section === 'system' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>开关机</h2><p>开机自启会马上生效；关闭窗口行为需要点保存。</p></div></div>
              <div className="form-grid pad">
                <div className="field span2">
                  <p className="hint" style={{ marginBottom: 10 }}>登录电脑后自动在后台启动，方便定时计划到点发送。</p>
                  <Switch checked={form.auto_start} label="开机后自动启动" onChange={(v) => void toggleAutostart(v)} />
                </div>
                <div className="field span2">
                  <Switch checked={form.close_to_tray} label="点关闭时藏到托盘，计划继续跑"
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
                  <Switch checked={form.auto_backup} label="开启自动备份"
                    onChange={(v) => setForm({ ...form, auto_backup: v })} />
                </div>
              </div>
              <div className="settings-actions">
                <Button variant="ghost" onClick={() => void backup()}><DatabaseBackup size={15} />立即备份</Button>
              </div>
            </div>
          )}

          {section === 'update' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>更新</h2><p>不填更新源就不会检查新版本。</p></div></div>
              <div className="form-grid pad">
                <label className="field span2">更新源地址
                  <input value={form.update_feed_url} onChange={(e) => setForm({ ...form, update_feed_url: e.target.value })} placeholder="https://example.com/latest.json" /></label>
              </div>
              <div className="settings-actions">
                {version && <p className="version">当前版本 v{version}</p>}
                <Button variant="ghost" onClick={() => void checkUpdate()}><Search size={15} />检查更新</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
