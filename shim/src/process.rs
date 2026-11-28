//! This process's parent, for the conditions child's `--for <pid>`
//! (contract 2, section 5): the client that launched the shim. Read once,
//! at startup, before any wait, so the parent has had the least time to
//! exit and its pid to be reused.

/// The parent's pid, or None if it can't be read.
pub fn parent_pid() -> Option<u32> {
    #[cfg(unix)]
    return rustix::process::getppid().map(|p| p.as_raw_nonzero().get() as u32);
    #[cfg(windows)]
    return crate::win_ffi::parent_pid();
}

/// Windows: the shim's own stdin, stdout and stderr made non-inheritable, so nothing it starts holds the client's pipes
/// (CreateProcessW runs with handle inheritance on); a child's own stdio is set for it. Elsewhere nothing to do.
pub fn keep_stdio_from_children() -> std::io::Result<()> {
    #[cfg(windows)]
    return crate::win_ffi::stdio_not_inherited();
    #[cfg(not(windows))]
    Ok(())
}

#[cfg(test)]
mod tests {
    // main keeps the client's pipes from what the shim starts before the relay (its first spawn is the conditions child),
    // and kills the relay's children once it ends: in that order, around the relay
    #[test]
    fn main_keeps_stdio_from_children_before_the_relay_and_kills_its_children_after() {
        let main = include_str!("main.rs");
        let at = |what: &str| main.find(what).unwrap_or_else(|| panic!("main.rs no longer has {what}"));
        let (keep, relay, run, kill) = (
            at("process::keep_stdio_from_children()"),
            at("Relay::new("),
            at("relay.run(io::stdin())"),
            at("children.kill_all()"),
        );
        assert!(keep < relay && relay < run && run < kill, "out of order: {keep} {relay} {run} {kill}");
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_shims_stdio_is_kept_from_children() {
        use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
        super::keep_stdio_from_children().unwrap();
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            assert_ne!(crate::win_ffi::stdio_inheritable(which), Some(true), "handle {which} is still inheritable");
        }
    }

    #[test]
    fn the_parent_is_another_process() {
        assert!(super::parent_pid().is_some_and(|p| p != std::process::id()));
    }
}
