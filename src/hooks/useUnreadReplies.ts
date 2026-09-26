import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onReply, onReplyReadChange } from '../api'
import { useEventSubscription } from './useEventSubscription'

/** One count query across all pages/accounts; serialize bursts so older counts cannot win. */
export function useUnreadReplies() {
  const [count, setCount] = useState(0)
  const refreshRef = useRef(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])
  useEventSubscription(onReply, refresh, 100)
  useEventSubscription(onReplyReadChange, refresh, 100)
  useEffect(() => {
    let cancelled = false, pending = false, running = false
    const load = async () => {
      if (cancelled) return
      if (running) { pending = true; return }
      running = true
      try {
        const next = await api.unreadHumanReplyCount()
        if (!cancelled) setCount(Math.max(0, next))
      } catch { /* Retain the last confirmed count during a temporary backend failure. */ }
      finally {
        running = false
        if (pending && !cancelled) { pending = false; void load() }
      }
    }
    refreshRef.current = () => { void load() }
    void load()
    const timer = window.setInterval(load, 15000)
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [refresh])
  return count
}
