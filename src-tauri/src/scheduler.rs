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

type SharedAttachment = Option<Arc<(String, Vec<u8>)>>;
type AttachmentMap = HashMap<i64, SharedAttachment>;

#[derive(Clone)]
struct SendTarget {
    manuscript: Arc<Manuscript>,
    recipient: String,
    /// 附件（文件名 + 内容），无附件时为 None。
    attachment: Option<Arc<(String, Vec<u8>)>>,
}

enum SendOutcome {
    Success { message_id: String, account_id: i64 },
    Failed,
    RetryLater,
}

fn delivery_target_key(manuscript_id: i64, recipient: &str) -> (i64, String) {
    let (_, email) = smtp::parse_recipient(recipient);
    (manuscript_id, email.trim().to_lowercase())
}

fn build_queue(
    _task: &Task,
    manuscripts: &[Manuscript],
    attachments: &AttachmentMap,
) -> VecDeque<SendTarget> {
    let mut queue = VecDeque::new();
    for manuscript in manuscripts {
        let shared_manuscript = Arc::new(manuscript.clone());
        let attachment = attachments.get(&manuscript.id).cloned().flatten();
        for recipient in &manuscript.recipients {
            queue.push_back(SendTarget {
                manuscript: shared_manuscript.clone(),
                recipient: recipient.clone(),
                attachment: attachment.clone(),
            });
        }
    }
    // Shuffle so identical content does not go out in a fixed order.
    let mut items: Vec<SendTarget> = queue.into_iter().collect();
    let offset = rand::rng().random_range(0..items.len().max(1));
    items.rotate_left(offset);
    items.into_iter().collect()
}

pub fn try_reserve_task_handle(
    registry: &Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    task_id: i64,
) -> Result<Option<Arc<TaskHandle>>, String> {
    let handle = Arc::new(TaskHandle::new());
    let mut tasks = registry.lock().map_err(|e| e.to_string())?;
    if tasks.contains_key(&task_id) {
        return Ok(None);
    }
    tasks.insert(task_id, handle.clone());
    Ok(Some(handle))
}

pub fn spawn_task_worker_with_handle(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    registry: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    task_id: i64,
    handle: Arc<TaskHandle>,
) {
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
                let handle = match try_reserve_task_handle(&registry, id) {
                    Ok(Some(handle)) => handle,
                    Ok(None) | Err(_) => continue,
                };
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
                    spawn_task_worker_with_handle(
                        app.clone(),
                        db.clone(),
                        registry.clone(),
                        id,
                        handle,
                    );
                } else {
                    let mut tasks = registry.lock().unwrap();
                    if tasks
                        .get(&id)
                        .is_some_and(|current| Arc::ptr_eq(current, &handle))
                    {
                        tasks.remove(&id);
                    }
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

/// 3 分钟沿用现在的节奏：2–4 分钟随机，偏向 3 分钟。其余选项按所选分钟数，略加抖动。
fn send_delay_secs(interval_min: i64) -> u64 {
    let mut rng = rand::rng();
    match crate::models::normalize_send_interval_min(interval_min) {
        3 => {
            let a = rng.random_range(0..=120);
            let b = rng.random_range(0..=120);
            (120 + (a + b) / 2) as u64
        }
        minutes => {
            let base = (minutes as u64).saturating_mul(60);
            let jitter = 12u64.min(base / 6).max(4);
            let lo = base.saturating_sub(jitter).max(30);
            let hi = base.saturating_add(jitter);
            rng.random_range(lo..=hi)
        }
    }
}

fn pick_available_account(
    db: &Arc<Mutex<Connection>>,
    cursor: &mut usize,
    allowed: &std::collections::HashSet<i64>,
) -> Option<Account> {
    let conn = db.lock().unwrap();
    let accounts = store::load_accounts(&conn).ok()?;
    if accounts.is_empty() {
        return None;
    }
    let scope: Vec<&Account> = if allowed.is_empty() {
        accounts.iter().collect()
    } else {
        accounts.iter().filter(|a| allowed.contains(&a.id)).collect()
    };
    if scope.is_empty() {
        return None;
    }
    let n = scope.len();
    let cursor_mod = if n == 0 { 0 } else { *cursor % n };
    for i in 0..n {
        let idx = (cursor_mod + i) % n;
        let account = scope[idx];
        if account.enabled {
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

    // 发送时按需读取各稿件的附件（文件名 + 内容），列表加载不带附件。
    let attachments: AttachmentMap = {
        let conn = db.lock().unwrap();
        manuscripts
            .iter()
            .map(|m| {
                let att = store::load_manuscript_attachment(&conn, m.id)
                    .unwrap_or(None)
                    .map(Arc::new);
                (m.id, att)
            })
            .collect()
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

    let send_interval_min = manuscripts
        .first()
        .map(|item| item.send_interval_min)
        .unwrap_or(3);

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
    let mut queue = build_queue(&task, &manuscripts, &attachments);
    if !is_loop {
        let full_total = queue.len() as i64;
        let own_deliveries = {
            let conn = db.lock().unwrap();
            store::task_delivery_count(&conn, task_id).unwrap_or(0)
        };
        // 同一任务清零后重发：不跳过本计划已投的。新任务 / 继续：跳过本计划已成功的收件人。
        let resend_all = task.sent == 0 && own_deliveries > 0;
        if !resend_all {
            let already = {
                let conn = db.lock().unwrap();
                let mut delivered_targets = std::collections::HashSet::new();
                for manuscript in &manuscripts {
                    for email in store::delivered_emails_for_task_manuscript(&conn, task_id, manuscript.id)
                        .unwrap_or_default()
                    {
                        delivered_targets.insert(delivery_target_key(manuscript.id, &email));
                    }
                }
                delivered_targets
            };
            if !already.is_empty() {
                queue.retain(|t| {
                    !already.contains(&delivery_target_key(t.manuscript.id, &t.recipient))
                });
            }
        }
        let skipped = full_total - queue.len() as i64;
        let initial_sent = skipped;
        {
            let conn = db.lock().unwrap();
            let _ = conn.execute(
                "UPDATE tasks SET total = ?1, sent = ?2 WHERE id = ?3",
                rusqlite::params![full_total, initial_sent, task_id],
            );
        }
        emit_task(&app, &db, task_id);
        if queue.is_empty() {
            if full_total > 0 && initial_sent > 0 {
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
    let mut had_failure = false;
    let allowed_accounts: std::collections::HashSet<i64> = task.account_ids.iter().copied().collect();

    loop {
        if !is_loop && queue.is_empty() {
            let completion_message = if had_failure { "任务投递结束，但有邮件发送失败" } else { "任务全部投递完成" };
            let log = store::insert_log(
                &db.lock().unwrap(),
                Some(task_id),
                None,
                if had_failure { "warning" } else { "success" },
                "task",
                completion_message,
            );
            if let Ok(log) = log {
                emit_log(&app, &log);
            }
            {
                let conn = db.lock().unwrap();
                let _ = store::mark_task_finished(&conn, task_id, if had_failure { "stopped" } else { "completed" });
            }
            emit_task(&app, &db, task_id);
            registry.lock().unwrap().remove(&task_id);
            return;
        }
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
            queue = build_queue(&task, &manuscripts, &attachments);
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
        }

        let target = queue.pop_front().unwrap();

        let delay = send_delay_secs(send_interval_min);
        let account = match pick_available_account(&db, &mut cursor, &allowed_accounts) {
            Some(a) => a,
            None => {
                let message = "没有可用的发件邮箱（全部被禁用），60 秒后重试";
                let log = store::insert_log(
                    &db.lock().unwrap(),
                    Some(task_id),
                    None,
                    "warning",
                    "task",
                    message,
                );
                if let Ok(log) = log {
                    emit_log(&app, &log);
                }
                queue.push_front(target);
                interruptible_sleep(60, &handle).await;
                continue;
            }
        };

        let (_editor_name, recipient_email) = smtp::parse_recipient(&target.recipient);
        let (subject, body) = smtp::resolve_outgoing_mail(
            &target.manuscript,
            &target.recipient,
            settings.anti_spam_mutation,
        );
        let outcome = send_with_retry(
            &app,
            &db,
            task_id,
            &account,
            &target,
            &subject,
            &body,
            task.retry_max,
            &mut cursor,
            &allowed_accounts,
            &handle,
        )
        .await;

        match outcome {
            SendOutcome::Success { message_id, account_id } => {
                let recorded = {
                    let mut conn = db.lock().unwrap();
                    store::record_successful_delivery(
                        &mut conn,
                        task_id,
                        account_id,
                        target.manuscript.id,
                        &recipient_email,
                        &subject,
                        &message_id,
                    )
                };
                let log = match recorded {
                    Ok(()) => store::insert_send_log(
                        &db.lock().unwrap(),
                        Some(task_id),
                        Some(account_id),
                        "success",
                        "send",
                        "投递成功",
                        &target.recipient,
                    ),
                    Err(error) => {
                        had_failure = true;
                        store::insert_send_log(
                            &db.lock().unwrap(),
                            Some(task_id),
                            Some(account_id),
                            "error",
                            "storage",
                            &format!("邮件已发出，但保存投递记录失败：{error}"),
                            &target.recipient,
                        )
                    }
                };
                if let Ok(log) = log {
                    emit_log(&app, &log);
                }
                emit_task(&app, &db, task_id);
            }
            SendOutcome::RetryLater => {
                queue.push_front(target);
                interruptible_sleep(30, &handle).await;
            }
            SendOutcome::Failed => { had_failure = true; }
        }

        if !is_loop && queue.is_empty() {
            continue;
        }

        if handle.is_stopped() {
            break;
        }

        interruptible_sleep(delay, &handle).await;
        if handle.is_stopped() {
            break;
        }
        if handle.is_paused() {
            continue;
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
    subject: &str,
    body: &str,
    retry_max: i64,
    cursor: &mut usize,
    allowed: &std::collections::HashSet<i64>,
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
        let sender_name = if target.manuscript.sender_name.trim().is_empty() {
            account.sender_name.as_str()
        } else {
            target.manuscript.sender_name.as_str()
        };
        match smtp::send_email(
            &account,
            &smtp::parse_recipient(&target.recipient).1,
            sender_name,
            subject,
            body,
            &target.manuscript.content_type,
            target.attachment.as_ref().map(|attachment| (attachment.0.as_str(), attachment.1.as_slice())),
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
                        match pick_available_account(db, cursor, allowed) {
                            Some(next) => {
                                account = next;
                                continue;
                            }
                            None => return SendOutcome::RetryLater,
                        }
                    }
                    "send" => {
                        let log = store::insert_send_log(
                            &db.lock().unwrap(),
                            Some(task_id),
                            Some(account.id),
                            "error",
                            "send",
                            &format!("投递被永久拒绝：{message}"),
                            &target.recipient,
                        );
                        if let Ok(log) = log {
                            emit_log(app, &log);
                        }
                        return SendOutcome::Failed;
                    }
                    _ => {
                        network_attempts += 1;
                        let log = store::insert_log(
                            &db.lock().unwrap(),
                            Some(task_id),
                            Some(account.id),
                            "warning",
                            &category,
                            &format!("发送失败（发件：{}），稍后重试：{}", account.email, message),
                        );
                        if let Ok(log) = log {
                            emit_log(app, &log);
                        }
                        if network_attempts >= retry_max.max(1) {
                            let log = store::insert_send_log(
                                &db.lock().unwrap(),
                                Some(task_id),
                                Some(account.id),
                                "error",
                                &category,
                                &format!("重试次数耗尽，跳过 {}", target.recipient),
                                &target.recipient,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_handle_reservation_is_atomic() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let reservations = (0..8)
            .map(|_| {
                let registry = registry.clone();
                std::thread::spawn(move || {
                    try_reserve_task_handle(&registry, 42).unwrap().is_some()
                })
            })
            .collect::<Vec<_>>();

        let claimed = reservations
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|claimed| *claimed)
            .count();
        assert_eq!(claimed, 1);
    }

    #[test]
    fn delivered_target_keeps_manuscript_identity() {
        assert_ne!(
            delivery_target_key(1, "编辑 <Editor@Example.com>"),
            delivery_target_key(2, "editor@example.com"),
        );
        assert_eq!(
            delivery_target_key(1, "编辑 <Editor@Example.com>"),
            delivery_target_key(1, "editor@example.com"),
        );
    }
}
