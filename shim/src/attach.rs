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
//! - 20 s gone: give up, saying the last reason.

use std::fmt;
use std::io;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{self, ConfigError, Home};
use crate::daemon;
use crate::endpoint::{self, Conn};
use crate::handshake::{self, HandshakeError, Refusal, Welcome};
use crate::trust::TrustKind;

/// How long an attach may take in all.
pub const BUDGET: Duration = Duration::from_secs(20);
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
    /// The budget ran out; the last reason.
    GaveUp(String),
}

impl fmt::Display for AttachError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttachError::Stop(why) => write!(f, "{why}"),
            AttachError::GaveUp(why) => write!(f, "no answer within {} s ({why})", BUDGET.as_secs()),
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

pub fn attach_within(home: &Home, resume: Option<&str>, deadline: Instant) -> Result<Attached, AttachError> {
    let mut resume = resume.map(String::from);
    let mut spawned = false;
    let mut last = String::from("not tried");
    let pause = |d: Duration| thread::sleep(d.min(deadline.saturating_duration_since(Instant::now())));
    while Instant::now() < deadline {
        match try_once(home, resume.as_deref(), deadline, &mut spawned) {
            Ok((conn, welcome)) => return Ok(Attached { conn, welcome, new_session: resume.is_none() }),
            Err(Next::NewSession) if resume.is_some() => resume = None,
            Err(Next::NewSession) => {
                last = "the runtime refused a new session as a resume".into();
                pause(jitter());
            }
            Err(Next::Stop(why)) => return Err(AttachError::Stop(why)),
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
    Err(AttachError::GaveUp(last))
}

/// No reachable daemon: start one, once per attach.
fn start(home: &Home, deadline: Instant, spawned: &mut bool) -> Next {
    if *spawned {
        return Next::Poll("waiting for the daemon this shim started".into());
    }
    match daemon::ensure_started(home, deadline) {
        Ok(true) => {
            *spawned = true;
            Next::Poll("the daemon is starting".into())
        }
        // another started one, under the lock: try it at once
        Ok(false) => Next::Reread("a daemon is running".into()),
        Err(daemon::StartError::Config(c)) => config_next(c),
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
    spawned: &mut bool,
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
        assert!(saw.contains("args:daemon\n"), "{saw}");
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
        rustix::fs::mknodat(
            rustix::fs::CWD,
            t.home.secret(),
            rustix::fs::FileType::Fifo,
            rustix::fs::Mode::from_raw_mode(0o600),
            0,
        )
        .unwrap();
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
