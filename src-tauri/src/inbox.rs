use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

pub fn start_reply_watcher(app: AppHandle, db: Arc<Mutex<Connection>>, scan_lock: Arc<Mutex<()>>) {
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
            let scan_lock = scan_lock.clone();
            let _ = tokio::task::spawn_blocking(move || scan_all_accounts(&app2, &db2, &scan_lock))
                .await;
            tokio::time::sleep(Duration::from_secs(minutes.saturating_mul(60))).await;
        }
    });
}

fn acquire_scan(lock: &Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    lock.try_lock()
        .map_err(|_| "收件箱检查正在进行，请稍后刷新".into())
}

pub fn scan_all_accounts(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    scan_lock: &Arc<Mutex<()>>,
) -> Result<usize, String> {
    let _guard = acquire_scan(scan_lock)?;
    let mut accounts = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::load_accounts(&conn)?
    };
    static NEXT_ACCOUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    accounts.retain(|account| {
        account.enabled && account.check_replies && !account.imap_host.trim().is_empty()
    });
    if !accounts.is_empty() {
        let offset =
            NEXT_ACCOUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % accounts.len();
        accounts.rotate_left(offset);
    }
    let round_deadline = Instant::now() + Duration::from_secs(120);
    let mut total = 0usize;
    let mut failures = Vec::new();
    for account in accounts {
        if !account.enabled || !account.check_replies || account.imap_host.trim().is_empty() {
            continue;
        }
        if Instant::now() >= round_deadline {
            failures.push("本轮收件扫描已达 120 秒，将在后续扫描继续".into());
            break;
        }
        match scan_one_account(app, db, &account, round_deadline) {
            Ok(n) => total += n,
            Err(e) => {
                failures.push(format!("{}：{e}", account.email));
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
    if !failures.is_empty() {
        return Err(format!(
            "已保存 {total} 封新回复；部分邮箱检查失败：{}",
            failures.join("；")
        ));
    }
    Ok(total)
}

fn scan_one_account(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    account: &Account,
    round_deadline: Instant,
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
    let fetched = fetch_mail(account, needs_backfill, round_deadline)?;
    if let Some(warning) = &fetched.warning {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let log = store::insert_log(&conn, None, Some(account.id), "warning", "reply", warning)?;
        let _ = app.emit("log", &log);
    }
    if !fetched.skipped.is_empty() {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let log = store::insert_log(&conn, None, Some(account.id), "warning", "reply",
            &format!("收件扫描跳过 {} 封超过 2 MiB 的邮件（UID: {:?}），请在邮箱客户端查看；其余邮件继续扫描", fetched.skipped.len(), fetched.skipped))?;
        let _ = app.emit("log", &log);
    }
    let validity = fetched.validity;
    // First upgrade: adopt the server namespace for legacy rows, without losing history.
    if account.imap_uid_validity == 0 && account.imap_uid > 0 {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE replies SET imap_uid_validity = ?1 WHERE account_id = ?2 AND imap_generation = ?3 AND imap_uid_validity = 0",
            rusqlite::params![validity, account.id, account.imap_generation]).map_err(|e| e.to_string())?;
    }
    let deliveries = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::load_account_deliveries(&conn, account.id)?
    };
    let delivery_index = DeliveryIndex::new(&deliveries, account.id);
    let mut saved = 0usize;
    let mut max_uid = fetched.scanned_through;
    for mail in fetched.mails {
        max_uid = max_uid.max(mail.uid as i64);
        let exists = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::reply_exists(&conn, account, mail.uid as i64, validity, &mail.message_id)?
        };
        if exists {
            continue;
        }
        let Some(delivery) = delivery_index.find(&mail) else {
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
                validity,
                account.imap_generation,
                &mail.received_at,
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
        store::set_account_imap_cursor(&conn, account.id, max_uid, validity)?;
        if needs_backfill {
            store::mark_setting(&conn, &backfill_key)?;
        }
    }
    Ok(saved)
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MAILS_PER_SCAN: usize = 200;

struct FetchedBatch {
    mails: Vec<FetchedMail>,
    validity: i64,
    scanned_through: i64,
    skipped: Vec<u32>,
    warning: Option<String>,
}

fn mailbox_cursor(account: &Account, validity: i64, backfill: bool) -> (i64, bool) {
    let reset = account.imap_uid_validity != validity;
    let backfill = backfill || reset;
    (if backfill { 0 } else { account.imap_uid }, backfill)
}

const MAX_MAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_BODY_BYTES_PER_SCAN: usize = 8 * 1024 * 1024;

/// Limits the underlying transport on EVERY read/write, including TLS handshake
/// and servers that keep trickling bytes below the idle timeout.
#[derive(Debug)]
struct BudgetStream {
    stream: TcpStream,
    deadline: Instant,
    io_timeout: Duration,
    remaining: usize,
}
impl BudgetStream {
    fn timeout(&self) -> io::Result<Duration> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "收件扫描总时限已到",
            ));
        }
        Ok(remaining.min(self.io_timeout))
    }
}
impl Read for BudgetStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.timeout()?))?;
        if buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return Err(io::Error::other("收件扫描已达 32 MiB 网络预算"));
        }
        let len = buf.len().min(self.remaining);
        let read = self.stream.read(&mut buf[..len])?;
        self.remaining -= read;
        Ok(read)
    }
}
impl Write for BudgetStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.timeout()?))?;
        self.stream.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.timeout()?;
        self.stream.flush()
    }
}

#[cfg(test)]
fn connect_imap_with_timeout(
    host: &str,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Result<imap::Client<native_tls::TlsStream<BudgetStream>>, String> {
    connect_imap_bounded(
        host,
        port,
        connect_timeout,
        io_timeout,
        Instant::now() + Duration::from_secs(60),
    )
}

fn connect_imap_bounded(
    host: &str,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
    deadline: Instant,
) -> Result<imap::Client<native_tls::TlsStream<BudgetStream>>, String> {
    let address = (host.to_owned(), port);
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = send.send(
            address
                .to_socket_addrs()
                .map(|items| items.collect::<Vec<_>>()),
        );
    });
    let addresses = recv
        .recv_timeout(connect_timeout.min(deadline.saturating_duration_since(Instant::now())))
        .map_err(|_| "解析收件服务器超时")?
        .map_err(|e| e.to_string())?;
    let connect_deadline = deadline.min(Instant::now() + connect_timeout);
    let mut last_error = "收件服务器没有可连接的地址".to_string();
    for address in addresses {
        let remaining = connect_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => {
                let stream = BudgetStream {
                    stream,
                    deadline,
                    io_timeout,
                    remaining: 32 * 1024 * 1024,
                };
                let tls = native_tls::TlsConnector::builder()
                    .build()
                    .map_err(|e| e.to_string())?;
                let stream = tls.connect(host, stream).map_err(|e| e.to_string())?;
                let mut client = imap::Client::new(stream);
                client.read_greeting().map_err(|e| e.to_string())?;
                return Ok(client);
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(last_error)
}

fn fetch_mail(
    account: &Account,
    include_recent_backfill: bool,
    round_deadline: Instant,
) -> Result<FetchedBatch, String> {
    let deadline = round_deadline.min(Instant::now() + Duration::from_secs(60));
    let client = connect_imap_bounded(
        &account.imap_host,
        account.imap_port,
        CONNECT_TIMEOUT,
        IO_TIMEOUT,
        deadline,
    )?;
    let session = client
        .login(&account.email, &account.password)
        .map_err(|e| e.0.to_string())?;
    fetch_mail_session(session, account, include_recent_backfill, deadline)
}

fn fetch_mail_session<S: Read + Write>(
    mut session: imap::Session<S>,
    account: &Account,
    include_recent_backfill: bool,
    deadline: Instant,
) -> Result<FetchedBatch, String> {
    let mailbox = session.select("INBOX").map_err(|e| e.to_string())?;
    let validity = mailbox.uid_validity.ok_or("服务器未返回 UIDVALIDITY")? as i64;
    let (cursor_start, include_recent_backfill) =
        mailbox_cursor(account, validity, include_recent_backfill);

    let query = if include_recent_backfill {
        let since = chrono_since_days(AUTO_REPLY_BACKFILL_DAYS);
        format!("SINCE {since}")
    } else if cursor_start > 0 {
        format!("UID {}:*", cursor_start + 1)
    } else {
        let since = chrono_since_days(14);
        format!("SINCE {since}")
    };
    let uids = session.uid_search(query).map_err(|e| e.to_string())?;
    let mut uid_list: Vec<u32> = uids
        .into_iter()
        .filter(|u| include_recent_backfill || (*u as i64) > cursor_start)
        .collect();
    uid_list.sort_unstable();
    uid_list.truncate(MAX_MAILS_PER_SCAN);
    if uid_list.is_empty() {
        let _ = session.logout();
        return Ok(FetchedBatch {
            mails: Vec::new(),
            validity,
            scanned_through: cursor_start,
            skipped: Vec::new(),
            warning: None,
        });
    }
    let mut out = Vec::new();
    let mut skipped = Vec::new();
    let mut scanned_through = cursor_start;
    let mut body_bytes = 0usize;
    let mut warning = None;
    for uid in uid_list {
        if Instant::now() >= deadline {
            warning = Some("收件扫描时限已到，已完成的邮件将保存，下次继续".into());
            break;
        }
        let step = fetch_one_mail(&mut session, uid, body_bytes);
        match step {
            Ok(MailStep::Skipped) => skipped.push(uid),
            Ok(MailStep::Missing) => {}
            Ok(MailStep::Deferred) => break,
            Ok(MailStep::Mail(mail, bytes)) => {
                out.push(*mail);
                body_bytes += bytes;
            }
            Err(error) if scanned_through > cursor_start => {
                warning = Some(format!(
                    "扫描在 UID {uid} 中断，已完成部分将保存，下次从此处继续：{}",
                    error.chars().take(500).collect::<String>()
                ));
                break;
            }
            Err(error) => return Err(error),
        }
        scanned_through = scanned_through.max(uid as i64);
    }
    let _ = session.logout();
    Ok(FetchedBatch {
        mails: out,
        validity,
        scanned_through,
        skipped,
        warning,
    })
}

enum MailStep {
    Skipped,
    Missing,
    Deferred,
    Mail(Box<FetchedMail>, usize),
}

fn fetch_one_mail<S: Read + Write>(
    session: &mut imap::Session<S>,
    uid: u32,
    body_bytes: usize,
) -> Result<MailStep, String> {
    // Metadata first: a large attachment is never downloaded just to measure it.
    let sizes = session
        .uid_fetch(uid.to_string(), "(RFC822.SIZE)")
        .map_err(|e| e.to_string())?;
    let Some(meta) = sizes.iter().find(|f| f.uid == Some(uid)) else {
        return if sizes.is_empty() {
            Ok(MailStep::Missing)
        } else {
            Err("收件服务器返回的邮件 UID 不匹配".into())
        };
    };
    let size = meta.size.ok_or("收件服务器未返回邮件大小")? as usize;
    if size > MAX_MAIL_BYTES {
        return Ok(MailStep::Skipped);
    }
    if body_bytes.saturating_add(size) > MAX_BODY_BYTES_PER_SCAN {
        return Ok(MailStep::Deferred);
    }
    let fetches = session
        .uid_fetch(uid.to_string(), "(INTERNALDATE BODY.PEEK[])")
        .map_err(|e| e.to_string())?;
    let Some(fetch) = fetches.iter().find(|f| f.uid == Some(uid)) else {
        return if fetches.is_empty() {
            Ok(MailStep::Missing)
        } else {
            Err("收件服务器返回的正文 UID 不匹配".into())
        };
    };
    let bytes = fetch.body().ok_or("收件服务器未返回邮件正文")?;
    if bytes.len() > MAX_MAIL_BYTES
        || body_bytes.saturating_add(bytes.len()) > MAX_BODY_BYTES_PER_SCAN
    {
        return Err("收件服务器返回的邮件大小超过预算".into());
    }
    let received_at = fetch
        .internal_date()
        .map(|value| {
            value
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_default();
    Ok(MailStep::Mail(
        Box::new(parse_message(uid, bytes, received_at)),
        bytes.len(),
    ))
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

struct DeliveryIndex<'a> {
    by_id: std::collections::HashMap<String, &'a Delivery>,
    by_subject: std::collections::HashMap<(String, String), Vec<&'a Delivery>>,
}

impl<'a> DeliveryIndex<'a> {
    fn new(deliveries: &'a [Delivery], account_id: i64) -> Self {
        let mut index = Self {
            by_id: Default::default(),
            by_subject: Default::default(),
        };
        for delivery in deliveries
            .iter()
            .filter(|d| d.account_id == Some(account_id))
        {
            let id = normalize_id(&delivery.message_id);
            if !id.is_empty() {
                index.by_id.entry(id).or_insert(delivery);
            }
            let subject = normalize_subject(&delivery.subject);
            if !subject.is_empty() {
                index
                    .by_subject
                    .entry((delivery.recipient.trim().to_lowercase(), subject))
                    .or_default()
                    .push(delivery);
            }
        }
        index
    }

    fn find(&self, mail: &FetchedMail) -> Option<&'a Delivery> {
        // Match complete IDs, not substrings; headers may contain an entire thread.
        if let Some(delivery) = mail
            .in_reply_to
            .split_whitespace()
            .chain(mail.references.split_whitespace())
            .filter_map(|id| self.by_id.get(&normalize_id(id)).copied())
            .max_by_key(|d| d.id)
        {
            return Some(delivery);
        }
        let key = (
            mail.from.trim().to_lowercase(),
            normalize_subject(&mail.subject),
        );
        let candidates = self.by_subject.get(&key)?;
        if mail.received_at.is_empty() {
            return if candidates.len() == 1 {
                candidates.first().copied()
            } else {
                None
            };
        }
        candidates
            .iter()
            .copied()
            .filter(|d| d.sent_at.as_str() <= mail.received_at.as_str())
            .max_by_key(|d| d.id)
    }
}

#[cfg(test)]
fn match_delivery<'a>(
    mail: &FetchedMail,
    deliveries: &'a [Delivery],
    account_id: i64,
) -> Option<&'a Delivery> {
    DeliveryIndex::new(deliveries, account_id).find(mail)
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
    fn cursor_account(uid: i64, validity: i64) -> Account {
        Account {
            id: 1,
            email: "fixture@example.com".into(),
            password: String::new(),
            smtp_host: String::new(),
            smtp_port: 465,
            sender_name: String::new(),
            provider: String::new(),
            enabled: true,
            last_sent_at: None,
            imap_host: "localhost".into(),
            imap_port: 993,
            check_replies: true,
            imap_uid: uid,
            imap_uid_validity: validity,
            imap_generation: 0,
            created_at: String::new(),
            sent_today: 0,
        }
    }

    #[test]
    fn uidvalidity_change_resets_cursor_and_backfills() {
        let account = cursor_account(900, 10);
        assert_eq!(mailbox_cursor(&account, 10, false), (900, false));
        assert_eq!(mailbox_cursor(&account, 11, false), (0, true));
        assert_eq!(mailbox_cursor(&account, 10, true), (0, true));
        assert_eq!(
            mailbox_cursor(&cursor_account(900, 0), 10, false),
            (0, true)
        );
    }

    #[test]
    fn automatic_and_manual_scans_share_one_gate() {
        let gate = Mutex::new(());
        let guard = acquire_scan(&gate).unwrap();
        assert!(acquire_scan(&gate).is_err());
        drop(guard);
        assert!(acquire_scan(&gate).is_ok());
    }

    #[test]
    fn stalled_tls_peer_hits_io_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, receiver) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            let _ = receiver.recv_timeout(Duration::from_secs(3));
        });
        let start = Instant::now();
        let result = connect_imap_with_timeout(
            "127.0.0.1",
            port,
            Duration::from_secs(1),
            Duration::from_millis(80),
        );
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        let _ = stop.send(());
        server.join().unwrap();
    }
    #[test]
    fn indexed_matching_uses_complete_message_ids() {
        let mut original = delivery(1, "editor@example.com", "original subject");
        original.message_id = "<message@example.com>".into();
        let deliveries = vec![original];
        let index = DeliveryIndex::new(&deliveries, 1);
        let mut incoming = reply("editor@example.com", "unrelated subject");
        incoming.in_reply_to = "<prefix-message@example.com>".into();
        assert!(index.find(&incoming).is_none());
        incoming.in_reply_to = "<message@example.com>".into();
        assert_eq!(index.find(&incoming).map(|d| d.id), Some(1));
        assert!(DeliveryIndex::new(&deliveries, 2).find(&incoming).is_none());
    }

    #[test]
    fn subject_match_does_not_link_a_future_submission() {
        let deliveries = vec![delivery(2, "editor@example.com", "same subject")];
        let mut incoming = reply("editor@example.com", "Re: same subject");
        incoming.received_at = "2026-08-01 10:00:00".into();
        assert!(match_delivery(&incoming, &deliveries, 1).is_none());
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn continuous_trickle_still_hits_absolute_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..100 {
                if server.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let started = Instant::now();
        let mut stream = BudgetStream {
            stream: client,
            deadline: started + Duration::from_millis(120),
            io_timeout: Duration::from_secs(1),
            remaining: 1024,
        };
        let mut received = Vec::new();
        assert!(stream.read_to_end(&mut received).is_err());
        assert!(!received.is_empty());
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(stream);
        writer.join().unwrap();
    }

    #[test]
    fn transport_budget_stops_even_a_server_that_ignores_size_limits() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server.write_all(&[1; 64]).unwrap();
        let mut stream = BudgetStream {
            stream: client,
            deadline: Instant::now() + Duration::from_secs(1),
            io_timeout: Duration::from_secs(1),
            remaining: 32,
        };
        let mut data = Vec::new();
        assert!(stream.read_to_end(&mut data).is_err());
        assert_eq!(data.len(), 32);
    }

    struct Transcript {
        input: std::io::Cursor<Vec<u8>>,
        commands: Arc<Mutex<Vec<u8>>>,
    }
    impl Read for Transcript {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.input.read(bytes)
        }
    }
    impl Write for Transcript {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.commands.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn oversized_mail_is_skipped_before_body_fetch_without_blocking_following_mail() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'fixture@example.com','','localhost')",[]).unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        let mail =
            "From: editor@example.com\r\nSubject: reply\r\nMessage-ID: <fixture>\r\n\r\nhello";
        let responses = format!("* OK fixture\r\na1 OK login\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 1 2\r\na3 OK search\r\n* 1 FETCH (UID 1 RFC822.SIZE {})\r\na4 OK size\r\n* 2 FETCH (UID 2 RFC822.SIZE {})\r\na5 OK size\r\n* 2 FETCH (UID 2 INTERNALDATE \"01-Jan-2026 12:00:00 +0000\" BODY[] {{{}}}\r\n{})\r\na6 OK body\r\n* BYE fixture\r\na7 OK logout\r\n",
            MAX_MAIL_BYTES+1,mail.len(),mail.len(),mail);
        let commands = Arc::new(Mutex::new(Vec::new()));
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(responses.into_bytes()),
            commands: commands.clone(),
        });
        client.read_greeting().unwrap();
        let session = client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap();
        let batch = fetch_mail_session(
            session,
            &account,
            true,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(batch.skipped, vec![1]);
        assert_eq!(batch.scanned_through, 2);
        assert_eq!(batch.mails.len(), 1);
        assert_eq!(batch.mails[0].uid, 2);
        let commands = String::from_utf8(commands.lock().unwrap().clone()).unwrap();
        assert!(!commands.contains("UID FETCH 1 (INTERNALDATE BODY.PEEK[])"));
        assert!(commands.contains("UID FETCH 2 (INTERNALDATE BODY.PEEK[])"));
    }
    #[test]
    fn body_budget_defers_next_mail_before_fetching_or_advancing_its_uid() {
        let commands = Arc::new(Mutex::new(Vec::new()));
        let input =
            b"* OK fixture\r\na1 OK login\r\n* 1 FETCH (UID 9 RFC822.SIZE 100)\r\na2 OK size\r\n"
                .to_vec();
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(input),
            commands: commands.clone(),
        });
        client.read_greeting().unwrap();
        let mut session = client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap();
        let step = fetch_one_mail(&mut session, 9, MAX_BODY_BYTES_PER_SCAN - 99).unwrap();
        assert!(matches!(step, MailStep::Deferred));
        let commands = String::from_utf8(commands.lock().unwrap().clone()).unwrap();
        assert!(!commands.contains("BODY.PEEK"));
    }

    #[test]
    fn interrupted_scan_keeps_complete_prefix_and_does_not_advance_failed_uid() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'fixture@example.com','','localhost')",[]).unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        let responses = format!("* OK fixture\r\na1 OK login\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 1 2\r\na3 OK search\r\n* 1 FETCH (UID 1 RFC822.SIZE {})\r\na4 OK size\r\n",MAX_MAIL_BYTES+1);
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(responses.into_bytes()),
            commands: Arc::new(Mutex::new(Vec::new())),
        });
        client.read_greeting().unwrap();
        let session = client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap();
        let batch = fetch_mail_session(
            session,
            &account,
            true,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(batch.scanned_through, 1);
        assert_eq!(batch.skipped, vec![1]);
        assert!(batch.warning.unwrap().contains("UID 2"));
    }
}
