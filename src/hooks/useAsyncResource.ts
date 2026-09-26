import { useCallback, useEffect, useRef, useState } from 'react'

/** Shared latest-request wins policy, including unmount and errors. */
export function useAsyncResource<T>(load: (refresh?: boolean) => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const pending = useRef<{ load: typeof load; request: Promise<void> } | null>(null)
  const reload = useCallback((refresh = true): Promise<void> => {
    if (pending.current?.load === load) return pending.current.request
    const request = (async () => {
      const id = ++sequence.current
      setLoading(true)
      try {
        const value = await load(refresh)
        if (id === sequence.current) { setData(value); setError('') }
      } catch (error) {
        if (id === sequence.current) { setData(null); setError(String(error)) }
      } finally { if (id === sequence.current) setLoading(false) }
    })().finally(() => { if (pending.current?.request === request) pending.current = null })
    pending.current = { load, request }
    return request
  }, [load])
  useEffect(() => {
    const current = sequence
    void reload(false)
    return () => { current.current++; pending.current = null }
  }, [reload])
  return { data, loading, error, reload }
}
