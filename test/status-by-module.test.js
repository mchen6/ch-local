'use strict';
require('./tmp-dirs');
// `status` by module (#413 rev 3 section 9.9; L1b-1): the modules first, each
// with what it is (on with its tools, a part, or why it would not load, in
// the sentence a start says), its credential, and a running client's word on
// it; then the packs as what they are, by their module count.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {status} = require('../lib/packs-command');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, record} = require('./install-helpers');
const {chLocal} = require('../lib/command-line');
const {layout} = require('../lib/home');
// a command as the home names it once an install wrote its launcher
// (lib/command-line.js); cmd: the same, as a regular expression's source
const said = (home, args) => chLocal(layout({COUNTINGHOUSE_HOME: home}), args);
const cmd = (home, args) => said(home, args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function installed(r = release(), env = {}) {
  const home = tmp('ch-home-');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 0, io.err);
  return {home, r, io: (more = {}) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env, ...more}, exec: npm()}), {release: r.allow})};
}
const stored = (home) => require('../lib/credential-store').bind(home, '@countinghouse/ch-access-github', 'GITHUB_TOKEN',
  {origin: 'https://api.githubcopilot.com', source: 'stored', value: 'test-stored-value-1'}, {held: require('./store-helpers').FIXTURE_HELD});
// a module's line: its short name and version, then what it is
const lineOf = (out, short) => (out.split('\n').find((l) => new RegExp(`^  ${short} \\S+ +`).test(l)) || '').replace(/^ +\S+ \S+ +/, '');
async function statusOf(io) {
  const code = await status({}, io);
  return {code, out: io.out, err: io.err};
}

test('the modules first, then the packs: a header, each module with what it is, each pack with its module count', async () => {
  const s = await installed();
  stored(s.home);
  const {code, out, err} = await statusOf(s.io());
  assert.strictEqual(code, 0, err);
  const r = record(s.home);
  const versions = r.runtime.versions;
  assert.match(out, new RegExp(`^ch-local ${versions['@countinghouse/ch-local'].replace(/\./g, '\\.')}, countinghouse ${versions.countinghouse.replace(/\./g, '\\.')}\nthe shared runtime's shim: none recorded \\(each session runs its own runtime\\)\nmodules:\n`));
  assert.strictEqual(lineOf(out, 'ch-pack-ci-failure-triage'), 'on; tools: ci_failure_triage');
  assert.strictEqual(lineOf(out, 'ch-access-github'), 'part; credential GITHUB_TOKEN -> https://api.githubcopilot.com (stored)');
  assert.strictEqual(lineOf(out, 'ch-step-redact'), 'part');
  const n = Object.keys(r.packs['ci-failure-triage'].modules).length;
  assert.match(out, new RegExp(`\npacks:\n  ci-failure-triage +${n} modules\n`));
  assert.ok(!out.includes('test-stored-value-1'), 'never a value');
});

test('a module that would not load says why, as a start says it; its callers say what they call', async () => {
  const s = await installed();
  const {out} = await statusOf(s.io({GITHUB_TOKEN: 'secret'}));
  assert.match(lineOf(out, 'ch-access-github'), new RegExp(`^part; not available: needs a credential \\(GITHUB_TOKEN, sent to https://api\\.githubcopilot\\.com\\): run \`${cmd(s.home, 'credentials add ch-access-github')}\`$`));
  assert.match(lineOf(out, 'ch-pack-ci-failure-triage'), new RegExp(`^not loaded: calls ch-access-github, which needs a credential: run \`${cmd(s.home, 'credentials add ch-access-github')}\`$`));
  assert.ok(!out.includes('secret'));
});

test('a module turned off says how to turn it on', async () => {
  const s = await installed();
  stored(s.home);
  require('../lib/settings').setSetting({...require('../lib/home').layout({COUNTINGHOUSE_HOME: s.home}, '/nonexistent')}, 'enabled.@countinghouse/ch-pack-ci-failure-triage', 'off', {by: 'cli'});
  const {out} = await statusOf(s.io());
  assert.strictEqual(lineOf(out, 'ch-pack-ci-failure-triage'), `not loaded: turned off (\`${said(s.home, 'settings set enabled.@countinghouse/ch-pack-ci-failure-triage on')}\`)`);
});

test('a running client\'s word: a module it stopped, with its code; a client on another ch-local, once; a dead start is not read', async () => {
  const s = await installed();
  stored(s.home);
  const {hostTag} = require('../lib/gc');
  const writeRun = (pid, extra) => {
    const dir = path.join(s.home, 'run', `r${pid}`);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(Object.assign({pid, host: hostTag('box-1'), loaded: {}}, extra)));
  };
  writeRun(4242, {stopped: {'@countinghouse/ch-pack-ci-failure-triage': 'MODULE_SUSPENDED'}});
  writeRun(4343, {chLocal: '0.0.1'});
  writeRun(4444, {chLocal: '0.0.1'});
  const live = Object.assign(s.io(), {hostname: 'box-1', alive: (pid) => pid === 4242 || pid === 4343 || pid === 4444});
  const {out, code, err} = await statusOf(live);
  assert.strictEqual(code, 0, err);
  assert.match(lineOf(out, 'ch-pack-ci-failure-triage'), /^on; stopped in a running client \(MODULE_SUSPENDED\): restart that client, or with the shared runtime run `[^`]+ restart`$/);
  assert.strictEqual(out.split('\n').filter((l) => /^a running client is still on ch-local 0\.0\.1; restart it, or with the shared runtime run `[^`]+ restart`$/.test(l)).length, 1, out);
  const dead = Object.assign(s.io(), {hostname: 'box-1', alive: () => false});
  const d = await statusOf(dead);
  assert.ok(!/stopped|still on ch-local/.test(d.out), d.out);
});

// the medium review of L1b-1: status decides as a start decides
test('a settings file a start refuses: status says so, and lists every module as not loaded, guessing nothing', async () => {
  const s = await installed();
  stored(s.home);
  fs.writeFileSync(path.join(s.home, 'settings.json'), '{not json');
  const {out, code} = await statusOf(s.io());
  assert.strictEqual(code, 0);
  assert.match(out, /no client starts until it is fixed/);
  assert.match(out, /^  ch-pack-ci-failure-triage \S+: not loaded \(no client starts until that is fixed\)$/m);
  assert.doesNotMatch(out, /on; tools/);
});

test('a live start that wrote no chLocal (a ch-local from before) is a client on an older ch-local', async () => {
  const s = await installed();
  stored(s.home);
  const {hostTag} = require('../lib/gc');
  const dir = path.join(s.home, 'run', 'r5151');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({pid: 5151, host: hostTag('box-1'), loaded: {}}));
  const nul = path.join(s.home, 'run', 'r5252');
  fs.mkdirSync(nul, {recursive: true});
  fs.writeFileSync(path.join(nul, 'run.json'), JSON.stringify({pid: 5252, host: hostTag('box-1'), loaded: {}, chLocal: null}));
  const {out} = await statusOf(Object.assign(s.io(), {hostname: 'box-1', alive: (pid) => pid === 5151 || pid === 5252}));
  const stillOn = out.split('\n').filter((l) => /still on/.test(l));
  assert.strictEqual(stillOn.length, 1, out);
  assert.match(stillOn[0], /^a running client is still on an older ch-local; restart it, or with the shared runtime run `[^`]+ restart`$/, 'a checkout\'s start (null) is not called stale');
});

test('a credential from the gh login: gh is asked as a start asks it; one that gives no token makes the part not available', async () => {
  const s = await installed();
  require('../lib/credential-store').bind(s.home, '@countinghouse/ch-access-github', 'GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'gh'}, {held: require('./store-helpers').FIXTURE_HELD});
  const io = Object.assign(s.io(), {exec: async (cmd) => { io.execs.push({cmd}); return {status: 1, stdout: '', stderr: 'not logged in'}; }});
  const {out} = await statusOf(io);
  assert.ok(io.execs.some((e) => e.cmd === 'gh'), 'gh asked');
  assert.match(lineOf(out, 'ch-access-github'), /^part; not available: (your gh login gave no token|has no token from your gh login)/);
  assert.match(lineOf(out, 'ch-pack-ci-failure-triage'), /^not loaded: calls ch-access-github/);
});

test('a module turned off still shows its stored credential', async () => {
  const s = await installed();
  stored(s.home);
  require('../lib/settings').setSetting(require('../lib/home').layout({COUNTINGHOUSE_HOME: s.home}, '/nonexistent'), 'enabled.@countinghouse/ch-pack-ci-failure-triage', 'off', {by: 'cli'});
  const {out} = await statusOf(s.io());
  assert.strictEqual(lineOf(out, 'ch-access-github'), 'part; credential GITHUB_TOKEN -> https://api.githubcopilot.com (stored)');
});
