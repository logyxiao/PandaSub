import { useCallback, useRef, useState } from 'react'

/** A synchronous admission guard as well as a renderable busy state. */
export function useBusyAction() {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { return await action() }
    finally { pending.current = false; setBusy(false) }
  }, [])
  return { busy, run }
}
