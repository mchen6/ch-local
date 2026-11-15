//! ch-shim's entry. SCAFFOLD: the relay, the handshake's I/O and the
//! reconnect wait for countinghouse's shared-runtime contract to be final.

fn main() {
    eprintln!("ch-shim {}: not yet wired to a runtime (scaffold)", env!("CARGO_PKG_VERSION"));
    std::process::exit(2);
}
