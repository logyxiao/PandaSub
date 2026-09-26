use super::*;
use std::net::Shutdown;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Condvar, RwLock, RwLockWriteGuard, TryLockResult,
};
use tauri::Manager;

#[derive(Clone, serde::Serialize, PartialEq, Eq)]
pub struct InboxStatus {
    pub account_id: i64,
    pub mode: String,
    pub detail: String,
    pub last_sync: Option<String>,
}

#[derive(Default)]
pub struct InboxSync {
    config: RwLock<()>,
    manual: Mutex<()>,
    accounts: Mutex<HashMap<i64, Arc<Mutex<()>>>>,
    statuses: Mutex<HashMap<i64, InboxStatus>>,
}
impl InboxSync {
    // Account edits keep the existing exclusion guarantee; scans of different accounts share readers.
    pub fn try_lock(&self) -> TryLockResult<RwLockWriteGuard<'_, ()>> {
        self.config.try_write()
    }
    fn account_gate(&self, id: i64) -> Arc<Mutex<()>> {
        self.accounts.lock().unwrap().entry(id).or_default().clone()
    }
    pub fn statuses(&self) -> Vec<InboxStatus> {
        let mut rows: Vec<_> = self.statuses.lock().unwrap().values().cloned().collect();
        rows.sort_by_key(|row| row.account_id);
        rows
    }
    fn status(&self, app: &AppHandle, id: i64, mode: &str, detail: String, synced: bool) {
        let mut statuses = self.statuses.lock().unwrap();
        let row = InboxStatus {
            account_id: id,
            mode: mode.into(),
            detail,
            last_sync: if synced {
                Some(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
            } else {
                statuses.get(&id).and_then(|row| row.last_sync.clone())
            },
        };
        if statuses.get(&id) == Some(&row) {
            return;
        }
        statuses.insert(id, row);
        drop(statuses);
        let _ = app.emit("inbox-status", self.statuses());
    }
}

pub(super) fn acquire_scan(lock: &Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    lock.try_lock()
        .map_err(|_| "收件箱检查正在进行，请稍后刷新".into())
}
fn enabled(account: &Account) -> bool {
    account.enabled && account.check_replies && !account.imap_host.trim().is_empty()
}
fn same_connection(a: &Account, b: &Account) -> bool {
    a.email == b.email
        && a.password == b.password
        && a.imap_host == b.imap_host
        && a.imap_port == b.imap_port
        && a.imap_generation == b.imap_generation
        && enabled(a) == enabled(b)
}
fn retry_delay(failures: u32) -> Duration {
    Duration::from_secs((2u64.saturating_pow(failures.min(6))).min(60))
}

fn scan_account(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    runtime: &InboxSync,
    id: i64,
) -> Result<ScanReport, String> {
    let _config = runtime.config.read().map_err(|e| e.to_string())?;
    let gate = runtime.account_gate(id);
    let _account = gate.lock().map_err(|e| e.to_string())?;
    let (account, keywords) = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let Some(account) = store::load_account(&conn, id)?.filter(enabled) else {
            return Ok(ScanReport::default());
        };
        (
            account,
            store::load_settings(&conn)?.auto_reply_subject_keywords,
        )
    };
    runtime.status(app, id, "syncing", "正在接收邮件".into(), false);
    scan_one_account(
        app,
        db,
        &account,
        Instant::now() + Duration::from_secs(120),
        &keywords,
    )
}

pub fn scan_all_accounts(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    runtime: &Arc<InboxSync>,
) -> Result<usize, String> {
    let _manual = acquire_scan(&runtime.manual)?;
    let accounts = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        store::load_enabled_account_configs(&conn)?
    };
    // A slow account never holds up another account's receipt/database/event updates.
    let results = std::thread::scope(|scope| {
        let jobs: Vec<_> = accounts
            .iter()
            .filter(|a| enabled(a))
            .map(|account| {
                scope.spawn(move || {
                    let result = scan_account(app, db, runtime, account.id);
                    match &result {
                        Ok(_) => {
                            runtime.status(app, account.id, "ready", "本次检查完成".into(), true)
                        }
                        Err(error) => runtime.status(
                            app,
                            account.id,
                            "retrying",
                            safe_error(error, account),
                            false,
                        ),
                    }
                    (
                        account.email.clone(),
                        result.map_err(|error| safe_error(&error, account)),
                    )
                })
            })
            .collect();
        jobs.into_iter()
            .map(|job| {
                job.join()
                    .unwrap_or_else(|_| ("邮箱".into(), Err("收件线程意外退出".into())))
            })
            .collect::<Vec<_>>()
    });
    let mut total = 0;
    let mut failures = Vec::new();
    for (email, result) in results {
        match result {
            Ok(report) => total += report.saved,
            Err(error) => failures.push(format!("{email}：{error}")),
        }
    }
    if failures.is_empty() {
        Ok(total)
    } else {
        Err(format!(
            "已保存 {total} 封邮件；部分邮箱检查失败：{}",
            failures.join("；")
        ))
    }
}

#[derive(Default)]
struct Control {
    stopped: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
    sleep: Mutex<()>,
    changed: Condvar,
}
impl Control {
    fn stop(&self) {
        let _guard = self.sleep.lock().unwrap();
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(socket) = self.socket.lock().unwrap().as_ref() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        self.changed.notify_all();
    }
    fn clear_socket(&self) {
        if let Some(socket) = self.socket.lock().unwrap().take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
    fn wait(&self, delay: Duration) {
        let guard = self.sleep.lock().unwrap();
        let _ = self
            .changed
            .wait_timeout_while(guard, delay, |_| !self.stopped.load(Ordering::SeqCst));
    }
}
struct Worker {
    account: Account,
    control: Arc<Control>,
    thread: std::thread::JoinHandle<()>,
}

pub fn start_reply_watcher(app: AppHandle, db: Arc<Mutex<Connection>>, runtime: Arc<InboxSync>) {
    tauri::async_runtime::spawn(async move {
        let mut workers: HashMap<i64, Worker> = HashMap::new();
        loop {
            if app
                .state::<crate::state::AppState>()
                .quitting
                .load(Ordering::SeqCst)
            {
                break;
            }
            let config_db = db.clone();
            let accounts = tauri::async_runtime::spawn_blocking(move || {
                let conn = config_db.lock().map_err(|e| e.to_string())?;
                store::load_enabled_account_configs(&conn)
            }).await.unwrap_or_else(|error| Err(error.to_string()));
            let Ok(accounts) = accounts else {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            };
            let desired: HashMap<_, _> = accounts
                .into_iter()
                .filter(enabled)
                .map(|account| (account.id, account))
                .collect();
            for (&id, worker) in &workers {
                if !desired
                    .get(&id)
                    .is_some_and(|next| same_connection(&worker.account, next))
                {
                    worker.control.stop();
                }
            }
            workers.retain(|_, worker| !worker.thread.is_finished());
            let removed = {
                let mut statuses = runtime.statuses.lock().unwrap();
                let old_len = statuses.len();
                statuses.retain(|id, _| desired.contains_key(id));
                old_len != statuses.len()
            };
            if removed {
                let _ = app.emit("inbox-status", runtime.statuses());
            }
            for (id, account) in desired {
                if workers.contains_key(&id) {
                    continue;
                }
                let control = Arc::new(Control::default());
                let (app, db, runtime, run_account, run_control) = (
                    app.clone(),
                    db.clone(),
                    runtime.clone(),
                    account.clone(),
                    control.clone(),
                );
                let thread = std::thread::spawn(move || {
                    run_account_worker(app, db, runtime, run_account, run_control)
                });
                workers.insert(
                    id,
                    Worker {
                        account,
                        control,
                        thread,
                    },
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        for worker in workers.values() {
            worker.control.stop();
        }
    });
}

fn safe_error(error: &str, account: &Account) -> String {
    let error = if account.password.is_empty() {
        error.to_string()
    } else {
        error.replace(&account.password, "***")
    };
    error.chars().take(240).collect()
}
fn poll_interval(db: &Arc<Mutex<Connection>>) -> Duration {
    let minutes = db
        .lock()
        .ok()
        .and_then(|conn| store::load_settings(&conn).ok())
        .map(|settings| settings.reply_poll_minutes)
        .unwrap_or(2);
    Duration::from_secs(minutes.clamp(1, 60) as u64 * 60)
}
fn run_account_worker(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    runtime: Arc<InboxSync>,
    account: Account,
    control: Arc<Control>,
) {
    let mut failures: u32 = 0;
    let mut idle: Option<IdleConnection> = None;
    let mut polling_only = false;
    while !control.stopped.load(Ordering::SeqCst) {
        match scan_account(&app, &db, &runtime, account.id) {
            Ok(report) => {
                if control.stopped.load(Ordering::SeqCst) {
                    break;
                }
                runtime.status(&app, account.id, "ready", "邮件已更新".into(), true);
                if report.more {
                    control.wait(Duration::from_millis(100));
                    continue;
                }
            }
            Err(error) => {
                if control.stopped.load(Ordering::SeqCst) {
                    break;
                }
                failures = failures.saturating_add(1);
                idle = None;
                control.clear_socket();
                runtime.status(
                    &app,
                    account.id,
                    "retrying",
                    format!(
                        "{} 秒后重试 · {}",
                        retry_delay(failures).as_secs(),
                        safe_error(&error, &account)
                    ),
                    false,
                );
                control.wait(retry_delay(failures));
                continue;
            }
        }
        if idle.is_none() {
            control.clear_socket();
        }
        if !polling_only && idle.is_none() {
            runtime.status(
                &app,
                account.id,
                "connecting",
                "正在建立实时连接".into(),
                false,
            );
            match IdleConnection::open(&account, &control) {
                Ok(Some(connection)) => {
                    idle = Some(connection);
                    continue;
                }
                Ok(None) => {
                    control.clear_socket();
                    polling_only = true;
                }
                Err(error) => {
                    if control.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    control.clear_socket();
                    failures = failures.saturating_add(1);
                    runtime.status(
                        &app,
                        account.id,
                        "retrying",
                        safe_error(&error, &account),
                        false,
                    );
                    control.wait(retry_delay(failures));
                    continue;
                }
            }
        }
        if polling_only {
            failures = 0;
            runtime.status(
                &app,
                account.id,
                "polling",
                "服务器未启用实时通知，按设置定时检查".into(),
                false,
            );
            control.wait(poll_interval(&db));
            continue;
        }
        let check_at = Instant::now() + poll_interval(&db);
        loop {
            if control.stopped.load(Ordering::SeqCst) {
                return;
            }
            runtime.status(&app, account.id, "idle", "实时监听中".into(), false);
            let outcome = idle.as_mut().unwrap().wait(
                Duration::from_secs(30).min(check_at.saturating_duration_since(Instant::now())),
            );
            match outcome {
                Ok(imap::extensions::idle::WaitOutcome::MailboxChanged) => {
                    failures = 0;
                    break;
                }
                Ok(_) if Instant::now() < check_at => {
                    failures = 0;
                    continue;
                }
                Ok(_) => {
                    failures = 0;
                    break;
                }
                Err(imap::error::Error::Bad(_) | imap::error::Error::No(_)) => {
                    polling_only = true;
                    idle = None;
                    control.clear_socket();
                    break;
                }
                Err(error) => {
                    idle = None;
                    control.clear_socket();
                    failures = failures.saturating_add(1);
                    if !control.stopped.load(Ordering::SeqCst) {
                        runtime.status(
                            &app,
                            account.id,
                            "retrying",
                            safe_error(&error.to_string(), &account),
                            false,
                        );
                        control.wait(retry_delay(failures));
                    }
                    break;
                }
            }
        }
    }
}

struct IdleTransport {
    tls: native_tls::TlsStream<BudgetStream>,
    deadline: Arc<Mutex<Instant>>,
}
impl Read for IdleTransport {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.tls.get_mut().deadline = *self.deadline.lock().unwrap();
        self.tls.read(buf)
    }
}
impl Write for IdleTransport {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.tls.get_mut().deadline = *self.deadline.lock().unwrap();
        self.tls.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.tls.flush()
    }
}
impl imap::extensions::idle::SetReadTimeout for IdleTransport {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> imap::error::Result<()> {
        let timeout = timeout.unwrap_or(IO_TIMEOUT).max(Duration::from_millis(1));
        *self.deadline.lock().unwrap() = Instant::now() + timeout;
        self.tls.get_mut().io_timeout = timeout;
        Ok(())
    }
}
struct IdleConnection {
    session: imap::Session<IdleTransport>,
    deadline: Arc<Mutex<Instant>>,
}
impl IdleConnection {
    fn open(account: &Account, control: &Control) -> Result<Option<Self>, String> {
        let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_secs(60)));
        let tls = connect_tls_bounded(
            &account.imap_host,
            account.imap_port,
            CONNECT_TIMEOUT,
            IO_TIMEOUT,
            *deadline.lock().unwrap(),
        )?;
        *control.socket.lock().unwrap() = Some(
            tls.get_ref()
                .stream
                .try_clone()
                .map_err(|e| e.to_string())?,
        );
        if control.stopped.load(Ordering::SeqCst) {
            return Err("收件监听已停止".into());
        }
        let mut client = imap::Client::new(IdleTransport {
            tls,
            deadline: deadline.clone(),
        });
        client.read_greeting().map_err(|e| e.to_string())?;
        let mut session = client
            .login(&account.email, &account.password)
            .map_err(|e| e.0.to_string())?;
        if !session
            .capabilities()
            .map_err(|e| e.to_string())?
            .has_str("IDLE")
        {
            let _ = session.logout();
            return Ok(None);
        }
        session.select("INBOX").map_err(|e| e.to_string())?;
        Ok(Some(Self { session, deadline }))
    }
    fn wait(
        &mut self,
        timeout: Duration,
    ) -> imap::error::Result<imap::extensions::idle::WaitOutcome> {
        *self.deadline.lock().unwrap() = Instant::now() + IO_TIMEOUT;
        wait_for_changes(&mut self.session, timeout)
    }
}

fn wait_for_changes<S: Read + Write + imap::extensions::idle::SetReadTimeout>(
    session: &mut imap::Session<S>,
    timeout: Duration,
) -> imap::error::Result<imap::extensions::idle::WaitOutcome> {
    // Flush notifications accumulated while a different connection fetched bodies/flags.
    // The IMAP 2.x IDLE handshake expects the continuation to be the first response.
    session.noop()?;
    if session.unsolicited_responses.try_iter().count() > 0 {
        return Ok(imap::extensions::idle::WaitOutcome::MailboxChanged);
    }
    session
        .idle()?
        .wait_with_timeout(timeout.max(Duration::from_millis(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_scan_independently_while_configuration_changes_remain_exclusive() {
        let runtime = InboxSync::default();
        let first = runtime.account_gate(1);
        let same = runtime.account_gate(1);
        let second = runtime.account_gate(2);
        let _scan = first.lock().unwrap();
        assert!(same.try_lock().is_err());
        assert!(second.try_lock().is_ok());
        let config = runtime.config.read().unwrap();
        assert!(runtime.try_lock().is_err());
        drop(config);
        let edit = runtime.try_lock().unwrap();
        assert!(runtime.config.try_read().is_err());
        drop(edit);
    }

    #[test]
    fn retry_delay_is_bounded_and_stop_interrupts_long_waits() {
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(4), Duration::from_secs(16));
        assert_eq!(retry_delay(u32::MAX), Duration::from_secs(60));
        let control = Arc::new(Control::default());
        let stopped = control.clone();
        let thread = std::thread::spawn(move || stopped.wait(Duration::from_secs(60)));
        control.stop();
        thread.join().unwrap();
        assert!(control.stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn imap_idle_wakes_on_new_mail_and_reuses_the_authenticated_connection() {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket.write_all(b"* OK fixture\r\n").unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut sent = String::new();
            reader.read_line(&mut sent).unwrap();
            assert!(sent.contains("LOGIN"));
            socket.write_all(b"a1 OK login\r\n").unwrap();
            for (tag, changed) in [(3, true), (5, false)] {
                sent.clear();
                reader.read_line(&mut sent).unwrap();
                assert_eq!(sent, format!("a{} NOOP\r\n", tag - 1));
                socket
                    .write_all(format!("a{} OK noop\r\n", tag - 1).as_bytes())
                    .unwrap();
                sent.clear();
                reader.read_line(&mut sent).unwrap();
                assert_eq!(sent, format!("a{tag} IDLE\r\n"));
                socket.write_all(b"+ idling\r\n").unwrap();
                if changed {
                    socket.write_all(b"* 2 EXISTS\r\n").unwrap();
                }
                sent.clear();
                reader.read_line(&mut sent).unwrap();
                assert_eq!(sent, "DONE\r\n");
                socket
                    .write_all(format!("a{tag} OK idle complete\r\n").as_bytes())
                    .unwrap();
            }
            sent.clear();
            reader.read_line(&mut sent).unwrap();
            assert_eq!(sent, "a6 NOOP\r\n");
            socket.write_all(b"* 3 EXISTS\r\na6 OK noop\r\n").unwrap();
        });
        let mut client = imap::Client::new(stream);
        client.read_greeting().unwrap();
        let mut session = client
            .login("fixture", "")
            .map_err(|e| e.0.to_string())
            .unwrap();
        assert!(matches!(
            wait_for_changes(&mut session, Duration::from_secs(1)).unwrap(),
            imap::extensions::idle::WaitOutcome::MailboxChanged
        ));
        assert!(matches!(
            wait_for_changes(&mut session, Duration::from_millis(30)).unwrap(),
            imap::extensions::idle::WaitOutcome::TimedOut
        ));
        assert!(matches!(
            wait_for_changes(&mut session, Duration::from_secs(1)).unwrap(),
            imap::extensions::idle::WaitOutcome::MailboxChanged
        ));
        server.join().unwrap();
    }
}
