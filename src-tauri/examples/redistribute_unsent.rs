//! Explicit database maintenance. Does not create a Tauri app or start SMTP/schedulers.
use std::{path::PathBuf, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(
        args.next()
            .ok_or("usage: redistribute_unsent DATABASE [--apply]")?,
    );
    let mut apply = false;
    let mut append_recipient = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--apply" => apply = true,
            "--append-recipient" => {
                append_recipient = Some(args.next().ok_or("missing recipient")?)
            }
            _ => return Err("unknown argument".into()),
        }
    }
    let mut conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let backup = if apply {
        let folder = path
            .parent()
            .ok_or("database has no parent")?
            .join("backups");
        std::fs::create_dir_all(&folder)?;
        let backup = folder.join(format!(
            "before-editor-redistribution-{}.sqlite",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        if backup.exists() {
            return Err("backup already exists".into());
        }
        conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])?;
        Some(backup)
    } else {
        None
    };
    let results = app_lib::editor_selection::redistribute_unsent_with_recipient(
        &mut conn,
        apply,
        append_recipient.as_deref(),
    )?;
    let report = serde_json::json!({"applied":apply,"backup":backup,"plans":results});
    if apply {
        let report_path = path.parent().unwrap().join("backups").join(format!(
            "editor-redistribution-{}.json",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        std::fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
        eprintln!("Audit: {}", report_path.display());
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
