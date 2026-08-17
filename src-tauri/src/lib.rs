mod commands;
mod classify;
mod db;
mod inbox;
mod models;
mod scheduler;
mod smtp;
mod state;
mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

use state::{AppState, TaskHandle};

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app.default_window_icon().cloned();
    if let Some(icon) = icon {
        let tray = TrayIconBuilder::new()
            .icon(icon)
            .menu(&menu)
            .tooltip("熊猫投稿")
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    let st = app.state::<AppState>();
                    st.quitting.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
                _ => {}
            })
            .build(app)?;
        app.state::<AppState>().tray.lock().unwrap().replace(tray);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Arc::new(Mutex::new(
                db::open_database(data_dir.join("novelsub.sqlite"))
                    .map_err(std::io::Error::other)?,
            ));
            let tasks: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let quitting = Arc::new(AtomicBool::new(false));

            app.manage(AppState {
                db: db.clone(),
                tasks: tasks.clone(),
                quitting: quitting.clone(),
                tray: Mutex::new(None),
            });

            let auto_backup = {
                let conn = db.lock().unwrap();
                store::load_settings(&conn).map(|s| s.auto_backup).unwrap_or(false)
            };
            if auto_backup {
                if let Err(error) = commands::backup_database(&data_dir) {
                    log::warn!("自动备份失败：{error}");
                }
            }

            build_tray(app)?;

            // 任务 worker 不跨进程存活：重启后数据库里还标着 running / paused 的任务
            // 其实已不在运行，直接标记为 stopped，避免界面出现可点「暂停」却没有 worker 的假任务。
            {
                let conn = db.lock().unwrap();
                let stale: Vec<i64> = {
                    let mut stmt = conn
                        .prepare("SELECT id FROM tasks WHERE status IN ('running', 'paused')")
                        .map_err(std::io::Error::other)?;
                    let rows = stmt
                        .query_map([], |r| r.get::<_, i64>(0))
                        .map_err(std::io::Error::other)?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(std::io::Error::other)?
                };
                for id in stale {
                    let _ = store::set_task_status(&conn, id, "stopped");
                    let _ = store::insert_log(
                        &conn,
                        Some(id),
                        None,
                        "warning",
                        "task",
                        "应用重启，原运行中的任务已自动停止",
                    );
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            scheduler::start_scheduler_watcher(app.handle().clone(), db.clone(), tasks.clone());
            inbox::start_reply_watcher(app.handle().clone(), db.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let close_to_tray = {
                    let conn = state.db.lock().unwrap();
                    store::load_settings(&conn)
                        .map(|s| s.close_to_tray)
                        .unwrap_or(true)
                };
                if !state.quitting.load(Ordering::SeqCst) && close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_dashboard,
            commands::get_stats,
            commands::list_accounts,
            commands::add_account,
            commands::update_account,
            commands::delete_account,
            commands::toggle_account,
            commands::test_account,
            commands::send_test_email,
            commands::resend_delivery,
            commands::send_manual_delivery,
            commands::list_manuscripts,
            commands::get_manuscript,
            commands::add_manuscript,
            commands::update_manuscript,
            commands::delete_manuscript,
            commands::list_tasks,
            commands::get_task,
            commands::create_task,
            commands::update_task_accounts,
            commands::delete_task,
            commands::start_task,
            commands::pause_task,
            commands::resume_task,
            commands::stop_task,
            commands::list_logs,
            commands::clear_logs,
            commands::export_logs,
            commands::get_settings,
            commands::update_settings,
            commands::check_update,
            commands::set_autostart,
            commands::backup_data,
            commands::show_main_window,
            commands::list_replies,
            commands::scan_replies,
            commands::reclassify_replies,
            commands::extract_docx_text,
            commands::list_deliveries,
            commands::list_editors,
            commands::add_editor,
            commands::update_editor,
            commands::toggle_editor_favorite,
            commands::delete_editor,
            commands::clear_editors,
            commands::export_editors,
            commands::import_editors,
            commands::import_default_editors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
