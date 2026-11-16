//! What the shim keeps for replay (contract 2, section 1, control `record`,
//! `forget`, `replay`): the runtime's opaque entries, as it sent them, at
//! most 64 and 16 KiB in all, the oldest going first. In memory only. An
//! entry too big to keep, or one pushed out by those bounds, is remembered
//! as lost: the tightening it carried
//! exists, and no replay can give it back, so the session counts as holding
//! records (never looser after a restart or a loss) until `forget`.

use std::collections::VecDeque;

use serde_json::value::RawValue;

pub const MAX_ENTRIES: usize = 64;
pub const MAX_BYTES: usize = 16 * 1024;

#[derive(Debug, Default)]
pub struct Records {
    entries: VecDeque<Box<RawValue>>,
    bytes: usize,
    lost: bool,
}

impl Records {
    /// Keeps `entry` (its bytes unchanged); the oldest go until both bounds
    /// hold. An entry larger than MAX_BYTES on its own is not kept.
    pub fn record(&mut self, entry: Box<RawValue>) -> bool {
        let n = entry.get().len();
        if n > MAX_BYTES {
            self.lost = true;
            return false;
        }
        self.entries.push_back(entry);
        self.bytes += n;
        while self.entries.len() > MAX_ENTRIES || self.bytes > MAX_BYTES {
            let old = self.entries.pop_front().expect("over a bound, so not empty");
            self.bytes -= old.get().len();
            // entries are opaque, so the shim can't tell whether a later one
            // superseded it: a replay without it may be looser, so it fails
            // closed (the reviewer's ruling on #50; B's #284 caps a session
            // at 32 recorded changes, so a well-behaved one never gets here)
            self.lost = true;
        }
        true
    }

    pub fn forget(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.lost = false;
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// A record the runtime sent that couldn't be read: its tightening is
    /// lost as surely as one too big to keep.
    pub fn lose(&mut self) {
        self.lost = true;
    }

    /// The session holds a tightening: an entry kept, or one lost.
    pub fn holds_any(&self) -> bool {
        !self.entries.is_empty() || self.lost
    }

    /// An entry too big to keep came since the last `forget`: a replay
    /// would give back less than the runtime was told.
    pub fn lost(&self) -> bool {
        self.lost
    }

    /// The `replay` control frame's payload: the entries as received.
    pub fn replay_frame(&self) -> Vec<u8> {
        let mut out = b"{\"op\":\"replay\",\"entries\":[".to_vec();
        for (i, e) in self.entries.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.extend_from_slice(e.get().as_bytes());
        }
        out.extend_from_slice(b"]}");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.to_string()).unwrap()
    }

    #[test]
    fn replay_is_the_vectors_frame() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let mut r = Records::default();
        let record: serde_json::Value = serde_json::from_str(v["control"]["record"]["json"].as_str().unwrap()).unwrap();
        r.record(raw(&record["entry"].to_string()));
        assert_eq!(r.replay_frame(), v["control"]["replay"]["json"].as_str().unwrap().as_bytes());
    }

    #[test]
    fn the_oldest_go_first_past_64_entries_or_16_kib() {
        let mut r = Records::default();
        for i in 0..70 {
            r.record(raw(&i.to_string()));
        }
        assert_eq!(r.entries.len(), 64);
        assert_eq!(r.entries.front().unwrap().get(), "6");
        assert!(r.lost(), "the six pushed out are lost: a replay can't give them back");
        assert!(r.holds_any());
        let big = format!("\"{}\"", "x".repeat(10_000));
        r.record(raw(&big));
        r.record(raw(&big));
        assert!(r.bytes <= MAX_BYTES);
        assert_eq!(r.entries.len(), 1, "the second big entry pushed out everything else");
        assert!(!r.record(raw(&format!("\"{}\"", "x".repeat(MAX_BYTES)))), "one entry over 16 KiB alone");
        r.forget();
        assert!(r.is_empty());
        assert!(!r.lost(), "forget clears the lost mark too");
        assert_eq!(r.replay_frame(), b"{\"op\":\"replay\",\"entries\":[]}");
        for i in 0..64 {
            r.record(raw(&i.to_string()));
        }
        assert!(!r.lost(), "64 exactly: nothing pushed out");
    }

    #[test]
    fn an_entry_too_big_to_keep_still_counts_as_held_until_forget() {
        let mut r = Records::default();
        assert!(!r.holds_any());
        assert!(!r.record(raw(&format!("\"{}\"", "x".repeat(MAX_BYTES)))));
        assert!(r.is_empty(), "nothing kept");
        assert!(r.holds_any(), "but a tightening exists that a replay can't give back");
        assert!(r.lost());
        r.record(raw("1"));
        assert!(r.holds_any() && r.lost(), "a later entry doesn't make up for it");
        r.forget();
        assert!(!r.holds_any() && !r.lost(), "forget drops all of them, the lost one too");
    }
}
