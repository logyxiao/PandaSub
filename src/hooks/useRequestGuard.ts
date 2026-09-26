import { useEffect, useMemo } from 'react'
import { createRequestGuard } from '../lib/requestGuard'

/** Ignore results from superseded requests, closed dialogs, and unmounted pages. */
export function useRequestGuard() {
  const guard = useMemo(createRequestGuard, [])
  useEffect(() => () => guard.invalidate(), [guard])
  return guard
}
