use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::Rng;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::models::{Account, Manuscript, Task, TaskLog};
use crate::smtp::{self, classify_error};
use crate::state::TaskHandle;
use crate::store;

#[derive(Clone)]
struct SendTarget {
    manuscript: Manuscript,
    recipient: String,
}

enum SendOutcome {
    Success { message_id: String, account_id: i64 },
    Failed,
    RetryLater,
}

fn rand_between(min: i64, max: i64) -> i64 {
    let (lo, hi) = if min > max { (max, min) } else { (min, max) };
    if lo == hi {
        return lo;
    }
    rand::rng().random_range(lo..=hi)
}

fn build_queue(_task: &Task, manuscripts: &[Manuscript]) -> VecDeque<SendTarget> {
    let mut queue = VecDeque::new();
    for manuscript in manuscripts {
        for recipient in &manuscript.recipients {
            queue.push_back(SendTarget {
                manuscript: manuscript.clone(),
                recipient: recipient.clone(),
            });
        }
    }
    // Shuffle so identical content does not go out in a fixed order.
    let mut items: Vec<SendTarget> = queue.into_iter().collect();
    let offset = rand::rng().random_range(0..items.len().max(1));
    items.rotate_left(offset);
    items.into_iter().collect()
}

pub fn spawn_task_worker(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    registry: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    task_id: i64,
) {
    let handle = Arc::new(TaskHandle::new());
    registry.lock().unwrap().insert(task_id, handle.clone());
    tauri::async_runtime::spawn(async move {
        run_task_worker(app, db, registry, task_id, handle).await;
    });
}

pub fn start_scheduler_watcher(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    registry: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let now = {
                let conn = db.lock().unwrap();
                store::now_str(&conn).unwrap_or_default()
            };
            let due: Vec<i64> = {
                let conn = db.lock().unwrap();
                let mut stmt = match conn.prepare(
                    "SELECT id FROM tasks WHERE schedule_type = 'scheduled'
                     AND status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?1",
                ) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let rows = match stmt.query_map([&now], |r| r.get::<_, i64>(0)) {
                    Ok(rows) => rows,
                    Err(_) => continue,
                };
                match rows.collect::<Result<Vec<_>, _>>() {
                    Ok(v) => v,
                    Err(_) => continue,
                }
            };
            for id in due {
                let claimed = {
                    let conn = db.lock().unwrap();
                    conn.execute(
                        "UPDATE tasks SET status = 'running' WHERE id = ?1 AND status = 'scheduled'",
                        [id],
                    )
                    .unwrap_or(0)
                        == 1
                };
                if claimed {
                    spawn_task_worker(app.clone(), db.clone(), registry.clone(), id);
                }
            }
        }
    });
}

async fn interruptible_sleep(secs: u64, handle: &TaskHandle) {
    let mut remaining = secs;
    while remaining > 0 {
        if handle.is_stopped() || handle.is_paused() {
            return;
        }
        let step = remaining.min(1);
        tokio::time::sleep(Duration::from_secs(step)).await;
        remaining -= step;
    }
}

async fn wait_until_resumed(handle: &TaskHandle) {
    while handle.is_paused() && !handle.is_stopped() {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn emit_log(app: &AppHandle, log: &TaskLog) {
    let _ = app.emit("log", log);
}

fn emit_task(app: &AppHandle, db: &Arc<Mutex<Connection>>, task_id: i64) {
    if let Some(task) = {
        let conn = db.lock().unwrap();
        store::load_task(&conn, task_id).ok().flatten()
    } {
        let _ = app.emit("task", &task);
    }
}

fn pick_available_account(db: &Arc<Mutex<Connection>>, cursor: &mut usize) -> Option<Account> {
    let conn = db.lock().unwrap();
    let accounts = store::load_accounts(&conn).ok()?;
    if accounts.is_empty() {
        return None;
    }
    let n = accounts.len();
    for i in 0..n {
        let idx = (*cursor + i) % n;
        let account = &accounts[idx];
        if store::account_available(&conn, account).unwrap_or(false) {
            *cursor = (idx + 1) % n;
            return Some(account.clone());
        }
    }
    None
}

async fn run_task_worker(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    registry: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    task_id: i64,
    handle: Arc<TaskHandle>,
) {
    let (task, settings, manuscripts) = {
        let conn = db.lock().unwrap();
        let _ = store::mark_task_running(&conn, task_id);
        let task = store::load_task(&conn, task_id).ok().flatten();
        let settings = store::load_settings(&conn).unwrap_or_default();
        let manuscripts = match &task {
            Some(t) => store::load_manuscripts(&conn, &t.manuscript_ids).unwrap_or_default(),
            None => Vec::new(),
        };
        (task, settings, manuscripts)
    };

    let task = match task {
        Some(t) => t,
        None => {
            registry.lock().unwrap().remove(&task_id);
            return;
        }
    };

    let first_log = store::insert_log(
        &db.lock().unwrap(),
        Some(task_id),
        None,
        "info",
        "task",
        "任务开始执行",
    );
    if let Ok(log) = first_log {
        emit_log(&app, &log);
    }
    emit_task(&app, &db, task_id);

    if manuscripts.is_empty() {
        let log = store::insert_log(
            &db.lock().unwrap(),
            Some(task_id),
            None,
            "error",
            "task",
            "任务未关联任何稿件，无法执行",
        );
        if let Ok(log) = log {
            emit_log(&app, &log);
        }
        {
            let conn = db.lock().unwrap();
            let _ = store::mark_task_finished(&conn, task_id, "stopped");
        }
        emit_task(&app, &db, task_id);
        registry.lock().unwrap().remove(&task_id);
        return;
    }

    let is_loop = task.schedule_type == "loop";
    let mut queue = build_queue(&task, &manuscripts);
    if !is_loop {
        let total = queue.len() as i64;
        let conn = db.lock().unwrap();
        let _ = conn.execute("UPDATE tasks SET total = ?1 WHERE id = ?2", [total, task_id]);
        if queue.is_empty() {
            let log = store::insert_log(
                &db.lock().unwrap(),
                Some(task_id),
                None,
                "error",
                "task",
                "所选稿件均未设置收件人，无法投递",
            );
            if let Ok(log) = log {
                emit_log(&app, &log);
            }
            {
                let conn = db.lock().unwrap();
                let _ = store::mark_task_finished(&conn, task_id, "stopped");
            }
            emit_task(&app, &db, task_id);
            registry.lock().unwrap().remove(&task_id);
            return;
        }
    }

    let mut cursor: usize = 0;
    let mut batch_remaining = rand_between(task.batch_size_min, task.batch_size_max);

    loop {
        if handle.is_stopped() {
            break;
        }
        if handle.is_paused() {
            {
                let conn = db.lock().unwrap();
                let _ = store::set_task_status(&conn, task_id, "paused");
            }
            emit_task(&app, &db, task_id);
            wait_until_resumed(&handle).await;
            if handle.is_stopped() {
                break;
            }
            {
                let conn = db.lock().unwrap();
                let _ = store::set_task_status(&conn, task_id, "running");
            }
            emit_task(&app, &db, task_id);
        }

        if queue.is_empty() {
            if is_loop {
                queue = build_queue(&task, &manuscripts);
                if queue.is_empty() {
                    let log = store::insert_log(
                        &db.lock().unwrap(),
                        Some(task_id),
                        None,
                        "warning",
                        "task",
                        "稿件未设置收件人，60 秒后重试",
                    );
                    if let Ok(log) = log {
                        emit_log(&app, &log);
                    }
                    interruptible_sleep(60, &handle).await;
                    continue;
                }
            } else {
                let log = store::insert_log(
                    &db.lock().unwrap(),
                    Some(task_id),
                    None,
                    "success",
                    "task",
                    "任务全部投递完成",
                );
                if let Ok(log) = log {
                    emit_log(&app, &log);
                }
                {
                    let conn = db.lock().unwrap();
                    let _ = store::mark_task_finished(&conn, task_id, "completed");
                }
                emit_task(&app, &db, task_id);
                registry.lock().unwrap().remove(&task_id);
                return;
            }
        }

        let target = queue.pop_front().unwrap();

        let account = match pick_available_account(&db, &mut cursor) {
            Some(a) => a,
            None => {
                let log = store::insert_log(
                    &db.lock().unwrap(),
                    Some(task_id),
                    None,
                    "warning",
                    "limit",
                    "无可用账号（全部禁用、限流或已达上限），60 秒后重试",
                );
                if let Ok(log) = log {
                    emit_log(&app, &log);
                }
                queue.push_front(target);
                interruptible_sleep(60, &handle).await;
                continue;
            }
        };

        let sender_name = if target.manuscript.sender_name.trim().is_empty() {
            account.sender_name.clone()
        } else {
            target.manuscript.sender_name.clone()
        };
        let (editor_name, recipient_email) = smtp::parse_recipient(&target.recipient);
        let subject_src = if target.manuscript.subject.trim().is_empty() {
            target.manuscript.title.as_str()
        } else {
            target.manuscript.subject.as_str()
        };
        let subject = smtp::apply_placeholders(subject_src, &editor_name, &recipient_email, &target.manuscript.title);
        let body = smtp::apply_placeholders(
            &smtp::mutate_body(&target.manuscript.body, settings.anti_spam_mutation),
            &editor_name,
            &recipient_email,
            &target.manuscript.title,
        );
        let outcome = send_with_retry(
            &app,
            &db,
            task_id,
            &account,
            &target,
            &sender_name,
            &subject,
            &body,
            task.retry_max,
            settings.limit_cooldown_minutes,
            &mut cursor,
            &handle,
        )
        .await;

        match outcome {
            SendOutcome::Success { message_id, account_id } => {
                {
                    let conn = db.lock().unwrap();
                    let _ = store::increment_task_sent(&conn, task_id);
                    let _ = store::record_account_send(&conn, account_id);
                    let _ = store::insert_delivery(
                        &conn,
                        task_id,
                        account_id,
                        target.manuscript.id,
                        &recipient_email,
                        &subject,
                        &message_id,
                    );
                }
                batch_remaining -= 1;
                let log = store::insert_log(
                    &db.lock().unwrap(),
                    Some(task_id),
                    Some(account.id),
                    "success",
                    "send",
                    &format!("投递成功 → {}", target.recipient),
                );
                if let Ok(log) = log {
                    emit_log(&app, &log);
                }
                emit_task(&app, &db, task_id);
            }
            SendOutcome::RetryLater => {
                queue.push_front(target);
                interruptible_sleep(30, &handle).await;
            }
            SendOutcome::Failed => {}
        }

        if handle.is_stopped() {
            break;
        }

        let delay = rand_between(task.interval_min, task.interval_max);
        interruptible_sleep(delay as u64, &handle).await;
        if handle.is_stopped() {
            break;
        }
        if handle.is_paused() {
            continue;
        }

        if batch_remaining <= 0 {
            batch_remaining = rand_between(task.batch_size_min, task.batch_size_max);
            let pause = rand_between(task.batch_pause_min, task.batch_pause_max);
            let log = store::insert_log(
                &db.lock().unwrap(),
                Some(task_id),
                None,
                "info",
                "batch",
                &format!("本批投递完成，切换账号并休眠 {} 秒", pause),
            );
            if let Ok(log) = log {
                emit_log(&app, &log);
            }
            interruptible_sleep(pause as u64, &handle).await;
        }
    }

    if handle.is_stopped() {
        let log = store::insert_log(
            &db.lock().unwrap(),
            Some(task_id),
            None,
            "warning",
            "task",
            "任务已被手动停止",
        );
        if let Ok(log) = log {
            emit_log(&app, &log);
        }
        {
            let conn = db.lock().unwrap();
            let _ = store::mark_task_finished(&conn, task_id, "stopped");
        }
    }
    emit_task(&app, &db, task_id);
    registry.lock().unwrap().remove(&task_id);
}

#[allow(clippy::too_many_arguments)]
async fn send_with_retry(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    task_id: i64,
    initial_account: &Account,
    target: &SendTarget,
    sender_name: &str,
    subject: &str,
    body: &str,
    retry_max: i64,
    cooldown_minutes: i64,
    cursor: &mut usize,
    handle: &TaskHandle,
) -> SendOutcome {
    let mut account = initial_account.clone();
    let mut network_attempts = 0i64;

    loop {
        if handle.is_stopped() {
            return SendOutcome::Failed;
        }
        if handle.is_paused() {
            wait_until_resumed(handle).await;
            if handle.is_stopped() {
                return SendOutcome::Failed;
            }
        }
        match smtp::send_email(
            &account,
            &smtp::parse_recipient(&target.recipient).1,
            sender_name,
            subject,
            body,
            &target.manuscript.content_type,
        )
        .await
        {
            Ok(message_id) => {
                return SendOutcome::Success {
                    message_id,
                    account_id: account.id,
                }
            }
            Err(err) => {
                let (category, message) = classify_error(&err);
                match category.as_str() {
                    "auth" => {
                        let log = store::insert_log(
                            &db.lock().unwrap(),
                            Some(task_id),
                            Some(account.id),
                            "error",
                            "auth",
                            &format!("账号 {} 认证失败，已自动禁用：{}", account.email, message),
                        );
                        if let Ok(log) = log {
                            emit_log(app, &log);
                        }
                        {
                            let conn = db.lock().unwrap();
                            let _ = store::mark_account_faulty(&conn, account.id);
                        }
                        match pick_available_account(db, cursor) {
                            Some(next) => {
                                account = next;
                                continue;
                            }
                            None => return SendOutcome::RetryLater,
                        }
                    }
                    "limit" => {
                        let log = store::insert_log(
                            &db.lock().unwrap(),
                            Some(task_id),
                            Some(account.id),
                            "warning",
                            "limit",
                            &format!(
                                "账号 {} 触发限流，冻结 {} 分钟：{}",
                                account.email, cooldown_minutes, message
                            ),
                        );
                        if let Ok(log) = log {
                            emit_log(app, &log);
                        }
                        {
                            let conn = db.lock().unwrap();
                            let _ = store::freeze_account(&conn, account.id, cooldown_minutes);
                        }
                        match pick_available_account(db, cursor) {
                            Some(next) => {
                                account = next;
                                continue;
                            }
                            None => return SendOutcome::RetryLater,
                        }
                    }
                    _ => {
                        network_attempts += 1;
                        let log = store::insert_log(
                            &db.lock().unwrap(),
                            Some(task_id),
                            Some(account.id),
                            "warning",
                            "network",
                            &format!("发送失败，稍后重试：{}", message),
                        );
                        if let Ok(log) = log {
                            emit_log(app, &log);
                        }
                        if network_attempts >= retry_max.max(1) {
                            let log = store::insert_log(
                                &db.lock().unwrap(),
                                Some(task_id),
                                Some(account.id),
                                "error",
                                "network",
                                &format!("重试次数耗尽，跳过 {}", target.recipient),
                            );
                            if let Ok(log) = log {
                                emit_log(app, &log);
                            }
                            return SendOutcome::Failed;
                        }
                        interruptible_sleep(10, handle).await;
                        continue;
                    }
                }
            }
        }
    }
}
