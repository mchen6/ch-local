//! ch-shim's entry. SCAFFOLD: the relay, the handshake's I/O and the
//! reconnect wait for countinghouse's shared-runtime contract to be final.

fn main() {
    // first, before any thread: a descriptor the client leaked must never
    // reach what the shim spawns (the daemon runs modules). A failed sweep
    // is not fatal here; the shim then refuses to start a daemon.
    #[cfg(unix)]
    {
        // SAFETY: main's first statement; no thread has been started.
        if let Err(e) = unsafe { ch_shim::unix_ffi::startup_sweep() } {
            eprintln!(
                "ch-shim: inherited descriptors could not be checked ({e}); no daemon will be started from this shim"
            );
        }
    }
    eprintln!("ch-shim {}: not yet wired to a runtime (scaffold)", env!("CARGO_PKG_VERSION"));
    std::process::exit(2);
}
