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
  [ACCESS]: {credentials: [{variable: 'X_TOKEN', origin: ORIGIN}], calls: [], confirmSettings: {}},
  [PACK]: {credentials: [], calls: [ACCESS], confirmSettings: {share: false}}
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

test('--check: 0 when the file\'s descriptions match the tarballs, 1 when they differ, and nothing is written', () => {
  const dir = dirOf();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-describe-pins-')), 'release-pins.json');
  const out = () => { let s = ''; return {write: (x) => { s += x; }, get text() { return s; }}; };
  fs.writeFileSync(file, JSON.stringify({...release(), modules: DESCRIBED}));
  const ok = out();
  assert.strictEqual(main([dir, '--check'], {stdout: ok, stderr: out(), releasePins: file}), 0, ok.text);
  const stale = {...release(), modules: {...DESCRIBED, [PACK]: {...DESCRIBED[PACK], calls: []}}};
  fs.writeFileSync(file, JSON.stringify(stale));
  const differ = out();
  assert.strictEqual(main([dir, '--check'], {stdout: differ, stderr: out(), releasePins: file}), 1);
  assert.match(differ.text, /differ from the tarballs/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stale, 'nothing written');
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
