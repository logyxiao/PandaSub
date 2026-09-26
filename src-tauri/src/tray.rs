use crate::{state::AppState, store};
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager};

pub struct InboxTray {
    icon: TrayIcon,
    unread_menu: MenuItem<tauri::Wry>,
    normal: Image<'static>,
    blue: Image<'static>,
    count: i64,
}

// Tint the existing panda's dark strokes, preserving its light face and transparency.
fn blue_pixels(rgba: &[u8]) -> Vec<u8> {
    let mut pixels = rgba.to_vec();
    for pixel in pixels.chunks_exact_mut(4) {
        let luminance =
            (u32::from(pixel[0]) * 299 + u32::from(pixel[1]) * 587 + u32::from(pixel[2]) * 114)
                / 1000;
        let blend = (210.0 - luminance as f32).clamp(0.0, 160.0) / 160.0;
        for (channel, blue) in pixel[..3].iter_mut().zip([37u8, 99, 235]) {
            *channel = (*channel as f32 * (1.0 - blend) + blue as f32 * blend).round() as u8;
        }
    }
    pixels
}

fn unread_label(count: i64) -> String {
    format!("查看未读人工回复（{}）", count.max(0))
}
fn tooltip(count: i64) -> String {
    if count > 0 {
        format!("熊猫投稿 · {count} 封未读人工回复")
    } else {
        "熊猫投稿".into()
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_unread(app: &AppHandle) {
    // Keep the request until React is ready, including clicks during window startup.
    app.state::<AppState>()
        .unread_inbox_request
        .store(true, Ordering::SeqCst);
    show_window(app);
    let _ = app.emit("open-unread-inbox", ());
}

pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let Some(source) = app.default_window_icon() else {
        return Ok(());
    };
    let count = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        store::unread_human_reply_count(&conn).unwrap_or(0)
    };
    let normal = Image::new_owned(source.rgba().to_vec(), source.width(), source.height());
    let blue = Image::new_owned(blue_pixels(source.rgba()), source.width(), source.height());
    let unread_menu = MenuItem::with_id(app, "unread", unread_label(count), true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&unread_menu, &show, &quit])?;
    let icon = TrayIconBuilder::new()
        .icon(if count > 0 {
            blue.clone()
        } else {
            normal.clone()
        })
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip(count))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "unread" => open_unread(app),
            "show" => show_window(app),
            "quit" => {
                app.state::<AppState>()
                    .quitting
                    .store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let has_unread = app
                    .state::<AppState>()
                    .tray
                    .lock()
                    .ok()
                    .and_then(|tray| tray.as_ref().map(|tray| tray.count > 0))
                    .unwrap_or(false);
                if has_unread {
                    open_unread(app)
                } else {
                    show_window(app)
                }
            }
        })
        .build(app)?;
    app.state::<AppState>()
        .tray
        .lock()
        .unwrap()
        .replace(InboxTray {
            icon,
            unread_menu,
            normal,
            blue,
            count,
        });
    start_watcher(app.handle());
    Ok(())
}

fn start_watcher(app: &AppHandle) {
    let changed = Arc::new(tokio::sync::Notify::new());
    for name in ["reply", "reply-read-change"] {
        let changed = changed.clone();
        app.listen(name, move |_| changed.notify_one());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                break;
            }
            let db = app.state::<AppState>().db.clone();
            let count = tauri::async_runtime::spawn_blocking(move || {
                let conn = db.lock().map_err(|e| e.to_string())?;
                store::unread_human_reply_count(&conn)
            })
            .await;
            if let Ok(Ok(count)) = count {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let state = handle.state::<AppState>();
                    let Ok(mut tray) = state.tray.lock() else {
                        return;
                    };
                    let Some(tray) = tray.as_mut() else { return };
                    if tray.count == count {
                        return;
                    }
                    let icon = if count > 0 { &tray.blue } else { &tray.normal };
                    let result = tray
                        .icon
                        .set_icon_with_as_template(Some(icon.clone()), false)
                        .and_then(|_| tray.icon.set_tooltip(Some(tooltip(count))))
                        .and_then(|_| tray.unread_menu.set_text(unread_label(count)));
                    if let Err(error) = result {
                        log::warn!("更新未读托盘提示失败：{error}");
                    } else {
                        tray.count = count;
                    }
                });
            }
            tokio::select! {
                _ = changed.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(15)) => {},
            }
        }
    });
}

#[tauri::command]
pub fn take_tray_inbox_request(state: tauri::State<'_, AppState>) -> bool {
    state.unread_inbox_request.swap(false, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unread_tint_preserves_face_alpha_and_source_pixels() {
        let source = [10, 20, 30, 255, 255, 250, 240, 255, 0, 0, 0, 0];
        let blue = blue_pixels(&source);
        assert_eq!(&blue[..4], &[37, 99, 235, 255]);
        assert_eq!(&blue[4..8], &source[4..8]);
        assert_eq!(blue[11], 0);
        assert_eq!(&source[..3], &[10, 20, 30]);
        assert_eq!(tooltip(0), "熊猫投稿");
        assert!(tooltip(105).contains("105"));
        assert_eq!(unread_label(2), "查看未读人工回复（2）");
    }
}
