use std::collections::BTreeMap;
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
    state: State<'_, AppState>,
    id: i64,
    is_read: bool,
) -> Result<(), String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (target, account) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let target = store::reply_flag_target(&conn, id)?.ok_or("邮件不存在或已删除")?;
            let account = store::load_account(&conn, target.account_id)?.ok_or("邮箱账号已删除")?;
            (target, account)
        };
        if account.imap_generation != target.generation || target.uid_validity <= 0 {
            return Err("邮件所属邮箱已重置，无法同步这封邮件的已读状态".into());
        }
        crate::inbox::store_seen_flag(&account, target.uid_validity, target.uid, is_read)?;
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::update_reply_server_read(&conn, &target, is_read)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_reply_read_flags(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<crate::models::ReplyReadState>, String> {
    if ids.len() > 100 {
        return Err("一次最多同步 100 封邮件".into());
    }
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut groups: BTreeMap<
            (i64, i64),
            (crate::models::Account, Vec<store::ReplyFlagTarget>),
        > = BTreeMap::new();
        {
            let conn = db.lock().map_err(|e| e.to_string())?;
            for id in ids {
                let Some(target) = store::reply_flag_target(&conn, id)? else {
                    continue;
                };
                let Some(account) = store::load_account(&conn, target.account_id)? else {
                    continue;
                };
                if account.imap_generation != target.generation
                    || target.uid_validity <= 0
                    || account.imap_host.trim().is_empty()
                {
                    continue;
                }
                groups
                    .entry((target.account_id, target.uid_validity))
                    .or_insert_with(|| (account, Vec::new()))
                    .1
                    .push(target);
            }
        }
        let mut results = Vec::new();
        let mut first_error = None;
        for ((_, validity), (account, targets)) in groups {
            let uids = targets.iter().map(|target| target.uid).collect::<Vec<_>>();
            match crate::inbox::fetch_seen_flags(&account, validity, &uids) {
                Ok(states) => {
                    let conn = db.lock().map_err(|e| e.to_string())?;
                    for target in targets {
                        if let Some(&is_read) = states.get(&target.uid) {
                            if store::update_reply_read_from_sync(&conn, &target, is_read)
                                .unwrap_or(false)
                            {
                                results.push(crate::models::ReplyReadState {
                                    id: target.id,
                                    is_read,
                                    read_synced: true,
                                });
                            }
                        }
                    }
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error)
                    }
                }
            }
        }
        if results.is_empty() {
            if let Some(error) = first_error {
                return Err(format!("同步邮箱已读状态失败：{error}"));
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
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
    let keywords = store::load_settings(&conn)?.auto_reply_subject_keywords;
    let replies = store::load_replies(&conn, None, None, 100_000)?;
    let mut changed = 0usize;
    for reply in replies {
        let result = crate::classify::classify_with_keywords(
            &crate::classify::IncomingMail {
                from: reply.from_email.clone(),
                subject: reply.subject.clone(),
                body: reply.body.clone(),
                content_type: String::new(),
                extra_headers: Vec::new(),
            },
            &keywords,
        );
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
