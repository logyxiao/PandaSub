/** Run one request at a time; replace queued obsolete pages before they reach IPC. */
export function createLatestRequestQueue<T, R>(load: (value: T) => Promise<R>, skipped: () => R) {
  type Job = { value: T; resolve: (value: R) => void; reject: (error: unknown) => void }
  let active = false
  let queued: Job | undefined
  let disposed = false
  const execute = async (job: Job) => {
    active = true
    try { const result = await load(job.value); job.resolve(disposed ? skipped() : result) }
    catch (error) { if (disposed) job.resolve(skipped()); else job.reject(error) }
    finally {
      active = false
      const next = queued; queued = undefined
      if (next) { if (disposed) next.resolve(skipped()); else void execute(next) }
    }
  }
  return {
    read(value: T): Promise<R> {
      if (disposed) return Promise.resolve(skipped())
      return new Promise((resolve, reject) => {
        const job = { value, resolve, reject }
        if (active) { queued?.resolve(skipped()); queued = job }
        else void execute(job)
      })
    },
    dispose() { disposed = true; queued?.resolve(skipped()); queued = undefined },
  }
}
