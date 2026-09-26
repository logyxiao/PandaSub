mod classify;
mod commands;
mod db;
mod inbox;
mod models;
mod scheduler;
mod smtp;
mod state;
mod store;
mod tray;
mod update_gate;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Manager, WindowEvent};

use state::{AppState, TaskHandle};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                attachments: Default::default(),
                db: db.clone(),
                tasks: tasks.clone(),
                quitting: quitting.clone(),
                reply_scan: Arc::new(inbox::InboxSync::default()),
                manual_sends: Arc::new(Mutex::new(HashMap::new())),
                tray: Mutex::new(None),
                unread_inbox_request: AtomicBool::new(false),
            });

            let auto_backup = {
                let conn = db.lock().unwrap();
                store::load_settings(&conn)
                    .map(|s| s.auto_backup)
                    .unwrap_or(false)
            };
            if auto_backup {
                let backup_dir = data_dir.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = commands::backup_database(&backup_dir) { log::warn!("自动备份失败：{error}"); }
                });
            }

            tray::build(app)?;

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

            scheduler::start_scheduler_watcher(
                app.handle().clone(),
                db.clone(),
                tasks.clone(),
                app.state::<AppState>().manual_sends.clone(),
            );
            inbox::start_reply_watcher(
                app.handle().clone(),
                db.clone(),
                app.state::<AppState>().reply_scan.clone(),
            );
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
            update_gate::prepare_update_install,
            update_gate::release_update_install,
            commands::get_dashboard,
            tray::take_tray_inbox_request,
            commands::running_task_count,
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
            commands::list_accepted_works,
            commands::get_accepted_work,
            commands::list_accepted_candidates,
            commands::add_accepted_work,
            commands::update_accepted_work,
            commands::delete_accepted_work,
            commands::get_accepted_work_document,
            commands::export_accepted_work_document,
            commands::open_saved_document,
            commands::save_accepted_share_image,
            commands::list_tasks,
            commands::get_task,
            commands::create_task,
            commands::update_task,
            commands::create_waste_draft_task,
            commands::update_task_accounts,
            commands::delete_task,
            commands::start_task,
            commands::pause_task,
            commands::resume_task,
            commands::stop_task,
            commands::list_log_options,
            commands::list_logs,
            commands::list_logs_page,
            commands::clear_logs,
            commands::export_logs,
            commands::get_settings,
            commands::update_settings,
            commands::get_default_mail_templates,
            commands::save_default_mail_templates,
            commands::set_autostart,
            commands::backup_data,
            commands::get_storage_summary,
            commands::clean_storage,
            commands::show_main_window,
            commands::get_reply_content,
            commands::get_local_reply_content,
            commands::save_reply_attachment,
            commands::open_mail_link,
            commands::list_replies,
            commands::unread_human_reply_count,
            commands::list_replies_page,
            commands::set_reply_read,
            commands::sync_reply_read_flags,
            commands::scan_replies,
            commands::get_inbox_status,
            commands::reclassify_replies,
            commands::extract_docx_text,
            commands::stage_attachment,
            commands::release_attachment,
            commands::list_deliveries,
            commands::delivery_summary_page,
            commands::list_pending_sends,
            commands::resolve_pending_send,
            commands::list_editors,
            commands::list_editor_groups,
            commands::create_editor_group,
            commands::update_editor_group,
            commands::delete_editor_group,
            commands::export_editor_groups,
            commands::import_editor_groups,
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
