import { useEffect, useRef, useState } from 'react'
export function useDebouncedValue<T>(value: T, delay = 200, onCommit?: () => void) {
  const [debounced, setDebounced] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => {
    if (Object.is(value, debounced)) return
    const timer = setTimeout(() => { setDebounced(value); commit.current?.() }, delay)
    return () => clearTimeout(timer)
  }, [value, delay, debounced])
  return debounced
}
