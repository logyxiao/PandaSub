//! Recipient-specific SMTP refusals. A block belongs to a sender/recipient pair,
//! not to an editor or a whole platform globally.
use crate::{
    models::{Account, Manuscript, TaskLog},
    smtp, store,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS editor_blocks (
 sender_email TEXT NOT NULL COLLATE NOCASE,
 recipient_email TEXT NOT NULL COLLATE NOCASE,
 editor_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
 reason TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(sender_email,recipient_email)
);
CREATE TABLE IF NOT EXISTS send_recipient_routes (
 task_id INTEGER NOT NULL, run_id INTEGER NOT NULL, manuscript_id INTEGER NOT NULL,
 original_recipient TEXT NOT NULL COLLATE NOCASE,
 recipient TEXT NOT NULL COLLATE NOCASE,
 PRIMARY KEY(task_id,run_id,manuscript_id,original_recipient),
 UNIQUE(task_id,run_id,manuscript_id,recipient)
);
CREATE TRIGGER IF NOT EXISTS clean_task_recipient_routes AFTER DELETE ON tasks BEGIN
 DELETE FROM send_recipient_routes WHERE task_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_manuscript_recipient_routes AFTER DELETE ON manuscripts BEGIN
 DELETE FROM send_recipient_routes WHERE manuscript_id=OLD.id;
END;
"#;

pub fn mailbox(raw: &str) -> String {
    smtp::parse_recipient(raw).1.trim().to_lowercase()
}

/// Deliberately narrow: a generic 550, spam/RBL rejection or a sender-provided
/// string containing "blacklist" alone is not evidence of this relationship.
pub fn is_blacklist_message(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    text.contains("550") && text.contains("the sender is blacklisted by the recipient")
}

#[derive(Serialize)]
pub struct EditorBlock {
    pub sender_email: String,
    pub recipient_email: String,
    pub editor_name: String,
    pub platform: String,
    pub reason: String,
    pub first_seen: String,
    pub last_seen: String,
}

pub fn record(
    conn: &Connection,
    sender: &str,
    recipient: &str,
    reason: &str,
    at: &str,
) -> Result<(), String> {
    let sender = mailbox(sender);
    let recipient = mailbox(recipient);
    if !is_blacklist_message(reason)
        || smtp::parse_mailbox(&sender).is_err()
        || smtp::parse_mailbox(&recipient).is_err()
    {
        return Ok(());
    }
    let (name, platform): (String, String) = conn
        .query_row(
            "SELECT name,platform FROM editors WHERE lower(trim(email))=?1",
            [&recipient],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    conn.execute("INSERT INTO editor_blocks(sender_email,recipient_email,editor_name,platform,reason,first_seen,last_seen) VALUES(?1,?2,?3,?4,?5,?6,?6)
        ON CONFLICT(sender_email,recipient_email) DO UPDATE SET reason=excluded.reason,last_seen=excluded.last_seen,active=1,
        editor_name=excluded.editor_name,platform=excluded.platform",
        params![sender,recipient,name,platform,reason,at]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn backfill(conn: &Connection) -> Result<(), String> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key='editors.blacklist_backfilled.v1')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if done {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt=tx.prepare("SELECT a.email,l.recipient,l.message,l.created_at FROM task_logs l JOIN accounts a ON a.id=l.account_id
            WHERE l.level='error' AND instr(lower(l.message),'the sender is blacklisted by the recipient')>0 ORDER BY l.id").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (sender, recipient, message, at) = row.map_err(|e| e.to_string())?;
            record(&tx, &sender, &recipient, &message, &at)?;
        }
    }
    tx.execute(
        "INSERT INTO settings(key,value) VALUES('editors.blacklist_backfilled.v1','1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn list(conn: &Connection) -> Result<Vec<EditorBlock>, String> {
    let mut stmt=conn.prepare("SELECT b.sender_email,b.recipient_email,COALESCE(e.name,b.editor_name),COALESCE(e.platform,b.platform),b.reason,b.first_seen,b.last_seen
        FROM editor_blocks b LEFT JOIN editors e ON lower(trim(e.email))=b.recipient_email WHERE b.active=1 ORDER BY b.last_seen DESC,b.recipient_email,b.sender_email").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(EditorBlock {
                sender_email: r.get(0)?,
                recipient_email: r.get(1)?,
                editor_name: r.get(2)?,
                platform: r.get(3)?,
                reason: r.get(4)?,
                first_seen: r.get(5)?,
                last_seen: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
pub fn clear(conn: &Connection, sender: &str, recipient: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE editor_blocks SET active=0 WHERE sender_email=?1 AND recipient_email=?2",
        params![mailbox(sender), mailbox(recipient)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn blocked(conn: &Connection, sender: &str, recipient: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM editor_blocks WHERE sender_email=?1 AND recipient_email=?2 AND active=1)",params![mailbox(sender),mailbox(recipient)],|r|r.get(0)).map_err(|e|e.to_string())
}

pub enum Route {
    Ready {
        recipient: String,
        notice: Option<TaskLog>,
    },
    Unavailable(TaskLog),
}

fn compatible(editor: &crate::models::Editor, manuscript: &Manuscript) -> bool {
    let mut raw = manuscript.genres.clone();
    raw.extend([
        manuscript.category.clone(),
        manuscript.reader_category.clone(),
    ]);
    let tags = crate::models::normalize_editor_work_types(&raw);
    let excluded = crate::models::normalize_editor_work_types(&manuscript.excluded_types);
    if editor.rejected_types.iter().any(|t| tags.contains(t))
        || editor.work_type.iter().any(|t| excluded.contains(t))
    {
        return false;
    }
    let axes: [&[&str]; 2] = [&["短篇", "中短篇", "中篇", "长篇"], &["女频", "男频"]];
    for axis in axes {
        let wanted: Vec<_> = tags.iter().filter(|t| axis.contains(&t.as_str())).collect();
        let offered: Vec<_> = editor
            .work_type
            .iter()
            .filter(|t| axis.contains(&t.as_str()))
            .collect();
        if !wanted.is_empty() && !offered.is_empty() && !wanted.iter().any(|t| offered.contains(t))
        {
            return false;
        }
    }
    let topic =
        |t: &&String| t.as_str() != "全品类" && !axes.iter().any(|axis| axis.contains(&t.as_str()));
    let wanted: Vec<_> = tags.iter().filter(topic).collect();
    let offered: Vec<_> = editor.work_type.iter().filter(topic).collect();
    wanted.is_empty()
        || offered.is_empty()
        || editor.work_type.iter().any(|t| t == "全品类")
        || wanted.iter().any(|t| offered.contains(t))
}

/// Persist each substitution before sending. The route keeps progress and
/// pending-attempt protection attached to the original plan entry after restart.
pub fn route(
    conn: &Connection,
    task_id: i64,
    account: &Account,
    manuscript: &Manuscript,
    original: &str,
) -> Result<Route, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let run_id: i64 = tx
        .query_row("SELECT run_id FROM tasks WHERE id=?1", [task_id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let original_email = mailbox(original);
    let current: Option<String>=tx.query_row("SELECT recipient FROM send_recipient_routes WHERE task_id=?1 AND run_id=?2 AND manuscript_id=?3 AND original_recipient=?4",
        params![task_id,run_id,manuscript.id,original_email],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let current_email = current.clone().unwrap_or_else(|| original_email.clone());
    let editors = store::load_editors(&tx)?;
    let platform = editors
        .iter()
        .find(|e| mailbox(&e.email) == original_email)
        .map(|e| crate::models::canonicalize_editor_platform(&e.platform))
        .unwrap_or_default();
    let formatted = |email: &str| {
        editors
            .iter()
            .find(|e| mailbox(&e.email) == email)
            .map(|e| format!("{} <{}>", e.name.replace(['<', '>', '\r', '\n'], ""), email))
            .unwrap_or_else(|| email.to_string())
    };
    if let Err(message) = store::ensure_editor_enabled(&tx, &current_email) {
        let log = store::insert_send_log(&tx, Some(task_id), Some(manuscript.id), Some(account.id),
            "warning", "editor_status", &message, &current_email)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Route::Unavailable(log));
    }
    if current.is_some()
        && !editors.iter().any(|e| {
            mailbox(&e.email) == current_email
                && e.enabled
                && crate::models::canonicalize_editor_platform(&e.platform) == platform
                && compatible(e, manuscript)
        })
    {
        let log=store::insert_send_log(&tx,Some(task_id),Some(manuscript.id),Some(account.id),"error","editor_replacement",
            &format!("先前替代编辑 {} 的资料已变更、被禁用或已不符合原平台与稿件类型。本次已跳过，请检查编辑资料后再发送。",formatted(&current_email)),&current_email)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Route::Unavailable(log));
    }
    if !blocked(&tx, &account.email, &current_email)? {
        let recipient = if current.is_some() {
            formatted(&current_email)
        } else {
            original.to_string()
        };
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(Route::Ready {
            recipient,
            notice: None,
        });
    }
    let mut excluded: HashSet<String> = manuscript.recipients.iter().map(|r| mailbox(r)).collect();
    excluded.extend(store::delivered_emails_for_manuscript(&tx, manuscript.id)?);
    excluded.extend(
        store::pending_sends(&tx, manuscript.id)?
            .iter()
            .map(|p| mailbox(&p.recipient)),
    );
    {
        let mut stmt=tx.prepare("SELECT recipient FROM send_recipient_routes WHERE task_id=?1 AND run_id=?2 AND manuscript_id=?3").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map(params![task_id, run_id, manuscript.id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            excluded.insert(mailbox(&row.map_err(|e| e.to_string())?));
        }
    }
    let mut next = None;
    if !["", "未知", "未填", "未填平台"].contains(&platform.as_str()) {
        for editor in &editors {
            let email = mailbox(&editor.email);
            if !editor.enabled
                || excluded.contains(&email)
                || email == current_email
                || crate::models::canonicalize_editor_platform(&editor.platform) != platform
                || smtp::parse_mailbox(&email).is_err()
                || !compatible(editor, manuscript)
                || blocked(&tx, &account.email, &email)?
            {
                continue;
            }
            next = Some(formatted(&email));
            break;
        }
    }
    let result = if let Some(recipient) = next {
        tx.execute("INSERT INTO send_recipient_routes(task_id,run_id,manuscript_id,original_recipient,recipient) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(task_id,run_id,manuscript_id,original_recipient) DO UPDATE SET recipient=excluded.recipient",
            params![task_id,run_id,manuscript.id,original_email,mailbox(&recipient)]).map_err(|e|e.to_string())?;
        let notice=store::insert_send_log(&tx,Some(task_id),Some(manuscript.id),Some(account.id),"warning","editor_replacement",
            &format!("发件邮箱 {} 被 {} 拉黑；已自动改投同平台「{}」的 {}。发件邮箱保持不变，替换仅用于本次任务；未发现拉黑记录不代表保证投递成功。",account.email,formatted(&current_email),platform,recipient),&recipient)?;
        Route::Ready {
            recipient,
            notice: Some(notice),
        }
    } else {
        Route::Unavailable(store::insert_send_log(&tx,Some(task_id),Some(manuscript.id),Some(account.id),"error","editor_replacement",
            &format!("发件邮箱 {} 被 {} 拉黑；未找到可用的同平台替代编辑（需有明确平台、启用、类型符合、未被该邮箱拉黑，且未在名单、投递历史或待确认记录中）。已跳过，未更换发件邮箱，请调整编辑名单后再发送。",account.email,formatted(&current_email)),&current_email)?)
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    const REASON: &str="投递被永久拒绝：服务端拒绝投递（550）：The sender is blacklisted by the recipient, please contact the recipient.";
    fn fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute_batch(r#"
          INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'sender@example.com','','localhost'),(2,'other@example.com','','localhost');
          INSERT INTO editors(id,name,email,platform,work_type) VALUES
           (1,'原编辑','old@example.com','甲平台','["短篇"]'),
           (2,'同平台编辑','peer@example.com','甲平台','["短篇"]'),
           (3,'另一平台','outside@example.com','乙平台','["短篇"]');
          INSERT INTO manuscripts(id,title,body,recipients,genres) VALUES(1,'稿件','给{{编辑昵称}}：正文','["原编辑 <old@example.com>"]','["短篇"]');
          INSERT INTO tasks(id,name,manuscript_ids) VALUES(1,'计划','[1]'),(2,'另一计划','[1]');
        "#).unwrap();
        conn
    }
    fn block(conn: &Connection, recipient: &str) {
        record(
            conn,
            "sender@example.com",
            recipient,
            REASON,
            "2026-10-03 12:00:00",
        )
        .unwrap();
    }
    fn resolve(conn: &Connection, account: i64) -> Route {
        route(
            conn,
            1,
            &store::load_account(conn, account).unwrap().unwrap(),
            &store::load_manuscript(conn, 1).unwrap().unwrap(),
            "原编辑 <old@example.com>",
        )
        .unwrap()
    }
    #[test]
    fn disabled_editors_are_checked_for_saved_plans_and_manual_targets() {
        let conn = fixture();
        store::set_editor_enabled(&conn, 1, false).unwrap();
        store::set_editor_enabled(&conn, 1, false).unwrap();
        assert!(store::set_editor_enabled(&conn, 99999, false).is_err());
        assert!(store::ensure_editor_enabled(&conn, "原编辑 <OLD@example.com>").is_err());
        assert!(store::ensure_editor_enabled(&conn, "not-in-library@example.com").is_ok());
        match resolve(&conn, 1) {
            Route::Unavailable(log) => {
                assert_eq!(log.category, "editor_status");
                assert!(log.message.contains("已停用"));
            }
            _ => panic!("disabled original must not be sent"),
        }
        let editor = store::load_editors(&conn).unwrap().into_iter().find(|e| e.id == 1).unwrap();
        assert!(!editor.enabled);
        assert_eq!(editor.name, "原编辑");
        assert_eq!(editor.work_type, vec!["短篇"]);
        store::set_editor_enabled(&conn, 1, true).unwrap();
        assert!(store::ensure_editor_enabled(&conn, "old@example.com").is_ok());
        assert!(matches!(resolve(&conn, 1), Route::Ready { .. }));
        block(&conn, "old@example.com");
        assert!(matches!(resolve(&conn, 1), Route::Ready { .. }));
        store::set_editor_enabled(&conn, 2, false).unwrap();
        assert!(matches!(resolve(&conn, 1), Route::Unavailable(_)));
    }

    #[test]
    fn upgrading_an_existing_database_backfills_once_without_resurrecting_cleared_blocks() {
        let conn = fixture();
        conn.execute("INSERT INTO task_logs(account_id,recipient,message,level) VALUES(1,'原编辑 <old@example.com>',?1,'error')",[REASON]).unwrap();
        conn.execute_batch("DROP TRIGGER clean_task_recipient_routes; DROP TRIGGER clean_manuscript_recipient_routes; DROP TABLE send_recipient_routes; DROP TABLE editor_blocks;").unwrap();
        let path = std::env::temp_dir().join(format!(
            "novelsub-block-upgrade-{:032x}.sqlite",
            rand::random::<u128>()
        ));
        conn.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        drop(conn);
        let upgraded = crate::db::open_database(path.clone()).unwrap();
        assert!(blocked(&upgraded, "sender@example.com", "old@example.com").unwrap());
        assert_eq!(list(&upgraded).unwrap().len(), 1);
        clear(&upgraded, "sender@example.com", "old@example.com").unwrap();
        drop(upgraded);
        let reopened = crate::db::open_database(path.clone()).unwrap();
        assert!(!blocked(&reopened, "sender@example.com", "old@example.com").unwrap());
        assert_eq!(
            reopened
                .query_row("SELECT COUNT(*) FROM task_logs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(reopened);
        std::fs::remove_file(&path).unwrap();
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn history_backfill_is_pair_scoped_idempotent_and_survives_log_clear() {
        let conn = fixture();
        for (id, sender, recipient, message) in [
            (1, 1, "原编辑 <OLD@example.com>", REASON),
            (2, 2, "old@example.com", REASON),
            (3, 1, "peer@example.com", "550 mailbox not found"),
            (
                4,
                1,
                "outside@example.com",
                "451 The sender is blacklisted by the recipient",
            ),
        ] {
            conn.execute("INSERT INTO task_logs(id,account_id,recipient,message,level) VALUES(?1,?2,?3,?4,'error')",params![id,sender,recipient,message]).unwrap();
        }
        backfill(&conn).unwrap();
        backfill(&conn).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 2);
        assert_eq!(
            store::load_editors(&conn)
                .unwrap()
                .iter()
                .find(|e| e.id == 1)
                .unwrap()
                .blocked_senders
                .len(),
            2
        );
        assert!(blocked(&conn, "SENDER@example.com", "OLD@example.com").unwrap());
        assert!(!blocked(&conn, "sender@example.com", "peer@example.com").unwrap());
        clear(&conn, "sender@example.com", "old@example.com").unwrap();
        backfill(&conn).unwrap();
        assert!(!blocked(&conn, "sender@example.com", "old@example.com").unwrap());
        conn.execute("DELETE FROM task_logs", []).unwrap();
        assert!(blocked(&conn, "other@example.com", "old@example.com").unwrap());
        store::insert_send_log(
            &conn,
            Some(1),
            Some(1),
            Some(1),
            "error",
            "blacklist",
            REASON,
            "原编辑 <old@example.com>",
        )
        .unwrap();
        assert!(blocked(&conn, "sender@example.com", "old@example.com").unwrap());
    }
    #[test]
    fn substitution_preserves_sender_platform_placeholders_and_resume_progress() {
        let mut conn = fixture();
        block(&conn, "old@example.com");
        let Route::Ready { recipient, notice } = resolve(&conn, 1) else {
            panic!("missing replacement")
        };
        assert_eq!(mailbox(&recipient), "peer@example.com");
        let notice = notice.unwrap();
        assert_eq!(notice.account_id, Some(1));
        assert!(notice.message.contains("原编辑"));
        assert!(notice.message.contains("同平台编辑"));
        let manuscript = store::load_manuscript(&conn, 1).unwrap().unwrap();
        let (_, body) = smtp::resolve_outgoing_mail(&manuscript, &recipient, false);
        assert!(body.contains("同平台编辑"));
        assert!(!body.contains("原编辑"));
        let Route::Ready {
            recipient: again,
            notice,
        } = resolve(&conn, 1)
        else {
            panic!()
        };
        assert_eq!(again, recipient);
        assert!(notice.is_none());
        let attempt = store::SuccessfulDelivery {
            task_id: Some(1),
            account_id: 1,
            manuscript_id: 1,
            recipient: "peer@example.com",
            subject: "稿件",
            message_id: "replacement-message",
            increment_task_progress: true,
        };
        store::begin_send_attempt(&conn, &attempt).unwrap();
        store::record_successful_delivery(&mut conn, attempt).unwrap();
        assert!(store::delivered_emails_for_task_manuscript(&conn, 1, 1)
            .unwrap()
            .contains("old@example.com"));
        assert!(!store::delivered_emails_for_task_manuscript(&conn, 2, 1)
            .unwrap()
            .contains("old@example.com"));
        assert_eq!(store::load_task(&conn, 1).unwrap().unwrap().sent, 1);
        let page = store::delivery_summary_page(
            &conn,
            1,
            &["old@example.com".into()],
            &[0],
            "sent",
            10,
            0,
        )
        .unwrap();
        assert_eq!(page.sent_total, 1);
        assert_eq!(page.items[0].sent_count, 1);
        let target = store::load_delivery(&conn, page.items[0].latest_id.unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(target.recipient, "peer@example.com");
        assert_eq!(target.account_id, Some(1));
        store::advance_loop_cycle(&conn, 1).unwrap();
        assert!(!store::delivered_emails_for_task_manuscript(&conn, 1, 1)
            .unwrap()
            .contains("old@example.com"));
    }
    #[test]
    fn no_substitution_for_unblocked_sender_and_no_cross_platform_fallback() {
        let conn = fixture();
        block(&conn, "old@example.com");
        let Route::Ready { recipient, notice } = resolve(&conn, 2) else {
            panic!()
        };
        assert_eq!(mailbox(&recipient), "old@example.com");
        assert!(notice.is_none());
        block(&conn, "peer@example.com");
        let Route::Unavailable(log) = resolve(&conn, 1) else {
            panic!()
        };
        assert!(log.message.contains("已跳过"));
        assert_eq!(log.account_id, Some(1));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM outgoing_attempts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn candidates_exclude_disabled_incompatible_selected_sent_and_pending_mail() {
        for case in [
            "disabled", "rejected", "excluded", "mismatch", "selected", "sent", "pending",
            "unknown",
        ] {
            let conn = fixture();
            block(&conn, "old@example.com");
            match case {
                "disabled" => {
                    conn.execute("UPDATE editors SET enabled=0 WHERE id=2", [])
                        .unwrap();
                }
                "rejected" => {
                    conn.execute(
                        "UPDATE editors SET rejected_types='[\"短篇\"]' WHERE id=2",
                        [],
                    )
                    .unwrap();
                }
                "excluded" => {
                    conn.execute(
                        "UPDATE manuscripts SET excluded_types='[\"短篇\"]' WHERE id=1",
                        [],
                    )
                    .unwrap();
                }
                "mismatch" => {
                    conn.execute("UPDATE editors SET work_type='[\"长篇\"]' WHERE id=2", [])
                        .unwrap();
                }
                "selected" => {
                    conn.execute("UPDATE manuscripts SET recipients='[\"old@example.com\",\"peer@example.com\"]' WHERE id=1",[]).unwrap();
                }
                "sent" => {
                    conn.execute("INSERT INTO deliveries(manuscript_id,recipient,message_id) VALUES(1,'peer@example.com','sent')",[]).unwrap();
                }
                "pending" => {
                    store::begin_send_attempt(
                        &conn,
                        &store::SuccessfulDelivery {
                            task_id: Some(1),
                            account_id: 1,
                            manuscript_id: 1,
                            recipient: "peer@example.com",
                            subject: "稿件",
                            message_id: "pending",
                            increment_task_progress: true,
                        },
                    )
                    .unwrap();
                }
                "unknown" => {
                    conn.execute("UPDATE editors SET platform='未知'", [])
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(matches!(resolve(&conn, 1), Route::Unavailable(_)), "{case}");
        }
    }
    #[test]
    fn shared_length_tag_does_not_override_gender_and_topic_mismatches() {
        let conn = fixture();
        block(&conn, "old@example.com");
        conn.execute(
            "UPDATE manuscripts SET genres='[\"短篇\",\"女频\",\"古言\"]' WHERE id=1",
            [],
        )
        .unwrap();
        for work in [
            "[\"短篇\",\"男频\",\"古言\"]",
            "[\"短篇\",\"女频\",\"悬疑\"]",
        ] {
            conn.execute("UPDATE editors SET work_type=?1 WHERE id=2", [work])
                .unwrap();
            assert!(matches!(resolve(&conn, 1), Route::Unavailable(_)));
        }
        conn.execute(
            "UPDATE editors SET work_type='[\"短篇\",\"女频\",\"古言\"]' WHERE id=2",
            [],
        )
        .unwrap();
        assert!(matches!(resolve(&conn, 1), Route::Ready { .. }));
        conn.execute("UPDATE editors SET platform='另一平台' WHERE id=2", [])
            .unwrap();
        assert!(
            matches!(resolve(&conn, 1), Route::Unavailable(_)),
            "a persisted route must revalidate its platform before SMTP"
        );
    }

    #[test]
    fn second_rejection_advances_chain_and_does_not_reuse_a_reserved_peer() {
        let conn = fixture();
        conn.execute("INSERT INTO editors(id,name,email,platform,work_type) VALUES(4,'新编辑','next@example.com','甲平台','[\"短篇\"]')",[]).unwrap();
        block(&conn, "old@example.com");
        let Route::Ready { recipient, .. } = resolve(&conn, 1) else {
            panic!()
        };
        block(&conn, &recipient);
        let Route::Ready {
            recipient: second, ..
        } = resolve(&conn, 1)
        else {
            panic!()
        };
        assert_ne!(recipient, second);
        block(&conn, &second);
        assert!(matches!(resolve(&conn, 1), Route::Unavailable(_)));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM send_recipient_routes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
