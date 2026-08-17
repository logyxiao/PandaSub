use std::time::{SystemTime, UNIX_EPOCH};
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::models::Settings;
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
    let feed = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_settings(&conn)?.update_feed_url.trim().to_string()
    };
    if feed.is_empty() {
        return Ok(UpdateInfo {
            current,
            has_update: false,
            latest: String::new(),
            feed,
        });
    }
    if !feed.starts_with("https://") && !feed.starts_with("http://") {
        return Err("更新源必须是 http:// 或 https:// 地址".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("无法创建更新检查请求：{e}"))?;
    let response = client
        .get(&feed)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| format!("检查更新失败：{e}"))?;
    if response.content_length().unwrap_or(0) > 1024 * 1024 {
        return Err("更新源返回的数据过大".into());
    }
    let raw = response.text().map_err(|e| format!("读取更新信息失败：{e}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("更新源不是有效的 JSON：{e}"))?;
    let latest = value
        .get("version")
        .or_else(|| value.get("latest"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.as_str())
        .unwrap_or_default()
        .trim()
        .trim_start_matches('v')
        .to_string();
    if latest.is_empty() {
        return Err("更新源缺少 version 或 latest 字段".into());
    }
    let current_version = semver::Version::parse(current.trim_start_matches('v'))
        .map_err(|e| format!("当前版本格式无效：{e}"))?;
    let latest_version = semver::Version::parse(&latest)
        .map_err(|e| format!("更新源版本格式无效：{e}"))?;
    Ok(UpdateInfo {
        current,
        has_update: latest_version > current_version,
        latest,
        feed,
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
