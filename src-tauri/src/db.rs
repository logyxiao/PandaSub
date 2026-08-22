use rusqlite::Connection;
use std::path::PathBuf;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL DEFAULT 465,
  sender_name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'qq',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  imap_host TEXT NOT NULL DEFAULT '',
  imap_port INTEGER NOT NULL DEFAULT 993,
  check_replies INTEGER NOT NULL DEFAULT 1,
  imap_uid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS manuscripts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  recipients TEXT NOT NULL DEFAULT '[]',
  sender_name TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  reader_category TEXT NOT NULL DEFAULT '',
  reader_emotion TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  genres TEXT NOT NULL DEFAULT '[]',
  excluded_types TEXT NOT NULL DEFAULT '[]',
  account_ids TEXT NOT NULL DEFAULT '[]',
  send_interval_min INTEGER NOT NULL DEFAULT 3,
  subject TEXT NOT NULL DEFAULT '',
  mail_templates TEXT NOT NULL DEFAULT '[]',
  file_name TEXT NOT NULL DEFAULT '',
  file_data BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  manuscript_ids TEXT NOT NULL DEFAULT '[]',
  account_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'stopped',
  schedule_type TEXT NOT NULL DEFAULT 'immediate',
  scheduled_at TEXT,
  retry_max INTEGER NOT NULL DEFAULT 3,
  sent INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER,
  account_id INTEGER,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  task_id INTEGER,
  account_id INTEGER,
  manuscript_id INTEGER,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  delivery_id INTEGER,
  account_id INTEGER,
  task_id INTEGER,
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  accepted INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  imap_uid INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS replies_account_uid ON replies(account_id, imap_uid);
CREATE INDEX IF NOT EXISTS deliveries_task_manuscript ON deliveries(task_id, manuscript_id);
CREATE INDEX IF NOT EXISTS deliveries_manuscript_recipient ON deliveries(manuscript_id, recipient);
CREATE INDEX IF NOT EXISTS task_logs_task_id ON task_logs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS tasks_schedule_due ON tasks(schedule_type, status, scheduled_at);

CREATE TABLE IF NOT EXISTS editors (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  style TEXT NOT NULL DEFAULT '[]',
  work_type TEXT NOT NULL DEFAULT '[]',
  rejected_types TEXT NOT NULL DEFAULT '[]',
  channel TEXT NOT NULL DEFAULT '',
  reader TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '手动数据',
  enabled INTEGER NOT NULL DEFAULT 1,
  favorited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
"#;

pub fn open_database(path: PathBuf) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;")
        .map_err(|e| e.to_string())?;
    migrate(&connection)?;
    connection.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    add_account_imap_columns(&connection)?;
    add_manuscript_plan_columns(&connection)?;
    add_editor_enabled_column(&connection)?;
    add_editor_favorited_column(&connection)?;
    add_editor_rejected_types_column(&connection)?;
    add_editor_tag_columns(&connection)?;
    add_editor_profile_columns(&connection)?;
    classify_builtin_editor_sources(&connection)?;
    migrate_editor_directions(&connection)?;
    normalize_editor_style_values(&connection)?;
    seed_default_editors(&connection)?;
    refresh_bundled_editor_library(&connection)?;
    backfill_editor_rejected_types(&connection)?;
    backfill_missing_editor_types(&connection)?;
    repair_editor_types_and_platforms(&connection)?;
    drop_press_and_magazine_editors(&connection)?;
    drop_longform_editors(&connection)?;
    drop_script_editors(&connection)?;
    add_task_account_columns(&connection)?;
    add_task_log_recipient_column(&connection)?;
    add_manuscript_file_column(&connection)?;
    add_manuscript_account_ids_column(&connection)?;
    add_manuscript_mail_templates_column(&connection)?;
    add_manuscript_send_interval_column(&connection)?;
    add_reply_accepted_column(&connection)?;
    repair_orphan_relations(&connection)?;
    reclassify_autoreply_history(&connection)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

/// Bring legacy/partial schemas forward without deleting user data.
fn migrate(connection: &Connection) -> Result<(), String> {
    ensure_columns(
        connection,
        "accounts",
        &[
            ("password", "password TEXT NOT NULL DEFAULT ''"),
            ("smtp_host", "smtp_host TEXT NOT NULL DEFAULT ''"),
            ("smtp_port", "smtp_port INTEGER NOT NULL DEFAULT 465"),
            ("sender_name", "sender_name TEXT NOT NULL DEFAULT ''"),
            ("provider", "provider TEXT NOT NULL DEFAULT 'qq'"),
            ("enabled", "enabled INTEGER NOT NULL DEFAULT 1"),
            ("last_sent_at", "last_sent_at TEXT"),
            ("imap_host", "imap_host TEXT NOT NULL DEFAULT ''"),
            ("imap_port", "imap_port INTEGER NOT NULL DEFAULT 993"),
            ("check_replies", "check_replies INTEGER NOT NULL DEFAULT 1"),
            ("imap_uid", "imap_uid INTEGER NOT NULL DEFAULT 0"),
            ("created_at", "created_at TEXT NOT NULL DEFAULT ''"),
        ],
    )?;
    ensure_columns(
        connection,
        "tasks",
        &[
            ("manuscript_ids", "manuscript_ids TEXT NOT NULL DEFAULT '[]'"),
            ("account_ids", "account_ids TEXT NOT NULL DEFAULT '[]'"),
            ("status", "status TEXT NOT NULL DEFAULT 'stopped'"),
            ("schedule_type", "schedule_type TEXT NOT NULL DEFAULT 'immediate'"),
            ("scheduled_at", "scheduled_at TEXT"),
            ("retry_max", "retry_max INTEGER NOT NULL DEFAULT 3"),
            ("sent", "sent INTEGER NOT NULL DEFAULT 0"),
            ("total", "total INTEGER NOT NULL DEFAULT 0"),
            ("created_at", "created_at TEXT NOT NULL DEFAULT ''"),
            ("started_at", "started_at TEXT"),
            ("finished_at", "finished_at TEXT"),
        ],
    )?;
    Ok(())
}

fn ensure_columns(
    connection: &Connection,
    table: &str,
    columns: &[(&str, &str)],
) -> Result<(), String> {
    for (name, declaration) in columns {
        if table_lacks_column(connection, table, name) {
            connection
                .execute(&format!("ALTER TABLE {table} ADD COLUMN {declaration}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Returns true when the table exists but is missing the expected column,
/// signalling a legacy schema that must be recreated.
fn table_lacks_column(connection: &Connection, table: &str, column: &str) -> bool {
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return false;
    }
    let has: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            [table, column],
            |r| r.get(0),
        )
        .unwrap_or(0);
    has == 0
}

fn add_account_imap_columns(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'accounts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    for (name, decl) in [
        ("imap_host", "imap_host TEXT NOT NULL DEFAULT ''"),
        ("imap_port", "imap_port INTEGER NOT NULL DEFAULT 993"),
        ("check_replies", "check_replies INTEGER NOT NULL DEFAULT 1"),
        ("imap_uid", "imap_uid INTEGER NOT NULL DEFAULT 0"),
    ] {
        if table_lacks_column(conn, "accounts", name) {
            conn.execute(&format!("ALTER TABLE accounts ADD COLUMN {decl}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    conn.execute(
        "UPDATE accounts SET imap_host = 'imap.qq.com', imap_port = 993
         WHERE provider = 'qq' AND (imap_host IS NULL OR imap_host = '')",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts SET imap_host = 'imap.163.com', imap_port = 993
         WHERE provider = '163' AND (imap_host IS NULL OR imap_host = '')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn add_manuscript_plan_columns(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'manuscripts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    for (name, decl) in [
        ("word_count", "word_count INTEGER NOT NULL DEFAULT 0"),
        ("category", "category TEXT NOT NULL DEFAULT ''"),
        ("reader_category", "reader_category TEXT NOT NULL DEFAULT ''"),
        ("reader_emotion", "reader_emotion TEXT NOT NULL DEFAULT ''"),
        ("style", "style TEXT NOT NULL DEFAULT ''"),
        ("genres", "genres TEXT NOT NULL DEFAULT '[]'"),
        ("excluded_types", "excluded_types TEXT NOT NULL DEFAULT '[]'"),
        ("subject", "subject TEXT NOT NULL DEFAULT ''"),
        ("file_name", "file_name TEXT NOT NULL DEFAULT ''"),
    ] {
        if table_lacks_column(conn, "manuscripts", name) {
            conn.execute(&format!("ALTER TABLE manuscripts ADD COLUMN {decl}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn add_editor_favorited_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "editors", "favorited") {
        conn.execute(
            "ALTER TABLE editors ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_editor_rejected_types_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "editors", "rejected_types") {
        conn.execute(
            "ALTER TABLE editors ADD COLUMN rejected_types TEXT NOT NULL DEFAULT '[]'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_editor_enabled_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "editors", "enabled") {
        conn.execute(
            "ALTER TABLE editors ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_editor_profile_columns(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    for (name, decl) in [
        ("channel", "channel TEXT NOT NULL DEFAULT ''"),
        ("reader", "reader TEXT NOT NULL DEFAULT ''"),
        ("notes", "notes TEXT NOT NULL DEFAULT ''"),
        ("source", "source TEXT NOT NULL DEFAULT '手动数据'"),
    ] {
        if table_lacks_column(conn, "editors", name) {
            conn.execute(&format!("ALTER TABLE editors ADD COLUMN {decl}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn classify_builtin_editor_sources(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.source_classified'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 && !table_lacks_column(conn, "editors", "source") {
        let defaults = crate::models::default_editor_inputs().unwrap_or_default();
        for input in defaults {
            conn.execute(
                "UPDATE editors SET source = ?1
                 WHERE email = ?2 AND (source = '' OR source = ?3)",
                rusqlite::params![
                    crate::models::EDITOR_SOURCE_INITIAL,
                    input.email.trim().to_lowercase(),
                    crate::models::EDITOR_SOURCE_MANUAL
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.source_classified', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn seed_default_editors(conn: &Connection) -> Result<(), String> {
    let seeded: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.default_seeded'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if seeded > 0 {
        return Ok(());
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM editors", [], |r| r.get(0))
        .unwrap_or(0);
    if count == 0 {
        for input in crate::models::default_editor_inputs()? {
            crate::store::upsert_editor(conn, &input, crate::models::EDITOR_SOURCE_INITIAL)?;
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.default_seeded', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn backfill_missing_editor_types(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.types_backfilled'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let extra: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM editors WHERE channel = '剧本'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if extra == 0 {
        // 默认库现在只保留短篇，不再回填其他类型。
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.types_backfilled', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn repair_editor_types_and_platforms(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.short_type_platform_fixed'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 && !table_lacks_column(conn, "editors", "channel") {
        conn.execute(
            "DELETE FROM editors WHERE TRIM(COALESCE(platform, '')) = ''",
            [],
        )
        .map_err(|e| e.to_string())?;

        let defaults = crate::models::default_editor_inputs().unwrap_or_default();
        for input in defaults {
            if input.platform.trim().is_empty() {
                continue;
            }
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM editors WHERE email = ?1",
                    [input.email.trim().to_lowercase()],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if exists == 0 {
                crate::store::upsert_editor(conn, &input, crate::models::EDITOR_SOURCE_INITIAL)?;
            }
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.short_type_platform_fixed', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn drop_press_and_magazine_editors(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.dropped_press_magazine'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 && !table_lacks_column(conn, "editors", "channel") {
        conn.execute(
            "DELETE FROM editors WHERE channel IN ('报刊', '杂志')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.dropped_press_magazine', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn drop_longform_editors(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.dropped_longform'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 && !table_lacks_column(conn, "editors", "channel") {
        conn.execute("DELETE FROM editors WHERE channel = '长篇'", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.dropped_longform', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn drop_script_editors(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.dropped_script'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 && !table_lacks_column(conn, "editors", "channel") {
        conn.execute("DELETE FROM editors WHERE channel = '剧本'", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.dropped_script', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn add_editor_tag_columns(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    for (name, decl) in [
        ("style", "style TEXT NOT NULL DEFAULT '[]'"),
        ("work_type", "work_type TEXT NOT NULL DEFAULT '[]'"),
    ] {
        if table_lacks_column(conn, "editors", name) {
            conn.execute(&format!("ALTER TABLE editors ADD COLUMN {decl}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn migrate_editor_directions(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 || table_lacks_column(conn, "editors", "directions") {
        return Ok(());
    }
    conn.execute(
        "UPDATE editors SET work_type = directions
         WHERE (work_type IS NULL OR work_type = '' OR work_type = '[]')
           AND directions IS NOT NULL AND TRIM(directions) != '' AND directions != '[]'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn normalize_editor_style_values(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 || table_lacks_column(conn, "editors", "style") {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT id, style, work_type FROM editors")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (id, raw_style, raw_work) in rows {
        let mut work_type: Vec<String> = serde_json::from_str(&raw_work).unwrap_or_default();
        let style: Vec<String> = serde_json::from_str(&raw_style).unwrap_or_default();
        work_type.extend(style);
        let next_work = crate::models::normalize_editor_work_types(&work_type);
        let style_cleared = raw_style.trim() == "[]" || raw_style.trim().is_empty();
        if style_cleared && next_work == crate::models::normalize_editor_work_types(
            &serde_json::from_str::<Vec<String>>(&raw_work).unwrap_or_default(),
        ) {
            continue;
        }
        conn.execute(
            "UPDATE editors SET style = '[]', work_type = ?1 WHERE id = ?2",
            rusqlite::params![serde_json::json!(next_work).to_string(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

const BUNDLED_EDITOR_LIBRARY_VERSION: &str = "2026-08-21-calibrated-only";

fn refresh_bundled_editor_library(conn: &Connection) -> Result<(), String> {
    let current: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'editors.library_version'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if current == BUNDLED_EDITOR_LIBRARY_VERSION {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 {
        let defaults = crate::models::default_editor_inputs()?;
        let keep: std::collections::HashSet<String> = defaults
            .iter()
            .map(|input| input.email.trim().to_lowercase())
            .filter(|email| !email.is_empty())
            .collect();
        if !keep.is_empty() {
            let mut stmt = conn
                .prepare("SELECT email FROM editors WHERE source = ?1")
                .map_err(|e| e.to_string())?;
            let stale: Vec<String> = stmt
                .query_map([crate::models::EDITOR_SOURCE_INITIAL], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|email: &String| !keep.contains(&email.trim().to_lowercase()))
                .collect();
            drop(stmt);
            for email in stale {
                conn.execute(
                    "DELETE FROM editors WHERE email = ?1 AND source = ?2",
                    rusqlite::params![email, crate::models::EDITOR_SOURCE_INITIAL],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        for input in defaults {
            let email = input.email.trim().to_lowercase();
            let source: Option<String> = conn
                .query_row(
                    "SELECT source FROM editors WHERE email = ?1",
                    [&email],
                    |r| r.get(0),
                )
                .ok();
            if source.as_deref().unwrap_or(crate::models::EDITOR_SOURCE_INITIAL)
                == crate::models::EDITOR_SOURCE_INITIAL
            {
                crate::store::upsert_editor(conn, &input, crate::models::EDITOR_SOURCE_INITIAL)?;
            }
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.library_version', ?1)",
        [BUNDLED_EDITOR_LIBRARY_VERSION],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn backfill_editor_rejected_types(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'editors.rejected_types_backfill'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'editors'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 || table_lacks_column(conn, "editors", "rejected_types") {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT id, notes, rejected_types FROM editors")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut updates = Vec::new();
    for row in rows {
        let (id, notes, raw) = row.map_err(|e| e.to_string())?;
        let current: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        if !current.is_empty() {
            continue;
        }
        let next = crate::models::extract_rejected_types_from_notes(&notes);
        if next.is_empty() {
            continue;
        }
        updates.push((id, serde_json::json!(next).to_string()));
    }
    drop(stmt);
    for (id, value) in updates {
        conn.execute(
            "UPDATE editors SET rejected_types = ?1 WHERE id = ?2",
            rusqlite::params![value, id],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('editors.rejected_types_backfill', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn add_manuscript_file_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'manuscripts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "manuscripts", "file_data") {
        conn.execute("ALTER TABLE manuscripts ADD COLUMN file_data BLOB", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_task_log_recipient_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'task_logs'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "task_logs", "recipient") {
        conn.execute(
            "ALTER TABLE task_logs ADD COLUMN recipient TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 历史库补 replies.accepted 列（过稿标记）。
fn add_reply_accepted_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'replies'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "replies", "accepted") {
        conn.execute(
            "ALTER TABLE replies ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn repair_orphan_relations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "UPDATE deliveries
         SET task_id = NULL
         WHERE task_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = deliveries.task_id);

         UPDATE replies
         SET task_id = NULL
         WHERE task_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = replies.task_id);

         UPDATE replies
         SET delivery_id = NULL
         WHERE delivery_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM deliveries WHERE deliveries.id = replies.delivery_id);",
    )
    .map_err(|e| e.to_string())
}

fn reclassify_autoreply_history(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'replies.autoreply_subjects_reclassified'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if done > 0 {
        return Ok(());
    }
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'replies'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists > 0 {
        let replies = crate::store::load_replies(conn, None, 100_000).unwrap_or_default();
        for reply in replies {
            if reply.kind == "bounce" || reply.kind == "auto" {
                continue;
            }
            let result = crate::classify::classify(&crate::classify::IncomingMail {
                from: reply.from_email.clone(),
                subject: reply.subject.clone(),
                body: reply.body.clone(),
                content_type: String::new(),
                extra_headers: Vec::new(),
            });
            if result.kind == crate::classify::ReplyKind::Auto {
                crate::store::update_reply_kind(
                    conn,
                    reply.id,
                    result.kind.as_str(),
                    &result.reason,
                    false,
                )?;
            }
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('replies.autoreply_subjects_reclassified', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn add_manuscript_mail_templates_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'manuscripts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "manuscripts", "mail_templates") {
        conn.execute(
            "ALTER TABLE manuscripts ADD COLUMN mail_templates TEXT NOT NULL DEFAULT '[]'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_manuscript_account_ids_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'manuscripts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "manuscripts", "account_ids") {
        conn.execute(
            "ALTER TABLE manuscripts ADD COLUMN account_ids TEXT NOT NULL DEFAULT '[]'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_manuscript_send_interval_column(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'manuscripts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "manuscripts", "send_interval_min") {
        conn.execute(
            "ALTER TABLE manuscripts ADD COLUMN send_interval_min INTEGER NOT NULL DEFAULT 3",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_task_account_columns(conn: &Connection) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'tasks'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok(());
    }
    if table_lacks_column(conn, "tasks", "account_ids") {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN account_ids TEXT NOT NULL DEFAULT '[]'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn legacy_migration_preserves_existing_rows() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "novelsub-legacy-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
                 INSERT INTO accounts (id, email) VALUES (1, 'author@example.com');
                 CREATE TABLE tasks (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 INSERT INTO tasks (id, name) VALUES (7, '旧任务');",
            )
            .unwrap();
        drop(connection);

        let connection = open_database(path.clone()).unwrap();

        let account: (String, String) = connection
            .query_row(
                "SELECT email, password FROM accounts WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let task: (String, String) = connection
            .query_row(
                "SELECT name, manuscript_ids FROM tasks WHERE id = 7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(account, ("author@example.com".into(), String::new()));
        assert_eq!(task, ("旧任务".into(), "[]".into()));
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn orphan_relations_are_detached_without_losing_history() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE tasks (id INTEGER PRIMARY KEY);
                 CREATE TABLE deliveries (id INTEGER PRIMARY KEY, task_id INTEGER);
                 CREATE TABLE replies (id INTEGER PRIMARY KEY, task_id INTEGER, delivery_id INTEGER);
                 INSERT INTO tasks (id) VALUES (1);
                 INSERT INTO deliveries (id, task_id) VALUES (10, 1), (11, 0);
                 INSERT INTO replies (id, task_id, delivery_id) VALUES
                    (20, 1, 10), (21, 0, 999);",
            )
            .unwrap();

        repair_orphan_relations(&connection).unwrap();

        let valid_delivery_task: Option<i64> = connection
            .query_row("SELECT task_id FROM deliveries WHERE id = 10", [], |row| row.get(0))
            .unwrap();
        let orphan_delivery_task: Option<i64> = connection
            .query_row("SELECT task_id FROM deliveries WHERE id = 11", [], |row| row.get(0))
            .unwrap();
        let orphan_reply: (Option<i64>, Option<i64>) = connection
            .query_row(
                "SELECT task_id, delivery_id FROM replies WHERE id = 21",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(valid_delivery_task, Some(1));
        assert_eq!(orphan_delivery_task, None);
        assert_eq!(orphan_reply, (None, None));
    }
}
