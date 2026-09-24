import { createContext, useContext } from 'react'
import type { Reply } from './types'

export type ViewId = 'dashboard' | 'stats' | 'plans' | 'logs' | 'replies' | 'accounts' | 'editors' | 'groups' | 'settings' | 'about'
export interface NavOptions {
  replyKind?: string
  reply?: Reply
  createPlan?: boolean
}
export type LeaveGuard = () => boolean | Promise<boolean>

export const NavContext = createContext<{
  go: (id: ViewId, options?: NavOptions) => void
  setChrome: (hidden: boolean) => void
  setLeaveGuard: (guard: LeaveGuard | null) => void
}>({ go: () => {}, setChrome: () => {}, setLeaveGuard: () => {} })

export function useNav() {
  return useContext(NavContext)
}
