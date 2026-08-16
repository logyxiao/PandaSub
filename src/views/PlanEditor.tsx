import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Clock3, FileUp, Plus, Send, Trash2 } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useToast } from '../components/feedback'
import { Button } from '../components/ui'
import { isValidEmail, parseRecipient, providerName } from '../format'
import type { Account, Delivery, Editor, EditorInput, MailTemplate, Manuscript, ManuscriptInput, TaskInput } from '../types'
import {
  GENRES, LENGTH_TAGS, editorRecipient, editorWorkTypeOptions, estimateAutoMinutes,
  fillPlaceholders, isLengthTag, lengthTagsFromWords, normalizeEditorTags, splitPlanTags,
  defaultMailTemplates, pickOneEditorPerPlatform, sentCountByEmail,
} from './planShared'
import { EditorsList } from './Editors'

const emptyEditor: EditorInput = {
  platform: '', name: '', email: '', work_type: [], notes: '',
}

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
  const [listCount, setListCount] = useState<number | null>(null)
  const [activeTplId, setActiveTplId] = useState(() => form.mail_templates[0]?.id ?? 't1')
  const [showEditorForm, setShowEditorForm] = useState(false)
  const [editorForm, setEditorForm] = useState<EditorInput>(emptyEditor)
  const [customWorkType, setCustomWorkType] = useState('')
  const [savingEditor, setSavingEditor] = useState(false)
  const [testing, setTesting] = useState(false)
  const initRef = useRef(false)
  const lastAutoPick = useRef<string | null>(null)

  const sentMap = useMemo(() => sentCountByEmail(deliveries), [deliveries])
  const platforms = useMemo(
    () => [...new Set(editors.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [editors],
  )
  const workTypeOptions = useMemo(
    () => editorWorkTypeOptions(editors),
    [editors],
  )
  const lengthChips = useMemo(
    () => LENGTH_TAGS.map((tag) => [tag, workTypeOptions.find(([item]) => item === tag)?.[1] ?? 0] as const),
    [workTypeOptions],
  )
  const genreChips = useMemo(() => {
    const fromEditors = workTypeOptions.filter(([tag]) => !isLengthTag(tag))
    const extra = splitPlanTags(form.genres).genres.filter((g) => !fromEditors.some(([tag]) => tag === g))
    return [
      ...fromEditors,
      ...extra.map((tag) => [tag, 0] as const),
    ]
  }, [workTypeOptions, form.genres])
  const excluded = form.excluded_types ?? []

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
  const mailTemplates = form.mail_templates?.length ? form.mail_templates : defaultMailTemplates()
  const activeTpl = mailTemplates.find((item) => item.id === activeTplId) ?? mailTemplates[0]
  const ready = Boolean(
    form.title.trim()
    && mailTemplates.some((item) => item.body.trim())
    && sendCount > 0
    && selectedAccounts.length,
  )

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
    const suggested = lengthTagsFromWords(form.word_count)
    if (!suggested.length) return
    setForm((f) => {
      const { genres } = splitPlanTags(f.genres)
      const next = [...suggested, ...genres]
      const category = suggested.join('、')
      if (f.category === category && f.genres.length === next.length && f.genres.every((tag, i) => tag === next[i])) return f
      return { ...f, genres: next, category }
    })
  }, [form.word_count, setForm])

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

  const togglePlanTag = (tag: string) => {
    setForm((f) => {
      const excludedTypes = (f.excluded_types ?? []).filter((item) => item !== tag)
      const genres = f.genres.includes(tag) ? f.genres.filter((item) => item !== tag) : [...f.genres, tag]
      const { lengths } = splitPlanTags(genres)
      return { ...f, genres, excluded_types: excludedTypes, category: lengths.join('、') }
    })
  }
  const excludePlanTag = (tag: string) => {
    setForm((f) => ({
      ...f,
      genres: f.genres.filter((item) => item !== tag),
      excluded_types: (f.excluded_types ?? []).includes(tag)
        ? (f.excluded_types ?? []).filter((item) => item !== tag)
        : [...(f.excluded_types ?? []), tag],
    }))
  }

  // 新建时进入第二步按篇幅 + 作品类型匹配（每个平台一位），用户可自行增删。
  // 第一步筛选变了才重算；同筛选下再进第二步，保留用户勾选。
  const goToStep2 = () => {
    if (!editing) {
      const key = `${form.genres.join('\0')}::${excluded.join('\0')}`
      if (lastAutoPick.current !== key) {
        lastAutoPick.current = key
        const { picked: auto } = pickOneEditorPerPlatform(editors, form.genres, sentMap, {}, excluded)
        setSelectedIds(new Set(auto.map((e) => e.id)))
      }
    }
    setStep(2)
  }

  const openAddEditor = () => {
    setEditorForm(normalizeEditorTags({
      ...emptyEditor,
      work_type: [...form.genres],
    }))
    setCustomWorkType('')
    setShowEditorForm(true)
  }

  const toggleEditorTag = (tag: string) => {
    setEditorForm((f) => ({
      ...f,
      work_type: f.work_type.includes(tag) ? f.work_type.filter((x) => x !== tag) : [...f.work_type, tag],
    }))
  }

  const addCustomEditorWorkType = () => {
    const tag = customWorkType.trim()
    if (!tag) return
    if (!editorForm.work_type.includes(tag)) {
      setEditorForm((f) => ({ ...f, work_type: [...f.work_type, tag] }))
    }
    setCustomWorkType('')
  }

  const saveEditor = async () => {
    const email = editorForm.email.trim().toLowerCase()
    if (!isValidEmail(editorForm.email)) { toast('请填写有效的收稿邮箱', 'warning'); return }
    const payload = normalizeEditorTags({ ...editorForm, email })
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

  const writeTemplates = (next: MailTemplate[], currentId = activeTplId) => {
    const current = next.find((item) => item.id === currentId) ?? next[0]
    setForm((f) => ({
      ...f,
      mail_templates: next,
      subject: current?.subject ?? '',
      body: current?.body ?? '',
    }))
  }

  const updateActiveTpl = (patch: Partial<MailTemplate>) => {
    if (!activeTpl) return
    writeTemplates(mailTemplates.map((item) => item.id === activeTpl.id ? { ...item, ...patch } : item))
  }

  const addTemplate = () => {
    const item: MailTemplate = {
      id: `tpl-${Date.now()}`,
      name: `模板 ${mailTemplates.length + 1}`,
      subject: '投稿：《{{作品名}}》',
      body: '尊敬的{{编辑昵称}}：\n\n现将作品《{{作品名}}》投至贵处，请审阅。谢谢。',
    }
    writeTemplates([...mailTemplates, item], item.id)
    setActiveTplId(item.id)
  }

  const removeTemplate = () => {
    if (!activeTpl || mailTemplates.length <= 1) {
      toast('至少保留一套模板', 'warning')
      return
    }
    const index = mailTemplates.findIndex((item) => item.id === activeTpl.id)
    const next = mailTemplates.filter((item) => item.id !== activeTpl.id)
    const fallback = next[Math.max(0, index - 1)] ?? next[0]
    writeTemplates(next, fallback.id)
    setActiveTplId(fallback.id)
  }

  const testSend = async () => {
    if (!form.title.trim() || !activeTpl?.body.trim()) { toast('请先填作品名称和当前模板正文', 'warning'); return }
    const account = selectedAccounts[0]
    if (!account) { toast('还没有勾选参与发送的邮箱，请先勾选一个', 'warning'); return }
    // 测试邮件只发到发件邮箱自己，绝不发给编辑。有勾选编辑时按第一位编辑填充占位符，方便预览实际效果。
    const first = selectedEditors[0]
    const extras = { wordCount: form.word_count, genres: form.genres, category: form.category }
    setTesting(true)
    try {
      const subject = fillPlaceholders(activeTpl.subject.trim() || form.title, first ? editorRecipient(first) : '', form.title, extras)
      const body = fillPlaceholders(activeTpl.body, first ? editorRecipient(first) : '', form.title, extras)
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
    !mailTemplates.some((item) => item.body.trim()) && '邮件正文',
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
              onClick={() => (s.n === 2 ? goToStep2() : setStep(s.n))}>
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
          <section className="plan-step-1">
            <div className="plan-step-1-split">
              <div className="plan-work-card plan-step-1-left">
                <div className="plan-file-title">
                  <div
                    className={`plan-drop ${dragging ? 'is-over' : ''} ${form.file_name ? 'has-file' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setDragging(false); void onImportFile(e.dataTransfer.files[0] ?? null) }}
                  >
                    <input ref={fileRef} type="file" accept=".docx,.txt,.md,.html,.htm" hidden
                      onChange={(e) => { void onImportFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
                    <Button variant="ghost" onClick={() => fileRef.current?.click()}><FileUp size={15} />选择文件</Button>
                    <b>{form.file_name || '未选文件'}</b>
                    {(form.file_data || form.has_file) && <small className="file-attach-hint">✓ 发送时会作为附件附带</small>}
                  </div>
                </div>
                <div className="plan-title-row">
                  <input className="plan-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="作品名称" />
                  <label className="plan-word-count">字数
                    <input type="number" min={0} value={form.word_count || ''}
                      onChange={(e) => setForm({ ...form, word_count: Number(e.target.value) || 0 })} />
                  </label>
                </div>

                <div className="plan-genre-row">
                  <span>篇幅（按编辑库短篇 / 中短篇筛选，可多选）</span>
                  <div className="field-filter-chips">
                    {lengthChips.map(([tag, count]) => (
                      <button type="button" key={tag}
                        className={`field-chip ${form.genres.includes(tag) ? 'on' : ''} ${excluded.includes(tag) ? 'is-excluded' : ''}`}
                        onClick={() => togglePlanTag(tag)}
                        onContextMenu={(ev) => { ev.preventDefault(); excludePlanTag(tag) }}>
                        {tag}{count > 0 && <small>{count}</small>}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="plan-genre-row is-grow">
                  <span>作品类型（按编辑库筛选，可多选，右键排除）</span>
                  {genreChips.length ? (
                    <div className="field-filter-chips">
                      {genreChips.map(([tag, count]) => (
                        <button type="button" key={tag} title="左键筛选，右键排除"
                          className={`field-chip ${form.genres.includes(tag) ? 'on' : ''} ${excluded.includes(tag) ? 'is-excluded' : ''}`}
                          onClick={() => togglePlanTag(tag)}
                          onContextMenu={(ev) => { ev.preventDefault(); excludePlanTag(tag) }}>
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
              </div>

              <div className="plan-work-card plan-step-1-right">
                <div className="plan-tpl-head">
                  <div>
                    <strong>邮件模板</strong>
                    <p>发送时从这 {mailTemplates.length} 套里随机选用。测试发送用当前这套。</p>
                  </div>
                  <div className="plan-tpl-head-actions">
                    <Button size="sm" onClick={addTemplate}><Plus size={14} />新增</Button>
                    <Button size="sm" variant="danger" disabled={mailTemplates.length <= 1} onClick={removeTemplate}>
                      <Trash2 size={14} />删除
                    </Button>
                  </div>
                </div>
                <div className="plan-tpl-tabs" role="tablist" aria-label="邮件模板">
                  {mailTemplates.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={item.id === activeTpl?.id}
                      className={`plan-tpl-tab ${item.id === activeTpl?.id ? 'on' : ''}`}
                      onClick={() => { writeTemplates(mailTemplates, item.id); setActiveTplId(item.id) }}
                    >
                      {item.name.trim() || `模板 ${index + 1}`}
                    </button>
                  ))}
                </div>
                {activeTpl && (
                  <div className="plan-tpl-editor">
                    <label className="plan-tpl-name">模板名称
                      <input value={activeTpl.name} onChange={(e) => updateActiveTpl({ name: e.target.value })} placeholder="例如：常规问候" />
                    </label>
                    <input
                      className="plan-tpl-subject"
                      value={activeTpl.subject}
                      onChange={(e) => updateActiveTpl({ subject: e.target.value })}
                      placeholder="邮件标题，可用 {{作品名}} {{字数}} {{类型}}"
                    />
                    <textarea
                      className="plan-body"
                      value={activeTpl.body}
                      onChange={(e) => updateActiveTpl({ body: e.target.value })}
                      placeholder={'尊敬的{{编辑昵称}}：\n\n现将作品《{{作品名}}》投至贵处，请审阅。'}
                    />
                    <p className="plan-tpl-hint">占位符：{'{{作品名}}'} {'{{编辑昵称}}'} {'{{字数}}'} {'{{篇幅}}'} {'{{类型}}'}</p>
                  </div>
                )}
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
              <span className="step-meta">
                已选 <strong>{listCount ?? selectedIds.size}</strong> 位
                {listCount != null && listCount !== selectedIds.size && <> · 共选 {selectedIds.size} 位</>}
              </span>
              <Button size="sm" onClick={openAddEditor}><Plus size={14} />添加编辑</Button>
            </div>
            <EditorsList
              key={`plan-${form.genres.join('|')}-${excluded.join('|')}`}
              items={selectedEditors}
              selectable
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onTotalChange={setListCount}
              initialWorkTypes={form.genres}
              initialExcludedWorkTypes={excluded}
              pageSize={6}
              emptyText="还没有选中的编辑。返回上一步调整篇幅和作品类型，或点右上角添加。"
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
            <div className="field span2">作品类型
              <div className="chip-picks">
                {[...new Set([...GENRES, ...editorForm.work_type])].map((g) => (
                  <button type="button" key={g} className={`chip ${editorForm.work_type.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleEditorTag(g)}>{g}</button>
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
