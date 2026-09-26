use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use crate::store;

// ---------- Replies ----------

#[tauri::command]
pub async fn list_replies_page(
    state: State<'_, AppState>,
    kind: Option<String>,
    task_id: Option<i64>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    account_id: Option<i64>,
) -> Result<crate::models::ReplyPage, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::query_replies(
            &conn,
            kind.as_deref().filter(|s| !s.is_empty()),
            task_id,
            query.as_deref().unwrap_or(""),
            limit.unwrap_or(20).clamp(1, 100),
            offset.unwrap_or(0),
            account_id,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_replies(
    state: State<'_, AppState>,
    kind: Option<String>,
    task_id: Option<i64>,
) -> Result<Vec<crate::models::Reply>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_replies(
        &conn,
        kind.as_deref().filter(|s| !s.is_empty()),
        task_id,
        300,
    )
}

#[tauri::command]
pub async fn set_reply_read(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    is_read: bool,
) -> Result<(), String> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (target, account) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let target = store::reply_flag_target(&conn, id)?.ok_or("邮件不存在或已删除")?;
            let account = store::load_account(&conn, target.account_id)?.ok_or("邮箱账号已删除")?;
            (target, account)
        };
        if account.imap_generation != target.generation || target.uid_validity <= 0 {
            return Err("邮件所属邮箱已重置，无法同步这封邮件的已读状态".into());
        }
        let is_read = is_read || target.kind == "auto";
        crate::inbox::store_seen_flag(&account, target.uid_validity, target.uid, is_read)?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::update_reply_server_read(&conn, &target, is_read)
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_ok() {
        let _ = app.emit("reply-read-change", ());
    }
    result
}

#[tauri::command]
pub async fn sync_reply_read_flags(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<crate::models::ReplyFlagSyncResult, String> {
    if ids.len() > 100 {
        return Err("一次最多同步 100 封邮件".into());
    }
    let db = state.db.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::inbox::sync_reply_flags(&db, ids))
            .await
            .map_err(|e| e.to_string())?;
    if result.as_ref().is_ok_and(|result| !result.states.is_empty()) {
        let _ = app.emit("reply-read-change", ());
    }
    result
}

#[tauri::command]
pub async fn scan_replies(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let db = state.db.clone();
    let scan_lock = state.reply_scan.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::inbox::scan_all_accounts(&app, &db, &scan_lock)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reclassify a bounded snapshot in small transactions, outside the UI thread.
#[tauri::command]
pub async fn reclassify_replies(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let db = state.db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || reclassify_history(&db))
        .await
        .map_err(|e| e.to_string())?;
    // Even a later batch failure can follow committed batches; refresh consumers in either case.
    let _ = app.emit("reply-read-change", ());
    result
}

fn reclassify_history(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
) -> Result<usize, String> {
    let (keywords, upper): (Vec<String>, i64) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        (
            store::load_settings(&conn)?.auto_reply_subject_keywords,
            conn.query_row("SELECT COALESCE(MAX(id),0) FROM replies", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?,
        )
    };
    let mut cursor = 0;
    let mut changed = 0;
    loop {
        let batch = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT id,kind,reason,accepted,delivery_id,from_email,subject,body FROM replies WHERE id>?1 AND id<=?2 ORDER BY id LIMIT 250").map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![cursor, upper], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if batch.is_empty() {
            break;
        }
        cursor = batch.last().unwrap().0;
        let mut updates = Vec::new();
        for (id, kind, reason, accepted, delivery, from, subject, body) in batch {
            // A prior bounce classification can rely solely on MIME/headers that older
            // records did not persist. Subject keyword edits must not erase that evidence.
            if kind == "bounce" {
                continue;
            }
            let result = crate::classify::classify_with_keywords(
                &crate::classify::IncomingMail {
                    from,
                    subject,
                    body: body.clone(),
                    ..Default::default()
                },
                &keywords,
            );
            let next_accepted = delivery.is_some()
                && result.kind == crate::classify::ReplyKind::Human
                && crate::classify::body_suggests_accepted(&body);
            if result.kind.as_str() != kind || result.reason != reason || next_accepted != accepted
            {
                updates.push((
                    id,
                    kind,
                    reason,
                    accepted,
                    result.kind.as_str(),
                    result.reason,
                    next_accepted,
                ));
            }
        }
        if updates.is_empty() {
            continue;
        }
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare_cached("UPDATE replies SET read_revision=read_revision+1,kind=?1,reason=?2,accepted=?3,
                is_read=CASE WHEN ?1='auto' THEN 1 ELSE is_read END,
                read_synced=CASE WHEN ?1='auto' AND is_read=0 THEN 0 ELSE read_synced END
                WHERE id=?4 AND kind=?5 AND reason=?6 AND accepted=?7").map_err(|e| e.to_string())?;
            for (id, old_kind, old_reason, old_accepted, kind, reason, accepted) in updates {
                changed += stmt
                    .execute(rusqlite::params![
                        kind,
                        reason,
                        accepted,
                        id,
                        old_kind,
                        old_reason,
                        old_accepted
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

#[cfg(test)]
mod classification_tests {
    use super::*;
    #[test]
    fn history_keeps_mime_bounces_and_processes_multiple_batches() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO replies(kind,reason,subject,body) VALUES('bounce','MIME report','Message report','Unable to deliver')", []).unwrap();
        for _ in 0..503 {
            conn.execute(
                "INSERT INTO replies(kind,subject,body) VALUES('human','自动回复：收到','正文')",
                [],
            )
            .unwrap();
        }
        let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
        assert_eq!(reclassify_history(&db).unwrap(), 503);
        assert_eq!(reclassify_history(&db).unwrap(), 0);
        let conn = db.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT kind FROM replies WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "bounce"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM replies WHERE kind='auto' AND is_read=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            503
        );
    }
}

#[tauri::command]
pub async fn unread_human_reply_count(state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::unread_human_reply_count(&conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_inbox_status(state: State<'_, AppState>) -> Vec<crate::inbox::InboxStatus> {
    state.reply_scan.statuses()
}

#[tauri::command]
pub async fn get_local_reply_content(
    state: State<'_, AppState>,
    id: i64,
) -> Result<crate::inbox::content::MailContent, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || crate::inbox::content::load_local(&db, id))
        .await.map_err(|e| e.to_string())?
}

static DETAIL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[tauri::command]
pub async fn get_reply_content(
    state: State<'_, AppState>,
    id: i64,
) -> Result<crate::inbox::content::MailContent, String> {
    let db = state.db.clone();
    let permit = DETAIL_SLOTS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        crate::inbox::content::load(&db, id)
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_reply_attachment(
    state: State<'_, AppState>,
    id: i64,
    index: usize,
    path: String,
) -> Result<(), String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let data: Vec<u8> = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT data FROM reply_files WHERE reply_id=?1 AND part_index=?2",
                rusqlite::params![id, index as i64],
                |r| r.get(0),
            )
            .map_err(|_| "附件尚未加载，请重新打开邮件".to_string())?
        };
        std::fs::write(path, data).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_mail_link(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "链接格式无效".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err("不支持这种链接类型".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("open")
            .arg(parsed.as_str())
            .status();
        #[cfg(target_os = "linux")]
        let result = std::process::Command::new("xdg-open")
            .arg(parsed.as_str())
            .status();
        #[cfg(target_os = "windows")]
        let result = std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed.as_str())
            .status();
        let status = result.map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("无法打开链接，请复制链接到浏览器".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
