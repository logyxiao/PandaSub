use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::models::TaskInput;
use crate::state::{AppState, TaskHandle};
use crate::{scheduler, store};

// ---------- Tasks ----------

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> Result<Vec<crate::models::Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_tasks(&conn)
}

#[tauri::command]
pub fn update_task_accounts(state: State<'_, AppState>, id: i64, account_ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET account_ids = ?1 WHERE id = ?2",
        rusqlite::params![json!(account_ids).to_string(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_task(state: State<'_, AppState>, id: i64) -> Result<Option<crate::models::Task>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_task(&conn, id)
}

fn validate_task_input(conn: &Connection, input: &TaskInput) -> Result<(), String> {
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
        if at <= store::now_str(conn)?.as_str() {
            return Err("定时发送时间必须晚于现在".into());
        }
    }

    let accounts = store::load_accounts(conn)?;
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
    let manuscripts = store::load_manuscripts(conn, &input.manuscript_ids)?;
    if manuscripts.len() != input.manuscript_ids.len() {
        return Err("部分稿件不存在，请刷新后重试".into());
    }
    if manuscripts.iter().map(|m| m.recipients.len()).sum::<usize>() == 0 {
        return Err("所选稿件都没有收件人，请先在稿件中填写编辑部邮箱".into());
    }
    Ok(())
}

#[tauri::command]
pub fn create_task(app: AppHandle, state: State<'_, AppState>, input: TaskInput) -> Result<i64, String> {
    let status = if input.schedule_type == "scheduled" {
        "scheduled"
    } else {
        "stopped"
    };
    let id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        validate_task_input(&conn, &input)?;
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
pub fn update_task(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    input: TaskInput,
) -> Result<(), String> {
    let handle = scheduler::try_reserve_task_handle(&state.tasks, id)?
        .ok_or("任务正在启动、运行或暂停，请先停止后再修改")?;
    let next_status = if input.schedule_type == "scheduled" {
        "scheduled"
    } else {
        "stopped"
    };
    let updated = (|| -> Result<(), String> {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        validate_task_input(&conn, &input)?;
        let changed = conn
            .execute(
                "UPDATE tasks SET name = ?1, manuscript_ids = ?2, account_ids = ?3,
                    status = ?4, schedule_type = ?5, scheduled_at = ?6, retry_max = ?7,
                    finished_at = NULL
                 WHERE id = ?8 AND status IN ('stopped', 'scheduled')",
                rusqlite::params![
                    input.name.trim(),
                    json!(input.manuscript_ids).to_string(),
                    json!(input.account_ids).to_string(),
                    next_status,
                    input.schedule_type,
                    input.scheduled_at,
                    input.retry_max,
                    id,
                ],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(if store::load_task(&conn, id)?.is_some() {
                "任务状态已变化，请刷新后重试".into()
            } else {
                "任务不存在".into()
            });
        }
        Ok(())
    })();
    if let Err(error) = updated {
        release_reserved_task(&state, id, &handle)?;
        return Err(error);
    }
    if input.schedule_type == "scheduled" {
        release_reserved_task(&state, id, &handle)?;
        return Ok(());
    }
    start_reserved_task(app, &state, id, handle)
}

#[tauri::command]
pub fn create_waste_draft_task(
    app: AppHandle,
    state: State<'_, AppState>,
    manuscript_id: i64,
) -> Result<usize, String> {
    let (task_id, cloned_manuscript_id, recipient_count) = {
        let mut conn = state.db.lock().map_err(|e| e.to_string())?;
        let manuscript = store::load_manuscript(&conn, manuscript_id)?
            .ok_or("原计划不存在，请刷新后重试")?;
        let latest_task = store::load_tasks(&conn)?
            .into_iter()
            .find(|task| task.manuscript_ids.contains(&manuscript_id));
        if manuscript.title.trim().ends_with("（废稿）")
            || latest_task
                .as_ref()
                .is_some_and(|task| task.name.trim().ends_with("（废稿）"))
        {
            return Err("当前已经是废稿计划，无需再次创建".into());
        }

        let mut excluded_emails = store::delivered_emails_for_manuscript(&conn, manuscript_id)?;
        excluded_emails.extend(manuscript.recipients.iter().filter_map(|recipient| {
            let email = crate::smtp::parse_recipient(recipient).1.trim().to_lowercase();
            (!email.is_empty()).then_some(email)
        }));

        let mut seen = std::collections::HashSet::new();
        let mut waste_editor_count = 0usize;
        let recipients: Vec<String> = store::load_editors(&conn)?
            .into_iter()
            .filter(|editor| {
                editor.enabled && editor.work_type.iter().any(|tag| tag.trim() == "废稿")
            })
            .filter_map(|editor| {
                waste_editor_count += 1;
                let email = editor.email.trim().to_lowercase();
                if email.is_empty()
                    || !email.contains('@')
                    || excluded_emails.contains(&email)
                    || !seen.insert(email.clone())
                {
                    return None;
                }
                let name = editor.name.trim();
                Some(if name.is_empty() {
                    email
                } else {
                    format!("{name} <{email}>")
                })
            })
            .collect();
        if recipients.is_empty() {
            return Err(if waste_editor_count == 0 {
                "没有启用且带有「废稿」标签的编辑".into()
            } else {
                "所有废稿编辑都已在原计划中或已有成功投递记录，无需重复发送".into()
            });
        }

        let account_ids = if manuscript.account_ids.is_empty() {
            latest_task
                .as_ref()
                .map(|task| task.account_ids.clone())
                .unwrap_or_default()
        } else {
            manuscript.account_ids.clone()
        };
        let has_account = store::load_accounts(&conn)?.into_iter().any(|account| {
            account.enabled && (account_ids.is_empty() || account_ids.contains(&account.id))
        });
        if !has_account {
            return Err("原计划没有可用的投稿邮箱，请先配置并启用邮箱".into());
        }

        let retry_max = latest_task
            .as_ref()
            .map(|task| task.retry_max)
            .unwrap_or(store::load_settings(&conn)?.default_retry_max);
        let manuscript_title = manuscript.title.trim();
        let task_name = format!("{manuscript_title}（废稿）");
        let recipients_json = json!(recipients).to_string();
        let account_ids_json = json!(account_ids).to_string();
        let recipient_count = recipients.len();

        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        transaction.execute(
            "INSERT INTO manuscripts (title, body, content_type, recipients, sender_name,
                word_count, category, reader_category, reader_emotion, style, genres,
                excluded_types, account_ids, send_interval_min, subject, mail_templates,
                file_name, file_data)
             SELECT ?1, body, content_type, ?2, sender_name,
                word_count, category, reader_category, reader_emotion, style, genres,
                excluded_types, ?3, send_interval_min, subject, mail_templates,
                file_name, file_data
             FROM manuscripts WHERE id = ?4",
            rusqlite::params![manuscript_title, recipients_json, account_ids_json, manuscript_id],
        )
        .map_err(|e| e.to_string())?;
        let cloned_manuscript_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO tasks (name, manuscript_ids, account_ids, status, schedule_type, scheduled_at, retry_max)
             VALUES (?1, ?2, ?3, 'stopped', 'immediate', NULL, ?4)",
            rusqlite::params![
                task_name,
                json!([cloned_manuscript_id]).to_string(),
                json!(account_ids).to_string(),
                retry_max,
            ],
        )
        .map_err(|e| e.to_string())?;
        let task_id = transaction.last_insert_rowid();
        transaction.commit().map_err(|e| e.to_string())?;
        (task_id, cloned_manuscript_id, recipient_count)
    };

    if let Err(error) = start_task(app, state.clone(), task_id) {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", [task_id]);
        let _ = conn.execute("DELETE FROM manuscripts WHERE id = ?1", [cloned_manuscript_id]);
        return Err(error);
    }
    Ok(recipient_count)
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
    let handle = scheduler::try_reserve_task_handle(&state.tasks, id)?
        .ok_or("任务已在运行或已暂停，请使用「继续」")?;

    start_reserved_task(app, &state, id, handle)
}

fn release_reserved_task(
    state: &AppState,
    id: i64,
    handle: &Arc<TaskHandle>,
) -> Result<(), String> {
    let mut registry = state.tasks.lock().map_err(|e| e.to_string())?;
    if registry
        .get(&id)
        .is_some_and(|current| Arc::ptr_eq(current, handle))
    {
        registry.remove(&id);
    }
    Ok(())
}

fn start_reserved_task(
    app: AppHandle,
    state: &AppState,
    id: i64,
    handle: Arc<TaskHandle>,
) -> Result<(), String> {

    let prepared = (|| -> Result<(), String> {
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
        Ok(())
    })();
    if let Err(error) = prepared {
        release_reserved_task(state, id, &handle)?;
        return Err(error);
    }

    scheduler::spawn_task_worker_with_handle(
        app.clone(),
        state.db.clone(),
        state.tasks.clone(),
        id,
        handle,
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
