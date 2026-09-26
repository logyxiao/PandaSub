import { invokeBinary } from './lib/binaryIpc'
import { createResourceCache } from './lib/resourceCache'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AcceptedCandidate, AcceptedWork, AcceptedWorkDocument, AcceptedWorkInput, Account, AccountInput, Dashboard, Delivery, DeliverySummaryPage, PendingSend, Editor, EditorGroup, EditorGroupImportResult, EditorGroupInput, EditorImportResult, EditorInput, MailTemplate, Manuscript, ManuscriptInput,
  Reply, Settings, StatsReport, Task, TaskInput, TaskLog,
} from './types'

const editorCache = createResourceCache(() => invoke<Editor[]>('list_editors'))
const groupCache = createResourceCache(() => invoke<EditorGroup[]>('list_editor_groups'))
async function editLibrary<T>(operation: Promise<T>): Promise<T> {
  try { return await operation }
  finally { editorCache.invalidate(); groupCache.invalidate() }
}

const statsCaches = new Map<string, ReturnType<typeof createResourceCache<StatsReport>>>()
export function invalidateStats() { for (const cache of statsCaches.values()) cache.invalidate() }
function getStats(start?: string, end?: string, group?: string, refresh = false) {
  const key = JSON.stringify([start || null, end || null, group || null])
  let cache = statsCaches.get(key)
  if (!cache) {
    cache = createResourceCache(() => invoke<StatsReport>('get_stats', { start: start || null, end: end || null, group: group || null }), 15_000)
    statsCaches.set(key, cache)
    if (statsCaches.size > 12) statsCaches.delete(statsCaches.keys().next().value!)
  }
  return cache.read(refresh)
}
async function changesStats<T>(operation: Promise<T>): Promise<T> {
  try { return await operation } finally { invalidateStats() }
}

export const api = {
  prepareUpdateInstall: () => invoke<void>('prepare_update_install'),
  releaseUpdateInstall: () => invoke<void>('release_update_install'),
  getLocalReplyContent: (id: number) => invoke<import('./types').MailContent>('get_local_reply_content', { id }),
  getReplyContent: (id: number) => invoke<import('./types').MailContent>('get_reply_content', { id }),
  saveReplyAttachment: (id: number, index: number, path: string) => invoke<void>('save_reply_attachment', { id, index, path }),
  openMailLink: (url: string) => invoke<void>('open_mail_link', { url }),
  dashboard: (replyKind = '') => invoke<Dashboard>('get_dashboard', { replyKind: replyKind || null }),
  runningTaskCount: () => invoke<number>('running_task_count'),
  getStats,

  listAccounts: () => invoke<Account[]>('list_accounts'),
  addAccount: (input: AccountInput) => invoke<number>('add_account', { input }),
  updateAccount: (id: number, input: AccountInput) => invoke('update_account', { id, input }),
  deleteAccount: (id: number) => invoke('delete_account', { id }),
  toggleAccount: (id: number, enabled: boolean) => invoke('toggle_account', { id, enabled }),
  testAccount: (id: number) => invoke<string>('test_account', { id }),
  sendTestEmail: (accountId: number, manuscriptId: number | null, attachment: { name: string; data?: number[]; token?: string } | null, recipient: string, senderName: string, subject: string, body: string, contentType: string) =>
    invoke<string>('send_test_email', { accountId, manuscriptId, attachment, recipient, senderName, subject, body, contentType }),

  listManuscripts: (summary = false) => invoke<Manuscript[]>('list_manuscripts', { summary }),
  getManuscript: (id: number) => invoke<Manuscript | null>('get_manuscript', { id }),
  addManuscript: (input: ManuscriptInput) => invoke<number>('add_manuscript', { input }),
  updateManuscript: (id: number, input: ManuscriptInput) => invoke('update_manuscript', { id, input }),
  deleteManuscript: (id: number) => changesStats(invoke('delete_manuscript', { id })),

  listAcceptedWorks: (summary = false) => invoke<AcceptedWork[]>('list_accepted_works', { summary }),
  getAcceptedWork: (id: number) => invoke<AcceptedWork>('get_accepted_work', { id }),
  listAcceptedCandidates: () => invoke<AcceptedCandidate[]>('list_accepted_candidates'),
  addAcceptedWork: (input: AcceptedWorkInput) => invoke<number>('add_accepted_work', { input }),
  updateAcceptedWork: (id: number, input: AcceptedWorkInput) => invoke<void>('update_accepted_work', { id, input }),
  deleteAcceptedWork: (id: number) => invoke<void>('delete_accepted_work', { id }),
  getAcceptedWorkDocument: (id: number) => invoke<AcceptedWorkDocument>('get_accepted_work_document', { id }),
  exportAcceptedWorkDocument: (id: number, path: string) => invoke<string>('export_accepted_work_document', { id, path }),
  openSavedDocument: (id: number, source: 'accepted' | 'manuscript', reveal: boolean) =>
    invoke<string>('open_saved_document', { id, source, reveal }),
  saveAcceptedShareImage: (path: string, data: Uint8Array) => invokeBinary<string>('save_accepted_share_image', data, { path }),

  listTasks: () => invoke<Task[]>('list_tasks'),
  createTask: (input: TaskInput) => invoke<{ id: number; start_error: string | null }>('create_task', { input }),
  updateTask: (id: number, input: TaskInput) => invoke('update_task', { id, input }),
  createWasteDraftTask: (manuscriptId: number) =>
    invoke<number>('create_waste_draft_task', { manuscriptId }),
  updateTaskAccounts: (id: number, accountIds: number[]) => invoke('update_task_accounts', { id, accountIds }),
  deleteTask: (id: number) => invoke('delete_task', { id }),
  startTask: (id: number) => invoke('start_task', { id }),
  pauseTask: (id: number) => invoke('pause_task', { id }),
  resumeTask: (id: number) => invoke('resume_task', { id }),
  stopTask: (id: number) => invoke('stop_task', { id }),

  listLogOptions: () => invoke<{ tasks: Array<{ id: number; name: string }>; manuscripts: Array<{ id: number; name: string }>; accounts: Array<{ id: number; name: string }> }>('list_log_options'),
  listLogs: (taskId?: number, limit = 300) => invoke<TaskLog[]>('list_logs', { taskId: taskId ?? null, limit, offset: 0 }),
  listLogsPage: (taskId: number | '', level: string, query: string, limit: number, offset: number) =>
    invoke<{ items: TaskLog[]; total: number }>('list_logs_page', { taskId: taskId || null, level: level || null, query, limit, offset }),
  clearLogs: (taskId?: number) => changesStats(invoke('clear_logs', { taskId: taskId ?? null })),
  exportLogs: (path: string, taskId?: number, level?: string, query?: string) =>
    invoke<string>('export_logs', { path, taskId: taskId ?? null, level: level || null, query: query || null }),

  getSettings: () => invoke<Settings>('get_settings'),
  updateSettings: (settings: Settings) => invoke('update_settings', { settings }),
  getDefaultMailTemplates: () => invoke<MailTemplate[]>('get_default_mail_templates'),
  saveDefaultMailTemplates: (templates: MailTemplate[]) => invoke('save_default_mail_templates', { templates }),
  setAutostart: (enabled: boolean) => invoke('set_autostart', { enabled }),
  storageSummary: () => invoke<import('./types').StorageSummary>('get_storage_summary'),
  cleanStorage: (scope: 'mail_cache' | 'backups', keep: number) => invoke<number>('clean_storage', { scope, keep }),
  backup: () => invoke<string>('backup_data'),
  getInboxStatus: () => invoke<import('./types').InboxStatus[]>('get_inbox_status'),
  takeTrayInboxRequest: () => invoke<boolean>('take_tray_inbox_request'),
  unreadHumanReplyCount: () => invoke<number>('unread_human_reply_count'),
  listReplies: (kind?: string, taskId?: number) => invoke<Reply[]>('list_replies', { kind: kind || null, taskId: taskId || null }),
  listRepliesPage: (kind: string, taskId: number | '', query: string, limit: number, offset: number, accountId: number | '' = '') =>
    invoke<{ items: Reply[]; total: number }>('list_replies_page', { kind: kind || null, taskId: taskId || null, query, limit, offset, accountId: accountId || null }),
  setReplyRead: (id: number, isRead: boolean) => invoke<void>('set_reply_read', { id, isRead }),
  syncReplyReadFlags: (ids: number[]) => invoke<{ states: Array<{ id: number; is_read: boolean; read_synced: boolean }>; errors: Array<{ account_id: number; email: string; message: string }> }>('sync_reply_read_flags', { ids }),
  scanReplies: () => invoke<number>('scan_replies'),
  reclassifyReplies: () => changesStats(invoke<number>('reclassify_replies')),
  stageAttachment: (bytes: Uint8Array, extension: string) => invokeBinary<{ token: string; word_count: number }>('stage_attachment', bytes, { extension }),
  releaseAttachment: (token: string) => invoke<void>('release_attachment', { token }),
  extractDocx: (data: number[]) => invoke<string>('extract_docx_text', { data }),
  listDeliveries: (manuscriptId?: number) => invoke<Delivery[]>('list_deliveries', { manuscriptId: manuscriptId ?? null }),
  deliverySummaryPage: (manuscriptId: number, emails: string[], matching: number[], filter: string, limit: number, offset: number) =>
    invoke<DeliverySummaryPage>('delivery_summary_page', { manuscriptId, emails, matching, filter, limit, offset }),
  listPendingSends: (manuscriptId: number) => invoke<PendingSend[]>('list_pending_sends', { manuscriptId }),
  resolvePendingSend: (id: number, sent: boolean) => invoke('resolve_pending_send', { id, sent }),
  resendDelivery: (deliveryId: number) => invoke('resend_delivery', { deliveryId }),
  sendManualDelivery: (manuscriptId: number, recipient: string, accountIds: number[]) =>
    invoke('send_manual_delivery', { manuscriptId, recipient, accountIds }),

  listEditors: (refresh = false) => editorCache.read(refresh),
  listEditorGroups: (refresh = false) => groupCache.read(refresh),
  createEditorGroup: (input: EditorGroupInput) => editLibrary(invoke<number>('create_editor_group', { input })),
  updateEditorGroup: (id: number, input: EditorGroupInput) => editLibrary(invoke('update_editor_group', { id, input })),
  deleteEditorGroup: (id: number) => editLibrary(invoke('delete_editor_group', { id })),
  exportEditorGroups: (path: string, groupIds: number[]) => invoke<string>('export_editor_groups', { path, groupIds }),
  importEditorGroups: (data: Uint8Array, fileName: string) => editLibrary(invokeBinary<EditorGroupImportResult>('import_editor_groups', data, { file_name: fileName })),
  addEditor: (input: EditorInput) => editLibrary(invoke<number>('add_editor', { input })),
  updateEditor: (id: number, input: EditorInput) => editLibrary(invoke('update_editor', { id, input })),
  toggleEditorFavorite: (id: number) => editLibrary(invoke<boolean>('toggle_editor_favorite', { id })),
  deleteEditor: (id: number) => editLibrary(invoke('delete_editor', { id })),
  clearEditors: () => editLibrary(invoke<number>('clear_editors')),
  exportEditors: (path: string) => invoke<string>('export_editors', { path }),
  importEditors: (data: Uint8Array, fileName: string) => editLibrary(invokeBinary<EditorImportResult>('import_editors', data, { file_name: fileName })),
  importDefaultEditors: () => editLibrary(invoke<EditorImportResult>('import_default_editors')),
}

function safeListen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => { if (event === 'log' || event === 'reply' || event === 'task') invalidateStats(); cb(e.payload) }).then((unlisten) => {
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

export function onReplyReadChange(cb: (value: null) => void): Promise<UnlistenFn> {
  return safeListen('reply-read-change', cb)
}

export function onOpenUnreadInbox(cb: (value: null) => void): Promise<UnlistenFn> {
  return safeListen('open-unread-inbox', cb)
}

export function onInboxStatus(cb: (value: import('./types').InboxStatus[]) => void): Promise<UnlistenFn> { return safeListen('inbox-status', cb) }
