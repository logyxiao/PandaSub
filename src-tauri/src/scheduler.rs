use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::Rng;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::models::{Account, Manuscript, Settings, Task, TaskLog};
use crate::smtp::{self, classify_error};
use crate::state::{
    ensure_no_manual_sends, ensure_no_manual_task, ManualSendMap, ManualSends, TaskHandle,
};
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
    NeedsReview(String),
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
    let mut seen = std::collections::HashSet::new();
    for manuscript in manuscripts {
        let shared_manuscript = Arc::new(manuscript.clone());
        let attachment = attachments.get(&manuscript.id).cloned().flatten();
        for recipient in &manuscript.recipients {
            let key = delivery_target_key(manuscript.id, recipient);
            if key.1.is_empty() || !seen.insert(key) {
                continue;
            }
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

/// Caller holds the registry for the entire claim, so two different task IDs
/// cannot acquire the same manuscript. Paused workers retain their claim.
pub fn claim_manuscripts(
    registry: &HashMap<i64, Arc<TaskHandle>>,
    task_id: i64,
    ids: &[i64],
) -> Result<(), String> {
    for (other_id, handle) in registry {
        if *other_id != task_id
            && handle
                .manuscript_ids
                .lock()
                .map_err(|e| e.to_string())?
                .iter()
                .any(|id| ids.contains(id))
        {
            return Err("该稿件已被其他自动任务占用，请等待该任务结束".into());
        }
    }
    let handle = registry.get(&task_id).ok_or("任务启动预约已失效")?;
    *handle.manuscript_ids.lock().map_err(|e| e.to_string())? = ids.to_vec();
    Ok(())
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
    manual_sends: ManualSends,
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
                    let tasks = registry.lock().unwrap();
                    let pending = manual_sends.lock().unwrap();
                    let conn = db.lock().unwrap();
                    let result = (|| -> Result<bool, String> {
                        let task = store::load_task(&conn, id)?.ok_or("任务不存在")?;
                        store::ensure_task_resolved(&conn, id)?;
                        claim_manuscripts(&tasks, id, &task.manuscript_ids)?;
                        claim_scheduled_task(&conn, &pending, id)
                    })();
                    result.unwrap_or(false)
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

fn claim_scheduled_task(
    conn: &Connection,
    pending: &ManualSendMap,
    id: i64,
) -> Result<bool, String> {
    let Some(task) = store::load_task(conn, id)? else {
        return Ok(false);
    };
    if ensure_no_manual_task(pending, id).is_err()
        || ensure_no_manual_sends(pending, &task.manuscript_ids).is_err()
    {
        return Ok(false);
    }
    conn.execute(
        "UPDATE tasks SET status = 'running' WHERE id = ?1 AND status = 'scheduled'",
        [id],
    )
    .map(|n| n == 1)
    .map_err(|e| e.to_string())
}

async fn interruptible_sleep(secs: u64, handle: &TaskHandle) {
    let mut remaining = Duration::from_secs(secs);
    while !remaining.is_zero() {
        if handle.is_stopped() {
            return;
        }
        if handle.is_paused() {
            wait_until_resumed(handle).await;
            continue;
        }
        let started = tokio::time::Instant::now();
        tokio::select! {
            _ = tokio::time::sleep(remaining) => return,
            _ = handle.changed() => {
                remaining = remaining.saturating_sub(started.elapsed());
            }
        }
    }
}

async fn wait_until_resumed(handle: &TaskHandle) {
    while handle.is_paused() && !handle.is_stopped() {
        handle.changed().await;
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

/// 在计划配置的闭区间内均匀随机选择下一封邮件的等待秒数。
fn send_delay_secs(from_sec: i64, to_sec: i64) -> u64 {
    let (from, to) = crate::models::normalize_send_interval_secs(from_sec, to_sec);
    let mut rng = rand::rng();
    rng.random_range(from..=to) as u64
}

fn pick_available_account(
    db: &Arc<Mutex<Connection>>,
    cursor: &mut usize,
    allowed: &std::collections::HashSet<i64>,
) -> Option<Account> {
    let conn = db.lock().unwrap();
    let accounts = store::load_enabled_account_configs(&conn).ok()?;
    if accounts.is_empty() {
        return None;
    }
    let scope: Vec<&Account> = if allowed.is_empty() {
        accounts.iter().collect()
    } else {
        accounts
            .iter()
            .filter(|a| allowed.contains(&a.id))
            .collect()
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

fn refresh_retry_account(
    db: &Arc<Mutex<Connection>>,
    preferred_id: i64,
    cursor: &mut usize,
    allowed: &std::collections::HashSet<i64>,
) -> Option<Account> {
    let current = {
        let conn = db.lock().ok()?;
        store::load_account(&conn, preferred_id).ok()?
    };
    if let Some(account) =
        current.filter(|a| a.enabled && (allowed.is_empty() || allowed.contains(&a.id)))
    {
        return Some(account);
    }
    pick_available_account(db, cursor, allowed)
}

struct PreparedTask {
    task: Task,
    settings: Settings,
    manuscripts: Vec<Manuscript>,
    attachments: AttachmentMap,
    queue: VecDeque<SendTarget>,
}

/// No network operation is allowed before every required read succeeds. In
/// particular an unreadable history is not equivalent to an empty history.
fn prepare_task(conn: &Connection, task_id: i64) -> Result<PreparedTask, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let task = store::load_task(&tx, task_id)?.ok_or("任务不存在")?;
    store::ensure_task_resolved(&tx, task_id)?;
    let settings = store::load_settings(&tx)?;
    let mut seen = std::collections::HashSet::new();
    let mut manuscripts = Vec::new();
    let mut attachments = AttachmentMap::new();
    for id in &task.manuscript_ids {
        if !seen.insert(*id) {
            continue;
        }
        let manuscript = store::load_manuscript(&tx, *id)?
            .ok_or_else(|| format!("稿件 #{id} 不存在，请检查计划"))?;
        let attachment = store::load_manuscript_attachment(&tx, *id)
            .map_err(|e| format!("稿件《{}》附件读取失败：{e}", manuscript.title))?
            .map(Arc::new);
        attachments.insert(*id, attachment);
        manuscripts.push(manuscript);
    }
    if manuscripts.is_empty() {
        return Err("任务未关联任何稿件".into());
    }
    let mut queue = build_queue(&task, &manuscripts, &attachments);
    let total = queue.len() as i64;
    if total == 0 {
        return Err("所选稿件均未设置有效收件人".into());
    }
    {
        let mut already = std::collections::HashSet::new();
        for manuscript in &manuscripts {
            for email in store::delivered_emails_for_task_manuscript(&tx, task_id, manuscript.id)
                .map_err(|e| format!("读取投递历史失败：{e}"))?
            {
                already.insert(delivery_target_key(manuscript.id, &email));
            }
        }
        queue.retain(|t| !already.contains(&delivery_target_key(t.manuscript.id, &t.recipient)));
        if task.schedule_type != "loop" {
            tx.execute(
                "UPDATE tasks SET total = ?1, sent = ?2 WHERE id = ?3",
                rusqlite::params![total, total - queue.len() as i64, task_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(PreparedTask {
        task,
        settings,
        manuscripts,
        attachments,
        queue,
    })
}

fn stop_for_data_error(app: &AppHandle, db: &Arc<Mutex<Connection>>, task_id: i64, error: &str) {
    log::error!("任务 {task_id} 已停止：{error}");
    let log = {
        let conn = db.lock().unwrap();
        let _ = store::mark_task_finished(&conn, task_id, "stopped");
        store::insert_log(
            &conn,
            Some(task_id),
            None,
            "error",
            "storage",
            &format!("任务已停止：{error}"),
        )
    };
    if let Ok(log) = log {
        emit_log(app, &log);
    }
    emit_task(app, db, task_id);
}

async fn run_task_worker(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    registry: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    task_id: i64,
    handle: Arc<TaskHandle>,
) {
    let prepared = {
        let conn = db.lock().unwrap();
        prepare_task(&conn, task_id).and_then(|prepared| {
            if !handle.is_paused() && !handle.is_stopped() {
                store::mark_task_running(&conn, task_id)?;
            }
            Ok(prepared)
        })
    };
    let PreparedTask {
        task,
        settings,
        manuscripts,
        attachments,
        mut queue,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            stop_for_data_error(&app, &db, task_id, &error);
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

    let (send_interval_from_sec, send_interval_to_sec) = manuscripts
        .first()
        .map(|item| (item.send_interval_from_sec, item.send_interval_to_sec))
        .unwrap_or((
            crate::models::DEFAULT_SEND_INTERVAL_FROM_SEC,
            crate::models::DEFAULT_SEND_INTERVAL_TO_SEC,
        ));

    let is_loop = task.schedule_type == "loop";

    let mut cursor: usize = 0;
    let mut had_failure = false;
    let allowed_accounts: std::collections::HashSet<i64> =
        task.account_ids.iter().copied().collect();

    loop {
        if !is_loop && queue.is_empty() {
            let completion_message = if had_failure {
                "任务投递结束，但有邮件发送失败"
            } else {
                "任务全部投递完成"
            };
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
                let _ = store::mark_task_finished(
                    &conn,
                    task_id,
                    if had_failure { "stopped" } else { "completed" },
                );
            }
            emit_task(&app, &db, task_id);
            registry.lock().unwrap().remove(&task_id);
            return;
        }
        if handle.is_stopped() {
            break;
        }
        if handle.is_paused() {
            wait_until_resumed(&handle).await;
            if handle.is_stopped() {
                break;
            }
        }

        if queue.is_empty() {
            let advanced = store::advance_loop_cycle(&db.lock().unwrap(), task_id);
            if let Err(error) = advanced {
                stop_for_data_error(&app, &db, task_id, &error);
                registry.lock().unwrap().remove(&task_id);
                return;
            }
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

        let delay = send_delay_secs(send_interval_from_sec, send_interval_to_sec);
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
            SendOutcome::Success {
                message_id,
                account_id,
            } => {
                let recorded = {
                    let mut conn = db.lock().unwrap();
                    store::record_successful_delivery(
                        &mut conn,
                        store::SuccessfulDelivery {
                            task_id: Some(task_id),
                            account_id,
                            manuscript_id: target.manuscript.id,
                            recipient: &recipient_email,
                            subject: &subject,
                            message_id: &message_id,
                            increment_task_progress: true,
                        },
                    )
                };
                let storage_error = recorded.as_ref().err().cloned();
                let log = match recorded {
                    Ok(()) => store::insert_send_log(
                        &db.lock().unwrap(),
                        Some(task_id),
                        Some(target.manuscript.id),
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
                            Some(target.manuscript.id),
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
                if let Some(error) = storage_error {
                    stop_for_data_error(
                        &app,
                        &db,
                        task_id,
                        &format!("邮件已发出但记账失败，请先核对发件记录再继续：{error}"),
                    );
                    registry.lock().unwrap().remove(&task_id);
                    return;
                }
            }
            SendOutcome::NeedsReview(error) => {
                stop_for_data_error(&app, &db, task_id, &error);
                registry.lock().unwrap().remove(&task_id);
                return;
            }
            SendOutcome::RetryLater => {
                queue.push_front(target);
                interruptible_sleep(30, &handle).await;
            }
            SendOutcome::Failed => {
                had_failure = true;
            }
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
        // Pause/retry can outlive a UI toggle. Re-read before every new SMTP attempt.
        account = match refresh_retry_account(db, account.id, cursor, allowed) {
            Some(current) => current,
            None => return SendOutcome::RetryLater,
        };
        let sender_name = if target.manuscript.sender_name.trim().is_empty() {
            account.sender_name.as_str()
        } else {
            target.manuscript.sender_name.as_str()
        };
        let message_id = smtp::make_message_id();
        let recipient = smtp::parse_recipient(&target.recipient).1;
        let prepared = store::begin_send_attempt(
            &db.lock().unwrap(),
            &store::SuccessfulDelivery {
                task_id: Some(task_id),
                account_id: account.id,
                manuscript_id: target.manuscript.id,
                recipient: &recipient,
                subject,
                message_id: &message_id,
                increment_task_progress: true,
            },
        );
        if let Err(error) = prepared {
            return SendOutcome::NeedsReview(error);
        }
        match smtp::send_email_with_id(
            &account,
            &smtp::parse_recipient(&target.recipient).1,
            sender_name,
            subject,
            body,
            &target.manuscript.content_type,
            target
                .attachment
                .as_ref()
                .map(|attachment| (attachment.0.as_str(), attachment.1.as_slice())),
            &message_id,
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
                if !smtp::definitely_not_sent(&err) {
                    return SendOutcome::NeedsReview(format!(
                        "发送结果待确认：{message}。请在计划记录中核对，自动重试已暂停"
                    ));
                }
                if let Err(error) = store::mark_attempt_not_sent(&db.lock().unwrap(), &message_id) {
                    return SendOutcome::NeedsReview(error);
                }
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
                            Some(target.manuscript.id),
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
                                Some(target.manuscript.id),
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

    fn prepared_fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute_batch(
            r#"INSERT INTO manuscripts(id,title,body,recipients) VALUES
            (1,'fixture','body','["one@example.com","two@example.com"]');
            INSERT INTO tasks(id,name,manuscript_ids,sent,total) VALUES(1,'fixture','[1]',7,9);"#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn preparation_stops_on_missing_or_unreadable_required_data() {
        for mutation in [
            "INSERT INTO settings(key,value) VALUES('app','bad json')",
            "UPDATE tasks SET manuscript_ids='[1,99]'",
            "UPDATE tasks SET account_ids='bad json'",
            "UPDATE tasks SET manuscript_ids='[\"wrong type\"]'",
            "UPDATE manuscripts SET recipients='bad json'",
            "UPDATE manuscripts SET account_ids='[\"wrong type\"]'",
            "UPDATE manuscripts SET mail_templates='{}'",
            "UPDATE manuscripts SET file_name='missing.docx'",
            "UPDATE manuscripts SET file_name='wrong.docx',file_data='not a blob'",
            "DROP TABLE deliveries",
            "CREATE TRIGGER deny_progress BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
        ] {
            let conn = prepared_fixture();
            conn.execute_batch(mutation).unwrap();
            assert!(prepare_task(&conn, 1).is_err(), "mutation should prevent a send: {mutation}");
            let progress: (i64,i64) = conn.query_row("SELECT sent,total FROM tasks WHERE id=1", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(progress, (7,9), "failed preparation must not rewrite progress: {mutation}");
        }
    }

    #[test]
    fn preparation_preserves_attachments_and_only_queues_current_round_remainder() {
        let conn = prepared_fixture();
        conn.execute_batch("UPDATE manuscripts SET file_name='fixture.txt',file_data=X'616263';
            INSERT INTO deliveries(task_id,manuscript_id,recipient,message_id) VALUES(1,1,'one@example.com','delivered');").unwrap();
        let prepared = prepare_task(&conn, 1).unwrap();
        assert_eq!(prepared.queue.len(), 1);
        assert_eq!(prepared.queue[0].recipient, "two@example.com");
        assert_eq!(prepared.queue[0].attachment.as_ref().unwrap().1, b"abc");
        let task = store::load_task(&conn, 1).unwrap().unwrap();
        assert_eq!((task.sent, task.total), (1, 2));
        conn.execute("INSERT INTO deliveries(task_id,manuscript_id,recipient,message_id) VALUES(1,1,'two@example.com','delivered2')", []).unwrap();
        assert!(prepare_task(&conn, 1).unwrap().queue.is_empty());
        conn.execute("UPDATE tasks SET schedule_type='loop'", [])
            .unwrap();
        assert!(prepare_task(&conn, 1).unwrap().queue.is_empty());
        let sent = store::load_task(&conn, 1).unwrap().unwrap().sent;
        store::advance_loop_cycle(&conn, 1).unwrap();
        assert_eq!(prepare_task(&conn, 1).unwrap().queue.len(), 2);
        assert_eq!(store::load_task(&conn, 1).unwrap().unwrap().sent, sent);
    }

    #[test]
    fn scheduled_task_waits_for_manual_submission_without_losing_schedule() {
        let conn = prepared_fixture();
        conn.execute(
            "UPDATE tasks SET schedule_type='scheduled',status='scheduled'",
            [],
        )
        .unwrap();
        assert!(!claim_scheduled_task(
            &conn,
            &HashMap::from([(
                1,
                crate::state::ManualSendScope {
                    account_id: 20,
                    task_id: Some(1)
                }
            )]),
            1
        )
        .unwrap());
        assert_eq!(
            store::load_task(&conn, 1).unwrap().unwrap().status,
            "scheduled"
        );
        // A historical delivery may refer to the task's previous manuscript.
        assert!(!claim_scheduled_task(
            &conn,
            &HashMap::from([(
                99,
                crate::state::ManualSendScope {
                    account_id: 20,
                    task_id: Some(1)
                }
            )]),
            1
        )
        .unwrap());
        assert!(claim_scheduled_task(&conn, &HashMap::new(), 1).unwrap());
        assert!(!claim_scheduled_task(&conn, &HashMap::new(), 1).unwrap());
    }

    #[test]
    fn attachment_reader_distinguishes_no_attachment_from_broken_attachment() {
        let conn = prepared_fixture();
        assert!(store::load_manuscript_attachment(&conn, 1)
            .unwrap()
            .is_none());
        assert!(store::load_manuscript_attachment(&conn, 99).is_err());
        conn.execute(
            "UPDATE manuscripts SET file_name='empty.docx',file_data=X''",
            [],
        )
        .unwrap();
        assert!(store::load_manuscript_attachment(&conn, 1).is_err());
        conn.execute("UPDATE manuscripts SET file_name='',file_data=X'01'", [])
            .unwrap();
        assert!(store::load_manuscript_attachment(&conn, 1).is_err());
    }

    #[test]
    fn each_queue_round_deduplicates_mailboxes_but_preserves_manuscript_identity() {
        let conn = crate::db::test_database();
        conn.execute_batch(r#"INSERT INTO manuscripts(id,title,body,recipients) VALUES
            (1,'first','body','["编辑甲 <Editor@Example.com>", "editor@example.com", "  ", "别名 <EDITOR@example.com>", "next@example.com"]'),
            (2,'second','body','["editor@example.com"]');
            INSERT INTO tasks(id,name,manuscript_ids) VALUES(1,'fixture','[1,1,2]');"#).unwrap();
        let task = store::load_task(&conn, 1).unwrap().unwrap();
        let manuscripts = store::load_manuscripts(&conn, &task.manuscript_ids).unwrap();
        for _ in 0..2 {
            // loop mode starts another independent round
            let queue = build_queue(&task, &manuscripts, &HashMap::new());
            assert_eq!(queue.len(), 3);
            let keys: std::collections::HashSet<_> = queue
                .iter()
                .map(|t| delivery_target_key(t.manuscript.id, &t.recipient))
                .collect();
            assert_eq!(keys.len(), 3);
            assert!(keys.contains(&(1, "editor@example.com".into())));
            assert!(keys.contains(&(2, "editor@example.com".into())));
            assert!(queue
                .iter()
                .any(|t| t.recipient == "编辑甲 <Editor@Example.com>"));
        }
    }

    #[test]
    fn picking_an_account_does_not_read_delivery_history() {
        let conn = crate::db::test_database();
        conn.execute_batch("INSERT INTO accounts(id,email,password,smtp_host,enabled) VALUES
            (1,'one@example.com','fixture','localhost',1), (2,'off@example.com','fixture','localhost',0),
            (3,'three@example.com','fixture','localhost',1); DROP TABLE deliveries;").unwrap();
        let db = Arc::new(Mutex::new(conn));
        let mut cursor = 0;
        let allowed = std::collections::HashSet::new();
        assert_eq!(
            pick_available_account(&db, &mut cursor, &allowed)
                .unwrap()
                .id,
            1
        );
        assert_eq!(
            pick_available_account(&db, &mut cursor, &allowed)
                .unwrap()
                .id,
            3
        );
        assert_eq!(
            pick_available_account(&db, &mut cursor, &allowed)
                .unwrap()
                .id,
            1
        );
        assert!(pick_available_account(&db, &mut cursor, &[2].into_iter().collect()).is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn pause_freezes_remaining_send_or_retry_delay() {
        let handle = Arc::new(TaskHandle::new());
        let worker_handle = handle.clone();
        let worker = tokio::spawn(async move { interruptible_sleep(10, &worker_handle).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(3)).await;
        tokio::task::yield_now().await;
        handle.pause();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(100)).await;
        assert!(!worker.is_finished());
        handle.resume();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert!(!worker.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(worker.is_finished());
        worker.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn stop_wakes_long_delay_and_paused_worker_without_polling() {
        for paused in [false, true] {
            let handle = Arc::new(TaskHandle::new());
            if paused {
                handle.pause();
            }
            let worker_handle = handle.clone();
            let worker =
                tokio::spawn(async move { interruptible_sleep(3600, &worker_handle).await });
            tokio::task::yield_now().await;
            handle.stop();
            // No timer advance: notification wakes immediately.
            tokio::task::yield_now().await;
            assert!(worker.is_finished());
            worker.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn control_changes_before_wait_are_not_lost() {
        let handle = TaskHandle::new();
        handle.pause();
        handle.resume();
        wait_until_resumed(&handle).await;
        handle.stop();
        interruptible_sleep(3600, &handle).await;
        assert!(handle.is_stopped());
    }

    #[test]
    fn retry_rechecks_account_toggle_and_keeps_selected_scope() {
        let conn = crate::db::test_database();
        conn.execute_batch(
            "INSERT INTO accounts(id,email,password,smtp_host) VALUES
            (1,'one@example.com','old','localhost'), (2,'two@example.com','fixture','localhost'),
            (3,'outside@example.com','fixture','localhost');",
        )
        .unwrap();
        let db = Arc::new(Mutex::new(conn));
        let allowed = [1, 2].into_iter().collect();
        let mut cursor = 0;
        assert_eq!(
            refresh_retry_account(&db, 1, &mut cursor, &allowed)
                .unwrap()
                .id,
            1
        );
        db.lock()
            .unwrap()
            .execute("UPDATE accounts SET enabled=0 WHERE id=1", [])
            .unwrap();
        assert_eq!(
            refresh_retry_account(&db, 1, &mut cursor, &allowed)
                .unwrap()
                .id,
            2
        );
        db.lock()
            .unwrap()
            .execute("UPDATE accounts SET enabled=0 WHERE id=2", [])
            .unwrap();
        assert!(refresh_retry_account(&db, 1, &mut cursor, &allowed).is_none());
        db.lock()
            .unwrap()
            .execute(
                "UPDATE accounts SET enabled=1,password='new' WHERE id=1",
                [],
            )
            .unwrap();
        assert_eq!(
            refresh_retry_account(&db, 1, &mut cursor, &allowed)
                .unwrap()
                .password,
            "new"
        );
        assert_eq!(
            refresh_retry_account(&db, 3, &mut cursor, &allowed)
                .unwrap()
                .id,
            1
        );
        db.lock()
            .unwrap()
            .execute("DELETE FROM accounts WHERE id=1", [])
            .unwrap();
        assert!(refresh_retry_account(&db, 1, &mut cursor, &allowed).is_none());
    }

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

    #[test]
    fn send_delay_uses_configured_second_range() {
        assert_eq!(send_delay_secs(17, 17), 17);
        for _ in 0..100 {
            let delay = send_delay_secs(12, 24);
            assert!((12..=24).contains(&delay));
        }
    }

    #[test]
    fn send_delay_normalizes_reversed_and_invalid_bounds() {
        for _ in 0..20 {
            assert!((10..=20).contains(&send_delay_secs(20, 10)));
            assert!((100..=240).contains(&send_delay_secs(0, 0)));
        }
    }
}

#[cfg(test)]
mod manuscript_claim_tests {
    use super::*;
    #[test]
    fn concurrent_different_tasks_have_one_winner_for_shared_manuscript() {
        for _ in 0..30 {
            let registry = Arc::new(Mutex::new(HashMap::new()));
            for id in [1, 2] {
                try_reserve_task_handle(&registry, id).unwrap().unwrap();
            }
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let threads: Vec<_> = [1, 2]
                .into_iter()
                .map(|id| {
                    let registry = registry.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        claim_manuscripts(&registry.lock().unwrap(), id, &[10]).is_ok()
                    })
                })
                .collect();
            assert_eq!(
                threads
                    .into_iter()
                    .filter_map(|t| t.join().ok())
                    .filter(|ok| *ok)
                    .count(),
                1
            );
        }
    }
    #[test]
    fn pause_retains_claim_and_release_allows_other_task_without_partial_claims() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let first = try_reserve_task_handle(&registry, 1).unwrap().unwrap();
        try_reserve_task_handle(&registry, 2).unwrap().unwrap();
        try_reserve_task_handle(&registry, 3).unwrap().unwrap();
        let mut tasks = registry.lock().unwrap();
        claim_manuscripts(&tasks, 1, &[10, 11]).unwrap();
        first.pause();
        assert!(claim_manuscripts(&tasks, 2, &[12, 11]).is_err());
        claim_manuscripts(&tasks, 3, &[12]).unwrap(); // failed claim did not reserve 12
        tasks.remove(&1);
        claim_manuscripts(&tasks, 2, &[10, 11]).unwrap();
    }
}
