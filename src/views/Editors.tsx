import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Plus, RefreshCw, Search, Trash2, Upload, Users } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Badge, Button, EmptyState, IconButton, Select } from '../components/ui'
import { isValidEmail } from '../format'
import { useNav } from '../nav'
import type { Editor, EditorInput } from '../types'
import { GENRES, STYLES, isPlanStyle, normalizeEditorTags } from './planShared'

const UNASSIGNED = '未填平台'
const emptyForm: EditorInput = { platform: '', name: '', email: '', style: [], work_type: [] }

export function EditorsView() {
  const [items, setItems] = useState<Editor[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('')
  const [style, setStyle] = useState('')
  const [workType, setWorkType] = useState('')
  const [status, setStatus] = useState<'all' | 'on' | 'off'>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Editor | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<EditorInput>(emptyForm)
  const [customWorkType, setCustomWorkType] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = async () => {
    setLoading(true)
    try { setItems((await api.listEditors()).map(normalizeEditorTags)); setNotice('') }
    catch (e) { setNotice(String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const platforms = useMemo(
    () => [...new Set(items.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [items],
  )

  const basePool = useMemo(() => items.filter((e) => {
    if (status === 'on' && e.enabled === false) return false
    if (status === 'off' && e.enabled !== false) return false
    if (platform && e.platform !== platform) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [e.name, e.email, e.platform, ...(e.style ?? []), ...(e.work_type ?? [])].join(' ').toLowerCase().includes(q)
  }), [items, status, platform, query])

  const styleCounts = useMemo(
    () => STYLES.map((tag) => [tag, basePool.filter((e) => (e.style ?? []).includes(tag)).length] as const),
    [basePool],
  )

  const workTypeCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of basePool) for (const d of e.work_type ?? []) map.set(d, (map.get(d) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [basePool])

  const visible = basePool.filter((e) => {
    if (style && !(e.style ?? []).includes(style)) return false
    if (workType && !(e.work_type ?? []).includes(workType)) return false
    return true
  })

  const grouped = useMemo(() => {
    const map = new Map<string, Editor[]>()
    for (const e of visible) {
      const key = e.platform.trim() || UNASSIGNED
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === UNASSIGNED) return 1
      if (b[0] === UNASSIGNED) return -1
      return b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh')
    })
  }, [visible])

  const allExpanded = collapsed.size === 0
  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleAll = () => {
    setCollapsed(allExpanded ? new Set(grouped.map(([key]) => key)) : new Set())
  }

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
      await load()
      toast(editing ? '编辑已保存' : '编辑已加入', 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const exportList = async () => {
    try {
      const path = await api.exportEditors()
      toast(`已导出到 ${path}`, 'success')
    } catch (e) { toast(String(e), 'error') }
  }

  const importList = async (file: File | null) => {
    if (!file) return
    try {
      const data = Array.from(new Uint8Array(await file.arrayBuffer()))
      const result = await api.importEditors(data, file.name)
      await load()
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

  const toggle = async (e: Editor) => {
    try {
      await api.toggleEditor(e.id, e.enabled === false)
      await load()
      toast(e.enabled === false ? '已启动' : '已暂停', 'success')
    } catch (err) { toast(String(err), 'error') }
  }

  const remove = async (id: number) => {
    const ok = await confirm({ title: '删除编辑', message: '从编辑库里去掉，已经写进计划的收件人不会自动删除。', confirmLabel: '删除', tone: 'danger' })
    if (!ok) return
    try { await api.deleteEditor(id); await load(); toast('编辑已删除', 'success') } catch (e) { toast(String(e), 'error') }
  }

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <label className="plan-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名、平台或邮箱" />
          </label>
          <Select value={platform} onChange={setPlatform} ariaLabel="按平台筛选" className="filter-select"
            options={[{ value: '', label: '全部平台' }, ...platforms.map((p) => ({ value: p, label: p }))]} />
          <Select value={status} onChange={setStatus} ariaLabel="按状态筛选" className="filter-select"
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'on', label: '使用中' },
              { value: 'off', label: '已暂停' },
            ]} />
        </div>
        <div className="toolbar-actions">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" hidden
            onChange={(e) => { void importList(e.target.files?.[0] ?? null); e.target.value = '' }} />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}><Upload size={15} />导入</Button>
          <Button variant="ghost" onClick={() => void exportList()}><Download size={15} />导出 Excel</Button>
          <Button variant="ghost" onClick={toggleAll}>{allExpanded ? '全部收起' : '全部展开'}</Button>
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" onClick={openAdd}><Plus size={16} />添加编辑</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !items.length ? (
        <div className="panel">
          <EmptyState icon={Users} title="还没有编辑"
            desc="至少填收稿邮箱、风格或作品类型，也可以先导入 Excel / CSV。"
            action={
              <div className="toolbar-actions">
                <Button onClick={() => fileRef.current?.click()}><Upload size={16} />导入</Button>
                <Button variant="primary" onClick={openAdd}><Plus size={16} />添加编辑</Button>
              </div>
            } />
        </div>
      ) : (
        <>
          <div className="field-filter-bar">
            <span className="field-filter-label">风格</span>
            <div className="field-filter-chips">
              <button type="button" className={`field-chip ${!style ? 'on' : ''}`} onClick={() => setStyle('')}>全部</button>
              {styleCounts.map(([tag, count]) => (
                <button type="button" key={tag} className={`field-chip ${style === tag ? 'on' : ''}`}
                  onClick={() => setStyle(style === tag ? '' : tag)}>
                  {tag}<small>{count}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="field-filter-bar">
            <span className="field-filter-label">作品类型</span>
            <div className="field-filter-chips">
              <button type="button" className={`field-chip ${!workType ? 'on' : ''}`} onClick={() => setWorkType('')}>全部</button>
              {workTypeCounts.map(([tag, count]) => (
                <button type="button" key={tag} className={`field-chip ${workType === tag ? 'on' : ''}`}
                  onClick={() => setWorkType(workType === tag ? '' : tag)}>
                  {tag}<small>{count}</small>
                </button>
              ))}
              {!workTypeCounts.length && <span className="field-filter-empty">暂无数据，编辑时可补填作品类型</span>}
            </div>
          </div>
          <div className="editors-summary" aria-label="编辑库概览">
            <span><b>{grouped.length}</b> 个平台</span>
            <span><b>{visible.length}</b> 位编辑</span>
            <span><b>{visible.filter((e) => e.enabled !== false).length}</b> 使用中</span>
            <span><b>{visible.filter((e) => e.enabled === false).length}</b> 已暂停</span>
          </div>
          <div className="panel">
            <div className="editor-groups">
              {grouped.map(([key, editors]) => {
                const isCollapsed = collapsed.has(key)
                const active = editors.filter((e) => e.enabled !== false).length
                return (
                  <section className="editor-group" key={key}>
                    <header className="editor-group-head" role="button" tabIndex={0}
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleGroup(key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(key) } }}>
                      {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                      <b>{key}</b>
                      <span className="editor-group-count">{editors.length} 位 · {active} 使用中</span>
                    </header>
                    {!isCollapsed && (
                      <div className="editor-group-body">
                        {editors.map((e) => (
                          <div className={`editor-row ${e.enabled === false ? 'dim' : ''}`} key={e.id}>
                            <div className="editor-row-main">
                              <b>{e.name.trim() || e.email}</b>
                              {e.name.trim() ? <small>{e.email}</small> : null}
                            </div>
                            <div className="editor-row-tags">
                              {(e.style ?? []).length
                                ? e.style.map((d) => <span className="chip on" key={d}>{d}</span>)
                                : <span className="hint">未设风格</span>}
                              {(e.work_type ?? []).length > 0 && <i className="editor-tag-divider" />}
                              {(e.work_type ?? []).length
                                ? e.work_type.map((d) => <span className="chip on tone" key={d}>{d}</span>)
                                : null}
                            </div>
                            <Badge tone={e.enabled === false ? 'warning' : 'success'} dot>
                              {e.enabled === false ? '已暂停' : '使用中'}
                            </Badge>
                            <div className="row-actions">
                              {e.enabled === false
                                ? <Button size="sm" variant="primary" onClick={() => void toggle(e)}>启动</Button>
                                : <Button size="sm" onClick={() => void toggle(e)}>暂停</Button>}
                              <Button size="sm" onClick={() => openEdit(e)}>编辑</Button>
                              <IconButton title="删除" className="danger" onClick={() => void remove(e.id)}><Trash2 size={15} /></IconButton>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
              {!visible.length && (
                <p className="editor-groups-empty">{loading ? '读取中…' : '没有符合筛选的编辑'}</p>
              )}
            </div>
          </div>
        </>
      )}

      {items.length > 0 && (
        <p className="after-table-hint">
          暂停后的编辑不会出现在新建计划的筛选里。导入同邮箱会更新资料。准备好后去 <button type="button" className="text-link" onClick={() => go('plans')}>投稿计划</button> 按风格、作品类型筛编辑。
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
              <div className="chip-picks">
                {STYLES.map((g) => (
                  <button type="button" key={g} className={`chip ${form.style.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleTag('style', g)}>{g}</button>
                ))}
              </div>
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
            {platforms.map((p) => <option key={p} value={p} />)}
          </datalist>
        </Modal>
      )}
    </>
  )
}
