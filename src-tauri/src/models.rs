use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub password: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub sender_name: String,
    pub provider: String,
    pub enabled: bool,
    pub hourly_limit: i64,
    pub daily_limit: i64,
    pub sent_hour: i64,
    pub hour_key: String,
    pub sent_day: i64,
    pub day_key: String,
    pub last_sent_at: Option<String>,
    pub limited: bool,
    pub limited_until: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub check_replies: bool,
    pub imap_uid: i64,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AccountInput {
    pub email: String,
    pub password: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub sender_name: String,
    pub provider: String,
    pub enabled: bool,
    pub hourly_limit: i64,
    pub daily_limit: i64,
    #[serde(default)]
    pub imap_host: String,
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,
    #[serde(default = "default_true")]
    pub check_replies: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manuscript {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub recipients: Vec<String>,
    pub sender_name: String,
    #[serde(default)]
    pub word_count: i64,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub reader_category: String,
    #[serde(default)]
    pub reader_emotion: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub file_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManuscriptInput {
    pub title: String,
    pub body: String,
    pub content_type: String,
    pub recipients: Vec<String>,
    pub sender_name: String,
    #[serde(default)]
    pub word_count: i64,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub reader_category: String,
    #[serde(default)]
    pub reader_emotion: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub file_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: i64,
    pub name: String,
    pub manuscript_ids: Vec<i64>,
    pub status: String,
    pub schedule_type: String,
    pub scheduled_at: Option<String>,
    pub interval_min: i64,
    pub interval_max: i64,
    pub batch_size_min: i64,
    pub batch_size_max: i64,
    pub batch_pause_min: i64,
    pub batch_pause_max: i64,
    pub retry_max: i64,
    pub sent: i64,
    pub total: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaskInput {
    pub name: String,
    pub manuscript_ids: Vec<i64>,
    pub schedule_type: String,
    pub scheduled_at: Option<String>,
    pub interval_min: i64,
    pub interval_max: i64,
    pub batch_size_min: i64,
    pub batch_size_max: i64,
    pub batch_pause_min: i64,
    pub batch_pause_max: i64,
    pub retry_max: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaskLog {
    pub id: i64,
    pub task_id: Option<i64>,
    pub account_id: Option<i64>,
    pub level: String,
    pub category: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub default_interval_min: i64,
    pub default_interval_max: i64,
    pub default_batch_size_min: i64,
    pub default_batch_size_max: i64,
    pub default_batch_pause_min: i64,
    pub default_batch_pause_max: i64,
    pub default_retry_max: i64,
    pub limit_cooldown_minutes: i64,
    pub anti_spam_mutation: bool,
    pub auto_start: bool,
    pub close_to_tray: bool,
    pub auto_backup: bool,
    pub update_feed_url: String,
    #[serde(default = "default_reply_poll")]
    pub reply_poll_minutes: i64,
}

fn default_true() -> bool { true }
fn default_imap_port() -> u16 { 993 }
fn default_reply_poll() -> i64 { 2 }

impl Default for Settings {
    fn default() -> Self {
        Settings {
            default_interval_min: 5,
            default_interval_max: 20,
            default_batch_size_min: 6,
            default_batch_size_max: 8,
            default_batch_pause_min: 180,
            default_batch_pause_max: 300,
            default_retry_max: 3,
            limit_cooldown_minutes: 60,
            anti_spam_mutation: true,
            auto_start: false,
            close_to_tray: true,
            auto_backup: false,
            update_feed_url: String::new(),
            reply_poll_minutes: 2,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Editor {
    pub id: i64,
    pub platform: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub directions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EditorInput {
    pub platform: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub directions: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct EditorImportResult {
    pub added: i64,
    pub updated: i64,
    pub errors: Vec<String>,
}

#[derive(Serialize)]
pub struct Dashboard {
    pub account_count: i64,
    pub manuscript_count: i64,
    #[serde(default)]
    pub editor_count: i64,
    pub sent_today: i64,
    pub failed_today: i64,
    pub running_tasks: i64,
    pub human_replies: i64,
    pub auto_replies: i64,
    pub tasks: Vec<Task>,
    pub logs: Vec<TaskLog>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Delivery {
    pub id: i64,
    pub task_id: Option<i64>,
    pub account_id: Option<i64>,
    pub manuscript_id: Option<i64>,
    pub recipient: String,
    pub subject: String,
    pub message_id: String,
    pub sent_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Reply {
    pub id: i64,
    pub delivery_id: Option<i64>,
    pub account_id: Option<i64>,
    pub task_id: Option<i64>,
    pub from_email: String,
    pub subject: String,
    pub snippet: String,
    pub body: String,
    pub kind: String,
    pub reason: String,
    pub message_id: String,
    pub in_reply_to: String,
    pub imap_uid: i64,
    pub received_at: String,
    pub created_at: String,
    pub recipient: String,
    pub task_name: String,
}
