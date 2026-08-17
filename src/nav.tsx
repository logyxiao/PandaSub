import { createContext, useContext } from 'react'

export type ViewId = 'dashboard' | 'stats' | 'plans' | 'logs' | 'replies' | 'accounts' | 'editors' | 'settings' | 'about'
export interface NavOptions {
  replyKind?: string
}

export const NavContext = createContext<{
  go: (id: ViewId, options?: NavOptions) => void
  setChrome: (hidden: boolean) => void
}>({ go: () => {}, setChrome: () => {} })

export function useNav() {
  return useContext(NavContext)
}
