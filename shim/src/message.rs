//! M frames: a 2-byte big-endian header length, the header (a JSON object,
//! none when the length is 0), then one line's bytes, never re-encoded.
//!
//! Replies are matched by the shim's own `seq`, never by comparing JSON-RPC
//! ids: the shim keeps each id's original bytes only to answer for it if
//! the connection is lost.

use std::collections::BTreeMap;
use std::io::{self, Read};

use serde_json::value::RawValue;

/// The largest `seq`: below 2^53, so any JSON reader holds it exactly.
pub const MAX_SEQ: u64 = (1 << 53) - 1;

/// The shim's `seq` counter: from 1, for the shim process's whole life. It
/// never restarts on a reconnect or a resume (contract 2), so a reply meant
/// for an earlier connection can never match a later request.
#[derive(Debug, Default)]
pub struct Seq(u64);

impl Seq {
    /// The next `seq`, or None once MAX_SEQ is spent (2^53 requests; the
    /// shim then stops relaying rather than reuse one).
    pub fn take(&mut self) -> Option<u64> {
        if self.0 >= MAX_SEQ {
            return None;
        }
        self.0 += 1;
        Some(self.0)
    }
}

/// What a client line is, as far as the shim needs to know.
#[derive(Debug, PartialEq)]
pub enum Line {
    /// An object with an `id` and a `method`: its id's original bytes, and
    /// its method when that is a string. One whose `method` is not a string
    /// is still a request (it gets a seq): the runtime answers it as
    /// invalid, and the shim must be able to crash-answer it meanwhile.
    Request { id: Vec<u8>, method: Option<String> },
    /// An object with an `id` and no `method`: the client's answer to a
    /// request of the runtime's (a dialog's elicitation, say). The runtime
    /// never answers it, so the shim keeps nothing for it and it gets no
    /// header. PENDING the spec, whose contract 2 says "an object with an
    /// id" is a request: raised with its author.
    Response,
    /// An array: the original bytes of each member's id, for members that
    /// have one.
    Batch { ids: Vec<Vec<u8>> },
    /// A notification, or a line that isn't JSON: forwarded with no header.
    Plain,
}

type Fields<'a> = BTreeMap<String, &'a RawValue>;

fn id_of(fields: &Fields<'_>) -> Option<Vec<u8>> {
    fields.get("id").map(|raw| raw.get().as_bytes().to_vec())
}

/// Only a line's top level is parsed into fields; each value is skipped as
/// raw bytes, so a value's depth or content never refuses a line. (A
/// top-level key that is not valid Unicode, a lone surrogate escape, makes
/// the line Plain.)
pub fn classify(line: &[u8]) -> Line {
    let first = line.iter().copied().find(|b| !matches!(b, b' ' | b'\t' | b'\r'));
    match first {
        Some(b'{') => match serde_json::from_slice::<Fields<'_>>(line) {
            Ok(fields) => match (id_of(&fields), fields.get("method")) {
                (Some(id), Some(method)) => {
                    Line::Request { id, method: serde_json::from_str::<String>(method.get()).ok() }
                }
                (Some(_), None) => Line::Response,
                (None, _) => Line::Plain,
            },
            Err(_) => Line::Plain,
        },
        Some(b'[') => match serde_json::from_slice::<Vec<&RawValue>>(line) {
            Ok(members) => Line::Batch {
                ids: members
                    .iter()
                    .filter_map(|m| serde_json::from_str::<Fields<'_>>(m.get()).ok().and_then(|f| id_of(&f)))
                    .collect(),
            },
            Err(_) => Line::Plain,
        },
        _ => Line::Plain,
    }
}

/// A line too long for the connection: WELCOME's maxToRuntime, the whole M
/// payload (header-length bytes, header and line).
#[derive(Debug, PartialEq)]
pub struct TooLong {
    pub payload: usize,
    pub cap: u32,
}

/// A client line as an M payload: `{"seq": n}` for a request or a batch, no
/// header otherwise, then the line's bytes. Refused, never truncated, when
/// the payload would be over `cap`.
pub fn to_runtime(seq: Option<u64>, line: &[u8], cap: u32) -> Result<Vec<u8>, TooLong> {
    let header = seq.map(|n| format!("{{\"seq\":{n}}}")).unwrap_or_default();
    let payload = 2 + header.len() + line.len();
    if payload > cap as usize {
        return Err(TooLong { payload, cap });
    }
    let mut out = Vec::with_capacity(payload);
    out.extend_from_slice(&(header.len() as u16).to_be_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(line);
    Ok(out)
}

/// Why an M payload from the runtime closes the connection.
#[derive(Debug, PartialEq)]
pub enum Malformed {
    Under2Bytes,
    HeaderPastEnd,
    HeaderNotAnObject,
    SeqNotAnInteger,
}

#[derive(Debug)]
pub enum HeaderError {
    Io(io::Error),
    Malformed(Malformed),
}

fn seq_of(header: &[u8]) -> Result<Option<u64>, Malformed> {
    let fields = serde_json::from_slice::<Fields<'_>>(header).map_err(|_| Malformed::HeaderNotAnObject)?;
    match fields.get("seq") {
        None => Ok(None),
        Some(raw) => match serde_json::from_str::<u64>(raw.get()) {
            Ok(seq) if (1..=MAX_SEQ).contains(&seq) => Ok(Some(seq)),
            _ => Err(Malformed::SeqNotAnInteger),
        },
    }
}

/// Reads an M payload's header from the connection, `length` being the
/// payload's length from frame::read_head: its `seq` (None for a
/// notification or a message of the runtime's own), and how many bytes of
/// the line follow, for the caller to copy to the client as they arrive.
/// The header is at most 65535 bytes; the line is never read here.
pub fn read_header<R: Read>(r: &mut R, length: u32) -> Result<(Option<u64>, u32), HeaderError> {
    if length < 2 {
        return Err(HeaderError::Malformed(Malformed::Under2Bytes));
    }
    let mut n = [0u8; 2];
    r.read_exact(&mut n).map_err(HeaderError::Io)?;
    let n = u16::from_be_bytes(n) as u32;
    if length - 2 < n {
        return Err(HeaderError::Malformed(Malformed::HeaderPastEnd));
    }
    let rest = length - 2 - n;
    if n == 0 {
        return Ok((None, rest));
    }
    let mut header = vec![0u8; n as usize];
    r.read_exact(&mut header).map_err(HeaderError::Io)?;
    seq_of(&header).map(|seq| (seq, rest)).map_err(HeaderError::Malformed)
}

/// A whole M payload already in memory: its `seq` and its line's bytes (for
/// tests, and for small payloads).
pub fn from_runtime(payload: &[u8]) -> Result<(Option<u64>, &[u8]), Malformed> {
    let mut r = payload;
    let length = u32::try_from(payload.len()).map_err(|_| Malformed::HeaderPastEnd)?;
    match read_header(&mut r, length) {
        Ok((seq, _)) => Ok((seq, r)),
        Err(HeaderError::Malformed(m)) => Err(m),
        Err(HeaderError::Io(_)) => Err(Malformed::HeaderPastEnd),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_requests_params_never_make_it_plain_whatever_their_depth_or_escapes() {
        let deep = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"x\",\"params\":{}{}}}",
            "[".repeat(100_000),
            "]".repeat(100_000)
        );
        assert!(matches!(classify(deep.as_bytes()), Line::Request { .. }), "100 000 levels deep");
        let surrogate = br#"{"jsonrpc":"2.0","id":1,"method":"x","params":{"t":"\ud800","\udc00":1}}"#;
        assert!(matches!(classify(surrogate), Line::Request { .. }), "lone surrogates inside params");
    }

    #[test]
    fn a_method_that_is_not_a_string_is_still_a_request() {
        assert_eq!(
            classify(br#"{"jsonrpc":"2.0","id":4,"method":7}"#),
            Line::Request { id: b"4".to_vec(), method: None }
        );
    }

    #[test]
    fn a_line_too_long_is_refused_never_cut() {
        assert_eq!(to_runtime(None, &[b'x'; 10], 11), Err(TooLong { payload: 12, cap: 11 }));
        assert_eq!(to_runtime(None, &[b'x'; 10], 12).map(|p| p.len()), Ok(12));
    }

    #[test]
    fn a_clients_response_is_not_a_request() {
        assert_eq!(classify(br#"{"jsonrpc":"2.0","id":3,"result":{}}"#), Line::Response);
        assert_eq!(classify(br#"{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"no"}}"#), Line::Response);
    }

    #[test]
    fn read_header_leaves_the_line_unread() {
        let payload = to_runtime(Some(5), b"0123456789", 64).unwrap();
        let mut r = &payload[..];
        assert_eq!(read_header(&mut r, payload.len() as u32).ok(), Some((Some(5), 10)));
        assert_eq!(r, b"0123456789");
    }

    #[test]
    fn seq_counts_from_1_and_never_passes_max() {
        let mut s = Seq::default();
        assert_eq!((s.take(), s.take()), (Some(1), Some(2)));
        let mut s = Seq(MAX_SEQ - 1);
        assert_eq!((s.take(), s.take()), (Some(MAX_SEQ), None));
    }
}
