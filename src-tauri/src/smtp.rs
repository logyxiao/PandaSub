use lettre::message::{header::ContentType, Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::transport::smtp::Error as SmtpError;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use rand::Rng;

use crate::models::Account;

#[derive(Debug)]
pub enum SendError {
    Smtp(SmtpError),
    Build(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Smtp(e) => write!(f, "{e}"),
            SendError::Build(m) => write!(f, "{m}"),
        }
    }
}

fn parse_mailbox(input: &str) -> Result<Mailbox, SendError> {
    match input.parse::<Mailbox>() {
        Ok(m) => Ok(m),
        Err(e) => Err(SendError::Build(e.to_string())),
    }
}

pub fn build_mailer(account: &Account) -> Result<AsyncSmtpTransport<Tokio1Executor>, SmtpError> {
    let creds = Credentials::new(account.email.clone(), account.password.clone());
    let tls_params = TlsParameters::new(account.smtp_host.clone())?;
    let builder = AsyncSmtpTransport::<Tokio1Executor>::relay(&account.smtp_host)?
        .credentials(creds)
        .port(account.smtp_port);
    let builder = if account.smtp_port == 465 {
        builder.tls(Tls::Wrapper(tls_params))
    } else {
        builder.tls(Tls::Required(tls_params))
    };
    Ok(builder.build())
}

pub fn parse_recipient(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if let Some(start) = raw.find('<') {
        if let Some(end) = raw.find('>') {
            let name = raw[..start].trim();
            let email = raw[start + 1..end].trim();
            let name = if name.is_empty() {
                email.split('@').next().unwrap_or(email)
            } else {
                name
            };
            return (name.to_string(), email.to_string());
        }
    }
    let email = raw;
    let name = email.split('@').next().unwrap_or(email);
    (name.to_string(), email.to_string())
}

pub fn apply_placeholders(text: &str, editor_name: &str, email: &str, title: &str) -> String {
    text.replace("{{编辑昵称}}", editor_name)
        .replace("{{收件人}}", editor_name)
        .replace("{{邮箱}}", email)
        .replace("{{作品名}}", title)
}

pub fn make_message_id() -> String {
    let n: u64 = rand::rng().random();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("<novelsub.{ts}.{n}@novelsub.local>")
}

pub async fn send_email(
    account: &Account,
    recipient: &str,
    sender_name: &str,
    subject: &str,
    body: &str,
    content_type: &str,
) -> Result<String, SendError> {
    let mailer = build_mailer(account).map_err(SendError::Smtp)?;
    let from_src = if sender_name.trim().is_empty() {
        account.email.clone()
    } else {
        format!("{} <{}>", sender_name, account.email)
    };
    let from: Mailbox = parse_mailbox(&from_src)?;
    let to: Mailbox = parse_mailbox(recipient)?;
    let content = if content_type == "text/html" {
        ContentType::TEXT_HTML
    } else {
        ContentType::TEXT_PLAIN
    };
    let message_id = make_message_id();
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .message_id(Some(message_id.clone()))
        .header(content)
        .body(body.to_string())
        .map_err(|e| SendError::Build(e.to_string()))?;
    mailer.send(message).await.map_err(SendError::Smtp)?;
    Ok(message_id)
}

fn extract_code(text: &str) -> Option<u16> {
    text.split_whitespace().find_map(|w| {
        if w.len() == 3 && w.bytes().all(|b| b.is_ascii_digit()) {
            w.parse().ok()
        } else {
            None
        }
    })
}

/// Returns (category, friendly message).
pub fn classify_error(err: &SendError) -> (String, String) {
    match err {
        SendError::Build(m) => ("send".into(), m.clone()),
        SendError::Smtp(smtp_err) => {
            let text = smtp_err.to_string();
            match extract_code(&text) {
                Some(535) | Some(530) | Some(534) => (
                    "auth".into(),
                    "认证失败：SMTP 授权码错误或未开启 SMTP 服务".into(),
                ),
                Some(550) | Some(551) | Some(552) | Some(553) | Some(554) => (
                    "limit".into(),
                    format!("服务端拒绝投递（{}）", extract_code(&text).unwrap_or(550)),
                ),
                Some(421) | Some(450) | Some(451) | Some(452) => (
                    "limit".into(),
                    "临时限流：服务器繁忙，稍后自动重试".into(),
                ),
                _ => ("network".into(), "网络错误或无法连接 SMTP 服务器".into()),
            }
        }
    }
}

/// 防风控内容微改：随机尾部空行、段落间额外换行、句末随空格，
/// 仅改变空白字符，不改变正文语义。
pub fn mutate_body(body: &str, enabled: bool) -> String {
    if !enabled {
        return body.to_string();
    }
    let mut rng = rand::rng();
    let mut out = String::with_capacity(body.len() + 16);
    out.push_str(body);

    let trailing_newlines = rng.random_range(0..4);
    for _ in 0..trailing_newlines {
        out.push('\n');
    }

    if body.contains("\n\n") {
        let chance: f64 = rng.random_range(0.0..1.0);
        if chance < 0.3 {
            out = out.replace("\n\n", "\n\n\n");
        }
    }

    let mut spaced = String::with_capacity(out.len() + 8);
    for ch in out.chars() {
        spaced.push(ch);
        if matches!(ch, '。' | '，' | '、' | '！' | '？' | '；') {
            let r: f64 = rng.random_range(0.0..1.0);
            if r < 0.12 {
                spaced.push(' ');
            }
        }
    }
    spaced
}
