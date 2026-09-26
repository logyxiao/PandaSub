import { useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { Editor } from '../types'
import { matchesEditorTags } from '../views/editorLibraryShared'
import { Button } from './ui'
import {
  EditorTagDialog,
  SelectedEditorTags,
  TagMatchSwitch,
  type EditorTagSelection,
} from './EditorTags'

/** Shared tag filtering for the editor library, member pickers and submission plans. */
export function EditorTagFilter({
  candidates,
  tags,
  value,
  onChange,
  beforeChange,
  previewCount: customPreviewCount,
  allowMatchModeChange = true,
}: {
  candidates: readonly Pick<Editor, 'work_type'>[]
  tags: readonly string[]
  value: EditorTagSelection
  onChange: (value: EditorTagSelection) => void
  beforeChange?: () => boolean | Promise<boolean>
  /** Domain-specific matching, e.g. submission length and rejection rules. */
  previewCount?: (value: EditorTagSelection) => number
  allowMatchModeChange?: boolean
}) {
  const [open, setOpen] = useState(false)
  const options = useMemo(() => {
    const counts = new Map<string, number>()
    candidates.forEach((editor) =>
      new Set(editor.work_type).forEach((tag) =>
        counts.set(tag, (counts.get(tag) ?? 0) + 1),
      ),
    )
    return [...new Set([...tags, ...counts.keys()])]
      .map((label) => ({ label, count: counts.get(label) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'))
  }, [candidates, tags])
  const previewCount = customPreviewCount ?? ((selection: EditorTagSelection) =>
    candidates.filter((editor) =>
      matchesEditorTags(
        editor,
        selection.included,
        selection.excluded,
        selection.match,
      ),
    ).length)
  const change = async (next: EditorTagSelection) => {
    if (beforeChange && !(await beforeChange())) return
    onChange(next)
    setOpen(false)
  }
  const toggle = (tag: string, exclude = false) => {
    const field = exclude ? 'excluded' : 'included'
    const other = exclude ? 'included' : 'excluded'
    void change({
      ...value,
      [field]: value[field].includes(tag)
        ? value[field].filter((item) => item !== tag)
        : [...value[field], tag],
      [other]: value[other].filter((item) => item !== tag),
    })
  }
  return (
    <div className="library-tag-filter">
      <div className="library-quick-tags">
        <span className="library-filter-label">常用标签</span>
        <div className="library-tags">
          {options
            .filter((tag) => tag.count > 0)
            .slice(0, 8)
            .map(({ label, count }) => (
              <button
                type="button"
                key={label}
                className={`chip ${value.included.includes(label) ? 'on' : ''}`}
                aria-label={`筛选标签${label}`}
                title={`${count} 位编辑使用该标签`}
                aria-pressed={value.included.includes(label)}
                onClick={() => toggle(label)}
              >
                <span>{label}</span>
                <small>{count}</small>
                {value.included.includes(label) && <Check size={12} />}
              </button>
            ))}
          <Button
            size="sm"
            aria-label="选择筛选标签"
            onClick={async () => {
              if (!beforeChange || (await beforeChange())) setOpen(true)
            }}
          >
            <Search size={13} />
            选择标签
          </Button>
        </div>
      </div>
      {Boolean(value.included.length || value.excluded.length) && (
        <div className="library-active-tags">
          <div className="library-active-tags-head">
            <span>当前筛选 · {previewCount(value)} 位编辑</span>
            {allowMatchModeChange && value.included.length > 1 && (
              <TagMatchSwitch
                value={value.match}
                onChange={(match) => void change({ ...value, match })}
              />
            )}
            <Button
              size="sm"
              variant="subtle"
              onClick={() =>
                void change({ ...value, included: [], excluded: [] })
              }
            >
              清空标签
            </Button>
          </div>
          <div className="selected-editor-tags">
            <SelectedEditorTags
              values={value.included}
              onRemove={(tag) => toggle(tag)}
            />
            <SelectedEditorTags
              values={value.excluded}
              excluded
              onRemove={(tag) => toggle(tag, true)}
            />
          </div>
        </div>
      )}
      {open && (
        <EditorTagDialog
          title="筛选收稿标签"
          filtering
          allowMatchModeChange={allowMatchModeChange}
          options={options}
          selection={value}
          previewCount={previewCount}
          onClose={() => setOpen(false)}
          onApply={(next) => void change(next)}
        />
      )}
    </div>
  )
}
