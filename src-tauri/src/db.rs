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
  send_interval_from_sec INTEGER NOT NULL DEFAULT 100,
  send_interval_to_sec INTEGER NOT NULL DEFAULT 240,
  subject TEXT NOT NULL DEFAULT '',
  mail_templates TEXT NOT NULL DEFAULT '[]',
  fixed_mail_template_id TEXT NOT NULL DEFAULT '',
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
  manuscript_id INTEGER,
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

CREATE TABLE IF NOT EXISTS outgoing_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  run_id INTEGER NOT NULL,
  increment_task_progress INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL,
  manuscript_id INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','not_sent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS outgoing_pending_manuscript
  ON outgoing_attempts(manuscript_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outgoing_task_status ON outgoing_attempts(task_id, status);

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

CREATE TABLE IF NOT EXISTS editor_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS editor_group_members (
  group_id INTEGER NOT NULL,
  editor_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, editor_id)
);
CREATE INDEX IF NOT EXISTS editor_group_members_editor ON editor_group_members(editor_id);
CREATE INDEX IF NOT EXISTS editor_group_members_group_position ON editor_group_members(group_id, position);
"#;

pub fn open_database(path: PathBuf) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = OFF;",
        )
        .map_err(|e| e.to_string())?;
    migrate(&connection)?;
    connection
        .execute_batch(SCHEMA)
        .map_err(|e| e.to_string())?;
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
    normalize_unknown_editor_platforms(&connection)?;
    normalize_editor_work_type_aliases(&connection)?;
    backfill_editor_rejected_types(&connection)?;
    backfill_missing_editor_types(&connection)?;
    repair_editor_types_and_platforms(&connection)?;
    drop_press_and_magazine_editors(&connection)?;
    drop_longform_editors(&connection)?;
    drop_script_editors(&connection)?;
    add_task_account_columns(&connection)?;
    add_task_log_recipient_column(&connection)?;
    backfill_manual_log_manuscripts(&connection)?;
    add_manuscript_file_column(&connection)?;
    add_manuscript_account_ids_column(&connection)?;
    add_manuscript_mail_templates_column(&connection)?;
    add_manuscript_fixed_mail_template_column(&connection)?;
    add_manuscript_send_interval_column(&connection)?;
    add_manuscript_send_interval_seconds_columns(&connection)?;
    add_reply_accepted_column(&connection)?;
    migrate_delivery_reliability(&connection)?;
    add_runtime_query_indexes(&connection)?;
    repair_orphan_relations(&connection)?;
    reclassify_autoreply_history(&connection)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

fn add_runtime_query_indexes(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!("CREATE INDEX IF NOT EXISTS deliveries_summary_recipient ON deliveries(manuscript_id, {}, id DESC);",
        crate::store::delivery_recipient_sql("recipient"))).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS deliveries_message_id ON deliveries(message_id);
        CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS replies_received_at ON replies(received_at);
        CREATE INDEX IF NOT EXISTS task_logs_level_id ON task_logs(level, id DESC);
        CREATE INDEX IF NOT EXISTS task_logs_level_created ON task_logs(level, created_at);",
    )
    .map_err(|e| e.to_string())
}

/// Additive migration: retain historical deliveries and isolate future send rounds.
fn migrate_delivery_reliability(conn: &Connection) -> Result<(), String> {
    if crate::store::setting_exists(conn, "schema.delivery_reliability.v1")? {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    ensure_columns(
        &tx,
        "accounts",
        &[(
            "imap_uid_validity",
            "imap_uid_validity INTEGER NOT NULL DEFAULT 0",
        )],
    )?;
    ensure_columns(
        &tx,
        "replies",
        &[(
            "imap_uid_validity",
            "imap_uid_validity INTEGER NOT NULL DEFAULT 0",
        )],
    )?;
    ensure_columns(
        &tx,
        "accounts",
        &[(
            "imap_generation",
            "imap_generation INTEGER NOT NULL DEFAULT 0",
        )],
    )?;
    ensure_columns(
        &tx,
        "replies",
        &[(
            "imap_generation",
            "imap_generation INTEGER NOT NULL DEFAULT 0",
        )],
    )?;
    ensure_columns(
        &tx,
        "tasks",
        &[("run_id", "run_id INTEGER NOT NULL DEFAULT 0")],
    )?;
    ensure_columns(
        &tx,
        "deliveries",
        &[("run_id", "run_id INTEGER NOT NULL DEFAULT 0")],
    )?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS account_ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
         CREATE TABLE IF NOT EXISTS task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT);
         INSERT OR IGNORE INTO account_ids(id)
         SELECT id FROM accounts UNION SELECT account_id FROM deliveries WHERE account_id IS NOT NULL
         UNION SELECT account_id FROM replies WHERE account_id IS NOT NULL
         UNION SELECT account_id FROM task_logs WHERE account_id IS NOT NULL;
         DROP INDEX IF EXISTS replies_account_uid;
         CREATE UNIQUE INDEX IF NOT EXISTS replies_account_validity_uid
             ON replies(account_id, imap_generation, imap_uid_validity, imap_uid);
         CREATE INDEX IF NOT EXISTS deliveries_sent_at ON deliveries(sent_at, account_id);
         CREATE INDEX IF NOT EXISTS deliveries_account_sent ON deliveries(account_id, sent_at);
         CREATE INDEX IF NOT EXISTS deliveries_task_run ON deliveries(task_id, run_id, manuscript_id);
         CREATE INDEX IF NOT EXISTS replies_task_kind ON replies(task_id, kind, id DESC);
         CREATE INDEX IF NOT EXISTS replies_account_message ON replies(account_id, imap_generation, message_id);
         CREATE INDEX IF NOT EXISTS editors_email_lower ON editors(lower(email));"
    ).map_err(|e| e.to_string())?;
    // Reserve even deleted account IDs still referenced by a saved plan. Never turn
    // a selected-but-missing account into the empty-list (= all accounts) fallback.
    for table in ["tasks", "manuscripts"] {
        let mut stmt = tx
            .prepare(&format!("SELECT account_ids FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            for id in serde_json::from_str::<Vec<i64>>(&row.map_err(|e| e.to_string())?)
                .unwrap_or_default()
            {
                if id > 0 {
                    tx.execute("INSERT OR IGNORE INTO account_ids(id) VALUES (?1)", [id])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    crate::store::mark_setting(&tx, "schema.delivery_reliability.v1")?;
    tx.commit().map_err(|e| e.to_string())
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
        "task_logs",
        &[("manuscript_id", "manuscript_id INTEGER")],
    )?;
    ensure_columns(
        connection,
        "tasks",
        &[
            (
                "manuscript_ids",
                "manuscript_ids TEXT NOT NULL DEFAULT '[]'",
            ),
            ("account_ids", "account_ids TEXT NOT NULL DEFAULT '[]'"),
            ("status", "status TEXT NOT NULL DEFAULT 'stopped'"),
            (
                "schedule_type",
                "schedule_type TEXT NOT NULL DEFAULT 'immediate'",
            ),
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
        (
            "reader_category",
            "reader_category TEXT NOT NULL DEFAULT ''",
        ),
        ("reader_emotion", "reader_emotion TEXT NOT NULL DEFAULT ''"),
        ("style", "style TEXT NOT NULL DEFAULT ''"),
        ("genres", "genres TEXT NOT NULL DEFAULT '[]'"),
        (
            "excluded_types",
            "excluded_types TEXT NOT NULL DEFAULT '[]'",
        ),
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

fn normalize_unknown_editor_platforms(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE editors SET platform = '未知', updated_at = datetime('now','localtime')
         WHERE TRIM(COALESCE(platform, '')) = ''",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn normalize_editor_work_type_aliases(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, work_type, rejected_types FROM editors")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    for (id, raw_work, raw_rejected) in rows {
        let (Ok(work), Ok(rejected)) = (
            serde_json::from_str::<Vec<String>>(&raw_work),
            serde_json::from_str::<Vec<String>>(&raw_rejected),
        ) else {
            continue;
        };
        let next_work = crate::models::normalize_editor_work_types(&work);
        let next_rejected = crate::models::normalize_editor_work_types(&rejected);
        if next_work == work && next_rejected == rejected {
            continue;
        }
        conn.execute(
            "UPDATE editors SET work_type = ?1, rejected_types = ?2,
             updated_at = datetime('now','localtime') WHERE id = ?3",
            rusqlite::params![
                serde_json::to_string(&next_work).map_err(|e| e.to_string())?,
                serde_json::to_string(&next_rejected).map_err(|e| e.to_string())?,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
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
        conn.execute("DELETE FROM editors WHERE channel IN ('报刊', '杂志')", [])
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
        if style_cleared
            && next_work
                == crate::models::normalize_editor_work_types(
                    &serde_json::from_str::<Vec<String>>(&raw_work).unwrap_or_default(),
                )
        {
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

const BUNDLED_EDITOR_LIBRARY_VERSION: &str = "2026-09-02-local-library";

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
            if source
                .as_deref()
                .unwrap_or(crate::models::EDITOR_SOURCE_INITIAL)
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

fn backfill_manual_log_manuscripts(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE task_logs AS log
         SET manuscript_id = (
           SELECT delivery.manuscript_id FROM deliveries AS delivery
           WHERE delivery.task_id IS NULL
             AND delivery.account_id = log.account_id
             AND instr(lower(log.recipient), lower(delivery.recipient)) > 0
             AND abs(strftime('%s', delivery.sent_at) - strftime('%s', log.created_at)) <= 2
           ORDER BY delivery.id DESC
           LIMIT 1
         )
         WHERE log.manuscript_id IS NULL AND log.task_id IS NULL
           AND log.message = '手动发送成功'",
        [],
    )
    .map_err(|e| e.to_string())?;
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
        let replies = crate::store::load_replies(conn, None, None, 100_000).unwrap_or_default();
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

fn add_manuscript_fixed_mail_template_column(conn: &Connection) -> Result<(), String> {
    if table_lacks_column(conn, "manuscripts", "fixed_mail_template_id") {
        conn.execute(
            "ALTER TABLE manuscripts ADD COLUMN fixed_mail_template_id TEXT NOT NULL DEFAULT ''",
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

fn add_manuscript_send_interval_seconds_columns(conn: &Connection) -> Result<(), String> {
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

    let add_from = table_lacks_column(conn, "manuscripts", "send_interval_from_sec");
    let add_to = table_lacks_column(conn, "manuscripts", "send_interval_to_sec");
    if add_from {
        conn.execute(
            "ALTER TABLE manuscripts ADD COLUMN send_interval_from_sec INTEGER NOT NULL DEFAULT 100",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    if add_to {
        conn.execute(
            "ALTER TABLE manuscripts ADD COLUMN send_interval_to_sec INTEGER NOT NULL DEFAULT 240",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    if add_from || add_to {
        conn.execute(
            "UPDATE manuscripts SET
                send_interval_from_sec = CASE send_interval_min
                    WHEN 1 THEN 50 WHEN 2 THEN 108 WHEN 5 THEN 288 WHEN 8 THEN 468 ELSE 100 END,
                send_interval_to_sec = CASE send_interval_min
                    WHEN 1 THEN 70 WHEN 2 THEN 132 WHEN 5 THEN 312 WHEN 8 THEN 492 ELSE 240 END",
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
    fn manual_log_backfill_links_matching_delivery() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE task_logs (
                    id INTEGER PRIMARY KEY, task_id INTEGER, manuscript_id INTEGER,
                    account_id INTEGER, message TEXT, recipient TEXT, created_at TEXT
                 );
                 CREATE TABLE deliveries (
                    id INTEGER PRIMARY KEY, task_id INTEGER, manuscript_id INTEGER,
                    account_id INTEGER, recipient TEXT, sent_at TEXT
                 );
                 INSERT INTO task_logs VALUES
                    (1, NULL, NULL, 2, '手动发送成功', '编辑 <editor@example.com>', '2026-01-01 10:00:00'),
                    (2, NULL, NULL, 2, '手动发送成功', 'other@example.com', '2026-01-01 10:00:00');
                 INSERT INTO deliveries VALUES
                    (3, NULL, 10, 2, 'editor@example.com', '2026-01-01 10:00:01');",
            )
            .unwrap();

        backfill_manual_log_manuscripts(&connection).unwrap();

        let linked: Option<i64> = connection
            .query_row(
                "SELECT manuscript_id FROM task_logs WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let unmatched: Option<i64> = connection
            .query_row(
                "SELECT manuscript_id FROM task_logs WHERE id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(linked, Some(10));
        assert_eq!(unmatched, None);
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
            .query_row("SELECT task_id FROM deliveries WHERE id = 10", [], |row| {
                row.get(0)
            })
            .unwrap();
        let orphan_delivery_task: Option<i64> = connection
            .query_row("SELECT task_id FROM deliveries WHERE id = 11", [], |row| {
                row.get(0)
            })
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

    #[test]
    fn fixed_mail_template_column_is_added_with_random_default() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE manuscripts (id INTEGER PRIMARY KEY); INSERT INTO manuscripts (id) VALUES (1);")
            .unwrap();

        add_manuscript_fixed_mail_template_column(&connection).unwrap();

        let fixed_id: String = connection
            .query_row(
                "SELECT fixed_mail_template_id FROM manuscripts WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fixed_id, "");
    }

    #[test]
    fn legacy_send_intervals_are_migrated_to_second_ranges() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE manuscripts (
                    id INTEGER PRIMARY KEY,
                    send_interval_min INTEGER NOT NULL DEFAULT 3
                 );
                 INSERT INTO manuscripts (id, send_interval_min) VALUES
                    (1, 1), (2, 2), (3, 3), (4, 5), (5, 8);",
            )
            .unwrap();

        add_manuscript_send_interval_seconds_columns(&connection).unwrap();

        let ranges = (1..=5)
            .map(|id| {
                connection
                    .query_row(
                        "SELECT send_interval_from_sec, send_interval_to_sec FROM manuscripts WHERE id = ?1",
                        [id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            ranges,
            vec![(50, 70), (108, 132), (100, 240), (288, 312), (468, 492)]
        );
    }
}

#[cfg(test)]
pub(crate) fn test_database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    migrate_delivery_reliability(&conn).unwrap();
    add_runtime_query_indexes(&conn).unwrap();
    conn
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    use crate::{state::TaskHandle, store};
    use std::{collections::HashMap, sync::Arc};

    fn connection() -> Connection {
        test_database()
    }

    fn seed(conn: &Connection) {
        conn.execute_batch("INSERT INTO accounts (id,email,password,smtp_host) VALUES (1,'sender@example.com','fixture','localhost');
            INSERT INTO manuscripts (id,title,body,recipients) VALUES (1,'作品','正文','[\"a@example.com\",\"b@example.com\",\"c@example.com\"]');
            INSERT INTO tasks (id,name,manuscript_ids,account_ids) VALUES (1,'计划','[1]','[1]');").unwrap();
    }

    fn deliver(conn: &mut Connection, recipient: &str, task_id: Option<i64>) {
        store::record_successful_delivery(
            conn,
            store::SuccessfulDelivery {
                task_id,
                account_id: 1,
                manuscript_id: 1,
                recipient,
                subject: "投稿",
                message_id: &crate::smtp::make_message_id(),
                increment_task_progress: task_id.is_some(),
            },
        )
        .unwrap();
    }

    #[test]
    fn account_ids_never_reuse_deleted_or_dangling_plan_ids() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        seed(&conn);
        conn.execute("UPDATE tasks SET account_ids = '[1,99]'", [])
            .unwrap();
        migrate_delivery_reliability(&conn).unwrap();
        let first = store::reserve_account_id(&conn).unwrap();
        assert_eq!(first, 100);
        conn.execute("INSERT INTO accounts(id,email,password,smtp_host) VALUES(?1,'next@example.com','fixture','localhost')", [first]).unwrap();
        conn.execute("DELETE FROM accounts WHERE id = ?1", [first])
            .unwrap();
        migrate_delivery_reliability(&conn).unwrap();
        assert_eq!(store::reserve_account_id(&conn).unwrap(), 101);
        assert_eq!(
            store::load_task(&conn, 1).unwrap().unwrap().account_ids,
            vec![1, 99]
        );
    }

    #[test]
    fn resend_stop_resume_only_deduplicates_current_round() {
        let mut conn = connection();
        seed(&conn);
        for recipient in ["a@example.com", "b@example.com", "c@example.com"] {
            deliver(&mut conn, recipient, Some(1));
        }
        store::mark_task_finished(&conn, 1, "completed").unwrap();
        store::reset_task_progress(&conn, 1).unwrap();
        assert!(store::delivered_emails_for_task_manuscript(&conn, 1, 1)
            .unwrap()
            .is_empty());
        store::mark_task_running(&conn, 1).unwrap();
        deliver(&mut conn, "a@example.com", Some(1));
        store::mark_task_finished(&conn, 1, "stopped").unwrap();
        store::mark_task_running(&conn, 1).unwrap();
        let sent = store::delivered_emails_for_task_manuscript(&conn, 1, 1).unwrap();
        assert_eq!(sent, ["a@example.com".to_string()].into_iter().collect());
        // Manual delivery during a stopped round belongs to that round, not the next.
        store::mark_task_finished(&conn, 1, "stopped").unwrap();
        deliver(&mut conn, "b@example.com", None);
        assert_eq!(
            store::delivered_emails_for_task_manuscript(&conn, 1, 1)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(store::load_task(&conn, 1).unwrap().unwrap().sent, 2);
        store::reset_task_progress(&conn, 1).unwrap();
        assert!(store::delivered_emails_for_task_manuscript(&conn, 1, 1)
            .unwrap()
            .is_empty());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM deliveries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            5
        );
    }

    #[test]
    fn reliability_migration_preserves_legacy_resume_progress() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        seed(&conn);
        conn.execute_batch("UPDATE tasks SET sent=1,status='stopped';
            INSERT INTO deliveries(task_id,account_id,manuscript_id,recipient,message_id) VALUES(1,1,1,'a@example.com','old');").unwrap();
        migrate_delivery_reliability(&conn).unwrap();
        migrate_delivery_reliability(&conn).unwrap();
        assert_eq!(store::load_task(&conn, 1).unwrap().unwrap().sent, 1);
        assert!(store::delivered_emails_for_task_manuscript(&conn, 1, 1)
            .unwrap()
            .contains("a@example.com"));
    }

    #[test]
    fn active_and_paused_tasks_lock_config() {
        let conn = connection();
        seed(&conn);
        let handle = Arc::new(TaskHandle::new());
        let mut registry = HashMap::from([(1, handle.clone())]);
        assert!(store::ensure_manuscript_idle(&conn, &registry, 1).is_err());
        assert!(store::ensure_account_idle(&conn, &registry, 1).is_err());
        assert!(store::ensure_account_idle(&conn, &registry, 2).is_ok());
        handle.pause();
        assert!(store::ensure_manuscript_idle(&conn, &registry, 1).is_err());
        handle.stop(); // still locked until the worker exits
        assert!(store::ensure_manuscript_idle(&conn, &registry, 1).is_err());
        registry.clear();
        assert!(store::ensure_manuscript_idle(&conn, &registry, 1).is_ok());
    }

    #[test]
    fn stopped_handle_is_never_resurrected() {
        let handle = TaskHandle::new();
        handle.stop();
        handle.pause();
        handle.resume();
        assert!(handle.is_stopped());
    }

    #[test]
    fn mailbox_generation_preserves_old_replies_and_accepts_reused_uids() {
        let conn = connection();
        seed(&conn);
        conn.execute("UPDATE accounts SET imap_uid=500, imap_uid_validity=10", [])
            .unwrap();
        store::mark_setting(&conn, "replies.autoreply_match_backfill.v1.1").unwrap();
        let insert = |generation, message: &str| {
            store::insert_reply(
                &conn,
                None,
                1,
                Some(1),
                "editor@example.com",
                "回复",
                "摘录",
                "内容",
                "human",
                "人工",
                false,
                message,
                "original",
                7,
                10,
                generation,
                "2026-01-02 03:04:05",
            )
            .unwrap()
        };
        let old = insert(0, "old-message");
        store::reset_account_mailbox(&conn, 1).unwrap();
        let account = store::load_account(&conn, 1).unwrap().unwrap();
        assert_eq!(
            (
                account.imap_uid,
                account.imap_uid_validity,
                account.imap_generation
            ),
            (0, 0, 1)
        );
        assert!(!store::setting_exists(&conn, "replies.autoreply_match_backfill.v1.1").unwrap());
        assert!(!store::reply_exists(&conn, &account, 7, 10, "new-message").unwrap());
        let new = insert(1, "new-message");
        assert_ne!(old.id, new.id);
        assert_eq!(new.received_at, "2026-01-02 03:04:05");
        let page = store::query_replies(&conn, None, None, "", 20, 0).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].received_at, "2026-01-02 03:04:05");
        assert_ne!(page.items[0].created_at, page.items[0].received_at);
        assert!(store::reply_exists(&conn, &account, 7, 10, "").unwrap());
        assert!(!store::reply_exists(&conn, &account, 7, 11, "").unwrap());
        assert!(store::reply_exists(&conn, &account, 8, 11, "new-message").unwrap());
    }

    #[test]
    fn replies_page_and_search_include_records_older_than_300() {
        let mut conn = connection();
        seed(&conn);
        conn.execute(
            "INSERT INTO editors(name,email,platform) VALUES('老编辑','old@example.com','平台甲')",
            [],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        for uid in 1..=305 {
            tx.execute("INSERT INTO replies(account_id,imap_uid,task_id,kind,from_email,body,accepted) VALUES(1,?1,1,'human',?2,?3,?4)",
                rusqlite::params![uid, if uid==1 {"old@example.com"} else {"other@example.com"}, if uid==1 {"最早的回复"} else {"普通回复"}, uid==1]).unwrap();
        }
        tx.commit().unwrap();
        let page = store::query_replies(&conn, None, None, "", 20, 300).unwrap();
        assert_eq!(page.total, 305);
        assert_eq!(page.items.len(), 5);
        assert_eq!(page.items[4].imap_uid, 1);
        for query in ["最早", "老编辑", "平台甲", "OLD@EXAMPLE.COM"] {
            let found =
                store::query_replies(&conn, Some("accepted"), Some(1), query, 20, 0).unwrap();
            assert_eq!(found.total, 1, "{query}");
            assert_eq!(found.items[0].imap_uid, 1);
        }
        assert_eq!(
            store::query_replies(&conn, None, Some(2), "", 20, 0)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            store::query_replies(&conn, None, None, "%", 20, 0)
                .unwrap()
                .total,
            0
        );
    }

    #[test]
    fn plan_history_does_not_expire_after_a_year() {
        let mut conn = connection();
        seed(&conn);
        deliver(&mut conn, "a@example.com", Some(1));
        conn.execute("UPDATE deliveries SET sent_at = '2020-01-01 00:00:00'", [])
            .unwrap();
        assert_eq!(
            store::load_manuscript_deliveries(&conn, 1).unwrap().len(),
            1
        );
        assert_eq!(store::load_account_deliveries(&conn, 1).unwrap().len(), 1);
    }
    #[test]
    fn logs_filter_and_export_cover_old_history_with_literal_email_search() {
        let conn = connection();
        seed(&conn);
        for id in 1..=305 {
            store::insert_send_log(
                &conn,
                Some(1),
                Some(1),
                Some(1),
                if id == 1 { "error" } else { "success" },
                "send",
                "fixture",
                if id == 1 {
                    "old_100%@example.com"
                } else {
                    "other@example.com"
                },
            )
            .unwrap();
        }
        let page = store::query_logs(&conn, None, None, None, 20, 300).unwrap();
        assert_eq!(page.total, 305);
        assert_eq!(page.items.len(), 5);
        assert_eq!(page.items.last().unwrap().id, 1);
        let page = store::query_logs(
            &conn,
            Some(1),
            Some("error"),
            Some(" OLD_100%@EXAMPLE.COM "),
            20,
            -1,
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, 1);
        assert_eq!(
            store::query_logs(&conn, None, None, Some("%"), 20, 0)
                .unwrap()
                .total,
            1
        );
        assert_eq!(
            store::query_logs(&conn, None, None, Some("SENDER@EXAMPLE.COM"), 20, 0)
                .unwrap()
                .total,
            305
        );
        assert_eq!(
            store::query_logs(&conn, Some(2), None, None, 20, 0)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            store::query_logs(&conn, None, Some("success"), Some("old_"), 20, 0)
                .unwrap()
                .total,
            0
        );
        let (exported, accounts) =
            crate::commands::logs::export_rows(&conn, Some(1), Some("error"), Some("old_"))
                .unwrap();
        assert_eq!(exported.iter().map(|l| l.id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(accounts.get(&1).unwrap(), "sender@example.com");
        conn.execute("DELETE FROM accounts WHERE id=1", []).unwrap();
        assert_eq!(
            store::query_logs(&conn, None, None, Some("old_"), 20, 0)
                .unwrap()
                .total,
            1
        );
    }

    #[test]
    fn oversized_log_export_is_reported_instead_of_truncated() {
        let conn = connection();
        conn.execute_batch(
            "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100001)
            INSERT INTO task_logs(level,category,message) SELECT 'info','test','fixture' FROM seq;",
        )
        .unwrap();
        let result = crate::commands::logs::export_rows(&conn, None, None, None);
        assert!(result.unwrap_err().contains("100001"));
        assert!(
            crate::commands::logs::export_rows(&conn, None, Some("error"), None)
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn dashboard_success_survives_log_clear_and_read_does_not_delete_tasks() {
        let mut conn = connection();
        seed(&conn);
        deliver(&mut conn, "a@example.com", Some(1));
        // Boundaries are compared in local dates, including exactly midnight.
        conn.execute(
            "UPDATE deliveries SET sent_at = date('now','localtime') || ' 00:00:00'",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO deliveries(account_id,manuscript_id,recipient,message_id,sent_at)
            VALUES(1,1,'old@example.com','old',date('now','localtime','-1 day') || ' 23:59:59'),
                  (1,1,'future@example.com','future',date('now','localtime','+1 day') || ' 00:00:00');
            INSERT INTO tasks(name,manuscript_ids,status) VALUES('orphan','[999]','running');").unwrap();
        store::insert_send_log(
            &conn,
            Some(1),
            Some(1),
            Some(1),
            "error",
            "send",
            "failure",
            "a@example.com",
        )
        .unwrap();
        let before = crate::commands::dashboard::load_dashboard(&conn).unwrap();
        assert_eq!(before.sent_today, 1);
        assert_eq!(before.failed_today, 1);
        assert_eq!(before.running_tasks, 1);
        conn.execute("DELETE FROM task_logs", []).unwrap();
        let after = crate::commands::dashboard::load_dashboard(&conn).unwrap();
        assert_eq!(after.sent_today, 1);
        assert_eq!(after.failed_today, 0); // failure metrics deliberately derive from logs
        assert_eq!(after.tasks.len(), before.tasks.len());
        assert_eq!(
            store::load_accounts(&conn).unwrap()[0].sent_today,
            after.sent_today
        );
    }

    #[test]
    fn runtime_indexes_install_after_previous_migration_and_are_idempotent() {
        let conn = connection();
        add_runtime_query_indexes(&conn).unwrap();
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM tasks WHERE status='running'",
                [],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("tasks_status"), "{plan}");
        let plan: String = conn.query_row("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM deliveries WHERE sent_at >= date('now','localtime') AND sent_at < date('now','localtime','+1 day')", [], |r| r.get(3)).unwrap();
        assert!(plan.contains("deliveries_sent_at"), "{plan}");
        let plan: String = conn.query_row("EXPLAIN QUERY PLAN SELECT id FROM task_logs WHERE level='error' ORDER BY id DESC LIMIT 20", [], |r| r.get(3)).unwrap();
        assert!(plan.contains("task_logs_level_id"), "{plan}");
    }
    #[test]
    fn manual_progress_ignores_duplicate_manuscript_ids_and_blank_recipients() {
        let mut conn = connection();
        seed(&conn);
        conn.execute_batch(r#"UPDATE tasks SET manuscript_ids='[1,1]';
            UPDATE manuscripts SET recipients='["编辑甲 <a@example.com>", "A@example.com", "  ", "b@example.com"]';"#).unwrap();
        deliver(&mut conn, "a@example.com", None);
        let task = store::load_task(&conn, 1).unwrap().unwrap();
        assert_eq!((task.sent, task.total), (1, 2));
    }
    #[test]
    fn failed_delivery_record_rolls_back_progress_and_account_bookkeeping() {
        let mut conn = connection();
        seed(&conn);
        conn.execute_batch("CREATE TRIGGER deny_delivery AFTER INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;").unwrap();
        let result = store::record_successful_delivery(
            &mut conn,
            store::SuccessfulDelivery {
                task_id: Some(1),
                account_id: 1,
                manuscript_id: 1,
                recipient: "a@example.com",
                subject: "fixture",
                message_id: "fixture",
                increment_task_progress: true,
            },
        );
        assert!(result.is_err());
        assert_eq!(store::load_task(&conn, 1).unwrap().unwrap().sent, 0);
        assert!(store::load_account(&conn, 1)
            .unwrap()
            .unwrap()
            .last_sent_at
            .is_none());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM deliveries", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
