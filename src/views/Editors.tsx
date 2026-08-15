import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Plus, RefreshCw, Search, Trash2, Upload, Users } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { useConfirm, useToast } from '../components/feedback'
import { Button, EmptyState, IconButton } from '../components/ui'
import { formatTime, isValidEmail } from '../format'
import { useNav } from '../nav'
import type { Editor, EditorInput } from '../types'
import { GENRES } from './planShared'

const emptyForm: EditorInput = { platform: '', name: '', email: '', directions: [] }

export function EditorsView() {
  const [items, setItems] = useState<Editor[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('')
  const [direction, setDirection] = useState('')
  const [editing, setEditing] = useState<Editor | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<EditorInput>(emptyForm)
  const [customTag, setCustomTag] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const confirm = useConfirm()
  const { go } = useNav()

  const load = async () => {
    setLoading(true)
    try { setItems(await api.listEditors()); setNotice('') }
    catch (e) { setNotice(String(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const platforms = useMemo(
    () => [...new Set(items.map((e) => e.platform.trim()).filter(Boolean))].sort(),
    [items],
  )

  const visible = items.filter((e) => {
    if (platform && e.platform !== platform) return false
    if (direction && !(e.directions ?? []).includes(direction)) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [e.name, e.email, e.platform, ...(e.directions ?? [])].join(' ').toLowerCase().includes(q)
  })

  const openAdd = () => { setEditing(null); setForm(emptyForm); setCustomTag(''); setShowForm(true) }
  const openEdit = (e: Editor) => {
    setEditing(e)
    setForm({ platform: e.platform, name: e.name, email: e.email, directions: e.directions ?? [] })
    setCustomTag('')
    setShowForm(true)
  }

  const toggleDirection = (tag: string) => {
    setForm((f) => ({
      ...f,
      directions: f.directions.includes(tag) ? f.directions.filter((x) => x !== tag) : [...f.directions, tag],
    }))
  }

  const addCustomTag = () => {
    const tag = customTag.trim()
    if (!tag) return
    if (!form.directions.includes(tag)) setForm((f) => ({ ...f, directions: [...f.directions, tag] }))
    setCustomTag('')
  }

  const save = async () => {
    if (!isValidEmail(form.email)) { toast('请填写有效的收稿邮箱', 'warning'); return }
    if (!form.directions.some((d) => d.trim())) { toast('请至少选一个收稿方向', 'warning'); return }
    try {
      if (editing) await api.updateEditor(editing.id, form)
      else await api.addEditor(form)
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
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="按平台筛选">
            <option value="">全部平台</option>
            {platforms.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={direction} onChange={(e) => setDirection(e.target.value)} aria-label="按收稿方向筛选">
            <option value="">全部方向</option>
            {GENRES.map((g) => <option key={g}>{g}</option>)}
          </select>
        </div>
        <div className="toolbar-actions">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" hidden
            onChange={(e) => { void importList(e.target.files?.[0] ?? null); e.target.value = '' }} />
          <Button variant="ghost" onClick={() => fileRef.current?.click()}><Upload size={15} />导入</Button>
          <Button variant="ghost" onClick={() => void exportList()}><Download size={15} />导出 Excel</Button>
          <IconButton title="刷新" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
          <Button variant="primary" onClick={openAdd}><Plus size={16} />添加编辑</Button>
        </div>
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}

      {!loading && !items.length ? (
        <div className="panel">
          <EmptyState icon={Users} title="还没有编辑"
            desc="至少填收稿邮箱和收稿方向，也可以先导入 Excel / CSV。"
            action={
              <div className="toolbar-actions">
                <Button onClick={() => fileRef.current?.click()}><Upload size={16} />导入</Button>
                <Button variant="primary" onClick={openAdd}><Plus size={16} />添加编辑</Button>
              </div>
            } />
        </div>
      ) : (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>编辑</th><th>平台</th><th>收稿方向</th><th>更新</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {visible.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <b>{e.name.trim() || e.email}</b>
                      {e.name.trim() ? <small>{e.email}</small> : null}
                    </td>
                    <td>{e.platform || <span className="hint">未填</span>}</td>
                    <td>
                      <div className="chip-picks compact">
                        {(e.directions ?? []).length
                          ? e.directions.map((d) => <span className="chip on" key={d}>{d}</span>)
                          : <span className="warn-text">未设方向</span>}
                      </div>
                    </td>
                    <td>{formatTime(e.updated_at)}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" onClick={() => openEdit(e)}>编辑</Button>
                        <IconButton title="删除" className="danger" onClick={() => void remove(e.id)}><Trash2 size={15} /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
                {!visible.length && <tr><td colSpan={5} className="empty">{loading ? '读取中…' : '没有符合筛选的编辑'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <p className="after-table-hint">
          表格列是「平台、名称、邮箱、收稿方向」。导入同邮箱会更新资料。准备好后去 <button type="button" className="text-link" onClick={() => go('plans')}>投稿计划</button> 按作品类型筛选。
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
            <div className="field span2">收稿方向（必填）
              <div className="chip-picks">
                {[...new Set([...GENRES, ...form.directions])].map((g) => (
                  <button type="button" key={g} className={`chip ${form.directions.includes(g) ? 'on' : ''}`}
                    onClick={() => toggleDirection(g)}>{g}</button>
                ))}
              </div>
              <div className="editor-custom-tag">
                <input value={customTag} onChange={(e) => setCustomTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag() } }}
                  placeholder="自定义方向，回车添加" />
                <Button size="sm" onClick={addCustomTag}>添加标签</Button>
              </div>
              <span className="field-hint">至少选一个。写计划时会用作品类型和这些标签对上。</span>
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
