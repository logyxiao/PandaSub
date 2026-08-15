import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Clock3, FileUp, Plus, Send } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useToast } from '../components/feedback'
import { Button, Select } from '../components/ui'
import { isValidEmail, parseRecipient, providerName } from '../format'
import type { Account, Delivery, Editor, EditorInput, Manuscript, ManuscriptInput, TaskInput } from '../types'
import {
  CATEGORIES, GENRES, STYLES, editorRecipient, editorWorkTypeOptions, estimateAutoMinutes,
  fillPlaceholders, isPlanStyle, normalizeEditorTags, categoryFromWords, defaultBody, defaultSubject, pickOneEditorPerPlatform, sentCountByEmail,
} from './planShared'
import { EditorsList } from './Editors'

const emptyEditor: EditorInput = { platform: '', name: '', email: '', style: [], work_type: [] }

export function PlanEditor({
  editing, editors, onReloadEditors, deliveries, enabledAccounts,
  form, setForm, taskForm, setTaskForm,
  saving, onClose, onSaveDraft, onSaveAndSend, onImportFile,
}: {
  editing: Manuscript | null
  editors: Editor[]
  onReloadEditors: () => Promise<void>
  deliveries: Delivery[]
  enabledAccounts: Account[]
  form: ManuscriptInput
  setForm: (next: ManuscriptInput | ((f: ManuscriptInput) => ManuscriptInput)) => void
  taskForm: TaskInput
  setTaskForm: (next: TaskInput | ((f: TaskInput) => TaskInput)) => void
  saving: boolean
  onClose: () => void
  onSaveDraft: () => void
  onSaveAndSend: () => void
  onImportFile: (file: File | null) => void
}) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [orphans, setOrphans] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [mailDirty, setMailDirty] = useState(() => Boolean(editing && (form.subject.trim() || form.body.trim())))
  const [showEditorForm, setShowEditorForm] = useState(false)
  const [editorForm, setEditorForm] = useState<EditorInput>(emptyEditor)
  const [customWorkType, setCustomWorkType] = useState('')
  const [savingEditor, setSavingEditor] = useState(false)
  const [testing, setTesting] = useState(false)
  const initRef = useRef(false)

  const sentMap = useMemo(() => sentCountByEmail(deliveries), [deliveries])
  const liveCount = form.word_count
  const platforms = useMemo(
    () => [...new Set(editors.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [editors],
  )
  const workTypeOptions = useMemo(
    () => editorWorkTypeOptions(editors),
    [editors],
  )
  const genreChips = useMemo(() => {
    const fromEditors = workTypeOptions.map(([tag]) => tag)
    const extra = form.genres.filter((g) => !fromEditors.includes(g))
    return [
      ...workTypeOptions,
      ...extra.map((tag) => [tag, 0] as const),
    ]
  }, [workTypeOptions, form.genres])

  // 初始选中：编辑已有计划 → 恢复保存的收件人；新建 → 进入第二步时自动匹配（见 goToStep2）。
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    if (!editing) return
    const ids = new Set<number>()
    const orphanList: string[] = []
    for (const r of form.recipients) {
      const email = parseRecipient(r).email.toLowerCase()
      const lib = editors.find((e) => e.email.toLowerCase() === email)
      if (lib) ids.add(lib.id)
      else orphanList.push(r)
    }
    setSelectedIds(ids)
    setOrphans(orphanList)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入时初始化一次
  }, [])

  const selectedEditors = useMemo(
    () => editors.filter((e) => selectedIds.has(e.id)),
    [editors, selectedIds],
  )

  // 收件名单 = 勾选的编辑 + 已保存但不在编辑库里的收件人（保留不丢）。
  const recipients = useMemo(
    () => [...selectedEditors.map(editorRecipient), ...orphans],
    [selectedEditors, orphans],
  )

  // 发送时默认跳过已投过的编辑，只统计未投数量。
  const pending = recipients.filter((r) => (sentMap.get(parseRecipient(r).email.toLowerCase()) ?? 0) === 0).length
  const sendCount = pending

  const selectedAccounts = useMemo(() => {
    if (!taskForm.account_ids.length) return enabledAccounts
    return enabledAccounts.filter((account) => taskForm.account_ids.includes(account.id))
  }, [enabledAccounts, taskForm.account_ids])
  const minutes = estimateAutoMinutes(sendCount)
  const ready = Boolean(form.title.trim() && form.body.trim() && sendCount > 0 && selectedAccounts.length)

  // 勾选变化写回 form.recipients
  useEffect(() => {
    const next = recipients
    setForm((f) => {
      if (f.recipients.length === next.length && f.recipients.every((item, i) => item === next[i])) return f
      return { ...f, recipients: next }
    })
  }, [recipients, setForm])

  // 邮箱勾选随计划持久化：写回 form.account_ids，保存草稿/发送时一并入库。
  useEffect(() => {
    setForm((f) => {
      const next = taskForm.account_ids
      if (f.account_ids.length === next.length && f.account_ids.every((x, i) => x === next[i])) return f
      return { ...f, account_ids: next }
    })
  }, [taskForm.account_ids, setForm])

  useEffect(() => {
    const category = categoryFromWords(form.word_count)
    if (!category || category === form.category) return
    setForm((f) => (f.category === category ? f : { ...f, category }))
  }, [form.word_count, form.category, setForm])

  useEffect(() => {
    if (mailDirty) return
    setForm((f) => {
      const subject = defaultSubject(f)
      const body = defaultBody(f)
      if (f.subject === subject && f.body === body) return f
      return { ...f, subject, body }
    })
  }, [form.title, form.word_count, form.category, form.genres, mailDirty, setForm])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        onSaveDraft()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSaveDraft])

  const toggleSelect = (editor: Editor, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(editor.id)
      else next.delete(editor.id)
      return next
    })
  }

  // 新建且尚未手动勾选时，进入第二步自动按风格/作品类型匹配出候选编辑（每个平台一位），用户可自行增删。
  const goToStep2 = () => {
    if (!editing && selectedIds.size === 0) {
      const { picked: auto } = pickOneEditorPerPlatform(editors, form.style, form.genres, sentMap)
      if (auto.length) setSelectedIds(new Set(auto.map((e) => e.id)))
    }
    setStep(2)
  }

  const openAddEditor = () => {
    setEditorForm(normalizeEditorTags({
      ...emptyEditor,
      style: form.style ? [form.style] : [],
      work_type: [...form.genres],
    }))
    setCustomWorkType('')
    setShowEditorForm(true)
  }

  const toggleEditorTag = (field: 'style' | 'work_type', tag: string) => {
    setEditorForm((f) => ({
      ...f,
      [field]: f[field].includes(tag) ? f[field].filter((x) => x !== tag) : [...f[field], tag],
    }))
  }

  const addCustomEditorWorkType = () => {
    const tag = customWorkType.trim()
    if (!tag || isPlanStyle(tag)) return
    if (!editorForm.work_type.includes(tag)) {
      setEditorForm((f) => ({ ...f, work_type: [...f.work_type, tag] }))
    }
    setCustomWorkType('')
  }

  const saveEditor = async () => {
    const email = editorForm.email.trim().toLowerCase()
    if (!isValidEmail(editorForm.email)) { toast('请填写有效的收稿邮箱', 'warning'); return }
    const payload = normalizeEditorTags({ ...editorForm, email })
    if (!payload.style.some((d) => d.trim()) && !payload.work_type.some((d) => d.trim())) {
      toast('请至少填一个风格或作品类型', 'warning')
      return
    }
    if (editors.some((e) => e.email.toLowerCase() === email)) {
      toast('这个邮箱已经在编辑库里了', 'warning')
      return
    }
    setSavingEditor(true)
    try {
      const id = await api.addEditor(payload)
      await onReloadEditors()
      setSelectedIds((prev) => new Set(prev).add(id))
      setShowEditorForm(false)
      toast('编辑已加入资料库', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setSavingEditor(false) }
  }

  const testSend = async () => {
    if (!form.title.trim() || !form.body.trim()) { toast('请先填作品名称和邮件正文', 'warning'); return }
    const account = selectedAccounts[0]
    if (!account) { toast('还没有勾选参与发送的邮箱，请先勾选一个', 'warning'); return }
    // 测试邮件只发到发件邮箱自己，绝不发给编辑。有勾选编辑时按第一位编辑填充占位符，方便预览实际效果。
    const first = selectedEditors[0]
    setTesting(true)
    try {
      const subject = fillPlaceholders(form.subject.trim() || form.title, first ? editorRecipient(first) : '', form.title)
      const body = fillPlaceholders(form.body, first ? editorRecipient(first) : '', form.title)
      // 测试邮件也带上附件：新导入的文件直接用字节；编辑已有计划时按稿件 id 从数据库读已保存的附件。
      const attachment = form.file_data?.length
        ? { name: form.file_name, data: form.file_data }
        : null
      const result = await api.sendTestEmail(
        account.id, editing?.id ?? null, attachment, account.email,
        form.sender_name || account.sender_name, subject, body, form.content_type,
      )
      toast(result, 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setTesting(false) }
  }

  const blockers = [
    !form.title.trim() && '作品名称',
    !form.body.trim() && '邮件正文',
    sendCount === 0 && '待发送的收件人',
    !selectedAccounts.length && '参与发送的邮箱',
  ].filter(Boolean) as string[]

  const toggleAccount = (id: number) => {
    setTaskForm((f) => {
      const current = f.account_ids.length ? f.account_ids : enabledAccounts.map((a) => a.id)
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
      return { ...f, account_ids: next }
    })
  }

  const steps = [
    { n: 1, label: '填写投稿内容' },
    { n: 2, label: '选择编辑' },
    { n: 3, label: '选择发送邮箱' },
  ]

  return (
    <div className="plan-desk">
      <header className="plan-bar">
        <div className="plan-bar-left">
          <button className="plan-back" onClick={onClose}><ArrowLeft size={16} />返回</button>
          <strong className="plan-bar-name">{form.title.trim() || (editing ? '编辑计划' : '新建计划')}</strong>
        </div>
        <div className="plan-steps" role="tablist" aria-label="新建投稿步骤">
          {steps.map((s) => (
            <button key={s.n} type="button" role="tab" aria-selected={step === s.n}
              className={`plan-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`}
              onClick={() => setStep(s.n)}>
              <i>{s.n}</i>{s.label}
            </button>
          ))}
        </div>
        <div className="plan-bar-actions">
          <Button variant="ghost" disabled={saving} onClick={onSaveDraft}>保存草稿</Button>
        </div>
      </header>

      <div className="plan-step-body">
        {step === 1 && (
          <section className="plan-sheet plan-step-1">
            <div className="plan-work-card">
              <div className="plan-file-title">
                <div
                  className={`plan-drop ${dragging ? 'is-over' : ''} ${form.file_name ? 'has-file' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); setMailDirty(false); void onImportFile(e.dataTransfer.files[0] ?? null) }}
                >
                  <input ref={fileRef} type="file" accept=".docx,.txt,.md,.html,.htm" hidden
                    onChange={(e) => { setMailDirty(false); void onImportFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
                  <Button variant="ghost" onClick={() => fileRef.current?.click()}><FileUp size={15} />选择文件</Button>
                  <b>{form.file_name || '未选文件'}</b>
                  {(form.file_data || form.has_file) && <small className="file-attach-hint">✓ 发送时会作为附件附带</small>}
                </div>
                <input className="plan-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="作品名称" />
              </div>

              <div className="plan-meta">
                <label>字数
                  <input type="number" min={0} value={form.word_count || ''}
                    onChange={(e) => setForm({ ...form, word_count: Number(e.target.value) || 0 })} />
                </label>
                <label>篇幅
                  <Select value={form.category} onChange={(value) => setForm({ ...form, category: value })} ariaLabel="选择作品篇幅"
                    options={[{ value: '', label: '未选' }, ...CATEGORIES.map((x) => ({ value: x, label: x }))]} />
                </label>
                <label>风格
                  <Select value={form.style} onChange={(value) => setForm({ ...form, style: value })} ariaLabel="选择作品风格"
                    options={[{ value: '', label: '未选' }, ...STYLES.map((x) => ({ value: x, label: x }))]} />
                </label>
              </div>

              <div className="plan-genre-row">
                <span>作品类型（按编辑库筛选，可多选）</span>
                {genreChips.length ? (
                  <div className="field-filter-chips">
                    {genreChips.map(([tag, count]) => (
                      <button type="button" key={tag} className={`field-chip ${form.genres.includes(tag) ? 'on' : ''}`}
                        onClick={() => setForm((f) => ({
                          ...f,
                          genres: f.genres.includes(tag) ? f.genres.filter((x) => x !== tag) : [...f.genres, tag],
                        }))}>
                        {tag}{count > 0 && <small>{count}</small>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="field-filter-empty">
                    {editors.length
                      ? '编辑库里还没有作品类型。去编辑页补上后再筛。'
                      : '还没有编辑，先去编辑页存收稿人。'}
                  </p>
                )}
              </div>

              <div className="plan-mail">
                <input value={form.subject} onChange={(e) => { setMailDirty(true); setForm({ ...form, subject: e.target.value }) }}
                  placeholder="标题+字数+作品类型" />
                <textarea className="plan-body" rows={5} value={form.body}
                  onChange={(e) => { setMailDirty(true); setForm({ ...form, body: e.target.value }) }}
                  placeholder={'尊敬的编辑大大：\n\n辛苦审阅，期待您的意见！'} />
                {liveCount > 0 && <div className="plan-body-meta">作品 {liveCount} 字</div>}
              </div>
            </div>
            <div className="step-actions">
              <Button variant="primary" onClick={goToStep2}>下一步：选择编辑</Button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="plan-step-2">
            <div className="step-toolbar">
              <span className="step-meta">已选 <strong>{selectedIds.size}</strong> / {editors.length} 位编辑</span>
              <Button size="sm" onClick={openAddEditor}><Plus size={14} />添加编辑</Button>
            </div>
            <EditorsList
              items={editors}
              selectable
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              pageSize={6}
              emptyText="还没有编辑，先去编辑页存收稿人，也可以点右上角「添加编辑」。"
            />
            {!!orphans.length && (
              <p className="step-orphan">另有 {orphans.length} 位保存过的收件人不在编辑库中，将保留发送。</p>
            )}
            <div className="step-actions">
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button variant="primary" onClick={() => setStep(3)}>下一步：选择邮箱</Button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="plan-step-3">
            <div className="plan-work-card">
              <h3 className="plan-send-title">选择发送邮箱</h3>
              <p className="plan-send-desc">勾选参与发送的邮箱，多选时按顺序轮流使用。</p>
              <div className="account-pick-list">
                {enabledAccounts.map((account) => {
                  const on = !taskForm.account_ids.length || taskForm.account_ids.includes(account.id)
                  return (
                    <label key={account.id} className={`account-pick-row ${on ? 'on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleAccount(account.id)}
                        aria-label={`${on ? '取消选择' : '选择'} ${account.email}`} />
                      <span className="account-pick-main">
                        <b>{account.email}</b>
                        <small>{account.sender_name || '未设笔名'} · {providerName[account.provider] ?? account.provider}</small>
                      </span>
                      <span className="account-pick-check"><Check size={15} /></span>
                    </label>
                  )
                })}
                {!enabledAccounts.length && (
                  <p className="account-pick-empty">还没有启用邮箱，去「邮箱」页添加并启用后再来。</p>
                )}
              </div>
            </div>

            <div className="plan-work-card plan-send-summary-card">
              <div className="plan-send-summary">
                <div className="plan-estimate">
                  <Clock3 size={15} />
                  <span>已选编辑 {recipients.length} 位{orphans.length ? `（含 ${orphans.length} 位不在编辑库）` : ''}</span>
                </div>
                <div className="plan-estimate">
                  <Clock3 size={15} />
                  <span>{sendCount > 0 ? `约 ${minutes} 分钟发完 ${sendCount} 封` : '等待选择编辑'}</span>
                </div>
              </div>
              <div className="plan-rhythm">
                <Clock3 size={15} />
                <div>
                  <strong>固定节奏</strong>
                  <p>每封邮件间隔 2–4 分钟随机发送，时间点偏向 3 分钟，更像人工投稿。无需设置频次。</p>
                </div>
              </div>
              {!enabledAccounts.length && <p className="warn-text">还没有可用发件邮箱，只能先存草稿。</p>}
              {!ready && blockers.length > 0 && (
                <p className="warn-text">还不能发送：{blockers.join('、')}。测试发送会把一封预览邮件发到你的发件邮箱（勾选的第一个邮箱），不会发给编辑。</p>
              )}
              <div className="plan-send-actions">
                <Button variant="ghost" disabled={saving || testing} onClick={() => void testSend()}>
                  {testing ? '发送中…' : '测试发送'}
                </Button>
                <Button variant="primary" disabled={saving || !ready} onClick={() => onSaveAndSend()}>
                  <Send size={15} />开始发送
                </Button>
              </div>
            </div>
            <div className="step-actions">
              <Button onClick={() => setStep(2)}>上一步</Button>
            </div>
          </section>
        )}
      </div>

      {showEditorForm && (
        <Modal title="添加编辑" width={520}
          onClose={() => setShowEditorForm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setShowEditorForm(false)}>取消</Button>
              <Button variant="primary" disabled={savingEditor} onClick={() => void saveEditor()}>保存到编辑库</Button>
            </>
          }>
          <div className="form-grid">
            <label className="field">平台
              <input value={editorForm.platform} onChange={(e) => setEditorForm({ ...editorForm, platform: e.target.value })} placeholder="选填，例如：起点、晋江" list="plan-editor-platforms" />
            </label>
            <label className="field">名称
              <input value={editorForm.name} onChange={(e) => setEditorForm({ ...editorForm, name: e.target.value })} placeholder="选填，编辑或栏目名" />
            </label>
            <label className="field span2">收稿邮箱（必填）
              <input value={editorForm.email} onChange={(e) => setEditorForm({ ...editorForm, email: e.target.value })} placeholder="editor@example.com" />
            </label>
            <div className="field span2">风格
              <div className="chip-picks">
                {STYLES.map((g) => (
                  <button type="button" key={g} className={`chip ${editorForm.style.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleEditorTag('style', g)}>{g}</button>
                ))}
              </div>
            </div>
            <div className="field span2">作品类型
              <div className="chip-picks">
                {[...new Set([...GENRES, ...editorForm.work_type.filter((tag) => !isPlanStyle(tag))])].map((g) => (
                  <button type="button" key={g} className={`chip ${editorForm.work_type.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleEditorTag('work_type', g)}>{g}</button>
                ))}
              </div>
              <div className="editor-custom-tag">
                <input value={customWorkType} onChange={(e) => setCustomWorkType(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomEditorWorkType() } }}
                  placeholder="自定义作品类型，回车添加" />
                <Button size="sm" onClick={addCustomEditorWorkType}>添加</Button>
              </div>
              <span className="field-hint">会直接写入编辑库，同一邮箱不能重复添加。</span>
            </div>
          </div>
          <datalist id="plan-editor-platforms">
            {platforms.map((p) => <option key={p} value={p} />)}
          </datalist>
        </Modal>
      )}
    </div>
  )
}
