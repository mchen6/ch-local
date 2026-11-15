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

// The line a vector gives: `line` as text, or `lineHex` for bytes that are
// not UTF-8.
fn line_of(v: &Value) -> Vec<u8> {
    match v["lineHex"].as_str() {
        Some(h) => hex(h),
        None => v["line"].as_str().unwrap().as_bytes().to_vec(),
    }
}

#[test]
fn the_parser_edges_requests_by_any_method_and_unescaped_names_lines_refused_go_plain() {
    let m = &vectors()["messages"];
    let mut seq = 0;
    for (name, want_seq) in [
        ("nonStringMethod", Some(4)),
        ("escapedIdKey", Some(5)),
        ("loneSurrogateKey", None),
        ("invalidUtf8", None),
        ("clientResponseToRuntime", None),
    ] {
        let line = line_of(&m[name]);
        let class = message::classify(&line);
        match want_seq {
            Some(_) => assert!(matches!(class, message::Line::Request { .. }), "{name}: {class:?}"),
            None if name == "clientResponseToRuntime" => assert_eq!(class, message::Line::Response, "{name}"),
            None => assert_eq!(class, message::Line::Plain, "{name}"),
        }
        assert_eq!(
            m[name]["header"].as_object().and_then(|h| h["seq"].as_u64()),
            want_seq,
            "{name}: the vector's header"
        );
        if let Some(h) = m[name]["hex"].as_str() {
            assert_eq!(message::to_runtime(want_seq, &line, CAPS.message).unwrap(), payload_of(h), "{name}");
        }
        seq += 1;
    }
    assert_eq!(seq, 5);
}

#[test]
fn the_drain_overflow_answer() {
    let d = &vectors()["drainOverflowAnswer"];
    assert_eq!(answer::crash(b"7", false), d["json"].as_str().unwrap().as_bytes());
}

/// A connection for the handshake tests: the runtime's frames, given in
/// advance, are read; what the shim writes is kept.
struct Scripted {
    from_runtime: std::io::Cursor<Vec<u8>>,
    to_runtime: Vec<u8>,
}

impl std::io::Read for Scripted {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.from_runtime.read(buf)
    }
}

impl std::io::Write for Scripted {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.to_runtime.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn scripted(frames: &[Vec<u8>]) -> Scripted {
    Scripted { from_runtime: std::io::Cursor::new(frames.concat()), to_runtime: Vec::new() }
}

fn frame_hex(name: &str) -> Vec<u8> {
    hex(vectors()["handshake"]["frames"][name]["hex"].as_str().unwrap())
}

fn handshake_inputs() -> (secret::Secret, [u8; 32]) {
    let h = &vectors()["handshake"];
    (secret_of(h["secretHex"].as_str().unwrap()), b32(h["ncHex"].as_str().unwrap()))
}

#[test]
fn the_handshake_writes_the_vectors_hello_and_auth_and_reads_welcome() {
    use crate::handshake;
    let (s, nc) = handshake_inputs();
    let mut conn = scripted(&[frame_hex("prove"), frame_hex("welcome")]);
    let w = handshake::attach(&mut conn, &s, nc, None).unwrap();
    assert_eq!(conn.to_runtime, [frame_hex("hello"), frame_hex("auth")].concat());
    assert_eq!((w.session.as_str(), w.resume_token.as_str()), ("s_example_session", "rt_example_resume_value"));
    assert_eq!((w.to_runtime.message, w.to_shim.message), (8_392_704, 537_919_488));
}

#[test]
fn a_resume_is_sent_as_the_vector_says() {
    use crate::handshake;
    let (s, nc) = handshake_inputs();
    let mut conn = scripted(&[frame_hex("prove"), frame_hex("welcome")]);
    handshake::attach(&mut conn, &s, nc, Some("rt_example_resume_value")).unwrap();
    assert_eq!(conn.to_runtime, [frame_hex("hello"), frame_hex("authResume")].concat());
}

#[test]
fn a_prove_whose_ms_is_wrong_ends_it_with_no_auth_sent() {
    use crate::handshake;
    let (s, nc) = handshake_inputs();
    let prove = vectors()["handshake"]["frames"]["prove"]["json"].as_str().unwrap().to_string();
    let mut p: serde_json::Map<String, Value> = serde_json::from_str(&prove).unwrap();
    use base64::Engine;
    let mut ms = base64::engine::general_purpose::STANDARD.decode(p["ms"].as_str().unwrap()).unwrap();
    ms[0] ^= 0x01;
    p.insert("ms".into(), Value::String(base64::engine::general_purpose::STANDARD.encode(ms)));
    let bad = frame::encode(frame::Kind::Prove, serde_json::to_string(&p).unwrap().as_bytes(), CAPS).unwrap();
    let mut conn = scripted(&[bad, frame_hex("welcome")]);
    assert!(matches!(handshake::attach(&mut conn, &s, nc, None), Err(handshake::HandshakeError::WrongProof)));
    assert_eq!(conn.to_runtime, frame_hex("hello"), "nothing after HELLO");
}

#[test]
fn a_refused_auth_names_its_code() {
    use crate::handshake::{self, HandshakeError, Refusal};
    let (s, nc) = handshake_inputs();
    let mut conn = scripted(&[frame_hex("prove"), frame_hex("refused")]);
    match handshake::attach(&mut conn, &s, nc, None) {
        Err(HandshakeError::Refused { refusal: Refusal::BadProof, .. }) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn every_refused_code_maps_to_its_action() {
    use crate::handshake::{self, HandshakeError, Refusal};
    let (s, nc) = handshake_inputs();
    for (code, want) in [
        ("PROTOCOL", Refusal::Protocol),
        ("RESUME_REFUSED", Refusal::ResumeRefused),
        ("BUSY", Refusal::Busy),
        ("SHUTTING_DOWN", Refusal::ShuttingDown),
        ("SOMETHING_NEW", Refusal::Unknown("SOMETHING_NEW".into())),
    ] {
        let r =
            frame::encode(frame::Kind::Refused, format!("{{\"code\":\"{code}\",\"message\":\"m\"}}").as_bytes(), CAPS)
                .unwrap();
        // a REFUSED may come at once (PROTOCOL), or after AUTH
        for frames in [vec![r.clone()], vec![frame_hex("prove"), r.clone()]] {
            let mut conn = scripted(&frames);
            match handshake::attach(&mut conn, &s, nc, None) {
                Err(HandshakeError::Refused { refusal, .. }) => assert_eq!(refusal, want, "{code}"),
                other => panic!("{code}: {other:?}"),
            }
        }
    }
}

#[test]
fn an_m_or_c_frame_before_welcome_closes_it() {
    use crate::handshake::{self, HandshakeError};
    let (s, nc) = handshake_inputs();
    let c = frame::encode(frame::Kind::Control, b"{\"op\":\"drain\"}", CAPS).unwrap();
    let mut conn = scripted(&[frame_hex("prove"), c]);
    assert!(matches!(
        handshake::attach(&mut conn, &s, nc, None),
        Err(HandshakeError::Unexpected(frame::Kind::Control))
    ));
    let m = vec![b'M', 0, 0, 0, 2, 0, 0];
    let mut conn = scripted(&[frame_hex("prove"), m]);
    assert!(matches!(
        handshake::attach(&mut conn, &s, nc, None),
        Err(HandshakeError::Frame(frame::FrameError::OverCap { .. } | frame::FrameError::MessageNotWhole))
    ));
}
