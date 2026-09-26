import { useModalFocus } from '../hooks/useModalFocus'
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type ToastTone = 'info' | 'success' | 'warning' | 'error'
interface ToastItem { id: number; message: string; tone: ToastTone }

const ToastCtx = createContext<(message: string, tone?: ToastTone) => void>(() => {})
// eslint-disable-next-line react/only-export-components
export function useToast() { return useContext(ToastCtx) }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, message, tone }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}><i />{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
}

const ConfirmCtx = createContext<(opts: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false))
// eslint-disable-next-line react/only-export-components
export function useConfirm() { return useContext(ConfirmCtx) }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  type Request = { id: number; opts: ConfirmOptions; resolve: (v: boolean) => void }
  const [pending, setPending] = useState<Request | null>(null)
  const current = useRef<Request | null>(null)
  const queue = useRef<Request[]>([])
  const sequence = useRef(0)

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    const request = { id: ++sequence.current, opts, resolve }
    if (current.current) queue.current.push(request)
    else { current.current = request; setPending(request) }
  }), [])

  const close = useCallback((v: boolean) => {
    const request = current.current
    if (!request) return
    current.current = queue.current.shift() ?? null
    setPending(current.current)
    // Mutate the queue and settle promises outside React state updaters.
    request.resolve(v)
  }, [])

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <div className="modal-backdrop" onClick={() => close(false)}>
          <ConfirmDialog requestId={pending.id} onClose={() => close(false)}>
            <div className="modal-body">
              <h2 id="confirm-title" style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{pending.opts.title}</h2>
              <p className="confirm-message">{pending.opts.message}</p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => close(false)} data-modal-initial-focus>
                {pending.opts.cancelLabel ?? '取消'}
              </button>
              <button className={`btn ${pending.opts.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => close(true)}>
                {pending.opts.confirmLabel ?? '确认'}
              </button>
            </div>
          </ConfirmDialog>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}

function ConfirmDialog({ children, onClose, requestId }: { children: ReactNode; onClose: () => void; requestId: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, onClose)
  useLayoutEffect(() => { ref.current?.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')?.focus() }, [requestId])
  return <div ref={ref} tabIndex={-1} className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"
    onClick={event => event.stopPropagation()}>{children}</div>
}
