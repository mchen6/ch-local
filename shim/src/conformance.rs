//! countinghouse's conformance vectors (contract 2), copied from its
//! docs/superpowers/specs/shared-runtime-wire/vectors.json. In the crate, so
//! the test-only proof (mac::server_proof) and Secret's bytes are reachable.

use serde_json::Value;

use crate::{answer, frame, mac, message, secret};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../tests/vectors/contract-2.json")).expect("the vectors parse")
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

fn b32(s: &str) -> [u8; 32] {
    hex(s).try_into().expect("32 bytes")
}

fn secret_of(hex_str: &str) -> secret::Secret {
    secret::parse(hex_str.as_bytes()).expect("the vectors' secret")
}

const CAPS: frame::Caps = frame::Caps { message: 1 << 20 };

#[test]
fn the_contract_is_2() {
    assert_eq!(vectors()["contract"], 2);
}

#[test]
fn the_secret_files_accepted_and_refused_forms() {
    let v = vectors();
    let want = b32(v["secretFile"]["secretHex"].as_str().unwrap());
    for ok in v["secretFiles"]["accepted"].as_array().unwrap() {
        let s = secret::parse(ok.as_str().unwrap().as_bytes()).unwrap_or_else(|e| panic!("{ok}: {e}"));
        assert_eq!(s.bytes(), &want, "{ok}");
    }
    for bad in v["secretFiles"]["refused"].as_array().unwrap() {
        assert!(secret::parse(bad.as_str().unwrap().as_bytes()).is_err(), "{bad}");
    }
}

#[test]
fn ms_and_mc_carry_the_protocol() {
    let h = &vectors()["handshake"];
    let s = secret_of(h["secretHex"].as_str().unwrap());
    let (nc, ns) = (b32(h["ncHex"].as_str().unwrap()), b32(h["nsHex"].as_str().unwrap()));
    let p = h["protocol"].as_u64().unwrap() as u8;
    let ms = hex(h["msHex"].as_str().unwrap());
    assert_eq!(mac::server_proof(&s, p, &nc, &ns).to_vec(), ms);
    assert!(mac::server_proof_ok(&s, p, &nc, &ns, &ms));
    assert!(!mac::server_proof_ok(&s, p + 1, &nc, &ns, &ms), "a proof for another protocol");
    let mut wrong = ms.clone();
    wrong[0] ^= 0x01;
    assert!(!mac::server_proof_ok(&s, p, &nc, &ns, &wrong), "the case: a PROVE whose ms is wrong");
    assert_eq!(mac::client_proof(&s, p, &nc, &ns).to_vec(), hex(h["mcHex"].as_str().unwrap()));
}

#[test]
fn the_token_mac() {
    use base64::Engine;
    let v = vectors();
    let s = secret_of(v["handshake"]["secretHex"].as_str().unwrap());
    let got = mac::token_mac(&s, v["tokenMac"]["token"].as_str().unwrap());
    assert_eq!(base64::engine::general_purpose::STANDARD.encode(got), v["tokenMac"]["macB64"].as_str().unwrap());
}

#[test]
fn every_handshake_frame_reads_back_as_its_json() {
    for (name, f) in vectors()["handshake"]["frames"].as_object().unwrap() {
        let bytes = hex(f["hex"].as_str().unwrap());
        let (kind, payload) = frame::read_frame(&mut &bytes[..], CAPS).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(payload, f["json"].as_str().unwrap().as_bytes(), "{name}");
        assert_eq!(frame::encode(kind, &payload, CAPS).unwrap(), bytes, "{name}");
    }
}

#[test]
fn every_control_frame_reads_back_as_its_json() {
    for (name, f) in vectors()["control"].as_object().unwrap() {
        let bytes = hex(f["hex"].as_str().unwrap());
        let (kind, payload) = frame::read_frame(&mut &bytes[..], CAPS).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(kind, frame::Kind::Control, "{name}");
        assert_eq!(payload, f["json"].as_str().unwrap().as_bytes(), "{name}");
    }
}

#[test]
fn over_cap_unknown_and_whole_m_frames_are_refused_before_their_payload() {
    let head = |kind: u8, len: u32| {
        let mut h = vec![kind];
        h.extend_from_slice(&len.to_be_bytes());
        h
    };
    assert!(
        matches!(frame::read_frame(&mut &head(b'H', 508)[..], CAPS), Err(frame::FrameError::OverCap { .. })),
        "HELLO over 507"
    );
    assert!(matches!(frame::read_frame(&mut &head(b'P', 4097)[..], CAPS), Err(frame::FrameError::OverCap { .. })));
    assert!(matches!(frame::read_frame(&mut &head(b'C', 65537)[..], CAPS), Err(frame::FrameError::OverCap { .. })));
    assert!(matches!(frame::read_frame(&mut &head(b'Z', 2)[..], CAPS), Err(frame::FrameError::UnknownKind(b'Z'))));
    assert!(matches!(
        frame::read_head(&mut &head(b'M', 17)[..], frame::Caps { message: 16 }),
        Err(frame::FrameError::OverCap { .. })
    ));
    assert!(
        matches!(frame::read_frame(&mut &head(b'M', 0)[..], CAPS), Err(frame::FrameError::MessageNotWhole)),
        "an M is streamed"
    );
}

#[test]
fn an_encode_over_cap_is_refused_never_truncated() {
    assert!(matches!(frame::encode(frame::Kind::Hello, &[b'x'; 508], CAPS), Err(frame::FrameError::OverCap { .. })));
    assert!(frame::encode(frame::Kind::Hello, &[b'x'; 507], CAPS).is_ok());
}

#[test]
fn a_welcomes_grant_is_clamped() {
    assert_eq!(frame::Caps::message_from(u64::MAX).message, frame::MESSAGE_CAP_CEILING);
    assert_eq!(frame::Caps::message_from(8_392_704).message, 8_392_704);
}

fn payload_of(hexed: &str) -> Vec<u8> {
    let bytes = hex(hexed);
    let (_, len) = frame::read_head(&mut &bytes[..], CAPS).expect("a frame");
    assert_eq!(bytes.len(), 5 + len as usize);
    bytes[5..].to_vec()
}

#[test]
fn requests_batches_and_notifications_to_the_runtime() {
    let m = &vectors()["messages"];
    for (name, seq) in [
        ("requestToRuntime", Some(1)),
        ("oddIdToRuntime", Some(2)),
        ("batchToRuntime", Some(3)),
        ("notificationToRuntime", None),
    ] {
        let line = m[name]["line"].as_str().unwrap().as_bytes();
        assert_eq!(
            message::to_runtime(seq, line, CAPS.message).unwrap(),
            payload_of(m[name]["hex"].as_str().unwrap()),
            "{name}"
        );
        let keep = &m[name]["keep"];
        match message::classify(line) {
            message::Line::Request { id, method } => {
                assert_eq!(id, keep["idBytes"].as_str().unwrap().as_bytes(), "{name}");
                assert_eq!(method.as_deref(), keep["method"].as_str(), "{name}");
            }
            message::Line::Batch { ids } => {
                let want: Vec<Vec<u8>> = keep["memberIdBytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().as_bytes().to_vec())
                    .collect();
                assert_eq!(ids, want, "{name}");
            }
            message::Line::Response => panic!("{name}: a request taken for a response"),
            message::Line::Plain => assert!(seq.is_none(), "{name}"),
        }
    }
}

#[test]
fn a_newline_inside_a_string_is_never_in_a_line() {
    // JSON text carries no unescaped 0x0a, so a line split on it is whole
    let line = br#"{"jsonrpc":"2.0","id":1,"method":"x","params":{"t":"a\nb"}}"#;
    assert!(!line.contains(&b'\n'));
    assert!(matches!(message::classify(line), message::Line::Request { .. }));
}

#[test]
fn replies_and_notifications_to_the_shim() {
    let m = &vectors()["messages"];
    for (name, seq) in [("replyToShim", Some(1)), ("unmatchedReplyToShim", Some(99)), ("notificationToShim", None)] {
        let p = payload_of(m[name]["hex"].as_str().unwrap());
        let (got, body) = message::from_runtime(&p).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(got, seq, "{name}");
        assert_eq!(body, m[name]["line"].as_str().unwrap().as_bytes(), "{name}");
    }
}

#[test]
fn malformed_payloads_close_the_connection() {
    let bad = &vectors()["messages"]["malformed"];
    for (name, want) in [
        ("payloadUnder2Bytes", message::Malformed::Under2Bytes),
        ("headerLongerThanPayload", message::Malformed::HeaderPastEnd),
        ("headerNotAnObject", message::Malformed::HeaderNotAnObject),
        ("seqNotAnInteger", message::Malformed::SeqNotAnInteger),
    ] {
        let p = payload_of(bad[name].as_str().unwrap());
        assert_eq!(message::from_runtime(&p).err(), Some(want), "{name}");
    }
}

#[test]
fn the_crash_answer() {
    let c = &vectors()["crashAnswer"];
    assert_eq!(answer::crash(b"7", true), c["json"].as_str().unwrap().as_bytes());
    let batch: Value =
        serde_json::from_slice(&answer::crash_batch(&[b"1".to_vec(), b"\"b\"".to_vec()], true).unwrap()).unwrap();
    assert_eq!(batch[1]["id"], "b");
    assert_eq!(answer::crash_batch(&[], true), None, "a batch of notifications only is answered with nothing");
}
