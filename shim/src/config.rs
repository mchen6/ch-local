//! The home the shim was given (`--home <absolute>`, from the client config
//! ch-local install writes; never from the environment) and the files in
//! it the shim reads, each trust-checked first (trust.rs):
//! - `<home>/run/daemon/` (the run directory): 0700;
//! - `daemon.json` there: {pid, socket, runtimeVersion, daemonVersion, started};
//! - `secret` there: the runtime's secret;
//! - `<home>/shim.json`: {node, chLocal, env}, from ch-local install.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::secret::{self, Secret};
use crate::trust::{self, TrustError};

/// The largest daemon.json and shim.json the shim reads.
const JSON_MAX: usize = 16 * 1024;
/// The secret file: 64 hex characters and a newline.
const SECRET_MAX: usize = 65;

#[derive(Debug)]
pub enum ConfigError {
    /// `--home` missing or not absolute.
    Home(String),
    Trust(TrustError),
    /// A file whose content isn't the contract's: which, and why.
    Malformed {
        path: PathBuf,
        why: String,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Home(why) => write!(f, "the shim's home: {why}"),
            ConfigError::Trust(e) => write!(f, "{e}"),
            ConfigError::Malformed { path, why } => write!(f, "{}: {why}", path.display()),
        }
    }
}

impl From<TrustError> for ConfigError {
    fn from(e: TrustError) -> Self {
        ConfigError::Trust(e)
    }
}

#[derive(Debug, Clone)]
pub struct Home {
    root: PathBuf,
}

impl Home {
    pub fn new(root: &Path) -> Result<Home, ConfigError> {
        if !root.is_absolute() {
            return Err(ConfigError::Home(format!("{} is not an absolute path", root.display())));
        }
        Ok(Home { root: root.to_path_buf() })
    }

    /// `--home <absolute>` from the shim's arguments, and the arguments left.
    pub fn from_args<I: IntoIterator<Item = std::ffi::OsString>>(
        args: I,
    ) -> Result<(Home, Vec<std::ffi::OsString>), ConfigError> {
        let mut rest = Vec::new();
        let mut home = None;
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            if a == OsStr::new("--home") && home.is_none() {
                home = Some(it.next().ok_or_else(|| ConfigError::Home("--home needs a path".into()))?);
            } else {
                rest.push(a);
            }
        }
        let home = home.ok_or_else(|| ConfigError::Home("no --home was given".into()))?;
        Ok((Home::new(Path::new(&home))?, rest))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn run_dir(&self) -> PathBuf {
        self.root.join("run").join("daemon")
    }
    pub fn daemon_json(&self) -> PathBuf {
        self.run_dir().join("daemon.json")
    }
    pub fn secret(&self) -> PathBuf {
        self.run_dir().join("secret")
    }
    pub fn start_lock(&self) -> PathBuf {
        self.run_dir().join("start.lock")
    }
    pub fn shim_json(&self) -> PathBuf {
        self.root.join("shim.json")
    }
}

fn json_object(path: &Path, bytes: &[u8]) -> Result<serde_json::Map<String, Value>, ConfigError> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(o)) => Ok(o),
        _ => Err(ConfigError::Malformed { path: path.to_path_buf(), why: "not a JSON object".into() }),
    }
}

fn field<'a>(path: &Path, o: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a Value, ConfigError> {
    o.get(key).ok_or_else(|| ConfigError::Malformed { path: path.to_path_buf(), why: format!("no {key}") })
}

fn text(path: &Path, o: &serde_json::Map<String, Value>, key: &str) -> Result<String, ConfigError> {
    field(path, o, key)?
        .as_str()
        .map(String::from)
        .ok_or_else(|| ConfigError::Malformed { path: path.to_path_buf(), why: format!("{key} is not a string") })
}

#[derive(Debug, Clone, PartialEq)]
pub struct DaemonInfo {
    pub pid: i64,
    /// The Unix socket's path, or the Windows pipe's name (endpoint.rs
    /// checks it).
    pub socket: String,
    pub runtime_version: String,
    pub daemon_version: String,
    pub started: String,
}

/// daemon.json, or None when there is none (no daemon is running, or it
/// is stopping). The run directory is checked first; a missing run
/// directory is also None.
pub fn read_daemon(home: &Home) -> Result<Option<DaemonInfo>, ConfigError> {
    let path = home.daemon_json();
    let bytes = match trust::read_private_in(&home.run_dir(), "daemon.json", JSON_MAX) {
        Ok(b) => b,
        // no run directory, or no daemon.json: no daemon (yet)
        Err(e) if e.kind == trust::TrustKind::Missing => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let o = json_object(&path, &bytes)?;
    let pid = field(&path, &o, "pid")?
        .as_i64()
        .filter(|p| *p > 0)
        .ok_or_else(|| ConfigError::Malformed { path: path.clone(), why: "pid is not a positive integer".into() })?;
    Ok(Some(DaemonInfo {
        pid,
        socket: text(&path, &o, "socket")?,
        runtime_version: text(&path, &o, "runtimeVersion")?,
        daemon_version: text(&path, &o, "daemonVersion")?,
        started: text(&path, &o, "started")?,
    }))
}

/// The runtime's secret; the run directory is checked first.
pub fn read_secret(home: &Home) -> Result<Secret, ConfigError> {
    let path = home.secret();
    let bytes = trust::read_private_in(&home.run_dir(), "secret", SECRET_MAX)?;
    secret::parse(&bytes).map_err(|e| ConfigError::Malformed { path, why: e.to_string() })
}

/// The environment the daemon may be given, by name (contract 2,
/// section 6, "Starting", step 4).
#[cfg(unix)]
pub const DAEMON_ENV: &[&str] = &["PATH", "HOME", "LANG", "TMPDIR"];
#[cfg(windows)]
pub const DAEMON_ENV: &[&str] =
    &["PATH", "USERPROFILE", "LANG", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"];

#[derive(Debug, Clone, PartialEq)]
pub struct ShimInfo {
    pub node: PathBuf,
    pub ch_local: PathBuf,
    /// Only DAEMON_ENV's names; any other is refused, never dropped.
    pub env: Vec<(String, String)>,
}

pub fn read_shim(home: &Home) -> Result<ShimInfo, ConfigError> {
    let path = home.shim_json();
    let bytes = trust::read_private(&path, JSON_MAX)?;
    parse_shim(&path, &bytes)
}

fn parse_shim(path: &Path, bytes: &[u8]) -> Result<ShimInfo, ConfigError> {
    let o = json_object(path, bytes)?;
    let absolute = |key: &str| -> Result<PathBuf, ConfigError> {
        let p = PathBuf::from(text(path, &o, key)?);
        if p.is_absolute() {
            Ok(p)
        } else {
            Err(ConfigError::Malformed { path: path.to_path_buf(), why: format!("{key} is not an absolute path") })
        }
    };
    let (node, ch_local) = (absolute("node")?, absolute("chLocal")?);
    // a .cmd or .bat would be run through cmd.exe, with its parsing
    let script = node
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if script {
        return Err(ConfigError::Malformed {
            path: path.to_path_buf(),
            why: "node is a .cmd or .bat script, not a program".into(),
        });
    }
    let env = field(path, &o, "env")?
        .as_object()
        .ok_or_else(|| ConfigError::Malformed { path: path.to_path_buf(), why: "env is not an object".into() })?;
    let mut out = Vec::new();
    for (k, v) in env {
        if !DAEMON_ENV.contains(&k.as_str()) {
            return Err(ConfigError::Malformed {
                path: path.to_path_buf(),
                why: format!("env names {k}, which the daemon may not be given"),
            });
        }
        let v = v.as_str().ok_or_else(|| ConfigError::Malformed {
            path: path.to_path_buf(),
            why: format!("env's {k} is not a string"),
        })?;
        out.push((k.clone(), v.to_string()));
    }
    Ok(ShimInfo { node, ch_local, env: out })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn p() -> PathBuf {
        PathBuf::from("/h/shim.json")
    }

    #[test]
    fn a_home_is_taken_only_from_its_argument_and_must_be_absolute() {
        let (h, rest) = Home::from_args(["--home", "/h", "--x"].map(Into::into)).unwrap();
        assert_eq!((h.root(), rest), (Path::new("/h"), vec!["--x".into()]));
        assert!(matches!(Home::from_args(["--x"].map(Into::into)), Err(ConfigError::Home(_))));
        assert!(matches!(Home::from_args(["--home", "rel"].map(Into::into)), Err(ConfigError::Home(_))));
        assert!(matches!(Home::from_args(["--home"].map(Into::into)), Err(ConfigError::Home(_))));
    }

    #[test]
    fn shim_json_s_vectors_accepted_and_refused() {
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let sj = &v["shimJson"];
        let accepted = if cfg!(windows) { &sj["acceptedWindows"] } else { &sj["acceptedPosix"] };
        for ok in accepted.as_array().unwrap() {
            let s = parse_shim(&p(), ok.to_string().as_bytes()).unwrap_or_else(|e| panic!("{ok}: {e}"));
            assert_eq!(s.env.len(), ok["env"].as_object().unwrap().len(), "{ok}");
        }
        for bad in sj["refused"].as_array().unwrap() {
            assert!(parse_shim(&p(), bad["value"].to_string().as_bytes()).is_err(), "{}", bad["why"]);
        }
    }

    #[test]
    fn shim_json_s_accepted_form() {
        let s = parse_shim(&p(), br#"{"node":"/usr/bin/node","chLocal":"/h/app/bin/ch-local.js","env":{"PATH":"/usr/bin","HOME":"/home/u"}}"#).unwrap();
        assert_eq!(s.node, PathBuf::from("/usr/bin/node"));
        assert_eq!(s.env, vec![("HOME".into(), "/home/u".into()), ("PATH".into(), "/usr/bin".into())]);
    }

    #[test]
    fn shim_json_refuses_a_relative_path_and_any_env_name_off_the_list() {
        for (bad, why) in [
            (r#"{"node":"node","chLocal":"/c","env":{}}"#, "node is not an absolute"),
            (r#"{"node":"/n","chLocal":"c.js","env":{}}"#, "chLocal is not an absolute"),
            (r#"{"node":"/n","chLocal":"/c","env":{"NODE_OPTIONS":"--require /x"}}"#, "NODE_OPTIONS"),
            (r#"{"node":"/n","chLocal":"/c","env":{"PATH":1}}"#, "not a string"),
            (r#"{"node":"/n","chLocal":"/c"}"#, "no env"),
            (r#"{"node":"/opt/node.CMD","chLocal":"/c","env":{}}"#, ".cmd or .bat"),
            (r#"{"node":"/opt/node.bat","chLocal":"/c","env":{}}"#, ".cmd or .bat"),
            (r#"[]"#, "not a JSON object"),
        ] {
            match parse_shim(&p(), bad.as_bytes()) {
                Err(ConfigError::Malformed { why: w, .. }) => assert!(w.contains(why), "{bad}: {w}"),
                other => panic!("{bad}: {other:?}"),
            }
        }
    }
}
