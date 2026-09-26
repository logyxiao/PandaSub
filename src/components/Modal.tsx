import { useModalFocus } from '../hooks/useModalFocus'
import { useId, useRef } from 'react'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export function Modal({ title, onClose, children, footer, width, className = '' }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  const uid = useId()
  const titleId = `modal-title-${uid}`
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, onClose)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} ref={ref} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}
