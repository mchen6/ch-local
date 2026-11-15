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
//! rule (private_problem, in safe code, tested everywhere), on the owner and
//! DACL read from the open handle through win_ffi; reparse points refused.

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

/// SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544), as SID bytes.
pub const SYSTEM: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
pub const ADMINISTRATORS: &[u8] = &[1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0];
/// What an allow ACE may grant someone else without letting them read or
/// change the file: SYNCHRONIZE, READ_CONTROL, FILE_READ_ATTRIBUTES.
pub const HARMLESS: u32 = 0x10_0000 | 0x2_0000 | 0x80;

/// A SID's bytes as S-R-A-S1-S2…, for messages.
pub fn sid_string(sid: &[u8]) -> String {
    if sid.len() < 8 || sid.len() != 8 + 4 * usize::from(sid[1]) {
        return "an unreadable SID".into();
    }
    let authority = sid[2..8].iter().fold(0u64, |a, b| (a << 8) | u64::from(*b));
    let mut out = format!("S-{}-{authority}", sid[0]);
    for c in sid[8..].chunks_exact(4) {
        out.push_str(&format!("-{}", u32::from_le_bytes([c[0], c[1], c[2], c[3]])));
    }
    out
}

/// One ACE, as privateProblem reads it.
pub struct Ace<'a> {
    pub sid: &'a [u8],
    pub allow: bool,
    pub inherit_only: bool,
    pub mask: u32,
}

/// countinghouse's lib/win-acl.js privateProblem, exactly: the owner must be
/// this user, SYSTEM or Administrators; every ACE a plain allow or deny
/// (`other_aces` otherwise, or for one unreadable); deny and inherit-only
/// ACEs skipped; an allow ACE for anyone else may grant nothing beyond
/// HARMLESS. -> a problem, or None.
pub fn private_problem(what: &str, user: &[u8], owner: &[u8], aces: &[Ace<'_>], other_aces: bool) -> Option<String> {
    if other_aces {
        return Some(format!(
            "{what} has an access rule other than a plain allow or deny, or its rules could not all be read"
        ));
    }
    let own = |sid: &[u8]| sid == user || sid == SYSTEM || sid == ADMINISTRATORS;
    if !own(owner) {
        return Some(format!("{what} is owned by {}, not this user, Administrators or SYSTEM", sid_string(owner)));
    }
    for a in aces {
        if !a.allow || a.inherit_only {
            continue;
        }
        if !own(a.sid) && a.mask & !HARMLESS != 0 {
            return Some(format!("{what} is accessible by {}", sid_string(a.sid)));
        }
    }
    None
}

#[cfg(windows)]
mod windows {
    use std::fs::{self, File, OpenOptions};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    use super::{Ace, TrustError, private_problem, refuse};
    use crate::win_ffi;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const READ_CONTROL: u32 = 0x2_0000;
    const GENERIC_READ: u32 = 0x8000_0000;

    fn check_open(path: &Path, f: &File, dir: bool) -> Result<(), TrustError> {
        let m = f.metadata().map_err(|e| refuse(path, format!("it cannot be read ({e})")))?;
        if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(refuse(path, "it is a symbolic link or another reparse point"));
        }
        if dir && !m.is_dir() {
            return Err(refuse(path, "it is not a directory"));
        }
        if !dir && !m.is_file() {
            return Err(refuse(path, "it is not a regular file"));
        }
        let user =
            win_ffi::current_user_sid().map_err(|e| refuse(path, format!("this user's SID cannot be read ({e})")))?;
        let acl = win_ffi::file_acl(f).map_err(|_| refuse(path, "its ACL could not be read"))?;
        let aces: Vec<Ace<'_>> = acl
            .rules
            .iter()
            .map(|r| Ace { sid: &r.sid, allow: r.allow, inherit_only: r.inherit_only, mask: r.mask })
            .collect();
        match private_problem("it", &user, &acl.owner, &aces, acl.other_aces) {
            Some(p) => Err(refuse(path, p.trim_start_matches("it ").to_string())),
            None => Ok(()),
        }
    }

    fn not_a_link(path: &Path) -> Result<(), TrustError> {
        let m = fs::symlink_metadata(path).map_err(|e| refuse(path, format!("it cannot be read ({e})")))?;
        if m.file_type().is_symlink() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(refuse(path, "it is a symbolic link or another reparse point"));
        }
        Ok(())
    }

    pub fn check_dir(dir: &Path) -> Result<(), TrustError> {
        not_a_link(dir)?;
        let f = OpenOptions::new()
            .access_mode(READ_CONTROL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(dir)
            .map_err(|e| refuse(dir, format!("it cannot be opened ({e})")))?;
        check_open(dir, &f, true)
    }

    /// Opened without following a reparse point, then checked on the open
    /// handle: what was checked is what is read.
    pub fn open_private(path: &Path) -> Result<File, TrustError> {
        not_a_link(path)?;
        let f = OpenOptions::new()
            .access_mode(GENERIC_READ | READ_CONTROL)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|e| refuse(path, format!("it cannot be opened ({e})")))?;
        check_open(path, &f, false)?;
        Ok(f)
    }
}

#[cfg(windows)]
pub use windows::check_dir;

#[cfg(windows)]
fn open_private(path: &Path) -> Result<std::fs::File, TrustError> {
    windows::open_private(path)
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

#[cfg(test)]
mod rule_tests {
    use super::*;

    const ME: &[u8] = &[1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xe9, 3, 0, 0];
    const OTHER: &[u8] = &[1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xea, 3, 0, 0];
    const EVERYONE: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];

    fn allow(sid: &[u8], mask: u32) -> Ace<'_> {
        Ace { sid, allow: true, inherit_only: false, mask }
    }

    #[test]
    fn the_sids_print_as_windows_does() {
        assert_eq!(sid_string(SYSTEM), "S-1-5-18");
        assert_eq!(sid_string(ADMINISTRATORS), "S-1-5-32-544");
        assert_eq!(sid_string(ME), "S-1-5-21-1-2-3-1001");
    }

    #[test]
    fn private_problem_s_rule() {
        let full = 0x1f_01ff;
        assert_eq!(
            private_problem("f", ME, ME, &[allow(ME, full), allow(SYSTEM, full), allow(ADMINISTRATORS, full)], false),
            None
        );
        assert_eq!(private_problem("f", ME, SYSTEM, &[allow(ME, full)], false), None, "SYSTEM may own it");
        assert_eq!(
            private_problem("f", ME, ME, &[allow(ME, full), allow(EVERYONE, HARMLESS)], false),
            None,
            "harmless rights only"
        );
        assert!(
            private_problem("f", ME, OTHER, &[allow(ME, full)], false)
                .unwrap()
                .contains("owned by S-1-5-21-1-2-3-1002")
        );
        assert!(
            private_problem("f", ME, ME, &[allow(EVERYONE, 0x1)], false).unwrap().contains("accessible by S-1-1-0")
        );
        assert_eq!(
            private_problem(
                "f",
                ME,
                ME,
                &[Ace { sid: EVERYONE, allow: false, inherit_only: false, mask: full }],
                false
            ),
            None,
            "a deny is skipped"
        );
        assert_eq!(
            private_problem("f", ME, ME, &[Ace { sid: EVERYONE, allow: true, inherit_only: true, mask: full }], false),
            None,
            "inherit-only is skipped"
        );
        assert!(private_problem("f", ME, ME, &[], true).unwrap().contains("other than a plain allow or deny"));
    }
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
