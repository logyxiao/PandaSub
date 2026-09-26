//! Short-lived, bounded account sessions for interactive FLAGS/Seen operations.
use super::*;
use std::sync::OnceLock;

type Session = imap::Session<native_tls::TlsStream<BudgetStream>>;
type Identity = (String, u16, String, String, i64, i64);
struct Cached<S: Read + Write> {
    identity: Identity,
    opened: Instant,
    session: imap::Session<S>,
}
type LiveCached = Cached<native_tls::TlsStream<BudgetStream>>;
struct Slot {
    session: Arc<Mutex<Option<LiveCached>>>,
    used: Instant,
}
static POOL: OnceLock<Mutex<HashMap<i64, Slot>>> = OnceLock::new();
const MAX_ACCOUNTS: usize = 8;
const REUSE_FOR: Duration = Duration::from_secs(15);

fn account_slot(id: i64) -> Result<Arc<Mutex<Option<LiveCached>>>, String> {
    let mut pool = POOL
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    if !pool.contains_key(&id) && pool.len() >= MAX_ACCOUNTS {
        let oldest = pool
            .iter()
            .filter(|(_, slot)| Arc::strong_count(&slot.session) == 1)
            .min_by_key(|(_, slot)| slot.used)
            .map(|(id, _)| *id);
        if let Some(id) = oldest {
            pool.remove(&id);
        } else {
            return Err("邮件状态正在同步，请稍后重试".into());
        }
    }
    let slot = pool.entry(id).or_insert_with(|| Slot {
        session: Arc::new(Mutex::new(None)),
        used: Instant::now(),
    });
    slot.used = Instant::now();
    Ok(slot.session.clone())
}

fn reusable<K: PartialEq>(saved: &K, current: &K, opened: Instant) -> bool {
    saved == current && opened.elapsed() < REUSE_FOR
}

pub(super) fn with_session<T>(
    account: &Account,
    validity: i64,
    operation: impl FnMut(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let slot = account_slot(account.id)?;
    let mut guard = slot.lock().map_err(|e| e.to_string())?;
    let before = guard.as_ref().map(|cached| cached.opened);
    let identity = (
        account.imap_host.clone(),
        account.imap_port,
        account.email.clone(),
        account.password.clone(),
        account.imap_generation,
        validity,
    );
    let result = run_cached(
        &mut guard,
        identity,
        validity,
        || open_read_state_session(account, validity),
        operation,
    );
    let opened = guard.as_ref().map(|cached| cached.opened);
    drop(guard);
    if opened.is_some() && opened != before {
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(REUSE_FOR).await;
            if let Ok(mut pool) = POOL.get_or_init(Default::default).lock() {
                pool.retain(|_, slot| {
                    if Arc::strong_count(&slot.session) != 1 {
                        return true;
                    }
                    let Ok(mut cached) = slot.session.try_lock() else {
                        return true;
                    };
                    if cached
                        .as_ref()
                        .is_some_and(|entry| entry.opened.elapsed() >= REUSE_FOR)
                    {
                        *cached = None;
                    }
                    cached.is_some()
                });
            }
        });
    }
    result
}

fn run_cached<S: Read + Write, T>(
    cache: &mut Option<Cached<S>>,
    identity: Identity,
    validity: i64,
    mut open: impl FnMut() -> Result<imap::Session<S>, String>,
    mut operation: impl FnMut(&mut imap::Session<S>) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(mut cached) = cache
        .take()
        .filter(|cached| reusable(&cached.identity, &identity, cached.opened))
    {
        // Recheck the namespace on every reuse, retaining the original hard
        // transport deadline and byte budget across operations.
        if let Ok(mailbox) = cached.session.select("INBOX") {
            if mailbox.uid_validity.map(i64::from) != Some(validity) {
                return Err("邮箱邮件编号已变化，请先检查收件箱以重新同步".into());
            }
            if let Ok(result) = operation(&mut cached.session) {
                if cached.opened.elapsed() < REUSE_FOR {
                    *cache = Some(cached);
                }
                return Ok(result);
            }
        }
        // FLAGS and setting Seen are idempotent: retry a stale connection once.
    }
    let opened = Instant::now();
    let mut session = open()?;
    let result = operation(&mut session)?;
    if opened.elapsed() < REUSE_FOR {
        *cache = Some(Cached {
            identity,
            opened,
            session,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reuse_requires_identical_mailbox_credentials_and_a_fresh_budget() {
        let key = ("host", 993, "mail", "secret", 1, 10);
        assert!(reusable(&key, &key, Instant::now()));
        for changed in [
            ("host", 993, "mail", "changed", 1, 10),
            ("host", 993, "mail", "secret", 2, 10),
            ("host", 993, "mail", "secret", 1, 11),
        ] {
            assert!(!reusable(&key, &changed, Instant::now()));
        }
        assert!(!reusable(
            &key,
            &key,
            Instant::now() - Duration::from_secs(16)
        ));
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    struct Transcript {
        input: std::io::Cursor<Vec<u8>>,
        written: Arc<Mutex<Vec<u8>>>,
    }
    impl Read for Transcript {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.input.read(bytes)
        }
    }
    impl Write for Transcript {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.written.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    fn key() -> Identity {
        ("host".into(), 993, "user".into(), "secret".into(), 1, 10)
    }
    fn open(tail: &str, written: Arc<Mutex<Vec<u8>>>) -> imap::Session<Transcript> {
        let prefix = "* OK hello\r\na1 OK login\r\n* OK [UIDVALIDITY 10] valid\r\na2 OK select\r\n";
        let mut client = imap::Client::new(Transcript {
            input: std::io::Cursor::new(format!("{prefix}{tail}").into_bytes()),
            written,
        });
        client.read_greeting().unwrap();
        let mut session = client
            .login("user", "secret")
            .map_err(|e| e.0.to_string())
            .unwrap();
        session.select("INBOX").unwrap();
        session
    }
    #[test]
    fn successive_reads_reuse_one_login_and_recheck_uidvalidity() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let mut cache = None;
        let tail="* 1 FETCH (UID 7 FLAGS ())\r\na3 OK fetch\r\n* OK [UIDVALIDITY 10] valid\r\na4 OK select\r\n* 1 FETCH (UID 7 FLAGS (\\Seen))\r\na5 OK fetch\r\n* OK [UIDVALIDITY 11] changed\r\na6 OK select\r\n";
        let first = run_cached(
            &mut cache,
            key(),
            10,
            || Ok(open(tail, written.clone())),
            |s| fetch_seen_flags_session(s, &[7]),
        )
        .unwrap();
        assert_eq!(first.get(&7), Some(&false));
        let second = run_cached(
            &mut cache,
            key(),
            10,
            || panic!("must reuse"),
            |s| fetch_seen_flags_session(s, &[7]),
        )
        .unwrap();
        assert_eq!(second.get(&7), Some(&true));
        assert!(run_cached(
            &mut cache,
            key(),
            10,
            || panic!("namespace changed"),
            |s| fetch_seen_flags_session(s, &[7])
        )
        .is_err());
        assert!(cache.is_none());
        let commands = String::from_utf8(written.lock().unwrap().clone()).unwrap();
        assert_eq!(commands.matches("LOGIN").count(), 1);
        assert_eq!(commands.matches("UID FETCH").count(), 2);
    }
    #[test]
    fn dead_reused_connection_reconnects_once_and_failed_fresh_reads_are_not_cached() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let mut cache = None;
        run_cached(
            &mut cache,
            key(),
            10,
            || Ok(open("a3 OK noop\r\n", written.clone())),
            |s| s.noop().map_err(|e| e.to_string()),
        )
        .unwrap();
        let states = run_cached(
            &mut cache,
            key(),
            10,
            || {
                Ok(open(
                    "* 1 FETCH (UID 8 FLAGS ())\r\na3 OK fetch\r\n",
                    written.clone(),
                ))
            },
            |s| fetch_seen_flags_session(s, &[8]),
        )
        .unwrap();
        assert_eq!(states.get(&8), Some(&false));
        let mut changed = key();
        changed.3 = "new secret".into();
        assert!(run_cached(
            &mut cache,
            changed,
            10,
            || Ok(open("a3 NO fetch failed\r\n", written.clone())),
            |s| fetch_seen_flags_session(s, &[8])
        )
        .is_err());
        assert!(cache.is_none());
    }
}
