import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCheck, Clock3, Copy, Eye, FileUp, FolderOpen, Heart, HeartOff, Mail, Paperclip, Pencil, Plus, Send, Square, Trash2, Users } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { GroupMemberPicker } from '../components/GroupMemberPicker'
import { useToast } from '../components/feedback'
import { Button, EmptyState } from '../components/ui'
import { isValidEmail, parseRecipient, providerName } from '../format'
import type { Account, Editor, EditorGroup, EditorInput, MailTemplate, Manuscript, ManuscriptInput, TaskInput } from '../types'
import {
  GENRES, LENGTH_TAGS, editorRecipient, editorWorkTypeOptions, estimateAutoMinutes,
  fillPlaceholders, isLengthTag, lengthTagsFromWords, normalizeEditorTags, splitPlanTags,
  defaultMailTemplates, editorPlatformKey, groupMatchingByPlatform, isDroppedMailTemplate,
  isEditorFavorited, isValidSendIntervalRange, mergeEditorSelectionByPlatform, normalizeSendIntervalRange,
  recipientEmailsForCopy, groupPlanRecipients, accountTodayQuota, MAX_SEND_INTERVAL_SEC,
  matchingEditorGroupId, summarizeEditorGroup,
} from './planShared'
import { EditorsList, emptyEditorListFilters, type EditorListFilters } from './Editors'

const emptyEditor: EditorInput = {
  platform: '', name: '', email: '', work_type: [], rejected_types: [], notes: '',
}

export function PlanEditor({
  editing, editors, editorGroups, onReloadEditors, onReloadEditorGroups, onFavoriteChange, enabledAccounts,
  form, setForm, taskForm, setTaskForm,
  saving, onClose, onSaveDraft, onSaveAndSend, onImportFile, onDefaultTemplatesChange,
}: {
  editing: Manuscript | null
  editors: Editor[]
  editorGroups: EditorGroup[]
  onReloadEditors: () => Promise<void>
  onReloadEditorGroups: () => Promise<void>
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
  onImportFile: (file: File | null) => Promise<void>
  onDefaultTemplatesChange: (templates: MailTemplate[]) => void
}) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [groupPlanIds, setGroupPlanIds] = useState<Set<number>>(new Set())
  const [showPlanMembers, setShowPlanMembers] = useState(false)
  const [planMemberDraft, setPlanMemberDraft] = useState<Set<number>>(new Set())
  const [orphans, setOrphans] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const dragDepth = useRef(0)
  const importPending = useRef(false)
  const [listCount, setListCount] = useState<number | null>(null)
  const [visibleEditors, setVisibleEditors] = useState<Editor[]>([])
  const [editorPickMode, setEditorPickMode] = useState<'groups' | 'all'>(
    () => (!editing && editorGroups.length > 0) ? 'groups' : 'all',
  )
  const [listFilters, setListFilters] = useState<EditorListFilters>(() =>
    emptyEditorListFilters(form.genres, form.excluded_types ?? []),
  )
  const pickKeyRef = useRef('')
  const [activeTplId, setActiveTplId] = useState(() => form.fixed_mail_template_id || form.mail_templates[0]?.id || 't1')
  const [tplMode, setTplMode] = useState<'preview' | 'edit'>('preview')
  const [showEditorForm, setShowEditorForm] = useState(false)
  const [editingEditor, setEditingEditor] = useState<Editor | null>(null)
  const [editorForm, setEditorForm] = useState<EditorInput>(emptyEditor)
  const [customWorkType, setCustomWorkType] = useState('')
  const [customRejectedType, setCustomRejectedType] = useState('')
  const [savingEditor, setSavingEditor] = useState(false)
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [editingGroup, setEditingGroup] = useState<EditorGroup | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupMemberIds, setGroupMemberIds] = useState<Set<number>>(new Set())
  const [savingGroup, setSavingGroup] = useState(false)
  const [testing, setTesting] = useState(false)
  const [sendIntervalTouched, setSendIntervalTouched] = useState(false)
  const initRef = useRef(false)

  const importManuscript = async (files: FileList | null) => {
    if (!files?.length || importPending.current) return
    if (files.length > 1) {
      toast('每个计划只能导入一份稿件，请只拖入一个文件', 'warning')
      return
    }
    importPending.current = true
    setImporting(true)
    try { await onImportFile(files[0]) }
    finally { importPending.current = false; setImporting(false) }
  }

  useEffect(() => {
    if (step !== 1) return
    // Prevent files dropped outside the target from navigating away from the plan.
    const preventFileNavigation = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      if (event.type === 'drop') {
        dragDepth.current = 0
        setDragging(false)
      }
    }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', preventFileNavigation)
      dragDepth.current = 0
      setDragging(false)
    }
  }, [step])

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
    const matched = matchingEditorGroupId(editorGroups, editors, ids)
    if (matched) {
      setSelectedGroupId(matched)
      setGroupPlanIds(ids)
      setEditorPickMode('groups')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入时初始化一次
  }, [])

  const groupPicks = useMemo(() => {
    const editorMap = new Map(editors.map((editor) => [editor.id, editor]))
    return editorGroups.map((group) => {
      const seenIds = new Set<number>()
      const members = group.editor_ids.flatMap((id) => {
        const editor = editorMap.get(id)
        if (!editor || seenIds.has(editor.id)) return []
        seenIds.add(editor.id)
        return [editor]
      })
      return { group, members }
    })
  }, [editorGroups, editors])

  // A selected group is copied into this plan, never a live reference to the library.
  const activeSelectedIds = editorPickMode === 'all' ? selectedIds : groupPlanIds

  const selectedEditors = useMemo(() => {
    const map = new Map(editors.map((editor) => [editor.id, editor]))
    return [...activeSelectedIds].flatMap((id) => {
      const editor = map.get(id)
      return editor ? [editor] : []
    })
  }, [activeSelectedIds, editors])

  useEffect(() => {
    const availableGroupIds = new Set(editorGroups.map((group) => group.id))
    setSelectedGroupId((current) => current && availableGroupIds.has(current) ? current : null)
  }, [editorGroups])

  // 两种方式保留独立名单；组内的临时增减只作用于当前计划。
  const recipients = useMemo(
    () => {
      if (editorPickMode === 'all') return [...selectedEditors.map(editorRecipient), ...orphans]
      return groupPlanRecipients(selectedEditors)
    },
    [editorPickMode, selectedEditors, orphans],
  )

  const sendCount = recipients.filter((r) => isValidEmail(r)).length

  const selectedAccounts = useMemo(() => {
    if (!taskForm.account_ids.length) return enabledAccounts
    return enabledAccounts.filter((account) => taskForm.account_ids.includes(account.id))
  }, [enabledAccounts, taskForm.account_ids])
  const sendIntervalValid = isValidSendIntervalRange(
    form.send_interval_from_sec,
    form.send_interval_to_sec,
  )
  const sendInterval = sendIntervalValid
    ? { fromSec: form.send_interval_from_sec, toSec: form.send_interval_to_sec }
    : normalizeSendIntervalRange(
      form.send_interval_from_sec,
      form.send_interval_to_sec,
      form.send_interval_min,
    )
  const minutes = estimateAutoMinutes(sendCount, sendInterval.fromSec, sendInterval.toSec)
  const updateSendInterval = (side: 'from' | 'to', raw: string) => {
    const value = raw === '' ? 0 : Math.round(Number(raw))
    setForm((current) => side === 'from'
      ? { ...current, send_interval_from_sec: value }
      : { ...current, send_interval_to_sec: value })
  }
  const mailTemplates = (form.mail_templates?.length ? form.mail_templates : defaultMailTemplates())
    .filter((item) => !isDroppedMailTemplate(item))
  const activeTpl = mailTemplates.find((item) => item.id === activeTplId) ?? mailTemplates[0]
  const fixedTemplate = mailTemplates.find((item) => item.id === form.fixed_mail_template_id)
  const ready = Boolean(
    form.title.trim()
    && (fixedTemplate ? fixedTemplate.body.trim() : mailTemplates.some((item) => item.body.trim()))
    && sendCount > 0
    && selectedAccounts.length
    && sendIntervalValid,
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

  const toggleEditorGroup = (groupId: number) => {
    const pick = groupPicks.find((item) => item.group.id === groupId)
    if (!pick?.members.length) return
    const selected = selectedGroupId === groupId
    setSelectedGroupId(selected ? null : groupId)
    setGroupPlanIds(new Set(selected ? [] : pick.members.map((editor) => editor.id)))
    toast(
      selected
        ? `已取消“${pick.group.name}”的 ${pick.members.length} 位编辑`
        : `已选“${pick.group.name}”的 ${pick.members.length} 位编辑`,
      'info',
    )
  }

  const openNewGroup = () => {
    setEditingGroup(null)
    setGroupName('')
    setGroupMemberIds(new Set())
    setShowGroupForm(true)
  }

  const openEditGroup = (group: EditorGroup) => {
    const availableIds = new Set(editors.map((editor) => editor.id))
    setEditingGroup(group)
    setGroupName(group.name)
    setGroupMemberIds(new Set(group.editor_ids.filter((id) => availableIds.has(id))))
    setShowGroupForm(true)
  }

  const openPlanMembers = () => {
    setPlanMemberDraft(new Set(groupPlanIds))
    setShowPlanMembers(true)
  }

  const savePlanAsGroup = () => {
    setEditingGroup(null)
    setGroupName(`${groupPicks.find((pick) => pick.group.id === selectedGroupId)?.group.name || '投稿名单'}（新组）`)
    setGroupMemberIds(new Set(groupPlanIds))
    setShowGroupForm(true)
  }

  const saveEditorGroup = async () => {
    const name = groupName.trim()
    if (!name) { toast('请填写编辑组名称', 'warning'); return }
    if (!groupMemberIds.size) { toast('请至少选择一位编辑', 'warning'); return }
    const editor_ids = editors.filter((editor) => groupMemberIds.has(editor.id)).map((editor) => editor.id)
    setSavingGroup(true)
    try {
      let createdId: number | null = null
      if (editingGroup) await api.updateEditorGroup(editingGroup.id, { name, editor_ids })
      else createdId = await api.createEditorGroup({ name, editor_ids })
      await onReloadEditorGroups()
      if (createdId) {
        setSelectedGroupId(createdId)
        setGroupPlanIds(new Set(editor_ids))
      }
      setShowGroupForm(false)
      toast(editingGroup ? '编辑组已更新' : '编辑组已创建并选中', 'success')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setSavingGroup(false)
    }
  }

  const favoriteEditors = useMemo(
    () => visibleEditors.filter(isEditorFavorited),
    [visibleEditors],
  )
  const hasSelectedFavorite = favoriteEditors.some((editor) => selectedIds.has(editor.id))
  const selectedResultPlatforms = useMemo(() => new Set(
    visibleEditors.filter((editor) => selectedIds.has(editor.id)).map(editorPlatformKey),
  ), [visibleEditors, selectedIds])
  const allResultsSelected = visibleEditors.length > 0
    && visibleEditors.every((editor) => selectedResultPlatforms.has(editorPlatformKey(editor)))

  // Results cover every page; keep an existing choice when search returns platform peers.
  const selectEditorResults = (candidates: Editor[]) => {
    setSelectedIds((prev) => {
      const pickByPlatform = new Map<string, Editor>()
      for (const editor of candidates) {
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

  const deselectEditorResults = (candidates: Editor[]) => {
    const resultIds = new Set(candidates.map((editor) => editor.id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of resultIds) next.delete(id)
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
      toast(
        editorPickMode === 'groups' ? '请先点选一个编辑组' : '还没有选择编辑，先从编辑库勾选，或返回上一步调整筛选',
        'warning',
      )
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

  const writeTemplates = (next: MailTemplate[], currentId = activeTplId, saveAsDefault = false) => {
    const current = next.find((item) => item.id === currentId) ?? next[0]
    setForm((f) => ({
      ...f,
      mail_templates: next,
      fixed_mail_template_id: next.some((item) => item.id === f.fixed_mail_template_id)
        ? f.fixed_mail_template_id
        : '',
      subject: current?.subject ?? '',
      body: current?.body ?? '',
    }))
    if (saveAsDefault) onDefaultTemplatesChange(next)
  }

  const updateActiveTpl = (patch: Partial<MailTemplate>) => {
    if (!activeTpl) return
    writeTemplates(mailTemplates.map((item) => item.id === activeTpl.id ? { ...item, ...patch } : item), activeTpl.id, true)
  }

  const addTemplate = () => {
    const item: MailTemplate = {
      id: `tpl-${Date.now()}`,
      name: `模板 ${mailTemplates.length + 1}`,
      subject: '投稿：《{{作品名}}》+{{字数}}+{{类型}}',
      body: '编辑老师您好：\n\n现将作品《{{作品名}}》投至贵处，恳请审阅。完整稿件已随信附上，谢谢。',
    }
    writeTemplates([...mailTemplates, item], item.id, true)
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
    writeTemplates(next, fallback.id, true)
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
    !sendIntervalValid && '有效的发送频率',
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
    { n: 1, label: '导入投稿内容' },
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
                <div className="plan-content-heading">
                  <span className="plan-content-icon"><BookOpen size={20} strokeWidth={1.7} /></span>
                  <div><h3>投稿作品</h3><p>导入稿件，再补充作品信息。</p></div>
                </div>
                <div className="plan-file-title">
                  <input ref={fileRef} type="file" accept=".docx,.txt,.md,.html,.htm" hidden
                    onChange={(e) => { void importManuscript(e.target.files); e.target.value = '' }} />
                  <button type="button"
                    className={`plan-drop ${dragging ? 'is-over' : ''} ${form.file_name ? 'has-file' : ''}`}
                    aria-label={form.file_name ? '拖拽或点击替换稿件' : '拖拽或点击导入稿件'}
                    aria-describedby="plan-drop-description"
                    aria-busy={importing}
                    disabled={importing}
                    onClick={() => fileRef.current?.click()}
                    onDragEnter={(e) => {
                      if (!e.dataTransfer.types.includes('Files')) return
                      e.preventDefault()
                      dragDepth.current += 1
                      setDragging(true)
                    }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes('Files')) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = importing ? 'none' : 'copy'
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault()
                      dragDepth.current = Math.max(0, dragDepth.current - 1)
                      if (!dragDepth.current) setDragging(false)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      dragDepth.current = 0
                      setDragging(false)
                      void importManuscript(e.dataTransfer.files)
                    }}
                  >
                    <span className="plan-drop-document" aria-hidden="true">
                      <FileUp size={32} strokeWidth={1.5} />
                      {form.file_name && <span className="plan-drop-check"><Check size={12} /></span>}
                    </span>
                    <span className="plan-drop-title" aria-live="polite">
                      {importing ? '正在读入稿件…' : dragging ? (form.file_name ? '松开鼠标，替换稿件' : '松开鼠标，导入稿件') : form.file_name || '把稿件拖到这里'}
                    </span>
                    <span className="plan-drop-description" id="plan-drop-description">
                      {form.file_name ? '已作为投稿附件 · 可拖入新文件替换' : '自动读取作品名称和字数，随投稿邮件附上原稿'}
                    </span>
                    <span className="plan-drop-formats" aria-label="支持的文件格式">
                      <span>DOCX</span><span>TXT</span><span>MD</span><span>HTML</span>
                    </span>
                    <span className="plan-drop-browse">{form.file_name ? '或点击替换文件' : '也可以点击上传'}</span>
                  </button>
                </div>
                <div className="plan-title-row">
                  <label className="plan-content-field">作品名称
                    <input className="plan-title-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="作品名称" />
                  </label>
                  <label className="plan-word-count plan-content-field">作品字数
                    <input type="number" min={0} value={form.word_count || ''}
                      placeholder="自动读取"
                      onChange={(e) => setForm({ ...form, word_count: Number(e.target.value) || 0 })} />
                  </label>
                </div>

                <div className="plan-genre-row">
                  <div className="plan-filter-heading"><strong>作品篇幅</strong><span>按字数推荐，可多选</span></div>
                  <div className="field-filter-chips">
                    {lengthChips.map(([tag, count]) => (
                      <button type="button" key={tag}
                        aria-pressed={form.genres.includes(tag)}
                        className={`field-chip ${form.genres.includes(tag) ? 'on' : ''} ${excluded.includes(tag) ? 'is-excluded' : ''}`}
                        onClick={() => togglePlanTag(tag)}
                        onContextMenu={(ev) => { ev.preventDefault(); excludePlanTag(tag) }}>
                        {tag}{count > 0 && <small>{count}</small>}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="plan-genre-row is-grow">
                  <div className="plan-filter-heading"><strong>作品类型</strong><span>可多选 · 右键排除</span></div>
                  {genreChips.length ? (
                    <div className="field-filter-chips">
                      {genreChips.map(([tag, count]) => (
                        <button type="button" key={tag} title="左键筛选，右键排除"
                          aria-pressed={form.genres.includes(tag)}
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
                  <p className="plan-filter-hint">下一步将根据篇幅和类型，为你匹配收稿编辑。</p>
                </div>
              </div>

              <div className="plan-work-card plan-step-1-right">
                <div className="plan-tpl-head">
                  <div className="plan-content-heading">
                    <span className="plan-content-icon"><Mail size={20} strokeWidth={1.7} /></span>
                    <div><h3>邮件模板</h3><p>写给编辑的话，随稿件一起发送。</p></div>
                  </div>
                  <div className="plan-tpl-head-actions">
                    <Button size="sm" onClick={addTemplate}><Plus size={14} />新增</Button>
                    <Button size="sm" variant="ghost" className="plan-tpl-delete" disabled={mailTemplates.length <= 1} onClick={removeTemplate}>
                      <Trash2 size={14} />删除
                    </Button>
                  </div>
                </div>
                <label className="plan-tpl-strategy">
                  <span><strong>发送时使用</strong><small>{fixedTemplate ? '每封邮件使用同一套模板' : `从 ${mailTemplates.length} 套模板中随机选用`}</small></span>
                  <select
                    value={form.fixed_mail_template_id}
                    onChange={(e) => {
                      const id = e.target.value
                      setForm((f) => ({ ...f, fixed_mail_template_id: id }))
                      if (id) setActiveTplId(id)
                    }}
                  >
                    <option value="">每封随机选择（默认）</option>
                    {mailTemplates.map((item, index) => (
                      <option key={item.id} value={item.id}>固定使用：{item.name.trim() || `模板 ${index + 1}`}</option>
                    ))}
                  </select>
                </label>
                <div className="plan-tpl-toolbar">
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
                    <div className="plan-tpl-mode" role="group" aria-label="模板视图">
                      <button type="button" aria-pressed={tplMode === 'preview'} className={`plan-tpl-mode-btn ${tplMode === 'preview' ? 'is-on' : ''}`}
                        onClick={() => setTplMode('preview')}><Eye size={14} />预览</button>
                      <button type="button" aria-pressed={tplMode === 'edit'} className={`plan-tpl-mode-btn ${tplMode === 'edit' ? 'is-on' : ''}`}
                        onClick={() => setTplMode('edit')}><Pencil size={14} />编辑</button>
                    </div>
                  )}
                </div>
                {activeTpl && (
                  <>
                    {tplMode === 'preview' ? (
                      <div className="plan-tpl-preview">
                        <p className="plan-tpl-preview-kicker">邮件主题</p>
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
                        <p className="plan-tpl-hint">预览已代入作品信息；未选类型时，自动省略「类型：」一行。</p>
                      </div>
                    ) : (
                      <div className="plan-tpl-editor">
                        <label className="plan-tpl-name">模板名称
                          <input value={activeTpl.name} onChange={(e) => updateActiveTpl({ name: e.target.value })} placeholder="例如：常规问候" />
                        </label>
                        <label className="plan-tpl-name">邮件主题
                          <input
                            className="plan-tpl-subject"
                            value={activeTpl.subject}
                            onChange={(e) => updateActiveTpl({ subject: e.target.value })}
                            placeholder="投稿：《{{作品名}}》+{{字数}}+{{类型}}"
                          />
                        </label>
                        <div className="plan-tpl-body-field">
                          <label htmlFor="plan-template-body">邮件正文</label>
                          <textarea
                            id="plan-template-body"
                            className="plan-body"
                            value={activeTpl.body}
                            onChange={(e) => updateActiveTpl({ body: e.target.value })}
                            placeholder={'编辑老师您好：\n\n现将作品《{{作品名}}》投至贵处，请审阅。'}
                          />
                        </div>
                        <p className="plan-tpl-hint">标题建议带 {'{{字数}}'} 和 {'{{类型}}'}（不含短篇 / 中短篇）。正文可用 {'{{作品名}}'} {'{{篇幅}}'} {'{{字数}}'} {'{{类型}}'}。没选类型时不会带上「类型：」。</p>
                      </div>
                    )}
                  </>
                )}
                <p className="plan-tpl-save-note">修改模板后，会自动保存为新计划的默认模板。</p>
              </div>
            </div>
            <div className="step-actions plan-content-actions">
              <span><Paperclip size={15} />{form.file_name ? `投稿附件：${form.file_name}` : '原稿将作为附件，邮件正文使用右侧模板'}</span>
              <Button variant="primary" onClick={() => goToStep2()}>下一步：选择编辑<ArrowRight size={16} /></Button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="plan-step-2">
            <div className="plan-work-card plan-recipient-workspace">
              <div className="plan-recipient-heading">
                <div className="plan-content-heading">
                  <span className="plan-content-icon"><Users size={20} strokeWidth={1.7} /></span>
                  <div><h3>选择收稿编辑</h3><p>使用常投名单，或从编辑库挑选这次的收稿人。</p></div>
                </div>
                {editorPickMode === 'groups'
                  ? <Button size="sm" onClick={openNewGroup}><Plus size={14} />新建编辑组</Button>
                  : <Button size="sm" onClick={openAddEditor}><Plus size={14} />添加编辑</Button>}
              </div>
              <div className="plan-editor-pick-nav">
                <div className="plan-editor-pick-tabs" role="tablist" aria-label="选择编辑方式">
                  <button type="button" role="tab" aria-selected={editorPickMode === 'groups'}
                    className={editorPickMode === 'groups' ? 'on' : ''} onClick={() => setEditorPickMode('groups')}>
                    <FolderOpen size={14} />编辑组<small>{groupPlanIds.size}</small>
                  </button>
                  <button type="button" role="tab" aria-selected={editorPickMode === 'all'}
                    className={editorPickMode === 'all' ? 'on' : ''} onClick={() => setEditorPickMode('all')}>
                    <Users size={14} />全部编辑<small>{selectedIds.size}</small>
                  </button>
                </div>
                <span className="step-meta">
                  {editorPickMode === 'groups'
                    ? selectedGroupId
                      ? <>已选「{groupPicks.find((pick) => pick.group.id === selectedGroupId)?.group.name}」<strong>{activeSelectedIds.size}</strong> 位，将投出 <strong>{recipients.length}</strong> 封</>
                      : <>共 <strong>{groupPicks.length}</strong> 个编辑组，点选一组即可用于这次投稿</>
                    : <>共有 <strong>{listCount ?? 0}</strong> 条可选数据，当前选择 <strong>{selectedIds.size}</strong> 位编辑</>}
                </span>
              </div>
              {editorPickMode === 'groups' ? (
                groupPicks.length ? (
                  <div className="plan-group-board">
                    <div className="plan-group-cards" role="radiogroup" aria-label="选择编辑组">
                      {groupPicks.map(({ group, members }) => {
                        const selected = selectedGroupId === group.id
                        const summary = summarizeEditorGroup(members)
                        return (
                          <div key={group.id} className={`plan-group-card ${selected ? 'on' : ''} ${!members.length ? 'is-empty' : ''}`}>
                            <button type="button" role="radio" aria-checked={selected}
                              className="plan-group-card-main" disabled={!members.length}
                              onClick={() => toggleEditorGroup(group.id)}>
                              <span className="plan-group-choice-check">{selected && <Check size={13} />}</span>
                              <span className="plan-group-card-copy">
                                <b>{group.name}</b>
                                <small>{summary.platformsLabel} · {summary.count} 位</small>
                              </span>
                            </button>
                            <button type="button" className="plan-group-card-edit" title="管理成员"
                              onClick={() => openEditGroup(group)}>
                              <Pencil size={13} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                    {selectedGroupId ? (
                      <div className="plan-group-roster">
                        <div className="plan-group-roster-head">
                          <div>
                            <b>这次将投给 {groupPlanIds.size} 位</b>
                            <p>有效邮箱 {recipients.length} 个。临时增减只影响这次，不会改原组。</p>
                          </div>
                          <Button size="sm" onClick={openPlanMembers}>调整名单</Button>
                          <Button size="sm" variant="ghost" disabled={!groupPlanIds.size} onClick={savePlanAsGroup}>存成新组</Button>
                        </div>
                        {selectedEditors.length ? (
                          <ul className="plan-group-faces">
                            {selectedEditors.slice(0, 14).map((editor) => (
                              <li key={editor.id} title={`${editor.name.trim() || '佚名'} · ${editor.email}`}>
                                <b>{editor.name.trim() || '佚名'}</b>
                                <small>{editor.platform.trim() || '未填平台'}</small>
                              </li>
                            ))}
                            {selectedEditors.length > 14 && (
                              <li className="plan-group-faces-more">+{selectedEditors.length - 14}</li>
                            )}
                          </ul>
                        ) : (
                          <p className="hint">名单是空的，点「调整名单」加人。</p>
                        )}
                      </div>
                    ) : (
                      <p className="plan-group-choice-hint">点选一个组，名单会复制到这次计划。之后临时加减人不会改原组。</p>
                    )}
                  </div>
                ) : (
                  <div className="panel">
                    <EmptyState icon={FolderOpen} title="还没有编辑组" desc="先把常投的人收成一组，之后投稿时点一下就能选入。"
                      action={<Button size="sm" variant="primary" onClick={openNewGroup}><Plus size={13} />新建编辑组</Button>} />
                  </div>
                )
              ) : (
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
                      <div className="plan-bulk-actions" role="group" aria-label="批量选择当前筛选结果">
                        <span>筛选结果</span>
                        <Button size="sm" disabled={!visibleEditors.length || allResultsSelected}
                          title="选中所有分页的筛选结果，每个平台保留一位编辑"
                          onClick={() => selectEditorResults(visibleEditors)}>
                          <CheckCheck size={13} />全选
                        </Button>
                        <Button size="sm" disabled={!selectedResultPlatforms.size}
                          title="取消所有分页筛选结果的勾选，保留筛选范围外的选择"
                          onClick={() => deselectEditorResults(visibleEditors)}>
                          <Square size={13} />取消全选
                        </Button>
                      </div>
                      <Button size="sm" className="favorite-action" disabled={!favoriteEditors.length}
                        onClick={() => selectEditorResults(favoriteEditors)}>
                        <Heart size={12} />选择收藏编辑
                      </Button>
                      <Button size="sm" className="favorite-action is-remove" disabled={!hasSelectedFavorite}
                        onClick={() => deselectEditorResults(favoriteEditors)}>
                        <HeartOff size={12} />取消选择收藏编辑
                      </Button>
                    </>
                  }
                  emptyText="没有符合筛选的编辑。可调整筛选，或点右上角从编辑库添加。"
                />
              )}
              {editorPickMode === 'all' && !!orphans.length && (
                <p className="step-orphan">另有 {orphans.length} 位保存过的收件人不在编辑库中，将保留发送。</p>
              )}
            </div>
            <div className="step-actions plan-content-actions">
              <span><Users size={15} />已选 {activeSelectedIds.size + (editorPickMode === 'all' ? orphans.length : 0)} 位编辑 · {sendCount} 个有效收稿邮箱</span>
              <div className="plan-footer-buttons">
                <Button onClick={() => setStep(1)}><ArrowLeft size={15} />上一步</Button>
                <Button variant="primary" onClick={goToStep3}>下一步：选择邮箱<ArrowRight size={16} /></Button>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="plan-step-3">
            <div className="plan-step-3-split">
              <div className="plan-work-card plan-step-3-left">
                <div className="plan-send-head">
                  <div className="plan-content-heading">
                    <span className="plan-content-icon"><Mail size={20} strokeWidth={1.7} /></span>
                    <div><h3>选择发送邮箱</h3><p>可多选，发送时按顺序轮流使用。</p></div>
                  </div>
                  <Button size="sm" disabled={!sendCount} onClick={() => void copyEditorList()}>
                    <Copy size={14} />复制编辑列表
                  </Button>
                </div>
                <div className="plan-account-caption"><strong>可用邮箱 <span>{enabledAccounts.length}</span></strong><span>已选 {selectedAccounts.length} 个</span></div>
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
                      </label>
                    )
                  })}
                  {!enabledAccounts.length && (
                    <p className="account-pick-empty">还没有启用邮箱，去「邮箱」页添加并启用后再来。</p>
                  )}
                </div>
                <div className="plan-copy-note"><Copy size={16} /><p className="plan-copy-hint">也可以复制收稿邮箱，粘贴到 QQ 邮箱「群发」收件人中，自行发送。</p></div>
              </div>

              <div className="plan-work-card plan-step-3-right">
                <div className="plan-content-heading">
                  <span className="plan-content-icon"><Clock3 size={20} strokeWidth={1.7} /></span>
                  <div><h3>发送设置</h3><p>每封邮件发完后，随机等待一段时间再发下一封。</p></div>
                </div>
                <div className="send-interval-range" aria-label="随机发送间隔">
                  <label className="send-interval-field">
                    <span>最短间隔</span>
                    <span className="send-interval-input-wrap">
                      <input type="number" min={1} max={MAX_SEND_INTERVAL_SEC} step={1}
                        value={form.send_interval_from_sec || ''}
                        aria-invalid={sendIntervalTouched && !sendIntervalValid}
                        onBlur={() => setSendIntervalTouched(true)}
                        onChange={(event) => updateSendInterval('from', event.target.value)} />
                      <em>秒</em>
                    </span>
                  </label>
                  <span className="send-interval-separator">至</span>
                  <label className="send-interval-field">
                    <span>最长间隔</span>
                    <span className="send-interval-input-wrap">
                      <input type="number" min={1} max={MAX_SEND_INTERVAL_SEC} step={1}
                        value={form.send_interval_to_sec || ''}
                        aria-invalid={sendIntervalTouched && !sendIntervalValid}
                        onBlur={() => setSendIntervalTouched(true)}
                        onChange={(event) => updateSendInterval('to', event.target.value)} />
                      <em>秒</em>
                    </span>
                  </label>
                </div>
                <p className="plan-send-desc">
                  {sendIntervalValid
                    ? `当前每封间隔 ${form.send_interval_from_sec}–${form.send_interval_to_sec} 秒，默认 100–240 秒。`
                    : sendIntervalTouched
                      ? '请填写 1–86400 秒，且最短时间需小于或等于最长时间。'
                      : '完成两个时间输入后会校验发送区间。'}
                </p>
                {sendIntervalValid && form.send_interval_from_sec < 30 && (
                  <p className="warn-text">最短间隔低于 30 秒，可能更容易触发邮箱发送频率限制。</p>
                )}
                <div className="plan-send-review">
                  <h4>本次投递</h4>
                  <dl className="plan-send-metrics">
                    <div><dt>待发送</dt><dd>{sendCount}<small>封</small></dd></div>
                    <div><dt>发件邮箱</dt><dd>{selectedAccounts.length}<small>个</small></dd></div>
                    <div><dt>预计用时</dt><dd>{sendCount > 0 && sendIntervalValid ? minutes : '—'}<small>分钟</small></dd></div>
                  </dl>
                  <div className="plan-send-manuscript"><BookOpen size={16} /><span><b>{form.title.trim() || '尚未填写作品名称'}</b><small>{form.file_name ? `附件：${form.file_name}` : '尚未添加稿件附件'}</small></span></div>
                  {!!orphans.length && <p className="plan-send-desc">含 {orphans.length} 位不在编辑库中的收件人。</p>}
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
              </div>
            </div>
            <div className="step-actions plan-content-actions">
              <span><Eye size={15} />测试邮件仅发给当前选中的第一个发件邮箱</span>
              <div className="plan-footer-buttons">
                <Button onClick={() => setStep(2)}><ArrowLeft size={15} />上一步</Button>
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

      {showPlanMembers && (
        <Modal title="调整这次名单" width={960} className="group-member-modal" onClose={() => setShowPlanMembers(false)}
          footer={<>
            <span className="editor-group-selected-count">已选 {planMemberDraft.size} 位</span>
            <Button variant="ghost" onClick={() => setShowPlanMembers(false)}>取消</Button>
            <Button variant="primary" onClick={() => {
              setGroupPlanIds(new Set(planMemberDraft))
              setShowPlanMembers(false)
            }}>用于这次计划</Button>
          </>}>
          <p className="hint">只改这次投稿，不会动原来的编辑组。</p>
          <GroupMemberPicker editors={editors} selectedIds={planMemberDraft} onChange={setPlanMemberDraft} />
        </Modal>
      )}

      {showGroupForm && (
        <Modal title={editingGroup ? '管理成员' : '新建编辑组'} width={960} className="group-member-modal"
          onClose={() => setShowGroupForm(false)}
          footer={
            <>
              <span className="editor-group-selected-count">已选 {groupMemberIds.size} 位</span>
              <Button variant="ghost" onClick={() => setShowGroupForm(false)}>取消</Button>
              <Button variant="primary" disabled={savingGroup || !groupName.trim() || !groupMemberIds.size}
                onClick={() => void saveEditorGroup()}>
                {savingGroup ? '保存中…' : '保存'}
              </Button>
            </>
          }>
          <GroupMemberPicker editors={editors} selectedIds={groupMemberIds} onChange={setGroupMemberIds} header={
            <div className="editor-group-form-head">
              <label className="field">编辑组名称
                <input autoFocus={!editingGroup} maxLength={40} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：短篇常投、重点编辑" />
              </label>
            </div>
          } />
        </Modal>
      )}

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
