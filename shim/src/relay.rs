//! The relay: one session's state machine (the relay design; contract 2,
//! section 1 "Messages", "Control", "Holding until settled", "The crash
//! answer"; section 5; section 6 "Reconnecting"). Every other thread (stdin,
//! the connection reader, attach, the conditions child, timers) only sends
//! events into one channel; this loop alone changes state.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{self, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
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
}

enum Ev {
    Stdin(lines::Read),
    Reader { generation: u64, event: reader::Event },
    Attached(Result<Attached, AttachError>),
    Client { generation: u64, frame: Vec<u8> },
    Retry,
}

#[derive(Debug, PartialEq)]
enum State {
    Attaching,
    Unsettled,
    Live,
    Draining,
    Unreachable(String),
    Closing(Instant),
}

pub struct Relay {
    setup: Setup,
    tx: Sender<Ev>,
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
    records: Records,
    held: Held,
    resume: Option<String>,
    /// The legacy `initialize` line, for the replay after a reconnect.
    initialize: Option<Vec<u8>>,
    replays: u64,
    reconnecting: bool,
    retries: usize,
    stdin_done: bool,
}

/// How the relay ended.
pub enum Exit {
    Done,
    /// The session can't be shared: run the per-session runtime, handing it
    /// these held lines first, then the rest of the client's lines.
    OwnRuntime {
        reason: String,
        held: Vec<Vec<u8>>,
        rest: Rest,
    },
}

/// The rest of the client's lines, still arriving from the relay's stdin
/// reader, after the relay has handed the session over.
pub struct Rest(Receiver<Ev>);

impl Iterator for Rest {
    type Item = Vec<u8>;
    fn next(&mut self) -> Option<Vec<u8>> {
        loop {
            match self.0.recv().ok()? {
                Ev::Stdin(lines::Read::Line(l)) => return Some(l),
                Ev::Stdin(lines::Read::Eof) => return None,
                // a line too long for the shared runtime goes nowhere; nor do
                // the old connection's late events
                _ => {}
            }
        }
    }
}

impl Relay {
    pub fn new(setup: Setup, out: Out) -> Relay {
        let (tx, rx) = mpsc::channel();
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
            records: Records::default(),
            held: Held::default(),
            resume: None,
            initialize: None,
            replays: 0,
            reconnecting: false,
            retries: 0,
            stdin_done: false,
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
        let (tx, home, resume) = (self.tx.clone(), self.setup.home.clone(), self.resume.clone());
        thread::spawn(move || {
            let _ = tx.send(Ev::Attached(attach::attach(&home, resume.as_deref())));
        });
    }

    fn on(&mut self, ev: Ev) -> Option<Exit> {
        match ev {
            Ev::Stdin(lines::Read::Line(line)) => self.line(line),
            Ev::Stdin(lines::Read::TooLong(_)) => self.say(&answer::too_long(self.limit.get())),
            Ev::Stdin(lines::Read::Eof) => return self.eof(),
            Ev::Attached(Ok(a)) => self.attached(a),
            Ev::Attached(Err(e)) => self.unreachable(e.to_string()),
            Ev::Retry => {
                if matches!(self.state, State::Unreachable(_)) {
                    self.attach();
                }
            }
            Ev::Client { generation, frame } if generation == self.generation => self.control(&frame),
            Ev::Client { .. } => {}
            Ev::Reader { generation, .. } if generation != self.generation => {}
            Ev::Reader { event: reader::Event::Answered(_), .. } => {
                if matches!(self.state, State::Closing(_)) && self.inflight.lock().expect("in-flight lock").is_empty() {
                    return Some(self.finish());
                }
            }
            Ev::Reader { event: reader::Event::Control(op), .. } => return self.op(op),
            Ev::Reader { event: reader::Event::Lost(why), .. } => return self.lost(why),
        }
        None
    }

    /// One whole message of the shim's own to the client.
    fn say(&self, bytes: &[u8]) {
        let _ = self.out.message(bytes);
    }

    fn control(&mut self, payload: &[u8]) {
        if let Some(w) = self.writer.as_mut() {
            // a failed write is the connection's loss, which the reader reports
            let _ = frame::write_frame(w, Kind::Control, payload, Caps { message: 0 });
        }
    }

    fn line(&mut self, line: Vec<u8>) {
        match &self.state {
            State::Live => self.forward(line),
            State::Unreachable(why) => {
                let why = why.clone();
                self.answer_unreachable(&line, &why);
            }
            State::Closing(_) => {}
            State::Attaching | State::Unsettled | State::Draining => {
                if let Err(over) = self.held.hold(line, self.to_runtime.message as usize) {
                    self.overflow(over);
                }
            }
        }
    }

    fn overflow(&self, over: Overflow) {
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

    fn answer_unreachable(&self, line: &[u8], why: &str) {
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

    fn forward(&mut self, line: Vec<u8>) {
        let class = message::classify(&line);
        let seq = match &class {
            Line::Request { id, method } => {
                if method.as_deref() == Some("initialize") {
                    self.initialize = Some(line.clone());
                }
                match self.seq.take() {
                    Some(n) => {
                        if self.inflight.lock().expect("in-flight lock").track(n, &class).is_err() {
                            self.say(&answer::too_many(id));
                            return;
                        }
                        Some(n)
                    }
                    None => {
                        self.say(&answer::too_many(id));
                        return;
                    }
                }
            }
            Line::Batch { .. } => {
                let Some(n) = self.seq.take() else { return };
                if self.inflight.lock().expect("in-flight lock").track(n, &class).is_err() {
                    if let Line::Batch { ids } = &class {
                        self.overflow(Overflow { ids: ids.clone(), batch: true });
                    }
                    return;
                }
                Some(n)
            }
            Line::Response | Line::Plain => None,
        };
        let Ok(payload) = message::to_runtime(seq, &line, self.to_runtime.message) else {
            self.say(&answer::too_long(self.limit.get()));
            return;
        };
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
        let shared = Shared { inflight: self.inflight.clone(), dropped: self.dropped.clone(), out: self.out.clone() };
        let from_runtime = a.welcome.to_shim;
        let (rtx, rrx) = mpsc::channel();
        thread::spawn(move || reader::run(read_half, from_runtime, shared, rtx));
        thread::spawn(move || {
            for event in rrx {
                if tx.send(Ev::Reader { generation, event }).is_err() {
                    return;
                }
            }
        });
        self.writer = Some(a.conn);
        if a.new_session && !self.records.is_empty() {
            let frame = self.records.replay_frame();
            self.control(&frame);
        }
        self.state = if matches!(self.state, State::Closing(_)) { return } else { State::Unsettled };
        self.conditions(None);
    }

    /// Runs the conditions child; its `client` frame goes to this
    /// connection (stale ones are dropped by generation).
    fn conditions(&self, seq: Option<u64>) {
        let (tx, generation, home, parent) =
            (self.tx.clone(), self.generation, self.setup.home.clone(), self.setup.parent);
        let env = child::child_env(self.setup.client_env.clone());
        thread::spawn(move || {
            let printed = match config::read_shim(&home) {
                Ok(shim) => child::run(&shim, parent, env, child::TIMEOUT),
                Err(e) => Err(format!("shim.json: {e}")),
            };
            let _ = tx.send(Ev::Client { generation, frame: child::client_frame(seq, printed) });
        });
    }

    fn op(&mut self, op: Map<String, Value>) -> Option<Exit> {
        match op["op"].as_str().unwrap_or("") {
            "settled" if self.state == State::Unsettled => {
                self.state = State::Live;
                for line in self.held.take() {
                    self.forward(line);
                }
                if self.reconnecting {
                    self.replay_initialize();
                }
                self.reconnecting = false;
            }
            "conditions?" => {
                if let Some(seq) = op.get("seq").and_then(Value::as_u64) {
                    self.conditions(Some(seq));
                }
            }
            "record" => {
                if let Some(entry) = op.get("entry") {
                    if let Ok(raw) = serde_json::value::to_raw_value(entry) {
                        self.records.record(raw);
                    }
                }
            }
            "forget" => self.records.forget(),
            "drain" if self.state == State::Live => self.state = State::Draining,
            "own-runtime" => {
                let reason = op
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(64)
                    .collect();
                self.writer = None;
                let (_, dead) = mpsc::channel();
                let rx = std::mem::replace(&mut self.rx, dead);
                return Some(Exit::OwnRuntime { reason, held: self.held.take(), rest: Rest(rx) });
            }
            _ => {}
        }
        None
    }

    /// The legacy replay (section 6, step 4): the kept initialize line with
    /// the shim's own id, its answer dropped; then notifications/initialized
    /// to the runtime, and tools/list_changed to the client.
    fn replay_initialize(&mut self) {
        let Some(line) = self.initialize.clone() else { return };
        let Ok(Value::Object(mut o)) = serde_json::from_slice::<Value>(&line) else { return };
        self.replays += 1;
        o.insert("id".into(), Value::String(format!("ch-shim-replay-{}", self.replays)));
        let Some(n) = self.seq.take() else { return };
        self.dropped.lock().expect("dropped lock").insert(n);
        let replay = serde_json::to_vec(&Value::Object(o)).expect("JSON serialises");
        if let (Ok(p), Some(w)) = (message::to_runtime(Some(n), &replay, self.to_runtime.message), self.writer.as_mut())
        {
            let _ = frame::write_frame(w, Kind::Message, &p, self.to_runtime);
        }
        let initialized = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        if let (Ok(p), Some(w)) =
            (message::to_runtime(None, initialized, self.to_runtime.message), self.writer.as_mut())
        {
            let _ = frame::write_frame(w, Kind::Message, &p, self.to_runtime);
        }
        self.say(br#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#);
    }

    fn lost(&mut self, why: String) -> Option<Exit> {
        self.writer = None;
        if let State::Closing(_) = self.state {
            return Some(self.finish());
        }
        if self.state != State::Draining {
            // under the in-flight mutex: whatever the reader settled is not here
            for a in self.inflight.lock().expect("in-flight lock").crash_answers() {
                self.say(&a);
            }
        }
        let _ = why;
        self.reconnecting = self.initialize.is_some();
        self.attach();
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
        let wait = RETRIES[self.retries.min(RETRIES.len() - 1)];
        self.retries += 1;
        let tx = self.tx.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(wait));
            let _ = tx.send(Ev::Retry);
        });
    }

    fn eof(&mut self) -> Option<Exit> {
        self.stdin_done = true;
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
        self.control(br#"{"op":"bye"}"#);
        self.state = State::Closing(Instant::now() + CLOSING_GRACE);
        if self.inflight.lock().expect("in-flight lock").is_empty() {
            return Some(self.finish());
        }
        None
    }

    fn finish(&mut self) -> Exit {
        for a in self.inflight.lock().expect("in-flight lock").crash_answers() {
            self.say(&a);
        }
        Exit::Done
    }
}

/// The per-session runtime (section 5): `<node> <chLocal> start --stdio
/// --own-runtime <args>`, the held lines first, then the shim's stdin
/// pumped through; stdout and stderr inherited; the client's env as given.
pub fn own_runtime(
    home: &Home,
    args: &[OsString],
    held: Vec<Vec<u8>>,
    rest: impl Iterator<Item = Vec<u8>> + Send + 'static,
) -> io::Result<i32> {
    let shim = config::read_shim(home).map_err(|e| io::Error::other(e.to_string()))?;
    let mut child: Child = Command::new(&shim.node)
        .arg(&shim.ch_local)
        .args(["start", "--stdio", "--own-runtime"])
        .args(args)
        .stdin(Stdio::piped())
        .spawn()?;
    let mut stdin: ChildStdin = child.stdin.take().expect("piped");
    thread::spawn(move || {
        for line in held.into_iter().chain(rest) {
            if stdin.write_all(&line).and_then(|()| stdin.write_all(b"\n")).is_err() {
                return;
            }
        }
        // dropping stdin closes it: the client's EOF, passed on
    });
    Ok(child.wait()?.code().unwrap_or(1))
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
        let relay =
            Relay::new(Setup { home, rest: vec![], client_env: vec![], parent: 1 }, Out::new(Box::new(sink.clone())));
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
        let relay =
            Relay::new(Setup { home, rest: vec![], client_env: vec![], parent: 1 }, Out::new(Box::new(sink.clone())));
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
}
