use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::tray::TrayIcon;

const STATE_STOPPED: u8 = 0;
const STATE_PAUSED: u8 = 1;
const STATE_RUNNING: u8 = 2;

/// Per-task control handle shared between the command layer and the worker.
pub struct TaskHandle {
    state: AtomicU8,
}

impl TaskHandle {
    pub fn new() -> Self {
        TaskHandle {
            state: AtomicU8::new(STATE_RUNNING),
        }
    }
    pub fn stop(&self) {
        self.state.store(STATE_STOPPED, Ordering::SeqCst);
    }
    pub fn pause(&self) {
        self.state.store(STATE_PAUSED, Ordering::SeqCst);
    }
    pub fn resume(&self) {
        self.state.store(STATE_RUNNING, Ordering::SeqCst);
    }
    pub fn is_stopped(&self) -> bool {
        self.state.load(Ordering::SeqCst) == STATE_STOPPED
    }
    pub fn is_paused(&self) -> bool {
        self.state.load(Ordering::SeqCst) == STATE_PAUSED
    }
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub tasks: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    pub quitting: Arc<AtomicBool>,
    pub tray: Mutex<Option<TrayIcon>>,
}
