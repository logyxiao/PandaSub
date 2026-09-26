import { useNav } from '../nav'
import { useEffect, useState } from 'react'
import { useConfirm, useToast } from './feedback'
import { Button } from './ui'
import { applyPreparedUpdate, runUpdateFlow, useUpdateFlow } from '../lib/updateFlow'

export function UpdateManager() {
  const { restart } = useNav()
  const confirm = useConfirm()
  const toast = useToast()
  const { state, version } = useUpdateFlow()
  const [dismissedVersion, setDismissedVersion] = useState<string>()
  useEffect(() => {
    let current = true
    const check = () => { void runUpdateFlow(confirm, toast, restart, true, () => current) }
    const timer = window.setTimeout(check, 5000)
    const periodic = window.setInterval(check, 4 * 60 * 60_000)
    return () => { current = false; window.clearTimeout(timer); window.clearInterval(periodic) }
  }, [confirm, toast, restart])
  if (state !== 'ready' || dismissedVersion === version) return null
  return <aside className="update-ready-notice" role="status" aria-label="应用更新">
    <span>新版本 {version} 已下载</span>
    <Button size="sm" variant="primary" onClick={() => void applyPreparedUpdate(restart, toast)}>更新并重启</Button>
    <Button size="sm" variant="ghost" onClick={() => setDismissedVersion(version)}>稍后</Button>
  </aside>
}
