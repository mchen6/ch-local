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
