//! Client lines held while they can't be forwarded: before `settled`, during
//! a drain, while attaching (contract 2, section 1). Kept in order, at most
//! 64 requests and `max_bytes` (WELCOME's maxToRuntime, or the default
//! before one) in all. A line past either bound is refused: the relay
//! answers it (drainOverflowAnswer per id) instead of holding it.

use std::collections::VecDeque;

use crate::message::{self, Line};

pub const MAX_REQUESTS: usize = 64;

#[derive(Debug, Default)]
pub struct Held {
    lines: VecDeque<Vec<u8>>,
    requests: usize,
    bytes: usize,
}

/// Why a line was not held: answer its ids, it never reached the runtime.
#[derive(Debug, PartialEq)]
pub struct Overflow {
    pub ids: Vec<Vec<u8>>,
    pub batch: bool,
}

impl Held {
    /// Holds `line`, or refuses it past a bound. A notification or response
    /// past a bound is dropped (Overflow with no ids): nothing answers it.
    pub fn hold(&mut self, line: Vec<u8>, max_bytes: usize) -> Result<(), Overflow> {
        let class = message::classify(&line);
        let is_request = matches!(class, Line::Request { .. } | Line::Batch { .. });
        if self.bytes + line.len() > max_bytes || (is_request && self.requests >= MAX_REQUESTS) {
            return Err(match class {
                Line::Request { id, .. } => Overflow { ids: vec![id], batch: false },
                Line::Batch { ids } => Overflow { ids, batch: true },
                _ => Overflow { ids: vec![], batch: false },
            });
        }
        self.requests += usize::from(is_request);
        self.bytes += line.len();
        self.lines.push_back(line);
        Ok(())
    }

    /// Everything held, in order, and the queue emptied.
    pub fn take(&mut self) -> Vec<Vec<u8>> {
        self.requests = 0;
        self.bytes = 0;
        self.lines.drain(..).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: u32) -> Vec<u8> {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"x"}}"#).into_bytes()
    }

    #[test]
    fn lines_are_held_in_order_and_given_back_once() {
        let mut h = Held::default();
        h.hold(req(1), 1 << 20).unwrap();
        h.hold(br#"{"jsonrpc":"2.0","method":"n"}"#.to_vec(), 1 << 20).unwrap();
        h.hold(req(2), 1 << 20).unwrap();
        let back = h.take();
        assert_eq!(back.len(), 3);
        assert_eq!(back[0], req(1));
        assert!(h.is_empty());
    }

    #[test]
    fn past_64_requests_or_the_byte_bound_a_request_is_refused_with_its_ids() {
        let mut h = Held::default();
        for i in 0..64 {
            h.hold(req(i), 1 << 20).unwrap();
        }
        assert_eq!(h.hold(req(99), 1 << 20), Err(Overflow { ids: vec![b"99".to_vec()], batch: false }));
        // notifications don't count toward the 64, only toward the bytes
        h.hold(br#"{"jsonrpc":"2.0","method":"n"}"#.to_vec(), 1 << 20).unwrap();
        let mut small = Held::default();
        small.hold(req(1), 40).unwrap();
        let batch = br#"[{"jsonrpc":"2.0","id":"a","method":"x"}]"#.to_vec();
        assert_eq!(small.hold(batch, 40), Err(Overflow { ids: vec![b"\"a\"".to_vec()], batch: true }));
    }
}
