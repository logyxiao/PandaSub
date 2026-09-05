use std::collections::BTreeMap;

use tauri::State;

use crate::models::{StatsGroup, StatsReport};
use crate::state::AppState;

// ---------- Stats ----------

/// 统计模块：按 日 / 周 / 月 分组统计投递次数、人工回复、失败、过稿。
///
/// - 投递次数：deliveries（每封发出的邮件）
/// - 人工回复：replies.kind = 'human'
/// - 失败：task_logs.level = 'error'（send / network 分类）
/// - 过稿：replies.accepted = 1
#[tauri::command]
pub async fn get_stats(
    state: State<'_, AppState>,
    start: Option<String>,
    end: Option<String>,
    group: Option<String>,
) -> Result<StatsReport, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        load_stats(&conn, start, end, group)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn load_stats(
    conn: &rusqlite::Connection,
    start: Option<String>,
    end: Option<String>,
    group: Option<String>,
) -> Result<StatsReport, String> {
    let group = group.unwrap_or_else(|| "day".into());
    if !matches!(group.as_str(), "day" | "week" | "month") {
        return Err("统计粒度应为 day、week 或 month".into());
    }
    let (start, end_exclusive) = normalize_range(start, end)?;

    let key = |col: &str| -> String {
        match group.as_str() {
            // SQLite's %W emits a locale-style week 00. Use the Thursday of
            // the ISO week to derive both the ISO year and week number.
            "week" => format!(
                "strftime('%Y', date({col}, '-3 days', 'weekday 4')) || '-W' || printf('%02d', (CAST(strftime('%j', date({col}, '-3 days', 'weekday 4')) AS INTEGER) - 1) / 7 + 1)"
            ),
            "month" => format!("strftime('%Y-%m', {col})"),
            _ => format!("date({col})"),
        }
    };
    let range = |col: &str| format!("({col} >= ?1 AND {col} < ?2)");

    // 投递次数
    let mut map: BTreeMap<String, StatsGroup> = BTreeMap::new();
    {
        let col = "sent_at";
        let sql = format!(
            "SELECT {} AS k, COUNT(*) AS c FROM deliveries WHERE {} GROUP BY k",
            key(col),
            range(col),
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&start, &end_exclusive], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (k, c) = row.map_err(|e| e.to_string())?;
            map.entry(k).or_default().deliveries = c;
        }
    }

    // One indexed scan for both reply metrics, retaining their independent counts.
    {
        let col = "received_at";
        let sql = format!(
            "SELECT {} AS k, SUM(CASE WHEN kind = 'human' THEN 1 ELSE 0 END),
                SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) FROM replies
             WHERE (kind = 'human' OR accepted = 1) AND {} GROUP BY k",
            key(col),
            range(col),
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&start, &end_exclusive], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (k, human, accepted) = row.map_err(|e| e.to_string())?;
            let entry = map.entry(k).or_default();
            entry.human_replies = human;
            entry.accepted = accepted;
        }
    }

    // 失败
    {
        let col = "created_at";
        let sql = format!(
            "SELECT {} AS k, COUNT(*) AS c FROM task_logs
             WHERE level = 'error' AND category IN ('send', 'network', 'limit', 'auth')
             AND TRIM(COALESCE(recipient, '')) <> '' AND {} GROUP BY k",
            key(col),
            range(col),
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&start, &end_exclusive], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (k, c) = row.map_err(|e| e.to_string())?;
            map.entry(k).or_default().failures = c;
        }
    }

    let mut totals = StatsGroup::default();
    let mut groups: Vec<StatsGroup> = Vec::with_capacity(map.len());
    for (period, mut g) in map {
        g.period = period;
        totals.deliveries += g.deliveries;
        totals.human_replies += g.human_replies;
        totals.failures += g.failures;
        totals.accepted += g.accepted;
        groups.push(g);
    }
    Ok(StatsReport { groups, totals })
}

/// Canonical local dates, with an exclusive lexical upper bound. Stored timestamps
/// use YYYY-MM-DD HH:MM:SS; fractional seconds on the end date remain included.
fn normalize_range(start: Option<String>, end: Option<String>) -> Result<(String, String), String> {
    let parse = |raw: Option<String>, fallback: &str| -> Result<chrono::NaiveDate, String> {
        let raw = raw.unwrap_or_default();
        let value = if raw.trim().is_empty() {
            fallback
        } else {
            raw.trim()
        };
        let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| "统计日期应为有效的 YYYY-MM-DD 日期".to_string())?;
        if value.len() != 10 || date.format("%Y-%m-%d").to_string() != value {
            return Err("统计日期应为有效的 YYYY-MM-DD 日期".into());
        }
        Ok(date)
    };
    let start = parse(start, "0000-01-01")?;
    let end = parse(end, "9999-12-31")?;
    if start > end {
        return Err("统计开始日期应早于或等于结束日期".into());
    }
    let upper = if end.format("%Y-%m-%d").to_string() == "9999-12-31" {
        // Lexical sentinel, never passed to SQLite date(): avoids year-10000 overflow.
        "9999-12-32".into()
    } else {
        end.succ_opt()
            .ok_or("统计日期超出范围")?
            .format("%Y-%m-%d")
            .to_string()
    };
    Ok((start.format("%Y-%m-%d").to_string(), upper))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_reject_impossible_dates_and_keep_leap_day_and_max_year() {
        for bad in [
            "2026-02-30",
            "2026-02-29",
            "2026-13-01",
            "2026-1-01",
            "not-a-date",
            "1234567890",
        ] {
            assert!(normalize_range(Some(bad.into()), None).is_err(), "{bad}");
        }
        assert_eq!(
            normalize_range(Some(" 2024-02-29 ".into()), Some("2024-02-29".into())).unwrap(),
            ("2024-02-29".into(), "2024-03-01".into())
        );
        assert_eq!(
            normalize_range(None, None).unwrap(),
            ("0000-01-01".into(), "9999-12-32".into())
        );
        assert!(normalize_range(Some("2026-09-06".into()), Some("2026-09-05".into())).is_err());
    }

    fn fixture() -> rusqlite::Connection {
        let conn = crate::db::test_database();
        conn.execute_batch(
            "INSERT INTO deliveries(recipient,message_id,sent_at) VALUES
            ('one@example.com','d1','2020-12-31 23:59:59'),
            ('two@example.com','d2','2021-01-01 00:00:00'),
            ('three@example.com','d3','2021-01-01 23:59:59.999'),
            ('four@example.com','d4','2021-01-02 00:00:00');
            INSERT INTO replies(account_id,imap_uid,kind,accepted,received_at) VALUES
            (1,1,'human',1,'2021-01-01 00:00:00'),
            (1,2,'human',0,'2021-01-01 12:00:00'),
            (1,3,'auto',1,'2021-01-01 23:59:59.999'),
            (1,4,'auto',0,'2021-01-01 10:00:00'),
            (1,5,'human',1,'2021-01-02 00:00:00');
            INSERT INTO task_logs(level,category,message,recipient,created_at) VALUES
            ('error','send','failed','one@example.com','2021-01-01 12:00:00'),
            ('warning','network','retry','one@example.com','2021-01-01 12:00:00'),
            ('error','auth','account fault','','2021-01-01 12:00:00');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn stats_use_inclusive_days_and_independent_reply_metrics() {
        let conn = fixture();
        let report = load_stats(
            &conn,
            Some("2021-01-01".into()),
            Some("2021-01-01".into()),
            None,
        )
        .unwrap();
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].period, "2021-01-01");
        assert_eq!(
            (
                report.totals.deliveries,
                report.totals.human_replies,
                report.totals.accepted,
                report.totals.failures
            ),
            (2, 2, 2, 1)
        );
        let empty = load_stats(&conn, Some("2030-01-01".into()), None, None).unwrap();
        assert!(empty.groups.is_empty());
        assert!(load_stats(&conn, None, None, Some("unknown".into())).is_err());
    }

    #[test]
    fn stats_preserve_iso_week_year_and_month_boundaries() {
        let conn = fixture();
        let weekly = load_stats(&conn, None, None, Some("week".into())).unwrap();
        assert_eq!(weekly.groups.len(), 1);
        assert_eq!(weekly.groups[0].period, "2020-W53");
        assert_eq!(weekly.totals.deliveries, 4);
        let monthly = load_stats(&conn, None, None, Some("month".into())).unwrap();
        assert_eq!(
            monthly
                .groups
                .iter()
                .map(|r| (r.period.as_str(), r.deliveries))
                .collect::<Vec<_>>(),
            [("2020-12", 1), ("2021-01", 3)]
        );
        conn.execute("INSERT INTO deliveries(recipient,message_id,sent_at) VALUES('max@example.com','max','9999-12-31 23:59:59.999')", []).unwrap();
        assert_eq!(
            load_stats(&conn, None, None, None)
                .unwrap()
                .totals
                .deliveries,
            5
        );
    }

    #[test]
    fn date_filters_use_range_indexes_instead_of_scanning_all_history() {
        let conn = fixture();
        for (table, column, predicate, index) in [
            ("deliveries", "sent_at", "1=1", "deliveries_sent_at"),
            (
                "replies",
                "received_at",
                "(kind='human' OR accepted=1)",
                "replies_received_at",
            ),
            (
                "task_logs",
                "created_at",
                "level='error'",
                "task_logs_level_created",
            ),
        ] {
            let plan: String = conn.query_row(&format!("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM {table} WHERE {predicate} AND {column} >= ?1 AND {column} < ?2"), ["2021-01-01", "2021-01-02"], |r| r.get(3)).unwrap();
            assert!(plan.contains("SEARCH") && plan.contains(index), "{plan}");
        }
    }
}
