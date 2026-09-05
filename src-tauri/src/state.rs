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
    changed: tokio::sync::Notify,
    pub manuscript_ids: Mutex<Vec<i64>>,
}

impl TaskHandle {
    pub fn new() -> Self {
        TaskHandle {
            state: AtomicU8::new(STATE_RUNNING),
            changed: tokio::sync::Notify::new(),
            manuscript_ids: Mutex::new(Vec::new()),
        }
    }
    pub fn stop(&self) {
        self.state.store(STATE_STOPPED, Ordering::SeqCst);
        self.changed.notify_one();
    }
    pub fn pause(&self) {
        if self
            .state
            .compare_exchange(
                STATE_RUNNING,
                STATE_PAUSED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            self.changed.notify_one();
        }
    }
    pub fn resume(&self) {
        if self
            .state
            .compare_exchange(
                STATE_PAUSED,
                STATE_RUNNING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            self.changed.notify_one();
        }
    }
    /// A task has one worker/waiter. notify_one retains a permit if a command
    /// changes state just before that worker starts waiting.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }
    pub fn is_stopped(&self) -> bool {
        self.state.load(Ordering::SeqCst) == STATE_STOPPED
    }
    pub fn is_paused(&self) -> bool {
        self.state.load(Ordering::SeqCst) == STATE_PAUSED
    }
}

#[derive(Clone, Copy)]
pub struct ManualSendScope {
    pub account_id: i64,
    pub task_id: Option<i64>,
}

pub type ManualSendMap = HashMap<i64, ManualSendScope>;
pub type ManualSends = Arc<Mutex<ManualSendMap>>;

/// A reservation, not a mutex guard: no mutex is held across the SMTP await.
/// Lock order at callers: task registry -> manual sends -> database.
pub struct ManualSendLease {
    registry: ManualSends,
    manuscript_id: i64,
}

impl ManualSendLease {
    pub fn reserve(
        registry: &ManualSends,
        pending: &mut ManualSendMap,
        manuscript_id: i64,
        account_id: i64,
        task_id: Option<i64>,
    ) -> Result<Self, String> {
        ensure_no_manual_sends(pending, &[manuscript_id])?;
        pending.insert(
            manuscript_id,
            ManualSendScope {
                account_id,
                task_id,
            },
        );
        Ok(Self {
            registry: registry.clone(),
            manuscript_id,
        })
    }
}

impl Drop for ManualSendLease {
    fn drop(&mut self) {
        // Cleanup also runs on early errors and cancelled futures.
        let mut pending = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        pending.remove(&self.manuscript_id);
    }
}

pub fn ensure_no_manual_sends(
    pending: &ManualSendMap,
    manuscript_ids: &[i64],
) -> Result<(), String> {
    if manuscript_ids.iter().any(|id| pending.contains_key(id)) {
        return Err("该稿件正在手动发送或重发，请等待完成后再操作".into());
    }
    Ok(())
}

pub fn ensure_no_manual_account(pending: &ManualSendMap, account_id: i64) -> Result<(), String> {
    if pending.values().any(|scope| scope.account_id == account_id) {
        return Err("该邮箱正在手动发送或重发，请等待完成后再修改或删除".into());
    }
    Ok(())
}

pub fn ensure_no_manual_task(pending: &ManualSendMap, task_id: i64) -> Result<(), String> {
    if pending.values().any(|scope| scope.task_id == Some(task_id)) {
        return Err("该任务关联的邮件正在手动发送或重发，请等待完成后再操作".into());
    }
    Ok(())
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub tasks: Arc<Mutex<HashMap<i64, Arc<TaskHandle>>>>,
    pub quitting: Arc<AtomicBool>,
    pub reply_scan: Arc<Mutex<()>>,
    pub manual_sends: ManualSends,
    pub tray: Mutex<Option<TrayIcon>>,
}

#[cfg(test)]
mod manual_tests {
    use super::*;

    #[test]
    fn manual_reservation_protects_manuscript_and_account_until_drop() {
        let registry = ManualSends::default();
        let lease = {
            let mut pending = registry.lock().unwrap();
            let lease = ManualSendLease::reserve(&registry, &mut pending, 10, 20, Some(7)).unwrap();
            assert!(ManualSendLease::reserve(&registry, &mut pending, 10, 30, Some(7)).is_err());
            assert!(ensure_no_manual_sends(&pending, &[10, 11]).is_err());
            assert!(ensure_no_manual_sends(&pending, &[11]).is_ok());
            assert!(ensure_no_manual_account(&pending, 20).is_err());
            assert!(ensure_no_manual_account(&pending, 30).is_ok());
            assert!(ensure_no_manual_task(&pending, 7).is_err());
            assert!(ensure_no_manual_task(&pending, 8).is_ok());
            lease
        };
        assert!(registry.try_lock().is_ok()); // no DB/mutex guard survives across network work
        drop(lease);
        assert!(registry.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelling_manual_operation_releases_reservation() {
        let registry = ManualSends::default();
        let work_registry = registry.clone();
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let _lease = {
                let mut pending = work_registry.lock().unwrap();
                ManualSendLease::reserve(&work_registry, &mut pending, 10, 20, Some(7)).unwrap()
            };
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        waiting.await.unwrap();
        assert!(ensure_no_manual_sends(&registry.lock().unwrap(), &[10]).is_err());
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(registry.lock().unwrap().is_empty());
    }

    #[test]
    fn automatic_and_manual_start_race_grants_only_one_operation() {
        for _ in 0..20 {
            let conn = crate::db::test_database();
            conn.execute_batch(
                "INSERT INTO tasks(id,name,manuscript_ids) VALUES(1,'fixture','[10]');",
            )
            .unwrap();
            let db = Arc::new(Mutex::new(conn));
            let tasks = Arc::new(Mutex::new(HashMap::new()));
            let manual = ManualSends::default();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let (md, mt, mm, mb) = (db.clone(), tasks.clone(), manual.clone(), barrier.clone());
            let worker = std::thread::spawn(move || {
                mb.wait();
                let registry = mt.lock().unwrap();
                let mut pending = mm.lock().unwrap();
                let conn = md.lock().unwrap();
                crate::store::ensure_manuscript_idle(&conn, &registry, 10).ok()?;
                ManualSendLease::reserve(&mm, &mut pending, 10, 20, Some(7)).ok()
            });
            barrier.wait();
            let _handle = crate::scheduler::try_reserve_task_handle(&tasks, 1)
                .unwrap()
                .unwrap();
            let automatic_allowed = {
                let pending = manual.lock().unwrap();
                let conn = db.lock().unwrap();
                let task = crate::store::load_task(&conn, 1).unwrap().unwrap();
                ensure_no_manual_sends(&pending, &task.manuscript_ids).is_ok()
            };
            // Returned lease stays alive until both claim results have been examined.
            let manual_lease = worker.join().unwrap();
            assert_ne!(automatic_allowed, manual_lease.is_some());
            drop(manual_lease);
        }
    }
}
