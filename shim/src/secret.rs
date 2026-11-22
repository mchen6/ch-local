//! The runtime's secret: read from its file (64 lowercase hex characters,
//! optionally followed by one newline), held as a Secret that never prints
//! and is zeroed when dropped. The owner and mode checks on the file and
//! its directory, and the reading of it, are the trust module's
//! (`config.rs` reads it with `trust::read_private_in`); parse is the only
//! way to make a Secret.

use zeroize::Zeroize;

pub struct Secret([u8; 32]);

impl Secret {
    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SecretError {
    Length(usize),
    NotLowercaseHex,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::Length(n) => write!(f, "the secret file holds {n} bytes, not 64 hex characters"),
            SecretError::NotLowercaseHex => write!(f, "the secret file is not 64 lowercase hex characters"),
        }
    }
}

/// The secret from its file's contents.
pub fn parse(contents: &[u8]) -> Result<Secret, SecretError> {
    let hex = contents.strip_suffix(b"\n").unwrap_or(contents);
    if hex.len() != 64 {
        return Err(SecretError::Length(contents.len()));
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = Secret([0u8; 32]);
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        match (digit(pair[0]), digit(pair[1])) {
            (Some(h), Some(l)) => out.0[i] = (h << 4) | l,
            _ => return Err(SecretError::NotLowercaseHex),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_secret_never_prints() {
        let s = super::parse(&[b'a'; 64]).unwrap();
        assert_eq!(format!("{s:?}"), "Secret(redacted)");
    }
}
