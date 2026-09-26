use crate::state::AppState;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct Activity {
    installing: bool,
    tests: usize,
}
#[derive(Default)]
pub struct UpdateGate(Mutex<Activity>);
pub static UPDATE_GATE: UpdateGate = UpdateGate(Mutex::new(Activity {
    installing: false,
    tests: 0,
}));

impl UpdateGate {
    pub fn ensure_available(&self) -> Result<(), String> {
        if self.0.lock().map_err(|e| e.to_string())?.installing {
            return Err("正在安装更新，请稍后再发送邮件".into());
        }
        Ok(())
    }
    fn prepare(&self, sending: bool) -> Result<(), String> {
        let mut activity = self.0.lock().map_err(|e| e.to_string())?;
        if activity.installing || sending || activity.tests > 0 {
            return Err("请先停止运行或暂停中的投稿任务，并等待邮件发送完成，再安装更新".into());
        }
        activity.installing = true;
        Ok(())
    }
    fn release(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).installing = false;
    }
    pub fn enter_test(&self) -> Result<TestLease<'_>, String> {
        let mut activity = self.0.lock().map_err(|e| e.to_string())?;
        if activity.installing {
            return Err("正在安装更新，请稍后再发送测试邮件".into());
        }
        activity.tests += 1;
        Ok(TestLease(self))
    }
}
pub struct TestLease<'a>(&'a UpdateGate);
impl Drop for TestLease<'_> {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap_or_else(|e| e.into_inner()).tests -= 1;
    }
}

#[tauri::command]
pub fn prepare_update_install(state: State<'_, AppState>) -> Result<(), String> {
    // The same lock order is used when reserving a send. No new sends can slip
    // between this check and the gate closing; no locks survive the IPC call.
    let tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    let manual = state.manual_sends.lock().map_err(|e| e.to_string())?;
    UPDATE_GATE.prepare(!tasks.is_empty() || !manual.is_empty())
}
#[tauri::command]
pub fn release_update_install() {
    UPDATE_GATE.release();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_sends_prevent_install_and_install_prevents_new_sends() {
        let gate = UpdateGate::default();
        assert!(gate.prepare(true).is_err());
        let test = gate.enter_test().unwrap();
        assert!(gate.prepare(false).is_err());
        drop(test);
        gate.prepare(false).unwrap();
        assert!(gate.ensure_available().is_err());
        assert!(gate.enter_test().is_err());
        assert!(gate.prepare(false).is_err());
        gate.release();
        assert!(gate.ensure_available().is_ok());
        gate.prepare(false).unwrap();
    }
    #[tokio::test]
    async fn cancellation_releases_test_mail_activity() {
        let gate = std::sync::Arc::new(UpdateGate::default());
        let other = gate.clone();
        let (ready, wait) = tokio::sync::oneshot::channel();
        let work = tokio::spawn(async move {
            let _lease = other.enter_test().unwrap();
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        wait.await.unwrap();
        assert!(gate.prepare(false).is_err());
        work.abort();
        assert!(work.await.unwrap_err().is_cancelled());
        gate.prepare(false).unwrap();
    }
}
