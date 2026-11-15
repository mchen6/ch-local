//! `<home>/run/daemon/start.lock`, in ch-local's lib/lock.js protocol
//! exactly (contract 2, section 6, "Starting"), so the shim and Node take
//! one lock and two daemons never start:
//! - the holder is `{"pid":…,"host":…,"at":…}` and a newline; `host` is the
//!   host name, plus on Linux `#` and the target of /proc/self/ns/pid;
//! - created whole: written to `<lock>.<pid>.<hex>.tmp`, hard-linked to the
//!   lock's name, the temporary removed; "exists" means another holds it;
//!   an empty or unreadable lock is never taken for stale;
//! - while held, its mtime is set to now every 15 s;
//! - a holder is gone when it is on this host and its pid is dead, or its
//!   mtime is over 2 minutes old on any host; a gone holder's lock is taken
//!   through `<lock>.break` (created exclusively, stale after 10 s), and
//!   removed only if it is still the same holder;
//! - released only while it still holds its own content.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub const HEARTBEAT: Duration = Duration::from_secs(15);
pub const STALE: Duration = Duration::from_secs(120);
pub const BREAK_STALE: Duration = Duration::from_secs(10);
pub const POLL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub pid: i64,
    pub host: String,
    pub at: String,
}

impl Holder {
    /// The lock file's content: compact JSON, pid, host, at, then a newline.
    pub fn content(&self) -> String {
        format!(
            "{{\"pid\":{},\"host\":{},\"at\":{}}}\n",
            self.pid,
            serde_json::to_string(&self.host).expect("a string serialises"),
            serde_json::to_string(&self.at).expect("a string serialises")
        )
    }

    fn parse(bytes: &[u8]) -> Option<Holder> {
        let v: Value = serde_json::from_slice(bytes).ok()?;
        Some(Holder {
            pid: v.get("pid")?.as_i64()?,
            host: v.get("host")?.as_str()?.to_string(),
            at: v.get("at")?.as_str()?.to_string(),
        })
    }
}

/// An instant as Node's `new Date().toISOString()`: UTC, milliseconds, Z.
pub fn iso_utc(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil from days (H. Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// This host, as lib/lock.js's lockHost has it.
pub fn this_host() -> String {
    let mut host = host_name();
    if cfg!(target_os = "linux") {
        if let Ok(ns) = fs::read_link("/proc/self/ns/pid") {
            host.push('#');
            host.push_str(&ns.to_string_lossy());
        }
    }
    host
}

#[cfg(unix)]
fn host_name() -> String {
    rustix::system::uname().nodename().to_string_lossy().into_owned()
}

// Node's os.hostname() on Windows is the DNS host name
// (GetComputerNameExW); win_ffi gives it. Until then COMPUTERNAME, which a
// lock written by Node may not match: such a holder then counts as another
// host's, judged only by its heartbeat, never taken for dead early.
#[cfg(windows)]
fn host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

#[cfg(unix)]
pub(crate) fn alive(pid: i64) -> bool {
    let Some(pid) = i32::try_from(pid).ok().and_then(rustix::process::Pid::from_raw) else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(e) => e == rustix::io::Errno::PERM,
    }
}

// win_ffi's OpenProcess check comes with it; until then a Windows holder is
// never judged dead by its pid, only by its heartbeat.
#[cfg(windows)]
pub(crate) fn alive(_pid: i64) -> bool {
    true
}

fn random_hex() -> String {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("the OS gives random bytes");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The lock created whole, or false when another holds it.
fn create(lock: &Path, mine: &Holder) -> io::Result<bool> {
    let tmp = PathBuf::from(format!("{}.{}.{}.tmp", lock.display(), std::process::id(), random_hex()));
    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(mine.content().as_bytes())?;
        f.sync_all()?;
        match fs::hard_link(&tmp, lock) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    })();
    let _ = fs::remove_file(&tmp);
    result
}

fn read_holder(lock: &Path) -> Option<Holder> {
    fs::read(lock).ok().and_then(|b| Holder::parse(&b))
}

fn age(path: &Path) -> Option<Duration> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    Some(SystemTime::now().duration_since(m).unwrap_or_default())
}

/// Clears `lock` if it is still `dead`'s; true when it was cleared.
fn clear_stale(lock: &Path, dead: &Holder) -> io::Result<bool> {
    let breaker = PathBuf::from(format!("{}.break", lock.display()));
    match OpenOptions::new().write(true).create_new(true).open(&breaker) {
        Ok(mut f) => {
            let _ = f.write_all(std::process::id().to_string().as_bytes());
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // a breaker left by a crash in the few lines below
            if age(&breaker).is_some_and(|a| a > BREAK_STALE) {
                let _ = fs::remove_file(&breaker);
            }
            return Ok(false);
        }
        Err(e) => return Err(e),
    }
    let cleared =
        if read_holder(lock).as_ref() == Some(dead) { fs::remove_file(lock).map(|_| true) } else { Ok(false) };
    let _ = fs::remove_file(&breaker);
    cleared
}

#[derive(Debug)]
pub enum LockError {
    Io(io::Error),
    /// Still held by a live holder at the deadline (None: unreadable, being
    /// written).
    Held(Option<Holder>),
}

/// The lock, held: its heartbeat runs until it is dropped, which releases
/// it if it is still ours.
pub struct Held {
    lock: PathBuf,
    mine: Holder,
    stop: Arc<AtomicBool>,
    beat: Option<thread::JoinHandle<()>>,
    wake: Arc<(Mutex<()>, std::sync::Condvar)>,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake.1.notify_all();
        if let Some(t) = self.beat.take() {
            let _ = t.join();
        }
        if read_holder(&self.lock).as_ref() == Some(&self.mine) {
            let _ = fs::remove_file(&self.lock);
        }
    }
}

fn touch(lock: &Path) {
    if let Ok(f) = File::open(lock) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// Takes `lock`, waiting for a live holder until `deadline`.
pub fn acquire(lock: &Path, deadline: Instant) -> Result<Held, LockError> {
    acquire_as(lock, deadline, HEARTBEAT)
}

fn acquire_as(lock: &Path, deadline: Instant, heartbeat: Duration) -> Result<Held, LockError> {
    let host = this_host();
    let mine = Holder { pid: i64::from(std::process::id()), host: host.clone(), at: iso_utc(SystemTime::now()) };
    loop {
        if create(lock, &mine).map_err(LockError::Io)? {
            break;
        }
        let holder = read_holder(lock);
        // empty or unreadable: being written, never stale
        if let Some(h) = &holder {
            let gone = (h.host == host && !alive(h.pid)) || age(lock).is_some_and(|a| a > STALE);
            if gone && clear_stale(lock, h).map_err(LockError::Io)? {
                continue;
            }
        }
        if Instant::now() + POLL > deadline {
            return Err(LockError::Held(holder));
        }
        thread::sleep(POLL);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(()), std::sync::Condvar::new()));
    let beat = {
        let (stop, wake, lock) = (stop.clone(), wake.clone(), lock.to_path_buf());
        thread::spawn(move || {
            let mut guard = wake.0.lock().expect("the heartbeat's lock");
            while !stop.load(Ordering::SeqCst) {
                guard = wake.1.wait_timeout(guard, heartbeat).expect("the heartbeat's lock").0;
                if !stop.load(Ordering::SeqCst) {
                    touch(&lock);
                }
            }
        })
    };
    Ok(Held { lock: lock.to_path_buf(), mine, stop, beat: Some(beat), wake })
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ch-shim-lock-{}", random_hex()));
        fs::create_dir(&d).unwrap();
        d
    }

    #[test]
    fn the_content_is_lib_lock_js_s_byte_for_byte() {
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let h = Holder { pid: 4242, host: "devbox#pid:[4026531836]".into(), at: "2026-11-15T09:30:00.000Z".into() };
        assert_eq!(h.content(), v["startLock"]["content"].as_str().unwrap());
        assert_eq!(Holder::parse(h.content().as_bytes()), Some(h));
    }

    #[test]
    fn the_time_is_node_s_to_iso_string() {
        let t = UNIX_EPOCH + Duration::from_millis(1_763_199_000_123);
        assert_eq!(iso_utc(t), "2025-11-15T09:30:00.123Z");
        assert_eq!(iso_utc(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_host_on_linux_carries_the_pid_namespace() {
        if cfg!(target_os = "linux") {
            assert!(this_host().contains("#pid:["), "{}", this_host());
        }
    }

    #[test]
    fn taken_released_and_a_dead_holder_on_this_host_is_taken() {
        let d = dir();
        let lock = d.join("start.lock");
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(Some(_)))), "held");
        drop(held);
        assert!(!lock.exists(), "released");
        // a holder on this host whose pid is dead
        let dead = Holder { pid: 2_000_000_000, host: this_host(), at: iso_utc(SystemTime::now()) };
        fs::write(&lock, dead.content()).unwrap();
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(read_holder(&lock).unwrap().pid, i64::from(std::process::id()));
        drop(held);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn another_host_s_lock_is_waited_for_until_its_heartbeat_is_two_minutes_old() {
        let d = dir();
        let lock = d.join("start.lock");
        let other = Holder { pid: 1, host: "elsewhere".into(), at: iso_utc(SystemTime::now()) };
        fs::write(&lock, other.content()).unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(Some(h))) if h == other));
        File::open(&lock).unwrap().set_modified(SystemTime::now() - Duration::from_secs(121)).unwrap();
        drop(acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn an_empty_or_unreadable_lock_is_never_taken_for_stale() {
        let d = dir();
        let lock = d.join("start.lock");
        fs::write(&lock, "").unwrap();
        File::open(&lock).unwrap().set_modified(SystemTime::now() - Duration::from_secs(600)).unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(None))));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_lock_no_longer_ours_is_left_on_release() {
        let d = dir();
        let lock = d.join("start.lock");
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        let other = Holder { pid: 1, host: "elsewhere".into(), at: "x".into() };
        fs::write(&lock, other.content()).unwrap();
        drop(held);
        assert_eq!(read_holder(&lock), Some(other));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_heartbeat_keeps_the_mtime_fresh() {
        let d = dir();
        let lock = d.join("start.lock");
        let held = acquire_as(&lock, Instant::now() + Duration::from_secs(1), Duration::from_millis(50)).unwrap();
        File::open(&lock).unwrap().set_modified(SystemTime::now() - Duration::from_secs(600)).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(age(&lock).unwrap() < Duration::from_secs(5));
        drop(held);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn two_takers_never_hold_it_at_once() {
        let d = dir();
        let lock = Arc::new(d.join("start.lock"));
        let inside = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (lock, inside, most) = (lock.clone(), inside.clone(), most.clone());
                thread::spawn(move || {
                    for _ in 0..10 {
                        let held = acquire(&lock, Instant::now() + Duration::from_secs(20)).unwrap();
                        let n = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(n, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(2));
                        inside.fetch_sub(1, Ordering::SeqCst);
                        drop(held);
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(most.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(&d).unwrap();
    }
}
