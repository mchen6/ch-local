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

#[cfg(test)]
mod tests {
    #[test]
    fn the_parent_is_another_process() {
        assert!(super::parent_pid().is_some_and(|p| p != std::process::id()));
    }
}
