use tauri::State;

use crate::models::Dashboard;
use crate::state::AppState;
use crate::store;

// ---------- Dashboard ----------

#[tauri::command]
pub async fn get_dashboard(state: State<'_, AppState>, reply_kind: Option<String>) -> Result<Dashboard, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        load_dashboard_filtered(&conn, reply_kind.as_deref())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn running_task_count(state: State<'_, AppState>) -> Result<i64, String> {
    let db=state.db.clone();
    tauri::async_runtime::spawn_blocking(move||{
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE status = 'running'",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
pub(crate) fn load_dashboard(conn: &rusqlite::Connection) -> Result<Dashboard, String> {
    load_dashboard_filtered(conn, None)
}
fn load_dashboard_filtered(conn: &rusqlite::Connection, kind: Option<&str>) -> Result<Dashboard, String> {
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
    let tasks = store::load_dashboard_tasks(conn)?;
    let recent_replies = store::load_replies(conn, kind.filter(|kind| !kind.is_empty()), None, 3)?;
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

#[cfg(test)]
mod recent_reply_tests {
    use super::*;
    #[test]
    fn filter_precedes_recent_limit() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO replies(kind,subject,received_at) VALUES('human','older human','2026-01-01')", []).unwrap();
        for _ in 0..35 { conn.execute("INSERT INTO replies(kind,subject,received_at) VALUES('auto','new auto','2026-02-01')", []).unwrap(); }
        let dashboard = load_dashboard_filtered(&conn, Some("human")).unwrap();
        assert_eq!(dashboard.recent_replies.len(), 1);
        assert_eq!(dashboard.recent_replies[0].subject, "older human");
        assert_eq!(load_dashboard_filtered(&conn, None).unwrap().recent_replies.len(), 3);
    }
}
