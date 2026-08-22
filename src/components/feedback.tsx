import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

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
  const [pending, setPending] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)
  const queue = useRef<Array<{ opts: ConfirmOptions; resolve: (v: boolean) => void }>>([])

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending((current) => {
      if (current) {
        queue.current.push({ opts, resolve })
        return current
      }
      return { opts, resolve }
    })
  }), [])

  const close = useCallback((v: boolean) => {
    setPending((current) => {
      current?.resolve(v)
      return queue.current.shift() ?? null
    })
  }, [])

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, close])

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <div className="modal-backdrop" onClick={() => close(false)}>
          <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h2 id="confirm-title" style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{pending.opts.title}</h2>
              <p className="confirm-message">{pending.opts.message}</p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => close(false)} autoFocus>
                {pending.opts.cancelLabel ?? '取消'}
              </button>
              <button className={`btn ${pending.opts.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => close(true)}>
                {pending.opts.confirmLabel ?? '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}
