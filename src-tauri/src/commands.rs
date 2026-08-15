use std::time::{SystemTime, UNIX_EPOCH};

use calamine::Reader;
use rusqlite::OptionalExtension;
use rust_xlsxwriter::Workbook;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::models::{AccountInput, Dashboard, EditorImportResult, EditorInput, Manuscript, Settings, TaskInput, TaskLog};
use crate::smtp;
use crate::state::AppState;
use crate::{scheduler, store};

// ---------- Dashboard ----------

#[tauri::command]
pub fn get_dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let count = |table: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())
    };
    let sent_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task_logs WHERE level = 'success' AND category = 'send'
             AND date(created_at) = date('now','localtime')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let failed_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task_logs WHERE level = 'error' AND category IN ('network', 'send')
             AND date(created_at) = date('now','localtime')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let running_tasks: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks WHERE status = 'running'", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let account_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM accounts WHERE enabled = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut tasks = store::load_tasks(&conn)?;
    tasks.truncate(20);
    let logs = store::load_logs(&conn, None, 50, 0)?;
    let human_replies = store::count_replies(&conn, "human").unwrap_or(0);
    let auto_replies = store::count_replies(&conn, "auto").unwrap_or(0);
    Ok(Dashboard {
        account_count,
        manuscript_count: count("manuscripts")?,
        editor_count: count("editors").unwrap_or(0),
        sent_today,
        failed_today,
        running_tasks,
        human_replies,
        auto_replies,
        tasks,
        logs,
    })
}

// ---------- Accounts ----------

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<crate::models::Account>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_accounts(&conn)
}

#[tauri::command]
pub fn add_account(
    state: State<'_, AppState>,
    input: AccountInput,
) -> Result<i64, String> {
    validate_account(&input)?;
    let (imap_host, imap_port) = resolve_imap(&input);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO accounts (email, password, smtp_host, smtp_port, sender_name, provider, enabled, hourly_limit, daily_limit, imap_host, imap_port, check_replies)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            input.email.trim(),
            input.password,
            input.smtp_host.trim(),
            input.smtp_port,
            input.sender_name.trim(),
            input.provider,
            input.enabled as i64,
            input.hourly_limit,
            input.daily_limit,
            imap_host,
            imap_port,
            input.check_replies as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_account(
    state: State<'_, AppState>,
    id: i64,
    input: AccountInput,
) -> Result<(), String> {
    validate_account(&input)?;
    let (imap_host, imap_port) = resolve_imap(&input);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts SET email = ?1, password = ?2, smtp_host = ?3, smtp_port = ?4,
                sender_name = ?5, provider = ?6, enabled = ?7, hourly_limit = ?8, daily_limit = ?9,
                imap_host = ?10, imap_port = ?11, check_replies = ?12
         WHERE id = ?13",
        rusqlite::params![
            input.email.trim(),
            input.password,
            input.smtp_host.trim(),
            input.smtp_port,
            input.sender_name.trim(),
            input.provider,
            input.enabled as i64,
            input.hourly_limit,
            input.daily_limit,
            imap_host,
            imap_port,
            input.check_replies as i64,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_account(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_account(state: State<'_, AppState>, id: i64, enabled: bool) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts SET enabled = ?1 WHERE id = ?2",
        [enabled as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn test_account(state: State<'_, AppState>, id: i64) -> Result<String, String> {
    let account = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_account(&conn, id)?.ok_or("账号不存在")?
    };
    match smtp::send_email(
        &account,
        &account.email,
        &account.sender_name,
        "熊猫投稿 连通性测试",
        "这是一封来自熊猫投稿的连通性测试邮件，收到说明 SMTP 配置正确。",
        "text/plain",
        None,
    )
    .await
    {
        Ok(_) => Ok(format!("连接成功：测试邮件已发送到 {}", account.email)),
        Err(err) => {
            let (_, msg) = smtp::classify_error(&err);
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn send_test_email(
    state: State<'_, AppState>,
    account_id: i64,
    manuscript_id: Option<i64>,
    attachment: Option<crate::models::AttachmentInput>,
    recipient: String,
    sender_name: String,
    subject: String,
    body: String,
    content_type: String,
) -> Result<String, String> {
    let account = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_account(&conn, account_id)?.ok_or("账号不存在")?
    };
    // 未指定收件人时发给自己，测试邮件绝不发给编辑。
    let to = if recipient.trim().is_empty() {
        account.email.clone()
    } else {
        recipient.trim().to_string()
    };
    // 附件：优先用前端传入的字节（新计划还没入库）；没传时若有稿件 id，则读数据库里已保存的附件。
    let attachment_data: Option<(String, Vec<u8>)> = if let Some(att) = attachment {
        Some((att.name, att.data))
    } else if let Some(mid) = manuscript_id {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_manuscript_attachment(&conn, mid).unwrap_or(None)
    } else {
        None
    };
    crate::smtp::parse_mailbox(&to).map_err(|_| "收件人地址格式不对".to_string())?;
    match crate::smtp::send_email(
        &account,
        &to,
        if sender_name.trim().is_empty() { &account.sender_name } else { &sender_name },
        &subject,
        &body,
        &content_type,
        attachment_data.as_ref().map(|(name, data)| (name.as_str(), data.as_slice())),
    )
    .await
    {
        Ok(_) => Ok(if attachment_data.is_some() {
            format!("测试邮件已发送到 {}（含附件）", to)
        } else {
            format!("测试邮件已发送到 {}", to)
        }),
        Err(err) => {
            let (_, msg) = crate::smtp::classify_error(&err);
            Err(msg)
        }
    }
}

fn resolve_imap(input: &AccountInput) -> (String, u16) {
    if !input.imap_host.trim().is_empty() {
        return (input.imap_host.trim().to_string(), if input.imap_port == 0 { 993 } else { input.imap_port });
    }
    match input.provider.as_str() {
        "qq" => ("imap.qq.com".into(), 993),
        "163" => ("imap.163.com".into(), 993),
        _ => (String::new(), 993),
    }
}

fn validate_account(input: &AccountInput) -> Result<(), String> {
    if input.email.trim().is_empty() || !input.email.contains('@') {
        return Err("请输入有效的邮箱地址".into());
    }
    if input.password.trim().is_empty() {
        return Err("请输入 SMTP 授权码".into());
    }
    if input.smtp_host.trim().is_empty() {
        return Err("请输入 SMTP 服务器地址".into());
    }
    Ok(())
}

// ---------- Editors ----------

fn normalize_editor_input(input: &crate::models::EditorInput) -> crate::models::EditorInput {
    let (style, work_type) = crate::models::split_editor_tags(&input.style, &input.work_type);
    crate::models::EditorInput {
        platform: input.platform.clone(),
        name: input.name.clone(),
        email: input.email.clone(),
        style,
        work_type,
    }
}

fn validate_editor(input: &crate::models::EditorInput) -> Result<crate::models::EditorInput, String> {
    let input = normalize_editor_input(input);
    if input.email.trim().is_empty() || !input.email.contains('@') {
        return Err("请填写有效的收稿邮箱".into());
    }
    if !input.style.iter().any(|d| !d.trim().is_empty())
        && !input.work_type.iter().any(|d| !d.trim().is_empty())
    {
        return Err("请至少填一个风格或作品类型".into());
    }
    Ok(input)
}

#[tauri::command]
pub fn list_editors(state: State<'_, AppState>) -> Result<Vec<crate::models::Editor>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut editors = store::load_editors(&conn)?;
    for editor in &mut editors {
        let (style, work_type) = crate::models::split_editor_tags(&editor.style, &editor.work_type);
        editor.style = style;
        editor.work_type = work_type;
    }
    Ok(editors)
}

#[tauri::command]
pub fn add_editor(
    state: State<'_, AppState>,
    input: crate::models::EditorInput,
) -> Result<i64, String> {
    let input = validate_editor(&input)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let style = json!(input.style).to_string();
    let work_type = json!(input.work_type).to_string();
    conn.execute(
        "INSERT INTO editors (platform, name, email, style, work_type)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            input.platform.trim(),
            input.name.trim(),
            input.email.trim().to_lowercase(),
            style,
            work_type
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "这个邮箱已经在编辑库里了".into()
        } else {
            e.to_string()
        }
    })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_editor(
    state: State<'_, AppState>,
    id: i64,
    input: crate::models::EditorInput,
) -> Result<(), String> {
    let input = validate_editor(&input)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let style = json!(input.style).to_string();
    let work_type = json!(input.work_type).to_string();
    conn.execute(
        "UPDATE editors SET platform = ?1, name = ?2, email = ?3, style = ?4, work_type = ?5,
                updated_at = datetime('now','localtime')
         WHERE id = ?6",
        rusqlite::params![
            input.platform.trim(),
            input.name.trim(),
            input.email.trim().to_lowercase(),
            style,
            work_type,
            id
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "这个邮箱已经在编辑库里了".into()
        } else {
            e.to_string()
        }
    })?;
    Ok(())
}

#[tauri::command]
pub fn delete_editor(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM editors WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_editor(state: State<'_, AppState>, id: i64, enabled: bool) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE editors SET enabled = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
        rusqlite::params![enabled as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_editors(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let editors = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_editors(&conn)?
    };
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("编辑库_{ts}.xlsx"));

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let headers = ["平台", "名称", "邮箱", "风格", "作品类型", "状态"];
    for (col, h) in headers.iter().enumerate() {
        sheet
            .write_string(0, col as u16, *h)
            .map_err(|e| e.to_string())?;
    }
    for (i, editor) in editors.iter().enumerate() {
        let row = (i + 1) as u32;
        sheet
            .write_string(row, 0, &editor.platform)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 1, &editor.name)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 2, &editor.email)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 3, &editor.style.join("、"))
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 4, &editor.work_type.join("、"))
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 5, if editor.enabled { "使用中" } else { "已暂停" })
            .map_err(|e| e.to_string())?;
    }
    workbook.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_editors(
    state: State<'_, AppState>,
    data: Vec<u8>,
    file_name: String,
) -> Result<EditorImportResult, String> {
    let rows = parse_editor_import(&data, &file_name)?;
    if rows.is_empty() {
        return Err("文件里没有可导入的行。请用列：平台、名称、邮箱、风格、作品类型。".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut added = 0i64;
    let mut updated = 0i64;
    let mut errors = Vec::new();
    for (index, input) in rows {
        match upsert_editor(&conn, &input) {
            Ok("updated") => updated += 1,
            Ok(_) => added += 1,
            Err(e) => errors.push(format!("第 {index} 行：{e}")),
        }
    }
    Ok(EditorImportResult {
        added,
        updated,
        errors,
    })
}

fn upsert_editor(conn: &rusqlite::Connection, input: &EditorInput) -> Result<&'static str, String> {
    let input = validate_editor(input)?;
    let email = input.email.trim().to_lowercase();
    let style = json!(input.style.iter().map(|d| d.trim()).filter(|d| !d.is_empty()).collect::<Vec<_>>()).to_string();
    let work_type = json!(input.work_type.iter().map(|d| d.trim()).filter(|d| !d.is_empty()).collect::<Vec<_>>()).to_string();
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM editors WHERE email = ?1", [&email], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE editors SET platform = ?1, name = ?2, email = ?3, style = ?4, work_type = ?5,
                    updated_at = datetime('now','localtime')
             WHERE id = ?6",
            rusqlite::params![input.platform.trim(), input.name.trim(), email, style, work_type, id],
        )
        .map_err(|e| e.to_string())?;
        Ok("updated")
    } else {
        conn.execute(
            "INSERT INTO editors (platform, name, email, style, work_type) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![input.platform.trim(), input.name.trim(), email, style, work_type],
        )
        .map_err(|e| e.to_string())?;
        Ok("added")
    }
}

fn parse_editor_import(data: &[u8], file_name: &str) -> Result<Vec<(usize, EditorInput)>, String> {
    let name = file_name.to_lowercase();
    let table = if name.ends_with(".xlsx") || name.ends_with(".xls") {
        read_spreadsheet_rows(data)?
    } else {
        read_text_rows(data)?
    };
    Ok(rows_to_editors(table))
}

fn read_spreadsheet_rows(data: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let mut workbook = calamine::open_workbook_auto_from_rs(std::io::Cursor::new(data))
        .map_err(|e| format!("无法读取表格：{e}"))?;
    let range = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| "表格是空的".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(range
        .rows()
        .map(|row| row.iter().map(spreadsheet_cell).collect())
        .collect())
}

fn spreadsheet_cell(value: &calamine::Data) -> String {
    match value {
        calamine::Data::Empty => String::new(),
        calamine::Data::String(s) => s.trim().to_string(),
        calamine::Data::Float(n) if n.fract() == 0.0 => format!("{}", *n as i64),
        calamine::Data::Int(n) => n.to_string(),
        other => other.to_string().trim().to_string(),
    }
}

fn read_text_rows(data: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let text = decode_import_text(data);
    let delim = detect_delim(&text);
    let rows: Vec<Vec<String>> = text
        .lines()
        .map(|line| parse_delimited_line(line, delim))
        .filter(|row| row.iter().any(|c| !c.is_empty()))
        .collect();
    if rows.is_empty() {
        return Err("文件是空的".into());
    }
    Ok(rows)
}

fn decode_import_text(data: &[u8]) -> String {
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&data[3..]).into_owned();
    }
    String::from_utf8_lossy(data).into_owned()
}

fn detect_delim(text: &str) -> char {
    let first = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
    let comma = first.matches(',').count();
    let tab = first.matches('\t').count();
    let semi = first.matches(';').count();
    if tab >= comma && tab >= semi && tab > 0 {
        '\t'
    } else if semi > comma {
        ';'
    } else {
        ','
    }
}

fn parse_delimited_line(line: &str, delim: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            if quoted && chars.peek() == Some(&'"') {
                chars.next();
                cur.push('"');
            } else {
                quoted = !quoted;
            }
        } else if ch == delim && !quoted {
            out.push(cur.trim().to_string());
            cur.clear();
        } else if ch != '\r' {
            cur.push(ch);
        }
    }
    out.push(cur.trim().to_string());
    out
}

fn rows_to_editors(table: Vec<Vec<String>>) -> Vec<(usize, EditorInput)> {
    if table.is_empty() {
        return Vec::new();
    }
    let (start, map) = detect_editor_columns(&table[0]);
    table
        .into_iter()
        .enumerate()
        .skip(start)
        .filter_map(|(i, row)| {
            let input = editor_from_row(&row, &map);
            if input.email.is_empty() && input.style.is_empty() && input.work_type.is_empty() && input.name.is_empty() && input.platform.is_empty() {
                return None;
            }
            Some((i + 1, input))
        })
        .collect()
}

#[derive(Default)]
struct EditorColumns {
    platform: Option<usize>,
    name: Option<usize>,
    email: Option<usize>,
    style: Option<usize>,
    work_type: Option<usize>,
}

fn detect_editor_columns(first: &[String]) -> (usize, EditorColumns) {
    let mut map = EditorColumns::default();
    for (i, cell) in first.iter().enumerate() {
        match normalize_header(cell).as_str() {
            "平台" | "platform" | "站点" | "刊物" => map.platform = Some(i),
            "名称" | "name" | "编辑" | "昵称" => map.name = Some(i),
            "邮箱" | "email" | "邮件" | "收稿邮箱" => map.email = Some(i),
            "风格" | "style" => map.style = Some(i),
            "作品类型" | "类型" | "题材" | "work_type" | "收稿方向" | "方向" | "收稿类别" | "类别" | "标签" | "tags" => map.work_type = Some(i),
            _ => {}
        }
    }
    if map.email.is_some() || map.style.is_some() || map.work_type.is_some() {
        return (1, map);
    }
    let fallback = match first.len() {
        1 => EditorColumns { email: Some(0), ..EditorColumns::default() },
        2 => EditorColumns { email: Some(0), work_type: Some(1), ..EditorColumns::default() },
        3 => EditorColumns { name: Some(0), email: Some(1), work_type: Some(2), ..EditorColumns::default() },
        4 => EditorColumns { platform: Some(0), name: Some(1), email: Some(2), work_type: Some(3), ..EditorColumns::default() },
        _ => EditorColumns {
            platform: Some(0),
            name: Some(1),
            email: Some(2),
            style: Some(3),
            work_type: Some(4),
        },
    };
    (0, fallback)
}

fn normalize_header(value: &str) -> String {
    value.trim().trim_start_matches('\u{feff}').to_lowercase()
}

fn cell_at(row: &[String], index: Option<usize>) -> String {
    index.and_then(|i| row.get(i)).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn editor_from_row(row: &[String], map: &EditorColumns) -> EditorInput {
    let mut email = cell_at(row, map.email);
    let mut name = cell_at(row, map.name);
    if email.is_empty() {
        if let Some((_, extracted)) = name.rsplit_once('<') {
            email = extracted.trim().trim_end_matches('>').trim().to_string();
            name = name.rsplit_once('<').map(|(left, _)| left.trim().to_string()).unwrap_or_default();
        }
    }
    if name.is_empty() && email.contains('<') {
        if let Some((left, rest)) = email.split_once('<') {
            name = left.trim().to_string();
            email = rest.trim().trim_end_matches('>').trim().to_string();
        }
    }
    EditorInput {
        platform: cell_at(row, map.platform),
        name,
        email,
        style: split_tags(&cell_at(row, map.style)),
        work_type: split_tags(&cell_at(row, map.work_type)),
    }
}

fn split_tags(raw: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for part in raw.split(['、', '，', ',', ';', '；', '/', '|', '\n']) {
        let tag = part.trim();
        if tag.is_empty() || !seen.insert(tag.to_string()) {
            continue;
        }
        out.push(tag.to_string());
    }
    out
}

// ---------- 重新发送单条投递 ----------

/// 把某条已投递的邮件重新发给同一收件人：复用原稿件内容与附件，选一个已启用且未限流的账号发送。
#[tauri::command]
pub async fn resend_delivery(
    app: AppHandle,
    state: State<'_, AppState>,
    delivery_id: i64,
) -> Result<(), String> {
    let (delivery, manuscript, account) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let delivery = store::load_delivery(&conn, delivery_id)?.ok_or("投递记录不存在")?;
        let manuscript = match delivery.manuscript_id {
            Some(mid) => store::load_manuscript(&conn, mid)?.ok_or("原稿件已删除，无法重发")?,
            None => return Err("这条投递没有关联稿件，无法重发".into()),
        };
        let account = store::load_account(&conn, delivery.account_id.unwrap_or(0))?
            .ok_or("原发件账号已删除，无法重发")?;
        (delivery, manuscript, account)
    };

    if !account.enabled {
        return Err(format!("发件账号 {} 已禁用，请先启用", account.email));
    }
    if account.limited {
        return Err(format!("发件账号 {} 正在限流中，请稍后再试", account.email));
    }

    let settings = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_settings(&conn).unwrap_or_default()
    };
    let attachment = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_manuscript_attachment(&conn, manuscript.id).unwrap_or(None)
    };

    let (editor_name, recipient_email) = smtp::parse_recipient(&delivery.recipient);
    let subject_src = if manuscript.subject.trim().is_empty() {
        manuscript.title.as_str()
    } else {
        manuscript.subject.as_str()
    };
    let subject = smtp::apply_placeholders(subject_src, &editor_name, &recipient_email, &manuscript.title);
    let body = smtp::apply_placeholders(
        &smtp::mutate_body(&manuscript.body, settings.anti_spam_mutation),
        &editor_name,
        &recipient_email,
        &manuscript.title,
    );
    let sender_name = if manuscript.sender_name.trim().is_empty() {
        account.sender_name.clone()
    } else {
        manuscript.sender_name.clone()
    };

    let message_id = smtp::send_email(
        &account,
        &recipient_email,
        &sender_name,
        &subject,
        &body,
        &manuscript.content_type,
        attachment.as_ref().map(|(name, data)| (name.as_str(), data.as_slice())),
    )
    .await
    .map_err(|err| {
        let (_, msg) = smtp::classify_error(&err);
        msg
    })?;

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let _ = store::record_account_send(&conn, account.id);
        let _ = store::insert_delivery(
            &conn,
            delivery.task_id.unwrap_or(0),
            account.id,
            manuscript.id,
            &recipient_email,
            &subject,
            &message_id,
        );
    }
    let log = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_send_log(
            &conn,
            delivery.task_id,
            Some(account.id),
            "success",
            "send",
            "重新发送成功",
            &delivery.recipient,
        )
    };
    if let Ok(log) = log {
        let _ = app.emit("log", &log);
    }
    Ok(())
}

// ---------- Manuscripts ----------
#[tauri::command]
pub fn list_manuscripts(state: State<'_, AppState>) -> Result<Vec<Manuscript>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_all_manuscripts(&conn)
}

#[tauri::command]
pub fn get_manuscript(state: State<'_, AppState>, id: i64) -> Result<Option<Manuscript>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_manuscript(&conn, id)
}

#[tauri::command]
pub fn add_manuscript(
    state: State<'_, AppState>,
    input: crate::models::ManuscriptInput,
) -> Result<i64, String> {
    if input.title.trim().is_empty() {
        return Err("作品名称不能为空".into());
    }
    if input.body.trim().is_empty() {
        return Err("邮件正文不能为空".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let recipients = json!(input.recipients).to_string();
    let genres = json!(input.genres).to_string();
    let excluded_types = json!(input.excluded_types).to_string();
    conn.execute(
        "INSERT INTO manuscripts (title, body, content_type, recipients, sender_name,
            word_count, category, reader_category, reader_emotion, style, genres, excluded_types, subject, file_name, file_data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![
            input.title.trim(),
            input.body,
            input.content_type,
            recipients,
            input.sender_name.trim(),
            input.word_count,
            input.category.trim(),
            input.reader_category.trim(),
            input.reader_emotion.trim(),
            input.style.trim(),
            genres,
            excluded_types,
            input.subject.trim(),
            input.file_name.trim(),
            input.file_data,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_manuscript(
    state: State<'_, AppState>,
    id: i64,
    input: crate::models::ManuscriptInput,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let recipients = json!(input.recipients).to_string();
    let genres = json!(input.genres).to_string();
    let excluded_types = json!(input.excluded_types).to_string();
    conn.execute(
        "UPDATE manuscripts SET title = ?1, body = ?2, content_type = ?3, recipients = ?4,
                sender_name = ?5, word_count = ?6, category = ?7, reader_category = ?8,
                reader_emotion = ?9, style = ?10, genres = ?11, excluded_types = ?16,
                subject = ?12, file_name = ?13,
                file_data = COALESCE(?15, file_data),
                updated_at = datetime('now','localtime')
         WHERE id = ?14",
        rusqlite::params![
            input.title.trim(),
            input.body,
            input.content_type,
            recipients,
            input.sender_name.trim(),
            input.word_count,
            input.category.trim(),
            input.reader_category.trim(),
            input.reader_emotion.trim(),
            input.style.trim(),
            genres,
            input.subject.trim(),
            input.file_name.trim(),
            id,
            input.file_data,
            excluded_types,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_manuscript(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let tasks = store::load_tasks(&conn)?;
    for task in &tasks {
        if task.manuscript_ids.contains(&id) && matches!(task.status.as_str(), "running" | "paused") {
            return Err("这个计划正在发送，请先停止".into());
        }
    }
    conn.execute("DELETE FROM manuscripts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    for task in tasks {
        if !task.manuscript_ids.contains(&id) {
            continue;
        }
        if task.manuscript_ids.len() <= 1 {
            conn.execute("DELETE FROM tasks WHERE id = ?1", [task.id])
                .map_err(|e| e.to_string())?;
        } else {
            let ids: Vec<i64> = task.manuscript_ids.into_iter().filter(|x| *x != id).collect();
            conn.execute(
                "UPDATE tasks SET manuscript_ids = ?1 WHERE id = ?2",
                rusqlite::params![json!(ids).to_string(), task.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn extract_docx_text(data: Vec<u8>) -> Result<String, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader).map_err(|_| "不是有效的 Word 文件".to_string())?;
    let mut file = archive
        .by_name("word/document.xml")
        .map_err(|_| "不是有效的 Word 文件".to_string())?;
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut file, &mut xml).map_err(|e| e.to_string())?;
    Ok(docx_xml_to_text(&xml))
}

fn docx_xml_to_text(xml: &str) -> String {
    let with_breaks = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t");
    let mut out = String::new();
    let mut in_tag = false;
    for ch in with_breaks.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

// ---------- Tasks ----------

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> Result<Vec<crate::models::Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_tasks(&conn)
}

#[tauri::command]
pub fn get_task(state: State<'_, AppState>, id: i64) -> Result<Option<crate::models::Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_task(&conn, id)
}

#[tauri::command]
pub fn create_task(app: AppHandle, state: State<'_, AppState>, input: TaskInput) -> Result<i64, String> {
    if input.name.trim().is_empty() {
        return Err("任务名称不能为空".into());
    }
    if input.manuscript_ids.is_empty() {
        return Err("请选择至少一篇稿件".into());
    }
    if input.interval_min < 1 || input.interval_max < input.interval_min {
        return Err("发送间隔无效：上限需大于等于下限，且至少 1 秒".into());
    }
    if input.batch_size_min < 1 || input.batch_size_max < input.batch_size_min {
        return Err("每批封数无效：上限需大于等于下限，且至少 1 封".into());
    }
    if input.schedule_type == "scheduled" {
        let Some(at) = input.scheduled_at.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            return Err("请选择定时发送的时间".into());
        };
        let now = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            store::now_str(&conn)?
        };
        if at <= now.as_str() {
            return Err("定时发送时间必须晚于现在".into());
        }
    }

    let status = if input.schedule_type == "scheduled" {
        "scheduled"
    } else {
        "stopped"
    };
    let id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let accounts = store::load_accounts(&conn)?;
        let selected: Vec<&crate::models::Account> = if input.account_ids.is_empty() {
            accounts.iter().filter(|a| a.enabled).collect()
        } else {
            accounts
                .iter()
                .filter(|a| input.account_ids.contains(&a.id) && a.enabled)
                .collect()
        };
        if selected.is_empty() {
            return Err(if input.account_ids.is_empty() {
                "请先添加并启用至少一个发件邮箱".into()
            } else {
                "所选邮箱不存在或未启用，请重新勾选参与发送的邮箱".into()
            });
        }
        let manuscripts = store::load_manuscripts(&conn, &input.manuscript_ids)?;
        if manuscripts.len() != input.manuscript_ids.len() {
            return Err("部分稿件不存在，请刷新后重试".into());
        }
        let recipients: usize = manuscripts.iter().map(|m| m.recipients.len()).sum();
        if recipients == 0 {
            return Err("所选稿件都没有收件人，请先在稿件中填写编辑部邮箱".into());
        }
        conn.execute(
            "INSERT INTO tasks (name, manuscript_ids, account_ids, status, schedule_type, scheduled_at,
                    interval_min, interval_max, batch_size_min, batch_size_max,
                    batch_pause_min, batch_pause_max, retry_max)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                input.name.trim(),
                json!(input.manuscript_ids).to_string(),
                json!(input.account_ids).to_string(),
                status,
                input.schedule_type,
                input.scheduled_at,
                input.interval_min,
                input.interval_max,
                input.batch_size_min,
                input.batch_size_max,
                input.batch_pause_min,
                input.batch_pause_max,
                input.retry_max
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };
    if input.schedule_type != "scheduled" {
        start_task(app, state, id)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = registry.get(&id) {
            handle.stop();
        }
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM task_logs WHERE task_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn start_task(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        if registry.contains_key(&id) {
            return Err("任务已在运行或已暂停，请使用「继续」".into());
        }
    }
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let task = store::load_task(&conn, id)?.ok_or("任务不存在")?;
        if task.status == "running" {
            return Err("任务已在运行".into());
        }
        if task.status == "paused" {
            return Err("任务已暂停，请点击「继续」".into());
        }
        // 已完成的重新发送要清零进度从头投递；已停止且发过部分的任务保留进度，继续投递剩余收件人（跳过已投递的）。
        if task.sent == 0 || task.status == "completed" {
            store::reset_task_progress(&conn, id)?;
        }
    }
    scheduler::spawn_task_worker(
        app.clone(),
        state.db.clone(),
        state.tasks.clone(),
        id,
    );
    Ok(())
}

#[tauri::command]
pub fn pause_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let handle = registry.get(&id).ok_or("任务未在运行（可能已结束，或应用重启后已自动停止）")?;
    handle.pause();
    Ok(())
}

#[tauri::command]
pub fn resume_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let handle = registry.get(&id).ok_or("任务未在运行（可能已结束，或应用重启后已自动停止）")?;
    handle.resume();
    Ok(())
}

#[tauri::command]
pub fn stop_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = registry.get(&id) {
            handle.stop();
            return Ok(());
        }
    }
    // 没有活动 worker（例如应用重启后遗留的假运行状态）：清掉状态而不是静默无操作。
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(task) = store::load_task(&conn, id)? {
        if matches!(task.status.as_str(), "running" | "paused") {
            store::set_task_status(&conn, id, "stopped")?;
        }
    }
    Ok(())
}

// ---------- Logs ----------

#[tauri::command]
pub fn list_logs(
    state: State<'_, AppState>,
    task_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<TaskLog>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_logs(
        &conn,
        task_id,
        limit.unwrap_or(200),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>, task_id: Option<i64>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match task_id {
        Some(tid) => conn
            .execute("DELETE FROM task_logs WHERE task_id = ?1", [tid])
            .map_err(|e| e.to_string())?,
        None => conn
            .execute("DELETE FROM task_logs", [])
            .map_err(|e| e.to_string())?,
    };
    Ok(())
}

#[tauri::command]
pub fn export_logs(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: Option<i64>,
) -> Result<String, String> {
    let (logs, accounts) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let logs = store::load_logs(&conn, task_id, 100000, 0)?;
        let accounts = store::load_accounts(&conn).unwrap_or_default();
        (logs, accounts)
    };
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("投稿日志_{ts}.xlsx"));

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let headers = ["ID", "任务", "账号", "编辑邮箱", "级别", "类别", "消息", "时间"];
    for (col, h) in headers.iter().enumerate() {
        sheet
            .write_string(0, col as u16, *h)
            .map_err(|e| e.to_string())?;
    }
    for (i, log) in logs.iter().enumerate() {
        let row = (i + 1) as u32;
        sheet
            .write_number(row, 0, log.id as f64)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 1, &log.task_id.map(|v| v.to_string()).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(
                row,
                2,
                &log
                    .account_id
                    .and_then(|id| accounts.iter().find(|a| a.id == id).map(|a| a.email.clone()))
                    .unwrap_or_default(),
            )
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 3, &log.recipient.clone().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 4, &log.level)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 5, &log.category)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 6, &log.message)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 7, &log.created_at)
            .map_err(|e| e.to_string())?;
    }
    workbook.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ---------- Replies ----------

#[tauri::command]
pub fn list_replies(
    state: State<'_, AppState>,
    kind: Option<String>,
) -> Result<Vec<crate::models::Reply>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_replies(&conn, kind.as_deref().filter(|s| !s.is_empty()), 300)
}

#[tauri::command]
pub fn scan_replies(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    crate::inbox::scan_all_accounts(&app, &state.db)
}

// ---------- Settings ----------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_settings(&conn)
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    if settings.default_interval_min < 1 || settings.default_interval_max < settings.default_interval_min {
        return Err("发送间隔设置无效".into());
    }
    if settings.default_batch_size_min < 1 || settings.default_batch_size_max < settings.default_batch_size_min {
        return Err("批次设置无效".into());
    }
    if settings.reply_poll_minutes < 1 {
        return Err("检查回复间隔至少 1 分钟".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::save_settings(&conn, &settings)
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub has_update: bool,
    pub latest: String,
    pub feed: String,
}

#[tauri::command]
pub fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let settings = store::load_settings(&conn)?;
    Ok(UpdateInfo {
        current,
        has_update: false,
        latest: String::new(),
        feed: settings.update_feed_url,
    })
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(e) = result {
        return Err(format!("设置开机自启失败：{e}"));
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut settings = store::load_settings(&conn)?;
    settings.auto_start = enabled;
    store::save_settings(&conn, &settings)
}

#[tauri::command]
pub fn backup_data(app: AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = data_dir.join("novelsub.sqlite");
    let backup_dir = data_dir.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dst = backup_dir.join(format!("novelsub_backup_{ts}.sqlite"));
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_deliveries(state: State<'_, AppState>) -> Result<Vec<crate::models::Delivery>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_recent_deliveries(&conn, 365)
}

/// 供 tray 使用的窗口显示命令。
#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
