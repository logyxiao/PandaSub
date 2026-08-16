import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Database, Download, Plus, RotateCcw, Search, Trash2, Upload, Users } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Button, EmptyState, IconButton, PagedList, Select } from '../components/ui'
import { isValidEmail } from '../format'
import { useNav } from '../nav'
import type { Editor, EditorInput } from '../types'
import { GENRES, SOURCES, editorMatchesPlan, editorRowTags, normalizeEditorTags } from './planShared'

const UNASSIGNED = '未填平台'

const emptyForm: EditorInput = {
  platform: '', name: '', email: '', work_type: [], notes: '',
}

export interface EditorListFilters {
  query: string
  platform: string
  source: string
  workTypes: string[]
  excludedWorkTypes: string[]
}

export const emptyEditorListFilters = (workTypes: string[] = [], excludedWorkTypes: string[] = []): EditorListFilters => ({
  query: '',
  platform: '',
  source: '',
  workTypes,
  excludedWorkTypes,
})

export interface EditorsListProps {
  /** 受控数据（如投稿向导传入）；不传则内部从后端加载 */
  items?: Editor[]
  /** 内部加载模式下，值变化时重新拉取 */
  reloadSignal?: number
  /** 选择模式：行首显示勾选框 */
  selectable?: boolean
  selectedIds?: ReadonlySet<number>
  onToggleSelect?: (editor: Editor, checked: boolean) => void
  onEdit?: (editor: Editor) => void
  onDelete?: (editor: Editor) => void
  onTotalChange?: (total: number) => void
  onVisibleChange?: (editors: Editor[]) => void
  onPlatformsChange?: (platforms: string[]) => void
  pageSize?: number
  emptyText?: string
  emptyAction?: ReactNode
  actions?: ReactNode
  initialWorkTypes?: string[]
  initialExcludedWorkTypes?: string[]
  filters?: EditorListFilters
  onFiltersChange?: (next: EditorListFilters) => void
  platformPeersOf?: (editor: Editor) => Editor[]
  onReplaceEditor?: (current: Editor, next: Editor) => void
}

/** 编辑库列表（搜索、平台/作品类型筛选、分页、标签气泡），可作为页面或插件式嵌入投稿向导。 */
export function EditorsList({
  items: externalItems, reloadSignal = 0, selectable = false,
  selectedIds, onToggleSelect, onEdit, onDelete, onTotalChange, onVisibleChange, onPlatformsChange, pageSize,
  emptyText = '首次打开会载入内置投稿邮箱。也可以自己添加，或导入 Excel / CSV。',
  emptyAction, actions, initialWorkTypes, initialExcludedWorkTypes,
  filters, onFiltersChange,
  platformPeersOf, onReplaceEditor,
}: EditorsListProps) {
  const [items, setItems] = useState<Editor[]>([])
  const [loading, setLoading] = useState(!externalItems)
  const [notice, setNotice] = useState('')
  const [localFilters, setLocalFilters] = useState<EditorListFilters>(() =>
    emptyEditorListFilters(initialWorkTypes ?? [], initialExcludedWorkTypes ?? []),
  )
  const current = filters ?? localFilters
  const { query, platform, source, workTypes, excludedWorkTypes } = current
  const setFilters = (patch: Partial<EditorListFilters>) => {
    const next = { ...current, ...patch }
    if (onFiltersChange) onFiltersChange(next)
    else setLocalFilters(next)
  }
  const [more, setMore] = useState<{ id: number; top: number; left: number; width: number } | null>(null)
  const [peerPick, setPeerPick] = useState<{ id: number; top: number; left: number; width: number } | null>(null)

  const list = useMemo(() => (externalItems ?? items).map(normalizeEditorTags), [externalItems, items])

  const load = async () => {
    setLoading(true)
    try { setItems((await api.listEditors()).map(normalizeEditorTags)); setNotice('') }
    catch (e) { setNotice(String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (!externalItems) void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!externalItems && reloadSignal > 0) void load() }, [externalItems, reloadSignal])

  const platforms = useMemo(
    () => [...new Set(list.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [list],
  )
  useEffect(() => { onPlatformsChange?.(platforms) }, [platforms, onPlatformsChange])

  const basePool = useMemo(() => list.filter((e) => {
    if (platform && e.platform !== platform) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [e.name, e.email, e.platform, e.source, e.notes, ...(e.work_type ?? [])].join(' ').toLowerCase().includes(q)
  }), [list, platform, query])

  const workTypeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of basePool) for (const d of e.work_type ?? []) map.set(d, (map.get(d) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [basePool])

  const visible = useMemo(() => basePool.filter((e) => {
    if (source && e.source !== source) return false
    return editorMatchesPlan(e, workTypes, excludedWorkTypes)
  }), [basePool, source, workTypes, excludedWorkTypes])

  useEffect(() => { onTotalChange?.(visible.length) }, [visible.length, onTotalChange])
  const onVisibleChangeRef = useRef(onVisibleChange)
  onVisibleChangeRef.current = onVisibleChange
  useEffect(() => { onVisibleChangeRef.current?.(visible) }, [visible])
  useEffect(() => { setMore(null); setPeerPick(null) }, [platform, query, source, workTypes, excludedWorkTypes, list])

  const toggleWorkType = (tag: string) => {
    setFilters({
      excludedWorkTypes: excludedWorkTypes.filter((item) => item !== tag),
      workTypes: workTypes.includes(tag) ? workTypes.filter((item) => item !== tag) : [...workTypes, tag],
    })
  }
  const excludeWorkType = (tag: string) => {
    setFilters({
      workTypes: workTypes.filter((item) => item !== tag),
      excludedWorkTypes: excludedWorkTypes.includes(tag)
        ? excludedWorkTypes.filter((item) => item !== tag)
        : [...excludedWorkTypes, tag],
    })
  }
  const resetFilters = () => {
    setFilters(emptyEditorListFilters())
    setMore(null)
    setPeerPick(null)
  }

  const moreEditor = more ? visible.find((item) => item.id === more.id) : undefined
  const moreWorkTypes = moreEditor ? editorRowTags(moreEditor.work_type) : []
  const peerEditor = peerPick ? visible.find((item) => item.id === peerPick.id) : undefined
  const peerList = peerEditor && platformPeersOf
    ? [...platformPeersOf(peerEditor)].sort((a, b) => {
        if (a.id === peerEditor.id) return -1
        if (b.id === peerEditor.id) return 1
        return (a.name || a.email).localeCompare(b.name || b.email, 'zh')
      })
    : []

  return (
    <>
      <div className="editor-toolbar">
        <label className="plan-search editor-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setFilters({ query: e.target.value })} placeholder="搜索姓名、平台、邮箱或备注" />
        </label>
        <Select value={platform} onChange={(value) => setFilters({ platform: value })} ariaLabel="按平台筛选" className="editor-filter-select"
          searchable searchPlaceholder="搜索平台" options={[{ value: '', label: '全部平台' }, ...platforms.map((p) => ({ value: p, label: p }))]} />
        <Select value={source} onChange={(value) => setFilters({ source: value })} ariaLabel="按来源筛选" className="editor-filter-select is-compact"
          options={[{ value: '', label: '全部来源' }, ...SOURCES.map((tag) => ({
            value: tag,
            label: `${tag}（${basePool.filter((e) => e.source === tag).length}）`,
          }))]} />
        <div className="editor-toolbar-actions">
          <IconButton title="重置筛选" className="editor-tool-icon" disabled={!query && !platform && !source && !workTypes.length && !excludedWorkTypes.length}
            onClick={resetFilters}>
            <RotateCcw size={14} />
          </IconButton>
          {actions}
        </div>
      </div>
      <div className="worktype-filter-bar">
        {workTypeCounts.length ? (
          <div className="field-filter-chips">
            {workTypeCounts.map(([tag, count]) => (
              <button type="button" key={tag} title="左键筛选，右键排除"
                className={`field-chip ${workTypes.includes(tag) ? 'on' : ''} ${excludedWorkTypes.includes(tag) ? 'is-excluded' : ''}`}
                onClick={() => toggleWorkType(tag)}
                onContextMenu={(ev) => { ev.preventDefault(); excludeWorkType(tag) }}>
                {tag}{count > 0 && <small>{count}</small>}
              </button>
            ))}
          </div>
        ) : (
          <span className="hint">还没有作品类型，添加编辑时补上即可筛选</span>
        )}
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !list.length ? (
        <div className="panel">
          <EmptyState icon={Users} title="还没有编辑" desc={emptyText} action={emptyAction} />
        </div>
      ) : (
        <div className="panel">
          <PagedList
            items={visible}
            pageSize={pageSize}
            keyOf={(e) => e.id}
            resetKey={`${query}\0${platform}\0${source}\0${workTypes.join('\0')}\0${excludedWorkTypes.join('\0')}`}
            listClassName="editor-groups"
            renderItem={(e) => {
              const tags = editorRowTags(e.work_type)
              const shown = tags.slice(0, 2)
              const rest = tags.slice(shown.length)
              const note = (e.notes ?? '').trim()
              const checked = selectedIds?.has(e.id) ?? false
              return (
                <div className={`editor-row ${selectable ? 'is-selectable' : ''}`}>
                  {selectable && (
                    <label className="editor-row-check">
                      <input type="checkbox" checked={checked}
                        onChange={(ev) => onToggleSelect?.(e, ev.target.checked)}
                        aria-label={`${checked ? '取消选择' : '选择'} ${e.name.trim() || e.email}`} />
                    </label>
                  )}
                  <div className={`editor-row-main ${onEdit ? 'is-hit' : ''}`}
                    role={onEdit ? 'button' : undefined}
                    tabIndex={onEdit ? 0 : undefined}
                    title={onEdit ? '修改这份编辑资料' : undefined}
                    onClick={onEdit ? () => onEdit(e) : undefined}
                    onKeyDown={onEdit ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEdit(e) } } : undefined}>
                    <b>
                      <span className="editor-row-name">{e.name.trim() || '佚名'}</span>
                      <span className="editor-row-sep">｜</span>
                      <span className="editor-row-plat">{e.platform.trim() || UNASSIGNED}</span>
                    </b>
                    <small>{e.email}</small>
                  </div>
                  <div className={`editor-row-note ${onEdit ? 'is-hit' : ''}`}
                    role={onEdit ? 'button' : undefined}
                    tabIndex={onEdit ? 0 : undefined}
                    title={note ? (onEdit ? `${note}\n点击修改` : note) : (onEdit ? '点击补充备注' : undefined)}
                    onClick={onEdit ? () => onEdit(e) : undefined}
                    onKeyDown={onEdit ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEdit(e) } } : undefined}>
                    {note || <span className="hint">无备注</span>}
                  </div>
                  <div className="editor-row-tags">
                    {tags.length ? (
                      <>
                        {shown.map((d, i) => (
                          <span key={`${i}-${d}`} className="chip on tone">{d}</span>
                        ))}
                        {rest.length > 0 && (
                          <button type="button" className="editor-chip-more"
                            onClick={(ev) => {
                              const next = moreRect(ev.currentTarget)
                              setMore((m) => (m?.id === e.id ? null : { id: e.id, ...next }))
                            }}>
                            +{rest.length}
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="hint">未设标签</span>
                    )}
                  </div>
                  <div className="row-actions">
                    {platformPeersOf && (() => {
                      const peers = platformPeersOf(e)
                      const count = peers.length
                      if (count <= 1) {
                        return <span className="editor-peer-count is-solo">同平台 1</span>
                      }
                      return (
                        <button type="button" className={`editor-peer-count ${peerPick?.id === e.id ? 'on' : ''}`}
                          title="更换同平台编辑"
                          onClick={(ev) => {
                            const next = moreRect(ev.currentTarget, 260, 220)
                            setPeerPick((m) => (m?.id === e.id ? null : { id: e.id, ...next }))
                          }}>
                          同平台 {count}<ChevronDown size={12} />
                        </button>
                      )
                    })()}
                    {onEdit && <Button size="sm" onClick={() => onEdit(e)}>编辑</Button>}
                    {onDelete && <IconButton title="删除" className="danger" onClick={() => onDelete(e)}><Trash2 size={15} /></IconButton>}
                  </div>
                </div>
              )
            }}
            empty={!visible.length && (
              <p className="editor-groups-empty">{loading ? '读取中…' : '没有符合筛选的编辑'}</p>
            )}
          />
        </div>
      )}
      {more && moreEditor && (
        <EditorTagsPop
          top={more.top}
          left={more.left}
          width={more.width}
          workTypes={moreWorkTypes}
          skip={2}
          onClose={() => setMore(null)}
        />
      )}
      {peerPick && peerEditor && peerList.length > 1 && (
        <PlatformPeersPop
          top={peerPick.top}
          left={peerPick.left}
          width={peerPick.width}
          current={peerEditor}
          peers={peerList}
          onPick={(next) => {
            if (next.id !== peerEditor.id) onReplaceEditor?.(peerEditor, next)
            setPeerPick(null)
          }}
          onClose={() => setPeerPick(null)}
        />
      )}
    </>
  )
}

export function moreRect(el: HTMLElement, minWidth = 180, estimate = 88) {
  const rect = el.getBoundingClientRect()
  const width = Math.min(320, Math.max(minWidth, rect.width))
  let left = Math.min(rect.right - width, window.innerWidth - width - 12)
  if (left < 12) left = 12
  const gap = 7
  const spaceBelow = window.innerHeight - rect.bottom - gap
  const up = spaceBelow < estimate && rect.top - gap > spaceBelow
  return up
    ? { top: Math.max(12, rect.top - gap - estimate), left, width }
    : { top: rect.bottom + gap, left, width }
}

export function EditorTagsPop({ top, left, width, workTypes, skip, onClose }: {
  top: number
  left: number
  width: number
  workTypes: string[]
  skip: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const restWorkTypes = workTypes.slice(skip).map(String)

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node
      if (ref.current?.contains(target)) return
      if (target instanceof Element && target.closest('.editor-chip-more')) return
      onCloseRef.current()
    }
    const dismiss = () => onCloseRef.current()
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') dismiss() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  return createPortal(
    <div ref={ref} className="editor-more-pop" style={{ top, left, width }} role="tooltip">
      <div className="editor-more-tags">
        {restWorkTypes.map((d, i) => <span className="chip on tone" key={`w-${i}-${d}`}>{d}</span>)}
      </div>
    </div>,
    document.body,
  )
}

function PlatformPeersPop({ top, left, width, current, peers, onPick, onClose }: {
  top: number
  left: number
  width: number
  current: Editor
  peers: Editor[]
  onPick: (editor: Editor) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node
      if (ref.current?.contains(target)) return
      if (target instanceof Element && target.closest('.editor-peer-count')) return
      onCloseRef.current()
    }
    const dismiss = () => onCloseRef.current()
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') dismiss() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  return createPortal(
    <div ref={ref} className="editor-peer-pop" style={{ top, left, width }} role="listbox" aria-label="同平台编辑">
      {peers.map((editor) => {
        const on = editor.id === current.id
        return (
          <button type="button" key={editor.id} role="option" aria-selected={on}
            className={`editor-peer-item ${on ? 'on' : ''}`}
            onClick={() => onPick(editor)}>
            <b>{editor.name.trim() || '佚名'}</b>
            <small>{editor.email}</small>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

export function EditorsView() {
  const [reloadSignal, setReloadSignal] = useState(0)
  const [total, setTotal] = useState(0)
  const [platformOptions, setPlatformOptions] = useState<string[]>([])
  const [editing, setEditing] = useState<Editor | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showData, setShowData] = useState(false)
  const [form, setForm] = useState<EditorInput>(emptyForm)
  const [customWorkType, setCustomWorkType] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const refresh = () => setReloadSignal((n) => n + 1)

  const openAdd = () => { setEditing(null); setForm(emptyForm); setCustomWorkType(''); setShowForm(true) }
  const openEdit = (e: Editor) => {
    const next = normalizeEditorTags(e)
    setEditing(next)
    setForm({
      platform: next.platform, name: next.name, email: next.email,
      work_type: next.work_type,
      notes: next.notes ?? '',
    })
    setCustomWorkType('')
    setShowForm(true)
  }

  const toggleTag = (tag: string) => {
    setForm((f) => ({
      ...f,
      work_type: f.work_type.includes(tag) ? f.work_type.filter((x) => x !== tag) : [...f.work_type, tag],
    }))
  }

  const addCustomWorkType = () => {
    const tag = customWorkType.trim()
    if (!tag) return
    if (!form.work_type.includes(tag)) setForm((f) => ({ ...f, work_type: [...f.work_type, tag] }))
    setCustomWorkType('')
  }

  const save = async () => {
    if (!isValidEmail(form.email)) { toast('请填写有效的收稿邮箱', 'warning'); return }
    const payload = normalizeEditorTags(form)
    try {
      if (editing) await api.updateEditor(editing.id, payload)
      else await api.addEditor(payload)
      setShowForm(false)
      refresh()
      toast(editing ? '编辑已保存' : '编辑已加入', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const exportList = async () => {
    const path = await saveDialog({
      title: '导出编辑库',
      defaultPath: '编辑库.xlsx',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
    })
    if (!path) return
    try {
      const saved = await api.exportEditors(path)
      toast(`已导出到 ${saved}`, 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const importList = async (file: File | null) => {
    if (!file) return
    try {
      const data = Array.from(new Uint8Array(await file.arrayBuffer()))
      const result = await api.importEditors(data, file.name)
      refresh()
      const parts = [
        result.added ? `新加入 ${result.added} 位` : '',
        result.updated ? `更新 ${result.updated} 位` : '',
      ].filter(Boolean)
      if (result.errors.length) {
        toast(`${parts.join('，') || '没有写入新编辑'}。${result.errors.slice(0, 3).join('；')}${result.errors.length > 3 ? ` 等 ${result.errors.length} 行未导入` : ''}`, 'warning')
      } else if (parts.length) {
        toast(parts.join('，'), 'success')
      } else {
        toast('文件里没有可导入的编辑', 'info')
      }
    } catch (e) { toast(String(e), 'error') }
  }

  const importDefaults = async () => {
    const ok = await confirm({
      title: '载入默认编辑库',
      message: '将写入内置的投稿邮箱。相同邮箱会更新资料，不会删除你自己添加的编辑。',
      confirmLabel: '载入',
    })
    if (!ok) return
    try {
      const result = await api.importDefaultEditors()
      refresh()
      const parts = [
        result.added ? `新加入 ${result.added} 位` : '',
        result.updated ? `更新 ${result.updated} 位` : '',
      ].filter(Boolean)
      toast(parts.join('，') || '默认编辑库已是最新', parts.length ? 'success' : 'info')
    } catch (e) { toast(String(e), 'error') }
  }

  const remove = async (id: number) => {
    const ok = await confirm({ title: '删除编辑', message: '从编辑库里去掉，已经写进计划的收件人不会自动删除。', confirmLabel: '删除', tone: 'danger' })
    if (!ok) return
    try { await api.deleteEditor(id); refresh(); toast('编辑已删除', 'success') } catch (e) { toast(String(e), 'error') }
  }

  const clearAll = async () => {
    const ok = await confirm({
      title: '清空编辑库',
      message: '将删除编辑库里的全部编辑。已经写进计划的收件人不会自动删除。此操作不可撤销。',
      confirmLabel: '清空',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const deleted = await api.clearEditors()
      refresh()
      setShowData(false)
      toast(deleted ? `已清空 ${deleted} 位编辑` : '编辑库已是空的', deleted ? 'success' : 'info')
    } catch (e) { toast(String(e), 'error') }
  }

  return (
    <>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" hidden
        onChange={(e) => { void importList(e.target.files?.[0] ?? null); e.target.value = '' }} />
      <EditorsList
        reloadSignal={reloadSignal}
        onEdit={openEdit}
        onDelete={(e) => void remove(e.id)}
        onTotalChange={setTotal}
        onPlatformsChange={setPlatformOptions}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setShowData(true)}><Database size={13} />数据管理</Button>
            <Button size="sm" variant="primary" onClick={openAdd}><Plus size={13} />添加</Button>
          </>
        }
        emptyAction={
          <div className="toolbar-actions">
            <Button size="sm" onClick={() => setShowData(true)}><Database size={13} />数据管理</Button>
            <Button size="sm" variant="primary" onClick={openAdd}><Plus size={13} />添加</Button>
          </div>
        }
      />

      {total > 0 && (
        <p className="after-table-hint">
          导入同邮箱会更新资料。准备好后去 <button type="button" className="text-link" onClick={() => go('plans')}>投稿计划</button> 按作品类型筛编辑。
        </p>
      )}

      {showData && (
        <Modal title="数据管理" width={440} onClose={() => setShowData(false)}>
          <div className="editor-data-list">
            <div className="editor-data-row">
              <div>
                <b>导入</b>
                <p>从 Excel / CSV 写入编辑。相同邮箱会更新资料。</p>
              </div>
              <Button size="sm" onClick={() => fileRef.current?.click()}><Upload size={13} />导入</Button>
            </div>
            <div className="editor-data-row">
              <div>
                <b>默认库</b>
                <p>载入内置投稿邮箱。已有的相同邮箱会更新，不会删你自己加的。</p>
              </div>
              <Button size="sm" onClick={() => void importDefaults()}>载入</Button>
            </div>
            <div className="editor-data-row">
              <div>
                <b>导出</b>
                <p>把当前编辑库存成 Excel，方便备份或换电脑。</p>
              </div>
              <Button size="sm" onClick={() => void exportList()}><Download size={13} />导出</Button>
            </div>
            <div className="editor-data-row is-danger">
              <div>
                <b>清空</b>
                <p>删除编辑库里的全部编辑。计划里已有的收件人不会跟着删。</p>
              </div>
              <Button size="sm" variant="ghost" className="danger" onClick={() => void clearAll()}>清空</Button>
            </div>
          </div>
        </Modal>
      )}

      {showForm && (
        <Modal title={editing ? '编辑资料' : '添加编辑'} width={560}
          onClose={() => setShowForm(false)}
          footer={<><Button variant="ghost" onClick={() => setShowForm(false)}>取消</Button><Button variant="primary" onClick={() => void save()}>保存</Button></>}>
          <div className="form-grid">
            <label className="field">平台
              <input value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} placeholder="选填，例如：起点、晋江" list="editor-platforms" />
            </label>
            <label className="field">名称
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="选填，编辑或栏目名" /></label>
            <label className="field span2">收稿邮箱（必填）
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="editor@example.com" /></label>
            <div className="field span2">作品类型
              <div className="chip-picks">
                {[...new Set([...GENRES, ...form.work_type])].map((g) => (
                  <button type="button" key={g} className={`chip ${form.work_type.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleTag(g)}>{g}</button>
                ))}
              </div>
              <div className="editor-custom-tag">
                <input value={customWorkType} onChange={(e) => setCustomWorkType(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomWorkType() } }}
                  placeholder="自定义作品类型，回车添加" />
                <Button size="sm" onClick={addCustomWorkType}>添加</Button>
              </div>
              <span className="field-hint">作品类型用于筛选收件人，可不填。</span>
            </div>
            <label className="field span2">收稿说明
              <textarea className="editor-notes" rows={4} value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="审稿、结算、收稿方向、不收题材等，选填" />
            </label>
            {editing && (
              <p className="field-hint span2">
                当前来源：{editing.source || '手动数据'}。在这里保存后会记为手动数据。
              </p>
            )}
          </div>
          <datalist id="editor-platforms">
            {platformOptions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </Modal>
      )}
    </>
  )
}

