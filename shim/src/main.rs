//! ch-shim: one MCP client session's shim to countinghouse's shared runtime
//! (contract 2). The client config ch-local writes runs it as
//! `<shim> --home <absolute home> [pass-through runtime flags…]`.

// unsafe is denied in the binary too; its one call (the startup sweep) is
// allowed where it is made, with its SAFETY note.
#![deny(unsafe_code)]

use std::io;
use std::process::ExitCode;

use ch_shim::config::Home;
use ch_shim::out::Out;
use ch_shim::relay::{self, Exit, Relay, Setup};

fn main() -> ExitCode {
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
    // read once, before any wait (pid reuse)
    let parent = ch_shim::process::parent_pid().unwrap_or(0);
    let (home, rest) = match Home::from_args(std::env::args_os().skip(1)) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("ch-shim: {e}");
            return ExitCode::from(2);
        }
    };
    // a pass-through runtime flag: this session can't share (section 5)
    if !rest.is_empty() {
        let shown: Vec<String> = rest.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        eprintln!("ch-shim: runtime flags given ({}): this session runs its own runtime", shown.join(" "));
        return exit_of(relay::own_runtime_inherited(&home, &rest));
    }
    // a daemon gave up (#236 section 6, failed.json): before anything is read
    // from stdin, the session runs its own runtime with the shim's stdin
    if let Some(r) = ch_shim::attach::startup_fallback(&home) {
        eprintln!("{}", ch_shim::failed::startup_line(r));
        return exit_of(relay::own_runtime_inherited(&home, &[]));
    }
    let client_env = std::env::vars_os().collect();
    let relay = Relay::new(
        Setup { home: home.clone(), rest: Vec::new(), client_env, parent, timing: Default::default() },
        Out::stdout(),
    );
    match relay.run(io::stdin()) {
        Exit::Done => ExitCode::SUCCESS,
        Exit::OwnRuntime { reason, held, rest: lines, replay } => {
            eprintln!("{reason}");
            let out = lines.out();
            own(&home, &[], held, lines, replay, out)
        }
        Exit::Refused => ExitCode::from(1),
    }
}

fn own(
    home: &Home,
    args: &[std::ffi::OsString],
    held: Vec<Vec<u8>>,
    lines: impl Iterator<Item = relay::Piece> + Send + 'static,
    replay: Option<(Vec<u8>, String)>,
    out: ch_shim::out::Out,
) -> ExitCode {
    exit_of(relay::own_runtime(home, args, held, lines, replay, out))
}

/// The per-session runtime's exit code as the shim's.
fn exit_of(r: io::Result<i32>) -> ExitCode {
    match r {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(e) => {
            eprintln!("ch-shim: the per-session runtime could not be started ({e})");
            ExitCode::from(1)
        }
    }
}
