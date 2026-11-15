//! Where the runtime listens, as daemon.json names it, checked before the
//! shim connects (contract 2, section 1, "Where it listens"):
//! - POSIX: a Unix socket, an absolute path whose directory passes the run
//!   directory's checks (the run directory itself, or the `$TMPDIR/ch-<uid>/`
//!   fallback), the socket itself this user's and not a symlink, and the
//!   path within the platform's limit (108 bytes on Linux, 104 on macOS);
//! - Windows: exactly `\\.\pipe\countinghouse-<32 lowercase hex>`, so
//!   daemon.json can never name a UNC host, opened with SECURITY_SQOS_PRESENT
//!   and SECURITY_IDENTIFICATION, so a server can identify the shim but
//!   never impersonate it.

use std::fmt;
use std::io::{self, Read, Write};
use std::time::Duration;

#[derive(Debug)]
pub struct EndpointError(pub String);

impl fmt::Display for EndpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "daemon.json's socket: {}", self.0)
    }
}

/// A connection to the runtime: both halves, for the two relay threads.
pub trait Conn: Read + Write + Send {
    fn try_clone_conn(&self) -> io::Result<Box<dyn Conn>>;
    fn set_read_timeout(&self, t: Option<Duration>) -> io::Result<()>;
}

/// The pipe-name rule, on every platform (so it is tested everywhere).
pub fn pipe_name_ok(name: &str) -> bool {
    const PREFIX: &str = r"\\.\pipe\countinghouse-";
    match name.strip_prefix(PREFIX) {
        Some(hex) => hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        None => false,
    }
}

#[cfg(unix)]
mod imp {
    use std::fs;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::trust;

    const LIMIT: usize = if cfg!(target_os = "macos") { 104 } else { 108 };

    pub struct Endpoint(PathBuf);

    pub fn check(socket: &str) -> Result<Endpoint, EndpointError> {
        let path = Path::new(socket);
        if !path.is_absolute() {
            return Err(EndpointError(format!("{socket} is not an absolute path")));
        }
        // the limit counts the terminating NUL
        if socket.len() >= LIMIT {
            return Err(EndpointError(format!("{socket} is longer than this platform's {LIMIT}-byte limit")));
        }
        let dir = path.parent().ok_or_else(|| EndpointError(format!("{socket} has no directory")))?;
        trust::check_dir(dir).map_err(|e| EndpointError(e.to_string()))?;
        let m = fs::symlink_metadata(path).map_err(|e| EndpointError(format!("{socket} cannot be read ({e})")))?;
        if !m.file_type().is_socket() {
            return Err(EndpointError(format!("{socket} is not a socket")));
        }
        if m.uid() != rustix::process::geteuid().as_raw() {
            return Err(EndpointError(format!("{socket} is owned by uid {}, not this user", m.uid())));
        }
        Ok(Endpoint(path.to_path_buf()))
    }

    impl Conn for UnixStream {
        fn try_clone_conn(&self) -> io::Result<Box<dyn Conn>> {
            Ok(Box::new(self.try_clone()?))
        }
        fn set_read_timeout(&self, t: Option<Duration>) -> io::Result<()> {
            UnixStream::set_read_timeout(self, t)
        }
    }

    pub fn connect(e: &Endpoint) -> io::Result<Box<dyn Conn>> {
        Ok(Box::new(UnixStream::connect(&e.0)?))
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;

    use super::*;

    /// SecurityIdentification (1) in the impersonation-level bits (<< 16):
    /// the server may learn who the shim is, and may not act as it. std's
    /// security_qos_flags sets SECURITY_SQOS_PRESENT with it.
    const SECURITY_IDENTIFICATION: u32 = 1 << 16;

    pub struct Endpoint(String);

    pub fn check(socket: &str) -> Result<Endpoint, EndpointError> {
        if pipe_name_ok(socket) {
            Ok(Endpoint(socket.to_string()))
        } else {
            Err(EndpointError(format!("{socket} is not \\\\.\\pipe\\countinghouse-<32 hex>")))
        }
    }

    impl Conn for File {
        fn try_clone_conn(&self) -> io::Result<Box<dyn Conn>> {
            Ok(Box::new(self.try_clone()?))
        }
        // a pipe opened as a file has no read timeout; the handshake's bound
        // is kept by the caller's deadline thread on Windows
        fn set_read_timeout(&self, _t: Option<Duration>) -> io::Result<()> {
            Ok(())
        }
    }

    pub fn connect(e: &Endpoint) -> io::Result<Box<dyn Conn>> {
        let f = OpenOptions::new().read(true).write(true).security_qos_flags(SECURITY_IDENTIFICATION).open(&e.0)?;
        Ok(Box::new(f))
    }
}

pub use imp::{Endpoint, check, connect};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_local_countinghouse_pipe_with_32_lowercase_hex_is_a_pipe_name() {
        let good = format!(r"\\.\pipe\countinghouse-{}", "0123456789abcdef".repeat(2));
        assert!(pipe_name_ok(&good));
        for bad in [
            format!(r"\\server\pipe\countinghouse-{}", "0".repeat(32)),
            format!(r"\\.\pipe\countinghouse-{}", "0".repeat(31)),
            format!(r"\\.\pipe\countinghouse-{}", "0".repeat(33)),
            format!(r"\\.\pipe\countinghouse-{}", "A".repeat(32)),
            format!(r"\\.\pipe\other-{}", "0".repeat(32)),
            format!(r"\\.\pipe\countinghouse-{}\..\x", "0".repeat(32)),
        ] {
            assert!(!pipe_name_ok(&bad), "{bad}");
        }
    }
}
