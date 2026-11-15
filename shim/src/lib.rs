//! ch-shim: the per-session shim of countinghouse's shared runtime.
//!
//! The wire contract is countinghouse's
//! `docs/superpowers/specs/2026-11-15-shared-runtime-design.md`, section 1,
//! with its conformance vectors in `shared-runtime-wire/vectors.json`.
//! SCAFFOLD: written against contract 2 (the spec's revision 5), which is
//! still under review, so nothing here is final until it is approved.

pub mod answer;
pub mod frame;
pub mod mac;
pub mod message;
pub mod secret;
