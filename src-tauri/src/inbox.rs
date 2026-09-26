use std::collections::HashMap;
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
    pub content: Option<content::ParsedContent>,
    pub uid: u32,
    pub is_read: bool,
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

pub mod content;
mod flags;
mod runtime;
pub use runtime::{scan_all_accounts, start_reply_watcher, InboxStatus, InboxSync};

const AUTO_REPLY_BACKFILL_DAYS: i64 = 14;

#[derive(Default)]
struct ScanReport {
    saved: usize,
    more: bool,
}

fn scan_one_account(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    account: &Account,
    round_deadline: Instant,
    auto_keywords: &[String],
) -> Result<ScanReport, String> {
    let backfill_key = format!(
        "replies.inbox_backfill.v2.{}.{}",
        account.id, account.imap_generation
    );
    let progress: Option<BackfillProgress> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        use rusqlite::OptionalExtension;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                [&backfill_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        value.and_then(|value| serde_json::from_str(&value).ok())
    };
    let fetched = fetch_mail_prioritized(account, progress, round_deadline)?;
    if let Some(warning) = &fetched.warning {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let log = store::insert_log(&conn, None, Some(account.id), "warning", "reply", warning)?;
        let _ = app.emit("log", &log);
    }
    if !fetched.headers_only.is_empty() {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let log = store::insert_log(
            &conn,
            None,
            Some(account.id),
            "warning",
            "reply",
            &format!(
                "已接收 {} 封大邮件的邮件头（UID: {:?}），完整正文和附件请在原邮箱查看",
                fetched.headers_only.len(),
                fetched.headers_only
            ),
        )?;
        let _ = app.emit("log", &log);
    }
    let validity = fetched.validity;
    // First upgrade: adopt the server namespace for legacy rows, without losing history.
    if account.imap_uid_validity == 0 && account.imap_uid > 0 {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE replies SET imap_uid_validity = ?1 WHERE account_id = ?2 AND imap_generation = ?3 AND imap_uid_validity = 0",
            rusqlite::params![validity, account.id, account.imap_generation]).map_err(|e| e.to_string())?;
    }
    let deliveries = if fetched.mails.is_empty() {
        Vec::new()
    } else {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::load_account_deliveries(&conn, account.id)?
    };
    let delivery_index = DeliveryIndex::new(&deliveries, account.id);
    let mut saved = 0usize;
    let mut max_uid = fetched.scanned_through;
    for mail in fetched.mails {
        max_uid = max_uid.max(mail.uid as i64);
        let delivery = delivery_index.find(&mail);
        let reply = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            persist_incoming(&conn, account, &mail, delivery, validity, auto_keywords)?
        };
        let Some(mut reply) = reply else {
            continue;
        };
        saved += 1;
        reply.body.clear(); // Notifications carry summaries; full text is loaded on demand.
        let _ = app.emit("reply", &reply);
        let kind_label = match reply.kind.as_str() {
            "human" => "人工回复",
            "bounce" => "退信",
            _ => "自动回复",
        };
        let log = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            store::insert_log(
                &conn,
                delivery.and_then(|delivery| delivery.task_id),
                Some(account.id),
                if reply.kind == "human" {
                    "success"
                } else if reply.kind == "bounce" {
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
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        store::set_account_imap_cursor(&tx, account.id, max_uid, validity)?;
        if let Some(progress) = &fetched.backfill {
            tx.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)",
                rusqlite::params![
                    backfill_key,
                    serde_json::to_string(progress).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    if round_deadline.saturating_duration_since(Instant::now()) >= Duration::from_secs(45) {
        let pending = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT id FROM replies WHERE account_id=?1 AND imap_generation=?2 AND imap_uid_validity=?3 AND imap_uid>0 AND kind IN ('auto','human') AND read_synced=0 ORDER BY id LIMIT 100").map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(
                    rusqlite::params![account.id, account.imap_generation, validity],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if !pending.is_empty() {
            let synced = sync_reply_flags(db, pending)?;
            if !synced.states.is_empty() {
                let _ = app.emit("reply-read-change", ());
            }
            if let Some(error) = synced.errors.first() {
                return Err(format!("同步邮箱已读状态失败：{}：{}", error.email, error.message));
            }
        }
    }
    let _ = app.emit("reply-read-change", ());
    Ok(ScanReport {
        saved,
        more: fetched.has_more,
    })
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MAILS_PER_SCAN: usize = 200;

struct FetchedBatch {
    mails: Vec<FetchedMail>,
    validity: i64,
    scanned_through: i64,
    headers_only: Vec<u32>,
    warning: Option<String>,
    has_more: bool,
    backfill: Option<BackfillProgress>,
}

#[cfg(test)]
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
    let stream = connect_tls_bounded(host, port, connect_timeout, io_timeout, deadline)?;
    let mut client = imap::Client::new(stream);
    client.read_greeting().map_err(|e| e.to_string())?;
    Ok(client)
}

fn connect_tls_bounded(
    host: &str,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
    deadline: Instant,
) -> Result<native_tls::TlsStream<BudgetStream>, String> {
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
                return Ok(stream);
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(last_error)
}

fn open_read_state_session(
    account: &Account,
    expected_validity: i64,
) -> Result<imap::Session<native_tls::TlsStream<BudgetStream>>, String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    let client = connect_imap_bounded(
        &account.imap_host,
        account.imap_port,
        CONNECT_TIMEOUT,
        IO_TIMEOUT,
        deadline,
    )?;
    let mut session = client
        .login(&account.email, &account.password)
        .map_err(|e| e.0.to_string())?;
    let mailbox = session.select("INBOX").map_err(|e| e.to_string())?;
    if mailbox.uid_validity.map(i64::from) != Some(expected_validity) {
        let _ = session.logout();
        return Err("邮箱邮件编号已变化，请先检查收件箱以重新同步".into());
    }
    Ok(session)
}

/// Query only IMAP FLAGS; reading metadata must not set the server's Seen flag.
fn fetch_seen_flags_with_auto_read(
    account: &Account,
    expected_validity: i64,
    uids: &[u32],
    auto_uids: &[u32],
) -> Result<HashMap<u32, bool>, String> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }
    flags::with_session(account, expected_validity, |session| {
        let mut states = fetch_seen_flags_session(session, uids)?;
        mark_auto_seen_session(session, &mut states, auto_uids);
        Ok(states)
    })
}

fn mark_auto_seen_session<S: Read + Write>(
    session: &mut imap::Session<S>,
    states: &mut HashMap<u32, bool>,
    auto_uids: &[u32],
) {
    let pending: Vec<u32> = auto_uids
        .iter()
        .copied()
        .filter(|uid| states.get(uid) == Some(&false))
        .collect();
    if pending.is_empty() {
        return;
    }
    let uid_set = pending
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    // Only automatic replies get Seen. A failed STORE stays pending for the next scan.
    if session.uid_store(uid_set, "+FLAGS (\\Seen)").is_ok() {
        if let Ok(confirmed) = fetch_seen_flags_session(session, &pending) {
            states.extend(confirmed);
        }
    }
}

fn fetch_seen_flags_session<S: Read + Write>(
    session: &mut imap::Session<S>,
    uids: &[u32],
) -> Result<HashMap<u32, bool>, String> {
    let uid_set = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let fetches = session
        .uid_fetch(uid_set, "(UID FLAGS)")
        .map_err(|e| e.to_string())?;
    Ok(fetches
        .iter()
        .filter_map(|fetch| {
            fetch.uid.map(|uid| {
                (
                    uid,
                    fetch
                        .flags()
                        .iter()
                        .any(|flag| matches!(flag, imap::types::Flag::Seen)),
                )
            })
        })
        .collect())
}

pub fn store_seen_flag(
    account: &Account,
    expected_validity: i64,
    uid: u32,
    is_read: bool,
) -> Result<bool, String> {
    flags::with_session(account, expected_validity, |session| store_seen_flag_session(session, uid, is_read))
}

fn store_seen_flag_session<S: Read + Write>(
    session: &mut imap::Session<S>,
    uid: u32,
    is_read: bool,
) -> Result<bool, String> {
    let command = if is_read {
        "+FLAGS (\\Seen)"
    } else {
        "-FLAGS (\\Seen)"
    };
    session
        .uid_store(uid.to_string(), command)
        .map_err(|e| e.to_string())?;
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID FLAGS)")
        .map_err(|e| e.to_string())?;
    let seen = fetches
        .iter()
        .find(|fetch| fetch.uid == Some(uid))
        .map(|fetch| {
            fetch
                .flags()
                .iter()
                .any(|flag| matches!(flag, imap::types::Flag::Seen))
        })
        .ok_or("服务器中找不到这封邮件")?;
    if seen != is_read {
        return Err("邮箱服务器未保存已读状态".into());
    }
    Ok(seen)
}

#[cfg(test)]
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
    let last_available = uid_list
        .last()
        .copied()
        .map(i64::from)
        .unwrap_or(cursor_start);
    uid_list.truncate(MAX_MAILS_PER_SCAN);
    if uid_list.is_empty() {
        let _ = session.logout();
        return Ok(FetchedBatch {
            mails: Vec::new(),
            validity,
            scanned_through: cursor_start,
            headers_only: Vec::new(),
            warning: None,
            has_more: false,
            backfill: None,
        });
    }
    let mut out = Vec::new();
    let mut headers_only = Vec::new();
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
            Ok(MailStep::Missing) => {}
            Ok(MailStep::Deferred) => break,
            Ok(MailStep::Mail(mail, bytes, header_only)) => {
                if header_only {
                    headers_only.push(uid);
                }
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
        headers_only,
        warning,
        has_more: scanned_through < last_available,
        backfill: None,
    })
}

enum MailStep {
    Missing,
    Deferred,
    Mail(Box<FetchedMail>, usize, bool),
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
    let header_only = size > MAX_MAIL_BYTES;
    if body_bytes.saturating_add(size.min(MAX_MAIL_BYTES)) > MAX_BODY_BYTES_PER_SCAN {
        return Ok(MailStep::Deferred);
    }
    let fetches = session
        .uid_fetch(
            uid.to_string(),
            if header_only {
                "(INTERNALDATE FLAGS BODY.PEEK[HEADER])"
            } else {
                "(INTERNALDATE FLAGS BODY.PEEK[])"
            },
        )
        .map_err(|e| e.to_string())?;
    let Some(fetch) = fetches.iter().find(|f| f.uid == Some(uid)) else {
        return if fetches.is_empty() {
            Ok(MailStep::Missing)
        } else {
            Err("收件服务器返回的正文 UID 不匹配".into())
        };
    };
    let bytes = (if header_only {
        fetch.header()
    } else {
        fetch.body()
    })
    .ok_or("收件服务器未返回邮件内容")?;
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
    let mut mail = parse_message(uid, bytes, received_at);
    if header_only {
        if let Some(content) = &mut mail.content {
            content.detail.complete = false;
        }
        mail.body = "这封邮件包含较大的正文或附件，已接收邮件头。请在原邮箱查看完整内容。".into();
    }
    mail.is_read = fetch
        .flags()
        .iter()
        .any(|flag| matches!(flag, imap::types::Flag::Seen));
    Ok(MailStep::Mail(Box::new(mail), bytes.len(), header_only))
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
        let content = content::parse(&parsed);
        let body = content.detail.text.clone();
        return FetchedMail {
            content: Some(content),
            uid,
            is_read: false,
            from: first_address(parsed.from()),
            subject: parsed.subject().unwrap_or("").to_string(),
            body,
            message_id: parsed.message_id().unwrap_or("").to_string(),
            in_reply_to: header_ids(parsed.in_reply_to()),
            references: header_ids(parsed.references()),
            content_type: content_type_of(&parsed),
            extra_headers: extra,
            received_at,
        };
    }
    FetchedMail {
        content: None,
        uid,
        is_read: false,
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

    pub(super) fn delivery(id: i64, recipient: &str, subject: &str) -> Delivery {
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

    pub(super) fn reply(from: &str, subject: &str) -> FetchedMail {
        FetchedMail {
            content: None,
            uid: 1,
            is_read: false,
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
        let guard = runtime::acquire_scan(&gate).unwrap();
        assert!(runtime::acquire_scan(&gate).is_err());
        drop(guard);
        assert!(runtime::acquire_scan(&gate).is_ok());
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
    fn imap_seen_flags_are_read_without_marking_mail_as_read() {
        let response = b"* OK fixture\r\na1 OK login\r\n* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n* 2 FETCH (UID 8 FLAGS ())\r\na2 OK fetch\r\n";
        let commands = Arc::new(Mutex::new(Vec::new()));
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(response.to_vec()),
            commands: commands.clone(),
        });
        client.read_greeting().unwrap();
        let mut session = client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap();
        let states = fetch_seen_flags_session(&mut session, &[7, 8]).unwrap();
        assert_eq!(states.get(&7), Some(&true));
        assert_eq!(states.get(&8), Some(&false));
        let sent = String::from_utf8(commands.lock().unwrap().clone()).unwrap();
        assert!(sent.contains("UID FETCH 7,8 (UID FLAGS)"));
        assert!(!sent.contains("STORE"));
    }

    #[test]
    fn auto_seen_batch_never_marks_human_uids_and_verifies_server_flags() {
        for success in [true, false] {
            let response = if success {
                b"* OK fixture\r\na1 OK login\r\na2 OK store\r\n* 1 FETCH (UID 7 FLAGS (\\Seen))\r\na3 OK fetch\r\n".as_slice()
            } else {
                b"* OK fixture\r\na1 OK login\r\na2 NO rejected\r\n".as_slice()
            };
            let commands = Arc::new(Mutex::new(Vec::new()));
            let mut client = imap::Client::new(Transcript {
                input: std::io::Cursor::new(response.to_vec()),
                commands: commands.clone(),
            });
            client.read_greeting().unwrap();
            let mut session = client
                .login("fixture", "")
                .map_err(|e| e.0.to_string())
                .unwrap();
            let mut states = HashMap::from([(7, false), (8, false)]);
            mark_auto_seen_session(&mut session, &mut states, &[7]);
            assert_eq!(states[&7], success);
            assert!(!states[&8]);
            let sent = String::from_utf8(commands.lock().unwrap().clone()).unwrap();
            assert!(sent.contains("UID STORE 7 +FLAGS (\\Seen)"));
            assert!(!sent.contains("UID STORE 8"));
            if success {
                assert!(sent.contains("UID FETCH 7 (UID FLAGS)"));
            }
        }
    }

    #[test]
    fn imap_read_action_uses_uid_store_and_verifies_seen_flag() {
        let response = b"* OK fixture\r\na1 OK login\r\n* 1 FETCH (UID 7 FLAGS (\\Seen))\r\na2 OK store\r\n* 1 FETCH (UID 7 FLAGS (\\Seen))\r\na3 OK fetch\r\n";
        let commands = Arc::new(Mutex::new(Vec::new()));
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(response.to_vec()),
            commands: commands.clone(),
        });
        client.read_greeting().unwrap();
        let mut session = client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap();
        assert!(store_seen_flag_session(&mut session, 7, true).unwrap());
        let sent = String::from_utf8(commands.lock().unwrap().clone()).unwrap();
        assert!(sent.contains("UID STORE 7 +FLAGS (\\Seen)"));
        assert!(sent.contains("UID FETCH 7 (UID FLAGS)"));
    }

    #[test]
    fn oversized_mail_keeps_headers_and_unread_without_blocking_following_mail() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'fixture@example.com','','localhost')",[]).unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        let mail =
            "From: editor@example.com\r\nSubject: reply\r\nMessage-ID: <fixture>\r\n\r\nhello";
        let header =
            "From: friend@example.com\r\nSubject: large mail\r\nMessage-ID: <large>\r\n\r\n";
        let responses = format!("* OK fixture\r\na1 OK login\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 1 2\r\na3 OK search\r\n* 1 FETCH (UID 1 RFC822.SIZE {})\r\na4 OK size\r\n* 1 FETCH (UID 1 FLAGS () BODY[HEADER] {{{}}}\r\n{})\r\na5 OK header\r\n* 2 FETCH (UID 2 RFC822.SIZE {})\r\na6 OK size\r\n* 2 FETCH (UID 2 INTERNALDATE \"01-Jan-2026 12:00:00 +0000\" FLAGS (\\Seen) BODY[] {{{}}}\r\n{})\r\na7 OK body\r\n* BYE fixture\r\na8 OK logout\r\n",
            MAX_MAIL_BYTES+1,header.len(),header,mail.len(),mail.len(),mail);
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
        assert_eq!(batch.headers_only, vec![1]);
        assert_eq!(batch.scanned_through, 2);
        assert_eq!(batch.mails.len(), 2);
        assert_eq!(batch.mails[0].uid, 1);
        assert!(!batch.mails[0].is_read);
        assert!(batch.mails[0].body.contains("请在原邮箱"));
        assert_eq!(batch.mails[1].uid, 2);
        assert!(batch.mails[1].is_read);
        let commands = String::from_utf8(commands.lock().unwrap().clone()).unwrap();
        assert!(!commands.contains("UID FETCH 1 (INTERNALDATE FLAGS BODY.PEEK[])"));
        assert!(commands.contains("UID FETCH 2 (INTERNALDATE FLAGS BODY.PEEK[])"));
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
        let header = "From: friend@example.com\r\nSubject: large mail\r\n\r\n";
        let responses = format!("* OK fixture\r\na1 OK login\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 1 2\r\na3 OK search\r\n* 1 FETCH (UID 1 RFC822.SIZE {})\r\na4 OK size\r\n* 1 FETCH (UID 1 FLAGS () BODY[HEADER] {{{}}}\r\n{})\r\na5 OK header\r\n",MAX_MAIL_BYTES+1,header.len(),header);
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
        assert_eq!(batch.headers_only, vec![1]);
        assert!(batch.warning.unwrap().contains("UID 2"));
    }
    fn scan_fixture() -> (Connection, Account) {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host,imap_uid,imap_uid_validity) VALUES(1,'fixture@example.com','','localhost',500,10)", []).unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        (conn, account)
    }

    #[test]
    fn ordinary_mail_is_unread_but_only_submission_mail_can_be_accepted() {
        let (conn, account) = scan_fixture();
        let mut mail = super::tests::reply("friend@example.com", "测试邮件");
        mail.body = "稿件审核通过".into();
        mail.message_id = "test-mail".into();
        let ordinary = persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .unwrap();
        assert_eq!(ordinary.kind, "human");
        assert!(
            ordinary.delivery_id.is_none()
                && !ordinary.accepted
                && !ordinary.is_read
                && ordinary.read_synced
        );
        assert_eq!(store::unread_human_reply_count(&conn).unwrap(), 1);
        assert_eq!(store::count_replies(&conn, "human").unwrap(), 0);
        assert!(persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .is_none());
        mail.uid = 2;
        mail.message_id = "submission".into();
        let matched = persist_incoming(
            &conn,
            &account,
            &mail,
            Some(&super::tests::delivery(1, "friend@example.com", "测试邮件")),
            10,
            &[],
        )
        .unwrap()
        .unwrap();
        assert!(matched.accepted);
        assert_eq!(matched.delivery_id, Some(1));
        assert_eq!(store::count_replies(&conn, "human").unwrap(), 1);
        assert_eq!(store::count_accepted_replies(&conn).unwrap(), 1);
        for (kind, id) in [("unmatched", ordinary.id), ("submission", matched.id)] {
            let page = store::query_replies(&conn, Some(kind), None, "", 20, 0, None).unwrap();
            assert_eq!(page.total, 1);
            assert_eq!(page.items[0].id, id);
        }
        mail.uid = 3;
        mail.message_id = "automatic".into();
        mail.subject = "自动回复：测试".into();
        let auto = persist_incoming(&conn, &account, &mail, None, 10, &["自动回复".into()])
            .unwrap()
            .unwrap();
        assert_eq!(auto.kind, "auto");
        assert!(auto.is_read && !auto.read_synced && !auto.accepted);
        assert_eq!(store::unread_human_reply_count(&conn).unwrap(), 2);
    }

    #[test]
    fn historical_backfill_does_not_push_newer_mail_off_the_first_page() {
        let (conn, account) = scan_fixture();
        let mut mail = super::tests::reply("friend@example.com", "new");
        mail.received_at = "2026-09-26 12:00:00".into();
        let newest = persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .unwrap();
        mail.uid = 2;
        mail.subject = "old".into();
        mail.received_at = "2026-09-20 12:00:00".into();
        persist_incoming(&conn, &account, &mail, None, 10, &[]).unwrap();
        let page = store::query_replies(&conn, None, None, "", 1, 0, None).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].id, newest.id);
    }

    #[test]
    fn backfill_deduplicates_without_undoing_read_and_rebinds_new_uidvalidity() {
        let (conn, account) = scan_fixture();
        let mut mail = super::tests::reply("friend@example.com", "测试");
        mail.message_id = "same-mail".into();
        let saved = persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .unwrap();
        store::set_reply_read(&conn, saved.id, true).unwrap();
        assert!(persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .is_none());
        assert_eq!(store::unread_human_reply_count(&conn).unwrap(), 0);
        mail.uid = 77;
        assert!(persist_incoming(&conn, &account, &mail, None, 11, &[])
            .unwrap()
            .is_none());
        let rows = store::load_replies(&conn, None, None, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].imap_uid, 77);
        assert_eq!(rows[0].imap_uid_validity, 11);
        assert!(!rows[0].is_read);
    }

    fn transcript_session(responses: String) -> imap::Session<Transcript> {
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(responses.into_bytes()),
            commands: Arc::new(Mutex::new(Vec::new())),
        });
        client.read_greeting().unwrap();
        client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap()
    }

    #[test]
    fn backfill_spans_batches_and_receives_new_mail_before_older_history() {
        let (_conn, mut account) = scan_fixture();
        let plan = prioritized_uids(
            vec![502, 500, 501, 501],
            vec![3, 299, 300, 299, 502],
            500,
            300,
        );
        assert_eq!(
            plan,
            vec![(501, false), (502, false), (299, true), (3, true)]
        );
        let history = (1..=300)
            .map(|uid| uid.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        let mut responses=format!("* OK fixture\r\na1 OK login\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 501\r\na3 OK search\r\n* SEARCH {history}\r\na4 OK search\r\n");
        // Expunged messages still advance checkpoints, without needing a body download.
        for tag in 5..205 {
            responses.push_str(&format!("a{tag} OK missing\r\n"));
        }
        responses.push_str("* BYE fixture\r\na205 OK logout\r\n");
        let first = fetch_prioritized_session(
            transcript_session(responses),
            &account,
            None,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(first.scanned_through, 501);
        assert!(first.has_more);
        let progress = first.backfill.unwrap();
        assert_eq!(progress.before, 102);
        assert!(!progress.complete);
        account.imap_uid = 501;
        let history = (1..102)
            .map(|uid| uid.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        let mut responses=format!("* OK fixture\r\na1 OK login\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 502\r\na3 OK search\r\n* SEARCH {history}\r\na4 OK search\r\n");
        for tag in 5..107 {
            responses.push_str(&format!("a{tag} OK missing\r\n"));
        }
        responses.push_str("* BYE fixture\r\na107 OK logout\r\n");
        let second = fetch_prioritized_session(
            transcript_session(responses),
            &account,
            Some(progress),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(second.scanned_through, 502);
        assert!(!second.has_more);
        assert!(second.backfill.unwrap().complete);
    }

    #[test]
    fn fresh_failure_does_not_skip_uid_or_advance_historical_checkpoint() {
        let (_conn, account) = scan_fixture();
        let responses="* OK fixture\r\na1 OK login\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n* SEARCH 501 502 503\r\na3 OK search\r\n* SEARCH 499\r\na4 OK search\r\na5 OK missing\r\na6 NO retry later\r\n* BYE fixture\r\na7 OK logout\r\n";
        let batch = fetch_prioritized_session(
            transcript_session(responses.into()),
            &account,
            None,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(batch.scanned_through, 501);
        assert!(batch.has_more && batch.warning.is_some());
        assert_eq!(batch.backfill.unwrap().before, 501);
    }

    #[test]
    fn uidvalidity_reset_discards_old_progress_and_uses_current_server_head() {
        let (_conn, account) = scan_fixture();
        let responses="* OK fixture\r\na1 OK login\r\n* OK [UIDVALIDITY 11] valid\r\n* OK [UIDNEXT 13] next\r\na2 OK select\r\n* SEARCH 12\r\na3 OK search\r\n* SEARCH 11 12\r\na4 OK search\r\na5 OK missing\r\na6 OK missing\r\n* BYE fixture\r\na7 OK logout\r\n";
        let progress = BackfillProgress {
            validity: 10,
            before: 2,
            since: "01-Jan-2000".into(),
            complete: true,
        };
        let batch = fetch_prioritized_session(
            transcript_session(responses.into()),
            &account,
            Some(progress),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(batch.scanned_through, 12);
        assert_eq!(batch.validity, 11);
        let progress = batch.backfill.unwrap();
        assert!(progress.complete);
        assert_eq!(progress.before, 11);
        assert_ne!(progress.since, "01-Jan-2000");
    }
    #[test]
    fn first_message_after_empty_initial_sync_is_not_skipped() {
        let (_conn, mut account) = scan_fixture();
        account.imap_uid = 0;
        let progress = BackfillProgress {
            validity: 10,
            before: 1,
            since: "01-Sep-2026".into(),
            complete: true,
        };
        let raw="From: friend@example.com\r\nSubject: first incoming\r\nMessage-ID: <first>\r\n\r\nhello";
        let responses=format!("* OK fixture\r\na1 OK login\r\n* OK [UIDVALIDITY 10] valid\r\n* OK [UIDNEXT 2] next\r\na2 OK select\r\n* SEARCH 1\r\na3 OK search\r\n* 1 FETCH (UID 1 RFC822.SIZE {})\r\na4 OK size\r\n* 1 FETCH (UID 1 FLAGS () BODY[] {{{}}}\r\n{})\r\na5 OK body\r\n* BYE fixture\r\na6 OK logout\r\n",raw.len(),raw.len(),raw);
        let batch = fetch_prioritized_session(
            transcript_session(responses),
            &account,
            Some(progress),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(batch.mails.len(), 1);
        assert_eq!(batch.mails[0].uid, 1);
        assert_eq!(batch.scanned_through, 1);
    }
}

pub(crate) fn sync_reply_flags(
    db: &Arc<Mutex<Connection>>,
    ids: Vec<i64>,
) -> Result<crate::models::ReplyFlagSyncResult, String> {
    sync_reply_flags_with(db, ids, &fetch_seen_flags_with_auto_read)
}

fn sync_reply_flags_with<F>(
    db: &Arc<Mutex<Connection>>,
    ids: Vec<i64>,
    fetch: &F,
) -> Result<crate::models::ReplyFlagSyncResult, String>
where
    F: Fn(&Account, i64, &[u32], &[u32]) -> Result<HashMap<u32, bool>, String> + Sync,
{
    let mut groups: std::collections::BTreeMap<
        (i64, i64),
        (crate::models::Account, Vec<store::ReplyFlagTarget>),
    > = std::collections::BTreeMap::new();
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mut accounts = HashMap::new();
        for id in ids {
            let Some(target) = store::reply_flag_target(&conn, id)? else {
                continue;
            };
            if !accounts.contains_key(&target.account_id) {
                accounts.insert(
                    target.account_id,
                    store::load_account(&conn, target.account_id)?,
                );
            }
            let Some(account) = accounts.get(&target.account_id).and_then(Clone::clone) else {
                continue;
            };
            if account.imap_generation != target.generation
                || target.uid_validity <= 0
                || account.imap_host.trim().is_empty()
            {
                continue;
            }
            groups
                .entry((target.account_id, target.uid_validity))
                .or_insert_with(|| (account, Vec::new()))
                .1
                .push(target);
        }
    }
    let mut results = crate::models::ReplyFlagSyncResult::default();
    let mut groups = groups.into_iter();
    loop {
        let batch: Vec<_> = groups.by_ref().take(4).collect();
        if batch.is_empty() {
            break;
        }
        let fetched = std::thread::scope(|scope| {
            let jobs: Vec<_> = batch
                .into_iter()
                .map(|((_, validity), (account, targets))| {
                    scope.spawn(move || {
                        let uids = targets.iter().map(|target| target.uid).collect::<Vec<_>>();
                        let automatic = targets
                            .iter()
                            .filter(|target| target.kind == "auto")
                            .map(|target| target.uid)
                            .collect::<Vec<_>>();
                        let result = fetch(&account, validity, &uids, &automatic).map_err(|message| {
                            crate::models::ReplyFlagSyncError {
                                account_id: account.id,
                                email: account.email.clone(),
                                message: if account.password.is_empty() {
                                    message
                                } else {
                                    message.replace(&account.password, "***")
                                },
                            }
                        });
                        (targets, result)
                    })
                })
                .collect();
            jobs.into_iter()
                .map(|job| job.join().map_err(|_| "邮件同步线程异常".to_string()))
                .collect::<Result<Vec<_>, _>>()
        })?;
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (targets, result) in fetched {
            match result {
                Ok(states) => {
                    for target in targets {
                        if let Some(&is_read) = states.get(&target.uid) {
                            if store::update_reply_read_from_sync(&tx, &target, is_read)? {
                                results.states.push(crate::models::ReplyReadState {
                                    id: target.id,
                                    is_read: is_read || target.kind == "auto",
                                    read_synced: is_read || target.kind != "auto",
                                });
                            }
                        }
                    }
                }
                Err(error) => results.errors.push(error),
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(results)
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct BackfillProgress {
    validity: i64,
    before: i64,
    since: String,
    complete: bool,
}

fn prioritized_uids(
    mut fresh: Vec<u32>,
    mut history: Vec<u32>,
    cursor: i64,
    before: i64,
) -> Vec<(u32, bool)> {
    fresh.retain(|uid| i64::from(*uid) > cursor);
    fresh.sort_unstable();
    fresh.dedup();
    history.retain(|uid| i64::from(*uid) <= cursor && i64::from(*uid) < before);
    history.sort_unstable_by(|a, b| b.cmp(a));
    history.dedup();
    fresh
        .into_iter()
        .map(|uid| (uid, false))
        .chain(history.into_iter().map(|uid| (uid, true)))
        .collect()
}

fn fetch_mail_prioritized(
    account: &Account,
    progress: Option<BackfillProgress>,
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
    fetch_prioritized_session(session, account, progress, deadline)
}

fn fetch_prioritized_session<S: Read + Write>(
    mut session: imap::Session<S>,
    account: &Account,
    progress: Option<BackfillProgress>,
    deadline: Instant,
) -> Result<FetchedBatch, String> {
    let mailbox = session.select("INBOX").map_err(|e| e.to_string())?;
    let validity = mailbox.uid_validity.ok_or("服务器未返回 UIDVALIDITY")? as i64;
    let since = chrono_since_days(AUTO_REPLY_BACKFILL_DAYS);
    let reset = validity != account.imap_uid_validity;
    // On first connection start at the server's current head, then backfill newest historical messages first.
    let head = if reset {
        mailbox.uid_next.map(|uid| i64::from(uid).saturating_sub(1))
    } else {
        Some(account.imap_uid)
    };
    let cursor = match head {
        Some(head) => head,
        None => session
            .uid_search("ALL")
            .map_err(|e| e.to_string())?
            .into_iter()
            .max()
            .map(i64::from)
            .unwrap_or(0),
    };
    let mut progress = progress
        .filter(|p| p.validity == validity)
        .unwrap_or(BackfillProgress {
            validity,
            before: cursor + 1,
            since,
            complete: false,
        });
    let fresh = session
        .uid_search(format!("UID {}:*", cursor + 1))
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let history = if progress.complete || progress.before <= 1 {
        Vec::new()
    } else {
        session
            .uid_search(format!(
                "SINCE {} UID 1:{}",
                progress.since,
                progress.before - 1
            ))
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect()
    };
    let planned = prioritized_uids(fresh, history, cursor, progress.before);
    let remaining = planned.len();
    let mut processed = 0;
    let mut out = Vec::new();
    let mut headers_only = Vec::new();
    let mut scanned_through = cursor;
    let mut body_bytes = 0;
    let mut warning = None;
    for (uid, historical) in planned.iter().copied().take(MAX_MAILS_PER_SCAN) {
        if Instant::now() >= deadline {
            warning = Some("本批检查已到时限，下次从断点继续".into());
            break;
        }
        match fetch_one_mail(&mut session, uid, body_bytes) {
            Ok(MailStep::Missing) => {}
            Ok(MailStep::Deferred) => break,
            Ok(MailStep::Mail(mail, bytes, header_only)) => {
                if header_only {
                    headers_only.push(uid);
                }
                out.push(*mail);
                body_bytes += bytes;
            }
            Err(error) if processed > 0 => {
                warning = Some(format!(
                    "本批收件中断，将从断点继续：{}",
                    error.chars().take(200).collect::<String>()
                ));
                break;
            }
            Err(error) => return Err(error),
        }
        processed += 1;
        if historical {
            progress.before = i64::from(uid);
        } else {
            scanned_through = i64::from(uid);
        }
    }
    if processed == remaining {
        progress.complete = true;
    }
    let _ = session.logout();
    Ok(FetchedBatch {
        mails: out,
        validity,
        scanned_through,
        headers_only,
        warning,
        has_more: processed < remaining,
        backfill: Some(progress),
    })
}

fn persist_incoming(
    conn: &Connection,
    account: &Account,
    mail: &FetchedMail,
    delivery: Option<&Delivery>,
    validity: i64,
    auto_keywords: &[String],
) -> Result<Option<crate::models::Reply>, String> {
    use rusqlite::OptionalExtension;
    let existing:Option<(i64,i64,i64)>=conn.query_row("SELECT id,imap_uid_validity,imap_uid FROM replies WHERE account_id=?1 AND imap_generation=?2 AND ((imap_uid_validity=?3 AND imap_uid=?4) OR (?5<>'' AND message_id=?5)) ORDER BY id LIMIT 1",
        rusqlite::params![account.id,account.imap_generation,validity,mail.uid,mail.message_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|e|e.to_string())?;
    if let Some((id, old_validity, old_uid)) = existing {
        // Rebind after server UIDVALIDITY resets. Ordinary backfill does not overwrite a newer read action.
        if old_validity != validity || old_uid != i64::from(mail.uid) {
            conn.execute("UPDATE replies SET imap_uid=?2,imap_uid_validity=?3,is_read=CASE WHEN kind='auto' THEN 1 ELSE ?4 END,read_synced=CASE WHEN kind='auto' THEN ?4 ELSE 1 END WHERE id=?1",
                rusqlite::params![id,mail.uid,validity,mail.is_read]).map_err(|e|e.to_string())?;
        }
        if let Some(content) = &mail.content {
            content::save(conn, id, content)?;
        }
        return Ok(None);
    }
    let classification = classify::classify_with_keywords(
        &IncomingMail {
            from: mail.from.clone(),
            subject: mail.subject.clone(),
            body: mail.body.clone(),
            content_type: mail.content_type.clone(),
            extra_headers: mail.extra_headers.clone(),
        },
        auto_keywords,
    );
    let accepted = delivery.is_some()
        && classification.kind == classify::ReplyKind::Human
        && classify::body_suggests_accepted(&mail.body);
    let snippet: String = mail.body.chars().take(180).collect();
    let reply = store::insert_reply(
        conn,
        delivery.map(|d| d.id),
        account.id,
        delivery.and_then(|d| d.task_id),
        &mail.from,
        &mail.subject,
        &snippet,
        &mail.body,
        classification.kind.as_str(),
        &classification.reason,
        accepted,
        &mail.message_id,
        &mail.in_reply_to,
        i64::from(mail.uid),
        validity,
        account.imap_generation,
        &mail.received_at,
        mail.is_read,
    )?;
    if let Some(content) = &mail.content {
        content::save(conn, reply.id, content)?;
    }
    Ok(Some(reply))
}

#[cfg(test)]
mod flag_sync_result_tests {
    use super::*;

    fn database() -> Arc<Mutex<Connection>> {
        let conn = crate::db::test_database();
        // More than one worker batch; failed accounts must not roll back successes.
        for id in 1..=6 {
            conn.execute(
                "INSERT INTO accounts(id,email,password,smtp_host,imap_host) VALUES(?1,?2,'fixture-secret','localhost','localhost')",
                rusqlite::params![id, format!("account{id}@example.com")],
            ).unwrap();
            conn.execute(
                "INSERT INTO replies(id,account_id,imap_uid,imap_uid_validity,kind,is_read,read_synced) VALUES(?1,?1,1,10,'human',0,0)",
                [id],
            ).unwrap();
        }
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn partial_flag_failures_keep_successes_and_report_every_failed_account() {
        let db = database();
        let result = sync_reply_flags_with(&db, (1..=6).collect(), &|account, _, _, _| {
            if account.id % 2 == 0 {
                Err("fixture-secret connection rejected".into())
            } else {
                Ok(HashMap::from([(1, true)]))
            }
        }).unwrap();
        assert_eq!(result.states.iter().map(|s| s.id).collect::<Vec<_>>(), [1, 3, 5]);
        assert_eq!(result.errors.iter().map(|e| e.account_id).collect::<Vec<_>>(), [2, 4, 6]);
        for error in &result.errors {
            assert_eq!(error.email, format!("account{}@example.com", error.account_id));
            assert_eq!(error.message, "*** connection rejected");
        }
        let conn = db.lock().unwrap();
        for id in 1..=6 {
            let (read, synced): (bool, bool) = conn.query_row(
                "SELECT is_read,read_synced FROM replies WHERE id=?1", [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!((read, synced), (id % 2 != 0, id % 2 != 0));
        }
    }

    #[test]
    fn total_flag_failure_still_returns_all_account_errors_and_supports_retry() {
        let db = database();
        let result = sync_reply_flags_with(&db, vec![1, 2], &|_, _, _, _| Err("offline".into())).unwrap();
        assert!(result.states.is_empty());
        assert_eq!(result.errors.len(), 2);
        let retry = sync_reply_flags_with(&db, vec![1, 2], &|_, _, _, _| Ok(HashMap::from([(1, false)]))).unwrap();
        assert!(retry.errors.is_empty());
        assert_eq!(retry.states.len(), 2);
        assert!(retry.states.iter().all(|state| !state.is_read && state.read_synced));
    }
}
