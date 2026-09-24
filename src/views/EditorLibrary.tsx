import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Database,
  FolderOpen,
  Heart,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { api } from '../api'
import type { Editor, EditorGroup, EditorInput } from '../types'
import { Button, EmptyState, IconButton, Pager, Select } from '../components/ui'
import { Modal } from '../components/Modal'
import { EditorNotePreview } from '../components/EditorNotePreview'
import {
  EditorTagDialog,
  EditorTagField,
  SelectedEditorTags,
  TagMatchSwitch,
} from '../components/EditorTags'
import { useConfirm, useToast } from '../components/feedback'
import {
  compareEditorsByFavorite,
  normalizeEditorTags,
  SOURCES,
} from './planShared'
import {
  editorInput,
  matchesEditorTags,
  splitEditorTags,
  validateEditorInput,
  type TagMatchMode,
} from './editorLibraryShared'

type View = 'all' | 'favorites' | 'incomplete' | 'changed'
type Draft = { id: number; input: EditorInput; types: string }

export function EditorLibrary({
  reloadSignal,
  updatedEditorId,
  onEdit,
  onDelete,
  onAdd,
  onData,
  onPlatformsChange,
  onTagsChange,
  onDirtyChange,
  onBusyChange,
}: {
  reloadSignal: number
  updatedEditorId: number | null
  onEdit: (editor: Editor) => void
  onDelete: (editor: Editor) => void
  onAdd: () => void
  onData: () => void
  onPlatformsChange: (values: string[]) => void
  onTagsChange: (values: string[]) => void
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [items, setItems] = useState<Editor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('')
  const [source, setSource] = useState('')
  const [view, setView] = useState<View>('all')
  const [workTypes, setWorkTypes] = useState<string[]>([])
  const [excluded, setExcluded] = useState<string[]>([])
  const [tagMode, setTagMode] = useState<TagMatchMode>('any')
  const [showTags, setShowTags] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(6)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [changed, setChanged] = useState<Set<number>>(new Set())
  const [groups, setGroups] = useState<EditorGroup[]>([])
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupTargets, setGroupTargets] = useState<Set<number>>(new Set())
  const [newGroupName, setNewGroupName] = useState('')
  const [groupLoading, setGroupLoading] = useState(false)
  const rowRef = useRef<HTMLTableRowElement>(null)
  const focusField = useRef<'email' | 'types' | 'notes'>('email')
  const checkAllRef = useRef<HTMLInputElement>(null)
  const requestSeq = useRef(0)
  const confirm = useConfirm()
  const toast = useToast()
  const original = draft ? items.find((e) => e.id === draft.id) : undefined
  const dirty = Boolean(
    draft &&
      original &&
      (draft.types !== original.work_type.join('、') ||
        JSON.stringify(draft.input) !== JSON.stringify(editorInput(original))),
  )
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    onBusyChange(saving)
    return () => onBusyChange(false)
  }, [saving, onBusyChange])
  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const rows = (await api.listEditors()).map(normalizeEditorTags)
      if (seq !== requestSeq.current) return
      setItems(rows)
      setError('')
      setSelected(
        (prev) =>
          new Set([...prev].filter((id) => rows.some((e) => e.id === id))),
      )
    } catch (e) {
      if (seq === requestSeq.current) setError(String(e))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const sequence = requestSeq
    return () => {
      sequence.current++
    }
  }, [load, reloadSignal])
  const platforms = useMemo(
    () =>
      [...new Set(items.map((e) => e.platform.trim()).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b, 'zh'),
      ),
    [items],
  )
  useEffect(() => {
    onPlatformsChange(platforms)
  }, [platforms, onPlatformsChange])
  const inView = useCallback(
    (e: Editor, candidate: View) =>
      candidate === 'all' ||
      (candidate === 'favorites' && e.favorited) ||
      (candidate === 'incomplete' &&
        (!e.work_type.length || !e.notes.trim())) ||
      (candidate === 'changed' && changed.has(e.id)),
    [changed],
  )
  const candidates = useMemo(
    () =>
      items.filter((editor) => {
        if (
          !inView(editor, view) ||
          (platform && editor.platform !== platform) ||
          (source && editor.source !== source)
        )
          return false
        return [
          editor.name,
          editor.platform,
          editor.email,
          editor.notes,
          ...editor.work_type,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      }),
    [items, view, platform, source, query, inView],
  )
  const filtered = useMemo(
    () =>
      candidates
        .filter((editor) =>
          matchesEditorTags(editor, workTypes, excluded, tagMode),
        )
        .sort(compareEditorsByFavorite),
    [candidates, workTypes, excluded, tagMode],
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const rows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const allTags = useMemo(
    () =>
      [
        ...new Set(
          items.flatMap((editor) => [
            ...editor.work_type,
            ...(editor.rejected_types ?? []),
          ]),
        ),
      ].sort((a, b) => a.localeCompare(b, 'zh')),
    [items],
  )
  useEffect(() => {
    onTagsChange(allTags)
  }, [allTags, onTagsChange])
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>()
    candidates.forEach((editor) =>
      editor.work_type.forEach((tag) =>
        counts.set(tag, (counts.get(tag) ?? 0) + 1),
      ),
    )
    return allTags
      .map((label) => ({ label, count: counts.get(label) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'))
  }, [candidates, allTags])
  const commonTags = tagOptions.filter((tag) => tag.count > 0).slice(0, 8)
  const allSelected = rows.length > 0 && rows.every((e) => selected.has(e.id))
  useEffect(() => {
    if (checkAllRef.current)
      checkAllRef.current.indeterminate =
        !allSelected && rows.some((e) => selected.has(e.id))
  }, [rows, selected, allSelected])
  useEffect(() => {
    if (updatedEditorId !== null)
      setChanged((prev) => new Set(prev).add(updatedEditorId))
  }, [updatedEditorId, reloadSignal])
  useEffect(() => {
    if (draft)
      rowRef.current
        ?.querySelector<HTMLElement>(
          `[data-quick-field="${focusField.current}"]`,
        )
        ?.focus()
  }, [draft?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const allowChange = async () => {
    if (savingRef.current) return false
    if (
      dirty &&
      !(await confirm({
        title: '放弃未保存的修改？',
        message: '当前编辑资料尚未保存。继续会丢弃这次修改。',
        confirmLabel: '放弃修改',
        cancelLabel: '继续编辑',
      }))
    )
      return false
    setDraft(null)
    return true
  }
  const filterChange = async (change: () => void) => {
    if (await allowChange()) {
      change()
      setPage(1)
    }
  }
  const openDetails = async (editor: Editor) => {
    if (await allowChange()) onEdit(editor)
  }
  const edit = async (
    e: Editor,
    field: 'email' | 'types' | 'notes' = 'email',
  ) => {
    if (draft?.id === e.id) return
    if (await allowChange()) {
      focusField.current = field
      setDraft({
        id: e.id,
        input: editorInput(e),
        types: e.work_type.join('、'),
      })
    }
  }
  const save = async () => {
    if (!draft || savingRef.current) return
    const work_type = splitEditorTags(draft.types)
    const payload = normalizeEditorTags({
      ...draft.input,
      email: draft.input.email.trim().toLowerCase(),
      notes: draft.input.notes.trim(),
      work_type,
      rejected_types: (draft.input.rejected_types ?? []).filter(
        (t) => !work_type.includes(t),
      ),
    })
    const validation = validateEditorInput(payload, items, draft.id)
    if (validation) {
      toast(validation, 'warning')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      await api.updateEditor(draft.id, payload)
      setItems((prev) =>
        prev.map((e) =>
          e.id === draft.id ? { ...e, ...payload, source: '手动数据' } : e,
        ),
      )
      setChanged((prev) => new Set(prev).add(draft.id))
      setDraft(null)
      toast('编辑资料已保存', 'success')
    } catch (e) {
      toast(String(e), 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const favorite = async (e: Editor) => {
    if (!(await allowChange())) return
    try {
      const value = await api.toggleEditorFavorite(e.id)
      setItems((prev) =>
        prev.map((row) =>
          row.id === e.id ? { ...row, favorited: value } : row,
        ),
      )
    } catch (error) {
      toast(String(error), 'error')
    }
  }
  const toggleTag = (tag: string, exclude = false) =>
    void filterChange(() => {
      if (exclude) {
        setWorkTypes((prev) => prev.filter((t) => t !== tag))
        setExcluded((prev) =>
          prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
        )
      } else {
        setExcluded((prev) => prev.filter((t) => t !== tag))
        setWorkTypes((prev) =>
          prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
        )
      }
    })
  const chooseGroups = async () => {
    if (!(await allowChange())) return
    setGroupOpen(true)
    setGroupLoading(true)
    setGroupTargets(new Set())
    setNewGroupName('')
    try {
      setGroups(await api.listEditorGroups())
    } catch (error) {
      toast(String(error), 'error')
      setGroupOpen(false)
    } finally {
      setGroupLoading(false)
    }
  }
  const addToGroups = async () => {
    if (savingRef.current || (!groupTargets.size && !newGroupName.trim()))
      return
    savingRef.current = true
    setSaving(true)
    const done: number[] = []
    let created = false
    try {
      const fresh = await api.listEditorGroups()
      const ids = [...selected].filter((id) => items.some((e) => e.id === id))
      if (!ids.length) throw new Error('请选择要加入组的编辑')
      for (const id of groupTargets) {
        const group = fresh.find((g) => g.id === id)
        if (!group) throw new Error('部分编辑组已不存在，请重新选择')
        await api.updateEditorGroup(id, {
          name: group.name,
          editor_ids: [...new Set([...group.editor_ids, ...ids])],
        })
        done.push(id)
      }
      if (newGroupName.trim()) {
        await api.createEditorGroup({
          name: newGroupName.trim(),
          editor_ids: ids,
        })
        created = true
      }
      setGroupOpen(false)
      setSelected(new Set())
      toast(`已加入 ${done.length + (created ? 1 : 0)} 个编辑组`, 'success')
    } catch (error) {
      setGroupTargets(
        (prev) => new Set([...prev].filter((id) => !done.includes(id))),
      )
      toast(
        `${done.length ? `已保存 ${done.length} 个组，其余未完成：` : ''}${String(error)}`,
        'error',
      )
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return (
    <section className="editor-library">
      <div className="library-top-actions">
        <Button
          variant="ghost"
          onClick={() =>
            void allowChange().then((ok) => {
              if (ok) onData()
            })
          }
        >
          <Database size={15} />
          导入 / 导出
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            void allowChange().then((ok) => {
              if (ok) onAdd()
            })
          }
        >
          <Plus size={15} />
          添加编辑
        </Button>
      </div>
      {error && (
        <div className="notice notice-error">
          {error}
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      <div className="panel library-panel">
        <div className="library-tabs" role="tablist" aria-label="编辑库视图">
          {(
            [
              ['all', '全部编辑'],
              ['favorites', '已收藏'],
              ['incomplete', '资料待完善'],
              ['changed', '本次修改'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={view === id ? 'on' : ''}
              onClick={() => void filterChange(() => setView(id))}
            >
              {label}
              <small>{items.filter((e) => inView(e, id)).length}</small>
            </button>
          ))}
        </div>
        <div className="library-toolbar">
          <label className="plan-search">
            <Search size={15} />
            <input
              value={query}
              disabled={Boolean(draft)}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder="搜索姓名、邮箱或备注"
              aria-label="搜索编辑库"
            />
          </label>
          <Select
            value={platform}
            ariaLabel="按平台筛选"
            searchable
            options={[
              { value: '', label: '全部平台' },
              ...platforms.map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => void filterChange(() => setPlatform(value))}
          />
          <Select
            value={source}
            ariaLabel="按来源筛选"
            options={[
              { value: '', label: '全部来源' },
              ...SOURCES.map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => void filterChange(() => setSource(value))}
          />
          <span className="hint">{filtered.length} 位编辑</span>
        </div>
        <div className="library-tag-filter">
          <div className="library-quick-tags">
            <span className="library-filter-label">常用标签</span>
            <div className="library-tags">
              {commonTags.map(({ label, count }) => (
                <button
                  type="button"
                  key={label}
                  className={`chip ${workTypes.includes(label) ? 'on' : ''}`}
                  aria-label={`筛选标签${label}`}
                  title={`${count} 位编辑使用该标签`}
                  aria-pressed={workTypes.includes(label)}
                  onClick={() => toggleTag(label)}
                >
                  <span>{label}</span>
                  <small>{count}</small>
                  {workTypes.includes(label) && <Check size={12} />}
                </button>
              ))}
              <Button
                size="sm"
                aria-label="选择筛选标签"
                onClick={() =>
                  void allowChange().then((ok) => {
                    if (ok) setShowTags(true)
                  })
                }
              >
                <Search size={13} />
                选择标签
              </Button>
            </div>
          </div>
          {Boolean(workTypes.length || excluded.length) && (
            <div className="library-active-tags">
              <div className="library-active-tags-head">
                <span>当前筛选 · {filtered.length} 位编辑</span>
                {workTypes.length > 1 && (
                  <TagMatchSwitch
                    value={tagMode}
                    onChange={(value) =>
                      void filterChange(() => setTagMode(value))
                    }
                  />
                )}
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() =>
                    void filterChange(() => {
                      setWorkTypes([])
                      setExcluded([])
                    })
                  }
                >
                  清空标签
                </Button>
              </div>
              <div className="selected-editor-tags">
                <SelectedEditorTags
                  values={workTypes}
                  onRemove={(tag) => toggleTag(tag)}
                />
                <SelectedEditorTags
                  values={excluded}
                  excluded
                  onRemove={(tag) => toggleTag(tag, true)}
                />
              </div>
            </div>
          )}
        </div>
        {showTags && (
          <EditorTagDialog
            title="筛选收稿标签"
            filtering
            options={tagOptions}
            selection={{ included: workTypes, excluded, match: tagMode }}
            previewCount={(value) =>
              candidates.filter((editor) =>
                matchesEditorTags(
                  editor,
                  value.included,
                  value.excluded,
                  value.match,
                ),
              ).length
            }
            onClose={() => setShowTags(false)}
            onApply={(value) => {
              setWorkTypes(value.included)
              setExcluded(value.excluded)
              setTagMode(value.match)
              setPage(1)
              setShowTags(false)
            }}
          />
        )}

        <div
          className={selected.size ? 'library-selection' : 'library-caption'}
        >
          {selected.size ? (
            <>
              <b>已选 {selected.size} 位</b>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void chooseGroups()}
              >
                <FolderOpen size={14} />
                加入编辑组
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => setSelected(new Set())}
              >
                清空选择
              </Button>
              <small>跨页选择会保留</small>
            </>
          ) : (
            <span>
              点击姓名或“编辑”打开完整资料；双击邮箱、类型，或点击备注可快速修改。
            </span>
          )}
        </div>
        {!loading && !items.length ? (
          <EmptyState
            icon={Heart}
            title="还没有编辑"
            desc="可以添加编辑，或从 Excel / CSV 导入。"
          />
        ) : (
          <div className="library-table-scroll">
            <table className="library-table">
              <thead>
                <tr>
                  <th>
                    <input
                      ref={checkAllRef}
                      type="checkbox"
                      checked={allSelected}
                      disabled={Boolean(draft)}
                      aria-label="选择本页编辑"
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          rows.forEach((row) =>
                            e.target.checked
                              ? next.add(row.id)
                              : next.delete(row.id),
                          )
                          return next
                        })
                      }
                    />
                  </th>
                  <th>编辑 / 平台</th>
                  <th>投稿邮箱</th>
                  <th>收稿类型</th>
                  <th>收稿要求与备注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const editing = draft?.id === e.id
                  return (
                    <tr
                      key={e.id}
                      ref={editing ? rowRef : undefined}
                      className={`${editing ? 'editing' : ''} ${selected.has(e.id) ? 'is-selected' : ''}`}
                      onKeyDown={(event) => {
                        if (!editing || saving) return
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setDraft(null)
                        }
                        if (
                          event.key === 'Enter' &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault()
                          void save()
                        }
                      }}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(e.id)}
                          disabled={Boolean(draft)}
                          aria-label={`选择编辑${e.name || e.email}`}
                          onChange={(event) =>
                            setSelected((prev) => {
                              const next = new Set(prev)
                              if (event.target.checked) next.add(e.id)
                              else next.delete(e.id)
                              return next
                            })
                          }
                        />
                      </td>
                      <td>
                        <div className="library-identity">
                          <button
                            className="text-link"
                            onClick={() => void openDetails(e)}
                          >
                            {e.name || '未命名编辑'}
                          </button>
                          <IconButton
                            title={e.favorited ? '取消收藏' : '收藏'}
                            className={`favorite-toggle ${e.favorited ? 'on' : ''}`}
                            onClick={() => void favorite(e)}
                          >
                            <Heart
                              size={13}
                              fill={e.favorited ? 'currentColor' : 'none'}
                            />
                          </IconButton>
                        </div>
                        <small>
                          {e.platform || '未填平台'}
                          {changed.has(e.id) && (
                            <span className="library-modified">已修改</span>
                          )}
                        </small>
                      </td>
                      <td onDoubleClick={() => void edit(e)}>
                        {editing ? (
                          <input
                            data-quick-field="email"
                            type="email"
                            aria-label="修改投稿邮箱"
                            disabled={saving}
                            value={draft.input.email}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                input: {
                                  ...draft.input,
                                  email: event.target.value,
                                },
                              })
                            }
                          />
                        ) : (
                          <span className="library-email">{e.email}</span>
                        )}
                      </td>
                      <td onDoubleClick={() => void edit(e, 'types')}>
                        {editing ? (
                          <EditorTagField
                            label="收稿类型"
                            focusKey="types"
                            values={splitEditorTags(draft.types)}
                            options={allTags}
                            disabled={saving}
                            onChange={(values) =>
                              setDraft({ ...draft, types: values.join('、') })
                            }
                          />
                        ) : (
                          <div className="library-tags">
                            {e.work_type.slice(0, 3).map((tag) => (
                              <span className="chip" key={tag}>
                                {tag}
                              </span>
                            ))}
                            {e.work_type.length > 3 && (
                              <button
                                className="text-link"
                                onClick={() => void openDetails(e)}
                              >
                                +{e.work_type.length - 3}
                              </button>
                            )}
                            {!e.work_type.length && <small>待补充</small>}
                          </div>
                        )}
                      </td>
                      <td>
                        {editing ? (
                          <textarea
                            data-quick-field="notes"
                            rows={3}
                            aria-label="修改收稿备注"
                            disabled={saving}
                            value={draft.input.notes}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                input: {
                                  ...draft.input,
                                  notes: event.target.value,
                                },
                              })
                            }
                          />
                        ) : (
                          <EditorNotePreview note={e.notes} onEdit={() => void edit(e, 'notes')} />
                        )}
                      </td>
                      <td>
                        <div className="library-row-actions">
                          {editing ? (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={saving}
                                onClick={() => void save()}
                              >
                                <Check size={13} />
                                {saving ? '保存中' : '保存'}
                              </Button>
                              <Button
                                size="sm"
                                disabled={saving}
                                onClick={() => setDraft(null)}
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="subtle"
                                onClick={() => void openDetails(e)}
                              >
                                <Pencil size={13} />
                                编辑
                              </Button>
                              <IconButton
                                title={`删除${e.name || e.email}`}
                                className="danger"
                                onClick={() =>
                                  void allowChange().then((ok) => {
                                    if (ok) onDelete(e)
                                  })
                                }
                              >
                                <Trash2 size={13} />
                              </IconButton>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="library-empty">
                      {loading
                        ? '正在读取编辑…'
                        : '没有匹配的编辑，请调整筛选。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          page={safePage}
          pageCount={pageCount}
          pageSize={pageSize}
          pageSizes={[6, 15, 30, 50]}
          total={filtered.length}
          onPage={(value) =>
            void allowChange().then((ok) => {
              if (ok) setPage(value)
            })
          }
          onPageSize={(value) => void filterChange(() => setPageSize(value))}
        />
        {draft && (
          <p className="library-keyboard-hint">
            Tab 切换字段 · ⌘ / Ctrl + Enter 保存 · Esc 取消
          </p>
        )}
      </div>
      {groupOpen && (
        <Modal
          title="加入编辑组"
          width={480}
          onClose={() => {
            if (!saving) setGroupOpen(false)
          }}
          footer={
            <>
              <Button disabled={saving} onClick={() => setGroupOpen(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={
                  saving ||
                  groupLoading ||
                  (!groupTargets.size && !newGroupName.trim())
                }
                onClick={() => void addToGroups()}
              >
                {saving ? '正在保存…' : '确认加入'}
              </Button>
            </>
          }
        >
          <p className="hint">
            将选中的 {selected.size}{' '}
            位编辑加入以下组。已有成员会保留，不会重复添加。
          </p>
          {groupLoading ? (
            <p>正在读取编辑组…</p>
          ) : (
            <div className="library-group-choices">
              {groups.map((group) => (
                <label key={group.id}>
                  <input
                    type="checkbox"
                    disabled={saving}
                    checked={groupTargets.has(group.id)}
                    onChange={(event) =>
                      setGroupTargets((prev) => {
                        const next = new Set(prev)
                        if (event.target.checked) next.add(group.id)
                        else next.delete(group.id)
                        return next
                      })
                    }
                  />
                  <span>{group.name}</span>
                  <small>{group.editor_ids.length} 位</small>
                </label>
              ))}
            </div>
          )}
          <label className="field">
            也可以新建一个组
            <input
              disabled={saving}
              maxLength={40}
              placeholder="新组名称（选填）"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
            />
          </label>
        </Modal>
      )}
    </section>
  )
}
