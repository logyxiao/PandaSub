import { useCallback, useEffect, useMemo } from 'react'

/** At most one active load plus one follow-up for events arriving during that load. */
export function useCoalescedRefresh(load: () => Promise<void>) {
  const queue = useMemo(() => ({ load, active: undefined as Promise<void> | undefined, again: false, disposed: false }), [load])
  useEffect(() => { queue.disposed = false; return () => { queue.disposed = true; queue.again = false } }, [queue])
  return useCallback((): Promise<void> => {
    if (queue.disposed) return Promise.resolve()
    if (queue.active) { queue.again = true; return queue.active }
    const request = (async () => {
      do { queue.again = false; await queue.load() } while (queue.again && !queue.disposed)
    })().finally(() => { if (queue.active === request) queue.active = undefined })
    queue.active = request
    return request
  }, [queue])
}
