import { useSyncExternalStore } from 'react'

export const themes = [
  { id: 'panda', name: '熊猫黑白', description: '纯净白底与黑灰点缀，简洁清晰。' },
  { id: 'sage', name: '竹叶青', description: '竹叶绿强调选中状态，搭配柔和浅绿背景。' },
] as const

export type ThemeId = typeof themes[number]['id']
const storageKey = 'novelsub.theme'
const changeEvent = 'novelsub:theme-change'
const normalizeTheme = (value: string | null | undefined): ThemeId => value === 'sage' ? 'sage' : 'panda'

function readSavedTheme(): ThemeId {
  try { return normalizeTheme(localStorage.getItem(storageKey)) }
  catch { return 'panda' }
}

function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme
  window.dispatchEvent(new Event(changeEvent))
}

/** Apply the saved palette before React's first render. */
export function initializeTheme() {
  applyTheme(readSavedTheme())
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) applyTheme(readSavedTheme())
  })
}

export function setTheme(theme: ThemeId): boolean {
  applyTheme(theme)
  try {
    localStorage.setItem(storageKey, theme)
    return true
  } catch { return false }
}

const subscribe = (listener: () => void) => {
  window.addEventListener(changeEvent, listener)
  return () => window.removeEventListener(changeEvent, listener)
}
const getTheme = () => normalizeTheme(document.documentElement.dataset.theme)

export const useTheme = () => useSyncExternalStore(subscribe, getTheme, () => 'panda' as ThemeId)
