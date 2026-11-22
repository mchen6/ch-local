'use strict';
require('./tmp-dirs');
// lib/win-acl.js, as countinghouse's copy (#275) plus makePrivateDirs (C4c):
// the scripts name no cmdlet, privateProblem's rule for directories, and on
// Windows, the daemon's run directories made private.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const winAcl = require('../lib/win-acl');

const USER = 'S-1-5-21-1000000000-1000000000-1000000000-1001';
const FULL = 2032127;
const ace = (sid, rights = FULL, extra = {}) => Object.assign({sid, rights, type: 'Allow', inheritOnly: false}, extra);
const priv = () => ({user: USER, owner: USER, otherAces: false, rules: [ace(USER), ace(winAcl.SYSTEM)]});

test('the PowerShell it runs names no cmdlet (a lookup rebuilds the module cache, and would load module code)', () => {
  for (const name of ['FILE_ACL_SCRIPT', 'FILE_ACLS_SCRIPT', 'PRIVATE_DIRS_SCRIPT', 'CREATE_SCRIPT']) {
    const code = winAcl[name].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    assert.doesNotMatch(code, /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/, name);
  }
});

test('privateProblem: a directory\'s inherit-only allow rule for anyone else fails; a file\'s is skipped (countinghouse #275)', () => {
  const flows = priv();
  flows.rules.push(ace('S-1-1-0', FULL, {inheritOnly: true}));
  assert.strictEqual(winAcl.privateProblem('a file', flows), null);
  assert.match(String(winAcl.privateProblem('a directory', flows, {directory: true})), /inherit-only rule for S-1-1-0/);
  const own = priv();
  own.rules.push(ace(USER, FULL, {inheritOnly: true}), ace('S-1-1-0', 0x100000 | 0x20000 | 0x80, {inheritOnly: true}));
  assert.strictEqual(winAcl.privateProblem('a directory', own, {directory: true}), null, 'its own people, and harmless rights, pass');
  const creator = priv();
  creator.rules.push(ace('S-1-3-0', FULL, {inheritOnly: true}));
  assert.strictEqual(winAcl.privateProblem('a directory', creator, {directory: true}), null, 'CREATOR OWNER, inherit-only');
  const group = priv();
  group.rules.push(ace('S-1-3-1', FULL, {inheritOnly: true}));
  assert.match(String(winAcl.privateProblem('a directory', group, {directory: true})), /inherit-only rule for S-1-3-1/, 'CREATOR GROUP: the primary group, every local user');
  const creatorOn = priv();
  creatorOn.rules.push(ace('S-1-3-0', FULL));
  assert.match(String(winAcl.privateProblem('a directory', creatorOn, {directory: true})), /accessible by S-1-3-0/, 'not as a rule on the directory itself');
  assert.match(String(winAcl.privateProblem('a directory', Object.assign(priv(), {rules: [ace(USER), ace('S-1-1-0', 1179817)]}), {directory: true})), /accessible by S-1-1-0/);
});

test('makePrivateDirs and fileAcls take one or more paths, none with a line break', () => {
  assert.throws(() => winAcl.fileAcls([]), /one or more paths/);
  assert.throws(() => winAcl.makePrivateDirs(['C:\\a\nb'], ['C:\\a']), /line break/);
});

test('on Windows: the run directories are made, or put right, private; the files made in them inherit only this user and SYSTEM', {skip: process.platform !== 'win32' && 'Windows only'}, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-wa-')));
  try {
    const run = path.join(home, 'run');
    const daemon = path.join(run, 'daemon');
    fs.mkdirSync(run);   // there already, with the inherited DACL: put right
    const acls = winAcl.makePrivateDirs([run, daemon], [run, daemon]);
    assert.strictEqual(acls.length, 2);
    for (const [i, d] of [run, daemon].entries()) assert.strictEqual(winAcl.privateProblem(d, acls[i], {directory: true}), null, JSON.stringify(acls[i]));
    fs.writeFileSync(path.join(daemon, 'start.lock'), 'x');
    assert.strictEqual(winAcl.privateProblem('a file made there', winAcl.fileAcl(path.join(daemon, 'start.lock'))), null);
    // a second call on the same directories is the same
    const again = winAcl.makePrivateDirs([run, daemon], [daemon]);
    assert.strictEqual(winAcl.privateProblem(daemon, again[0], {directory: true}), null);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// A12 (the final pass): createPrivate read its stdin as console text and
// wrote ASCII.GetBytes of it, so every byte past ASCII became '?' (a
// credential, a name, a home under C:\Users\José). The data goes as base64
// of its bytes, decoded by FromBase64String: the bytes written are the
// bytes given.
test('A12: createPrivate hands PowerShell its data as base64 of the bytes, decoded whole', () => {
  const winAcl = require('../lib/win-acl');
  assert.match(winAcl.CREATE_SCRIPT, /\[System\.Convert\]::FromBase64String\(\[Console\]::In\.ReadToEnd\(\)\.Trim\(\)\)/);
  assert.doesNotMatch(winAcl.CREATE_SCRIPT, /ASCII/);
  const data = '{"home":"C:\\\\Users\\\\José","token":"x€y"}';
  assert.strictEqual(Buffer.from(winAcl.createInput(data), 'base64').toString('utf8'), data);
  const bytes = Buffer.from([0, 255, 128, 0xc3]);
  assert.strictEqual(winAcl.createInput(bytes), bytes.toString('base64'), 'a Buffer as its bytes, never through text');
  assert.strictEqual(winAcl.createInput(new Uint8Array([0, 255])), Buffer.from([0, 255]).toString('base64'), 'any view as its bytes');
  for (const bad of [undefined, null, 5]) assert.throws(() => winAcl.createInput(bad), /not a string or bytes/);
});

test('A12, on Windows: a file createPrivate makes holds exactly the bytes given', {skip: process.platform !== 'win32' && 'PowerShell'}, () => {
  const {createPrivate} = require('../lib/win-acl');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ch-acl-bytes-'));
  try {
    const file = require('node:path').join(dir, 'f.json');
    const data = '{"home":"C:\\\\Users\\\\José","token":"x€y"}';
    createPrivate(file, data);
    assert.strictEqual(require('node:fs').readFileSync(file, 'utf8'), data);
    // (bytes that aren't UTF-8 text, as they are)
    const raw = Buffer.from([0, 255, 128, 0xc3]);
    createPrivate(`${file}.bin`, raw);
    assert.ok(require('node:fs').readFileSync(`${file}.bin`).equals(raw));
  } finally {
    require('node:fs').rmSync(dir, {recursive: true, force: true});
  }
});

test('A9 (L7): the private-directories script refuses a missing parent: CreateDirectory would make a removed home again', () => {
  const {PRIVATE_DIRS_SCRIPT} = require('../lib/win-acl');
  assert.match(PRIVATE_DIRS_SCRIPT, /elseif \(-not \[System\.IO\.Directory\]::Exists\(\[System\.IO\.Path\]::GetDirectoryName\(\$d\)\)\) \{ throw /);
});
