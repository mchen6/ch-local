//! The handshake's proofs and the client token's MAC, all HMAC-SHA256 under
//! the runtime's secret. `p` is HELLO's `protocol` as one byte, so a proof
//! made for one protocol is never accepted for another. The shim only
//! checks ms (it never makes one): server_proof is for the tests.

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::secret::Secret;

type HmacSha256 = Hmac<Sha256>;

fn mac(secret: &Secret, parts: &[&[u8]]) -> HmacSha256 {
    let mut m = HmacSha256::new_from_slice(secret.bytes()).expect("HMAC takes a key of any length");
    for p in parts {
        m.update(p);
    }
    m
}

/// ms = HMAC-SHA256(secret, "ch-server" || p || nc || ns)
#[cfg(test)]
pub(crate) fn server_proof(secret: &Secret, protocol: u8, nc: &[u8; 32], ns: &[u8; 32]) -> [u8; 32] {
    mac(secret, &[b"ch-server", &[protocol], nc, ns]).finalize().into_bytes().into()
}

/// Checks a PROVE's `ms` in constant time.
pub fn server_proof_ok(secret: &Secret, protocol: u8, nc: &[u8; 32], ns: &[u8; 32], ms: &[u8]) -> bool {
    mac(secret, &[b"ch-server", &[protocol], nc, ns]).verify_slice(ms).is_ok()
}

/// mc = HMAC-SHA256(secret, "ch-client" || p || ns || nc)
pub fn client_proof(secret: &Secret, protocol: u8, nc: &[u8; 32], ns: &[u8; 32]) -> [u8; 32] {
    mac(secret, &[b"ch-client", &[protocol], ns, nc]).finalize().into_bytes().into()
}

/// HMAC-SHA256(secret, "ch-token" || the token's UTF-8 bytes)
pub fn token_mac(secret: &Secret, token: &str) -> [u8; 32] {
    mac(secret, &[b"ch-token", token.as_bytes()]).finalize().into_bytes().into()
}
