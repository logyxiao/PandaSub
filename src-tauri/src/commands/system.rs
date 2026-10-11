use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::models::{MailTemplate, Settings};
use crate::state::AppState;
use crate::store;

// ---------- Settings ----------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_settings(&conn)
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, mut settings: Settings) -> Result<(), String> {
    if settings.default_retry_max < 1 { return Err("发送重试次数至少为 1".into()); }
    if settings.reply_poll_minutes < 1 {
        return Err("检查回复间隔至少 1 分钟".into());
    }
    normalize_reply_keywords(&mut settings.auto_reply_subject_keywords, "自动回复")?;
    normalize_reply_keywords(&mut settings.acceptance_body_keywords, "过稿统计")?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::save_settings(&conn, &settings)
}

fn normalize_reply_keywords(keywords: &mut Vec<String>, label: &str) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    *keywords = std::mem::take(keywords).into_iter().map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(value.to_lowercase())).collect();
    if keywords.len() > 30 || keywords.iter().any(|value| value.chars().count() > 80) {
        return Err(format!("{label}关键词最多 30 个，每个最多 80 字"));
    }
    Ok(())
}

#[tauri::command]
pub fn get_default_mail_templates(state: State<'_, AppState>) -> Result<Vec<MailTemplate>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_default_mail_templates(&conn)
}

#[tauri::command]
pub fn save_default_mail_templates(
    state: State<'_, AppState>,
    templates: Vec<MailTemplate>,
) -> Result<(), String> {
    if templates.is_empty() {
        return Err("至少保留一套默认邮件模板".into());
    }
    if templates.iter().all(|item| item.body.trim().is_empty()) {
        return Err("默认邮件模板至少需要一套正文".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::save_default_mail_templates(&conn, &templates)
}

#[tauri::command]
pub fn set_autostart(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
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
pub async fn backup_data(app: AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || backup_database(&data_dir)).await.map_err(|e| e.to_string())?
}

/// Creates a consistent snapshot of the WAL database in the data directory.
pub fn backup_database(data_dir: &Path) -> Result<String, String> {
    let src = data_dir.join("novelsub.sqlite");
    let backup_dir = data_dir.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dst = backup_dir.join(format!("novelsub_backup_{ts}_{}.sqlite", rand::random::<u128>()));
    // The database runs in WAL mode. Copying only the main file can omit
    // committed pages that are still in the WAL, so ask SQLite for a
    // consistent snapshot instead.
    let snapshot = Connection::open(&src).map_err(|e| e.to_string())?;
    let temporary = dst.with_extension("sqlite.tmp");
    if let Err(error) = snapshot.execute("VACUUM INTO ?1", [&temporary.to_string_lossy().to_string()]) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    std::fs::rename(&temporary, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_deliveries(
    state: State<'_, AppState>,
    manuscript_id: Option<i64>,
) -> Result<Vec<crate::models::Delivery>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match manuscript_id {
        Some(id) => store::load_manuscript_deliveries(&conn, id),
        None => store::load_recent_deliveries(&conn, 365),
    }
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

#[tauri::command]
pub async fn delivery_summary_page(
    state: State<'_, AppState>,
    manuscript_id: i64,
    emails: Vec<String>,
    matching: Vec<usize>,
    filter: String,
    limit: i64,
    offset: i64,
) -> Result<store::DeliverySummaryPage, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::delivery_summary_page(
            &conn,
            manuscript_id,
            &emails,
            &matching,
            &filter,
            limit,
            offset,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    #[test]
    fn successive_backups_have_unique_paths_and_include_wal_data() {
        let root = std::env::temp_dir().join(format!("novelsub-backup-{}", rand::random::<u128>()));
        std::fs::create_dir_all(&root).unwrap();
        let conn = crate::db::open_database(root.join("novelsub.sqlite")).unwrap();
        conn.execute("INSERT INTO manuscripts(title,body) VALUES('fixture','body')", []).unwrap();
        let first = backup_database(&root).unwrap(); let second = backup_database(&root).unwrap();
        assert_ne!(first, second);
        for path in [first, second] {
            let snapshot = Connection::open(path).unwrap();
            assert_eq!(snapshot.query_row("SELECT COUNT(*) FROM manuscripts WHERE title='fixture'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        }
        drop(conn); std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod keyword_tests {
    use super::*;
    #[test]
    fn reply_keyword_validation_is_shared_and_counts_unique_unicode_entries() {
        let mut keywords = vec![" 签约邀请 ".into(),"READY".into(),"ready".into()," ".into()];
        normalize_reply_keywords(&mut keywords,"过稿统计").unwrap();
        assert_eq!(keywords,vec!["签约邀请","READY"]);
        normalize_reply_keywords(&mut Vec::new(),"过稿统计").unwrap();
        assert!(normalize_reply_keywords(&mut vec!["过".repeat(81)],"过稿统计").unwrap_err().contains("过稿统计"));
        assert!(normalize_reply_keywords(&mut (0..31).map(|i|format!("词{i}")).collect(),"过稿统计").is_err());
        assert!(normalize_reply_keywords(&mut vec!["重复".into();31],"过稿统计").is_ok());
    }
}
