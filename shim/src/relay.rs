//! The relay: one session's state machine (the relay design; contract 2,
//! section 1 "Messages", "Control", "Holding until settled", "The crash
//! answer"; section 5; section 6 "Reconnecting"). Every other thread (stdin,
//! the connection reader, attach, the conditions child, timers) only sends
//! events into one channel; this loop alone changes state.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{self, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::attach::{self, AttachError, Attached};
use crate::config::{self, Home};
use crate::endpoint::Conn;
use crate::frame::{self, Caps, Kind};
use crate::held::{Held, Overflow};
use crate::inflight::InFlight;
use crate::lines::{self, Limit};
use crate::message::{self, Line, Seq};
use crate::out::Out;
use crate::reader::{self, Shared};
use crate::records::Records;
use crate::{answer, child};

/// After the client's stdin ends: answers are relayed this long at most.
const CLOSING_GRACE: Duration = Duration::from_secs(10);
/// Sent after a replayed initialize.
const INITIALIZED: &[u8] = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
/// How long the shim waits for the per-session runtime's output to end
/// after the runtime exits: a process it started may hold the pipe.
const PUMP_DRAIN: Duration = Duration::from_secs(2);
/// How long a welcomed connection waits for `settled` before it is
/// closed and attached again (the runtime's own conditions? wait is 12 s).
const SETTLE_DEADLINE: Duration = Duration::from_secs(30);
/// A connection lost this soon after its WELCOME counts as a quick loss:
/// the next attach waits, doubling, so a runtime that closes at once is
/// never hammered.
const QUICK_LOSS: Duration = Duration::from_secs(10);
/// Connections left at the settle deadline in a row before the runtime is
/// counted unreachable.
const MAX_SETTLE_LOSSES: u32 = 2;
/// The most conditions? asks waiting for the child.
const CHILD_QUEUE: usize = 8;
/// How long finish() waits for an answer still streaming to stdout.
const STDOUT_BARRIER: Duration = Duration::from_secs(5);
/// The relay's event queue: bounded, so the stdin thread (and the reader)
/// wait while main is busy (back-pressure), never queueing without limit.
const QUEUE: usize = 64;
/// The background retries after an attach gave up.
const RETRIES: [u64; 4] = [5, 10, 30, 30];

pub struct Setup {
    pub home: Home,
    /// Arguments other than --home: pass-through runtime flags.
    pub rest: Vec<OsString>,
    /// The client's environment, as the shim was given it.
    pub client_env: Vec<(OsString, OsString)>,
    /// The client's pid, read once at startup.
    pub parent: u32,
    pub timing: Timing,
}

/// How long an attach may take, and the unit of the background retries'
/// backoff (5, 10, 30, 30 units): the spec's 20 s and 1 s; shorter in tests.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub attach: Duration,
    pub retry_unit: Duration,
    /// After stdin's EOF, how long answers are still relayed.
    pub closing: Duration,
    /// How long a welcomed connection may wait for `settled`.
    pub settle: Duration,
    /// How long the exit waits for an answer still streaming to stdout.
    pub barrier: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            attach: attach::BUDGET,
            retry_unit: Duration::from_secs(1),
            closing: CLOSING_GRACE,
            settle: SETTLE_DEADLINE,
            barrier: STDOUT_BARRIER,
        }
    }
}

enum Ev {
    Stdin(lines::Read),
    Reader {
        generation: u64,
        event: reader::Event,
    },
    Attached(Result<Attached, AttachError>),
    Client {
        generation: u64,
        frame: Vec<u8>,
    },
    Retry,
    /// A backoff after a quick loss has passed: attach again.
    Reattach,
    /// The deadline for `settled` on this connection has passed.
    SettleDeadline {
        generation: u64,
    },
}

#[derive(Debug, PartialEq)]
enum State {
    Attaching,
    Unsettled,
    Live,
    Draining,
    Unreachable(String),
    Closing(Instant),
    /// A mid-session fallback refused (failed.json while holding records):
    /// every request is answered SESSION_CANT_FALL_BACK until stdin ends,
    /// then the shim exits non-zero. Nothing attaches again.
    Refused,
}

pub struct Relay {
    setup: Setup,
    tx: SyncSender<Ev>,
    rx: Receiver<Ev>,
    out: Out,
    state: State,
    writer: Option<Box<dyn Conn>>,
    generation: u64,
    to_runtime: Caps,
    limit: Limit,
    seq: Seq,
    inflight: Arc<Mutex<InFlight>>,
    dropped: Arc<Mutex<HashSet<u64>>>,
    closed: Arc<AtomicBool>,
    streaming: Arc<std::sync::atomic::AtomicUsize>,
    records: Records,
    held: Held,
    resume: Option<String>,
    /// The legacy `initialize` line, for the replay after a reconnect.
    initialize: Option<Vec<u8>>,
    replays: u64,
    reconnecting: bool,
    retries: usize,
    stdin_done: bool,
    /// When this connection was welcomed, and how many connections in a
    /// row were lost soon after: the backoff before attaching again.
    attached_at: Option<Instant>,
    quick_losses: u32,
    /// The conditions child runs one at a time; what waits for it.
    child_running: bool,
    child_queue: std::collections::VecDeque<Option<u64>>,
    /// stdout failed: the client is gone, and the shim ends.
    stdout_gone: bool,
    /// Connections in a row left at the settle deadline; at two, the
    /// runtime is unreachable (its held requests answered) instead of
    /// retried every deadline for ever.
    settle_losses: u32,
    give_up: Option<String>,
}

/// How the relay ended.
pub enum Exit {
    Done,
    /// The session can't be shared: run the per-session runtime, handing it
    /// these held lines first, then the rest of the client's lines.
    OwnRuntime {
        /// The line for stderr, as it is printed.
        reason: String,
        held: Vec<Vec<u8>>,
        rest: Rest,
        /// A session that was live: its initialize under the shim's replay
        /// id, and that id, replayed to the per-session runtime first and its
        /// answer dropped (#236 section 6, failed.json).
        replay: Option<(Vec<u8>, String)>,
    },
    /// A mid-session fallback refused: the session held records, and every
    /// request was answered SESSION_CANT_FALL_BACK until stdin ended. The
    /// shim exits non-zero.
    Refused,
}

#[derive(Debug, PartialEq)]
enum Refusal {
    Ids(Vec<Vec<u8>>, bool),
    Null,
    Nothing,
}

/// The rest of the client's lines, still arriving from the relay's stdin
/// reader, after the relay has handed the session over.
pub struct Rest {
    rx: Receiver<Ev>,
    out: Out,
    /// The line bound before the hand-over, for a line cut at the switch.
    limit: usize,
}

/// What goes to the per-session runtime's stdin.
pub enum Piece {
    /// A whole line, its newline to be added.
    Line(Vec<u8>),
    /// Bytes as they came (raw mode).
    Raw(Vec<u8>),
}

impl Rest {
    /// The shim's stdout, which the per-session runtime's relayed output
    /// shares with Rest's own answers (one lock, whole lines).
    pub fn out(&self) -> Out {
        self.out.clone()
    }
}

impl Iterator for Rest {
    type Item = Piece;
    fn next(&mut self) -> Option<Piece> {
        loop {
            match self.rx.recv().ok()? {
                Ev::Stdin(lines::Read::Line(l)) => return Some(Piece::Line(l)),
                Ev::Stdin(lines::Read::Chunk(c)) => return Some(Piece::Raw(c)),
                Ev::Stdin(lines::Read::Eof) => return None,
                // only a line already past the bound when raw mode began:
                // discarded unread, so nothing else can answer it (one small
                // write; pipe writes that size are atomic beside the
                // per-session runtime's own)
                Ev::Stdin(lines::Read::TooLong(_)) => {
                    let _ = self.out.message(&answer::too_long(self.limit));
                }
                // the old connection's late events
                _ => {}
            }
        }
    }
}

impl Relay {
    pub fn new(setup: Setup, out: Out) -> Relay {
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        Relay {
            setup,
            tx,
            rx,
            out,
            state: State::Attaching,
            writer: None,
            generation: 0,
            to_runtime: Caps { message: (lines::DEFAULT_LIMIT + 4096) as u32 },
            limit: Limit::new(lines::DEFAULT_LIMIT),
            seq: Seq::default(),
            inflight: Arc::new(Mutex::new(InFlight::default())),
            dropped: Arc::new(Mutex::new(HashSet::new())),
            closed: Arc::new(AtomicBool::new(false)),
            streaming: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            records: Records::default(),
            held: Held::default(),
            resume: None,
            initialize: None,
            replays: 0,
            reconnecting: false,
            retries: 0,
            stdin_done: false,
            attached_at: None,
            quick_losses: 0,
            child_running: false,
            child_queue: std::collections::VecDeque::new(),
            stdout_gone: false,
            settle_losses: 0,
            give_up: None,
        }
    }

    /// Reads `input` as the client's stdin, and runs until the session ends.
    pub fn run<R: io::Read + Send + 'static>(mut self, input: R) -> Exit {
        let (tx, limit) = (self.tx.clone(), self.limit.clone());
        thread::spawn(move || {
            let mut r = BufReader::new(input);
            loop {
                let got = lines::next(&mut r, &limit).unwrap_or(lines::Read::Eof);
                let end = got == lines::Read::Eof;
                if tx.send(Ev::Stdin(got)).is_err() || end {
                    return;
                }
            }
        });
        self.attach();
        loop {
            let ev = match &self.state {
                State::Closing(by) => match self.rx.recv_timeout(by.saturating_duration_since(Instant::now())) {
                    Ok(ev) => ev,
                    Err(RecvTimeoutError::Timeout) => return self.finish(),
                    Err(RecvTimeoutError::Disconnected) => return self.finish(),
                },
                _ => match self.rx.recv() {
                    Ok(ev) => ev,
                    Err(_) => return self.finish(),
                },
            };
            if let Some(exit) = self.on(ev) {
                return exit;
            }
        }
    }

    fn attach(&mut self) {
        self.state = if matches!(self.state, State::Closing(_)) { return } else { State::Attaching };
        let (tx, home, resume, budget) =
            (self.tx.clone(), self.setup.home.clone(), self.resume.clone(), self.setup.timing.attach);
        thread::spawn(move || {
            let _ = tx.send(Ev::Attached(attach::attach_within(&home, resume.as_deref(), Instant::now() + budget)));
        });
    }

    fn on(&mut self, ev: Ev) -> Option<Exit> {
        match ev {
            Ev::Stdin(lines::Read::Line(line)) => self.line(line),
            // a refused session's unread line: the refusal, its id unknown
            Ev::Stdin(lines::Read::TooLong(_)) if self.state == State::Refused => {
                self.say(&answer::cant_fall_back(b"null"))
            }
            Ev::Stdin(lines::Read::TooLong(_)) => self.say(&answer::too_long(self.limit.get())),
            Ev::Stdin(lines::Read::Eof) => return self.eof(),
            // raw mode starts at the hand-over, when Rest has the queue
            Ev::Stdin(lines::Read::Chunk(_)) => {}
            Ev::Attached(Ok(a)) => self.attached(a),
            Ev::Attached(Err(AttachError::SharedFailed(r))) => return self.shared_failed(r),
            Ev::Attached(Err(e)) => {
                self.unreachable(e.to_string());
                // stdin ended during the attach (eof deferred it): over now
                if self.stdin_done {
                    return Some(Exit::Done);
                }
            }
            Ev::Retry => {
                if matches!(self.state, State::Unreachable(_)) {
                    self.attach();
                }
            }
            Ev::Reattach => {
                if self.state == State::Attaching && self.writer.is_none() {
                    self.attach();
                }
            }
            Ev::SettleDeadline { generation } => {
                if generation == self.generation && self.state == State::Unsettled {
                    self.settle_losses += 1;
                    if self.settle_losses >= MAX_SETTLE_LOSSES {
                        self.give_up =
                            Some(format!("the runtime never settled this session ({} tries)", self.settle_losses));
                    } else {
                        let _ =
                            writeln!(io::stderr(), "ch-shim: the runtime never settled this session; attaching again");
                    }
                    if let Some(w) = self.writer.as_ref() {
                        // the reader then ends, and its Lost reattaches
                        let _ = w.shutdown();
                    }
                }
            }
            Ev::Client { generation, frame } => {
                self.child_running = false;
                if generation == self.generation {
                    self.control(&frame);
                }
                self.next_child();
            }
            Ev::Reader { generation, .. } if generation != self.generation => {}
            Ev::Reader { event: reader::Event::Answered(_), .. } => {
                if matches!(self.state, State::Closing(_)) && self.nothing_in_flight() {
                    return Some(self.finish());
                }
            }
            Ev::Reader { event: reader::Event::Control(op, raw), .. } => return self.op(op, &raw),
            Ev::Reader { event: reader::Event::Lost(why), .. } => return self.lost(why),
            Ev::Reader { event: reader::Event::StdoutGone(_), .. } => self.stdout_gone = true,
        }
        if self.stdout_gone {
            // the client is gone: nothing can be answered, so end at once
            self.close_and_crash_answer();
            return Some(Exit::Done);
        }
        None
    }

    /// One whole message of the shim's own to the client; a failed write
    /// means the client is gone, and the shim ends.
    fn say(&mut self, bytes: &[u8]) {
        if self.out.message(bytes).is_err() {
            self.stdout_gone = true;
        }
    }

    fn control(&mut self, payload: &[u8]) {
        if let Some(w) = self.writer.as_mut() {
            // a failed write is the connection's loss, which the reader reports
            let _ = frame::write_frame(w, Kind::Control, payload, Caps { message: 0 });
        }
    }

    fn line(&mut self, line: Vec<u8>) {
        // an empty (or blank) line is no message: never forwarded or held
        if line.iter().all(|b| matches!(b, b' ' | b'\t' | b'\r')) {
            return;
        }
        match &self.state {
            State::Refused => self.refuse_line(&line),
            State::Live => self.forward(line),
            State::Unreachable(why) => {
                let why = why.clone();
                self.answer_unreachable(&line, &why);
            }
            State::Closing(_) => {}
            State::Attaching | State::Unsettled | State::Draining => {
                // a line this connection could never carry is refused as too
                // large at once, whatever the state: never held, so never
                // answered as a held line that "did not run" instead
                if Self::never_fits(&line, self.to_runtime.message) {
                    let limit = (self.to_runtime.message as usize).saturating_sub(4096);
                    self.refuse_too_long(&line, &message::classify(&line), limit);
                    return;
                }
                if let Err(over) = self.held.hold(line, self.to_runtime.message as usize) {
                    self.overflow(over);
                }
            }
        }
    }

    /// Whether `line`, with the longest seq header, is over the
    /// connection's M cap: 2 length bytes, `{"seq":9007199254740991}`, then
    /// the line.
    fn never_fits(line: &[u8], cap: u32) -> bool {
        const HEADER_MAX: usize = 2 + r#"{"seq":9007199254740991}"#.len();
        HEADER_MAX + line.len() > cap as usize
    }

    fn overflow(&mut self, over: Overflow) {
        if over.ids.is_empty() {
            return;
        }
        if over.batch {
            let mut all = vec![b'['];
            for (i, id) in over.ids.iter().enumerate() {
                if i > 0 {
                    all.push(b',');
                }
                all.extend_from_slice(&answer::crash(id, false));
            }
            all.push(b']');
            self.say(&all);
        } else {
            self.say(&answer::crash(&over.ids[0], false));
        }
    }

    fn answer_unreachable(&mut self, line: &[u8], why: &str) {
        match message::classify(line) {
            Line::Request { id, .. } => self.say(&answer::unreachable(&id, why)),
            Line::Batch { ids } if !ids.is_empty() => {
                let mut all = vec![b'['];
                for (i, id) in ids.iter().enumerate() {
                    if i > 0 {
                        all.push(b',');
                    }
                    all.extend_from_slice(&answer::unreachable(id, why));
                }
                all.push(b']');
                self.say(&all);
            }
            _ => {}
        }
    }

    /// The ids a request or batch line must be answered for, if any.
    /// What a line too large to send gets: each request its too_long
    /// answer; a notification or response nothing (nothing answers those);
    /// a line that isn't a JSON object the null-id answer, as the runtime
    /// would have given it.
    fn too_long_refusal(line: &[u8], class: &Line) -> Refusal {
        if let Some((ids, batch)) = Self::ids_of(class) {
            return Refusal::Ids(ids, batch);
        }
        type Object<'a> = std::collections::HashMap<String, &'a serde_json::value::RawValue>;
        match class {
            Line::Plain if serde_json::from_slice::<Object>(line).is_err() => Refusal::Null,
            _ => Refusal::Nothing,
        }
    }

    fn refuse_too_long(&mut self, line: &[u8], class: &Line, limit: usize) {
        match Self::too_long_refusal(line, class) {
            Refusal::Ids(ids, batch) => self.answer_each(&ids, batch, |id| answer::too_long_for(id, limit)),
            Refusal::Null => self.say(&answer::too_long(limit)),
            Refusal::Nothing => {}
        }
    }

    fn ids_of(class: &Line) -> Option<(Vec<Vec<u8>>, bool)> {
        match class {
            Line::Request { id, .. } => Some((vec![id.clone()], false)),
            Line::Batch { ids } if !ids.is_empty() => Some((ids.clone(), true)),
            _ => None,
        }
    }

    /// One answer per id: the request's own, or a batch's array.
    fn answer_each(&mut self, ids: &[Vec<u8>], batch: bool, one: impl Fn(&[u8]) -> Vec<u8>) {
        if !batch {
            return self.say(&one(&ids[0]));
        }
        let mut all = vec![b'['];
        for (i, id) in ids.iter().enumerate() {
            if i > 0 {
                all.push(b',');
            }
            all.extend_from_slice(&one(id));
        }
        all.push(b']');
        self.say(&all);
    }

    /// A line sent to the runtime. Its frame is built (and checked against
    /// the connection's cap) BEFORE the request is tracked, so a line the
    /// shim answers itself is never left in the in-flight table to be
    /// answered a second time.
    fn forward(&mut self, line: Vec<u8>) {
        let class = message::classify(&line);
        let numbered = matches!(class, Line::Request { .. } | Line::Batch { .. });
        if let Line::Request { method: Some(m), .. } = &class {
            if m == "initialize" {
                self.initialize = Some(line.clone());
            }
        }
        let seq = if numbered {
            match self.seq.take() {
                Some(n) => Some(n),
                None => {
                    if let Some((ids, batch)) = Self::ids_of(&class) {
                        self.answer_each(&ids, batch, answer::too_many);
                    }
                    return;
                }
            }
        } else {
            None
        };
        let Ok(payload) = message::to_runtime(seq, &line, self.to_runtime.message) else {
            let limit = (self.to_runtime.message as usize).saturating_sub(4096);
            // a notification (or a response) too large is dropped: nothing
            // answers a notification
            self.refuse_too_long(&line, &class, limit);
            return;
        };
        if let Some(n) = seq {
            if self.inflight.lock().expect("in-flight lock").track(n, &class).is_err() {
                if let Some((ids, batch)) = Self::ids_of(&class) {
                    self.answer_each(&ids, batch, answer::too_many);
                }
                return;
            }
        }
        if let Some(w) = self.writer.as_mut() {
            let _ = frame::write_frame(w, Kind::Message, &payload, self.to_runtime);
        }
    }

    fn attached(&mut self, a: Attached) {
        self.generation += 1;
        self.retries = 0;
        self.to_runtime = a.welcome.to_runtime;
        self.limit.set((a.welcome.to_runtime.message as usize).saturating_sub(4096));
        self.resume = Some(a.welcome.resume_token.clone());
        let read_half = match a.conn.try_clone_conn() {
            Ok(r) => r,
            Err(e) => return self.unreachable(format!("the connection could not be shared ({e})")),
        };
        let (tx, generation) = (self.tx.clone(), self.generation);
        let shared = Shared {
            inflight: self.inflight.clone(),
            dropped: self.dropped.clone(),
            out: self.out.clone(),
            closed: self.closed.clone(),
            streaming: self.streaming.clone(),
        };
        let from_runtime = a.welcome.to_shim;
        let (rtx, rrx) = mpsc::sync_channel(QUEUE);
        thread::spawn(move || reader::run(read_half, from_runtime, shared, rtx));
        thread::spawn(move || {
            for event in rrx {
                if tx.send(Ev::Reader { generation, event }).is_err() {
                    return;
                }
            }
        });
        self.writer = Some(a.conn);
        self.attached_at = Some(Instant::now());
        {
            let (tx, wait) = (self.tx.clone(), self.setup.timing.settle);
            thread::spawn(move || {
                thread::sleep(wait);
                let _ = tx.send(Ev::SettleDeadline { generation });
            });
        }
        // a new connection's first client frame comes first; asks queued
        // for an older connection are its, and gone with it
        self.child_queue.clear();
        if a.new_session && !self.records.is_empty() {
            let frame = self.records.replay_frame();
            self.control(&frame);
        }
        self.state = if matches!(self.state, State::Closing(_)) { return } else { State::Unsettled };
        self.conditions(None);
    }

    /// Asks for a run of the conditions child: one runs at a time, at most
    /// CHILD_QUEUE wait (an ask past that is dropped; the runtime counts no
    /// answer in 12 s as "no").
    fn conditions(&mut self, seq: Option<u64>) {
        if self.child_queue.len() < CHILD_QUEUE {
            self.child_queue.push_back(seq);
        }
        self.next_child();
    }

    /// Runs the next queued child, if none is running; its `client` frame
    /// goes to this connection (stale ones are dropped by generation).
    fn next_child(&mut self) {
        if self.child_running {
            return;
        }
        let Some(seq) = self.child_queue.pop_front() else { return };
        self.child_running = true;
        let (tx, generation, home, parent) =
            (self.tx.clone(), self.generation, self.setup.home.clone(), self.setup.parent);
        let env = child::child_env(self.setup.client_env.clone());
        thread::spawn(move || {
            let printed = match config::read_shim(&home) {
                Ok(shim) => child::run(&shim, home.root(), parent, env, child::TIMEOUT),
                Err(e) => Err(format!("shim.json: {e}")),
            };
            let _ = tx.send(Ev::Client { generation, frame: child::client_frame(seq, printed) });
        });
    }

    fn op(&mut self, op: Map<String, Value>, raw: &[u8]) -> Option<Exit> {
        match op["op"].as_str().unwrap_or("") {
            "settled" if self.state == State::Unsettled => {
                self.state = State::Live;
                self.settle_losses = 0;
                // the session is restored (section 6, step 4) before any of
                // the client's held traffic reaches it
                if self.reconnecting {
                    self.replay_initialize();
                }
                self.reconnecting = false;
                for line in self.held.take() {
                    self.forward(line);
                }
                // stdin ended during the attach (eof deferred it): its end now
                if self.stdin_done {
                    return self.eof();
                }
            }
            "conditions?" => {
                if let Some(seq) = op.get("seq").and_then(Value::as_u64) {
                    self.conditions(Some(seq));
                }
            }
            "record" => {
                // the entry's bytes as the runtime sent them, never
                // re-serialized: replay hands them back exactly
                type Fields = std::collections::BTreeMap<String, Box<serde_json::value::RawValue>>;
                if let Some(entry) = serde_json::from_slice::<Fields>(raw).ok().and_then(|mut f| f.remove("entry")) {
                    self.records.record(entry);
                }
            }
            "forget" => self.records.forget(),
            "drain" if self.state == State::Live => self.state = State::Draining,
            "own-runtime" => {
                let reason: String = op
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(64)
                    .collect();
                return Some(self.hand_over(
                    format!("ch-shim: this session can't share the runtime ({reason}); it runs its own"),
                    None,
                ));
            }
            _ => {}
        }
        None
    }

    /// The legacy replay (section 6, step 4): the kept initialize line with
    /// the shim's own id, its answer dropped; then notifications/initialized
    /// to the runtime, and tools/list_changed to the client.
    /// The kept initialize line under the shim's own next replay id
    /// (`ch-shim-replay-<n>`, section 6 step 4), and that id: what a replay
    /// sends, and how its answer is told from the client's.
    fn next_replay(&mut self) -> Option<(Vec<u8>, String)> {
        let line = self.initialize.clone()?;
        let Ok(Value::Object(mut o)) = serde_json::from_slice::<Value>(&line) else { return None };
        self.replays += 1;
        let id = format!("ch-shim-replay-{}", self.replays);
        o.insert("id".into(), Value::String(id.clone()));
        Some((serde_json::to_vec(&Value::Object(o)).expect("JSON serialises"), id))
    }

    fn replay_initialize(&mut self) {
        let Some((replay, _)) = self.next_replay() else { return };
        let Some(n) = self.seq.take() else { return };
        self.dropped.lock().expect("dropped lock").insert(n);
        if let (Ok(p), Some(w)) = (message::to_runtime(Some(n), &replay, self.to_runtime.message), self.writer.as_mut())
        {
            let _ = frame::write_frame(w, Kind::Message, &p, self.to_runtime);
        }
        if let (Ok(p), Some(w)) =
            (message::to_runtime(None, INITIALIZED, self.to_runtime.message), self.writer.as_mut())
        {
            let _ = frame::write_frame(w, Kind::Message, &p, self.to_runtime);
        }
        self.say(br#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#);
    }

    /// Crash answers for everything still in flight, taken under the
    /// in-flight mutex with `closed` set, so the reader (if still running)
    /// discards any later answer for them instead of writing a second one.
    fn close_and_crash_answer(&mut self) {
        let answers = {
            let mut t = self.inflight.lock().expect("in-flight lock");
            self.closed.store(true, Ordering::SeqCst);
            t.crash_answers()
        };
        // a bounded barrier: an answer the reader is still streaming ends
        // first (it holds stdout's lock). One stalled past the barrier is
        // cut: the connection is shut, so the reader ends that line and
        // writes its request's crash answer, and then these follow. Only a
        // stdout that takes nothing (the client not reading) loses them.
        let wait = self.setup.timing.barrier;
        let mut held = self.out.lock_within(wait);
        if held.is_none() {
            let _ = writeln!(io::stderr(), "ch-shim: an answer was still being written after {wait:?}; cutting it");
            if let Some(w) = self.writer.as_ref() {
                let _ = w.shutdown();
            }
            held = self.out.lock_within(wait);
        }
        let Some(mut held) = held else {
            let _ = writeln!(
                io::stderr(),
                "ch-shim: stdout took nothing for {wait:?}; {} answers not written",
                answers.len()
            );
            return;
        };
        for a in answers {
            if held.message(&a).is_err() {
                self.stdout_gone = true;
                return;
            }
        }
    }

    fn lost(&mut self, _why: String) -> Option<Exit> {
        self.writer = None;
        if let State::Closing(_) = self.state {
            return Some(self.finish());
        }
        // whatever is still in flight was never answered (after a drain the
        // runtime should have answered all of it; if it crashed instead,
        // these are its crash answers); the reader is gone, so nothing more
        // can come for them
        let answers = self.inflight.lock().expect("in-flight lock").crash_answers();
        for a in answers {
            self.say(&a);
        }
        if let Some(why) = self.give_up.take() {
            // unreachable: the held requests are answered, and the retry
            // schedule (not every deadline) decides when to try again
            self.settle_losses = 0;
            self.unreachable(why);
            return None;
        }
        self.reconnecting = self.initialize.is_some();
        // a connection that died soon after its WELCOME (and not by a
        // drain) waits before the next attach, doubling up to 30 units
        let drained = self.state == State::Draining;
        let quick = !drained && self.attached_at.is_some_and(|t| t.elapsed() < QUICK_LOSS);
        self.quick_losses = if quick { self.quick_losses + 1 } else { 0 };
        self.state = State::Attaching;
        if self.quick_losses == 0 {
            self.attach();
        } else {
            let wait = self.setup.timing.retry_unit * 2u32.saturating_pow(self.quick_losses).min(30);
            let tx = self.tx.clone();
            thread::spawn(move || {
                thread::sleep(wait);
                let _ = tx.send(Ev::Reattach);
            });
        }
        None
    }

    fn unreachable(&mut self, why: String) {
        if matches!(self.state, State::Closing(_)) {
            return;
        }
        if !matches!(self.state, State::Unreachable(_)) {
            let _ = writeln!(io::stderr(), "ch-shim: countinghouse could not reach its shared runtime ({why})");
        }
        for line in self.held.take() {
            self.answer_unreachable(&line, &why);
        }
        self.state = State::Unreachable(why);
        let wait = self.setup.timing.retry_unit * RETRIES[self.retries.min(RETRIES.len() - 1)] as u32;
        self.retries += 1;
        let tx = self.tx.clone();
        thread::spawn(move || {
            thread::sleep(wait);
            let _ = tx.send(Ev::Retry);
        });
    }

    /// The session goes to a runtime of its own: whatever was in flight here
    /// is crash-answered now and the reader stops writing (closed), so the
    /// per-session runtime's output is the only thing on stdout from here;
    /// stdin's bytes pass through unsplit, since that runtime bounds its lines
    /// itself and the shim buffers none of them.
    fn hand_over(&mut self, reason: String, replay: Option<(Vec<u8>, String)>) -> Exit {
        self.close_and_crash_answer();
        if let Some(w) = self.writer.take() {
            let _ = w.shutdown();
        }
        let limit = self.limit.get();
        self.limit.set(lines::Limit::RAW);
        let (_, dead) = mpsc::sync_channel(1);
        let rx = std::mem::replace(&mut self.rx, dead);
        let rest = Rest { rx, out: self.out.clone(), limit };
        Exit::OwnRuntime { reason, held: self.held.take(), rest, replay }
    }

    /// A daemon gave up (#236 section 6, failed.json). Never looser: a
    /// session holding records (its tightenings) can't move to a runtime that
    /// takes no replay, so it refuses; otherwise it runs its own, replaying
    /// its initialize first if it was live.
    fn shared_failed(&mut self, r: crate::failed::Reason) -> Option<Exit> {
        if !self.records.is_empty() {
            let _ = writeln!(io::stderr(), "{}", crate::failed::refusal_line(r));
            self.state = State::Refused;
            for line in self.held.take() {
                self.refuse_line(&line);
            }
            if self.stdin_done {
                return Some(Exit::Refused);
            }
            return None;
        }
        let replay = if self.initialize.is_some() {
            let built = self.next_replay();
            if built.is_none() {
                let _ = writeln!(
                    io::stderr(),
                    "ch-shim: this session's initialize could not be replayed; its own runtime starts uninitialized"
                );
            }
            built
        } else {
            None
        };
        Some(self.hand_over(crate::failed::startup_line(r), replay))
    }

    /// One line of a refused session: each request (a batch's each) answered
    /// SESSION_CANT_FALL_BACK; a notification gets nothing.
    fn refuse_line(&mut self, line: &[u8]) {
        if let Some((ids, batch)) = Self::ids_of(&message::classify(line)) {
            self.answer_each(&ids, batch, answer::cant_fall_back);
        }
    }

    fn eof(&mut self) -> Option<Exit> {
        self.stdin_done = true;
        if self.state == State::Refused {
            return Some(Exit::Refused);
        }
        // a session holding records, mid-reattach: what the attach finds
        // decides (a failed.json means the refusal, its answers and a
        // non-zero exit), so nothing ends before it does
        if self.writer.is_none() && self.state == State::Attaching && !self.records.is_empty() {
            return None;
        }
        if self.writer.is_none() {
            let why = match &self.state {
                State::Unreachable(w) => w.clone(),
                _ => "the client closed before the runtime was reached".into(),
            };
            for line in self.held.take() {
                self.answer_unreachable(&line, &why);
            }
            return Some(Exit::Done);
        }
        // held lines (before settled, during a drain) never reached the
        // runtime, and now never will: each request says so
        for line in self.held.take() {
            if let Some((ids, batch)) = Self::ids_of(&message::classify(&line)) {
                self.answer_each(&ids, batch, |id| answer::crash(id, false));
            }
        }
        self.control(br#"{"op":"bye"}"#);
        self.state = State::Closing(Instant::now() + self.setup.timing.closing);
        if self.nothing_in_flight() {
            return Some(self.finish());
        }
        None
    }

    /// No request is waiting for its answer, and none is being written.
    fn nothing_in_flight(&self) -> bool {
        self.inflight.lock().expect("in-flight lock").is_empty() && self.streaming.load(Ordering::SeqCst) == 0
    }

    fn finish(&mut self) -> Exit {
        self.close_and_crash_answer();
        Exit::Done
    }
}

/// The per-session runtime with the shim's own stdin, unread by the shim:
/// for pass-through flags, before anything was held (section 5). No pump,
/// no line bound of the shim's.
pub fn own_runtime_inherited(home: &Home, args: &[OsString]) -> io::Result<i32> {
    let shim = config::read_shim(home).map_err(|e| io::Error::other(e.to_string()))?;
    let mut child = own_command(&shim, home, args).spawn()?;
    Ok(child.wait()?.code().unwrap_or(1))
}

/// `<node> <chLocal> start --stdio --own-runtime --home <home> <args>`: the
/// shim's home goes with it (it wins over COUNTINGHOUSE_HOME there), and
/// neither flag reaches the runtime itself.
fn own_command(shim: &config::ShimInfo, home: &Home, args: &[OsString]) -> Command {
    let mut c = Command::new(&shim.node);
    c.arg(&shim.ch_local).args(["start", "--stdio", "--own-runtime", "--home"]).arg(home.root()).args(args);
    c
}

/// The per-session runtime (section 5): `<node> <chLocal> start --stdio
/// --own-runtime <args>`, the held lines first, then the shim's stdin
/// pumped through; stdout and stderr inherited; the client's env as given.
pub fn own_runtime(
    home: &Home,
    args: &[OsString],
    held: Vec<Vec<u8>>,
    rest: impl Iterator<Item = Piece> + Send + 'static,
    replay: Option<(Vec<u8>, String)>,
    out: Out,
) -> io::Result<i32> {
    own_runtime_to(home, args, held, rest, replay, out)
}

/// How much of the per-session runtime's output is looked through for the
/// replayed initialize's answer before it is all passed on as it comes, and
/// the most of one line held while looking.
const REPLAY_LOOK_LINES: usize = 64;
const REPLAY_LOOK_BYTES: usize = 1 << 20;

/// One line of `r` to `out` under its lock, so whole lines never interleave
/// with the shim's own answers, streamed as it comes; `start` is the part
/// already read. Ok(false) at EOF.
fn relay_line<R: io::BufRead>(r: &mut R, out: &Out, start: &[u8]) -> io::Result<bool> {
    let mut held = out.lock();
    if !start.is_empty() {
        held.raw(start)?;
        if start.ends_with(b"\n") {
            return Ok(true);
        }
    }
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(false);
        }
        let (take, done) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len(), false),
        };
        held.raw(&buf[..take])?;
        r.consume(take);
        if done {
            return Ok(true);
        }
    }
}

/// The start of a line, at most `cap` bytes, and whether it is the whole line.
fn line_start<R: io::BufRead>(r: &mut R, cap: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut line = Vec::new();
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok((line, false));
        }
        let room = cap - line.len();
        let (take, done) = match buf.iter().take(room).position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buf.len().min(room), false),
        };
        line.extend_from_slice(&buf[..take]);
        r.consume(take);
        if done || line.len() >= cap {
            return Ok((line, done));
        }
    }
}

/// own_runtime, the runtime's output relayed through `out` when a replay's
/// answer must be dropped. With no replay the runtime writes the shim's
/// stdout itself, unread.
pub fn own_runtime_to(
    home: &Home,
    args: &[OsString],
    held: Vec<Vec<u8>>,
    rest: impl Iterator<Item = Piece> + Send + 'static,
    replay: Option<(Vec<u8>, String)>,
    out: Out,
) -> io::Result<i32> {
    let shim = config::read_shim(home).map_err(|e| io::Error::other(e.to_string()))?;
    let mut cmd = own_command(&shim, home, args);
    cmd.stdin(Stdio::piped());
    if replay.is_some() {
        cmd.stdout(Stdio::piped());
    }
    let mut child: Child = cmd.spawn()?;
    let mut stdin: ChildStdin = child.stdin.take().expect("piped");
    let first: Vec<Piece> = match &replay {
        Some((init, _)) => vec![Piece::Line(init.clone()), Piece::Line(INITIALIZED.to_vec())],
        None => Vec::new(),
    };
    thread::spawn(move || {
        for piece in first.into_iter().chain(held.into_iter().map(Piece::Line)).chain(rest) {
            let wrote = match piece {
                Piece::Line(l) => stdin.write_all(&l).and_then(|()| stdin.write_all(b"\n")),
                Piece::Raw(b) => stdin.write_all(&b),
            };
            if wrote.is_err() {
                return;
            }
        }
        // dropping stdin closes it: the client's EOF, passed on
    });
    let pumped = replay.map(|(_, id)| {
        let stdout = child.stdout.take().expect("piped");
        let (done_tx, done_rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            let mut r = io::BufReader::with_capacity(64 * 1024, stdout);
            // look for the replayed initialize's answer, which is dropped;
            // each line looked at is held only up to REPLAY_LOOK_BYTES
            for _ in 0..REPLAY_LOOK_LINES {
                let Ok((start, whole)) = line_start(&mut r, REPLAY_LOOK_BYTES) else { break };
                if start.is_empty() {
                    let _ = done_tx.send(());
                    return;
                }
                let is_it = whole
                    && serde_json::from_slice::<Value>(start.trim_ascii_end())
                        .ok()
                        .is_some_and(|v| v.get("id").and_then(Value::as_str) == Some(id.as_str()));
                if is_it {
                    break;
                }
                if !matches!(relay_line(&mut r, &out, &start), Ok(true)) {
                    let _ = done_tx.send(());
                    return;
                }
            }
            while let Ok(true) = relay_line(&mut r, &out, &[]) {}
            let _ = done_tx.send(());
        });
        done_rx
    });
    let code = child.wait()?.code().unwrap_or(1);
    // a process the runtime started may hold its stdout: waited for at most
    // PUMP_DRAIN, then the shim exits with the runtime's code regardless
    if let Some(done) = pumped {
        let _ = done.recv_timeout(PUMP_DRAIN);
    }
    Ok(code)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as B64;

    use super::*;
    use crate::{mac, secret};

    const BIG: Caps = Caps { message: 1 << 20 };

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
    impl Sink {
        fn lines(&self) -> Vec<String> {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap().lines().map(String::from).collect()
        }
    }

    fn private(path: &Path, body: &[u8]) {
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    /// A home with a daemon.json (our own pid), a secret, and a shim.json
    /// whose conditions child prints an ok line.
    fn home() -> (Home, std::path::PathBuf) {
        crate::unix_ffi::assume_swept();
        let mut b = [0u8; 6];
        getrandom::fill(&mut b).unwrap();
        let root = std::env::temp_dir()
            .join(format!("ch-shim-relay-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        let run = root.join("run").join("daemon");
        fs::create_dir_all(&run).unwrap();
        for d in [&root, &run] {
            fs::set_permissions(d, fs::Permissions::from_mode(0o700)).unwrap();
        }
        private(&run.join("secret"), format!("{}\n", "07".repeat(32)).as_bytes());
        let sock = run.join("s.sock");
        let d = serde_json::json!({"pid": std::process::id(), "socket": sock, "runtimeVersion": "8.0.0", "daemonVersion": "0.1.0", "started": "x"});
        private(&run.join("daemon.json"), d.to_string().as_bytes());
        let script = root.join("ch-local.sh");
        fs::write(&script, "echo '{\"status\":\"ok\",\"conditions\":\"no\",\"repo\":null,\"token\":null}'\n").unwrap();
        let shim = serde_json::json!({"node": "/bin/sh", "chLocal": script, "env": {"PATH": "/usr/bin:/bin"}});
        private(&root.join("shim.json"), shim.to_string().as_bytes());
        (Home::new(&root).unwrap(), sock)
    }

    /// The server side of the handshake, from the contract; the AUTH's resume.
    fn welcome(s: &mut UnixStream, token: &str) -> Option<String> {
        let sk = secret::parse(format!("{}\n", "07".repeat(32)).as_bytes()).unwrap();
        let (_, hello) = frame::read_frame(s, BIG).unwrap();
        let hello: Value = serde_json::from_slice(&hello).unwrap();
        let nc: [u8; 32] = B64.decode(hello["nc"].as_str().unwrap()).unwrap().try_into().unwrap();
        let ns = [9u8; 32];
        let prove =
            format!("{{\"ns\":\"{}\",\"ms\":\"{}\"}}", B64.encode(ns), B64.encode(mac::server_proof(&sk, 1, &nc, &ns)));
        frame::write_frame(s, Kind::Prove, prove.as_bytes(), BIG).unwrap();
        let (_, auth) = frame::read_frame(s, BIG).unwrap();
        let auth: Value = serde_json::from_slice(&auth).unwrap();
        let w = format!(
            r#"{{"session":"s","resumeToken":"{token}","runtimeVersion":"8.0.0","maxToRuntime":65536,"maxToShim":65536}}"#
        );
        frame::write_frame(s, Kind::Welcome, w.as_bytes(), BIG).unwrap();
        auth.get("resume").and_then(Value::as_str).map(String::from)
    }

    /// Reads frames until a control frame with this op; the M lines seen.
    fn until_op(s: &mut UnixStream, op: &str) -> Vec<(Option<u64>, Vec<u8>)> {
        let mut ms = Vec::new();
        loop {
            let (kind, len) = frame::read_head(s, BIG).unwrap();
            let mut p = vec![0u8; len as usize];
            s.read_exact(&mut p).unwrap();
            match kind {
                Kind::Control => {
                    let v: Value = serde_json::from_slice(&p).unwrap();
                    if v["op"] == op {
                        return ms;
                    }
                }
                Kind::Message => {
                    let (seq, body) = message::from_runtime(&p).unwrap();
                    ms.push((seq, body.to_vec()));
                }
                _ => panic!("{kind:?}"),
            }
        }
    }

    fn read_m(s: &mut UnixStream) -> (Option<u64>, Vec<u8>) {
        let (kind, len) = frame::read_head(s, BIG).unwrap();
        let mut p = vec![0u8; len as usize];
        s.read_exact(&mut p).unwrap();
        assert_eq!(kind, Kind::Message);
        let (seq, body) = message::from_runtime(&p).unwrap();
        (seq, body.to_vec())
    }

    fn reply(s: &mut UnixStream, seq: u64, line: &str) {
        let p = message::to_runtime(Some(seq), line.as_bytes(), 1 << 20).unwrap();
        frame::write_frame(s, Kind::Message, &p, BIG).unwrap();
    }

    fn settled(s: &mut UnixStream) {
        frame::write_frame(s, Kind::Control, br#"{"op":"settled"}"#, BIG).unwrap();
    }

    use std::io::Read;

    #[test]
    fn lines_before_settled_are_held_then_forwarded_in_order_and_answers_come_back_byte_exact() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, input) = UnixStream::pair().unwrap();
        let sink = Sink::default();
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing: Timing::default() },
            Out::new(Box::new(sink.clone())),
        );
        let done = thread::spawn(move || relay.run(input));
        client_in
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"n\"}\n")
            .unwrap();
        let (mut s, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s, "rt1"), None);
        // the first client frame, carrying the child's line
        assert!(until_op(&mut s, "client").is_empty(), "nothing forwarded before settled");
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"b\",\"method\":\"b\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        settled(&mut s);
        let got: Vec<_> = (0..3).map(|_| read_m(&mut s)).collect();
        assert_eq!(got[0], (Some(1), br#"{"jsonrpc":"2.0","id":1,"method":"a"}"#.to_vec()));
        assert_eq!(got[1], (None, br#"{"jsonrpc":"2.0","method":"n"}"#.to_vec()));
        assert_eq!(got[2], (Some(2), br#"{"jsonrpc":"2.0","id":"b","method":"b"}"#.to_vec()));
        reply(&mut s, 2, r#"{"jsonrpc":"2.0","id":"b","result":{}}"#);
        reply(&mut s, 1, r#"{"jsonrpc":"2.0","id":1,"result":{"x":"é"}}"#);
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        assert!(matches!(done.join().unwrap(), Exit::Done));
        assert_eq!(
            sink.lines(),
            [r#"{"jsonrpc":"2.0","id":"b","result":{}}"#, r#"{"jsonrpc":"2.0","id":1,"result":{"x":"é"}}"#]
        );
    }

    #[test]
    fn a_lost_connection_crash_answers_what_was_unanswered_and_the_shim_resumes() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, input) = UnixStream::pair().unwrap();
        let sink = Sink::default();
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing: Timing::default() },
            Out::new(Box::new(sink.clone())),
        );
        let done = thread::spawn(move || relay.run(input));
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"a\"}\n{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"b\"}\n",
            )
            .unwrap();
        let (seq7, _) = read_m(&mut s);
        read_m(&mut s);
        reply(&mut s, seq7.unwrap(), r#"{"jsonrpc":"2.0","id":7,"result":{}}"#);
        thread::sleep(Duration::from_millis(100));
        drop(s); // a crash, no drain
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s2, "rt2").as_deref(), Some("rt1"), "resumed with the last token");
        until_op(&mut s2, "client");
        settled(&mut s2);
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        assert!(matches!(done.join().unwrap(), Exit::Done));
        let lines = sink.lines();
        assert_eq!(lines[0], r#"{"jsonrpc":"2.0","id":7,"result":{}}"#);
        assert_eq!(lines.len(), 2, "{lines:?}");
        let crash: Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(
            (crash["id"].as_u64(), crash["error"]["data"]["mayHaveRun"].as_bool()),
            (Some(8), Some(true)),
            "only 8 was unanswered"
        );
    }

    fn start(home: Home) -> (UnixStream, Sink, thread::JoinHandle<Exit>) {
        let (client_in, input) = UnixStream::pair().unwrap();
        let sink = Sink::default();
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing: Timing::default() },
            Out::new(Box::new(sink.clone())),
        );
        (client_in, sink, thread::spawn(move || relay.run(input)))
    }

    fn control_payload(s: &mut UnixStream) -> Value {
        loop {
            let (kind, len) = frame::read_head(s, BIG).unwrap();
            let mut p = vec![0u8; len as usize];
            s.read_exact(&mut p).unwrap();
            if kind == Kind::Control {
                return serde_json::from_slice(&p).unwrap();
            }
        }
    }

    #[test]
    fn conditions_asked_is_answered_with_its_seq() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        assert_eq!(control_payload(&mut s)["status"], "ok", "the first client frame");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"conditions?","seq":5}"#, BIG).unwrap();
        let c = control_payload(&mut s);
        assert_eq!(
            (c["op"].as_str(), c["seq"].as_u64(), c["conditions"].as_str()),
            (Some("client"), Some(5), Some("no"))
        );
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    #[test]
    fn own_runtime_before_settled_hands_over_the_held_lines_and_the_rest() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"own-runtime","reason":"token"}"#, BIG).unwrap();
        let exit = done.join().unwrap();
        let Exit::OwnRuntime { reason, held, rest, replay } = exit else { panic!("not handed over") };
        assert_eq!(replay, None, "the runtime's own-runtime op replays nothing");
        assert_eq!(reason, "ch-shim: this session can't share the runtime (token); it runs its own");
        assert_eq!(held, vec![br#"{"jsonrpc":"2.0","id":1,"method":"a"}"#.to_vec()]);
        client_in.write_all(b"{\"later\":1}\n").unwrap();
        drop(client_in);
        let bytes: Vec<u8> = rest
            .flat_map(|p| match p {
                Piece::Line(mut l) => {
                    l.push(b'\n');
                    l
                }
                Piece::Raw(b) => b,
            })
            .collect();
        assert_eq!(bytes, b"{\"later\":1}\n".to_vec(), "bytes after the hand-over reach it too, as they came");
    }

    #[test]
    fn a_drain_holds_new_requests_and_forwards_them_after_the_reconnect_with_no_crash_answer() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"drain"}"#, BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        welcome(&mut s2, "rt2");
        until_op(&mut s2, "client");
        settled(&mut s2);
        let (seq, body) = read_m(&mut s2);
        assert_eq!((seq, body), (Some(1), br#"{"jsonrpc":"2.0","id":3,"method":"a"}"#.to_vec()));
        reply(&mut s2, 1, r#"{"jsonrpc":"2.0","id":3,"result":{}}"#);
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
        assert_eq!(sink.lines(), [r#"{"jsonrpc":"2.0","id":3,"result":{}}"#], "no crash answer during a drain");
    }

    #[test]
    fn a_legacy_session_replays_initialize_after_a_reconnect_and_drops_its_answer() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{}}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":0,"result":{"v":1}}"#);
        thread::sleep(Duration::from_millis(100));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        welcome(&mut s2, "rt2");
        until_op(&mut s2, "client");
        settled(&mut s2);
        let (rseq, replay) = read_m(&mut s2);
        let replay: Value = serde_json::from_slice(&replay).unwrap();
        assert_eq!((replay["id"].as_str(), replay["method"].as_str()), (Some("ch-shim-replay-1"), Some("initialize")));
        let (nseq, initialized) = read_m(&mut s2);
        assert_eq!((nseq, initialized), (None, br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec()));
        reply(&mut s2, rseq.unwrap(), r#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","result":{"v":1}}"#);
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
        assert_eq!(
            sink.lines(),
            [
                r#"{"jsonrpc":"2.0","id":0,"result":{"v":1}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#
            ],
            "the replay's answer is dropped; the client hears list_changed"
        );
    }

    /// AUTH answered with REFUSED RESUME_REFUSED, after a proven PROVE.
    fn refuse_resume(s: &mut UnixStream) -> Option<String> {
        let sk = secret::parse(format!("{}\n", "07".repeat(32)).as_bytes()).unwrap();
        let (_, hello) = frame::read_frame(s, BIG).unwrap();
        let hello: Value = serde_json::from_slice(&hello).unwrap();
        let nc: [u8; 32] = B64.decode(hello["nc"].as_str().unwrap()).unwrap().try_into().unwrap();
        let ns = [9u8; 32];
        let prove =
            format!("{{\"ns\":\"{}\",\"ms\":\"{}\"}}", B64.encode(ns), B64.encode(mac::server_proof(&sk, 1, &nc, &ns)));
        frame::write_frame(s, Kind::Prove, prove.as_bytes(), BIG).unwrap();
        let (_, auth) = frame::read_frame(s, BIG).unwrap();
        let auth: Value = serde_json::from_slice(&auth).unwrap();
        frame::write_frame(s, Kind::Refused, br#"{"code":"RESUME_REFUSED","message":"m"}"#, BIG).unwrap();
        auth.get("resume").and_then(Value::as_str).map(String::from)
    }

    #[test]
    fn a_refused_resume_opens_a_new_session_whose_first_frame_replays_the_records() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(
            &mut s,
            Kind::Control,
            br#"{"op":"record","entry":{"kind":"value","name":"maxOutputBytes","value":1048576}}"#,
            BIG,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(refuse_resume(&mut s2).as_deref(), Some("rt1"));
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s3, "rt3"), None, "a new session: no resume");
        let first = control_payload(&mut s3);
        assert_eq!(first["op"], "replay");
        assert_eq!(
            first["entries"],
            serde_json::json!([{"kind": "value", "name": "maxOutputBytes", "value": 1048576}])
        );
        assert_eq!(control_payload(&mut s3)["op"], "client", "then the client frame");
        settled(&mut s3);
        drop(client_in);
        until_op(&mut s3, "bye");
        drop(s3);
        done.join().unwrap();
    }

    #[test]
    fn unreachable_answers_each_request_then_a_background_retry_attaches() {
        let (home, sock) = home();
        // no socket yet; the stand-in daemon (the conditions script) starts
        // nothing, so the attach gives up at its (short) budget
        let (client_in, input) = UnixStream::pair().unwrap();
        let sink = Sink::default();
        let timing = Timing {
            attach: Duration::from_millis(400),
            retry_unit: Duration::from_millis(100),
            closing: CLOSING_GRACE,
            settle: SETTLE_DEADLINE,
            barrier: STDOUT_BARRIER,
        };
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing },
            Out::new(Box::new(sink.clone())),
        );
        let mut client_in = client_in;
        let done = thread::spawn(move || relay.run(input));
        thread::sleep(Duration::from_millis(700));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        let answered: Value = serde_json::from_str(&sink.lines()[0]).unwrap();
        assert_eq!((answered["id"].as_u64(), answered["error"]["code"].as_i64()), (Some(1), Some(-32603)));
        assert!(
            answered["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("countinghouse could not reach its shared runtime (")
        );
        // the runtime appears; the retry (500 ms on) attaches
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"b\"}\n").unwrap();
        let (seq, body) = read_m(&mut s);
        assert_eq!((seq, body), (Some(1), br#"{"jsonrpc":"2.0","id":2,"method":"b"}"#.to_vec()));
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    fn start_with(home: Home, timing: Timing) -> (UnixStream, Sink, thread::JoinHandle<Exit>) {
        let (client_in, input) = UnixStream::pair().unwrap();
        let sink = Sink::default();
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing },
            Out::new(Box::new(sink.clone())),
        );
        (client_in, sink, thread::spawn(move || relay.run(input)))
    }

    #[test]
    fn eof_with_a_line_held_before_settled_says_it_did_not_run() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
        let a: Value = serde_json::from_str(&sink.lines()[0]).unwrap();
        assert_eq!((a["id"].as_u64(), a["error"]["data"]["mayHaveRun"].as_bool()), (Some(4), Some(false)));
    }

    #[test]
    fn own_runtime_while_live_crash_answers_what_was_in_flight_and_writes_no_late_answer() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"a\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"own-runtime","reason":"token"}"#, BIG).unwrap();
        assert!(matches!(done.join().unwrap(), Exit::OwnRuntime { .. }));
        // the runtime answers late, on the old connection, which the shim
        // has shut down (the write may fail): never written to the client
        let late = message::to_runtime(seq, br#"{"jsonrpc":"2.0","id":3,"result":{}}"#, 1 << 20).unwrap();
        let _ = frame::write_frame(&mut s, Kind::Message, &late, BIG);
        thread::sleep(Duration::from_millis(200));
        let lines = sink.lines();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let a: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!((a["id"].as_u64(), a["error"]["data"]["mayHaveRun"].as_bool()), (Some(3), Some(true)));
        drop(client_in);
    }

    #[test]
    fn a_held_line_larger_than_the_welcome_allows_is_answered_with_its_id_and_never_forwarded() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        // before WELCOME, under the default 8 MiB bound
        let big = format!("{{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"a\",\"params\":\"{}\"}}\n", "x".repeat(70_000));
        client_in.write_all(big.as_bytes()).unwrap();
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1"); // maxToRuntime 65536
        until_op(&mut s, "client");
        settled(&mut s);
        // request 9's answer is written while settled is handled: once it is
        // there, the session is Live, and request 10 isn't held behind the
        // big line (held, the two would be over WELCOME's byte bound, and 10
        // would be refused, correctly, as never sent)
        for _ in 0..200 {
            if !sink.lines().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"b\"}\n").unwrap();
        let (seq, body) = read_m(&mut s);
        assert_eq!(body, br#"{"jsonrpc":"2.0","id":10,"method":"b"}"#.to_vec(), "the big line was never sent");
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":10,"result":{}}"#);
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
        let lines = sink.lines();
        let a: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!((a["id"].as_u64(), a["error"]["code"].as_i64()), (Some(9), Some(-32600)));
        assert_eq!(lines.len(), 2, "one answer each, no crash answer for 9: {lines:?}");
    }

    #[test]
    fn after_the_closing_grace_a_crash_answer_is_final_and_a_late_reply_is_discarded() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { closing: Duration::from_millis(200), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"a\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        drop(client_in);
        until_op(&mut s, "bye");
        assert!(matches!(done.join().unwrap(), Exit::Done), "ended at the grace");
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":5,"result":{}}"#);
        thread::sleep(Duration::from_millis(200));
        let lines = sink.lines();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("RUNTIME_RESTARTED"));
    }

    // The ordering CI hit: the line too large for this connection arrives
    // after WELCOME, while unsettled. It is refused as too large (-32600,
    // its own id), never held and answered as a held line that "did not run".
    #[test]
    fn a_line_too_large_for_the_connection_arriving_unsettled_is_refused_as_too_large() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1"); // maxToRuntime 65536
        until_op(&mut s, "client");
        let big = format!("{{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"a\",\"params\":\"{}\"}}\n", "x".repeat(70_000));
        client_in.write_all(big.as_bytes()).unwrap();
        for _ in 0..200 {
            if !sink.lines().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let a: Value = serde_json::from_str(&sink.lines()[0]).unwrap();
        assert_eq!((a["id"].as_u64(), a["error"]["code"].as_i64()), (Some(9), Some(-32600)), "{a}");
        settled(&mut s);
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    /// An M frame's head and header for `seq`, with a body of `len` bytes to
    /// follow, written by the test in pieces.
    fn m_head(seq: u64, len: usize) -> Vec<u8> {
        let header = format!("{{\"seq\":{seq}}}");
        let payload = 2 + header.len() + len;
        let mut out = vec![b'M'];
        out.extend_from_slice(&(payload as u32).to_be_bytes());
        out.extend_from_slice(&(header.len() as u16).to_be_bytes());
        out.extend_from_slice(header.as_bytes());
        out
    }

    #[test]
    fn a_body_cut_mid_answer_ends_its_line_and_the_request_gets_its_crash_answer() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"a\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        let body = br#"{"jsonrpc":"2.0","id":6,"result":{"text":"a long answer"}}"#;
        s.write_all(&m_head(seq.unwrap(), body.len())).unwrap();
        s.write_all(&body[..20]).unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(s); // the connection dies mid-answer
        let (mut s2, _) = listener.accept().unwrap();
        welcome(&mut s2, "rt2");
        until_op(&mut s2, "client");
        settled(&mut s2);
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
        let lines = sink.lines();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0].as_bytes(), &body[..20], "the half line, ended");
        let crash: Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(
            (crash["id"].as_u64(), crash["error"]["data"]["countinghouse/code"].as_str()),
            (Some(6), Some("RUNTIME_RESTARTED"))
        );
    }

    #[test]
    fn an_answer_still_streaming_at_the_closing_grace_is_written_whole_with_no_crash_answer() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { closing: Duration::from_millis(200), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"a\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        let body = br#"{"jsonrpc":"2.0","id":7,"result":{"text":"streamed slowly"}}"#;
        s.write_all(&m_head(seq.unwrap(), body.len())).unwrap();
        s.write_all(&body[..10]).unwrap();
        drop(client_in); // EOF: bye, and the 200 ms grace starts
        thread::sleep(Duration::from_millis(600)); // the grace runs out mid-stream
        s.write_all(&body[10..]).unwrap();
        done.join().unwrap();
        assert_eq!(sink.lines(), [String::from_utf8(body.to_vec()).unwrap()], "whole, and no crash answer after it");
    }

    #[test]
    fn a_runtime_that_closes_right_after_welcome_is_attached_to_with_backoff_not_a_storm() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { retry_unit: Duration::from_millis(100), ..Timing::default() };
        let (client_in, _sink, done) = start_with(home, timing);
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let accepted = accepted.clone();
            thread::spawn(move || {
                for c in listener.incoming() {
                    let Ok(mut s) = c else { return };
                    accepted.fetch_add(1, Ordering::SeqCst);
                    welcome(&mut s, "rt");
                    drop(s); // closed at once
                }
            });
        }
        thread::sleep(Duration::from_millis(1500));
        let n = accepted.load(Ordering::SeqCst);
        // backoff 200, 400, 800 ms: about 4 attaches in 1.5 s; without it, dozens
        assert!((2..=5).contains(&n), "{n} attaches in 1.5 s");
        drop(client_in);
        let _ = done;
    }

    #[test]
    fn a_runtime_that_never_settles_is_left_at_the_deadline_and_attached_to_again() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { settle: Duration::from_millis(300), ..Timing::default() };
        let (client_in, _sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        // no settled; after the deadline the shim leaves this connection
        let mut rest = Vec::new();
        let _ = s.read_to_end(&mut rest);
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s2, "rt2").as_deref(), Some("rt1"), "attached again, resuming");
        until_op(&mut s2, "client");
        settled(&mut s2);
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
    }

    #[test]
    fn a_records_entry_is_replayed_byte_for_byte() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        // spacing and key order a re-serialization would change
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"record","entry":{ "z": 1,  "a" : [ 1.0, 2e0 ] }}"#, BIG)
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        refuse_resume(&mut s2);
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        welcome(&mut s3, "rt3");
        let (kind, len) = frame::read_head(&mut s3, BIG).unwrap();
        let mut p = vec![0u8; len as usize];
        s3.read_exact(&mut p).unwrap();
        assert_eq!(kind, Kind::Control);
        assert_eq!(String::from_utf8(p).unwrap(), r#"{"op":"replay","entries":[{ "z": 1,  "a" : [ 1.0, 2e0 ] }]}"#);
        until_op(&mut s3, "client");
        settled(&mut s3);
        drop(client_in);
        until_op(&mut s3, "bye");
        drop(s3);
        done.join().unwrap();
    }

    #[test]
    fn the_per_session_runtime_is_started_with_this_home() {
        let (home, _sock) = home();
        let root = home.root().to_path_buf();
        let seen = root.join("args.txt");
        fs::write(root.join("ch-local.sh"), format!("printf '%s\\n' \"$@\" > '{}'\n", seen.display())).unwrap();
        assert_eq!(own_runtime_inherited(&home, &["--flag".into()]).unwrap(), 0);
        let args = fs::read_to_string(&seen).unwrap();
        let want = format!("start\n--stdio\n--own-runtime\n--home\n{}\n--flag\n", root.display());
        assert_eq!(args, want);
    }

    #[test]
    fn a_stalled_stream_at_exit_is_cut_and_every_request_still_gets_an_answer() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing =
            Timing { closing: Duration::from_millis(200), barrier: Duration::from_millis(200), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n").unwrap();
        let (seq_a, _) = read_m(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"b\"}\n").unwrap();
        let _ = read_m(&mut s);
        let body = br#"{"jsonrpc":"2.0","id":1,"result":{"text":"never finished"}}"#;
        s.write_all(&m_head(seq_a.unwrap(), body.len())).unwrap();
        s.write_all(&body[..12]).unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(client_in); // EOF; A's stream stalls past the grace and the barrier
        done.join().unwrap();
        let lines = sink.lines();
        let ids: Vec<Option<u64>> =
            lines[1..].iter().map(|l| serde_json::from_str::<Value>(l).ok().and_then(|v| v["id"].as_u64())).collect();
        assert_eq!(lines[0].as_bytes(), &body[..12], "{lines:?}");
        assert_eq!(ids, [Some(1), Some(2)], "A's crash answer after its cut line, then B's: {lines:?}");
        drop(s);
    }

    #[test]
    fn eof_while_an_answer_streams_waits_the_closing_grace_not_just_the_barrier() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing =
            Timing { closing: Duration::from_secs(3), barrier: Duration::from_millis(200), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"a\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        let body = br#"{"jsonrpc":"2.0","id":8,"result":{"text":"slow but in the grace"}}"#;
        s.write_all(&m_head(seq.unwrap(), body.len())).unwrap();
        s.write_all(&body[..10]).unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        thread::sleep(Duration::from_millis(700)); // past the barrier, inside the grace
        assert!(!done.is_finished(), "the shim ended while an answer was streaming, inside the closing grace");
        let _ = s.write_all(&body[10..]);
        done.join().unwrap();
        assert_eq!(sink.lines(), [String::from_utf8(body.to_vec()).unwrap()]);
    }

    #[test]
    fn a_line_too_long_to_send_is_answered_unless_it_is_a_notification() {
        let refuse = |l: &[u8]| Relay::too_long_refusal(l, &message::classify(l));
        assert_eq!(refuse(br#"{"jsonrpc":"2.0","method":"notifications/x"}"#), Refusal::Nothing);
        assert_eq!(refuse(br#"{"jsonrpc":"2.0","id":4,"result":{}}"#), Refusal::Nothing, "a response");
        assert_eq!(refuse(br#"[{"jsonrpc":"2.0","method":"n"}]"#), Refusal::Nothing, "a batch of notifications");
        assert_eq!(refuse(br#"{"jsonrpc":"2.0","id":4,"method":"m"}"#), Refusal::Ids(vec![b"4".to_vec()], false));
        assert_eq!(refuse(b"{not json"), Refusal::Null, "unparseable: the null-id answer");
    }

    #[test]
    fn a_runtime_that_never_settles_twice_is_unreachable_and_the_held_request_is_answered() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing =
            Timing { settle: Duration::from_millis(300), retry_unit: Duration::from_millis(50), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home, timing);
        thread::spawn(move || {
            for c in listener.incoming() {
                let Ok(mut s) = c else { return };
                thread::spawn(move || {
                    welcome(&mut s, "rt");
                    // never settled; held until the shim leaves
                    let mut rest = Vec::new();
                    let _ = s.read_to_end(&mut rest);
                });
            }
        });
        thread::sleep(Duration::from_millis(100));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"a\"}\n").unwrap();
        let mut answered = None;
        for _ in 0..300 {
            if let Some(l) = sink.lines().first() {
                answered = Some(l.clone());
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let a: Value = serde_json::from_str(&answered.expect("the held request was never answered")).unwrap();
        assert_eq!(a["id"].as_u64(), Some(7), "{a}");
        assert!(a["error"].is_object(), "{a}");
        drop(client_in);
        let _ = done;
    }

    // --- failed.json (#236 section 6) ---

    fn write_failed(home: &Home, reason: &str) {
        let at = crate::failed::now_ms();
        let body = format!("{{\"v\":1,\"at\":{at},\"exit\":1,\"signal\":null,\"reason\":\"{reason}\"}}");
        private(&home.run_dir().join("failed.json"), body.as_bytes());
    }

    /// ch-local.sh as a spawn recorder: `daemon` touches <root>/spawned.
    fn record_spawns(home: &Home) -> std::path::PathBuf {
        let marker = home.root().join("spawned");
        let script = format!(
            "[ \"$1\" = daemon ] && touch '{}'\necho '{{\"status\":\"ok\",\"conditions\":\"no\",\"repo\":null,\"token\":null}}'\n",
            marker.display()
        );
        fs::write(home.root().join("ch-local.sh"), script).unwrap();
        marker
    }

    #[test]
    fn a_fresh_failed_json_stops_the_attach_and_no_daemon_is_started() {
        let (home, _sock) = home(); // daemon.json names a socket nothing listens on
        let marker = record_spawns(&home);
        write_failed(&home, "restarts-exhausted");
        let r = attach::attach_within(&home, None, Instant::now() + Duration::from_secs(2));
        assert!(
            matches!(r, Err(AttachError::SharedFailed(crate::failed::Reason::RestartsExhausted))),
            "{:?}",
            r.err().map(|e| e.to_string())
        );
        assert!(!marker.exists(), "a daemon was started behind one that gave up");
    }

    #[test]
    fn under_the_start_lock_a_fresh_failed_json_starts_no_daemon() {
        let (home, _sock) = home();
        let marker = record_spawns(&home);
        fs::remove_file(home.run_dir().join("daemon.json")).unwrap();
        write_failed(&home, "never-listened");
        let r = crate::daemon::ensure_started(&home, Instant::now() + Duration::from_secs(2));
        assert!(
            matches!(r, Err(crate::daemon::StartError::Failed(crate::failed::Reason::NeverListened))),
            "{:?}",
            r.err().map(|e| e.to_string())
        );
        assert!(!marker.exists());
    }

    #[test]
    fn at_startup_a_live_daemon_wins_over_failed_json_and_none_means_falling_back() {
        let (home, _sock) = home(); // daemon.json: this process's pid, alive
        write_failed(&home, "restarts-exhausted");
        assert_eq!(attach::startup_fallback(&home), None, "a live daemon is attached to as always");
        fs::remove_file(home.run_dir().join("daemon.json")).unwrap();
        assert_eq!(attach::startup_fallback(&home), Some(crate::failed::Reason::RestartsExhausted));
        // a stale file is ignored
        let stale = crate::failed::now_ms() - 600_001;
        private(
            &home.run_dir().join("failed.json"),
            format!("{{\"v\":1,\"at\":{stale},\"exit\":1,\"signal\":null,\"reason\":\"restarts-exhausted\"}}")
                .as_bytes(),
        );
        assert_eq!(attach::startup_fallback(&home), None);
    }

    #[test]
    fn a_session_holding_a_record_refuses_the_fallback_with_the_exact_answer_and_exits_non_zero() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        // a quick loss backs the reattach off by doubling retry units: kept short
        let timing = Timing { retry_unit: Duration::from_millis(50), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home.clone(), timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"record","entry":{"tighten":"x"}}"#, BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        write_failed(&home, "restarts-exhausted");
        drop(listener); // the socket file stays; nothing answers it
        drop(s); // the daemon is gone
        thread::sleep(Duration::from_millis(300));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/list\"}\n").unwrap();
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}\n").unwrap();
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"s\",\"method\":\"tools/call\"}\n").unwrap();
        thread::sleep(Duration::from_millis(200));
        drop(client_in);
        let exit = done.join().unwrap();
        assert!(matches!(exit, Exit::Refused), "the shim must exit non-zero");
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let want = v["sessionCantFallBackAnswer"]["json"].as_str().unwrap();
        let lines = sink.lines();
        assert_eq!(
            lines,
            [want.replace("\"id\":7", "\"id\":9"), want.replace("\"id\":7", "\"id\":\"s\"")],
            "exact apart from the id; a notification gets nothing"
        );
    }

    #[test]
    fn a_live_session_with_no_record_hands_over_replaying_its_initialize() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { retry_unit: Duration::from_millis(50), ..Timing::default() };
        let (mut client_in, _sink, done) = start_with(home.clone(), timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        let init = br#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#;
        client_in.write_all(init).unwrap();
        client_in.write_all(b"\n").unwrap();
        let (seq, _) = read_m(&mut s);
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":0,"result":{}}"#);
        thread::sleep(Duration::from_millis(100));
        write_failed(&home, "never-listened");
        drop(listener);
        drop(s);
        let exit = done.join().unwrap();
        let Exit::OwnRuntime { reason, replay, .. } = exit else { panic!("not handed over") };
        assert_eq!(reason, crate::failed::startup_line(crate::failed::Reason::NeverListened));
        let (line, id) = replay.expect("the recorded initialize is replayed");
        assert_eq!(id, "ch-shim-replay-1", "under the shim's own replay id");
        let mut want: Value = serde_json::from_slice(init).unwrap();
        want["id"] = Value::String(id);
        assert_eq!(serde_json::from_slice::<Value>(&line).unwrap(), want);
        drop(client_in);
    }

    fn node() -> Option<std::path::PathBuf> {
        std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("node")).find(|n| n.is_file()))
    }

    #[test]
    fn the_replayed_initializes_answer_is_dropped_and_the_rest_passes() {
        let Some(node) = node() else { return eprintln!("no node on PATH: skipped") };
        let (home, _sock) = home();
        // a per-session runtime that answers every request by id, in order
        let echo = home.root().join("echo.js");
        fs::write(&echo, "require('readline').createInterface({input: process.stdin}).on('line', (l) => { const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: m.id, result: {method: m.method}}) + '\\n'); });\n").unwrap();
        let shim = serde_json::json!({"node": node, "chLocal": echo, "env": {"PATH": "/usr/bin:/bin"}});
        private(&home.root().join("shim.json"), shim.to_string().as_bytes());
        let sink = Sink::default();
        let init = br#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","method":"initialize","params":{}}"#.to_vec();
        let held = vec![br#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#.to_vec()];
        let out = Out::new(Box::new(sink.clone()));
        let code =
            own_runtime_to(&home, &[], held, std::iter::empty(), Some((init, "ch-shim-replay-1".into())), out).unwrap();
        assert_eq!(code, 0);
        assert_eq!(
            sink.lines(),
            [r#"{"jsonrpc":"2.0","id":5,"result":{"method":"tools/list"}}"#],
            "only the client's own answer"
        );
    }

    #[test]
    fn a_null_socket_in_daemon_json_is_waited_for_not_a_stop() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let d = home.run_dir().join("daemon.json");
        let good = fs::read(&d).unwrap();
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["socket"] = Value::Null; // a runtime ended, its successor not yet listening
        private(&d, v.to_string().as_bytes());
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            welcome(&mut s, "rt1");
            s
        });
        let back = d.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            private(&back, &good);
        });
        let r = attach::attach_within(&home, None, Instant::now() + Duration::from_secs(5));
        assert!(r.is_ok(), "{:?}", r.err().map(|e| e.to_string()));
        let _ = server.join();
    }

    #[test]
    fn after_a_loss_the_shim_follows_daemon_json_to_a_restarted_runtimes_new_socket() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home.clone());
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        // the daemon restarts its runtime on a new socket name
        let sock2 = home.run_dir().join("s2.sock");
        let listener2 = UnixListener::bind(&sock2).unwrap();
        let d = home.run_dir().join("daemon.json");
        let mut v: Value = serde_json::from_slice(&fs::read(&d).unwrap()).unwrap();
        v["socket"] = Value::String(sock2.to_string_lossy().into_owned());
        private(&d, v.to_string().as_bytes());
        drop(listener);
        let _ = fs::remove_file(&sock);
        drop(s);
        let (mut s2, _) = listener2.accept().unwrap();
        assert_eq!(welcome(&mut s2, "rt2").as_deref(), Some("rt1"), "reattached to the new socket, resuming");
        until_op(&mut s2, "client");
        settled(&mut s2);
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
    }

    /// A per-session runtime script for own_runtime_to: `body` is JS run per
    /// stdin line `m` (parsed), after which it answers requests by id.
    fn echo_runtime(home: &Home, before: &str) -> bool {
        let Some(node) = node() else { return false };
        let echo = home.root().join("echo.js");
        fs::write(&echo, format!("{before}\nrequire('readline').createInterface({{input: process.stdin}}).on('line', (l) => {{ const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify({{jsonrpc: '2.0', id: m.id, result: {{method: m.method}}}}) + '\\n'); }});\n")).unwrap();
        let shim = serde_json::json!({"node": node, "chLocal": echo, "env": {"PATH": "/usr/bin:/bin"}});
        private(&home.root().join("shim.json"), shim.to_string().as_bytes());
        true
    }

    #[test]
    fn a_grandchild_holding_the_runtimes_stdout_doesnt_hold_the_shim() {
        let (home, _sock) = home();
        // the runtime starts a process that inherits its stdout and outlives
        // the test by far (120 s), and writes its pid so the test ends it
        let pid_file = home.root().join("grandchild.pid");
        let pid_path = serde_json::to_string(&pid_file.to_string_lossy()).unwrap();
        let _grandchild = KillOnDrop(pid_file.clone());
        if !echo_runtime(
            &home,
            &format!(
                "const g = require('child_process').spawn('sleep', ['120'], {{stdio: ['ignore', 'inherit', 'ignore'], detached: true}}); require('fs').writeFileSync({pid_path}, String(g.pid)); g.unref(); setTimeout(() => process.exit(0), 300);"
            ),
        ) {
            return eprintln!("no node on PATH: skipped");
        }
        let sink = Sink::default();
        let init = br#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","method":"initialize"}"#.to_vec();
        let started = Instant::now();
        let code = own_runtime_to(
            &home,
            &[],
            vec![],
            std::iter::empty(),
            Some((init, "ch-shim-replay-1".into())),
            Out::new(Box::new(sink.clone())),
        )
        .unwrap();
        assert_eq!(code, 0);
        // the shim leaves within PUMP_DRAIN of the runtime's exit, so long
        // before the grandchild's 120 s; the bound leaves node's start-up on
        // a loaded runner (seen at ~3.7 s on the musl leg) out of the question
        assert!(started.elapsed() < Duration::from_secs(60), "held for {:?}", started.elapsed());
        assert!(pid_file.exists(), "the grandchild was started");
    }

    // ends the process whose pid is in the file, when the test ends (a
    // panic included), so no grandchild outlives its test
    struct KillOnDrop(std::path::PathBuf);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            if let Ok(pid) = fs::read_to_string(&self.0) {
                if let Ok(pid) = pid.trim().parse::<u32>() {
                    let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
                }
            }
        }
    }

    #[test]
    fn a_huge_line_ahead_of_the_replayed_answer_passes_whole_and_the_answer_is_still_dropped() {
        let (home, _sock) = home();
        // a 3 MiB notification first, then the answers
        if !echo_runtime(
            &home,
            "process.stdout.write(JSON.stringify({jsonrpc: '2.0', method: 'big', params: {x: 'y'.repeat(3 << 20)}}) + '\\n');",
        ) {
            return eprintln!("no node on PATH: skipped");
        }
        let sink = Sink::default();
        let init = br#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","method":"initialize"}"#.to_vec();
        let held = vec![br#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#.to_vec()];
        own_runtime_to(
            &home,
            &[],
            held,
            std::iter::empty(),
            Some((init, "ch-shim-replay-1".into())),
            Out::new(Box::new(sink.clone())),
        )
        .unwrap();
        let lines = sink.lines();
        assert_eq!(lines.len(), 2, "{} lines", lines.len());
        let big: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(big["params"]["x"].as_str().map(str::len), Some(3 << 20), "the big line, whole");
        assert_eq!(lines[1], r#"{"jsonrpc":"2.0","id":5,"result":{"method":"tools/list"}}"#);
    }

    #[test]
    fn a_refused_sessions_line_too_long_to_read_gets_the_refusal_with_a_null_id() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { retry_unit: Duration::from_millis(50), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home.clone(), timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1"); // maxToRuntime 65536: lines over 61440 are unread
        until_op(&mut s, "client");
        settled(&mut s);
        // a line's bound is fixed when its read begins: one line now, so the
        // next read starts under the welcomed bound
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}\n").unwrap();
        let _ = read_m(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"record","entry":{"tighten":"x"}}"#, BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        write_failed(&home, "restarts-exhausted");
        drop(listener);
        drop(s);
        thread::sleep(Duration::from_millis(300));
        let big = format!("{{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"a\",\"params\":\"{}\"}}\n", "x".repeat(70_000));
        client_in.write_all(big.as_bytes()).unwrap();
        thread::sleep(Duration::from_millis(200));
        drop(client_in);
        assert!(matches!(done.join().unwrap(), Exit::Refused));
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let want = v["sessionCantFallBackAnswer"]["json"].as_str().unwrap().replace("\"id\":7", "\"id\":null");
        assert_eq!(sink.lines(), [want]);
    }

    #[test]
    fn eof_during_the_reattach_of_a_session_with_records_still_refuses_and_exits_non_zero() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        // the default backoff: a quick loss waits 2 s before the reattach
        let (mut client_in, sink, done) = start(home.clone());
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"record","entry":{"tighten":"x"}}"#, BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        write_failed(&home, "restarts-exhausted");
        drop(listener);
        drop(s);
        thread::sleep(Duration::from_millis(100));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"a\"}\n").unwrap();
        drop(client_in); // EOF inside the backoff, before the reattach finds failed.json
        assert!(matches!(done.join().unwrap(), Exit::Refused), "an EOF mid-reattach must not skip the refusal");
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let want = v["sessionCantFallBackAnswer"]["json"].as_str().unwrap().replace("\"id\":7", "\"id\":4");
        assert_eq!(sink.lines(), [want]);
    }
}
