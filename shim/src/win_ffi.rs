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
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_SUCCESS, GetLastError, HANDLE, LocalFree, STILL_ACTIVE,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION, GetAce,
    GetAclInformation, GetLengthSid, GetTokenInformation, IsValidSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
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

/// A SID's bytes, copied out of memory the caller owns.
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
        for i in 0..info.AceCount {
            let mut ace: *mut c_void = ptr::null_mut();
            // SAFETY: i < AceCount; GetAce sets ace to point inside the DACL.
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 || ace.is_null() {
                acl.other_aces = true;
                continue;
            }
            // SAFETY: every ACE starts with an ACE_HEADER.
            let header = unsafe { *(ace as *const ACE_HEADER) };
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE && header.AceType != ACCESS_DENIED_ACE_TYPE {
                acl.other_aces = true;
                continue;
            }
            // SAFETY: allow and deny ACEs share ACCESS_ALLOWED_ACE's layout
            // (header, mask, then the SID at SidStart), within the DACL.
            let a = ace as *const ACCESS_ALLOWED_ACE;
            let mask = unsafe { (*a).Mask };
            // SAFETY: SidStart is the first word of the ACE's SID, inside the
            // DACL, which lives in sd.
            let sid = unsafe { sid_bytes(ptr::addr_of!((*a).SidStart) as PSID) };
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
