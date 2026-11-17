'use strict';
// The stored GitHub token (ch-local credentials; lib/credential-store.js,
// lib/credentials-command.js, lib/github-token.js chooseGitHubToken): kept
// this user's alone and never repaired, taken at a terminal only and never
// shown, bound to the access module that declares it, used in one order by
// start, the daemon's runtime and the conditions check, and removed with the
// program. Token values are made here, never literals.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const store = require('../lib/credential-store');
const {credentials} = require('../lib/credentials-command');
const {chooseGitHubToken} = require('../lib/github-token');
const {readHidden} = require('../lib/hidden-input');

const POSIX = {skip: process.platform === 'win32' && 'POSIX modes'};
const made = () => `t${crypto.randomBytes(12).toString('hex')}`;
const ACCESS = '@countinghouse/ch-access-github';
const VAR = 'COUNTINGHOUSE_GITHUB_TOKEN';
const GITHUB = {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  credential: {env: VAR, fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};

// an installed home (the flat layout) whose pack's access module declares
// the GitHub variables; extra: more access modules that declare them too
function home({extra = []} = {}) {
  const h = tmp('ch-cred-');
  fs.chmodSync(h, 0o700);
  const pkgs = {'@countinghouse/ch-pack-ci-failure-triage': {role: 'scenario'}, [ACCESS]: {role: 'part', remotes: [GITHUB]}};
  for (const m of extra) pkgs[m] = {role: 'part', remotes: [GITHUB]};
  for (const [name, countinghouse] of Object.entries(pkgs)) {
    const at = path.join(h, 'app', 'node_modules', ...name.split('/'));
    fs.mkdirSync(at, {recursive: true});
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse}));
  }
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: {countinghouse: '1.0.0'}}, packs: {
    'ci-failure-triage': {packages: Object.fromEntries(Object.keys(pkgs).map((n) => [n, '1.0.0'])), credentials: [VAR, 'GITHUB_TOKEN']}}}));
  return h;
}
const io = (h, {terminal = true, typed = null, env = {}} = {}) => {
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: h, ...env}, homedir: '/nowhere'});
  Object.assign(f, {terminal, pid: 4242, hostname: 'box-1'});
  if (typed !== null) f.readHidden = async (prompt) => { f.prompts = [...(f.prompts || []), prompt]; if (typed instanceof Error) throw typed; return typed; };
  return f;
};
const everything = (h, f) => {
  const history = fs.existsSync(path.join(h, 'history.jsonl')) ? fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8') : '';
  return `${f.out}\n${f.err}\n${history}\n${(f.prompts || []).join('\n')}`;
};

test('add at a terminal: stored for the access module that declares it, 0700 and 0600, the value shown nowhere; list shows names only; remove takes it away', POSIX, async () => {
  const h = home();
  const value = made();
  const f = io(h, {typed: value});
  assert.strictEqual(await credentials({action: 'add', name: 'github'}, f), 0, f.err);
  assert.strictEqual(store.get(h, VAR), value);
  assert.deepStrictEqual(store.list(h), [{variable: VAR, module: ACCESS}]);
  assert.strictEqual(fs.statSync(path.join(h, 'credentials')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(h, 'credentials', 'credentials.json')).mode & 0o777, 0o600);
  assert.match(f.prompts[0], /github credential for @countinghouse\/ch-access-github \(input hidden\)/);
  assert.match(f.out, /stored for @countinghouse\/ch-access-github, readable by this user only \(another program running as this user can read it/);
  assert.ok(!everything(h, f).includes(value), 'never in the output, the prompt or the history');
  const l = io(h);
  assert.strictEqual(await credentials({action: 'list'}, l), 0);
  assert.strictEqual(l.out, `github  ${VAR}  (for ${ACCESS})\n`);
  const r = io(h);
  assert.strictEqual(await credentials({action: 'remove', name: 'github'}, r), 0);
  assert.strictEqual(store.get(h, VAR), null);
  assert.ok(!fs.existsSync(path.join(h, 'credentials', 'credentials.json')), 'the file goes with its last entry');
  assert.ok(!everything(h, r).includes(value));
});

test('add: no terminal, an aborted entry, or a value that is not a token: refused, nothing stored, the value never shown back', async () => {
  const h = home();
  const value = made();
  for (const f of [io(h, {terminal: false, typed: value}), io(h, {typed: Object.assign(new Error('x'), {code: 'ABORTED'})})]) {
    assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, f), 0);
    assert.strictEqual(store.get(h, VAR), null);
  }
  const noTerm = io(h, {terminal: false, typed: value});
  await credentials({action: 'add', name: 'github'}, noTerm);
  assert.match(noTerm.err, /at a terminal, with nothing shown; run it in one/);
  for (const bad of [`${value} trailing`, 'short', `${value}‮`, 'x'.repeat(300)]) {
    const f = io(h, {typed: bad});
    assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, f), 0, JSON.stringify(bad));
    assert.match(f.err, /does not look like a token/);
    assert.ok(!f.err.includes(bad) && !f.err.includes(value), 'not even partly');
    assert.strictEqual(store.get(h, VAR), null);
  }
});

test('add binds to the declaring access module: none installed is refused; two need --module; a --module that does not declare it is refused', async () => {
  const bare = tmp('ch-cred-');
  fs.chmodSync(bare, 0o700);
  const none = io(bare, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, none), 0);
  assert.match(none.err, /no installed pack declares the github credential \(COUNTINGHOUSE_GITHUB_TOKEN or GITHUB_TOKEN\)/);
  const h = home({extra: ['@countinghouse/ch-access-github-mirror']});
  const two = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'github'}, two), 2);
  assert.match(two.err, /more than one installed module declares the github credential \(@countinghouse\/ch-access-github, @countinghouse\/ch-access-github-mirror\): name the one with --module/);
  assert.strictEqual(store.get(h, VAR), null, 'never guessed');
  const wrong = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'github', module: '@countinghouse/ch-step-redact'}, wrong), 2);
  const chosen = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'github', module: '@countinghouse/ch-access-github-mirror'}, chosen), 0, chosen.err);
  assert.deepStrictEqual(store.list(h), [{variable: VAR, module: '@countinghouse/ch-access-github-mirror'}]);
  const unknown = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'gitlab'}, unknown), 2);
});

test('a credentials directory or file that fails a check is refused, said with the fix, never repaired, and nothing is written through or beside it', POSIX, async () => {
  const h = home();
  const value = made();
  assert.strictEqual(await credentials({action: 'add', name: 'github'}, io(h, {typed: value})), 0);
  const dir = path.join(h, 'credentials');
  const file = path.join(dir, 'credentials.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(dir, 0o755);
  const loose = io(h, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, loose), 0);
  assert.match(loose.err, /credentials is open to others \(mode 0755\); make it this user's alone: chmod 700 ".*credentials"\. Nothing was changed\./);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o755, 'not repaired');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['credentials.json'], 'nothing written beside it');
  assert.notStrictEqual(await credentials({action: 'remove', name: 'github'}, io(h)), 0, 'remove refuses too');
  assert.throws(() => store.get(h, VAR), /open to others/);
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(file, 0o644);
  const looseFile = io(h, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, looseFile), 0);
  assert.match(looseFile.err, /chmod 600/);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o644, 'not repaired');
  fs.chmodSync(file, 0o600);
  // a link where the directory should be
  fs.renameSync(dir, `${dir}.real`);
  fs.symlinkSync(`${dir}.real`, dir);
  assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, io(h, {typed: made()})), 0);
  assert.throws(() => store.get(h, VAR), /is a link/);
  // a file that is not ours: its content refused, never its value shown
  fs.rmSync(dir);
  fs.renameSync(`${dir}.real`, dir);
  fs.writeFileSync(file, JSON.stringify({v: 1, values: {[VAR]: {value: 'not a token!', module: ACCESS}}}), {mode: 0o600});
  assert.throws(() => store.get(h, VAR), (e) => /not a credentials file/.test(e.message) && !e.message.includes('not a token!'));
});

test('Windows (win-acl stubbed): a directory or file whose DACL fails is refused with icacls to fix it; a new directory is made private', () => {
  const h = tmp('ch-cred-win-');
  const me = 'S-1-5-21-1-2-3-1001';
  const mine = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-18', type: 'Allow', rights: 2032127}]};
  const open = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-32-545', type: 'Allow', rights: 1179817}]};
  const {privateProblem} = require('../lib/win-acl');
  let made_ = 0;
  const acl = (dirAcl) => ({privateProblem, fileAcl: () => dirAcl, makePrivateDirs: (dirs) => { made_ += 1; return dirs.map(() => mine); }});
  assert.strictEqual(store.checkDir(path.join(h, 'credentials'), {platform: 'win32', acl: acl(mine), create: true}), 'ok');
  assert.strictEqual(made_, 1, 'a new directory is made private');
  assert.throws(() => store.checkDir(path.join(h, 'credentials'), {platform: 'win32', acl: acl(open)}), (e) => /accessible by S-1-5-32-545/.test(e.message) && /icacls ".*credentials" \/inheritance:r/.test(e.message));
  assert.throws(() => store.checkDir(path.join(h, 'credentials'), {platform: 'win32', acl: {privateProblem, fileAcl: () => { throw new Error('powershell failed'); }}}), /access list could not be read \(powershell failed\)/);
});

test('the one order: the client\'s COUNTINGHOUSE_GITHUB_TOKEN, then the stored one, then gh, then GITHUB_TOKEN; the daemon\'s runtime has only the stored one and gh', async () => {
  const h = home();
  const stored = made();
  const gh = made();
  const explicit = made();
  const plain = made();
  const ghIo = (env, {loggedIn = true} = {}) => {
    const f = io(h, {env});
    f.exec = async (cmd) => (cmd === 'gh' ? (loggedIn ? {status: 0, stdout: `${gh}\n`, stderr: ''} : {status: 1, stdout: '', stderr: 'not logged in'}) : {status: 0, stdout: '', stderr: ''});
    return f;
  };
  assert.deepStrictEqual(await chooseGitHubToken(ghIo({}), h), {token: gh, source: 'gh'});
  store.add(h, VAR, stored, ACCESS);
  assert.deepStrictEqual(await chooseGitHubToken(ghIo({}), h), {token: stored, source: 'stored'});
  assert.deepStrictEqual(await chooseGitHubToken(ghIo({[VAR]: explicit, GITHUB_TOKEN: plain}), h), {token: explicit, source: 'environment', variable: VAR});
  assert.deepStrictEqual(await chooseGitHubToken(ghIo({[VAR]: explicit}), h, {shared: true, env: {}}), {token: stored, source: 'stored'}, 'the daemon never sees a client\'s');
  store.remove(h, VAR);
  assert.deepStrictEqual(await chooseGitHubToken(ghIo({GITHUB_TOKEN: plain}, {loggedIn: false}), h), {token: plain, source: 'GITHUB_TOKEN', variable: 'GITHUB_TOKEN', why: 'gh is not logged in to github.com'});
  const none = await chooseGitHubToken(ghIo({GITHUB_TOKEN: plain}, {loggedIn: false}), h, {shared: true, env: {}});
  assert.strictEqual(none.token, null);
});

test('a stored token whose file fails its checks is passed over, said, and never used', POSIX, async () => {
  const h = home();
  store.add(h, VAR, made(), ACCESS);
  fs.chmodSync(path.join(h, 'credentials'), 0o750);
  const gh = made();
  const f = io(h);
  f.exec = async (cmd) => (cmd === 'gh' ? {status: 0, stdout: `${gh}\n`, stderr: ''} : {status: 0, stdout: '', stderr: ''});
  const c = await chooseGitHubToken(f, h);
  assert.strictEqual(c.token, gh);
  assert.match(c.storeProblem, /open to others \(mode 0750\)/);
});

test('start gives its runtime the stored token, under the GitHub variables, without asking gh, and says where it came from', async () => {
  const h = home();
  const stored = made();
  store.add(h, VAR, stored, ACCESS);
  const f = io(h);
  f.cwd = h;
  f.spawned = [];
  Object.assign(f, {alive: () => true, trapSignals: () => () => {}, exit: () => {}});
  f.spawn = (cmd, args, {env} = {}) => { f.spawned.push({cmd, args, env}); return {kill: () => {}, exited: Promise.resolve(0)}; };
  const {start} = require('../lib/start');
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(f.spawned[0].env[VAR], stored);
  assert.deepStrictEqual(f.execs.filter((e) => e.cmd === 'gh'), [], 'gh is not asked');
  assert.match(f.err, /GitHub token from `ch-local credentials`, held in memory/);
  assert.ok(!f.err.includes(stored) && !f.out.includes(stored));
});

test('the conditions check sends the stored token\'s keyed hash, so a daemon not yet restarted on it runs this session on its own runtime', async () => {
  const conditions = require('../lib/conditions-command');
  const h = home();
  const run = path.join(h, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  const secret = Buffer.alloc(32, 0x5a);
  fs.writeFileSync(path.join(run, 'secret'), `${secret.toString('hex')}\n`, {mode: 0o600});
  const mac = (t) => crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from('ch-token'), Buffer.from(t, 'utf8')])).digest('base64');
  const line = async(env) => {
    const f = io(h, {env});
    f.clientAncestry = Promise.resolve({lines: null, policyPresent: false});
    f.conditionsStopAt = h;
    assert.strictEqual(await conditions.conditions({pid: 1, home: h}, f), 0, f.err);
    return JSON.parse(f.out);
  };
  assert.strictEqual((await line({})).token, null, 'none stored, none set: the daemon\'s');
  const stored = made();
  store.add(h, VAR, stored, ACCESS);
  assert.strictEqual((await line({})).token, mac(stored));
  const explicit = made();
  assert.strictEqual((await line({[VAR]: explicit})).token, mac(explicit), 'the client\'s own comes first');
});

test('add and remove ask a running daemon to restart its runtime (it drains first), and say so', POSIX, async () => {
  const {readRequests} = require('../lib/daemon-requests');
  const h = home();
  fs.mkdirSync(path.join(h, 'run', 'daemon'), {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  fs.chmodSync(path.join(h, 'run', 'daemon'), 0o700);
  const f = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'github'}, f), 0, f.err);
  assert.match(f.out, /The shared runtime, if one is running, takes it once its calls finish \(it drains, then restarts\)\. A session on a runtime of its own takes it at its next start\./);
  await credentials({action: 'remove', name: 'github'}, io(h));
  assert.deepStrictEqual(readRequests(h, 0).requests.map((r) => r.op), ['restart', 'restart']);
});

test('uninstall removes the stored credentials, with or without --keep-data, and says so', POSIX, async () => {
  const {uninstall} = require('../lib/uninstall');
  for (const keepData of [false, true]) {
    const h = home();
    store.add(h, VAR, made(), ACCESS);
    const f = fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: tmp('ch-cred-user-'), answers: ['yes']});
    Object.assign(f, {pid: 4242, hostname: 'box-1', alive: () => false});
    assert.strictEqual(await uninstall({keepData}, f), 0, f.err);
    assert.match(f.out, /credentials\/ {2}\(the stored credentials: removed, with or without --keep-data\)/);
    assert.ok(!fs.existsSync(path.join(h, 'credentials')), `keepData ${keepData}`);
  }
});

test('nothing that installs, upgrades or rolls back names the credentials directory: they never touch it', () => {
  const lib = path.join(__dirname, '..', 'lib');
  for (const f of ['install.js', 'rollback.js', 'auto-upgrade.js', 'upgrade-command.js', 'npm-release.js', 'shim-install.js', 'in-place.js']) {
    const file = path.join(lib, f);
    if (!fs.existsSync(file)) continue;
    assert.ok(!/['"`]credentials['"`/]/.test(fs.readFileSync(file, 'utf8')), `${f} names it`);
  }
});

test('the hidden reader: nothing echoed, raw mode restored, a pasted line\'s CRLF ends it, backspace, Ctrl-C aborts', async () => {
  const {EventEmitter} = require('node:events');
  const tty = () => {
    const s = new EventEmitter();
    s.isRaw = false;
    s.modes = [];
    s.setRawMode = (on) => { s.modes.push(on); s.isRaw = on; };
    s.setEncoding = () => {};
    s.resume = () => {};
    s.pause = () => {};
    return s;
  };
  const err = {text: '', write(t) { this.text += t; }};
  const value = made();
  let stdin = tty();
  let p = readHidden('token: ', {stdin, stderr: err});
  stdin.emit('data', `${value}x\u007f\r\n`);
  assert.strictEqual(await p, value);
  assert.deepStrictEqual(stdin.modes, [true, false]);
  assert.strictEqual(err.text, 'token: \n', 'only the prompt and a newline: nothing echoed');
  stdin = tty();
  p = readHidden('token: ', {stdin, stderr: err});
  stdin.emit('data', 'abc\u0003');
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  assert.deepStrictEqual(stdin.modes, [true, false]);
});

// the shared order (countinghouse's githubTokenPrecedence vectors, copied):
// start's choice, the daemon's and the conditions check's, for every case
test('the order holds to the shared vectors: start, the daemon and the conditions check, case by case', async () => {
  const conditions = require('../lib/conditions-command');
  const P = require('./vectors/github-token-precedence.json').githubTokenPrecedence;
  const secret = Buffer.alloc(32, 0x5a);
  const mac = (t) => crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from('ch-token'), Buffer.from(t, 'utf8')])).digest('base64');
  for (const c of P.cases) {
    const h = home();
    const run = path.join(h, 'run', 'daemon');
    fs.mkdirSync(run, {recursive: true, mode: 0o700});
    fs.chmodSync(path.join(h, 'run'), 0o700);
    fs.writeFileSync(path.join(run, 'secret'), `${secret.toString('hex')}\n`, {mode: 0o600});
    const tokens = {env: made(), stored: made(), gh: made(), GITHUB_TOKEN: made()};
    if (c.input.stored !== false) store.add(h, VAR, tokens.stored, ACCESS);
    if (c.input.stored === 'refused') {
      if (process.platform === 'win32') continue;   // a POSIX mode makes it fail its checks
      fs.chmodSync(path.join(h, 'credentials'), 0o755);
    }
    const env = Object.fromEntries(c.input.env.map((v) => [v, v === VAR ? tokens.env : tokens.GITHUB_TOKEN]));
    const f = io(h, {env});
    f.exec = async (cmd) => (cmd === 'gh' ? (c.input.ghLogin ? {status: 0, stdout: `${tokens.gh}\n`, stderr: ''} : {status: 1, stdout: '', stderr: ''}) : {status: 0, stdout: '', stderr: ''});
    const sourceOf = (r) => (r.source == null ? null : r.source);
    assert.strictEqual(sourceOf(await chooseGitHubToken(f, h)), c.start, `start: ${c.why}`);
    assert.strictEqual(sourceOf(await chooseGitHubToken(f, h, {shared: true, env: {}})), c.daemon, `daemon: ${c.why}`);
    f.clientAncestry = Promise.resolve({lines: null, policyPresent: false});
    f.conditionsStopAt = h;
    f.out = '';
    assert.strictEqual(await conditions.conditions({pid: 1, home: h}, f), 0, f.err);
    const sent = JSON.parse(f.out).token;
    const want = c.conditions == null ? null : mac(tokens[{'mac(env)': 'env', 'mac(stored)': 'stored', 'mac(GITHUB_TOKEN)': 'GITHUB_TOKEN'}[c.conditions]]);
    assert.strictEqual(sent, want, `conditions: ${c.why}`);
  }
});

test('a token typed where the name or --module goes is never shown back', async () => {
  const h = home();
  const value = made();
  const asName = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: value}, asName), 2);
  assert.ok(!asName.err.includes(value) && !asName.out.includes(value), asName.err);
  const asModule = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'github', module: value}, asModule), 2);
  assert.ok(!asModule.err.includes(value) && !asModule.out.includes(value), asModule.err);
  assert.strictEqual(store.get(h, VAR), null);
});

test('the binding: a pack whose manifest can\'t be read is refused, never skipped; a GITHUB_TOKEN-only module counts; a remote whose origin is not allowed does not', async () => {
  const broken = home({extra: ['@countinghouse/ch-access-github-mirror']});
  fs.rmSync(path.join(broken, 'app', 'node_modules', '@countinghouse', 'ch-access-github-mirror', 'package.json'));
  const f = io(broken, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, f), 0);
  assert.match(f.err, /the installed pack ci-failure-triage can't be read; run `ch-local install` again\. Nothing was changed\./);
  assert.strictEqual(store.get(broken, VAR), null, 'never bound to the one module still visible');
  // only GITHUB_TOKEN, and a remote to an origin the release doesn't allow
  const h = home();
  const access = path.join(h, 'app', 'node_modules', ...ACCESS.split('/'), 'package.json');
  fs.writeFileSync(access, JSON.stringify({name: ACCESS, version: '1.0.0', countinghouse: {role: 'part', remotes: [{...GITHUB, credential: {env: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}}]}}));
  assert.deepStrictEqual(require('../lib/credentials-command').declaringModules(require('../lib/home').layout({COUNTINGHOUSE_HOME: h}), ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']), [ACCESS]);
  fs.writeFileSync(access, JSON.stringify({name: ACCESS, version: '1.0.0', countinghouse: {role: 'part', remotes: [{...GITHUB, url: 'https://example.invalid/mcp/'}]}}));
  assert.deepStrictEqual(require('../lib/credentials-command').declaringModules(require('../lib/home').layout({COUNTINGHOUSE_HOME: h}), ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']), []);
});

test('the conditions check takes a value as start does: a placeholder or a blank one is not set', async () => {
  const conditions = require('../lib/conditions-command');
  const h = home();
  const run = path.join(h, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  const secret = Buffer.alloc(32, 0x5a);
  fs.writeFileSync(path.join(run, 'secret'), `${secret.toString('hex')}\n`, {mode: 0o600});
  const stored = made();
  store.add(h, VAR, stored, ACCESS);
  const mac = (t) => crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from('ch-token'), Buffer.from(t, 'utf8')])).digest('base64');
  for (const unset of ['${COUNTINGHOUSE_GITHUB_TOKEN}', '   ', '']) {
    const f = io(h, {env: {[VAR]: unset}});
    f.clientAncestry = Promise.resolve({lines: null, policyPresent: false});
    f.conditionsStopAt = h;
    assert.strictEqual(await conditions.conditions({pid: 1, home: h}, f), 0, f.err);
    assert.strictEqual(JSON.parse(f.out).token, mac(stored), JSON.stringify(unset));
  }
});

test('the hidden reader: input that ends mid-prompt aborts and restores the terminal; raw mode is on before the prompt is shown', async () => {
  const {EventEmitter} = require('node:events');
  const order = [];
  const stdin = new EventEmitter();
  stdin.isRaw = false;
  stdin.setRawMode = (on) => { order.push(`raw:${on}`); stdin.isRaw = on; };
  stdin.setEncoding = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  const p = readHidden('token: ', {stdin, stderr: {write: (t) => { if (t === 'token: ') order.push('prompt'); }}});
  stdin.emit('data', 'partial');
  stdin.emit('end');
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  assert.deepStrictEqual(order, ['raw:true', 'prompt', 'raw:false']);
});

test('a store that can\'t be written is said, nothing stored, never an unhandled error', POSIX, async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;   // root writes anywhere
  const h = home();
  fs.chmodSync(h, 0o500);
  try {
    const f = io(h, {typed: made()});
    assert.notStrictEqual(await credentials({action: 'add', name: 'github'}, f), 0);
    assert.match(f.err, /credentials could not be made \(EACCES\).*Nothing was changed\./s);
  } finally {
    fs.chmodSync(h, 0o700);
  }
  assert.strictEqual(store.get(h, VAR), null);
});

