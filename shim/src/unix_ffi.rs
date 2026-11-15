//! The crate's POSIX unsafe code (the reviewer, 2026-11-14): one sweep at
//! startup. The daemon this shim may start runs modules, so a descriptor the
//! client passed the shim without FD_CLOEXEC must never reach it, where
//! module code could use it by number. Before any thread is started, every
//! open descriptor from 3 up is marked FD_CLOEXEC: kept by the shim, closed
//! in anything it executes.
//!
//! It fails closed: the open descriptors are listed (/proc/self/fd on
//! Linux, /dev/fd elsewhere); if that can't be done, every number from 3 to
//! the descriptor limit is tried; if neither can be done, the sweep fails,
//! and the shim then refuses to start a daemon (`swept`).

use std::io;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};

use rustix::fs::{Dir, Mode, OFlags};

/// The most descriptor numbers the fallback tries.
const FALLBACK_CAP: u64 = 1 << 20;

static SWEPT: AtomicBool = AtomicBool::new(false);

/// Whether the startup sweep succeeded in this process.
pub fn swept() -> bool {
    SWEPT.load(Ordering::SeqCst)
}

/// For tests, which run with the harness's threads and can't sweep.
#[cfg(test)]
pub fn assume_swept() {
    SWEPT.store(true, Ordering::SeqCst);
}

/// Marks one descriptor FD_CLOEXEC; Ok(false) when no such descriptor is
/// open.
fn mark(fd: i32) -> io::Result<bool> {
    // SAFETY: fcntl(F_GETFD) on any integer is sound: the kernel checks it,
    // and a closed or invalid descriptor fails with EBADF. No Rust object is
    // made from fd.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        let e = io::Error::last_os_error();
        return if e.raw_os_error() == Some(libc::EBADF) { Ok(false) } else { Err(e) };
    }
    if flags & libc::FD_CLOEXEC != 0 {
        return Ok(false);
    }
    // SAFETY: as above; F_SETFD only changes the close-on-exec flag.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(true)
}

fn by_listing() -> io::Result<usize> {
    let list = if cfg!(target_os = "linux") { "/proc/self/fd" } else { "/dev/fd" };
    let dirfd = rustix::fs::open(list, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?;
    let own = dirfd.as_raw_fd();
    let mut dir = Dir::read_from(&dirfd)?;
    let mut fds = Vec::new();
    while let Some(entry) = dir.read() {
        let entry = entry?;
        if let Some(fd) = entry.file_name().to_str().ok().and_then(|n| n.parse::<i32>().ok()) {
            if fd >= 3 && fd != own {
                fds.push(fd);
            }
        }
    }
    let mut marked = 0;
    for fd in fds {
        marked += usize::from(mark(fd)?);
    }
    Ok(marked)
}

fn by_range() -> io::Result<usize> {
    let limit = rustix::process::getrlimit(rustix::process::Resource::Nofile);
    let top = limit.current.unwrap_or(FALLBACK_CAP).min(FALLBACK_CAP);
    let mut marked = 0;
    for fd in 3..top {
        marked += usize::from(mark(fd as i32)?);
    }
    Ok(marked)
}

/// Marks every open descriptor from 3 up FD_CLOEXEC, and records that it
/// was done; how many it marked.
///
/// # Safety
/// Call before the process starts any thread (main's first act), so that
/// no descriptor is opened or closed, and no number reused, while the sweep
/// runs. A descriptor opened by another thread meanwhile could be marked,
/// or missed.
pub unsafe fn startup_sweep() -> io::Result<usize> {
    let marked = by_listing().or_else(|_| by_range())?;
    SWEPT.store(true, Ordering::SeqCst);
    Ok(marked)
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    // The child half: this test binary re-run with CH_SHIM_FD set, holding
    // that descriptor without FD_CLOEXEC (inherited from the parent half).
    // It sweeps (unless told not to), then spawns a shell that probes what it
    // was given.
    #[test]
    fn child_half() {
        let Ok(fd) = std::env::var("CH_SHIM_FD") else { return };
        match std::env::var("CH_SHIM_SWEEP").as_deref() {
            Ok("listing") => {
                super::by_listing().unwrap();
            }
            Ok("range") => {
                super::by_range().unwrap();
            }
            _ => {}
        }
        // each descriptor probed by duplicating it, so the shell opens nothing
        // of its own that could be taken for the leaked one
        let probe = "i=3; while [ $i -le 255 ]; do if ( : >&$i ) 2>/dev/null; then echo $i; fi; i=$((i+1)); done";
        let out = Command::new("/bin/sh").arg("-c").arg(probe).output().unwrap();
        let listed = String::from_utf8_lossy(&out.stdout);
        println!("CH_SHIM_CHILD_SAW[{}] fd={fd}", listed.split_whitespace().collect::<Vec<_>>().join(","));
    }

    fn run_child(sweep: &str) -> (i32, Vec<i32>) {
        let f = std::fs::File::open("/dev/null").unwrap();
        // inheritable, as a careless client would leave it
        rustix::io::fcntl_setfd(&f, rustix::io::FdFlags::empty()).unwrap();
        let fd = std::os::fd::AsRawFd::as_raw_fd(&f);
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "unix_ffi::tests::child_half", "--nocapture", "--test-threads=1"])
            .env("CH_SHIM_FD", fd.to_string())
            .env("CH_SHIM_SWEEP", sweep)
            .output()
            .unwrap();
        drop(f);
        let text = String::from_utf8_lossy(&out.stdout);
        // the harness prints "test … " before the child's own output
        const TAG: &str = "CH_SHIM_CHILD_SAW[";
        let at = text.find(TAG).unwrap_or_else(|| panic!("no child line: {text}")) + TAG.len();
        let list = &text[at..at + text[at..].find(']').unwrap()];
        (fd, list.split(',').filter_map(|n| n.parse().ok()).collect())
    }

    #[test]
    fn a_descriptor_the_client_leaked_never_reaches_what_the_shim_spawns() {
        let (fd, saw) = run_child("listing");
        assert!(!saw.contains(&fd), "fd {fd} reached the spawned process: {saw:?}");
    }

    #[test]
    fn the_fallback_over_the_descriptor_range_does_the_same() {
        let (fd, saw) = run_child("range");
        assert!(!saw.contains(&fd), "fd {fd} reached the spawned process: {saw:?}");
    }

    #[test]
    fn without_the_sweep_it_would() {
        let (fd, saw) = run_child("none");
        assert!(
            saw.contains(&fd),
            "the test's leaked fd {fd} should reach the spawned process without the sweep: {saw:?}"
        );
    }
}
