use std::time::{SystemTime, UNIX_EPOCH};

use calamine::Reader;
use rusqlite::OptionalExtension;
use rust_xlsxwriter::Workbook;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, State};

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

fn validate_editor(input: &crate::models::EditorInput) -> Result<(), String> {
    if input.email.trim().is_empty() || !input.email.contains('@') {
        return Err("请填写有效的收稿邮箱".into());
    }
    if !input.directions.iter().any(|d| !d.trim().is_empty()) {
        return Err("请至少选一个收稿方向".into());
    }
    Ok(())
}

#[tauri::command]
pub fn list_editors(state: State<'_, AppState>) -> Result<Vec<crate::models::Editor>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_editors(&conn)
}

#[tauri::command]
pub fn add_editor(
    state: State<'_, AppState>,
    input: crate::models::EditorInput,
) -> Result<i64, String> {
    validate_editor(&input)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let directions = json!(input.directions).to_string();
    conn.execute(
        "INSERT INTO editors (platform, name, email, directions)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            input.platform.trim(),
            input.name.trim(),
            input.email.trim().to_lowercase(),
            directions
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
    validate_editor(&input)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let directions = json!(input.directions).to_string();
    conn.execute(
        "UPDATE editors SET platform = ?1, name = ?2, email = ?3, directions = ?4,
                updated_at = datetime('now','localtime')
         WHERE id = ?5",
        rusqlite::params![
            input.platform.trim(),
            input.name.trim(),
            input.email.trim().to_lowercase(),
            directions,
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
    let headers = ["平台", "名称", "邮箱", "收稿方向"];
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
            .write_string(row, 3, &editor.directions.join("、"))
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
        return Err("文件里没有可导入的行。请用列：平台、名称、邮箱、收稿方向。".into());
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
    validate_editor(input)?;
    let email = input.email.trim().to_lowercase();
    let directions = json!(input.directions.iter().map(|d| d.trim()).filter(|d| !d.is_empty()).collect::<Vec<_>>()).to_string();
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM editors WHERE email = ?1", [&email], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE editors SET platform = ?1, name = ?2, email = ?3, directions = ?4,
                    updated_at = datetime('now','localtime')
             WHERE id = ?5",
            rusqlite::params![input.platform.trim(), input.name.trim(), email, directions, id],
        )
        .map_err(|e| e.to_string())?;
        Ok("updated")
    } else {
        conn.execute(
            "INSERT INTO editors (platform, name, email, directions) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![input.platform.trim(), input.name.trim(), email, directions],
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
            if input.email.is_empty() && input.directions.is_empty() && input.name.is_empty() && input.platform.is_empty() {
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
    directions: Option<usize>,
}

fn detect_editor_columns(first: &[String]) -> (usize, EditorColumns) {
    let mut map = EditorColumns::default();
    for (i, cell) in first.iter().enumerate() {
        match normalize_header(cell).as_str() {
            "平台" | "platform" | "站点" | "刊物" => map.platform = Some(i),
            "名称" | "name" | "编辑" | "昵称" => map.name = Some(i),
            "邮箱" | "email" | "邮件" | "收稿邮箱" => map.email = Some(i),
            "收稿方向" | "方向" | "类型" | "标签" | "directions" | "tags" => map.directions = Some(i),
            _ => {}
        }
    }
    if map.email.is_some() || map.directions.is_some() {
        return (1, map);
    }
    let fallback = match first.len() {
        1 => EditorColumns { email: Some(0), ..EditorColumns::default() },
        2 => EditorColumns { email: Some(0), directions: Some(1), ..EditorColumns::default() },
        3 => EditorColumns { name: Some(0), email: Some(1), directions: Some(2), ..EditorColumns::default() },
        _ => EditorColumns {
            platform: Some(0),
            name: Some(1),
            email: Some(2),
            directions: Some(3),
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
        directions: split_directions(&cell_at(row, map.directions)),
    }
}

fn split_directions(raw: &str) -> Vec<String> {
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
    conn.execute(
        "INSERT INTO manuscripts (title, body, content_type, recipients, sender_name,
            word_count, category, reader_category, reader_emotion, style, genres, subject, file_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
    conn.execute(
        "UPDATE manuscripts SET title = ?1, body = ?2, content_type = ?3, recipients = ?4,
                sender_name = ?5, word_count = ?6, category = ?7, reader_category = ?8,
                reader_emotion = ?9, style = ?10, genres = ?11, subject = ?12, file_name = ?13,
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
            id
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
        if !accounts.iter().any(|a| a.enabled) {
            return Err("请先添加并启用至少一个发件邮箱".into());
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
            "INSERT INTO tasks (name, manuscript_ids, status, schedule_type, scheduled_at,
                    interval_min, interval_max, batch_size_min, batch_size_max,
                    batch_pause_min, batch_pause_max, retry_max)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                input.name.trim(),
                json!(input.manuscript_ids).to_string(),
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
        store::reset_task_progress(&conn, id)?;
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
    let handle = registry.get(&id).ok_or("任务未在运行")?;
    handle.pause();
    Ok(())
}

#[tauri::command]
pub fn resume_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let handle = registry.get(&id).ok_or("任务未在运行")?;
    handle.resume();
    Ok(())
}

#[tauri::command]
pub fn stop_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = registry.get(&id) {
        handle.stop();
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
    let logs = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_logs(&conn, task_id, 100000, 0)?
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
    let headers = ["ID", "任务", "账号", "级别", "类别", "消息", "时间"];
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
            .write_string(row, 2, &log.account_id.map(|v| v.to_string()).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 3, &log.level)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 4, &log.category)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 5, &log.message)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 6, &log.created_at)
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
