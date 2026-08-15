import { useEffect, useState } from 'react'
import { AlertTriangle, Ban, Check, Eye, EyeOff, Gauge, Mail, Plus, RefreshCw, ShieldCheck, Timer, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton } from '../components/ui'
import { formatTime, isValidEmail, providerName, type Tone } from '../format'
import { useNav } from '../nav'
import type { Account, AccountInput } from '../types'

const presets: Record<string, { host: string; port: number; imap_host: string; imap_port: number }> = {
  qq: { host: 'smtp.qq.com', port: 465, imap_host: 'imap.qq.com', imap_port: 993 },
  '163': { host: 'smtp.163.com', port: 465, imap_host: 'imap.163.com', imap_port: 993 },
  other: { host: '', port: 465, imap_host: '', imap_port: 993 },
}

const emptyForm: AccountInput = {
  email: '', password: '', smtp_host: 'smtp.qq.com', smtp_port: 465,
  sender_name: '', provider: 'qq', enabled: true, hourly_limit: 7, daily_limit: 50,
  imap_host: 'imap.qq.com', imap_port: 993, check_replies: true,
}

const detectProvider = (email: string) => {
  const domain = email.trim().toLowerCase().split('@')[1] ?? ''
  if (domain === 'qq.com') return 'qq'
  if (['163.com', '126.com', 'yeah.net'].includes(domain)) return '163'
  return 'other'
}

const normalizeForm = (form: AccountInput): AccountInput => {
  const provider = detectProvider(form.email)
  const preset = presets[provider]
  const domain = form.email.trim().toLowerCase().split('@')[1] ?? ''
  const customHost = domain ? `smtp.${domain}` : ''
  const customImap = domain ? `imap.${domain}` : ''
  return {
    ...form,
    email: form.email.trim(),
    sender_name: form.sender_name.trim(),
    provider,
    smtp_host: preset.host || customHost,
    smtp_port: preset.port,
    imap_host: preset.imap_host || customImap,
    imap_port: preset.imap_port,
    enabled: true,
    check_replies: true,
    hourly_limit: Math.max(1, Math.ceil(form.daily_limit / 8)),
    daily_limit: Math.max(1, form.daily_limit),
  }
}

export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Account | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [forms, setForms] = useState<AccountInput[]>([{ ...emptyForm }])
  const [showPasswords, setShowPasswords] = useState<boolean[]>([false])
  const [testing, setTesting] = useState<number | null>(null)
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = async () => {
    setLoading(true)
    try { setAccounts(await api.listAccounts()); setNotice('') }
    catch (e) { setNotice(String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const openAdd = () => {
    setEditing(null)
    setForms([{ ...emptyForm }])
    setShowPasswords([false])
    setShowForm(true)
  }

  const openEdit = (a: Account) => {
    setEditing(a)
    setForms([{
      email: a.email, password: a.password, smtp_host: a.smtp_host, smtp_port: a.smtp_port,
      sender_name: a.sender_name, provider: a.provider, enabled: a.enabled,
      hourly_limit: a.hourly_limit, daily_limit: a.daily_limit,
      imap_host: a.imap_host, imap_port: a.imap_port, check_replies: a.check_replies,
    }])
    setShowPasswords([false])
    setShowForm(true)
  }

  const updateForm = (index: number, patch: Partial<AccountInput>) => {
    setForms((current) => current.map((form, i) => i === index ? { ...form, ...patch } : form))
  }

  const addForm = () => {
    setForms((current) => [...current, { ...emptyForm }])
    setShowPasswords((current) => [...current, false])
  }

  const removeForm = (index: number) => {
    if (forms.length === 1) return
    setForms((current) => current.filter((_, i) => i !== index))
    setShowPasswords((current) => current.filter((_, i) => i !== index))
  }

  const save = async () => {
    const invalidEmail = forms.find((form) => !isValidEmail(form.email.trim()))
    if (invalidEmail) { toast('请输入有效的邮箱地址', 'warning'); return }
    if (forms.some((form) => !form.password.trim())) { toast('请填写邮箱授权码，不是登录密码', 'warning'); return }
    if (forms.some((form) => form.daily_limit < 1)) { toast('每天发送限制至少为 1 封', 'warning'); return }

    try {
      if (editing) await api.updateAccount(editing.id, normalizeForm(forms[0]))
      else for (const form of forms) await api.addAccount(normalizeForm(form))
      setShowForm(false)
      await load()
      toast(editing ? '邮箱配置已保存' : `已添加 ${forms.length} 个邮箱`, 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const remove = async (id: number) => {
    const ok = await confirm({ title: '删除邮箱', message: '删除后这个邮箱不再参与发送。历史记录会保留。', confirmLabel: '删除', tone: 'danger' })
    if (!ok) return
    try { await api.deleteAccount(id); await load(); toast('邮箱已删除', 'success') } catch (e) { toast(String(e), 'error') }
  }

  const toggle = async (a: Account) => {
    try { await api.toggleAccount(a.id, !a.enabled); await load() } catch (e) { toast(String(e), 'error') }
  }

  const test = async (id: number) => {
    setTesting(id); setTestResult((r) => ({ ...r, [id]: '' }))
    try {
      const result = await api.testAccount(id)
      setTestResult((r) => ({ ...r, [id]: result }))
      toast('测试邮件已发出，请检查该邮箱收件箱', 'success')
    } catch (e) { setTestResult((r) => ({ ...r, [id]: String(e) })); toast(String(e), 'error') }
    finally { setTesting(null) }
  }

  const accountState = (a: Account): { tone: Tone; label: string } => {
    if (a.limited) return { tone: 'warning', label: '暂时限流' }
    if (!a.enabled) return { tone: 'neutral', label: '已停用' }
    const nearDay = a.daily_limit > 0 && a.sent_day >= a.daily_limit * 0.9
    const nearHour = a.hourly_limit > 0 && a.sent_hour >= a.hourly_limit * 0.9
    if (nearDay || nearHour) return { tone: 'warning', label: '额度将尽' }
    return { tone: 'success', label: '可用' }
  }

  const active = accounts.filter((a) => a.enabled && !a.limited)
  const summary = [
    { label: '可用邮箱', value: active.length, unit: '个', icon: Mail },
    { label: '今日还能发', value: active.reduce((s, a) => s + Math.max(0, a.daily_limit - a.sent_day), 0), unit: '封', icon: Gauge },
    { label: '本小时还能发', value: active.reduce((s, a) => s + Math.max(0, a.hourly_limit - a.sent_hour), 0), unit: '封', icon: Timer },
    { label: '暂时限流', value: accounts.filter((a) => a.limited).length, unit: '个', icon: AlertTriangle, warn: true },
    { label: '已停用', value: accounts.filter((a) => !a.enabled).length, unit: '个', icon: Ban },
  ]

  return (
    <>
      <div className="toolbar">
        <p className="hint">管理投稿邮箱、授权码、笔名与每日发送额度。</p>
        <div className="toolbar-actions">
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" onClick={openAdd}><Plus size={16} />添加邮箱</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !accounts.length ? (
        <div className="panel">
          <EmptyState icon={Mail} title="还没有发件邮箱"
            desc="添加 QQ 或 163 邮箱及授权码，系统会自动完成服务参数配置。"
            action={<Button variant="primary" onClick={openAdd}><Plus size={16} />添加邮箱</Button>} />
        </div>
      ) : (
        <>
          {accounts.some((account) => account.provider === 'qq') && (
            <div className="notice notice-info">
              <ShieldCheck size={16} />
              <span>QQ 安全模式已启用：所有 QQ 邮箱和同时运行的计划共用至少 5 分钟的发送间隔。QQ 官方按发件人、qq.com 域名、出口 IP 和连接频率限流，但不公开具体数字；页面额度是应用自己的保护上限。</span>
            </div>
          )}
          <section className="stat-strip" aria-label="邮箱额度">
            {summary.map(({ label, value, unit, icon: Icon, warn }) => (
              <div className="stat" key={label}>
                <div className="stat-top"><span className="stat-label">{label}</span><Icon size={16} className={`stat-icon ${warn ? 'warn' : ''}`} /></div>
                <div className={`stat-value ${warn ? 'warn' : ''}`}>{value}<small>{unit}</small></div>
              </div>
            ))}
          </section>
          <div className="panel">
            <div className="table-wrap">
              <table>
                <thead><tr><th>邮箱</th><th>类型</th><th>今日已发 / 上限</th><th>本小时</th><th>状态</th><th>上次发送</th><th aria-label="操作" /></tr></thead>
                <tbody>
                  {accounts.map((a) => {
                    const st = accountState(a)
                    return (
                      <tr key={a.id} className={!a.enabled ? 'dim' : ''}>
                        <td><b>{a.email}</b><small>{a.sender_name || '未设笔名'}</small></td>
                        <td>{providerName[a.provider] ?? a.provider}<small>{a.smtp_host}:{a.smtp_port}</small></td>
                        <td><b>{a.sent_day} / {a.daily_limit}</b></td>
                        <td>{a.sent_hour} / {a.hourly_limit}</td>
                        <td><Badge tone={st.tone} dot>{st.label}</Badge></td>
                        <td>{formatTime(a.last_sent_at)}</td>
                        <td>
                          <div className="row-actions">
                            <Button size="sm" onClick={() => void test(a.id)} disabled={testing === a.id}>{testing === a.id ? '测试中…' : '测试'}</Button>
                            <Button size="sm" onClick={() => openEdit(a)}>编辑</Button>
                            <IconButton title={a.enabled ? '停用' : '启用'} onClick={() => void toggle(a)}>{a.enabled ? <Ban size={15} /> : <Check size={15} />}</IconButton>
                            <IconButton title="删除" className="danger" onClick={() => void remove(a.id)}><Trash2 size={15} /></IconButton>
                          </div>
                          {testResult[a.id] && <small className={testResult[a.id].includes('成功') || testResult[a.id].includes('连接') ? 'test-result' : 'testing'}>{testResult[a.id]}</small>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {accounts.some((a) => a.enabled) && <p className="after-table-hint">邮箱可用后，可先去 <button type="button" className="text-link" onClick={() => go('editors')}>编辑</button> 里存收稿人，再去 <button type="button" className="text-link" onClick={() => go('plans')}>投稿计划</button> 写作品。</p>}
        </>
      )}

      {showForm && (
        <Modal title={editing ? '编辑投稿邮箱' : '配置投稿邮箱'} width={980}
          onClose={() => setShowForm(false)}
          footer={<><Button variant="ghost" onClick={() => setShowForm(false)}>取消</Button><Button variant="primary" onClick={() => void save()}>保存配置</Button></>}>
          <div className="mail-config">
            <div className="mail-config-intro">
              <div><p className="mail-config-title">邮箱配置</p><p className="mail-config-sub">授权码用于 SMTP / IMAP。每天上限是应用本地保护值，不是邮箱官方承诺的额度。</p></div>
              {!editing && <Button variant="ghost" onClick={addForm}><Plus size={16} />添加邮箱</Button>}
            </div>

            <div className="mail-card-list">
              {forms.map((form, index) => (
                <section className="mail-card" key={`${editing?.id ?? 'new'}-${index}`}>
                  <div className="mail-card-head">
                    <div className="mail-card-name"><span className="mail-card-index">{index + 1}</span><h3>邮箱 {index + 1}</h3></div>
                    {!editing && forms.length > 1 && <IconButton title={`删除邮箱 ${index + 1}`} className="danger" onClick={() => removeForm(index)}><X size={16} /></IconButton>}
                  </div>
                  <div className="mail-card-fields">
                    <label className="field">邮箱地址
                      <input type="email" value={form.email} onChange={(e) => updateForm(index, { email: e.target.value })} placeholder="例如：author@qq.com" autoFocus={index === 0} /></label>
                    <label className="field">授权码
                      <div className="input-with-action">
                        <input type={showPasswords[index] ? 'text' : 'password'} value={form.password} onChange={(e) => updateForm(index, { password: e.target.value })} placeholder="请输入邮箱授权码" />
                        <button type="button" className="input-action" onClick={() => setShowPasswords((current) => current.map((v, i) => i === index ? !v : v))} title={showPasswords[index] ? '隐藏授权码' : '显示授权码'} aria-label={showPasswords[index] ? '隐藏授权码' : '显示授权码'}>{showPasswords[index] ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                      </div></label>
                    <label className="field">笔名（可选）
                      <input value={form.sender_name} onChange={(e) => updateForm(index, { sender_name: e.target.value })} placeholder="留空则使用邮箱名称" /></label>
                    <label className="field mail-limit-field">每天发送限制
                      <div className="number-with-suffix"><input type="number" min={1} value={form.daily_limit} onChange={(e) => updateForm(index, { daily_limit: Number(e.target.value) })} /><span>封 / 天</span></div></label>
                  </div>
                  <p className="mail-auto-note">{form.email && isValidEmail(form.email) ? `已识别为 ${providerName[detectProvider(form.email)] ?? '其他邮箱'}，服务参数将自动配置` : '填写邮箱地址后将自动识别邮箱服务商'}</p>
                </section>
              ))}
            </div>

            <div className="mail-help">
              <div className="mail-help-icon"><Mail size={18} /></div>
              <div><strong>授权码与发送限制</strong><p>QQ 邮箱：设置 → 账户 → POP3/IMAP/SMTP/Exchange 服务 → 开启服务并获取授权码。</p><p>QQ 官方会按发件人、qq.com 域名、出口 IP 和连接频率限流，但不公开具体数字；应用会按所有 QQ 邮箱整体保护，含 QQ 的计划至少间隔 5 分钟。</p><p>163 邮箱：设置 → POP3/SMTP/IMAP → 开启服务并设置授权码。</p></div>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
