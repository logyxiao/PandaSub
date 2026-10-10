use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{
    Account, Delivery, Editor, EditorGroup, EditorInput, MailTemplate, Manuscript, Reply, Settings,
    Task, TaskLog,
};

const ACCOUNT_COLS: &str =
    "id, email, password, smtp_host, smtp_port, sender_name, provider, enabled,
                    last_sent_at,
                    imap_host, imap_port, check_replies, imap_uid, created_at, imap_uid_validity, imap_generation, notes";

pub const ACCEPTANCE_FILTER_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS acceptance_filters (
    body_key TEXT PRIMARY KEY, sample_body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);";

pub fn acceptance_is_filtered(conn: &Connection, body: &str) -> Result<bool, String> {
    let key = crate::classify::acceptance_template_key(body);
    if key.is_empty() { return Ok(false); }
    conn.query_row("SELECT EXISTS(SELECT 1 FROM acceptance_filters WHERE body_key=?1)", [key], |row| row.get(0))
        .map_err(|e| e.to_string())
}

pub fn clear_filtered_acceptance(conn: &Connection) -> Result<usize, String> {
    let mut stmt = conn.prepare("SELECT body_key FROM acceptance_filters").map_err(|e| e.to_string())?;
    let keys = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
        .collect::<Result<std::collections::HashSet<_>, _>>().map_err(|e| e.to_string())?;
    if keys.is_empty() { return Ok(0); }
    let mut stmt = conn.prepare("SELECT id,body FROM replies WHERE accepted=1").map_err(|e| e.to_string())?;
    let replies = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let mut changed = 0;
    for (id, body) in replies {
        if keys.contains(&crate::classify::acceptance_template_key(&body)) {
            changed += conn.execute("UPDATE replies SET accepted=0 WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        }
    }
    Ok(changed)
}

pub fn learn_acceptance_filter(conn: &Connection, body: &str) -> Result<(), String> {
    let key = crate::classify::acceptance_template_key(body);
    if key.is_empty() { return Ok(()); }
    conn.execute("INSERT OR IGNORE INTO acceptance_filters(body_key,sample_body) VALUES(?1,?2)",
        params![key, crate::classify::unique_body(body)]).map_err(|e| e.to_string())?;
    clear_filtered_acceptance(conn)?;
    Ok(())
}

#[cfg(test)]
mod acceptance_filter_tests {
    use super::*;

    #[test]
    fn learned_template_filters_other_accounts_history_and_future_mail_without_touching_body() {
        let conn = crate::db::test_database();
        let body = "感谢来稿，录用结果另行通知。\n祝宝子早日过稿！";
        let quoted = format!("{body}\n---原始邮件---\n作品甲，字数一万");
        let other = "感谢来稿，录用结果另行通知。 祝宝子早日过稿！\nOn Tuesday wrote:\n作品乙";
        conn.execute("INSERT INTO replies(id,account_id,imap_uid,body,kind,accepted) VALUES(1,1,1,?1,'human',1),(2,2,2,?2,'human',1),(3,2,3,'恭喜过稿，终审通过','human',1)", params![quoted, other]).unwrap();
        learn_acceptance_filter(&conn, &quoted).unwrap();
        learn_acceptance_filter(&conn, other).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM acceptance_filters", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(!load_reply(&conn, 1).unwrap().unwrap().accepted);
        assert!(!load_reply(&conn, 2).unwrap().unwrap().accepted);
        assert_eq!(load_reply(&conn, 1).unwrap().unwrap().body, quoted);
        assert!(load_reply(&conn, 3).unwrap().unwrap().accepted);
        let incoming = insert_reply(&conn,None,7,None,"editor@example.com","新书","",other,"human","",true,"future","",1,10,0,"",false).unwrap();
        assert!(!incoming.accepted);
        update_reply_kind(&conn, incoming.id, "human", "重判", true).unwrap();
        assert!(!load_reply(&conn, incoming.id).unwrap().unwrap().accepted);
        assert!(!acceptance_is_filtered(&conn, "恭喜过稿，终审通过").unwrap());
        // Empty/quoted-only replies must never become a match-all rule.
        learn_acceptance_filter(&conn, " \n> quoted text").unwrap();
        assert!(!acceptance_is_filtered(&conn, "").unwrap());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM acceptance_filters", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
}

fn map_account(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        email: r.get(1)?,
        password: r.get(2)?,
        smtp_host: r.get(3)?,
        smtp_port: r.get::<_, i64>(4)? as u16,
        sender_name: r.get(5)?,
        notes: r.get(16)?,
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
    send_interval_from_sec, send_interval_to_sec, lock_recipients";

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
        lock_recipients: r.get::<_, i64>(24)? != 0,
        sender_name: r.get(5)?,
        word_count: r.get(6)?,
        category: r.get(7)?,
        reader_category: r.get(8)?,
        reader_emotion: r.get(9)?,
        style: r.get(10)?,
        genres: parse_list(&raw_genres),
        excluded_types: parse_list(&raw_excluded),
        account_ids: parse_required_list::<i64>(&raw_accounts, 18)?,
        sent_account_ids: Vec::new(),
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

#[cfg(test)]
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

pub fn load_manuscript_list(conn: &Connection, summary: bool) -> Result<Vec<Manuscript>, String> {
    // Keep the metadata/attachment flag while avoiding large bodies and templates on list pages.
    let columns = if summary {
        MANUSCRIPT_COLS.replace("title, body,", "title, '' AS body,")
            .replace("mail_templates,", "'[]' AS mail_templates,")
    } else { MANUSCRIPT_COLS.to_string() };
    let mut stmt = conn.prepare(&format!("SELECT {columns} FROM manuscripts ORDER BY id DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_manuscript).map_err(|e| e.to_string())?;
    let mut manuscripts = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if summary && !manuscripts.is_empty() {
        // One compact aggregate for the list; never load message bodies or full delivery history.
        let mut senders = std::collections::HashMap::<i64, Vec<Option<i64>>>::new();
        let mut stmt = conn.prepare("SELECT manuscript_id, account_id FROM deliveries WHERE manuscript_id IS NOT NULL GROUP BY manuscript_id, account_id ORDER BY manuscript_id, account_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, account_id) = row.map_err(|e| e.to_string())?;
            senders.entry(id).or_default().push(account_id);
        }
        for manuscript in &mut manuscripts {
            manuscript.sent_account_ids = senders.remove(&manuscript.id).unwrap_or_default();
        }
    }
    Ok(manuscripts)
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
        average_reply_seconds: None,
        reply_sample_count: 0,
        blocked_senders: Vec::new(),
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
    let existing: Option<i64> = conn.prepare_cached("SELECT id FROM editors WHERE email = ?1").map_err(|e|e.to_string())?
        .query_row([&email], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        conn.prepare_cached(
            "UPDATE editors SET platform = ?1, name = ?2, email = ?3, style = '[]', work_type = ?4,
                    rejected_types = ?8, notes = ?5, source = ?6, updated_at = datetime('now','localtime')
             WHERE id = ?7").map_err(|e|e.to_string())?.execute(
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
        conn.prepare_cached(
            "INSERT INTO editors (platform, name, email, style, work_type, rejected_types, notes, source)
             VALUES (?1, ?2, ?3, '[]', ?4, ?7, ?5, ?6)").map_err(|e|e.to_string())?.execute(
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

pub fn set_editor_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<(), String> {
    let changed = conn.execute(
        "UPDATE editors SET enabled=?2, updated_at=datetime('now','localtime') WHERE id=?1",
        params![id, enabled],
    ).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("没有找到这位编辑".into()); }
    Ok(())
}

/// Apply explicit editor ids atomically. A stale selection fails without partial writes.
pub fn batch_editors(conn: &mut Connection, ids: &[i64], enabled: Option<bool>) -> Result<usize, String> {
    let ids: std::collections::BTreeSet<_> = ids.iter().copied().collect();
    if ids.is_empty() { return Err("请先选择编辑".into()); }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in &ids {
        if let Some(enabled) = enabled {
            set_editor_enabled(&tx, *id, enabled)?;
        } else {
            tx.execute("DELETE FROM editor_group_members WHERE editor_id=?1", [id]).map_err(|e| e.to_string())?;
            let changed = tx.execute("DELETE FROM editors WHERE id=?1", [id]).map_err(|e| e.to_string())?;
            if changed == 0 { return Err("部分编辑已不存在，请刷新后重新选择；本次未删除任何编辑".into()); }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids.len())
}

/// Saved plan recipients may outlive library selections. Check at send time too.
/// Explicit recipients outside the library keep their existing behavior.
pub fn ensure_editor_enabled(conn: &Connection, recipient: &str) -> Result<(), String> {
    let email = crate::editor_blocks::mailbox(recipient);
    let disabled: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM editors WHERE lower(trim(email))=?1 AND enabled=0)",
        [&email], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if disabled { return Err(format!("编辑 {email} 已停用，本次未发送。请确认恢复收稿后在收件箱中启用该编辑，再重新发送。")); }
    Ok(())
}

pub fn load_editors(conn: &Connection) -> Result<Vec<Editor>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {EDITOR_COLS} FROM editors ORDER BY favorited DESC, platform ASC, name ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_editor).map_err(|e| e.to_string())?;
    let mut editors = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let mut blocked = std::collections::HashMap::<String, Vec<String>>::new();
    for block in crate::editor_blocks::list(conn)? {
        blocked.entry(block.recipient_email).or_default().push(block.sender_email);
    }
    for editor in &mut editors {
        editor.blocked_senders = blocked.remove(&editor.email.trim().to_lowercase()).unwrap_or_default();
    }
    Ok(editors)
}

/// Derived from successful deliveries, one sample per delivery's first valid human reply.
/// Keep this out of load_editors: the scheduler uses that lightweight path before each send.
pub fn load_editors_with_reply_stats(conn: &Connection) -> Result<Vec<Editor>, String> {
    let mut editors = load_editors(conn)?;
    let mut stmt = conn.prepare(
        "SELECT d.recipient, MIN(CAST(strftime('%s', r.received_at) AS INTEGER) - CAST(strftime('%s', d.sent_at) AS INTEGER))
         FROM replies r JOIN deliveries d ON d.id=r.delivery_id
         WHERE r.kind='human' AND r.account_id IS d.account_id
           AND strftime('%s', d.sent_at) IS NOT NULL
           AND strftime('%s', r.received_at) IS NOT NULL
           AND CAST(strftime('%s', r.received_at) AS INTEGER) >= CAST(strftime('%s', d.sent_at) AS INTEGER)
         GROUP BY d.id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut stats = std::collections::HashMap::<String, (f64, usize)>::new();
    for row in rows {
        let (recipient, seconds) = row.map_err(|e| e.to_string())?;
        let entry = stats.entry(crate::editor_blocks::mailbox(&recipient)).or_default();
        entry.0 += seconds as f64;
        entry.1 += 1;
    }
    for editor in &mut editors {
        if let Some((sum, count)) = stats.get(&editor.email.trim().to_lowercase()) {
            editor.average_reply_seconds = Some(sum / *count as f64);
            editor.reply_sample_count = *count;
        }
    }
    Ok(editors)
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

    let positions=groups.iter().enumerate().map(|(index,group)|(group.id,index)).collect::<std::collections::HashMap<_,_>>();
    let mut member_stmt=conn.prepare("SELECT m.group_id,m.editor_id FROM editor_group_members m JOIN editors e ON e.id=m.editor_id ORDER BY m.group_id,m.position,m.editor_id").map_err(|e|e.to_string())?;
    let members=member_stmt.query_map([],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?))).map_err(|e|e.to_string())?;
    for member in members {let (group_id,editor_id)=member.map_err(|e|e.to_string())?;if let Some(&index)=positions.get(&group_id){groups[index].editor_ids.push(editor_id);}}
    Ok(groups)
}

pub fn load_task(conn: &Connection, id: i64) -> Result<Option<Task>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, manuscript_ids, account_ids, status, schedule_type, scheduled_at,
                    retry_max, sent, total,
                    created_at, started_at, finished_at, after_task_id, delay_minutes
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
                after_task_id: r.get(13)?,
                delay_minutes: r.get(14)?,
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
    load_task_list(conn, "")
}

pub fn load_dashboard_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    load_task_list(conn, "WHERE status IN ('running', 'paused') OR id IN (SELECT id FROM tasks ORDER BY id DESC LIMIT 3)")
}

fn load_task_list(conn: &Connection, filter: &str) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, name, manuscript_ids, account_ids, status, schedule_type, scheduled_at,
                    retry_max, sent, total,
                    created_at, started_at, finished_at, after_task_id, delay_minutes
             FROM tasks {filter} ORDER BY id DESC",
        ))
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
                after_task_id: r.get(13)?,
                delay_minutes: r.get(14)?,
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
            ensure_no_waiting_dependents(conn, task.id)?;
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
    // Keep evidence independently of logs, so clearing logs cannot forget blocks.
    if level == "error" && crate::editor_blocks::is_blacklist_message(message) {
        if let Some(account_id) = account_id {
            let sender: String = conn.query_row("SELECT email FROM accounts WHERE id=?1", [account_id], |r| r.get(0)).map_err(|e|e.to_string())?;
            crate::editor_blocks::record(conn, &sender, recipient, message, &now_str(conn)?)?;
        }
    }
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

pub fn resolve_relative_schedules(conn: &Connection) -> Result<(), String> {
    conn.execute("UPDATE tasks SET scheduled_at=(
        SELECT datetime(p.finished_at, '+' || tasks.delay_minutes || ' minutes') FROM tasks p
        WHERE p.id=tasks.after_task_id AND p.status IN ('completed','stopped') AND p.finished_at IS NOT NULL)
        WHERE schedule_type='after_previous' AND status='scheduled' AND scheduled_at IS NULL
        AND after_task_id < id AND delay_minutes BETWEEN 1 AND 10080
        AND EXISTS(SELECT 1 FROM tasks p WHERE p.id=tasks.after_task_id AND p.status IN ('completed','stopped') AND datetime(p.finished_at) IS NOT NULL)", []).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_task_finished(conn: &Connection, id: i64, status: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = now_str(&tx)?;
    tx.execute(
        "UPDATE tasks SET status = ?1, finished_at = ?2 WHERE id = ?3",
        params![status, now, id],
    )
    .map_err(|e| e.to_string())?;
    resolve_relative_schedules(&tx)?;
    tx.commit().map_err(|e| e.to_string())
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
    let mut settings: Settings = match raw {
        Some(v) => serde_json::from_str(&v).map_err(|e| e.to_string())?,
        None => Settings::default(),
    };
    let last: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='last_send_interval'", [], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    let (from, to) = last.and_then(|raw| serde_json::from_str::<(i64,i64)>(&raw).ok())
        .filter(|(from,to)| *from >= 1 && *to <= 86400 && from <= to)
        .unwrap_or((crate::models::DEFAULT_SEND_INTERVAL_FROM_SEC, crate::models::DEFAULT_SEND_INTERVAL_TO_SEC));
    settings.last_send_interval_from_sec = from;
    settings.last_send_interval_to_sec = to;
    Ok(settings)
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
    let mut templates: Vec<MailTemplate> = raw.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .unwrap_or_else(|| Ok(Vec::new()))?;
    const UPGRADE_KEY: &str = "mail_templates.friendly_twenty.v1";
    const COPY_UPGRADE_KEY: &str = "mail_templates.casual_copy.v2";
    let expand = !setting_exists(conn, UPGRADE_KEY)?;
    if !expand && setting_exists(conn, COPY_UPGRADE_KEY)? {
        return Ok(templates);
    }
    #[derive(serde::Deserialize)]
    struct Catalog {
        presets: Vec<MailTemplate>,
        legacy: Vec<MailTemplate>,
        previous: Vec<MailTemplate>,
    }
    let catalog: Catalog = serde_json::from_str(include_str!("../../src/data/mail-template-catalog.json"))
        .map_err(|e| e.to_string())?;
    templates.retain(|item| !["t9", "t10"].contains(&item.id.as_str()) && !["初次投稿", "完整稿件"].contains(&item.name.trim()));
    for item in &mut templates {
        if let Some(preset) = catalog.presets.iter().find(|preset| preset.id == item.id) {
            let previous: Vec<_> = catalog.legacy.iter().chain(&catalog.previous).filter(|old| old.id == item.id).collect();
            if previous.iter().any(|old| item.body == old.body) { item.body = preset.body.clone(); }
            if previous.iter().any(|old| item.name == old.name) { item.name = preset.name.clone(); }
            if previous.iter().any(|old| item.subject == old.subject) { item.subject = preset.subject.clone(); }
        }
        // Keep user-written content, but do not address an uncertain editor by name.
        item.body = item.body.replace("{{编辑昵称}}", "编辑老师").replace("{{收件人}}", "编辑老师");
        for token in ["{{编辑昵称}}", "{{收件人}}"] {
            for prefix in ["给", "致", ""] {
                item.subject = item.subject.replace(&format!("{prefix}{token}"), "");
            }
        }
        item.subject = item.subject.trim().trim_start_matches(['：', ':', '，', ',']).trim().to_string();
    }
    for preset in catalog.presets {
        if !expand || templates.len() >= 20 { break; }
        if !templates.iter().any(|item| item.id == preset.id) { templates.push(preset); }
    }
    // Upgrade only once: later user deletions must remain deleted.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    save_default_mail_templates(&tx, &templates)?;
    tx.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?1,'1')", [UPGRADE_KEY]).map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?1,'1')", [COPY_UPGRADE_KEY]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(templates)
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

#[cfg(test)]
mod default_mail_template_tests {
    use super::*;

    #[test]
    fn fresh_defaults_have_twenty_templates_without_recipient_names() {
        let conn = crate::db::test_database();
        let templates = load_default_mail_templates(&conn).unwrap();
        assert_eq!(templates.len(), 20);
        let ids: std::collections::HashSet<_> = templates.iter().map(|item| &item.id).collect();
        assert_eq!(ids.len(), 20);
        for item in &templates {
            for text in [&item.subject, &item.body] {
                assert!(!text.contains("{{编辑昵称}}") && !text.contains("{{收件人}}"));
            }
        }
    }

    #[test]
    fn legacy_defaults_expand_once_preserving_custom_content_and_later_deletions() {
        let conn = crate::db::test_database();
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../src/data/mail-template-catalog.json")).unwrap();
        let mut old: Vec<MailTemplate> = serde_json::from_value(catalog["legacy"].clone()).unwrap();
        old[0].body = "{{编辑昵称}}，这是我自己写的投稿说明。".into();
        old[0].subject = "给{{收件人}}：我的自定义主题".into();
        old[0].name = "我的模板".into();
        save_default_mail_templates(&conn, &old).unwrap();
        let upgraded = load_default_mail_templates(&conn).unwrap();
        assert_eq!(upgraded.len(), 20);
        assert_eq!(upgraded[0].body, "编辑老师，这是我自己写的投稿说明。");
        assert_eq!(upgraded[0].subject, "我的自定义主题");
        assert_eq!(upgraded[0].name, "我的模板");
        assert_eq!(upgraded[1].body, catalog["presets"][1]["body"].as_str().unwrap());
        // A user may still deliberately remove templates after the one-time upgrade.
        save_default_mail_templates(&conn, &upgraded[..3]).unwrap();
        assert_eq!(load_default_mail_templates(&conn).unwrap().len(), 3);
    }

    #[test]
    fn casual_copy_refreshes_previous_defaults_without_restoring_deleted_templates() {
        let conn = crate::db::test_database();
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../src/data/mail-template-catalog.json")).unwrap();
        let previous: Vec<MailTemplate> = serde_json::from_value(catalog["previous"].clone()).unwrap();
        let mut saved = previous[..2].to_vec();
        saved[1].body = "我自己写的投稿话术".into();
        save_default_mail_templates(&conn, &saved).unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('mail_templates.friendly_twenty.v1','1')", []).unwrap();
        let updated = load_default_mail_templates(&conn).unwrap();
        assert_eq!(updated.len(), 2);
        assert_eq!(updated[0].body, "哈喽，来投稿啦🥺 《{{作品名}}》{{类型}}，麻烦看看！");
        assert_eq!(updated[1].body, saved[1].body);
        assert_eq!(load_default_mail_templates(&conn).unwrap().len(), 2);
    }

    #[test]
    fn invalid_saved_templates_are_reported_without_overwriting_them() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO settings(key,value) VALUES('default_mail_templates','broken json')", []).unwrap();
        assert!(load_default_mail_templates(&conn).is_err());
        assert!(!setting_exists(&conn, "mail_templates.friendly_twenty.v1").unwrap());
        let saved: String = conn.query_row("SELECT value FROM settings WHERE key='default_mail_templates'", [], |row| row.get(0)).unwrap();
        assert_eq!(saved, "broken json");
    }
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

/// Pending attempts protect history from destructive changes. Automatic sends
/// may continue to other recipients while these attempts await reconciliation.
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
    let recipient = crate::smtp::parse_recipient(delivery.recipient)
        .1
        .trim()
        .to_lowercase();
    let pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM outgoing_attempts WHERE manuscript_id=?1 AND recipient=?2 COLLATE NOCASE AND status='pending')",
        params![delivery.manuscript_id, recipient], |r| r.get(0)).map_err(|e| e.to_string())?;
    if pending {
        return Err("该收件人的发送结果待确认，请先核对计划记录".into());
    }
    conn.execute("INSERT INTO outgoing_attempts(task_id,run_id,account_id,manuscript_id,recipient,subject,message_id,increment_task_progress)
        VALUES(?1, COALESCE((SELECT run_id FROM tasks WHERE id=?1),
        (SELECT run_id FROM tasks WHERE ?1 IS NULL AND EXISTS
        (SELECT 1 FROM json_each(tasks.manuscript_ids) WHERE value=?3) ORDER BY id DESC LIMIT 1),0), ?2,?3,?4,?5,?6,?7)",
        params![delivery.task_id, delivery.account_id, delivery.manuscript_id,
            recipient, delivery.subject, delivery.message_id, delivery.increment_task_progress])
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

fn ensure_no_waiting_dependents(conn: &Connection, id: i64) -> Result<(), String> {
    let waiting: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE after_task_id=?1 AND schedule_type='after_previous' AND status='scheduled' AND scheduled_at IS NULL)", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if waiting { return Err("还有投稿计划等待此计划结束，请先取消或修改后续预约".into()); }
    Ok(())
}

pub fn delete_task_data(conn: &mut Connection, id: i64) -> Result<(), String> {
    ensure_task_resolved(conn, id)?;
    ensure_no_waiting_dependents(conn, id)?;
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

/// Added recipients reopen the latest completed task without resetting its round.
pub fn refresh_completed_task_recipients(conn: &Connection, task_id: i64) -> Result<bool, String> {
    let Some(task) = load_task(conn, task_id)? else { return Ok(false) };
    if task.status != "completed" || task.schedule_type == "loop" {
        return Ok(false);
    }
    let mut targets = std::collections::HashSet::new();
    let mut delivered = std::collections::HashSet::new();
    for manuscript_id in &task.manuscript_ids {
        let latest: Option<i64> = conn.query_row(
            "SELECT MAX(id) FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.manuscript_ids) WHERE value=?1)",
            [manuscript_id], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if latest != Some(task_id) { return Ok(false); }
        let raw: String = conn.query_row("SELECT recipients FROM manuscripts WHERE id=?1", [manuscript_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let recipients: Vec<String> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        for raw in recipients {
            let email = crate::smtp::parse_recipient(&raw).1.trim().to_lowercase();
            if !email.is_empty() { targets.insert((*manuscript_id, email)); }
        }
    }
    let total = targets.len() as i64;
    if total <= task.total { return Ok(false); }
    for manuscript_id in &task.manuscript_ids {
        for email in delivered_emails_for_task_manuscript(conn, task_id, *manuscript_id)? {
            delivered.insert((*manuscript_id, email.trim().to_lowercase()));
        }
    }
    let sent = targets.intersection(&delivered).count() as i64;
    if sent == total { return Ok(false); }
    // Retain this round and its delivery history; starting a stopped task skips sent targets.
    conn.execute("UPDATE tasks SET status='stopped', sent=?1, total=?2, finished_at=NULL WHERE id=?3 AND status='completed'",
        params![sent, total, task_id]).map(|changed| changed > 0).map_err(|e| e.to_string())
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
               AND run_id = COALESCE((SELECT run_id FROM tasks WHERE id = ?1), 0)
             UNION SELECT r.original_recipient FROM send_recipient_routes r JOIN deliveries d
               ON d.manuscript_id=r.manuscript_id AND lower(d.recipient)=r.recipient AND d.run_id=r.run_id
              AND (d.task_id=r.task_id OR d.task_id IS NULL)
             WHERE r.task_id=?1 AND r.manuscript_id=?2 AND r.run_id=COALESCE((SELECT run_id FROM tasks WHERE id=?1),0)",
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

#[cfg(test)]
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
    is_read: bool,
) -> Result<Reply, String> {
    let accepted = accepted && !acceptance_is_filtered(conn, body)?;
    let read_synced = kind != "auto" || is_read;
    let is_read = is_read || kind == "auto";
    conn.execute(
        "INSERT INTO replies (delivery_id, account_id, task_id, from_email, subject, snippet, body, kind, reason, accepted, message_id, in_reply_to, imap_uid, imap_uid_validity, imap_generation, received_at, is_read, read_synced)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, COALESCE(NULLIF(?16, ''), datetime('now','localtime')), ?17, ?18)",
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
            received_at,
            is_read,
            read_synced,
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
        submissions_paused: [subject, snippet, body].iter().any(|text| text.contains("暂停收稿")),
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
        is_read,
        read_synced,
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
        submissions_paused: r.get(22)?,
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
        is_read: r.get::<_, i64>(20)? != 0,
        read_synced: r.get::<_, i64>(21)? != 0,
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

// A derived category: keep human/auto/bounce and their read semantics intact.
const PAUSED_REPLY: &str = "(instr(r.body, '暂停收稿')>0 OR instr(r.snippet, '暂停收稿')>0 OR instr(r.subject, '暂停收稿')>0)";
const REPLY_FROM: &str = "FROM replies r
    LEFT JOIN deliveries d ON d.id = r.delivery_id
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN manuscripts m ON m.id = d.manuscript_id";
fn reply_filter(
    kind: Option<&str>,
    task_id: Option<i64>,
    query: &str,
    account_id: Option<i64>,
) -> (String, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;
    let mut clauses = vec!["1=1".to_string()];
    let mut values = Vec::<Value>::new();
    if let Some(kind) = kind.filter(|kind| !kind.is_empty()) {
        clauses.push(match kind {
            "paused" => PAUSED_REPLY.into(),
            "accepted" => "r.accepted=1".into(),
            "unread" => "r.kind='human' AND r.is_read=0 AND r.read_synced=1".into(),
            "submission" => "r.delivery_id IS NOT NULL".into(),
            "unmatched" => "r.delivery_id IS NULL".into(),
            _ => {
                values.push(kind.to_string().into());
                format!("r.kind=?{}", values.len())
            }
        });
    }
    if let Some(id) = task_id {
        values.push(id.into());
        clauses.push(format!("r.task_id=?{}", values.len()));
    }
    if let Some(id) = account_id {
        values.push(id.into());
        clauses.push(format!("r.account_id=?{}", values.len()));
    }
    if !query.is_empty() {
        values.push(query.to_string().into());
        let q = values.len();
        clauses.push(format!(
            "(instr(lower(r.body || ' ' || r.snippet || ' ' || r.subject || ' ' || r.from_email
            || ' ' || COALESCE(d.recipient, '') || ' ' || COALESCE(t.name, m.title, '')), ?{q}) > 0
            OR EXISTS (SELECT 1 FROM editors e
                WHERE (lower(e.email)=lower(d.recipient) OR lower(e.email)=lower(r.from_email))
                AND instr(lower(e.name || ' ' || e.platform || ' ' || e.email), ?{q}) > 0))"
        ));
    }
    (format!("WHERE {}", clauses.join(" AND ")), values)
}

pub fn load_reply(conn: &Connection, id: i64) -> Result<Option<Reply>, String> {
    conn.query_row(&format!("SELECT r.id, r.delivery_id, r.account_id, r.task_id, r.from_email, r.subject,
        r.snippet, r.body, r.kind, r.reason, r.accepted, r.message_id, r.in_reply_to, r.imap_uid,
        r.received_at, r.created_at, d.recipient, COALESCE(t.name, m.title, ''), r.imap_uid_validity,
        r.imap_generation, r.is_read, r.read_synced, {PAUSED_REPLY}
        {REPLY_FROM} WHERE r.id=?1"), [id], map_reply)
        .optional().map_err(|e| e.to_string())
}

pub fn query_replies(
    conn: &Connection,
    kind: Option<&str>,
    task_id: Option<i64>,
    query: &str,
    limit: i64,
    offset: i64,
    account_id: Option<i64>,
) -> Result<crate::models::ReplyPage, String> {
    let query = query.trim().to_lowercase();
    let (filter, mut values) = reply_filter(kind, task_id, &query, account_id);
    let count_from = if query.is_empty() {
        "FROM replies r"
    } else {
        REPLY_FROM
    };
    let total = conn
        .query_row(
            &format!("SELECT COUNT(*) {count_from} {filter}"),
            rusqlite::params_from_iter(&values),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let limit_parameter = values.len() + 1;
    let offset_parameter = values.len() + 2;
    let sql = format!("SELECT r.id, r.delivery_id, r.account_id, r.task_id, r.from_email, r.subject,
        substr(CASE WHEN r.snippet<>'' THEN r.snippet ELSE r.body END,1,180), '' AS body, r.kind, r.reason, r.accepted, r.message_id, r.in_reply_to, r.imap_uid,
        r.received_at, r.created_at, d.recipient, COALESCE(t.name, m.title, ''), r.imap_uid_validity, r.imap_generation, r.is_read, r.read_synced, {PAUSED_REPLY}
        {REPLY_FROM} {filter} ORDER BY r.received_at DESC, r.id DESC LIMIT ?{limit_parameter} OFFSET ?{offset_parameter}");
    values.push(limit.max(1).into());
    values.push(offset.max(0).into());
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(&values), map_reply)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(crate::models::ReplyPage { items, total })
}

/// Snapshot every matching unread mail, independent of the visible page.
pub fn unread_reply_ids(
    conn: &Connection,
    kind: Option<&str>,
    task_id: Option<i64>,
    query: &str,
    account_id: Option<i64>,
) -> Result<Vec<i64>, String> {
    let (filter, values) = reply_filter(kind, task_id, &query.trim().to_lowercase(), account_id);
    let mut stmt = conn.prepare(&format!(
        "SELECT r.id {REPLY_FROM} {filter} AND r.kind='human' AND r.is_read=0 AND r.read_synced=1 ORDER BY r.account_id,r.id"
    )).map_err(|e| e.to_string())?;
    let ids = stmt.query_map(rusqlite::params_from_iter(&values), |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

pub fn load_replies(
    conn: &Connection,
    kind: Option<&str>,
    task_id: Option<i64>,
    limit: i64,
) -> Result<Vec<Reply>, String> {
    Ok(query_replies(conn, kind, task_id, "", limit, 0, None)?.items)
}

#[cfg(test)]
pub fn set_reply_read(conn: &Connection, id: i64, is_read: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE replies SET read_revision = read_revision + 1, is_read = CASE WHEN kind = 'auto' THEN 1 ELSE ?2 END, read_synced = CASE WHEN kind = 'auto' THEN ?2 ELSE 1 END WHERE id = ?1",
            params![id, is_read],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("邮件不存在或已删除".into());
    }
    Ok(())
}

#[derive(Clone)]
pub struct ReplyFlagTarget {
    pub read_revision: i64,
    pub id: i64,
    pub account_id: i64,
    pub uid: u32,
    pub uid_validity: i64,
    pub generation: i64,
    pub kind: String,
    pub local_is_read: bool,
    pub local_read_synced: bool,
}

pub fn reply_flag_target(conn: &Connection, id: i64) -> Result<Option<ReplyFlagTarget>, String> {
    let row = conn.query_row(
        "SELECT id, account_id, imap_uid, imap_uid_validity, imap_generation, is_read, read_synced, kind, read_revision FROM replies WHERE id = ?1",
        [id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)? != 0, r.get::<_, i64>(6)? != 0, r.get::<_, String>(7)?, r.get::<_, i64>(8)?)),
    ).optional().map_err(|e| e.to_string())?;
    let Some((
        id,
        Some(account_id),
        uid,
        uid_validity,
        generation,
        local_is_read,
        local_read_synced,
        kind,
        read_revision,
    )) = row
    else {
        return Ok(None);
    };
    let Ok(uid) = u32::try_from(uid) else {
        return Ok(None);
    };
    if uid == 0 {
        return Ok(None);
    }
    Ok(Some(ReplyFlagTarget {
        read_revision,
        id,
        account_id,
        uid,
        uid_validity,
        generation,
        local_is_read,
        local_read_synced,
        kind,
    }))
}

pub fn update_reply_server_read(
    conn: &Connection,
    target: &ReplyFlagTarget,
    is_read: bool,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE replies SET read_revision = read_revision + 1, is_read = CASE WHEN kind = 'auto' THEN 1 ELSE ?2 END, read_synced = CASE WHEN kind = 'auto' THEN ?2 ELSE 1 END
         WHERE id = ?1 AND account_id = ?3 AND imap_uid = ?4
           AND imap_uid_validity = ?5 AND imap_generation = ?6",
            params![
                target.id,
                is_read,
                target.account_id,
                target.uid,
                target.uid_validity,
                target.generation
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("邮件记录已变化，请刷新收件箱".into());
    }
    Ok(())
}

/// Do not let an older FLAGS response overwrite a user's newer read/unread action.
pub fn update_reply_read_from_sync(
    conn: &Connection,
    target: &ReplyFlagTarget,
    is_read: bool,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE replies SET read_revision = read_revision + 1, is_read = CASE WHEN kind = 'auto' THEN 1 ELSE ?2 END, read_synced = CASE WHEN kind = 'auto' THEN ?2 ELSE 1 END
         WHERE id = ?1 AND account_id = ?3 AND imap_uid = ?4
           AND imap_uid_validity = ?5 AND imap_generation = ?6
           AND is_read = ?7 AND read_synced = ?8 AND kind = ?9 AND read_revision = ?10",
            params![
                target.id,
                is_read,
                target.account_id,
                target.uid,
                target.uid_validity,
                target.generation,
                target.local_is_read,
                target.local_read_synced,
                target.kind,
                target.read_revision
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub fn count_replies(conn: &Connection, kind: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM replies WHERE kind = ?1 AND delivery_id IS NOT NULL",
        [kind],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn count_accepted_replies(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM replies WHERE accepted = 1 AND delivery_id IS NOT NULL", [], |r| {
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
    let accepted = if accepted {
        let body: String = conn.query_row("SELECT body FROM replies WHERE id=?1", [id], |row| row.get(0)).map_err(|e| e.to_string())?;
        !acceptance_is_filtered(conn, &body)?
    } else { false };
    conn.execute(
        "UPDATE replies SET read_revision = read_revision + 1, kind = ?1, reason = ?2,
         accepted = CASE WHEN acceptance_dismissed=1 THEN 0 ELSE ?3 END,
         is_read = CASE WHEN ?1 = 'auto' THEN 1 ELSE is_read END,
         read_synced = CASE WHEN ?1 = 'auto' AND is_read = 0 THEN 0 ELSE read_synced END WHERE id = ?4",
        params![kind, reason, accepted, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_editor_source_survives_save_and_load() {
        let conn = crate::db::test_database();
        let input = crate::models::EditorInput {
            platform: "测试平台".into(),
            name: "测试编辑".into(),
            email: "external-source@example.com".into(),
            work_type: vec!["短篇".into(), "女频".into()],
            rejected_types: Vec::new(),
            notes: String::new(),
        };
        upsert_editor(&conn, &input, crate::models::EDITOR_SOURCE_EXTERNAL).unwrap();
        let editors = load_editors(&conn).unwrap();
        let editor = editors.iter().find(|e| e.email == input.email).unwrap();
        assert_eq!(editor.source, "外部导入");
        assert_eq!(editor.work_type, input.work_type);
        assert!(editor.notes.is_empty());
    }

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
                    schedule_type TEXT NOT NULL DEFAULT 'immediate', scheduled_at TEXT, after_task_id INTEGER, delay_minutes INTEGER NOT NULL DEFAULT 30,
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
                    accepted INTEGER NOT NULL DEFAULT 0, is_read INTEGER NOT NULL DEFAULT 0, read_synced INTEGER NOT NULL DEFAULT 0,
                    message_id TEXT NOT NULL DEFAULT '',
                    in_reply_to TEXT NOT NULL DEFAULT '', imap_uid INTEGER NOT NULL DEFAULT 0,
                    received_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', imap_uid_validity INTEGER NOT NULL DEFAULT 0, imap_generation INTEGER NOT NULL DEFAULT 0
                 );",
            )
            .unwrap();
        connection.execute_batch(crate::editor_blocks::SCHEMA).unwrap();
        connection.execute_batch(ACCEPTANCE_FILTER_SCHEMA).unwrap();
        connection
    }

    #[test]
    fn paused_category_uses_full_history_and_preserves_kind_and_read_state() {
        let conn = test_connection();
        conn.execute("INSERT INTO tasks(id,name,manuscript_ids) VALUES(7,'历史计划','[]')", []).unwrap();
        for id in 1..=45 {
            conn.execute("INSERT INTO replies(id,account_id,task_id,body,kind,is_read,read_synced) VALUES(?1,?2,7,?3,?4,0,1)",
                params![id, if id == 3 { 2 } else { 1 }, if id <= 3 { format!("{}暂停收稿", "正文".repeat(200)) } else { "普通回复".into() }, if id == 2 { "auto" } else { "human" }]).unwrap();
        }
        let page = query_replies(&conn, Some("paused"), Some(7), "历史计划", 1, 0, Some(1)).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].id, 2);
        assert_eq!(page.items[0].kind, "auto");
        assert!(page.items[0].submissions_paused);
        assert!(!page.items[0].snippet.contains("暂停收稿"));
        let second = query_replies(&conn, Some("paused"), Some(7), "", 1, 1, Some(1)).unwrap();
        assert_eq!(second.total, 2);
        assert_eq!(second.items[0].id, 1);
        assert!(!second.items[0].is_read);
        assert_eq!(query_replies(&conn, Some("unread"), None, "", 100, 0, None).unwrap().total, 44);
        conn.execute("INSERT INTO replies(subject) VALUES('暂停收稿通知')", []).unwrap();
        assert_eq!(query_replies(&conn, Some("paused"), None, "", 100, 0, None).unwrap().total, 4);
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
    pub latest_recipient: Option<String>,
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
          ON d.manuscript_id=?1 AND ({recipient_key}=r.value OR EXISTS(
            SELECT 1 FROM send_recipient_routes x WHERE x.manuscript_id=d.manuscript_id
              AND x.original_recipient=r.value AND x.recipient={recipient_key}
              AND x.run_id=d.run_id AND (x.task_id=d.task_id OR d.task_id IS NULL)))
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
            (SELECT sent_at FROM deliveries WHERE id=latest_id),
            (SELECT recipient FROM deliveries WHERE id=latest_id) FROM filtered
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
                        latest_recipient: r.get(4)?,
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
    #[test]
    fn plan_sender_summary_uses_distinct_successful_deliveries_including_manual_sends() {
        let conn = fixture();
        conn.execute("UPDATE manuscripts SET account_ids='[3]' WHERE id=10", []).unwrap();
        conn.execute("INSERT INTO manuscripts(id,title,body,account_ids) VALUES(11,'草稿','','[]')", []).unwrap();
        conn.execute_batch("INSERT INTO deliveries(task_id,account_id,manuscript_id,recipient,message_id) VALUES
            (1,1,10,'a@example.com','m1'),(1,1,10,'b@example.com','m2'),
            (NULL,2,10,'c@example.com','manual'),(1,NULL,10,'d@example.com','legacy'),
            (1,99,10,'e@example.com','deleted');").unwrap();
        // Pending/failed attempts must not be presented as successful senders.
        begin_send_attempt(&conn, &SuccessfulDelivery { account_id: 3, ..attempt("pending") }).unwrap();
        let summaries = load_manuscript_list(&conn, true).unwrap();
        let sent = summaries.iter().find(|m| m.id == 10).unwrap();
        assert_eq!(sent.sent_account_ids, vec![None, Some(1), Some(2), Some(99)]);
        assert_eq!(sent.account_ids, vec![3]);
        assert!(summaries.iter().find(|m| m.id == 11).unwrap().sent_account_ids.is_empty());
        assert!(sent.body.is_empty());
    }

    #[test]
    fn summary_omits_large_content_but_detail_preserves_it() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO manuscripts(title, body, mail_templates, file_name, file_data) VALUES (?1, ?2, ?3, 'draft.txt', X'6162')",
            rusqlite::params!["稿件", "正文".repeat(100_000), r#"[{"id":"one","name":"模板","subject":"主题","body":"邮件正文"}]"#]).unwrap();
        let summary = load_manuscript_list(&conn, true).unwrap();
        assert!(summary[0].body.is_empty()); assert!(summary[0].mail_templates.is_empty()); assert!(summary[0].has_file);
        let detail = load_manuscript(&conn, summary[0].id).unwrap().unwrap();
        assert_eq!(detail.body, "正文".repeat(100_000)); assert_eq!(detail.mail_templates.len(), 1);
    }
    #[test]
    fn dashboard_loads_latest_three_and_older_active_tasks() {
        let conn = crate::db::test_database();
        for id in 1..=100 { conn.execute("INSERT INTO tasks(id, name, status) VALUES (?1, 'task', ?2)",
            rusqlite::params![id, if id == 1 { "running" } else if id == 2 { "paused" } else { "completed" }]).unwrap(); }
        let ids: Vec<_> = load_dashboard_tasks(&conn).unwrap().into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec![100, 99, 98, 2, 1]);
    }
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
    fn pending_blocks_resets_deletion_and_duplicate_recipient_attempts() {
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
    fn pending_only_blocks_same_manuscript_and_recipient() {
        let mut conn = fixture();
        begin_send_attempt(&conn, &attempt("m1")).unwrap();
        let duplicate = SuccessfulDelivery {
            recipient: "编辑 <A@EXAMPLE.COM>",
            ..attempt("duplicate")
        };
        assert!(begin_send_attempt(&conn, &duplicate).is_err());
        let other = SuccessfulDelivery {
            recipient: "b@example.com",
            ..attempt("m2")
        };
        begin_send_attempt(&conn, &other).unwrap();
        assert_eq!(pending_sends(&conn, 10).unwrap().len(), 2);
        record_successful_delivery(&mut conn, other).unwrap();
        assert_eq!(pending_sends(&conn, 10).unwrap().len(), 1);
        assert_eq!(load_task(&conn, 1).unwrap().unwrap().sent, 1);
        let another_task = SuccessfulDelivery {
            task_id: None,
            ..attempt("same-recipient-other-task")
        };
        assert!(begin_send_attempt(&conn, &another_task).is_err());
        let another_manuscript = SuccessfulDelivery {
            manuscript_id: 11,
            ..attempt("other-manuscript")
        };
        begin_send_attempt(&conn, &another_manuscript).unwrap();
    }

    #[test]
    fn bookkeeping_failure_keeps_pending_but_allows_next_recipient() {
        let mut conn = fixture();
        begin_send_attempt(&conn, &attempt("m1")).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_one_delivery BEFORE INSERT ON deliveries WHEN NEW.message_id='m1' BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END;").unwrap();
        assert!(record_successful_delivery(&mut conn, attempt("m1")).is_err());
        let other = SuccessfulDelivery {
            recipient: "b@example.com",
            ..attempt("m2")
        };
        begin_send_attempt(&conn, &other).unwrap();
        record_successful_delivery(&mut conn, other).unwrap();
        let pending = pending_sends(&conn, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message_id, "m1");
        assert_eq!(load_task(&conn, 1).unwrap().unwrap().sent, 1);
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

/// Unknown legacy FLAGS are not guessed to be unread. The count covers all accounts and pages.
pub fn unread_human_reply_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM replies WHERE kind='human' AND is_read=0 AND read_synced=1", [], |row| row.get(0)).map_err(|e| e.to_string())
}

pub fn normalize_auto_reply_reads(conn: &Connection) -> Result<(), String> {
    conn.execute("UPDATE replies SET is_read=1, read_synced=0 WHERE kind='auto' AND is_read=0", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod unread_reply_tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'one@example.com','','localhost'),(2,'two@example.com','','localhost')", []).unwrap();
        conn
    }
    #[test]
    fn bulk_read_snapshot_respects_filters_and_includes_every_page() {
        let conn = fixture();
        for uid in 1..=350 {
            conn.execute("INSERT INTO replies(account_id,imap_uid,task_id,kind,is_read,read_synced,subject) VALUES (?1,?2,7,'human',0,1,'暂停收稿 Match')", params![if uid % 2 == 0 { 1 } else { 2 }, uid]).unwrap();
        }
        for (uid, kind, read, synced) in [(351,"auto",0,1),(352,"bounce",0,1),(353,"human",1,1),(354,"human",0,0)] {
            conn.execute("INSERT INTO replies(account_id,imap_uid,kind,is_read,read_synced) VALUES(1,?1,?2,?3,?4)",params![uid,kind,read,synced]).unwrap();
        }
        let ids = unread_reply_ids(&conn, None, None, "", None).unwrap();
        assert_eq!(ids.len(), 350);
        assert_eq!(unread_reply_ids(&conn, Some("paused"), Some(7), " MATCH ", Some(2)).unwrap().len(), 175);
        assert!(unread_reply_ids(&conn, None, Some(8), "", None).unwrap().is_empty());
        assert!(unread_reply_ids(&conn, Some("auto"), None, "", None).unwrap().is_empty());
        assert!(unread_reply_ids(&conn, None, None, "not found", None).unwrap().is_empty());
        // Applying a snapshot must not skip rows as the unread result set shrinks.
        for id in ids { set_reply_read(&conn, id, true).unwrap(); }
        assert!(unread_reply_ids(&conn, Some("unread"), None, "", None).unwrap().is_empty());
    }

    #[test]
    fn human_unread_count_covers_all_accounts_and_pages_without_auto_or_unknown_flags() {
        let conn = fixture();
        for uid in 1..=350 {
            conn.execute("INSERT INTO replies(account_id,imap_uid,kind,is_read,read_synced) VALUES (?1,?2,'human',0,1)", params![if uid % 2 == 0 { 1 } else { 2 }, uid]).unwrap();
        }
        for (uid, kind, read, synced) in [(351,"auto",0,1),(352,"bounce",0,1),(353,"human",1,1),(354,"human",0,0)] {
            conn.execute("INSERT INTO replies(account_id,imap_uid,kind,is_read,read_synced) VALUES(1,?1,?2,?3,?4)",params![uid,kind,read,synced]).unwrap();
        }
        assert_eq!(unread_human_reply_count(&conn).unwrap(), 350);
        let page = query_replies(&conn,Some("unread"),None,"",20,340,None).unwrap();
        assert_eq!(page.total,350); assert_eq!(page.items.len(),10);
        assert!(page.items.iter().all(|reply|reply.kind=="human" && reply.read_synced && !reply.is_read));
        let account = query_replies(&conn,Some("unread"),None,"",20,0,Some(2)).unwrap();
        assert_eq!(account.total,175);
        conn.execute("UPDATE replies SET subject='筛选命中' WHERE imap_uid=350 AND account_id=1",[]).unwrap();
        let searched = query_replies(&conn,Some("unread"),None,"筛选命中",20,0,None).unwrap();
        assert_eq!(searched.total,1);

        set_reply_read(&conn, 1, true).unwrap(); assert_eq!(unread_human_reply_count(&conn).unwrap(), 349);
        set_reply_read(&conn, 1, false).unwrap(); assert_eq!(unread_human_reply_count(&conn).unwrap(), 350);
    }
    #[test]
    fn auto_replies_are_locally_read_even_when_server_store_fails_and_retry_is_pending() {
        let conn = fixture();
        let reply = insert_reply(&conn,None,1,None,"editor@example.com","auto","","body","auto","",false,"m1","",1,10,0,"",false).unwrap();
        assert!(reply.is_read); assert!(!reply.read_synced);
        let target = reply_flag_target(&conn,reply.id).unwrap().unwrap();
        update_reply_read_from_sync(&conn,&target,false).unwrap();
        let read = load_replies(&conn,None,None,10).unwrap().remove(0);
        assert!(read.is_read); assert!(!read.read_synced);
        let target = reply_flag_target(&conn,reply.id).unwrap().unwrap();
        update_reply_read_from_sync(&conn,&target,true).unwrap();
        let read = load_replies(&conn,None,None,10).unwrap().remove(0);
        assert!(read.is_read && read.read_synced);
        assert_eq!(unread_human_reply_count(&conn).unwrap(),0);
    }
    #[test]
    fn stale_flags_cannot_overwrite_read_unread_read_round_trip() {
        let conn=fixture();
        let reply=insert_reply(&conn,None,1,None,"friend@example.com","test","","body","human","",false,"m1","",1,10,0,"",true).unwrap();
        let stale=reply_flag_target(&conn,reply.id).unwrap().unwrap();
        set_reply_read(&conn,reply.id,false).unwrap();set_reply_read(&conn,reply.id,true).unwrap();
        assert!(!update_reply_read_from_sync(&conn,&stale,false).unwrap());
        assert_eq!(unread_human_reply_count(&conn).unwrap(),0);
        let current=reply_flag_target(&conn,reply.id).unwrap().unwrap();
        assert!(update_reply_read_from_sync(&conn,&current,false).unwrap());
        assert_eq!(unread_human_reply_count(&conn).unwrap(),1);
    }

    #[test]
    fn history_and_reclassification_keep_human_read_state_and_reject_stale_flags() {
        let conn = fixture();
        conn.execute("INSERT INTO replies(account_id,imap_uid,kind,is_read,read_synced) VALUES(1,1,'auto',0,1),(1,2,'human',0,1)",[]).unwrap();
        normalize_auto_reply_reads(&conn).unwrap(); normalize_auto_reply_reads(&conn).unwrap();
        let rows = load_replies(&conn,None,None,10).unwrap();
        assert!(rows.iter().find(|r|r.kind=="auto").unwrap().is_read);
        let human = rows.iter().find(|r|r.kind=="human").unwrap();
        assert!(!human.is_read);
        let target = reply_flag_target(&conn,human.id).unwrap().unwrap();
        update_reply_kind(&conn,human.id,"auto","rule",false).unwrap();
        assert!(!update_reply_read_from_sync(&conn,&target,false).unwrap());
        assert_eq!(unread_human_reply_count(&conn).unwrap(),0);
    }
}

#[cfg(test)]
mod inbox_filter_index_tests {
    use super::*;
    #[test]
    fn unread_and_account_filters_use_indexes_and_preserve_results() {
        let conn = crate::db::test_database();
        conn.execute_batch(
            "INSERT INTO replies(account_id,imap_uid,kind,is_read,read_synced,subject) VALUES
            (1,1,'human',0,1,'one'),(2,1,'human',0,1,'two'),(1,2,'auto',1,1,'automatic');",
        )
        .unwrap();
        for (kind, account, index) in [
            (Some("unread"), None, "replies_"),
            (None, Some(1), "replies_account_received"),
        ] {
            let (filter, values) = reply_filter(kind, None, "", account);
            let sql = format!("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM replies r {filter}");
            let mut stmt = conn.prepare(&sql).unwrap();
            let plans = stmt
                .query_map(rusqlite::params_from_iter(&values), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join(" ");
            assert!(plans.contains(index), "{plans}");
            assert!(!plans.contains("SCAN r "), "{plans}");
        }
        let page = query_replies(&conn, Some("unread"), None, "", 20, 0, Some(1)).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].subject, "one");
        assert_eq!(
            query_replies(&conn, None, None, "automatic", 20, 0, Some(1))
                .unwrap()
                .total,
            1
        );
    }
}

#[cfg(test)]
mod account_config_tests {
    use super::*;
    #[test]
    fn enabled_configs_do_not_read_delivery_statistics() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(email,password,smtp_host,enabled) VALUES('on@example.com','fixture','localhost',1),('off@example.com','fixture','localhost',0)", []).unwrap();
        conn.execute("DROP TABLE deliveries", []).unwrap();
        let accounts = load_enabled_account_configs(&conn).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].email, "on@example.com");
        assert_eq!(accounts[0].sent_today, 0);
        assert!(load_accounts(&conn).is_err(), "UI account statistics still require deliveries");
    }
}

#[cfg(test)]
mod editor_batch_tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute_batch("INSERT INTO editors(id,name,email,favorited,notes) VALUES(1,'甲','a@example.com',1,'保留'),(2,'乙','b@example.com',0,''),(3,'丙','c@example.com',0,'');
            INSERT INTO editor_groups(id,name) VALUES(1,'编辑组');
            INSERT INTO editor_group_members(group_id,editor_id,position) VALUES(1,1,0),(1,2,1),(1,3,2);
            INSERT INTO manuscripts(id,title,body,recipients) VALUES(1,'稿件','正文','[\"a@example.com\"]');
            INSERT INTO replies(id,from_email,body,kind) VALUES(1,'a@example.com','暂停收稿','human');").unwrap();
        conn
    }
    #[test]
    fn batch_status_deduplicates_preserves_profiles_and_rolls_back_stale_selection() {
        let mut conn = fixture();
        assert!(batch_editors(&mut conn, &[], Some(false)).is_err());
        assert!(batch_editors(&mut conn, &[1, 999], Some(false)).is_err());
        assert!(ensure_editor_enabled(&conn, "a@example.com").is_ok());
        assert_eq!(batch_editors(&mut conn, &[2, 1, 1], Some(false)).unwrap(), 2);
        assert!(ensure_editor_enabled(&conn, "a@example.com").is_err());
        assert!(ensure_editor_enabled(&conn, "b@example.com").is_err());
        assert!(ensure_editor_enabled(&conn, "c@example.com").is_ok());
        let profile: (bool, String) = conn.query_row("SELECT favorited,notes FROM editors WHERE id=1", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(profile, (true, "保留".into()));
        assert_eq!(batch_editors(&mut conn, &[1, 2], Some(true)).unwrap(), 2);
        assert!(ensure_editor_enabled(&conn, "a@example.com").is_ok());
    }
    #[test]
    fn batch_delete_is_atomic_and_preserves_mail_and_plan_recipients() {
        let mut conn = fixture();
        assert!(batch_editors(&mut conn, &[1, 999], None).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM editor_group_members", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        conn.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON editors WHEN OLD.id=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(batch_editors(&mut conn, &[1, 2], None).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM editors", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        conn.execute_batch("DROP TRIGGER fail_delete;").unwrap();
        assert_eq!(batch_editors(&mut conn, &[2, 1, 1], None).unwrap(), 2);
        assert_eq!(conn.query_row("SELECT editor_id FROM editor_group_members", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replies", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT recipients FROM manuscripts WHERE id=1", [], |r| r.get::<_, String>(0)).unwrap(), "[\"a@example.com\"]");
    }
}

#[cfg(test)]
mod editor_reply_time_tests {
    use super::*;
    #[test]
    fn averages_first_human_reply_per_delivery_across_accounts_and_history() {
        let conn = crate::db::test_database();
        conn.execute_batch("INSERT INTO editors(id,email,name) VALUES(1,'editor@example.com','有回复'),(2,'none@example.com','无回复');
          INSERT INTO deliveries(id,account_id,recipient,subject,message_id,sent_at) VALUES
           (1,1,'编辑 <EDITOR@example.com>','稿件','d1','2026-10-01 08:00:00'),
           (2,2,'editor@example.com','重发','d2','2026-10-02 08:00:00'),
           (3,1,'editor@example.com','未回复','d3','2026-10-01 08:00:00'),
           (4,1,'none@example.com','自动回执','d4','2026-10-01 08:00:00'),
           (5,1,'editor@example.com','异常','d5','无效时间');
          INSERT INTO replies(imap_uid,delivery_id,account_id,kind,received_at) VALUES
           (1,1,1,'auto','2026-10-01 08:01:00'),
           (2,1,1,'human','2026-10-01 10:00:00'),
           (3,1,1,'human','2026-10-01 18:00:00'),
           (4,1,1,'human','2026-10-01 10:00:00'),
           (5,1,1,'human','2026-09-30 08:00:00'),
           (6,1,1,'human','损坏时间'),
           (7,2,2,'human','2026-10-02 14:00:00'),
           (8,2,1,'human','2026-10-02 08:01:00'),
           (9,3,1,'bounce','2026-10-01 08:01:00'),
           (10,4,1,'auto','2026-10-01 08:01:00'),
           (11,5,1,'human','2026-10-01 08:00:00'),
           (12,NULL,1,'human','2026-10-01 08:01:00');").unwrap();
        let editors = load_editors_with_reply_stats(&conn).unwrap();
        let editor = editors.iter().find(|e| e.id == 1).unwrap();
        assert_eq!(editor.reply_sample_count, 2);
        assert_eq!(editor.average_reply_seconds, Some(4.0 * 3600.0));
        let empty = editors.iter().find(|e| e.id == 2).unwrap();
        assert_eq!(empty.average_reply_seconds, None);
        assert_eq!(empty.reply_sample_count, 0);
        // Reclassification updates the derived value without migrations or cached DB columns.
        conn.execute("UPDATE replies SET kind='auto' WHERE delivery_id=1", []).unwrap();
        let editor = load_editors_with_reply_stats(&conn).unwrap().into_iter().find(|e| e.id == 1).unwrap();
        assert_eq!(editor.reply_sample_count, 1);
        assert_eq!(editor.average_reply_seconds, Some(6.0 * 3600.0));
        // A genuine zero-second reply counts; missing data must remain null instead.
        conn.execute("INSERT INTO replies(imap_uid,delivery_id,account_id,kind,received_at) VALUES(99,4,1,'human','2026-10-01 08:00:00')", []).unwrap();
        let editor = load_editors_with_reply_stats(&conn).unwrap().into_iter().find(|e| e.id == 2).unwrap();
        assert_eq!(editor.reply_sample_count, 1);
        assert_eq!(editor.average_reply_seconds, Some(0.0));
    }

    #[test]
    fn scheduler_editor_lookup_does_not_require_reply_history() {
        let conn = crate::db::test_database();
        conn.execute_batch("DROP TABLE replies; DROP TABLE deliveries;").unwrap();
        assert!(load_editors(&conn).is_ok());
    }
}
