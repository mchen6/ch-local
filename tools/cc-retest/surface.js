#!/usr/bin/env node
'use strict';
// Claude Code's config surface, per version, and its diff against the last
// approved version's (the automated re-test for countinghouse's part 3
// confirmation dialog, step 1: no model calls). A new Claude Code version
// must still read hooks only from the places ch-local's scanner looks
// (lib/client-conditions.js); a new environment variable, flag, settings path
// or hook term touching hooks, plugins, settings, managed sources or policy
// keeps it off the tested-client allowlist until a person has looked.
//
//   node tools/cc-retest/surface.js <version>             diff against the newest approved snapshot
//   node tools/cc-retest/surface.js <version> --against <approved version>
//   node tools/cc-retest/surface.js <version> --approve   record its snapshot (after the hand test)
//   ... --approved-dir <dir>                               snapshots elsewhere (a trial run)
//
// Exit: 0 pass, 1 fail (the one-line report says what), 2 could not run.
//
// - Fetched from the npm registry directly: the version's metadata, then
//   the tarball of @anthropic-ai/claude-code and of each platform package
//   in its optionalDependencies (the native binaries). Nothing is installed
//   and no install script runs. Each tarball's sha512 must equal the
//   registry's published dist.integrity, or it is refused.
// - Each tarball is streamed, never written: hashed as it arrives, gunzipped,
//   and each regular file's bytes scanned in chunks. Only entry sizes are
//   read from the tar headers, and no path from it is used. The bytes are
//   data, never run, and at most a few chunks are in memory (the platform
//   packages' native binaries are about 350 MB each).
// - A snapshot (approved/<version>.json) holds only identifiers: variable
//   names, flags, file names and paths, terms. Never a code excerpt (this
//   repository is public).
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const crypto = require('node:crypto');

const PACKAGE = '@anthropic-ai/claude-code';
const REGISTRY = 'https://registry.npmjs.org/';
const APPROVED_DIR = path.join(__dirname, 'approved');
// Bumped whenever extraction changes: a diff never mixes two extractors (the
// last approved version is snapshotted again with this one first).
const EXTRACTOR = 1;
// Claude Code's platform packages carry a native binary each (about 350 MB).
const MAX_UNCOMPRESSED = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const ITEM_MAX = 160;

// What the surface is made of. Each pattern runs over every file's bytes read
// as latin1 (JS bundle and native binary alike; ASCII identifiers read the
// same either way).
const PATTERNS = {
  env: [/(?<![A-Za-z0-9_])(?:CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|ANTHROPIC_[A-Z0-9_]+|(?:DISABLE|ENABLE)_[A-Z0-9_]+)(?![A-Za-z0-9_])/g],
  flags: [/(?<![A-Za-z0-9_-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![A-Za-z0-9_-])/g],
  files: [
    /[A-Za-z0-9_./~%\\-]*settings[A-Za-z0-9_.-]*\.json/gi,
    /\.claude[/\\][A-Za-z0-9_./\\-]+/g,
    /managed-settings[A-Za-z0-9_.-]*/g,
    /\/etc\/claude-code[A-Za-z0-9_./-]*/g,
    /ProgramData\\{1,2}ClaudeCode[A-Za-z0-9_.\\-]*/g,
    /Managed Preferences\/[A-Za-z0-9_.-]+\.plist/g,
    /SOFTWARE\\{1,2}Policies\\{1,2}[A-Za-z0-9_\\]+/gi,
    /[A-Za-z0-9_-]*hooks\.json/g
  ],
  hookTerms: [/(?<![A-Za-z0-9_$])[A-Za-z][A-Za-z0-9]{0,40}(?:[Hh]ook|[Pp]lugin|[Mm]arketplace|[Ee]licit|[Mm]anaged|[Pp]olicy)[A-Za-z0-9]{0,40}(?![A-Za-z0-9_$])/g]
};
// A new item that touches what the part 3 dialog's safety rests on fails the
// version; any new file name or path does.
const TOUCHES = /hook|plugin|setting|managed|policy|marketplace|elicit/i;

const integrityOf = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

const newSets = () => Object.fromEntries(Object.keys(PATTERNS).map((k) => [k, new Set()]));
const sortedSets = (sets) => Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()]));

function addMatches(text, sets, accept) {
  for (const [set, patterns] of Object.entries(PATTERNS)) {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!accept(m.index, m[0].length)) continue;
        // an escape's doubled backslashes as one; a trailing one (a string's escape) dropped
        const item = m[0].replace(/\\{2,}/g, '\\').replace(/\\+$/, '');
        if (item.length >= 3 && item.length <= ITEM_MAX) sets[set].add(item);
      }
    }
  }
}

// One file's bytes, chunk by chunk, into sets. A match is taken only once it
// can't run on into the next chunk; each chunk is read with the previous
// one's last 2 * ITEM_MAX + 1 characters before it, so no identifier is cut,
// and a match at the very start of that carry (whose left context was cut)
// is skipped, as the previous chunk already took it.
function fileScanner(sets) {
  let carry = '';
  let first = true;
  const keep = 2 * ITEM_MAX + 1;
  return {
    write(bytes) {
      const text = carry + bytes.toString('latin1');
      const safe = text.length - ITEM_MAX;
      const fresh = first;
      addMatches(text, sets, (i, len) => (fresh || i > 0) && i + len <= safe);
      carry = text.length > keep ? text.slice(text.length - keep) : text;
      first = first && text.length <= keep;
    },
    end() {
      const fresh = first;
      addMatches(carry, sets, (i) => fresh || i > 0);
      carry = '';
    }
  };
}

// dirs -> {env, flags, files, hookTerms}: sorted, unique identifiers.
function extractSurface(dirs) {
  const sets = newSets();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const f = fileScanner(sets); f.write(fs.readFileSync(p)); f.end(); }
    }
  };
  for (const dir of dirs) walk(dir);
  return sortedSets(sets);
}

// A tarball's bytes (a stream of Buffers), read without writing anything:
// hashed as they come, gunzipped, and each regular file's contents scanned
// into sets. Only names and sizes are read from the headers, and no path is
// used. Capped: entries, and the uncompressed total. Every byte is hashed
// even when the tar can't be read, so a tampered tarball is named as one.
// -> {integrity, error}
async function scanTarball(chunks, sets) {
  const hash = crypto.createHash('sha512');
  const gunzip = zlib.createGunzip();
  let pending = Buffer.alloc(0);
  let state = {kind: 'header'};
  let total = 0;
  let entries = 0;
  const onData = (data) => {
    total += data.length;
    if (total > MAX_UNCOMPRESSED) throw new Error(`over ${MAX_UNCOMPRESSED} bytes uncompressed`);
    pending = pending.length > 0 ? Buffer.concat([pending, data]) : data;
    for (;;) {
      if (state.kind === 'header') {
        if (pending.length < 512) return;
        const h = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (h.every((b) => b === 0)) { state = {kind: 'end'}; continue; }
        const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('a tar header has no size');
        if (++entries > MAX_ENTRIES) throw new Error(`over ${MAX_ENTRIES} entries`);
        const type = String.fromCharCode(h[156]);
        state = {kind: 'data', left: size, pad: (512 - (size % 512)) % 512, scan: (type === '0' || type === '\0') ? fileScanner(sets) : null};
        if (size === 0) { if (state.scan) state.scan.end(); state = {kind: 'pad', left: 0}; }
        continue;
      }
      if (state.kind === 'data') {
        if (pending.length === 0) return;
        const n = Math.min(state.left, pending.length);
        if (state.scan) state.scan.write(pending.subarray(0, n));
        pending = pending.subarray(n);
        state.left -= n;
        if (state.left > 0) return;
        if (state.scan) state.scan.end();
        state = {kind: 'pad', left: state.pad};
        continue;
      }
      if (state.kind === 'pad') {
        const n = Math.min(state.left, pending.length);
        pending = pending.subarray(n);
        state.left -= n;
        if (state.left > 0) return;
        state = {kind: 'header'};
        continue;
      }
      return;   // end: the rest is padding
    }
  };
  const done = new Promise((resolve, reject) => {
    gunzip.on('data', (d) => { try { onData(d); } catch (err) { gunzip.destroy(err); } });
    gunzip.on('error', reject);
    gunzip.on('end', resolve);
  });
  let error = null;
  done.catch((err) => { error = err; });
  for await (const chunk of chunks) {
    const buf = Buffer.from(chunk);
    hash.update(buf);
    if (error == null && !gunzip.destroyed && !gunzip.write(buf)) {
      await new Promise((r) => {
        const go = () => { gunzip.off('drain', go); gunzip.off('error', go); gunzip.off('close', go); r(); };
        gunzip.on('drain', go); gunzip.on('error', go); gunzip.on('close', go);
      });
    }
  }
  if (error == null && !gunzip.destroyed) gunzip.end();
  try { await done; } catch (err) { error = err; }
  return {integrity: 'sha512-' + hash.digest('base64'), error};
}

// approved, current: surfaces -> {failing, added, removed}, each [{set, item}].
function diffSurface(approved, current) {
  const failing = [];
  const added = [];
  const removed = [];
  for (const set of Object.keys(PATTERNS)) {
    const was = new Set((approved && approved[set]) || []);
    const now = new Set((current && current[set]) || []);
    for (const item of now) {
      if (was.has(item)) continue;
      (set === 'files' || TOUCHES.test(item) ? failing : added).push({set, item});
    }
    for (const item of was) if (!now.has(item)) removed.push({set, item});
  }
  return {failing, added, removed};
}

// The version's registry metadata: {tarball, integrity, optionalDependencies}.
async function metadata(name, version, io) {
  const res = await io.fetch(`${REGISTRY}${name.replace('/', '%2F')}/${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`the npm registry answered ${res.status} for ${name}@${version}`);
  const body = await res.json();
  const dist = (body != null) ? body.dist : null;
  if (dist == null || typeof dist.tarball !== 'string' || typeof dist.integrity !== 'string' || !/^sha512-/.test(dist.integrity)) {
    throw new Error(`${name}@${version}: the registry gives no sha512 dist.integrity`);
  }
  return {tarball: dist.tarball, integrity: dist.integrity, optionalDependencies: body.optionalDependencies || {}};
}

// A response body as a stream of chunks: a fetch Response's body, or a
// stand-in's arrayBuffer.
async function* bodyOf(res) {
  if (res.body != null && typeof res.body[Symbol.asyncIterator] === 'function') { yield* res.body; return; }
  if (res.body != null && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) { const {done, value} = await reader.read(); if (done) return; yield value; }
  }
  yield Buffer.from(await res.arrayBuffer());
}

// The version and its platform packages, each tarball streamed: scanned as
// it is hashed, nothing written. A tarball's identifiers count only once its
// sha512 equals the registry's published dist.integrity; any mismatch
// refuses the version. -> {packages: {name: {version, integrity}}, surface}
async function fetchVersion(version, io) {
  const main = await metadata(PACKAGE, version, io);
  const all = [{name: PACKAGE, version, meta: main}];
  for (const [name, range] of Object.entries(main.optionalDependencies)) {
    // a platform package is pinned to an exact version
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range)) throw new Error(`${name}: its version ${range} is not exact`);
    all.push({name, version: range, meta: await metadata(name, range, io)});
  }
  const packages = {};
  const sets = newSets();
  for (const p of all) {
    const label = `${p.name}@${p.version}`;
    const res = await io.fetch(p.meta.tarball);
    if (!res.ok) throw new Error(`${label}: the tarball answered ${res.status}`);
    const own = newSets();
    const {integrity, error} = await scanTarball(bodyOf(res), own);
    if (integrity !== p.meta.integrity) throw new Error(`${label}: the tarball's integrity is not the registry's published one; refused`);
    if (error != null) throw new Error(`${label}: the tarball could not be read (${error.message})`);
    for (const [k, v] of Object.entries(own)) for (const item of v) sets[k].add(item);
    packages[p.name] = {version: p.version, integrity: p.meta.integrity};
  }
  return {packages, surface: sortedSets(sets)};
}

function approvedVersions(dir = APPROVED_DIR) {
  if (!fs.existsSync(dir)) return [];
  const cmp = (a, b) => {
    const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      return (typeof pa[i] === 'number' && typeof pb[i] === 'number') ? pa[i] - pb[i] : String(pa[i]).localeCompare(String(pb[i]));
    }
    return 0;
  };
  return fs.readdirSync(dir).filter((f) => /\.json$/.test(f)).map((f) => f.slice(0, -5)).sort(cmp);
}

const snapshotOf = (version, fetched, surface) => ({version, extractor: EXTRACTOR, packages: fetched.packages, surface});

// One line for the maintainer, then the details (stdout). -> exit code
function report(version, against, diff, out) {
  if (diff.failing.length > 0) {
    out(`Claude Code ${version}: FAIL against ${against}: new ${diff.failing.map((x) => `${x.set} ${x.item}`).slice(0, 8).join(', ')}${diff.failing.length > 8 ? `, and ${diff.failing.length - 8} more` : ''}`);
  } else {
    out(`Claude Code ${version}: pass against ${against} (${diff.added.length} other new, ${diff.removed.length} removed)`);
  }
  return diff.failing.length > 0 ? 1 : 0;
}

async function main(argv, io = {fetch: globalThis.fetch, out: (l) => process.stdout.write(l + '\n'), approvedDir: APPROVED_DIR}) {
  const againstAt = argv.indexOf('--against');
  const dirAt = argv.indexOf('--approved-dir');
  const version = argv.find((a, i) => !a.startsWith('--') && !(againstAt >= 0 && i === againstAt + 1) && !(dirAt >= 0 && i === dirAt + 1));
  // --approved-dir <dir>: snapshots somewhere other than tools/cc-retest/approved (a trial run)
  if (dirAt >= 0) io = Object.assign({}, io, {approvedDir: path.resolve(argv[dirAt + 1])});
  const approve = argv.includes('--approve');
  if (version == null || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    io.out('usage: node tools/cc-retest/surface.js <version> [--against <approved version>] [--approve]');
    return 2;
  }
  try {
    const fetched = await fetchVersion(version, io);
    const current = snapshotOf(version, fetched, fetched.surface);
    if (approve) {
      fs.mkdirSync(io.approvedDir, {recursive: true});
      fs.writeFileSync(path.join(io.approvedDir, `${version}.json`), JSON.stringify(current, null, 2) + '\n');
      io.out(`Claude Code ${version}: snapshot recorded as approved`);
      return 0;
    }
    const versions = approvedVersions(io.approvedDir);
    const against = againstAt >= 0 ? argv[againstAt + 1] : versions[versions.length - 1];
    if (against == null || !versions.includes(against)) {
      io.out(`Claude Code ${version}: no approved snapshot${against != null ? ` ${against}` : ''} to diff against; could not run`);
      return 2;
    }
    const approved = JSON.parse(fs.readFileSync(path.join(io.approvedDir, `${against}.json`), 'utf8'));
    if (approved.extractor !== EXTRACTOR) {
      io.out(`Claude Code ${version}: ${against}'s snapshot was taken by extractor ${approved.extractor}, not ${EXTRACTOR}; snapshot it again first (--approve ${against}); could not run`);
      return 2;
    }
    const diff = diffSurface(approved.surface, current.surface);
    const code = report(version, against, diff, io.out);
    io.out(JSON.stringify({version, against, failing: diff.failing, added: diff.added, removed: diff.removed}, null, 2));
    return code;
  } catch (err) {
    io.out(`Claude Code ${version}: could not run: ${err.message}`);
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = {extractSurface, diffSurface, fetchVersion, scanTarball, integrityOf, approvedVersions, main, EXTRACTOR, PACKAGE, TOUCHES};
