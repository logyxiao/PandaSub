use crate::state::AppState;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{
    ipc::Request,
    State,
};

pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
#[derive(Default, Clone)]
pub struct AttachmentStore(Arc<Mutex<HashMap<String, Vec<u8>>>>);
impl AttachmentStore {
    pub fn insert(&self, data: Vec<u8>) -> Result<String, String> {
        if data.is_empty() || data.len() > MAX_ATTACHMENT_BYTES {
            return Err("文稿不能为空，且不能超过 25 MB".into());
        }
        let mut entries = self.0.lock().map_err(|e| e.to_string())?;
        if entries.values().map(Vec::len).sum::<usize>() + data.len() > 100 * 1024 * 1024 {
            return Err("待保存附件过多，请先保存或关闭其他编辑窗口".into());
        }
        let token = format!("{:032x}", rand::random::<u128>());
        entries.insert(token.clone(), data);
        Ok(token)
    }
    pub fn resolve(&self, token: &str) -> Result<Vec<u8>, String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .get(token)
            .cloned()
            .ok_or_else(|| "附件已释放，请重新导入".into())
    }
    pub fn release(&self, token: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(token);
        Ok(())
    }
}
#[derive(Serialize)]
pub struct StagedAttachment {
    token: String,
    word_count: usize,
}
#[tauri::command]
pub async fn stage_attachment(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<StagedAttachment, String> {
    let (data, metadata) = super::binary::read_binary(
        request.body(),
        request
            .headers()
            .get("x-file-metadata")
            .and_then(|h| h.to_str().ok()),
        MAX_ATTACHMENT_BYTES,
        "文稿",
    )?;
    let ext = metadata.extension;
    let data = data.to_vec();
    let attachments = state.attachments.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let text = match ext.as_str() {
            "docx" => super::manuscripts::extract_docx_bytes(&data)?,
            "txt" | "md" | "html" | "htm" => String::from_utf8_lossy(&data).into_owned(),
            _ => return Err("不支持的文稿格式".into()),
        };
        let word_count = count_words(&text);
        let token = attachments.insert(data)?;
        Ok(StagedAttachment { token, word_count })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn release_attachment(state: State<'_, AppState>, token: String) -> Result<(), String> {
    state.attachments.release(&token)
}
fn count_words(text: &str) -> usize {
    let mut count = 0;
    let mut tag: Option<(usize, usize)> = None;
    for ch in text.chars() {
        let width = if ch.is_whitespace() || ch == '\u{feff}' {
            0
        } else {
            ch.len_utf16()
        };
        match (ch, tag.as_mut()) {
            ('>', Some((pending, inner))) => {
                if *inner == 0 {
                    count += *pending + width;
                }
                tag = None;
            }
            (_, Some((pending, inner))) => {
                *pending += width;
                *inner += 1;
            }
            ('<', None) => tag = Some((width, 0)),
            (_, None) => count += width,
        }
    }
    count + tag.map_or(0, |(pending, _)| pending)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staged_bytes_survive_retries_until_release() {
        let store = AttachmentStore::default();
        let token = store.insert(b"original".to_vec()).unwrap();
        assert_eq!(store.resolve(&token).unwrap(), b"original");
        assert!(store.resolve(&token).is_ok());
        store.release(&token).unwrap();
        assert!(store.resolve(&token).is_err());
        assert!(store.insert(vec![]).is_err());
        assert!(store.insert(vec![0; MAX_ATTACHMENT_BYTES + 1]).is_err());
    }
    #[test]
    fn counts_text_like_frontend() {
        assert_eq!(count_words("<p>你 好😀</p>\n\u{feff}"), 4);
        assert_eq!(count_words("a<unfinished"), 12);
        assert_eq!(count_words("<>"), 2);
        assert_eq!(count_words(&"<".repeat(100_000)), 100_000);
    }
}
