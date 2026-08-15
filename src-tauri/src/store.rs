use rusqlite::{params, Connection, OptionalExtension};
use serde_json;

use crate::models::{Account, Delivery, Editor, Manuscript, Reply, Settings, Task, TaskLog};

const ACCOUNT_COLS: &str = "id, email, password, smtp_host, smtp_port, sender_name, provider, enabled,
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
    })
}

fn parse_list<T: serde::de::DeserializeOwned>(raw: &str) -> Vec<T> {
    serde_json::from_str(raw).unwrap_or_default()
}

const MANUSCRIPT_COLS: &str = "id, title, body, content_type, recipients, sender_name,
    word_count, category, reader_category, reader_emotion, style, genres, subject, file_name,
    created_at, updated_at, (file_data IS NOT NULL AND length(file_data) > 0), excluded_types";

fn map_manuscript(r: &rusqlite::Row<'_>) -> rusqlite::Result<Manuscript> {
    let raw_recipients: String = r.get(4)?;
    let raw_genres: String = r.get(11)?;
    let raw_excluded: String = r.get(17)?;
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
        subject: r.get(12)?,
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
        .prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts ORDER BY id ASC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_account)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn load_account(conn: &Connection, id: i64) -> Result<Option<Account>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?1"))
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
        .prepare(&format!("SELECT {MANUSCRIPT_COLS} FROM manuscripts WHERE id = ?1"))
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row([id], map_manuscript)
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

pub fn load_all_manuscripts(conn: &Connection) -> Result<Vec<Manuscript>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {MANUSCRIPT_COLS} FROM manuscripts ORDER BY id DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_manuscript)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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

const EDITOR_COLS: &str = "id, platform, name, email, style, work_type, created_at, updated_at, enabled";

fn map_editor(r: &rusqlite::Row<'_>) -> rusqlite::Result<Editor> {
    let raw_style: String = r.get(4)?;
    let raw_work_type: String = r.get(5)?;
    Ok(Editor {
        id: r.get(0)?,
        platform: r.get(1)?,
        name: r.get(2)?,
        email: r.get(3)?,
        style: parse_list(&raw_style),
        work_type: parse_list(&raw_work_type),
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        enabled: r.get::<_, i64>(8)? != 0,
    })
}

pub fn load_editors(conn: &Connection) -> Result<Vec<Editor>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {EDITOR_COLS} FROM editors ORDER BY platform ASC, name ASC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_editor)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
            account_id: r.get(2)?,
            level: r.get(3)?,
            category: r.get(4)?,
            message: r.get(5)?,
            recipient: r.get(6)?,
            created_at: r.get(7)?,
        })
    };

    let result = match task_id {
        Some(tid) => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, task_id, account_id, level, category, message, recipient, created_at
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
                    "SELECT id, task_id, account_id, level, category, message, recipient, created_at
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
        account_id,
        level: level.to_string(),
        category: category.to_string(),
        message: message.to_string(),
        recipient: None,
        created_at,
    })
}

/// 发送类日志：额外记录收件人（编辑）邮箱，供记录页「编辑邮箱」列展示。
pub fn insert_send_log(
    conn: &Connection,
    task_id: Option<i64>,
    account_id: Option<i64>,
    level: &str,
    category: &str,
    message: &str,
    recipient: &str,
) -> Result<TaskLog, String> {
    conn.execute(
        "INSERT INTO task_logs (task_id, account_id, level, category, message, recipient) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![task_id, account_id, level, category, message, recipient],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let created_at = now_str(conn)?;
    Ok(TaskLog {
        id,
        task_id,
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
    conn.execute("UPDATE accounts SET enabled = 0 WHERE id = ?1", [account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_settings(conn: &Connection) -> Result<Settings, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0))
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

pub fn insert_delivery(
    conn: &Connection,
    task_id: i64,
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

/// 本次运行开始后已投递成功的收件人邮箱集合（统一小写），用于停止后「继续发送」时跳过已投的收件人。
pub fn delivered_emails_since(
    conn: &Connection,
    task_id: i64,
    started_at: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT recipient FROM deliveries WHERE task_id = ?1 AND sent_at >= ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![task_id, started_at], |r| {
            let raw: String = r.get(0)?;
            Ok(raw.to_lowercase())
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
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
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
        recipient: String::new(),
        task_name: String::new(),
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

pub fn load_replies(conn: &Connection, kind: Option<&str>, limit: i64) -> Result<Vec<Reply>, String> {
    let sql = "SELECT r.id, r.delivery_id, r.account_id, r.task_id, r.from_email, r.subject, r.snippet, r.body,
                      r.kind, r.reason, r.accepted, r.message_id, r.in_reply_to, r.imap_uid, r.received_at, r.created_at,
                      d.recipient, t.name
               FROM replies r
               LEFT JOIN deliveries d ON d.id = r.delivery_id
               LEFT JOIN tasks t ON t.id = r.task_id";
    if let Some(k) = kind {
        let mut stmt = conn
            .prepare(&format!("{sql} WHERE r.kind = ?1 ORDER BY r.id DESC LIMIT ?2"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![k, limit], map_reply)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    } else {
        let mut stmt = conn
            .prepare(&format!("{sql} ORDER BY r.id DESC LIMIT ?1"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], map_reply)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }
}

pub fn count_replies(conn: &Connection, kind: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM replies WHERE kind = ?1",
        [kind],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 按新分类规则更新某条回复的判定结果（kind / reason / accepted）。
pub fn update_reply_kind(conn: &Connection, id: i64, kind: &str, reason: &str, accepted: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE replies SET kind = ?1, reason = ?2, accepted = ?3 WHERE id = ?4",
        params![kind, reason, accepted, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
