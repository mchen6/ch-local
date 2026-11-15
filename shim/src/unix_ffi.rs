//! The crate's POSIX unsafe code (the reviewer, 2026-11-14): one sweep at
//! startup. The daemon this shim may start runs modules, so a descriptor the
//! client passed the shim without FD_CLOEXEC must never reach it, where
//! module code could use it by number. Before any thread is started, every
//! open descriptor from 3 up is marked FD_CLOEXEC: kept by the shim, closed
//! in anything it executes.

use std::os::fd::{AsRawFd, BorrowedFd};

use rustix::fs::{Dir, Mode, OFlags};
use rustix::io::{FdFlags, fcntl_getfd, fcntl_setfd};

/// Marks every open descriptor from 3 up FD_CLOEXEC. Must be called before
/// the process starts any thread (main's first act), so no descriptor is
/// opened or closed while the sweep runs. Returns how many it marked.
pub fn cloexec_inherited() -> usize {
    let list = if cfg!(target_os = "linux") { "/proc/self/fd" } else { "/dev/fd" };
    let Ok(dirfd) = rustix::fs::open(list, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty()) else {
        return 0;
    };
    let own = dirfd.as_raw_fd();
    let Ok(mut dir) = Dir::read_from(&dirfd) else {
        return 0;
    };
    let mut marked = 0;
    while let Some(Ok(entry)) = dir.read() {
        let Some(fd) = entry.file_name().to_str().ok().and_then(|n| n.parse::<i32>().ok()) else { continue };
        if fd < 3 || fd == own {
            continue;
        }
        // SAFETY: fd is listed by the kernel as open in this process. No other
        // thread exists yet (the caller's contract), so nothing can close it
        // before fcntl below returns, and the borrow lives only for these two
        // calls. dir's own descriptors (dirfd, and the one Dir duplicated from
        // it, which is CLOEXEC already) are left alone or harmlessly re-marked.
        let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
        if let Ok(flags) = fcntl_getfd(borrowed) {
            if !flags.contains(FdFlags::CLOEXEC) && fcntl_setfd(borrowed, flags | FdFlags::CLOEXEC).is_ok() {
                marked += 1;
            }
        }
    }
    marked
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    // The child half: this test binary re-run with CH_SHIM_FD set, holding
    // that descriptor without FD_CLOEXEC (inherited from the parent half). It
    // sweeps (unless told not to), then spawns a shell that lists what it was
    // given.
    #[test]
    fn child_half() {
        let Ok(fd) = std::env::var("CH_SHIM_FD") else { return };
        if std::env::var("CH_SHIM_SWEEP").as_deref() != Ok("0") {
            super::cloexec_inherited();
        }
        // each descriptor probed by duplicating it, so the shell opens nothing
        // of its own that could be taken for the leaked one (ls /dev/fd
        // lists its own directory's descriptor)
        let probe = "i=3; while [ $i -le 255 ]; do if ( : >&$i ) 2>/dev/null; then echo $i; fi; i=$((i+1)); done";
        let out = Command::new("/bin/sh").arg("-c").arg(probe).output().unwrap();
        let listed = String::from_utf8_lossy(&out.stdout);
        println!("CH_SHIM_CHILD_SAW[{}] fd={fd}", listed.split_whitespace().collect::<Vec<_>>().join(","));
    }

    fn run_child(sweep: bool) -> (i32, Vec<i32>) {
        let f = std::fs::File::open("/dev/null").unwrap();
        // inheritable, as a careless client would leave it
        rustix::io::fcntl_setfd(&f, rustix::io::FdFlags::empty()).unwrap();
        let fd = std::os::fd::AsRawFd::as_raw_fd(&f);
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "unix_ffi::tests::child_half", "--nocapture", "--test-threads=1"])
            .env("CH_SHIM_FD", fd.to_string())
            .env("CH_SHIM_SWEEP", if sweep { "1" } else { "0" })
            .output()
            .unwrap();
        drop(f);
        let text = String::from_utf8_lossy(&out.stdout);
        // the harness prints "test … " before the child's own output
        const TAG: &str = "CH_SHIM_CHILD_SAW[";
        let at = text.find(TAG).unwrap_or_else(|| panic!("no child line: {text}")) + TAG.len();
        let list = &text[at..at + text[at..].find(']').unwrap()];
        let saw = list.split(',').filter_map(|n| n.parse().ok()).collect();
        (fd, saw)
    }

    #[test]
    fn a_descriptor_the_client_leaked_never_reaches_what_the_shim_spawns() {
        let (fd, saw) = run_child(true);
        assert!(!saw.contains(&fd), "fd {fd} reached the spawned process: {saw:?}");
    }

    #[test]
    fn without_the_sweep_it_would() {
        let (fd, saw) = run_child(false);
        assert!(
            saw.contains(&fd),
            "the test's leaked fd {fd} should reach the spawned process without the sweep: {saw:?}"
        );
    }
}
