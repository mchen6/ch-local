//! ch-shim: the per-session shim of countinghouse's shared runtime.
//!
//! The wire contract is countinghouse's
//! `docs/superpowers/specs/2026-11-15-shared-runtime-design.md`, section 1
//! (contract 2), with its conformance vectors in
//! `shared-runtime-wire/vectors.json`. SCAFFOLD: the parts of the contract
//! that need no I/O; the I/O (the trust checks, the handshake, the relay)
//! comes next, under its own security review.

#![forbid(unsafe_code)]

pub mod answer;
pub mod frame;
pub mod inflight;
pub mod mac;
pub mod message;
pub mod secret;

#[cfg(test)]
mod conformance;
