import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Clock3, FileUp, Plus, Search, Send, Users } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useToast } from '../components/feedback'
import { Button, Select } from '../components/ui'
import { isValidEmail, parseRecipient } from '../format'
import { useNav } from '../nav'
import type { Account, Delivery, Editor, EditorInput, Manuscript, ManuscriptInput, TaskInput } from '../types'
import {
  CATEGORIES, GENRES, SCHEDULE_OPTIONS, STYLES, editorWorkTypeOptions, isPlanStyle, normalizeEditorTags,
  categoryFromWords, defaultBody, defaultSubject, editorPlatformKey, editorRecipient, estimateAutoMinutes, fillPlaceholders, pickOneEditorPerPlatform, sentCountByEmail,
} from './planShared'

const emptyEditor: EditorInput = { platform: '', name: '', email: '', style: [], work_type: [] }

export function PlanEditor({
  editing, editors, onReloadEditors, deliveries, enabledAccounts,
  form, setForm, taskForm, setTaskForm, scheduledInput, setScheduledInput,
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
  scheduledInput: string
  setScheduledInput: (v: string) => void
  saving: boolean
  onClose: () => void
  onSaveDraft: () => void
  onSaveAndSend: () => void
  onImportFile: (file: File | null) => void
}) {
  const toast = useToast()
  const { go } = useNav()
  const fileRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [showRecipients, setShowRecipients] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [matchGenres, setMatchGenres] = useState<Set<string>>(() => new Set())
  const [excludedTypes, setExcludedTypes] = useState<Set<string>>(() => new Set())
  const [pickedByPlatform, setPickedByPlatform] = useState<Record<string, string>>({})
  const [mailDirty, setMailDirty] = useState(() => Boolean(editing && (form.subject.trim() || form.body.trim())))
  const [showEditorForm, setShowEditorForm] = useState(false)
  const [editorForm, setEditorForm] = useState<EditorInput>(emptyEditor)
  const [customWorkType, setCustomWorkType] = useState('')
  const [savingEditor, setSavingEditor] = useState(false)
  const [testing, setTesting] = useState(false)
  // 名单里已保存、但不在当前匹配池的收件人（改过类型、编辑库调整后不再匹配等），保留显示不丢。
  const [pinned, setPinned] = useState<string[]>([])
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

  const { picked, groups } = useMemo(
    () => pickOneEditorPerPlatform(editors, form.style, [...matchGenres], sentMap, pickedByPlatform, excludedTypes),
    [editors, form.style, matchGenres, sentMap, pickedByPlatform, excludedTypes],
  )

  const rows = useMemo(() => {
    const poolEmails = new Set(picked.map((e) => e.email.toLowerCase()))
    const poolRows = picked.map((editor) => {
      const raw = editorRecipient(editor)
      const parsed = parseRecipient(raw)
      const sent = sentMap.get(editor.email.toLowerCase()) ?? 0
      const key = editorPlatformKey(editor)
      return {
        editor, raw, ...parsed, sent,
        checked: !excluded.has(editor.email.toLowerCase()),
        alts: groups.get(key) ?? [editor],
        pinned: false,
      }
    })
    // 固定收件人：不在匹配池里的已保存收件人，去重后追加显示。
    const pinnedRows = pinned
      .filter((raw) => !poolEmails.has(parseRecipient(raw).email.toLowerCase()))
      .map((raw) => {
        const parsed = parseRecipient(raw)
        const email = parsed.email.toLowerCase()
        return {
          editor: null, raw, ...parsed,
          sent: sentMap.get(email) ?? 0,
          checked: true,
          alts: [],
          pinned: true,
        }
      })
    return [...poolRows, ...pinnedRows]
  }, [picked, sentMap, excluded, groups, pinned])

  const selected = rows.filter((r) => r.checked)
  const recipientKey = selected.map((r) => r.raw).join('\n')
  const pending = selected.filter((r) => r.sent === 0).length
  // 发送时默认跳过已投过的编辑，只统计未投数量。
  const sendCount = pending
  const selectedAccounts = useMemo(() => {
    if (!taskForm.account_ids.length) return enabledAccounts
    return enabledAccounts.filter((account) => taskForm.account_ids.includes(account.id))
  }, [enabledAccounts, taskForm.account_ids])
  const minutes = estimateAutoMinutes(sendCount)
  const ready = Boolean(form.title.trim() && form.body.trim() && sendCount > 0 && selectedAccounts.length)

  const visible = rows.filter((r) => {
    const q = query.trim().toLowerCase()
    if (q && ![r.editor?.name ?? r.name, r.email, r.editor?.platform ?? '', ...(r.editor?.style ?? []), ...(r.editor?.work_type ?? [])].join(' ').toLowerCase().includes(q)) return false
    return true
  })

  // 中途改风格 / 作品类型：重新按新类型匹配，清掉之前的排除与固定收件人（挂载那一次交给下面的初始化）。
  useEffect(() => {
    if (!initRef.current) return
    setExcluded(new Set())
    setPinned([])
  }, [form.style, form.genres])

  // 匹配的作品类型默认取作品已勾选的类型；编辑已有计划时额外恢复保存的收件名单状态与排除类型。
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    setMatchGenres(new Set(form.genres))
    if (form.excluded_types?.length) setExcludedTypes(new Set(form.excluded_types))
    if (!editing) return
    const savedEmails = new Set(form.recipients.map((r) => parseRecipient(r).email.toLowerCase()))
    const poolEmails = new Set(picked.map((e) => e.email.toLowerCase()))
    setExcluded(new Set(picked.filter((e) => !savedEmails.has(e.email.toLowerCase())).map((e) => e.email.toLowerCase())))
    setPinned(form.recipients.filter((r) => !poolEmails.has(parseRecipient(r).email.toLowerCase())))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入时按保存的数据初始化一次
  }, [])

  // 排除的作品类型随计划持久化：改动即写回 form，保存草稿/发送时一并入库。
  useEffect(() => {
    setForm((f) => {
      const next = [...excludedTypes].sort()
      const cur = f.excluded_types ?? []
      if (cur.length === next.length && cur.every((t, i) => t === next[i])) return f
      return { ...f, excluded_types: next }
    })
  }, [excludedTypes, setForm])

  useEffect(() => {
    const next = recipientKey ? recipientKey.split('\n') : []
    setForm((f) => {
      if (f.recipients.length === next.length && f.recipients.every((item, i) => item === next[i])) return f
      return { ...f, recipients: next }
    })
  }, [recipientKey, setForm])

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

  const toggleOne = (email: string) => {
    const key = email.toLowerCase()
    // 不在匹配池里的固定收件人，勾掉即从名单移除。
    if (!picked.some((e) => e.email.toLowerCase() === key)) {
      setPinned((prev) => prev.filter((r) => parseRecipient(r).email.toLowerCase() !== key))
      return
    }
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleMatchGenre = (tag: string) => {
    setMatchGenres((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  const toggleExcludedType = (tag: string) => {
    setExcludedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
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
      await api.addEditor(payload)
      await onReloadEditors()
      setExcluded((prev) => {
        const next = new Set(prev)
        next.delete(email)
        return next
      })
      setPickedByPlatform((prev) => ({
        ...prev,
        [editorPlatformKey({ platform: editorForm.platform, email })]: email,
      }))
      setShowEditorForm(false)
      toast('编辑已加入资料库。同一平台只会保留一位。', 'success')
    } catch (e) { toast(String(e), 'error') }
    finally { setSavingEditor(false) }
  }

  const setPoolChecked = (on: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      for (const row of visible) {
        if (row.pinned) continue
        if (on) next.delete(row.email.toLowerCase())
        else next.add(row.email.toLowerCase())
      }
      return next
    })
  }

  const testSend = async () => {
    if (!form.title.trim() || !form.body.trim()) { toast('请先填作品名称和邮件正文', 'warning'); return }
    const account = selectedAccounts[0]
    if (!account) { toast('还没有勾选参与发送的邮箱，请先勾选一个', 'warning'); return }
    // 测试邮件只发到发件邮箱自己，绝不发给编辑。有勾选编辑时按第一位编辑填充占位符，方便预览实际效果。
    const first = selected[0]
    setTesting(true)
    try {
      const subject = fillPlaceholders(form.subject.trim() || form.title, first?.raw ?? '', form.title)
      const body = fillPlaceholders(form.body, first?.raw ?? '', form.title)
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

  const emptyHint = !editors.length
    ? <>还没有编辑。去 <button type="button" className="text-link" onClick={() => go('editors')}>编辑</button> 里先存邮箱、风格和作品类型。</>
    : !form.style && !matchGenres.size
        ? '先选好作品风格或作品类型，名单会按这两项匹配，每个平台只出一位。'
        : excludedTypes.size
          ? '当前条件下没有编辑。可减少排除的作品类型，或改风格 / 作品类型。'
          : '没有对上当前风格或作品类型的编辑。可以改风格、作品类型，或手动添加。'

  const visibleEmptyHint = query.trim()
    ? '没有符合当前搜索的编辑。换个姓名、邮箱、平台或标签试试。'
    : emptyHint

  return (
    <div className="plan-desk">
      <header className="plan-bar">
        <button className="plan-back" onClick={onClose}><ArrowLeft size={16} />返回</button>
        <strong className="plan-bar-name">{form.title.trim() || (editing ? '编辑计划' : '新建计划')}</strong>
        <div className="plan-bar-actions">
          <Button variant="ghost" disabled={saving} onClick={onSaveDraft}>保存草稿</Button>
          <Button variant="ghost" disabled={saving || testing} onClick={() => void testSend()}>
            {testing ? '发送中…' : '测试发送'}
          </Button>
          <Button variant="primary" disabled={saving || !ready} onClick={() => onSaveAndSend()}>
            <Send size={15} />{taskForm.schedule_type === 'scheduled' ? '预约发送' : '开始发送'}
          </Button>
        </div>
      </header>

      <div className="plan-split">
        <section className="plan-sheet">
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
              <textarea className="plan-body" rows={8} value={form.body}
                onChange={(e) => { setMailDirty(true); setForm({ ...form, body: e.target.value }) }}
                placeholder={'尊敬的编辑大大：\n\n辛苦审阅，期待您的意见！'} />
              {liveCount > 0 && <div className="plan-body-meta">作品 {liveCount} 字</div>}
            </div>
          </div>
        </section>

        <aside className="plan-board">
          <div className="plan-recipient-card">
            <div className="plan-recipient-info">
              <h3>收件名单</h3>
              <p>已选 <strong>{selected.length}</strong> / {rows.length} 位</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShowRecipients(true)}><Users size={14} />编辑名单</Button>
          </div>

          <div className="plan-send">
            <div className="plan-accounts">
              <span className="plan-accounts-label">参与发送的邮箱</span>
              <div className="plan-accounts-list">
                {enabledAccounts.map((account) => {
                  const on = !taskForm.account_ids.length || taskForm.account_ids.includes(account.id)
                  return (
                    <label key={account.id} className={`plan-account-chip ${on ? 'on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleAccount(account.id)} />
                      <span>{account.email}</span>
                    </label>
                  )
                })}
                {!enabledAccounts.length && <span className="hint">还没有启用邮箱，去「邮箱」页添加并启用</span>}
              </div>
            </div>
            <div className="plan-send-fields">
              <label className="plan-setting-field">时间
                <Select
                  value={taskForm.schedule_type}
                  onChange={(value) => setTaskForm({ ...taskForm, schedule_type: value })}
                  ariaLabel="选择发送时间"
                  className="plan-send-select"
                  options={SCHEDULE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }))}
                />
              </label>
            </div>
            {taskForm.schedule_type === 'scheduled' && (
              <input type="datetime-local" value={scheduledInput} onChange={(e) => setScheduledInput(e.target.value)} />
            )}
            {taskForm.schedule_type === 'loop' && (
              <p className="field-hint">循环是这份名单投完后再投一遍，需手动停止。不是等上一个计划结束。</p>
            )}
            <div className="plan-rhythm">
              <Clock3 size={15} />
              <div>
                <strong>固定节奏</strong>
                <p>每封邮件间隔 2–4 分钟随机发送，时间点偏向 3 分钟，更像人工投稿。无需设置频次。</p>
              </div>
            </div>
            <div className="plan-send-summary">
              <div className="plan-estimate">
                <Clock3 size={15} />
                <span>{sendCount > 0 ? `约 ${minutes} 分钟发完 ${sendCount} 封` : '等待选择编辑'}</span>
              </div>
            </div>
            {!enabledAccounts.length && <p className="warn-text">还没有可用发件邮箱，只能先存草稿。</p>}
            {!ready && blockers.length > 0 && (
              <p className="warn-text">还不能发送：{blockers.join('、')}。测试发送会把一封预览邮件发到你的发件邮箱（勾选的第一个邮箱），不会发给编辑。</p>
            )}
          </div>
        </aside>
      </div>

      {showRecipients && (
        <Modal title="收件名单" width={880} onClose={() => setShowRecipients(false)}>
          <div className="send-detail-head">
            <div className="send-detail-title">
              <h3>收件名单</h3>
              <p>已选 {selected.length} / {rows.length} 位</p>
            </div>
            <div className="send-detail-actions">
              <label className="plan-search send-detail-search">
                <Search size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="姓名、邮箱或平台" />
              </label>
              <Button size="sm" variant="ghost" onClick={openAddEditor}><Plus size={14} />添加编辑</Button>
              <Button size="sm" variant="primary" onClick={() => setShowRecipients(false)}>完成</Button>
            </div>
          </div>

          <div className="plan-board-toolbar recipients-toolbar">
            <div className="plan-list-actions">
              <div className="plan-board-meta">
                <span>显示 {visible.length} 位</span>
                {!!visible.length && (
                  <div className="plan-bulk">
                    <button type="button" onClick={() => setPoolChecked(true)}>全选</button>
                    <button type="button" onClick={() => setPoolChecked(false)}>取消</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="plan-exclude-bar">
            <span className="plan-exclude-label">作品类型</span>
            <div className="plan-exclude-chips">
              {genreChips.map(([tag, count]) => (
                <button type="button" key={tag}
                  className={`plan-exclude-chip ${matchGenres.has(tag) ? 'on' : ''}`}
                  onClick={() => toggleMatchGenre(tag)}
                  title={matchGenres.has(tag) ? `不参与匹配「${tag}」` : `参与匹配「${tag}」`}>
                  {tag}<small>{count}</small>
                </button>
              ))}
            </div>
            <div className="plan-exclude-ops">
              <button type="button" className="plan-exclude-clear" onClick={() => setMatchGenres(new Set())}>清空</button>
              <button type="button" className="plan-exclude-clear" onClick={() => setMatchGenres(new Set(genreChips.map(([tag]) => tag)))}>全部</button>
            </div>
          </div>

          {!matchGenres.size && (
            <p className="plan-genres-empty plan-genres-hint">未选作品类型，名单将只按风格匹配。</p>
          )}

          {!!genreChips.length && (
            <div className="plan-exclude-bar">
              <span className="plan-exclude-label">排除作品类型</span>
              <div className="plan-exclude-chips">
                {genreChips.map(([tag, count]) => (
                  <button type="button" key={tag}
                    className={`plan-exclude-chip danger ${excludedTypes.has(tag) ? 'on' : ''}`}
                    onClick={() => toggleExcludedType(tag)}
                    title={excludedTypes.has(tag) ? `取消排除「${tag}」` : `排除「${tag}」`}>
                    {tag}<small>{count}</small>
                  </button>
                ))}
              </div>
              {!!excludedTypes.size && (
                <button type="button" className="plan-exclude-clear" onClick={() => setExcludedTypes(new Set())}>
                  清空（{excludedTypes.size}）
                </button>
              )}
            </div>
          )}

          <div className="recipients-table-wrap">
            <table className="recipients-table">
              <thead>
                <tr>
                  <th className="col-check" aria-label="选择" />
                  <th>编辑</th>
                  <th className="col-platform">平台</th>
                  <th>风格 / 作品类型</th>
                  <th className="col-switch" aria-label="换人" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const styles = r.editor?.style ?? []
                  const workTypes = r.editor?.work_type ?? []
                  const tags = [...new Set([...styles, ...workTypes])]
                  const displayName = r.editor?.name.trim() || r.name
                  const platformLabel = r.pinned ? '名单内' : (r.editor?.platform.trim() || '未填平台')
                  return (
                    <tr key={r.raw} className={`${r.checked ? '' : 'is-off'} ${r.pinned ? 'is-pinned' : ''}`}>
                      <td className="col-check">
                        <input type="checkbox" checked={r.checked} onChange={() => toggleOne(r.email)} aria-label={`${r.checked ? '取消选择' : '选择'} ${displayName}`} />
                      </td>
                      <td className="recipients-editor">
                        <b>{displayName}</b>
                        <small>{r.email}</small>
                      </td>
                      <td className="col-platform">
                        {r.pinned
                          ? <span className="chip on">{platformLabel}</span>
                          : <span className="recipients-platform">{platformLabel}</span>}
                      </td>
                      <td>
                        {tags.length ? (
                          <div className="editor-row-tags recipients-tags">
                            {styles.map((d) => <span className="chip on" key={d}>{d}</span>)}
                            {!!styles.length && !!workTypes.length && <i className="editor-tag-divider" />}
                            {workTypes.map((d) => <span className="chip on tone" key={d}>{d}</span>)}
                          </div>
                        ) : <span className="hint">无标签</span>}
                      </td>
                      <td className="col-switch">
                        {!r.pinned && r.alts.length > 1 && (
                          <Select
                            value={r.email}
                            className="plan-alt-select"
                            ariaLabel={`${r.editor?.platform || '该平台'}换一位编辑`}
                            onChange={(next) => {
                              const email = String(next).toLowerCase()
                              setPickedByPlatform((prev) => ({ ...prev, [editorPlatformKey(r.editor!)]: email }))
                              setExcluded((prev) => {
                                const copy = new Set(prev)
                                copy.delete(email)
                                return copy
                              })
                            }}
                            options={r.alts.map((alt) => ({
                              value: alt.email,
                              label: alt.name.trim() || alt.email,
                              description: alt.email === r.email ? '当前' : alt.email,
                            }))}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!visible.length && <p className="plan-empty">{visibleEmptyHint}</p>}
          </div>
        </Modal>
      )}

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
