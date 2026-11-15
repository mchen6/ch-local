//! ch-shim's entry. SCAFFOLD: the relay, the handshake's I/O and the
//! reconnect wait for countinghouse's shared-runtime contract to be final.

// unsafe is denied in the binary too; its one call (the startup sweep) is
// allowed where it is made, with its SAFETY note.
#![deny(unsafe_code)]

fn main() {
    // first, before any thread: a descriptor the client leaked must never
    // reach what the shim spawns (the daemon runs modules). A failed sweep
    // is not fatal here; the shim then refuses to start a daemon.
    #[cfg(unix)]
    {
        // SAFETY: startup_sweep's contract is that no thread exists yet; this
        // is main's first statement, before anything that could start one.
        #[allow(unsafe_code)]
        let swept = unsafe { ch_shim::unix_ffi::startup_sweep() };
        if let Err(e) = swept {
            eprintln!(
                "ch-shim: inherited descriptors could not be checked ({e}); no daemon will be started from this shim"
            );
        }
    }
    eprintln!("ch-shim {}: not yet wired to a runtime (scaffold)", env!("CARGO_PKG_VERSION"));
    std::process::exit(2);
}
