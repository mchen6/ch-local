//! The relay: one session's state machine (the relay design; contract 2,
//! section 1 "Messages", "Control", "Holding until settled", "The crash
//! answer"; section 5; section 6 "Reconnecting"). Every other thread (stdin,
//! the connection reader, attach, the conditions child, timers) only sends
//! events into one channel; this loop alone changes state.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{self, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// What a session that lost a record is refused with when the runtime can't
/// resume it (a daemon death, or a resume refused): a new session can't be
/// given back a tightening that wasn't kept.
// (business's words: what happened, then the next step, as
// SESSION_CANT_FALL_BACK says "restart the session"; "replay" is the shim's)
const RECORD_LOST: &str = "ch-shim: the runtime couldn't resume this session, and a setting this session tightened couldn't be kept, so the session stops: restart it";
/// What a session holding tightenings is refused with when the runtime tells
/// it to run its own (`reason`, the op's, cleaned): a runtime of its own
/// starts at the file's values, so never looser, it stops.
fn cant_share_with_tightenings(reason: &str) -> String {
    format!(
        "ch-shim: this session can't share the runtime ({reason}), and a runtime of its own wouldn't have the settings this session tightened, so the session stops: restart it"
    )
}
/// Sent after a replayed initialize.
const INITIALIZED: &[u8] = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
/// What a legacy (2025-11-25) client is told when the runtime it talks to
/// may have changed (a replay, a handover): each of its lists may be others.
/// Its tools always (every runtime declares their listChanged to such a
/// client); its prompts and its resources only where the runtime's initialize
/// answer declared their listChanged (R-cold-prompts: a runtime from before
/// it declares `{}` for both, and a server sends list_changed only for a list
/// it declared). A client re-lists on each.
pub(crate) const LISTS_CHANGED: [(&str, &[u8]); 3] = [
    ("tools", br#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#),
    ("prompts", br#"{"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}"#),
    ("resources", br#"{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}"#),
];

/// Whether an initialize answer lets its client be told this list changed
/// (LISTS_CHANGED): the tools always; another list where the answer's
/// `result.capabilities.<list>.listChanged` is true.
pub(crate) fn told_of(answer: &Value, list: &str) -> bool {
    list == "tools" || answer.pointer(&format!("/result/capabilities/{list}/listChanged")) == Some(&Value::Bool(true))
}
/// After the per-session runtime exits, its output is waited for while it
/// keeps coming (a process it started may hold the pipe, writing or not):
/// until PUMP_DRAIN passes with nothing read, or PUMP_MAX in all.
const PUMP_DRAIN: Duration = Duration::from_secs(2);
const PUMP_MAX: Duration = CLOSING_GRACE;
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
/// The longest a welcomed connection waits for its first `client` frame from the shim's first child run, the one started with
/// the shim: within the runtime's own wait for that frame (12 s, countinghouse's session listener), so a child slower than this
/// is answered failed, as one past its bound always was, never left to the runtime to close.
const FIRST_WAIT: Duration = Duration::from_secs(10);

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
    /// The first attach's, once it has itself started the daemon.
    pub cold_attach: Duration,
    pub retry_unit: Duration,
    /// After stdin's EOF, how long answers are still relayed.
    pub closing: Duration,
    /// How long a welcomed connection may wait for `settled`.
    pub settle: Duration,
    /// How long the exit waits for an answer still streaming to stdout.
    pub barrier: Duration,
    /// The bound of the child's first run, from the shim's start (child::FIRST_TIMEOUT).
    pub first_child: Duration,
    /// How long a welcomed connection waits for that run's answer (FIRST_WAIT).
    pub first_wait: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            attach: attach::BUDGET,
            cold_attach: attach::COLD_BUDGET,
            retry_unit: Duration::from_secs(1),
            closing: CLOSING_GRACE,
            settle: SETTLE_DEADLINE,
            barrier: STDOUT_BARRIER,
            first_child: child::FIRST_TIMEOUT,
            first_wait: FIRST_WAIT,
        }
    }
}

/// The longer budget, for the first attach only.
fn first_attach_budget(first: &mut bool, cold: Duration) -> Option<Duration> {
    std::mem::take(first).then_some(cold)
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
    /// A welcomed connection's wait for the first child run's answer has passed.
    FirstWait {
        generation: u64,
    },
    /// The first child run's answer (started with the shim, before any connection).
    EarlyClient {
        frame: Vec<u8>,
    },
}

/// The shim's first run of the conditions child, started with the shim so that its cold start overlaps the attach (a daemon's
/// boot, on a first start): its answer is the first connection's first `client` frame.
#[derive(Debug, PartialEq)]
enum Early {
    /// Started, no connection waiting for it yet.
    Running,
    /// Answered while no connection was welcomed: sent the moment one is, unless the runtime was unreachable meanwhile.
    Ready(Vec<u8>),
    /// Started, and this connection (its generation) waits for it.
    Wanted(u64),
    /// Its answer sent, or no longer wanted (its wait passed, or the runtime was unreachable): a later connection runs the
    /// child afresh. It never holds the one child slot: a run given up never delays the next.
    Spent,
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
    /// Of `dropped`, the replayed initializes, whose answers the reader reads
    /// (bounded) for the lists they declare (reader::Shared::replay_seqs).
    replay_seqs: Arc<Mutex<HashSet<u64>>>,
    closed: Arc<AtomicBool>,
    streaming: Arc<std::sync::atomic::AtomicUsize>,
    records: Records,
    held: Held,
    resume: Option<String>,
    /// The legacy `initialize` line, for the replay after a reconnect.
    initialize: Option<Vec<u8>>,
    replays: u64,
    /// The sequence number the kept initialize went under.
    initialize_seq: Option<u64>,
    reconnecting: bool,
    retries: usize,
    /// No attach made yet: the next is the one a cold start may extend.
    first_attach: bool,
    stdin_done: bool,
    /// When this connection was welcomed, and how many connections in a
    /// row were lost soon after: the backoff before attaching again.
    attached_at: Option<Instant>,
    quick_losses: u32,
    /// The conditions child runs one at a time; what waits for it.
    child_running: bool,
    /// The first run, started with the shim.
    early: Early,
    /// Every conditions child this relay spawns: killed when it ends (main), none spawned after.
    children: child::Children,
    /// The `why` of this connection's first `client` frame, when it failed
    /// (the conditions child's failure, in the shim's own words).
    first_client_why: Option<String>,
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
        /// The runtime's own-runtime op's reason token (token, credential,
        /// conditions-failed, ...), passed to `ch-local start` as
        /// `--own-runtime-reason` so the client's first result says why
        /// (#236 section 5); None for a hand-over of the shim's own
        /// (failed.json).
        code: Option<String>,
        /// For conditions-failed only: the `why` of the shim's own first
        /// `client` frame when it failed, cleaned (own_runtime_flags).
        why: Option<String>,
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
            replay_seqs: Arc::new(Mutex::new(HashSet::new())),
            closed: Arc::new(AtomicBool::new(false)),
            streaming: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            records: Records::default(),
            held: Held::default(),
            resume: None,
            initialize: None,
            replays: 0,
            initialize_seq: None,
            reconnecting: false,
            retries: 0,
            first_attach: true,
            stdin_done: false,
            attached_at: None,
            quick_losses: 0,
            child_running: false,
            early: Early::Spent,
            children: child::Children::default(),
            first_client_why: None,
            child_queue: std::collections::VecDeque::new(),
            stdout_gone: false,
            settle_losses: 0,
            give_up: None,
        }
    }

    /// Its conditions children, for main to kill when run returns (Children::kill_all).
    pub fn children(&self) -> child::Children {
        self.children.clone()
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
        // the conditions child's first run starts now, before the attach: it needs only the client's pid and the home, and its
        // cold start (Node, and on Windows PowerShell walking the client's ancestors) then overlaps the attach instead of
        // following it. Its answer is still the first thing the runtime hears, and nothing of the client's is forwarded before
        // the runtime says `settled` (the hold is unchanged).
        self.start_early();
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
        // (only the process's first attach: a re-attach that happens to start
        // a daemon keeps its budget)
        let cold = first_attach_budget(&mut self.first_attach, self.setup.timing.cold_attach);
        thread::spawn(move || {
            let now = Instant::now();
            let got = match cold {
                Some(c) => attach::attach_first(&home, resume.as_deref(), now + budget, now + c),
                None => attach::attach_within(&home, resume.as_deref(), now + budget),
            };
            let _ = tx.send(Ev::Attached(got));
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
            Ev::Attached(Ok(a)) => return self.attached(a),
            Ev::Attached(Err(AttachError::SharedFailed(r))) => return self.shared_failed(r),
            Ev::Attached(Err(e)) => return self.unreachable_or_end(e.to_string()),
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
            Ev::EarlyClient { frame } => {
                match std::mem::replace(&mut self.early, Early::Spent) {
                    // (unreachable meanwhile: an answer kept that long could be stale when a connection comes; the next
                    // connection runs the child afresh)
                    Early::Running | Early::Wanted(_) if matches!(self.state, State::Unreachable(_)) => {}
                    Early::Wanted(g) if g == self.generation && self.writer.is_some() => self.first_frame(frame),
                    // (no connection, or its connection lost before the answer came: kept for the next welcome)
                    Early::Running | Early::Wanted(_) => self.early = Early::Ready(frame),
                    _ => {}
                }
            }
            Ev::FirstWait { generation } => {
                // (a connection lost meanwhile keeps waiting: its reattach gets a wait of its own)
                if generation == self.generation && self.writer.is_some() && self.early == Early::Wanted(generation) {
                    // past the wait: answered failed, as a child past its bound is, so the runtime never closes the
                    // connection for want of a first frame; the run's own answer, when it comes, is no longer wanted
                    self.early = Early::Spent;
                    // (business's words: the real wait, whatever a test sets, since it is the runtime's)
                    let why = format!(
                        "the check of the client's setup did not finish in the {} s the shared runtime waits for it",
                        FIRST_WAIT.as_secs()
                    );
                    self.first_frame(child::client_frame(None, Err(why)));
                }
            }
            Ev::Client { generation, frame } => {
                self.child_running = false;
                if generation == self.generation {
                    // the connection's first frame (no seq): its failure is what
                    // a conditions-failed hand-over says why with
                    if let Ok(Value::Object(f)) = serde_json::from_slice::<Value>(&frame) {
                        if !f.contains_key("seq") {
                            self.first_client_why = (f.get("status").and_then(Value::as_str) == Some("failed"))
                                .then(|| f.get("why").and_then(Value::as_str).unwrap_or("").to_string());
                        }
                    }
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
        // (the home's own status command, a line that runs: the reviewer)
        let status = answer::status_command(self.setup.home.root());
        match message::classify(line) {
            Line::Request { id, .. } => self.say(&answer::unreachable_with(&id, why, &status)),
            Line::Batch { ids } if !ids.is_empty() => {
                let mut all = vec![b'['];
                for (i, id) in ids.iter().enumerate() {
                    if i > 0 {
                        all.push(b',');
                    }
                    all.extend_from_slice(&answer::unreachable_with(id, why, &status));
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
        let initialize = matches!(&class, Line::Request { method: Some(m), .. } if m == "initialize");
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
        // (kept once it is tracked: one the shim answered itself is the
        // client's to send again)
        if initialize {
            self.initialize = Some(line);
            self.initialize_seq = seq;
        }
        if let Some(w) = self.writer.as_mut() {
            let _ = frame::write_frame(w, Kind::Message, &payload, self.to_runtime);
        }
    }

    /// An initialize not answered yet, about to be crash-answered: the client
    /// sends it again, so it is never replayed for it.
    fn forget_unanswered_initialize(&mut self, t: &InFlight) {
        if self.initialize_seq.is_some_and(|n| t.holds(n)) {
            self.initialize = None;
            self.initialize_seq = None;
        }
    }

    fn attached(&mut self, a: Attached) -> Option<Exit> {
        if a.new_session && self.records.lost() {
            // a new session can't be given back a record that wasn't kept:
            // the connection is dropped unused
            drop(a);
            return self.refuse_session(RECORD_LOST);
        }
        self.generation += 1;
        self.retries = 0;
        self.to_runtime = a.welcome.to_runtime;
        self.limit.set((a.welcome.to_runtime.message as usize).saturating_sub(4096));
        self.resume = Some(a.welcome.resume_token.clone());
        let read_half = match a.conn.try_clone_conn() {
            Ok(r) => r,
            Err(e) => return self.unreachable_or_end(format!("the connection could not be shared ({e})")),
        };
        let (tx, generation) = (self.tx.clone(), self.generation);
        let shared = Shared {
            inflight: self.inflight.clone(),
            dropped: self.dropped.clone(),
            replay_seqs: self.replay_seqs.clone(),
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
        self.state = if matches!(self.state, State::Closing(_)) { return None } else { State::Unsettled };
        // the first run's answer, if one was started with the shim: at once if it is in, else when it comes, within FIRST_WAIT
        // of this welcome; with none, a run of this connection's own, as before
        match std::mem::replace(&mut self.early, Early::Spent) {
            Early::Ready(frame) => self.first_frame(frame),
            Early::Running | Early::Wanted(_) => {
                self.early = Early::Wanted(generation);
                let (tx, wait) = (self.tx.clone(), self.setup.timing.first_wait);
                thread::spawn(move || {
                    thread::sleep(wait);
                    let _ = tx.send(Ev::FirstWait { generation });
                });
            }
            Early::Spent => self.conditions(None),
        }
        None
    }

    /// Starts the conditions child's first run, its bound counted from now (Timing::first_child). It runs beside the one
    /// child slot, never in it: a later run (a reattach's, a conditions? ask's) never waits for it.
    fn start_early(&mut self) {
        self.early = Early::Running;
        let (tx, home, parent, bound, children) = (
            self.tx.clone(),
            self.setup.home.clone(),
            self.setup.parent,
            self.setup.timing.first_child,
            self.children.clone(),
        );
        let env = child::child_env(self.setup.client_env.clone());
        thread::spawn(move || {
            let printed = match config::read_shim(&home) {
                Ok(shim) => child::run(&shim, home.root(), parent, env, bound, &children),
                Err(e) => Err(format!("shim.json: {e}")),
            };
            let _ = tx.send(Ev::EarlyClient { frame: child::client_frame(None, printed) });
        });
    }

    /// A connection's first `client` frame, sent: its failure is what a conditions-failed hand-over says why with.
    fn first_frame(&mut self, frame: Vec<u8>) {
        if let Ok(Value::Object(f)) = serde_json::from_slice::<Value>(&frame) {
            self.first_client_why = (f.get("status").and_then(Value::as_str) == Some("failed"))
                .then(|| f.get("why").and_then(Value::as_str).unwrap_or("").to_string());
        }
        self.control(&frame);
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
        let (tx, generation, home, parent, children) =
            (self.tx.clone(), self.generation, self.setup.home.clone(), self.setup.parent, self.children.clone());
        let env = child::child_env(self.setup.client_env.clone());
        thread::spawn(move || {
            let printed = match config::read_shim(&home) {
                Ok(shim) => child::run(&shim, home.root(), parent, env, child::TIMEOUT, &children),
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
                // the records go back first, on every settled connection
                // while any are held, a new session or a resumed one: the
                // runtime takes a replay only once settled, and a session
                // lost after its settle (announced, so resumed) may never
                // have read the one sent before. The runtime applies an
                // entry only if it is tighter than the value in effect, so
                // a replay of the session's latest snapshot changes nothing,
                // and a stale one (a later change not yet read here) can
                // only tighten again. On a resumed session, whose values the
                // runtime still holds, records partly lost replay what is
                // kept, which can only tighten too. It is ahead of every
                // held line on this one connection, and the runtime applies
                // it as it reads it, before the next frame
                if !self.records.is_empty() {
                    let frame = self.records.replay_frame();
                    self.control(&frame);
                }
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
                match serde_json::from_slice::<Fields>(raw).ok().and_then(|mut f| f.remove("entry")) {
                    Some(entry) => {
                        self.records.record(entry);
                    }
                    // a tightening that can't be kept for replay: lost
                    None => self.records.lose(),
                }
            }
            "forget" => self.records.forget(),
            // a call the client cancelled has no answer (MCP completeness
            // section 13): its seq is forgotten, so no crash answer is made
            // for it, and a close waiting on it ends once nothing is left.
            // A seq not held (answered already, or another connection's) is
            // ignored, as an op this shim did not know would be.
            "cancelled" => {
                if let Some(seq) = op.get("seq").and_then(Value::as_u64) {
                    self.inflight.lock().expect("in-flight lock").settle(seq);
                    if matches!(self.state, State::Closing(_)) && self.nothing_in_flight() {
                        return Some(self.finish());
                    }
                }
            }
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
                // never looser: a session holding records refuses, as on a
                // failed.json; with none it runs its own, as before
                if self.records.holds_any() {
                    return self.refuse_session(&cant_share_with_tightenings(&reason));
                }
                // the op's token as given, if it is one, for ch-local's notice;
                // the shim's own words only for its own failed first frame
                let code = reason_token(op.get("reason").and_then(Value::as_str));
                let why = if code == "conditions-failed" { self.first_client_why.clone() } else { None };
                // (a reattach: the session's initialize went to the shared
                // runtime, and its own hears it too; on a first attach it is
                // still held)
                let replay = self.replay_for_own();
                return Some(self.hand_over(
                    format!("ch-shim: this session can't share the runtime ({reason}); it runs its own"),
                    replay,
                    Some(code),
                    why,
                ));
            }
            _ => {}
        }
        None
    }

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

    /// The legacy replay (section 6, step 4): the kept initialize line with
    /// the shim's own id, its answer dropped; then notifications/initialized
    /// to the runtime, and tools/list_changed to the client. Its prompts' and
    /// resources' list_changed follow from the reader, once the replay's
    /// answer declares them (LISTS_CHANGED, reader::Shared::replay_seqs).
    fn replay_initialize(&mut self) {
        let Some((replay, _)) = self.next_replay() else { return };
        let Some(n) = self.seq.take() else { return };
        self.dropped.lock().expect("dropped lock").insert(n);
        self.replay_seqs.lock().expect("replay seqs lock").insert(n);
        // its tools first, before the replay is sent: its prompts and
        // resources follow from the reader once the replay's answer says they
        // are declared (reader::Shared::replay_seqs), so never ahead of these
        self.say(LISTS_CHANGED[0].1);
        if let (Ok(p), Some(w)) = (message::to_runtime(Some(n), &replay, self.to_runtime.message), self.writer.as_mut())
        {
            let _ = frame::write_frame(w, Kind::Message, &p, self.to_runtime);
        }
        if let (Ok(p), Some(w)) =
            (message::to_runtime(None, INITIALIZED, self.to_runtime.message), self.writer.as_mut())
        {
            let _ = frame::write_frame(w, Kind::Message, &p, self.to_runtime);
        }
    }

    /// Crash answers for everything still in flight, taken under the
    /// in-flight mutex with `closed` set, so the reader (if still running)
    /// discards any later answer for them instead of writing a second one.
    fn close_and_crash_answer(&mut self) {
        let answers = {
            let inflight = self.inflight.clone();
            let mut t = inflight.lock().expect("in-flight lock");
            self.closed.store(true, Ordering::SeqCst);
            self.forget_unanswered_initialize(&t);
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
        let answers = {
            let inflight = self.inflight.clone();
            let mut t = inflight.lock().expect("in-flight lock");
            self.forget_unanswered_initialize(&t);
            t.crash_answers()
        };
        for a in answers {
            self.say(&a);
        }
        // stdin ended during an attach (eof deferred it until the attach
        // decided, and it found a runtime): that connection is gone before
        // it settled, so nothing more can reach a runtime; the held requests
        // say they didn't run, and the shim ends, not reattaching for ever (L1)
        if self.stdin_done {
            for line in self.held.take() {
                if let Some((ids, batch)) = Self::ids_of(&message::classify(&line)) {
                    self.answer_each(&ids, batch, |id| answer::crash(id, false));
                }
            }
            return Some(Exit::Done);
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

    /// Unreachable; and if stdin ended during the attach (eof deferred it),
    /// the end now.
    fn unreachable_or_end(&mut self, why: String) -> Option<Exit> {
        self.unreachable(why);
        if self.stdin_done { Some(Exit::Done) } else { None }
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
        // (an early answer kept: dropped, since a connection after this could be minutes later)
        if matches!(self.early, Early::Ready(_)) {
            self.early = Early::Spent;
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
    fn hand_over(
        &mut self,
        reason: String,
        replay: Option<(Vec<u8>, String)>,
        code: Option<String>,
        why: Option<String>,
    ) -> Exit {
        self.close_and_crash_answer();
        if let Some(w) = self.writer.take() {
            let _ = w.shutdown();
        }
        let limit = self.limit.get();
        self.limit.set(lines::Limit::RAW);
        let (_, dead) = mpsc::sync_channel(1);
        let rx = std::mem::replace(&mut self.rx, dead);
        let rest = Rest { rx, out: self.out.clone(), limit };
        Exit::OwnRuntime { reason, code, why, held: self.held.take(), rest, replay }
    }

    /// A daemon gave up (#236 section 6, failed.json). Never looser: a
    /// session holding records (its tightenings) can't move to a runtime that
    /// takes no replay, so it refuses; otherwise it runs its own, replaying
    /// its initialize first if it was live.
    fn shared_failed(&mut self, r: crate::failed::Reason) -> Option<Exit> {
        if self.records.holds_any() {
            return self.refuse_session(&crate::failed::refusal_line(r));
        }
        let replay = self.replay_for_own();
        Some(self.hand_over(crate::failed::startup_line(r), replay, None, None))
    }

    /// The replay its own runtime starts with: the initialize this session
    /// sent to the shared one, if it did.
    fn replay_for_own(&mut self) -> Option<(Vec<u8>, String)> {
        // (still in flight: crash-answered at the hand-over)
        let inflight = self.inflight.clone();
        self.forget_unanswered_initialize(&inflight.lock().expect("in-flight lock"));
        self.initialize.as_ref()?;
        let built = self.next_replay();
        if built.is_none() {
            let _ = writeln!(
                io::stderr(),
                "ch-shim: this session's initialize could not be replayed; its own runtime starts uninitialized"
            );
        }
        built
    }

    /// The session can't go on (never looser): stderr says why; whatever is
    /// in flight on a live connection is crash-answered and the connection
    /// closed (a new generation, so its reader's events are ignored); each
    /// held and later request is answered SESSION_CANT_FALL_BACK; at stdin's
    /// end the shim exits 1.
    fn refuse_session(&mut self, why: &str) -> Option<Exit> {
        let _ = writeln!(io::stderr(), "{why}");
        if self.writer.is_some() {
            self.close_and_crash_answer();
            if let Some(w) = self.writer.take() {
                let _ = w.shutdown();
            }
        }
        self.generation += 1;
        self.state = State::Refused;
        for line in self.held.take() {
            self.refuse_line(&line);
        }
        if self.stdin_done {
            return Some(Exit::Refused);
        }
        None
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
        if self.writer.is_none() && self.state == State::Attaching && self.records.holds_any() {
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
        // the bye waits for what is in flight (finish): the runtime ends a
        // session at once on its bye, so one sent here would end the calls
        // still running and leave them only crash answers
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

    /// The end: the client gone, once nothing is in flight or the closing
    /// grace has passed. Then, and only then, the bye (the runtime ends the
    /// session on it at once, workers included), and what is still in flight
    /// is crash-answered. A connection already lost sends nothing.
    fn finish(&mut self) -> Exit {
        if self.stdin_done {
            self.control(br#"{"op":"bye"}"#);
        }
        self.close_and_crash_answer();
        Exit::Done
    }
}

/// The runtime's reason as a token ch-local takes (`^[a-z][a-z-]{0,31}$`), else
/// "unknown": never a value of the runtime's own choosing passed through.
pub fn reason_token(given: Option<&str>) -> String {
    match given {
        Some(t)
            if !t.is_empty()
                && t.len() <= 32
                && t.as_bytes()[0].is_ascii_lowercase()
                && t.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') =>
        {
            t.to_string()
        }
        _ => "unknown".to_string(),
    }
}

/// The shim's own words, as ch-local takes a `--own-runtime-why`: control,
/// bidi and line-separator characters out, cut to 200 characters, and never
/// an option (no leading `-`); None when nothing is left.
pub fn clean_why(why: &str) -> Option<String> {
    let bidi = |c: char| matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{2028}' | '\u{2029}' | '\u{200E}' | '\u{200F}');
    let cleaned: String = why.chars().map(|c| if c.is_control() || bidi(c) { ' ' } else { c }).take(200).collect();
    let cleaned = cleaned.trim_start_matches(|c: char| c == '-' || c.is_whitespace()).trim_end().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `ch-local start`'s flags for a hand-over (#236 section 5; ch-local #60):
/// `--own-runtime-reason <code>`, and `--own-runtime-why <why>` when there is
/// one. They follow `--home` in own_command's line, still ch-local's own
/// options, before any pass-through.
pub fn own_runtime_flags(code: Option<&str>, why: Option<&str>) -> Vec<OsString> {
    let mut out = Vec::new();
    if let Some(c) = code {
        out.push(OsString::from("--own-runtime-reason"));
        out.push(OsString::from(reason_token(Some(c))));
        if let Some(w) = why.and_then(clean_why) {
            out.push(OsString::from("--own-runtime-why"));
            out.push(OsString::from(w));
        }
    }
    out
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
fn relay_line<R: io::BufRead>(r: &mut R, out: &Out, start: &[u8], p: &Progress) -> io::Result<bool> {
    let mut held = out.lock();
    if !start.is_empty() {
        p.wrote(|| held.raw(start), start.len())?;
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
        p.wrote(|| held.raw(&buf[..take]), take)?;
        r.consume(take);
        if done {
            return Ok(true);
        }
    }
}

/// The pump's progress: bytes read from the runtime's output and written to
/// the client, and whether a write to the client is under way (a slow client
/// holds the pump there, with nothing read meanwhile).
#[derive(Default)]
struct Progress {
    moved: AtomicU64,
    writing: AtomicBool,
}

impl Progress {
    fn wrote(&self, write: impl FnOnce() -> io::Result<()>, n: usize) -> io::Result<()> {
        self.writing.store(true, Ordering::Relaxed);
        let r = write();
        // moved first: drain never sees "not writing" before the bytes count
        self.moved.fetch_add(n as u64, Ordering::Relaxed);
        self.writing.store(false, Ordering::Relaxed);
        r
    }
}

/// A reader that counts the bytes read through it into the pump's progress.
struct Counted<R> {
    inner: R,
    progress: Arc<Progress>,
}

impl<R: io::Read> io::Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.progress.moved.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// Waits for the pump to end (`done`) while it makes progress (bytes moved,
/// or a write to the client under way): until `idle` passes with neither, or
/// `max` in all.
fn drain(done: &Receiver<()>, p: &Progress, idle: Duration, max: Duration) {
    let until = Instant::now() + max;
    let mut seen = p.moved.load(Ordering::Relaxed);
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        match done.recv_timeout(idle.min(left)) {
            Err(RecvTimeoutError::Timeout) => {}
            _ => return,
        }
        let now = p.moved.load(Ordering::Relaxed);
        if now == seen && !p.writing.load(Ordering::Relaxed) {
            return;
        }
        seen = now;
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
        let progress = Arc::new(Progress::default());
        let counted = Counted { inner: stdout, progress: progress.clone() };
        let p = progress.clone();
        thread::spawn(move || {
            let mut r = io::BufReader::with_capacity(64 * 1024, counted);
            // look for the replayed initialize's answer, which is dropped;
            // each line looked at is held only up to REPLAY_LOOK_BYTES
            for _ in 0..REPLAY_LOOK_LINES {
                let Ok((start, whole)) = line_start(&mut r, REPLAY_LOOK_BYTES) else { break };
                if start.is_empty() {
                    let _ = done_tx.send(());
                    return;
                }
                let answer = if whole {
                    serde_json::from_slice::<Value>(start.trim_ascii_end())
                        .ok()
                        .filter(|v| v.get("id").and_then(Value::as_str) == Some(id.as_str()))
                } else {
                    None
                };
                if let Some(v) = answer {
                    // it serves now, and its lists may be others than the
                    // shared runtime's the client listed
                    if v.get("result").is_some_and(Value::is_object)
                        && LISTS_CHANGED
                            .iter()
                            .filter(|(list, _)| told_of(&v, list))
                            .any(|(_, line)| p.wrote(|| out.message(line), line.len() + 1).is_err())
                    {
                        let _ = done_tx.send(());
                        return;
                    }
                    break;
                }
                if !matches!(relay_line(&mut r, &out, &start, &p), Ok(true)) {
                    let _ = done_tx.send(());
                    return;
                }
            }
            while let Ok(true) = relay_line(&mut r, &out, &[], &p) {}
            let _ = done_tx.send(());
        });
        (done_rx, progress)
    });
    let code = child.wait()?.code().unwrap_or(1);
    // a process the runtime started may hold its stdout: waited for while
    // its output keeps coming, then the shim exits with the runtime's code
    if let Some((done, progress)) = pumped {
        drain(&done, &progress, PUMP_DRAIN, PUMP_MAX);
    }
    Ok(code)
}

#[cfg(all(test, unix))]
mod tests {
    use crate::test_files::private;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

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
        let Exit::OwnRuntime { reason, code, why, held, rest, replay } = exit else { panic!("not handed over") };
        assert_eq!(replay, None, "the runtime's own-runtime op replays nothing");
        assert_eq!(reason, "ch-shim: this session can't share the runtime (token); it runs its own");
        assert_eq!(
            (code.as_deref(), why),
            (Some("token"), None),
            "its token for ch-local's notice; no words of the shim's"
        );
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

    /// A legacy session reconnected: its initialize replayed under the shim's
    /// id, the replay's answer (declaring `caps`, a JSON object) dropped; what
    /// its client heard.
    fn reconnected_with(caps: &str) -> Vec<String> {
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
        reply(
            &mut s2,
            rseq.unwrap(),
            &format!(r#"{{"jsonrpc":"2.0","id":"ch-shim-replay-1","result":{{"v":1,"capabilities":{caps}}}}}"#),
        );
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
        sink.lines()
    }

    #[test]
    fn a_legacy_session_replays_initialize_after_a_reconnect_and_drops_its_answer() {
        assert_eq!(
            reconnected_with(
                r#"{"tools":{"listChanged":true},"prompts":{"listChanged":true},"resources":{"listChanged":true}}"#
            ),
            [
                r#"{"jsonrpc":"2.0","id":0,"result":{"v":1}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}"#
            ],
            "the replay's answer is dropped; the client hears its lists changed, its tools first"
        );
    }

    /// A runtime from before R-cold-prompts, reconnected to: `{}` for its
    /// prompts and resources, so its client is told only of its tools.
    #[test]
    fn a_reconnect_to_a_runtime_that_declares_no_listchanged_for_prompts_or_resources_tells_only_the_tools() {
        assert_eq!(
            reconnected_with(r#"{"tools":{"listChanged":true},"prompts":{},"resources":{}}"#),
            [
                r#"{"jsonrpc":"2.0","id":0,"result":{"v":1}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#
            ]
        );
    }

    /// A session that was live and reconnects to a runtime that now says it
    /// runs its own: that runtime hears the client's initialize too.
    #[test]
    fn own_runtime_on_a_reattach_replays_the_sessions_initialize() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"c\"}}}\n")
            .unwrap();
        let (seq, _) = read_m(&mut s);
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":0,"result":{"v":1}}"#);
        thread::sleep(Duration::from_millis(100));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        welcome(&mut s2, "rt2");
        until_op(&mut s2, "client");
        frame::write_frame(&mut s2, Kind::Control, br#"{"op":"own-runtime","reason":"token"}"#, BIG).unwrap();
        let Exit::OwnRuntime { code, replay, .. } = done.join().unwrap() else { panic!("not handed over") };
        assert_eq!(code.as_deref(), Some("token"));
        let (line, id) = replay.expect("its initialize is replayed");
        let line: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!((id.as_str(), line["id"].as_str()), ("ch-shim-replay-1", Some("ch-shim-replay-1")));
        assert_eq!(
            (line["method"].as_str(), line["params"]["clientInfo"]["name"].as_str()),
            (Some("initialize"), Some("c"))
        );
        drop(client_in);
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

    /// Short waits for the replay tests: a quick loss's backoff and the
    /// closing grace in tenths of a second.
    fn fast() -> Timing {
        Timing { retry_unit: Duration::from_millis(100), closing: Duration::from_millis(500), ..Timing::default() }
    }

    /// A session that settled and was given one record, then lost (a legacy
    /// one first sent `initialize`, answered); the listener, the client's
    /// input, its output, the relay's end.
    fn session_with_a_record(legacy: bool) -> (UnixListener, UnixStream, Sink, thread::JoinHandle<Exit>) {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start_with(home, fast());
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        if legacy {
            client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{}}\n").unwrap();
            let (seq, _) = read_m(&mut s);
            reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":0,"result":{"v":1}}"#);
        }
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"record","entry":{"maxOutputBytes":1048576}}"#, BIG)
            .unwrap();
        // (the record taken: an op's effect is seen only through what follows,
        // so the connection's end comes after a frame the shim answers)
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"conditions?","seq":1}"#, BIG).unwrap();
        until_op(&mut s, "client");
        drop(s);
        (listener, client_in, sink, done)
    }

    /// The next frame: its kind, a control frame's payload, an M line's seq
    /// and body.
    fn next_frame(s: &mut UnixStream) -> (Kind, Value, Option<u64>, Vec<u8>) {
        let (kind, len) = frame::read_head(s, BIG).unwrap();
        let mut p = vec![0u8; len as usize];
        s.read_exact(&mut p).unwrap();
        match kind {
            Kind::Control => (kind, serde_json::from_slice(&p).unwrap(), None, vec![]),
            Kind::Message => {
                let (seq, body) = message::from_runtime(&p).unwrap();
                (kind, Value::Null, seq, body.to_vec())
            }
            _ => panic!("{kind:?}"),
        }
    }

    /// `line` sent while the connection is unsettled, and known held: a line
    /// too long for any connection follows it, which the shim answers itself
    /// at once, and the lines are read in order (a bounded wait on that
    /// answer, never a sleep).
    fn held(client_in: &mut UnixStream, sink: &Sink, line: &[u8]) {
        let before = sink.lines().len();
        client_in.write_all(line).unwrap();
        let mut long = vec![b'x'; 70_000];
        long.push(b'\n');
        client_in.write_all(&long).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while sink.lines().len() <= before && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(sink.lines().len() > before, "the too-long line was never answered");
    }

    /// No connection is waiting on `listener` (it is left blocking).
    fn no_connection_waiting(listener: &UnixListener) -> bool {
        listener.set_nonblocking(true).unwrap();
        let none = matches!(listener.accept(), Err(e) if e.kind() == io::ErrorKind::WouldBlock);
        listener.set_nonblocking(false).unwrap();
        none
    }

    /// The server side of a handshake that refuses a resume, as the runtime
    /// does for a session that ended: Some(token) welcomed as a new session,
    /// None refused.
    fn new_session_only(s: &mut UnixStream, token: &str) -> Option<()> {
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
        if auth.get("resume").is_some() {
            frame::write_frame(s, Kind::Refused, br#"{"code":"RESUME_REFUSED","message":"m"}"#, BIG).unwrap();
            return None;
        }
        let w = format!(
            r#"{{"session":"s","resumeToken":"{token}","runtimeVersion":"8.0.0","maxToRuntime":65536,"maxToShim":65536}}"#
        );
        frame::write_frame(s, Kind::Welcome, w.as_bytes(), BIG).unwrap();
        Some(())
    }

    // (the runtime's entry shape: lib/sessions.js snapshot(), one object of
    // the session's caps)
    const RECORD: &str = r#"[{"maxOutputBytes":1048576}]"#;

    // (the runtime takes a welcomed connection's `client` frame first, and a
    // replay only once the session is settled: shared-runtime design,
    // "Holding until settled" and the replay row; countinghouse listener.js.
    // So the records go after `settled`, ahead of any client line held
    // meanwhile)
    #[test]
    fn a_refused_resume_opens_a_new_session_that_sends_client_then_replays_on_settled_before_held_lines() {
        let (listener, mut client_in, sink, done) = session_with_a_record(false);
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(refuse_resume(&mut s2).as_deref(), Some("rt1"));
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s3, "rt3"), None, "a new session: no resume");
        assert_eq!(control_payload(&mut s3)["op"], "client", "the client frame first");
        held(&mut client_in, &sink, b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\"}\n");
        settled(&mut s3);
        let (kind, replay, _, _) = next_frame(&mut s3);
        assert_eq!((kind, replay["op"].as_str()), (Kind::Control, Some("replay")), "the replay first: {replay}");
        assert_eq!(replay["entries"], serde_json::from_str::<Value>(RECORD).unwrap());
        let (kind, _, seq, line) = next_frame(&mut s3);
        assert_eq!(kind, Kind::Message, "then the held line");
        assert!(String::from_utf8_lossy(&line).contains("\"id\":7"));
        reply(&mut s3, seq.unwrap(), r#"{"jsonrpc":"2.0","id":7,"result":{}}"#);
        drop(client_in);
        until_op(&mut s3, "bye");
        drop(s3);
        done.join().unwrap();
    }

    // (a legacy session: its records go ahead of its replayed initialize, so
    // the session is restored with its tightenings before anything runs)
    #[test]
    fn a_legacy_session_replays_its_records_before_its_initialize() {
        let (listener, client_in, _sink, done) = session_with_a_record(true);
        let (mut s2, _) = listener.accept().unwrap();
        refuse_resume(&mut s2);
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        welcome(&mut s3, "rt3");
        assert_eq!(control_payload(&mut s3)["op"], "client");
        settled(&mut s3);
        let (kind, replay, _, _) = next_frame(&mut s3);
        assert_eq!((kind, replay["op"].as_str()), (Kind::Control, Some("replay")), "the records first: {replay}");
        let (kind, _, rseq, init) = next_frame(&mut s3);
        let init: Value = serde_json::from_slice(&init).unwrap();
        assert_eq!(
            (kind, init["id"].as_str(), init["method"].as_str()),
            (Kind::Message, Some("ch-shim-replay-1"), Some("initialize")),
            "then the replayed initialize"
        );
        reply(&mut s3, rseq.unwrap(), r#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","result":{"v":1}}"#);
        drop(client_in);
        until_op(&mut s3, "bye");
        drop(s3);
        done.join().unwrap();
    }

    // (a runtime that refuses a resume of a session that ended, and closes a
    // welcomed connection whose first frame isn't `client`, as countinghouse's
    // does: one new session, settled, and no attach after; with the replay
    // first, every new session was closed, its resume refused, and a new one
    // opened again, so the bound below is what such a loop meets)
    #[test]
    fn a_refused_resume_holding_records_settles_once_and_does_not_reattach_in_a_loop() {
        let (listener, client_in, _sink, done) = session_with_a_record(false);
        let mut sessions = 0;
        let mut live = loop {
            let (mut s, _) = listener.accept().unwrap();
            if new_session_only(&mut s, &format!("rt{}", sessions + 2)).is_none() {
                continue;
            }
            sessions += 1;
            assert!(sessions <= 3, "{sessions} new sessions: a reattach loop");
            let first = control_payload(&mut s);
            if first["op"] == "client" {
                break s;
            }
            // (as the runtime: closed, the unsettled session ended)
            drop(s);
        };
        assert_eq!(sessions, 1, "one new session");
        settled(&mut live);
        assert_eq!(control_payload(&mut live)["op"], "replay");
        drop(client_in);
        until_op(&mut live, "bye");
        drop(live);
        done.join().unwrap();
        assert!(no_connection_waiting(&listener), "no attach after the settle");
    }

    // (lost after `settled`, before the runtime read the replay: the session
    // was announced, so the next attach resumes it, and the records go again)
    #[test]
    fn a_connection_lost_after_settled_resumes_and_replays_again() {
        let (listener, mut client_in, sink, done) = session_with_a_record(false);
        let (mut s2, _) = listener.accept().unwrap();
        refuse_resume(&mut s2);
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        welcome(&mut s3, "rt3");
        assert_eq!(control_payload(&mut s3)["op"], "client");
        settled(&mut s3);
        assert_eq!(control_payload(&mut s3)["op"], "replay");
        drop(s3);
        let (mut s4, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s4, "rt4").as_deref(), Some("rt3"), "a resume");
        assert_eq!(control_payload(&mut s4)["op"], "client");
        held(&mut client_in, &sink, b"{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/list\"}\n");
        settled(&mut s4);
        let (kind, replay, _, _) = next_frame(&mut s4);
        assert_eq!(
            (kind, replay["op"].as_str()),
            (Kind::Control, Some("replay")),
            "the records again on the resumed session, first: {replay}"
        );
        assert_eq!(replay["entries"], serde_json::from_str::<Value>(RECORD).unwrap());
        let (kind, _, seq, line) = next_frame(&mut s4);
        assert_eq!(kind, Kind::Message, "then the held line");
        assert!(String::from_utf8_lossy(&line).contains("\"id\":8"));
        reply(&mut s4, seq.unwrap(), r#"{"jsonrpc":"2.0","id":8,"result":{}}"#);
        drop(client_in);
        until_op(&mut s4, "bye");
        drop(s4);
        done.join().unwrap();
    }

    #[test]
    fn a_resumed_session_holding_no_records_sends_no_replay() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start_with(home, fast());
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"conditions?","seq":1}"#, BIG).unwrap();
        until_op(&mut s, "client");
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s2, "rt2").as_deref(), Some("rt1"), "a resume");
        assert_eq!(control_payload(&mut s2)["op"], "client");
        held(&mut client_in, &sink, b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/list\"}\n");
        settled(&mut s2);
        let (kind, op, seq, line) = next_frame(&mut s2);
        assert_eq!(kind, Kind::Message, "no replay: the held line comes first ({op})");
        assert!(String::from_utf8_lossy(&line).contains("\"id\":9"));
        reply(&mut s2, seq.unwrap(), r#"{"jsonrpc":"2.0","id":9,"result":{}}"#);
        drop(client_in);
        until_op(&mut s2, "bye");
        drop(s2);
        done.join().unwrap();
    }

    // (the words a session holding tightenings is refused with, as business
    // gave them: what happened, and the next step, as SESSION_CANT_FALL_BACK's
    // "restart the session"; the refusal itself, Exit::Refused, is pinned by
    // the record and own-runtime tests)
    #[test]
    fn a_session_holding_tightenings_is_refused_in_these_words() {
        assert_eq!(
            RECORD_LOST,
            "ch-shim: the runtime couldn't resume this session, and a setting this session tightened couldn't be kept, so the session stops: restart it"
        );
        assert_eq!(
            cant_share_with_tightenings("token"),
            "ch-shim: this session can't share the runtime (token), and a runtime of its own wouldn't have the settings this session tightened, so the session stops: restart it"
        );
    }

    #[test]
    fn a_new_session_after_a_record_too_big_to_keep_refuses_rather_than_replay_less() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        let big = format!(r#"{{"op":"record","entry":"{}"}}"#, "x".repeat(crate::records::MAX_BYTES));
        frame::write_frame(&mut s, Kind::Control, big.as_bytes(), BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(refuse_resume(&mut s2).as_deref(), Some("rt1"));
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s3, "rt3"), None, "a new session: no resume");
        // no replay of less than the runtime was told: the connection ends
        let mut ops = Vec::new();
        while let Ok((_, p)) = frame::read_frame(&mut s3, BIG) {
            if let Ok(v) = serde_json::from_slice::<Value>(&p) {
                ops.push(v["op"].as_str().unwrap_or("").to_string());
            }
        }
        assert!(!ops.iter().any(|o| o == "replay"), "no partial replay: {ops:?}");
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        assert!(matches!(done.join().unwrap(), Exit::Refused));
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        // (its own answer: a tightening lost, not the shared runtime failing)
        let want = v["sessionTighteningsLostAnswer"]["json"].as_str().unwrap().replace("\"id\":7", "\"id\":4");
        assert_eq!(sink.lines(), [want]);
    }

    #[test]
    fn a_new_session_after_records_pushed_out_by_the_bound_refuses_rather_than_replay_less() {
        // 65 records: the first (a `pack X off`, say) is pushed out of the
        // 64 kept; a replay without it would run the session looser
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        for i in 0..65 {
            let r = format!(r#"{{"op":"record","entry":{{"n":{i}}}}}"#);
            frame::write_frame(&mut s, Kind::Control, r.as_bytes(), BIG).unwrap();
        }
        thread::sleep(Duration::from_millis(200));
        drop(s);
        let (mut s2, _) = listener.accept().unwrap();
        assert_eq!(refuse_resume(&mut s2).as_deref(), Some("rt1"));
        drop(s2);
        let (mut s3, _) = listener.accept().unwrap();
        assert_eq!(welcome(&mut s3, "rt3"), None, "a new session: no resume");
        let mut ops = Vec::new();
        while let Ok((_, p)) = frame::read_frame(&mut s3, BIG) {
            if let Ok(v) = serde_json::from_slice::<Value>(&p) {
                ops.push(v["op"].as_str().unwrap_or("").to_string());
            }
        }
        assert!(!ops.iter().any(|o| o == "replay"), "no partial replay: {ops:?}");
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        assert!(matches!(done.join().unwrap(), Exit::Refused));
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        // (its own answer: a tightening lost, not the shared runtime failing)
        let want = v["sessionTighteningsLostAnswer"]["json"].as_str().unwrap().replace("\"id\":7", "\"id\":4");
        assert_eq!(sink.lines(), [want]);
    }

    #[test]
    fn only_the_first_attach_may_take_the_cold_budget() {
        let mut first = true;
        let cold = Duration::from_secs(28);
        assert_eq!(first_attach_budget(&mut first, cold), Some(cold));
        assert_eq!(first_attach_budget(&mut first, cold), None, "a re-attach keeps its budget");
        assert_eq!(first_attach_budget(&mut first, cold), None);
    }

    #[test]
    fn unreachable_answers_each_request_then_a_background_retry_attaches() {
        let (home, sock) = home();
        // no socket yet; the stand-in daemon (the conditions script) starts nothing, so the attach gives up at its budget.
        // A budget roomy enough for a slow machine's handshake on the retry; each wait gated on what is seen, not a sleep
        let (client_in, input) = UnixStream::pair().unwrap();
        let sink = Sink::default();
        let timing = Timing {
            attach: Duration::from_secs(2),
            cold_attach: Duration::from_secs(2),
            retry_unit: Duration::from_millis(100),
            ..Timing::default()
        };
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing },
            Out::new(Box::new(sink.clone())),
        );
        let mut client_in = client_in;
        let done = thread::spawn(move || relay.run(input));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n").unwrap();
        // (held while the attach runs, then answered once the shim is unreachable)
        let until = Instant::now() + Duration::from_secs(20);
        while sink.lines().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let answered: Value = serde_json::from_str(&sink.lines()[0]).unwrap();
        assert_eq!((answered["id"].as_u64(), answered["error"]["code"].as_i64()), (Some(1), Some(-32603)));
        assert!(
            answered["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("countinghouse could not reach its shared runtime (")
        );
        // the runtime appears; a retry attaches
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

    /// The conditions child's script: `body`, then the usual ok line.
    fn child_script(home: &Home, body: &str) {
        let ok = r#"echo '{"status":"ok","conditions":"no","repo":null,"token":null}'"#;
        fs::write(home.root().join("ch-local.sh"), format!("{body}\n{ok}\n")).unwrap();
    }

    // the child's first run starts with the shim, before the attach is done: it overlaps a daemon's boot instead of following
    // it; its answer is still the first frame the runtime hears, and the hold is unchanged
    #[test]
    fn the_conditions_child_runs_while_the_shim_attaches() {
        let (home, sock) = home();
        let mark = home.root().join("child-started");
        child_script(&home, &format!(": > '{}'", mark.display()));
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        // (the runtime has not welcomed the shim yet: the child already ran)
        until_file(&mark);
        assert!(mark.exists(), "the conditions child had not started before the runtime's welcome");
        welcome(&mut s, "rt1");
        let first = control_payload(&mut s);
        assert_eq!((first["op"].as_str(), first["status"].as_str()), (Some("client"), Some("ok")), "{first}");
        assert!(first.get("seq").is_none(), "the first frame: {first}");
        settled(&mut s);
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    /// Waits (bounded) until `f` exists.
    fn until_file(f: &std::path::Path) {
        let until = Instant::now() + Duration::from_secs(10);
        while !f.exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// A child script that, on its first run only (the marker `first`), waits until `gate` exists, then answers; a later
    /// run answers at once. Writes `done` once the first run has answered.
    fn gated_child(home: &Home, first: &std::path::Path, gate: &std::path::Path, done: &std::path::Path) {
        child_script(
            home,
            &format!(
                "if [ ! -e '{f}' ]; then : > '{f}'; while [ ! -e '{g}' ]; do sleep 0.02; done; : > '{d}'; fi",
                f = first.display(),
                g = gate.display(),
                d = done.display()
            ),
        );
    }

    // a first run slower than the wait after the welcome: answered failed then (within the runtime's own 12 s), never left
    // for the runtime to close the connection; its late answer is not sent
    #[test]
    fn a_first_run_not_in_within_the_wait_after_the_welcome_is_answered_failed() {
        let (home, sock) = home();
        let (first, gate, answered) =
            (home.root().join("first"), home.root().join("gate"), home.root().join("answered"));
        gated_child(&home, &first, &gate, &answered);
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { first_wait: Duration::from_millis(300), ..Timing::default() };
        let (client_in, _sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        welcome(&mut s, "rt1");
        let failed = control_payload(&mut s);
        assert_eq!((failed["op"].as_str(), failed["status"].as_str()), (Some("client"), Some("failed")), "{failed}");
        assert_eq!(
            failed["why"].as_str(),
            Some("the check of the client's setup did not finish in the 10 s the shared runtime waits for it"),
            "{failed}"
        );
        // (the first run answers now: never sent; the next control frame is the answer to an ask)
        fs::write(&gate, "").unwrap();
        until_file(&answered);
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"conditions?","seq":7}"#, BIG).unwrap();
        let next = control_payload(&mut s);
        assert_eq!(next["seq"].as_u64(), Some(7), "the late first answer was sent: {next}");
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    // the failed first frame's why reaches the hand-over as the client's reason
    #[test]
    fn a_first_run_past_the_wait_hands_over_with_its_why() {
        let (home, sock) = home();
        let (first, gate, answered) =
            (home.root().join("first"), home.root().join("gate"), home.root().join("answered"));
        gated_child(&home, &first, &gate, &answered);
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { first_wait: Duration::from_millis(300), ..Timing::default() };
        let (client_in, _sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        let failed = control_payload(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"own-runtime","reason":"conditions-failed"}"#, BIG)
            .unwrap();
        let Exit::OwnRuntime { code, why, .. } = done.join().unwrap() else { panic!("not handed over") };
        assert_eq!((code.as_deref(), why.as_deref()), (Some("conditions-failed"), failed["why"].as_str()));
        fs::write(&gate, "").unwrap();
        drop(client_in);
    }

    // a first run given up at the wait after the welcome holds no slot: a conditions? ask after it runs at once, never
    // behind the run still going
    #[test]
    fn a_first_run_given_up_never_holds_up_a_later_run() {
        let (home, sock) = home();
        let (first, gate, answered) =
            (home.root().join("first"), home.root().join("gate"), home.root().join("answered"));
        gated_child(&home, &first, &gate, &answered);
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { first_wait: Duration::from_millis(300), ..Timing::default() };
        let (client_in, _sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        // (an answer that never comes fails the test, never hangs it)
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        welcome(&mut s, "rt1");
        assert_eq!(control_payload(&mut s)["status"], "failed", "the first frame, at the wait");
        settled(&mut s);
        // (the first run still waits at its gate: the ask's own run answers regardless)
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"conditions?","seq":5}"#, BIG).unwrap();
        let c = control_payload(&mut s);
        assert_eq!((c["seq"].as_u64(), c["status"].as_str()), (Some(5), Some("ok")), "{c}");
        assert!(!answered.exists(), "the first run answered first: the ask waited for it");
        fs::write(&gate, "").unwrap();
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    /// A child script that counts its conditions runs (the script is the stand-in daemon too, whose starts are not
    /// counted) and says the count in its repo field; with `gate`, the first run waits until it exists.
    fn counting_child(home: &Home, runs: &std::path::Path, gate: Option<&std::path::Path>) {
        let wait = gate.map_or(String::new(), |g| {
            format!(
                "[ \"$1\" = conditions ] && [ ! -s '{r}' ] && while [ ! -e '{g}' ]; do sleep 0.02; done\n",
                r = runs.display(),
                g = g.display()
            )
        });
        let script = format!(
            r#"{wait}[ "$1" = conditions ] && echo x >> '{0}'
printf '{{"status":"ok","conditions":"no","repo":"run-%s","token":null}}\n' "$(( $(wc -l < '{0}') ))"
"#,
            runs.display()
        );
        fs::write(home.root().join("ch-local.sh"), script).unwrap();
    }

    /// Relay with a short attach (no socket at first: unreachable), roomy enough for a slow machine's handshake; its
    /// background retries `retry_unit` apart (5, 10, 30, 30 of them).
    fn start_unreachable(home: Home, retry_unit: Duration) -> (UnixStream, Sink, thread::JoinHandle<Exit>) {
        let timing = Timing {
            attach: Duration::from_secs(1),
            cold_attach: Duration::from_secs(1),
            retry_unit,
            ..Timing::default()
        };
        start_with(home, timing)
    }

    /// Writes a request and waits (bounded) for its answer: the shim is unreachable once it is answered.
    fn until_unreachable(client_in: &mut UnixStream, sink: &Sink) {
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}\n").unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        while sink.lines().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            sink.lines().first().is_some_and(|l| l.contains("could not reach its shared runtime")),
            "{:?}",
            sink.lines()
        );
    }

    // an early answer kept while the runtime could not be reached is never a later connection's first frame: that one is
    // a fresh run's (the client's setup may have changed meanwhile); kept before the shim was unreachable, or arriving
    // while it is
    #[test]
    fn an_early_answer_kept_while_unreachable_is_dropped_for_a_fresh_run() {
        for gated in [false, true] {
            let (home, sock) = home();
            let (runs, gate) = (home.root().join("runs"), home.root().join("gate"));
            counting_child(&home, &runs, gated.then_some(gate.as_path()));
            // (gated: the first run answers while the shim is unreachable, and no retry may be attaching then, or the
            // answer, kept outside Unreachable, would be a retry's first frame: the first retry 5 s on, well clear)
            let unit = if gated { Duration::from_secs(1) } else { Duration::from_millis(100) };
            let (mut client_in, sink, done) = start_unreachable(home, unit);
            until_unreachable(&mut client_in, &sink);
            if gated {
                // (the first run answers only now, while the shim is unreachable)
                fs::write(&gate, "").unwrap();
                until_file(&runs);
            }
            let listener = UnixListener::bind(&sock).unwrap();
            let (mut s, _) = listener.accept().unwrap();
            welcome(&mut s, "rt1");
            let first = control_payload(&mut s);
            assert_eq!(first["repo"].as_str(), Some("run-2"), "gated {gated}: a fresh run, not the one kept: {first}");
            settled(&mut s);
            drop(client_in);
            until_op(&mut s, "bye");
            drop(s);
            done.join().unwrap();
        }
    }

    // an early answer that comes after its connection was lost, before the reattach, is kept for the reattach: no second
    // cold run
    #[test]
    fn an_early_answer_after_a_lost_connection_is_kept_for_the_reattach() {
        let (home, sock) = home();
        let (runs, gate) = (home.root().join("runs"), home.root().join("gate"));
        counting_child(&home, &runs, Some(&gate));
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { retry_unit: Duration::from_millis(50), ..Timing::default() };
        let (client_in, _sink, done) = start_with(home, timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        // (lost before the first run answers; it answers now, with no connection)
        drop(s);
        fs::write(&gate, "").unwrap();
        until_file(&runs);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        let first = control_payload(&mut s);
        assert_eq!(first["repo"].as_str(), Some("run-1"), "the kept answer, no second run: {first}");
        settled(&mut s);
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
    }

    // stdin at EOF at once: the relay ends in microseconds; killing its children then (as main does) leaves none running,
    // the first run's spawn under way included, and none spawned after
    #[test]
    fn a_relay_ended_at_once_leaves_no_child_after_kill_all() {
        let (home, _sock) = home();
        let pid = home.root().join("child.pid");
        // (only the conditions run writes it: the script is the stand-in daemon too, which outlives the shim by design)
        child_script(
            &home,
            &format!(
                "[ \"$1\" = conditions ] || exit 0; echo $$ > '{p}.part' && mv '{p}.part' '{p}'; exec sleep 30",
                p = pid.display()
            ),
        );
        let (client_in, input) = UnixStream::pair().unwrap();
        drop(client_in);
        let relay = Relay::new(
            Setup { home, rest: vec![], client_env: vec![], parent: 1, timing: Timing::default() },
            Out::new(Box::new(Sink::default())),
        );
        let children = relay.children();
        let _ = relay.run(input);
        children.kill_all();
        // (a child spawned before the kill wrote its pid, and is gone; none spawned after writes one)
        let until = Instant::now() + Duration::from_secs(2);
        while !pid.exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        if let Ok(p) = fs::read_to_string(&pid) {
            let p: i32 = p.trim().parse().unwrap();
            let gone = rustix::process::test_kill_process(rustix::process::Pid::from_raw(p).unwrap()).is_err();
            assert!(gone, "the child {p} outlived the relay");
        }
    }

    // #236 section 5, ch-local #60: why the session runs its own reaches
    // `ch-local start` as --own-runtime-reason and, for conditions-failed only,
    // the shim's own words of its failed first `client` frame
    #[test]
    fn own_runtime_conditions_failed_carries_the_shims_own_failed_frame_why() {
        let (home, sock) = home();
        // the conditions child fails: the first client frame is status failed
        fs::write(home.root().join("ch-local.sh"), "exit 3\n").unwrap();
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        let first = control_payload(&mut s);
        assert_eq!(first["status"], "failed", "{first}");
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"own-runtime","reason":"conditions-failed"}"#, BIG)
            .unwrap();
        let Exit::OwnRuntime { code, why, .. } = done.join().unwrap() else { panic!("not handed over") };
        assert_eq!(code.as_deref(), Some("conditions-failed"));
        assert_eq!(why.as_deref(), first["why"].as_str(), "the frame's own why");
        let flags = own_runtime_flags(code.as_deref(), why.as_deref());
        assert_eq!(
            flags[..3],
            [OsString::from("--own-runtime-reason"), "conditions-failed".into(), "--own-runtime-why".into()]
        );
        drop(client_in);
    }

    #[test]
    fn own_runtime_conditions_failed_with_an_ok_first_frame_carries_no_why() {
        // (the runtime's other cause for it: a malformed credentials key)
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (client_in, _sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        assert_eq!(control_payload(&mut s)["status"], "ok");
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"own-runtime","reason":"conditions-failed"}"#, BIG)
            .unwrap();
        let Exit::OwnRuntime { code, why, .. } = done.join().unwrap() else { panic!("not handed over") };
        assert_eq!((code.as_deref(), why), (Some("conditions-failed"), None));
        assert_eq!(
            own_runtime_flags(code.as_deref(), None),
            vec![OsString::from("--own-runtime-reason"), "conditions-failed".into()]
        );
        drop(client_in);
    }

    #[test]
    fn own_runtime_flags_pass_only_a_token_and_clean_words() {
        assert_eq!(reason_token(Some("credential")), "credential");
        for bad in [
            None,
            Some(""),
            Some("Token"),
            Some("--home"),
            Some("a b"),
            Some("x".repeat(33).as_str()),
            Some("t\u{202E}k"),
        ] {
            assert_eq!(reason_token(bad), "unknown", "{bad:?}");
        }
        assert_eq!(own_runtime_flags(None, Some("x")), Vec::<OsString>::new(), "no op, no flags");
        let messy = format!("--home /x\u{7}\u{202E}evil\n{}", "y".repeat(400));
        let flags = own_runtime_flags(Some("conditions-failed"), Some(&messy));
        let w = flags[3].to_str().unwrap();
        assert!(!w.starts_with('-'), "never read as an option: {w}");
        assert!(w.chars().count() <= 200, "cut: {}", w.chars().count());
        assert!(!w.chars().any(|c| c.is_control() || c == '\u{202E}'), "cleaned: {w:?}");
        assert!(w.starts_with("home /x"), "{w}");
        assert_eq!(clean_why("---\u{7}  "), None, "nothing left: no flag");
        assert_eq!(own_runtime_flags(Some("token"), Some("--")).len(), 2, "no why flag when nothing is left");
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

    // MCP completeness section 13: a cancelled call has no answer, so the
    // runtime sends `cancelled` with its seq and the shim forgets it: no
    // crash answer is made for it, and a close waiting on it ends at once.
    #[test]
    fn a_cancelled_seq_is_forgotten_with_no_crash_answer_and_a_close_waiting_on_it_ends_at_once() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        drop(client_in);
        // the close waits on the call: no bye while it is in flight
        let started = Instant::now();
        let op = format!(r#"{{"op":"cancelled","seq":{}}}"#, seq.unwrap());
        frame::write_frame(&mut s, Kind::Control, op.as_bytes(), BIG).unwrap();
        // settled, nothing is in flight: the bye, at once
        until_op(&mut s, "bye");
        assert!(matches!(done.join().unwrap(), Exit::Done));
        assert!(started.elapsed() < Duration::from_secs(2), "at once, not at the 10 s grace: {:?}", started.elapsed());
        assert_eq!(sink.lines(), Vec::<String>::new(), "no answer and no crash answer for a cancelled call");
    }

    // The runtime ends a session at once on its bye (countinghouse
    // lib/session-transport/listener.js: shut() and _end('bye'), its
    // per-session workers stopped with it), so a bye sent at the stdin's close
    // ended every call still in flight, which then had only crash answers
    // (ch-local #72's acceptance run). The bye waits for them, within the
    // closing grace: this fake runtime closes the connection the moment a bye
    // arrives, as the real one does, and answers the call 300 ms after the
    // close, which the client must get.
    #[test]
    fn at_the_stdin_close_a_call_in_flight_gets_its_answer_before_the_bye_which_ends_the_session() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        drop(client_in);
        // the real runtime's way with a bye: the session ends, the connection with it
        s.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        // (a byte read here is a bye come early, and fails the test anyway)
        let mut head = [0u8; 1];
        let early = match s.read(&mut head) {
            Ok(n) => n > 0,
            Err(e) => !matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut),
        };
        assert!(!early, "nothing (no bye) while the call is in flight");
        s.set_read_timeout(None).unwrap();
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":5,"result":{"ran":true}}"#);
        // then the bye, and the session ends on it
        until_op(&mut s, "bye");
        drop(s);
        assert!(matches!(done.join().unwrap(), Exit::Done));
        assert_eq!(
            sink.lines(),
            [r#"{"jsonrpc":"2.0","id":5,"result":{"ran":true}}"#],
            "the call's own answer, no crash answer"
        );
    }

    #[test]
    fn a_cancelled_op_for_an_unknown_seq_is_ignored_and_answers_still_relay() {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"cancelled","seq":999}"#, BIG).unwrap();
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"cancelled"}"#, BIG).unwrap();
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"a\"}\n").unwrap();
        let (seq, _) = read_m(&mut s);
        reply(&mut s, seq.unwrap(), r#"{"jsonrpc":"2.0","id":6,"result":{}}"#);
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        until_op(&mut s, "bye");
        drop(s);
        done.join().unwrap();
        assert_eq!(sink.lines(), [r#"{"jsonrpc":"2.0","id":6,"result":{}}"#]);
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
        until_op(&mut s3, "client");
        settled(&mut s3);
        // (the replay, on settled)
        let (kind, len) = frame::read_head(&mut s3, BIG).unwrap();
        let mut p = vec![0u8; len as usize];
        s3.read_exact(&mut p).unwrap();
        assert_eq!(kind, Kind::Control);
        assert_eq!(String::from_utf8(p).unwrap(), r#"{"op":"replay","entries":[{ "z": 1,  "a" : [ 1.0, 2e0 ] }]}"#);
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

    /// A per-session runtime that answers every request by id, in order; its
    /// initialize's answer declares `caps` (a JS object literal). What a
    /// handover tells its client: the replayed initialize's answer dropped,
    /// the list notices its capabilities allow, then the held request's answer.
    fn handed_over_with(caps: &str) -> Option<Vec<String>> {
        let node = node()?;
        let (home, _sock) = home();
        let echo = home.root().join("echo.js");
        fs::write(&echo, format!("require('readline').createInterface({{input: process.stdin}}).on('line', (l) => {{ const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify({{jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? {{method: m.method, capabilities: {caps}}} : {{method: m.method}}}}) + '\\n'); }});\n")).unwrap();
        let shim = serde_json::json!({"node": node, "chLocal": echo, "env": {"PATH": "/usr/bin:/bin"}});
        private(&home.root().join("shim.json"), shim.to_string().as_bytes());
        let sink = Sink::default();
        let init = br#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","method":"initialize","params":{}}"#.to_vec();
        let held = vec![br#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#.to_vec()];
        let out = Out::new(Box::new(sink.clone()));
        let code =
            own_runtime_to(&home, &[], held, std::iter::empty(), Some((init, "ch-shim-replay-1".into())), out).unwrap();
        assert_eq!(code, 0);
        Some(sink.lines())
    }

    #[test]
    fn the_replayed_initializes_answer_is_dropped_and_the_rest_passes() {
        let Some(lines) = handed_over_with(
            "{tools: {listChanged: true}, prompts: {listChanged: true}, resources: {listChanged: true}}",
        ) else {
            return eprintln!("no node on PATH: skipped");
        };
        assert_eq!(
            lines,
            [
                r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}"#,
                r#"{"jsonrpc":"2.0","id":5,"result":{"method":"tools/list"}}"#
            ],
            "once this runtime serves, the client hears its lists may be others; then only its own answer"
        );
    }

    /// A runtime from before R-cold-prompts declares `{}` for its prompts and
    /// resources: its client is told only of its tools (a server sends
    /// list_changed only for a list it declared).
    #[test]
    fn a_handed_over_runtime_that_declares_no_listchanged_for_prompts_or_resources_tells_only_the_tools() {
        let Some(lines) = handed_over_with("{tools: {listChanged: true}, prompts: {}, resources: {}}") else {
            return eprintln!("no node on PATH: skipped");
        };
        assert_eq!(
            lines,
            [
                r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#,
                r#"{"jsonrpc":"2.0","id":5,"result":{"method":"tools/list"}}"#
            ]
        );
    }

    /// A client whose initialize was crash-answered sends it again, to the
    /// runtime it is handed to: that one hears no replay of it.
    #[test]
    fn an_initialize_never_answered_is_not_replayed_to_the_sessions_own_runtime() {
        for live in [false, true] {
            let (home, sock) = home();
            let listener = UnixListener::bind(&sock).unwrap();
            let (mut client_in, sink, done) = start(home);
            let (mut s, _) = listener.accept().unwrap();
            welcome(&mut s, "rt1");
            until_op(&mut s, "client");
            settled(&mut s);
            client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{}}\n").unwrap();
            read_m(&mut s);
            let mut on = s;
            if !live {
                drop(on);
                on = listener.accept().unwrap().0;
                welcome(&mut on, "rt2");
                until_op(&mut on, "client");
            }
            frame::write_frame(&mut on, Kind::Control, br#"{"op":"own-runtime","reason":"token"}"#, BIG).unwrap();
            let Exit::OwnRuntime { replay, .. } = done.join().unwrap() else { panic!("not handed over") };
            assert!(replay.is_none(), "live: {live}");
            let lines = sink.lines();
            assert_eq!(lines.len(), 1, "its crash answer only: {lines:?}");
            drop(client_in);
        }
    }

    /// A client slow to read what it is told first: the runtime's answers,
    /// written before it ended, still reach it.
    #[test]
    fn a_client_slow_to_take_the_notice_still_gets_the_answers_behind_it() {
        struct Slow(Sink);
        impl Write for Slow {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                if self.0.0.lock().unwrap().is_empty() {
                    thread::sleep(PUMP_DRAIN + PUMP_DRAIN + Duration::from_millis(500));
                }
                self.0.write(b)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let (home, _sock) = home();
        if !echo_runtime(&home, "") {
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
            Out::new(Box::new(Slow(sink.clone()))),
        )
        .unwrap();
        // (the three lists' notices, then its answer)
        assert_eq!(sink.lines().len(), 4, "{:?}", sink.lines());
    }

    /// The replayed initialize refused: the runtime serves no tools, and the
    /// client is told of none.
    #[test]
    fn a_replayed_initialize_answered_with_an_error_announces_nothing() {
        let Some(node) = node() else { return eprintln!("no node on PATH: skipped") };
        let (home, _sock) = home();
        let echo = home.root().join("echo.js");
        fs::write(&echo, "require('readline').createInterface({input: process.stdin}).on('line', (l) => { const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify(m.method === 'initialize' ? {jsonrpc: '2.0', id: m.id, error: {code: -32602, message: 'no'}} : {jsonrpc: '2.0', id: m.id, result: {method: m.method}}) + '\\n'); });\n").unwrap();
        let shim = serde_json::json!({"node": node, "chLocal": echo, "env": {"PATH": "/usr/bin:/bin"}});
        private(&home.root().join("shim.json"), shim.to_string().as_bytes());
        let sink = Sink::default();
        let init = br#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","method":"initialize","params":{}}"#.to_vec();
        let held = vec![br#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#.to_vec()];
        let out = Out::new(Box::new(sink.clone()));
        let code =
            own_runtime_to(&home, &[], held, std::iter::empty(), Some((init, "ch-shim-replay-1".into())), out).unwrap();
        assert_eq!(code, 0);
        assert_eq!(sink.lines(), [r#"{"jsonrpc":"2.0","id":5,"result":{"method":"tools/list"}}"#]);
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
        fs::write(&echo, format!("{before}\nrequire('readline').createInterface({{input: process.stdin}}).on('line', (l) => {{ const m = JSON.parse(l); if (m.id !== undefined) process.stdout.write(JSON.stringify({{jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? {{method: m.method, capabilities: {{tools: {{listChanged: true}}, prompts: {{listChanged: true}}, resources: {{listChanged: true}}}}}} : {{method: m.method}}}}) + '\\n'); }});\n")).unwrap();
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
    fn the_drain_waits_while_a_write_to_a_slow_client_is_under_way_and_no_longer_than_its_cap() {
        let (_tx, done) = mpsc::channel::<()>();
        let p = Arc::new(Progress::default());
        p.writing.store(true, Ordering::Relaxed);
        let q = p.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(800));
            q.writing.store(false, Ordering::Relaxed);
        });
        let started = Instant::now();
        drain(&done, &p, Duration::from_millis(200), Duration::from_secs(5));
        let took = started.elapsed();
        t.join().unwrap();
        assert!(took >= Duration::from_millis(800), "waited for the write: {took:?}");
        assert!(took < Duration::from_millis(1500), "then the idle wait only: {took:?}");
        p.writing.store(true, Ordering::Relaxed);
        let started = Instant::now();
        drain(&done, &p, Duration::from_millis(100), Duration::from_millis(600));
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(600) && took < Duration::from_millis(1000), "the cap: {took:?}");
    }

    // L2: output still arriving after the runtime exits is waited for while
    // it keeps coming (here 6 lines, 600 ms apart: 3.6 s, past PUMP_DRAIN)
    #[test]
    fn output_still_trickling_after_the_runtime_exits_is_all_relayed() {
        let (home, _sock) = home();
        let tick = "let i = 0; const t = setInterval(() => { process.stdout.write(JSON.stringify({jsonrpc: '2.0', method: 'tick', params: {i}}) + '\\n'); if (++i === 6) clearInterval(t); }, 600);";
        let js = format!(
            "require('child_process').spawn(process.execPath, ['-e', {}], {{stdio: ['ignore', 'inherit', 'ignore']}}); setTimeout(() => process.exit(0), 300);",
            serde_json::to_string(tick).unwrap()
        );
        if !echo_runtime(&home, &js) {
            return eprintln!("no node on PATH: skipped");
        }
        let sink = Sink::default();
        let init = br#"{"jsonrpc":"2.0","id":"ch-shim-replay-1","method":"initialize"}"#.to_vec();
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
        let ticks = sink.lines().iter().filter(|l| l.contains("\"tick\"")).count();
        assert_eq!(ticks, 6, "every line the runtime's output carried: {:?}", sink.lines());
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
        assert_eq!(lines.len(), 5, "{} lines", lines.len());
        let big: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(big["params"]["x"].as_str().map(str::len), Some(3 << 20), "the big line, whole");
        assert_eq!(lines[1], r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#);
        assert_eq!(lines[2], r#"{"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}"#);
        assert_eq!(lines[3], r#"{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}"#);
        assert_eq!(lines[4], r#"{"jsonrpc":"2.0","id":5,"result":{"method":"tools/list"}}"#);
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

    // A1 (never looser): mid-session, the runtime's own-runtime op is the
    // same fallback as failed.json's, so a session holding records refuses
    fn own_runtime_mid_session(record: &str) -> (Exit, Vec<String>) {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let (mut client_in, sink, done) = start(home);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, record.as_bytes(), BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"own-runtime","reason":"token"}"#, BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"a\"}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(client_in);
        let exit = done.join().unwrap();
        drop(s);
        (exit, sink.lines())
    }

    #[test]
    fn own_runtime_mid_session_with_a_record_refuses_rather_than_hand_over() {
        let (exit, lines) = own_runtime_mid_session(r#"{"op":"record","entry":{"tighten":"x"}}"#);
        assert!(matches!(exit, Exit::Refused), "a session holding records must not move to a runtime without them");
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let want = v["sessionCantFallBackAnswer"]["json"].as_str().unwrap().replace("\"id\":7", "\"id\":4");
        assert_eq!(lines, [want]);
    }

    #[test]
    fn own_runtime_mid_session_after_a_record_too_big_to_keep_refuses_too() {
        // L3: the record wasn't kept, but the tightening it carried exists
        let big = format!(r#"{{"op":"record","entry":"{}"}}"#, "x".repeat(crate::records::MAX_BYTES));
        let (exit, lines) = own_runtime_mid_session(&big);
        assert!(matches!(exit, Exit::Refused), "a dropped record still counts");
        let v: Value = serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).unwrap();
        let want = v["sessionCantFallBackAnswer"]["json"].as_str().unwrap().replace("\"id\":7", "\"id\":4");
        assert_eq!(lines, [want]);
    }

    #[test]
    fn own_runtime_mid_session_after_forget_hands_over_as_before() {
        let (exit, _) = own_runtime_mid_session(r#"{"op":"forget"}"#);
        assert!(matches!(exit, Exit::OwnRuntime { .. }), "no records: the hand-over, as now");
    }

    #[test]
    fn own_runtime_mid_session_after_a_record_that_cant_be_read_refuses_too() {
        // a record frame without an entry: its tightening is lost all the same
        let (exit, _) = own_runtime_mid_session(r#"{"op":"record","entri":{"tighten":"x"}}"#);
        assert!(matches!(exit, Exit::Refused));
    }

    // An EOF deferred during the reattach of a session with records, then an
    // attach that succeeds: the end follows what the runtime does
    type Deferred = (Exit, Vec<String>, Vec<(Option<u64>, Vec<u8>)>, Duration);

    fn eof_deferred_then_attached(settle: bool) -> Deferred {
        let (home, sock) = home();
        let listener = UnixListener::bind(&sock).unwrap();
        let timing = Timing { settle: Duration::from_millis(500), ..Timing::default() };
        let (mut client_in, sink, done) = start_with(home.clone(), timing);
        let (mut s, _) = listener.accept().unwrap();
        welcome(&mut s, "rt1");
        until_op(&mut s, "client");
        settled(&mut s);
        frame::write_frame(&mut s, Kind::Control, br#"{"op":"record","entry":{"tighten":"x"}}"#, BIG).unwrap();
        thread::sleep(Duration::from_millis(100));
        drop(s); // lost: the backoff waits before the reattach
        thread::sleep(Duration::from_millis(100));
        client_in.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"a\"}\n").unwrap();
        drop(client_in); // EOF inside the backoff: deferred until the attach decides
        let (mut s2, _) = listener.accept().unwrap();
        welcome(&mut s2, "rt2");
        let started = Instant::now();
        let mut seen = Vec::new();
        if settle {
            until_op(&mut s2, "client");
            settled(&mut s2);
            seen = until_op(&mut s2, "bye");
        } else {
            // never settled: the connection is closed at the settle deadline
            while frame::read_frame(&mut s2, BIG).is_ok() {}
        }
        let exit = done.join().unwrap();
        let took = started.elapsed();
        drop(s2);
        (exit, sink.lines(), seen, took)
    }

    // L1: it ends at the settle deadline, not reattaching for ever
    #[test]
    fn eof_deferred_then_an_attach_that_never_settles_ends_at_the_settle_deadline() {
        let (exit, lines, _, took) = eof_deferred_then_attached(false);
        assert!(matches!(exit, Exit::Done));
        assert!(took < Duration::from_secs(10), "ended at the deadline, took {took:?}");
        assert_eq!(lines.len(), 1, "the held request is answered once: {lines:?}");
        assert!(lines[0].contains("\"id\":4"));
    }

    // and a runtime that does settle still gets the held request
    #[test]
    fn eof_deferred_then_an_attach_that_settles_still_forwards_the_held_request() {
        let (exit, _, seen, _) = eof_deferred_then_attached(true);
        assert!(matches!(exit, Exit::Done), "an ordinary end: answered, then bye");
        assert!(
            seen.iter().any(|(_, body)| body.windows(6).any(|w| w == b"\"id\":4")),
            "id 4 reached the runtime before bye: {seen:?}"
        );
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
