import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Plus, Search, X } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './ui'
import {
  splitEditorTags,
  type TagMatchMode,
} from '../views/editorLibraryShared'

export interface EditorTagOption {
  label: string
  count?: number
}
export interface EditorTagSelection {
  included: string[]
  excluded: string[]
  match: TagMatchMode
}

export function TagMatchSwitch({
  value,
  onChange,
}: {
  value: TagMatchMode
  onChange: (value: TagMatchMode) => void
}) {
  return (
    <div className="tag-match-switch" role="group" aria-label="标签匹配方式">
      <button
        type="button"
        aria-pressed={value === 'any'}
        onClick={() => onChange('any')}
      >
        任一标签
      </button>
      <button
        type="button"
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >
        全部标签
      </button>
    </div>
  )
}

export function SelectedEditorTags({
  values,
  excluded = false,
  onRemove,
  disabled = false,
}: {
  values: readonly string[]
  excluded?: boolean
  onRemove: (tag: string) => void
  disabled?: boolean
}) {
  return (
    <>
      {values.map((tag) => (
        <span
          className={`selected-editor-tag ${excluded ? 'is-excluded' : ''}`}
          key={tag}
        >
          <span title={tag}>
            {excluded ? '排除：' : ''}
            {tag}
          </span>
          <button
            type="button"
            disabled={disabled}
            aria-label={`${excluded ? '取消排除' : '移除标签'}${tag}`}
            onClick={() => onRemove(tag)}
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </>
  )
}

export function EditorTagDialog({
  title,
  options,
  selection,
  filtering = false,
  allowMatchModeChange = true,
  previewCount,
  onApply,
  onClose,
}: {
  title: string
  options: readonly EditorTagOption[]
  selection: EditorTagSelection
  filtering?: boolean
  allowMatchModeChange?: boolean
  previewCount?: (value: EditorTagSelection) => number
  onApply: (value: EditorTagSelection) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<EditorTagSelection>(() => ({
    included: [...selection.included],
    excluded: [...selection.excluded],
    match: selection.match,
  }))
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    search.current?.focus()
  }, [])
  const allOptions = [
    ...new Set([
      ...options.map((option) => option.label),
      ...draft.included,
      ...draft.excluded,
    ]),
  ]
  const visible = allOptions.filter((tag) =>
    tag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  const toggle = (tag: string, exclude = false) =>
    setDraft((value) =>
      exclude
        ? {
            ...value,
            included: value.included.filter((item) => item !== tag),
            excluded: value.excluded.includes(tag)
              ? value.excluded.filter((item) => item !== tag)
              : [...value.excluded, tag],
          }
        : {
            ...value,
            excluded: value.excluded.filter((item) => item !== tag),
            included: value.included.includes(tag)
              ? value.included.filter((item) => item !== tag)
              : [...value.included, tag],
          },
    )
  const pendingTags = splitEditorTags(query)
  const canAdd =
    !filtering && pendingTags.some((tag) => !draft.included.includes(tag))
  const addQuery = () => {
    if (!pendingTags.length || filtering) return
    setDraft((value) => ({
      ...value,
      included: [...new Set([...value.included, ...pendingTags])],
      excluded: value.excluded.filter((tag) => !pendingTags.includes(tag)),
    }))
    setQuery('')
    search.current?.focus()
  }
  const apply = () => onApply(draft)
  return createPortal(
    <div
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          event.stopPropagation()
          return
        }
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          event.stopPropagation()
          apply()
        }
      }}
    >
      <Modal
        title={title}
        width={640}
        className="editor-tag-dialog"
        onClose={onClose}
        footer={
          <>
            <span className="tag-dialog-result">
              {filtering
                ? `匹配 ${previewCount?.(draft) ?? 0} 位编辑`
                : `已选 ${draft.included.length} 个标签`}
            </span>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={apply}>
              {filtering ? '应用筛选' : '确定标签'}
            </Button>
          </>
        }
      >
        <p className="tag-dialog-help">
          {filtering
            ? '勾选要包含的标签，或点击右侧“排除”。可以同时选择多个。'
            : '点选已有类型，或输入新类型后按回车。多个类型可用逗号、顿号分隔。'}
        </p>
        <label className="tag-dialog-search">
          <Search size={16} />
          <input
            ref={search}
            value={query}
            aria-label={filtering ? '搜索筛选标签' : '搜索或新增标签'}
            placeholder={filtering ? '输入标签名称' : '搜索或输入新类型'}
            onChange={(event) => setQuery(event.target.value)}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text')
              if (filtering || !/[，,、;；\n]/.test(text)) return
              event.preventDefault()
              const tags = splitEditorTags(text)
              setDraft((value) => ({
                ...value,
                included: [...new Set([...value.included, ...tags])],
                excluded: value.excluded.filter((tag) => !tags.includes(tag)),
              }))
              setQuery('')
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                !event.ctrlKey &&
                !event.metaKey &&
                !filtering
              ) {
                event.preventDefault()
                event.stopPropagation()
                addQuery()
              }
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="清空标签搜索"
              onClick={() => {
                setQuery('')
                search.current?.focus()
              }}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="tag-dialog-selected">
          <div className="tag-dialog-selected-head">
            <b>
              {filtering ? '当前条件' : '已选类型'}{' '}
              <small>{draft.included.length + draft.excluded.length}</small>
            </b>
            {(draft.included.length > 0 || draft.excluded.length > 0) && (
              <Button
                size="sm"
                variant="subtle"
                onClick={() =>
                  setDraft((value) => ({
                    ...value,
                    included: [],
                    excluded: [],
                  }))
                }
              >
                清空选择
              </Button>
            )}
          </div>
          <div className="selected-editor-tags">
            <SelectedEditorTags
              values={draft.included}
              onRemove={(tag) => toggle(tag)}
            />
            <SelectedEditorTags
              values={draft.excluded}
              excluded
              onRemove={(tag) => toggle(tag, true)}
            />
            {!draft.included.length && !draft.excluded.length && (
              <span className="hint">
                {filtering ? '不限制收稿标签' : '尚未选择类型'}
              </span>
            )}
          </div>
          {filtering && allowMatchModeChange && draft.included.length > 1 && (
            <div className="tag-dialog-match">
              <span>包含条件</span>
              <TagMatchSwitch
                value={draft.match}
                onChange={(match) => setDraft((value) => ({ ...value, match }))}
              />
            </div>
          )}
        </div>
        <div className="tag-dialog-options-head">
          <span>{query.trim() ? '搜索结果' : '可选标签'}</span>
          <small>
            {filtering ? '右侧数字为当前列表中使用该标签的编辑数' : '可多选'}
          </small>
        </div>
        <div className="tag-dialog-options">
          <div className="tag-dialog-option-grid">
            {visible.map((tag) => (
              <div
                className={`tag-dialog-option ${draft.included.includes(tag) ? 'is-included' : ''} ${draft.excluded.includes(tag) ? 'is-excluded' : ''}`}
                key={tag}
              >
                <label>
                  <input
                    type="checkbox"
                    aria-label={`选择标签${tag}`}
                    checked={draft.included.includes(tag)}
                    onChange={() => toggle(tag)}
                  />
                  <span title={tag}>{tag}</span>
                </label>
                {filtering && (
                  <>
                    <small>
                      {options.find((option) => option.label === tag)?.count ??
                        0}
                    </small>
                    <button
                      type="button"
                      aria-label={`排除标签${tag}`}
                      aria-pressed={draft.excluded.includes(tag)}
                      onClick={() => toggle(tag, true)}
                    >
                      {draft.excluded.includes(tag) ? (
                        <>
                          <Check size={12} />
                          已排除
                        </>
                      ) : (
                        '排除'
                      )}
                    </button>
                  </>
                )}
              </div>
            ))}
            {!visible.length && (
              <p className="tag-dialog-empty">
                {filtering
                  ? '没有匹配的标签，换个关键词试试。'
                  : '未找到已有类型，可以添加为新标签。'}
              </p>
            )}
          </div>
        </div>
        {canAdd && (
          <Button className="tag-dialog-create" onClick={addQuery}>
            <Plus size={14} />
            {pendingTags.length > 1
              ? `添加这 ${pendingTags.length} 个类型`
              : `添加「${pendingTags[0]}」`}
          </Button>
        )}
      </Modal>
    </div>,
    document.body,
  )
}

export function EditorTagField({
  label,
  values,
  options,
  onChange,
  disabled = false,
  excluded = false,
  focusKey,
}: {
  label: string
  values: readonly string[]
  options: readonly string[]
  onChange: (value: string[]) => void
  disabled?: boolean
  excluded?: boolean
  focusKey?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="editor-tag-field">
      <div className="selected-editor-tags">
        <SelectedEditorTags
          values={values}
          excluded={excluded}
          disabled={disabled}
          onRemove={(tag) => onChange(values.filter((value) => value !== tag))}
        />
        {!values.length && <span className="hint">尚未选择</span>}
      </div>
      <Button
        size="sm"
        data-quick-field={focusKey}
        disabled={disabled}
        aria-label={`选择${label}`}
        onClick={() => setOpen(true)}
      >
        <Plus size={13} />
        选择 / 添加
      </Button>
      {open && (
        <EditorTagDialog
          title={`选择${label}`}
          options={[...new Set([...options, ...values])].map((label) => ({
            label,
          }))}
          selection={{ included: [...values], excluded: [], match: 'any' }}
          onClose={() => setOpen(false)}
          onApply={(value) => {
            onChange(value.included)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}
