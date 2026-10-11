//! Terminal recipient refusals are processed targets, never successful deliveries.
use crate::{editor_blocks, store};
use rusqlite::{params, Connection};
use std::collections::HashSet;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS send_recipient_failures (
 task_id INTEGER NOT NULL, run_id INTEGER NOT NULL, manuscript_id INTEGER NOT NULL,
 recipient TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL,
 PRIMARY KEY(task_id,run_id,manuscript_id,recipient,kind)
);
CREATE TABLE IF NOT EXISTS send_recipient_skips (
 task_id INTEGER NOT NULL, run_id INTEGER NOT NULL, manuscript_id INTEGER NOT NULL,
 original_recipient TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL,
 PRIMARY KEY(task_id,run_id,manuscript_id,original_recipient)
);
CREATE VIEW IF NOT EXISTS active_send_recipient_skips AS
 SELECT s.* FROM send_recipient_skips s JOIN tasks t ON t.id=s.task_id AND t.run_id=s.run_id
 JOIN manuscripts m ON m.id=s.manuscript_id
 WHERE EXISTS(SELECT 1 FROM json_each(m.recipients) r WHERE lower(trim(CASE WHEN instr(r.value,'<')>0
   THEN substr(r.value,instr(r.value,'<')+1,instr(substr(r.value,instr(r.value,'<')+1),'>')-1) ELSE r.value END))=s.original_recipient)
;
CREATE TRIGGER IF NOT EXISTS settle_delivered_recipient_skip AFTER INSERT ON deliveries BEGIN
 DELETE FROM send_recipient_skips WHERE manuscript_id=NEW.manuscript_id AND run_id=NEW.run_id
 AND (task_id=NEW.task_id OR NEW.task_id IS NULL) AND (original_recipient=lower(trim(NEW.recipient)) OR EXISTS(
 SELECT 1 FROM send_recipient_routes r WHERE r.task_id=send_recipient_skips.task_id AND r.run_id=send_recipient_skips.run_id
 AND r.manuscript_id=send_recipient_skips.manuscript_id AND r.original_recipient=send_recipient_skips.original_recipient
 AND r.recipient=lower(trim(NEW.recipient))));
END;
CREATE TRIGGER IF NOT EXISTS clean_task_send_outcomes AFTER DELETE ON tasks BEGIN
 DELETE FROM send_recipient_failures WHERE task_id=OLD.id;
 DELETE FROM send_recipient_skips WHERE task_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_manuscript_send_outcomes AFTER DELETE ON manuscripts BEGIN
 DELETE FROM send_recipient_failures WHERE manuscript_id=OLD.id;
 DELETE FROM send_recipient_skips WHERE manuscript_id=OLD.id;
END;
"#;

pub fn failure_kind(message: &str) -> Option<&'static str> {
    if editor_blocks::is_blacklist_message(message) {
        Some("blacklist")
    } else if editor_blocks::is_invalid_recipient_message(message) {
        Some("recipient_invalid")
    } else {
        None
    }
}

pub fn record_failure(
    conn: &Connection,
    task_id: i64,
    manuscript_id: i64,
    recipient: &str,
    kind: &str,
) -> Result<(), String> {
    conn.execute("INSERT OR IGNORE INTO send_recipient_failures SELECT id,run_id,?2,?3,?4 FROM tasks WHERE id=?1",
        params![task_id,manuscript_id,editor_blocks::mailbox(recipient),kind]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn record_skip(
    conn: &Connection,
    task_id: i64,
    manuscript_id: i64,
    original: &str,
    kind: &str,
) -> Result<(), String> {
    if store::delivered_emails_for_task_manuscript(conn, task_id, manuscript_id)?
        .contains(&editor_blocks::mailbox(original))
    {
        return Ok(());
    }
    conn.execute("INSERT INTO send_recipient_skips SELECT id,run_id,?2,?3,?4 FROM tasks WHERE id=?1
        ON CONFLICT(task_id,run_id,manuscript_id,original_recipient) DO UPDATE SET kind=excluded.kind",
        params![task_id,manuscript_id,editor_blocks::mailbox(original),kind]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn skipped_emails(
    conn: &Connection,
    task_id: i64,
    manuscript_id: i64,
) -> Result<HashSet<String>, String> {
    let mut stmt = conn.prepare("SELECT original_recipient FROM active_send_recipient_skips WHERE task_id=?1 AND manuscript_id=?2").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![task_id, manuscript_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Reconcile only ended tasks whose complete recipient roster is accounted for.
/// Paused/running, manually stopped, unknown failures and pending sends stay intact.
pub fn reconcile_finished_tasks(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut changed = Vec::new();
    for task in store::load_tasks(conn)? {
        if task.status != "stopped" || task.schedule_type == "loop" || task.finished_at.is_none() {
            continue;
        }
        if store::ensure_task_resolved(conn, task.id).is_err() {
            continue;
        }
        let ended: bool = conn.query_row("SELECT COALESCE((SELECT message='任务投递结束，但有邮件发送失败' FROM task_logs
            WHERE task_id=?1 AND category='task' AND created_at>=COALESCE(?2,'') ORDER BY id DESC LIMIT 1),0)",
            params![task.id,task.started_at], |r|r.get(0)).map_err(|e|e.to_string())?;
        if !ended {
            continue;
        }
        let mut total = 0;
        let mut sent = 0;
        let mut skipped = 0;
        let mut seen = HashSet::new();
        let mut missing = false;
        for mid in &task.manuscript_ids {
            if !seen.insert(*mid) {
                continue;
            }
            let Some(manuscript) = store::load_manuscript(conn, *mid)? else {
                missing = true;
                break;
            };
            let delivered = store::delivered_emails_for_task_manuscript(conn, task.id, *mid)?;
            let handled = skipped_emails(conn, task.id, *mid)?;
            let recipients: HashSet<_> = manuscript
                .recipients
                .iter()
                .map(|r| editor_blocks::mailbox(r))
                .filter(|r| !r.is_empty())
                .collect();
            total += recipients.len() as i64;
            sent += recipients.intersection(&delivered).count() as i64;
            skipped += recipients.intersection(&handled).count() as i64;
        }
        if !missing && total > 0 && skipped > 0 && sent + skipped == total {
            conn.execute("UPDATE tasks SET status='completed',sent=?2,total=?3 WHERE id=?1 AND status='stopped'",
                params![task.id,sent,total]).map_err(|e|e.to_string())?;
            changed.push(task.id);
        }
    }
    Ok(changed)
}

pub fn backfill(conn: &Connection) -> Result<(), String> {
    if store::setting_exists(conn, "send_outcomes.backfilled.v1")? {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare("SELECT l.task_id,l.manuscript_id,l.recipient,l.message FROM task_logs l JOIN tasks t ON t.id=l.task_id
            WHERE l.manuscript_id IS NOT NULL AND l.recipient<>'' AND l.level IN ('error','warning')
            AND l.category IN ('send','blacklist','recipient_invalid','editor_replacement')
            AND l.created_at>=COALESCE(t.started_at,t.created_at)
            AND (t.run_id=0 OR EXISTS(SELECT 1 FROM outgoing_attempts a WHERE a.task_id=t.id AND a.run_id=t.run_id
                AND a.manuscript_id=l.manuscript_id AND instr(lower(l.recipient),lower(a.recipient))>0)) ORDER BY l.id").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (task, mid, recipient, message) = row.map_err(|e| e.to_string())?;
            let kind = failure_kind(&message).or_else(|| {
                message.contains("未找到可用的同平台替代编辑").then_some(
                    if message.contains("收件地址") && message.contains("已失效") {
                        "recipient_invalid"
                    } else { "blacklist" }
                )
            });
            let Some(kind) = kind else {
                continue;
            };
            record_failure(&tx, task, mid, &recipient, kind)?;
            let email = editor_blocks::mailbox(&recipient);
            let original: String = tx.query_row("SELECT COALESCE((SELECT original_recipient FROM send_recipient_routes WHERE task_id=?1
                AND manuscript_id=?2 AND run_id=(SELECT run_id FROM tasks WHERE id=?1) AND recipient=?3),?3)",
                params![task,mid,email],|r|r.get(0)).map_err(|e|e.to_string())?;
            record_skip(&tx, task, mid, &original, kind)?;
        }
    }
    reconcile_finished_tasks(&tx)?;
    store::mark_setting(&tx, "send_outcomes.backfilled.v1")?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute_batch(r#"
          INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'sender@example.com','','localhost');
          INSERT INTO manuscripts(id,title,body,recipients) VALUES(1,'稿件','正文','["a@example.com","b@example.com","c@example.com"]');
          INSERT INTO tasks(id,name,manuscript_ids,status,sent,total,started_at,finished_at) VALUES(1,'计划','[1]','stopped',1,3,'2026-01-01','2026-01-02');
          INSERT INTO deliveries(task_id,account_id,manuscript_id,recipient,message_id) VALUES(1,1,1,'a@example.com','sent');
          INSERT INTO task_logs(task_id,manuscript_id,account_id,recipient,category,level,message) VALUES
           (1,1,1,'b@example.com','send','error','550 The sender is blacklisted by the recipient'),
           (1,1,1,'c@example.com','send','error','550 The recipient may contain a non-existent account');
          INSERT INTO task_logs(task_id,category,level,message) VALUES(1,'task','warning','任务投递结束，但有邮件发送失败');
        "#).unwrap();
        conn
    }

    #[test]
    fn historical_refusals_complete_without_inflating_success_or_double_counting() {
        let conn = fixture();
        conn.execute("INSERT INTO task_logs(task_id,manuscript_id,recipient,category,level,message) VALUES
            (1,1,'c@example.com','editor_replacement','warning','收件地址 c@example.com 已失效；未找到可用的同平台替代编辑')",[]).unwrap();
        backfill(&conn).unwrap();
        let task = store::load_task(&conn, 1).unwrap().unwrap();
        assert_eq!(
            (task.status.as_str(), task.sent, task.skipped, task.total),
            ("completed", 1, 2, 3)
        );
        let emails = vec![
            "a@example.com".into(),
            "b@example.com".into(),
            "c@example.com".into(),
        ];
        let page = store::delivery_summary_page(&conn, 1, &emails, &[0], "all", 1, 0).unwrap();
        assert_eq!(
            (
                page.sent_total,
                page.skipped_total,
                page.blacklist_total,
                page.invalid_total
            ),
            (1, 2, 1, 1)
        );
        record_failure(&conn, 1, 1, "B@example.com", "blacklist").unwrap();
        backfill(&conn).unwrap();
        conn.execute("DELETE FROM task_logs", []).unwrap();
        let page =
            store::delivery_summary_page(&conn, 1, &emails, &[0, 1, 2], "all", 10, 0).unwrap();
        assert_eq!(
            (page.blacklist_total, page.invalid_total, page.skipped_total),
            (1, 1, 2)
        );
        assert_eq!(page.items[1].skip_kind.as_deref(), Some("blacklist"));
        assert_eq!(store::delivery_summary_page(&conn,1,&emails,&[0,1,2],"unsent",10,0).unwrap().total,0);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM deliveries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn active_manual_pending_and_other_failures_are_not_completed() {
        for case in [
            "running", "paused", "manual", "network", "pending", "missing",
        ] {
            let conn = fixture();
            match case {
                "running" | "paused" => {
                    conn.execute("UPDATE tasks SET status=?1", [case]).unwrap();
                }
                "manual" => {
                    conn.execute("INSERT INTO task_logs(task_id,category,message) VALUES(1,'task','任务已被手动停止')",[]).unwrap();
                }
                "network" => {
                    conn.execute("UPDATE task_logs SET message='连接中断',category='network' WHERE recipient='c@example.com'",[]).unwrap();
                }
                "missing" => {
                    conn.execute("UPDATE tasks SET manuscript_ids='[1,99]'", [])
                        .unwrap();
                }
                "pending" => {
                    store::begin_send_attempt(
                        &conn,
                        &store::SuccessfulDelivery {
                            task_id: Some(1),
                            account_id: 1,
                            manuscript_id: 1,
                            recipient: "c@example.com",
                            subject: "稿件",
                            message_id: "pending",
                            increment_task_progress: true,
                        },
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
            backfill(&conn).unwrap();
            assert_ne!(
                store::load_task(&conn, 1).unwrap().unwrap().status,
                "completed",
                "{case}"
            );
        }
    }

    #[test]
    fn retry_round_and_manual_success_keep_skip_counts_separate() {
        let conn = fixture();
        backfill(&conn).unwrap();
        conn.execute("INSERT INTO deliveries(task_id,account_id,manuscript_id,recipient,message_id) VALUES(1,1,1,'b@example.com','manual')",[]).unwrap();
        assert_eq!(store::load_task(&conn, 1).unwrap().unwrap().skipped, 1);
        store::reset_task_progress(&conn, 1).unwrap();
        let task = store::load_task(&conn, 1).unwrap().unwrap();
        assert_eq!((task.sent, task.skipped), (0, 0));
        assert!(skipped_emails(&conn, 1, 1).unwrap().is_empty());
    }
}
