use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::models::{legacy_send_interval_min, normalize_send_interval_secs, Manuscript};
use crate::smtp;
use crate::state::{ensure_no_manual_sends, AppState, ManualSendLease};
use crate::store;

// ---------- 重新发送单条投递 ----------

/// 把某条已投递的邮件重新发给同一收件人：复用原稿件内容与附件，选一个已启用的账号发送。
#[tauri::command]
pub async fn resend_delivery(
    app: AppHandle,
    state: State<'_, AppState>,
    delivery_id: i64,
) -> Result<(), String> {
    let (delivery, manuscript, account, settings, attachment, _lease) = {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        let mut pending = state.manual_sends.lock().map_err(|e| e.to_string())?;
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let delivery = store::load_delivery(&conn, delivery_id)?.ok_or("投递记录不存在")?;
        let manuscript = match delivery.manuscript_id {
            Some(mid) => store::load_manuscript(&conn, mid)?.ok_or("原稿件已删除，无法重发")?,
            None => return Err("这条投递没有关联稿件，无法重发".into()),
        };
        store::ensure_manuscript_idle(&conn, &registry, manuscript.id)?;
        ensure_no_manual_sends(&pending, &[manuscript.id])?;
        let account = store::load_account(&conn, delivery.account_id.unwrap_or(0))?
            .ok_or("原发件账号已删除，无法重发")?;
        let settings = store::load_settings(&conn)?;
        let attachment = store::load_manuscript_attachment(&conn, manuscript.id)?;
        let lease = ManualSendLease::reserve(
            &state.manual_sends,
            &mut pending,
            manuscript.id,
            account.id,
            delivery.task_id,
        )?;
        (delivery, manuscript, account, settings, attachment, lease)
    };

    if !account.enabled {
        return Err(format!("发件账号 {} 已禁用，请先启用", account.email));
    }

    let (_editor_name, recipient_email) = smtp::parse_recipient(&delivery.recipient);
    let (subject, body) = smtp::resolve_outgoing_mail(
        &manuscript,
        &delivery.recipient,
        settings.anti_spam_mutation,
    );
    let sender_name = if manuscript.sender_name.trim().is_empty() {
        account.sender_name.clone()
    } else {
        manuscript.sender_name.clone()
    };

    let message_id = smtp::make_message_id();
    store::begin_send_attempt(
        &*state.db.lock().map_err(|e| e.to_string())?,
        &store::SuccessfulDelivery {
            task_id: delivery.task_id,
            account_id: account.id,
            manuscript_id: manuscript.id,
            recipient: &recipient_email,
            subject: &subject,
            message_id: &message_id,
            increment_task_progress: false,
        },
    )?;
    let send_result = smtp::send_email_with_id(
        &account,
        &recipient_email,
        &sender_name,
        &subject,
        &body,
        &manuscript.content_type,
        attachment
            .as_ref()
            .map(|(name, data)| (name.as_str(), data.as_slice())),
        &message_id,
    )
    .await;
    settle_send_error(&state, &message_id, &send_result)?;
    let message_id = send_result.map_err(|err| smtp::classify_error(&err).1)?;

    let recorded = {
        let mut conn = state.db.lock().map_err(|e| e.to_string())?;
        store::record_successful_delivery(
            &mut conn,
            store::SuccessfulDelivery {
                task_id: delivery.task_id,
                account_id: account.id,
                manuscript_id: manuscript.id,
                recipient: &recipient_email,
                subject: &subject,
                message_id: &message_id,
                increment_task_progress: false,
            },
        )
    };
    if let Err(error) = recorded {
        let log = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_send_log(
                &conn,
                delivery.task_id,
                Some(manuscript.id),
                Some(account.id),
                "error",
                "storage",
                &format!("邮件已重新发出，但保存投递记录失败：{error}"),
                &delivery.recipient,
            )
        };
        if let Ok(log) = log {
            let _ = app.emit("log", &log);
        }
        return Err(format!(
            "邮件已发出，但保存投递记录失败：{error}。请勿立即重复发送"
        ));
    }
    let log = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_send_log(
            &conn,
            delivery.task_id,
            Some(manuscript.id),
            Some(account.id),
            "success",
            "send",
            "重新发送成功",
            &delivery.recipient,
        )
    };
    if let Ok(log) = log {
        let _ = app.emit("log", &log);
    }
    emit_current_task(&app, &state, delivery.task_id);
    Ok(())
}

// ---------- 手动发送单个收件人 ----------

/// 不触发整份名单发送，只给指定的编辑手动发送一封当前稿件邮件。
#[tauri::command]
pub async fn send_manual_delivery(
    app: AppHandle,
    state: State<'_, AppState>,
    manuscript_id: i64,
    recipient: String,
    account_ids: Vec<i64>,
) -> Result<(), String> {
    let (manuscript, account, task_id, settings, attachment, _lease) = {
        let registry = state.tasks.lock().map_err(|e| e.to_string())?;
        let mut pending = state.manual_sends.lock().map_err(|e| e.to_string())?;
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let manuscript =
            store::load_manuscript(&conn, manuscript_id)?.ok_or("稿件不存在，无法手动发送")?;
        store::ensure_manuscript_idle(&conn, &registry, manuscript_id)?;
        ensure_no_manual_sends(&pending, &[manuscript_id])?;
        let accounts = store::load_enabled_account_configs(&conn)?;
        let account = if account_ids.is_empty() {
            accounts.into_iter().find(|a| a.enabled)
        } else {
            accounts
                .into_iter()
                .find(|a| account_ids.contains(&a.id) && a.enabled)
        }
        .ok_or("没有可用的发件邮箱，请先启用")?;
        let task_id = store::load_tasks(&conn)?
            .into_iter()
            .find(|task| task.manuscript_ids.contains(&manuscript_id))
            .map(|task| task.id);
        let settings = store::load_settings(&conn)?;
        let attachment = store::load_manuscript_attachment(&conn, manuscript.id)?;
        let lease = ManualSendLease::reserve(
            &state.manual_sends,
            &mut pending,
            manuscript.id,
            account.id,
            task_id,
        )?;
        (manuscript, account, task_id, settings, attachment, lease)
    };

    if !manuscript.recipients.iter().any(|r| {
        smtp::parse_recipient(r)
            .1
            .eq_ignore_ascii_case(&smtp::parse_recipient(&recipient).1)
    }) {
        return Err("该收件人不在当前稿件的收件名单中".into());
    }

    let (_editor_name, recipient_email) = smtp::parse_recipient(&recipient);
    let (subject, body) =
        smtp::resolve_outgoing_mail(&manuscript, &recipient, settings.anti_spam_mutation);
    let sender_name = if manuscript.sender_name.trim().is_empty() {
        account.sender_name.clone()
    } else {
        manuscript.sender_name.clone()
    };

    let message_id = smtp::make_message_id();
    store::begin_send_attempt(
        &*state.db.lock().map_err(|e| e.to_string())?,
        &store::SuccessfulDelivery {
            task_id,
            account_id: account.id,
            manuscript_id: manuscript.id,
            recipient: &recipient_email,
            subject: &subject,
            message_id: &message_id,
            increment_task_progress: false,
        },
    )?;
    let send_result = smtp::send_email_with_id(
        &account,
        &recipient_email,
        &sender_name,
        &subject,
        &body,
        &manuscript.content_type,
        attachment
            .as_ref()
            .map(|(name, data)| (name.as_str(), data.as_slice())),
        &message_id,
    )
    .await;
    settle_send_error(&state, &message_id, &send_result)?;
    let message_id = match send_result {
        Ok(message_id) => message_id,
        Err(err) => {
            let (category, message) = smtp::classify_error(&err);
            let log = {
                let conn = state.db.lock().map_err(|e| e.to_string())?;
                store::insert_send_log(
                    &conn,
                    task_id,
                    Some(manuscript.id),
                    Some(account.id),
                    "error",
                    &category,
                    &format!("手动发送失败（发件：{}）：{}", account.email, message),
                    &recipient,
                )
            };
            if let Ok(log) = log {
                let _ = app.emit("log", &log);
            }
            return Err(format!("{}（发件邮箱：{}）", message, account.email));
        }
    };

    let recorded = {
        let mut conn = state.db.lock().map_err(|e| e.to_string())?;
        store::record_successful_delivery(
            &mut conn,
            store::SuccessfulDelivery {
                task_id: None,
                account_id: account.id,
                manuscript_id: manuscript.id,
                recipient: &recipient_email,
                subject: &subject,
                message_id: &message_id,
                increment_task_progress: false,
            },
        )
    };
    if let Err(error) = recorded {
        let log = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            store::insert_send_log(
                &conn,
                task_id,
                Some(manuscript.id),
                Some(account.id),
                "error",
                "storage",
                &format!("邮件已手动发出，但保存投递记录失败：{error}"),
                &recipient,
            )
        };
        if let Ok(log) = log {
            let _ = app.emit("log", &log);
        }
        return Err(format!(
            "邮件已发出，但保存投递记录失败：{error}。请勿立即重复发送"
        ));
    }
    let log = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_send_log(
            &conn,
            task_id,
            Some(manuscript.id),
            Some(account.id),
            "success",
            "send",
            "手动发送成功",
            &recipient,
        )
    };
    if let Ok(log) = log {
        let _ = app.emit("log", &log);
    }
    emit_current_task(&app, &state, task_id);
    Ok(())
}

fn emit_current_task(app: &AppHandle, state: &AppState, task_id: Option<i64>) {
    if let Some(id) = task_id {
        let task = state
            .db
            .lock()
            .ok()
            .and_then(|conn| store::load_task(&conn, id).ok().flatten());
        if let Some(task) = task {
            let _ = app.emit("task", task);
        }
    }
}

// ---------- Manuscripts ----------
#[tauri::command]
pub fn list_manuscripts(state: State<'_, AppState>) -> Result<Vec<Manuscript>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_all_manuscripts(&conn)
}

#[tauri::command]
pub fn get_manuscript(state: State<'_, AppState>, id: i64) -> Result<Option<Manuscript>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::load_manuscript(&conn, id)
}

#[tauri::command]
pub fn add_manuscript(
    state: State<'_, AppState>,
    input: crate::models::ManuscriptInput,
) -> Result<i64, String> {
    if input.title.trim().is_empty() {
        return Err("作品名称不能为空".into());
    }
    if input.body.trim().is_empty()
        && !input
            .mail_templates
            .iter()
            .any(|item| !item.body.trim().is_empty())
    {
        return Err("请至少填写一套邮件正文".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let recipients = json!(input.recipients).to_string();
    let genres = json!(input.genres).to_string();
    let excluded_types = json!(input.excluded_types).to_string();
    let mail_templates = json!(input.mail_templates).to_string();
    let fixed_mail_template_id = input.fixed_mail_template_id.trim();
    let (send_interval_from_sec, send_interval_to_sec) =
        normalize_send_interval_secs(input.send_interval_from_sec, input.send_interval_to_sec);
    if !fixed_mail_template_id.is_empty()
        && !input
            .mail_templates
            .iter()
            .any(|item| item.id == fixed_mail_template_id && !item.body.trim().is_empty())
    {
        return Err("固定使用的邮件模板不存在或正文为空".into());
    }
    let body = if input.body.trim().is_empty() {
        input
            .mail_templates
            .iter()
            .find(|item| !item.body.trim().is_empty())
            .map(|item| item.body.clone())
            .unwrap_or_default()
    } else {
        input.body.clone()
    };
    conn.execute(
        "INSERT INTO manuscripts (title, body, content_type, recipients, sender_name,
            word_count, category, reader_category, reader_emotion, style, genres, excluded_types, account_ids, send_interval_min, subject, file_name, file_data, mail_templates, fixed_mail_template_id, send_interval_from_sec, send_interval_to_sec)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        rusqlite::params![
            input.title.trim(),
            body,
            input.content_type,
            recipients,
            input.sender_name.trim(),
            input.word_count,
            input.category.trim(),
            input.reader_category.trim(),
            input.reader_emotion.trim(),
            input.style.trim(),
            genres,
            excluded_types,
            json!(input.account_ids).to_string(),
            legacy_send_interval_min(send_interval_from_sec, send_interval_to_sec),
            input.subject.trim(),
            input.file_name.trim(),
            input.file_data,
            mail_templates,
            fixed_mail_template_id,
            send_interval_from_sec,
            send_interval_to_sec,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_manuscript(
    state: State<'_, AppState>,
    id: i64,
    input: crate::models::ManuscriptInput,
) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let pending = state.manual_sends.lock().map_err(|e| e.to_string())?;
    ensure_no_manual_sends(&pending, &[id])?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    store::ensure_manuscript_idle(&conn, &registry, id)?;
    let recipients = json!(input.recipients).to_string();
    let genres = json!(input.genres).to_string();
    let excluded_types = json!(input.excluded_types).to_string();
    let mail_templates = json!(input.mail_templates).to_string();
    let fixed_mail_template_id = input.fixed_mail_template_id.trim();
    let (send_interval_from_sec, send_interval_to_sec) =
        normalize_send_interval_secs(input.send_interval_from_sec, input.send_interval_to_sec);
    if !fixed_mail_template_id.is_empty()
        && !input
            .mail_templates
            .iter()
            .any(|item| item.id == fixed_mail_template_id && !item.body.trim().is_empty())
    {
        return Err("固定使用的邮件模板不存在或正文为空".into());
    }
    conn.execute(
        "UPDATE manuscripts SET title = ?1, body = ?2, content_type = ?3, recipients = ?4,
                sender_name = ?5, word_count = ?6, category = ?7, reader_category = ?8,
                reader_emotion = ?9, style = ?10, genres = ?11, excluded_types = ?16, account_ids = ?17,
                send_interval_min = ?19,
                subject = ?12, file_name = ?13,
                file_data = COALESCE(?15, file_data),
                mail_templates = ?18,
                fixed_mail_template_id = ?20,
                send_interval_from_sec = ?21,
                send_interval_to_sec = ?22,
                updated_at = datetime('now','localtime')
         WHERE id = ?14",
        rusqlite::params![
            input.title.trim(),
            input.body,
            input.content_type,
            recipients,
            input.sender_name.trim(),
            input.word_count,
            input.category.trim(),
            input.reader_category.trim(),
            input.reader_emotion.trim(),
            input.style.trim(),
            genres,
            input.subject.trim(),
            input.file_name.trim(),
            id,
            input.file_data,
            excluded_types,
            json!(input.account_ids).to_string(),
            mail_templates,
            legacy_send_interval_min(send_interval_from_sec, send_interval_to_sec),
            fixed_mail_template_id,
            send_interval_from_sec,
            send_interval_to_sec,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_manuscript(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    // Hold the task registry through the database transaction. A concurrent
    // start can then only reserve the task before this check (and be rejected)
    // or after deletion (and fail because the task no longer exists).
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let pending = state.manual_sends.lock().map_err(|e| e.to_string())?;
    ensure_no_manual_sends(&pending, &[id])?;
    // Deleting a manuscript also prunes orphan tasks and detaches their history.
    // Keep those task references stable until every pending manual send is recorded.
    if !pending.is_empty() {
        return Err("有手动发送或重发尚未完成，请完成后再删除稿件".into());
    }

    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tasks = store::load_tasks(&conn)?;
    for task in &tasks {
        if task.manuscript_ids.contains(&id)
            && (registry.contains_key(&task.id)
                || matches!(task.status.as_str(), "running" | "paused"))
        {
            return Err("这个计划正在发送，请先停止".into());
        }
    }
    store::delete_manuscript_data(&mut conn, id)
}

#[tauri::command]
pub fn extract_docx_text(data: Vec<u8>) -> Result<String, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|_| "不是有效的 Word 文件".to_string())?;
    let mut file = archive
        .by_name("word/document.xml")
        .map_err(|_| "不是有效的 Word 文件".to_string())?;
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut file, &mut xml).map_err(|e| e.to_string())?;
    Ok(docx_xml_to_text(&xml))
}

fn docx_xml_to_text(xml: &str) -> String {
    let with_breaks = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t");
    let mut out = String::new();
    let mut in_tag = false;
    for ch in with_breaks.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn settle_send_error(
    state: &AppState,
    message_id: &str,
    result: &Result<String, smtp::SendError>,
) -> Result<(), String> {
    if let Err(error) = result {
        if smtp::definitely_not_sent(error) {
            store::mark_attempt_not_sent(
                &*state.db.lock().map_err(|e| e.to_string())?,
                message_id,
            )?;
        } else {
            return Err(format!(
                "发送结果待确认：{}。请在计划记录中核对后处理",
                smtp::classify_error(error).1
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_pending_sends(
    state: State<'_, AppState>,
    manuscript_id: i64,
) -> Result<Vec<store::PendingSend>, String> {
    store::pending_sends(&*state.db.lock().map_err(|e| e.to_string())?, manuscript_id)
}

#[tauri::command]
pub fn resolve_pending_send(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    sent: bool,
) -> Result<(), String> {
    let registry = state.tasks.lock().map_err(|e| e.to_string())?;
    let pending = state.manual_sends.lock().map_err(|e| e.to_string())?;
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let (mid, task_id): (i64, Option<i64>) = conn
        .query_row(
            "SELECT manuscript_id,task_id FROM outgoing_attempts WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    // Do not use ensure_manuscript_idle here: pending is exactly what we resolve.
    if store::load_tasks(&conn)?.iter().any(|t| {
        registry.contains_key(&t.id) && (Some(t.id) == task_id || t.manuscript_ids.contains(&mid))
    }) {
        return Err("请先停止相关任务并等待发送结束，再确认结果".into());
    }
    ensure_no_manual_sends(&pending, &[mid])?;
    let attempt = store::pending_sends(&conn, mid)?
        .into_iter()
        .find(|attempt| attempt.id == id);
    store::resolve_send_attempt(&mut conn, id, sent)?;
    let log = attempt.and_then(|attempt| {
        store::insert_send_log(
            &conn,
            task_id,
            Some(mid),
            Some(attempt.account_id),
            if sent { "success" } else { "info" },
            "reconcile",
            if sent {
                "已人工核对并补记投递成功，未重新发送邮件"
            } else {
                "已人工核对邮件未发出，解除待确认状态"
            },
            &attempt.recipient,
        )
        .ok()
    });
    drop(conn);
    drop(pending);
    drop(registry);
    if let Some(log) = log {
        let _ = app.emit("log", &log);
    }
    emit_current_task(&app, &state, task_id);
    Ok(())
}
