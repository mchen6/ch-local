//! The handshake, over any connection: HELLO, PROVE, AUTH, then WELCOME or
//! REFUSED (contract 2, section 1). Each side proves the secret, and the
//! secret is never sent. A PROVE whose `ms` doesn't check closes the
//! connection with nothing more sent on it: no AUTH, and no client byte.

use std::io::{Read, Write};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::Value;

use crate::frame::{self, Caps, FrameError, Kind};
use crate::mac;
use crate::secret::Secret;

/// The protocol this shim speaks: HELLO's `protocol`, and `p` in both MACs.
pub const PROTOCOL: u8 = 1;

/// Before WELCOME no M frame may arrive; read_frame refuses one anyway.
const PRE_WELCOME: Caps = Caps { message: 0 };

/// What a WELCOME grants.
#[derive(Debug, PartialEq)]
pub struct Welcome {
    pub session: String,
    pub resume_token: String,
    pub runtime_version: String,
    /// The M cap toward the runtime, and from it, each clamped.
    pub to_runtime: Caps,
    pub to_shim: Caps,
}

/// A REFUSED's code, and what the shim then does (the spec's table).
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// `mc` didn't match: re-read daemon.json and the secret, and retry
    /// within the 20 s (a runtime that restarted has a new secret).
    BadProof,
    /// The runtime speaks another protocol: stop; the shim and the runtime
    /// are different releases.
    Protocol,
    /// The resume token is unknown, used, or its session still connected:
    /// open a new session (no `resume`) on a new connection, and replay.
    ResumeRefused,
    /// The session limit: retry with jitter.
    Busy,
    /// The runtime is draining: retry with jitter.
    ShuttingDown,
    /// A code this shim doesn't know: stop, naming it.
    Unknown(String),
}

impl Refusal {
    fn of(code: &str) -> Refusal {
        match code {
            "BAD_PROOF" => Refusal::BadProof,
            "PROTOCOL" => Refusal::Protocol,
            "RESUME_REFUSED" => Refusal::ResumeRefused,
            "BUSY" => Refusal::Busy,
            "SHUTTING_DOWN" => Refusal::ShuttingDown,
            other => Refusal::Unknown(other.to_string()),
        }
    }
}

#[derive(Debug)]
pub enum HandshakeError {
    Frame(FrameError),
    /// A frame of a kind not allowed at this point (an M or C before
    /// WELCOME, a second PROVE): the connection is closed.
    Unexpected(Kind),
    /// A PROVE, WELCOME or REFUSED that isn't the JSON the contract says.
    Malformed(&'static str),
    /// The PROVE's `ms` didn't check: not our runtime, or one that
    /// restarted with a new secret. Nothing more was sent.
    WrongProof,
    Refused {
        refusal: Refusal,
        message: String,
    },
}

impl From<FrameError> for HandshakeError {
    fn from(e: FrameError) -> Self {
        HandshakeError::Frame(e)
    }
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::Frame(e) => write!(f, "{e}"),
            HandshakeError::Unexpected(k) => write!(f, "the runtime sent a {k:?} frame during the handshake"),
            HandshakeError::Malformed(what) => write!(f, "the runtime's {what} is not what the contract says"),
            HandshakeError::WrongProof => write!(f, "the runtime could not prove it holds this home's secret"),
            HandshakeError::Refused { refusal, message } => {
                write!(f, "the runtime refused the session ({refusal:?}): {message}")
            }
        }
    }
}

fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("a string serialises")
}

/// HELLO's payload: compact JSON, `protocol` then `nc`.
pub fn hello(nc: &[u8; 32]) -> Vec<u8> {
    format!("{{\"protocol\":{PROTOCOL},\"nc\":\"{}\"}}", b64(nc)).into_bytes()
}

/// AUTH's payload: `mc`, then `resume` when the shim holds a token.
pub fn auth(mc: &[u8; 32], resume: Option<&str>) -> Vec<u8> {
    match resume {
        Some(t) => format!("{{\"mc\":\"{}\",\"resume\":{}}}", b64(mc), json_string(t)).into_bytes(),
        None => format!("{{\"mc\":\"{}\"}}", b64(mc)).into_bytes(),
    }
}

fn object(payload: &[u8], what: &'static str) -> Result<serde_json::Map<String, Value>, HandshakeError> {
    match serde_json::from_slice::<Value>(payload) {
        Ok(Value::Object(o)) => Ok(o),
        _ => Err(HandshakeError::Malformed(what)),
    }
}

fn bytes32(o: &serde_json::Map<String, Value>, key: &str, what: &'static str) -> Result<[u8; 32], HandshakeError> {
    let s = o.get(key).and_then(Value::as_str).ok_or(HandshakeError::Malformed(what))?;
    let v = B64.decode(s).map_err(|_| HandshakeError::Malformed(what))?;
    v.try_into().map_err(|_| HandshakeError::Malformed(what))
}

fn string(o: &serde_json::Map<String, Value>, key: &str, what: &'static str) -> Result<String, HandshakeError> {
    o.get(key).and_then(Value::as_str).map(String::from).ok_or(HandshakeError::Malformed(what))
}

fn welcome(payload: &[u8]) -> Result<Welcome, HandshakeError> {
    let o = object(payload, "WELCOME")?;
    let cap = |key: &str| o.get(key).and_then(Value::as_u64).ok_or(HandshakeError::Malformed("WELCOME"));
    Ok(Welcome {
        session: string(&o, "session", "WELCOME")?,
        resume_token: string(&o, "resumeToken", "WELCOME")?,
        runtime_version: string(&o, "runtimeVersion", "WELCOME")?,
        to_runtime: Caps::message_from(cap("maxToRuntime")?),
        to_shim: Caps::message_from(cap("maxToShim")?),
    })
}

/// Makes the handshake on `conn`. `nc` is 32 bytes from the OS (the caller
/// draws them), `resume` the last WELCOME's token if the shim holds one.
pub fn attach<S: Read + Write>(
    conn: &mut S,
    secret: &Secret,
    nc: [u8; 32],
    resume: Option<&str>,
) -> Result<Welcome, HandshakeError> {
    frame::write_frame(conn, Kind::Hello, &hello(&nc), PRE_WELCOME)?;
    let (kind, payload) = frame::read_frame(conn, PRE_WELCOME)?;
    if kind != Kind::Prove {
        return Err(match kind {
            Kind::Refused => refused(&payload),
            other => HandshakeError::Unexpected(other),
        });
    }
    let prove = object(&payload, "PROVE")?;
    let ns = bytes32(&prove, "ns", "PROVE")?;
    let ms = bytes32(&prove, "ms", "PROVE")?;
    if !mac::server_proof_ok(secret, PROTOCOL, &nc, &ns, &ms) {
        return Err(HandshakeError::WrongProof);
    }
    let mc = mac::client_proof(secret, PROTOCOL, &nc, &ns);
    frame::write_frame(conn, Kind::Auth, &auth(&mc, resume), PRE_WELCOME)?;
    let (kind, payload) = frame::read_frame(conn, PRE_WELCOME)?;
    match kind {
        Kind::Welcome => welcome(&payload),
        Kind::Refused => Err(refused(&payload)),
        other => Err(HandshakeError::Unexpected(other)),
    }
}

fn refused(payload: &[u8]) -> HandshakeError {
    match object(payload, "REFUSED") {
        Ok(o) => HandshakeError::Refused {
            refusal: Refusal::of(o.get("code").and_then(Value::as_str).unwrap_or("")),
            message: o.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
        },
        Err(e) => e,
    }
}
