//! The conditions child (contract 2, section 5): `<node> <chLocal>
//! conditions --for <client pid> --home <home>`: its first run started with the shim (its answer the first connection's
//! first `client` frame), then one for a later connection's first frame and for each `conditions?`, its one JSON line
//! carried as the `client` frame.
//! - Its environment is the client's (the shim's own), minus every name
//!   starting `NODE_` or `npm_config_`, so nothing acts in Node before
//!   ch-local's own code; its working directory is the shim's (the
//!   client's); stdin and stderr null; at most 4 KiB of stdout read.
//! - It has 10 s (its first run 25 s, from the shim's start). Every child is one of its relay's Children, killed when the
//!   relay ends; on Windows in a job object, so what it starts (PowerShell) goes with it. A child that exits non-zero,
//!   times out, or prints
//!   anything but exactly one JSON object line (or one naming `op` or `seq`)
//!   is a failure, never "no token": a `client` frame with `status:
//!   "failed"` and the shim's own `why`.
//! - The frame keeps the child's bytes: `{"op":"client",` (and `"seq":n,`
//!   when answering `conditions?`), then the child's object after its `{`,
//!   never re-serialized (vectors.json clientFromChildLine).

use std::ffi::OsString;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::config::ShimInfo;

pub const TIMEOUT: Duration = Duration::from_secs(10);
/// The shim's first run of the child starts with the shim, while it attaches, so its bound counts from the shim's start, and
/// is longer than TIMEOUT: a cold Node (and on Windows a cold PowerShell walking the client's ancestors) now shares the
/// machine with a daemon's boot. The relay still answers the runtime within its FIRST_WAIT of the runtime's welcome
/// (relay.rs), whatever is left of this.
pub const FIRST_TIMEOUT: Duration = Duration::from_secs(25);

/// One relay's conditions children. Each is spawned and registered under one lock, with `stopped`: kill_all (when the
/// relay ends) reaches every one, a spawn under way included, and none is spawned after it. Each is killed at its own
/// bound meanwhile. On Windows each runs in a job object that kills its whole tree (Node and the PowerShell it starts) when
/// the child is killed, and when the job's last handle closes: the shim's exit, a signal's included.
#[derive(Clone, Default)]
pub struct Children(std::sync::Arc<std::sync::Mutex<Registered>>);

#[derive(Default)]
struct Registered {
    stopped: bool,
    running: Vec<std::sync::Arc<std::sync::Mutex<Running>>>,
}

/// A child as it runs, and on Windows its job.
struct Running {
    child: std::process::Child,
    #[cfg(windows)]
    job: Option<crate::win_ffi::Job>,
}

impl Running {
    /// Killed, its tree with it on Windows, and waited for.
    fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Children {
    /// Stops the spawning, then kills every child still running and waits for each; none is spawned after this.
    pub fn kill_all(&self) {
        let running: Vec<_> = match self.0.lock() {
            Ok(mut r) => {
                r.stopped = true;
                std::mem::take(&mut r.running)
            }
            Err(_) => Vec::new(),
        };
        // (a child whose lock a panic poisoned is killed all the same: taken off the list, it is never reached again)
        for c in running {
            c.lock().unwrap_or_else(std::sync::PoisonError::into_inner).kill();
        }
    }

    /// Whether no child runs (tests).
    #[cfg(all(test, unix))]
    fn none_running(&self) -> bool {
        self.0.lock().map(|r| r.running.is_empty()).unwrap_or(false)
    }
}

const STDOUT_MAX: u64 = 4096;

/// The environment the child gets: `env` minus NODE_* and npm_config_*.
pub fn child_env(env: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    env.into_iter()
        .filter(|(k, _)| {
            // Windows' environment names are case-insensitive: node_options
            // is NODE_OPTIONS there
            let k = k.to_string_lossy();
            let k = if cfg!(windows) { k.to_ascii_uppercase() } else { k.into_owned() };
            let npm = if cfg!(windows) { "NPM_CONFIG_" } else { "npm_config_" };
            !k.starts_with("NODE_") && !k.starts_with(npm)
        })
        .collect()
}

/// The `client` frame's payload for what the child printed (Ok) or why it
/// failed (Err), answering `seq` if given.
/// After the child exited: its first line (within 2 s), refused if any
/// more than blank space follows it within LATER, or by EOF.
fn read_answer(rx: &std::sync::mpsc::Receiver<Option<Vec<u8>>>) -> Result<Vec<u8>, String> {
    const LATER: Duration = Duration::from_millis(200);
    let never_ended = || "the conditions child's output never ended (a process it started holds it open)".to_string();
    let mut out = Vec::new();
    let first_by = Instant::now() + Duration::from_secs(2);
    let mut eof = false;
    while !out.contains(&b'\n') {
        match rx.recv_timeout(first_by.saturating_duration_since(Instant::now())) {
            Ok(Some(c)) => out.extend_from_slice(&c),
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                eof = true;
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(never_ended()),
        }
        if out.len() as u64 > STDOUT_MAX {
            return Err("the conditions child printed more than 4 KiB".into());
        }
    }
    let later_by = Instant::now() + LATER;
    while !eof {
        match rx.recv_timeout(later_by.saturating_duration_since(Instant::now())) {
            Ok(Some(c)) => out.extend_from_slice(&c),
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => eof = true,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
        }
        if out.len() as u64 > STDOUT_MAX {
            return Err("the conditions child printed more than 4 KiB".into());
        }
    }
    let end = out.iter().position(|b| *b == b'\n').map_or(out.len(), |i| i + 1);
    if out[end..].iter().any(|b| !b.is_ascii_whitespace()) {
        return Err("the conditions child printed more than one line".into());
    }
    out.truncate(end);
    Ok(out)
}

pub fn client_frame(seq: Option<u64>, printed: Result<Vec<u8>, String>) -> Vec<u8> {
    let head = match seq {
        Some(n) => format!("{{\"op\":\"client\",\"seq\":{n}"),
        None => "{\"op\":\"client\"".to_string(),
    };
    let failed = |why: &str| {
        let mut out = head.clone().into_bytes();
        out.extend_from_slice(b",\"status\":\"failed\",\"why\":");
        out.extend_from_slice(serde_json::to_string(why).expect("a string serialises").as_bytes());
        out.push(b'}');
        out
    };
    let bytes = match printed {
        Ok(b) => b,
        Err(why) => return failed(&why),
    };
    let line = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.is_empty() {
        return failed("the conditions child printed nothing");
    }
    if line.contains(&b'\n') {
        return failed("the conditions child printed more than one line");
    }
    let object = match serde_json::from_slice::<Value>(line) {
        Ok(Value::Object(o)) => o,
        Ok(_) => return failed("the conditions child's line is not a JSON object"),
        Err(_) => return failed("the conditions child's line is not JSON"),
    };
    if object.contains_key("op") || object.contains_key("seq") {
        return failed("the conditions child's line names op or seq");
    }
    // the child's bytes after its opening brace
    let start = line.iter().position(|b| *b == b'{').expect("a JSON object starts with {");
    let inner = &line[start + 1..];
    let mut out = head.into_bytes();
    if object.is_empty() {
        out.push(b'}');
    } else {
        out.push(b',');
        out.extend_from_slice(inner);
    }
    out
}

// Tests: a pause between the child's spawn and its joining the job, set on the thread that runs it; a child that ran before
// it joined, and started something, would show it
#[cfg(all(test, windows))]
thread_local! {
    static BEFORE_ASSIGN: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

/// Runs the child for the client `for_pid`; what it printed, or why it
/// failed.
pub fn run(
    shim: &ShimInfo,
    home: &std::path::Path,
    for_pid: u32,
    env: Vec<(OsString, OsString)>,
    timeout: Duration,
    children: &Children,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(&shim.node);
    cmd.arg(&shim.ch_local)
        .arg("conditions")
        .arg("--for")
        .arg(for_pid.to_string())
        .arg("--home")
        .arg(home)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // spawned and registered under the one lock, never after kill_all (its relay has ended)
    let (child, mut stdout) = {
        let mut r = children.0.lock().map_err(|_| "the conditions children could not be counted".to_string())?;
        if r.stopped {
            return Err("the shim has stopped relaying".into());
        }
        // (Windows: in a job that kills its tree. The child starts suspended, joins the job, and only then runs, so nothing
        // it starts is outside it. A job that can't be made, or joined, leaves the child to run outside one, to its own
        // kill, as before)
        #[cfg(windows)]
        let job = crate::win_ffi::Job::kill_on_close().ok();
        #[cfg(windows)]
        if job.is_some() {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::win_ffi::CREATE_SUSPENDED);
        }
        let mut spawned = cmd.spawn().map_err(|e| format!("the conditions child could not be started ({e})"))?;
        #[cfg(all(test, windows))]
        if let Some(pause) = BEFORE_ASSIGN.with(|p| p.get()) {
            std::thread::sleep(pause);
        }
        #[cfg(windows)]
        let job = match job {
            Some(j) => {
                let joined = j.assign(&spawned).is_ok();
                // (started suspended: it runs from here; one that can't be resumed would only wait out its timeout, so it
                // is killed, by its job if it joined, and waited for only if it was, never blocking the lock on a process
                // that may not end)
                if let Err(e) = crate::win_ffi::resume_threads(spawned.id()) {
                    if joined {
                        j.terminate();
                    }
                    if spawned.kill().is_ok() || joined {
                        let _ = spawned.wait();
                    }
                    return Err(format!("the conditions child could not be started ({e})"));
                }
                joined.then_some(j)
            }
            None => None,
        };
        let stdout = spawned.stdout.take().expect("piped");
        let running = std::sync::Arc::new(std::sync::Mutex::new(Running {
            child: spawned,
            #[cfg(windows)]
            job,
        }));
        r.running.push(running.clone());
        (running, stdout)
    };
    // (off the list once it has exited or been killed)
    let forget = || {
        if let Ok(mut r) = children.0.lock() {
            r.running.retain(|c| !std::sync::Arc::ptr_eq(c, &child));
        }
    };
    // read on a thread that sends each chunk as it comes, then None at EOF:
    // the answer is its first line, and a second line refuses it (fail
    // closed). A grandchild that holds the pipe open can't hold the shim:
    // past the first line, only what comes within LATER is looked at (the
    // thread itself then lives until that grandchild lets the pipe go)
    let (rtx, rrx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        let mut total = 0u64;
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total += n as u64;
                    if rtx.send(Some(buf[..n].to_vec())).is_err() || total > STDOUT_MAX {
                        return;
                    }
                }
            }
        }
        let _ = rtx.send(None);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        let waited = match child.lock() {
            Ok(mut c) => c.child.try_wait(),
            Err(_) => {
                forget();
                return Err("the conditions child could not be waited for".into());
            }
        };
        match waited {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                if let Ok(mut c) = child.lock() {
                    c.kill();
                }
                // (shown to the client as the reason its checks could not run: business's words, "setup" since the
                // child reads more than settings files: hooks, plugins, policy, the client's command line and variables)
                forget();
                return Err(format!("the check of the client's setup did not finish within {} s", timeout.as_secs()));
            }
            Err(e) => {
                forget();
                return Err(format!("the conditions child could not be waited for ({e})"));
            }
        }
    };
    forget();
    let out = read_answer(&rrx)?;
    if !status.success() {
        return Err(format!("the conditions child exited with {status}"));
    }
    if out.len() as u64 > STDOUT_MAX {
        return Err("the conditions child printed more than 4 KiB".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap()
    }

    #[test]
    fn the_childs_line_is_spliced_byte_for_byte_as_the_vectors_have_it() {
        let v = &vectors()["clientFromChildLine"];
        let line = format!("{}\n", v["childLine"].as_str().unwrap()).into_bytes();
        assert_eq!(client_frame(None, Ok(line.clone())), v["first"]["json"].as_str().unwrap().as_bytes());
        assert_eq!(client_frame(Some(3), Ok(line)), v["answeringSeq3"]["json"].as_str().unwrap().as_bytes());
    }

    #[test]
    fn every_bad_child_output_becomes_a_failed_client_frame() {
        let v = &vectors()["clientFromBadChildLine"];
        for bad in v["childOutputs"].as_array().unwrap() {
            let frame = client_frame(Some(4), Ok(bad.as_str().unwrap().as_bytes().to_vec()));
            let o: Value = serde_json::from_slice(&frame).unwrap_or_else(|e| panic!("{bad}: {e}"));
            assert_eq!(
                (o["op"].as_str(), o["status"].as_str(), o["seq"].as_u64()),
                (Some("client"), Some("failed"), Some(4)),
                "{bad}"
            );
            assert!(o["why"].as_str().is_some_and(|w| !w.is_empty()), "{bad}");
        }
        let o: Value = serde_json::from_slice(&client_frame(None, Err("it timed out".into()))).unwrap();
        assert_eq!(o["why"], "it timed out");
        assert!(o.get("seq").is_none());
    }

    #[test]
    fn an_empty_object_is_spliced_without_a_stray_comma() {
        let f = client_frame(Some(2), Ok(b"{}\n".to_vec()));
        assert_eq!(f, br#"{"op":"client","seq":2}"#);
        serde_json::from_slice::<Value>(&f).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_conditions_child_that_prints_a_second_line_is_refused() {
        let p = std::env::temp_dir().join(format!("ch-shim-twolines-{}.sh", std::process::id()));
        std::fs::write(&p, "echo '{\"status\":\"ok\"}'; echo '{\"status\":\"also\"}'\n").unwrap();
        let shim = ShimInfo { node: "/bin/sh".into(), ch_local: p.clone(), env: vec![] };
        let r = run(&shim, std::path::Path::new("/h"), 1, vec![], TIMEOUT, &Children::default());
        let _ = std::fs::remove_file(&p);
        assert!(r.as_ref().is_err_and(|w| w.contains("more than one line")), "{r:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_child_past_its_bound_is_said_in_the_clients_words() {
        let p = std::env::temp_dir().join(format!("ch-shim-slow-{}.sh", std::process::id()));
        std::fs::write(&p, "sleep 5\n").unwrap();
        let shim = ShimInfo { node: "/bin/sh".into(), ch_local: p.clone(), env: vec![] };
        let r = run(&shim, std::path::Path::new("/h"), 1, vec![], Duration::from_secs(1), &Children::default());
        let _ = std::fs::remove_file(&p);
        assert_eq!(r, Err("the check of the client's setup did not finish within 1 s".to_string()));
    }

    // a run in flight when the relay ends is killed then (main: Children::kill_all), never left to outlive the shim; and
    // after it no child is spawned at all
    #[cfg(unix)]
    #[test]
    fn a_run_in_flight_is_killed_when_the_relay_ends_and_none_starts_after() {
        let pid = std::env::temp_dir().join(format!("ch-shim-inflight-{}.pid", std::process::id()));
        let p = std::env::temp_dir().join(format!("ch-shim-inflight-{}.sh", std::process::id()));
        std::fs::write(&p, format!("echo $$ > '{}.part' && mv '{0}.part' '{0}'; exec sleep 30\n", pid.display()))
            .unwrap();
        let shim = ShimInfo { node: "/bin/sh".into(), ch_local: p.clone(), env: vec![] };
        let children = Children::default();
        let (theirs, shim2) = (children.clone(), shim.clone());
        let started = Instant::now();
        let handle = std::thread::spawn(move || {
            run(&shim2, std::path::Path::new("/h"), 1, vec![], Duration::from_secs(60), &theirs)
        });
        // (the pid file appears whole: written aside, then moved)
        while !pid.exists() && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let child: i32 = std::fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
        children.kill_all();
        let r = handle.join().unwrap();
        assert!(r.is_err(), "{r:?}");
        assert!(started.elapsed() < Duration::from_secs(10), "it ran on: {:?}", started.elapsed());
        let gone = rustix::process::test_kill_process(rustix::process::Pid::from_raw(child).unwrap()).is_err();
        assert!(gone, "the child {child} still runs");
        assert!(children.none_running());
        // (stopped: a run asked for after it spawns nothing)
        let _ = std::fs::remove_file(&pid);
        let after = run(&shim, std::path::Path::new("/h"), 1, vec![], Duration::from_secs(60), &children);
        assert_eq!(after, Err("the shim has stopped relaying".to_string()));
        assert!(!pid.exists(), "a child was spawned after the relay ended");
        let _ = std::fs::remove_file(&p);
    }

    // Windows: a child killed takes what it started with it (the job), as the conditions child's PowerShell would be
    #[cfg(windows)]
    #[test]
    fn on_windows_a_killed_child_takes_what_it_started_with_it() {
        let node = match Command::new("node").args(["-p", "process.execPath"]).output() {
            Ok(o) => String::from_utf8(o.stdout).unwrap().trim().to_string(),
            Err(_) => {
                assert!(std::env::var("CI").is_err(), "node is needed for this test in CI");
                return;
            }
        };
        let dir = std::env::temp_dir();
        let pid = dir.join(format!("ch-shim-tree-{}.pid", std::process::id()));
        let script = dir.join(format!("ch-shim-tree-{}.js", std::process::id()));
        // (a grandchild that would live a minute; its pid written whole, then the child waits as long. Detached, so it is
        // outside the kill-on-close job Node's libuv keeps for the children it starts: only the shim's job ends it)
        std::fs::write(
            &script,
            format!(
                "const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {{}}, 60000)'], {{stdio: 'ignore', detached: true}}); \
                 const fs = require('fs'); fs.writeFileSync({p} + '.part', String(g.pid)); fs.renameSync({p} + '.part', {p}); \
                 setTimeout(() => {{}}, 60000);",
                p = serde_json::to_string(&pid.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let shim = ShimInfo { node: node.into(), ch_local: script.clone(), env: vec![] };
        let children = Children::default();
        let theirs = children.clone();
        let started = Instant::now();
        // (the child's environment as a real launch gives it: the client's, filtered)
        let env = child_env(std::env::vars_os());
        let handle = std::thread::spawn(move || {
            run(&shim, std::path::Path::new("C:\\h"), 1, env, Duration::from_secs(60), &theirs)
        });
        while !pid.exists() && started.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let grandchild: u32 = std::fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
        assert!(crate::win_ffi::process_alive(grandchild), "the grandchild never ran");
        children.kill_all();
        let _ = handle.join().unwrap();
        let _ = (std::fs::remove_file(&pid), std::fs::remove_file(&script));
        let until = Instant::now() + Duration::from_secs(5);
        while crate::win_ffi::process_alive(grandchild) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!crate::win_ffi::process_alive(grandchild), "what the child started outlived it");
    }

    /// The child joins its job before it runs at all: what it starts at once is in the job too, however long the spawn takes
    /// to reach the assign (a pause there, here, which a child already running would outrun).
    #[cfg(windows)]
    #[test]
    fn on_windows_what_the_child_starts_at_once_is_in_its_job_whatever_the_gap_before_the_assign() {
        let node = match Command::new("node").args(["-p", "process.execPath"]).output() {
            Ok(o) => String::from_utf8(o.stdout).unwrap().trim().to_string(),
            Err(_) => {
                assert!(std::env::var("CI").is_err(), "node is needed for this test in CI");
                return;
            }
        };
        let dir = std::env::temp_dir();
        let pid = dir.join(format!("ch-shim-early-{}.pid", std::process::id()));
        let script = dir.join(format!("ch-shim-early-{}.js", std::process::id()));
        // (its first act: a grandchild that would live a minute, its pid written whole; then the child waits as long. Detached,
        // so it is outside the kill-on-close job Node's libuv keeps for the children it starts: only the shim's job, if the
        // child was in it when it started the grandchild, ends it with the child)
        std::fs::write(
            &script,
            format!(
                "const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {{}}, 60000)'], {{stdio: 'ignore', detached: true}}); \
                 const fs = require('fs'); fs.writeFileSync({p} + '.part', String(g.pid)); fs.renameSync({p} + '.part', {p}); \
                 setTimeout(() => {{}}, 60000);",
                p = serde_json::to_string(&pid.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let shim = ShimInfo { node: node.into(), ch_local: script.clone(), env: vec![] };
        let children = Children::default();
        let theirs = children.clone();
        let started = Instant::now();
        let env = child_env(std::env::vars_os());
        let handle = std::thread::spawn(move || {
            BEFORE_ASSIGN.with(|p| p.set(Some(Duration::from_secs(5))));
            run(&shim, std::path::Path::new("C:\\h"), 1, env, Duration::from_secs(60), &theirs)
        });
        while !pid.exists() && started.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(50));
        }
        if !pid.exists() {
            // (the run's own answer says why: a start that failed, say)
            children.kill_all();
            let ran = handle.join().unwrap();
            let _ = std::fs::remove_file(&script);
            panic!("the child never started its grandchild: {ran:?}");
        }
        let grandchild: u32 = std::fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
        assert!(crate::win_ffi::process_alive(grandchild), "the grandchild never ran");
        children.kill_all();
        let _ = handle.join().unwrap();
        let _ = (std::fs::remove_file(&pid), std::fs::remove_file(&script));
        let until = Instant::now() + Duration::from_secs(5);
        while crate::win_ffi::process_alive(grandchild) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        // (one that escaped ends on its own within the minute: never killed here by a pid that could be reused)
        assert!(
            !crate::win_ffi::process_alive(grandchild),
            "what the child started before it joined its job outlived it"
        );
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_env_filter_ignores_case() {
        let env = child_env(
            [("node_options", "x"), ("Npm_Config_Prefix", "y"), ("Path", "z")].map(|(k, v)| (k.into(), v.into())),
        );
        let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["Path"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_grandchild_holding_the_childs_stdout_doesnt_hold_the_shim() {
        let p = std::env::temp_dir().join(format!("ch-shim-grandchild-{}.sh", std::process::id()));
        // prints a line, exits, but leaves a grandchild with stdout open
        std::fs::write(&p, "(sleep 30 &) ; echo '{\"status\":\"ok\"}'\n").unwrap();
        let shim = ShimInfo { node: "/bin/sh".into(), ch_local: p.clone(), env: vec![] };
        let started = Instant::now();
        let r = run(&shim, std::path::Path::new("/h"), 1, vec![], TIMEOUT, &Children::default());
        assert!(started.elapsed() < Duration::from_secs(2), "held for {:?}", started.elapsed());
        // the line it printed is its answer: read to its newline, not to EOF
        assert_eq!(r.unwrap(), b"{\"status\":\"ok\"}\n");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn the_childs_env_loses_node_and_npm_config_names_only() {
        let env = child_env(
            [
                ("NODE_OPTIONS", "--require x"),
                ("npm_config_prefix", "/x"),
                ("PATH", "/bin"),
                ("GITHUB_TOKEN", "t"),
                ("XNODE_", "keep"),
            ]
            .map(|(k, v)| (k.into(), v.into())),
        );
        let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["PATH", "GITHUB_TOKEN", "XNODE_"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_hangs_is_killed_at_its_timeout_and_one_that_prints_is_read() {
        use std::path::Path;
        let dir = std::env::temp_dir();
        let shim = |script: &str| {
            let p = dir.join(format!("ch-shim-child-{}-{}.sh", std::process::id(), script.len()));
            std::fs::write(&p, script).unwrap();
            ShimInfo { node: "/bin/sh".into(), ch_local: p, env: vec![] }
        };
        let hang = shim("sleep 30\n");
        let started = Instant::now();
        let r = run(&hang, Path::new("/h"), 1, vec![], Duration::from_millis(500), &Children::default());
        assert!(r.is_err_and(|w| w.contains("did not finish")));
        assert!(started.elapsed() < Duration::from_secs(5));
        let prints = shim("echo \"{\\\"status\\\":\\\"ok\\\",\\\"args\\\":\\\"$*\\\"}\"\n");
        let out = run(&prints, Path::new("/h"), 42, vec![], TIMEOUT, &Children::default()).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "{\"status\":\"ok\",\"args\":\"conditions --for 42 --home /h\"}\n");
        let fails = shim("exit 3\n");
        assert!(
            run(&fails, Path::new("/h"), 1, vec![], TIMEOUT, &Children::default()).is_err_and(|w| w.contains("exited"))
        );
    }
}
