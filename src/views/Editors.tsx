import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Plus, RefreshCw, Search, Trash2, Upload, Users } from 'lucide-react'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Button, EmptyState, IconButton, PagedList, Select } from '../components/ui'
import { formatTime, isValidEmail } from '../format'
import { useNav } from '../nav'
import type { Editor, EditorInput } from '../types'
import { GENRES, STYLES, isPlanStyle, normalizeEditorTags } from './planShared'

const UNASSIGNED = '未填平台'
const emptyForm: EditorInput = { platform: '', name: '', email: '', style: [], work_type: [] }

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
  onPlatformsChange?: (platforms: string[]) => void
  pageSize?: number
  emptyText?: string
  emptyAction?: ReactNode
}

/** 编辑库列表（搜索、平台/风格/作品类型筛选、分页、标签气泡），可作为页面或插件式嵌入投稿向导。 */
export function EditorsList({
  items: externalItems, reloadSignal = 0, selectable = false,
  selectedIds, onToggleSelect, onEdit, onDelete, onTotalChange, onPlatformsChange, pageSize,
  emptyText = '至少填收稿邮箱、风格或作品类型，也可以先导入 Excel / CSV。',
  emptyAction,
}: EditorsListProps) {
  const [items, setItems] = useState<Editor[]>([])
  const [loading, setLoading] = useState(!externalItems)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('')
  const [style, setStyle] = useState('')
  const [workType, setWorkType] = useState('')
  const [more, setMore] = useState<{ id: number; anchor: HTMLButtonElement } | null>(null)

  const list = useMemo(() => (externalItems ?? items).map(normalizeEditorTags), [externalItems, items])

  const load = async () => {
    setLoading(true)
    try { setItems((await api.listEditors()).map(normalizeEditorTags)); setNotice('') }
    catch (e) { setNotice(String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (!externalItems) void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!externalItems && reloadSignal > 0) void load() }, [externalItems, reloadSignal])
  useEffect(() => { onTotalChange?.(list.length) }, [list.length, onTotalChange])

  const platforms = useMemo(
    () => [...new Set(list.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [list],
  )
  useEffect(() => { onPlatformsChange?.(platforms) }, [platforms, onPlatformsChange])

  const basePool = useMemo(() => list.filter((e) => {
    if (platform && e.platform !== platform) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [e.name, e.email, e.platform, ...(e.style ?? []), ...(e.work_type ?? [])].join(' ').toLowerCase().includes(q)
  }), [list, platform, query])

  const styleCounts = useMemo(
    () => STYLES.map((tag) => [tag, basePool.filter((e) => (e.style ?? []).includes(tag)).length] as const),
    [basePool],
  )

  const workTypeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of basePool) for (const d of e.work_type ?? []) map.set(d, (map.get(d) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [basePool])

  const visible = useMemo(() => basePool.filter((e) => {
    if (style && !(e.style ?? []).includes(style)) return false
    if (workType && !(e.work_type ?? []).includes(workType)) return false
    return true
  }), [basePool, style, workType])

  // 筛选变化时收起展开中的标签气泡
  useEffect(() => { setMore(null) }, [visible])

  return (
    <>
      <div className="filters">
        <label className="plan-search editor-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名、平台或邮箱" />
        </label>
        <Select value={platform} onChange={setPlatform} ariaLabel="按平台筛选" className="editor-filter-select"
          options={[{ value: '', label: '全部平台' }, ...platforms.map((p) => ({ value: p, label: p }))]} />
        <Select value={style} onChange={setStyle} ariaLabel="按风格筛选" className="editor-filter-select"
          options={[{ value: '', label: '全部风格' }, ...styleCounts.map(([tag, count]) => ({ value: tag, label: `${tag}（${count}）` }))]} />
      </div>
      <div className="worktype-filter-bar">
        <span>作品类型</span>
        {workTypeCounts.length ? (
          <div className="field-filter-chips">
            {workTypeCounts.map(([tag, count]) => (
              <button type="button" key={tag} className={`field-chip ${workType === tag ? 'on' : ''}`}
                onClick={() => setWorkType(workType === tag ? '' : tag)}>
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
            listClassName="editor-groups"
            renderItem={(e) => {
              const styles = e.style ?? []
              const workTypes = e.work_type ?? []
              const tags = [...styles, ...workTypes]
              const shown = tags.slice(0, 2)
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
                  <div className="editor-row-main">
                    <b>{e.name.trim() || '佚名'}</b>
                    <small>{e.email}</small>
                  </div>
                  <div className="editor-row-platform">{e.platform.trim() || UNASSIGNED}</div>
                  <div className="editor-row-time" title={e.updated_at}>录入 {formatTime(e.updated_at)}</div>
                  <div className="editor-row-tags">
                    {tags.length ? (
                      <>
                        {shown.map((d, i) => (
                          <span key={d} className={`chip on ${i >= styles.length ? 'tone' : ''}`}>{d}</span>
                        ))}
                        {tags.length > shown.length && (
                          <button type="button" className="editor-chip-more"
                            onClick={(ev) => setMore((m) => (m?.id === e.id ? null : { id: e.id, anchor: ev.currentTarget }))}>
                            +{tags.length - shown.length}
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="hint">未设标签</span>
                    )}
                  </div>
                  <div className="row-actions">
                    {onEdit && <Button size="sm" onClick={() => onEdit(e)}>编辑</Button>}
                    {onDelete && <IconButton title="删除" className="danger" onClick={() => onDelete(e)}><Trash2 size={15} /></IconButton>}
                  </div>
                  {more?.id === e.id && (
                    <EditorTagsPop anchor={more.anchor} styles={styles} workTypes={workTypes} skip={shown.length} onClose={() => setMore(null)} />
                  )}
                </div>
              )
            }}
            empty={!visible.length && (
              <p className="editor-groups-empty">{loading ? '读取中…' : '没有符合筛选的编辑'}</p>
            )}
          />
        </div>
      )}
    </>
  )
}

export function EditorsView() {
  const [reloadSignal, setReloadSignal] = useState(0)
  const [total, setTotal] = useState(0)
  const [platformOptions, setPlatformOptions] = useState<string[]>([])
  const [editing, setEditing] = useState<Editor | null>(null)
  const [showForm, setShowForm] = useState(false)
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
    setForm({ platform: next.platform, name: next.name, email: next.email, style: next.style, work_type: next.work_type })
    setCustomWorkType('')
    setShowForm(true)
  }

  const toggleTag = (field: 'style' | 'work_type', tag: string) => {
    setForm((f) => ({
      ...f,
      [field]: f[field].includes(tag) ? f[field].filter((x) => x !== tag) : [...f[field], tag],
    }))
  }

  const addCustomWorkType = () => {
    const tag = customWorkType.trim()
    if (!tag || isPlanStyle(tag)) return
    if (!form.work_type.includes(tag)) setForm((f) => ({ ...f, work_type: [...f.work_type, tag] }))
    setCustomWorkType('')
  }

  const save = async () => {
    if (!isValidEmail(form.email)) { toast('请填写有效的收稿邮箱', 'warning'); return }
    const payload = normalizeEditorTags(form)
    if (!payload.style.some((d) => d.trim()) && !payload.work_type.some((d) => d.trim())) {
      toast('请至少填一个风格或作品类型', 'warning')
      return
    }
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

  const remove = async (id: number) => {
    const ok = await confirm({ title: '删除编辑', message: '从编辑库里去掉，已经写进计划的收件人不会自动删除。', confirmLabel: '删除', tone: 'danger' })
    if (!ok) return
    try { await api.deleteEditor(id); refresh(); toast('编辑已删除', 'success') } catch (e) { toast(String(e), 'error') }
  }

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-actions">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" hidden
            onChange={(e) => { void importList(e.target.files?.[0] ?? null); e.target.value = '' }} />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}><Upload size={15} />导入</Button>
          <Button variant="ghost" onClick={() => void exportList()}><Download size={15} />导出 Excel</Button>
          <IconButton title="刷新" onClick={refresh}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" onClick={openAdd}><Plus size={16} />添加编辑</Button>
        </div>
      </div>

      <EditorsList
        reloadSignal={reloadSignal}
        onEdit={openEdit}
        onDelete={(e) => void remove(e.id)}
        onTotalChange={setTotal}
        onPlatformsChange={setPlatformOptions}
        emptyAction={
          <div className="toolbar-actions">
            <Button onClick={() => fileRef.current?.click()}><Upload size={16} />导入</Button>
            <Button variant="primary" onClick={openAdd}><Plus size={16} />添加编辑</Button>
          </div>
        }
      />

      {total > 0 && (
        <p className="after-table-hint">
          导入同邮箱会更新资料。准备好后去 <button type="button" className="text-link" onClick={() => go('plans')}>投稿计划</button> 按风格、作品类型筛编辑。
        </p>
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
            <div className="field span2">风格
              <Select
                value={form.style[0] ?? ''}
                options={[{ value: '', label: '不设风格' }, ...STYLES.map((s) => ({ value: s, label: s }))]}
                onChange={(v) => setForm({ ...form, style: v ? [v] : [] })}
                ariaLabel="风格"
                placeholder="不设风格"
              />
            </div>
            <div className="field span2">作品类型
              <div className="chip-picks">
                {[...new Set([...GENRES, ...form.work_type.filter((tag) => !isPlanStyle(tag))])].map((g) => (
                  <button type="button" key={g} className={`chip ${form.work_type.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleTag('work_type', g)}>{g}</button>
                ))}
              </div>
              <div className="editor-custom-tag">
                <input value={customWorkType} onChange={(e) => setCustomWorkType(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomWorkType() } }}
                  placeholder="自定义作品类型，回车添加" />
                <Button size="sm" onClick={addCustomWorkType}>添加</Button>
              </div>
              <span className="field-hint">至少填一项。写计划时会用作品的风格和作品类型对上。</span>
            </div>
          </div>
          <datalist id="editor-platforms">
            {platformOptions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </Modal>
      )}
    </>
  )
}

// 「+N」标签气泡：只展示行内未显示的标签；跟随按钮定位，超出视口时向上弹开，滚动/缩放跟随。
function EditorTagsPop({ anchor, styles, workTypes, skip, onClose }: {
  anchor: HTMLButtonElement
  styles: string[]
  workTypes: string[]
  skip: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<CSSProperties>()
  // onClose 每次渲染都是新引用，放进 effect 依赖会造成 setPos 死循环导致白屏，用 ref 固定。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const skipStyles = Math.min(skip, styles.length)
  const restStyles = styles.slice(skipStyles)
  const restWorkTypes = workTypes.slice(skip - skipStyles)

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.isConnected) { onCloseRef.current(); return }
      const rect = anchor.getBoundingClientRect()
      const gap = 7
      const width = Math.min(300, Math.max(170, rect.width))
      const estimate = 16 + Math.ceil((restStyles.length + restWorkTypes.length) / 3) * 30
      const spaceBelow = window.innerHeight - rect.bottom - gap
      const spaceAbove = rect.top - gap
      const up = spaceBelow < estimate && spaceAbove > spaceBelow
      let left = Math.min(rect.right - width, window.innerWidth - width - 12)
      if (left < 12) left = 12
      setPos(up
        ? { top: 'auto', bottom: window.innerHeight - rect.top + gap, left, width }
        : { top: rect.bottom + gap, bottom: 'auto', left, width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, restStyles.length, restWorkTypes.length])

  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node
      if (ref.current?.contains(target) || anchor.contains(target)) return
      onCloseRef.current()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor])

  return createPortal(
    <div ref={ref} className="editor-more-pop" style={pos} role="tooltip">
      <div className="editor-more-tags">
        {restStyles.map((d) => <span className="chip on" key={d}>{d}</span>)}
        {!!restStyles.length && !!restWorkTypes.length && <i className="editor-tag-divider" />}
        {restWorkTypes.map((d) => <span className="chip on tone" key={d}>{d}</span>)}
      </div>
    </div>,
    document.body,
  )
}
