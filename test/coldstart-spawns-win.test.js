'use strict';
require('./tmp-dirs');
// Cold-start part 3, on a real Windows filesystem: how many PowerShell runs
// (win-acl's own count of them) the daemon's first start and the reads it
// joined take. Windows only: elsewhere no PowerShell runs, and the reads are
// pinned by the stubbed cases (win-acl-prefetch, private-file-prefetch,
// credentials). Each case writes what it counted to the log, so a Windows
// leg shows it ran.
// - The daemon's read of its runtime's secret at ready: the run folder's ACL
//   and the secret's in one run (two before).
// - A private read in a private folder: one run (two before).
// - Reading the credential store: one run (two before).
// - Attribution, on real PowerShell: a file granted to Users in a private
//   folder is refused for the file, in one run; a batch of [missing, folder]
//   answers [failed, the folder's ACL], in that order.
// On Windows a missing precondition fails the case, never skips it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const winAcl = require('../lib/win-acl');

const WIN = {skip: process.platform !== 'win32' && 'PowerShell runs are counted on Windows only'};
const say = (line) => process.stdout.write(`cold-start spawns: ${line}\n`);

test('Windows: the daemon\'s first start reads its runtime\'s secret in one PowerShell run', WIN, async() => {
  const {daemon} = require('../lib/daemon');
  const {fakeRuntime, daemonIo, tmpHome, runDirOf, stopLeftDaemons, ADOPT_MS} = require('./daemon-fakes');
  const home = tmpHome();
  const io = daemonIo(home);
  const before = winAcl.runCount();
  const at = {listening: null, hello: null, rt: null};
  const run = async(opts) => {
    at.rt = await fakeRuntime(runDirOf(home), opts.socket, {onHello: () => { if (at.hello == null) at.hello = winAcl.runCount(); }});
    let end = null;
    const exited = new Promise((r) => { end = r; });
    opts.signal.addEventListener('abort', () => { at.rt.close().then(() => end(143)); });
    at.listening = winAcl.runCount();
    opts.onListening({type: 'listening', socket: opts.socket});
    return exited;
  };
  const done = daemon({home}, io, {run});
  try {
    const until = Date.now() + ADOPT_MS;
    while (at.hello == null && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(at.hello != null, `the daemon never probed its runtime: ${io.err}`);
    say(`${at.listening - before} run(s) before the runtime said it listens; ${at.hello - at.listening} from then to the daemon's first probe`);
    assert.strictEqual(at.hello - at.listening, 1, 'the run folder\'s ACL and the secret\'s in one run');
  } finally {
    if (typeof io.signal === 'function') io.signal('SIGTERM');
    await done;
    stopLeftDaemons();
  }
});

test('Windows: a private read in a private folder takes one PowerShell run', WIN, () => {
  const {readPrivateIn} = require('../lib/private-file');
  const dir = path.join(require('./fake-io').tmp('ch-cs-pf-'), 'run');
  winAcl.makePrivateDirs([dir], [dir]);
  fs.writeFileSync(path.join(dir, 'secret'), 'abc');
  const before = winAcl.runCount();
  assert.strictEqual(readPrivateIn(dir, 'secret', 80).toString(), 'abc');
  say(`a private read: ${winAcl.runCount() - before} run(s)`);
  assert.strictEqual(winAcl.runCount() - before, 1);
});

test('Windows: reading the credential store takes one PowerShell run', WIN, () => {
  const crypto = require('node:crypto');
  const store = require('../lib/credential-store');
  const h = require('./fake-io').tmp('ch-cs-cred-');
  store.bind(h, '@countinghouse/ch-access-github', 'COUNTINGHOUSE_GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'stored', value: `t${crypto.randomBytes(12).toString('hex')}`}, {held: require('./store-helpers').FIXTURE_HELD});
  const before = winAcl.runCount();
  const got = store.readStore(h);
  say(`a store read: ${winAcl.runCount() - before} run(s)`);
  assert.ok(got.modules.size === 1);
  assert.strictEqual(winAcl.runCount() - before, 1);
});

test('Windows: a file granted to Users in a private folder is refused for the file, in one PowerShell run', WIN, () => {
  const {readPrivateIn} = require('../lib/private-file');
  const dir = path.join(require('./fake-io').tmp('ch-cs-attr-'), 'run');
  winAcl.makePrivateDirs([dir], [dir]);
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'abc');
  const granted = require('node:child_process').spawnSync('icacls', [file, '/grant', '*S-1-5-32-545:(R)'], {encoding: 'utf8', windowsHide: true});
  assert.strictEqual(granted.status, 0, `icacls: ${granted.stdout}${granted.stderr}`);
  const before = winAcl.runCount();
  assert.throws(() => readPrivateIn(dir, 'secret', 80), (e) => e.message.includes(file) && /accessible by S-1-5-32-545/.test(e.message) && !e.message.startsWith(`${dir} `));
  say(`a refused private read: ${winAcl.runCount() - before} run(s)`);
  assert.strictEqual(winAcl.runCount() - before, 1);
});

test('Windows: a batch of [missing, folder] answers [failed, the folder\'s ACL], in that order', WIN, () => {
  const dir = require('./fake-io').tmp('ch-cs-order-');
  // (beside the folder, not in it: a path in a folder listed after it is
  // never sent, and both must be)
  const missing = `${dir}-not-there`;
  let out = null;
  let sent = null;
  const run = (script, env) => { sent = env.CH_ACL_FILES.split('\n'); const text = winAcl.runPowershell(script, env); out = JSON.parse(text); return text; };
  const plainStat = {isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false};
  const read = winAcl.prefetch([missing, dir], {run, lstat: () => plainStat, single: () => { throw new Error('a single read'); }});
  assert.deepStrictEqual(sent, [path.resolve(missing), path.resolve(dir)], 'both paths sent, in order');
  assert.ok(Array.isArray(out) && out.length === 2, JSON.stringify(out));
  assert.strictEqual(out[0].failed, true, JSON.stringify(out[0]));
  assert.ok(out[1].failed !== true && typeof out[1].owner === 'string', JSON.stringify(out[1]));
  assert.deepStrictEqual(read(dir), out[1]);
  assert.deepStrictEqual(read(dir), winAcl.fileAcl(dir));
  say('a batch of [missing, folder]: [failed, ACL]');
});

