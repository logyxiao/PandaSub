import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

import { MAX_ATTACHMENT_BYTES } from '../lib/binaryIpc'
export { MAX_ATTACHMENT_BYTES } from '../lib/binaryIpc'
/** Owns staged bytes until the editor closes; stale imports cannot replace a newer draft. */
export function useAttachmentImport(active: boolean) {
  const owned = useRef<string | null>(null)
  const sequence = useRef(0)
  const [importing, setImporting] = useState(false)
  const release = useCallback(() => {
    sequence.current++
    const token = owned.current
    owned.current = null
    if (token) void api.releaseAttachment(token).catch(() => {})
  }, [])
  useEffect(() => {
    if (!active) { release(); setImporting(false) }
    return release
  }, [active, release])
  const stage = useCallback(async (file: File, extensions = ['docx', 'txt', 'md', 'html', 'htm']) => {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!extensions.includes(extension)) throw new Error(`请导入 ${extensions.map(ext => ext.toUpperCase()).join('、')} 格式的文稿`)
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error('文稿不能为空，且不能超过 25 MB')
    const version = ++sequence.current
    setImporting(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (version !== sequence.current) return null
      const result = await api.stageAttachment(bytes, extension)
      if (version !== sequence.current) { await api.releaseAttachment(result.token); return null }
      const previous = owned.current
      owned.current = result.token
      if (previous) void api.releaseAttachment(previous).catch(() => {})
      return result
    } finally { if (version === sequence.current) setImporting(false) }
  }, [])
  const cancel = useCallback(() => { release(); setImporting(false) }, [release])
  return { stage, importing, release: cancel }
}
