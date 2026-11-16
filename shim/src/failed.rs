//! `<home>/run/daemon/failed.json` (countinghouse's shared-runtime design,
//! section 6, "failed.json: falling back without a loop"): a daemon that gave
//! up says so, and a shim that finds a fresh, valid file starts no daemon and
//! runs the session's own runtime instead. Read with daemon.json's trust
//! checks, at most 512 bytes. Exactly `{v, at, exit, signal, reason}`, none
//! extra, missing or twice. Anything stale, from the future, unreadable or
//! invalid is ignored: the shim goes on as before.

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde_json::Value;

use crate::config::Home;
use crate::trust;

/// The file's largest size.
pub const MAX_BYTES: usize = 512;
/// Fresh: `now - FRESH_PAST_MS <= at <= now + FRESH_FUTURE_MS`.
pub const FRESH_PAST_MS: i128 = 600_000;
pub const FRESH_FUTURE_MS: i128 = 60_000;
const SAFE_MAX: u64 = 9_007_199_254_740_991;

/// Why the daemon gave up: the only text of the file the shim ever shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    RestartsExhausted,
    NeverListened,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::RestartsExhausted => "restarts-exhausted",
            Reason::NeverListened => "never-listened",
        }
    }
}

impl fmt::Display for Reason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The startup fallback's line on stderr (the vectors' failedJson.stderr).
pub fn startup_line(reason: Reason) -> String {
    format!("the shared runtime failed ({reason}); this session runs its own")
}

/// The mid-session refusal's line on stderr (sessionCantFallBackAnswer.stderr).
pub fn refusal_line(reason: Reason) -> String {
    format!(
        "the shared runtime failed ({reason}), and this session's tightened settings can't move to a runtime of its own: restart the session"
    )
}

pub fn now_ms() -> i128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i128)
}

/// The object's keys in order, a duplicate refused (serde_json's own Map keeps
/// the last of two silently).
struct Fields(Vec<(String, Value)>);

impl<'de> de::Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Fields, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Fields, A::Error> {
                let mut out: Vec<(String, Value)> = Vec::new();
                while let Some(k) = m.next_key::<String>()? {
                    if out.iter().any(|(x, _)| *x == k) {
                        return Err(de::Error::custom("a duplicate key"));
                    }
                    let v: Value = m.next_value()?;
                    out.push((k, v));
                }
                Ok(Fields(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// A valid file's reason, if it is fresh at `now` (epoch ms); else None.
pub fn parse(bytes: &[u8], now: i128) -> Option<Reason> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let Fields(fields) = serde_json::from_slice::<Fields>(bytes).ok()?;
    const KEYS: [&str; 5] = ["v", "at", "exit", "signal", "reason"];
    if fields.len() != KEYS.len() || !KEYS.iter().all(|k| fields.iter().any(|(x, _)| x == k)) {
        return None;
    }
    let get = |k: &str| fields.iter().find(|(x, _)| x == k).map(|(_, v)| v);
    // v exactly 1, an integer
    if get("v")?.as_u64() != Some(1) {
        return None;
    }
    // at: a positive safe integer
    let at = get("at")?.as_u64().filter(|&n| (1..=SAFE_MAX).contains(&n))?;
    // exit: a safe integer or null
    match get("exit")? {
        Value::Null => {}
        Value::Number(n) if n.as_i64().is_some_and(|i| i.unsigned_abs() <= SAFE_MAX) => {}
        _ => return None,
    }
    // signal: ^SIG[A-Z0-9]+$ or null
    match get("signal")? {
        Value::Null => {}
        Value::String(s)
            if s.len() > 3
                && s.starts_with("SIG")
                && s[3..].bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) => {}
        _ => return None,
    }
    let reason = match get("reason")?.as_str()? {
        "restarts-exhausted" => Reason::RestartsExhausted,
        "never-listened" => Reason::NeverListened,
        _ => return None,
    };
    let at = at as i128;
    (now - FRESH_PAST_MS <= at && at <= now + FRESH_FUTURE_MS).then_some(reason)
}

/// `<home>/run/daemon/failed.json`'s reason, if present, private, valid and
/// fresh now; anything else is None (ignored).
pub fn read(home: &Home) -> Option<Reason> {
    read_at(home, now_ms())
}

pub fn read_at(home: &Home, now: i128) -> Option<Reason> {
    let bytes = trust::read_private_in(&home.run_dir(), "failed.json", MAX_BYTES).ok()?;
    parse(&bytes, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i128 = 1_794_391_200_000;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap()
    }

    /// A case's bytes: its value with `at` = now + atOffsetMs, or its text
    /// with "<at>" replaced.
    fn bytes_of(case: &Value) -> Vec<u8> {
        let at = NOW + case["atOffsetMs"].as_i64().unwrap() as i128;
        if let Some(text) = case["text"].as_str() {
            return text.replace("<at>", &at.to_string()).into_bytes();
        }
        let mut v = case["value"].as_object().unwrap().clone();
        v.insert("at".into(), Value::from(at as i64));
        serde_json::to_vec(&v).unwrap()
    }

    #[test]
    fn the_vectors_accepted_forms_are_fresh_and_valid() {
        let v = vectors();
        for case in v["failedJson"]["accepted"].as_array().unwrap() {
            let want = match case["value"]["reason"].as_str().unwrap() {
                "never-listened" => Reason::NeverListened,
                _ => Reason::RestartsExhausted,
            };
            assert_eq!(parse(&bytes_of(case), NOW), Some(want), "{}", case["why"]);
        }
    }

    #[test]
    fn the_vectors_ignored_forms_are_ignored() {
        let v = vectors();
        let ignored = v["failedJson"]["ignored"].as_array().unwrap();
        assert!(ignored.len() >= 10);
        for case in ignored {
            assert_eq!(
                parse(&bytes_of(case), NOW),
                None,
                "{}: {}",
                case["why"],
                String::from_utf8_lossy(&bytes_of(case))
            );
        }
    }

    #[test]
    fn the_freshness_bounds_and_the_lines_are_the_vectors() {
        let v = vectors();
        assert_eq!(v["failedJson"]["freshPastMs"].as_i64().unwrap() as i128, FRESH_PAST_MS);
        assert_eq!(v["failedJson"]["freshFutureMs"].as_i64().unwrap() as i128, FRESH_FUTURE_MS);
        assert_eq!(
            startup_line(Reason::NeverListened),
            v["failedJson"]["stderr"].as_str().unwrap().replace("<reason>", "never-listened")
        );
        assert_eq!(
            refusal_line(Reason::RestartsExhausted),
            v["sessionCantFallBackAnswer"]["stderr"].as_str().unwrap().replace("<reason>", "restarts-exhausted")
        );
    }

    #[test]
    fn a_file_over_512_bytes_or_not_an_object_is_ignored() {
        let mut big = br#"{"v":1,"at":1794391200000,"exit":null,"signal":null,"reason":"never-listened"}"#.to_vec();
        assert_eq!(parse(&big, NOW), Some(Reason::NeverListened));
        big.extend(std::iter::repeat_n(b' ', MAX_BYTES));
        assert_eq!(parse(&big, NOW), None);
        assert_eq!(parse(b"[1]", NOW), None);
        assert_eq!(parse(b"", NOW), None);
    }
}
