export interface Account {
  id: number
  email: string
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
  imap_uid_validity?: number
  imap_generation?: number
  created_at: string
  sent_today?: number
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
  rejected_types?: string[]
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
  rejected_types?: string[]
  notes: string
}

export interface EditorGroup {
  id: number
  name: string
  editor_ids: number[]
  created_at: string
  updated_at: string
}

export interface EditorGroupInput {
  name: string
  editor_ids: number[]
}

export interface EditorGroupImportResult {
  groups_added: number
  groups_updated: number
  editors_added: number
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
  send_interval_from_sec?: number
  send_interval_to_sec?: number
  subject: string
  mail_templates?: MailTemplate[]
  fixed_mail_template_id?: string
  file_name: string
  has_file?: boolean
  created_at: string
  updated_at: string
}

export type ManuscriptSummary = Omit<Manuscript, 'body' | 'mail_templates'>

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
  send_interval_from_sec: number
  send_interval_to_sec: number
  subject: string
  mail_templates: MailTemplate[]
  fixed_mail_template_id: string
  file_name: string
  file_data?: number[] | null
  file_token?: string | null
  has_file?: boolean
}

export type AcceptedDealMode = 'undecided' | 'buyout' | 'guarantee_share' | 'platform_share'
export type AcceptedReviewStatus = 'accepted' | 'preliminary' | 'final_rejected' | 'not_accepted'
export interface AcceptedMonthlySettlement { month: string; amount_cents: number }

export interface AcceptedWork {
  id: number
  manuscript_id: number | null
  source: 'plan' | 'external'
  review_status: AcceptedReviewStatus
  title: string
  body: string
  file_name: string
  has_file: boolean
  accepted_at: string
  sold_at: string
  deal_mode: AcceptedDealMode
  price_cents: number
  guarantee_cents: number
  per_thousand_cents: number
  realized_share_cents: number
  monthly_settlements: AcceptedMonthlySettlement[]
  share_percent: number
  sale_platform: string
  buyer_editor: string
  listing_platform: string
  article_url: string
  notes: string
  record_origin: 'manual' | 'historical_import'
  created_at: string
  updated_at: string
}

export type AcceptedWorkSummary = Omit<AcceptedWork, 'body'>

export interface AcceptedWorkInput {
  manuscript_id: number | null
  source: 'plan' | 'external'
  review_status: AcceptedReviewStatus
  title: string
  body: string
  file_name: string
  file_data?: number[] | null
  file_token?: string | null
  remove_file: boolean
  accepted_at: string
  deal_mode: AcceptedDealMode
  price_cents: number
  guarantee_cents: number
  per_thousand_cents: number
  realized_share_cents: number
  monthly_settlements: AcceptedMonthlySettlement[]
  share_percent: number
  sale_platform: string
  buyer_editor: string
  listing_platform: string
  article_url: string
  notes: string
}

export interface AcceptedCandidate {
  manuscript_id: number
  title: string
  received_at: string
  sale_platform: string
  buyer_editor: string
}

export interface AcceptedWorkDocument {
  title: string
  body: string
  file_name: string
  attachment_text: string
  has_file: boolean
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
  manuscript_id: number | null
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
  auto_reply_subject_keywords: string[]
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
  is_read: boolean
  read_synced: boolean
  message_id: string
  in_reply_to: string
  imap_uid: number
  imap_uid_validity?: number
  imap_generation?: number
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

export interface DeliverySummaryPage {
  items: { row_index: number; sent_count: number; latest_id: number | null; last_sent_at: string | null }[]
  total: number
  sent_total: number
}
export interface PendingSend {
  id: number; task_id: number | null; account_id: number; manuscript_id: number
  recipient: string; subject: string; message_id: string; created_at: string; account_email: string
}

export interface InboxStatus {
  account_id: number
  mode: 'syncing' | 'connecting' | 'idle' | 'polling' | 'ready' | 'retrying'
  detail: string
  last_sync: string | null
}

export interface MailAddress { name: string; email: string }
export interface MailAttachment { index: number; name: string; mime: string; size: number; content_id: string }
export interface MailContent {
  from: MailAddress[]; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; reply_to: MailAddress[];
  sent_at: string; text: string; html: string; attachments: MailAttachment[];
  inline_images: Record<string,string>; complete: boolean; warning?: string | null;
}

export interface StorageSummary {
  database_bytes: number
  cache_bytes: number
  cache_messages: number
  protected_messages: number
  backup_bytes: number
  backup_count: number
}
