use tauri::State;

use crate::models::AccountInput;
use crate::smtp;
use crate::state::AppState;
use crate::store;

// ---------- Accounts ----------

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<crate::models::Account>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_accounts(&conn)
}

#[tauri::command]
pub fn add_account(
    state: State<'_, AppState>,
    input: AccountInput,
) -> Result<i64, String> {
    validate_account(&input)?;
    let (imap_host, imap_port) = resolve_imap(&input);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO accounts (email, password, smtp_host, smtp_port, sender_name, provider, enabled, imap_host, imap_port, check_replies)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            input.email.trim(),
            input.password,
            input.smtp_host.trim(),
            input.smtp_port,
            input.sender_name.trim(),
            input.provider,
            input.enabled as i64,
            imap_host,
            imap_port,
            input.check_replies as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_account(
    state: State<'_, AppState>,
    id: i64,
    input: AccountInput,
) -> Result<(), String> {
    validate_account(&input)?;
    let (imap_host, imap_port) = resolve_imap(&input);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts SET email = ?1, password = ?2, smtp_host = ?3, smtp_port = ?4,
                sender_name = ?5, provider = ?6, enabled = ?7,
                imap_host = ?8, imap_port = ?9, check_replies = ?10
         WHERE id = ?11",
        rusqlite::params![
            input.email.trim(),
            input.password,
            input.smtp_host.trim(),
            input.smtp_port,
            input.sender_name.trim(),
            input.provider,
            input.enabled as i64,
            imap_host,
            imap_port,
            input.check_replies as i64,
            id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_account(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_account(state: State<'_, AppState>, id: i64, enabled: bool) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts SET enabled = ?1 WHERE id = ?2",
        [enabled as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn test_account(state: State<'_, AppState>, id: i64) -> Result<String, String> {
    let account = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_account(&conn, id)?.ok_or("账号不存在")?
    };
    match smtp::send_email(
        &account,
        &account.email,
        &account.sender_name,
        "熊猫投稿 连通性测试",
        "这是一封来自熊猫投稿的连通性测试邮件，收到说明 SMTP 配置正确。",
        "text/plain",
        None,
    )
    .await
    {
        Ok(_) => Ok(format!("连接成功：测试邮件已发送到 {}", account.email)),
        Err(err) => {
            let (_, msg) = smtp::classify_error(&err);
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn send_test_email(
    state: State<'_, AppState>,
    account_id: i64,
    manuscript_id: Option<i64>,
    attachment: Option<crate::models::AttachmentInput>,
    recipient: String,
    sender_name: String,
    subject: String,
    body: String,
    content_type: String,
) -> Result<String, String> {
    let account = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_account(&conn, account_id)?.ok_or("账号不存在")?
    };
    // 未指定收件人时发给自己，测试邮件绝不发给编辑。
    let to = if recipient.trim().is_empty() {
        account.email.clone()
    } else {
        recipient.trim().to_string()
    };
    // 附件：优先用前端传入的字节（新计划还没入库）；没传时若有稿件 id，则读数据库里已保存的附件。
    let attachment_data: Option<(String, Vec<u8>)> = if let Some(att) = attachment {
        Some((att.name, att.data))
    } else if let Some(mid) = manuscript_id {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::load_manuscript_attachment(&conn, mid).unwrap_or(None)
    } else {
        None
    };
    crate::smtp::parse_mailbox(&to).map_err(|_| "收件人地址格式不对".to_string())?;
    match crate::smtp::send_email(
        &account,
        &to,
        if sender_name.trim().is_empty() { &account.sender_name } else { &sender_name },
        &subject,
        &body,
        &content_type,
        attachment_data.as_ref().map(|(name, data)| (name.as_str(), data.as_slice())),
    )
    .await
    {
        Ok(_) => Ok(if attachment_data.is_some() {
            format!("测试邮件已发送到 {}（含附件）", to)
        } else {
            format!("测试邮件已发送到 {}", to)
        }),
        Err(err) => {
            let (_, msg) = crate::smtp::classify_error(&err);
            Err(msg)
        }
    }
}

fn resolve_imap(input: &AccountInput) -> (String, u16) {
    if !input.imap_host.trim().is_empty() {
        return (input.imap_host.trim().to_string(), if input.imap_port == 0 { 993 } else { input.imap_port });
    }
    match input.provider.as_str() {
        "qq" => ("imap.qq.com".into(), 993),
        "163" => ("imap.163.com".into(), 993),
        _ => (String::new(), 993),
    }
}

fn validate_account(input: &AccountInput) -> Result<(), String> {
    if input.email.trim().is_empty() || !input.email.contains('@') {
        return Err("请输入有效的邮箱地址".into());
    }
    if input.password.trim().is_empty() {
        return Err("请输入 SMTP 授权码".into());
    }
    if input.smtp_host.trim().is_empty() {
        return Err("请输入 SMTP 服务器地址".into());
    }
    Ok(())
}

