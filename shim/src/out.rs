//! The client's stdout, shared: every writer (the connection reader with
//! the runtime's messages, the relay with the shim's own answers) holds it
//! for one whole message and its newline, so no two messages interleave. A
//! message from the runtime is streamed through it, never held whole.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Out(Arc<Mutex<Box<dyn Write + Send>>>);

impl Out {
    pub fn new(w: Box<dyn Write + Send>) -> Out {
        Out(Arc::new(Mutex::new(w)))
    }

    pub fn stdout() -> Out {
        Out::new(Box::new(io::stdout()))
    }

    /// One whole message the shim made, and its newline.
    pub fn message(&self, bytes: &[u8]) -> io::Result<()> {
        let mut w = self.0.lock().expect("stdout's lock");
        w.write_all(bytes)?;
        w.write_all(b"\n")?;
        w.flush()
    }

    /// Exactly `len` bytes copied from `from` as they arrive, then the
    /// newline. If `from` ends early, the newline is still written (so the
    /// next message starts its own line) and the error returned.
    pub fn stream<R: Read>(&self, from: &mut R, len: u64) -> io::Result<()> {
        let mut w = self.0.lock().expect("stdout's lock");
        let copied = io::copy(&mut from.take(len), &mut *w);
        let ended = w.write_all(b"\n").and_then(|()| w.flush());
        match copied {
            Ok(n) if n == len => ended,
            Ok(n) => {
                ended?;
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    format!("the connection ended {} bytes into a {len}-byte message", n),
                ))
            }
            Err(e) => Err(e),
        }
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
        assert!(out.stream(&mut &b"{\"c\""[..], 10).is_err());
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
