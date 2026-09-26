import { useSyncExternalStore } from 'react'
import type { useConfirm, useToast } from '../components/feedback'
import { availableUpdate, downloadUpdate, installUpdate } from '../update'

type Snapshot = { state: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'installed'; progress: number | null; version?: string }
export type GuardedRestart = (beforeRestart?: () => Promise<void>) => Promise<void>
let snapshot: Snapshot = { state: 'idle', progress: null }
let active = false
let prepared: Awaited<ReturnType<typeof availableUpdate>> | undefined
const listeners = new Set<() => void>()
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useUpdateFlow() { return useSyncExternalStore(subscribe, () => snapshot) }

/** Downloads only. Native signature verification finishes before the update becomes ready. */
export async function runUpdateFlow(_confirm: ReturnType<typeof useConfirm>, toast: ReturnType<typeof useToast>,
  _restart: GuardedRestart, silent = false, isCurrent: () => boolean = () => true) {
  if (active || snapshot.state === 'ready' || snapshot.state === 'installed') return
  active = true
  publish({ state: 'checking', progress: null })
  let update: Awaited<ReturnType<typeof availableUpdate>> | undefined
  try {
    update = await availableUpdate()
    if (!isCurrent()) return
    if (!update) { if (!silent) toast('当前已是最新版本', 'success'); return }
    const version = update.version
    publish({ state: 'downloading', progress: null, version })
    await downloadUpdate(update, progress => publish({ state: 'downloading', progress, version }))
    prepared = update
    publish({ state: 'ready', progress: 100, version })
  } catch (error) { if (!silent) toast(`检查或下载更新失败：${String(error)}`, 'error') }
  finally {
    if (update && update !== prepared) await update.close().catch(() => {})
    if ((snapshot as Snapshot).state !== 'ready') publish({ state: 'idle', progress: null })
    active = false
  }
}

/** Guard BEFORE install: on Windows installing starts the updater and exits immediately. */
export async function applyPreparedUpdate(restart: GuardedRestart, toast: ReturnType<typeof useToast>) {
  if (active || !['ready', 'installed'].includes(snapshot.state)) return
  active = true
  try {
    if (snapshot.state === 'installed') { await restart(); return }
    const update = prepared
    if (!update) throw new Error('更新包不可用，请重新检查更新')
    await restart(async () => {
      publish({ state: 'installing', progress: null, version: update.version })
      await installUpdate(update)
      publish({ state: 'installed', progress: null, version: update.version })
      prepared = undefined
      await update.close().catch(() => {})
    })
  } catch (error) {
    if ((snapshot as Snapshot).state !== 'installed') publish({ state: 'ready', progress: 100, version: prepared?.version })
    toast(`暂时无法更新：${String(error)}`, 'error')
  } finally { active = false }
}
