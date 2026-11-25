//! The requests the shim relayed and has not seen answered, by seq: what it
//! answers for if the connection is lost without a drain. Bounded: past
//! MAX_IN_FLIGHT, a new request is not relayed, and the caller answers it
//! itself.

use std::collections::BTreeMap;

use crate::answer;
use crate::message::Line;

/// The most requests (a batch counts once) in flight at a time.
pub const MAX_IN_FLIGHT: usize = 4096;
/// The most id bytes kept for them in all: a request's id is kept as
/// sent, so a few huge ids must not hold memory without bound.
pub const MAX_ID_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq)]
enum Entry {
    Request(Vec<u8>),
    Batch(Vec<Vec<u8>>),
}

#[derive(Debug, PartialEq)]
pub struct Full;

/// A request whose answer is being written by the reader.
#[derive(Debug)]
pub struct Pending(Entry);

impl Pending {
    /// Its crash answer (a batch's array), or None for nothing to answer.
    pub fn crash_answer(&self) -> Option<Vec<u8>> {
        match &self.0 {
            Entry::Request(id) => Some(answer::crash(id, true)),
            Entry::Batch(ids) => answer::crash_batch(ids, true),
        }
    }
}

#[derive(Debug, Default)]
pub struct InFlight {
    entries: BTreeMap<u64, Entry>,
    id_bytes: usize,
}

fn id_bytes(e: &Entry) -> usize {
    match e {
        Entry::Request(id) => id.len(),
        Entry::Batch(ids) => ids.iter().map(Vec::len).sum(),
    }
}

impl InFlight {
    /// Keeps what a line sent with `seq` needs answering for: a request's id,
    /// or a batch's ids. A batch with no id in it (`[]`, `[1,2]`,
    /// notifications only) is answered with nothing, so nothing is kept;
    /// nor for a response or a plain line. Err(Full) when MAX_IN_FLIGHT
    /// entries are held already: the line is then not to be relayed.
    pub fn track(&mut self, seq: u64, line: &Line) -> Result<(), Full> {
        let entry = match line {
            Line::Request { id, .. } => Entry::Request(id.clone()),
            Line::Batch { ids } if !ids.is_empty() => Entry::Batch(ids.clone()),
            _ => return Ok(()),
        };
        let bytes = id_bytes(&entry);
        if self.entries.len() >= MAX_IN_FLIGHT || self.id_bytes + bytes > MAX_ID_BYTES {
            return Err(Full);
        }
        self.id_bytes += bytes;
        self.entries.insert(seq, entry);
        Ok(())
    }

    /// The answer for `seq` is about to be written: its entry, taken out of
    /// the table, so no crash answer is made for it here; the reader that
    /// took it owns its answer from now (the whole body, or its crash answer
    /// if the body is cut short).
    pub fn take(&mut self, seq: u64) -> Option<Pending> {
        let e = self.entries.remove(&seq)?;
        self.id_bytes -= id_bytes(&e);
        Some(Pending(e))
    }

    /// The answer for `seq` arrived: forgotten. False for a seq not held
    /// (answered already, or an earlier connection's), whose answer is still
    /// written to the client.
    pub fn settle(&mut self, seq: u64) -> bool {
        self.take(seq).is_some()
    }

    /// Whether `seq` still waits for its answer.
    pub fn holds(&self, seq: u64) -> bool {
        self.entries.contains_key(&seq)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The connection was lost without a drain: the crash answers for
    /// everything held, in seq order, and the table is emptied.
    pub fn crash_answers(&mut self) -> Vec<Vec<u8>> {
        self.id_bytes = 0;
        std::mem::take(&mut self.entries)
            .into_values()
            .filter_map(|e| match e {
                Entry::Request(id) => Some(answer::crash(&id, true)),
                Entry::Batch(ids) => answer::crash_batch(&ids, true),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &[u8]) -> Line {
        Line::Request { id: id.to_vec(), method: Some("x".into()) }
    }

    #[test]
    fn a_batch_with_no_id_and_a_response_keep_nothing() {
        let mut t = InFlight::default();
        t.track(1, &Line::Batch { ids: vec![] }).unwrap();
        t.track(2, &Line::Response).unwrap();
        t.track(3, &Line::Plain).unwrap();
        assert!(t.is_empty());
    }

    #[test]
    fn answered_requests_are_forgotten_and_the_rest_crash_answered_in_order() {
        let mut t = InFlight::default();
        t.track(1, &request(b"7")).unwrap();
        t.track(2, &Line::Batch { ids: vec![b"1".to_vec()] }).unwrap();
        t.track(3, &request(b"\"z\"")).unwrap();
        assert!(t.settle(1));
        assert!(!t.settle(1), "answered already");
        assert!(!t.settle(99), "never held");
        let answers = t.crash_answers();
        assert_eq!(answers.len(), 2);
        assert!(answers[0].starts_with(b"[{"), "the batch first, by seq");
        assert!(t.is_empty());
    }

    #[test]
    fn the_ids_kept_are_bounded_in_bytes() {
        let mut t = InFlight::default();
        let big = vec![b'7'; 100 * 1024];
        t.track(1, &request(&big)).unwrap();
        t.track(2, &request(&big)).unwrap();
        assert_eq!(t.track(3, &request(&big)), Err(Full), "over 256 KiB of ids");
        assert!(t.settle(1));
        t.track(3, &request(&big)).unwrap();
    }

    #[test]
    fn the_table_is_bounded() {
        let mut t = InFlight::default();
        for seq in 1..=MAX_IN_FLIGHT as u64 {
            t.track(seq, &request(b"1")).unwrap();
        }
        assert_eq!(t.track(MAX_IN_FLIGHT as u64 + 1, &request(b"1")), Err(Full));
        assert_eq!(t.len(), MAX_IN_FLIGHT);
    }
}
