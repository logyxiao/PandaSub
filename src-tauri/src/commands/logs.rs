use std::{collections::HashMap, path::PathBuf};

use rust_xlsxwriter::Workbook;
use tauri::State;

use crate::models::{LogPage, TaskLog};
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
pub async fn list_logs_page(
    state: State<'_, AppState>,
    task_id: Option<i64>,
    level: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<LogPage, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::query_logs(
            &conn,
            task_id,
            level.as_deref(),
            query.as_deref(),
            limit.unwrap_or(20).clamp(1, 100),
            offset.unwrap_or(0).max(0),
        )
    })
    .await
    .map_err(|e| e.to_string())?
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
pub async fn export_logs(
    state: State<'_, AppState>,
    path: String,
    task_id: Option<i64>,
    level: Option<String>,
    query: Option<String>,
) -> Result<String, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (logs, accounts) = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            export_rows(&conn, task_id, level.as_deref(), query.as_deref())?
        };
        write_log_workbook(path, &logs, &accounts)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Explicit limit instead of silently discarding records. Query zero rows first
// so an over-limit export does not allocate an oversized snapshot or touch a file.
type ExportRows = (Vec<TaskLog>, HashMap<i64, String>);
pub(crate) fn export_rows(
    conn: &rusqlite::Connection,
    task_id: Option<i64>,
    level: Option<&str>,
    query: Option<&str>,
) -> Result<ExportRows, String> {
    let total = store::query_logs(conn, task_id, level, query, 0, 0)?.total;
    if total > 100_000 {
        return Err(format!(
            "当前筛选共有 {total} 条记录，单次导出上限为 100000 条，请缩小计划、结果或邮箱筛选范围"
        ));
    }
    let logs = store::query_logs(conn, task_id, level, query, total, 0)?.items;
    let mut stmt = conn
        .prepare("SELECT id, email FROM accounts")
        .map_err(|e| e.to_string())?;
    let accounts = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|e| e.to_string())?;
    Ok((logs, accounts))
}

fn write_log_workbook(
    path: String,
    logs: &[TaskLog],
    accounts: &HashMap<i64, String>,
) -> Result<String, String> {
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
                    .and_then(|id| accounts.get(&id))
                    .map(String::as_str)
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

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{open_workbook_auto, Data, Reader};

    #[test]
    fn exported_workbook_preserves_filtered_columns_and_literal_content() {
        let conn = crate::db::test_database();
        conn.execute_batch("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'sender@example.com','fixture','localhost');").unwrap();
        store::insert_send_log(
            &conn,
            None,
            None,
            Some(1),
            "error",
            "send",
            "=1+1",
            "编辑@example.com",
        )
        .unwrap();
        store::insert_log(&conn, None, None, "success", "test", "excluded").unwrap();
        let (rows, accounts) = export_rows(&conn, None, Some("error"), None).unwrap();
        let path = std::env::temp_dir().join(format!(
            "novelsub-log-test-{}-{}.xlsx",
            std::process::id(),
            rand::random::<u64>()
        ));
        write_log_workbook(path.to_string_lossy().into_owned(), &rows, &accounts).unwrap();
        let mut workbook = open_workbook_auto(&path).unwrap();
        let range = workbook.worksheet_range_at(0).unwrap().unwrap();
        assert_eq!(range.height(), 2);
        assert_eq!(range.get((0, 2)), Some(&Data::String("账号".into())));
        assert_eq!(
            range.get((1, 2)),
            Some(&Data::String("sender@example.com".into()))
        );
        assert_eq!(
            range.get((1, 3)),
            Some(&Data::String("编辑@example.com".into()))
        );
        assert_eq!(range.get((1, 4)), Some(&Data::String("error".into())));
        assert_eq!(range.get((1, 6)), Some(&Data::String("=1+1".into())));
        drop(workbook);
        std::fs::remove_file(path).unwrap();
    }
}
