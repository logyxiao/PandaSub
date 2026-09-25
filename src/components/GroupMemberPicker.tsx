import { memo, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Heart, Plus, Search, X } from 'lucide-react'
import type { Editor } from '../types'
import { isValidEmail } from '../format'
import { Button } from './ui'
import { EditorTagFilter } from './EditorTagFilter'
import type { EditorTagSelection } from './EditorTags'
import { matchesEditorTags } from '../views/editorLibraryShared'
import { compareEditorsByFavorite, isEditorFavorited, normalizeEditorTags } from '../views/planShared'

const MemberRow = memo(function MemberRow({ editor, chosen }: { editor: Editor; chosen: boolean }) {
  return (
    <li>
      <button type="button" className={`group-member-row ${chosen ? 'is-chosen' : ''}`}
        data-editor-id={editor.id}>
        <span className="group-member-copy">
          <span className="group-member-name">
            {isEditorFavorited(editor) && <Heart size={10} className="editor-star-mark" fill="currentColor" />}
            <b>{editor.name.trim() || '佚名'}</b>
            <span>{editor.platform.trim() || '未填平台'}</span>
          </span>
          <span className="group-member-meta">
            <span className="group-member-email" title={editor.email}>{editor.email}</span>
            <span className="group-member-tags">
              {editor.work_type.slice(0, 2).map((type) => <span key={type}>{type}</span>)}
              {editor.work_type.length > 2 && <span title={editor.work_type.join('、')}>+{editor.work_type.length - 2}</span>}
            </span>
            {!editor.enabled && <span className="group-member-flag">已停用</span>}
            {!isValidEmail(editor.email) && <span className="group-member-flag">邮箱无效</span>}
          </span>
        </span>
        <span className={`group-member-action ${chosen ? 'is-remove' : 'is-add'}`} aria-hidden="true">
          {chosen ? <X size={13} /> : <Plus size={14} />}
        </span>
      </button>
    </li>
  )
})

const PAGE_SIZE = 80

// Bound DOM size on both sides, even after "加入筛选" selects thousands of members.
function MemberList({ editors, chosen, onToggle, empty }: {
  editors: Editor[]
  chosen: boolean
  onToggle: (id: number) => void
  empty: ReactNode
}) {
  const [page, setPage] = useState(0)
  const lastPage = Math.max(0, Math.ceil(editors.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  if (page !== currentPage) setPage(currentPage)
  const start = currentPage * PAGE_SIZE
  return <>
    <div className="group-member-scroll" key={currentPage}>
      <ul className="group-member-rows" onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-editor-id]')
        if (button && event.currentTarget.contains(button)) onToggle(Number(button.dataset.editorId))
      }}>
        {editors.slice(start, start + PAGE_SIZE).map((editor) => <MemberRow key={editor.id} editor={editor} chosen={chosen} />)}
      </ul>
      {!editors.length && empty}
    </div>
    {editors.length > PAGE_SIZE && <div className="group-member-pagination">
      <span>{start + 1}–{Math.min(start + PAGE_SIZE, editors.length)} / {editors.length} 位</span>
      <Button size="sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button>
      <Button size="sm" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>下一页</Button>
    </div>}
  </>
}

/** Search and tag filters apply to both panes without changing membership. */
export function GroupMemberPicker({ editors, selectedIds, onChange, header }: {
  header?: ReactNode
  editors: Editor[]
  selectedIds: ReadonlySet<number>
  onChange: (ids: Set<number>) => void
}) {
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<EditorTagSelection>({ included: [], excluded: [], match: 'any' })
  const [favoritedOnly, setFavoritedOnly] = useState(false)
  // Sorting/search text depend on the library, not on each membership click.
  const normalized = useMemo(() => editors.map(normalizeEditorTags).sort(compareEditorsByFavorite), [editors])
  const searchIndex = useMemo(() => new Map(normalized.map((editor) =>
    [editor.id, `${editor.name} ${editor.platform} ${editor.email}`.toLowerCase()])), [normalized])
  const types = useMemo(() => [...new Set(normalized.flatMap((e) => e.work_type))].sort((a, b) => a.localeCompare(b, 'zh')), [normalized])
  const candidates = useMemo(() => {
    const search = query.trim().toLowerCase()
    return normalized.filter((editor) =>
      (!search || searchIndex.get(editor.id)!.includes(search)) &&
      (!favoritedOnly || isEditorFavorited(editor)))
  }, [normalized, searchIndex, query, favoritedOnly])
  const filtered = useMemo(() => candidates.filter((editor) =>
    matchesEditorTags(editor, tags.included, tags.excluded, tags.match)), [candidates, tags])
  const { available, selectedResults } = useMemo(() => {
    const available: Editor[] = []
    const selectedResults: Editor[] = []
    for (const editor of filtered) (selectedIds.has(editor.id) ? selectedResults : available).push(editor)
    return { available, selectedResults }
  }, [filtered, selectedIds])
  const selectedCount = useMemo(() => normalized.reduce((count, editor) => count + Number(selectedIds.has(editor.id)), 0), [normalized, selectedIds])
  const filterKey = JSON.stringify([query, favoritedOnly, tags])
  const add = (items: Editor[]) => onChange(new Set([...selectedIds, ...items.map((e) => e.id)]))
  const remove = (id: number) => {
    const next = new Set(selectedIds)
    next.delete(id)
    onChange(next)
  }
  const empty = (chosen: boolean) => (
    <div className="group-member-empty">
      <b>{chosen && !selectedCount ? '从左边点选加入' : '没有匹配的编辑'}</b>
      <span>{chosen && !selectedCount ? '点整行即可添加' : '换个关键词或类型试试'}</span>
    </div>
  )
  return (
    <div className="group-member-workspace">
      <div className="group-member-topbar">
        {header}
        <label className="group-member-search group-member-shared-search">
          <Search size={13} />
          <input aria-label="搜索两边名单" placeholder="搜索姓名、平台或邮箱（两边共用）"
            value={query} onChange={(event) => { setQuery(event.target.value) }} />
        </label>
      </div>
      <div className="group-member-filters">
        <button type="button" className={`field-chip editor-fav-filter ${favoritedOnly ? 'on' : ''}`}
          aria-pressed={favoritedOnly} onClick={() => { setFavoritedOnly((value) => !value) }}>
          <Heart size={11} fill={favoritedOnly ? 'currentColor' : 'none'} />收藏
        </button>
        <EditorTagFilter candidates={candidates} tags={types} value={tags} onChange={setTags} />
      </div>
      <div className="group-member-panes">
        <section className="group-member-pane" aria-label="待选编辑">
          <header className="group-member-heading">
            <h3>待选 <small>{available.length}</small></h3>
            <Button size="sm" disabled={!available.length} onClick={() => add(available)}
              title={`加入全部 ${available.length} 条筛选结果`}>
              加入筛选 <ArrowRight size={12} />
            </Button>
          </header>
          <MemberList key={`available-${filterKey}`} editors={available} chosen={false}
            onToggle={(id) => onChange(new Set([...selectedIds, id]))} empty={empty(false)} />
        </section>
        <section className="group-member-pane is-selected" aria-label="已选成员">
          <header className="group-member-heading">
            <h3>已选 <small>{selectedCount}</small></h3>
            <Button size="sm" disabled={!selectedCount} onClick={() => onChange(new Set())}>清空</Button>
          </header>
          <MemberList key={`selected-${filterKey}`} editors={selectedResults} chosen
            onToggle={remove} empty={empty(true)} />
        </section>
      </div>
    </div>
  )
}
