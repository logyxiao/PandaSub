import { useEffect, useMemo, useRef } from 'react'
import { createDebouncedSave } from '../lib/debouncedSave'

export function useDebouncedSave<T>(save: (value: T) => Promise<unknown>, onError: (error: unknown) => void, delay = 400) {
  const callbacks = useRef({ save, onError })
  callbacks.current = { save, onError }
  const queue = useMemo(() => createDebouncedSave<T>(value => callbacks.current.save(value), error => callbacks.current.onError(error), delay), [delay])
  useEffect(() => {
    const flush = () => { void queue.flush().catch(error => callbacks.current.onError(error)) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [queue])
  return queue
}
