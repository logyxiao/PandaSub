use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager, State};

use crate::models::{AcceptedCandidate, AcceptedWork, AcceptedWorkDocument, AcceptedWorkInput};
use crate::state::AppState;
use crate::store;

const WORK_COLS: &str = "id, manuscript_id, source, title, body, file_name, \
    CASE WHEN file_data IS NOT NULL AND length(file_data) > 0 THEN 1 ELSE 0 END, \
    accepted_at, deal_mode, price_cents, guarantee_cents, share_percent, sale_platform, \
    buyer_editor, listing_platform, article_url, notes, created_at, updated_at, review_status, sold_at, realized_share_cents, per_thousand_cents, record_origin, monthly_settlements";

fn map_work(row: &rusqlite::Row<'_>) -> rusqlite::Result<AcceptedWork> {
    let settlements_json: String = row.get(24)?;
    let monthly_settlements = serde_json::from_str(&settlements_json).map_err(|error|
        rusqlite::Error::FromSqlConversionFailure(24, rusqlite::types::Type::Text, Box::new(error)))?;
    Ok(AcceptedWork {
        id: row.get(0)?,
        manuscript_id: row.get(1)?,
        source: row.get(2)?,
        review_status: row.get(19)?,
        title: row.get(3)?,
        body: row.get(4)?,
        file_name: row.get(5)?,
        has_file: row.get::<_, i64>(6)? != 0,
        accepted_at: row.get(7)?,
        sold_at: row.get(20)?,
        deal_mode: row.get(8)?,
        price_cents: row.get(9)?,
        guarantee_cents: row.get(10)?,
        per_thousand_cents: row.get(22)?,
        realized_share_cents: row.get(21)?,
        monthly_settlements,
        share_percent: row.get(11)?,
        sale_platform: row.get(12)?,
        buyer_editor: row.get(13)?,
        listing_platform: row.get(14)?,
        article_url: row.get(15)?,
        notes: row.get(16)?,
        record_origin: row.get(23)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

fn validate(input: &AcceptedWorkInput) -> Result<(), String> {
    if !matches!(input.source.as_str(), "plan" | "external") {
        return Err("作品来源无效".into());
    }
    if !matches!(
        input.review_status.as_str(),
        "accepted" | "preliminary" | "final_rejected" | "not_accepted"
    ) {
        return Err("过稿核对状态无效".into());
    }
    if input.source == "plan" && input.manuscript_id.is_none() {
        return Err("请选择一份投稿计划".into());
    }
    if input.source == "external" && input.title.trim().is_empty() {
        return Err("请填写作品名称".into());
    }
    if input.source == "external" && input.manuscript_id.is_some() {
        return Err("外部文章不能关联投稿计划".into());
    }
    if !matches!(
        input.deal_mode.as_str(),
        "undecided" | "buyout" | "guarantee_share" | "platform_share"
    ) {
        return Err("价格模式无效".into());
    }
    if input.price_cents < 0 || input.guarantee_cents < 0 || input.per_thousand_cents < 0 || input.realized_share_cents < 0 {
        return Err("金额不能为负数".into());
    }
    if input.review_status == "accepted" && input.deal_mode == "platform_share" && input.listing_platform.trim().is_empty() {
        return Err("上架平台分成请填写上架平台，例如知乎或番茄".into());
    }
    let mut settlement_months = HashSet::new();
    if input.monthly_settlements.len() > 240 { return Err("月结记录不能超过 240 条".into()); }
    for settlement in &input.monthly_settlements {
        let month = settlement.month.as_bytes();
        if month.len() != 7 || month[4] != b'-' || !month.iter().enumerate().all(|(i, b)| i == 4 || b.is_ascii_digit())
            || settlement.month[..4].parse::<u32>().unwrap_or(0) == 0
            || !(1..=12).contains(&settlement.month[5..].parse::<u32>().unwrap_or(0)) {
            return Err("月结月份格式应为 YYYY-MM".into());
        }
        if settlement.amount_cents <= 0 { return Err("月结收入须大于 0 元".into()); }
        if !settlement_months.insert(&settlement.month) { return Err("同一个月份只能记录一笔月结收入".into()); }
    }
    if !input.accepted_at.is_empty() && !is_date(&input.accepted_at) {
        return Err("记录日期格式无效".into());
    }
    if input.review_status == "accepted"
        && ((input.deal_mode == "buyout" && input.price_cents == 0)
            || (input.deal_mode == "guarantee_share" && input.guarantee_cents == 0 && input.per_thousand_cents == 0))
    {
        return Err("已卖出作品请填写买断价、保底价或千字单价".into());
    }
    if !input.share_percent.is_finite() || !(0.0..=100.0).contains(&input.share_percent) {
        return Err("分成比例应在 0–100% 之间".into());
    }
    if input
        .file_data
        .as_ref()
        .is_some_and(|data| data.len() > 25 * 1024 * 1024)
    {
        return Err("文稿文件不能超过 25 MB".into());
    }
    if input.file_data.as_ref().is_some_and(Vec::is_empty) {
        return Err("文稿文件为空".into());
    }
    if input
        .file_data
        .as_ref()
        .is_some_and(|data| !data.is_empty())
        && !matches!(
            input
                .file_name
                .rsplit('.')
                .next()
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("docx" | "txt")
        )
    {
        return Err("只支持 .docx 或 .txt 文稿".into());
    }
    if !input.article_url.trim().is_empty()
        && !input
            .article_url
            .trim()
            .to_ascii_lowercase()
            .starts_with("https://")
        && !input
            .article_url
            .trim()
            .to_ascii_lowercase()
            .starts_with("http://")
    {
        return Err("文章链接请以 http:// 或 https:// 开头".into());
    }
    Ok(())
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' { return false; }
    if !bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit()) { return false; }
    let year: i32 = value[..4].parse().unwrap_or(0);
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    chrono::NaiveDate::from_ymd_opt(year, month, day).is_some()
}

pub(crate) fn load_works(conn: &Connection) -> Result<Vec<AcceptedWork>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {WORK_COLS} FROM accepted_works ORDER BY accepted_at DESC, id DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_work).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn load_candidates(conn: &Connection) -> Result<Vec<AcceptedCandidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.manuscript_id, m.title, r.received_at,
                COALESCE(e.platform, ''), COALESCE(e.name, r.from_email)
         FROM replies r
         JOIN deliveries d ON d.id = r.delivery_id
         JOIN manuscripts m ON m.id = d.manuscript_id
         LEFT JOIN editors e ON lower(e.email) = lower(r.from_email)
         WHERE r.accepted = 1 AND NOT EXISTS (
           SELECT 1 FROM accepted_works w WHERE w.manuscript_id = d.manuscript_id
         )
         ORDER BY r.received_at DESC, r.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AcceptedCandidate {
                manuscript_id: row.get(0)?,
                title: row.get(1)?,
                received_at: row.get(2)?,
                sale_platform: row.get(3)?,
                buyer_editor: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        let candidate = row.map_err(|e| e.to_string())?;
        if seen.insert(candidate.manuscript_id) {
            result.push(candidate)
        }
    }
    Ok(result)
}

pub(crate) fn create_work(conn: &Connection, input: AcceptedWorkInput) -> Result<i64, String> {
    validate(&input)?;
    let settlements_json = serde_json::to_string(&input.monthly_settlements).map_err(|error| error.to_string())?;
    let sold_at = if input.review_status == "accepted" && input.deal_mode != "undecided" {
        input.accepted_at.clone()
    } else {
        String::new()
    };
    let (title, body, file_name, file_data) = if input.source == "plan" {
        let id = input.manuscript_id.ok_or("请选择一份投稿计划")?;
        conn.query_row(
            "SELECT title, body, file_name, file_data FROM manuscripts WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("投稿计划不存在")?
    } else {
        let file_name = if input
            .file_data
            .as_ref()
            .is_some_and(|data| !data.is_empty())
        {
            input.file_name
        } else {
            String::new()
        };
        (
            input.title.trim().to_owned(),
            input.body,
            file_name,
            input.file_data,
        )
    };
    conn.execute(
        "INSERT INTO accepted_works (manuscript_id, source, title, body, file_name, file_data,
         accepted_at, deal_mode, price_cents, guarantee_cents, share_percent, sale_platform,
         buyer_editor, listing_platform, article_url, notes, review_status, sold_at, realized_share_cents, per_thousand_cents, monthly_settlements)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            input.manuscript_id,
            input.source,
            title,
            body,
            file_name,
            file_data,
            input.accepted_at,
            input.deal_mode,
            input.price_cents,
            input.guarantee_cents,
            input.share_percent,
            input.sale_platform.trim(),
            input.buyer_editor.trim(),
            input.listing_platform.trim(),
            input.article_url.trim(),
            input.notes.trim(),
            input.review_status,
            sold_at,
            input.realized_share_cents,
            input.per_thousand_cents,
            settlements_json
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint") {
            "这篇投稿作品已加入过稿统计".into()
        } else {
            e.to_string()
        }
    })?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn update_work(
    conn: &Connection,
    id: i64,
    input: AcceptedWorkInput,
) -> Result<(), String> {
    validate(&input)?;
    let settlements_json = serde_json::to_string(&input.monthly_settlements).map_err(|error| error.to_string())?;
    let sold_at = if input.review_status == "accepted" && input.deal_mode != "undecided" {
        input.accepted_at.clone()
    } else {
        String::new()
    };
    let source: String = conn
        .query_row("SELECT source FROM accepted_works WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("过稿记录不存在")?;
    if source != input.source {
        return Err("不能更改作品来源".into());
    }
    let changed = if source == "plan" {
        conn.execute(
            "UPDATE accepted_works SET accepted_at=?1, deal_mode=?2, price_cents=?3,
             guarantee_cents=?4, share_percent=?5, sale_platform=?6, buyer_editor=?7,
             listing_platform=?8, article_url=?9, notes=?10, review_status=?11,
             sold_at=?12, realized_share_cents=?13, per_thousand_cents=?14, monthly_settlements=?15,
             updated_at=datetime('now','localtime') WHERE id=?16",
            params![
                input.accepted_at,
                input.deal_mode,
                input.price_cents,
                input.guarantee_cents,
                input.share_percent,
                input.sale_platform.trim(),
                input.buyer_editor.trim(),
                input.listing_platform.trim(),
                input.article_url.trim(),
                input.notes.trim(),
                input.review_status,
                sold_at,
                input.realized_share_cents,
                input.per_thousand_cents,
                settlements_json,
                id
            ],
        )
    } else {
        conn.execute(
            "UPDATE accepted_works SET title=?1, body=?2,
             file_name=CASE WHEN ?3 THEN '' WHEN ?4 IS NOT NULL THEN ?5 ELSE file_name END,
             file_data=CASE WHEN ?3 THEN NULL WHEN ?4 IS NOT NULL THEN ?4 ELSE file_data END,
             accepted_at=?6, deal_mode=?7, price_cents=?8, guarantee_cents=?9,
             share_percent=?10, sale_platform=?11, buyer_editor=?12, listing_platform=?13,
             article_url=?14, notes=?15, review_status=?16,
             sold_at=?17, realized_share_cents=?18, per_thousand_cents=?19, monthly_settlements=?20,
             updated_at=datetime('now','localtime') WHERE id=?21",
            params![
                input.title.trim(),
                input.body,
                input.remove_file,
                input.file_data,
                input.file_name,
                input.accepted_at,
                input.deal_mode,
                input.price_cents,
                input.guarantee_cents,
                input.share_percent,
                input.sale_platform.trim(),
                input.buyer_editor.trim(),
                input.listing_platform.trim(),
                input.article_url.trim(),
                input.notes.trim(),
                input.review_status,
                sold_at,
                input.realized_share_cents,
                input.per_thousand_cents,
                settlements_json,
                id
            ],
        )
    }
    .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("过稿记录不存在".into());
    }
    Ok(())
}

pub(crate) fn load_document(conn: &Connection, id: i64) -> Result<AcceptedWorkDocument, String> {
    conn.query_row(
        "SELECT title, body, file_name, file_data FROM accepted_works WHERE id=?1",
        [id],
        |row| {
            Ok(AcceptedWorkDocument {
                title: row.get(0)?,
                body: row.get(1)?,
                file_name: row.get(2)?,
                file_data: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "过稿记录不存在".into())
}

#[tauri::command]
pub fn list_accepted_works(state: State<'_, AppState>) -> Result<Vec<AcceptedWork>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    load_works(&conn)
}

#[tauri::command]
pub fn list_accepted_candidates(
    state: State<'_, AppState>,
) -> Result<Vec<AcceptedCandidate>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    load_candidates(&conn)
}

#[tauri::command]
pub fn add_accepted_work(
    state: State<'_, AppState>,
    input: AcceptedWorkInput,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    create_work(&conn, input)
}

#[tauri::command]
pub fn update_accepted_work(
    state: State<'_, AppState>,
    id: i64,
    input: AcceptedWorkInput,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    update_work(&conn, id, input)
}

#[tauri::command]
pub fn delete_accepted_work(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let changed = conn
        .execute("DELETE FROM accepted_works WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("过稿记录不存在".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_accepted_work_document(
    state: State<'_, AppState>,
    id: i64,
) -> Result<AcceptedWorkDocument, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    load_document(&conn, id)
}

#[tauri::command]
pub fn export_accepted_work_document(
    state: State<'_, AppState>,
    id: i64,
    path: String,
) -> Result<String, String> {
    let document = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        load_document(&conn, id)?
    };
    let bytes = document.file_data.ok_or("这篇作品没有原始文稿附件")?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

fn safe_document_name(raw: &str) -> Result<String, String> {
    let base = raw.rsplit(|ch| ch == '/' || ch == '\\').next().unwrap_or("");
    let safe: String = base.chars().map(|ch| {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { ch }
    }).collect();
    let safe = safe.trim().trim_matches('.');
    let extension = Path::new(safe).extension().and_then(|value| value.to_str())
        .unwrap_or("").to_ascii_lowercase();
    if safe.is_empty() || !matches!(extension.as_str(), "docx" | "txt") {
        return Err("原始文稿文件名无效，请重新上传 Word 或文本附件".into());
    }
    Ok(safe.to_owned())
}

/// Materialize a stored snapshot without overwriting a copy the user may have edited.
fn managed_document_copy(root: &Path, folder: &str, original_name: &str, data: &[u8]) -> Result<PathBuf, String> {
    if data.is_empty() { return Err("这篇作品没有原始文稿附件".into()); }
    let name = safe_document_name(original_name)?;
    let directory = root.join("submitted-manuscripts").join(folder);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = Path::new(&name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("文稿");
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("docx");
    for version in 1..=100 {
        let file_name = if version == 1 { name.clone() } else { format!("{stem} ({version}).{extension}") };
        let target = directory.join(file_name);
        if target.exists() {
            if fs::read(&target).map_err(|error| error.to_string())? == data { return Ok(target); }
            continue;
        }
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(data).and_then(|_| file.sync_all()) {
                    let _ = fs::remove_file(&target);
                    return Err(error.to_string());
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("文稿副本版本过多，请整理文稿文件夹后重试".into())
}

fn launch_document(path: &Path, reveal: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = {
        let mut command = Command::new("open");
        if reveal { command.arg("-R"); }
        command.arg(path).status()
    };
    #[cfg(target_os = "windows")]
    let status = if reveal {
        Command::new("explorer.exe").arg("/select,").arg(path).status()
    } else {
        Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(path).status()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = Command::new("xdg-open").arg(if reveal { path.parent().unwrap_or(path) } else { path }).status();
    let status = status.map_err(|error| format!("无法打开文稿：{error}"))?;
    if !status.success() { return Err("系统未能打开文稿，请检查默认文件程序".into()); }
    Ok(())
}

#[tauri::command]
pub fn open_saved_document(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    source: String,
    reveal: bool,
) -> Result<String, String> {
    let (folder, file_name, data) = {
        let conn = state.db.lock().map_err(|error| error.to_string())?;
        match source.as_str() {
            "accepted" => {
                let document = load_document(&conn, id)?;
                (format!("accepted-{id}"), document.file_name,
                    document.file_data.ok_or("这篇作品没有原始文稿附件")?)
            }
            "manuscript" => {
                let sent: i64 = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM deliveries WHERE manuscript_id=?1)", [id],
                    |row| row.get(0),
                ).map_err(|error| error.to_string())?;
                if sent == 0 { return Err("这篇作品尚无投递记录".into()); }
                let (name, bytes) = store::load_manuscript_attachment(&conn, id)?
                    .ok_or("这篇投稿计划没有保存 Word 文稿")?;
                (format!("manuscript-{id}"), name, bytes)
            }
            _ => return Err("文稿来源无效".into()),
        }
    };
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let path = managed_document_copy(&root, &folder, &file_name, &data)?;
    launch_document(&path, reveal)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn save_accepted_share_image(path: String, data: Vec<u8>) -> Result<String, String> {
    const PNG_HEADER: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    if path.trim().is_empty()
        || data.len() < PNG_HEADER.len()
        || data.len() > 12 * 1024 * 1024
        || !data.starts_with(&PNG_HEADER)
    {
        return Err("分享图片无效".into());
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn word_file() -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(b"<w:document><w:body><w:p><w:r><w:t>Sent manuscript</w:t></w:r></w:p></w:body></w:document>")
            .unwrap();
        archive.finish().unwrap().into_inner()
    }

    fn input(source: &str, manuscript_id: Option<i64>, title: &str) -> AcceptedWorkInput {
        AcceptedWorkInput {
            manuscript_id,
            source: source.into(),
            review_status: "accepted".into(),
            title: title.into(),
            body: "外部正文".into(),
            file_name: String::new(),
            file_data: None,
            remove_file: false,
            accepted_at: "2026-09-25".into(),
            deal_mode: "guarantee_share".into(),
            price_cents: 0,
            guarantee_cents: 300_000,
            per_thousand_cents: 0,
            realized_share_cents: 0,
            monthly_settlements: Vec::new(),
            share_percent: 47.5,
            sale_platform: "知乎".into(),
            buyer_editor: "编辑甲".into(),
            listing_platform: "番茄".into(),
            article_url: String::new(),
            notes: String::new(),
        }
    }

    #[test]
    fn candidate_confirmation_keeps_a_copy_of_sent_word_file() {
        let conn = crate::db::open_database(":memory:".into()).unwrap();
        let original = word_file();
        conn.execute(
            "INSERT INTO manuscripts (id,title,body,recipients,file_name,file_data)
            VALUES (101,'山海之间','投稿正文','[]','原稿.docx',?1)",
            [&original],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deliveries (id,manuscript_id,recipient,message_id)
            VALUES (1,101,'writer@example.com','message-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO replies (id,delivery_id,from_email,kind,accepted,received_at)
            VALUES (1,1,'editor@example.com','human',1,'2026-09-25 12:00:00')",
            [],
        )
        .unwrap();
        assert_eq!(load_candidates(&conn).unwrap().len(), 1);

        let id = create_work(&conn, input("plan", Some(101), "ignored")).unwrap();
        assert!(load_candidates(&conn).unwrap().is_empty());
        assert!(create_work(&conn, input("plan", Some(101), "ignored")).is_err());
        let mut corrected = input("plan", Some(101), "ignored");
        corrected.review_status = "preliminary".into();
        update_work(&conn, id, corrected).unwrap();
        assert_eq!(load_works(&conn).unwrap()[0].review_status, "preliminary");
        assert_eq!(load_works(&conn).unwrap()[0].sold_at, "");
        let mut final_rejected = input("plan", Some(101), "ignored");
        final_rejected.review_status = "final_rejected".into();
        update_work(&conn, id, final_rejected).unwrap();
        assert_eq!(load_works(&conn).unwrap()[0].review_status, "final_rejected");
        conn.execute("DELETE FROM manuscripts WHERE id=101", [])
            .unwrap();
        let document = load_document(&conn, id).unwrap();
        assert_eq!(document.title, "山海之间");
        let saved_file = document.file_data.unwrap();
        assert_eq!(saved_file, original);
        assert!(crate::commands::manuscripts::extract_docx_text(saved_file)
            .unwrap()
            .contains("Sent manuscript"));
        let work = load_works(&conn).unwrap().remove(0);
        assert_eq!(work.guarantee_cents, 300_000);
        assert_eq!(work.share_percent, 47.5);
    }

    #[test]
    fn external_article_can_be_edited_and_attachment_removed() {
        let conn = crate::db::open_database(":memory:".into()).unwrap();
        let mut draft = input("external", None, "外部文章");
        draft.file_name = "文章.txt".into();
        draft.file_data = Some(b"original".to_vec());
        let id = create_work(&conn, draft).unwrap();
        assert!(load_works(&conn).unwrap()[0].has_file);

        let mut changed = input("external", None, "修改后的文章");
        changed.body = "新正文".into();
        changed.deal_mode = "buyout".into();
        changed.price_cents = 500_050;
        changed.remove_file = true;
        update_work(&conn, id, changed).unwrap();
        let work = load_works(&conn).unwrap().remove(0);
        assert_eq!(work.title, "修改后的文章");
        assert_eq!(work.price_cents, 500_050);
        assert_eq!(work.sold_at, "2026-09-25");
        assert!(!work.has_file);
        assert_eq!(load_document(&conn, id).unwrap().body, "新正文");
    }

    #[test]
    fn unified_record_date_and_settled_share_round_trip_and_validate() {
        let conn = crate::db::open_database(":memory:".into()).unwrap();
        let mut draft = input("external", None, "成交文章");
        draft.accepted_at = "2026-09-19".into();
        draft.realized_share_cents = 12_345;
        let id = create_work(&conn, draft.clone()).unwrap();
        let saved = load_works(&conn).unwrap().remove(0);
        assert_eq!((saved.sold_at.as_str(), saved.realized_share_cents), ("2026-09-19", 12_345));
        draft.accepted_at = "2026-09-25".into();
        draft.realized_share_cents = 23_456;
        update_work(&conn, id, draft.clone()).unwrap();
        let saved = load_works(&conn).unwrap().remove(0);
        assert_eq!((saved.sold_at.as_str(), saved.realized_share_cents), ("2026-09-25", 23_456));
        draft.accepted_at = "2026-02-30".into();
        assert!(create_work(&conn, draft.clone()).is_err());
        draft.accepted_at.clear();
        draft.realized_share_cents = -1;
        assert!(update_work(&conn, id, draft).is_err());

        let mut per_thousand = input("external", None, "千字计价");
        per_thousand.guarantee_cents = 0;
        per_thousand.per_thousand_cents = 3_000;
        let rate_id = create_work(&conn, per_thousand).unwrap();
        let work = load_works(&conn).unwrap().into_iter().find(|work| work.id == rate_id).unwrap();
        assert_eq!(work.per_thousand_cents, 3_000);
        assert_eq!(work.guarantee_cents, 0);
        assert_eq!(work.record_origin, "manual");
        conn.execute("UPDATE accepted_works SET record_origin='historical_import' WHERE id=?1", [rate_id]).unwrap();
        let mut edited = input("external", None, "千字计价");
        edited.guarantee_cents = 0;
        edited.per_thousand_cents = 3_000;
        update_work(&conn, rate_id, edited).unwrap();
        let work = load_works(&conn).unwrap().into_iter().find(|work| work.id == rate_id).unwrap();
        assert_eq!(work.record_origin, "historical_import");
    }

    #[test]
    fn platform_share_tracks_monthly_settlements_without_fixed_price() {
        let conn = crate::db::open_database(":memory:".into()).unwrap();
        let mut draft = input("external", None, "知乎上架文章");
        draft.deal_mode = "platform_share".into();
        draft.price_cents = 0;
        draft.guarantee_cents = 0;
        draft.listing_platform = "知乎".into();
        draft.monthly_settlements = vec![
            crate::models::AcceptedMonthlySettlement { month: "2026-08".into(), amount_cents: 12_345 },
            crate::models::AcceptedMonthlySettlement { month: "2026-09".into(), amount_cents: 23_456 },
        ];
        let id = create_work(&conn, draft.clone()).unwrap();
        let saved = load_works(&conn).unwrap().remove(0);
        assert_eq!(saved.monthly_settlements.len(), 2);
        assert_eq!(saved.monthly_settlements[0].amount_cents, 12_345);
        assert_eq!(saved.sold_at, "2026-09-25");
        draft.monthly_settlements[1].amount_cents = 25_000;
        update_work(&conn, id, draft.clone()).unwrap();
        assert_eq!(load_works(&conn).unwrap()[0].monthly_settlements[1].amount_cents, 25_000);
        draft.monthly_settlements[1].month = "2026-08".into();
        assert!(update_work(&conn, id, draft.clone()).is_err());
        draft.monthly_settlements[1].month = "2026-13".into();
        assert!(update_work(&conn, id, draft.clone()).is_err());
        draft.monthly_settlements.clear();
        draft.listing_platform.clear();
        assert!(update_work(&conn, id, draft).is_err());
    }

    #[test]
    fn managed_document_copy_preserves_existing_versions_and_sanitizes_name() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("novelsub-document-{}-{stamp}", std::process::id()));
        let first = managed_document_copy(&root, "accepted-7", "../稿件.docx", b"first").unwrap();
        assert_eq!(first.file_name().unwrap().to_string_lossy(), "稿件.docx");
        assert_eq!(managed_document_copy(&root, "accepted-7", "稿件.docx", b"first").unwrap(), first);
        let second = managed_document_copy(&root, "accepted-7", "稿件.docx", b"revised").unwrap();
        assert_ne!(second, first);
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
        assert_eq!(std::fs::read(&second).unwrap(), b"revised");
        assert!(safe_document_name("../../bad.exe").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
