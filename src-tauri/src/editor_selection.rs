//! Selection statistics and an explicit, offline-only redistribution of unstarted plans.
use std::collections::{HashMap, HashSet};

use rand::Rng;
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;

use crate::{editor_blocks::mailbox, models::Editor, store};

#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct Usage {
    pub sent: usize,
    pub queued: usize,
}

/// Count distinct manuscripts, not retries or accounts. Failures and manual mail
/// without a task are not successful plan submissions. Pending rosters reserve
/// their recipients so successive new plans do not all draw the same unused peer.
pub(crate) fn load_usage(
    conn: &Connection,
    excluded_manuscripts: &HashSet<i64>,
) -> Result<HashMap<String, Usage>, String> {
    let mut sent = HashMap::<String, HashSet<i64>>::new();
    let mut stmt = conn.prepare("SELECT recipient,manuscript_id FROM deliveries WHERE task_id IS NOT NULL AND manuscript_id IS NOT NULL").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (recipient, mid) = row.map_err(|e| e.to_string())?;
        sent.entry(mailbox(&recipient)).or_default().insert(mid);
    }
    let mut queued = HashMap::<String, HashSet<i64>>::new();
    let mut stmt = conn.prepare("SELECT DISTINCT m.id,m.recipients FROM manuscripts m JOIN tasks t JOIN json_each(CASE WHEN json_valid(t.manuscript_ids) THEN t.manuscript_ids ELSE '[]' END) ids ON ids.value=m.id
        WHERE t.status IN ('scheduled','running','paused') OR (t.status='stopped' AND t.started_at IS NULL AND t.finished_at IS NULL AND t.sent=0)").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (mid, recipients) = row.map_err(|e| e.to_string())?;
        if excluded_manuscripts.contains(&mid) {
            continue;
        }
        let recipients: Vec<String> = serde_json::from_str(&recipients).unwrap_or_default();
        for recipient in recipients {
            let email = mailbox(&recipient);
            if !sent.get(&email).is_some_and(|mids| mids.contains(&mid)) {
                queued.entry(email).or_default().insert(mid);
            }
        }
    }
    let mut usage: HashMap<String, Usage> = sent
        .into_iter()
        .map(|(email, mids)| {
            (
                email,
                Usage {
                    sent: mids.len(),
                    queued: 0,
                },
            )
        })
        .collect();
    for (email, mids) in queued {
        usage.entry(email).or_default().queued = mids.len();
    }
    Ok(usage)
}

pub(crate) fn choose<'a>(
    editors: &[&'a Editor],
    usage: &HashMap<String, Usage>,
    rng: &mut impl Rng,
) -> Option<&'a Editor> {
    let counts = |editor: &Editor| {
        usage
            .get(&mailbox(&editor.email))
            .copied()
            .unwrap_or_default()
    };
    let unused = editors.iter().any(|e| counts(e).sent == 0);
    let pool: Vec<_> = editors
        .iter()
        .copied()
        .filter(|e| !unused || counts(e).sent == 0)
        .collect();
    let minimum = pool
        .iter()
        .map(|e| {
            let c = counts(e);
            c.sent + c.queued
        })
        .min()?;
    let pool: Vec<_> = pool
        .into_iter()
        .filter(|e| {
            let c = counts(e);
            c.sent + c.queued == minimum
        })
        .collect();
    let favorite = pool.iter().any(|e| e.favorited);
    let pool: Vec<_> = pool
        .into_iter()
        .filter(|e| !favorite || e.favorited)
        .collect();
    Some(pool[rng.random_range(0..pool.len())])
}

fn matches(editor: &Editor, tags: &[String], excluded: &[String]) -> bool {
    if !editor.enabled
        || editor.invalid_recipient_reason.is_some()
        || crate::smtp::parse_mailbox(&editor.email).is_err()
    {
        return false;
    }
    if editor.work_type.iter().any(|t| excluded.contains(t))
        || editor.rejected_types.iter().any(|t| tags.contains(t))
    {
        return false;
    }
    let lengths = ["短篇", "中短篇", "中篇", "长篇"];
    for is_length in [true, false] {
        let wanted: Vec<_> = tags
            .iter()
            .filter(|t| lengths.contains(&t.as_str()) == is_length)
            .collect();
        if !wanted.is_empty() && !wanted.iter().any(|t| editor.work_type.contains(t)) {
            return false;
        }
    }
    true
}

#[derive(Serialize, Debug)]
pub struct Redistribution {
    pub manuscript_id: i64,
    pub task_ids: Vec<i64>,
    pub title: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub no_compatible_peer: Vec<String>,
    pub matching_platforms: usize,
    pub multiple_candidate_platforms: usize,
}

/// This is only invoked by the explicit maintenance CLI, never on startup or
/// task execution. An IMMEDIATE transaction rechecks live status and history
/// before writing; all shared/started/sent/pending manuscripts are protected.
pub fn redistribute_unsent(
    conn: &mut Connection,
    apply: bool,
) -> Result<Vec<Redistribution>, String> {
    redistribute_unsent_with_recipient(conn, apply, None)
}

/// An explicitly requested recipient overrides type matching and pins the
/// resulting roster. This never changes the editor's library tags or status.
pub fn redistribute_unsent_with_recipient(
    conn: &mut Connection,
    apply: bool,
    append_recipient: Option<&str>,
) -> Result<Vec<Redistribution>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let tasks = store::load_tasks(&tx)?;
    let mut candidates = Vec::new();
    for manuscript in store::load_manuscript_list(&tx, true)? {
        // Explicitly locked/manual rosters are not automatic type selections.
        if append_recipient.is_none()
            && (manuscript.recipients.is_empty() || manuscript.lock_recipients)
        {
            continue;
        }
        let related: Vec<_> = tasks
            .iter()
            .filter(|t| t.manuscript_ids.contains(&manuscript.id))
            .collect();
        if related.iter().any(|t| {
            !["stopped", "scheduled"].contains(&t.status.as_str())
                || t.started_at.is_some()
                || t.finished_at.is_some()
                || t.sent != 0
        }) {
            continue;
        }
        let previous_run = related
            .iter()
            .try_fold(false, |has_run, t| {
                tx.query_row("SELECT run_id<>0 FROM tasks WHERE id=?1", [t.id], |r| {
                    r.get::<_, bool>(0)
                })
                .map(|value| has_run || value)
            })
            .map_err(|e| e.to_string())?;
        if previous_run {
            continue;
        }
        let touched: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM deliveries WHERE manuscript_id=?1) OR EXISTS(SELECT 1 FROM outgoing_attempts WHERE manuscript_id=?1) OR EXISTS(SELECT 1 FROM task_logs WHERE manuscript_id=?1 AND category IN ('send','blacklist','recipient_invalid','editor_replacement'))", [manuscript.id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if touched {
            continue;
        }
        let order = related.iter().map(|t| t.id).min().unwrap_or(i64::MAX);
        let task_ids = related.iter().map(|t| t.id).collect::<Vec<_>>();
        let accounts: HashSet<_> = related
            .iter()
            .flat_map(|t| t.account_ids.iter().copied())
            .chain(manuscript.account_ids.iter().copied())
            .collect();
        candidates.push((order, manuscript, task_ids, accounts));
    }
    candidates.sort_by_key(|(order, _, _, _)| *order);
    let excluded = candidates.iter().map(|(_, m, _, _)| m.id).collect();
    let mut usage = load_usage(&tx, &excluded)?;
    let editors = store::load_editors(&tx)?;
    let fixed = append_recipient
        .map(|raw| {
            let email = mailbox(raw);
            if crate::smtp::parse_mailbox(&email).is_err() {
                return Err("指定收件地址无效".to_string());
            }
            let editor = editors
                .iter()
                .find(|e| mailbox(&e.email) == email)
                .ok_or("指定编辑不在编辑库中")?;
            if !editor.enabled || editor.invalid_recipient_reason.is_some() {
                return Err("指定编辑已停用或地址失效".to_string());
            }
            Ok(editor)
        })
        .transpose()?;
    let accounts = store::load_enabled_account_configs(&tx)?;
    let mut rng = rand::rng();
    let mut result = Vec::new();
    for (_, manuscript, task_ids, account_ids) in candidates {
        let senders: Vec<_> = accounts
            .iter()
            .filter(|a| account_ids.is_empty() || account_ids.contains(&a.id))
            .map(|a| a.email.trim().to_lowercase())
            .collect();
        let tags = crate::models::normalize_editor_work_types(&manuscript.genres);
        let excluded = crate::models::normalize_editor_work_types(&manuscript.excluded_types);
        let mut after = Vec::new();
        let mut unavailable = Vec::new();
        // Automatic type matching must rebuild from the complete library, not
        // only platforms already present in an older saved recipient list.
        let mut groups = std::collections::BTreeMap::<String, Vec<&Editor>>::new();
        for editor in &editors {
            if !matches(editor, &tags, &excluded)
                || (!editor.blocked_senders.is_empty()
                    && (senders.is_empty()
                        || !senders.iter().any(|s| !editor.blocked_senders.contains(s))))
            {
                continue;
            }
            let platform = crate::models::canonicalize_editor_platform(&editor.platform);
            let key = if ["未知", "未填", "未填平台"].contains(&platform.as_str()) {
                format!("__{}", mailbox(&editor.email))
            } else {
                platform
            };
            groups.entry(key).or_default().push(editor);
        }
        let matching_platforms = groups.len();
        let multiple_candidate_platforms = groups.values().filter(|peers| peers.len() > 1).count();
        if manuscript.lock_recipients || manuscript.recipients.is_empty() || task_ids.is_empty() {
            after = manuscript.recipients.clone();
        } else if groups.is_empty() {
            after = manuscript.recipients.clone();
            unavailable.extend(
                manuscript
                    .recipients
                    .iter()
                    .filter_map(|r| editors.iter().find(|e| mailbox(&e.email) == mailbox(r)))
                    .map(|e| e.platform.clone()),
            );
        } else {
            for peers in groups.values() {
                let chosen = choose(&peers, &usage, &mut rng);
                if let Some(chosen) = chosen {
                    after.push(format!(
                        "{} <{}>",
                        chosen.name.replace(['<', '>', '\r', '\n'], ""),
                        mailbox(&chosen.email)
                    ));
                }
            }
            // Addresses outside the library were explicit entries, not auto picks.
            after.extend(
                manuscript
                    .recipients
                    .iter()
                    .filter(|r| !editors.iter().any(|e| mailbox(&e.email) == mailbox(r)))
                    .cloned(),
            );
        }
        if let Some(editor) = fixed {
            let email = mailbox(&editor.email);
            let platform = crate::models::canonicalize_editor_platform(&editor.platform);
            after.retain(|r| {
                mailbox(r) != email
                    && !editors.iter().any(|e| {
                        mailbox(&e.email) == mailbox(r)
                            && crate::models::canonicalize_editor_platform(&e.platform) == platform
                    })
            });
            after.push(format!(
                "{} <{}>",
                editor.name.replace(['<', '>', '\r', '\n'], ""),
                email
            ));
        }
        for recipient in &after {
            usage.entry(mailbox(recipient)).or_default().queued += 1;
        }
        if apply
            && (after != manuscript.recipients || (fixed.is_some() && !manuscript.lock_recipients))
        {
            tx.execute("UPDATE manuscripts SET recipients=?2,lock_recipients=?3,updated_at=datetime('now','localtime') WHERE id=?1", params![manuscript.id, serde_json::to_string(&after).map_err(|e| e.to_string())?, manuscript.lock_recipients || fixed.is_some()]).map_err(|e| e.to_string())?;
        }
        result.push(Redistribution {
            manuscript_id: manuscript.id,
            task_ids,
            title: manuscript.title,
            before: manuscript.recipients,
            after,
            no_compatible_peer: unavailable,
            matching_platforms,
            multiple_candidate_platforms,
        });
    }
    if apply {
        tx.commit().map_err(|e| e.to_string())?;
    } else {
        tx.rollback().map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = crate::db::test_database();
        conn.execute_batch(r#"
            INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'sender@example.com','fixture','localhost');
            INSERT INTO editors(id,name,email,platform,work_type,favorited) VALUES
                (1,'已投收藏','old@example.com','平台','["短篇","悬疑"]',1),
                (2,'未投收藏','new@example.com','平台','["短篇","悬疑"]',1),
                (3,'未投普通','other@example.com','平台','["短篇","悬疑"]',0),
                (4,'类型不符','wrong@example.com','平台','["长篇","甜宠"]',1);
            INSERT INTO manuscripts(id,title,body,genres,recipients) VALUES
                (1,'待发一','正文','["短篇","悬疑"]','["old@example.com"]'),
                (2,'待发二','正文','["短篇","悬疑"]','["old@example.com"]'),
                (99,'历史稿','正文','[]','[]');
            INSERT INTO tasks(id,name,manuscript_ids,status,schedule_type,after_task_id,delay_minutes,account_ids) VALUES
                (1,'待发一','[1]','scheduled','after_previous',99,30,'[1]'),
                (2,'待发二','[2]','stopped','immediate',NULL,30,'[1]');
            INSERT INTO deliveries(task_id,manuscript_id,recipient,message_id) VALUES
                (99,99,'已投收藏 <OLD@example.com>','old'),
                (99,99,'old@example.com','retry'),
                (NULL,99,'new@example.com','manual');
        "#).unwrap();
        conn
    }

    #[test]
    fn usage_counts_distinct_successful_plan_manuscripts_and_reservations() {
        let conn = fixture();
        conn.execute("INSERT INTO outgoing_attempts(task_id,run_id,account_id,manuscript_id,recipient,subject,message_id,status) VALUES(1,0,1,1,'other@example.com','','pending','pending')", []).unwrap();
        let usage = load_usage(&conn, &HashSet::new()).unwrap();
        assert_eq!(usage["old@example.com"].sent, 1);
        assert_eq!(usage["old@example.com"].queued, 2);
        assert!(!usage.contains_key("new@example.com"));
        assert!(!usage.contains_key("other@example.com"));
        let editors = store::load_editors_with_reply_stats(&conn).unwrap();
        let old = editors.iter().find(|e| e.id == 1).unwrap();
        assert_eq!((old.plan_sent_count, old.plan_queued_count), (1, 2));
        let excluded = load_usage(&conn, &HashSet::from([1, 2])).unwrap();
        assert_eq!(excluded["old@example.com"].queued, 0);
        conn.execute("UPDATE tasks SET status='completed' WHERE id=1", [])
            .unwrap();
        assert_eq!(
            load_usage(&conn, &HashSet::new()).unwrap()["old@example.com"].queued,
            1
        );
    }

    #[test]
    fn selection_uses_unseen_then_least_usage_then_favorites_and_reaches_all_ties() {
        use rand::{rngs::StdRng, SeedableRng};
        let conn = fixture();
        let editors = store::load_editors(&conn).unwrap();
        let pool: Vec<_> = editors.iter().filter(|e| e.id <= 3).collect();
        let mut rng = StdRng::seed_from_u64(1);
        let mut usage = load_usage(&conn, &HashSet::new()).unwrap();
        assert_eq!(choose(&pool, &usage, &mut rng).unwrap().id, 2);
        usage.insert("new@example.com".into(), Usage { sent: 0, queued: 1 });
        assert_eq!(choose(&pool, &usage, &mut rng).unwrap().id, 3);
        usage.insert("other@example.com".into(), Usage { sent: 2, queued: 0 });
        assert_eq!(
            choose(&pool, &usage, &mut rng).unwrap().id,
            2,
            "unseen precedes historical recipients despite queue pressure"
        );
        usage.insert("new@example.com".into(), Usage { sent: 2, queued: 1 });
        assert_eq!(
            choose(&pool, &usage, &mut rng).unwrap().id,
            3,
            "least combined use precedes favorite"
        );
        usage.insert("old@example.com".into(), Usage { sent: 2, queued: 0 });
        assert_eq!(
            choose(&pool, &usage, &mut rng).unwrap().id,
            1,
            "favorite among equal use"
        );
        usage.insert("new@example.com".into(), Usage { sent: 2, queued: 0 });
        let reached: HashSet<_> = (0..100)
            .map(|_| choose(&pool, &usage, &mut rng).unwrap().id)
            .collect();
        assert_eq!(reached, HashSet::from([1, 2]));
        assert!(choose(&[], &usage, &mut rng).is_none());
    }

    #[test]
    fn preview_is_read_only_and_batch_balances_rosters_without_starting_or_rescheduling() {
        let mut conn = fixture();
        let before = store::load_tasks(&conn).unwrap();
        let preview = redistribute_unsent(&mut conn, false).unwrap();
        assert_eq!(preview.len(), 2);
        assert_eq!(
            store::load_manuscript(&conn, 1)
                .unwrap()
                .unwrap()
                .recipients,
            ["old@example.com"]
        );
        let applied = redistribute_unsent(&mut conn, true).unwrap();
        assert_eq!(mailbox(&applied[0].after[0]), "new@example.com");
        assert_eq!(mailbox(&applied[1].after[0]), "other@example.com");
        assert_eq!(
            serde_json::to_value(store::load_tasks(&conn).unwrap()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM deliveries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM outgoing_attempts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn automatic_redistribution_includes_matching_platforms_missing_from_old_roster() {
        let mut conn = fixture();
        conn.execute("INSERT INTO editors(id,name,email,platform,work_type) VALUES(5,'新增平台编辑','new-platform@example.com','新增平台','[\"短篇\",\"悬疑\"]')", []).unwrap();
        let results = redistribute_unsent(&mut conn, true).unwrap();
        assert_eq!(results[0].matching_platforms, 2);
        assert_eq!(results[0].multiple_candidate_platforms, 1);
        assert_eq!(results[0].after.len(), 2);
        assert!(results[0]
            .after
            .iter()
            .any(|r| mailbox(r) == "new-platform@example.com"));
        assert_eq!(
            store::load_task(&conn, 1).unwrap().unwrap().status,
            "scheduled"
        );
    }

    #[test]
    fn explicit_recipient_is_added_once_to_all_unstarted_plans_and_pinned_despite_type_rejection() {
        let mut conn = fixture();
        conn.execute_batch("INSERT INTO editors(id,name,email,platform,work_type,rejected_types) VALUES(5,'指定编辑','fixed@example.com','指定平台','[\"短篇\"]','[\"悬疑\"]');
          INSERT INTO manuscripts(id,title,body,recipients,genres,lock_recipients) VALUES
            (3,'锁定草稿','正文','[\"old@example.com\"]','[\"短篇\"]',1),(4,'运行稿','正文','[\"old@example.com\"]','[\"短篇\"]',0),(5,'空名单草稿','正文','[]','[]',0);
          INSERT INTO tasks(id,name,manuscript_ids,status) VALUES(3,'锁定计划','[3]','scheduled'),(4,'运行计划','[4]','running');").unwrap();
        let results =
            redistribute_unsent_with_recipient(&mut conn, true, Some("fixed@example.com")).unwrap();
        assert_eq!(
            results
                .iter()
                .map(|r| r.manuscript_id)
                .collect::<HashSet<_>>(),
            HashSet::from([1, 2, 3, 5])
        );
        for result in &results {
            assert_eq!(
                result
                    .after
                    .iter()
                    .filter(|r| mailbox(r) == "fixed@example.com")
                    .count(),
                1
            );
            assert!(
                store::load_manuscript(&conn, result.manuscript_id)
                    .unwrap()
                    .unwrap()
                    .lock_recipients
            );
        }
        assert_eq!(
            store::load_manuscript(&conn, 4)
                .unwrap()
                .unwrap()
                .recipients,
            ["old@example.com"]
        );
        assert_eq!(
            store::load_manuscript(&conn, 3)
                .unwrap()
                .unwrap()
                .recipients
                .len(),
            2,
            "locked manual roster is retained"
        );
        let before: Vec<_> = results.iter().map(|r| r.after.clone()).collect();
        let again =
            redistribute_unsent_with_recipient(&mut conn, true, Some("fixed@example.com")).unwrap();
        assert_eq!(
            before,
            again.iter().map(|r| r.after.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn all_started_sent_attempted_locked_or_shared_active_manuscripts_are_protected() {
        let mut conn = fixture();
        for id in 3..=15 {
            conn.execute("INSERT INTO manuscripts(id,title,body,genres,recipients) VALUES(?1,'保护稿','正文','[\"短篇\"]','[\"old@example.com\"]')", [id]).unwrap();
            conn.execute("INSERT INTO tasks(id,name,manuscript_ids,status) VALUES(?1,'保护计划',?2,'stopped')", params![id, format!("[{id}]")]).unwrap();
        }
        for (id, status) in [(3, "running"), (4, "paused"), (5, "completed")] {
            conn.execute(
                "UPDATE tasks SET status=?2 WHERE id=?1",
                params![id, status],
            )
            .unwrap();
        }
        conn.execute_batch("UPDATE tasks SET started_at='2026-01-01' WHERE id=6;
            UPDATE tasks SET sent=1 WHERE id=7;
            UPDATE tasks SET run_id=1 WHERE id=10;
            UPDATE manuscripts SET lock_recipients=1 WHERE id=11;
            INSERT INTO tasks(id,name,manuscript_ids,status) VALUES(30,'共享运行','[12]','running');
            UPDATE tasks SET finished_at='2026-01-01' WHERE id=14;
            INSERT INTO deliveries(task_id,manuscript_id,recipient,message_id) VALUES(15,15,'old@example.com','legacy-success');
            INSERT INTO task_logs(task_id,manuscript_id,category,level,message) VALUES(13,13,'send','error','过去失败');
            INSERT INTO outgoing_attempts(task_id,run_id,account_id,manuscript_id,recipient,subject,message_id,status) VALUES
                (8,0,1,8,'old@example.com','','pending','pending'),(9,0,1,9,'old@example.com','','failed','not_sent');").unwrap();
        let protected: Vec<_> = (3..=15)
            .map(|id| {
                serde_json::to_value(store::load_manuscript(&conn, id).unwrap().unwrap()).unwrap()
            })
            .collect();
        let result = redistribute_unsent(&mut conn, true).unwrap();
        assert_eq!(
            result.iter().map(|r| r.manuscript_id).collect::<Vec<_>>(),
            [1, 2]
        );
        let after: Vec<_> = (3..=15)
            .map(|id| {
                serde_json::to_value(store::load_manuscript(&conn, id).unwrap().unwrap()).unwrap()
            })
            .collect();
        assert_eq!(protected, after);
    }

    #[test]
    fn selection_respects_type_rejection_invalid_address_sender_blocks_and_platform() {
        let mut conn = fixture();
        crate::editor_blocks::record(
            &conn,
            "sender@example.com",
            "new@example.com",
            "550 The sender is blacklisted by the recipient",
            "2026-01-01",
        )
        .unwrap();
        let selected = redistribute_unsent(&mut conn, false).unwrap();
        assert_eq!(mailbox(&selected[0].after[0]), "other@example.com");
        conn.execute(
            "UPDATE editors SET rejected_types='[\"悬疑\"]' WHERE id=3",
            [],
        )
        .unwrap();
        let selected = redistribute_unsent(&mut conn, false).unwrap();
        assert_eq!(mailbox(&selected[0].after[0]), "old@example.com");
        conn.execute("UPDATE editors SET enabled=0 WHERE id=1", [])
            .unwrap();
        let selected = redistribute_unsent(&mut conn, false).unwrap();
        assert_eq!(
            selected[0].after,
            ["old@example.com"],
            "no peer must preserve the roster, not cross platform or silently shrink it"
        );
        assert_eq!(selected[0].no_compatible_peer, ["平台"]);
    }
}
