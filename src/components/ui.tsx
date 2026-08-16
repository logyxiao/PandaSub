import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Tone } from '../format'
import type { TaskStatus } from '../types'

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle'
type ButtonSize = 'md' | 'sm'

export function Button({ variant = 'ghost', size = 'md', className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={`btn btn-${variant} btn-${size} ${className}`.trim()} {...rest}>{children}</button>
}

export function IconButton({ title, className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return <button className={`icon-button ${className}`.trim()} title={title} aria-label={title} {...rest}>{children}</button>
}

export function Badge({ tone = 'neutral', dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{dot && <i className="badge-dot" />}{children}</span>
}

export interface SelectOption<T extends string | number = string> {
  value: T
  label: string
  description?: string
}

export function Select<T extends string | number>({ value, options, onChange, ariaLabel, placeholder = '请选择', className = '', disabled = false, searchable = false, searchPlaceholder = '搜索' }: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  placeholder?: string
  className?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = options[selectedIndex]
  const visible = (() => {
    const q = query.trim().toLowerCase()
    if (!searchable || !q) return options
    const head = options.filter((option) => option.value === '')
    const rest = options.filter((option) => option.value !== '' && (
      String(option.label).toLowerCase().includes(q) || String(option.value).toLowerCase().includes(q)
    ))
    return [...head, ...rest]
  })()

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null)
      setUp(false)
      setQuery('')
      return
    }
    const place = () => {
      const root = rootRef.current
      if (!root) return
      const rect = root.getBoundingClientRect()
      const gap = 7
      const estimated = Math.min(320, visible.length * 40 + (searchable ? 52 : 18))
      const spaceBelow = window.innerHeight - rect.bottom - gap
      const spaceAbove = rect.top - gap
      const shouldUp = spaceBelow < estimated && spaceAbove > spaceBelow
      const width = Math.min(Math.max(rect.width, searchable ? 220 : 190), window.innerWidth - 32)
      let left = rect.left
      if (left + width > window.innerWidth - 16) left = Math.max(16, rect.right - width)
      if (left < 16) left = 16
      const next: CSSProperties = shouldUp
        ? { top: 'auto', bottom: window.innerHeight - rect.top + gap, left, width }
        : { top: rect.bottom + gap, bottom: 'auto', left, width }
      setUp(shouldUp)
      setMenuStyle((prev) => (
        prev
        && prev.top === next.top
        && prev.bottom === next.bottom
        && prev.left === next.left
        && prev.width === next.width
          ? prev
          : next
      ))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, visible.length, searchable])

  useEffect(() => {
    if (!open) return
    setActive(0)
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable, menuStyle])

  const choose = (option: SelectOption<T>) => {
    onChange(option.value)
    setOpen(false)
  }

  const move = (delta: number) => {
    if (!visible.length) return
    setActive((index) => (index + delta + visible.length) % visible.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement | HTMLInputElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' || (event.key === ' ' && event.currentTarget instanceof HTMLButtonElement)) {
      event.preventDefault()
      if (open) { if (visible[active]) choose(visible[active]) }
      else setOpen(true)
    } else if (event.key === 'Escape') {
      setOpen(false)
    } else if (event.key === 'Home' && open) {
      event.preventDefault(); setActive(0)
    } else if (event.key === 'End' && open) {
      event.preventDefault(); setActive(visible.length - 1)
    }
  }

  return (
    <div ref={rootRef} className={`select-control ${open ? 'is-open' : ''} ${up ? 'is-up' : ''} ${disabled ? 'is-disabled' : ''} ${className}`.trim()}>
      <button type="button" className="select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={onKeyDown}>
        <span className={selected ? '' : 'is-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={15} />
      </button>
      {open && menuStyle && createPortal(
        <div ref={menuRef} id={listId} className={`select-menu ${up ? 'is-up' : ''} ${searchable ? 'is-searchable' : ''}`} role="listbox" aria-label={ariaLabel} style={menuStyle}>
          {searchable && (
            <label className="select-search">
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
            </label>
          )}
          {visible.length ? visible.map((option, index) => (
            <button type="button" role="option" aria-selected={option.value === value} key={String(option.value)}
              className={`select-option ${option.value === value ? 'is-selected' : ''} ${index === active ? 'is-active' : ''}`}
              onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
              <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
              {option.value === value && <Check size={15} />}
            </button>
          )) : (
            <p className="select-empty">没有匹配项</p>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <label className={`switch ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track"><i /></span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  )
}

export function PagedList<T>({ items, renderItem, keyOf, empty, pageSize = 8, listClassName = '', resetKey }: {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  keyOf?: (item: T) => string | number
  empty?: ReactNode
  pageSize?: number
  listClassName?: string
  /** 筛选条件变化时回到第一页；增删改当前页保持 */
  resetKey?: string | number
}) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  useEffect(() => { setPage(1) }, [resetKey])
  useEffect(() => { setPage((p) => Math.min(p, pageCount)) }, [pageCount])
  const start = (page - 1) * pageSize
  return (
    <div className="paged-list">
      <div className={listClassName}>
        {items.slice(start, start + pageSize).map((item, i) => (
          <Fragment key={keyOf ? keyOf(item) : start + i}>{renderItem(item, start + i)}</Fragment>
        ))}
      </div>
      {items.length
        ? <Pager page={page} pageCount={pageCount} pageSize={pageSize} total={items.length} onPage={setPage} />
        : empty}
    </div>
  )
}

export function Pager({ page, pageCount, pageSize, total, onPage, onPageSize, pageSizes = [10, 20, 50] }: {
  page: number
  pageCount: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  onPageSize?: (size: number) => void
  pageSizes?: number[]
}) {
  const start = total ? (page - 1) * pageSize + 1 : 0
  const end = Math.min(page * pageSize, total)
  const buttons = pagerButtons(page, pageCount)
  return (
    <div className="pager">
      <span className="pager-meta">第 {start}–{end} 条，共 {total} 条</span>
      <div className="pager-pages">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
        {buttons.map((item, i) => item === '…'
          ? <span key={`e${i}`}>…</span>
          : <button type="button" key={item} className={item === page ? 'on' : ''} onClick={() => onPage(item)}>{item}</button>)}
        <button type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>下一页</button>
      </div>
      {onPageSize && (
        <label className="pager-size">每页
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="每页条数">
            {pageSizes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}

function pagerButtons(page: number, pageCount: number): Array<number | '…'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const set = new Set([1, pageCount, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pageCount))
  const sorted = [...set].sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  for (const n of sorted) {
    if (out.length && n - (out[out.length - 1] as number) > 1) out.push('…')
    out.push(n)
  }
  return out
}

export function EmptyState({ icon: Icon, title, desc, action }: {
  icon: LucideIcon
  title: string
  desc?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="es-icon"><Icon size={22} /></div>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  )
}

export function RuntimeTrack({ sent, total, status, meta }: {
  sent: number
  total: number
  status: TaskStatus
  meta?: string
}) {
  const indeterminate = !total && status === 'running'
  const pct = total ? Math.min(100, (sent / total) * 100) : 0
  const active = status === 'running'
  return (
    <div className="runtime-track">
      <div className={`rt-bar ${indeterminate ? 'indeterminate' : ''}`}>
        <i className="rt-fill" style={{ width: indeterminate ? '40%' : `${pct}%` }} />
        {active && !indeterminate && <i className="rt-pulse" style={{ left: `${pct}%` }} />}
      </div>
      <span className="rt-meta">{meta ?? `${sent} / ${total || '—'}`}</span>
    </div>
  )
}
