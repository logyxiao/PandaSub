import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

export const RELEASES_URL = 'https://pandasub.zhudot.com/'

export async function currentVersion() {
  return getVersion()
}

export async function availableUpdate() {
  return check({ timeout: 12_000 })
}

export async function installUpdate(update: Update, onProgress?: (percent: number | null) => void) {
  let downloaded = 0
  let total: number | undefined
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength
      downloaded = 0
      onProgress?.(total ? 0 : null)
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress?.(total ? Math.min(99, Math.round((downloaded / total) * 100)) : null)
    } else {
      onProgress?.(100)
    }
  })
}

export async function restartApp() {
  await relaunch()
}
