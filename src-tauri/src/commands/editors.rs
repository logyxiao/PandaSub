use calamine::Reader;
use rust_xlsxwriter::Workbook;
use serde_json::json;
use tauri::State;

use crate::models::{
    EditorImportResult, EditorInput, EDITOR_SOURCE_IMPORT, EDITOR_SOURCE_INITIAL, EDITOR_SOURCE_MANUAL,
};
use crate::state::AppState;
use crate::store;

// ---------- Editors ----------

fn normalize_editor_input(input: &crate::models::EditorInput) -> crate::models::EditorInput {
    crate::models::EditorInput {
        platform: crate::models::canonicalize_editor_platform(&input.platform),
        name: input.name.clone(),
        email: input.email.clone(),
        work_type: crate::models::normalize_editor_work_types(&input.work_type),
        notes: input.notes.trim().to_string(),
    }
}

fn validate_editor(input: &crate::models::EditorInput) -> Result<crate::models::EditorInput, String> {
    let input = normalize_editor_input(input);
    if input.email.trim().is_empty() || !input.email.contains('@') {
        return Err("请填写有效的收稿邮箱".into());
    }
    Ok(input)
}

#[tauri::command]
pub fn list_editors(state: State<'_, AppState>) -> Result<Vec<crate::models::Editor>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    Ok(store::load_editors(&conn)?)
}

#[tauri::command]
pub fn add_editor(
    state: State<'_, AppState>,
    input: crate::models::EditorInput,
) -> Result<i64, String> {
    let input = validate_editor(&input)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let work_type = json!(input.work_type).to_string();
    conn.execute(
        "INSERT INTO editors (platform, name, email, style, work_type, notes, source)
         VALUES (?1, ?2, ?3, '[]', ?4, ?5, ?6)",
        rusqlite::params![
            input.platform.trim(),
            input.name.trim(),
            input.email.trim().to_lowercase(),
            work_type,
            input.notes.trim(),
            EDITOR_SOURCE_MANUAL
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
    let work_type = json!(input.work_type).to_string();
    conn.execute(
        "UPDATE editors SET platform = ?1, name = ?2, email = ?3, style = '[]', work_type = ?4,
                notes = ?5, source = ?6, updated_at = datetime('now','localtime')
         WHERE id = ?7",
        rusqlite::params![
            input.platform.trim(),
            input.name.trim(),
            input.email.trim().to_lowercase(),
            work_type,
            input.notes.trim(),
            EDITOR_SOURCE_MANUAL,
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
pub fn toggle_editor_favorite(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE editors SET favorited = CASE WHEN favorited = 1 THEN 0 ELSE 1 END,
                updated_at = datetime('now','localtime')
         WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    let favorited: i64 = conn
        .query_row("SELECT favorited FROM editors WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|_| "没有找到这位编辑".to_string())?;
    Ok(favorited != 0)
}

#[tauri::command]
pub fn delete_editor(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM editors WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_editors(state: State<'_, AppState>) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM editors", [])
        .map_err(|e| e.to_string())?;
    Ok(deleted as i64)
}

#[tauri::command]
pub fn export_editors(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let editors = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_editors(&conn)?
    };
    let path = if path.trim().to_lowercase().ends_with(".xlsx") {
        path
    } else {
        format!("{path}.xlsx")
    };
    let file = std::path::PathBuf::from(&path);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let headers = ["平台", "名称", "邮箱", "作品类型", "收稿说明", "来源"];
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
            .write_string(row, 3, &editor.work_type.join("、"))
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 4, &editor.notes)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 5, &editor.source)
            .map_err(|e| e.to_string())?;
    }
    workbook.save(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn import_editors(
    state: State<'_, AppState>,
    data: Vec<u8>,
    file_name: String,
) -> Result<EditorImportResult, String> {
    let rows = parse_editor_import(&data, &file_name)?;
    if rows.is_empty() {
        return Err("文件里没有可导入的行。请用列：平台、名称、邮箱、作品类型、收稿说明。".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut added = 0i64;
    let mut updated = 0i64;
    let mut errors = Vec::new();
    for (index, input) in rows {
        match upsert_imported_editor(&conn, &input) {
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

#[tauri::command]
pub fn import_default_editors(state: State<'_, AppState>) -> Result<EditorImportResult, String> {
    let rows = crate::models::default_editor_inputs()?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut added = 0i64;
    let mut updated = 0i64;
    let mut errors = Vec::new();
    for input in rows {
        match validate_editor(&input).and_then(|input| store::upsert_editor(&conn, &input, EDITOR_SOURCE_INITIAL)) {
            Ok("updated") => updated += 1,
            Ok(_) => added += 1,
            Err(e) => errors.push(e),
        }
    }
    Ok(EditorImportResult {
        added,
        updated,
        errors,
    })
}

fn upsert_imported_editor(conn: &rusqlite::Connection, input: &EditorInput) -> Result<&'static str, String> {
    let input = validate_editor(input)?;
    store::upsert_editor(conn, &input, EDITOR_SOURCE_IMPORT)
}

fn parse_editor_import(data: &[u8], file_name: &str) -> Result<Vec<(usize, EditorInput)>, String> {
    let name = file_name.to_lowercase();
    if name.ends_with(".xlsx") || name.ends_with(".xls") {
        let mut out = Vec::new();
        for (sheet, rows) in read_spreadsheet_sheets(data)? {
            if skip_import_sheet(&sheet) {
                continue;
            }
            out.extend(rows_to_editors(rows));
        }
        return Ok(out);
    }
    Ok(rows_to_editors(read_text_rows(data)?))
}

fn skip_import_sheet(name: &str) -> bool {
    let name = name.trim();
    matches!(name, "平台统计" | "写稿方向建议" | "题材例文明细")
        || name.contains("报刊")
        || name.contains("杂志")
        || name.contains("长篇")
        || name.contains("剧本")
        || name.contains("短剧")
}

fn read_spreadsheet_sheets(data: &[u8]) -> Result<Vec<(String, Vec<Vec<String>>)>, String> {
    let mut workbook = calamine::open_workbook_auto_from_rs(std::io::Cursor::new(data))
        .map_err(|e| format!("无法读取表格：{e}"))?;
    let names = workbook.sheet_names().to_vec();
    let mut out = Vec::new();
    for name in names {
        let Ok(range) = workbook.worksheet_range(&name) else { continue };
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|row| row.iter().map(spreadsheet_cell).collect())
            .collect();
        if rows.iter().any(|row| row.iter().any(|cell| !cell.is_empty())) {
            out.push((name, rows));
        }
    }
    if out.is_empty() {
        return Err("表格是空的".into());
    }
    Ok(out)
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
            if input.email.is_empty() && input.work_type.is_empty() && input.name.is_empty() && input.platform.is_empty() {
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
    work_type: Option<usize>,
    notes: Option<usize>,
}

fn detect_editor_columns(first: &[String]) -> (usize, EditorColumns) {
    let mut map = EditorColumns::default();
    for (i, cell) in first.iter().enumerate() {
        match normalize_header(cell).as_str() {
            "平台" | "platform" | "站点" | "刊物" | "三方" | "报刊" | "杂志" | "杂志名称" => map.platform = Some(i),
            "名称" | "name" | "编辑" | "昵称" | "副刊" => map.name = Some(i),
            "邮箱" | "email" | "邮件" | "收稿邮箱" | "投稿邮箱" | "联系方式" => map.email = Some(i),
            "作品类型" | "类型" | "题材" | "work_type" | "收稿方向" | "方向" | "收稿类别" | "类别" | "标签" | "tags" | "收稿类型" => map.work_type = Some(i),
            "说明" | "notes" | "收稿说明" | "备注" | "审稿" | "投稿注意" => map.notes = Some(i),
            _ => {}
        }
    }
    if map.email.is_some() || map.work_type.is_some() {
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
            work_type: Some(3),
            notes: Some(4),
            ..EditorColumns::default()
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
    let raw_work = cell_at(row, map.work_type);
    let mut notes = cell_at(row, map.notes);
    if notes.is_empty() && raw_work.chars().count() > 16 {
        notes = raw_work.clone();
    }
    EditorInput {
        platform: cell_at(row, map.platform),
        name,
        email: extract_email(&email),
        work_type: split_tags(&raw_work),
        notes,
    }
}

fn extract_email(raw: &str) -> String {
    let cleaned = raw.replace("小窗", " ").replace("微信", " ");
    cleaned
        .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-' | '@')))
        .find(|part| part.contains('@') && part.contains('.'))
        .unwrap_or("")
        .to_lowercase()
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

