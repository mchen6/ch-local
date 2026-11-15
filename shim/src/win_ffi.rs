//! The crate's only unsafe code (the reviewer, 2026-11-14): the Windows
//! calls the trust checks and the lock need, each behind a safe function
//! that owns every handle and buffer it touches. Every unsafe block says
//! why it is sound. Nothing here decides anything: the rules (privateProblem,
//! lock liveness) are in safe code, trust.rs and lock.rs.

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_SUCCESS, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, LocalFree,
    STILL_ACTIVE, SetHandleInformation,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION, GetAce, GetAclInformation,
    GetLengthSid, GetTokenInformation, IsValidSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const INHERIT_ONLY_ACE: u8 = 0x08;

/// One ACE of a DACL, as privateProblem reads it.
#[derive(Debug)]
pub struct Rule {
    pub sid: Vec<u8>,
    pub allow: bool,
    pub inherit_only: bool,
    pub mask: u32,
}

/// An object's owner and DACL, by SID. `other_aces`: the DACL holds an
/// ACE that is neither a plain allow nor a plain deny, or one that could
/// not be read, or there is no DACL at all (which grants everyone
/// everything): privateProblem fails it.
#[derive(Debug)]
pub struct Acl {
    pub owner: Vec<u8>,
    pub rules: Vec<Rule>,
    pub other_aces: bool,
}

/// A SID inside an ACE, copied out only if it lies wholly within the
/// `room` bytes the ACE has for it: its header (2 bytes: revision, count)
/// is read only when there is room for it, and its length (8 + 4 × count)
/// checked against `room` before anything else is read.
///
/// # Safety
/// `sid` must point to `room` readable bytes that stay valid for this call.
unsafe fn sid_bytes_within(sid: *const u8, room: usize) -> Option<Vec<u8>> {
    if room < 8 {
        return None;
    }
    // SAFETY: room >= 8, so byte 1 (the sub-authority count) is readable.
    let count = usize::from(unsafe { *sid.add(1) });
    let len = 8 + 4 * count;
    if len > room {
        return None;
    }
    // SAFETY: len <= room bytes are readable (the caller's contract).
    Some(unsafe { std::slice::from_raw_parts(sid, len) }.to_vec())
}

/// A SID's bytes, copied out of memory the OS gave (a token, a security
/// descriptor), which holds the whole SID.
///
/// # Safety
/// `sid` must point to a SID that stays valid for this call.
unsafe fn sid_bytes(sid: PSID) -> Option<Vec<u8>> {
    // SAFETY: the caller guarantees sid is valid; IsValidSid only reads it.
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return None;
    }
    // SAFETY: a valid SID; GetLengthSid reads its header.
    let len = unsafe { GetLengthSid(sid) } as usize;
    // SAFETY: len bytes from a valid SID are readable (GetLengthSid's
    // contract), and the slice is copied before the SID can go.
    Some(unsafe { std::slice::from_raw_parts(sid as *const u8, len) }.to_vec())
}

/// The current process's user SID.
pub fn current_user_sid() -> io::Result<Vec<u8>> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle needing no close;
    // token is an out-pointer to a local.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut size = 0u32;
        // SAFETY: a size query (null buffer, length 0); fails with
        // ERROR_INSUFFICIENT_BUFFER and sets size.
        unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        if (size as usize) < size_of::<TOKEN_USER>() {
            return Err(io::Error::other("the token's user is smaller than a TOKEN_USER"));
        }
        // u64s, so the buffer is aligned for TOKEN_USER
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: buf holds at least size bytes and outlives the call.
        if unsafe { GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut c_void, size, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetTokenInformation(TokenUser) filled buf with a TOKEN_USER
        // whose Sid points inside buf, which is alive here.
        let sid = unsafe { (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid };
        // SAFETY: as above, the SID is inside buf.
        unsafe { sid_bytes(sid) }.ok_or_else(|| io::Error::other("the token's user SID is not valid"))
    })();
    // SAFETY: token was opened above and is closed once.
    unsafe { CloseHandle(token) };
    result
}

/// The owner and DACL of an open file or directory (read from the handle,
/// so what was opened is what is checked).
pub fn file_acl(file: &File) -> io::Result<Acl> {
    let mut owner: PSID = ptr::null_mut();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: the handle is the open file's, valid for the call; the out
    // pointers are locals; sd, on success, is ours to LocalFree, and owner and
    // dacl point inside it.
    let rc = unsafe {
        GetSecurityInfo(
            file.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut sd,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(rc as i32));
    }
    let result = (|| {
        // SAFETY: owner points inside sd, alive until LocalFree below.
        let owner = unsafe { sid_bytes(owner) }.ok_or_else(|| io::Error::other("the owner SID is not valid"))?;
        let mut acl = Acl { owner, rules: Vec::new(), other_aces: false };
        if dacl.is_null() {
            // no DACL: everyone has every right
            acl.other_aces = true;
            return Ok(acl);
        }
        let mut info = ACL_SIZE_INFORMATION { AceCount: 0, AclBytesInUse: 0, AclBytesFree: 0 };
        // SAFETY: dacl is valid inside sd; info is a local of the size given.
        if unsafe {
            GetAclInformation(
                dacl,
                &mut info as *mut _ as *mut c_void,
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            acl.other_aces = true;
            return Ok(acl);
        }
        let dacl_start = dacl as usize;
        let dacl_end = dacl_start + info.AclBytesInUse as usize;
        for i in 0..info.AceCount {
            let mut ace: *mut c_void = ptr::null_mut();
            // SAFETY: i < AceCount; GetAce sets ace to point inside the DACL.
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
                acl.other_aces = true;
                continue;
            }
            // the ACE header must lie within the DACL's used bytes
            let at = ace as usize;
            if at < dacl_start || at + size_of::<ACE_HEADER>() > dacl_end {
                acl.other_aces = true;
                continue;
            }
            // SAFETY: the header's 4 bytes are within the DACL (checked above);
            // read unaligned, since an ACE's alignment isn't promised.
            let header = unsafe { ptr::read_unaligned(ace as *const ACE_HEADER) };
            let size = usize::from(header.AceSize);
            if at + size > dacl_end || size < 8 {
                acl.other_aces = true;
                continue;
            }
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE && header.AceType != ACCESS_DENIED_ACE_TYPE {
                acl.other_aces = true;
                continue;
            }
            // SAFETY: an allow or deny ACE is a header (4 bytes), a mask (4
            // bytes) and the SID; size >= 8 and the ACE is within the DACL,
            // so the mask at offset 4 is readable.
            let mask = unsafe { ptr::read_unaligned((ace as *const u8).add(4) as *const u32) };
            // SAFETY: the SID starts at offset 8 and has size - 8 bytes of the
            // ACE for it, all within the DACL; sid_bytes_within reads no more.
            let sid = unsafe { sid_bytes_within((ace as *const u8).add(8), size - 8) };
            match sid {
                Some(sid) => acl.rules.push(Rule {
                    sid,
                    allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                    inherit_only: header.AceFlags & INHERIT_ONLY_ACE != 0,
                    mask,
                }),
                None => acl.other_aces = true,
            }
        }
        Ok(acl)
    })();
    // SAFETY: sd came from GetSecurityInfo and is freed once; nothing read
    // from it is used after this.
    unsafe { LocalFree(sd as _) };
    result
}

/// As Node's process.kill(pid, 0) on Windows (libuv's uv_kill): alive if
/// the process can be opened and has not exited; a process that exists but
/// can't be opened (access denied) counts as alive, as EPERM does on POSIX.
pub fn process_alive(pid: u32) -> bool {
    // libuv's uv_kill(0, 0) succeeds (a pseudo-pid for this process group's
    // idea of "self" on Windows): counted alive, as Node does
    if pid == 0 {
        return true;
    }
    // SAFETY: OpenProcess with a plain pid; the handle, if any, is closed
    // below.
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if h.is_null() {
        // SAFETY: reads the calling thread's last error.
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    let mut code = 0u32;
    // SAFETY: h is a live process handle; code is a local.
    let ok = unsafe { GetExitCodeProcess(h, &mut code) } != 0;
    // SAFETY: h was opened above and is closed once.
    unsafe { CloseHandle(h) };
    ok && code == STILL_ACTIVE as u32
}

/// The DNS host name (GetComputerNameExW, ComputerNameDnsHostname), as
/// Node's os.hostname() gives it on Windows.
pub fn dns_hostname() -> Option<String> {
    let mut len = 0u32;
    // SAFETY: a size query (null buffer); sets len, counting the NUL.
    unsafe { GetComputerNameExW(ComputerNameDnsHostname, ptr::null_mut(), &mut len) };
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    // SAFETY: buf holds len u16s; on success len is the length without NUL.
    if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) } == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// The shim's own stdin, stdout and stderr handles made non-inheritable, so
/// a process it spawns (the daemon) never holds the client's pipes. A
/// handle that exists and can't be changed is an error: the caller then
/// refuses to spawn.
pub fn stdio_not_inherited() -> io::Result<()> {
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle returns this process's handle, null (none) or
        // INVALID_HANDLE_VALUE; it reads no memory of ours.
        let h = unsafe { GetStdHandle(which) };
        if h.is_null() || h == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            continue;
        }
        // SAFETY: h is this process's own standard handle; clearing its
        // inherit flag changes nothing else about it.
        if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Whether one of this process's standard handles is inheritable (tests).
#[cfg(test)]
pub fn stdio_inheritable(which: u32) -> Option<bool> {
    let mut flags = 0u32;
    // SAFETY: as stdio_not_inherited; flags is a local.
    unsafe {
        let h = GetStdHandle(which);
        if h.is_null() || h == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return None;
        }
        if windows_sys::Win32::Foundation::GetHandleInformation(h, &mut flags) == 0 {
            return None;
        }
    }
    Some(flags & HANDLE_FLAG_INHERIT != 0)
}

/// This process's parent's pid, from a Toolhelp process snapshot (the
/// documented way). Read once, at startup, before any wait, so the parent
/// has had the least time to exit and its pid to be reused. The snapshot
/// handle is closed on every path.
pub fn parent_pid() -> Option<u32> {
    let me = std::process::id();
    // SAFETY: a process snapshot of the whole system (pid 0); the handle, if
    // valid, is closed below on every path.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: PROCESSENTRY32W is plain data; dwSize is set as the API needs.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = None;
    // SAFETY: snap is a valid snapshot handle and entry a local with dwSize set.
    let mut ok = unsafe { Process32FirstW(snap, &mut entry) } != 0;
    while ok {
        if entry.th32ProcessID == me {
            found = Some(entry.th32ParentProcessID);
            break;
        }
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snap, &mut entry) } != 0;
    }
    // SAFETY: snap was opened above and is closed once, whatever was found.
    unsafe { CloseHandle(snap) };
    found
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;
    use crate::trust::{self, sid_string};

    fn temp_file(name: &str) -> std::path::PathBuf {
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        let p = std::env::temp_dir()
            .join(format!("ch-shim-{name}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        std::fs::write(&p, b"x").unwrap();
        p
    }

    fn icacls(path: &std::path::Path, args: &[&str]) {
        let st = Command::new("icacls").arg(path).args(args).status().unwrap();
        assert!(st.success(), "icacls {args:?}");
    }

    #[test]
    fn the_current_user_sid_is_a_user_sid() {
        let sid = current_user_sid().unwrap();
        assert!(sid_string(&sid).starts_with("S-1-5-"), "{}", sid_string(&sid));
    }

    #[test]
    fn a_private_file_passes_and_one_everyone_can_read_fails() {
        let me = sid_string(&current_user_sid().unwrap());
        let f = temp_file("acl");
        icacls(&f, &["/inheritance:r", "/grant:r", &format!("*{me}:F"), "*S-1-5-18:F"]);
        let acl = file_acl(&std::fs::File::open(&f).unwrap()).unwrap();
        assert!(!acl.other_aces);
        assert!(sid_string(&acl.owner).starts_with("S-1-5-"), "{}", sid_string(&acl.owner));
        assert!(trust::read_private(&f, 64).is_ok(), "{:?}", trust::read_private(&f, 64).err());
        icacls(&f, &["/grant", "*S-1-1-0:R"]);
        let e = trust::read_private(&f, 64).unwrap_err();
        assert!(e.why.contains("accessible by S-1-1-0"), "{}", e.why);
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn process_alive_as_node_s_kill_0() {
        assert!(process_alive(std::process::id()));
        assert!(process_alive(0), "libuv counts 0 as alive");
        let mut child = Command::new("cmd").args(["/C", "exit 0"]).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        drop(child);
        assert!(!process_alive(pid), "an exited child");
    }

    #[test]
    fn the_host_name_is_node_s_os_hostname() {
        let Ok(out) = Command::new("node").args(["-e", "process.stdout.write(require('os').hostname())"]).output()
        else {
            assert!(std::env::var("CI").is_err(), "node is needed for this test in CI");
            return;
        };
        assert_eq!(dns_hostname().unwrap(), String::from_utf8_lossy(&out.stdout));
    }

    #[test]
    fn the_parent_pid_is_read() {
        assert!(parent_pid().is_some_and(|p| p != 0 && p != std::process::id()));
    }

    #[test]
    fn the_standard_handles_end_up_not_inheritable() {
        stdio_not_inherited().unwrap();
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            if let Some(inheritable) = stdio_inheritable(which) {
                assert!(!inheritable, "standard handle {which} is still inheritable");
            }
        }
    }
}
