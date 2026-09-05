import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  Account, AccountInput, Dashboard, Delivery, DeliverySummaryPage, PendingSend, Editor, EditorGroup, EditorGroupImportResult, EditorGroupInput, EditorImportResult, EditorInput, MailTemplate, Manuscript, ManuscriptInput,
  Reply, Settings, StatsReport, Task, TaskInput, TaskLog,
} from './types'

export const api = {
  dashboard: () => invoke<Dashboard>('get_dashboard'),
  runningTaskCount: () => invoke<number>('running_task_count'),
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
  updateTask: (id: number, input: TaskInput) => invoke('update_task', { id, input }),
  createWasteDraftTask: (manuscriptId: number) =>
    invoke<number>('create_waste_draft_task', { manuscriptId }),
  updateTaskAccounts: (id: number, accountIds: number[]) => invoke('update_task_accounts', { id, accountIds }),
  deleteTask: (id: number) => invoke('delete_task', { id }),
  startTask: (id: number) => invoke('start_task', { id }),
  pauseTask: (id: number) => invoke('pause_task', { id }),
  resumeTask: (id: number) => invoke('resume_task', { id }),
  stopTask: (id: number) => invoke('stop_task', { id }),

  listLogs: (taskId?: number, limit = 300) => invoke<TaskLog[]>('list_logs', { taskId: taskId ?? null, limit, offset: 0 }),
  listLogsPage: (taskId: number | '', level: string, query: string, limit: number, offset: number) =>
    invoke<{ items: TaskLog[]; total: number }>('list_logs_page', { taskId: taskId || null, level: level || null, query, limit, offset }),
  clearLogs: (taskId?: number) => invoke('clear_logs', { taskId: taskId ?? null }),
  exportLogs: (path: string, taskId?: number, level?: string, query?: string) =>
    invoke<string>('export_logs', { path, taskId: taskId ?? null, level: level || null, query: query || null }),

  getSettings: () => invoke<Settings>('get_settings'),
  updateSettings: (settings: Settings) => invoke('update_settings', { settings }),
  getDefaultMailTemplates: () => invoke<MailTemplate[]>('get_default_mail_templates'),
  saveDefaultMailTemplates: (templates: MailTemplate[]) => invoke('save_default_mail_templates', { templates }),
  setAutostart: (enabled: boolean) => invoke('set_autostart', { enabled }),
  backup: () => invoke<string>('backup_data'),
  listReplies: (kind?: string, taskId?: number) => invoke<Reply[]>('list_replies', { kind: kind || null, taskId: taskId || null }),
  listRepliesPage: (kind: string, taskId: number | '', query: string, limit: number, offset: number) =>
    invoke<{ items: Reply[]; total: number }>('list_replies_page', { kind: kind || null, taskId: taskId || null, query, limit, offset }),
  scanReplies: () => invoke<number>('scan_replies'),
  reclassifyReplies: () => invoke<number>('reclassify_replies'),
  extractDocx: (data: number[]) => invoke<string>('extract_docx_text', { data }),
  listDeliveries: (manuscriptId?: number) => invoke<Delivery[]>('list_deliveries', { manuscriptId: manuscriptId ?? null }),
  deliverySummaryPage: (manuscriptId: number, emails: string[], matching: number[], filter: string, limit: number, offset: number) =>
    invoke<DeliverySummaryPage>('delivery_summary_page', { manuscriptId, emails, matching, filter, limit, offset }),
  listPendingSends: (manuscriptId: number) => invoke<PendingSend[]>('list_pending_sends', { manuscriptId }),
  resolvePendingSend: (id: number, sent: boolean) => invoke('resolve_pending_send', { id, sent }),
  resendDelivery: (deliveryId: number) => invoke('resend_delivery', { deliveryId }),
  sendManualDelivery: (manuscriptId: number, recipient: string, accountIds: number[]) =>
    invoke('send_manual_delivery', { manuscriptId, recipient, accountIds }),

  listEditors: () => invoke<Editor[]>('list_editors'),
  listEditorGroups: () => invoke<EditorGroup[]>('list_editor_groups'),
  createEditorGroup: (input: EditorGroupInput) => invoke<number>('create_editor_group', { input }),
  updateEditorGroup: (id: number, input: EditorGroupInput) => invoke('update_editor_group', { id, input }),
  deleteEditorGroup: (id: number) => invoke('delete_editor_group', { id }),
  exportEditorGroups: (path: string, groupIds: number[]) => invoke<string>('export_editor_groups', { path, groupIds }),
  importEditorGroups: (data: number[], fileName: string) => invoke<EditorGroupImportResult>('import_editor_groups', { data, fileName }),
  addEditor: (input: EditorInput) => invoke<number>('add_editor', { input }),
  updateEditor: (id: number, input: EditorInput) => invoke('update_editor', { id, input }),
  toggleEditorFavorite: (id: number) => invoke<boolean>('toggle_editor_favorite', { id }),
  deleteEditor: (id: number) => invoke('delete_editor', { id }),
  clearEditors: () => invoke<number>('clear_editors'),
  exportEditors: (path: string) => invoke<string>('export_editors', { path }),
  importEditors: (data: number[], fileName: string) => invoke<EditorImportResult>('import_editors', { data, fileName }),
  importDefaultEditors: () => invoke<EditorImportResult>('import_default_editors'),
}

function safeListen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload)).then((unlisten) => {
    return () => {
      try {
        void Promise.resolve(unlisten()).catch(() => {})
      } catch {
        // The web fallback and hot-reload teardown may already have removed it.
      }
    }
  }).catch(() => () => {})
}

export function onLog(cb: (log: TaskLog) => void): Promise<UnlistenFn> {
  return safeListen('log', cb)
}

export function onTask(cb: (task: Task) => void): Promise<UnlistenFn> {
  return safeListen('task', cb)
}

export function onReply(cb: (reply: Reply) => void): Promise<UnlistenFn> {
  return safeListen('reply', cb)
}
