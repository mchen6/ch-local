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

use std::fs::{self, OpenOptions};
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

/// A lock's holder, as lib/lock.js reads one: any JSON value parsed from
/// the file (readHolder), its fields compared as JavaScript compares them.
/// Ours is always {pid, host, at}; another's may lack a field, or carry a
/// value of another type, and is judged as Node would judge it.
#[derive(Debug, Clone)]
pub struct Holder {
    pub pid: Option<Value>,
    pub host: Option<Value>,
    pub at: Option<Value>,
}

impl Holder {
    pub fn ours(pid: u32, host: &str, at: &str) -> Holder {
        Holder { pid: Some(Value::from(pid)), host: Some(Value::from(host)), at: Some(Value::from(at)) }
    }

    /// The lock file's content: compact JSON, pid, host, at, then a newline.
    pub fn content(&self) -> String {
        let field = |v: &Option<Value>| v.as_ref().map_or_else(|| "null".into(), Value::to_string);
        format!("{{\"pid\":{},\"host\":{},\"at\":{}}}\n", field(&self.pid), field(&self.host), field(&self.at))
    }

    /// readHolder: None when the file is unreadable or isn't JSON, or is
    /// JSON null (`holder == null` in lib/lock.js).
    fn parse(bytes: &[u8]) -> Option<Holder> {
        let v: Value = serde_json::from_slice(bytes).ok()?;
        if v.is_null() {
            return None;
        }
        let get = |k: &str| v.get(k).cloned();
        Some(Holder { pid: get("pid"), host: get("host"), at: get("at") })
    }

    /// Number.isInteger(holder.pid): a JSON number with no fraction.
    fn integer_pid(&self) -> Option<i64> {
        let n = self.pid.as_ref()?.as_f64()?;
        (n.fract() == 0.0 && n.is_finite()).then_some(n as i64)
    }

    fn on_host(&self, host: &str) -> bool {
        self.host.as_ref().and_then(Value::as_str) == Some(host)
    }

    /// sameHolder: pid, host and at all equal (=== on JSON values: two
    /// numbers by value, two strings by content, a missing field equal to a
    /// missing field).
    fn same(&self, other: &Holder) -> bool {
        fn eq(a: &Option<Value>, b: &Option<Value>) -> bool {
            match (a, b) {
                (None, None) => true,
                (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
                (Some(Value::String(x)), Some(Value::String(y))) => x == y,
                (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
                (Some(Value::Null), Some(Value::Null)) => true,
                // objects and arrays are never === in JavaScript
                _ => false,
            }
        }
        eq(&self.pid, &other.pid) && eq(&self.host, &other.host) && eq(&self.at, &other.at)
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

// Node's os.hostname() on Windows: the DNS host name (GetComputerNameExW).
#[cfg(windows)]
fn host_name() -> String {
    crate::win_ffi::dns_hostname().unwrap_or_default()
}

/// As Node's process.kill(pid, 0): true unless it fails with anything but
/// EPERM. 0 is this process group and -n the group n, as kill(2) has them;
/// a pid kill(2) can't take (past i32) fails as Node's does, dead.
#[cfg(unix)]
pub(crate) fn alive(pid: i64) -> bool {
    use rustix::process::{Pid, test_kill_current_process_group, test_kill_process, test_kill_process_group};
    let Ok(raw) = i32::try_from(pid) else { return false };
    let r = match raw {
        0 => test_kill_current_process_group(),
        n if n > 0 => test_kill_process(Pid::from_raw(n).expect("positive")),
        n => match n.checked_neg().and_then(Pid::from_raw) {
            Some(g) => test_kill_process_group(g),
            None => return false,
        },
    };
    match r {
        Ok(()) => true,
        Err(e) => e == rustix::io::Errno::PERM,
    }
}

// As Node's process.kill(pid, 0) on Windows: OpenProcess, and not exited.
#[cfg(windows)]
pub(crate) fn alive(pid: i64) -> bool {
    match u32::try_from(pid) {
        Ok(pid) => crate::win_ffi::process_alive(pid),
        Err(_) => false,
    }
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

/// The most of a lock file read: a holder is a few dozen bytes.
const HOLDER_MAX: u64 = 4096;

/// Whether `lock`'s holder is this pid on this host (a pid means nothing in
/// another PID namespace).
pub fn held_by(lock: &Path, pid: u32) -> bool {
    read_holder(lock).is_some_and(|h| h.on_host(&this_host()) && h.integer_pid() == Some(i64::from(pid)))
}

/// readHolder, opened without following a symlink and without blocking on a
/// FIFO, at most HOLDER_MAX bytes read.
fn read_holder(lock: &Path) -> Option<Holder> {
    use std::io::Read;
    let file = open_nofollow(lock).ok()?;
    let mut bytes = Vec::new();
    file.take(HOLDER_MAX).read_to_end(&mut bytes).ok()?;
    Holder::parse(&bytes)
}

#[cfg(unix)]
fn open_nofollow(path: &Path) -> io::Result<fs::File> {
    use rustix::fs::{Mode, OFlags};
    let fd =
        rustix::fs::open(path, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?;
    Ok(fs::File::from(fd))
}

#[cfg(windows)]
fn open_nofollow(path: &Path) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)
}

/// fs.rmSync(file, {force: true}): a file already gone is not an error.
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
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
                let _ = remove(&breaker);
            }
            return Ok(false);
        }
        Err(e) => return Err(e),
    }
    // sameHolder: still the dead holder's, by JavaScript's ===
    let cleared = if read_holder(lock).is_some_and(|h| h.same(dead)) { remove(lock).map(|_| true) } else { Ok(false) };
    let _ = remove(&breaker);
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
        {
            // under the mutex, so the heartbeat can't miss the wakeup between
            // its check of `stop` and its wait
            let _guard = self.wake.0.lock().expect("the heartbeat's lock");
            self.stop.store(true, Ordering::SeqCst);
            self.wake.1.notify_all();
        }
        if let Some(t) = self.beat.take() {
            let _ = t.join();
        }
        if read_holder(&self.lock).is_some_and(|h| h.same(&self.mine)) {
            let _ = remove(&self.lock);
        }
    }
}

// opened for writing (nothing written): Windows needs FILE_WRITE_ATTRIBUTES
// to set the mtime, which a read-only handle lacks
fn touch(lock: &Path) {
    if let Ok(f) = OpenOptions::new().write(true).open(lock) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// Takes `lock`, waiting for a live holder until `deadline`.
pub fn acquire(lock: &Path, deadline: Instant) -> Result<Held, LockError> {
    acquire_as(lock, deadline, HEARTBEAT)
}

/// What a wait for the lock came to: the lock, or what its stop said.
pub enum Waited<T> {
    Held(Held),
    Stopped(T),
}

/// acquire, asking `stop` at each turn of the wait: what it says ends it.
pub fn acquire_unless<T>(
    lock: &Path,
    deadline: Instant,
    stop: impl FnMut() -> Option<T>,
) -> Result<Waited<T>, LockError> {
    acquire_with(lock, deadline, HEARTBEAT, stop)
}

fn acquire_as(lock: &Path, deadline: Instant, heartbeat: Duration) -> Result<Held, LockError> {
    match acquire_with(lock, deadline, heartbeat, || None::<std::convert::Infallible>)? {
        Waited::Held(h) => Ok(h),
        Waited::Stopped(never) => match never {},
    }
}

fn acquire_with<T>(
    lock: &Path,
    deadline: Instant,
    heartbeat: Duration,
    mut stop: impl FnMut() -> Option<T>,
) -> Result<Waited<T>, LockError> {
    let host = this_host();
    let mine = Holder::ours(std::process::id(), &host, &iso_utc(SystemTime::now()));
    loop {
        if create(lock, &mine).map_err(LockError::Io)? {
            break;
        }
        let holder = read_holder(lock);
        // empty or unreadable: being written, never stale
        // lib/lock.js: gone = holder != null && Number.isInteger(holder.pid)
        //   && ((holder.host === host && !alive(holder.pid)) || heartbeatAge > STALE_MS)
        if let Some(h) = &holder {
            if let Some(pid) = h.integer_pid() {
                let gone = (h.on_host(&host) && !alive(pid)) || age(lock).is_some_and(|a| a > STALE);
                if gone && clear_stale(lock, h).map_err(LockError::Io)? {
                    continue;
                }
            }
        }
        if let Some(t) = stop() {
            return Ok(Waited::Stopped(t));
        }
        if Instant::now() + POLL > deadline {
            return Err(LockError::Held(holder));
        }
        thread::sleep(POLL);
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(()), std::sync::Condvar::new()));
    let beat = {
        let (stop, wake, lock) = (stopped.clone(), wake.clone(), lock.to_path_buf());
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
    Ok(Waited::Held(Held { lock: lock.to_path_buf(), mine, stop: stopped, beat: Some(beat), wake }))
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs::File;
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
        let h = Holder::ours(4242, "devbox#pid:[4026531836]", "2026-11-15T09:30:00.000Z");
        assert_eq!(h.content(), v["startLock"]["content"].as_str().unwrap());
        assert!(Holder::parse(h.content().as_bytes()).unwrap().same(&h));
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
        let dead = Holder::ours(2_000_000_000, &this_host(), &iso_utc(SystemTime::now()));
        fs::write(&lock, dead.content()).unwrap();
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(read_holder(&lock).unwrap().integer_pid(), Some(i64::from(std::process::id())));
        drop(held);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn another_host_s_lock_is_waited_for_until_its_heartbeat_is_two_minutes_old() {
        let d = dir();
        let lock = d.join("start.lock");
        let other = Holder::ours(1, "elsewhere", &iso_utc(SystemTime::now()));
        fs::write(&lock, other.content()).unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(Some(h))) if h.same(&other)));
        File::open(&lock).unwrap().set_modified(SystemTime::now() - Duration::from_secs(121)).unwrap();
        drop(acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_wait_ends_as_soon_as_its_stop_says_so_and_takes_nothing() {
        let d = dir();
        let lock = d.join("start.lock");
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        let asked = AtomicUsize::new(0);
        let began = Instant::now();
        let r = acquire_unless(&lock, began + Duration::from_secs(20), || {
            (asked.fetch_add(1, Ordering::SeqCst) == 2).then_some("gave up")
        });
        assert!(matches!(r, Ok(Waited::Stopped("gave up"))));
        assert!(began.elapsed() < Duration::from_secs(5), "{:?}", began.elapsed());
        assert!(lock.exists(), "the holder's, still");
        drop(held);
        // free: taken, whatever the stop would say
        assert!(matches!(
            acquire_unless(&lock, Instant::now() + Duration::from_secs(1), || Some(())),
            Ok(Waited::Held(_))
        ));
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
    fn holders_are_judged_as_lib_lock_js_judges_them() {
        let d = dir();
        let lock = d.join("start.lock");
        // no `at`, an integer pid in float form, another host, a stale
        // heartbeat: Node clears it, so the shim must too
        fs::write(&lock, "{\"pid\":123.0,\"host\":\"elsewhere\"}\n").unwrap();
        File::open(&lock).unwrap().set_modified(SystemTime::now() - Duration::from_secs(180)).unwrap();
        drop(acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap());
        // pid 0 on this host: kill(0, 0) is this process group, alive, so a
        // fresh lock is held
        fs::write(
            &lock,
            format!("{{\"pid\":0,\"host\":{},\"at\":\"x\"}}\n", serde_json::to_string(&this_host()).unwrap()),
        )
        .unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(Some(_)))));
        // a pid that isn't an integer is never gone, however old
        fs::write(&lock, "{\"pid\":1.5,\"host\":\"elsewhere\",\"at\":\"x\"}\n").unwrap();
        File::open(&lock).unwrap().set_modified(SystemTime::now() - Duration::from_secs(600)).unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(Some(_)))));
        // JSON null is no holder (unreadable), never stale
        fs::write(&lock, "null").unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(None))));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_lock_no_longer_ours_is_left_on_release() {
        let d = dir();
        let lock = d.join("start.lock");
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        let other = Holder::ours(1, "elsewhere", "x");
        fs::write(&lock, other.content()).unwrap();
        drop(held);
        assert!(read_holder(&lock).unwrap().same(&other));
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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn a_lock_round_trip_and_a_dead_holder_on_this_host() {
        let d = std::env::temp_dir().join(format!("ch-shim-lock-{}", random_hex()));
        fs::create_dir(&d).unwrap();
        let lock = d.join("start.lock");
        let held = acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap();
        assert!(matches!(acquire(&lock, Instant::now()), Err(LockError::Held(Some(_)))));
        drop(held);
        assert!(!lock.exists());
        // a pid that no process has (Windows pids are multiples of 4)
        let dead = Holder::ours(4_000_000_002, &this_host(), &iso_utc(SystemTime::now()));
        fs::write(&lock, dead.content()).unwrap();
        drop(acquire(&lock, Instant::now() + Duration::from_secs(1)).unwrap());
        // the heartbeat sets the mtime through a writable handle
        let held = acquire_as(&lock, Instant::now() + Duration::from_secs(1), Duration::from_millis(50)).unwrap();
        OpenOptions::new()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(600))
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(age(&lock).unwrap() < Duration::from_secs(5));
        drop(held);
        fs::remove_dir_all(&d).unwrap();
    }
}
