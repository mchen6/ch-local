//! Frames: one kind byte (an ASCII letter), a 4-byte big-endian payload
//! length, then the payload. A receiver checks the length against the
//! kind's cap before it reads the payload, and closes on an over-cap length
//! or an unknown kind.

use std::io::{self, Read, Write};

/// HELLO's cap: the whole frame (5-byte head and payload) within the 512
/// bytes the runtime reads before HELLO is complete.
pub const HELLO_CAP: u32 = 507;
/// The other handshake frames' cap.
pub const HANDSHAKE_CAP: u32 = 4096;
/// Control frames' cap.
pub const CONTROL_CAP: u32 = 65536;
/// The most a WELCOME may grant an M frame, either way: 1 GiB. A WELCOME
/// asking for more is clamped to it (the spec's largest, maxToShim, is
/// twice 256 MiB plus 1 MiB).
pub const MESSAGE_CAP_CEILING: u32 = 1 << 30;

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
/// direction being read, clamped (Caps::message_from). Which kinds may
/// arrive at all (no M or C before WELCOME, no second HELLO or AUTH) is the
/// connection's state, checked by its caller, never a cap: a zero-length
/// frame passes any cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub message: u32,
}

impl Caps {
    /// The M cap from a WELCOME's `maxToRuntime` or `maxToShim`, clamped to
    /// MESSAGE_CAP_CEILING whatever the runtime asks.
    pub fn message_from(granted: u64) -> Caps {
        Caps { message: granted.min(MESSAGE_CAP_CEILING as u64) as u32 }
    }

    pub fn of(self, kind: Kind) -> u32 {
        match kind {
            Kind::Message => self.message,
            Kind::Control => CONTROL_CAP,
            Kind::Hello => HELLO_CAP,
            _ => HANDSHAKE_CAP,
        }
    }
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    UnknownKind(u8),
    OverCap {
        kind: Kind,
        length: u64,
        cap: u32,
    },
    /// read_frame was asked for an M frame, which is streamed instead.
    MessageNotWhole,
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
                write!(f, "a {kind:?} frame of {length} bytes, over its cap of {cap}")
            }
            FrameError::MessageNotWhole => write!(f, "an M frame is streamed, never read whole"),
        }
    }
}

fn length_within(kind: Kind, len: usize, caps: Caps) -> Result<u32, FrameError> {
    let cap = caps.of(kind);
    match u32::try_from(len) {
        Ok(n) if n <= cap => Ok(n),
        _ => Err(FrameError::OverCap { kind, length: len as u64, cap }),
    }
}

/// A frame's bytes, refused (never truncated) when the payload is over the
/// kind's cap.
pub fn encode(kind: Kind, payload: &[u8], caps: Caps) -> Result<Vec<u8>, FrameError> {
    let n = length_within(kind, payload.len(), caps)?;
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind.byte());
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn write_frame<W: Write>(w: &mut W, kind: Kind, payload: &[u8], caps: Caps) -> Result<(), FrameError> {
    let n = length_within(kind, payload.len(), caps)?;
    let mut head = [0u8; 5];
    head[0] = kind.byte();
    head[1..].copy_from_slice(&n.to_be_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()?;
    Ok(())
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
        return Err(FrameError::OverCap { kind, length: length as u64, cap });
    }
    Ok((kind, length))
}

/// Reads one whole handshake or control frame (their caps are small). An M
/// frame is refused here: it is streamed (read_head, then message::read_header).
pub fn read_frame<R: Read>(r: &mut R, caps: Caps) -> Result<(Kind, Vec<u8>), FrameError> {
    let (kind, length) = read_head(r, caps)?;
    if kind == Kind::Message {
        return Err(FrameError::MessageNotWhole);
    }
    let mut payload = vec![0u8; length as usize];
    r.read_exact(&mut payload)?;
    Ok((kind, payload))
}
