import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Clock3, Copy, Eye, FileUp, Heart, HeartOff, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useToast } from '../components/feedback'
import { Button } from '../components/ui'
import { isValidEmail, parseRecipient, providerName } from '../format'
import type { Account, Editor, EditorInput, MailTemplate, Manuscript, ManuscriptInput, TaskInput } from '../types'
import {
  GENRES, LENGTH_TAGS, editorRecipient, editorWorkTypeOptions, estimateAutoMinutes,
  fillPlaceholders, isLengthTag, lengthTagsFromWords, normalizeEditorTags, splitPlanTags,
  defaultMailTemplates, editorPlatformKey, groupMatchingByPlatform, isDroppedMailTemplate,
  isEditorFavorited, mergeEditorSelectionByPlatform, normalizeSendIntervalMin,
  recipientEmailsForCopy, SEND_INTERVAL_OPTIONS, accountTodayQuota,
} from './planShared'
import { EditorsList, emptyEditorListFilters, type EditorListFilters } from './Editors'

const emptyEditor: EditorInput = {
  platform: '', name: '', email: '', work_type: [], rejected_types: [], notes: '',
}

export function PlanEditor({
  editing, editors, onReloadEditors, onFavoriteChange, enabledAccounts,
  form, setForm, taskForm, setTaskForm,
  saving, onClose, onSaveDraft, onSaveAndSend, onImportFile,
}: {
  editing: Manuscript | null
  editors: Editor[]
  onReloadEditors: () => Promise<void>
  onFavoriteChange?: (id: number, favorited: boolean) => void
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
  const [visibleEditors, setVisibleEditors] = useState<Editor[]>([])
  const [listFilters, setListFilters] = useState<EditorListFilters>(() =>
    emptyEditorListFilters(form.genres, form.excluded_types ?? []),
  )
  const pickKeyRef = useRef('')
  const [activeTplId, setActiveTplId] = useState(() => form.mail_templates[0]?.id ?? 't1')
  const [tplMode, setTplMode] = useState<'preview' | 'edit'>('preview')
  const [showEditorForm, setShowEditorForm] = useState(false)
  const [editingEditor, setEditingEditor] = useState<Editor | null>(null)
  const [editorForm, setEditorForm] = useState<EditorInput>(emptyEditor)
  const [customWorkType, setCustomWorkType] = useState('')
  const [customRejectedType, setCustomRejectedType] = useState('')
  const [savingEditor, setSavingEditor] = useState(false)
  const [testing, setTesting] = useState(false)
  const initRef = useRef(false)

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
  const excluded = useMemo(() => form.excluded_types ?? [], [form.excluded_types])

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

  const selectedEditors = useMemo(() => {
    const map = new Map(editors.map((editor) => [editor.id, editor]))
    return [...selectedIds].flatMap((id) => {
      const editor = map.get(id)
      return editor ? [editor] : []
    })
  }, [editors, selectedIds])

  // 收件名单 = 勾选的编辑 + 已保存但不在编辑库里的收件人（保留不丢）。
  const recipients = useMemo(
    () => [...selectedEditors.map(editorRecipient), ...orphans],
    [selectedEditors, orphans],
  )

  const sendCount = recipients.filter((r) => isValidEmail(r)).length

  const selectedAccounts = useMemo(() => {
    if (!taskForm.account_ids.length) return enabledAccounts
    return enabledAccounts.filter((account) => taskForm.account_ids.includes(account.id))
  }, [enabledAccounts, taskForm.account_ids])
  const sendIntervalMin = normalizeSendIntervalMin(form.send_interval_min)
  const minutes = estimateAutoMinutes(sendCount, sendIntervalMin)
  const mailTemplates = (form.mail_templates?.length ? form.mail_templates : defaultMailTemplates())
    .filter((item) => !isDroppedMailTemplate(item))
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
    setForm((f) => {
      const { genres } = splitPlanTags(f.genres)
      const next = [...suggested, ...genres]
      const category = suggested.join('、')
      if (f.category === category && f.genres.length === next.length && f.genres.every((tag, i) => tag === next[i])) return f
      return { ...f, genres: next, category }
    })
  }, [form.word_count, setForm])

  useEffect(() => {
    if (!form.mail_templates?.some(isDroppedMailTemplate)) return
    const kept = form.mail_templates.filter((item) => !isDroppedMailTemplate(item))
    const next = kept.length ? kept : defaultMailTemplates()
    const current = next.find((item) => item.id === activeTplId) ?? next[0]
    setForm((f) => ({ ...f, mail_templates: next, subject: current?.subject ?? f.subject, body: current?.body ?? f.body }))
    if (current && current.id !== activeTplId) setActiveTplId(current.id)
  }, [form.mail_templates, activeTplId, setForm])

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
      if (checked) {
        const key = editorPlatformKey(editor)
        for (const item of editors) {
          if (item.id !== editor.id && editorPlatformKey(item) === key) next.delete(item.id)
        }
        next.add(editor.id)
      } else {
        next.delete(editor.id)
      }
      return next
    })
  }

  const favoriteEditors = useMemo(
    () => visibleEditors.filter(isEditorFavorited),
    [visibleEditors],
  )
  const hasSelectedFavorite = favoriteEditors.some((editor) => selectedIds.has(editor.id))

  const selectFavoriteEditors = () => {
    setSelectedIds((prev) => {
      const pickByPlatform = new Map<string, Editor>()
      for (const editor of favoriteEditors) {
        const key = editorPlatformKey(editor)
        const current = pickByPlatform.get(key)
        if (!current || (prev.has(editor.id) && !prev.has(current.id))) pickByPlatform.set(key, editor)
      }

      const next = new Set(prev)
      for (const item of editors) {
        if (pickByPlatform.has(editorPlatformKey(item))) next.delete(item.id)
      }
      for (const editor of pickByPlatform.values()) next.add(editor.id)
      return next
    })
  }

  const deselectFavoriteEditors = () => {
    const visibleFavoriteIds = new Set(favoriteEditors.map((editor) => editor.id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of visibleFavoriteIds) next.delete(id)
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

  const platformGroups = useMemo(() => {
    const selectedGenres = step === 2 ? listFilters.workTypes : form.genres
    const selectedExcluded = step === 2 ? listFilters.excludedWorkTypes : excluded
    return groupMatchingByPlatform(editors, selectedGenres, selectedExcluded)
  }, [editors, step, listFilters.workTypes, listFilters.excludedWorkTypes, form.genres, excluded])

  const matchKey = `${form.genres.join('\0')}::${excluded.join('\0')}`

  // 标签变了就按匹配结果补齐勾选：每个平台一位，已经换过的人还在。返回上一步会保留筛选。
  const goToStep2 = () => {
    if (pickKeyRef.current !== matchKey) {
      setSelectedIds((prev) => mergeEditorSelectionByPlatform(editors, prev, form.genres, excluded))
      setListFilters(emptyEditorListFilters(form.genres, excluded))
      pickKeyRef.current = matchKey
    }
    setStep(2)
  }

  const goToStep3 = () => {
    if (!sendCount) {
      toast('还没有选择编辑，先从编辑库勾选，或返回上一步调整筛选', 'warning')
      return
    }
    setStep(3)
  }

  const platformPeersOf = (editor: Editor) => platformGroups.get(editorPlatformKey(editor)) ?? [editor]

  const replacePlatformEditor = (current: Editor, next: Editor) => {
    setSelectedIds((prev) => {
      const ids = new Set<number>()
      for (const id of prev) {
        if (id === current.id) ids.add(next.id)
        else if (id !== next.id) ids.add(id)
      }
      return ids
    })
  }

  const openAddEditor = () => {
    setEditingEditor(null)
    setEditorForm(normalizeEditorTags({
      ...emptyEditor,
      work_type: [...form.genres],
    }))
    setCustomWorkType('')
    setCustomRejectedType('')
    setShowEditorForm(true)
  }

  const openEditEditor = (editor: Editor) => {
    const next = normalizeEditorTags(editor)
    setEditingEditor(next)
    setEditorForm({
      platform: next.platform,
      name: next.name,
      email: next.email,
      work_type: next.work_type,
      rejected_types: next.rejected_types ?? [],
      notes: next.notes ?? '',
    })
    setCustomWorkType('')
    setCustomRejectedType('')
    setShowEditorForm(true)
  }

  const toggleEditorTag = (tag: string) => {
    setEditorForm((f) => {
      const work_type = f.work_type.includes(tag) ? f.work_type.filter((x) => x !== tag) : [...f.work_type, tag]
      const rejected_types = work_type.includes(tag)
        ? (f.rejected_types ?? []).filter((x) => x !== tag)
        : (f.rejected_types ?? [])
      return { ...f, work_type, rejected_types }
    })
  }

  const toggleEditorRejectedTag = (tag: string) => {
    setEditorForm((f) => {
      const current = f.rejected_types ?? []
      const rejected_types = current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]
      const work_type = rejected_types.includes(tag) ? f.work_type.filter((x) => x !== tag) : f.work_type
      return { ...f, work_type, rejected_types }
    })
  }

  const addCustomEditorWorkType = () => {
    const tag = customWorkType.trim()
    if (!tag) return
    setEditorForm((f) => {
      const work_type = f.work_type.includes(tag) ? f.work_type : [...f.work_type, tag]
      const rejected_types = (f.rejected_types ?? []).filter((x) => x !== tag)
      return { ...f, work_type, rejected_types }
    })
    setCustomWorkType('')
  }

  const addCustomEditorRejectedType = () => {
    const tag = customRejectedType.trim()
    if (!tag) return
    setEditorForm((f) => {
      const current = f.rejected_types ?? []
      const rejected_types = current.includes(tag) ? current : [...current, tag]
      const work_type = f.work_type.filter((x) => x !== tag)
      return { ...f, work_type, rejected_types }
    })
    setCustomRejectedType('')
  }

  const saveEditor = async () => {
    const email = editorForm.email.trim().toLowerCase()
    if (!isValidEmail(editorForm.email)) { toast('请填写有效的收稿邮箱', 'warning'); return }
    const payload = normalizeEditorTags({ ...editorForm, email })
    const clash = editors.some((e) => e.email.toLowerCase() === email && e.id !== editingEditor?.id)
    if (clash) {
      toast('这个邮箱已经在编辑库里了', 'warning')
      return
    }
    setSavingEditor(true)
    try {
      if (editingEditor) {
        await api.updateEditor(editingEditor.id, payload)
        await onReloadEditors()
        setSelectedIds((prev) => {
          if (!prev.has(editingEditor.id)) return prev
          const next = new Set(prev)
          for (const item of editors) {
            if (item.id !== editingEditor.id && next.has(item.id) && editorPlatformKey(item) === editorPlatformKey(payload)) {
              next.delete(item.id)
            }
          }
          next.add(editingEditor.id)
          return next
        })
        setShowEditorForm(false)
        toast('编辑资料已更新', 'success')
      } else {
        const id = await api.addEditor(payload)
        await onReloadEditors()
        setSelectedIds((prev) => {
          const next = new Set(prev)
          for (const item of editors) {
            if (next.has(item.id) && editorPlatformKey(item) === editorPlatformKey(payload)) next.delete(item.id)
          }
          next.add(id)
          return next
        })
        setShowEditorForm(false)
        toast('编辑已加入资料库', 'success')
      }
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
      subject: '投稿：《{{作品名}}》+{{字数}}+{{类型}}',
      body: '尊敬的{{编辑昵称}}：\n\n现将作品《{{作品名}}》投至贵处，请审阅。谢谢。',
    }
    writeTemplates([...mailTemplates, item], item.id)
    setActiveTplId(item.id)
    setTplMode('edit')
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
      const subject = fillPlaceholders(activeTpl.subject.trim() || form.title, first ? editorRecipient(first) : '', form.title, { ...extras, asSubject: true })
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

  const overQuotaAccounts = selectedAccounts.filter((account) => accountTodayQuota(account.sent_today).over)

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

  const copyEditorList = async () => {
    const emails = recipientEmailsForCopy(recipients)
    if (!emails.length) {
      toast('还没有可复制的编辑邮箱', 'warning')
      return
    }
    const text = emails.join('; ')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      if (!ok) {
        toast('复制失败，请检查系统剪贴板权限', 'error')
        return
      }
    }
    toast(`已复制 ${emails.length} 个收稿邮箱，可粘贴到 QQ 邮箱群发`, 'success')
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
              onClick={() => {
                if (s.n === 2) goToStep2()
                else if (s.n === 3 && step === 2) goToStep3()
                else setStep(s.n)
              }}>
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
                  <>
                    <div className="plan-tpl-mode" role="tablist" aria-label="模板视图">
                      <button type="button" className={`plan-tpl-mode-btn ${tplMode === 'preview' ? 'is-on' : ''}`}
                        onClick={() => setTplMode('preview')}><Eye size={13} />预览</button>
                      <button type="button" className={`plan-tpl-mode-btn ${tplMode === 'edit' ? 'is-on' : ''}`}
                        onClick={() => setTplMode('edit')}><Pencil size={13} />编辑</button>
                    </div>
                    {tplMode === 'preview' ? (
                      <div className="plan-tpl-preview">
                        <p className="plan-tpl-preview-kicker">{activeTpl.name.trim() || '未命名模板'}</p>
                        <h4 className="plan-tpl-preview-subject">
                          {fillPlaceholders(
                            activeTpl.subject.trim() || '投稿：《{{作品名}}》',
                            selectedEditors[0] ? editorRecipient(selectedEditors[0]) : '',
                            form.title,
                            { wordCount: form.word_count, genres: form.genres, category: form.category, asSubject: true },
                          ) || '（标题为空）'}
                        </h4>
                        <pre className="plan-tpl-preview-body">
                          {fillPlaceholders(
                            activeTpl.body,
                            selectedEditors[0] ? editorRecipient(selectedEditors[0]) : '',
                            form.title,
                            { wordCount: form.word_count, genres: form.genres, category: form.category },
                          ) || '这套模板还没有正文'}
                        </pre>
                        <p className="plan-tpl-hint">按左侧作品信息填充。没选类型时，「类型：」整行不会出现。</p>
                      </div>
                    ) : (
                      <div className="plan-tpl-editor">
                        <label className="plan-tpl-name">模板名称
                          <input value={activeTpl.name} onChange={(e) => updateActiveTpl({ name: e.target.value })} placeholder="例如：常规问候" />
                        </label>
                        <input
                          className="plan-tpl-subject"
                          value={activeTpl.subject}
                          onChange={(e) => updateActiveTpl({ subject: e.target.value })}
                          placeholder="投稿：《{{作品名}}》+{{字数}}+{{类型}}"
                        />
                        <textarea
                          className="plan-body"
                          value={activeTpl.body}
                          onChange={(e) => updateActiveTpl({ body: e.target.value })}
                          placeholder={'尊敬的{{编辑昵称}}：\n\n现将作品《{{作品名}}》投至贵处，请审阅。'}
                        />
                        <p className="plan-tpl-hint">标题建议带 {'{{字数}}'} 和 {'{{类型}}'}（不含短篇 / 中短篇）。正文还可用 {'{{作品名}}'} {'{{编辑昵称}}'} {'{{篇幅}}'}。没选类型时不会带上「类型：」。</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="step-actions">
              <Button variant="primary" onClick={() => goToStep2()}>下一步：选择编辑</Button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="plan-step-2">
            <div className="step-toolbar">
              <span className="step-meta">
                共有 <strong>{listCount ?? 0}</strong> 条可选数据，已选 <strong>{selectedIds.size}</strong> 条
              </span>
              <Button size="sm" onClick={openAddEditor}><Plus size={14} />添加编辑</Button>
            </div>
            <EditorsList
              items={editors}
              selectable
              onePerPlatform
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onTotalChange={setListCount}
              onVisibleChange={setVisibleEditors}
              platformPeersOf={platformPeersOf}
              onReplaceEditor={replacePlatformEditor}
              onFavoriteChange={onFavoriteChange}
              onEdit={openEditEditor}
              filters={listFilters}
              onFiltersChange={(next) => {
                const tagsChanged = next.workTypes.join('\0') !== listFilters.workTypes.join('\0')
                  || next.excludedWorkTypes.join('\0') !== listFilters.excludedWorkTypes.join('\0')
                setListFilters(next)
                if (tagsChanged) {
                  setSelectedIds((prev) => mergeEditorSelectionByPlatform(
                    editors, prev, next.workTypes, next.excludedWorkTypes,
                  ))
                }
              }}
              pageSize={6}
              actions={
                <>
                  <Button size="sm" className="favorite-action" disabled={!favoriteEditors.length}
                    onClick={selectFavoriteEditors}>
                    <Heart size={12} />选择收藏编辑
                  </Button>
                  <Button size="sm" className="favorite-action is-remove" disabled={!hasSelectedFavorite}
                    onClick={deselectFavoriteEditors}>
                    <HeartOff size={12} />取消选择收藏编辑
                  </Button>
                </>
              }
              emptyText="没有符合筛选的编辑。可调整筛选，或点右上角从编辑库添加。"
            />
            {!!orphans.length && (
              <p className="step-orphan">另有 {orphans.length} 位保存过的收件人不在编辑库中，将保留发送。</p>
            )}
            <div className="step-actions">
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button variant="primary" onClick={goToStep3}>下一步：选择邮箱</Button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="plan-step-3">
            <div className="plan-work-card plan-step-3-left">
              <div className="plan-send-head">
                <div>
                  <h3 className="plan-send-title">选择发送邮箱</h3>
                  <p className="plan-send-desc">勾选参与发送的邮箱，多选时按顺序轮流使用。</p>
                </div>
                <Button size="sm" disabled={!sendCount} onClick={() => void copyEditorList()}>
                  <Copy size={14} />复制编辑列表
                </Button>
              </div>
              <div className="account-pick-list">
                {enabledAccounts.map((account) => {
                  const on = !taskForm.account_ids.length || taskForm.account_ids.includes(account.id)
                  const quota = accountTodayQuota(account.sent_today)
                  return (
                    <label key={account.id} className={`account-pick-row ${on ? 'on' : ''} ${quota.over ? 'is-over' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleAccount(account.id)}
                        aria-label={`${on ? '取消选择' : '选择'} ${account.email}`} />
                      <span className="account-pick-main">
                        <b>{account.email}</b>
                        <small>{account.sender_name || '未设笔名'} · {providerName[account.provider] ?? account.provider} · 今日 {quota.label}</small>
                        {quota.over && <small className="account-quota-warn">已达建议 80 封，建议不要再用这封发送</small>}
                      </span>
                      <span className="account-pick-check"><Check size={15} /></span>
                    </label>
                  )
                })}
                {!enabledAccounts.length && (
                  <p className="account-pick-empty">还没有启用邮箱，去「邮箱」页添加并启用后再来。</p>
                )}
              </div>
              <p className="plan-copy-hint">复制后是分号分隔的收稿邮箱，可粘贴到 QQ 邮箱「群发」收件人里，不必用本软件发送。</p>
            </div>

            <div className="plan-work-card plan-step-3-right">
              <div>
                <h3 className="plan-send-title">发送频率</h3>
                <p className="plan-send-desc">默认 3 分钟/次，仍按现在的 2–4 分钟随机节奏。其他档位按所选分钟数发送。</p>
              </div>
              <div className="send-interval-list" role="radiogroup" aria-label="发送频率">
                {SEND_INTERVAL_OPTIONS.map((item) => {
                  const on = sendIntervalMin === item.minutes
                  return (
                    <button key={item.minutes} type="button" role="radio" aria-checked={on}
                      className={`send-interval-row ${on ? 'on' : ''}`}
                      onClick={() => setForm((f) => ({ ...f, send_interval_min: item.minutes }))}>
                      <span className="send-interval-main">
                        <b>{item.minutes} 分钟/次</b>
                        <small>({item.hint})</small>
                      </span>
                      {on && <Check size={16} />}
                    </button>
                  )
                })}
              </div>
              {sendIntervalMin === 1 && selectedAccounts.length < 3 && (
                <p className="warn-text">1 分钟/次建议至少 3 个投稿邮箱，并同时投不同作品。</p>
              )}
              {sendIntervalMin === 2 && selectedAccounts.length < 2 && (
                <p className="warn-text">2 分钟/次建议至少配置 2 个投稿邮箱。</p>
              )}
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
              {overQuotaAccounts.length > 0 && (
                <p className="warn-text">
                  {overQuotaAccounts.map((account) => account.email).join('、')} 今日已达建议 80 封，建议今天不要再用这些邮箱发送。
                </p>
              )}
              {!enabledAccounts.length && <p className="warn-text">还没有可用发件邮箱，只能先存草稿。</p>}
              {!ready && blockers.length > 0 && (
                <p className="warn-text">还不能发送：{blockers.join('、')}。测试发送会把一封预览邮件发到你的发件邮箱（勾选的第一个邮箱），不会发给编辑。</p>
              )}
              <div className="plan-send-actions">
                <Button onClick={() => setStep(2)}>上一步</Button>
                <Button variant="ghost" disabled={saving || testing} onClick={() => void testSend()}>
                  {testing ? '发送中…' : '测试发送'}
                </Button>
                <Button variant="primary" disabled={saving || !ready} onClick={() => onSaveAndSend()}>
                  <Send size={15} />开始发送
                </Button>
              </div>
            </div>
          </section>
        )}
      </div>

      {showEditorForm && (
        <Modal title={editingEditor ? '修改编辑资料' : '添加编辑'} width={560}
          onClose={() => setShowEditorForm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setShowEditorForm(false)}>取消</Button>
              <Button variant="primary" disabled={savingEditor} onClick={() => void saveEditor()}>
                {editingEditor ? '保存修改' : '保存到编辑库'}
              </Button>
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
              <span className="field-hint">改完会写回编辑库，后面的计划也会用这份资料。</span>
            </div>
            <div className="field span2">拒收类型
              <div className="chip-picks">
                {[...new Set([...GENRES, ...(editorForm.rejected_types ?? [])])].map((g) => (
                  <button type="button" key={g} className={`chip ${(editorForm.rejected_types ?? []).includes(g) ? 'is-rejected' : ''}`}
                    onClick={() => toggleEditorRejectedTag(g)}>{g}</button>
                ))}
              </div>
              <div className="editor-custom-tag">
                <input value={customRejectedType} onChange={(e) => setCustomRejectedType(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomEditorRejectedType() } }}
                  placeholder="自定义拒收类型，回车添加" />
                <Button size="sm" onClick={addCustomEditorRejectedType}>添加</Button>
              </div>
              <span className="field-hint">选中计划标签时，会自动排除拒收对应类型的编辑。</span>
            </div>
            <label className="field span2">收稿说明
              <textarea className="editor-notes" rows={4} value={editorForm.notes}
                onChange={(e) => setEditorForm({ ...editorForm, notes: e.target.value })}
                placeholder="审稿、结算、收稿方向、不收题材等，选填" />
            </label>
            {editingEditor && (
              <p className="field-hint span2">
                当前来源：{editingEditor.source || '手动数据'}。保存后会记为手动数据。
              </p>
            )}
          </div>
          <datalist id="plan-editor-platforms">
            {platforms.map((p) => <option key={p} value={p} />)}
          </datalist>
        </Modal>
      )}
    </div>
  )
}
