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
    /// 今日已成功发出的邮件数（投递记录，不入库）。
    #[serde(default)]
    pub sent_today: i64,
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
    /// 旧版分钟档位，仅为旧数据和旧客户端兼容保留。
    #[serde(default = "default_send_interval_min")]
    pub send_interval_min: i64,
    /// 每封发送后的随机等待下限（秒）。
    #[serde(default = "default_send_interval_from_sec")]
    pub send_interval_from_sec: i64,
    /// 每封发送后的随机等待上限（秒）。
    #[serde(default = "default_send_interval_to_sec")]
    pub send_interval_to_sec: i64,
    #[serde(default)]
    pub subject: String,
    /// 多套邮件标题/正文。默认在发送时随机选用一套。
    #[serde(default)]
    pub mail_templates: Vec<MailTemplate>,
    /// 固定使用的邮件模板 ID；空字符串表示每封随机选择。
    #[serde(default)]
    pub fixed_mail_template_id: String,
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
    /// 旧版分钟档位，仅为旧客户端兼容保留。
    #[serde(default = "default_send_interval_min")]
    pub send_interval_min: i64,
    /// 每封发送后的随机等待下限（秒）。
    #[serde(default = "default_send_interval_from_sec")]
    pub send_interval_from_sec: i64,
    /// 每封发送后的随机等待上限（秒）。
    #[serde(default = "default_send_interval_to_sec")]
    pub send_interval_to_sec: i64,
    #[serde(default)]
    pub subject: String,
    /// 多套邮件标题/正文。默认在发送时随机选用一套。
    #[serde(default)]
    pub mail_templates: Vec<MailTemplate>,
    /// 固定使用的邮件模板 ID；空字符串表示每封随机选择。
    #[serde(default)]
    pub fixed_mail_template_id: String,
    #[serde(default)]
    pub file_name: String,
    /// 上传的附件文件内容（Word / 文本）。None 表示无附件；更新时 None 保留原附件。
    #[serde(default)]
    pub file_data: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MailTemplate {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
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
    pub manuscript_id: Option<i64>,
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

fn default_true() -> bool {
    true
}
fn default_editor_source() -> String {
    EDITOR_SOURCE_MANUAL.to_string()
}
fn default_imap_port() -> u16 {
    993
}
fn default_reply_poll() -> i64 {
    2
}
fn default_send_interval_min() -> i64 {
    3
}

pub const DEFAULT_SEND_INTERVAL_FROM_SEC: i64 = 100;
pub const DEFAULT_SEND_INTERVAL_TO_SEC: i64 = 240;
pub const MAX_SEND_INTERVAL_SEC: i64 = 86_400;

fn default_send_interval_from_sec() -> i64 {
    DEFAULT_SEND_INTERVAL_FROM_SEC
}

fn default_send_interval_to_sec() -> i64 {
    DEFAULT_SEND_INTERVAL_TO_SEC
}

pub fn normalize_send_interval_secs(from_sec: i64, to_sec: i64) -> (i64, i64) {
    let from = if from_sec > 0 {
        from_sec.clamp(1, MAX_SEND_INTERVAL_SEC)
    } else {
        DEFAULT_SEND_INTERVAL_FROM_SEC
    };
    let to = if to_sec > 0 {
        to_sec.clamp(1, MAX_SEND_INTERVAL_SEC)
    } else {
        DEFAULT_SEND_INTERVAL_TO_SEC
    };
    (from.min(to), from.max(to))
}

/// 写回一个最接近的旧版档位，方便旧版本回退读取。
pub fn legacy_send_interval_min(from_sec: i64, to_sec: i64) -> i64 {
    let (from, to) = normalize_send_interval_secs(from_sec, to_sec);
    let average = (from + to) / 2;
    [1_i64, 2, 3, 5, 8]
        .into_iter()
        .min_by_key(|minutes| (minutes * 60 - average).abs())
        .unwrap_or(3)
}

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

const EDITOR_DROPPED_TAGS: &[&str] = &["小程序", "知乎风", "番茄风"];
pub const EDITOR_SOURCE_INITIAL: &str = "初始数据";
pub const EDITOR_SOURCE_MANUAL: &str = "手动数据";
pub const EDITOR_SOURCE_IMPORT: &str = "导入数据";

pub fn normalize_editor_source(value: &str) -> String {
    match value.trim() {
        EDITOR_SOURCE_INITIAL | EDITOR_SOURCE_MANUAL | EDITOR_SOURCE_IMPORT => {
            value.trim().to_string()
        }
        _ => EDITOR_SOURCE_MANUAL.to_string(),
    }
}

pub fn normalize_editor_work_types(tags: &[String]) -> Vec<String> {
    let mut types = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for raw in tags {
        let tag = raw.trim();
        if tag.is_empty() || EDITOR_DROPPED_TAGS.contains(&tag) {
            continue;
        }
        let aliases: &[&str] = match tag {
            "中短" => &["中短篇"],
            "全品类短篇" | "全品类短篇（题材不限）" => &["全品类", "短篇"],
            "全品类（主收情绪流追妻+追夫）" => &["全品类", "情绪流", "追妻", "追夫"],
            "全品类（偏爱爽文）" => &["全品类", "爽文"],
            "女频全品类" => &["女频", "全品类"],
            "知乎全品类" => &["知乎", "全品类"],
            "虐恋等全品类" => &["虐恋", "全品类"],
            "追夫追妻小程序全品类" => &["追夫", "追妻", "全品类"],
            "2万字以上中短" => &["中短篇"],
            "一万字短篇小程序方向：追妻虐爽" => &["短篇", "追妻", "爽文"],
            "下沉世情" | "世情亲情" => &["世情"],
            "世情古言大女主虐爽" => &["世情", "古言", "大女主", "爽文"],
            "世情废稿" => &["世情", "废稿"],
            "古穿今" => &["穿越"],
            "复仇" | "逆袭" => &["爽文"],
            "大女主爽文短片" => &["大女主", "爽文", "短篇"],
            "大女主追妻" => &["大女主", "追妻"],
            "女频追妻" => &["女频", "追妻"],
            "小甜文" | "甜文装穷梗" => &["甜宠"],
            "微悬疑" | "惊悚" => &["悬疑"],
            "快节奏追妻脑洞文" => &["追妻", "脑洞"],
            "现代短篇小说（题材不限）" => &["全品类", "短篇", "现言"],
            "现言追妻" => &["现言", "追妻"],
            "短篇女频" => &["短篇", "女频"],
            "短篇爽文" => &["短篇", "爽文"],
            "虐文" => &["虐恋"],
            "虐爽文" => &["虐恋", "爽文"],
            "言情中短" => &["言情", "中短篇"],
            "追夫虐爽" => &["追夫", "虐恋", "爽文"],
            "追夫追妻" => &["追夫", "追妻"],
            "追妻古言脑洞" => &["追妻", "古言", "脑洞"],
            "七猫风"
            | "点众风"
            | "大尺度小程序风"
            | "区别对待"
            | "嫡姐"
            | "庶妹"
            | "开学"
            | "暑假"
            | "热点"
            | "番茄"
            | "职场" => &[],
            _ => std::slice::from_ref(&tag),
        };
        for alias in aliases {
            if seen.insert((*alias).to_string()) {
                types.push((*alias).to_string());
            }
        }
    }
    types
}

const REJECTED_TYPE_ALIASES: &[(&str, &str)] =
    &[("纯世情", "世情"), ("甜文", "甜宠"), ("同人类型", "同人")];

const KNOWN_REJECTED_TYPES: &[&str] = &[
    "短篇",
    "中短篇",
    "女频",
    "男频",
    "全品类",
    "追妻",
    "追夫",
    "世情",
    "爽文",
    "脑洞",
    "古言",
    "现言",
    "悬疑",
    "年代",
    "情绪流",
    "都市",
    "亲情虐",
    "大女主",
    "玄幻",
    "重生",
    "打脸",
    "种田",
    "末世",
    "甜宠",
    "宅斗",
    "宫斗",
    "萌宝",
    "校园",
    "仙侠",
    "穿越",
    "穿书",
    "总裁",
    "婚恋",
    "虐恋",
    "全员背叛",
    "言情",
    "性转",
    "死人文学",
    "系统",
    "女强",
    "信息差",
    "散文",
    "童话",
    "诗歌",
    "耽美",
    "百合",
    "同人",
    "剧本",
];

const REJECTED_CLAUSE_STOPS: &[&str] = &[
    "\n",
    "。",
    "；",
    ";",
    "全勤",
    "结算",
    "例文",
    "标签",
    "投稿需",
    "其他类型",
    "其余类型",
    "，收",
    "、收",
];

fn next_reject_marker(text: &str) -> Option<(usize, usize)> {
    let a = text.find("不收").map(|i| (i, "不收".len()));
    let b = text.find("拒收").map(|i| (i, "拒收".len()));
    match (a, b) {
        (Some(left), Some(right)) if left.0 <= right.0 => Some(left),
        (Some(_), Some(right)) => Some(right),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn collect_rejected_tags(
    clause: &str,
    found: &mut Vec<String>,
    seen: &mut std::collections::BTreeSet<String>,
) {
    for (from, mapped) in REJECTED_TYPE_ALIASES {
        if clause.contains(from) && seen.insert((*mapped).to_string()) {
            found.push((*mapped).to_string());
        }
    }
    let hits: Vec<&str> = KNOWN_REJECTED_TYPES
        .iter()
        .copied()
        .filter(|tag| clause.contains(tag))
        .collect();
    for tag in &hits {
        if hits
            .iter()
            .any(|other| *other != *tag && other.contains(tag))
        {
            continue;
        }
        if seen.insert((*tag).to_string()) {
            found.push((*tag).to_string());
        }
    }
}

/// 从收稿说明里抽出「不收 / 拒收」后面的类型标签，供筛选和回填。
pub fn extract_rejected_types_from_notes(notes: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let text = notes.replace('\r', "");
    let mut search = text.as_str();
    while let Some((pos, marker_len)) = next_reject_marker(search) {
        let after = search[pos + marker_len..].trim_start_matches(['：', ':']);
        let end = REJECTED_CLAUSE_STOPS
            .iter()
            .filter_map(|mark| after.find(mark))
            .min()
            .unwrap_or(after.len());
        let clause =
            after[..end].trim_matches([' ', '，', ',', '、', '的', '（', '）', '(', ')', '\t']);
        let consumed = search.len() - after.len() + end;
        search = search.get(consumed..).unwrap_or("");
        if clause.is_empty() {
            continue;
        }
        collect_rejected_tags(clause, &mut found, &mut seen);
    }
    found
}

pub fn canonicalize_editor_platform(raw: &str) -> String {
    let value = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('樂', "乐");
    if value.is_empty() {
        return "未知".to_string();
    }
    if let Some(alias) = editor_platform_alias(&value) {
        return alias.to_string();
    }
    let stripped = strip_platform_suffix(&value);
    if let Some(alias) = editor_platform_alias(&stripped) {
        return alias.to_string();
    }
    if !stripped.is_empty() {
        stripped
    } else {
        value
    }
}

fn editor_platform_alias(value: &str) -> Option<&'static str> {
    Some(match value {
        "九州（一组）" | "九州（二组）" | "九州（海外）" | "九州(一组)" | "九州(二组)"
        | "九州(海外)" => "九州",
        "麦芽5组" => "麦芽",
        "吾里鹿糖" => "吾里",
        "长樂" => "长乐",
        "花不完(刚刚好)" | "花不完（刚刚好）" => "花不完",
        "GoodNovel(海外）" | "GoodNovel(海外)" | "GoodNovel（海外）" | "GoodNovel（海外)" => {
            "GoodNovel"
        }
        "dreame（海外）" | "dreame(海外)" | "dreame（海外)" | "Dreame（海外）" => {
            "Dreame"
        }
        "月下" => "月下小说",
        "四季文学" => "四季",
        "绣球阅读" => "绣球",
        "17K" | "17k" => "17k",
        "长乐文学" | "长樂文学" => "长乐",
        "花不完故事会" => "花不完",
        "吾里文化" | "鹿糖" => "吾里",
        _ => return None,
    })
}

fn strip_platform_suffix(value: &str) -> String {
    let mut out = value.to_string();
    if out.ends_with(')') || out.ends_with('）') {
        if let Some(start) = out.rfind(['(', '（']) {
            out.truncate(start);
            out = out.trim().to_string();
        }
    }
    if let Some(stripped) = out.strip_suffix("组") {
        let bytes = stripped.as_bytes();
        let mut i = bytes.len();
        while i > 0 && bytes[i - 1].is_ascii_digit() {
            i -= 1;
        }
        if i < bytes.len() {
            out = stripped[..i].trim().to_string();
        }
    }
    out
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Editor {
    pub id: i64,
    pub platform: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub work_type: Vec<String>,
    #[serde(default)]
    pub rejected_types: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "default_editor_source")]
    pub source: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub favorited: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EditorInput {
    pub platform: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub work_type: Vec<String>,
    #[serde(default)]
    pub rejected_types: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EditorGroup {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub editor_ids: Vec<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EditorGroupInput {
    pub name: String,
    #[serde(default)]
    pub editor_ids: Vec<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct EditorGroupImportResult {
    pub groups_added: i64,
    pub groups_updated: i64,
    pub editors_added: i64,
}

pub fn default_editor_inputs() -> Result<Vec<EditorInput>, String> {
    serde_json::from_str(include_str!("data/default_editors.json"))
        .map_err(|e| format!("内置编辑库损坏：{e}"))
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
    pub accepted_replies: i64,
    pub tasks: Vec<Task>,
    pub recent_replies: Vec<Reply>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_editor_library_is_valid_and_unique() {
        let editors = default_editor_inputs().unwrap();
        let emails = editors
            .iter()
            .map(|editor| editor.email.trim().to_lowercase())
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(editors.len(), emails.len());
        assert!(editors
            .iter()
            .all(|editor| !editor.platform.trim().is_empty() && !editor.email.trim().is_empty()));
    }

    #[test]
    fn empty_editor_platform_is_unknown() {
        assert_eq!(canonicalize_editor_platform(" \t"), "未知");
    }

    #[test]
    fn singleton_descriptions_collapse_to_standard_filter_tags() {
        let tags = [
            "一万字短篇小程序方向：追妻虐爽",
            "世情古言大女主虐爽",
            "现代短篇小说（题材不限）",
            "七猫风",
            "暑假",
        ]
        .map(str::to_string);

        assert_eq!(
            normalize_editor_work_types(&tags),
            [
                "短篇",
                "追妻",
                "爽文",
                "世情",
                "古言",
                "大女主",
                "全品类",
                "现言"
            ]
        );
    }

    #[test]
    fn editor_work_type_aliases_collapse_to_filter_tags() {
        let tags = [
            "全品类短篇（题材不限）",
            "全品类",
            "短篇",
            "中短",
            "全品类（偏爱爽文）",
            "女频全品类",
            "知乎全品类",
            "虐恋等全品类",
            "追夫追妻小程序全品类",
        ]
        .map(str::to_string);

        assert_eq!(
            normalize_editor_work_types(&tags),
            [
                "全品类",
                "短篇",
                "中短篇",
                "爽文",
                "女频",
                "知乎",
                "虐恋",
                "追夫",
                "追妻"
            ]
        );
    }
}
