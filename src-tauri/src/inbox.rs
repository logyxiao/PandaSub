use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::classify::{self, IncomingMail};
use crate::models::{Account, Delivery};
use crate::store;

#[derive(Debug, Clone)]
pub struct FetchedMail {
    pub uid: u32,
    pub from: String,
    pub subject: String,
    pub body: String,
    pub message_id: String,
    pub in_reply_to: String,
    pub references: String,
    pub content_type: String,
    pub extra_headers: Vec<(String, String)>,
    /// IMAP 服务器记录的收件时间，本地格式用于在重复主题中选择最近一次先发出的投稿。
    pub received_at: String,
}

const AUTO_REPLY_BACKFILL_DAYS: i64 = 14;
const AUTO_REPLY_BACKFILL_VERSION: &str = "v1";

pub fn start_reply_watcher(app: AppHandle, db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(25)).await;
        loop {
            let minutes = {
                let conn = db.lock().unwrap();
                store::load_settings(&conn)
                    .map(|s| s.reply_poll_minutes.max(1) as u64)
                    .unwrap_or(2)
            };
            let app2 = app.clone();
            let db2 = db.clone();
            let _ = tokio::task::spawn_blocking(move || scan_all_accounts(&app2, &db2)).await;
            tokio::time::sleep(Duration::from_secs(minutes.saturating_mul(60))).await;
        }
    });
}

pub fn scan_all_accounts(app: &AppHandle, db: &Arc<Mutex<Connection>>) -> Result<usize, String> {
    let accounts = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::load_accounts(&conn)?
    };
    let mut total = 0usize;
    for account in accounts {
        if !account.enabled || !account.check_replies || account.imap_host.trim().is_empty() {
            continue;
        }
        match scan_one_account(app, db, &account) {
            Ok(n) => total += n,
            Err(e) => {
                let log = {
                    let conn = db.lock().map_err(|e| e.to_string())?;
                    store::insert_log(
                        &conn,
                        None,
                        Some(account.id),
                        "warning",
                        "reply",
                        &format!("检查回复失败（{}）：{}", account.email, e),
                    )
                };
                if let Ok(log) = log {
                    let _ = app.emit("log", &log);
                }
            }
        }
    }
    Ok(total)
}

fn scan_one_account(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    account: &Account,
) -> Result<usize, String> {
    let backfill_key = format!(
        "replies.autoreply_match_backfill.{AUTO_REPLY_BACKFILL_VERSION}.{}",
        account.id
    );
    let needs_backfill = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        !store::setting_exists(&conn, &backfill_key)?
    };
    // 此版本首次运行时回看近 14 天，补回旧匹配规则已经推进 UID、却未保存的自动回复。
    let fetched = fetch_mail(account, needs_backfill)?;
    if fetched.is_empty() {
        if needs_backfill {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::mark_setting(&conn, &backfill_key)?;
        }
        return Ok(0);
    }
    let deliveries = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::load_recent_deliveries(&conn, 90)?
    };
    let mut saved = 0usize;
    let mut max_uid = account.imap_uid;
    for mail in fetched {
        max_uid = max_uid.max(mail.uid as i64);
        let exists = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::reply_exists(&conn, account.id, mail.uid as i64)?
        };
        if exists {
            continue;
        }
        let Some(delivery) = match_delivery(&mail, &deliveries, account.id) else {
            continue;
        };
        let classification = classify::classify(&IncomingMail {
            from: mail.from.clone(),
            subject: mail.subject.clone(),
            body: mail.body.clone(),
            content_type: mail.content_type.clone(),
            extra_headers: mail.extra_headers.clone(),
        });
        let snippet: String = mail.body.chars().take(180).collect();
        let accepted = classification.kind == classify::ReplyKind::Human
            && classify::body_suggests_accepted(&mail.body);
        let reply = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::insert_reply(
                &conn,
                Some(delivery.id),
                account.id,
                delivery.task_id,
                &mail.from,
                &mail.subject,
                &snippet,
                &mail.body,
                classification.kind.as_str(),
                &classification.reason,
                accepted,
                &mail.message_id,
                &mail.in_reply_to,
                mail.uid as i64,
            )?
        };
        saved += 1;
        let _ = app.emit("reply", &reply);
        let kind_label = match classification.kind.as_str() {
            "human" => "人工回复",
            "bounce" => "退信",
            _ => "自动回复",
        };
        let log = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::insert_log(
                &conn,
                delivery.task_id,
                Some(account.id),
                if classification.kind.as_str() == "human" {
                    "success"
                } else if classification.kind.as_str() == "bounce" {
                    "error"
                } else {
                    "info"
                },
                "reply",
                &format!("{kind_label} ← {} · {}", mail.from, mail.subject),
            )
        };
        if let Ok(log) = log {
            let _ = app.emit("log", &log);
        }
    }
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::set_account_imap_uid(&conn, account.id, max_uid)?;
        if needs_backfill {
            store::mark_setting(&conn, &backfill_key)?;
        }
    }
    Ok(saved)
}

fn fetch_mail(
    account: &Account,
    include_recent_backfill: bool,
) -> Result<Vec<FetchedMail>, String> {
    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let client = imap::connect(
        (account.imap_host.as_str(), account.imap_port),
        account.imap_host.as_str(),
        &tls,
    )
    .map_err(|e| e.to_string())?;
    let mut session = client
        .login(&account.email, &account.password)
        .map_err(|e| e.0.to_string())?;
    session.select("INBOX").map_err(|e| e.to_string())?;

    let query = if include_recent_backfill {
        let since = chrono_since_days(AUTO_REPLY_BACKFILL_DAYS);
        format!("SINCE {since}")
    } else if account.imap_uid > 0 {
        format!("UID {}:*", account.imap_uid + 1)
    } else {
        let since = chrono_since_days(14);
        format!("SINCE {since}")
    };
    let uids = session.uid_search(query).map_err(|e| e.to_string())?;
    let mut uid_list: Vec<u32> = uids
        .into_iter()
        .filter(|u| include_recent_backfill || (*u as i64) > account.imap_uid)
        .collect();
    uid_list.sort_unstable();
    if uid_list.is_empty() {
        let _ = session.logout();
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for batch in uid_list.chunks(80) {
        let set = batch
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let fetches = session
            .uid_fetch(&set, "(INTERNALDATE BODY.PEEK[])")
            .map_err(|e| e.to_string())?;
        for fetch in fetches.iter() {
            let Some(uid) = fetch.uid else { continue };
            let Some(bytes) = fetch.body() else { continue };
            let received_at = fetch
                .internal_date()
                .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default();
            out.push(parse_message(uid, bytes, received_at));
        }
    }
    let _ = session.logout();
    Ok(out)
}

fn chrono_since_days(days: i64) -> String {
    let secs = days.saturating_mul(86400);
    let t = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(secs as u64))
        .unwrap_or(std::time::UNIX_EPOCH);
    let dur = t
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // Approximate civil date from unix days; good enough for IMAP SINCE.
    let days_total = (dur / 86400) as i64;
    let mut y = 1970i64;
    let mut remain = days_total;
    loop {
        let len = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if remain < len {
            break;
        }
        remain -= len;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let mdays = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0usize;
    while month < 12 && remain >= mdays[month] {
        remain -= mdays[month];
        month += 1;
    }
    format!("{:02}-{}-{y}", remain + 1, MONTHS[month.min(11)])
}

fn parse_message(uid: u32, raw: &[u8], received_at: String) -> FetchedMail {
    if let Some(parsed) = mail_parser::MessageParser::default().parse(raw) {
        let extra = collect_auto_headers(&parsed);
        return FetchedMail {
            uid,
            from: first_address(parsed.from()),
            subject: parsed.subject().unwrap_or("").to_string(),
            body: parsed
                .body_text(0)
                .map(|s| s.into_owned())
                .unwrap_or_else(|| {
                    parsed
                        .body_html(0)
                        .map(|s| strip_tags(s.into_owned()))
                        .unwrap_or_default()
                }),
            message_id: parsed.message_id().unwrap_or("").to_string(),
            in_reply_to: header_ids(parsed.in_reply_to()),
            references: header_ids(parsed.references()),
            content_type: content_type_of(&parsed),
            extra_headers: extra,
            received_at,
        };
    }
    FetchedMail {
        uid,
        from: String::new(),
        subject: String::new(),
        body: String::new(),
        message_id: String::new(),
        in_reply_to: String::new(),
        references: String::new(),
        content_type: String::new(),
        extra_headers: Vec::new(),
        received_at,
    }
}

fn first_address(addr: Option<&mail_parser::Address<'_>>) -> String {
    match addr {
        Some(mail_parser::Address::List(list)) => list
            .first()
            .and_then(|a| a.address.as_ref())
            .map(|s| s.to_string())
            .unwrap_or_default(),
        Some(mail_parser::Address::Group(groups)) => groups
            .first()
            .and_then(|g| g.addresses.first())
            .and_then(|a| a.address.as_ref())
            .map(|s| s.to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

fn header_ids(value: &mail_parser::HeaderValue<'_>) -> String {
    match value {
        mail_parser::HeaderValue::Text(t) => t.to_string(),
        mail_parser::HeaderValue::TextList(list) => list
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join(" "),
        _ => value.as_text().unwrap_or("").to_string(),
    }
}

fn header_text(msg: &mail_parser::Message<'_>, name: &str) -> String {
    msg.header(name)
        .and_then(|v| v.as_text())
        .unwrap_or("")
        .to_string()
}

fn content_type_of(msg: &mail_parser::Message<'_>) -> String {
    match msg.header("Content-Type") {
        Some(mail_parser::HeaderValue::ContentType(ct)) => {
            format!("{}/{}", ct.c_type, ct.c_subtype.as_deref().unwrap_or("*"))
        }
        Some(mail_parser::HeaderValue::Text(t)) => t.to_string(),
        _ => String::new(),
    }
}

fn collect_auto_headers(msg: &mail_parser::Message<'_>) -> Vec<(String, String)> {
    const NAMES: &[&str] = &[
        "X-Autoreply",
        "X-Auto-Reply",
        "X-Autogenerated",
        "X-Auto-Response-Suppress",
        "X-Failed-Recipients",
    ];
    NAMES
        .iter()
        .filter_map(|n| {
            let v = header_text(msg, n);
            if v.is_empty() {
                None
            } else {
                Some(((*n).to_string(), v))
            }
        })
        .collect()
}

fn strip_tags(html: String) -> String {
    let mut out = String::with_capacity(html.len());
    let mut skip = false;
    for ch in html.chars() {
        match ch {
            '<' => skip = true,
            '>' => skip = false,
            _ if !skip => out.push(ch),
            _ => {}
        }
    }
    out
}

fn normalize_id(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_lowercase()
}

fn emails_equal(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn normalize_subject(value: &str) -> String {
    let mut subject = value.trim().to_lowercase();
    // QQ 自动回复会把原主题改成“自动回复: 原主题”，部分服务还会在此前加品牌名。
    // 只在标记出现在主题开头附近时剥离，避免误伤正文标题里偶然出现的同名词。
    const AUTO_MARKERS: &[&str] = &[
        "自动回复:",
        "自动回复：",
        "自動回覆:",
        "自動回覆：",
        "autoreply:",
        "autoreply：",
        "auto-reply:",
        "auto-reply：",
    ];
    if let Some((position, marker)) = AUTO_MARKERS
        .iter()
        .filter_map(|marker| subject.find(marker).map(|position| (position, *marker)))
        .filter(|(position, _)| *position <= 32)
        .min_by_key(|(position, _)| *position)
    {
        subject = subject[position + marker.len()..].trim_start().to_string();
    }
    loop {
        let trimmed = subject.trim_start();
        let prefix = [
            "re:",
            "re：",
            "回复:",
            "回复：",
            "答复:",
            "答复：",
            "fw:",
            "fwd:",
        ]
        .into_iter()
        .find(|prefix| trimmed.starts_with(prefix));
        let Some(prefix) = prefix else { break };
        subject = trimmed[prefix.len()..].trim_start().to_string();
    }
    subject.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn match_delivery<'a>(
    mail: &FetchedMail,
    deliveries: &'a [Delivery],
    account_id: i64,
) -> Option<&'a Delivery> {
    let reply_ids = format!("{} {}", mail.in_reply_to, mail.references);
    let reply_norm = normalize_id(&reply_ids);
    if !reply_norm.is_empty() {
        if let Some(found) = deliveries.iter().find(|d| {
            let id = normalize_id(&d.message_id);
            d.account_id == Some(account_id) && !id.is_empty() && reply_norm.contains(&id)
        }) {
            return Some(found);
        }
    }
    let subject = normalize_subject(&mail.subject);
    if subject.is_empty() {
        return None;
    }
    let mut matches = deliveries.iter().filter(|d| {
        if d.account_id != Some(account_id) {
            return false;
        }
        if !emails_equal(&mail.from, &d.recipient) {
            return false;
        }
        let original = normalize_subject(&d.subject);
        !original.is_empty() && subject == original
    });
    let matched = matches.next()?;
    let Some(second) = matches.next() else {
        return Some(matched);
    };
    if mail.received_at.is_empty() {
        return None;
    }
    // load_recent_deliveries 按 id 倒序；重复主题时选择收件时间之前最近的一次投递。
    std::iter::once(matched)
        .chain(std::iter::once(second))
        .chain(matches)
        .find(|item| item.sent_at.as_str() <= mail.received_at.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delivery(id: i64, recipient: &str, subject: &str) -> Delivery {
        Delivery {
            id,
            task_id: Some(id),
            account_id: Some(1),
            manuscript_id: Some(id),
            recipient: recipient.into(),
            subject: subject.into(),
            message_id: String::new(),
            sent_at: format!("2026-08-{:02} 10:00:00", id),
        }
    }

    fn reply(from: &str, subject: &str) -> FetchedMail {
        FetchedMail {
            uid: 1,
            from: from.into(),
            subject: subject.into(),
            body: String::new(),
            message_id: String::new(),
            in_reply_to: String::new(),
            references: String::new(),
            content_type: String::new(),
            extra_headers: Vec::new(),
            received_at: String::new(),
        }
    }

    #[test]
    fn fallback_match_uses_subject_not_only_re_prefix() {
        let deliveries = vec![
            delivery(2, "editor@example.com", "投稿：《新稿》"),
            delivery(1, "editor@example.com", "投稿：《旧稿》"),
        ];
        let matched = match_delivery(
            &reply("editor@example.com", "Re: 投稿：《旧稿》"),
            &deliveries,
            1,
        );
        assert_eq!(matched.map(|item| item.id), Some(1));
    }

    #[test]
    fn fallback_match_rejects_unrelated_reply() {
        let deliveries = vec![delivery(1, "editor@example.com", "投稿：《旧稿》")];
        assert!(match_delivery(
            &reply("editor@example.com", "Re: 完全无关的主题"),
            &deliveries,
            1,
        )
        .is_none());
    }

    #[test]
    fn fallback_match_rejects_ambiguous_short_subject() {
        let deliveries = vec![delivery(1, "editor@example.com", "投稿：《旧稿》")];
        assert!(match_delivery(&reply("editor@example.com", "Re: 投稿"), &deliveries, 1).is_none());
    }

    #[test]
    fn fallback_match_rejects_multiple_exact_candidates() {
        let deliveries = vec![
            delivery(2, "editor@example.com", "投稿：《同名稿》"),
            delivery(1, "editor@example.com", "投稿：《同名稿》"),
        ];
        assert!(match_delivery(
            &reply("editor@example.com", "Re: 投稿：《同名稿》"),
            &deliveries,
            1,
        )
        .is_none());
    }

    #[test]
    fn fallback_match_strips_automatic_reply_prefix() {
        let deliveries = vec![delivery(1, "editor@example.com", "投稿：《新稿》")];
        let matched = match_delivery(
            &reply("editor@example.com", "自动回复: 投稿：《新稿》"),
            &deliveries,
            1,
        );
        assert_eq!(matched.map(|item| item.id), Some(1));
    }

    #[test]
    fn fallback_match_strips_branded_automatic_reply_prefix() {
        let deliveries = vec![delivery(1, "editor@example.com", "投稿：《新稿》")];
        let matched = match_delivery(
            &reply("editor@example.com", "大江禾禾 AutoReply: 投稿：《新稿》"),
            &deliveries,
            1,
        );
        assert_eq!(matched.map(|item| item.id), Some(1));
    }

    #[test]
    fn duplicate_subject_uses_latest_delivery_before_reply() {
        let deliveries = vec![
            delivery(3, "editor@example.com", "投稿：《同名稿》"),
            delivery(2, "editor@example.com", "投稿：《同名稿》"),
            delivery(1, "editor@example.com", "投稿：《同名稿》"),
        ];
        let mut mail = reply("editor@example.com", "自动回复: 投稿：《同名稿》");
        mail.received_at = "2026-08-02 10:01:00".into();
        let matched = match_delivery(&mail, &deliveries, 1);
        assert_eq!(matched.map(|item| item.id), Some(2));
    }

    #[test]
    fn fallback_match_stays_with_current_sender_account() {
        let mut other_account = delivery(2, "editor@example.com", "投稿：《新稿》");
        other_account.account_id = Some(2);
        let deliveries = vec![
            other_account,
            delivery(1, "editor@example.com", "投稿：《新稿》"),
        ];
        let matched = match_delivery(
            &reply("editor@example.com", "自动回复: 投稿：《新稿》"),
            &deliveries,
            1,
        );
        assert_eq!(matched.map(|item| item.id), Some(1));
    }
}
