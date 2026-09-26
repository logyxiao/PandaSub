use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[derive(serde::Serialize)]
pub struct StorageSummary {
    database_bytes: u64,
    cache_bytes: i64,
    cache_messages: i64,
    protected_messages: i64,
    backup_bytes: u64,
    backup_count: usize,
}
// Keep offline-only copies when the account/namespace is no longer available.
const RECOVERABLE: &str = "EXISTS (SELECT 1 FROM accounts a WHERE a.id=r.account_id
    AND a.imap_generation=r.imap_generation AND r.imap_uid_validity>0
    AND a.imap_uid_validity=r.imap_uid_validity AND a.imap_host<>'' AND a.password<>'')";

fn backups(root: &Path) -> Result<Vec<(PathBuf, std::time::SystemTime, u64)>, String> {
    let dir = root.join("backups");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let owned_name = name
            .strip_prefix("novelsub_backup_")
            .and_then(|name| name.strip_suffix(".sqlite"))
            .is_some_and(|body| {
                let parts: Vec<_> = body.split('_').collect();
                (1..=2).contains(&parts.len())
                    && parts.iter().all(|part| {
                        !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
                    })
            });
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() || !owned_name {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        files.push((
            entry.path(),
            metadata.modified().map_err(|e| e.to_string())?,
            metadata.len(),
        ));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    Ok(files)
}
fn summary(conn: &Connection, root: &Path) -> Result<StorageSummary, String> {
    let (cache_messages, contents): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(length(CAST(json AS BLOB))),0) FROM reply_contents",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let attachments: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(length(data)),0) FROM reply_files",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let protected_messages = conn.query_row(&format!("SELECT COUNT(*) FROM reply_contents c JOIN replies r ON r.id=c.reply_id WHERE NOT ({RECOVERABLE})"), [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let backups = backups(root)?;
    let mut database_bytes = 0;
    for name in [
        "novelsub.sqlite",
        "novelsub.sqlite-wal",
        "novelsub.sqlite-shm",
    ] {
        match std::fs::metadata(root.join(name)) {
            Ok(metadata) => database_bytes += metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(StorageSummary {
        database_bytes,
        cache_bytes: contents + attachments,
        cache_messages,
        protected_messages,
        backup_count: backups.len(),
        backup_bytes: backups.iter().map(|file| file.2).sum(),
    })
}

pub(crate) fn cache_generation(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM settings WHERE key='mail.cache_generation'",
        [],
        |r| r.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|e| e.to_string())
}
fn clear_mail_cache(conn: &mut Connection, keep: usize) -> Result<usize, String> {
    if ![0, 100, 500, 1000].contains(&keep) {
        return Err("缓存保留数量无效".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO settings(key,value) VALUES('mail.cache_generation','1')
        ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Use a temporary target set so both cache tables use exactly the same IDs.
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS cache_cleanup_ids(id INTEGER PRIMARY KEY); DELETE FROM cache_cleanup_ids;").map_err(|e|e.to_string())?;
    tx.execute(&format!("INSERT INTO cache_cleanup_ids SELECT c.reply_id FROM reply_contents c JOIN replies r ON r.id=c.reply_id
        WHERE {RECOVERABLE} ORDER BY r.received_at DESC,r.id DESC LIMIT -1 OFFSET ?1"), [keep as i64]).map_err(|e|e.to_string())?;
    tx.execute(
        "DELETE FROM reply_files WHERE reply_id IN (SELECT id FROM cache_cleanup_ids)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let count = tx
        .execute(
            "DELETE FROM reply_contents WHERE reply_id IN (SELECT id FROM cache_cleanup_ids)",
            [],
        )
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM cache_cleanup_ids", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}
fn clear_backups(root: &Path, keep: usize) -> Result<usize, String> {
    if ![1, 5, 10, 20].contains(&keep) {
        return Err("备份保留数量无效".into());
    }
    let mut removed = 0;
    for (path, _, _) in backups(root)?.into_iter().skip(keep) {
        match std::fs::remove_file(path) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("已清理 {removed} 份备份，后续清理失败：{error}")),
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn get_storage_summary(app: AppHandle) -> Result<StorageSummary, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = Connection::open_with_flags(
            root.join("novelsub.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let result = summary(&tx, &root)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn clean_storage(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: String,
    keep: usize,
) -> Result<usize, String> {
    let db = state.db.clone();
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match scope.as_str() {
        "mail_cache" => {
            let mut conn = db.lock().map_err(|e| e.to_string())?;
            clear_mail_cache(&mut conn, keep)
        }
        "backups" => clear_backups(&root, keep),
        _ => Err("清理范围无效".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("novelsub-storage-{}", rand::random::<u128>()));
        std::fs::create_dir_all(root.join("backups")).unwrap();
        root
    }
    #[test]
    fn cache_cleanup_preserves_mail_metadata_and_offline_only_copies() {
        let root = root();
        let mut conn = crate::db::open_database(root.join("novelsub.sqlite")).unwrap();
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host,imap_host,imap_uid_validity,imap_generation) VALUES(1,'fixture@example.com','fixture','localhost','localhost',10,1)",[]).unwrap();
        for id in 1..=104 {
            conn.execute("INSERT INTO replies(id,account_id,imap_uid,imap_uid_validity,imap_generation,kind,subject,body,is_read,read_synced) VALUES(?1,1,?1,10,1,'human','保留标题','保留正文',0,1)",[id]).unwrap();
            conn.execute(
                "INSERT INTO reply_contents(reply_id,json) VALUES(?1,'{}')",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO reply_files(reply_id,part_index,data) VALUES(?1,1,X'010203')",
                [id],
            )
            .unwrap();
        }
        // Deleted account and old namespace cache entries must not be removed.
        conn.execute("UPDATE replies SET account_id=999 WHERE id=1", [])
            .unwrap();
        conn.execute("UPDATE replies SET imap_generation=0 WHERE id=2", [])
            .unwrap();
        let before = summary(&conn, &root).unwrap();
        assert_eq!(before.cache_messages, 104);
        assert_eq!(before.protected_messages, 2);
        let old_generation = cache_generation(&conn).unwrap();
        assert!(clear_mail_cache(&mut conn, 99).is_err());
        assert_eq!(cache_generation(&conn).unwrap(), old_generation);
        assert_eq!(clear_mail_cache(&mut conn, 100).unwrap(), 2);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM reply_contents WHERE reply_id IN (3,4)",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM reply_contents WHERE reply_id=104",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(clear_mail_cache(&mut conn, 0).unwrap(), 100);
        assert!(cache_generation(&conn).unwrap() > old_generation);
        let after = summary(&conn, &root).unwrap();
        assert_eq!(after.cache_messages, 2);
        assert_eq!(after.cache_bytes, 10);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM replies WHERE body='保留正文' AND is_read=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            104
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM reply_files", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn backup_cleanup_only_removes_completed_owned_backups_and_keeps_newest() {
        let root = root();
        for name in [
            "novelsub_backup_1.sqlite",
            "novelsub_backup_2.sqlite",
            "novelsub_backup_active.sqlite.tmp",
            "other.sqlite",
            "novelsub_backup_notes.sqlite",
        ] {
            std::fs::write(root.join("backups").join(name), b"fixture").unwrap();
        }
        let newest = backups(&root).unwrap()[0].0.clone();
        assert!(clear_backups(&root, 0).is_err());
        assert_eq!(clear_backups(&root, 1).unwrap(), 1);
        assert!(newest.exists());
        assert!(root
            .join("backups/novelsub_backup_active.sqlite.tmp")
            .exists());
        assert!(root.join("backups/other.sqlite").exists());
        assert!(root.join("backups/novelsub_backup_notes.sqlite").exists());
        assert_eq!(clear_backups(&root, 1).unwrap(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
