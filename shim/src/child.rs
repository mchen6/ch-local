//! The conditions child (contract 2, section 5): `<node> <chLocal>
//! conditions --for <client pid> --home <home>`, run once per connection and again for
//! each `conditions?`, its one JSON line carried as the `client` frame.
//! - Its environment is the client's (the shim's own), minus every name
//!   starting `NODE_` or `npm_config_`, so nothing acts in Node before
//!   ch-local's own code; its working directory is the shim's (the
//!   client's); stdin and stderr null; at most 4 KiB of stdout read.
//! - It has 10 s. A child that exits non-zero, times out, or prints
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

/// Runs the child for the client `for_pid`; what it printed, or why it
/// failed.
pub fn run(
    shim: &ShimInfo,
    home: &std::path::Path,
    for_pid: u32,
    env: Vec<(OsString, OsString)>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut child = Command::new(&shim.node)
        .arg(&shim.ch_local)
        .arg("conditions")
        .arg("--for")
        .arg(for_pid.to_string())
        .arg("--home")
        .arg(home)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("the conditions child could not be started ({e})"))?;
    let mut stdout = child.stdout.take().expect("piped");
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
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("the conditions child gave no answer within {} s", timeout.as_secs()));
            }
            Err(e) => return Err(format!("the conditions child could not be waited for ({e})")),
        }
    };
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
        let r = run(&shim, std::path::Path::new("/h"), 1, vec![], TIMEOUT);
        let _ = std::fs::remove_file(&p);
        assert!(r.as_ref().is_err_and(|w| w.contains("more than one line")), "{r:?}");
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
        let r = run(&shim, std::path::Path::new("/h"), 1, vec![], TIMEOUT);
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
        let r = run(&hang, Path::new("/h"), 1, vec![], Duration::from_millis(500));
        assert!(r.is_err_and(|w| w.contains("no answer")));
        assert!(started.elapsed() < Duration::from_secs(5));
        let prints = shim("echo \"{\\\"status\\\":\\\"ok\\\",\\\"args\\\":\\\"$*\\\"}\"\n");
        let out = run(&prints, Path::new("/h"), 42, vec![], TIMEOUT).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "{\"status\":\"ok\",\"args\":\"conditions --for 42 --home /h\"}\n");
        let fails = shim("exit 3\n");
        assert!(run(&fails, Path::new("/h"), 1, vec![], TIMEOUT).is_err_and(|w| w.contains("exited")));
    }
}
