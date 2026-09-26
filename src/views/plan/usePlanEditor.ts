import { changeEditorSelection, pickPlatformEditors } from '../../lib/editorListModel'
import { useMailTemplates } from './useMailTemplates'
import { validateEditorInput } from '../editorLibraryShared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useToast } from '../../components/feedback'
import { isValidEmail, parseRecipient } from '../../format'
import type { Account, Editor, EditorGroup, EditorInput, MailTemplate, Manuscript, ManuscriptInput, TaskInput } from '../../types'
import { emptyEditorListFilters, type EditorListFilters } from '../Editors'
import {
  LENGTH_TAGS,
  accountTodayQuota,
  editorPlatformKey,
  editorRecipient, editorWorkTypeOptions, estimateAutoMinutes,
  fillPlaceholders,
  groupMatchingByPlatform,
  groupPlanRecipients,
  isEditorFavorited,
  isLengthTag,
  isValidSendIntervalRange,
  lengthTagsFromWords,
  matchingEditorGroupId,
  mergeEditorSelectionByPlatform,
  normalizeEditorTags,
  normalizeSendIntervalRange,
  recipientEmailsForCopy,
  splitPlanTags
} from '../planShared'
export type PlanEditorProps = {
  onInteraction?: () => void
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
}
const emptyEditor: EditorInput = {
  platform: '', name: '', email: '', work_type: [], rejected_types: [], notes: '',
}


export function usePlanEditor({
  editing, editors, editorGroups, onReloadEditors, onReloadEditorGroups, onFavoriteChange, enabledAccounts,
  form, setForm, taskForm, setTaskForm,
  saving, onClose, onSaveDraft, onSaveAndSend, onImportFile, onDefaultTemplatesChange,
}: PlanEditorProps) {

  const toast = useToast()
  const { mailTemplates, activeTpl, fixedTemplate, setActiveTplId, tplMode, setTplMode, writeTemplates, updateActiveTpl, addTemplate, removeTemplate } = useMailTemplates(form, setForm, onDefaultTemplatesChange)
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
  const [showEditorForm, setShowEditorForm] = useState(false)
  const [editingEditor, setEditingEditor] = useState<Editor | null>(null)
  const [editorForm, setEditorForm] = useState<EditorInput>(emptyEditor)
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
    const byEmail = new Map<string, Editor>()
    for (const editor of editors) {
      const email = editor.email.trim().toLowerCase()
      if (!byEmail.has(email)) byEmail.set(email, editor)
    }
    for (const r of form.recipients) {
      const email = parseRecipient(r).email.toLowerCase()
      const lib = byEmail.get(email)
      if (lib) ids.add(lib.id)
      else orphanList.push(r)
    }
    setSelectedIds(ids)
    setOrphans(orphanList)
    const matched = matchingEditorGroupId(editorGroups, editors, ids)
    if (matched && orphanList.length === 0) {
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
  const updateSendInterval = (side: 'from' | 'to', value: number) => {
    setForm((current) => side === 'from'
      ? { ...current, send_interval_from_sec: value }
      : { ...current, send_interval_to_sec: value })
  }
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
      const picks = pickPlatformEditors(candidates, prev)
      const platforms = new Set(picks.map(editorPlatformKey))
      const next = new Set(prev)
      for (const item of editors) {
        if (platforms.has(editorPlatformKey(item))) next.delete(item.id)
      }
      for (const editor of picks) next.add(editor.id)
      return next
    })
  }

  const deselectEditorResults = (candidates: Editor[]) => {
    setSelectedIds((prev) => changeEditorSelection(prev, candidates, false))
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
    setShowEditorForm(true)
  }

  const saveEditor = async () => {
    const error = validateEditorInput(editorForm, editors, editingEditor?.id)
    if (error) { toast(error, 'warning'); return }
    const payload = normalizeEditorTags({ ...editorForm, email: editorForm.email.trim().toLowerCase() })
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
      // 测试邮件也带上附件：新导入的文件使用暂存标识；编辑已有计划时按稿件 id 从数据库读已保存的附件。
      const attachment = form.file_token
        ? { name: form.file_name, token: form.file_token }
        : form.file_data?.length
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


  return {
    steps, onClose, form, editing, step, goToStep2,
    goToStep3, setStep, saving, onSaveDraft, fileRef, importManuscript,
    dragging, importing, dragDepth, setDragging, setForm, lengthChips,
    excluded, togglePlanTag, excludePlanTag, genreChips, editors, addTemplate,
    mailTemplates, removeTemplate, fixedTemplate, setActiveTplId, activeTpl, writeTemplates,
    tplMode, setTplMode, selectedEditors, updateActiveTpl, editorPickMode, openNewGroup,
    openAddEditor, setEditorPickMode, groupPlanIds, selectedIds, selectedGroupId, groupPicks,
    activeSelectedIds, recipients, listCount, toggleEditorGroup, openEditGroup, openPlanMembers,
    savePlanAsGroup, toggleSelect, setListCount, setVisibleEditors, platformPeersOf, replacePlatformEditor,
    onFavoriteChange, openEditEditor, listFilters, setListFilters, setSelectedIds, visibleEditors,
    allResultsSelected, selectEditorResults, selectedResultPlatforms, deselectEditorResults, favoriteEditors, hasSelectedFavorite,
    orphans, sendCount, copyEditorList, enabledAccounts, selectedAccounts, taskForm,
    toggleAccount, sendIntervalTouched, setSendIntervalTouched, updateSendInterval, sendIntervalValid, minutes,
    overQuotaAccounts, ready, blockers, testing, testSend, onSaveAndSend,
    showPlanMembers, setShowPlanMembers, planMemberDraft, setGroupPlanIds, setPlanMemberDraft, showGroupForm,
    editingGroup, setShowGroupForm, groupMemberIds, savingGroup, groupName, saveEditorGroup,
    setGroupMemberIds, setGroupName, showEditorForm, editingEditor, setShowEditorForm, savingEditor,
    saveEditor, editorForm, setEditorForm, platforms, workTypeOptions,
  }
}
export type PlanEditorModel = ReturnType<typeof usePlanEditor>
