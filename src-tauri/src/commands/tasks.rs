use serde_json::json;
use tauri::{AppHandle, State};

use crate::models::TaskInput;
use crate::state::AppState;
use crate::{scheduler, store};

// ---------- Tasks ----------

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> Result<Vec<crate::models::Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_tasks(&conn)
}

#[tauri::command]
pub fn get_task(state: State<'_, AppState>, id: i64) -> Result<Option<crate::models::Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_task(&conn, id)
}

#[tauri::command]
pub fn create_task(app: AppHandle, state: State<'_, AppState>, input: TaskInput) -> Result<i64, String> {
    if input.name.trim().is_empty() {
        return Err("任务名称不能为空".into());
    }
    if input.manuscript_ids.is_empty() {
        return Err("请选择至少一篇稿件".into());
    }
    if input.schedule_type == "scheduled" {
        let Some(at) = input.scheduled_at.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            return Err("请选择定时发送的时间".into());
        };
        let now = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            store::now_str(&conn)?
        };
        if at <= now.as_str() {
            return Err("定时发送时间必须晚于现在".into());
        }
    }

    let status = if input.schedule_type == "scheduled" {
        "scheduled"
    } else {
        "stopped"
    };
    let id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let accounts = store::load_accounts(&conn)?;
        let selected: Vec<&crate::models::Account> = if input.account_ids.is_empty() {
            accounts.iter().filter(|a| a.enabled).collect()
        } else {
            accounts
                .iter()
                .filter(|a| input.account_ids.contains(&a.id) && a.enabled)
                .collect()
        };
        if selected.is_empty() {
            return Err(if input.account_ids.is_empty() {
                "请先添加并启用至少一个发件邮箱".into()
            } else {
                "所选邮箱不存在或未启用，请重新勾选参与发送的邮箱".into()
            });
        }
        let manuscripts = store::load_manuscripts(&conn, &input.manuscript_ids)?;
        if manuscripts.len() != input.manuscript_ids.len() {
            return Err("部分稿件不存在，请刷新后重试".into());
        }
        let recipients: usize = manuscripts.iter().map(|m| m.recipients.len()).sum();
        if recipients == 0 {
            return Err("所选稿件都没有收件人，请先在稿件中填写编辑部邮箱".into());
        }
        conn.execute(
            "INSERT INTO tasks (name, manuscript_ids, account_ids, status, schedule_type, scheduled_at, retry_max)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                input.name.trim(),
                json!(input.manuscript_ids).to_string(),
                json!(input.account_ids).to_string(),
                status,
                input.schedule_type,
                input.scheduled_at,
                input.retry_max
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };
    if input.schedule_type != "scheduled" {
        start_task(app, state, id)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = registry.get(&id) {
            handle.stop();
        }
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM task_logs WHERE task_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn start_task(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        if registry.contains_key(&id) {
            return Err("任务已在运行或已暂停，请使用「继续」".into());
        }
    }
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let task = store::load_task(&conn, id)?.ok_or("任务不存在")?;
        if task.status == "running" {
            return Err("任务已在运行".into());
        }
        if task.status == "paused" {
            return Err("任务已暂停，请点击「继续」".into());
        }
        // 已完成的重新发送要清零进度从头投递；已停止且发过部分的任务保留进度，继续投递剩余收件人（跳过已投递的）。
        if task.sent == 0 || task.status == "completed" {
            store::reset_task_progress(&conn, id)?;
        }
    }
    scheduler::spawn_task_worker(
        app.clone(),
        state.db.clone(),
        state.tasks.clone(),
        id,
    );
    Ok(())
}

#[tauri::command]
pub fn pause_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let handle = registry.get(&id).ok_or("任务未在运行（可能已结束，或应用重启后已自动停止）")?;
    handle.pause();
    Ok(())
}

#[tauri::command]
pub fn resume_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let handle = registry.get(&id).ok_or("任务未在运行（可能已结束，或应用重启后已自动停止）")?;
    handle.resume();
    Ok(())
}

#[tauri::command]
pub fn stop_task(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        if let Some(handle) = registry.get(&id) {
            handle.stop();
            return Ok(());
        }
    }
    // 没有活动 worker（例如应用重启后遗留的假运行状态）：清掉状态而不是静默无操作。
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(task) = store::load_task(&conn, id)? {
        if matches!(task.status.as_str(), "running" | "paused") {
            store::set_task_status(&conn, id, "stopped")?;
        }
    }
    Ok(())
}

