import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
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

export function Select<T extends string | number>({ value, options, onChange, ariaLabel, placeholder = '请选择', className = '', disabled = false }: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = options[selectedIndex]

  useEffect(() => {
    if (!open) return
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [open, selectedIndex])

  const choose = (option: SelectOption<T>) => {
    onChange(option.value)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + delta + options.length) % options.length)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(options[active])
      else setOpen(true)
    } else if (event.key === 'Escape') {
      setOpen(false)
    } else if (event.key === 'Home' && open) {
      event.preventDefault(); setActive(0)
    } else if (event.key === 'End' && open) {
      event.preventDefault(); setActive(options.length - 1)
    }
  }

  return (
    <div ref={rootRef} className={`select-control ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className}`.trim()}>
      <button type="button" className="select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={onKeyDown}>
        <span className={selected ? '' : 'is-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={15} />
      </button>
      {open && (
        <div id={listId} className="select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button type="button" role="option" aria-selected={option.value === value} key={String(option.value)}
              className={`select-option ${option.value === value ? 'is-selected' : ''} ${index === active ? 'is-active' : ''}`}
              onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
              <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>
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
