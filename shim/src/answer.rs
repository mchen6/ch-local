//! The shim's own JSON-RPC answers: the crash answer, for a request relayed
//! and never answered when the connection is lost without a drain. The id
//! is the request's original bytes, unchanged.

fn one(id: &[u8], may_have_run: bool) -> Vec<u8> {
    // mayHaveRun false: a request held past a drain's bound, which never
    // reached the runtime (vectors.json drainOverflowAnswer)
    let message = if may_have_run {
        "countinghouse's runtime restarted before answering; the call may have run"
    } else {
        "countinghouse's runtime restarted before this was sent; the call did not run"
    };
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":");
    out.extend_from_slice(id);
    out.extend_from_slice(b",\"error\":{\"code\":-32603,\"message\":");
    out.extend_from_slice(serde_json::to_string(message).expect("a string serialises").as_bytes());
    out.extend_from_slice(
        b",\"data\":{\"countinghouse/code\":\"RUNTIME_RESTARTED\",\"retryable\":true,\"mayHaveRun\":",
    );
    out.extend_from_slice(if may_have_run { &b"true"[..] } else { &b"false"[..] });
    out.extend_from_slice(b"}}}");
    out
}

/// A mid-session fallback refused because this shim holds records (the
/// vectors' sessionCantFallBackAnswer, exact apart from the id).
pub fn cant_fall_back(id: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(320);
    out.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":");
    out.extend_from_slice(id);
    out.extend_from_slice(b",\"error\":{\"code\":-32603,\"message\":\"countinghouse's shared runtime failed, and this session's tightened settings can't move to a runtime of its own: restart the session\",\"data\":{\"countinghouse/code\":\"SESSION_CANT_FALL_BACK\",\"retryable\":false}}}");
    out
}

/// The crash answer for a request with these id bytes.
pub fn crash(id: &[u8], may_have_run: bool) -> Vec<u8> {
    one(id, may_have_run)
}

/// For a batch: an array of crash answers, one per member that had an id;
/// None for a batch with no request in it, which JSON-RPC answers with
/// nothing at all.
pub fn crash_batch(ids: &[Vec<u8>], may_have_run: bool) -> Option<Vec<u8>> {
    if ids.is_empty() {
        return None;
    }
    let mut out = vec![b'['];
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(&one(id, may_have_run));
    }
    out.push(b']');
    Some(out)
}

fn error(id: &[u8], code: i32, message: &str) -> Vec<u8> {
    let mut out = b"{\"jsonrpc\":\"2.0\",\"id\":".to_vec();
    out.extend_from_slice(id);
    out.extend_from_slice(format!(",\"error\":{{\"code\":{code},\"message\":").as_bytes());
    out.extend_from_slice(serde_json::to_string(message).expect("a string serialises").as_bytes());
    out.extend_from_slice(b"}}");
    out
}

/// A client line over the bound, discarded unread, so with no id
/// (vectors.json tooLongLineAnswer).
pub fn too_long(limit: usize) -> Vec<u8> {
    too_long_for(b"null", limit)
}

/// A request read whole and then found too large for the connection (a
/// line held under the default bound, then a WELCOME granting less): the
/// same answer, with the request's own id.
pub fn too_long_for(id: &[u8], limit: usize) -> Vec<u8> {
    error(id, -32600, &format!("the request is larger than countinghouse accepts ({limit} bytes)"))
}

/// A request while the shim can't reach the runtime (contract 2, section 1,
/// "If it still can't attach"). The reason is the shim's own text, its
/// control characters removed and its length capped.
pub fn unreachable(id: &[u8], reason: &str) -> Vec<u8> {
    unreachable_with(id, reason, &None)
}

/// The home's own status command for a line (the reviewer, 11-21: a command
/// that runs): `node "<root>/bin/ch-local.js" status`, as ch-local's launcher
/// form says it. None for a path a terminal would not read plainly (a quote,
/// a backtick, a dollar, a control character): the line keeps its words.
pub fn status_command(root: &std::path::Path) -> Option<String> {
    let launcher = root.join("bin").join("ch-local.js");
    let s = launcher.to_str()?;
    if s.chars()
        .any(|c| c.is_control() || matches!(c, '"' | '`' | '$' | '%' | '!' | '\\') && !(cfg!(windows) && c == '\\'))
    {
        return None;
    }
    Some(format!("node \"{s}\" status"))
}

/// unreachable, naming `status` (status_command) when it is given.
pub fn unreachable_with(id: &[u8], reason: &str, status: &Option<String>) -> Vec<u8> {
    let reason: String = reason.chars().filter(|c| !c.is_control()).take(300).collect();
    let then = match status {
        Some(cmd) => format!("run `{cmd}` in your own terminal to see why"),
        None => "countinghouse's status in your own terminal says why".to_string(),
    };
    error(
        id,
        -32603,
        &format!("countinghouse could not reach its shared runtime ({reason}); try again; if it keeps failing, {then}"),
    )
}

/// A request past the in-flight table's bound: answered by the shim, never
/// forwarded.
pub fn too_many(id: &[u8]) -> Vec<u8> {
    error(id, -32603, "countinghouse has too many requests in flight on this session; try again")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_too_long_answer_is_the_vectors() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let t = &v["tooLongLineAnswer"];
        assert_eq!(too_long(t["limit"].as_u64().unwrap() as usize), t["json"].as_str().unwrap().as_bytes());
    }

    #[test]
    fn the_unreachable_answer_keeps_no_control_character_and_is_valid_json() {
        let a = unreachable(b"\"x\"", "a\u{1b}[2Jb\nc");
        let v: serde_json::Value = serde_json::from_slice(&a).unwrap();
        assert_eq!(v["id"], "x");
        assert_eq!(v["error"]["code"], -32603);
        assert!(v["error"]["message"].as_str().unwrap().contains("(a[2Jbc)"));
    }

    /// The reviewer, 11-21: the line names a command that runs, the home's
    /// own launcher's status; a home no terminal reads plainly keeps the words
    #[test]
    fn the_unreachable_answer_names_the_homes_status_command() {
        let line = |root: &str| {
            let a = unreachable_with(b"1", "no answer", &status_command(std::path::Path::new(root)));
            let v: serde_json::Value = serde_json::from_slice(&a).unwrap();
            v["error"]["message"].as_str().unwrap().to_string()
        };
        let plain = line("/home/u/.countinghouse");
        let want = format!(
            "if it keeps failing, run `node \"{}\" status` in your own terminal to see why",
            std::path::Path::new("/home/u/.countinghouse").join("bin").join("ch-local.js").display()
        );
        assert!(plain.ends_with(&want), "{plain}");
        let odd = line("/home/a\"b/.countinghouse");
        assert!(odd.ends_with("if it keeps failing, countinghouse's status in your own terminal says why"), "{odd}");
    }
}
