import { createContext, useContext } from 'react'
import type { Reply } from './types'

export type ViewId = 'dashboard' | 'stats' | 'accepted' | 'plans' | 'logs' | 'replies' | 'accounts' | 'editors' | 'groups' | 'settings' | 'about'
export interface NavOptions {
  replyKind?: string
  reply?: Reply
  accountId?: number | ''
  createPlan?: boolean
}
export type LeaveGuard = () => boolean | Promise<boolean>

export const NavContext = createContext<{
  go: (id: ViewId, options?: NavOptions) => void
  restart: (beforeRestart?: () => Promise<void>) => Promise<void>
  setChrome: (hidden: boolean) => void
  setLeaveGuard: (guard: LeaveGuard | null) => void
}>({ restart: async () => {}, go: () => {}, setChrome: () => {}, setLeaveGuard: () => {} })

export function useNav() {
  return useContext(NavContext)
}
