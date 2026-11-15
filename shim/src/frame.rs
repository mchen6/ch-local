//! Frames: one kind byte (an ASCII letter), a 4-byte big-endian payload
//! length, then the payload. A receiver checks the length against the
//! kind's cap before it reads the payload, and closes on an over-cap length
//! or an unknown kind.

use std::io::{self, Read, Write};

/// The handshake frames' cap, and the control frames'.
pub const HANDSHAKE_CAP: u32 = 4096;
pub const CONTROL_CAP: u32 = 65536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Hello,
    Prove,
    Auth,
    Welcome,
    Refused,
    Message,
    Control,
}

impl Kind {
    pub fn byte(self) -> u8 {
        match self {
            Kind::Hello => b'H',
            Kind::Prove => b'P',
            Kind::Auth => b'A',
            Kind::Welcome => b'W',
            Kind::Refused => b'R',
            Kind::Message => b'M',
            Kind::Control => b'C',
        }
    }

    pub fn from_byte(b: u8) -> Option<Kind> {
        Some(match b {
            b'H' => Kind::Hello,
            b'P' => Kind::Prove,
            b'A' => Kind::Auth,
            b'W' => Kind::Welcome,
            b'R' => Kind::Refused,
            b'M' => Kind::Message,
            b'C' => Kind::Control,
            _ => return None,
        })
    }
}

/// The caps a connection enforces. `message` is WELCOME's limit for the
/// direction being read. Which kinds may arrive at all (no M or C before
/// WELCOME, no second HELLO or AUTH) is the connection's state, checked by
/// its caller, never a cap: a zero-length frame passes any cap.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub message: u32,
}

impl Caps {
    pub fn of(self, kind: Kind) -> u32 {
        match kind {
            Kind::Message => self.message,
            Kind::Control => CONTROL_CAP,
            _ => HANDSHAKE_CAP,
        }
    }
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    UnknownKind(u8),
    OverCap { kind: Kind, length: u32, cap: u32 },
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        FrameError::Io(e)
    }
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(e) => write!(f, "{e}"),
            FrameError::UnknownKind(b) => write!(f, "a frame of unknown kind 0x{b:02x}"),
            FrameError::OverCap { kind, length, cap } => {
                write!(f, "a {:?} frame of {length} bytes, over its cap of {cap}", kind)
            }
        }
    }
}

pub fn encode(kind: Kind, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind.byte());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn write_frame<W: Write>(w: &mut W, kind: Kind, payload: &[u8]) -> io::Result<()> {
    let mut head = [0u8; 5];
    head[0] = kind.byte();
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

/// Reads a frame's 5-byte head and checks its kind and its length against
/// the kind's cap, reading nothing of the payload. An M payload (up to
/// maxToShim) is then streamed by its reader (message::read_header, then
/// the rest copied out), never held whole.
pub fn read_head<R: Read>(r: &mut R, caps: Caps) -> Result<(Kind, u32), FrameError> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let kind = Kind::from_byte(head[0]).ok_or(FrameError::UnknownKind(head[0]))?;
    let length = u32::from_be_bytes([head[1], head[2], head[3], head[4]]);
    let cap = caps.of(kind);
    if length > cap {
        return Err(FrameError::OverCap { kind, length, cap });
    }
    Ok((kind, length))
}

/// Reads one whole frame: for the handshake and control kinds, whose caps
/// are small. The payload is read only once its length is within the cap.
pub fn read_frame<R: Read>(r: &mut R, caps: Caps) -> Result<(Kind, Vec<u8>), FrameError> {
    let (kind, length) = read_head(r, caps)?;
    let mut payload = vec![0u8; length as usize];
    r.read_exact(&mut payload)?;
    Ok((kind, payload))
}
