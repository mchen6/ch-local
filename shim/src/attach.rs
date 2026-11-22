//! Attaching: from the home's files to a WELCOMEd connection, within the
//! spec's 20 s (contract 2, sections 1 and 6).
//!
//! Each try reads daemon.json, the secret and the endpoint, every one
//! trust-checked, then connects and makes the handshake with a nonce from
//! the OS. The connect and the handshake run bounded by min(5 s, what is
//! left of the 20 s), on a worker thread, so a runtime (or a squatter) that
//! accepts and never answers can't hold the shim past its budget on any
//! platform; a Windows pipe read has no timeout of its own.
//!
//! When there is no daemon, its pid is dead, or its socket refuses or is
//! gone (a daemon.json left by a crash, its pid reused), one is started under
//! start.lock, once per attach; then the shim polls for it. Then, by what
//! happened:
//! - a PROVE whose ms doesn't check, or BAD_PROOF: the runtime may have
//!   restarted with a new secret, so the files are read again (100 ms on);
//! - RESUME_REFUSED: at once, as a new session, without `resume` (once: a
//!   new session has no resume to refuse);
//! - BUSY, SHUTTING_DOWN, a file missing, half-written or replaced while
//!   checked, a timeout: again after 100 ms to 2 s, randomised;
//! - PROTOCOL, an unknown code, a file that fails its trust check: stop,
//!   saying why;
//! - 20 s gone: give up, saying the last reason. Only the first attach of a
//!   shim that itself started the daemon may go on to COLD_BUDGET: that daemon
//!   and its runtime are starting from nothing, and on a busy machine can
//!   outlast the plain 20 s budget.

use std::fmt;
use std::io;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{self, ConfigError, Home};
use crate::daemon;
use crate::endpoint::{self, Conn};
use crate::frame;
use crate::handshake::{self, HandshakeError, Refusal, Welcome};
use crate::trust::TrustKind;

/// How long an attach may take in all.
pub const BUDGET: Duration = Duration::from_secs(20);
/// How long the first attach of a shim that itself started the daemon may
/// take: under Claude Code's 30 s for a stdio server's connection, which also
/// covers its one retry, with 2 s for the answer to reach it. Past BUDGET a
/// give-up there leaves the retry too little time, and the server failed for
/// the session (measured on 2.1.330, the dry run, 11-22).
pub const COLD_BUDGET: Duration = Duration::from_secs(28);
/// A daemon spawned later than this into the attach may wait its whole cold
/// bound (25 s from its own start, lib/daemon.js COLD_READY_MS) past the
/// shim's: no extension for it. 28 = 1 of this + 25 + 2 to answer.
const SPAWN_WINDOW: Duration = Duration::from_secs(1);
/// After the daemon releases start.lock, its runtime is up: one bounded last
/// attach, never on to the cold deadline.
const RELEASE_GRACE: Duration = Duration::from_secs(2);
/// The longest one connect and handshake may take.
const HANDSHAKE_LIMIT: Duration = Duration::from_secs(5);
/// The pause before the files are read again after a wrong proof.
const REREAD_PAUSE: Duration = Duration::from_millis(100);
/// How often a started daemon is looked for.
const POLL: Duration = Duration::from_millis(200);

pub struct Attached {
    pub conn: Box<dyn Conn>,
    pub welcome: Welcome,
    /// The session is new (no resume token was held, or it was refused):
    /// the caller sends `replay` with its records.
    pub new_session: bool,
}

#[derive(Debug)]
pub enum AttachError {
    /// Not to be retried: the reason, for stderr and the -32603 answers.
    Stop(String),
    /// A daemon gave up (a fresh, valid failed.json): the session runs its
    /// own runtime, or refuses to if it holds records (#236 section 6).
    SharedFailed(crate::failed::Reason),
    /// The budget ran out; the last reason.
    GaveUp(String),
}

impl fmt::Display for AttachError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttachError::Stop(why) => write!(f, "{why}"),
            AttachError::SharedFailed(r) => write!(f, "the shared runtime failed ({r})"),
            AttachError::GaveUp(why) => write!(f, "no answer within {why}"),
        }
    }
}

enum Next {
    /// Read the files again, after REREAD_PAUSE.
    Reread(String),
    /// RESUME_REFUSED.
    NewSession,
    /// A daemon is starting: look again after POLL.
    Poll(String),
    /// Wait 100 ms to 2 s, then try again.
    Later(String),
    Stop(String),
    /// A fresh, valid failed.json.
    Failed(crate::failed::Reason),
}

fn nonce() -> [u8; 32] {
    let mut nc = [0u8; 32];
    getrandom::fill(&mut nc).expect("the OS gives random bytes");
    nc
}

fn jitter() -> Duration {
    let mut b = [0u8; 2];
    getrandom::fill(&mut b).expect("the OS gives random bytes");
    Duration::from_millis(100 + u64::from(u16::from_le_bytes(b)) % 1901)
}

fn config_next(e: ConfigError) -> Next {
    match e {
        // missing, or replaced while it was checked, while a daemon starts,
        // stops or restarts: again; half-written JSON: again; a file that is
        // there and fails its trust check: stop
        ConfigError::Trust(t) if t.kind != TrustKind::Refused => Next::Later(t.to_string()),
        // daemon.json's `socket` null is Malformed too, on purpose: the daemon
        // clears it when a runtime ends and writes the successor's once that
        // one listens (C4c; a new pipe name each start on Windows), so it is
        // "not yet", never a stop (a_null_socket_in_daemon_json_is_waited_for_not_a_stop)
        ConfigError::Malformed { .. } => Next::Later(e.to_string()),
        other => Next::Stop(other.to_string()),
    }
}

/// Runs `f` on a worker thread for at most `limit`; None past it. A worker
/// left behind ends when its blocking call does, or with the process.
fn bounded<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(limit).ok()
}

/// Attaches within BUDGET, resuming `resume` if given.
pub fn attach(home: &Home, resume: Option<&str>) -> Result<Attached, AttachError> {
    attach_within(home, resume, Instant::now() + BUDGET)
}

/// The startup fallback's check (#236 section 6): with no live daemon,
/// a fresh, valid failed.json's reason. A live daemon wins: it is attached to
/// as always.
pub fn startup_fallback(home: &Home) -> Option<crate::failed::Reason> {
    if let Ok(Some(info)) = config::read_daemon(home) {
        if daemon::live(&info) {
            return None;
        }
    }
    crate::failed::read(home)
}

pub fn attach_within(home: &Home, resume: Option<&str>, deadline: Instant) -> Result<Attached, AttachError> {
    attach_until(home, resume, deadline, None)
}

/// A shim's first attach: `deadline`, or `cold` while the daemon this attach
/// itself spawned is the one starting: it has taken start.lock (a first start
/// holds it until its runtime is ready) and hasn't ended. The shim that spawned
/// a daemon releases the lock before that daemon has booted, so a second shim
/// can spawn one too; that one never gets the lock, and keeps `deadline`, as
/// does a shim that found a daemon running.
pub fn attach_first(
    home: &Home,
    resume: Option<&str>,
    deadline: Instant,
    cold: Instant,
) -> Result<Attached, AttachError> {
    attach_until(home, resume, deadline, Some(cold))
}

fn attach_until(
    home: &Home,
    resume: Option<&str>,
    deadline: Instant,
    cold: Option<Instant>,
) -> Result<Attached, AttachError> {
    let began = Instant::now();
    let plain = deadline;
    let mut deadline = deadline;
    let mut budget = BUDGET;
    let mut took_lock = false;
    let mut released: Option<Instant> = None;
    let mut resume = resume.map(String::from);
    let mut spawned: Option<daemon::Started> = None;
    let mut last = String::from("not tried");
    while Instant::now() < deadline {
        let tried = try_once(home, resume.as_deref(), deadline, &mut spawned);
        if let (Some(child), Some(c)) = (spawned.as_ref(), cold) {
            let in_time = child.spawned_at.saturating_duration_since(began) <= SPAWN_WINDOW;
            let holds = in_time && !child.ended() && crate::lock::held_by(&home.start_lock(), child.pid);
            (deadline, budget) = if holds {
                took_lock = true;
                released = None;
                (c, COLD_BUDGET)
            } else if took_lock && !child.ended() {
                // released: its runtime is up, or it is about to say why not
                let until = *released.get_or_insert_with(|| (Instant::now() + RELEASE_GRACE).min(c));
                (plain.max(until), if until > plain { COLD_BUDGET } else { BUDGET })
            } else {
                (plain, BUDGET)
            };
        }
        let until = deadline;
        let pause = |d: Duration| thread::sleep(d.min(until.saturating_duration_since(Instant::now())));
        match tried {
            Ok((conn, welcome)) => return Ok(Attached { conn, welcome, new_session: resume.is_none() }),
            Err(Next::NewSession) if resume.is_some() => resume = None,
            Err(Next::NewSession) => {
                last = "the runtime refused a new session as a resume".into();
                pause(jitter());
            }
            Err(Next::Stop(why)) => return Err(AttachError::Stop(why)),
            Err(Next::Failed(r)) => return Err(AttachError::SharedFailed(r)),
            Err(Next::Reread(why)) => {
                last = why;
                pause(REREAD_PAUSE);
            }
            Err(Next::Poll(why)) => {
                last = why;
                pause(POLL);
            }
            Err(Next::Later(why)) => {
                last = why;
                pause(jitter());
            }
        }
    }
    // (a daemon of this shim's that gave up as the deadline passed: its
    // failed.json is read once more, so the session falls back)
    if spawned.is_some() {
        if let Some(r) = crate::failed::read(home) {
            return Err(AttachError::SharedFailed(r));
        }
    }
    // (past a release the wait ended before the cold budget: the time it took)
    let waited = if released.is_some() && budget == COLD_BUDGET {
        (began.elapsed().as_millis() as u64 + 500) / 1000
    } else {
        budget.as_secs()
    };
    Err(AttachError::GaveUp(format!("{waited} s ({last})")))
}

/// No reachable daemon: start one, once per attach.
fn start(home: &Home, deadline: Instant, spawned: &mut Option<daemon::Started>) -> Next {
    if spawned.is_some() {
        // (a daemon that gave up says so in failed.json: read at every poll,
        // so the session falls back at once, never only at the budget's
        // end -- A4, the final pass)
        if let Some(r) = crate::failed::read(home) {
            return Next::Failed(r);
        }
        return Next::Poll("waiting for the daemon this shim started".into());
    }
    // the daemon.json check failed: a daemon that gave up says so here
    // (#236 section 6), read first now, and again under the start lock
    if let Some(r) = crate::failed::read(home) {
        return Next::Failed(r);
    }
    match daemon::ensure_started(home, deadline) {
        Ok(Some(child)) => {
            *spawned = Some(child);
            Next::Poll("the daemon is starting".into())
        }
        // another started one, under the lock: try it at once
        Ok(None) => Next::Reread("a daemon is running".into()),
        Err(daemon::StartError::Config(c)) => config_next(c),
        Err(daemon::StartError::Failed(r)) => Next::Failed(r),
        Err(other) => Next::Later(other.to_string()),
    }
}

/// A connection and its handshake's outcome.
type Tried = (Box<dyn Conn>, Result<Welcome, HandshakeError>);

fn unreachable_kind(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused)
}

fn try_once(
    home: &Home,
    resume: Option<&str>,
    deadline: Instant,
    spawned: &mut Option<daemon::Started>,
) -> Result<(Box<dyn Conn>, Welcome), Next> {
    let info = match config::read_daemon(home).map_err(config_next)? {
        Some(info) if daemon::live(&info) => info,
        _ => return Err(start(home, deadline, spawned)),
    };
    let secret = config::read_secret(home).map_err(config_next)?;
    let end = match endpoint::check(&info.socket) {
        Ok(e) => e,
        // no socket where daemon.json says: a crashed daemon's file
        Err(_) if !endpoint::exists(&info.socket) => return Err(start(home, deadline, spawned)),
        Err(e) => return Err(Next::Stop(e.to_string())),
    };
    let limit = HANDSHAKE_LIMIT.min(deadline.saturating_duration_since(Instant::now()));
    let resume = resume.map(String::from);
    let outcome = bounded(limit, move || -> Result<Tried, io::Error> {
        let mut conn = endpoint::connect(&end)?;
        let _ = conn.set_read_timeout(Some(limit.max(Duration::from_millis(1))));
        let w = handshake::attach(&mut conn, &secret, nonce(), resume.as_deref());
        Ok((conn, w))
    });
    let (conn, result) = match outcome {
        None => return Err(Next::Later(format!("the runtime did not answer within {} ms", limit.as_millis()))),
        Some(Err(e)) if unreachable_kind(&e) => return Err(start(home, deadline, spawned)),
        Some(Err(e)) => return Err(Next::Later(format!("connecting: {e}"))),
        Some(Ok(x)) => x,
    };
    match result {
        Ok(w) => {
            let _ = conn.set_read_timeout(None);
            Ok((conn, w))
        }
        Err(HandshakeError::WrongProof) => Err(Next::Reread("the runtime's proof did not check".into())),
        // a REFUSED other than PROTOCOL before a checked PROVE counts as a
        // wrong ms (#236 §1, b17f9ca): the files are read again
        Err(HandshakeError::Unexpected(frame::Kind::Refused)) => {
            Err(Next::Reread("the runtime's proof did not check".into()))
        }
        // fixed text only: the peer proved nothing
        Err(HandshakeError::UnprovenProtocol) => {
            Err(Next::Later("a peer that has not proven this home's secret refused the protocol".into()))
        }
        Err(HandshakeError::Refused { refusal, message }) => Err(match refusal {
            Refusal::BadProof => Next::Reread(format!("the runtime refused the proof ({message})")),
            Refusal::ResumeRefused => Next::NewSession,
            Refusal::Busy | Refusal::ShuttingDown => Next::Later(format!("the runtime is busy ({message})")),
            Refusal::Protocol => Next::Stop("the shim and the runtime are different releases (PROTOCOL)".into()),
            Refusal::Unknown(code) => Next::Stop(format!("the runtime refused with {code}: {message}")),
        }),
        Err(other) => Err(Next::Later(other.to_string())),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::thread;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as B64;
    use serde_json::Value;

    use super::*;
    use crate::frame::{self, Caps, Kind};
    use crate::{mac, secret};

    const CAPS: Caps = Caps { message: 1 << 20 };

    struct TestHome {
        home: Home,
    }
    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.home.root());
        }
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn private(path: &Path, body: &[u8]) {
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn home() -> TestHome {
        // the harness's threads mean these tests can't sweep for real
        crate::unix_ffi::assume_swept();
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        let root = std::env::temp_dir().join(format!("ch-shim-attach-{}", hex(&b)));
        let run = root.join("run").join("daemon");
        fs::create_dir_all(&run).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
        TestHome { home: Home::new(&root).unwrap() }
    }

    fn write_secret(h: &Home, bytes: &[u8; 32]) {
        private(&h.secret(), format!("{}\n", hex(bytes)).as_bytes());
    }

    fn socket_of(h: &Home) -> PathBuf {
        h.run_dir().join("s.sock")
    }

    fn write_daemon_json(h: &Home) {
        let d = serde_json::json!({"pid": std::process::id(), "socket": socket_of(h), "runtimeVersion": "8.0.0", "daemonVersion": "0.1.0", "started": "2026-11-15T00:00:00.000Z"});
        private(&h.daemon_json(), d.to_string().as_bytes());
    }

    #[derive(Clone)]
    enum Reply {
        Welcome,
        Refuse(&'static str),
        /// PROVE made with this other secret; the runtime then writes it to
        /// the secret file, as a restarted runtime would
        RestartedWith([u8; 32]),
    }

    /// A runtime written from the contract: serves one connection per reply
    /// and reports each AUTH's `resume`.
    fn fake_runtime(h: &Home, secret_bytes: [u8; 32], replies: Vec<Reply>) -> mpsc::Receiver<Option<String>> {
        let listener = UnixListener::bind(socket_of(h)).unwrap();
        let (tx, rx) = mpsc::channel();
        let secret_path = h.secret();
        thread::spawn(move || {
            let mut key = secret_bytes;
            for reply in replies {
                let Ok((mut s, _)) = listener.accept() else { return };
                let (k, hello) = frame::read_frame(&mut s, CAPS).unwrap();
                assert_eq!(k, Kind::Hello);
                let hello: Value = serde_json::from_slice(&hello).unwrap();
                assert_eq!(hello["protocol"], 1);
                let nc: [u8; 32] = B64.decode(hello["nc"].as_str().unwrap()).unwrap().try_into().unwrap();
                let mut ns = [0u8; 32];
                getrandom::fill(&mut ns).unwrap();
                let prove_key = match &reply {
                    Reply::RestartedWith(other) => {
                        // a restarted runtime writes its new secret before it
                        // listens: the shim's re-read finds it
                        private(&secret_path, format!("{}\n", hex(other)).as_bytes());
                        *other
                    }
                    _ => key,
                };
                let sk = secret::parse(format!("{}\n", hex(&prove_key)).as_bytes()).unwrap();
                let ms = mac::server_proof(&sk, 1, &nc, &ns);
                let prove = format!("{{\"ns\":\"{}\",\"ms\":\"{}\"}}", B64.encode(ns), B64.encode(ms));
                frame::write_frame(&mut s, Kind::Prove, prove.as_bytes(), CAPS).unwrap();
                if let Reply::RestartedWith(other) = reply {
                    // the shim must close, sending nothing more
                    let mut rest = Vec::new();
                    let _ = s.read_to_end(&mut rest);
                    assert!(rest.is_empty(), "the shim sent {} bytes after a wrong PROVE", rest.len());
                    key = other;
                    tx.send(None).unwrap();
                    continue;
                }
                let (k, auth) = frame::read_frame(&mut s, CAPS).unwrap();
                assert_eq!(k, Kind::Auth);
                let auth: Value = serde_json::from_slice(&auth).unwrap();
                assert_eq!(B64.decode(auth["mc"].as_str().unwrap()).unwrap(), mac::client_proof(&sk, 1, &nc, &ns));
                tx.send(auth.get("resume").and_then(Value::as_str).map(String::from)).unwrap();
                let answer = match reply {
                    Reply::Welcome => (Kind::Welcome, r#"{"session":"s1","resumeToken":"rt_next","runtimeVersion":"8.0.0","maxToRuntime":8392704,"maxToShim":537919488}"#.to_string()),
                    Reply::Refuse(code) => (Kind::Refused, format!(r#"{{"code":"{code}","message":"m"}}"#)),
                    Reply::RestartedWith(_) => unreachable!(),
                };
                frame::write_frame(&mut s, answer.0, answer.1.as_bytes(), CAPS).unwrap();
                let _ = s.flush();
            }
        });
        rx
    }

    fn ready(replies: Vec<Reply>) -> (TestHome, mpsc::Receiver<Option<String>>) {
        let t = home();
        let key = [7u8; 32];
        write_secret(&t.home, &key);
        write_daemon_json(&t.home);
        let rx = fake_runtime(&t.home, key, replies);
        (t, rx)
    }

    #[test]
    fn it_attaches_and_is_welcomed() {
        let (t, rx) = ready(vec![Reply::Welcome]);
        let a = attach(&t.home, None).unwrap();
        assert_eq!((a.welcome.resume_token.as_str(), a.new_session), ("rt_next", true));
        assert_eq!(rx.recv().unwrap(), None, "no resume sent");
    }

    #[test]
    fn a_refused_resume_becomes_a_new_session_without_the_token() {
        let (t, rx) = ready(vec![Reply::Refuse("RESUME_REFUSED"), Reply::Welcome]);
        let a = attach(&t.home, Some("rt_old")).unwrap();
        assert!(a.new_session);
        assert_eq!(rx.recv().unwrap().as_deref(), Some("rt_old"));
        assert_eq!(rx.recv().unwrap(), None);
    }

    #[test]
    fn a_resume_accepted_is_not_a_new_session() {
        let (t, rx) = ready(vec![Reply::Welcome]);
        assert!(!attach(&t.home, Some("rt_old")).unwrap().new_session);
        assert_eq!(rx.recv().unwrap().as_deref(), Some("rt_old"));
    }

    #[test]
    fn busy_is_tried_again_and_protocol_stops() {
        let (t, _rx) = ready(vec![Reply::Refuse("BUSY"), Reply::Welcome]);
        let started = Instant::now();
        attach(&t.home, None).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100), "after the jitter");
        let (t, _rx) = ready(vec![Reply::Refuse("PROTOCOL")]);
        assert!(matches!(attach(&t.home, None), Err(AttachError::Stop(w)) if w.contains("different releases")));
    }

    #[test]
    fn a_runtime_restarted_with_a_new_secret_is_attached_after_the_files_are_read_again() {
        let t = home();
        write_secret(&t.home, &[7u8; 32]);
        write_daemon_json(&t.home);
        let rx = fake_runtime(&t.home, [7u8; 32], vec![Reply::RestartedWith([9u8; 32]), Reply::Welcome]);
        attach(&t.home, None).unwrap();
        assert_eq!(rx.recv().unwrap(), None, "the wrong PROVE: nothing more was sent");
        assert_eq!(rx.recv().unwrap(), None, "then attached under the new secret");
    }

    #[test]
    fn a_secret_that_fails_its_check_stops_it() {
        let (t, _rx) = ready(vec![]);
        fs::set_permissions(t.home.secret(), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(attach(&t.home, None), Err(AttachError::Stop(w)) if w.contains("0644")));
    }

    /// A4 (the final pass): once this shim has started a daemon, a failed.json
    /// that daemon writes (it gave up) is seen at the next poll, never only
    /// at the budget's end: the session falls back at once, with its reason.
    #[test]
    fn a_daemon_this_shim_started_that_gives_up_is_seen_at_the_next_poll() {
        let t = home();
        let script = t.home.root().join("fake-ch-local.sh");
        let spawned = t.home.root().join("spawned");
        // (the stand-in daemon marks that it ran: failed.json is written only
        // after the spawn, so the read after it is the path that runs)
        fs::write(&script, format!("touch '{}'\n", spawned.display())).unwrap();
        let shim = serde_json::json!({"node": "/bin/sh", "chLocal": script, "env": {"PATH": "/usr/bin:/bin", "HOME": t.home.root()}});
        private(&t.home.shim_json(), shim.to_string().as_bytes());
        let failed = t.home.run_dir().join("failed.json");
        // (written after the spawn, as a daemon that never listened writes it)
        let writer = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(10);
            while !spawned.exists() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(spawned.exists(), "the daemon was spawned");
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
            private(
                &failed,
                format!(r#"{{"v":1,"at":{at},"exit":null,"signal":null,"reason":"never-listened"}}"#).as_bytes(),
            );
        });
        let started = Instant::now();
        let r = attach_within(&t.home, None, Instant::now() + Duration::from_secs(15));
        writer.join().unwrap();
        assert!(matches!(r, Err(AttachError::SharedFailed(_))), "{:?}", r.as_ref().err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "seen at the next poll, not the budget's end: {:?}",
            started.elapsed()
        );
    }

    // The cold start (the dry run, 11-22): only the FIRST attach of a shim that
    // itself started the daemon may wait past BUDGET, up to COLD_BUDGET. Each
    // other attach keeps its own deadline, so the contract's "attaches within
    // its 20 s" stays true for them.
    // A stand-in daemon that takes start.lock as itself (a real first start
    // holds it until its runtime is ready), then runs `after`.
    fn stand_in(t: &TestHome, holder: &str, after: &str) -> std::path::PathBuf {
        stand_in_on(t, holder, &crate::lock::this_host(), after)
    }
    fn stand_in_on(t: &TestHome, holder: &str, host: &str, after: &str) -> std::path::PathBuf {
        let script = t.home.root().join("fake-ch-local.sh");
        let spawned = t.home.root().join("spawned");
        let run = t.home.run_dir();
        fs::write(
            &script,
            format!(
                "umask 077\nmkdir -p '{run}'\nprintf '{{\"pid\":%s,\"host\":\"{host}\",\"at\":\"a\"}}\\n' {holder} > '{lock}'\ntouch '{spawned}'\n{after}\n",
                run = run.display(),
                lock = t.home.start_lock().display(),
                spawned = spawned.display(),
            ),
        )
        .unwrap();
        let shim = serde_json::json!({"node": "/bin/sh", "chLocal": script, "env": {"PATH": "/usr/bin:/bin", "HOME": t.home.root()}});
        private(&t.home.shim_json(), shim.to_string().as_bytes());
        spawned
    }
    fn stand_in_daemon(t: &TestHome) -> std::path::PathBuf {
        stand_in(t, "$$", "sleep 4")
    }

    /// A daemon that lost the race (the first shim released start.lock before
    /// its own daemon had booted, and this shim spawned a second): the lock
    /// is the other's, so this shim keeps its deadline.
    #[test]
    fn a_first_attach_whose_daemon_does_not_hold_the_lock_keeps_its_deadline() {
        let t = home();
        let spawned = stand_in(&t, "1", "sleep 4");
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(500), now + Duration::from_millis(3000));
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() < Duration::from_millis(2500), "the plain deadline: {:?}", now.elapsed());
        assert!(spawned.exists(), "it did spawn one");
        assert!(r.err().unwrap().to_string().starts_with(&format!("no answer within {} s", BUDGET.as_secs())));
    }

    /// A holder with this child's pid in another PID namespace is not this
    /// child: pids aren't comparable across hosts.
    #[test]
    fn a_holder_with_the_same_pid_on_another_host_is_not_this_shims_daemon() {
        let t = home();
        let spawned = stand_in_on(&t, "$$", "another-host#pid:[1]", "sleep 4");
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(500), now + Duration::from_millis(3000));
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() < Duration::from_millis(2500), "the plain deadline: {:?}", now.elapsed());
        assert!(spawned.exists());
    }

    /// A daemon spawned late (this shim first waited on start.lock) may wait
    /// its whole cold bound from then, past the shim's: no extension.
    #[test]
    fn a_first_attach_that_spawned_late_keeps_its_deadline() {
        let t = home();
        let spawned = stand_in_daemon(&t);
        fs::create_dir_all(t.home.run_dir()).unwrap();
        fs::set_permissions(t.home.run_dir(), fs::Permissions::from_mode(0o700)).unwrap();
        let held = crate::lock::acquire(&t.home.start_lock(), Instant::now() + Duration::from_secs(2)).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(SPAWN_WINDOW + Duration::from_millis(300));
            drop(held);
        });
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(2600), now + Duration::from_millis(6000));
        release.join().unwrap();
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(spawned.exists(), "it spawned once the lock was free");
        assert!(now.elapsed() < Duration::from_millis(4500), "the plain deadline: {:?}", now.elapsed());
    }

    /// The longer budget ends with the start it was for: once the daemon has
    /// released start.lock, one bounded last attach, never on to the cold
    /// deadline.
    #[test]
    fn the_extension_ends_when_the_daemon_releases_the_lock() {
        let t = home();
        let lock = t.home.start_lock();
        let spawned = stand_in(&t, "$$", &format!("sleep 0.6; rm -f '{}'; sleep 9", lock.display()));
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(600), now + Duration::from_secs(8));
        let waited = now.elapsed();
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(waited >= RELEASE_GRACE, "it saw the lock held, then released: {waited:?}");
        assert!(waited < RELEASE_GRACE + Duration::from_millis(1500), "not to the cold deadline: {waited:?}");
        assert!(spawned.exists());
        // the line says the time it waited, not the budget it no longer had
        let text = r.err().unwrap().to_string();
        let said: u64 = text
            .strip_prefix("no answer within ")
            .and_then(|rest| rest.split(' ').next())
            .and_then(|n| n.parse().ok())
            .unwrap_or_else(|| panic!("{text}"));
        assert!(said < COLD_BUDGET.as_secs() && said <= waited.as_secs() + 1, "{text} after {waited:?}");
    }

    /// A daemon that gave up and ended past the plain deadline: its failed.json
    /// is read before giving up, so the session falls back.
    #[test]
    fn a_daemon_that_gave_up_past_the_plain_deadline_is_seen() {
        let t = home();
        let failed = t.home.run_dir().join("failed.json");
        let after = format!(
            "sleep 0.7; printf '{{\"v\":1,\"at\":%s000,\"exit\":null,\"signal\":null,\"reason\":\"never-listened\"}}' \"$(date +%s)\" > '{}'; exit 1",
            failed.display()
        );
        stand_in(&t, "$$", &after);
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(300), now + Duration::from_secs(5));
        assert!(matches!(r, Err(AttachError::SharedFailed(_))), "{:?}", r.as_ref().err());
    }

    /// A daemon that held the lock and ended (with no failed.json) ends the
    /// extension: the shim doesn't poll a dead process to the cold deadline.
    #[test]
    fn a_first_attach_whose_daemon_ended_goes_back_to_its_deadline() {
        let t = home();
        let spawned = stand_in(&t, "$$", "sleep 0.3; exit 2");
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(900), now + Duration::from_millis(4000));
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() < Duration::from_millis(3000), "not to the cold deadline: {:?}", now.elapsed());
        assert!(spawned.exists());
    }

    #[test]
    fn the_first_attach_of_a_shim_that_started_the_daemon_waits_to_the_cold_deadline() {
        let t = home();
        let spawned = stand_in_daemon(&t);
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(400), now + Duration::from_millis(1400));
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() >= Duration::from_millis(1300), "it waited past the plain deadline: {:?}", now.elapsed());
        assert!(spawned.exists(), "it started the daemon");
        assert!(r.err().unwrap().to_string().starts_with(&format!("no answer within {} s", COLD_BUDGET.as_secs())));
    }

    /// The point of it: a daemon that comes up after the plain deadline, and
    /// before the cold one, is attached to.
    #[test]
    fn a_daemon_that_listens_after_the_plain_deadline_is_attached_to() {
        let t = home();
        let spawned = stand_in_daemon(&t);
        let key = [7u8; 32];
        let root = t.home.clone();
        let late = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(10);
            while !spawned.exists() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(Duration::from_millis(700));
            write_secret(&root, &key);
            write_daemon_json(&root);
            fake_runtime(&root, key, vec![Reply::Welcome])
        });
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(400), now + Duration::from_secs(6));
        let _rx = late.join().unwrap();
        assert!(r.is_ok(), "{:?}", r.as_ref().err());
        assert!(now.elapsed() > Duration::from_millis(400), "past the plain deadline: {:?}", now.elapsed());
    }

    #[test]
    fn a_first_attach_that_found_a_daemon_running_keeps_its_deadline() {
        let replies = (0..60).map(|_| Reply::Refuse("BUSY")).collect();
        let (t, _rx) = ready(replies);
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(400), now + Duration::from_millis(3000));
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() < Duration::from_millis(2500), "the plain deadline: {:?}", now.elapsed());
        assert!(r.err().unwrap().to_string().starts_with(&format!("no answer within {} s", BUDGET.as_secs())));
    }

    #[test]
    fn a_second_session_during_the_same_cold_start_keeps_its_deadline() {
        let t = home();
        let spawned = stand_in_daemon(&t);
        fs::create_dir_all(t.home.run_dir()).unwrap();
        fs::set_permissions(t.home.run_dir(), fs::Permissions::from_mode(0o700)).unwrap();
        // (the first session's daemon holds start.lock while it starts)
        let held = crate::lock::acquire(&t.home.start_lock(), Instant::now() + Duration::from_secs(2)).unwrap();
        let now = Instant::now();
        let r = attach_first(&t.home, None, now + Duration::from_millis(400), now + Duration::from_millis(3000));
        drop(held);
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() < Duration::from_millis(2500), "the plain deadline: {:?}", now.elapsed());
        assert!(!spawned.exists(), "it started nothing");
    }

    #[test]
    fn a_re_attach_that_happens_to_start_a_daemon_keeps_its_deadline() {
        let t = home();
        let spawned = stand_in_daemon(&t);
        let now = Instant::now();
        let r = attach_within(&t.home, None, now + Duration::from_millis(500));
        assert!(matches!(r, Err(AttachError::GaveUp(_))), "{:?}", r.as_ref().err());
        assert!(now.elapsed() < Duration::from_millis(1400), "its own deadline: {:?}", now.elapsed());
        assert!(spawned.exists(), "it did start one");
        assert!(r.err().unwrap().to_string().starts_with(&format!("no answer within {} s", BUDGET.as_secs())));
    }

    #[test]
    fn the_cold_budget_fits_under_the_clients_thirty_seconds() {
        assert_eq!((BUDGET.as_secs(), COLD_BUDGET.as_secs()), (20, 28));
    }

    #[test]
    fn the_daemon_is_started_with_a_cleared_env_in_the_home_in_its_own_process_group() {
        let t = home();
        let out = t.home.root().join("daemon-saw");
        let script = t.home.root().join("fake-ch-local.sh");
        fs::write(&script, format!("{{ echo \"args:$*\"; echo \"cwd:$(pwd -P)\"; echo \"pid:$$ pgid:$(ps -o pgid= -p $$ | tr -d ' ')\"; /usr/bin/env; }} > '{}'\n", out.display())).unwrap();
        let shim = serde_json::json!({"node": "/bin/sh", "chLocal": script, "env": {"PATH": "/usr/bin:/bin", "HOME": t.home.root()}});
        private(&t.home.shim_json(), shim.to_string().as_bytes());
        // no daemon.json: the attach starts the daemon, then gives up (the
        // stand-in never listens)
        assert!(matches!(
            attach_within(&t.home, None, Instant::now() + Duration::from_millis(1500)),
            Err(AttachError::GaveUp(_))
        ));
        for _ in 0..50 {
            if out.exists() && fs::read_to_string(&out).unwrap().contains("PATH=") {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let saw = fs::read_to_string(&out).unwrap();
        assert!(saw.contains(&format!("args:daemon --home {}\n", t.home.root().display())), "{saw}");
        assert!(saw.contains(&format!("cwd:{}\n", fs::canonicalize(t.home.root()).unwrap().display())), "{saw}");
        let ids: Vec<&str> = saw.lines().find(|l| l.starts_with("pid:")).unwrap().split(' ').collect();
        assert_eq!(
            ids[0].trim_start_matches("pid:"),
            ids[1].trim_start_matches("pgid:"),
            "its own process group: {saw}"
        );
        for line in saw.lines().filter(|l| l.contains('=') && !l.starts_with("args:") && !l.starts_with("cwd:")) {
            let name = line.split('=').next().unwrap();
            assert!(
                ["PATH", "HOME", "PWD", "OLDPWD", "SHLVL", "_"].contains(&name),
                "the daemon was given {name}: {saw}"
            );
        }
    }

    fn script_home(t: &TestHome, runs: &Path) {
        // a stand-in ch-local whose `daemon` only counts its starts
        let script = t.home.root().join("count-starts.sh");
        fs::write(&script, format!("echo started >> '{}'\n", runs.display())).unwrap();
        let shim = serde_json::json!({"node": "/bin/sh", "chLocal": script, "env": {"PATH": "/usr/bin:/bin"}});
        private(&t.home.shim_json(), shim.to_string().as_bytes());
    }

    #[test]
    fn a_runtime_that_accepts_and_never_answers_is_given_up_on_by_the_deadline() {
        let t = home();
        write_secret(&t.home, &[7u8; 32]);
        write_daemon_json(&t.home);
        let listener = UnixListener::bind(socket_of(&t.home)).unwrap();
        thread::spawn(move || {
            let held: Vec<_> = listener.incoming().take(20).collect();
            thread::sleep(Duration::from_secs(30));
            drop(held);
        });
        let started = Instant::now();
        assert!(matches!(
            attach_within(&t.home, None, Instant::now() + Duration::from_secs(2)),
            Err(AttachError::GaveUp(_))
        ));
        assert!(started.elapsed() < Duration::from_millis(2600), "took {:?}", started.elapsed());
    }

    #[test]
    fn a_daemon_json_whose_pid_lives_but_whose_socket_is_gone_starts_a_daemon_once() {
        let t = home();
        write_secret(&t.home, &[7u8; 32]);
        // our own pid, alive: a crashed daemon's file with its pid reused
        write_daemon_json(&t.home);
        let runs = t.home.root().join("starts");
        script_home(&t, &runs);
        assert!(matches!(
            attach_within(&t.home, None, Instant::now() + Duration::from_millis(1500)),
            Err(AttachError::GaveUp(_))
        ));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(fs::read_to_string(&runs).unwrap().lines().count(), 1, "started once, then polled");
    }

    #[test]
    fn no_daemon_starts_one_once_however_long_it_takes_to_appear() {
        let t = home();
        let runs = t.home.root().join("starts");
        script_home(&t, &runs);
        assert!(matches!(
            attach_within(&t.home, None, Instant::now() + Duration::from_millis(1500)),
            Err(AttachError::GaveUp(_))
        ));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(fs::read_to_string(&runs).unwrap().lines().count(), 1);
    }

    #[test]
    fn a_runtime_refusing_every_session_as_a_resume_ends_at_the_deadline() {
        let (t, _rx) = ready(vec![Reply::Refuse("RESUME_REFUSED"); 40]);
        let started = Instant::now();
        assert!(matches!(
            attach_within(&t.home, None, Instant::now() + Duration::from_millis(1500)),
            Err(AttachError::GaveUp(_))
        ));
        assert!(started.elapsed() < Duration::from_millis(2100));
    }

    #[test]
    fn a_fifo_where_the_secret_should_be_is_refused_at_once() {
        let (t, _rx) = ready(vec![]);
        fs::remove_file(t.home.secret()).unwrap();
        // mkfifo(1): rustix has no mknodat on every platform this runs on
        let made = std::process::Command::new("mkfifo").arg("-m").arg("600").arg(t.home.secret()).status().unwrap();
        assert!(made.success());
        let started = Instant::now();
        assert!(matches!(attach(&t.home, None), Err(AttachError::Stop(w)) if w.contains("not a regular file")));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_missing_file_is_missing_not_refused() {
        let t = home();
        let e = crate::trust::read_private_in(&t.home.run_dir(), "secret", 65).unwrap_err();
        assert_eq!(e.kind, TrustKind::Missing);
    }
}

/// The Windows path, end to end, on CI's Windows legs: a runtime written
/// from the contract in Node (net's pipe server, crypto's HMAC; no unsafe
/// test code), a home made private with icacls, and the attach loop over
/// the named pipe: trust::windows check_dir and the file checks, the strict
/// pipe name, the SQOS open, the handshake.
#[cfg(all(test, windows))]
mod windows_tests {
    use std::io::{BufRead, BufReader};
    use std::path::Path;
    use std::process::{Command, Stdio};

    use super::*;

    const SERVER: &str = r#"
const net = require('net'), crypto = require('crypto');
const secret = Buffer.from(process.argv[1], 'hex'), name = process.argv[2];
const frame = (k, p) => { const h = Buffer.alloc(5); h[0] = k.charCodeAt(0); h.writeUInt32BE(p.length, 1); return Buffer.concat([h, p]); };
const mac = (label, a, b) => crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(label), Buffer.from([1]), a, b])).digest();
net.createServer((s) => {
  let buf = Buffer.alloc(0), stage = 0, nc, ns;
  s.on('error', () => {});
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
      const kind = String.fromCharCode(buf[0]), len = buf.readUInt32BE(1), p = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (stage === 0 && kind === 'H') {
        nc = Buffer.from(JSON.parse(p).nc, 'base64'); ns = crypto.randomBytes(32);
        s.write(frame('P', Buffer.from(JSON.stringify({ns: ns.toString('base64'), ms: mac('ch-server', nc, ns).toString('base64')}))));
        stage = 1;
      } else if (stage === 1 && kind === 'A') {
        if (JSON.parse(p).mc !== mac('ch-client', ns, nc).toString('base64')) { s.end(frame('R', Buffer.from('{"code":"BAD_PROOF","message":"m"}'))); return; }
        s.write(frame('W', Buffer.from(JSON.stringify({session: 's', resumeToken: 'rt_pipe', runtimeVersion: '8.0.0', maxToRuntime: 65536, maxToShim: 65536}))));
        stage = 2;
      } else if (stage === 2 && kind === 'C') {
        // the session side: settled after the first client frame
        const op = JSON.parse(p);
        if (op.op === 'client' && op.seq === undefined) s.write(frame('C', Buffer.from('{"op":"settled"}')));
        if (op.op === 'bye') s.end();
      } else if (stage === 2 && kind === 'M') {
        // a request (a seq header) is answered with that seq
        const hn = p.readUInt16BE(0), line = JSON.parse(p.subarray(2 + hn));
        if (hn > 0) {
          const header = p.subarray(0, 2 + hn);
          const body = Buffer.from(JSON.stringify({jsonrpc: '2.0', id: line.id, result: {over: 'the pipe'}}));
          s.write(frame('M', Buffer.concat([header, body])));
        }
      }
    }
  });
}).listen(name, () => console.log('listening'));
"#;

    fn icacls_private(path: &Path, me: &str) {
        let st = Command::new("icacls")
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &format!("*{me}:F"), "*S-1-5-18:F"])
            .status()
            .unwrap();
        assert!(st.success(), "icacls {}", path.display());
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// A private home whose daemon.json names a pipe a Node server holds.
    fn pipe_home() -> Option<(Home, std::process::Child)> {
        if Command::new("node").arg("-v").output().is_err() {
            assert!(std::env::var("CI").is_err(), "node is needed for this test in CI");
            return None;
        }
        let me = crate::trust::sid_string(&crate::win_ffi::current_user_sid().unwrap());
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).unwrap();
        let root = std::env::temp_dir().join(format!("ch-shim-pipe-{}", hex(&b[..6])));
        let run = root.join("run").join("daemon");
        std::fs::create_dir_all(&run).unwrap();
        icacls_private(&run, &me);
        let secret = [7u8; 32];
        let pipe = format!(r"\\.\pipe\countinghouse-{}", hex(&b));
        let files = [
            ("secret", format!("{}\n", hex(&secret))),
            ("daemon.json", serde_json::json!({"pid": std::process::id(), "socket": pipe, "runtimeVersion": "8.0.0", "daemonVersion": "0.1.0", "started": "x"}).to_string()),
        ];
        for (name, body) in files {
            let p = run.join(name);
            std::fs::write(&p, body).unwrap();
            icacls_private(&p, &me);
        }
        let mut server =
            Command::new("node").args(["-e", SERVER, &hex(&secret), &pipe]).stdout(Stdio::piped()).spawn().unwrap();
        let mut first = String::new();
        BufReader::new(server.stdout.as_mut().unwrap()).read_line(&mut first).unwrap();
        assert_eq!(first.trim(), "listening");
        Some((Home::new(&root).unwrap(), server))
    }

    #[test]
    fn it_attaches_over_a_named_pipe_to_a_runtime_that_proves_the_secret() {
        let Some((home, mut server)) = pipe_home() else { return };
        let a = attach(&home, None);
        let _ = server.kill();
        let a = a.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(a.welcome.resume_token, "rt_pipe");
        assert!(a.new_session);
    }

    /// The relay over a real named pipe (the native review: a synchronous
    /// pipe handle shared by the reader and main deadlocks on Windows,
    /// where I/O on one file object is serialized). A request must be
    /// answered within 20 s; the test fails at that deadline rather than
    /// hanging the job.
    #[test]
    fn the_relay_answers_a_request_over_a_named_pipe() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        #[derive(Clone, Default)]
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let Some((home, mut server)) = pipe_home() else { return };
        // a shim.json whose conditions child answers at once
        let me = crate::trust::sid_string(&crate::win_ffi::current_user_sid().unwrap());
        let node = String::from_utf8(Command::new("node").args(["-p", "process.execPath"]).output().unwrap().stdout)
            .unwrap()
            .trim()
            .to_string();
        let script = home.root().join("conditions.js");
        std::fs::write(
            &script,
            "console.log(JSON.stringify({status: 'ok', conditions: 'no', repo: null, token: null}))",
        )
        .unwrap();
        let shim = serde_json::json!({"node": node, "chLocal": script, "env": {"SystemRoot": std::env::var("SystemRoot").unwrap()}});
        std::fs::write(home.shim_json(), shim.to_string()).unwrap();
        icacls_private(&home.shim_json(), &me);
        let (reader, mut writer) = std::io::pipe().unwrap();
        let sink = Sink::default();
        let relay = crate::relay::Relay::new(
            crate::relay::Setup {
                home,
                rest: vec![],
                client_env: vec![],
                parent: std::process::id(),
                timing: Default::default(),
            },
            crate::out::Out::new(Box::new(sink.clone())),
        );
        std::thread::spawn(move || relay.run(reader));
        writer.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n").unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        let answered = loop {
            let got = String::from_utf8_lossy(&sink.0.lock().unwrap()).into_owned();
            if got.contains("the pipe") || Instant::now() > until {
                break got;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let _ = server.kill();
        assert!(
            answered.contains(r#""id":1"#) && answered.contains("the pipe"),
            "no answer over the pipe within 20 s: {answered:?}"
        );
    }

    #[test]
    fn a_run_directory_everyone_can_read_stops_the_attach() {
        let Some((home, mut server)) = pipe_home() else { return };
        let st = Command::new("icacls").arg(home.run_dir()).args(["/grant", "*S-1-1-0:R"]).status().unwrap();
        assert!(st.success());
        let r = attach(&home, None);
        let _ = server.kill();
        match r {
            Err(AttachError::Stop(w)) => assert!(w.contains("accessible by S-1-1-0"), "{w}"),
            Err(e) => panic!("stopped for another reason: {e}"),
            Ok(_) => panic!("attached through a run directory Everyone can read"),
        }
    }
}
