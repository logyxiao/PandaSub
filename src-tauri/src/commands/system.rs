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
pub fn update_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    if settings.reply_poll_minutes < 1 {
        return Err("检查回复间隔至少 1 分钟".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::save_settings(&conn, &settings)
}

#[tauri::command]
pub fn get_default_mail_templates(
    state: State<'_, AppState>,
) -> Result<Vec<MailTemplate>, String> {
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
pub fn backup_data(app: AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    backup_database(&data_dir)
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
    let dst = backup_dir.join(format!("novelsub_backup_{ts}.sqlite"));
    // The database runs in WAL mode. Copying only the main file can omit
    // committed pages that are still in the WAL, so ask SQLite for a
    // consistent snapshot instead.
    let snapshot = Connection::open(&src).map_err(|e| e.to_string())?;
    snapshot
        .execute("VACUUM INTO ?1", [&dst.to_string_lossy().to_string()])
        .map_err(|e| e.to_string())?;
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
