export interface Account {
  id: number
  email: string
  password: string
  smtp_host: string
  smtp_port: number
  sender_name: string
  provider: string
  enabled: boolean
  last_sent_at: string | null
  imap_host: string
  imap_port: number
  check_replies: boolean
  imap_uid: number
  created_at: string
}

export interface AccountInput {
  email: string
  password: string
  smtp_host: string
  smtp_port: number
  sender_name: string
  provider: string
  enabled: boolean
  imap_host: string
  imap_port: number
  check_replies: boolean
}

export interface Editor {
  id: number
  platform: string
  name: string
  email: string
  work_type: string[]
  notes: string
  source: string
  enabled: boolean
  favorited: boolean
  created_at: string
  updated_at: string
}

export interface EditorInput {
  platform: string
  name: string
  email: string
  work_type: string[]
  notes: string
}

export interface EditorImportResult {
  added: number
  updated: number
  errors: string[]
}

export interface MailTemplate {
  id: string
  name: string
  subject: string
  body: string
}

export interface Manuscript {
  id: number
  title: string
  body: string
  content_type: string
  recipients: string[]
  sender_name: string
  word_count: number
  category: string
  reader_emotion: string
  style: string
  genres: string[]
  excluded_types?: string[]
  account_ids: number[]
  send_interval_min?: number
  subject: string
  mail_templates?: MailTemplate[]
  file_name: string
  has_file?: boolean
  created_at: string
  updated_at: string
}

export interface ManuscriptInput {
  title: string
  body: string
  content_type: string
  recipients: string[]
  sender_name: string
  word_count: number
  category: string
  reader_emotion: string
  style: string
  genres: string[]
  excluded_types?: string[]
  account_ids: number[]
  send_interval_min?: number
  subject: string
  mail_templates: MailTemplate[]
  file_name: string
  file_data?: number[] | null
  has_file?: boolean
}

export type TaskStatus = 'stopped' | 'scheduled' | 'running' | 'paused' | 'completed'
export type ScheduleType = 'immediate' | 'scheduled' | 'loop'

export interface Task {
  id: number
  name: string
  manuscript_ids: number[]
  account_ids: number[]
  status: TaskStatus
  schedule_type: ScheduleType
  scheduled_at: string | null
  retry_max: number
  sent: number
  total: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface TaskInput {
  name: string
  manuscript_ids: number[]
  account_ids: number[]
  schedule_type: ScheduleType
  scheduled_at: string | null
  retry_max: number
}

export type LogLevel = 'info' | 'success' | 'warning' | 'error'

export interface TaskLog {
  id: number
  task_id: number | null
  account_id: number | null
  level: LogLevel
  category: string
  message: string
  recipient?: string | null
  created_at: string
}

export interface Settings {
  default_retry_max: number
  anti_spam_mutation: boolean
  auto_start: boolean
  close_to_tray: boolean
  auto_backup: boolean
  update_feed_url: string
  reply_poll_minutes: number
}

export interface Dashboard {
  account_count: number
  manuscript_count: number
  editor_count: number
  sent_today: number
  failed_today: number
  running_tasks: number
  human_replies: number
  auto_replies: number
  accepted_replies: number
  tasks: Task[]
  recent_replies: Reply[]
}

export interface Delivery {
  id: number
  task_id: number | null
  account_id: number | null
  manuscript_id: number | null
  recipient: string
  subject: string
  message_id: string
  sent_at: string
}

export type ReplyKind = 'auto' | 'human' | 'bounce'

export interface Reply {
  id: number
  delivery_id: number | null
  account_id: number | null
  task_id: number | null
  from_email: string
  subject: string
  snippet: string
  body: string
  kind: ReplyKind
  reason: string
  accepted: boolean
  message_id: string
  in_reply_to: string
  imap_uid: number
  received_at: string
  created_at: string
  recipient: string
  task_name: string
}

export interface StatsGroup {
  period: string
  deliveries: number
  human_replies: number
  failures: number
  accepted: number
}

export interface StatsReport {
  groups: StatsGroup[]
  totals: StatsGroup
}
