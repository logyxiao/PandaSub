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
pub fn get_stats(
    state: State<'_, AppState>,
    start: Option<String>,
    end: Option<String>,
    group: Option<String>,
) -> Result<StatsReport, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let group = group.unwrap_or_else(|| "day".into());
    let (start, end) = normalize_range(&conn, start, end)?;

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
    let range = |col: &str| format!("(date({col}) >= date(?1) AND date({col}) <= date(?2))");

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
            .query_map([&start, &end], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (k, c) = row.map_err(|e| e.to_string())?;
            map.entry(k).or_default().deliveries = c;
        }
    }

    // 人工回复
    {
        let col = "received_at";
        let sql = format!(
            "SELECT {} AS k, COUNT(*) AS c FROM replies WHERE kind = 'human' AND {} GROUP BY k",
            key(col),
            range(col),
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&start, &end], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (k, c) = row.map_err(|e| e.to_string())?;
            map.entry(k).or_default().human_replies = c;
        }
    }

    // 过稿
    {
        let col = "received_at";
        let sql = format!(
            "SELECT {} AS k, COUNT(*) AS c FROM replies WHERE accepted = 1 AND {} GROUP BY k",
            key(col),
            range(col),
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&start, &end], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (k, c) = row.map_err(|e| e.to_string())?;
            map.entry(k).or_default().accepted = c;
        }
    }

    // 失败
    {
        let col = "created_at";
        let sql = format!(
            "SELECT {} AS k, COUNT(*) AS c FROM task_logs
             WHERE level = 'error' AND category IN ('send', 'network') AND {} GROUP BY k",
            key(col),
            range(col),
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&start, &end], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
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

/// 默认范围：全部数据；提供时按 YYYY-MM-DD 归一化。
fn normalize_range(conn: &rusqlite::Connection, start: Option<String>, end: Option<String>) -> Result<(String, String), String> {
    let start = start.unwrap_or_default();
    let end = end.unwrap_or_default();
    let clamp = |v: &str, fallback: &str| -> String {
        if v.trim().is_empty() {
            fallback.to_string()
        } else {
            v.trim().to_string()
        }
    };
    let start = clamp(&start, "0000-01-01");
    let end = clamp(&end, "9999-12-31");
    // 校验格式：能通过 date() 解析且形如 YYYY-MM-DD 即可
    let valid: i64 = conn
        .query_row("SELECT date(?1) IS NOT NULL AND length(?1) = 10", [&start], |r| r.get(0))
        .unwrap_or(0);
    if valid == 0 {
        return Err("统计日期格式应为 YYYY-MM-DD".into());
    }
    let valid: i64 = conn
        .query_row("SELECT date(?1) IS NOT NULL AND length(?1) = 10", [&end], |r| r.get(0))
        .unwrap_or(0);
    if valid == 0 {
        return Err("统计日期格式应为 YYYY-MM-DD".into());
    }
    if start > end {
        return Err("统计开始日期不能晚于结束日期".into());
    }
    Ok((start, end))
}
