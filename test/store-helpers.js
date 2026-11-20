'use strict';
// A home as install leaves it (#413 sections 9.1 and 9.2), built directly
// for tests that need one without running install: each module in the
// module store with its marker, and modules.json written by the record's
// own writer (its derived modules and withdrawn), the runtime in the app.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {writeModulesRecord} = require('../lib/module-record');

// One module version in the store: its package.json (manifest: the
// countinghouse block and any other fields), any files, and its marker.
// -> its directory.
// Its api.json names it by its short name (the friendly name another
// module's countinghouse.calls reach it by), unless files gives one.
function storeModule(home, name, version, {countinghouse = null, extra = {}, files = {}} = {}) {
  const dir = path.join(home, 'module-store', ...name.split('/'), version);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, ...(countinghouse ? {countinghouse} : {}), ...extra}));
  if (files['api.json'] === undefined) fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name.replace(/^@[^/]+\//, ''), serviceList: {}}}));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
    fs.writeFileSync(path.join(dir, rel), data);
  }
  const integrity = 'sha512-' + crypto.createHash('sha512').update(`${name}@${version}`).digest('base64');
  fs.writeFileSync(`${dir}.json`, JSON.stringify({name, version, integrity, placedAt: new Date(0).toISOString()}) + '\n');
  return dir;
}

// The role a stored version declares, as install derives it.
const roleOf = (home) => (name, version) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, 'module-store', ...name.split('/'), version, 'package.json'), 'utf8'));
    const r = m.countinghouse != null ? m.countinghouse.role : null;
    return r === 'scenario' || r === 'part' ? r : null;
  } catch (e) {
    return null;
  }
};

// modules.json for these packs ({pack: {module: version}}), each from
// `from` (a release by default). release: the pins the withdrawn list is
// derived from; by default one that lists every pack given, so nothing is
// withdrawn. -> what was written.
// credentials: {pack: [variable]}, the variables the running release's
// (version 1) pins give each pack, which fakeIo's release reads
// (test/fake-io.js installedRelease) in place of the declared remotes.
function writeHome(home, packs, {runtime = {countinghouse: '1.0.0'}, unreleased = false, from = {release: '1.0.0'}, release = null, held = undefined, releaseOf = null, credentials = null} = {}) {
  const lists = release != null ? release : {packs: Object.fromEntries(Object.entries(packs).map(([p, ms]) => [p, {packages: Object.keys(ms)}]))};
  if (credentials != null) setPackCredentials(home, credentials);
  return writeModulesRecord({modulesRecord: path.join(home, 'modules.json')}, {
    runtime: {versions: runtime},
    release: releaseOf,
    unreleased,
    packs: Object.fromEntries(Object.entries(packs).map(([p, ms]) => [p, {from, modules: ms}])),
    ...(held != null ? {held} : {})
  }, {roleOf: roleOf(home), release: lists});
}

// The test's own pins credentials, {pack: [variable]} (see writeHome).
const CREDENTIALS_FILE = 'test-pack-credentials.json';
function setPackCredentials(home, credentials) {
  fs.writeFileSync(path.join(home, CREDENTIALS_FILE), JSON.stringify(credentials));
}

// modules.json changed as an operation would write it (its own writer: the
// derived modules and withdrawn). fn(record) -> the record to write;
// release: the pins withdrawn is derived from (by default, every pack listed).
function editHome(home, fn, {release = null} = {}) {
  const file = path.join(home, 'modules.json');
  const next = fn(JSON.parse(fs.readFileSync(file, 'utf8')));
  const lists = release != null ? release : {packs: Object.fromEntries(Object.entries(next.packs).map(([p, e]) => [p, {packages: Object.keys(e.modules)}]))};
  return writeModulesRecord({modulesRecord: file}, next, {roleOf: roleOf(home), release: lists});
}

// ch-access-github's credential stored in a test home (L5a: a credential is
// the module's own, in the store), a test value with no real token's shape
function bindAccess(home, value = 'test-stored-value-1') {
  require('../lib/credential-store').bind(home, '@countinghouse/ch-access-github', 'GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'stored', value}, {held: FIXTURE_HELD});
}

// a stand-in for the store lock's `held`, for fixtures that set a store up
// before the code under test runs (lib/ takes it only from withStoreLock:
// test/credential-lock.test.js pins that)
const FIXTURE_HELD = Object.freeze({check() {}});

module.exports = {FIXTURE_HELD, storeModule, writeHome, editHome, roleOf, setPackCredentials, bindAccess, CREDENTIALS_FILE};
