import { useCallback, useEffect, useRef } from 'react'
import { api, onOpenUnreadInbox } from '../api'
import type { NavOptions, ViewId } from '../nav'
import { useEventSubscription } from './useEventSubscription'

/** Acknowledge each native request once, including focus/event races and React startup. */
export function useTrayInboxNavigation(go: (id: ViewId, options?: NavOptions) => void) {
  const latestGo = useRef(go)
  latestGo.current = go
  const mounted = useRef(false)
  const running = useRef(false)
  const pending = useRef(false)
  const consume = useCallback(async () => {
    if (!mounted.current) return
    if (running.current) { pending.current = true; return }
    running.current = true
    try {
      do {
        pending.current = false
        const requested = await api.takeTrayInboxRequest()
        if (requested && mounted.current) latestGo.current('replies', { replyKind: 'unread', accountId: '' })
      } while (pending.current && mounted.current)
    } catch { /* Retry on the next focus/native request if the backend is temporarily unavailable. */ }
    finally { running.current = false }
  }, [])
  useEventSubscription(onOpenUnreadInbox, () => { void consume() })
  useEffect(() => {
    mounted.current = true
    void consume()
    const focus = () => { void consume() }
    window.addEventListener('focus', focus)
    return () => { mounted.current = false; window.removeEventListener('focus', focus) }
  }, [consume])
}
