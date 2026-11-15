//! M frames: a 2-byte big-endian header length, the header (a JSON object,
//! none when the length is 0), then one line's bytes, never re-encoded.
//!
//! Replies are matched by the shim's own `seq`, never by comparing JSON-RPC
//! ids: the shim keeps each id's original bytes only to answer for it if
//! the connection is lost.

use std::collections::BTreeMap;

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
    /// An object with an `id`: its id's original bytes, and its method.
    Request { id: Vec<u8>, method: Option<String> },
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

pub fn classify(line: &[u8]) -> Line {
    let first = line
        .iter()
        .copied()
        .find(|b| !matches!(b, b' ' | b'\t' | b'\r'));
    match first {
        Some(b'{') => match serde_json::from_slice::<Fields<'_>>(line) {
            Ok(fields) => match id_of(&fields) {
                Some(id) => Line::Request {
                    id,
                    method: fields
                        .get("method")
                        .and_then(|m| serde_json::from_str::<String>(m.get()).ok()),
                },
                None => Line::Plain,
            },
            Err(_) => Line::Plain,
        },
        Some(b'[') => match serde_json::from_slice::<Vec<&RawValue>>(line) {
            Ok(members) => Line::Batch {
                ids: members
                    .iter()
                    .filter_map(|m| {
                        serde_json::from_str::<Fields<'_>>(m.get())
                            .ok()
                            .and_then(|f| id_of(&f))
                    })
                    .collect(),
            },
            Err(_) => Line::Plain,
        },
        _ => Line::Plain,
    }
}

/// A client line as an M payload: `{"seq": n}` for a request or a batch, no
/// header otherwise, then the line's bytes.
pub fn to_runtime(seq: Option<u64>, line: &[u8]) -> Vec<u8> {
    let header = seq.map(|n| format!("{{\"seq\":{n}}}")).unwrap_or_default();
    let mut out = Vec::with_capacity(2 + header.len() + line.len());
    out.extend_from_slice(&(header.len() as u16).to_be_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(line);
    out
}

/// Why an M payload from the runtime closes the connection.
#[derive(Debug, PartialEq)]
pub enum Malformed {
    Under2Bytes,
    HeaderPastEnd,
    HeaderNotAnObject,
    SeqNotAnInteger,
}

/// An M payload from the runtime: its `seq` (None for a notification or a
/// message of the runtime's own), and the bytes to write to the client.
pub fn from_runtime(payload: &[u8]) -> Result<(Option<u64>, &[u8]), Malformed> {
    if payload.len() < 2 {
        return Err(Malformed::Under2Bytes);
    }
    let n = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    if payload.len() - 2 < n {
        return Err(Malformed::HeaderPastEnd);
    }
    let body = &payload[2 + n..];
    if n == 0 {
        return Ok((None, body));
    }
    let fields = serde_json::from_slice::<Fields<'_>>(&payload[2..2 + n])
        .map_err(|_| Malformed::HeaderNotAnObject)?;
    match fields.get("seq") {
        None => Ok((None, body)),
        Some(raw) => match serde_json::from_str::<u64>(raw.get()) {
            Ok(seq) if (1..=MAX_SEQ).contains(&seq) => Ok((Some(seq), body)),
            _ => Err(Malformed::SeqNotAnInteger),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seq_counts_from_1_and_never_passes_max() {
        let mut s = Seq::default();
        assert_eq!((s.take(), s.take()), (Some(1), Some(2)));
        let mut s = Seq(MAX_SEQ - 1);
        assert_eq!((s.take(), s.take()), (Some(MAX_SEQ), None));
    }
}
