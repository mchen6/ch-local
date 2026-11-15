//! The client's stdout, shared: every writer (the connection reader with
//! the runtime's messages, the relay with the shim's own answers) holds it
//! for one whole message and its newline, so no two messages interleave. A
//! message from the runtime is streamed through it, never held whole.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Out(Arc<Mutex<Box<dyn Write + Send>>>);

/// stdout, held: whole messages written under it never interleave.
pub struct Held<'a>(std::sync::MutexGuard<'a, Box<dyn Write + Send>>);

/// Why a stream stopped.
#[derive(Debug)]
pub enum StreamError {
    /// The source (the connection) ended or failed: the body is short.
    Source(io::Error),
    /// stdout itself failed: the client is gone.
    Sink(io::Error),
}

impl Held<'_> {
    /// One whole message the shim made, and its newline.
    pub fn message(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.0.write_all(bytes)?;
        self.0.write_all(b"\n")?;
        self.0.flush()
    }

    /// Exactly `len` bytes copied from `from` as they arrive, then the
    /// newline. If `from` ends early, the newline is still written (so the
    /// next message starts its own line) and Source is returned; a failed
    /// write to stdout is Sink.
    pub fn stream<R: Read>(&mut self, from: &mut R, len: u64) -> Result<(), StreamError> {
        let mut left = len;
        let mut buf = vec![0u8; 64 * 1024];
        let cut = loop {
            if left == 0 {
                break None;
            }
            let want = buf.len().min(left as usize);
            match from.read(&mut buf[..want]) {
                Ok(0) => {
                    break Some(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        format!("the connection ended {} bytes into a {len}-byte message", len - left),
                    ));
                }
                Ok(n) => {
                    self.0.write_all(&buf[..n]).map_err(StreamError::Sink)?;
                    left -= n as u64;
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => break Some(e),
            }
        };
        self.0.write_all(b"\n").and_then(|()| self.0.flush()).map_err(StreamError::Sink)?;
        match cut {
            None => Ok(()),
            Some(e) => Err(StreamError::Source(e)),
        }
    }
}

impl Out {
    pub fn new(w: Box<dyn Write + Send>) -> Out {
        Out(Arc::new(Mutex::new(w)))
    }

    pub fn stdout() -> Out {
        Out::new(Box::new(io::stdout()))
    }

    pub fn lock(&self) -> Held<'_> {
        Held(self.0.lock().expect("stdout's lock"))
    }

    /// stdout's lock if it comes within `wait` (a stream in progress ends
    /// first), else None: a bounded barrier.
    pub fn lock_within(&self, wait: std::time::Duration) -> Option<Held<'_>> {
        let until = std::time::Instant::now() + wait;
        loop {
            match self.0.try_lock() {
                Ok(g) => return Some(Held(g)),
                Err(std::sync::TryLockError::Poisoned(p)) => return Some(Held(p.into_inner())),
                Err(std::sync::TryLockError::WouldBlock) if std::time::Instant::now() < until => {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
                Err(std::sync::TryLockError::WouldBlock) => return None,
            }
        }
    }

    /// One whole message the shim made, and its newline.
    pub fn message(&self, bytes: &[u8]) -> io::Result<()> {
        self.lock().message(bytes)
    }

    /// As Held::stream, under the lock for the stream's length.
    pub fn stream<R: Read>(&self, from: &mut R, len: u64) -> Result<(), StreamError> {
        self.lock().stream(from, len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_streamed_message_ends_with_one_newline_even_when_cut_short() {
        let sink = Sink::default();
        let out = Out::new(Box::new(sink.clone()));
        out.stream(&mut &b"{\"a\":1}rest"[..], 7).unwrap();
        out.message(b"{\"b\":2}").unwrap();
        assert!(matches!(out.stream(&mut &b"{\"c\""[..], 10), Err(StreamError::Source(_))));
        assert_eq!(&*sink.0.lock().unwrap(), b"{\"a\":1}\n{\"b\":2}\n{\"c\"\n");
    }

    #[test]
    fn two_writers_never_interleave() {
        let sink = Sink::default();
        let out = Out::new(Box::new(sink.clone()));
        let a = {
            let out = out.clone();
            std::thread::spawn(move || {
                for _ in 0..200 {
                    out.stream(&mut &[b'a'; 1000][..], 1000).unwrap();
                }
            })
        };
        for _ in 0..200 {
            out.message(&[b'b'; 1000]).unwrap();
        }
        a.join().unwrap();
        for line in sink.0.lock().unwrap().split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            assert!(line.iter().all(|b| *b == line[0]) && line.len() == 1000, "an interleaved line");
        }
    }
}
