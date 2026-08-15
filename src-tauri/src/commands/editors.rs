use std::time::{SystemTime, UNIX_EPOCH};

use calamine::Reader;
use rusqlite::OptionalExtension;
use rust_xlsxwriter::Workbook;
use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::models::{EditorImportResult, EditorInput};
use crate::state::AppState;
use crate::store;

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
    let headers = ["平台", "名称", "邮箱", "风格", "作品类型"];
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

