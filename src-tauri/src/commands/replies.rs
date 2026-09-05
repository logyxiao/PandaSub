use tauri::{AppHandle, State};

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
pub async fn scan_replies(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let db = state.db.clone();
    let scan_lock = state.reply_scan.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::inbox::scan_all_accounts(&app, &db, &scan_lock)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按当前分类规则重新判定历史回复（不改动邮件内容，只重算 kind / reason / accepted），返回被改动的条数。
#[tauri::command]
pub fn reclassify_replies(state: State<'_, AppState>) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let replies = store::load_replies(&conn, None, None, 100_000)?;
    let mut changed = 0usize;
    for reply in replies {
        let result = crate::classify::classify(&crate::classify::IncomingMail {
            from: reply.from_email.clone(),
            subject: reply.subject.clone(),
            body: reply.body.clone(),
            content_type: String::new(),
            extra_headers: Vec::new(),
        });
        let new_kind = result.kind.as_str();
        let accepted = result.kind == crate::classify::ReplyKind::Human
            && crate::classify::body_suggests_accepted(&reply.body);
        if new_kind != reply.kind || result.reason != reply.reason || accepted != reply.accepted {
            store::update_reply_kind(&conn, reply.id, new_kind, &result.reason, accepted)?;
            changed += 1;
        }
    }
    Ok(changed)
}
