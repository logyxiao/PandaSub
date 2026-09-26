import { useCallback, useEffect } from 'react'
import { useConfirm, useToast } from '../components/feedback'
import { useNav } from '../nav'

export function useUnsavedChanges(dirty: boolean, busy: boolean, description: string, beforeLeave?: () => Promise<boolean>) {
  const confirm = useConfirm()
  const toast = useToast()
  const { setLeaveGuard } = useNav()
  const allowLeave = useCallback(async () => {
    if (busy) { toast('正在保存，请稍候', 'info'); return false }
    if (beforeLeave && !await beforeLeave()) return false
    return !dirty || await confirm({ title: '放弃未保存的修改？', message: description,
      confirmLabel: '放弃修改', cancelLabel: '继续编辑' })
  }, [busy, dirty, description, confirm, toast, beforeLeave])
  useEffect(() => {
    setLeaveGuard(allowLeave)
    return () => setLeaveGuard(null)
  }, [allowLeave, setLeaveGuard])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])
  return allowLeave
}
