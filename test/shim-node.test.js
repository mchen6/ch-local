'use strict';
// C4, the shim's Node side (countinghouse's shared-runtime design, #236,
// sections 5, 6 and 10): shim.json as install writes it, each client's entry
// naming the native shim with --home (or the per-session mode where there is
// no binary), and `ch-local conditions --for <pid>`, whose one line the shim
// carries as its `client` frame. Against the shim's own vectors
// (shim/tests/vectors/contract-2.json).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fakeIo} = require('./fake-io');
const shimConfig = require('../lib/shim-config');
const {snippet} = require('../lib/snippets');
const conditions = require('../lib/conditions-command');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shim', 'tests', 'vectors', 'contract-2.json'), 'utf8'));
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-c4-'));

// Each platform's case runs on every OS: the platform is given, and so are
// its paths (no host temporary directory, whose form is the host's)
test('shim.json: absolute node and chLocal, and only the allowlisted environment, as strings (POSIX)', () => {
  const home = '/home/dev/.countinghouse';
  const env = {PATH: '/usr/bin:/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', NODE_OPTIONS: '--require /tmp/x.js',
    COUNTINGHOUSE_GITHUB_TOKEN: 'not-for-the-daemon', SHELL: '/bin/zsh'};
  const body = shimConfig.shimJsonFor({node: '/usr/local/bin/node', home, env, platform: 'linux'});
  assert.deepStrictEqual(body, {node: '/usr/local/bin/node', chLocal: '/home/dev/.countinghouse/bin/ch-local.js',
    env: {PATH: '/usr/bin:/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8', TMPDIR: '/tmp'}});
  assert.strictEqual(shimConfig.shimJsonProblem(body, 'linux'), null);
});

test('shim.json: absolute node and chLocal, and only the allowlisted environment, as strings (Windows)', () => {
  const home = 'C:\\Users\\dev\\.countinghouse';
  const env = {PATH: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\dev', NODE_OPTIONS: '--require C:\\x.js', COUNTINGHOUSE_GITHUB_TOKEN: 'not-for-the-daemon'};
  const body = shimConfig.shimJsonFor({node: 'C:\\Program Files\\nodejs\\node.exe', home, env, platform: 'win32'});
  assert.deepStrictEqual(body, {node: 'C:\\Program Files\\nodejs\\node.exe', chLocal: 'C:\\Users\\dev\\.countinghouse\\bin\\ch-local.js',
    env: {PATH: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\dev'}});
  assert.strictEqual(shimConfig.shimJsonProblem(body, 'win32'), null);
  assert.match(shimConfig.shimJsonProblem(body, 'linux'), /node is not an absolute path/, 'and judged by its own platform\'s rule');
});

test('shim.json on Windows takes USERPROFILE and the Windows variables, never HOME or TMPDIR', () => {
  const env = {Path: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\dev', HOME: 'C:\\x', TMPDIR: 'C:\\t', SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp', TMP: 'C:\\Users\\dev\\AppData\\Local\\Temp', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local'};
  const body = shimConfig.shimJsonFor({node: 'C:\\node\\node.exe', home: 'C:\\Users\\dev\\.countinghouse', env, platform: 'win32'});
  assert.deepStrictEqual(Object.keys(body.env).sort(), ['APPDATA', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']);
  assert.strictEqual(body.env.PATH, 'C:\\Windows\\system32', 'Windows\'s Path, whatever its case, as PATH');
});

test('the shim\'s vectors: every accepted form passes, every refused one fails', () => {
  for (const ok of VECTORS.shimJson.acceptedPosix) assert.strictEqual(shimConfig.shimJsonProblem(ok, 'linux'), null, JSON.stringify(ok));
  for (const ok of VECTORS.shimJson.acceptedWindows) assert.strictEqual(shimConfig.shimJsonProblem(ok, 'win32'), null, JSON.stringify(ok));
  for (const bad of VECTORS.shimJson.refused) assert.notStrictEqual(shimConfig.shimJsonProblem(bad.value, 'linux'), null, bad.why);
});

test('shim.json is written 0600, never through a symlink, and rewritten in place', {skip: process.platform === 'win32'}, () => {
  const home = tmpHome();
  try {
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, 'theirs');
    fs.symlinkSync(target, path.join(home, 'shim.json'));
    shimConfig.writeShimJson(home, {node: '/usr/local/bin/node', home, env: {PATH: '/usr/bin', HOME: '/home/dev'}, platform: 'linux'});
    const st = fs.lstatSync(path.join(home, 'shim.json'));
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'the link is replaced by a file of ours');
    assert.strictEqual(st.mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs', 'the link\'s target is untouched');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8')).node, '/usr/local/bin/node');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a client\'s entry names the shim with --home where there is a binary', () => {
  const shim = '/home/dev/.countinghouse/app/node_modules/@countinghouse/ch-shim-linux-x64/bin/ch-shim';
  const home = '/home/dev/.countinghouse';
  const cursor = JSON.parse(snippet('cursor', {node: '/n', launcher: '/l', shim, home}).text).mcpServers.countinghouse;
  assert.deepStrictEqual(cursor, {command: shim, args: ['--home', home]});
  const vscode = JSON.parse(snippet('vscode', {node: '/n', launcher: '/l', shim, home}).text).mcpServers.countinghouse;
  assert.deepStrictEqual(vscode, {type: 'stdio', command: shim, args: ['--home', home]});
  assert.match(snippet('codex', {node: '/n', launcher: '/l', shim, home}).text, /command = ".*ch-shim"\nargs = \["--home", "\/home\/dev\/\.countinghouse"\]/);
  assert.match(snippet('claude-code', {node: '/n', launcher: '/l', shim, home}).text, /-- "?\/home\/dev\/.*ch-shim"? --home \/home\/dev\/\.countinghouse\n$/);
  // without one, today's entry: the per-session runtime
  const own = JSON.parse(snippet('cursor', {node: '/n', launcher: '/l'}).text).mcpServers.countinghouse;
  assert.deepStrictEqual(own, {command: '/n', args: ['/l', 'start', '--stdio']});
});

test('the shim install puts in <home>/shim wins over any other lookup; a link there is not trusted', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {shimFor} = require('../lib/shim-binary');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shimfor-'));
  try {
    const elsewhere = () => ({status: 'found', path: '/x/ch-shim'});
    assert.deepStrictEqual(shimFor({home, locate: elsewhere}), {shim: '/x/ch-shim', note: null}, 'no <home>/shim yet: the lookup');
    const bin = path.join(home, 'shim', process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
    fs.mkdirSync(path.dirname(bin));
    fs.writeFileSync(bin, 'binary', {mode: 0o755});
    assert.deepStrictEqual(shimFor({home, locate: elsewhere}), {shim: bin, note: null}, '<home>/shim/ch-shim first');
    if (process.platform !== 'win32') {
      fs.rmSync(bin);
      fs.symlinkSync('/x/ch-shim', bin);
      assert.deepStrictEqual(shimFor({home, locate: elsewhere}), {shim: '/x/ch-shim', note: null}, 'a link in <home>/shim is passed over');
    }
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('the shim\'s binary: found, missing (say reinstall), or unsupported (the per-session mode)', () => {
  const {shimFor} = require('../lib/shim-binary');
  assert.deepStrictEqual(shimFor({locate: () => ({status: 'found', path: '/x/ch-shim'})}), {shim: '/x/ch-shim', note: null});
  const missing = shimFor({locate: () => ({status: 'missing', package: '@countinghouse/ch-shim-linux-x64'})});
  assert.strictEqual(missing.shim, null);
  assert.match(missing.note, /@countinghouse\/ch-shim-linux-x64\) is not installed.*reinstall/s);
  const none = shimFor({locate: () => ({status: 'unsupported'})});
  assert.strictEqual(none.shim, null);
  assert.match(none.note, /runs one runtime per session/);
});

// conditions --for <pid> ---------------------------------------------------

function conditionsIo({env = {}, cwd, gh = {status: 1, stdout: ''}, ancestry} = {}) {
  const io = fakeIo({env, exec: (cmd) => (cmd === 'gh' ? gh : {status: 0, stdout: ''})});
  io.cwd = cwd;
  io.clientAncestry = ancestry !== undefined ? ancestry : Promise.resolve({lines: null, policyPresent: false});
  return io;
}
const SECRET = Buffer.alloc(32, 0x5a);
function homeWithSecret() {
  const home = tmpHome();
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.writeFileSync(path.join(run, 'secret'), `${SECRET.toString('hex')}\n`, {mode: 0o600});
  return home;
}
const mac = (token) => crypto.createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from('ch-token'), Buffer.from(token, 'utf8')])).digest('base64');

test('conditions: one JSON line; no interactive Claude Code session is "no"; the repo from cwd\'s origin', async() => {
  const home = homeWithSecret();
  const repo = tmpHome();
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n');
    const io = conditionsIo({env: {}, cwd: repo});
    assert.strictEqual(await conditions.conditions({pid: 4242, home}, io), 0);
    const lines = io.out.split('\n').filter((l) => l !== '');
    assert.strictEqual(lines.length, 1, io.out);
    assert.deepStrictEqual(JSON.parse(lines[0]), {status: 'ok', conditions: 'no', repo: 'acme/widgets', token: null});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

test('conditions: the token the environment chooses, as its keyed hash; gh asked only when it can change the answer', async() => {
  const home = homeWithSecret();
  const asked = (io) => io.execs.filter((e) => e.cmd === 'gh').length;
  try {
    // COUNTINGHOUSE_GITHUB_TOKEN is the user's explicit choice: gh can't change it
    let io = conditionsIo({env: {COUNTINGHOUSE_GITHUB_TOKEN: 'example-narrow-token', GITHUB_TOKEN: 'example-shell-token'}});
    assert.strictEqual(await conditions.conditions({pid: 1, home}, io), 0);
    assert.strictEqual(JSON.parse(io.out).token, mac('example-narrow-token'));
    assert.ok(!io.out.includes('example-narrow-token'));
    assert.strictEqual(asked(io), 0);
    // nothing set: none chosen, and gh isn't asked (null means the daemon's)
    io = conditionsIo({env: {}});
    await conditions.conditions({pid: 1, home}, io);
    assert.strictEqual(JSON.parse(io.out).token, null);
    assert.strictEqual(asked(io), 0);
    // only GITHUB_TOKEN: gh decides. A gh login chooses nothing...
    io = conditionsIo({env: {GITHUB_TOKEN: 'example-shell-token'}, gh: {status: 0, stdout: 'gho_exampleexampleexample\n'}});
    await conditions.conditions({pid: 1, home}, io);
    assert.strictEqual(JSON.parse(io.out).token, null);
    assert.strictEqual(asked(io), 1);
    // ...and gh not logged in leaves GITHUB_TOKEN the choice
    io = conditionsIo({env: {GITHUB_TOKEN: 'example-shell-token'}, gh: {status: 1, stdout: ''}});
    await conditions.conditions({pid: 1, home}, io);
    assert.strictEqual(JSON.parse(io.out).token, mac('example-shell-token'));
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('conditions: a gh that times out or cannot run is a failure, never "none chosen": no line, a non-zero exit', async() => {
  const home = homeWithSecret();
  try {
    for (const gh of [{status: null, stdout: ''}, 'timeout']) {
      const io = conditionsIo({env: {GITHUB_TOKEN: 'example-shell-token'}, gh: gh === 'timeout' ? new Promise(() => {}) : gh});
      io.ghTimeoutMs = 100;
      assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0, JSON.stringify(gh));
      assert.strictEqual(io.out, '');
    }
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('conditions: a chosen token with no readable secret, or a bad --for, is a failure: no line, a non-zero exit', async() => {
  const home = tmpHome();
  try {
    const io = conditionsIo({env: {COUNTINGHOUSE_GITHUB_TOKEN: 'example-narrow-token'}});
    assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0);
    assert.strictEqual(io.out, '');
    const bad = conditionsIo({});
    assert.notStrictEqual(await conditions.conditions({pid: 'x', home}, bad), 0);
    assert.strictEqual(bad.out, '');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('the CLI: ch-local conditions --for <pid> --home <abs>, both required', async() => {
  const {main} = require('../bin/ch-local');
  const home = homeWithSecret();
  try {
    const io = conditionsIo({env: {}});
    assert.strictEqual(await main(['conditions', '--for', '77', '--home', home], io), 0, io.err);
    assert.strictEqual(JSON.parse(io.out).status, 'ok');
    const relative = conditionsIo({env: {}});
    assert.strictEqual(await main(['conditions', '--for', '77', '--home', 'relative/home'], relative), 2);
    const missing = conditionsIo({env: {}});
    assert.strictEqual(await main(['conditions', '--for', '77'], missing), 2, '--home is required');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// ch-local #31's review -------------------------------------------------------

test('conditions: the secret is read with the shim\'s checks: a 0777 directory, a 0666 secret, a symlink or a FIFO is a failure', {skip: process.platform === 'win32'}, async() => {
  const cases = [
    ['a 0777 directory', (run) => fs.chmodSync(run, 0o777)],
    ['a 0666 secret', (run) => fs.chmodSync(path.join(run, 'secret'), 0o666)],
    ['a symlinked secret', (run) => { const t = path.join(run, 'real'); fs.renameSync(path.join(run, 'secret'), t); fs.symlinkSync(t, path.join(run, 'secret')); }],
    ['a FIFO at the secret\'s path', (run) => { fs.rmSync(path.join(run, 'secret')); require('node:child_process').execFileSync('mkfifo', ['-m', '600', path.join(run, 'secret')]); }]
  ];
  for (const [what, spoil] of cases) {
    const home = homeWithSecret();
    try {
      spoil(path.join(home, 'run', 'daemon'));
      const io = conditionsIo({env: {COUNTINGHOUSE_GITHUB_TOKEN: 'example-narrow-token'}});
      const started = Date.now();
      assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0, what);
      assert.strictEqual(io.out, '', what);
      assert.ok(Date.now() - started < 2000, `${what}: never blocks`);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  }
});

test('conditions: gh runs in the home, never in the client\'s directory', async() => {
  const home = homeWithSecret();
  try {
    const io = conditionsIo({env: {GITHUB_TOKEN: 'example-shell-token'}, cwd: os.tmpdir(), gh: {status: 1, stdout: ''}});
    await conditions.conditions({pid: 1, home}, io);
    const gh = io.execs.find((e) => e.cmd === 'gh');
    assert.strictEqual(gh.cwd, home);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('shim.json is checked per platform, and a .cmd or .bat node is refused', () => {
  const posix = {node: '/usr/bin/node', chLocal: '/h/bin/ch-local.js', env: {PATH: '/usr/bin', HOME: '/home/u'}};
  assert.strictEqual(shimConfig.shimJsonProblem(posix, 'linux'), null);
  assert.match(String(shimConfig.shimJsonProblem({...posix, env: {APPDATA: 'x'}}, 'linux')), /APPDATA/);
  assert.match(String(shimConfig.shimJsonProblem({...posix, node: 'C:\\node\\node.exe'}, 'linux')), /node is not an absolute/);
  const win = {node: 'C:\\node\\node.exe', chLocal: 'C:\\h\\bin\\ch-local.js', env: {PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u'}};
  assert.strictEqual(shimConfig.shimJsonProblem(win, 'win32'), null);
  assert.match(String(shimConfig.shimJsonProblem({...win, env: {HOME: 'C:\\x'}}, 'win32')), /HOME/);
  assert.match(String(shimConfig.shimJsonProblem({...win, node: '/usr/bin/node'}, 'win32')), /node is not an absolute/);
  for (const node of ['C:\\node\\node.CMD', 'C:\\node\\node.bat']) assert.match(String(shimConfig.shimJsonProblem({...win, node}, 'win32')), /\.cmd or \.bat/);
  assert.match(String(shimConfig.shimJsonProblem({...posix, node: '/opt/node.bat'}, 'linux')), /\.cmd or \.bat/);
});

test('shim.json is 0600 whatever the umask', {skip: process.platform === 'win32'}, () => {
  const home = tmpHome();
  const old = process.umask(0o277);
  try {
    shimConfig.writeShimJson(home, {node: '/usr/local/bin/node', env: {PATH: '/usr/bin', HOME: '/home/dev'}, platform: 'linux'});
    assert.strictEqual(fs.statSync(path.join(home, 'shim.json')).mode & 0o777, 0o600);
  } finally {
    process.umask(old);
    fs.rmSync(home, {recursive: true, force: true});
  }
});
