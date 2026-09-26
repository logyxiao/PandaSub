/** Debounce edits, serialize writes and retain the latest draft after a failed write. */
export function createDebouncedSave<T>(save: (value: T) => Promise<unknown>, onError: (error: unknown) => void, delay = 400) {
  let pending: { value: T } | undefined
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (running) return running.then(() => pending ? flush() : undefined)
    if (!pending) return Promise.resolve()
    running = (async () => {
      while (pending) {
        const job = pending
        pending = undefined
        try { await save(job.value) }
        catch (error) { pending ??= job; throw error }
      }
    })().finally(() => { running = undefined })
    return running
  }
  return {
    schedule(value: T) {
      pending = { value }
      clearTimeout(timer)
      timer = setTimeout(() => { void flush().catch(onError) }, delay)
    },
    flush,
    isPending: () => Boolean(pending || running),
  }
}
