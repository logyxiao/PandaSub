import { useCallback, useState } from 'react'
import { api } from '../api'
import { useAsyncResource } from '../hooks/useAsyncResource'
import { useBusyAction } from '../hooks/useBusyAction'
import { clearMailContentCache } from '../lib/mailContentCache'
import { useConfirm, useToast } from './feedback'
import { Button, Select } from './ui'

const size = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MB`

export function StorageManager() {
  const load = useCallback(() => api.storageSummary(), [])
  const { data, loading, error, reload } = useAsyncResource(load)
  const [mailKeep, setMailKeep] = useState(500)
  const [backupKeep, setBackupKeep] = useState(10)
  const action = useBusyAction()
  const confirm = useConfirm()
  const toast = useToast()
  const clean = (scope: 'mail_cache' | 'backups') => action.run(async () => {
    const keep = scope === 'mail_cache' ? mailKeep : backupKeep
    const accepted = await confirm({ title: scope === 'mail_cache' ? '清理邮件缓存？' : '清理旧备份？',
      message: scope === 'mail_cache'
        ? `${keep ? `按收信时间保留最新 ${keep} 封可重新下载邮件的缓存。` : '清理可重新下载邮件的全部缓存。'}标题、摘要、已读状态、投稿稿件和统计保留。清理后的完整正文和附件需要联网重新下载；服务器已删除的邮件可能无法恢复。缺少有效账号或属于旧邮箱的缓存会保留。`
        : `保留最新 ${keep} 份完整备份，删除其余旧备份。删除后无法恢复，不影响当前数据库。`,
      confirmLabel: '确认清理', tone: 'danger' })
    if (!accepted) return
    try {
      const count = await api.cleanStorage(scope, keep)
      if (scope === 'mail_cache') clearMailContentCache()
      await reload()
      toast(scope === 'mail_cache' ? `已清理 ${count} 封邮件的缓存` : `已清理 ${count} 份旧备份`, 'success')
    } catch (error) { await reload(); toast(String(error), 'error') }
  })
  return <div className="pad" aria-label="存储空间管理">
    <div className="toolbar"><h3>存储空间</h3><Button size="sm" disabled={loading || action.busy} onClick={() => void reload()}>刷新用量</Button></div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {!data ? <p className="hint">{loading ? '正在统计空间…' : '空间统计暂不可用，点击刷新用量重试。'}</p> : <>
      <p className="hint">数据库占用 {size(data.database_bytes)} · 邮件缓存 {data.cache_messages} 封 / {size(data.cache_bytes)} · 备份 {data.backup_count} 份 / {size(data.backup_bytes)}</p>
      <div className="form-grid">
        <div className="field">邮件缓存
          <Select ariaLabel="邮件缓存保留数量" value={mailKeep} onChange={setMailKeep} disabled={action.busy}
            options={[{value:100,label:'保留最新 100 封'},{value:500,label:'保留最新 500 封'},{value:1000,label:'保留最新 1000 封'},{value:0,label:'清理全部可重新下载的缓存'}]} />
          <span className="field-hint">缺少可用邮箱连接的 {data.protected_messages} 封缓存会保留。清理后数据库空间供后续数据复用，文件可能不会立即缩小。</span>
          <Button size="sm" disabled={action.busy || loading || data.cache_messages-data.protected_messages <= mailKeep} onClick={() => void clean('mail_cache')}>清理邮件缓存</Button>
        </div>
        <div className="field">历史备份
          <Select ariaLabel="备份保留数量" value={backupKeep} onChange={setBackupKeep} disabled={action.busy}
            options={[1,5,10,20].map(value=>({value,label:`保留最新 ${value} 份`}))} />
          <span className="field-hint">只在点击清理并确认后删除旧备份。正在生成的备份不参与清理。</span>
          <Button size="sm" disabled={action.busy || loading || data.backup_count <= backupKeep} onClick={() => void clean('backups')}>清理旧备份</Button>
        </div>
      </div>
    </>}
  </div>
}
