use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{
    Account, Delivery, Editor, EditorGroup, EditorInput, MailTemplate, Manuscript, Reply, Settings,
    Task, TaskLog,
};

const ACCOUNT_COLS: &str =
    "id, email, password, smtp_host, smtp_port, sender_name, provider, enabled,
                    last_sent_at,
                    imap_host, imap_port, check_replies, imap_uid, created_at, imap_uid_validity, imap_generation";

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
        imap_uid_validity: r.get(14)?,
        imap_generation: r.get(15)?,
        created_at: r.get(13)?,
        sent_today: 0,
    })
}

fn parse_list<T: serde::de::DeserializeOwned>(raw: &str) -> Vec<T> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_required_list<T: serde::de::DeserializeOwned>(
    raw: &str,
    column: usize,
) -> rusqlite::Result<Vec<T>> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

const MANUSCRIPT_COLS: &str = "id, title, body, content_type, recipients, sender_name,
    word_count, category, reader_category, reader_emotion, style, genres, subject, file_name,
    created_at, updated_at, (file_data IS NOT NULL AND length(file_data) > 0), excluded_types, account_ids,
    mail_templates, send_interval_min, fixed_mail_template_id,
    send_interval_from_sec, send_interval_to_sec";

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
        recipients: parse_required_list(&raw_recipients, 4)?,
        sender_name: r.get(5)?,
        word_count: r.get(6)?,
        category: r.get(7)?,
        reader_category: r.get(8)?,
        reader_emotion: r.get(9)?,
        style: r.get(10)?,
        genres: parse_list(&raw_genres),
        excluded_types: parse_list(&raw_excluded),
        account_ids: parse_required_list::<i64>(&raw_accounts, 18)?,
        send_interval_min: r.get(20)?,
        send_interval_from_sec: r.get(22)?,
        send_interval_to_sec: r.get(23)?,
        subject: r.get(12)?,
        mail_templates: parse_required_list(&raw_templates, 19)?,
        fixed_mail_template_id: r.get(21)?,
        file_name: r.get(13)?,
        has_file: r.get::<_, i64>(16)? != 0,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

/// Call inside the transaction that inserts the account. Rows are never deleted.
pub fn reserve_account_id(conn: &Connection) -> Result<i64, String> {
    conn.execute("INSERT INTO account_ids DEFAULT VALUES", [])
        .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn ensure_manuscript_idle(
    conn: &Connection,
    registry: &std::collections::HashMap<i64, std::sync::Arc<crate::state::TaskHandle>>,
    id: i64,
) -> Result<(), String> {
    ensure_manuscript_resolved(conn, id)?;
    if load_tasks(conn)?
        .iter()
        .any(|t| t.manuscript_ids.contains(&id) && registry.contains_key(&t.id))
    {
        return Err("计划正在执行或暂停，请停止后再修改配置".into());
    }
    Ok(())
}

pub fn ensure_account_idle(
    conn: &Connection,
    registry: &std::collections::HashMap<i64, std::sync::Arc<crate::state::TaskHandle>>,
    id: i64,
) -> Result<(), String> {
    let pending: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM outgoing_attempts WHERE account_id=?1 AND status='pending')", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if pending {
        return Err("该邮箱存在发送结果待确认的邮件，请先核对计划记录".into());
    }
    if load_tasks(conn)?.iter().any(|t| {
        registry.contains_key(&t.id) && (t.account_ids.is_empty() || t.account_ids.contains(&id))
    }) {
        return Err("邮箱正在参与任务，请停止相关任务后再修改或删除".into());
    }
    Ok(())
}

pub fn now_str(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT datetime('now','localtime')", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Scheduler needs configuration, not per-day delivery aggregates.
pub fn load_enabled_account_configs(conn: &Connection) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ACCOUNT_COLS} FROM accounts WHERE enabled = 1 ORDER BY id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map([], map_account)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
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
             WHERE account_id IS NOT NULL AND sent_at >= date('now','localtime')
               AND sent_at < date('now','localtime', '+1 day')
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
        Some((name, Some(data))) if !name.trim().is_empty() && !data.is_empty() => {
            Ok(Some((name, data)))
        }
        Some((name, data))
            if name.trim().is_empty() && data.as_ref().map_or(true, Vec::is_empty) =>
        {
            Ok(None)
        }
        Some(_) => Err("附件名称或内容缺失，请重新选择附件后再发送".into()),
        None => Err("稿件不存在，请刷新后重试".into()),
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
                manuscript_ids: parse_required_list::<i64>(&raw_ids, 2)?,
                account_ids: parse_required_list::<i64>(&raw_accounts, 3)?,
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
                manuscript_ids: parse_required_list::<i64>(&raw_ids, 2)?,
                account_ids: parse_required_list::<i64>(&raw_accounts, 3)?,
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

fn map_log(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLog> {
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
}

// Page, count and export share the exact same predicates. INSTR treats %, _ literally.
pub fn query_logs(
    conn: &Connection,
    task_id: Option<i64>,
    level: Option<&str>,
    query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<crate::models::LogPage, String> {
    let mut clauses = vec!["1 = 1"];
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(id) = task_id {
        clauses.push("l.task_id = ?");
        values.push(id.into());
    }
    if let Some(level) = level.filter(|v| !v.is_empty()) {
        clauses.push("l.level = ?");
        values.push(level.to_owned().into());
    }
    if let Some(query) = query.map(str::trim).filter(|v| !v.is_empty()) {
        clauses.push(
            "(instr(lower(COALESCE(l.recipient, '')), ?) > 0 OR EXISTS
            (SELECT 1 FROM accounts a WHERE a.id = l.account_id AND instr(lower(a.email), ?) > 0))",
        );
        values.push(query.to_lowercase().into());
        values.push(query.to_lowercase().into());
    }
    let predicate = clauses.join(" AND ");
    let total = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM task_logs l WHERE {predicate}"),
            rusqlite::params_from_iter(&values),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    values.push(limit.into());
    values.push(offset.max(0).into());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT l.id, l.task_id, l.manuscript_id, l.account_id,
        l.level, l.category, l.message, l.recipient, l.created_at FROM task_logs l
        WHERE {predicate} ORDER BY l.id DESC LIMIT ? OFFSET ?"
        ))
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(&values), map_log)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(crate::models::LogPage { items, total })
}

pub fn load_logs(
    conn: &Connection,
    task_id: Option<i64>,
    limit: i64,
    offset: i64,
) -> Result<Vec<TaskLog>, String> {
    Ok(query_logs(conn, task_id, None, None, limit, offset)?.items)
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
#[allow(clippy::too_many_arguments)]
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
    ensure_task_resolved(conn, id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO task_runs DEFAULT VALUES", [])
        .map_err(|e| e.to_string())?;
    let run_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE tasks SET sent = 0, total = 0, run_id = ?2, started_at = NULL, finished_at = NULL WHERE id = ?1",
        params![id, run_id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
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

pub fn setting_exists(conn: &Connection, key: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

pub fn mark_setting(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key],
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
        "INSERT INTO deliveries (task_id, account_id, manuscript_id, recipient, subject, message_id, run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(
             (SELECT run_id FROM tasks WHERE id = ?1),
             (SELECT run_id FROM tasks WHERE ?1 IS NULL AND EXISTS
                 (SELECT 1 FROM json_each(tasks.manuscript_ids) WHERE value = ?3)
              ORDER BY id DESC LIMIT 1), 0))",
        params![task_id, account_id, manuscript_id, recipient, subject, message_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Persisted before any network work. A pending attempt always requires
/// explicit reconciliation; restarting/resetting tasks never clears it.
pub fn ensure_manuscript_resolved(conn: &Connection, id: i64) -> Result<(), String> {
    let pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM outgoing_attempts WHERE manuscript_id=?1 AND status='pending')",
        [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if pending {
        return Err("存在发送结果待确认的邮件，请在计划记录中核对后处理".into());
    }
    Ok(())
}

pub fn ensure_task_resolved(conn: &Connection, id: i64) -> Result<(), String> {
    let pending: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outgoing_attempts WHERE task_id=?1 AND status='pending')",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if pending {
        return Err("任务存在发送结果待确认的邮件，请先核对计划记录".into());
    }
    if let Some(task) = load_task(conn, id)? {
        for mid in task.manuscript_ids {
            ensure_manuscript_resolved(conn, mid)?;
        }
    }
    Ok(())
}

pub fn begin_send_attempt(
    conn: &Connection,
    delivery: &SuccessfulDelivery<'_>,
) -> Result<(), String> {
    ensure_manuscript_resolved(conn, delivery.manuscript_id)?;
    conn.execute("INSERT INTO outgoing_attempts(task_id,run_id,account_id,manuscript_id,recipient,subject,message_id,increment_task_progress)
        VALUES(?1, COALESCE((SELECT run_id FROM tasks WHERE id=?1),
        (SELECT run_id FROM tasks WHERE ?1 IS NULL AND EXISTS
        (SELECT 1 FROM json_each(tasks.manuscript_ids) WHERE value=?3) ORDER BY id DESC LIMIT 1),0), ?2,?3,?4,?5,?6,?7)",
        params![delivery.task_id, delivery.account_id, delivery.manuscript_id,
            delivery.recipient.trim().to_lowercase(), delivery.subject, delivery.message_id, delivery.increment_task_progress])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_attempt_not_sent(conn: &Connection, message_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE outgoing_attempts SET status='not_sent' WHERE message_id=?1 AND status='pending'",
        [message_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct PendingSend {
    pub id: i64,
    pub task_id: Option<i64>,
    pub account_id: i64,
    pub manuscript_id: i64,
    pub recipient: String,
    pub subject: String,
    pub message_id: String,
    pub created_at: String,
    pub increment_task_progress: bool,
    pub account_email: String,
}

pub fn pending_sends(conn: &Connection, manuscript_id: i64) -> Result<Vec<PendingSend>, String> {
    let mut stmt = conn.prepare("SELECT id,task_id,account_id,manuscript_id,recipient,subject,message_id,created_at,increment_task_progress,
        COALESCE((SELECT email FROM accounts WHERE accounts.id=outgoing_attempts.account_id),'')
        FROM outgoing_attempts WHERE manuscript_id=?1 AND status='pending' ORDER BY id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([manuscript_id], |r| {
            Ok(PendingSend {
                id: r.get(0)?,
                task_id: r.get(1)?,
                account_id: r.get(2)?,
                manuscript_id: r.get(3)?,
                recipient: r.get(4)?,
                subject: r.get(5)?,
                message_id: r.get(6)?,
                created_at: r.get(7)?,
                increment_task_progress: r.get(8)?,
                account_email: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

/// User has checked the server/recipient. This operation itself sends no mail.
pub fn resolve_send_attempt(conn: &mut Connection, id: i64, sent: bool) -> Result<(), String> {
    let mid: i64 = conn
        .query_row(
            "SELECT manuscript_id FROM outgoing_attempts WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let pending = pending_sends(conn, mid)?.into_iter().find(|p| p.id == id);
    let Some(pending) = pending else {
        return Ok(());
    }; // idempotent double click
    if !sent {
        return mark_attempt_not_sent(conn, &pending.message_id);
    }
    record_delivery_at(
        conn,
        SuccessfulDelivery {
            task_id: pending.task_id,
            account_id: pending.account_id,
            manuscript_id: mid,
            recipient: &pending.recipient,
            subject: &pending.subject,
            message_id: &pending.message_id,
            increment_task_progress: pending.increment_task_progress,
        },
        Some(&pending.created_at),
    )
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
    record_delivery_at(conn, delivery, None)
}

fn record_delivery_at(
    conn: &mut Connection,
    delivery: SuccessfulDelivery<'_>,
    original_attempt_at: Option<&str>,
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let already_recorded: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deliveries WHERE message_id=?1)",
            [delivery.message_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if already_recorded {
        return Ok(());
    }
    transaction
        .execute(
            "UPDATE outgoing_attempts SET status='sent' WHERE message_id=?1 AND status='pending'",
            [delivery.message_id],
        )
        .map_err(|e| e.to_string())?;
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
    transaction
        .execute(
            "UPDATE deliveries SET
        run_id = (SELECT run_id FROM outgoing_attempts WHERE message_id=?1)
        WHERE message_id=?1 AND EXISTS(SELECT 1 FROM outgoing_attempts WHERE message_id=?1)",
            [delivery.message_id],
        )
        .map_err(|e| e.to_string())?;
    if let Some(at) = original_attempt_at {
        transaction
            .execute(
                "UPDATE deliveries SET sent_at=?2 WHERE message_id=?1",
                params![delivery.message_id, at],
            )
            .map_err(|e| e.to_string())?;
        transaction.execute("UPDATE accounts SET last_sent_at=(SELECT MAX(sent_at) FROM deliveries WHERE account_id=?1) WHERE id=?1", [delivery.account_id]).map_err(|e| e.to_string())?;
    }
    if !delivery.increment_task_progress {
        let task_id = match delivery.task_id {
            Some(id) => Some(id),
            None => transaction.query_row("SELECT id FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.manuscript_ids) WHERE value = ?1) ORDER BY id DESC LIMIT 1",
                [delivery.manuscript_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?,
        };
        if let Some(id) = task_id {
            refresh_idle_task_progress(&transaction, id)?;
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

fn refresh_idle_task_progress(conn: &Connection, task_id: i64) -> Result<(), String> {
    let Some(task) = load_task(conn, task_id)? else {
        return Ok(());
    };
    if task.schedule_type == "loop" || matches!(task.status.as_str(), "running" | "paused") {
        return Ok(());
    }
    let mut sent = 0usize;
    let mut total = 0usize;
    for id in task
        .manuscript_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>()
    {
        let raw: Option<String> = conn
            .query_row(
                "SELECT recipients FROM manuscripts WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let targets = parse_list::<String>(raw.as_deref().unwrap_or("[]"))
            .iter()
            .map(|r| crate::smtp::parse_recipient(r).1.trim().to_lowercase())
            .filter(|email| !email.is_empty())
            .collect::<std::collections::HashSet<_>>();
        let delivered = delivered_emails_for_task_manuscript(conn, task_id, id)?;
        sent += targets.intersection(&delivered).count();
        total += targets.len();
    }
    conn.execute(
        "UPDATE tasks SET sent = ?1, total = ?2 WHERE id = ?3",
        params![sent as i64, total as i64, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_task_data(conn: &mut Connection, id: i64) -> Result<(), String> {
    ensure_task_resolved(conn, id)?;
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
    ensure_manuscript_resolved(conn, id)?;
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
             WHERE (task_id = ?1 OR task_id IS NULL) AND manuscript_id = ?2
               AND run_id = COALESCE((SELECT run_id FROM tasks WHERE id = ?1), 0)",
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
    load_deliveries_where(
        conn,
        "sent_at >= datetime('now','localtime', '-' || ?1 || ' days')",
        days,
    )
}

pub fn load_account_deliveries(
    conn: &Connection,
    account_id: i64,
) -> Result<Vec<Delivery>, String> {
    load_deliveries_where(conn, "account_id = ?1", account_id)
}

pub fn load_manuscript_deliveries(
    conn: &Connection,
    manuscript_id: i64,
) -> Result<Vec<Delivery>, String> {
    load_deliveries_where(conn, "manuscript_id = ?1", manuscript_id)
}

// Predicates are internal constants; user-supplied values stay bound parameters.
fn load_deliveries_where(
    conn: &Connection,
    predicate: &str,
    value: i64,
) -> Result<Vec<Delivery>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, task_id, account_id, manuscript_id, recipient, subject, message_id, sent_at
         FROM deliveries WHERE {predicate} ORDER BY id DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([value], |r| {
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

pub fn reset_account_mailbox(conn: &Connection, account_id: i64) -> Result<(), String> {
    conn.execute("UPDATE accounts SET imap_uid = 0, imap_uid_validity = 0, imap_generation = imap_generation + 1 WHERE id = ?1", [account_id]).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM settings WHERE key LIKE ?1",
        [format!("replies.autoreply_match_backfill.%.{account_id}")],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_account_imap_cursor(
    conn: &Connection,
    account_id: i64,
    uid: i64,
    validity: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE accounts SET imap_uid = ?1, imap_uid_validity = ?3 WHERE id = ?2",
        params![uid, account_id, validity],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reply_exists(
    conn: &Connection,
    account: &Account,
    imap_uid: i64,
    validity: i64,
    message_id: &str,
) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM replies WHERE account_id = ?1 AND imap_generation = ?2
         AND ((imap_uid_validity = ?3 AND imap_uid = ?4) OR (?5 <> '' AND message_id = ?5))",
            params![
                account.id,
                account.imap_generation,
                validity,
                imap_uid,
                message_id
            ],
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
    imap_uid_validity: i64,
    imap_generation: i64,
    received_at: &str,
) -> Result<Reply, String> {
    conn.execute(
        "INSERT INTO replies (delivery_id, account_id, task_id, from_email, subject, snippet, body, kind, reason, accepted, message_id, in_reply_to, imap_uid, imap_uid_validity, imap_generation, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, COALESCE(NULLIF(?16, ''), datetime('now','localtime')))",
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
            imap_uid,
            imap_uid_validity,
            imap_generation,
            received_at
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
        imap_uid_validity,
        imap_generation,
        received_at: if received_at.is_empty() {
            created_at.clone()
        } else {
            received_at.into()
        },
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
        imap_uid_validity: r.get(18)?,
        imap_generation: r.get(19)?,
        received_at: r.get(14)?,
        created_at: r.get(15)?,
        recipient: r.get::<_, Option<String>>(16)?.unwrap_or_default(),
        task_name: r.get::<_, Option<String>>(17)?.unwrap_or_default(),
    })
}

const REPLY_FROM: &str = "FROM replies r
    LEFT JOIN deliveries d ON d.id = r.delivery_id
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN manuscripts m ON m.id = d.manuscript_id";
const REPLY_FILTER: &str = "WHERE
    (?1 IS NULL OR (?1 = 'accepted' AND r.accepted = 1) OR (?1 <> 'accepted' AND r.kind = ?1))
    AND (?2 IS NULL OR r.task_id = ?2)
    AND (?3 = '' OR instr(lower(r.body || ' ' || r.snippet || ' ' || r.subject || ' ' || r.from_email
        || ' ' || COALESCE(d.recipient, '') || ' ' || COALESCE(t.name, m.title, '')), ?3) > 0
        OR EXISTS (SELECT 1 FROM editors e
            WHERE (lower(e.email) = lower(d.recipient) OR lower(e.email) = lower(r.from_email))
            AND instr(lower(e.name || ' ' || e.platform || ' ' || e.email), ?3) > 0))";

pub fn query_replies(
    conn: &Connection,
    kind: Option<&str>,
    task_id: Option<i64>,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<crate::models::ReplyPage, String> {
    let query = query.trim().to_lowercase();
    let total = conn
        .query_row(
            &format!("SELECT COUNT(*) {REPLY_FROM} {REPLY_FILTER}"),
            params![kind, task_id, query],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let sql = format!("SELECT r.id, r.delivery_id, r.account_id, r.task_id, r.from_email, r.subject,
        r.snippet, r.body, r.kind, r.reason, r.accepted, r.message_id, r.in_reply_to, r.imap_uid,
        r.received_at, r.created_at, d.recipient, COALESCE(t.name, m.title, ''), r.imap_uid_validity, r.imap_generation
        {REPLY_FROM} {REPLY_FILTER} ORDER BY r.id DESC LIMIT ?4 OFFSET ?5");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(
            params![kind, task_id, query, limit.max(1), offset.max(0)],
            map_reply,
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(crate::models::ReplyPage { items, total })
}

pub fn load_replies(
    conn: &Connection,
    kind: Option<&str>,
    task_id: Option<i64>,
    limit: i64,
) -> Result<Vec<Reply>, String> {
    Ok(query_replies(conn, kind, task_id, "", limit, 0)?.items)
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
                 CREATE TABLE manuscripts (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', recipients TEXT NOT NULL DEFAULT '[]');
                 CREATE TABLE editors (id INTEGER PRIMARY KEY, email TEXT, name TEXT, platform TEXT);
                 CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, manuscript_ids TEXT NOT NULL,
                    account_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'stopped',
                    schedule_type TEXT NOT NULL DEFAULT 'immediate', scheduled_at TEXT,
                    retry_max INTEGER NOT NULL DEFAULT 3, sent INTEGER NOT NULL DEFAULT 0,
                    total INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
                    started_at TEXT, finished_at TEXT, run_id INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT);
                 CREATE TABLE outgoing_attempts (
                    id INTEGER PRIMARY KEY, task_id INTEGER, account_id INTEGER, manuscript_id INTEGER,
                    recipient TEXT, subject TEXT, message_id TEXT, status TEXT, run_id INTEGER, created_at TEXT
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
                    message_id TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT '', run_id INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE replies (
                    id INTEGER PRIMARY KEY, delivery_id INTEGER, account_id INTEGER, task_id INTEGER,
                    from_email TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
                    snippet TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL DEFAULT 'human', reason TEXT NOT NULL DEFAULT '',
                    accepted INTEGER NOT NULL DEFAULT 0, message_id TEXT NOT NULL DEFAULT '',
                    in_reply_to TEXT NOT NULL DEFAULT '', imap_uid INTEGER NOT NULL DEFAULT 0,
                    received_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', imap_uid_validity INTEGER NOT NULL DEFAULT 0, imap_generation INTEGER NOT NULL DEFAULT 0
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

#[derive(serde::Serialize)]
pub struct DeliverySummary {
    pub row_index: usize,
    pub sent_count: i64,
    pub latest_id: Option<i64>,
    pub last_sent_at: Option<String>,
}
#[derive(serde::Serialize)]
pub struct DeliverySummaryPage {
    pub items: Vec<DeliverySummary>,
    pub total: i64,
    pub sent_total: i64,
}

// Only internal column identifiers are passed here, never user input.
pub(crate) fn delivery_recipient_sql(column: &str) -> String {
    format!("lower(trim(CASE WHEN instr({column},'<')>0 AND instr(substr({column},instr({column},'<')+1),'>')>0
        THEN substr({column},instr({column},'<')+1,instr(substr({column},instr({column},'<')+1),'>')-1)
        ELSE {column} END))")
}

/// One row per requested recipient, never one row per historical delivery.
/// Recipient ordering/search is supplied by the editor-enriched UI; status
/// filtering, aggregation, totals and pagination are performed in SQLite.
#[allow(clippy::too_many_arguments)]
pub fn delivery_summary_page(
    conn: &Connection,
    manuscript_id: i64,
    emails: &[String],
    matching: &[usize],
    filter: &str,
    limit: i64,
    offset: i64,
) -> Result<DeliverySummaryPage, String> {
    if !matches!(filter, "all" | "sent" | "unsent") {
        return Err("未知发送状态筛选".into());
    }
    let emails = serde_json::to_string(
        &emails
            .iter()
            .map(|e| crate::smtp::parse_recipient(e).1.trim().to_lowercase())
            .collect::<Vec<_>>(),
    )
    .map_err(|e| e.to_string())?;
    let matching = serde_json::to_string(matching).map_err(|e| e.to_string())?;
    let recipient_key = delivery_recipient_sql("d.recipient");
    let cte = format!(
        "WITH summary AS (
        SELECT CAST(r.key AS INTEGER) row_index, COUNT(d.id) sent_count, MAX(d.id) latest_id
        FROM json_each(?2) r LEFT JOIN deliveries d
          ON d.manuscript_id=?1 AND {recipient_key}=r.value
        GROUP BY r.key), filtered AS (
        SELECT * FROM summary WHERE row_index IN (SELECT value FROM json_each(?3))
        AND (?4='all' OR (?4='sent' AND sent_count>0) OR (?4='unsent' AND sent_count=0)))"
    );
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (total, sent_total) = tx
        .query_row(
            &format!(
                "{cte} SELECT (SELECT COUNT(*) FROM filtered),
        (SELECT COUNT(*) FROM summary WHERE sent_count>0)"
            ),
            params![manuscript_id, emails, matching, filter],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let items = {
        let mut stmt = tx
            .prepare(&format!(
                "{cte} SELECT row_index,sent_count,latest_id,
            (SELECT sent_at FROM deliveries WHERE id=latest_id) FROM filtered
            ORDER BY row_index LIMIT ?5 OFFSET ?6"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    manuscript_id,
                    emails,
                    matching,
                    filter,
                    limit.clamp(1, 100),
                    offset.max(0)
                ],
                |r| {
                    Ok(DeliverySummary {
                        row_index: r.get::<_, u32>(0)? as usize,
                        sent_count: r.get(1)?,
                        latest_id: r.get(2)?,
                        last_sent_at: r.get(3)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(DeliverySummaryPage {
        items,
        total,
        sent_total,
    })
}

#[cfg(test)]
mod outbox_tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute_batch("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'fixture@example.com','','localhost');
            INSERT INTO manuscripts(id,title,body,recipients) VALUES(10,'稿件','正文','[\"a@example.com\",\"b@example.com\"]');
            INSERT INTO tasks(id,name,manuscript_ids) VALUES(1,'任务','[10]');").unwrap();
        conn
    }
    fn attempt(message_id: &str) -> SuccessfulDelivery<'_> {
        SuccessfulDelivery {
            task_id: Some(1),
            account_id: 1,
            manuscript_id: 10,
            recipient: "a@example.com",
            subject: "投稿",
            message_id,
            increment_task_progress: true,
        }
    }
    #[test]
    fn pending_blocks_restarts_resets_deletion_and_new_attempts() {
        let mut conn = fixture();
        begin_send_attempt(&conn, &attempt("m1")).unwrap();
        assert!(ensure_task_resolved(&conn, 1).is_err());
        assert!(reset_task_progress(&conn, 1).is_err());
        assert!(delete_task_data(&mut conn, 1).is_err());
        assert!(delete_manuscript_data(&mut conn, 10).is_err());
        assert!(begin_send_attempt(&conn, &attempt("m2")).is_err());
        assert!(ensure_account_idle(&conn, &std::collections::HashMap::new(), 1).is_err());
        let id = pending_sends(&conn, 10).unwrap()[0].id;
        resolve_send_attempt(&mut conn, id, false).unwrap();
        assert!(pending_sends(&conn, 10).unwrap().is_empty());
        assert_eq!(load_manuscript_deliveries(&conn, 10).unwrap().len(), 0);
        begin_send_attempt(&conn, &attempt("m2")).unwrap();
    }
    #[test]
    fn successful_bookkeeping_and_outbox_settlement_are_atomic_and_idempotent() {
        let mut conn = fixture();
        begin_send_attempt(&conn, &attempt("m1")).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(FAIL,'disk fault fixture'); END;").unwrap();
        assert!(record_successful_delivery(&mut conn, attempt("m1")).is_err());
        assert_eq!(pending_sends(&conn, 10).unwrap().len(), 1);
        assert_eq!(load_task(&conn, 1).unwrap().unwrap().sent, 0);
        assert_eq!(load_account(&conn, 1).unwrap().unwrap().last_sent_at, None);
        conn.execute_batch("DROP TRIGGER fail_delivery").unwrap();
        record_successful_delivery(&mut conn, attempt("m1")).unwrap();
        record_successful_delivery(&mut conn, attempt("m1")).unwrap();
        assert!(pending_sends(&conn, 10).unwrap().is_empty());
        assert_eq!(load_manuscript_deliveries(&conn, 10).unwrap().len(), 1);
        assert_eq!(load_task(&conn, 1).unwrap().unwrap().sent, 1);
    }
    #[test]
    fn confirmed_sent_restores_progress_without_resending_or_changing_original_time() {
        let mut conn = fixture();
        begin_send_attempt(&conn, &attempt("m1")).unwrap();
        conn.execute(
            "UPDATE outgoing_attempts SET created_at='2025-01-02 03:04:05'",
            [],
        )
        .unwrap();
        let id = pending_sends(&conn, 10).unwrap()[0].id;
        resolve_send_attempt(&mut conn, id, true).unwrap();
        resolve_send_attempt(&mut conn, id, true).unwrap();
        let deliveries = load_manuscript_deliveries(&conn, 10).unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].sent_at, "2025-01-02 03:04:05");
        assert_eq!(load_task(&conn, 1).unwrap().unwrap().sent, 1);
        assert!(delivered_emails_for_task_manuscript(&conn, 1, 10)
            .unwrap()
            .contains("a@example.com"));
    }
    #[test]
    fn crash_writer_fixture() {
        let Ok(path) = std::env::var("NOVELSUB_CRASH_FIXTURE") else {
            return;
        };
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .unwrap();
        begin_send_attempt(&conn, &attempt("crash-message")).unwrap();
        // No SMTP involved. Exit without dropping Connection, exactly in the
        // journal-committed / delivery-not-committed crash window.
        std::process::exit(0);
    }
    #[test]
    fn pending_survives_process_exit_before_delivery_commit() {
        let path = std::env::temp_dir().join(format!(
            "novelsub-outbox-{}-{}.sqlite",
            std::process::id(),
            rand::random::<u64>()
        ));
        let conn = fixture();
        conn.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::outbox_tests::crash_writer_fixture",
                "--nocapture",
            ])
            .env("NOVELSUB_CRASH_FIXTURE", &path)
            .status()
            .unwrap();
        assert!(status.success());
        let mut reopened = Connection::open(&path).unwrap();
        assert_eq!(pending_sends(&reopened, 10).unwrap().len(), 1);
        assert!(ensure_task_resolved(&reopened, 1).is_err());
        let id = pending_sends(&reopened, 10).unwrap()[0].id;
        resolve_send_attempt(&mut reopened, id, true).unwrap();
        assert_eq!(load_manuscript_deliveries(&reopened, 10).unwrap().len(), 1);
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
    #[test]
    fn summary_paginates_recipients_over_complete_history_and_filters_before_paging() {
        let conn = fixture();
        conn.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
            INSERT INTO deliveries(manuscript_id,recipient,message_id,sent_at)
            SELECT 10,'编辑 <A@EXAMPLE.COM>',CAST(x AS TEXT),'2026-01-01 00:00:00' FROM n;
            INSERT INTO deliveries(manuscript_id,recipient,message_id,sent_at) VALUES(10,'a@example.com','new','2026-02-01 00:00:00'),(99,'b@example.com','other','2026-02-01 00:00:00');").unwrap();
        let emails = vec![
            "a@example.com".into(),
            "b@example.com".into(),
            "a@example.com".into(),
        ];
        let page = delivery_summary_page(&conn, 10, &emails, &[0, 1, 2], "all", 1, 0).unwrap();
        assert_eq!((page.total, page.sent_total, page.items.len()), (3, 2, 1));
        assert_eq!(page.items[0].sent_count, 1001);
        assert_eq!(
            page.items[0].last_sent_at.as_deref(),
            Some("2026-02-01 00:00:00")
        );
        assert_eq!(page.items[0].latest_id, Some(1001));
        let page = delivery_summary_page(&conn, 10, &emails, &[0, 1, 2], "unsent", 10, 0).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].row_index, 1);
        let page = delivery_summary_page(&conn, 10, &emails, &[2], "sent", 10, 0).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].row_index, 2);
        assert!(
            delivery_summary_page(&conn, 10, &emails, &[0, 1, 2], "all", 10, 999)
                .unwrap()
                .items
                .is_empty()
        );
        assert!(delivery_summary_page(&conn, 10, &emails, &[], "all", 10, 0)
            .unwrap()
            .items
            .is_empty());
    }
}

/// Begin an intentional loop cycle without erasing cumulative progress.
pub fn advance_loop_cycle(conn: &Connection, task_id: i64) -> Result<(), String> {
    ensure_task_resolved(conn, task_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO task_runs DEFAULT VALUES", [])
        .map_err(|e| e.to_string())?;
    let run_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE tasks SET run_id=?2 WHERE id=?1",
        params![task_id, run_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
