/** Small bounded-lifetime cache; invalidation also prevents stale in-flight reads from being cached. */
export function createResourceCache<T>(load: () => Promise<T>, ttl = 30_000) {
  let entry: { value: T; expires: number } | undefined
  let pending: Promise<T> | undefined
  let pendingRefresh = false
  let generation = 0
  const invalidate = () => { generation++; entry = undefined; pending = undefined }
  return {
    invalidate,
    read(refresh = false): Promise<T> {
      if (refresh && pending && pendingRefresh) return pending
      if (refresh) invalidate()
      if (entry && entry.expires > Date.now()) return Promise.resolve(entry.value)
      if (pending) return pending
      const version = generation
      let loaded: Promise<T>
      try { loaded = load() } catch (error) { return Promise.reject(error) }
      const request = loaded.then(value => {
        if (version === generation) entry = { value, expires: Date.now() + ttl }
        return value
      }).finally(() => { if (pending === request) pending = undefined })
      pending = request
      pendingRefresh = refresh
      return request
    },
  }
}
