import { useEffect, useRef } from 'react'

/** Handles asynchronous listener installation/teardown and optionally coalesces accepted events. */
export function useEventSubscription<T>(subscribe: (callback: (value: T) => void) => Promise<() => void>,
  onEvent: (value: T) => void, delay = 0, accept: (value: T) => boolean = () => true) {
  const callbacks = useRef({ onEvent, accept })
  callbacks.current = { onEvent, accept }
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: T
    void subscribe(value => {
      if (cancelled || !callbacks.current.accept(value)) return
      if (!delay) { callbacks.current.onEvent(value); return }
      last = value
      if (timer === undefined) timer = setTimeout(() => {
        timer = undefined
        if (!cancelled) callbacks.current.onEvent(last)
      }, delay)
    }).then(un => { if (cancelled) un(); else unlisten = un }).catch(() => {})
    return () => { cancelled = true; clearTimeout(timer); unlisten?.() }
  }, [subscribe, delay])
}
