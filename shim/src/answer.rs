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

/// A session refused because this shim lost one of its tightenings (the
/// vectors' sessionTighteningsLostAnswer, exact apart from the id).
pub fn tightenings_lost(id: &[u8]) -> Vec<u8> {
    cant_fall_back(id)
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
    // (only a launcher that is there: a partial install or a moved home
    // names none -- the medium, 4)
    if !launcher.is_file() {
        return None;
    }
    let s = launcher.to_str()?;
    if s.chars().any(|c| unsafe_in_command(c) && !(cfg!(windows) && c == '\\')) {
        return None;
    }
    Some(format!("node \"{s}\" status"))
}

/// A character a terminal would not read plainly in a printed command:
/// ch-local's own set (lib/command-line.js UNSAFE: quotes, a backtick, a
/// dollar, a percent, a bang, a caret, the typographic quotes PowerShell
/// reads as quotes, and the controls, bidi and invisible marks a terminal
/// shows as nothing -- the medium, 1). Windows' backslash is its separator.
fn unsafe_in_command(c: char) -> bool {
    c.is_control()
        || matches!(c, '"' | '`' | '$' | '\\' | '%' | '!' | '^')
        || matches!(c as u32,
            0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
            | 0x2018..=0x201F | 0x200B..=0x200F | 0x2028 | 0x2029 | 0x202A..=0x202E | 0x2060..=0x2069
            | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0xE0000..=0xE007F)
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

    // (business's words for a session refused because it lost one of its
    // tightenings: its own answer, not the cant-fall-back one)
    #[test]
    fn the_tightenings_lost_answer_is_the_vectors_in_these_words() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let want = v["sessionTighteningsLostAnswer"]["json"].as_str().unwrap();
        assert_eq!(String::from_utf8(tightenings_lost(b"7")).unwrap(), want);
        assert_eq!(
            want,
            r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"countinghouse couldn't keep the settings this session tightened, so the session stops: restart it","data":{"countinghouse/code":"SESSION_TIGHTENINGS_LOST","retryable":false}}}"#
        );
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
        // (a home with its launcher there)
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        let root = std::env::temp_dir()
            .join(format!("ch-shim-answer-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin").join("ch-local.js"), "").unwrap();
        let plain = line(root.to_str().unwrap());
        let want = format!(
            "if it keeps failing, run `node \"{}\" status` in your own terminal to see why",
            root.join("bin").join("ch-local.js").display()
        );
        let _ = std::fs::remove_dir_all(&root);
        assert!(plain.ends_with(&want), "{plain}");
        let words = "if it keeps failing, countinghouse's status in your own terminal says why";
        // (no launcher there: the words, never a command that fails)
        assert!(line("/nonexistent-home-for-a-test/.countinghouse").ends_with(words));
        // (a character a terminal would not read plainly: refused)
        for c in ['"', '^', '\u{2019}', '\u{202e}', '\u{200b}'] {
            assert!(unsafe_in_command(c), "{c:?}");
        }
        assert!(!unsafe_in_command('a') && !unsafe_in_command('/'));
    }
}
