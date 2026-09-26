import { useNav } from '../nav'
import { useEffect } from 'react'
import { useConfirm, useToast } from './feedback'
import { runUpdateFlow } from '../lib/updateFlow'

export function UpdateManager() {
  const { restart } = useNav()
  const confirm = useConfirm()
  const toast = useToast()
  useEffect(() => {
    let current = true
    const timer = window.setTimeout(() => { void runUpdateFlow(confirm, toast, restart, true, () => current) }, 5000)
    return () => { current = false; window.clearTimeout(timer) }
  }, [confirm, toast, restart])
  return null
}
