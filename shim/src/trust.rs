//! What the shim trusts in the home, and how it checks it before reading:
//! the run directory, daemon.json, shim.json and the secret (contract 2,
//! section 1, "The secret"). A check that fails stops the attach, naming
//! what and why.
//!
//! POSIX: a directory must be owned by this user (the effective uid), not
//! a symlink, and mode 0700 exactly; a file must be owned by this user, a
//! regular file, not a symlink, and mode 0600 exactly. A file is lstat'ed,
//! then opened with O_NOFOLLOW, then fstat'ed on the open descriptor, and
//! both stats must name the same file (device and inode): what was checked
//! is what is read. Windows: countinghouse's lib/win-acl.js privateProblem
//! rule, through win_ffi (to come in this change).

use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct TrustError {
    pub path: PathBuf,
    pub why: String,
}

impl fmt::Display for TrustError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is not trusted: {}", self.path.display(), self.why)
    }
}

fn refuse(path: &Path, why: impl Into<String>) -> TrustError {
    TrustError { path: path.to_path_buf(), why: why.into() }
}

#[cfg(unix)]
mod posix {
    use std::fs::{self, File, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    use super::{TrustError, refuse};

    fn euid() -> u32 {
        rustix::process::geteuid().as_raw()
    }

    fn mode(m: &fs::Metadata) -> u32 {
        m.mode() & 0o7777
    }

    pub fn check_dir(dir: &Path) -> Result<(), TrustError> {
        let m = fs::symlink_metadata(dir).map_err(|e| refuse(dir, format!("it cannot be read ({e})")))?;
        if m.file_type().is_symlink() {
            return Err(refuse(dir, "it is a symbolic link"));
        }
        if !m.is_dir() {
            return Err(refuse(dir, "it is not a directory"));
        }
        if m.uid() != euid() {
            return Err(refuse(dir, format!("it is owned by uid {}, not this user", m.uid())));
        }
        if mode(&m) != 0o700 {
            return Err(refuse(dir, format!("its mode is {:04o}, not 0700", mode(&m))));
        }
        Ok(())
    }

    pub fn open_private(path: &Path) -> Result<File, TrustError> {
        let before = fs::symlink_metadata(path).map_err(|e| refuse(path, format!("it cannot be read ({e})")))?;
        if before.file_type().is_symlink() {
            return Err(refuse(path, "it is a symbolic link"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(path)
            .map_err(|e| refuse(path, format!("it cannot be opened ({e})")))?;
        let m = file.metadata().map_err(|e| refuse(path, format!("it cannot be read ({e})")))?;
        if (m.dev(), m.ino()) != (before.dev(), before.ino()) {
            return Err(refuse(path, "it was replaced while it was being opened"));
        }
        if !m.is_file() {
            return Err(refuse(path, "it is not a regular file"));
        }
        if m.uid() != euid() {
            return Err(refuse(path, format!("it is owned by uid {}, not this user", m.uid())));
        }
        if mode(&m) != 0o600 {
            return Err(refuse(path, format!("its mode is {:04o}, not 0600", mode(&m))));
        }
        Ok(file)
    }
}

#[cfg(unix)]
pub use posix::check_dir;

#[cfg(unix)]
fn open_private(path: &Path) -> Result<std::fs::File, TrustError> {
    posix::open_private(path)
}

#[cfg(windows)]
pub fn check_dir(dir: &Path) -> Result<(), TrustError> {
    Err(refuse(dir, "the Windows check is not built yet"))
}

#[cfg(windows)]
fn open_private(path: &Path) -> Result<std::fs::File, TrustError> {
    Err(refuse(path, "the Windows check is not built yet"))
}

/// A private file's contents, checked first, at most `max` bytes (a file
/// over it is refused, never cut).
pub fn read_private(path: &Path, max: usize) -> Result<Vec<u8>, TrustError> {
    let file = open_private(path)?;
    let mut out = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut out).map_err(|e| refuse(path, format!("it cannot be read ({e})")))?;
    if out.len() > max {
        return Err(refuse(path, format!("it is larger than {max} bytes")));
    }
    Ok(out)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    struct Home(PathBuf);
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn home() -> Home {
        let mut name = [0u8; 8];
        getrandom::fill(&mut name).unwrap();
        let dir = std::env::temp_dir()
            .join(format!("ch-shim-trust-{}", name.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        Home(dir)
    }

    fn private(dir: &Path, name: &str, body: &[u8], mode: u32) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    #[test]
    fn a_private_directory_and_file_are_trusted() {
        let h = home();
        check_dir(&h.0).unwrap();
        let f = private(&h.0, "secret", b"x", 0o600);
        assert_eq!(read_private(&f, 64).unwrap(), b"x");
    }

    #[test]
    fn a_directory_open_to_others_or_a_symlink_to_one_is_refused() {
        let h = home();
        fs::set_permissions(&h.0, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(check_dir(&h.0).unwrap_err().why.contains("0750"));
        fs::set_permissions(&h.0, fs::Permissions::from_mode(0o700)).unwrap();
        let link = h.0.join("link");
        let real = h.0.join("real");
        fs::create_dir(&real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&real, &link).unwrap();
        assert!(check_dir(&link).unwrap_err().why.contains("symbolic link"));
    }

    #[test]
    fn a_file_with_other_bits_a_symlink_or_not_a_file_is_refused() {
        let h = home();
        for mode in [0o644, 0o640, 0o700, 0o4600, 0o400] {
            let f = private(&h.0, "s", b"x", mode);
            assert!(read_private(&f, 64).unwrap_err().why.contains("mode"), "{mode:o}");
            fs::remove_file(&f).unwrap();
        }
        let real = private(&h.0, "real", b"x", 0o600);
        symlink(&real, h.0.join("link")).unwrap();
        assert!(read_private(&h.0.join("link"), 64).unwrap_err().why.contains("symbolic link"));
        let d = h.0.join("dir");
        fs::create_dir(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_private(&d, 64).is_err(), "a directory");
    }

    #[test]
    fn a_file_over_its_bound_is_refused_never_cut() {
        let h = home();
        let f = private(&h.0, "daemon.json", &[b'x'; 65], 0o600);
        assert!(read_private(&f, 64).unwrap_err().why.contains("larger than 64"));
        assert_eq!(read_private(&f, 65).unwrap().len(), 65);
    }
}
