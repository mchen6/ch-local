//! The connection's read half, on its own thread (the relay design): every
//! frame from the runtime after WELCOME.
//! - M: its header is read; a `seq` is settled in the shared InFlight under
//!   its mutex BEFORE the body is written, so a request gets exactly one
//!   answer: the runtime's (written here) or a crash answer (taken by the
//!   relay under the same mutex when the connection is lost), never both.
//!   The body is streamed to stdout, never held whole. A seq in `dropped`
//!   (the shim's own initialize replay) has its body read and discarded.
//! - C: an object with a string `op`, handed to the relay.
//! - anything else, a malformed M or C, or the connection ending: Lost.

use std::collections::HashSet;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::frame::{self, Caps, Kind};
use crate::inflight::InFlight;
use crate::message::{self, HeaderError};
use crate::out::Out;

#[derive(Debug)]
pub enum Event {
    /// An M frame was written to the client (or dropped): its seq, if any.
    Answered(Option<u64>),
    Control(Map<String, Value>),
    /// The connection is over: why.
    Lost(String),
}

/// What the reader shares with the relay.
#[derive(Clone)]
pub struct Shared {
    pub inflight: Arc<Mutex<InFlight>>,
    /// Seqs whose answers the shim itself asked for and drops.
    pub dropped: Arc<Mutex<HashSet<u64>>>,
    pub out: Out,
    /// Set (under the in-flight mutex) once the relay has crash-answered
    /// what was in flight and handed the session on or ended it: from then
    /// no runtime answer is written, so none can follow its crash answer.
    pub closed: Arc<AtomicBool>,
}

/// Reads frames until the connection ends; the last event is always Lost.
pub fn run<R: Read>(mut conn: R, from_runtime: Caps, shared: Shared, tx: SyncSender<Event>) {
    let why = loop {
        match one(&mut conn, from_runtime, &shared) {
            Ok(e) => {
                if tx.send(e).is_err() {
                    return;
                }
            }
            Err(why) => break why,
        }
    };
    let _ = tx.send(Event::Lost(why));
}

fn one<R: Read>(conn: &mut R, caps: Caps, shared: &Shared) -> Result<Event, String> {
    let (kind, len) = frame::read_head(conn, caps).map_err(|e| e.to_string())?;
    match kind {
        Kind::Message => {
            let (seq, rest) = message::read_header(conn, len).map_err(|e| match e {
                HeaderError::Io(e) => e.to_string(),
                HeaderError::Malformed(m) => format!("a malformed message frame ({m:?})"),
            })?;
            // settled first, and the relay's closed flag read, under the
            // in-flight mutex: either the relay's crash answers already ran
            // (closed: this answer is discarded) or they will find this seq
            // gone (it is written here). Never both.
            let closed = {
                let mut t = shared.inflight.lock().expect("the in-flight table's lock");
                if let Some(seq) = seq {
                    t.settle(seq);
                }
                shared.closed.load(Ordering::SeqCst)
            };
            let dropped = seq.is_some_and(|n| shared.dropped.lock().expect("the dropped set's lock").remove(&n));
            if closed || dropped {
                io::copy(&mut conn.take(u64::from(rest)), &mut io::sink()).map_err(|e| e.to_string())?;
                return Ok(Event::Answered(seq));
            }
            shared.out.stream(conn, u64::from(rest)).map_err(|e| e.to_string())?;
            Ok(Event::Answered(seq))
        }
        Kind::Control => {
            let mut payload = vec![0u8; len as usize];
            conn.read_exact(&mut payload).map_err(|e| e.to_string())?;
            match serde_json::from_slice::<Value>(&payload) {
                Ok(Value::Object(o)) if o.get("op").is_some_and(Value::is_string) => Ok(Event::Control(o)),
                _ => Err("a malformed control frame".into()),
            }
        }
        other => Err(format!("the runtime sent a {other:?} frame after WELCOME")),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::mpsc;

    use super::*;
    use crate::message::Line;

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

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap()
    }

    fn read_all(frames: Vec<u8>, inflight: InFlight, dropped: &[u64]) -> (Vec<Event>, Vec<u8>, Arc<Mutex<InFlight>>) {
        let sink = Sink::default();
        let shared = Shared {
            inflight: Arc::new(Mutex::new(inflight)),
            dropped: Arc::new(Mutex::new(dropped.iter().copied().collect())),
            out: Out::new(Box::new(sink.clone())),
            closed: Arc::new(AtomicBool::new(false)),
        };
        let (tx, rx) = mpsc::sync_channel(1024);
        run(&frames[..], Caps { message: 1 << 20 }, shared.clone(), tx);
        let events: Vec<Event> = rx.iter().collect();
        let written = sink.0.lock().unwrap().clone();
        (events, written, shared.inflight)
    }

    #[test]
    fn replies_are_settled_and_written_unmatched_ones_written_anyway() {
        let m = &vectors()["messages"];
        let mut t = InFlight::default();
        t.track(1, &Line::Request { id: b"7".to_vec(), method: Some("tools/call".into()) }).unwrap();
        let frames = [
            m["replyToShim"]["hex"].as_str().unwrap(),
            m["unmatchedReplyToShim"]["hex"].as_str().unwrap(),
            m["notificationToShim"]["hex"].as_str().unwrap(),
        ]
        .iter()
        .map(|h| hex(h))
        .collect::<Vec<_>>()
        .concat();
        let (events, written, inflight) = read_all(frames, t, &[]);
        assert!(inflight.lock().unwrap().is_empty(), "seq 1 settled");
        let want = [
            m["replyToShim"]["line"].as_str().unwrap(),
            m["unmatchedReplyToShim"]["line"].as_str().unwrap(),
            m["notificationToShim"]["line"].as_str().unwrap(),
        ]
        .map(|l| format!("{l}\n"))
        .concat();
        assert_eq!(String::from_utf8(written).unwrap(), want);
        assert!(matches!(
            events.as_slice(),
            [Event::Answered(Some(1)), Event::Answered(Some(99)), Event::Answered(None), Event::Lost(_)]
        ));
    }

    #[test]
    fn the_shims_own_replay_answer_is_dropped() {
        let m = &vectors()["messages"];
        let (events, written, _) = read_all(hex(m["replyToShim"]["hex"].as_str().unwrap()), InFlight::default(), &[1]);
        assert!(written.is_empty(), "{}", String::from_utf8_lossy(&written));
        assert!(matches!(events[0], Event::Answered(Some(1))));
    }

    #[test]
    fn control_frames_go_to_the_relay_and_a_malformed_one_ends_it() {
        let c = &vectors()["control"];
        let frames = [
            hex(c["drain"]["hex"].as_str().unwrap()),
            frame::encode(Kind::Control, b"[1]", Caps { message: 0 }).unwrap(),
        ]
        .concat();
        let (events, _, _) = read_all(frames, InFlight::default(), &[]);
        assert!(matches!(&events[0], Event::Control(o) if o["op"] == "drain"));
        assert!(matches!(&events[1], Event::Lost(w) if w.contains("malformed control")));
    }

    #[test]
    fn a_body_cut_short_still_ends_its_line_and_the_connection_is_lost() {
        let m = &vectors()["messages"];
        let mut whole = hex(m["replyToShim"]["hex"].as_str().unwrap());
        whole.truncate(whole.len() - 5);
        let (events, written, _) = read_all(whole, InFlight::default(), &[]);
        assert_eq!(written.last(), Some(&b'\n'));
        assert!(matches!(events.last(), Some(Event::Lost(_))));
    }

    #[test]
    fn a_frame_of_a_kind_that_never_follows_welcome_ends_it() {
        let frames = frame::encode(Kind::Prove, b"{}", Caps { message: 0 }).unwrap();
        let (events, _, _) = read_all(frames, InFlight::default(), &[]);
        assert!(matches!(&events[0], Event::Lost(w) if w.contains("Prove")));
    }
}
