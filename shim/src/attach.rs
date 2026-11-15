//! Attaching: from the home's files to a WELCOMEd connection, within the
//! spec's 20 s (contract 2, sections 1 and 6).
//!
//! Each try reads daemon.json (no daemon, or a dead pid: one is started
//! under start.lock), the secret, and the endpoint, every one trust-checked,
//! then connects and makes the handshake with a nonce from the OS. Then, by
//! what happened:
//! - a PROVE whose ms doesn't check, or BAD_PROOF: the runtime may have
//!   restarted with a new secret, so the files are read again, at once;
//! - RESUME_REFUSED: a new session, without `resume`, on a new connection;
//!   the caller then replays its records;
//! - BUSY, SHUTTING_DOWN, a connection refused or closed, a timeout: again
//!   after 100 ms to 2 s, randomised;
//! - PROTOCOL, an unknown code, a file that fails its trust check: stop,
//!   saying why;
//! - 20 s gone: give up, saying the last reason.

use std::fmt;
use std::time::{Duration, Instant};

use crate::config::{self, ConfigError, Home};
use crate::daemon;
use crate::endpoint::{self, Conn};
use crate::handshake::{self, HandshakeError, Refusal, Welcome};

/// How long an attach may take in all.
pub const BUDGET: Duration = Duration::from_secs(20);
/// The pause before the files are read again after a wrong proof.
const REREAD_PAUSE: Duration = Duration::from_millis(100);
/// The longest one handshake may take, its reads bounded by it.
const HANDSHAKE_READ: Duration = Duration::from_secs(5);

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
    /// Read the files again at once.
    Reread(String),
    /// RESUME_REFUSED: again at once, as a new session.
    NewSession,
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
        // a file missing or half-written while a daemon starts or stops is
        // tried again; one that fails its trust check is not
        ConfigError::Trust(t) if t.why.contains("cannot be read") || t.why.contains("cannot be opened") => {
            Next::Later(t.to_string())
        }
        ConfigError::Malformed { .. } => Next::Later(e.to_string()),
        other => Next::Stop(other.to_string()),
    }
}

/// Attaches within BUDGET, resuming `resume` if given.
pub fn attach(home: &Home, resume: Option<&str>) -> Result<Attached, AttachError> {
    attach_within(home, resume, Instant::now() + BUDGET)
}

pub fn attach_within(home: &Home, resume: Option<&str>, deadline: Instant) -> Result<Attached, AttachError> {
    let mut resume = resume.map(String::from);
    let mut last;
    loop {
        match try_once(home, resume.as_deref(), deadline) {
            Ok((conn, welcome)) => return Ok(Attached { conn, welcome, new_session: resume.is_none() }),
            // at once, once: a new session has no resume to refuse
            Err(Next::NewSession) => {
                resume = None;
                continue;
            }
            Err(Next::Stop(why)) => return Err(AttachError::Stop(why)),
            // not at once: a secret that is wrong for good must not spin
            Err(Next::Reread(why)) => {
                last = why;
                std::thread::sleep(REREAD_PAUSE);
            }
            Err(Next::Later(why)) => {
                last = why;
                let wait = jitter();
                if Instant::now() + wait >= deadline {
                    return Err(AttachError::GaveUp(last));
                }
                std::thread::sleep(wait);
            }
        }
        if Instant::now() >= deadline {
            return Err(AttachError::GaveUp(last));
        }
    }
}

fn try_once(home: &Home, resume: Option<&str>, deadline: Instant) -> Result<(Box<dyn Conn>, Welcome), Next> {
    let info = match config::read_daemon(home).map_err(config_next)? {
        Some(info) if daemon::live(&info) => info,
        _ => {
            daemon::ensure_started(home, deadline).map_err(|e| match e {
                daemon::StartError::Config(c) => config_next(c),
                other => Next::Later(other.to_string()),
            })?;
            return Err(Next::Later("the daemon is starting".into()));
        }
    };
    let secret = config::read_secret(home).map_err(config_next)?;
    let end = endpoint::check(&info.socket).map_err(|e| Next::Later(e.to_string()))?;
    let mut conn = endpoint::connect(&end).map_err(|e| Next::Later(format!("connecting: {e}")))?;
    let _ = conn.set_read_timeout(Some(HANDSHAKE_READ));
    match handshake::attach(&mut conn, &secret, nonce(), resume) {
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
}
