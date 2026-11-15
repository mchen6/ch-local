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
//! Residual (POSIX, raised with the reviewer): a descriptor above 2 that the
//! client passed the shim without FD_CLOEXEC is inherited by the daemon;
//! closing it in the child needs pre_exec, which is unsafe.

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
        }
    }
}

/// A daemon.json whose pid is alive (POSIX: kill(pid, 0)).
pub fn live(info: &DaemonInfo) -> bool {
    lock::alive(info.pid)
}

/// Running, for starting's purpose: alive AND taking connections. A
/// daemon.json left by a crash whose pid was reused by another process is
/// alive and never answers, so it must not stop a start.
fn running(info: &DaemonInfo) -> bool {
    live(info) && endpoint::probe(&info.socket, PROBE)
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
    let running = config::read_daemon(home).map_err(StartError::Config)?.is_some_and(|d| running(&d));
    let spawned = if running { false } else { spawn(home).map(|()| true)? };
    drop(held);
    Ok(spawned)
}

fn spawn(home: &Home) -> Result<(), StartError> {
    let shim = config::read_shim(home).map_err(StartError::Config)?;
    let mut cmd = Command::new(&shim.node);
    cmd.arg(&shim.ch_local)
        .arg("daemon")
        .env_clear()
        .envs(shim.env.iter().map(|(k, v)| (k, v)))
        .current_dir(home.root())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut cmd);
    let mut child = cmd.spawn().map_err(StartError::Spawn)?;
    // reaped whenever it ends, so a daemon that exits early is never left a
    // zombie of this shim's
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // Windows' CreateProcessW is called with handle inheritance on: the
    // shim's own stdio (the client's pipes, inheritable when the client made
    // them so) must not reach the daemon, which outlives the shim and would
    // keep the client from ever seeing EOF. The daemon's own stdio is null.
    crate::win_ffi::stdio_not_inherited();
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
}
