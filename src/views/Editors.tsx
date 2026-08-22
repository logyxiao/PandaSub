import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Database, Download, FolderOpen, Heart, Pencil, Plus, RotateCcw, Search, Trash2, Upload, Users } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Button, EmptyState, IconButton, Select } from '../components/ui'
import { Table, type TableColumn } from '../components/Table'
import { isValidEmail } from '../format'
import { useNav } from '../nav'
import type { Editor, EditorGroup, EditorInput } from '../types'
import { GENRES, SOURCES, compareEditorsByFavorite, editorMatchesPlan, editorPlatformKey, editorRowTags, isEditorFavorited, normalizeEditorTags } from './planShared'

const UNASSIGNED = '未填平台'

const emptyForm: EditorInput = {
  platform: '', name: '', email: '', work_type: [], rejected_types: [], notes: '',
}

export interface EditorListFilters {
  query: string
  platform: string
  source: string
  workTypes: string[]
  excludedWorkTypes: string[]
  favoritedOnly: boolean
}

// eslint-disable-next-line react/only-export-components
export const emptyEditorListFilters = (workTypes: string[] = [], excludedWorkTypes: string[] = []): EditorListFilters => ({
  query: '',
  platform: '',
  source: '',
  workTypes,
  excludedWorkTypes,
  favoritedOnly: false,
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
  onFavoriteChange?: (id: number, favorited: boolean) => void
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
  /** 投稿向导：每个平台只显示一位，同平台其他人走「同平台」更换 */
  onePerPlatform?: boolean
}

/** 编辑库列表（搜索、平台/作品类型筛选、分页、标签气泡），可作为页面或插件式嵌入投稿向导。 */
export function EditorsList({
  items: externalItems, reloadSignal = 0, selectable = false,
  selectedIds, onToggleSelect, onEdit, onDelete, onTotalChange, onVisibleChange, onPlatformsChange, pageSize,
  emptyText = '首次打开会载入内置投稿邮箱。也可以自己添加，或导入 Excel / CSV。',
  emptyAction, actions, initialWorkTypes, initialExcludedWorkTypes,
  filters, onFiltersChange,
  platformPeersOf, onReplaceEditor, onFavoriteChange, onePerPlatform = false,
}: EditorsListProps) {
  const [items, setItems] = useState<Editor[]>([])
  const [loading, setLoading] = useState(!externalItems)
  const [notice, setNotice] = useState('')
  const [localFilters, setLocalFilters] = useState<EditorListFilters>(() =>
    emptyEditorListFilters(initialWorkTypes ?? [], initialExcludedWorkTypes ?? []),
  )
  const current = filters ?? localFilters
  const { query, platform, source, workTypes, excludedWorkTypes, favoritedOnly } = current
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
    return [e.name, e.email, e.platform, e.source, e.notes, ...(e.work_type ?? []), ...(e.rejected_types ?? [])].join(' ').toLowerCase().includes(q)
  }), [list, platform, query])

  const workTypeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of basePool) for (const d of e.work_type ?? []) map.set(d, (map.get(d) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [basePool])

  const visible = useMemo(() => {
    const filtered = [...basePool.filter((e) => {
      if (favoritedOnly && !isEditorFavorited(e)) return false
      if (source && e.source !== source) return false
      return editorMatchesPlan(e, workTypes, excludedWorkTypes)
    })].sort(compareEditorsByFavorite)
    // 搜索时列出库里所有命中的人，方便从编辑库找人；平时每个平台只留一位。
    if (!onePerPlatform || query.trim()) return filtered
    const groups = new Map<string, Editor[]>()
    const order: string[] = []
    for (const editor of filtered) {
      const key = editorPlatformKey(editor)
      const list = groups.get(key)
      if (list) list.push(editor)
      else {
        groups.set(key, [editor])
        order.push(key)
      }
    }
    return order.map((key) => {
      const list = groups.get(key) ?? []
      return list.find((item) => selectedIds?.has(item.id)) ?? list[0]
    })
  }, [basePool, source, workTypes, excludedWorkTypes, favoritedOnly, onePerPlatform, query, selectedIds])

  useEffect(() => { onTotalChange?.(visible.length) }, [visible.length, onTotalChange])
  const onVisibleChangeRef = useRef(onVisibleChange)
  onVisibleChangeRef.current = onVisibleChange
  useEffect(() => { onVisibleChangeRef.current?.(visible) }, [visible])
  useEffect(() => { setMore(null); setPeerPick(null) }, [platform, query, source, workTypes, excludedWorkTypes, favoritedOnly, list])

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

  const toggleFavorite = useCallback(async (editor: Editor) => {
    try {
      const saved = await api.toggleEditorFavorite(editor.id)
      if (!externalItems) {
        setItems((list) => list.map((item) => (item.id === editor.id ? { ...item, favorited: saved } : item)))
      }
      onFavoriteChange?.(editor.id, saved)
    } catch (e) {
      setNotice(String(e))
    }
  }, [externalItems, onFavoriteChange])

  const moreEditor = more ? visible.find((item) => item.id === more.id) : undefined
  const moreWorkTypes = moreEditor ? editorRowTags(moreEditor.work_type) : []
  const peerEditor = peerPick ? visible.find((item) => item.id === peerPick.id) : undefined
  const peerList = peerEditor && platformPeersOf
    ? [...platformPeersOf(peerEditor)].sort((a, b) => {
        if (a.id === peerEditor.id) return -1
        if (b.id === peerEditor.id) return 1
        if (isEditorFavorited(a) !== isEditorFavorited(b)) return isEditorFavorited(a) ? -1 : 1
        return (a.name || a.email).localeCompare(b.name || b.email, 'zh')
      })
    : []

  const editorColumns = useMemo<TableColumn<Editor>[]>(() => {
    const cols: TableColumn<Editor>[] = []
    if (selectable) {
      cols.push({
        key: 'check',
        title: '',
        width: 40,
        align: 'center',
        render: (_value, e) => {
          const checked = selectedIds?.has(e.id) ?? false
          return (
            <label className="editor-row-check">
              <input type="checkbox" checked={checked}
                onChange={(ev) => onToggleSelect?.(e, ev.target.checked)}
                aria-label={`${checked ? '取消选择' : '选择'} ${e.name.trim() || e.email}`} />
            </label>
          )
        },
      })
    }
    cols.push(
      {
        key: 'favorite',
        title: '',
        width: 40,
        align: 'center',
        render: (_value, e) => {
          const on = isEditorFavorited(e)
          return (
            <IconButton
              className={`favorite-toggle editor-star ${on ? 'on' : ''}`}
              title={on ? '取消收藏' : '收藏'}
              onClick={() => void toggleFavorite(e)}>
              <Heart size={13} fill={on ? 'currentColor' : 'none'} />
            </IconButton>
          )
        },
      },
      {
        key: 'editor',
        title: '编辑',
        width: 220,
        render: (_value, e) => (
          <div className={`editor-row-main ${onEdit ? 'is-hit' : ''}`}
            role={onEdit ? 'button' : undefined}
            tabIndex={onEdit ? 0 : undefined}
            title={onEdit ? '修改这份编辑资料' : undefined}
            onClick={onEdit ? () => onEdit(e) : undefined}
            onKeyDown={onEdit ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEdit(e) } } : undefined}>
            <EditorIdentity name={e.name} platform={e.platform} email={e.email} />
          </div>
        ),
      },
      {
        key: 'notes',
        title: '备注',
        ellipsis: { rows: 2 },
        render: (_value, e) => {
          const note = (e.notes ?? '').trim()
          return (
            <div className={onEdit ? 'is-hit' : undefined}
              role={onEdit ? 'button' : undefined}
              tabIndex={onEdit ? 0 : undefined}
              title={note ? (onEdit ? `${note}\n点击修改` : note) : (onEdit ? '点击补充备注' : undefined)}
              onClick={onEdit ? () => onEdit(e) : undefined}
              onKeyDown={onEdit ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEdit(e) } } : undefined}>
              {note || <span className="hint">无备注</span>}
            </div>
          )
        },
      },
      {
        key: 'work_type',
        title: '作品类型',
        width: 168,
        render: (_value, e) => (
          <EditorTypeChips
            workTypes={e.work_type}
            rejectedTypes={e.rejected_types}
            open={more?.id === e.id}
            onToggle={(el) => {
              const next = moreRect(el)
              setMore((m) => (m?.id === e.id ? null : { id: e.id, ...next }))
            }}
          />
        ),
      },
      {
        key: 'actions',
        title: '',
        width: platformPeersOf ? 200 : 112,
        render: (_value, e) => (
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
        ),
      },
    )
    return cols
  }, [selectable, selectedIds, onToggleSelect, onEdit, onDelete, platformPeersOf, peerPick, more, toggleFavorite])

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
        <button type="button" className={`field-chip editor-fav-filter ${favoritedOnly ? 'on' : ''}`}
          onClick={() => setFilters({ favoritedOnly: !favoritedOnly })}>
          <Heart size={11} fill={favoritedOnly ? 'currentColor' : 'none'} />收藏
        </button>
        <div className="editor-toolbar-actions">
          <IconButton title="重置筛选" className="editor-tool-icon" disabled={!query && !platform && !source && !workTypes.length && !excludedWorkTypes.length && !favoritedOnly}
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
          <Table
            rowKey="id"
            dataSource={visible}
            resetKey={`${query}\0${platform}\0${source}\0${workTypes.join('\0')}\0${excludedWorkTypes.join('\0')}\0${favoritedOnly ? '1' : '0'}`}
            pagination={{
              pageSize: pageSize ?? 10,
              pageSizeOptions: [...new Set([pageSize ?? 10, 10, 20, 50])].sort((a, b) => a - b),
            }}
            empty={loading ? '读取中…' : '没有符合筛选的编辑'}
            columns={editorColumns}
          />
        </div>
      )}
      {more && moreEditor && (
        <EditorTagsPop
          top={more.top}
          left={more.left}
          width={more.width}
          workTypes={moreWorkTypes}
          rejectedTypes={moreEditor.rejected_types ?? []}
          skip={moreWorkTypes.length && (moreEditor.rejected_types ?? []).length ? 1 : 2}
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

export function EditorIdentity({ name, platform, email, fallbackPlatform = UNASSIGNED }: {
  name: string
  platform: string
  email: string
  fallbackPlatform?: string
}) {
  return (
    <>
      <b>
        <span className="editor-row-name">{name.trim() || '佚名'}</span>
        <span className="editor-row-sep">｜</span>
        <span className="editor-row-plat">{platform.trim() || fallbackPlatform}</span>
      </b>
      <small>{email}</small>
    </>
  )
}

export function EditorTypeChips({ workTypes, rejectedTypes = [], open, onToggle }: {
  workTypes: string[]
  rejectedTypes?: string[]
  open?: boolean
  onToggle?: (el: HTMLElement, tags: string[], rejected: string[]) => void
}) {
  const tags = editorRowTags(workTypes)
  const rejected = editorRowTags(rejectedTypes)
  const shown = tags.slice(0, rejected.length ? 1 : 2)
  const shownRejected = rejected.slice(0, tags.length ? 1 : 2)
  const rest = tags.slice(shown.length)
  const restRejected = rejected.slice(shownRejected.length)
  const restCount = rest.length + restRejected.length
  if (!tags.length && !rejected.length) return <span className="hint">未设标签</span>
  return (
    <div className="editor-row-tags">
      {shown.map((d, i) => (
        <span key={`${i}-${d}`} className="chip on tone">{d}</span>
      ))}
      {shownRejected.map((d, i) => (
        <span key={`r-${i}-${d}`} className="chip is-rejected" title={`拒收 ${d}`}>{d}</span>
      ))}
      {restCount > 0 && (
        <button type="button" className={`editor-chip-more ${open ? 'on' : ''}`}
          onClick={(ev) => onToggle?.(ev.currentTarget, tags, rejected)}>
          +{restCount}
        </button>
      )}
    </div>
  )
}

// eslint-disable-next-line react/only-export-components
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

export function EditorTagsPop({ top, left, width, workTypes, rejectedTypes = [], skip, onClose }: {
  top: number
  left: number
  width: number
  workTypes: string[]
  rejectedTypes?: string[]
  skip: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const restWorkTypes = workTypes.slice(skip).map(String)
  const restRejected = editorRowTags(rejectedTypes).slice(workTypes.length ? 1 : 2)

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
        {restRejected.map((d, i) => <span className="chip is-rejected" key={`r-${i}-${d}`}>{d}</span>)}
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
    const onScroll = (ev: Event) => {
      const target = ev.target
      if (target instanceof Node && ref.current?.contains(target)) return
      dismiss()
    }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') dismiss() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
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
            <b>
              {isEditorFavorited(editor) && <Heart size={10} className="editor-star-mark" fill="currentColor" />}
              {editor.name.trim() || '佚名'}
            </b>
            <small>{editor.email}</small>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

function EditorGroupsLibrary() {
  const [groups, setGroups] = useState<EditorGroup[]>([])
  const [editors, setEditors] = useState<Editor[]>([])
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<EditorGroup | null>(null)
  const [name, setName] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [visibleEditors, setVisibleEditors] = useState<Editor[]>([])
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const groupFileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const load = useCallback(async (preferredGroupId?: number) => {
    setLoading(true)
    try {
      const [nextGroups, nextEditors] = await Promise.all([api.listEditorGroups(), api.listEditors()])
      setGroups(nextGroups)
      setEditors(nextEditors)
      setActiveGroupId((current) => {
        if (preferredGroupId && nextGroups.some((group) => group.id === preferredGroupId)) return preferredGroupId
        if (current && nextGroups.some((group) => group.id === current)) return current
        return nextGroups[0]?.id ?? null
      })
      setNotice('')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const editorMap = useMemo(
    () => new Map(editors.map((editor) => [editor.id, editor])),
    [editors],
  )
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null
  const activeMembers = activeGroup?.editor_ids.flatMap((id) => {
    const editor = editorMap.get(id)
    return editor ? [editor] : []
  }) ?? []

  const openNew = () => {
    setEditing(null)
    setName('')
    setSelectedIds(new Set())
    setVisibleEditors([])
    setSelectedOnly(false)
    setShowForm(true)
  }

  const openEdit = (group: EditorGroup) => {
    setEditing(group)
    setName(group.name)
    setSelectedIds(new Set(group.editor_ids.filter((id) => editorMap.has(id))))
    setVisibleEditors([])
    setSelectedOnly(false)
    setShowForm(true)
  }

  const toggleEditor = (editor: Editor, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(editor.id)
      else next.delete(editor.id)
      return next
    })
  }

  const toggleVisible = () => {
    const shouldSelect = visibleEditors.some((editor) => !selectedIds.has(editor.id))
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const editor of visibleEditors) {
        if (shouldSelect) next.add(editor.id)
        else next.delete(editor.id)
      }
      return next
    })
  }

  const save = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) { toast('请填写编辑组名称', 'warning'); return }
    if (!selectedIds.size) { toast('请至少选择一位编辑', 'warning'); return }
    const editor_ids = editors.filter((editor) => selectedIds.has(editor.id)).map((editor) => editor.id)
    setSaving(true)
    try {
      let savedId = editing?.id
      if (editing) await api.updateEditorGroup(editing.id, { name: trimmedName, editor_ids })
      else savedId = await api.createEditorGroup({ name: trimmedName, editor_ids })
      setShowForm(false)
      await load(savedId)
      toast(editing ? '编辑组已更新' : '编辑组已创建', 'success')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (group: EditorGroup) => {
    const ok = await confirm({
      title: `删除“${group.name}”？`,
      message: '只会删除这个分组，不会删除组里的编辑资料，也不会影响已经保存的投稿计划。',
      confirmLabel: '删除分组',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteEditorGroup(group.id)
      await load()
      toast('编辑组已删除', 'success')
    } catch (error) {
      toast(String(error), 'error')
    }
  }

  const exportGroups = async (groupIds: number[], fileLabel: string) => {
    const safeLabel = fileLabel.replace(/[\\/:*?"<>|]/g, '_')
    const path = await saveDialog({
      title: groupIds.length ? '导出当前编辑组' : '导出全部编辑组',
      defaultPath: `${safeLabel}.json`,
      filters: [{ name: 'NovelSub 编辑组', extensions: ['json'] }],
    })
    if (!path) return
    setExporting(true)
    try {
      const saved = await api.exportEditorGroups(path, groupIds)
      toast(`编辑组已导出到 ${saved}`, 'success')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setExporting(false)
    }
  }

  const importGroups = async (file: File | null) => {
    if (!file) return
    setImporting(true)
    try {
      const data = Array.from(new Uint8Array(await file.arrayBuffer()))
      const result = await api.importEditorGroups(data, file.name)
      await load()
      const changes = [
        result.groups_added ? `新增 ${result.groups_added} 个组` : '',
        result.groups_updated ? `合并 ${result.groups_updated} 个同名组` : '',
        result.editors_added ? `补入 ${result.editors_added} 位编辑` : '',
      ].filter(Boolean)
      toast(changes.join('，') || '编辑组内容已存在，无需重复导入', changes.length ? 'success' : 'info')
    } catch (error) {
      toast(String(error), 'error')
    } finally {
      setImporting(false)
    }
  }

  const pickerItems = useMemo(
    () => selectedOnly ? editors.filter((editor) => selectedIds.has(editor.id)) : editors,
    [editors, selectedIds, selectedOnly],
  )
  const allVisibleSelected = visibleEditors.length > 0
    && visibleEditors.every((editor) => selectedIds.has(editor.id))

  return (
    <>
      <input ref={groupFileRef} type="file" accept=".json,application/json" hidden
        onChange={(event) => { void importGroups(event.target.files?.[0] ?? null); event.target.value = '' }} />
      <div className="editor-group-tabs-bar">
        <div className="editor-group-tabs" role="tablist" aria-label="编辑组列表">
          {groups.map((group) => {
            const memberCount = group.editor_ids.filter((id) => editorMap.has(id)).length
            const active = group.id === activeGroupId
            return (
              <button type="button" role="tab" aria-selected={active} key={group.id}
                className={`editor-group-tab ${active ? 'on' : ''}`}
                onClick={() => setActiveGroupId(group.id)}>
                <span>{group.name}</span><small>{memberCount}</small>
              </button>
            )
          })}
        </div>
        <div className="editor-group-share-actions">
          <Button size="sm" disabled={importing} onClick={() => groupFileRef.current?.click()}>
            <Upload size={13} />{importing ? '导入中…' : '导入'}
          </Button>
          <Button size="sm" disabled={exporting || !groups.length} onClick={() => void exportGroups([], '全部编辑组')}>
            <Download size={13} />导出全部
          </Button>
          <Button size="sm" variant="primary" onClick={openNew}><Plus size={13} />新建编辑组</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}
      {!loading && !groups.length ? (
        <div className="panel">
          <EmptyState icon={FolderOpen} title="还没有编辑组"
            desc="把常用编辑整理成组，写投稿计划时就能一键选择。"
            action={<Button size="sm" variant="primary" onClick={openNew}><Plus size={13} />新建编辑组</Button>} />
        </div>
      ) : activeGroup && (
        <div className="editor-group-detail">
          <div className="editor-group-detail-head">
            <span className="editor-group-detail-title">
              <span className="editor-group-icon"><FolderOpen size={17} /></span>
              <span><b>{activeGroup.name}</b><small>{activeMembers.length} 位编辑</small></span>
            </span>
            <span className="editor-group-actions">
              <Button size="sm" disabled={exporting} onClick={() => void exportGroups([activeGroup.id], activeGroup.name)}>
                <Download size={13} />导出当前
              </Button>
              <Button size="sm" onClick={() => openEdit(activeGroup)}><Pencil size={13} />改名和成员</Button>
              <IconButton title={`删除编辑组 ${activeGroup.name}`} className="danger" onClick={() => void remove(activeGroup)}><Trash2 size={14} /></IconButton>
            </span>
          </div>
          <EditorsList
            key={activeGroup.id}
            items={activeMembers}
            onFavoriteChange={(id, favorited) => setEditors((items) => items.map((editor) => editor.id === id ? { ...editor, favorited } : editor))}
            pageSize={10}
            emptyText="这个组里暂时没有可用编辑，可点“改名和成员”重新选择。"
            emptyAction={<Button size="sm" onClick={() => openEdit(activeGroup)}><Pencil size={13} />管理成员</Button>}
          />
          <p className="after-table-hint">在投稿计划的“选择编辑”步骤，点“{activeGroup.name}”即可整组选入。</p>
        </div>
      )}

      {showForm && (
        <Modal title={editing ? '编辑编辑组' : '新建编辑组'} width={900}
          onClose={() => setShowForm(false)}
          footer={
            <>
              <span className="editor-group-selected-count">已选 {selectedIds.size} 位</span>
              <Button variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
              <Button variant="primary" disabled={saving || !name.trim() || !selectedIds.size} onClick={() => void save()}>
                {saving ? '保存中…' : '保存编辑组'}
              </Button>
            </>
          }>
          <div className="editor-group-form-head">
            <label className="field">编辑组名称
              <input autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：短篇常投、重点编辑" />
            </label>
            <p>从完整编辑库中勾选成员。保存后可随时改名、增减成员。</p>
          </div>
          <div className="editor-group-picker">
            <EditorsList
              items={pickerItems}
              selectable
              selectedIds={selectedIds}
              onToggleSelect={toggleEditor}
              onVisibleChange={setVisibleEditors}
              onFavoriteChange={(id, favorited) => setEditors((items) => items.map((editor) => editor.id === id ? { ...editor, favorited } : editor))}
              pageSize={6}
              actions={
                <>
                  <Button size="sm" className={selectedOnly ? 'on' : ''} onClick={() => setSelectedOnly((value) => !value)}>
                    {selectedOnly ? '查看全部' : `只看已选（${selectedIds.size}）`}
                  </Button>
                  <Button size="sm" disabled={!visibleEditors.length} onClick={toggleVisible}>
                    {allVisibleSelected ? '取消当前结果' : '选择当前结果'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>清空</Button>
                </>
              }
              emptyText={selectedOnly ? '还没有选中编辑。切换到“查看全部”开始选择。' : '编辑库还是空的，请先添加或导入编辑。'}
            />
          </div>
        </Modal>
      )}
    </>
  )
}

export function EditorsView() {
  const [view, setView] = useState<'editors' | 'groups'>('editors')
  const [reloadSignal, setReloadSignal] = useState(0)
  const [total, setTotal] = useState(0)
  const [platformOptions, setPlatformOptions] = useState<string[]>([])
  const [editing, setEditing] = useState<Editor | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showData, setShowData] = useState(false)
  const [form, setForm] = useState<EditorInput>(emptyForm)
  const [customWorkType, setCustomWorkType] = useState('')
  const [customRejectedType, setCustomRejectedType] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const refresh = () => setReloadSignal((n) => n + 1)

  const openAdd = () => { setEditing(null); setForm(emptyForm); setCustomWorkType(''); setCustomRejectedType(''); setShowForm(true) }
  const openEdit = (e: Editor) => {
    const next = normalizeEditorTags(e)
    setEditing(next)
    setForm({
      platform: next.platform, name: next.name, email: next.email,
      work_type: next.work_type,
      rejected_types: next.rejected_types ?? [],
      notes: next.notes ?? '',
    })
    setCustomWorkType('')
    setCustomRejectedType('')
    setShowForm(true)
  }

  const toggleTag = (tag: string) => {
    setForm((f) => {
      const work_type = f.work_type.includes(tag) ? f.work_type.filter((x) => x !== tag) : [...f.work_type, tag]
      const rejected_types = work_type.includes(tag)
        ? (f.rejected_types ?? []).filter((x) => x !== tag)
        : (f.rejected_types ?? [])
      return { ...f, work_type, rejected_types }
    })
  }

  const toggleRejectedTag = (tag: string) => {
    setForm((f) => {
      const current = f.rejected_types ?? []
      const rejected_types = current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]
      const work_type = rejected_types.includes(tag) ? f.work_type.filter((x) => x !== tag) : f.work_type
      return { ...f, work_type, rejected_types }
    })
  }

  const addCustomWorkType = () => {
    const tag = customWorkType.trim()
    if (!tag) return
    setForm((f) => {
      const work_type = f.work_type.includes(tag) ? f.work_type : [...f.work_type, tag]
      const rejected_types = (f.rejected_types ?? []).filter((x) => x !== tag)
      return { ...f, work_type, rejected_types }
    })
    setCustomWorkType('')
  }

  const addCustomRejectedType = () => {
    const tag = customRejectedType.trim()
    if (!tag) return
    setForm((f) => {
      const current = f.rejected_types ?? []
      const rejected_types = current.includes(tag) ? current : [...current, tag]
      const work_type = f.work_type.filter((x) => x !== tag)
      return { ...f, work_type, rejected_types }
    })
    setCustomRejectedType('')
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
      <div className="editor-view-switch" role="tablist" aria-label="编辑库视图">
        <button type="button" role="tab" aria-selected={view === 'editors'} className={view === 'editors' ? 'on' : ''} onClick={() => setView('editors')}>
          <Users size={14} />全部编辑
        </button>
        <button type="button" role="tab" aria-selected={view === 'groups'} className={view === 'groups' ? 'on' : ''} onClick={() => setView('groups')}>
          <FolderOpen size={14} />编辑组
        </button>
      </div>
      {view === 'editors' ? <><EditorsList
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
      )}</> : <EditorGroupsLibrary />}

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
            <div className="field span2">拒收类型
              <div className="chip-picks">
                {[...new Set([...GENRES, ...(form.rejected_types ?? [])])].map((g) => (
                  <button type="button" key={g} className={`chip ${(form.rejected_types ?? []).includes(g) ? 'is-rejected' : ''}`}
                    onClick={() => toggleRejectedTag(g)}>{g}</button>
                ))}
              </div>
              <div className="editor-custom-tag">
                <input value={customRejectedType} onChange={(e) => setCustomRejectedType(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomRejectedType() } }}
                  placeholder="自定义拒收类型，回车添加" />
                <Button size="sm" onClick={addCustomRejectedType}>添加</Button>
              </div>
              <span className="field-hint">选中计划标签时，会自动排除拒收对应类型的编辑。</span>
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
