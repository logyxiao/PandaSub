import { detectProvider, normalizeAccountForm, serverPreset } from '../lib/accountPresets'
import { useRequestGuard } from '../hooks/useRequestGuard'
import { useUnsavedChanges } from '../hooks/useUnsavedChanges'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, Check, Eye, EyeOff, Mail, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton } from '../components/ui'
import { Table } from '../components/Table'
import { formatTime, isValidEmail, providerName, type Tone } from '../format'
import { useNav } from '../nav'
import type { Account, AccountInput } from '../types'
import { accountTodayQuota } from './planShared'

const emptyForm: AccountInput = {
  email: '', password: '', ...serverPreset(''),
  sender_name: '', enabled: true, check_replies: true,
}

export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Account | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [forms, setForms] = useState<AccountInput[]>([{ ...emptyForm }])
  const [autoServers, setAutoServers] = useState<boolean[]>([true])
  const [showPasswords, setShowPasswords] = useState<boolean[]>([false])
  const [testing, setTesting] = useState<Set<number>>(new Set())
  const testingIds = useRef(new Set<number>())
  const requests = useRequestGuard()
  const [testResult, setTestResult] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const baseline = useRef('')
  const allowLeave = useUnsavedChanges(showForm && JSON.stringify(forms) !== baseline.current, saving, '邮箱配置尚未保存，继续会丢弃修改。')
  const closeForm = async () => { if (await allowLeave()) setShowForm(false) }
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = useCallback(async () => {
    const request = requests.begin()
    setLoading(true)
    try {
      const accounts = await api.listAccounts()
      if (requests.isCurrent(request)) { setAccounts(accounts); setNotice('') }
    } catch (error) { if (requests.isCurrent(request)) setNotice(String(error)) }
    finally { if (requests.isCurrent(request)) setLoading(false) }
  }, [requests])
  useEffect(() => { void load() }, [load])

  const openAdd = () => {
    setEditing(null)
    setAutoServers([true])
    baseline.current = JSON.stringify([{ ...emptyForm }])
    setForms([{ ...emptyForm }])
    setShowPasswords([false])
    setShowForm(true)
  }

  const openEdit = (a: Account) => {
    setEditing(a)
    setAutoServers([false])
    const next = [{
      email: a.email, password: '', smtp_host: a.smtp_host, smtp_port: a.smtp_port,
      sender_name: a.sender_name, provider: a.provider, enabled: a.enabled,
      imap_host: a.imap_host, imap_port: a.imap_port, check_replies: a.check_replies,
    }]
    baseline.current = JSON.stringify(next)
    setForms(next)
    setShowPasswords([false])
    setShowForm(true)
  }

  const updateForm = (index: number, patch: Partial<AccountInput>) => {
    setForms((current) => current.map((form, i) => i === index ? { ...form, ...patch } : form))
  }

  const addForm = () => {
    setForms((current) => [...current, { ...emptyForm }])
    setShowPasswords((current) => [...current, false])
    setAutoServers((current) => [...current, true])
  }

  const removeForm = (index: number) => {
    if (forms.length === 1) return
    setForms((current) => current.filter((_, i) => i !== index))
    setShowPasswords((current) => current.filter((_, i) => i !== index))
    setAutoServers((current) => current.filter((_, i) => i !== index))
  }

  const save = async () => {
    if (busy.current) return
    const invalidEmail = forms.find((form) => !isValidEmail(form.email.trim()))
    if (invalidEmail) { toast('请输入有效的邮箱地址', 'warning'); return }
    if (!editing && forms.some((form) => !form.password.trim())) { toast('请填写邮箱授权码，不是登录密码', 'warning'); return }

    if (forms.some(form => !form.smtp_host.trim() || (form.check_replies && !form.imap_host.trim()) ||
      !Number.isInteger(form.smtp_port) || form.smtp_port < 1 || form.smtp_port > 65535 ||
      !Number.isInteger(form.imap_port) || form.imap_port < 1 || form.imap_port > 65535)) {
      toast('请检查服务器地址和端口，端口应为 1–65535 的整数', 'warning'); return
    }
    const emails = forms.map(form => form.email.trim().toLowerCase())
    if (new Set(emails).size !== emails.length) { toast('填写了重复的邮箱地址', 'warning'); return }
    busy.current = true; setSaving(true)
    let completed = 0
    try {
      if (editing) await api.updateAccount(editing.id, normalizeAccountForm(forms[0]))
      else for (const form of forms) { await api.addAccount(normalizeAccountForm(form)); completed++ }
      setShowForm(false)
      await load()
      toast(editing ? '邮箱配置已保存' : `已添加 ${forms.length} 个邮箱`, 'success')
    } catch (e) {
      if (completed) {
        setAutoServers(autoServers.slice(completed))
        setForms(forms.slice(completed)); setShowPasswords(forms.slice(completed).map(() => false))
        await load()
      }
      toast(`${completed ? `已添加 ${completed} 个邮箱，剩余项目可继续保存：` : ''}${String(e)}`, 'error')
    } finally { busy.current = false; setSaving(false) }
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
    if (testingIds.current.has(id)) return
    testingIds.current.add(id)
    setTesting(new Set(testingIds.current)); setTestResult((r) => ({ ...r, [id]: '' }))
    try {
      const result = await api.testAccount(id)
      setTestResult((r) => ({ ...r, [id]: result }))
      toast('测试邮件已发出，请检查该邮箱收件箱', 'success')
    } catch (e) { setTestResult((r) => ({ ...r, [id]: String(e) })); toast(String(e), 'error') }
    finally { testingIds.current.delete(id); setTesting(new Set(testingIds.current)) }
  }

  const accountState = (a: Account): { tone: Tone; label: string } => {
    if (!a.enabled) return { tone: 'neutral', label: '已停用' }
    return { tone: 'success', label: '可用' }
  }

  const active = accounts.filter((a) => a.enabled)
  const summary = [
    { label: '可用邮箱', value: active.length, unit: '个', icon: Mail },
    { label: '已停用', value: accounts.filter((a) => !a.enabled).length, unit: '个', icon: Ban },
  ]

  return (
    <>
      <div className="toolbar">
        <p className="hint">支持 QQ、163、126、Yeah 邮箱，也可手动配置其他邮箱。</p>
        <div className="toolbar-actions">
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" onClick={() => openAdd()}><Plus size={16} />添加邮箱</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !accounts.length ? (
        <div className="panel">
          <EmptyState icon={Mail} title="还没有发件邮箱"
            desc="添加 QQ 或 163 邮箱及授权码，系统会自动完成服务参数配置。"
            action={<Button variant="primary" onClick={() => openAdd()}><Plus size={16} />添加邮箱</Button>} />
        </div>
      ) : (
        <>
          <section className="stat-strip" aria-label="邮箱概览">
            {summary.map(({ label, value, unit, icon: Icon }) => (
              <div className="stat" key={label}>
                <div className="stat-top"><span className="stat-label">{label}</span><Icon size={16} className="stat-icon" /></div>
                <div className="stat-value">{value}<small>{unit}</small></div>
              </div>
            ))}
          </section>
          <div className="panel">
            <Table
              rowKey="id"
              dataSource={accounts}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              rowClassName={(a) => [a.enabled ? '' : 'dim', accountTodayQuota(a.sent_today).over ? 'is-quota-over' : ''].filter(Boolean).join(' ')}
              columns={[
                {
                  key: 'email',
                  title: '邮箱',
                  render: (_value, a) => (
                    <>
                      <b>{a.email}</b>
                      <small>{a.sender_name || '未设笔名'}</small>
                    </>
                  ),
                },
                {
                  key: 'provider',
                  title: '类型',
                  width: 160,
                  render: (_value, a) => (
                    <>
                      {providerName[a.provider] ?? a.provider}
                      <small>{a.smtp_host}:{a.smtp_port}</small>
                    </>
                  ),
                },
                {
                  key: 'status',
                  title: '状态',
                  width: 92,
                  render: (_value, a) => {
                    const st = accountState(a)
                    return <Badge tone={st.tone} dot>{st.label}</Badge>
                  },
                },
                {
                  key: 'last',
                  title: '上次发送',
                  width: 120,
                  render: (_value, a) => formatTime(a.last_sent_at),
                },
                {
                  key: 'today',
                  title: '今日发送',
                  width: 128,
                  render: (_value, a) => {
                    const quota = accountTodayQuota(a.sent_today)
                    return (
                      <div className={`account-today-quota ${quota.over ? 'is-over' : ''}`}>
                        <b>{quota.label}</b>
                        <small>{quota.over ? '建议今天不要再发' : '建议 80'}</small>
                      </div>
                    )
                  },
                },
                {
                  key: 'actions',
                  title: '',
                  width: 220,
                  render: (_value, a) => (
                    <>
                      <div className="row-actions">
                        <Button size="sm" onClick={() => void test(a.id)} disabled={testing.has(a.id)}>{testing.has(a.id) ? '测试中…' : '测试'}</Button>
                        <Button size="sm" onClick={() => openEdit(a)}>编辑</Button>
                        <IconButton title={a.enabled ? '停用' : '启用'} onClick={() => void toggle(a)}>{a.enabled ? <Ban size={15} /> : <Check size={15} />}</IconButton>
                        <IconButton title="删除" className="danger" onClick={() => void remove(a.id)}><Trash2 size={15} /></IconButton>
                      </div>
                      {testResult[a.id] && <small className={testResult[a.id].includes('成功') || testResult[a.id].includes('连接') ? 'test-result' : 'testing'}>{testResult[a.id]}</small>}
                    </>
                  ),
                },
              ]}
            />
          </div>
          {accounts.some((a) => a.enabled) && <p className="after-table-hint">邮箱可用后，可先去 <button type="button" className="text-link" onClick={() => go('editors')}>编辑</button> 里存收稿人，再去 <button type="button" className="text-link" onClick={() => go('plans')}>投稿计划</button> 写作品。</p>}
        </>
      )}

      {showForm && (
        <Modal title={editing ? '编辑投稿邮箱' : '配置投稿邮箱'} width={980}
          onClose={() => void closeForm()}
          footer={<><Button variant="ghost" disabled={saving} onClick={() => void closeForm()}>取消</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>保存配置</Button></>}>
          <fieldset className="mail-config" disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="mail-config-intro">
              <div><p className="mail-config-title">邮箱配置</p><p className="mail-config-sub">输入完整地址和授权码即可添加，服务器参数支持手动调整。</p></div>
              {!editing && <Button variant="ghost" onClick={addForm}><Plus size={16} />添加邮箱</Button>}
            </div>

            <div className="mail-card-list">
              {forms.map((form, index) => (
                <section className="mail-card" key={`${editing?.id ?? 'new'}-${index}`}>
                  <div className="mail-card-head">
                    <div className="mail-card-name"><span className="mail-card-index">{index + 1}</span><h3>邮箱 {index + 1}</h3><Badge>{isValidEmail(form.email.trim()) ? (providerName[detectProvider(form.email)] ?? '其他邮箱') : '自动识别'}</Badge></div>
                    {!editing && forms.length > 1 && <IconButton title={`删除邮箱 ${index + 1}`} className="danger" onClick={() => removeForm(index)}><X size={16} /></IconButton>}
                  </div>
                  <div className="mail-card-fields">
                    <label className="field">邮箱地址
                      <input type="email" value={form.email} onChange={(e) => updateForm(index, { email: e.target.value, ...(autoServers[index] ? serverPreset(e.target.value) : {}) })} placeholder="例如：author@qq.com 或 author@163.com" autoFocus={index === 0} /></label>
                    <label className="field">授权码
                      <div className="input-with-action">
                        <input type={showPasswords[index] ? 'text' : 'password'} value={form.password} onChange={(e) => updateForm(index, { password: e.target.value })} placeholder={editing ? '留空保留原授权码' : '请输入邮箱授权码'} />
                        <button type="button" className="input-action" onClick={() => setShowPasswords((current) => current.map((v, i) => i === index ? !v : v))} title={showPasswords[index] ? '隐藏授权码' : '显示授权码'} aria-label={showPasswords[index] ? '隐藏授权码' : '显示授权码'}>{showPasswords[index] ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                      </div></label>
                    <label className="field">笔名（可选）
                      <input value={form.sender_name} onChange={(e) => updateForm(index, { sender_name: e.target.value })} placeholder="留空则使用邮箱名称" /></label>
                  </div>
                  <details className="mail-server-settings">
                    <summary>服务器设置</summary>
                    <label className="check-line"><input type="checkbox" checked={autoServers[index] ?? false}
                      onChange={event => {
                        const enabled = event.target.checked
                        setAutoServers(current => current.map((value, i) => i === index ? enabled : value))
                        if (enabled) updateForm(index, serverPreset(form.email))
                      }} />根据邮箱地址自动配置</label>
                    <div className="form-grid">
                      <label className="field">SMTP 服务器<input value={form.smtp_host} disabled={autoServers[index]} onChange={e => updateForm(index, { smtp_host: e.target.value })} /></label>
                      <label className="field">SMTP 端口<input type="number" min={1} max={65535} value={form.smtp_port} disabled={autoServers[index]} onChange={e => updateForm(index, { smtp_port: Number(e.target.value) })} /></label>
                      <label className="field">IMAP 服务器<input value={form.imap_host} disabled={autoServers[index]} onChange={e => updateForm(index, { imap_host: e.target.value })} /></label>
                      <label className="field">IMAP 端口<input type="number" min={1} max={65535} value={form.imap_port} disabled={autoServers[index]} onChange={e => updateForm(index, { imap_port: Number(e.target.value) })} /></label>
                    </div>
                    <p className="field-hint">使用 SSL/TLS 连接。其他邮箱或企业邮箱请核对服务商提供的服务器地址。</p>
                  </details>
                  <p className="mail-auto-note">{autoServers[index] ? '输入完整邮箱地址后自动配置，可展开服务器设置手动调整。' : '保留当前服务器设置；修改地址或笔名不会覆盖这些参数。'}</p>
                </section>
              ))}
            </div>

            <div className="mail-help">
              <div className="mail-help-icon"><Mail size={18} /></div>
              <div><strong>授权码</strong><p>QQ 邮箱：设置 → 账户 → POP3/IMAP/SMTP/Exchange 服务 → 开启服务并获取授权码。</p><p>163 邮箱：设置 → POP3/SMTP/IMAP → 开启服务并设置授权码。</p></div>
            </div>
          </fieldset>
        </Modal>
      )}
    </>
  )
}
