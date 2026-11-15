//! The client's stdin, as lines (contract 2, section 1, "Client to
//! runtime"): split only on the byte 0x0a, which JSON text never carries
//! unescaped, each bounded by `--maxRequestBody` (WELCOME's maxToRuntime −
//! 4096). A line over the bound is discarded through its newline, never
//! parsed or forwarded, and reported as TooLong; how it is answered is the
//! relay's.

use std::io::{self, BufRead};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The bound before any WELCOME: the runtime's default --maxRequestBody.
pub const DEFAULT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum Read {
    /// A line's bytes without its newline, otherwise unchanged (a `\r`
    /// before it is JSON whitespace, and is forwarded with the rest).
    Line(Vec<u8>),
    /// A line over the limit, discarded; its length so far.
    TooLong(usize),
    Eof,
}

/// The bound a reader enforces, shared so the relay can change it when a
/// WELCOME arrives.
#[derive(Clone, Debug)]
pub struct Limit(Arc<AtomicUsize>);

impl Limit {
    pub fn new(n: usize) -> Limit {
        Limit(Arc::new(AtomicUsize::new(n)))
    }
    pub fn set(&self, n: usize) {
        self.0.store(n, Ordering::Relaxed);
    }
    pub fn get(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}

/// Reads the next line from `r`, holding at most `limit` bytes of it.
pub fn next<R: BufRead>(r: &mut R, limit: &Limit) -> io::Result<Read> {
    let max = limit.get();
    let mut line = Vec::new();
    let mut over = 0usize;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            // EOF: a last line without a newline is still a line
            return Ok(if over > 0 {
                Read::TooLong(over)
            } else if line.is_empty() {
                Read::Eof
            } else {
                Read::Line(line)
            });
        }
        let (take, done) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (buf.len(), false),
        };
        if over == 0 && line.len() + take <= max {
            line.extend_from_slice(&buf[..take]);
        } else {
            // past the limit: count, keep nothing
            over = over.max(line.len()) + take;
            line = Vec::new();
        }
        r.consume(take + usize::from(done));
        if done {
            return Ok(if over > 0 { Read::TooLong(over) } else { Read::Line(line) });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(input: &[u8], limit: usize) -> Vec<Read> {
        let mut r = io::BufReader::with_capacity(4, input);
        let l = Limit::new(limit);
        let mut out = Vec::new();
        loop {
            let x = next(&mut r, &l).unwrap();
            let end = x == Read::Eof;
            out.push(x);
            if end {
                return out;
            }
        }
    }

    #[test]
    fn lines_split_only_on_newline_bytes_and_a_last_line_without_one_counts() {
        assert_eq!(
            all(b"{\"a\":\"x\\ny\"}\n\n{\"b\":1}", 64),
            vec![
                Read::Line(br#"{"a":"x\ny"}"#.to_vec()),
                Read::Line(vec![]),
                Read::Line(br#"{"b":1}"#.to_vec()),
                Read::Eof
            ]
        );
    }

    #[test]
    fn a_line_over_the_limit_is_discarded_through_its_newline_and_the_next_is_whole() {
        let mut input = vec![b'x'; 20];
        input.extend_from_slice(b"\nok\n");
        assert_eq!(all(&input, 10), vec![Read::TooLong(20), Read::Line(b"ok".to_vec()), Read::Eof]);
        assert_eq!(all(&[b'x'; 10], 10), vec![Read::Line(vec![b'x'; 10]), Read::Eof], "at the limit exactly");
    }

    #[test]
    fn the_limit_can_change_between_lines() {
        let mut r = io::BufReader::new(&b"12345\n12345\n"[..]);
        let l = Limit::new(4);
        assert_eq!(next(&mut r, &l).unwrap(), Read::TooLong(5));
        l.set(5);
        assert_eq!(next(&mut r, &l).unwrap(), Read::Line(b"12345".to_vec()));
    }
}
