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
    pub last_sent_at: Option<String>,
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
    /// 排除的作品类型（不参与匹配筛选），随计划持久化。
    #[serde(default)]
    pub excluded_types: Vec<String>,
    /// 计划指定的投稿邮箱（留空表示使用全部启用邮箱）。
    #[serde(default)]
    pub account_ids: Vec<i64>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub file_name: String,
    /// 是否存有附件文件内容（列表查询用，不携带实际字节）。
    #[serde(default)]
    pub has_file: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 测试发送时附带附件：文件名 + 文件内容字节。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AttachmentInput {
    pub name: String,
    pub data: Vec<u8>,
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
    /// 排除的作品类型（不参与匹配筛选），随计划持久化。
    #[serde(default)]
    pub excluded_types: Vec<String>,
    /// 计划指定的投稿邮箱（留空表示使用全部启用邮箱）。
    #[serde(default)]
    pub account_ids: Vec<i64>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub file_name: String,
    /// 上传的附件文件内容（Word / 文本）。None 表示无附件；更新时 None 保留原附件。
    #[serde(default)]
    pub file_data: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: i64,
    pub name: String,
    pub manuscript_ids: Vec<i64>,
    #[serde(default)]
    pub account_ids: Vec<i64>,
    pub status: String,
    pub schedule_type: String,
    pub scheduled_at: Option<String>,
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
    #[serde(default)]
    pub account_ids: Vec<i64>,
    pub schedule_type: String,
    pub scheduled_at: Option<String>,
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
    /// 收件人（编辑）邮箱，仅发送类日志有值。
    pub recipient: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub default_retry_max: i64,
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
            default_retry_max: 3,
            anti_spam_mutation: true,
            auto_start: false,
            close_to_tray: true,
            auto_backup: false,
            update_feed_url: String::new(),
            reply_poll_minutes: 2,
        }
    }
}

pub const EDITOR_STYLES: &[&str] = &["小程序", "知乎风", "番茄风"];

pub fn split_editor_tags(style: &[String], work_type: &[String]) -> (Vec<String>, Vec<String>) {
    let mut styles = Vec::new();
    let mut types = Vec::new();
    let mut seen_style = std::collections::BTreeSet::new();
    let mut seen_type = std::collections::BTreeSet::new();
    for raw in style.iter().chain(work_type.iter()) {
        let tag = raw.trim();
        if tag.is_empty() {
            continue;
        }
        if EDITOR_STYLES.contains(&tag) {
            if seen_style.insert(tag.to_string()) {
                styles.push(tag.to_string());
            }
        } else if seen_type.insert(tag.to_string()) {
            types.push(tag.to_string());
        }
    }
    (styles, types)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Editor {
    pub id: i64,
    pub platform: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub style: Vec<String>,
    #[serde(default)]
    pub work_type: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EditorInput {
    pub platform: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub style: Vec<String>,
    #[serde(default)]
    pub work_type: Vec<String>,
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

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct StatsGroup {
    pub period: String,
    pub deliveries: i64,
    pub human_replies: i64,
    pub failures: i64,
    pub accepted: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct StatsReport {
    pub groups: Vec<StatsGroup>,
    pub totals: StatsGroup,
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
    pub accepted: bool,
    pub message_id: String,
    pub in_reply_to: String,
    pub imap_uid: i64,
    pub received_at: String,
    pub created_at: String,
    pub recipient: String,
    pub task_name: String,
}
