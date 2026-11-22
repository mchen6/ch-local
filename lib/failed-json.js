'use strict';
// failed.json read by the shim's own rule (shim/src/failed.rs; its vectors
// are shim/tests/vectors/contract-2.json failedJson), so what status and
// restart say about it is what a session does with it: a file a session
// ignores -- stale, from the future, of another shape -- is no "gave up"
// (the medium on the closing pass, 1). Exactly {v, at, exit, signal,
// reason}, none extra, missing or twice; at most 512 bytes; fresh when
// now - 600000 <= at <= now + 60000.
const MAX_BYTES = 512;
const FRESH_PAST_MS = 600000;
const FRESH_FUTURE_MS = 60000;
const KEYS = ['v', 'at', 'exit', 'signal', 'reason'];
const REASONS = ['restarts-exhausted', 'never-listened'];

// (bytes, now ms) -> the reason, or null
function parse(bytes, now) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return null;
  const text = bytes.toString('utf8');
  let j;
  try { j = JSON.parse(text); } catch (e) { return null; }
  if (j == null || typeof j !== 'object' || Array.isArray(j)) return null;
  const keys = Object.keys(j);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return null;
  // (JSON.parse keeps the last of a key twice; the shim refuses it: each
  // key counted in the text, as a key -- no value can hold a quote here)
  for (const k of KEYS) if ((text.match(new RegExp(`"${k}"\\s*:`, 'g')) || []).length !== 1) return null;
  if (j.v !== 1) return null;
  if (!Number.isSafeInteger(j.at) || j.at < 1) return null;
  if (j.exit !== null && !Number.isSafeInteger(j.exit)) return null;
  if (j.signal !== null && !(typeof j.signal === 'string' && /^SIG[A-Z0-9]+$/.test(j.signal))) return null;
  if (!REASONS.includes(j.reason)) return null;
  return now - FRESH_PAST_MS <= j.at && j.at <= now + FRESH_FUTURE_MS ? j.reason : null;
}

// <runDir>/failed.json with daemon.json's trust checks (the private read),
// judged at now -> the reason, or null
function read(runDir, now = Date.now()) {
  let bytes;
  try { bytes = require('./private-file').readPrivateIn(runDir, 'failed.json', MAX_BYTES + 1); } catch (e) { return null; }
  return parse(bytes, now);
}

module.exports = {parse, read, MAX_BYTES, FRESH_PAST_MS, FRESH_FUTURE_MS};
