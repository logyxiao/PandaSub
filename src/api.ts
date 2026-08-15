import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  Account, AccountInput, Dashboard, Delivery, Editor, EditorImportResult, EditorInput, Manuscript, ManuscriptInput,
  Reply, Settings, StatsReport, Task, TaskInput, TaskLog,
} from './types'

export const api = {
  dashboard: () => invoke<Dashboard>('get_dashboard'),
  getStats: (start?: string, end?: string, group?: string) =>
    invoke<StatsReport>('get_stats', { start: start || null, end: end || null, group: group || null }),

  listAccounts: () => invoke<Account[]>('list_accounts'),
  addAccount: (input: AccountInput) => invoke<number>('add_account', { input }),
  updateAccount: (id: number, input: AccountInput) => invoke('update_account', { id, input }),
  deleteAccount: (id: number) => invoke('delete_account', { id }),
  toggleAccount: (id: number, enabled: boolean) => invoke('toggle_account', { id, enabled }),
  testAccount: (id: number) => invoke<string>('test_account', { id }),
  sendTestEmail: (accountId: number, manuscriptId: number | null, attachment: { name: string; data: number[] } | null, recipient: string, senderName: string, subject: string, body: string, contentType: string) =>
    invoke<string>('send_test_email', { accountId, manuscriptId, attachment, recipient, senderName, subject, body, contentType }),

  listManuscripts: () => invoke<Manuscript[]>('list_manuscripts'),
  addManuscript: (input: ManuscriptInput) => invoke<number>('add_manuscript', { input }),
  updateManuscript: (id: number, input: ManuscriptInput) => invoke('update_manuscript', { id, input }),
  deleteManuscript: (id: number) => invoke('delete_manuscript', { id }),

  listTasks: () => invoke<Task[]>('list_tasks'),
  createTask: (input: TaskInput) => invoke<number>('create_task', { input }),
  deleteTask: (id: number) => invoke('delete_task', { id }),
  startTask: (id: number) => invoke('start_task', { id }),
  pauseTask: (id: number) => invoke('pause_task', { id }),
  resumeTask: (id: number) => invoke('resume_task', { id }),
  stopTask: (id: number) => invoke('stop_task', { id }),

  listLogs: (taskId?: number, limit = 300) => invoke<TaskLog[]>('list_logs', { taskId: taskId ?? null, limit, offset: 0 }),
  clearLogs: (taskId?: number) => invoke('clear_logs', { taskId: taskId ?? null }),
  exportLogs: (taskId?: number) => invoke<string>('export_logs', { taskId: taskId ?? null }),

  getSettings: () => invoke<Settings>('get_settings'),
  updateSettings: (settings: Settings) => invoke('update_settings', { settings }),
  setAutostart: (enabled: boolean) => invoke('set_autostart', { enabled }),
  checkUpdate: () => invoke<{ current: string; has_update: boolean; latest: string; feed: string }>('check_update'),
  backup: () => invoke<string>('backup_data'),
  listReplies: (kind?: string) => invoke<Reply[]>('list_replies', { kind: kind || null }),
  scanReplies: () => invoke<number>('scan_replies'),
  reclassifyReplies: () => invoke<number>('reclassify_replies'),
  extractDocx: (data: number[]) => invoke<string>('extract_docx_text', { data }),
  listDeliveries: () => invoke<Delivery[]>('list_deliveries'),
  resendDelivery: (deliveryId: number) => invoke('resend_delivery', { deliveryId }),
  sendManualDelivery: (manuscriptId: number, recipient: string, accountIds: number[]) =>
    invoke('send_manual_delivery', { manuscriptId, recipient, accountIds }),

  listEditors: () => invoke<Editor[]>('list_editors'),
  addEditor: (input: EditorInput) => invoke<number>('add_editor', { input }),
  updateEditor: (id: number, input: EditorInput) => invoke('update_editor', { id, input }),
  deleteEditor: (id: number) => invoke('delete_editor', { id }),
  exportEditors: () => invoke<string>('export_editors'),
  importEditors: (data: number[], fileName: string) => invoke<EditorImportResult>('import_editors', { data, fileName }),
}

export function onLog(cb: (log: TaskLog) => void): Promise<UnlistenFn> {
  return listen<TaskLog>('log', (e) => cb(e.payload))
}

export function onTask(cb: (task: Task) => void): Promise<UnlistenFn> {
  return listen<Task>('task', (e) => cb(e.payload))
}

export function onReply(cb: (reply: Reply) => void): Promise<UnlistenFn> {
  return listen<Reply>('reply', (e) => cb(e.payload))
}
