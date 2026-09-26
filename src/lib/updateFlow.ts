import { useSyncExternalStore } from 'react'
import type { useConfirm, useToast } from '../components/feedback'
import { availableUpdate, installUpdate } from '../update'

type Snapshot = { state: 'idle' | 'checking' | 'downloading' | 'installed'; progress: number | null }
let snapshot: Snapshot = { state: 'idle', progress: null }
let active = false
const listeners = new Set<() => void>()
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useUpdateFlow() { return useSyncExternalStore(subscribe, () => snapshot) }

/** One owner for checks, confirmation, download and restart across both entry points. */
export async function runUpdateFlow(confirm: ReturnType<typeof useConfirm>, toast: ReturnType<typeof useToast>,
  restartApp: () => Promise<void>, silent = false, isCurrent: () => boolean = () => true) {
  if (active || snapshot.state === 'installed') return
  active = true
  publish({ state: 'checking', progress: null })
  let update: Awaited<ReturnType<typeof availableUpdate>> | undefined
  try {
    update = await availableUpdate()
    if (!isCurrent()) return
    if (!update) { if (!silent) toast('当前已是最新版本', 'success'); return }
    if (silent && sessionStorage.getItem('novelsub.dismissed-update') === update.version) return
    const accepted = await confirm({ title: `发现新版本 v${update.version}`,
      message: update.body?.trim() || '下载并安装后，已有数据会继续保留。', confirmLabel: '下载并安装', cancelLabel: '稍后更新' })
    if (!accepted || !isCurrent()) {
      if (silent) sessionStorage.setItem('novelsub.dismissed-update', update.version)
      return
    }
    publish({ state: 'downloading', progress: null })
    await installUpdate(update, progress => publish({ state: 'downloading', progress }))
    publish({ state: 'installed', progress: null })
    if (!isCurrent()) return
    const restart = await confirm({ title: '更新安装完成', message: '重启熊猫投稿后即可使用新版本。正在发送的计划会在重启时停止。', confirmLabel: '立即重启', cancelLabel: '稍后重启' })
    if (restart) await restartApp()
  } catch (error) { if (!silent || (snapshot as Snapshot).state === 'installed') toast(`更新失败：${String(error)}`, 'error') }
  finally {
    if (update) await update.close().catch(() => {})
    if ((snapshot as Snapshot).state !== 'installed') publish({ state: 'idle', progress: null })
    active = false
  }
}
