use tauri::State;

use crate::models::Dashboard;
use crate::state::AppState;
use crate::store;

// ---------- Dashboard ----------

#[tauri::command]
pub fn get_dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    load_dashboard(&conn)
}

#[tauri::command]
pub fn running_task_count(state: State<'_, AppState>) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE status = 'running'",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn load_dashboard(conn: &rusqlite::Connection) -> Result<Dashboard, String> {
    let count = |table: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    let sent_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deliveries WHERE sent_at >= date('now','localtime')
             AND sent_at < date('now','localtime','+1 day')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let failed_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM task_logs WHERE level = 'error'
             AND category IN ('network', 'send', 'limit', 'auth')
             AND TRIM(COALESCE(recipient, '')) <> ''
             AND created_at >= date('now','localtime') AND created_at < date('now','localtime','+1 day')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let running_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE status = 'running'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let account_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts WHERE enabled = 1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let tasks = store::load_tasks(conn)?;
    let recent_replies = store::load_replies(conn, None, None, 30)?;
    let human_replies = store::count_replies(conn, "human").unwrap_or(0);
    let auto_replies = store::count_replies(conn, "auto").unwrap_or(0);
    let accepted_replies = store::count_accepted_replies(conn).unwrap_or(0);
    Ok(Dashboard {
        account_count,
        manuscript_count: count("manuscripts")?,
        editor_count: count("editors").unwrap_or(0),
        sent_today,
        failed_today,
        running_tasks,
        human_replies,
        auto_replies,
        accepted_replies,
        tasks,
        recent_replies,
    })
}
