use super::*;
use base64::Engine;
use mail_parser::MimeHeaders;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailAddress {
    pub name: String,
    pub email: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MailAttachment {
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
    pub content_id: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MailContent {
    pub from: Vec<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub reply_to: Vec<MailAddress>,
    pub sent_at: String,
    pub text: String,
    pub html: String,
    pub attachments: Vec<MailAttachment>,
    pub inline_images: HashMap<String, String>,
    pub complete: bool,
    #[serde(default)]
    pub warning: Option<String>,
}
#[derive(Clone, Debug)]
pub struct ParsedContent {
    pub detail: MailContent,
    pub files: Vec<(usize, Vec<u8>)>,
}
fn addresses(value: Option<&mail_parser::Address<'_>>) -> Vec<MailAddress> {
    let entries = match value {
        Some(mail_parser::Address::List(list)) => list.iter().collect::<Vec<_>>(),
        Some(mail_parser::Address::Group(groups)) => {
            groups.iter().flat_map(|g| g.addresses.iter()).collect()
        }
        None => Vec::new(),
    };
    entries
        .into_iter()
        .map(|a| MailAddress {
            name: a.name.as_deref().unwrap_or_default().into(),
            email: a.address.as_deref().unwrap_or_default().into(),
        })
        .collect()
}
pub(super) fn parse(parsed: &mail_parser::Message<'_>) -> ParsedContent {
    let mut detail = MailContent {
        from: addresses(parsed.from()),
        to: addresses(parsed.to()),
        cc: addresses(parsed.cc()),
        bcc: addresses(parsed.bcc()),
        reply_to: addresses(parsed.reply_to()),
        sent_at: parsed.date().map(|d| d.to_rfc3339()).unwrap_or_default(),
        text: (0..parsed.text_body_count())
            .filter_map(|i| parsed.body_text(i).map(|s| s.into_owned()))
            .collect::<Vec<_>>()
            .join("\n\n"),
        html: if parsed
            .html_bodies()
            .any(|part| matches!(part.body, mail_parser::PartType::Html(_)))
        {
            (0..parsed.html_body_count())
                .filter_map(|i| parsed.body_html(i).map(|s| s.into_owned()))
                .collect::<Vec<_>>()
                .join("\n<hr>\n")
        } else {
            String::new()
        },
        complete: true,
        ..Default::default()
    };
    let mut files = Vec::new();
    for (index, part) in parsed.attachments().enumerate() {
        let mime = part
            .content_type()
            .map(|ct| {
                format!(
                    "{}/{}",
                    ct.c_type,
                    ct.c_subtype.as_deref().unwrap_or("octet-stream")
                )
            })
            .unwrap_or_else(|| "application/octet-stream".into());
        let bytes = part.contents();
        let cid = part
            .content_id()
            .unwrap_or_default()
            .trim_matches(['<', '>'])
            .to_string();
        if !cid.is_empty()
            && matches!(
                mime.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            )
        {
            detail.inline_images.insert(
                cid.clone(),
                format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
            );
        }
        detail.attachments.push(MailAttachment {
            index,
            name: part.attachment_name().unwrap_or("未命名附件").into(),
            mime,
            size: bytes.len(),
            content_id: cid,
        });
        files.push((index, bytes.to_vec()));
    }
    ParsedContent { detail, files }
}
pub(super) fn save(conn: &Connection, id: i64, content: &ParsedContent) -> Result<(), String> {
    let json = serde_json::to_string(&content.detail).map_err(|e| e.to_string())?;
    save_encoded(conn, id, content, &json)
}
fn save_encoded(
    conn: &Connection,
    id: i64,
    content: &ParsedContent,
    json: &str,
) -> Result<(), String> {
    // Do not decode a full HTML/inline-image cache just to inspect its completion flag.
    if !content.detail.complete {
        let complete: Option<bool> = conn
            .query_row(
                "SELECT json_extract(json,'$.complete') FROM reply_contents WHERE reply_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if complete == Some(true) {
            return Ok(());
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO reply_contents(reply_id,json) VALUES(?1,?2)",
        params![id, json],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM reply_files WHERE reply_id=?1", [id])
        .map_err(|e| e.to_string())?;
    for (index, data) in &content.files {
        tx.execute(
            "INSERT INTO reply_files(reply_id,part_index,data) VALUES(?1,?2,?3)",
            params![id, *index as i64, data],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
fn cached_json(conn: &Connection, id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT json FROM reply_contents WHERE reply_id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
fn decode_cached(json: Option<String>) -> Result<Option<MailContent>, String> {
    json.map(|j| serde_json::from_str(&j).map_err(|e| e.to_string()))
        .transpose()
}
#[cfg(test)]
pub fn cached(conn: &Connection, id: i64) -> Result<Option<MailContent>, String> {
    decode_cached(cached_json(conn, id)?)
}
fn read_cached(db: &Arc<Mutex<Connection>>, id: i64) -> Result<Option<MailContent>, String> {
    let json = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        cached_json(&conn, id)?
    };
    // Large MIME caches are decoded after releasing the shared database lock.
    decode_cached(json)
}

const MAX_DETAIL_BYTES: usize = 25 * 1024 * 1024;
fn fetch_detail(
    account: &Account,
    target: &store::ReplyFlagTarget,
    message_id: &str,
) -> Result<FetchedMail, String> {
    let client = connect_imap_bounded(
        &account.imap_host,
        account.imap_port,
        CONNECT_TIMEOUT,
        IO_TIMEOUT,
        Instant::now() + Duration::from_secs(90),
    )?;
    let session = client
        .login(&account.email, &account.password)
        .map_err(|e| e.0.to_string())?;
    fetch_detail_session(session, target, message_id)
}
fn fetch_detail_session<S: Read + Write>(
    mut session: imap::Session<S>,
    target: &store::ReplyFlagTarget,
    message_id: &str,
) -> Result<FetchedMail, String> {
    let mailbox = session.select("INBOX").map_err(|e| e.to_string())?;
    if mailbox.uid_validity.map(i64::from) != Some(target.uid_validity) {
        return Err("邮箱标识已变化，请先检查收件箱再打开邮件".into());
    }
    let sizes = session
        .uid_fetch(target.uid.to_string(), "(RFC822.SIZE)")
        .map_err(|e| e.to_string())?;
    let size = sizes
        .iter()
        .find(|f| f.uid == Some(target.uid))
        .and_then(|f| f.size)
        .ok_or("原邮件已不在收件箱中，无法补取完整内容")? as usize;
    if size > MAX_DETAIL_BYTES {
        return Err("邮件超过 25 MiB，请在原邮箱查看完整正文和附件".into());
    }
    let rows = session
        .uid_fetch(target.uid.to_string(), "(INTERNALDATE BODY.PEEK[])")
        .map_err(|e| e.to_string())?;
    let row = rows
        .iter()
        .find(|f| f.uid == Some(target.uid))
        .ok_or("原邮件已不在收件箱中")?;
    let raw = row.body().ok_or("服务器未返回邮件正文")?;
    if raw.len() > MAX_DETAIL_BYTES {
        return Err("邮件内容超过加载上限".into());
    }
    let mail = parse_message(target.uid, raw, String::new());
    if !message_id.is_empty() && normalize_id(&mail.message_id) != normalize_id(message_id) {
        return Err("服务器返回的邮件标识不匹配，未覆盖本地内容".into());
    }
    // The payload is complete. Drop this dedicated connection without waiting for
    // a slow server to acknowledge LOGOUT before allowing the reader to render.
    Ok(mail)
}
/// Read disk/local text only. This must not wait for a network slot or contact IMAP.
pub fn load_local(db: &Arc<Mutex<Connection>>, id: i64) -> Result<MailContent, String> {
    if let Some(content) = read_cached(db, id)? {
        return Ok(content);
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT from_email,body FROM replies WHERE id=?1", [id], |row| {
        Ok(MailContent {
            from: vec![MailAddress { name: String::new(), email: row.get(0)? }],
            text: row.get(1)?,
            ..Default::default()
        })
    }).optional().map_err(|e| e.to_string())?.ok_or_else(|| "邮件不存在或已删除".into())
}

pub fn load(db: &Arc<Mutex<Connection>>, id: i64) -> Result<MailContent, String> {
    match load_full(db, id) {
        Ok(content) => Ok(content),
        Err(error) => {
            let mut partial = load_local(db, id)?;
            partial.warning = Some(error);
            Ok(partial)
        }
    }
}

fn load_full(db: &Arc<Mutex<Connection>>, id: i64) -> Result<MailContent, String> {
    if let Some(content) = read_cached(db, id)?.filter(|c| c.complete) {
        return Ok(content);
    }
    let (account, target, message_id, cache_generation) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let target = store::reply_flag_target(&conn, id)?.ok_or("邮件不存在")?;
        let account = store::load_account(&conn, target.account_id)?.ok_or("邮箱账号不存在")?;
        if account.imap_generation != target.generation
            || target.uid_validity <= 0
            || account.imap_host.is_empty()
        {
            return Err("这封历史邮件缺少可用的邮箱连接信息，暂时显示已保存的正文".into());
        }
        let message_id = conn
            .query_row("SELECT message_id FROM replies WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        (account, target, message_id, crate::commands::storage::cache_generation(&conn)?)
    };
    let mail = fetch_detail(&account, &target, &message_id).map_err(|e| {
        if account.password.is_empty() {
            e
        } else {
            e.replace(&account.password, "***")
        }
    })?;
    let content = mail.content.ok_or("邮件内容无法解析")?;
    let encoded = serde_json::to_string(&content.detail).map_err(|e| e.to_string())?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let current = store::reply_flag_target(&conn, id)?.ok_or("邮件已删除")?;
    let account_now = store::load_account(&conn, target.account_id)?.ok_or("邮箱账号已删除")?;
    if current.generation != target.generation
        || current.uid_validity != target.uid_validity
        || current.uid != target.uid
        || account_now.imap_generation != target.generation
    {
        return Err("邮箱已发生变化，请重新打开邮件".into());
    }
    // A cleanup completed while this network request was pending: allow reading
    // the result without silently rebuilding the just-cleared disk cache.
    if crate::commands::storage::cache_generation(&conn)? != cache_generation {
        return Ok(content.detail);
    }
    save_encoded(&conn, id, &content, &encoded)?;
    conn.execute(
        "UPDATE replies SET body=?2,snippet=?3 WHERE id=?1",
        params![
            id,
            content.detail.text,
            content.detail.text.chars().take(180).collect::<String>()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(content.detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> FetchedMail {
        parse_message(
            7,
            include_bytes!("fixtures/full-message.eml"),
            "2026-09-26 12:31:00".into(),
        )
    }
    #[test]
    fn mime_details_keep_headers_html_inline_images_and_decoded_attachments() {
        let mail = fixture();
        let content = mail.content.unwrap();
        let detail = content.detail;
        assert_eq!(detail.from[0].name, "张编辑");
        assert_eq!(detail.to.len(), 2);
        assert_eq!(detail.cc.len(), 2);
        assert_eq!(detail.reply_to[0].email, "desk@example.com");
        assert!(detail.sent_at.starts_with("2026-09-26T12:30:00"));
        assert!(detail.text.contains("编辑您好："));
        assert!(detail.text.contains("Second paragraph & details."));
        assert!(detail.html.contains("<table>") && detail.html.contains("完整引用内容"));
        assert!(detail.inline_images["signature"].starts_with("data:image/png;base64,"));
        assert_eq!(detail.attachments.len(), 2);
        let file = detail
            .attachments
            .iter()
            .find(|a| a.name == "修改意见.txt")
            .unwrap();
        assert_eq!(
            content
                .files
                .iter()
                .find(|(i, _)| *i == file.index)
                .unwrap()
                .1,
            b"hello attachment"
        );
    }
    #[test]
    fn cache_is_offline_readable_keeps_full_content_and_deletes_with_reply() {
        let conn = crate::db::test_database();
        conn.execute_batch("PRAGMA foreign_keys=ON; INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'fixture@example.com','','localhost');").unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        let mail = fixture();
        let saved = persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .unwrap();
        assert!(cached(&conn, saved.id).unwrap().unwrap().complete);
        let mut header = mail.content.clone().unwrap();
        header.detail.complete = false;
        header.detail.html.clear();
        header.files.clear();
        save(&conn, saved.id, &header).unwrap();
        assert!(!cached(&conn, saved.id).unwrap().unwrap().html.is_empty());
        let db = Arc::new(Mutex::new(conn));
        assert_eq!(load(&db, saved.id).unwrap().attachments.len(), 2);
        let conn = db.lock().unwrap();
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT data FROM reply_files WHERE reply_id=?1 AND part_index=1",
                [saved.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bytes, b"hello attachment");
        conn.execute("DELETE FROM replies WHERE id=?1", [saved.id])
            .unwrap();
        assert!(cached(&conn, saved.id).unwrap().is_none());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM reply_files", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn html_only_entities_and_non_utf8_text_are_decoded() {
        let html=parse_message(1,b"Content-Type: text/html; charset=utf-8\r\n\r\n<p>First &amp; second</p><p>Next paragraph</p>",String::new());
        let content = html.content.unwrap().detail;
        assert!(content.text.contains("First & second"));
        assert!(content.text.contains("Next paragraph"));
        let latin = parse_message(
            2,
            b"Content-Type: text/plain; charset=iso-8859-1\r\n\r\nCaf\xe9",
            String::new(),
        );
        assert_eq!(latin.content.unwrap().detail.text, "Café");
    }
    struct Wire {
        input: std::io::Cursor<Vec<u8>>,
        output: Arc<Mutex<Vec<u8>>>,
    }
    impl Read for Wire {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Wire {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn full_detail_fetch_peeks_and_rejects_reused_uid_or_oversized_mail() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host) VALUES(1,'fixture@example.com','','localhost')",[]).unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        let mail = fixture();
        let saved = persist_incoming(&conn, &account, &mail, None, 10, &[])
            .unwrap()
            .unwrap();
        let target = store::reply_flag_target(&conn, saved.id).unwrap().unwrap();
        for case in ["success", "namespace", "size", "message_id"] {
            let raw = include_str!("fixtures/full-message.eml");
            let validity = if case == "namespace" { 11 } else { 10 };
            let size = if case == "size" {
                MAX_DETAIL_BYTES + 1
            } else {
                raw.len()
            };
            let response=format!("* OK fixture\r\na1 OK login\r\n* OK [UIDVALIDITY {validity}] valid\r\na2 OK select\r\n* 1 FETCH (UID 7 RFC822.SIZE {size})\r\na3 OK size\r\n* 1 FETCH (UID 7 BODY[] {{{}}}\r\n{})\r\na4 OK body\r\n* BYE fixture\r\na5 OK logout\r\n",raw.len(),raw);
            let output = Arc::new(Mutex::new(Vec::new()));
            let mut client = imap::Client::new(Wire {
                input: std::io::Cursor::new(response.into_bytes()),
                output: output.clone(),
            });
            client.read_greeting().unwrap();
            let session = client
                .login("fixture", "")
                .map_err(|e| e.0.to_string())
                .unwrap();
            let result = fetch_detail_session(
                session,
                &target,
                if case == "message_id" {
                    "different-id"
                } else {
                    "full-message@example.com"
                },
            );
            assert_eq!(result.is_ok(), case == "success", "{case}");
            let sent = String::from_utf8(output.lock().unwrap().clone()).unwrap();
            if case == "namespace" || case == "size" {
                assert!(!sent.contains("BODY.PEEK"));
            } else {
                assert!(sent.contains("BODY.PEEK[]"));
            }
            assert!(!sent.contains("STORE"));
            assert!(!sent.contains("LOGOUT"), "Content display must not wait for logout acknowledgement");
        }
    }
    #[test]
    fn multiple_body_sections_are_retained_and_plain_mail_stays_plain() {
        let raw=b"Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nFirst section\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: inline\r\n\r\nSecond section\r\n--x--\r\n";
        let mail = parse_message(1, raw, String::new());
        assert!(mail.body.contains("First section"));
        assert!(mail.body.contains("Second section"));
        assert!(mail.content.unwrap().detail.html.is_empty());
    }
}

#[cfg(test)]
mod summary_tests {
    use super::*;
    #[test]
    fn large_reply_lists_remain_small_and_legacy_text_stays_offline_readable() {
        let conn = crate::db::test_database();
        let text = "x".repeat(1024 * 1024) + "完整正文末尾";
        for id in 1..=20 {
            conn.execute("INSERT INTO replies(id,from_email,subject,body,snippet,kind) VALUES(?1,'friend@example.com','大邮件',?2,'','human')", params![id, text]).unwrap();
        }
        let page = store::query_replies(&conn, None, None, "", 20, 0, None).unwrap();
        assert_eq!(page.items.len(), 20);
        assert!(page.items.iter().all(|reply| reply.body.is_empty() && reply.snippet.len() == 180));
        assert!(serde_json::to_vec(&page).unwrap().len() < 20_000);
        let found = store::query_replies(&conn, None, None, "完整正文末尾", 20, 0, None).unwrap();
        assert_eq!(found.total, 20, "summary projection must not change full-text search");
        let db = Arc::new(Mutex::new(conn));
        let detail = load(&db, 1).unwrap();
        assert_eq!(detail.text, text);
        assert!(!detail.complete);
        assert!(detail.warning.is_some());
        assert!(load(&db, 999).is_err());
    }
}

#[cfg(test)]
mod local_read_tests {
    use super::*;
    #[test]
    fn local_reader_returns_full_cache_or_plain_text_without_imap_metadata() {
        let conn = crate::db::test_database();
        conn.execute("INSERT INTO replies(id,from_email,body,kind) VALUES(1,'friend@example.com','旧版正文','human'),(2,'friend@example.com','摘要正文','human')", []).unwrap();
        let full = MailContent { text: "完整缓存正文".into(), html: "<p>原始排版</p>".into(), complete: true, ..Default::default() };
        conn.execute("INSERT INTO reply_contents(reply_id,json) VALUES(2,?1)", [serde_json::to_string(&full).unwrap()]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let partial = load_local(&db, 1).unwrap();
        assert_eq!(partial.text, "旧版正文");
        assert!(!partial.complete);
        assert!(partial.warning.is_none());
        let cached = load_local(&db, 2).unwrap();
        assert!(cached.complete);
        assert_eq!(cached.html, full.html);
        assert!(load_local(&db, 999).is_err());
    }
}
