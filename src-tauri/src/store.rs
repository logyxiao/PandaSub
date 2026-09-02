use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{
    Account, Delivery, Editor, EditorGroup, EditorInput, MailTemplate, Manuscript, Reply, Settings,
    Task, TaskLog,
};

const ACCOUNT_COLS: &str =
    "id, email, password, smtp_host, smtp_port, sender_name, provider, enabled,
                    last_sent_at,
                    imap_host, imap_port, check_replies, imap_uid, created_at";

fn map_account(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        email: r.get(1)?,
        password: r.get(2)?,
        smtp_host: r.get(3)?,
        smtp_port: r.get::<_, i64>(4)? as u16,
        sender_name: r.get(5)?,
        provider: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        last_sent_at: r.get(8)?,
        imap_host: r.get(9)?,
        imap_port: r.get::<_, i64>(10)? as u16,
        check_replies: r.get::<_, i64>(11)? != 0,
        imap_uid: r.get(12)?,
        created_at: r.get(13)?,
        sent_today: 0,
    })
}

fn parse_list<T: serde::de::DeserializeOwned>(raw: &str) -> Vec<T> {
    serde_json::from_str(raw).unwrap_or_default()
}

const MANUSCRIPT_COLS: &str = "id, title, body, content_type, recipients, sender_name,
    word_count, category, reader_category, reader_emotion, style, genres, subject, file_name,
    created_at, updated_at, (file_data IS NOT NULL AND length(file_data) > 0), excluded_types, account_ids,
    mail_templates, send_interval_min";

fn map_manuscript(r: &rusqlite::Row<'_>) -> rusqlite::Result<Manuscript> {
    let raw_recipients: String = r.get(4)?;
    let raw_genres: String = r.get(11)?;
    let raw_excluded: String = r.get(17)?;
    let raw_accounts: String = r.get(18)?;
    let raw_templates: String = r.get(19)?;
    Ok(Manuscript {
        id: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        content_type: r.get(3)?,
        recipients: parse_list(&raw_recipients),
        sender_name: r.get(5)?,
        word_count: r.get(6)?,
        category: r.get(7)?,
        reader_category: r.get(8)?,
        reader_emotion: r.get(9)?,
        style: r.get(10)?,
        genres: parse_list(&raw_genres),
        excluded_types: parse_list(&raw_excluded),
        account_ids: parse_list::<i64>(&raw_accounts),
        send_interval_min: r.get(20)?,
        subject: r.get(12)?,
        mail_templates: parse_list(&raw_templates),
        file_name: r.get(13)?,
        has_file: r.get::<_, i64>(16)? != 0,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

pub fn now_str(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

pub fn load_accounts(conn: &Connection) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ACCOUNT_COLS} FROM accounts ORDER BY id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_account).map_err(|e| e.to_string())?;
    let mut accounts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let counts = sent_today_by_account(conn)?;
    for account in &mut accounts {
        account.sent_today = counts.get(&account.id).copied().unwrap_or(0);
    }
    Ok(accounts)
}

fn sent_today_by_account(conn: &Connection) -> Result<std::collections::HashMap<i64, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, COUNT(*) FROM deliveries
             WHERE account_id IS NOT NULL AND date(sent_at) = date('now','localtime')
             GROUP BY account_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (id, count) = row.map_err(|e| e.to_string())?;
        map.insert(id, count);
    }
    Ok(map)
}

pub fn load_account(conn: &Connection, id: i64) -> Result<Option<Account>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?1"
        ))
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row([id], map_account)
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn load_manuscripts(conn: &Connection, ids: &[i64]) -> Result<Vec<Manuscript>, String> {
    let mut result = Vec::new();
    for id in ids {
        if let Some(m) = load_manuscript(conn, *id)? {
            result.push(m);
        }
    }
    Ok(result)
}

pub fn load_manuscript(conn: &Connection, id: i64) -> Result<Option<Manuscript>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MANUSCRIPT_COLS} FROM manuscripts WHERE id = ?1"
        ))
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row([id], map_manuscript)
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn load_all_manuscripts(conn: &Connection) -> Result<Vec<Manuscript>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MANUSCRIPT_COLS} FROM manuscripts ORDER BY id DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_manuscript)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// 加载稿件的附件（文件名 + 内容），没有附件时返回 None。列表查询不带附件，仅发送时按需读取。
pub fn load_manuscript_attachment(
    conn: &Connection,
    id: i64,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let row: Option<(String, Option<Vec<u8>>)> = conn
        .query_row(
            "SELECT file_name, file_data FROM manuscripts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some((name, Some(data))) if !data.is_empty() => Ok(Some((name, data))),
        _ => Ok(None),
    }
}

const EDITOR_COLS: &str = "id, platform, name, email, work_type, rejected_types, notes, source, created_at, updated_at, enabled, favorited";

fn map_editor(r: &rusqlite::Row<'_>) -> rusqlite::Result<Editor> {
    let raw_work_type: String = r.get(4)?;
    let raw_rejected: String = r.get(5)?;
    let source: String = r.get(7)?;
    Ok(Editor {
        id: r.get(0)?,
        platform: r.get(1)?,
        name: r.get(2)?,
        email: r.get(3)?,
        work_type: crate::models::normalize_editor_work_types(&parse_list(&raw_work_type)),
        rejected_types: crate::models::normalize_editor_work_types(&parse_list(&raw_rejected)),
        notes: r.get(6)?,
        source: crate::models::normalize_editor_source(&source),
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        enabled: r.get::<_, i64>(10)? != 0,
        favorited: r.get::<_, i64>(11)? != 0,
    })
}

pub fn upsert_editor(
    conn: &Connection,
    input: &EditorInput,
    source: &str,
) -> Result<&'static str, String> {
    let email = input.email.trim().to_lowercase();
    let source = crate::models::normalize_editor_source(source);
    let work_type =
        serde_json::json!(crate::models::normalize_editor_work_types(&input.work_type)).to_string();
    let rejected_types = serde_json::json!(crate::models::normalize_editor_work_types(
        &input.rejected_types
    ))
    .to_string();
    let platform = crate::models::canonicalize_editor_platform(&input.platform);
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM editors WHERE email = ?1", [&email], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE editors SET platform = ?1, name = ?2, email = ?3, style = '[]', work_type = ?4,
                    rejected_types = ?8, notes = ?5, source = ?6, updated_at = datetime('now','localtime')
             WHERE id = ?7",
            rusqlite::params![
                platform,
                input.name.trim(),
                email,
                work_type,
                input.notes.trim(),
                source,
                id,
                rejected_types,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok("updated")
    } else {
        conn.execute(
            "INSERT INTO editors (platform, name, email, style, work_type, rejected_types, notes, source)
             VALUES (?1, ?2, ?3, '[]', ?4, ?7, ?5, ?6)",
            rusqlite::params![
                platform,
                input.name.trim(),
                email,
                work_type,
                input.notes.trim(),
                source,
                rejected_types,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok("added")
    }
}

pub fn load_editors(conn: &Connection) -> Result<Vec<Editor>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {EDITOR_COLS} FROM editors ORDER BY favorited DESC, platform ASC, name ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_editor).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn load_editor_groups(conn: &Connection) -> Result<Vec<EditorGroup>, String> {
    let mut group_stmt = conn
        .prepare(
            "SELECT id, name, created_at, updated_at
             FROM editor_groups
             ORDER BY name COLLATE NOCASE ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = group_stmt
        .query_map([], |row| {
            Ok(EditorGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                editor_ids: Vec::new(),
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut groups = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut member_stmt = conn
        .prepare(
            "SELECT m.editor_id
             FROM editor_group_members m
             JOIN editors e ON e.id = m.editor_id
             WHERE m.group_id = ?1
             ORDER BY m.position ASC, m.editor_id ASC",
        )
        .map_err(|e| e.to_string())?;
    for group in &mut groups {
        let members = member_stmt
            .query_map([group.id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        group.editor_ids = members
            .collect::<Result<Vec<i64>, _>>()
            .map_err(|e| e.to_string())?;
    }
    Ok(groups)
}

pub fn load_task(conn: &Connection, id: i64) -> Result<Option<Task>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, manuscript_ids, account_ids, status, schedule_type, scheduled_at,
                    retry_max, sent, total,
                    created_at, started_at, finished_at
             FROM tasks WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row([id], |r| {
            let raw_ids: String = r.get(2)?;
            let raw_accounts: String = r.get(3)?;
            Ok(Task {
                id: r.get(0)?,
                name: r.get(1)?,
                manuscript_ids: parse_list::<i64>(&raw_ids),
                account_ids: parse_list::<i64>(&raw_accounts),
                status: r.get(4)?,
                schedule_type: r.get(5)?,
                scheduled_at: r.get(6)?,
                retry_max: r.get(7)?,
                sent: r.get(8)?,
                total: r.get(9)?,
                created_at: r.get(10)?,
                started_at: r.get(11)?,
                finished_at: r.get(12)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn load_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, manuscript_ids, account_ids, status, schedule_type, scheduled_at,
                    retry_max, sent, total,
                    created_at, started_at, finished_at
             FROM tasks ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let raw_ids: String = r.get(2)?;
            let raw_accounts: String = r.get(3)?;
            Ok(Task {
                id: r.get(0)?,
                name: r.get(1)?,
                manuscript_ids: parse_list::<i64>(&raw_ids),
                account_ids: parse_list::<i64>(&raw_accounts),
                status: r.get(4)?,
                schedule_type: r.get(5)?,
                scheduled_at: r.get(6)?,
                retry_max: r.get(7)?,
                sent: r.get(8)?,
                total: r.get(9)?,
                created_at: r.get(10)?,
                started_at: r.get(11)?,
                finished_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// 删掉稿件已不存在的发送任务，避免工作台还显示已删除的计划。
pub fn prune_orphan_tasks(conn: &Connection) -> Result<(), String> {
    let existing: std::collections::HashSet<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM manuscripts")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for task in load_tasks(conn)? {
        let alive: Vec<i64> = task
            .manuscript_ids
            .iter()
            .copied()
            .filter(|id| existing.contains(id))
            .collect();
        if alive.is_empty() {
            conn.execute(
                "UPDATE deliveries SET task_id = NULL WHERE task_id = ?1",
                [task.id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE replies SET task_id = NULL WHERE task_id = ?1",
                [task.id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM task_logs WHERE task_id = ?1", [task.id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tasks WHERE id = ?1", [task.id])
                .map_err(|e| e.to_string())?;
        } else if alive.len() != task.manuscript_ids.len() {
            conn.execute(
                "UPDATE tasks SET manuscript_ids = ?1 WHERE id = ?2",
                rusqlite::params![serde_json::json!(alive).to_string(), task.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn load_logs(
    conn: &Connection,
    task_id: Option<i64>,
    limit: i64,
    offset: i64,
) -> Result<Vec<TaskLog>, String> {
    let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<TaskLog> {
        Ok(TaskLog {
            id: r.get(0)?,
            task_id: r.get(1)?,
            manuscript_id: r.get(2)?,
            account_id: r.get(3)?,
            level: r.get(4)?,
            category: r.get(5)?,
            message: r.get(6)?,
            recipient: r.get(7)?,
            created_at: r.get(8)?,
        })
    };

    let result = match task_id {
        Some(tid) => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, task_id, manuscript_id, account_id, level, category, message, recipient, created_at
                     FROM task_logs WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(|e| e.to_string())?;
            let collected: Vec<TaskLog> = stmt
                .query_map(params![tid, limit, offset], map_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            collected
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, task_id, manuscript_id, account_id, level, category, message, recipient, created_at
                     FROM task_logs ORDER BY id DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| e.to_string())?;
            let collected: Vec<TaskLog> = stmt
                .query_map(params![limit, offset], map_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            collected
        }
    };
    Ok(result)
}

pub fn insert_log(
    conn: &Connection,
    task_id: Option<i64>,
    account_id: Option<i64>,
    level: &str,
    category: &str,
    message: &str,
) -> Result<TaskLog, String> {
    conn.execute(
        "INSERT INTO task_logs (task_id, account_id, level, category, message) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task_id, account_id, level, category, message],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let created_at = now_str(conn)?;
    Ok(TaskLog {
        id,
        task_id,
        manuscript_id: None,
        account_id,
        level: level.to_string(),
        category: category.to_string(),
        message: message.to_string(),
        recipient: None,
        created_at,
    })
}

/// 发送类日志：额外记录计划稿件和收件人，供记录页展示。
pub fn insert_send_log(
    conn: &Connection,
    task_id: Option<i64>,
    manuscript_id: Option<i64>,
    account_id: Option<i64>,
    level: &str,
    category: &str,
    message: &str,
    recipient: &str,
) -> Result<TaskLog, String> {
    conn.execute(
        "INSERT INTO task_logs (task_id, manuscript_id, account_id, level, category, message, recipient) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![task_id, manuscript_id, account_id, level, category, message, recipient],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let created_at = now_str(conn)?;
    Ok(TaskLog {
        id,
        task_id,
        manuscript_id,
        account_id,
        level: level.to_string(),
        category: category.to_string(),
        message: message.to_string(),
        recipient: (!recipient.trim().is_empty()).then(|| recipient.to_string()),
        created_at,
    })
}

pub fn set_task_status(conn: &Connection, id: i64, status: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET status = ?1 WHERE id = ?2",
        params![status, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_task_running(conn: &Connection, id: i64) -> Result<(), String> {
    let now = now_str(conn)?;
    conn.execute(
        "UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?1), finished_at = NULL WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_task_finished(conn: &Connection, id: i64, status: &str) -> Result<(), String> {
    let now = now_str(conn)?;
    conn.execute(
        "UPDATE tasks SET status = ?1, finished_at = ?2 WHERE id = ?3",
        params![status, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn increment_task_sent(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("UPDATE tasks SET sent = sent + 1 WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clear progress so a stopped/completed task can be run again from the start.
pub fn reset_task_progress(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET sent = 0, total = 0, started_at = NULL, finished_at = NULL WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 记录一次成功发送：仅更新「上次发送时间」，用于界面展示。
pub fn record_account_send(conn: &Connection, account_id: i64) -> Result<(), String> {
    let now = now_str(conn)?;
    conn.execute(
        "UPDATE accounts SET last_sent_at = ?1 WHERE id = ?2",
        params![now, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_account_faulty(conn: &Connection, account_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE accounts SET enabled = 0 WHERE id = ?1",
        [account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_settings(conn: &Connection) -> Result<Settings, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match raw {
        Some(v) => serde_json::from_str(&v).map_err(|e| e.to_string()),
        None => Ok(Settings::default()),
    }
}

pub fn save_settings(conn: &Connection, settings: &Settings) -> Result<(), String> {
    let raw = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('app', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [raw],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_default_mail_templates(conn: &Connection) -> Result<Vec<MailTemplate>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'default_mail_templates'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub fn save_default_mail_templates(
    conn: &Connection,
    templates: &[MailTemplate],
) -> Result<(), String> {
    let raw = serde_json::to_string(templates).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('default_mail_templates', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [raw],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn insert_delivery(
    conn: &Connection,
    task_id: Option<i64>,
    account_id: i64,
    manuscript_id: i64,
    recipient: &str,
    subject: &str,
    message_id: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO deliveries (task_id, account_id, manuscript_id, recipient, subject, message_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![task_id, account_id, manuscript_id, recipient, subject, message_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub struct SuccessfulDelivery<'a> {
    pub task_id: Option<i64>,
    pub account_id: i64,
    pub manuscript_id: i64,
    pub recipient: &'a str,
    pub subject: &'a str,
    pub message_id: &'a str,
    pub increment_task_progress: bool,
}

pub fn record_successful_delivery(
    conn: &mut Connection,
    delivery: SuccessfulDelivery<'_>,
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    if delivery.increment_task_progress {
        let task_id = delivery.task_id.ok_or("任务投递缺少任务 ID")?;
        increment_task_sent(&transaction, task_id)?;
    }
    record_account_send(&transaction, delivery.account_id)?;
    insert_delivery(
        &transaction,
        delivery.task_id,
        delivery.account_id,
        delivery.manuscript_id,
        delivery.recipient,
        delivery.subject,
        delivery.message_id,
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

pub fn delete_task_data(conn: &mut Connection, id: i64) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE deliveries SET task_id = NULL WHERE task_id = ?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute("UPDATE replies SET task_id = NULL WHERE task_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM task_logs WHERE task_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let deleted = transaction
        .execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err("任务不存在".into());
    }
    transaction.commit().map_err(|e| e.to_string())
}

pub fn delete_manuscript_data(conn: &mut Connection, id: i64) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "DELETE FROM replies WHERE delivery_id IN (
                SELECT id FROM deliveries WHERE manuscript_id = ?1
             )",
            [id],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM deliveries WHERE manuscript_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let deleted = transaction
        .execute("DELETE FROM manuscripts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err("稿件不存在".into());
    }
    prune_orphan_tasks(&transaction)?;
    transaction.commit().map_err(|e| e.to_string())
}

/// Returns recipients delivered manually or by this task for this manuscript.
/// Delivery history still associated with other tasks must not make a new task skip recipients.
pub fn delivered_emails_for_task_manuscript(
    conn: &Connection,
    task_id: i64,
    manuscript_id: i64,
) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT recipient FROM deliveries
             WHERE (task_id = ?1 OR task_id IS NULL) AND manuscript_id = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![task_id, manuscript_id], |r| {
            let raw: String = r.get(0)?;
            Ok(crate::smtp::parse_recipient(&raw).1.to_lowercase())
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Returns every recipient successfully delivered for this manuscript,
/// regardless of which task performed the delivery.
pub fn delivered_emails_for_manuscript(
    conn: &Connection,
    manuscript_id: i64,
) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT recipient FROM deliveries WHERE manuscript_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([manuscript_id], |r| {
            let raw: String = r.get(0)?;
            Ok(crate::smtp::parse_recipient(&raw).1.trim().to_lowercase())
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn task_delivery_count(conn: &Connection, task_id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM deliveries WHERE task_id = ?1",
        [task_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 按 id 读取一条投递记录，用于「重新发送」。
pub fn load_delivery(conn: &Connection, id: i64) -> Result<Option<Delivery>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, account_id, manuscript_id, recipient, subject, message_id, sent_at
             FROM deliveries WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row([id], |r| {
            Ok(Delivery {
                id: r.get(0)?,
                task_id: r.get(1)?,
                account_id: r.get(2)?,
                manuscript_id: r.get(3)?,
                recipient: r.get(4)?,
                subject: r.get(5)?,
                message_id: r.get(6)?,
                sent_at: r.get(7)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn load_recent_deliveries(conn: &Connection, days: i64) -> Result<Vec<Delivery>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, account_id, manuscript_id, recipient, subject, message_id, sent_at
             FROM deliveries
             WHERE sent_at >= datetime('now','localtime', '-' || ?1 || ' days')
             ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([days], |r| {
            Ok(Delivery {
                id: r.get(0)?,
                task_id: r.get(1)?,
                account_id: r.get(2)?,
                manuscript_id: r.get(3)?,
                recipient: r.get(4)?,
                subject: r.get(5)?,
                message_id: r.get(6)?,
                sent_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn set_account_imap_uid(conn: &Connection, account_id: i64, uid: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE accounts SET imap_uid = ?1 WHERE id = ?2",
        params![uid, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reply_exists(conn: &Connection, account_id: i64, imap_uid: i64) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM replies WHERE account_id = ?1 AND imap_uid = ?2",
            params![account_id, imap_uid],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

#[allow(clippy::too_many_arguments)]
pub fn insert_reply(
    conn: &Connection,
    delivery_id: Option<i64>,
    account_id: i64,
    task_id: Option<i64>,
    from_email: &str,
    subject: &str,
    snippet: &str,
    body: &str,
    kind: &str,
    reason: &str,
    accepted: bool,
    message_id: &str,
    in_reply_to: &str,
    imap_uid: i64,
) -> Result<Reply, String> {
    conn.execute(
        "INSERT INTO replies (delivery_id, account_id, task_id, from_email, subject, snippet, body, kind, reason, accepted, message_id, in_reply_to, imap_uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            delivery_id,
            account_id,
            task_id,
            from_email,
            subject,
            snippet,
            body,
            kind,
            reason,
            accepted,
            message_id,
            in_reply_to,
            imap_uid
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let created_at = now_str(conn)?;
    let (recipient, task_name) = if let Some(delivery_id) = delivery_id {
        conn.query_row(
            "SELECT d.recipient, COALESCE(t.name, '')
             FROM deliveries d LEFT JOIN tasks t ON t.id = d.task_id WHERE d.id = ?1",
            [delivery_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default()
    } else if let Some(task_id) = task_id {
        let name = conn
            .query_row("SELECT name FROM tasks WHERE id = ?1", [task_id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        (String::new(), name)
    } else {
        (String::new(), String::new())
    };
    Ok(Reply {
        id,
        delivery_id,
        account_id: Some(account_id),
        task_id,
        from_email: from_email.into(),
        subject: subject.into(),
        snippet: snippet.into(),
        body: body.into(),
        kind: kind.into(),
        reason: reason.into(),
        accepted,
        message_id: message_id.into(),
        in_reply_to: in_reply_to.into(),
        imap_uid,
        received_at: created_at.clone(),
        created_at,
        recipient,
        task_name,
    })
}

fn map_reply(r: &rusqlite::Row<'_>) -> rusqlite::Result<Reply> {
    Ok(Reply {
        id: r.get(0)?,
        delivery_id: r.get(1)?,
        account_id: r.get(2)?,
        task_id: r.get(3)?,
        from_email: r.get(4)?,
        subject: r.get(5)?,
        snippet: r.get(6)?,
        body: r.get(7)?,
        kind: r.get(8)?,
        reason: r.get(9)?,
        accepted: r.get::<_, i64>(10)? != 0,
        message_id: r.get(11)?,
        in_reply_to: r.get(12)?,
        imap_uid: r.get(13)?,
        received_at: r.get(14)?,
        created_at: r.get(15)?,
        recipient: r.get::<_, Option<String>>(16)?.unwrap_or_default(),
        task_name: r.get::<_, Option<String>>(17)?.unwrap_or_default(),
    })
}

pub fn load_replies(
    conn: &Connection,
    kind: Option<&str>,
    task_id: Option<i64>,
    limit: i64,
) -> Result<Vec<Reply>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.delivery_id, r.account_id, r.task_id, r.from_email, r.subject, r.snippet, r.body,
                    r.kind, r.reason, r.accepted, r.message_id, r.in_reply_to, r.imap_uid, r.received_at, r.created_at,
                    d.recipient, t.name
             FROM replies r
             LEFT JOIN deliveries d ON d.id = r.delivery_id
             LEFT JOIN tasks t ON t.id = r.task_id
             WHERE (?1 IS NULL OR (?1 = 'accepted' AND r.accepted = 1) OR (?1 <> 'accepted' AND r.kind = ?1))
               AND (?2 IS NULL OR r.task_id = ?2)
             ORDER BY r.id DESC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![kind, task_id, limit], map_reply)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn count_replies(conn: &Connection, kind: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM replies WHERE kind = ?1",
        [kind],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn count_accepted_replies(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM replies WHERE accepted = 1", [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

/// 按新分类规则更新某条回复的判定结果（kind / reason / accepted）。
pub fn update_reply_kind(
    conn: &Connection,
    id: i64,
    kind: &str,
    reason: &str,
    accepted: bool,
) -> Result<(), String> {
    conn.execute(
        "UPDATE replies SET kind = ?1, reason = ?2, accepted = ?3 WHERE id = ?4",
        params![kind, reason, accepted, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE accounts (id INTEGER PRIMARY KEY, last_sent_at TEXT);
                 CREATE TABLE manuscripts (id INTEGER PRIMARY KEY);
                 CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, manuscript_ids TEXT NOT NULL,
                    account_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'stopped',
                    schedule_type TEXT NOT NULL DEFAULT 'immediate', scheduled_at TEXT,
                    retry_max INTEGER NOT NULL DEFAULT 3, sent INTEGER NOT NULL DEFAULT 0,
                    total INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
                    started_at TEXT, finished_at TEXT
                 );
                 CREATE TABLE task_logs (
                    id INTEGER PRIMARY KEY, task_id INTEGER, manuscript_id INTEGER,
                    account_id INTEGER, level TEXT NOT NULL DEFAULT 'info',
                    category TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL DEFAULT '',
                    recipient TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
                 );
                 CREATE TABLE deliveries (
                    id INTEGER PRIMARY KEY, task_id INTEGER, account_id INTEGER,
                    manuscript_id INTEGER, recipient TEXT NOT NULL, subject TEXT NOT NULL,
                    message_id TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT ''
                 );
                 CREATE TABLE replies (
                    id INTEGER PRIMARY KEY, delivery_id INTEGER, account_id INTEGER, task_id INTEGER,
                    from_email TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
                    snippet TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL DEFAULT 'human', reason TEXT NOT NULL DEFAULT '',
                    accepted INTEGER NOT NULL DEFAULT 0, message_id TEXT NOT NULL DEFAULT '',
                    in_reply_to TEXT NOT NULL DEFAULT '', imap_uid INTEGER NOT NULL DEFAULT 0,
                    received_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT ''
                 );",
            )
            .unwrap();
        connection
    }

    #[test]
    fn replies_filter_by_plan_and_kind() {
        let connection = test_connection();
        connection
            .execute_batch(
                "INSERT INTO tasks (id, name, manuscript_ids) VALUES
                    (7, '计划甲', '[]'), (8, '计划乙', '[]');
                 INSERT INTO deliveries (id, task_id, recipient, subject, message_id) VALUES
                    (1, 7, 'a@example.com', '投稿', 'a'),
                    (2, 8, 'b@example.com', '投稿', 'b');
                 INSERT INTO replies (id, delivery_id, task_id, kind, accepted) VALUES
                    (1, 1, 7, 'human', 0),
                    (2, 2, 8, 'human', 1);",
            )
            .unwrap();

        assert_eq!(
            load_replies(&connection, None, Some(7), 300).unwrap()[0].id,
            1
        );
        assert_eq!(
            load_replies(&connection, Some("accepted"), None, 300).unwrap()[0].id,
            2
        );
        assert!(load_replies(&connection, Some("accepted"), Some(7), 300)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn manual_delivery_uses_null_task_and_atomic_bookkeeping() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO accounts (id) VALUES (1)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks (id, name, manuscript_ids) VALUES (7, '任务', '[10]')",
                [],
            )
            .unwrap();

        record_successful_delivery(
            &mut connection,
            SuccessfulDelivery {
                task_id: None,
                account_id: 1,
                manuscript_id: 10,
                recipient: "editor@example.com",
                subject: "投稿",
                message_id: "message-id",
                increment_task_progress: false,
            },
        )
        .unwrap();

        let delivery_task: Option<i64> = connection
            .query_row("SELECT task_id FROM deliveries", [], |row| row.get(0))
            .unwrap();
        let sent: i64 = connection
            .query_row("SELECT sent FROM tasks WHERE id = 7", [], |row| row.get(0))
            .unwrap();
        let account_updated: i64 = connection
            .query_row(
                "SELECT last_sent_at IS NOT NULL FROM accounts WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(delivery_task, None);
        assert_eq!(sent, 0);
        assert_eq!(account_updated, 1);
    }

    #[test]
    fn send_log_keeps_manuscript_without_task() {
        let connection = test_connection();
        let inserted = insert_send_log(
            &connection,
            None,
            Some(10),
            Some(1),
            "success",
            "send",
            "手动发送成功",
            "editor@example.com",
        )
        .unwrap();

        assert_eq!(inserted.manuscript_id, Some(10));
        assert_eq!(
            load_logs(&connection, None, 1, 0).unwrap()[0].manuscript_id,
            Some(10)
        );
    }

    #[test]
    fn task_delivery_lookup_includes_manual_but_not_other_tasks() {
        let connection = test_connection();
        connection
            .execute_batch(
                "INSERT INTO deliveries (task_id, account_id, manuscript_id, recipient, subject, message_id) VALUES
                    (7, 1, 10, 'Current <current@example.com>', '投稿', 'current'),
                    (NULL, 1, 10, 'Manual <MANUAL@example.com>', '投稿', 'manual'),
                    (8, 1, 10, 'other@example.com', '投稿', 'other');",
            )
            .unwrap();

        let delivered = delivered_emails_for_task_manuscript(&connection, 7, 10).unwrap();
        assert_eq!(
            delivered,
            ["current@example.com".into(), "manual@example.com".into()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn deleting_manuscript_removes_related_rows_in_one_operation() {
        let mut connection = test_connection();
        connection
            .execute("INSERT INTO manuscripts (id) VALUES (10)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks (id, name, manuscript_ids) VALUES (7, '任务', '[10]')",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO task_logs (id, task_id) VALUES (1, 7)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO deliveries (id, task_id, account_id, manuscript_id, recipient, subject, message_id)
                 VALUES (20, 7, 1, 10, 'editor@example.com', '投稿', 'message-id')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO replies (id, delivery_id, task_id) VALUES (30, 20, 7)",
                [],
            )
            .unwrap();

        delete_manuscript_data(&mut connection, 10).unwrap();

        for table in ["manuscripts", "deliveries", "replies", "tasks", "task_logs"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should be empty");
        }
    }

    #[test]
    fn deleting_task_detaches_preserved_history() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO tasks (id, name, manuscript_ids) VALUES (7, '任务', '[10]')",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO task_logs (id, task_id) VALUES (1, 7)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO deliveries (id, task_id, account_id, manuscript_id, recipient, subject, message_id)
                 VALUES (20, 7, 1, 10, 'editor@example.com', '投稿', 'message-id')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO replies (id, delivery_id, task_id) VALUES (30, 20, 7)",
                [],
            )
            .unwrap();

        delete_task_data(&mut connection, 7).unwrap();

        let delivery_task: Option<i64> = connection
            .query_row("SELECT task_id FROM deliveries WHERE id = 20", [], |row| {
                row.get(0)
            })
            .unwrap();
        let reply_task: Option<i64> = connection
            .query_row("SELECT task_id FROM replies WHERE id = 30", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(delivery_task, None);
        assert_eq!(reply_task, None);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM task_logs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
