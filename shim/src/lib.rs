//! ch-shim: the per-session shim of countinghouse's shared runtime.
//!
//! The wire contract is countinghouse's
//! `docs/superpowers/specs/2026-11-15-shared-runtime-design.md`, section 1
//! (contract 2), with its conformance vectors in
//! `shared-runtime-wire/vectors.json`. SCAFFOLD: the parts of the contract
//! that need no I/O; the I/O (the trust checks, the handshake, the relay)
//! comes next, under its own security review.

// unsafe is denied everywhere; the two exceptions (reviewer, 2026-11-14)
// are win_ffi (Windows) and unix_ffi (POSIX), which allow it block by block.
#![deny(unsafe_code)]

pub mod answer;
pub mod attach;
pub mod child;
pub mod config;
pub mod daemon;
pub mod endpoint;
pub mod failed;
pub mod frame;
pub mod handshake;
pub mod held;
pub mod inflight;
pub mod lines;
pub mod lock;
pub mod mac;
pub mod message;
pub mod out;
pub mod process;
pub mod reader;
pub mod records;
pub mod relay;
pub mod secret;
pub mod trust;
#[cfg(unix)]
#[allow(unsafe_code)]
pub mod unix_ffi;
#[cfg(windows)]
#[allow(unsafe_code)]
pub(crate) mod win_ffi;

#[cfg(test)]
mod conformance;
