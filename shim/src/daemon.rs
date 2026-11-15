//! Starting the daemon when none is running (contract 2, section 6,
//! "Starting", steps 3-4): under start.lock, daemon.json is checked again;
//! still none (or its pid is dead), the shim spawns `<node> <chLocal>
//! daemon` from shim.json, and releases the lock. The daemon takes the
//! lock itself, writes daemon.json once its socket listens, and releases
//! it.
//!
//! The daemon's environment is cleared and given exactly shim.json's `env`
//! (its names already checked against the allowlist): nothing comes from
//! the client's environment, NODE_OPTIONS least of all. Its working
//! directory is <home>, its stdio null, and it is detached: on POSIX its
//! own process group (process_group(0)), so it is not in the terminal's
//! foreground group; on Windows DETACHED_PROCESS | CREATE_NO_WINDOW, with
//! the shim's stdio handles made non-inheritable first.
//!
//! On POSIX, a descriptor above 2 that the client passed the shim without
//! FD_CLOEXEC was marked FD_CLOEXEC at the shim's start (unix_ffi), so the
//! daemon never inherits it; a shim whose sweep failed starts no daemon.
//!
//! Residual, Windows (release 1; the reviewer, 2026-11-15): only the shim's
//! three standard handles are made non-inheritable (a failure refuses the
//! spawn). Any other inheritable handle the client leaked into the shim is
//! inherited by the daemon, because std's CreateProcessW passes
//! bInheritHandles = TRUE and offers no PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
//! fixing it means a hand-rolled CreateProcessW. The exposure is smaller
//! than POSIX's: module code in Node can't use a raw inherited HANDLE value
//! the way it can a descriptor number. Recorded in the spec's residuals.

use std::fmt;
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::config::{self, ConfigError, DaemonInfo, Home};
use crate::endpoint;
use crate::lock::{self, LockError};

#[derive(Debug)]
pub enum StartError {
    Config(ConfigError),
    Lock(LockError),
    Spawn(std::io::Error),
    /// Starting a daemon now could hand it what it must never hold.
    Unsafe(String),
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartError::Config(e) => write!(f, "{e}"),
            StartError::Lock(LockError::Held(Some(h))) => {
                write!(f, "start.lock is held ({})", h.content().trim_end())
            }
            StartError::Lock(LockError::Held(None)) => write!(f, "start.lock is held (being written)"),
            StartError::Lock(LockError::Io(e)) => write!(f, "start.lock: {e}"),
            StartError::Spawn(e) => write!(f, "the daemon could not be started: {e}"),
            StartError::Unsafe(why) => write!(f, "the daemon was not started: {why}"),
        }
    }
}

/// A daemon.json whose pid is alive (POSIX: kill(pid, 0)).
pub fn live(info: &DaemonInfo) -> bool {
    lock::alive(info.pid)
}

/// Running, for starting's purpose: alive AND answering with a checked
/// PROVE. A daemon.json left by a crash whose pid was reused is alive and
/// never answers; a name a squatter took answers and can't prove the
/// secret. Neither may stop a start.
fn running(home: &Home, info: &DaemonInfo) -> bool {
    live(info) && config::read_secret(home).is_ok_and(|secret| endpoint::probe(&info.socket, secret, PROBE))
}

const PROBE: std::time::Duration = std::time::Duration::from_secs(2);

/// Starts the daemon unless, under the lock, a live one is found.
/// Returns whether this call spawned one.
pub fn ensure_started(home: &Home, deadline: Instant) -> Result<bool, StartError> {
    if !home.run_dir().exists() {
        // the run directory is the daemon's to make (0700); without it there
        // is no start.lock to take, so the daemon is started unlocked, and
        // takes the lock itself
        return spawn(home).map(|()| true);
    }
    let held = lock::acquire(&home.start_lock(), deadline).map_err(StartError::Lock)?;
    let running = config::read_daemon(home).map_err(StartError::Config)?.is_some_and(|d| running(home, &d));
    let spawned = if running { false } else { spawn(home).map(|()| true)? };
    drop(held);
    Ok(spawned)
}

fn spawn(home: &Home) -> Result<(), StartError> {
    #[cfg(unix)]
    if !crate::unix_ffi::swept() {
        return Err(StartError::Unsafe("this shim's inherited descriptors were never marked close-on-exec".into()));
    }
    let shim = config::read_shim(home).map_err(StartError::Config)?;
    let mut cmd = Command::new(&shim.node);
    cmd.arg(&shim.ch_local)
        .arg("daemon")
        .arg("--home")
        .arg(home.root())
        .env_clear()
        .envs(shim.env.iter().map(|(k, v)| (k, v)))
        .current_dir(home.root())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut cmd)
        .map_err(|e| StartError::Unsafe(format!("the shim's own handles could not be kept from the daemon ({e})")))?;
    let mut child = cmd.spawn().map_err(StartError::Spawn)?;
    // reaped whenever it ends, so a daemon that exits early is never left a
    // zombie of this shim's
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(unix)]
fn detach(cmd: &mut Command) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
    Ok(())
}

#[cfg(windows)]
fn detach(cmd: &mut Command) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // Windows' CreateProcessW is called with handle inheritance on: the
    // shim's own stdio (the client's pipes, inheritable when the client made
    // them so) must not reach the daemon, which outlives the shim and would
    // keep the client from ever seeing EOF. The daemon's own stdio is null.
    crate::win_ffi::stdio_not_inherited()?;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn the_daemon_is_started_with_only_shim_json_s_env_in_the_home() {
        let Ok(out) = Command::new("node").args(["-p", "process.execPath"]).output() else {
            assert!(std::env::var("CI").is_err(), "node is needed for this test in CI");
            return;
        };
        let node = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        let root = std::env::temp_dir()
            .join(format!("ch-shim-daemon-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        std::fs::create_dir(&root).unwrap();
        let saw = root.join("saw.json");
        let script = root.join("fake-ch-local.js");
        std::fs::write(&script, format!("require('fs').writeFileSync({}, JSON.stringify({{args: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env)}}))", serde_json::to_string(&saw).unwrap())).unwrap();
        let me = crate::trust::sid_string(&crate::win_ffi::current_user_sid().unwrap());
        let shim_json = root.join("shim.json");
        let body = serde_json::json!({"node": node, "chLocal": script, "env": {"SystemRoot": std::env::var("SystemRoot").unwrap(), "USERPROFILE": root}});
        std::fs::write(&shim_json, body.to_string()).unwrap();
        let st = Command::new("icacls")
            .arg(&shim_json)
            .args(["/inheritance:r", "/grant:r", &format!("*{me}:F"), "*S-1-5-18:F"])
            .status()
            .unwrap();
        assert!(st.success());
        let home = Home::new(&root).unwrap();
        spawn(&home).unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        while !saw.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&saw).unwrap()).unwrap();
        assert_eq!(v["args"], serde_json::json!(["daemon", "--home", root]));
        assert_eq!(
            std::path::Path::new(v["cwd"].as_str().unwrap()).canonicalize().unwrap(),
            root.canonicalize().unwrap()
        );
        for k in v["env"].as_array().unwrap() {
            let k = k.as_str().unwrap();
            // Windows adds a few names to a process whatever its parent passes:
            // SYSTEMROOT's spelling, the =C: drive entries, and, for a process
            // running emulated (an x64 node on the arm64 runner),
            // PROCESSOR_ARCHITECTURE and PROCESSOR_ARCHITEW6432. None comes
            // from the shim's environment, which held only shim.json's two.
            assert!(
                ["SystemRoot", "USERPROFILE", "SYSTEMROOT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432"]
                    .contains(&k)
                    || k.starts_with('='),
                "the daemon was given {k}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
