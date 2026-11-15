//! The secret file: 64 lowercase hex characters, optionally followed by one
//! newline; the secret is the 32 bytes they encode. (The owner and mode
//! checks on the file and its directory are separate, in `trust`, still to
//! come: revision 4's Windows check is under review.)

#[derive(Debug, PartialEq, Eq)]
pub enum SecretError {
    Length(usize),
    NotLowercaseHex,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Length(n) => {
                write!(f, "the secret file holds {n} bytes, not 64 hex characters")
            }
            SecretError::NotLowercaseHex => {
                write!(f, "the secret file is not 64 lowercase hex characters")
            }
        }
    }
}

pub fn parse(contents: &[u8]) -> Result<[u8; 32], SecretError> {
    let hex = contents.strip_suffix(b"\n").unwrap_or(contents);
    if hex.len() != 64 {
        return Err(SecretError::Length(contents.len()));
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        let (hi, lo) = (digit(pair[0]), digit(pair[1]));
        match (hi, lo) {
            (Some(h), Some(l)) => out[i] = (h << 4) | l,
            _ => return Err(SecretError::NotLowercaseHex),
        }
    }
    Ok(out)
}
