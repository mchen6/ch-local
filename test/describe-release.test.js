'use strict';
require('./tmp-dirs');
// scripts/describe-release.js (#413 section 9.3; L5b): the release step that
// writes each pack module's description from the release's own tarballs,
// never by hand, and the development pins file's (describePinned). What it
// refuses, it refuses whole: nothing is written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {packageTgz} = require('./tgz');
const {describeRelease, describePinned, readTarballs, main} = require('../scripts/describe-release');

const ORIGIN = 'https://api.example.test';
const ACCESS = '@countinghouse/ch-access-x';
const PACK = '@countinghouse/ch-pack-x';
const RUNTIME = 'countinghouse';
const api = (friendlyName) => JSON.stringify({device: {friendlyName}});
const tarballs = {
  [ACCESS]: [{name: ACCESS, version: '0.2.0', countinghouse: {role: 'part', remotes: [{name: 'x', url: `${ORIGIN}/mcp/`, credential: 'X_TOKEN'}]}}, {'api.json': api('ch-access-x')}],
  [PACK]: [{name: PACK, version: '0.5.0', countinghouse: {role: 'scenario', calls: ['ch-access-x/xService.list'], settings: {share: {type: 'boolean', default: false, confirm: true}}}}, {'api.json': api('ch-pack-x')}]
};
const release = () => ({packs: {x: {modules: [PACK, ACCESS]}}, modules: {}, pins: {[PACK]: {version: '0.5.0'}, [ACCESS]: {version: '0.2.0'}}});
const DESCRIBED = {
  [ACCESS]: {role: 'part', credentials: [{variable: 'X_TOKEN', origin: ORIGIN}], calls: [], confirmSettings: {}},
  [PACK]: {role: 'scenario', credentials: [], calls: [ACCESS], confirmSettings: {share: false}}
};
// a directory of tarballs: those named, plus `extra` ({file: manifest})
function dirOf(names = Object.keys(tarballs), extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-'));
  for (const n of names) {
    const [manifest, files] = tarballs[n];
    fs.writeFileSync(path.join(dir, `${n.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`), packageTgz(manifest, files));
  }
  for (const [file, manifest] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), packageTgz(manifest));
  return dir;
}
const refusal = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };

test('each pack module described from its own tarball: its key\'s destination, its calls as packages, its confirm settings', () => {
  const dir = dirOf();
  const r = release();
  assert.deepStrictEqual(describeRelease(r, r.pins, readTarballs(dir)), {packs: {x: {modules: [PACK, ACCESS]}}, modules: DESCRIBED});
});

test('refused whole: a module with no tarball, a tarball no pack lists, a tarball off its pin, a module that cannot be described', () => {
  const r = release();
  assert.match(refusal(() => describeRelease(r, r.pins, readTarballs(dirOf([PACK])))), /no tarball of @countinghouse\/ch-access-x, a module of this release/);
  assert.match(refusal(() => describeRelease(r, r.pins, readTarballs(dirOf(undefined, {'other-1.0.0.tgz': {name: 'other', version: '1.0.0'}})))),
    /other is no module of this release's packs/);
  assert.match(refusal(() => describeRelease(r, {...r.pins, [ACCESS]: {version: '0.1.0'}}, readTarballs(dirOf()))), /ch-access-x 0\.2\.0 is not its pin \(0\.1\.0\)/);
  const saved = tarballs[PACK];
  tarballs[PACK] = [{...saved[0], countinghouse: {role: 'scenario', calls: ['nobody/x.y']}}, saved[1]];
  try {
    assert.match(refusal(() => describeRelease(r, r.pins, readTarballs(dirOf()))), /ch-pack-x 0\.5\.0: it calls nobody, which is no module of this release/);
  } finally {
    tarballs[PACK] = saved;
  }
});

test('a development pins file\'s descriptions: only the pack modules it pins, the runtime\'s and ch-local\'s tarballs beside them never described', () => {
  const dir = dirOf(undefined, {'countinghouse-9.0.0.tgz': {name: RUNTIME, version: '9.0.0'}, 'ch-local-0.4.0.tgz': {name: '@countinghouse/ch-local', version: '0.4.0'}});
  assert.deepStrictEqual(describePinned(release(), {[RUNTIME]: {version: '9.0.0'}, [PACK]: {version: '0.5.0'}, [ACCESS]: {version: '0.2.0'}}, dir), DESCRIBED);
});

// a whole release document with this test's pack (the shipped one's other
// parts)
// (the shipped document with this file's pack: its floors, which name the
// shipped pack's modules, go with the shipped pack)
const wholeDoc = (modules) => {
  const {floors, ...rest} = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
  void floors;
  return {...rest, packs: {x: {modules: [PACK, ACCESS]}}, modules, pins: {}};
};

// a runtime tarball whose lib/held-back.js lists `reasons` on its one
// REASONS line (countinghouse's form)
const OURS = [...require('../lib/held-back').REASONS];
const runtimeTgz = (dir, reasons = OURS, {version = '9.0.0', line = null} = {}) => fs.writeFileSync(path.join(dir, `countinghouse-${version}.tgz`),
  packageTgz({name: RUNTIME, version}, {'lib/held-back.js': `'use strict';\n${line != null ? line : `const REASONS = [${reasons.map((r) => `'${r}'`).join(', ')}];`}\nmodule.exports = {};\n`}));

test('--check: 0 when the file\'s descriptions match the tarballs, 1 when they differ, and nothing is written', () => {
  const dir = dirOf();
  runtimeTgz(dir);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-pins-')), 'release-pins.json');
  const out = () => { let s = ''; return {write: (x) => { s += x; }, get text() { return s; }}; };
  fs.writeFileSync(file, JSON.stringify(wholeDoc(DESCRIBED)));
  const ok = out();
  assert.strictEqual(main([dir, '--check'], {stdout: ok, stderr: out(), releasePins: file}), 0, ok.text);
  const stale = wholeDoc({...DESCRIBED, [PACK]: {...DESCRIBED[PACK], calls: []}});
  fs.writeFileSync(file, JSON.stringify(stale));
  const differ = out();
  assert.strictEqual(main([dir, '--check'], {stdout: differ, stderr: out(), releasePins: file}), 1);
  assert.match(differ.text, /differ from the tarballs/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stale, 'nothing written');
  // matching descriptions in a document a write would convert, or every
  // command would refuse: not a match (the medium on #98's high round, 6)
  for (const doc of [{...wholeDoc(DESCRIBED), allowedOrigins: {}}, {...wholeDoc(DESCRIBED), v: 1}]) {
    fs.writeFileSync(file, JSON.stringify(doc));
    const said = out();
    assert.strictEqual(main([dir, '--check'], {stdout: said, stderr: out(), releasePins: file}), 1);
    assert.match(said.text, /not a document this ch-local reads as it is/);
  }
});

test('--unreleased-pins: the runtime\'s and ch-local\'s tarballs beside the modules are skipped, as install\'s --from holds them (the medium on L5b, 1)', () => {
  const dir = dirOf(undefined, {'countinghouse-9.0.0.tgz': {name: RUNTIME, version: '9.0.0'}});
  const at = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-dev-'));
  const rel = path.join(at, 'release-pins.json');
  const dev = path.join(at, 'pins.json');
  fs.writeFileSync(rel, JSON.stringify({...release(), modules: DESCRIBED}));
  fs.writeFileSync(dev, JSON.stringify({pins: {[RUNTIME]: {version: '9.0.0'}, [PACK]: {version: '0.5.0'}, [ACCESS]: {version: '0.2.0'}}, runtimeLockfile: {}}));
  const err = {write: () => {}};
  assert.strictEqual(main([dir, '--unreleased-pins', dev], {stdout: err, stderr: err, releasePins: rel}), 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(dev, 'utf8')).modules, DESCRIBED);
});

test('a description the pins\' format would refuse is refused by the step, never written (the medium on L5b, 4)', () => {
  const saved = tarballs[PACK];
  tarballs[PACK] = [{...saved[0], countinghouse: {role: 'scenario', calls: ['ch-access-x/xService.list'], settings: {share: {type: 'boolean', default: [1], confirm: true}}}}, saved[1]];
  try {
    const r = release();
    assert.match(refusal(() => describeRelease(r, r.pins, readTarballs(dirOf()))), /share/);
  } finally {
    tarballs[PACK] = saved;
  }
});

test('a directory as install\'s --from holds it: ch-local\'s own tarball, bundling what the strict reader refuses, is never opened (the Reviewer\'s high review of #98, 1)', () => {
  const {member, tgz} = require('./tgz');
  const dir = dirOf();
  fs.writeFileSync(path.join(dir, 'countinghouse-ch-local-0.4.0.tgz'), tgz(member('package/package.json', {data: JSON.stringify({name: '@countinghouse/ch-local', version: '0.4.0'})}),
    member('package/node_modules/@sigstore/verify/package.json', {data: '{}'}), member('package/escape', {type: '2', linkname: '../../etc/passwd'})));
  assert.deepStrictEqual(describePinned(release(), {'@countinghouse/ch-local': {version: '0.4.0'}, [PACK]: {version: '0.5.0'}, [ACCESS]: {version: '0.2.0'}}, dir), DESCRIBED);
});

test('the release document is written only as the parser reads it: version 2, allowedOrigins gone, refused whole otherwise (the Reviewer\'s high review of #98, 4)', () => {
  const dir = dirOf();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-whole-')), 'release-pins.json');
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
  delete shipped.floors;
  const quiet = {write: () => {}};
  // a version 1 document with this release's packs: converted
  fs.writeFileSync(file, JSON.stringify({...shipped, v: 1, packs: {x: {packages: [PACK, ACCESS], credentials: ['X_TOKEN']}}, modules: undefined, allowedOrigins: {[ORIGIN]: ['X_TOKEN']}}));
  assert.strictEqual(main([dir], {stdout: quiet, stderr: quiet, releasePins: file}), 0);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(written.v, 2);
  assert.ok(!('allowedOrigins' in written));
  assert.strictEqual(require('../lib/release-pins').parseReleasePins(written).problem, undefined);
  // one the parser refuses (a pin that is no pin) is not written
  const bad = {...written, pins: {[PACK]: {version: 'not a version'}}};
  fs.writeFileSync(file, JSON.stringify(bad));
  const err = {text: '', write(x) { this.text += x; }};
  assert.strictEqual(main([dir], {stdout: quiet, stderr: err, releasePins: file}), 1);
  assert.match(err.text, /nothing was written/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), bad);
});

// floors (the reviewer on the redaction fixes): the release step refuses a
// module's tarball below its floor, so no release is described from one
test('a tarball below its floor is refused whole', () => {
  const r = {...release(), floors: {[ACCESS]: '0.3.0'}};
  assert.match(refusal(() => describeRelease(r, {}, readTarballs(dirOf()))) || '', /ch-access-x 0\.2\.0 is below its floor 0\.3\.0/);
  const ok = {...release(), floors: {[ACCESS]: '0.2.0'}};
  assert.strictEqual(refusal(() => describeRelease(ok, {}, readTarballs(dirOf()))), null, 'at its floor');
  // (a pre-release of the floor's own version comes before it)
  const pre = {...release(), floors: {[ACCESS]: '0.2.1'}};
  const dir = dirOf([PACK]);
  const [manifest, files] = tarballs[ACCESS];
  fs.writeFileSync(path.join(dir, 'countinghouse-ch-access-x-0.2.1-rc.1.tgz'), packageTgz({...manifest, version: '0.2.1-rc.1'}, files));
  assert.match(refusal(() => describeRelease(pre, {}, readTarballs(dir))) || '', /ch-access-x 0\.2\.1-rc\.1 is below its floor 0\.2\.1/);
});

// K3 (the feature audit): the release's change notes, from the maintainer's
// notes file (one change per line), or none.
test('--notes <file> writes the release\'s change notes, one per line; --notes none writes null; a file the format refuses writes nothing', () => {
  const dir = dirOf();
  const at = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-notes-'));
  const file = path.join(at, 'release-pins.json');
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
  delete shipped.floors;
  const quiet = {write: () => {}};
  fs.writeFileSync(file, JSON.stringify({...shipped, packs: release().packs}));
  const notes = path.join(at, 'notes.txt');
  fs.writeFileSync(notes, 'the triage tool says which test failed\n\n  owner hints name later commits too  \n');
  const said = {text: "", write(x) { this.text += x; }};
  assert.strictEqual(main([dir, "--notes", notes], {stdout: said, stderr: said, releasePins: file}), 0, said.text);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).release.notes, ['the triage tool says which test failed', 'owner hints name later commits too']);
  // (no --notes: the notes stay as they are, said, so a new release never
  // ships the last one's unasked -- the final pass, L7)
  const kept = {text: '', write(x) { this.text += x; }};
  assert.strictEqual(main([dir], {stdout: quiet, stderr: kept, releasePins: file}), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).release.notes.length, 2);
  assert.match(kept.text, /release\.notes kept as they were \(2 lines\); for a new release pass --notes <file> or --notes none/);
  assert.strictEqual(main([dir, '--notes', 'none'], {stdout: quiet, stderr: quiet, releasePins: file}), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).release.notes, null);
  fs.writeFileSync(notes, Array.from({length: 9}, (_, i) => `change ${i}`).join('\n'));
  const err = {text: '', write(x) { this.text += x; }};
  assert.strictEqual(main([dir, '--notes', notes], {stdout: quiet, stderr: err, releasePins: file}), 1);
  assert.match(err.text, /release\.notes[\s\S]*nothing was written/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).release.notes, null);
});

// A-own-gone: --check holds the runtime the release pins to every held-back
// reason this ch-local writes (lib/held-back.js REASONS), read from its
// tarball in the directory: one that lacks any, or that can't be read so,
// fails the check (the gate for E10's gone: countinghouse c313b561)
test('--check: the pinned runtime must know every held-back reason this ch-local writes; a missing or unreadable one fails', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-pins-')), 'release-pins.json');
  fs.writeFileSync(file, JSON.stringify(wholeDoc(DESCRIBED)));
  const out = () => { let s = ''; return {write: (x) => { s += x; }, get text() { return s; }}; };
  const check = (dir) => { const o = out(); return {code: main([dir, '--check'], {stdout: o, stderr: o, releasePins: file}), text: o.text}; };
  // (every reason known: the check goes on to the descriptions; the
  // runtime's and ch-local's own tarballs beside the release's are never
  // described, ch-local's -- which bundles what the strict reader refuses --
  // never opened)
  const {member, tgz} = require('./tgz');
  let dir = dirOf();
  runtimeTgz(dir);
  fs.writeFileSync(path.join(dir, 'countinghouse-ch-local-0.4.0.tgz'), tgz(member('package/package.json', {data: JSON.stringify({name: '@countinghouse/ch-local', version: '0.4.0'})}),
    member('package/escape', {type: '2', linkname: '../../etc/passwd'})));
  assert.deepStrictEqual(check(dir), {code: 0, text: `${file}: the descriptions match the tarballs\n`});
  // (one without gone: refused, naming it and the runtime's version)
  dir = dirOf();
  runtimeTgz(dir, OURS.filter((r) => r !== 'gone'), {version: '7.1.2'});
  let r = check(dir);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.text, `${file}: the pinned countinghouse 7.1.2 does not know the held-back reason gone, which this ch-local writes: pin a countinghouse that does\n`);
  // (no runtime tarball; two; a REASONS line not in its one-line form; none)
  dir = dirOf();
  r = check(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /the runtime's held-back reasons can't be checked \(no single countinghouse tarball in .*: 0\)/);
  runtimeTgz(dir);
  runtimeTgz(dir, OURS, {version: '9.0.1'});
  r = check(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /can't be checked \(no single countinghouse tarball in .*: 2\)/);
  // (a runtime with no held-back file: too old, said so)
  dir = dirOf();
  fs.writeFileSync(path.join(dir, 'countinghouse-9.0.0.tgz'), packageTgz({name: RUNTIME, version: '9.0.0'}));
  r = check(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /can't be checked \(countinghouse-9\.0\.0\.tgz: it has no lib\/held-back\.js \(a runtime older than the held-back file\)\)/);
  // (CRLF line endings: read as the same line)
  dir = dirOf();
  runtimeTgz(dir, OURS, {line: `const REASONS = [${OURS.map((x) => `'${x}'`).join(', ')}];\r`});
  assert.strictEqual(check(dir).code, 0);
  // (a pack module whose name starts as the runtime's, then a digit, is
  // still a module of the release, never skipped as a runtime tarball)
  dir = dirOf([]);
  fs.writeFileSync(path.join(dir, 'countinghouse-2fa-check-1.0.0.tgz'), packageTgz({name: '@countinghouse/2fa-check', version: '1.0.0'}));
  runtimeTgz(dir);
  assert.deepStrictEqual(Object.keys(readTarballs(dir, {skip: [RUNTIME]})), ['@countinghouse/2fa-check'], 'the runtime skipped, the module read');
  for (const line of ["const REASONS = ['credential',\n  'off'];", 'const REASONS = new Set(OTHERS);', '// none here']) {
    dir = dirOf();
    runtimeTgz(dir, OURS, {line});
    r = check(dir);
    assert.strictEqual(r.code, 1, line);
    assert.match(r.text, /can't be checked \(countinghouse-9\.0\.0\.tgz: its lib\/held-back\.js has no one-line REASONS list\)/, line);
  }
});

test('--check with --unreleased-pins: the runtime is the one the file pins, beside others', () => {
  const dir = dirOf();
  runtimeTgz(dir, OURS.filter((r) => r !== 'gone'), {version: '7.1.2'});
  runtimeTgz(dir, OURS, {version: '9.0.0'});
  const at = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-dev-'));
  const rel = path.join(at, 'release-pins.json');
  const dev = path.join(at, 'pins.json');
  fs.writeFileSync(rel, JSON.stringify({...release(), modules: DESCRIBED}));
  const o = {s: '', write(x) { this.s += x; }};
  for (const [v, code] of [['9.0.0', 0], ['7.1.2', 1]]) {
    fs.writeFileSync(dev, JSON.stringify({pins: {[RUNTIME]: {version: v}, [PACK]: {version: '0.5.0'}, [ACCESS]: {version: '0.2.0'}}, runtimeLockfile: {}, modules: DESCRIBED}));
    o.s = '';
    assert.strictEqual(main([dir, '--unreleased-pins', dev, '--check'], {stdout: o, stderr: o, releasePins: rel}), code, o.s);
  }
  assert.match(o.s, /the pinned countinghouse 7\.1\.2 does not know the held-back reason gone/);
  // (the file named for the pin holds another version: refused)
  fs.writeFileSync(path.join(dir, 'countinghouse-9.0.0.tgz'), packageTgz({name: RUNTIME, version: '7.1.2'}, {'lib/held-back.js': `const REASONS = [${OURS.map((x) => `'${x}'`).join(', ')}];\n`}));
  fs.writeFileSync(dev, JSON.stringify({pins: {[RUNTIME]: {version: '9.0.0'}, [PACK]: {version: '0.5.0'}, [ACCESS]: {version: '0.2.0'}}, runtimeLockfile: {}, modules: DESCRIBED}));
  o.s = '';
  assert.strictEqual(main([dir, '--unreleased-pins', dev, '--check'], {stdout: o, stderr: o, releasePins: rel}), 1);
  assert.match(o.s, /countinghouse-9\.0\.0\.tgz: it holds countinghouse 7\.1\.2, not the pinned 9\.0\.0/);
});

// The closing pass on release 1, L1: the release's own document (gating's
// mode) with the shim's tarball beside the release's: never described,
// never opened (as the runtime's), so never refused as no module of its packs
test('the release\'s own document: a shim tarball beside the release\'s is skipped, as the runtime\'s are', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-pins-')), 'release-pins.json');
  const doc = wholeDoc(DESCRIBED);
  fs.writeFileSync(file, JSON.stringify(doc));
  const dir = dirOf();
  runtimeTgz(dir);
  const shim = Object.values(doc.shim.packages)[0];
  fs.writeFileSync(path.join(dir, `${shim.replace(/^@/, '').replace('/', '-')}-0.0.0-dev.6496c6f9469b.tgz`), packageTgz({name: shim, version: '0.0.0-dev.6496c6f9469b'}));
  const o = {s: '', write(x) { this.s += x; }};
  assert.strictEqual(main([dir, '--check'], {stdout: o, stderr: o, releasePins: file}), 0, o.s);
  assert.match(o.s, /the descriptions match the tarballs/);
});
