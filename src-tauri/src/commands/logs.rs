use std::path::PathBuf;

use rust_xlsxwriter::Workbook;
use tauri::State;

use crate::models::TaskLog;
use crate::state::AppState;
use crate::store;

// ---------- Logs ----------

#[tauri::command]
pub fn list_logs(
    state: State<'_, AppState>,
    task_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<TaskLog>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_logs(&conn, task_id, limit.unwrap_or(200), offset.unwrap_or(0))
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
    state: State<'_, AppState>,
    path: String,
    task_id: Option<i64>,
) -> Result<String, String> {
    let (logs, accounts) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let logs = store::load_logs(&conn, task_id, 100000, 0)?;
        let accounts = store::load_accounts(&conn).unwrap_or_default();
        (logs, accounts)
    };
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let headers = [
        "ID",
        "任务",
        "账号",
        "编辑邮箱",
        "级别",
        "类别",
        "消息",
        "时间",
    ];
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
            .write_string(
                row,
                1,
                log.task_id.map(|v| v.to_string()).unwrap_or_default(),
            )
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(
                row,
                2,
                log.account_id
                    .and_then(|id| {
                        accounts
                            .iter()
                            .find(|a| a.id == id)
                            .map(|a| a.email.clone())
                    })
                    .unwrap_or_default(),
            )
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 3, log.recipient.clone().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 4, &log.level)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 5, &log.category)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 6, &log.message)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string(row, 7, &log.created_at)
            .map_err(|e| e.to_string())?;
    }
    workbook.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
