export interface Account {
  id: number
  email: string
  password: string
  smtp_host: string
  smtp_port: number
  sender_name: string
  provider: string
  enabled: boolean
  hourly_limit: number
  daily_limit: number
  sent_hour: number
  hour_key: string
  sent_day: number
  day_key: string
  last_sent_at: string | null
  limited: boolean
  limited_until: string | null
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
  hourly_limit: number
  daily_limit: number
  imap_host: string
  imap_port: number
  check_replies: boolean
}

export interface Editor {
  id: number
  platform: string
  name: string
  email: string
  directions: string[]
  created_at: string
  updated_at: string
}

export interface EditorInput {
  platform: string
  name: string
  email: string
  directions: string[]
}

export interface EditorImportResult {
  added: number
  updated: number
  errors: string[]
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
  reader_category: string
  reader_emotion: string
  style: string
  genres: string[]
  subject: string
  file_name: string
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
  reader_category: string
  reader_emotion: string
  style: string
  genres: string[]
  subject: string
  file_name: string
}

export type TaskStatus = 'stopped' | 'scheduled' | 'running' | 'paused' | 'completed'
export type ScheduleType = 'immediate' | 'scheduled' | 'loop'

export interface Task {
  id: number
  name: string
  manuscript_ids: number[]
  status: TaskStatus
  schedule_type: ScheduleType
  scheduled_at: string | null
  interval_min: number
  interval_max: number
  batch_size_min: number
  batch_size_max: number
  batch_pause_min: number
  batch_pause_max: number
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
  schedule_type: ScheduleType
  scheduled_at: string | null
  interval_min: number
  interval_max: number
  batch_size_min: number
  batch_size_max: number
  batch_pause_min: number
  batch_pause_max: number
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
  created_at: string
}

export interface Settings {
  default_interval_min: number
  default_interval_max: number
  default_batch_size_min: number
  default_batch_size_max: number
  default_batch_pause_min: number
  default_batch_pause_max: number
  default_retry_max: number
  limit_cooldown_minutes: number
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
  tasks: Task[]
  logs: TaskLog[]
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
  message_id: string
  in_reply_to: string
  imap_uid: number
  received_at: string
  created_at: string
  recipient: string
  task_name: string
}
