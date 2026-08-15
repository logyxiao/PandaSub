import { createContext, useContext } from 'react'

export type ViewId = 'dashboard' | 'plans' | 'logs' | 'replies' | 'accounts' | 'editors' | 'settings'

export const NavContext = createContext<{
  go: (id: ViewId) => void
  setChrome: (hidden: boolean) => void
}>({ go: () => {}, setChrome: () => {} })

export function useNav() {
  return useContext(NavContext)
}
