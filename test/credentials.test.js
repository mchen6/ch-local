'use strict';
// Credentials bound to one module (#413 sections 6.2, 6.3, 6.8 and 10; L5a:
// lib/credential-store.js, lib/credentials-command.js,
// lib/module-credentials.js): kept this user's alone and never repaired;
// entered at a terminal (where the gh login is offered for exactly
// https://api.githubcopilot.com) or on standard input with --to; never
// shown; read in place from version 1; removed with the program. Values are
// made here, never literals.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const store = require('../lib/credential-store');
const {credentials} = require('../lib/credentials-command');
const {readHidden} = require('../lib/hidden-input');

const POSIX = {skip: process.platform === 'win32' && 'POSIX modes'};
const made = () => `t${crypto.randomBytes(12).toString('hex')}`;
const ACCESS = '@countinghouse/ch-access-github';
const VAR = 'COUNTINGHOUSE_GITHUB_TOKEN';
const ORIGIN = 'https://api.githubcopilot.com';
const remote = (url = `${ORIGIN}/mcp/`) => ({name: 'github', url, credential: VAR});

// an installed home whose access module declares the GitHub credential;
// extra: {package: url} more modules that declare one
function home({extra = {}, url} = {}) {
  const h = tmp('ch-cred-');
  fs.chmodSync(h, 0o700);
  const pkgs = {'@countinghouse/ch-pack-ci-failure-triage': {role: 'scenario'}, [ACCESS]: {role: 'part', remotes: [remote(url)]}};
  for (const [m, u] of Object.entries(extra)) pkgs[m] = {role: 'part', remotes: [remote(u)]};
  const {storeModule, writeHome} = require('./store-helpers');
  for (const [name, countinghouse] of Object.entries(pkgs)) storeModule(h, name, '1.0.0', {countinghouse});
  writeHome(h, {'ci-failure-triage': Object.fromEntries(Object.keys(pkgs).map((n) => [n, '1.0.0']))});
  return h;
}
// terminal: a terminal both ways; typed: what the hidden reader returns (an
// Error: it throws); stdin: what standard input holds; answers: io.ask's;
// gh: what gh auth token answers (null: no login)
const io = (h, {terminal = true, typed = null, stdin = null, answers = [], gh = null} = {}) => {
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: '/nowhere', answers});
  Object.assign(f, {terminal, pid: 4242, hostname: 'box-1'});
  f.exec = async (cmd) => (cmd === 'gh' && gh != null ? {status: 0, stdout: `${gh}\n`, stderr: ''} : {status: 1, stdout: '', stderr: 'not logged in'});
  if (typed !== null) f.readHidden = async (prompt) => { f.prompts = [...(f.prompts || []), prompt]; if (typed instanceof Error) throw typed; return typed; };
  if (stdin !== null) f.readStdin = async () => stdin;
  return f;
};
const everything = (h, f) => {
  const history = fs.existsSync(path.join(h, 'history.jsonl')) ? fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8') : '';
  return `${f.out}\n${f.err}\n${history}\n${(f.prompts || []).join('\n')}`;
};
const bound = (h, m = ACCESS) => {
  const vars = store.readStore(h).modules.get(m);
  return vars != null ? vars.get(VAR) || null : null;
};
const historyOf = (h) => (fs.existsSync(path.join(h, 'history.jsonl')) ? fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('add at a terminal: shown where it goes before asking; stored for that module, 0700 and 0600, the value shown nowhere; list shows no value; remove takes it away', POSIX, async () => {
  const h = home();
  const value = made();
  const f = io(h, {typed: value});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, f), 0, f.err);
  assert.match(f.out, /^ch-access-github 1\.0\.0 declares one credential:\n {2}COUNTINGHOUSE_GITHUB_TOKEN, sent to https:\/\/api\.githubcopilot\.com \(its remote "github"\)\n/);
  assert.match(f.prompts[0], /^COUNTINGHOUSE_GITHUB_TOKEN for ch-access-github \(input hidden\): $/);
  assert.deepStrictEqual(bound(h), {origin: ORIGIN, source: 'stored', value});
  assert.strictEqual(fs.statSync(path.join(h, 'credentials')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(h, 'credentials', 'credentials.json')).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h, 'credentials', 'credentials.json'), 'utf8')).v, 2);
  assert.match(f.out, /stored for ch-access-github: COUNTINGHOUSE_GITHUB_TOKEN, sent to https:\/\/api\.githubcopilot\.com; readable by this user only/);
  assert.ok(!everything(h, f).includes(value), 'the value nowhere');
  assert.deepStrictEqual((({module, variable, origin, source, how, change}) => ({module, variable, origin, source, how, change}))(historyOf(h)[0]),
    {module: ACCESS, variable: VAR, origin: ORIGIN, source: 'stored', how: 'terminal', change: 'added'});
  const l = io(h);
  assert.strictEqual(await credentials({action: 'list'}, l), 0);
  assert.match(l.out, /^ch-access-github {2}COUNTINGHOUSE_GITHUB_TOKEN {2}https:\/\/api\.githubcopilot\.com {2}stored {2}\(its installed version sends it here\)$/m);
  assert.ok(!l.out.includes(value));
  const r = io(h);
  assert.strictEqual(await credentials({action: 'remove', name: 'ch-access-github'}, r), 0, r.err);
  assert.strictEqual(bound(h), null);
  assert.ok(!fs.existsSync(path.join(h, 'credentials', 'credentials.json')), 'the file goes with its last entry');
  assert.strictEqual(historyOf(h).pop().change, 'removed');
});

test('the gh offer: only at a terminal, with a gh login, for exactly https://api.githubcopilot.com; yes stores no value, no asks for one', POSIX, async () => {
  const h = home();
  const yes = io(h, {typed: made(), gh: made(), answers: ['y']});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, yes), 0, yes.err);
  assert.match(yes.asked[0], /^Use your gh login's token for ch-access-github\? \[y\/N\] $/);
  assert.deepStrictEqual(bound(h), {origin: ORIGIN, source: 'gh'});
  assert.strictEqual(yes.prompts, undefined, 'no value asked');
  assert.match(yes.out, /stored for ch-access-github: your gh login's token, asked at each start/);
  const no = io(h, {typed: made(), gh: made(), answers: ['']});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, no), 0, no.err);
  assert.strictEqual(bound(h).source, 'stored', 'the default is No: a value is asked');
  // no login: no question
  const none = io(home(), {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, none), 0, none.err);
  assert.deepStrictEqual(none.asked, []);
  // a look-alike, another port, or http: no offer
  for (const url of ['https://api.githubcopilot.com.example/mcp/', 'https://api.githubcopilot.com:8443/mcp/', 'https://api-githubcopilot.com/mcp/']) {
    const f = io(home({url}), {typed: made(), gh: made(), answers: ['y']});
    assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, f), 0, f.err);
    assert.deepStrictEqual(f.asked, [], url);
  }
});

test('standard input: --to is required and must be the declared origin; never re-binds another destination; a rotated key is fine; one line of at most 4096 bytes', POSIX, async () => {
  const h = home();
  const value = made();
  const noTo = io(h, {terminal: false, stdin: `${value}\n`});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, noTo), 2);
  assert.match(noTo.err, /a key on standard input needs `--to <origin>`: the address it is for \(`ch-local credentials list` shows what ch-access-github declares\)\. Nothing was stored\./);
  const wrong = io(h, {terminal: false, stdin: `${value}\n`});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: 'https://api.example.com'}, wrong), 2);
  assert.match(wrong.err, /ch-access-github 1\.0\.0 sends its credential to https:\/\/api\.githubcopilot\.com, not the address given\. Nothing was stored\./);
  assert.strictEqual(bound(h), null);
  const ok = io(h, {terminal: false, stdin: `${value}\r\n`});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN}, ok), 0, ok.err);
  assert.deepStrictEqual(bound(h), {origin: ORIGIN, source: 'stored', value});
  assert.strictEqual(historyOf(h).pop().how, 'stdin');
  // a rotated key, same destination
  const rotated = made();
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN}, io(h, {terminal: false, stdin: rotated})), 0);
  assert.strictEqual(bound(h).value, rotated);
  // a binding for another origin is never replaced from standard input
  const other = home();
  store.bind(other, ACCESS, VAR, {origin: 'https://old.example', source: 'stored', value: made()});
  const rebind = io(other, {terminal: false, stdin: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN}, rebind), 2);
  assert.match(rebind.err, /the credential stored for ch-access-github is for https:\/\/old\.example, and this version sends it to https:\/\/api\.githubcopilot\.com: run `ch-local credentials add ch-access-github` at a terminal to allow that\. Nothing was changed\./);
  // two lines, or over 4096 bytes: refused
  for (const stdin of [`${made()}\n${made()}\n`, 'x'.repeat(4097)]) {
    const f = io(home(), {terminal: false, stdin});
    assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN}, f), 2);
    assert.match(f.err, /one line of at most 4096 bytes/);
  }
});

test('at a terminal, a binding for another origin is named before asking, then replaced', POSIX, async () => {
  const h = home();
  store.bind(h, ACCESS, VAR, {origin: 'https://old.example', source: 'stored', value: made()});
  const value = made();
  const f = io(h, {typed: value});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, f), 0, f.err);
  assert.match(f.out, /the stored credential for ch-access-github is for https:\/\/old\.example; this version sends it to https:\/\/api\.githubcopilot\.com/);
  assert.deepStrictEqual(bound(h), {origin: ORIGIN, source: 'stored', value});
  assert.strictEqual(historyOf(h).pop().change, 'replaced');
});

test('not an installed module that declares a credential: refused, the argument never shown back; a short name two share asks for the full one', async () => {
  const h = home();
  const value = made();
  const asName = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: value}, asName), 2);
  assert.match(asName.err, /that is not an installed module that declares a credential; `ch-local credentials list` and `ch-local status` show them\. Nothing was changed\./);
  assert.ok(!asName.err.includes(value) && !asName.out.includes(value), asName.err);
  const noCred = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-pack-ci-failure-triage'}, noCred), 2);
  assert.match(noCred.err, /not an installed module that declares a credential/);
  const two = home({extra: {'@other/ch-access-github': 'https://api.example.com/mcp/'}});
  const amb = io(two, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'ch-access-github'}, amb), 0);
  assert.match(amb.err, /more than one installed module is named ch-access-github: @countinghouse\/ch-access-github, @other\/ch-access-github; give the full name/);
  assert.strictEqual(await credentials({action: 'add', name: '@other/ch-access-github'}, io(two, {typed: made()})), 0);
});

test('list shows what an installed module with no binding declares, so --to can be written', async () => {
  const h = home();
  const f = io(h);
  assert.strictEqual(await credentials({action: 'list'}, f), 0);
  assert.match(f.out, /^ch-access-github {2}COUNTINGHOUSE_GITHUB_TOKEN {2}https:\/\/api\.githubcopilot\.com {2}none stored {2}\(`ch-local credentials add ch-access-github`\)$/m);
});

test('a version 1 store is read in place as a binding for its recorded module, to api.githubcopilot.com, under the name the module declares; the first write makes it version 2', POSIX, async () => {
  const h = home();
  const value = made();
  fs.mkdirSync(path.join(h, 'credentials'), {mode: 0o700});
  fs.writeFileSync(path.join(h, 'credentials', 'credentials.json'), JSON.stringify({v: 1, values: {GITHUB_TOKEN: {value, module: ACCESS}}}), {mode: 0o600});
  const mc = require('../lib/module-credentials');
  const {layout} = require('../lib/home');
  const where = layout({COUNTINGHOUSE_HOME: h});
  const record = require('../lib/module-record').readModulesRecord(where);
  const read = mc.bindings(where, record);
  assert.deepStrictEqual(read.bindings.get(ACCESS).get(VAR), {origin: ORIGIN, source: 'stored', value});
  const l = io(h);
  assert.strictEqual(await credentials({action: 'list'}, l), 0);
  assert.match(l.out, /^ch-access-github {2}COUNTINGHOUSE_GITHUB_TOKEN {2}https:\/\/api\.githubcopilot\.com {2}stored/m);
  // a rotated key from standard input: the file is version 2 now
  const rotated = made();
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN}, io(h, {terminal: false, stdin: rotated})), 0);
  const doc = JSON.parse(fs.readFileSync(path.join(h, 'credentials', 'credentials.json'), 'utf8'));
  assert.deepStrictEqual(doc, {v: 2, modules: {[ACCESS]: {[VAR]: {origin: ORIGIN, source: 'stored', value: rotated}}}});
});

test('a credentials directory or file that fails a check is refused, said with the fix, never repaired, and nothing is written through or beside it', POSIX, async () => {
  const h = home();
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, io(h, {typed: made()})), 0);
  const dir = path.join(h, 'credentials');
  const file = path.join(dir, 'credentials.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(dir, 0o755);
  const loose = io(h, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'ch-access-github'}, loose), 0);
  assert.match(loose.err, /credentials is open to others \(mode 0755\); make it this user's alone: chmod 700 ".*credentials"/);
  assert.match(loose.err, /Nothing was changed\./);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o755, 'not repaired');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['credentials.json'], 'nothing written beside it');
  assert.notStrictEqual(await credentials({action: 'remove', name: 'ch-access-github'}, io(h)), 0, 'remove refuses too');
  assert.throws(() => store.readStore(h), /open to others/);
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(file, 0o644);
  const looseFile = io(h, {typed: made()});
  assert.notStrictEqual(await credentials({action: 'add', name: 'ch-access-github'}, looseFile), 0);
  assert.match(looseFile.err, /chmod 600/);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o644, 'not repaired');
  fs.chmodSync(file, 0o600);
  // a link where the directory should be
  fs.renameSync(dir, `${dir}.real`);
  fs.symlinkSync(`${dir}.real`, dir);
  assert.notStrictEqual(await credentials({action: 'add', name: 'ch-access-github'}, io(h, {typed: made()})), 0);
  assert.throws(() => store.readStore(h), /is a link/);
  // a file that is not of the form: its content refused, never its value shown
  fs.rmSync(dir);
  fs.renameSync(`${dir}.real`, dir);
  fs.writeFileSync(file, JSON.stringify({v: 2, modules: {[ACCESS]: {[VAR]: {origin: ORIGIN, source: 'stored', value: 'has a space'}}}}), {mode: 0o600});
  assert.throws(() => store.readStore(h), (e) => /not a credentials file/.test(e.message) && !e.message.includes('has a space'));
});

test('add and remove ask a running daemon to restart its runtime (it drains first), and say what a session on its own runtime sees', POSIX, async () => {
  const {readRequests} = require('../lib/daemon-requests');
  const h = home();
  fs.mkdirSync(path.join(h, 'run', 'daemon'), {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  fs.chmodSync(path.join(h, 'run', 'daemon'), 0o700);
  const f = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github'}, f), 0, f.err);
  assert.match(f.out, /The shared runtime, if one is running, restarts once its calls finish \(it drains first\)\.\nA session on a runtime of its own takes it at its client's next start/);
  const r = io(h);
  await credentials({action: 'remove', name: 'ch-access-github'}, r);
  assert.match(r.out, /A session on a runtime of its own unloads the module at once, until its client restarts\./);
  assert.deepStrictEqual(readRequests(h, 0).requests.map((x) => x.op), ['restart', 'restart']);
});

test('uninstall removes the stored credentials, with or without --keep-data, and says so', POSIX, async () => {
  const {uninstall} = require('../lib/uninstall');
  for (const keepData of [false, true]) {
    const h = home();
    store.bind(h, ACCESS, VAR, {origin: ORIGIN, source: 'stored', value: made()});
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

test('a store that can\'t be written is said, nothing stored, never an unhandled error', POSIX, async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;   // root writes anywhere
  const h = home();
  fs.chmodSync(h, 0o500);
  try {
    const f = io(h, {typed: made()});
    assert.notStrictEqual(await credentials({action: 'add', name: 'ch-access-github'}, f), 0);
    assert.match(f.err, /credentials could not be made \(EACCES\).*Nothing was changed\./s);
  } finally {
    fs.chmodSync(h, 0o700);
  }
  assert.strictEqual(bound(h), null);
});

// a file over its bound, or cut short, is refused and its content never
// reaches an error, a line the command or a start says, or the history
test('a credentials file over 512 KiB, or one cut short around a value, is refused without its content in any error or line', POSIX, async () => {
  for (const shape of ['over', 'cut']) {
    const h = home();
    const value = made();
    store.bind(h, ACCESS, VAR, {origin: ORIGIN, source: 'stored', value});
    const file = path.join(h, 'credentials', 'credentials.json');
    const whole = fs.readFileSync(file, 'utf8');
    if (shape === 'over') fs.writeFileSync(file, whole.replace('"v": 2', `"v": 2, "pad": "${'x'.repeat(520 * 1024)}"`));
    else fs.writeFileSync(file, whole.slice(0, whole.indexOf(value) + Math.floor(value.length / 2)));
    assert.throws(() => store.readStore(h), (e) => !e.message.includes(value) && !e.message.includes(value.slice(0, 8)), shape);
    const f = io(h, {typed: made()});
    assert.notStrictEqual(await credentials({action: 'add', name: 'ch-access-github'}, f), 0);
    assert.ok(!everything(h, f).includes(value.slice(0, 8)), shape);
    // a start passes it over and says why, without the value
    const mc = require('../lib/module-credentials');
    const {layout} = require('../lib/home');
    const where = layout({COUNTINGHOUSE_HOME: h});
    const record = require('../lib/module-record').readModulesRecord(where);
    const s = await mc.forStart(where, record, {env: {}, ghToken: async () => ({why: 'none'})});
    const st = s.states.get(ACCESS);
    assert.strictEqual(st.state, 'store-problem');
    assert.ok(!st.reason.includes(value.slice(0, 8)), st.reason);
  }
});

test('Windows (win-acl stubbed): the home\'s own DACL is checked before a write; one another user can reach, or that can\'t be read, refuses', () => {
  const h = tmp('ch-cred-winhome-');
  const me = 'S-1-5-21-1-2-3-1001';
  const mine = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-18', type: 'Allow', rights: 2032127}]};
  const open = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-32-545', type: 'Allow', rights: 1179817}]};
  const {privateProblem} = require('../lib/win-acl');
  const realHome = fs.realpathSync(h);
  const seam = (homeAcl) => ({privateProblem, fileAcl: (p) => { if (p === realHome) { if (homeAcl instanceof Error) throw homeAcl; return homeAcl; } return mine; },
    makePrivateDirs: (dirs) => dirs.map(() => mine), createPrivate: (file, data) => fs.writeFileSync(file, data, {flag: 'wx'})});
  const entry = {origin: ORIGIN, source: 'stored', value: made()};
  assert.throws(() => store.bind(h, ACCESS, VAR, entry, {platform: 'win32', acl: seam(open)}), /is accessible by S-1-5-32-545/);
  assert.throws(() => store.bind(h, ACCESS, VAR, entry, {platform: 'win32', acl: seam(new Error('powershell failed'))}), /access list could not be read \(powershell failed\)/);
  assert.ok(!fs.existsSync(path.join(h, 'credentials')), 'nothing made under a home that failed');
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


// the /code-review medium on L5a, 2: a key a removed module left is listed
// and removable, also with nothing installed
test('remove: a key whose module is no longer installed is still removed, by its full or short name', async () => {
  const h = home();
  store.bind(h, '@countinghouse/ch-gone', VAR, {origin: ORIGIN, source: 'stored', value: made()});
  assert.strictEqual(await credentials({action: 'remove', name: 'ch-gone'}, io(h)), 0);
  assert.strictEqual(store.readStore(h).modules.get('@countinghouse/ch-gone'), undefined);
  // nothing installed at all
  fs.rmSync(path.join(h, 'modules.json'));
  store.bind(h, '@countinghouse/ch-gone', VAR, {origin: ORIGIN, source: 'stored', value: made()});
  const f = io(h);
  assert.strictEqual(await credentials({action: 'list'}, f), 0, f.err);
  assert.match(f.out, /^ch-gone {2}COUNTINGHOUSE_GITHUB_TOKEN {2}https:\/\/api\.githubcopilot\.com {2}stored {2}\(not installed/m);
  assert.strictEqual(await credentials({action: 'remove', name: '@countinghouse/ch-gone'}, io(h)), 0);
  assert.strictEqual(store.readStore(h).modules.get('@countinghouse/ch-gone'), undefined);
  // an argument that names nothing stored is still never shown back
  const odd = io(h);
  assert.strictEqual(await credentials({action: 'remove', name: 'ghp_lookslikeatoken'}, odd), 2);
  assert.ok(!(odd.out + odd.err).includes('ghp_lookslikeatoken'));
});

// the /code-review medium on L5a, 4: --to is checked at a terminal too
test('add at a terminal with --to another origin is refused before anything is asked', async () => {
  const h = home();
  const f = io(h, {typed: made()});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: 'https://api.example.com'}, f), 2);
  assert.match(f.err, /sends its credential to https:\/\/api\.githubcopilot\.com, not the address given/);
  assert.strictEqual(f.prompts, undefined, 'nothing asked');
  assert.strictEqual(bound(h), null);
});

// the /code-review medium on L5a, 3: a terminal on standard input whose
// output is redirected would echo the key
test('add with a terminal on standard input but not both ways is refused: the key would echo', async () => {
  const h = home();
  const f = io(h, {terminal: false, stdin: `${made()}\n`});
  f.stdinIsTTY = true;
  assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN}, f), 2);
  assert.match(f.err, /typed only at a terminal both ways/);
  assert.strictEqual(bound(h), null);
});
