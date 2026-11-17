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
    fs.mkdirSync(path.dirname(bin), {mode: 0o700});
    fs.writeFileSync(bin, 'binary', {mode: 0o755});
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
    assert.deepStrictEqual(shimFor({home, locate: elsewhere}), {shim: bin, note: null}, '<home>/shim/ch-shim first');
    if (process.platform !== 'win32') {
      // each passed over for the lookup, and said
      const passedOver = (why, re) => {
        const r = shimFor({home, locate: elsewhere});
        assert.strictEqual(r.shim, '/x/ch-shim', why);
        assert.match(r.note, re, why);
      };
      fs.chmodSync(bin, 0o644);
      passedOver('a file that is not executable', /installed shim is not used: .*ch-shim: it is not executable by its owner/);
      fs.chmodSync(bin, 0o775);
      passedOver('a file group can write', /ch-shim: it is writable by group or others \(mode 0775\)/);
      fs.chmodSync(bin, 0o757);
      passedOver('a file others can write', /ch-shim: it is writable by group or others \(mode 0757\)/);
      fs.chmodSync(bin, 0o4755);
      passedOver('a setuid file', /ch-shim: it is setuid or setgid \(mode 4755\)/);
      fs.chmodSync(bin, 0o2755);
      passedOver('a setgid file', /ch-shim: it is setuid or setgid \(mode 2755\)/);
      fs.chmodSync(bin, 0o755);
      for (const mode of [0o750, 0o705, 0o770, 0o755, 0o2700, 0o1700, 0o500]) {
        fs.chmodSync(path.dirname(bin), mode);
        const shown = mode.toString(8).padStart(4, '0');
        passedOver(`a directory of mode ${shown}`, new RegExp(`shim: its mode is ${shown}, not 0700`));
      }
      fs.chmodSync(path.dirname(bin), 0o700);
      const other = shimFor({home, locate: elsewhere, geteuid: () => process.geteuid() + 1});
      assert.strictEqual(other.shim, '/x/ch-shim');
      assert.match(other.note, /shim: it is owned by uid \d+, not this user/, 'the directory (then the file) must be this user\'s, by effective uid');
      fs.chmodSync(home, 0o770);
      passedOver('a home its group can write', /: it is group- or world-writable \(mode 0770\)/);
      fs.chmodSync(home, 0o700);
      assert.deepStrictEqual(shimFor({home, locate: elsewhere}), {shim: bin, note: null}, 'back to 700 and 755: used');
      const usedOverMissing = shimFor({home, locate: () => ({status: 'missing', package: 'p'})});
      fs.chmodSync(bin, 0o777);
      const both = shimFor({home, locate: () => ({status: 'missing', package: 'p'})});
      assert.strictEqual(both.shim, null);
      assert.match(both.note, /installed shim is not used: [\s\S]*\(p\) is not installed/, 'the reason, then the fallback\'s line');
      assert.deepStrictEqual(usedOverMissing, {shim: bin, note: null}, 'a sound install is used whatever the lookup says');
      fs.rmSync(bin);
      fs.symlinkSync('/x/ch-shim', bin);
      passedOver('a link in <home>/shim', /ch-shim: it is not a regular file \(or is a link\)/);
      fs.rmSync(bin);
      fs.writeFileSync(bin, 'binary', {mode: 0o755});
      const real = path.join(home, 'shim-real');
      fs.renameSync(path.dirname(bin), real);
      fs.symlinkSync(real, path.join(home, 'shim'));
      passedOver('<home>/shim a link', /shim: it is a symbolic link/);
      fs.rmSync(path.join(home, 'shim'));
      fs.writeFileSync(path.join(home, 'shim'), 'not a directory');
      passedOver('<home>/shim a file (lstat of ch-shim: ENOTDIR), said, not taken for "none there"', /ch-shim could not be read \(ENOTDIR\)/);
    }
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('on Windows the installed shim is used only when its directory and file pass privateProblem (owner and DACL)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {shimFor} = require('../lib/shim-binary');
  const {privateProblem} = require('../lib/win-acl');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shimfor-win-'));
  try {
    const bin = path.join(home, 'shim', 'ch-shim.exe');
    fs.mkdirSync(path.dirname(bin), {mode: 0o700});
    fs.writeFileSync(bin, 'binary');
    const me = 'S-1-5-21-1-2-3-1001';
    const mine = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-18', type: 'Allow', rights: 2032127}]};
    const open = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-32-545', type: 'Allow', rights: 1179817}]};
    const run = (acls) => shimFor({home, platform: 'win32', locate: () => ({status: 'found', path: 'C:\\x\\ch-shim.exe'}), acl: {privateProblem, fileAcl: (p) => {
      const a = acls[p === bin ? 'file' : 'dir'];
      if (a instanceof Error) throw a;
      return a;
    }}});
    assert.deepStrictEqual(run({dir: mine, file: mine}), {shim: bin, note: null}, 'both private: used');
    let r = run({dir: open, file: mine});
    assert.strictEqual(r.shim, 'C:\\x\\ch-shim.exe');
    assert.match(r.note, /installed shim is not used: .*shim: .*is accessible by S-1-5-32-545/, 'a directory Users can read and execute (Windows refuses any rule beyond HARMLESS, as private-file does)');
    r = run({dir: mine, file: open});
    assert.match(r.note, /ch-shim\.exe: .*is accessible by S-1-5-32-545/, 'a file Users can read and execute');
    r = run({dir: mine, file: Object.assign({}, mine, {owner: 'S-1-5-21-9-9-9-1002'})});
    assert.match(r.note, /ch-shim\.exe: .*is owned by S-1-5-21-9-9-9-1002/, 'a file another user owns');
    r = run({dir: new Error('powershell failed'), file: mine});
    assert.match(r.note, /shim could not be checked \(powershell failed\)/, 'an unreadable DACL fails closed');
    assert.strictEqual(r.shim, 'C:\\x\\ch-shim.exe');
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
    assert.deepStrictEqual(JSON.parse(lines[0]), {status: 'ok', conditions: 'no', repo: 'acme/widgets', token: null, why: {reason: 'not an interactive session'}});
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

// the scan's why, for the runtime's latch: a closed reason, and where it was
// seen under the home ("~/..."), never a path outside it
test('conditions: a "no" carries its why: the reason, and where under the home it was seen', async() => {
  const home = homeWithSecret();
  const user = tmpHome();
  try {
    fs.mkdirSync(path.join(user, '.claude'));
    fs.writeFileSync(path.join(user, '.claude', 'settings.json'), JSON.stringify({hooks: {Elicitation: [{hooks: [{type: 'command', command: 'true'}]}]}}));
    const project = path.join(user, 'project');
    fs.mkdirSync(project);
    const io = conditionsIo({env: {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: project}, cwd: project});
    io.homedir = () => user;
    io.conditionsStopAt = user;
    assert.strictEqual(await conditions.conditions({pid: 1, home}, io), 0, io.err);
    const line = JSON.parse(io.out);
    assert.strictEqual(line.conditions, 'no');
    assert.deepStrictEqual(line.why, {reason: 'client hook present', at: '~/.claude/settings.json'});
    assert.ok(!io.out.includes(user), 'the home\'s own path is never sent');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(user, {recursive: true, force: true});
  }
});

test('conditions: whyOf: a reason outside the closed set is none; a path outside the home is never sent; a path is cut and cleaned', () => {
  const u = path.join(path.sep, 'home', 'someone');
  assert.strictEqual(conditions.whyOf({mayElicit: false, why: 'made-up reason', at: path.join(u, 'x')}, u), null);
  assert.deepStrictEqual(conditions.whyOf({mayElicit: false, why: 'plugin hook present', at: path.join(path.sep, 'opt', 'other-user', 'plugins', 'p')}, u), {reason: 'plugin hook present'});
  assert.deepStrictEqual(conditions.whyOf({mayElicit: false, why: 'plugin hook present', at: path.join(u, '..', 'other', 'p')}, u), {reason: 'plugin hook present'});
  assert.deepStrictEqual(conditions.whyOf({mayElicit: false, why: 'client hook present', at: u}, u), {reason: 'client hook present'}, 'the home itself names nothing');
  const odd = conditions.whyOf({mayElicit: false, why: 'client hook present', at: path.join(u, `pl\u202eugin\u{e0041}${'x'.repeat(300)}`)}, u);
  assert.ok(/^~\/pl ugin /.test(odd.at), odd.at);
  assert.strictEqual(Array.from(odd.at).length, 200);
  assert.deepStrictEqual(conditions.whyOf({mayElicit: false, why: 'client settings unreadable', at: null}, u), {reason: 'client settings unreadable'});
});

// the shared rule for the why (countinghouse's conditionsWhy vectors, copied)
const WHY_V = require('./vectors/conditions-why.json').conditionsWhy;
const whyOk = (w) => {
  const hidden = new RegExp(`[${WHY_V.hiddenClass}]`, 'u');
  return w != null && typeof w === 'object' && !Array.isArray(w) && WHY_V.reasons.includes(w.reason) && Object.keys(w).every((k) => k === 'reason' || k === 'at')
    && (w.at === undefined || (typeof w.at === 'string' && w.at.startsWith('~/') && Array.from(w.at).length <= 200 && !hidden.test(w.at) && !w.at.split('/').includes('..')));
};

test('conditions: the why holds to the shared vectors: the vectors\' own cases, the closed reasons, and every why whyOf makes', () => {
  for (const {why, value} of WHY_V.accepted) assert.strictEqual(whyOk(value), true, why);
  for (const {why, value} of WHY_V.refused) assert.strictEqual(whyOk(value), false, why);
  assert.deepStrictEqual([...require('../lib/client-conditions').REASONS].sort(), [...WHY_V.reasons].sort());
  assert.strictEqual(require('../lib/clean-text').HIDDEN_CLASS, WHY_V.hiddenClass, 'one definition of a hidden character');
  const u = path.join(path.sep, 'home', 'someone');
  for (const at of [path.join(u, '.claude', 'settings.json'), path.join(u, `x\u202e${'y'.repeat(400)}`), path.join(path.sep, 'opt', 'x'), null]) {
    for (const why of WHY_V.reasons) {
      const w = conditions.whyOf({mayElicit: false, why, at}, u);
      assert.ok(whyOk(w), JSON.stringify(w));
    }
  }
});

test('conditions: whyOf by real path: a home through a link keeps its places; a shallow home is no boundary; ..dotfiles is under the home', () => {
  const root = tmpHome();
  try {
    const realHome = path.join(root, 'var', 'home', 'u');
    fs.mkdirSync(path.join(realHome, 'proj', '.claude'), {recursive: true});
    fs.mkdirSync(path.join(realHome, '..dotfiles', '.claude'), {recursive: true});
    fs.mkdirSync(path.join(root, 'home'));
    fs.symlinkSync(realHome, path.join(root, 'home', 'u'), process.platform === 'win32' ? 'junction' : 'dir');
    const hook = 'client hook present';
    // HOME through the link, the hit by its real path (as cwd gives it)
    assert.deepStrictEqual(conditions.whyOf({why: hook, at: path.join(realHome, 'proj', '.claude', 'settings.json')}, path.join(root, 'home', 'u')), {reason: hook, at: '~/proj/.claude/settings.json'});
    assert.deepStrictEqual(conditions.whyOf({why: hook, at: path.join(realHome, '..dotfiles', '.claude')}, realHome), {reason: hook, at: '~/..dotfiles/.claude'});
    // HOME=/ or one level down: nothing under it is sent
    assert.deepStrictEqual(conditions.whyOf({why: hook, at: path.join(realHome, 'proj')}, path.parse(root).root), {reason: hook});
    assert.deepStrictEqual(conditions.whyOf({why: hook, at: path.join(path.parse(root).root, 'home', 'alice', '.claude')}, path.join(path.parse(root).root, 'home')), {reason: hook});
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('conditions: a why that would take the line over the shim\'s 4 KiB is dropped, and the "no" still sent', async() => {
  const home = homeWithSecret();
  const user = tmpHome();
  try {
    const deep = path.join(user, ...Array.from({length: 4}, () => `${'\u{1F600}'.repeat(50)}`));
    fs.mkdirSync(path.join(deep, '.claude'), {recursive: true});
    fs.writeFileSync(path.join(deep, '.claude', 'settings.json'), JSON.stringify({hooks: {Elicitation: [{hooks: [{type: 'command', command: 'true'}]}]}}));
    const packs = {};
    const env = {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: deep};
    for (let i = 0; i < conditions.MAX_CREDENTIALS; i++) {
      const name = `PACK_VAR_${String(i).padStart(2, '0')}_${'X'.repeat(60)}`;
      packs[`p${i}`] = [name];
      env[name] = `example-${i}`;
    }
    withPacks(home, packs);
    const io = conditionsIo({env, cwd: deep});
    io.homedir = () => user;
    io.conditionsStopAt = user;
    assert.strictEqual(await conditions.conditions({pid: 1, home}, io), 0, io.err);
    const line = JSON.parse(io.out);
    assert.strictEqual(line.conditions, 'no');
    assert.ok(!('why' in line), 'dropped, not a failure');
    assert.strictEqual(Object.keys(line.credentials).length, conditions.MAX_CREDENTIALS);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(user, {recursive: true, force: true});
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

// the pack credentials the client environment chooses (a session whose
// choice the shared runtime lacks runs its own runtime), named by the
// installed packs only: packs.json, as install writes it
function withPacks(home, packs) {
  fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({runtime: {versions: {countinghouse: '8.0.0'}}, packs: Object.fromEntries(Object.entries(packs).map(([n, credentials]) => [n, {packages: {[`@countinghouse/ch-pack-${n}`]: '1.0.0'}, credentials}]))}));
}
const CRED_V = require('./vectors/credentials.json');

test('conditions: a pack credential the environment chooses, by the installed packs\' names, as the vectors\' keyed hash; never its value', async() => {
  const home = homeWithSecret();
  try {
    // SECRET is the vectors' own (32 bytes of 0x5a), so the MAC is theirs exactly
    withPacks(home, {other: [CRED_V.credentialMac.name], ci: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']});
    const io = conditionsIo({env: {[CRED_V.credentialMac.name]: CRED_V.credentialMac.value, UNDECLARED_TOKEN: 'example-undeclared', GITHUB_TOKEN: 'example-shell-token'}});
    assert.strictEqual(await conditions.conditions({pid: 1, home}, io), 0, io.err);
    const line = JSON.parse(io.out);
    assert.deepStrictEqual(line.credentials, {[CRED_V.credentialMac.name]: CRED_V.credentialMac.macB64}, 'only the declared one; the GitHub ones are token\'s');
    assert.deepStrictEqual(JSON.parse(CRED_V.clientCredentials).credentials, line.credentials, 'the vectors\' client frame');
    for (const v of [CRED_V.credentialMac.value, 'example-undeclared', 'example-shell-token']) assert.ok(!io.out.includes(v) && !io.err.includes(v), 'no value is printed');
    assert.ok(!io.out.includes('UNDECLARED_TOKEN'), 'no name the environment offers');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('conditions: no pack credential chosen, or no packs: no credentials key, and the secret is not read for them', async() => {
  const home = homeWithSecret();
  try {
    let io = conditionsIo({env: {}});
    await conditions.conditions({pid: 1, home}, io);
    assert.ok(!('credentials' in JSON.parse(io.out)));
    withPacks(home, {other: ['OTHER_TOKEN']});
    io = conditionsIo({env: {OTHER_TOKEN: '${OTHER_TOKEN}'}});
    await conditions.conditions({pid: 1, home}, io);
    assert.ok(!('credentials' in JSON.parse(io.out)), 'an unresolved placeholder is no choice, as for start');
    // no secret needed when nothing is hashed
    fs.rmSync(path.join(home, 'run', 'daemon', 'secret'));
    io = conditionsIo({env: {}});
    assert.strictEqual(await conditions.conditions({pid: 1, home}, io), 0, io.err);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('conditions: start\'s precedence: a pack whose choice is a GitHub variable is token\'s, not a credential; a name the runtime would refuse fails the check', async() => {
  const home = homeWithSecret();
  try {
    withPacks(home, {mixed: ['COUNTINGHOUSE_GITHUB_TOKEN', 'OTHER_TOKEN']});
    let io = conditionsIo({env: {COUNTINGHOUSE_GITHUB_TOKEN: 'example-narrow-token', OTHER_TOKEN: 'example-other'}});
    assert.strictEqual(await conditions.conditions({pid: 1, home}, io), 0, io.err);
    assert.ok(!('credentials' in JSON.parse(io.out)), 'start would load it with the GitHub token');
    io = conditionsIo({env: {OTHER_TOKEN: 'example-other'}});
    await conditions.conditions({pid: 1, home}, io);
    assert.deepStrictEqual(Object.keys(JSON.parse(io.out).credentials), ['OTHER_TOKEN'], 'with no GitHub token set, the other');
    withPacks(home, {odd: ['MY-API-KEY']});
    io = conditionsIo({env: {'MY-API-KEY': 'example-odd'}});
    assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0);
    assert.strictEqual(io.out, '');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('conditions: a line that would pass the shim\'s 4 KiB fails here, named, with no line', async() => {
  const home = homeWithSecret();
  try {
    const packs = {};
    const env = {};
    for (let i = 0; i < conditions.MAX_CREDENTIALS; i++) {
      const name = `PACK_VAR_${String(i).padStart(2, '0')}_${'X'.repeat(110)}`;
      packs[`p${i}`] = [name];
      env[name] = `example-${i}`;
    }
    withPacks(home, packs);
    const io = conditionsIo({env});
    assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0);
    assert.strictEqual(io.out, '');
    assert.match(io.err, new RegExp(`over ${conditions.MAX_LINE_BYTES} bytes`));
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('conditions: more than 32 chosen pack credentials, or packs.json that cannot be read, is a failure: no line, a non-zero exit', async() => {
  const home = homeWithSecret();
  try {
    const many = {};
    const env = {};
    for (let i = 0; i <= conditions.MAX_CREDENTIALS; i++) { many[`p${i}`] = [`EXAMPLE_${i}_TOKEN`]; env[`EXAMPLE_${i}_TOKEN`] = `example-${i}`; }
    withPacks(home, many);
    let io = conditionsIo({env});
    assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0);
    assert.strictEqual(io.out, '');
    fs.writeFileSync(path.join(home, 'packs.json'), '{not json');
    io = conditionsIo({env: {}});
    assert.notStrictEqual(await conditions.conditions({pid: 1, home}, io), 0);
    assert.strictEqual(io.out, '');
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
