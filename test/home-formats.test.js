'use strict';
require('./tmp-dirs');
// Older homes, read by this tree (C-upgrade-path, tier 2): every home under
// test/fixtures/homes/ was built by an older ch-local's own code
// (scripts/capture-home.js: its install, its settings command, its
// credential store) and is read here, on every run and offline, by this
// tree's readers -- the record, the settings, the stored credentials --
// which must read what that release's own readers read (expected.json).
//
// The rule (CONTRIBUTING.md): from release 1 on, every change to a home's
// format ships the reader for the older one. A change that can't read a
// captured home fails here. A format may change what it holds on purpose
// (a migration): say so in that home's expected.json, never by deleting the
// fixture. The full path -- upgrade, start, rollback -- is
// test/upgrade-path.test.js's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ROOT, summaryWith} = require('./upgrade-helpers');

const HOMES = path.join(__dirname, 'fixtures', 'homes');
// (a capture in progress, or one left by a failed run, is a dot-directory:
// never a home of a release)
const captured = fs.existsSync(HOMES) ? fs.readdirSync(HOMES).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(HOMES, d, 'expected.json'))).sort() : [];

test('at least one older home is captured (release gating adds the release\'s own)', () => {
  assert.ok(captured.length > 0, 'no home under test/fixtures/homes');
});

for (const label of captured) {
  test(`a home built by ${label}, read by this tree: the same packs, settings and credentials`, () => {
    const from = JSON.parse(fs.readFileSync(path.join(HOMES, label, 'from.json'), 'utf8'));
    assert.ok(/^[0-9a-f]{40}$/.test(from.commit), 'from.json names the commit it was built by');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-home-formats-'));
    try {
      const home = path.join(work, 'home');
      const capturedCreds = path.join(HOMES, label, 'home', 'credentials');
      fs.cpSync(path.join(HOMES, label, 'home'), home, {recursive: true, filter: (src) => src !== capturedCreds});
      // (git keeps no modes and no ACLs: the home this user's, and the
      // credentials made private as the store itself makes them -- its
      // directory by its own check, its file by the private writer -- on
      // every platform, with the captured bytes)
      fs.chmodSync(home, 0o700);
      if (fs.existsSync(capturedCreds)) {
        const dir = path.join(home, 'credentials');
        require('../lib/credential-store').checkDir(dir, {create: true});
        for (const f of fs.readdirSync(capturedCreds)) require('../lib/private-write').writePrivate(dir, f, fs.readFileSync(path.join(capturedCreds, f), 'utf8'));
      }
      const expected = JSON.parse(fs.readFileSync(path.join(HOMES, label, 'expected.json'), 'utf8'));
      assert.deepStrictEqual(summaryWith(ROOT, {...process.env, COUNTINGHOUSE_HOME: home}), expected);
    } finally {
      fs.rmSync(work, {recursive: true, force: true});
    }
  });
}
