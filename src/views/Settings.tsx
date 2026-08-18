import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Coffee, DatabaseBackup, Download, Inbox, Power, RefreshCw, Save, Send, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { SupportAuthor } from '../components/SupportAuthor'
import { useConfirm, useToast } from '../components/feedback'
import { Button, Switch } from '../components/ui'
import type { Settings } from '../types'
import { availableUpdate, currentVersion, installUpdate, restartApp } from '../update'

const defaults: Settings = {
  default_retry_max: 3,
  anti_spam_mutation: true, auto_start: false, close_to_tray: true, auto_backup: false,
  update_feed_url: '', reply_poll_minutes: 2,
}

const sections = [
  { id: 'send', label: '发送', icon: Send },
  { id: 'guard', label: '内容保护', icon: ShieldCheck },
  { id: 'replies', label: '回复检查', icon: Inbox },
  { id: 'system', label: '开关机', icon: Power },
  { id: 'data', label: '备份', icon: DatabaseBackup },
  { id: 'update', label: '更新', icon: RefreshCw },
  { id: 'support', label: '支持作者', icon: Coffee },
] as const

type SectionId = typeof sections[number]['id']

export function SettingsView() {
  const [form, setForm] = useState<Settings>(defaults)
  const [saved, setSaved] = useState<Settings>(defaults)
  const [notice, setNotice] = useState('')
  const [version, setVersion] = useState('')
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'downloading' | 'installed'>('idle')
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const [section, setSection] = useState<SectionId>('send')
  const toast = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    api.getSettings().then((s) => { setForm(s); setSaved(s) }).catch((e) => setNotice(String(e)))
    currentVersion().then(setVersion).catch(() => {})
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
    if (updateState !== 'idle') return
    setUpdateState('checking')
    try {
      const update = await availableUpdate()
      if (!update) {
        toast(`当前已是最新版本 ${version ? `v${version}` : ''}`.trim(), 'success')
        return
      }
      const accepted = await confirm({
        title: `发现新版本 v${update.version}`,
        message: update.body?.trim() || '下载并安装后，已有数据会继续保留。',
        confirmLabel: '下载并安装',
      })
      if (!accepted) {
        await update.close()
        return
      }
      setUpdateState('downloading')
      await installUpdate(update, setUpdateProgress)
      setUpdateState('installed')
      const restart = await confirm({
        title: '更新安装完成',
        message: '重启熊猫投稿后即可使用新版本。正在发送的计划会在重启时停止。',
        confirmLabel: '立即重启',
        cancelLabel: '稍后重启',
      })
      if (restart) await restartApp()
    } catch (e) {
      toast(`更新失败：${String(e)}`, 'error')
    } finally {
      setUpdateState((state) => state === 'installed' ? state : 'idle')
      setUpdateProgress(null)
    }
  }

  const num = (key: keyof Settings) => ({
    value: form[key] as number,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(e.target.value) }),
  })

  return (
    <>
      <div className="toolbar">
        <p className="hint">{dirty ? '有未保存的修改。' : '默认发送间隔仍是 2–4 分钟随机。每个计划也可以在选择邮箱时改频率。'}</p>
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
          {section === 'send' && (
            <div className="panel settings-section">
              <div className="panel-heading"><div><h2>发送</h2><p>默认每封间隔 2–4 分钟随机，偏向 3 分钟。单个计划可在「选择邮箱」里改成 1 / 2 / 5 / 8 分钟。</p></div></div>
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
                  <Switch checked={form.anti_spam_mutation} label="发送时微调正文（插入看不见的空格）"
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
              <div className="panel-heading"><div><h2>更新</h2><p>自动检查官方版本，安装前会验证发布签名。</p></div></div>
              <div className="update-status pad">
                <Download size={18} />
                <div>
                  <b>{updateState === 'checking' ? '正在检查更新'
                    : updateState === 'downloading' ? `正在下载${updateProgress === null ? '' : ` ${updateProgress}%`}`
                      : updateState === 'installed' ? '更新已安装，等待重启'
                        : '熊猫投稿桌面版'}</b>
                  <span>{version ? `当前版本 v${version}` : '正在读取当前版本'}</span>
                </div>
              </div>
              <div className="settings-actions">
                <Button variant="ghost" disabled={updateState !== 'idle'} onClick={() => void checkUpdate()}>
                  <RefreshCw size={15} className={updateState === 'checking' ? 'is-spinning' : ''} />检查更新
                </Button>
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
