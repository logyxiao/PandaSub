//! Shared bounded binary IPC for file imports and exports. Never serialize file bytes as JSON arrays.
use base64::Engine;
use serde::Deserialize;
use tauri::ipc::InvokeBody;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BinaryMetadata {
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub extension: String,
    #[serde(default)]
    pub path: String,
}
pub(crate) fn read_binary<'a>(
    body: &'a InvokeBody,
    header: Option<&str>,
    limit: usize,
    label: &str,
) -> Result<(&'a [u8], BinaryMetadata), String> {
    let InvokeBody::Raw(bytes) = body else {
        return Err(format!("{label}必须使用二进制传输"));
    };
    if bytes.is_empty() || bytes.len() > limit {
        return Err(format!(
            "{label}不能为空，且不能超过 {} MB",
            limit / 1024 / 1024
        ));
    }
    let header = header
        .filter(|value| value.len() <= 10924)
        .ok_or("缺少文件信息或文件信息过长")?;
    let metadata = base64::engine::general_purpose::STANDARD
        .decode(header)
        .map_err(|_| "文件信息编码无效")?;
    if metadata.len() > 8192 {
        return Err("文件信息过长".into());
    }
    let metadata = serde_json::from_slice(&metadata).map_err(|_| "文件信息格式无效")?;
    Ok((bytes, metadata))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_raw_bytes_and_unicode_metadata_without_copying_payload() {
        let body = InvokeBody::Raw(vec![0, 127, 128, 255]);
        let header = base64::engine::general_purpose::STANDARD
            .encode(r#"{"file_name":"编辑库（新版）.xlsx","path":"/tmp/成绩 图.png"}"#);
        let (bytes, metadata) = read_binary(&body, Some(&header), 1024, "文件").unwrap();
        assert_eq!(bytes, [0, 127, 128, 255]);
        assert_eq!(metadata.file_name, "编辑库（新版）.xlsx");
        assert_eq!(metadata.path, "/tmp/成绩 图.png");
        if let InvokeBody::Raw(original) = &body {
            assert_eq!(bytes.as_ptr(), original.as_ptr());
        }
    }
    #[test]
    fn rejects_unbounded_or_ambiguous_payloads_before_work_starts() {
        let header = base64::engine::general_purpose::STANDARD.encode("{}");
        for body in [
            InvokeBody::Raw(vec![]),
            InvokeBody::Raw(vec![0; 5]),
            InvokeBody::Json(serde_json::json!([1, 2])),
        ] {
            assert!(read_binary(&body, Some(&header), 4, "文件").is_err());
        }
        let body = InvokeBody::Raw(vec![1]);
        for header in [None, Some("not-base64"), Some("e30.invalid")] {
            assert!(read_binary(&body, header, 4, "文件").is_err());
        }
        assert!(read_binary(&body, Some(&"x".repeat(10925)), 4, "文件").is_err());
        let unknown = base64::engine::general_purpose::STANDARD.encode(r#"{"unknown":"value"}"#);
        assert!(read_binary(&body, Some(&unknown), 4, "文件").is_err());
    }
}
