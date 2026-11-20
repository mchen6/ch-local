'use strict';
require('./tmp-dirs');
// The opt-in automatic upgrade check (packs in place, part 2, plan Task B4):
// only with autoUpgrade on, at most once a day (or week) across starts,
// never when upgradeCheck is never; what it finds, and a failure, said and
// recorded. The registry is a stand-in: no network in tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {autoCheck} = require('../lib/auto-upgrade');
const {setSetting} = require('../lib/settings');
const {install} = require('../lib/install');
const {layout} = require('../lib/home');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

// The check runs `ch-local upgrade --apply-auto` (lib/auto-apply.js) in a
// child of its own; here a stand-in for that child: what it was run with,
// and what it says.
const child = (answer = {status: 0, stdout: ''}) => {
  const runs = [];
  const exec = async(cmd, args, opts) => { runs.push({cmd, args, opts}); if (answer === 'hang') return {status: null, stdout: '', stderr: 'killed'}; return answer; };
  return {runs, exec};
};
async function home() {
  const h = tmp('ch-home-');
  const r = release();
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()}), r.allow), 0);
  return {h, where: layout({COUNTINGHOUSE_HOME: h})};
}
const shell = {PATH: '/usr/bin', HOME: '/home/u', LANG: 'C', TMPDIR: '/tmp', NODE_OPTIONS: '--require /x.js', npm_execpath: '/evil/npm-cli.js',
  npm_config_registry: 'https://evil.example.invalid/', HTTPS_PROXY: 'http://proxy.example.invalid:3128', NODE_EXTRA_CA_CERTS: '/evil.pem', SSL_CERT_FILE: '/evil.pem'};
const run = (where, answer, now) => {
  const said = [];
  const c = child(answer);
  const io = Object.assign(fakeIo({env: shell, exec: c.exec}), {pid: 1, platform: 'linux'});
  return autoCheck({where, io, say: (x) => said.push(x), host: 'box', now}).then((r) => ({r, said, runs: c.runs}));
};

test('off by default: no check, no child', async () => {
  const {where} = await home();
  const {r, runs} = await run(where, undefined, Date.now());
  assert.deepStrictEqual([r.checked, r.why, runs.length], [false, 'off', 0]);
});

test('on: the child runs as `ch-local upgrade --apply-auto`, with the allowlisted environment only; its lines are said; the next start within the day does not run it', async () => {
  const {h, where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  const now = Date.now();
  const first = await run(where, {status: 0, stdout: 'ch-local 0.3.0 is available; it installs automatically after 2026-01-01T00:00:00.000Z\n'}, now);
  assert.strictEqual(first.r.checked, true);
  assert.deepStrictEqual(first.runs.map((x) => x.args), [[path.join(h, 'bin', 'ch-local.js'), 'upgrade', '--apply-auto']]);
  assert.deepStrictEqual(Object.keys(first.runs[0].opts.env).sort(), ['COUNTINGHOUSE_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR'], 'no npm_execpath, NODE_OPTIONS, npm_config_*, proxy or CA variable');
  assert.strictEqual(first.runs[0].opts.env.COUNTINGHOUSE_HOME, h);
  assert.deepStrictEqual(first.said, ['ch-local 0.3.0 is available; it installs automatically after 2026-01-01T00:00:00.000Z']);
  const again = await run(where, undefined, now + 60 * 60 * 1000);
  assert.deepStrictEqual([again.r.checked, again.r.why, again.runs.length], [false, 'not due', 0]);
  assert.strictEqual((await run(where, undefined, now + 25 * 60 * 60 * 1000)).r.checked, true);
});

test('the stamp keeps what the child wrote: lastCheck is merged in, never written over', async () => {
  const {where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  fs.writeFileSync(path.join(where.home, 'upgrade-check.json'), JSON.stringify({firstSeen: {'0.3.0': 5}, refused: [{version: '0.2.9', root: 'r'}], declined: ['0.2.8'], announced: [{version: '0.3.1', key: '0123456789abcdef'}], lastSuccess: 7}), {mode: 0o600});
  const now = Date.now();
  await run(where, {status: 0, stdout: ''}, now);
  const stamp = JSON.parse(fs.readFileSync(path.join(where.home, 'upgrade-check.json'), 'utf8'));
  // (announced: the held versions said once, L4: kept as the rest)
  assert.deepStrictEqual(stamp, {firstSeen: {'0.3.0': 5}, refused: [{version: '0.2.9', root: 'r'}], declined: ['0.2.8'], announced: [{version: '0.3.1', key: '0123456789abcdef'}], lastSuccess: 7, lastCheck: now});
});

test('weekly waits a week; never never checks; a child that fails is said, and tried again an hour later; one start checks at a time', async () => {
  const {where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  setSetting(where, 'upgradeCheck', 'weekly', {by: 'cli'});
  const now = Date.now();
  assert.strictEqual((await run(where, {status: 0, stdout: ''}, now)).r.checked, true);
  assert.strictEqual((await run(where, undefined, now + 2 * 24 * 60 * 60 * 1000)).r.why, 'not due');
  setSetting(where, 'upgradeCheck', 'never', {by: 'cli'});
  assert.strictEqual((await run(where, undefined, now + 30 * 24 * 60 * 60 * 1000)).r.why, 'never');
  setSetting(where, 'upgradeCheck', 'daily', {by: 'cli'});
  const t = now + 31 * 24 * 60 * 60 * 1000;
  const failed = await run(where, 'hang', t);
  assert.ok(failed.r.failed);
  assert.match(failed.said[0], /^automatic upgrade check failed/);
  assert.strictEqual((await run(where, undefined, t + 30 * 60 * 1000)).r.why, 'not due', 'not within the hour');
  assert.strictEqual((await run(where, {status: 0, stdout: ''}, t + 61 * 60 * 1000)).r.checked, true, 'an hour later');
  fs.writeFileSync(path.join(where.home, 'upgrade-check.lock'), String(t + 2 * 24 * 60 * 60 * 1000));
  assert.strictEqual((await run(where, undefined, t + 2 * 24 * 60 * 60 * 1000 + 1000)).r.why, 'another start is checking');
});

// the review of #48 --------------------------------------------------------

test('a development override is checked before the child (the allowlist drops its variables): announced, recorded, no child', async () => {
  for (const [env, why] of [[{CH_LOCAL_DEV: '1'}, 'CH_LOCAL_DEV'], [{CH_LOCAL_REMOTE_MAP: 'https://x.invalid=http://y.invalid'}, 'CH_LOCAL_REMOTE_MAP']]) {
    const {h, where} = await home();
    setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
    const said = [];
    const c = child({status: 0, stdout: 'installed\n'});
    const io = Object.assign(fakeIo({env: Object.assign({}, shell, env), exec: c.exec}), {pid: 1, platform: 'linux'});
    const r = await autoCheck({where, io, say: (x) => said.push(x), host: 'box', now: Date.now()});
    assert.deepStrictEqual([r.checked, r.why, c.runs.length], [false, 'override', 0], why);
    assert.deepStrictEqual(said, [`automatic upgrades are off while a development override is set (${why})`]);
    const history = fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8');
    assert.match(history, new RegExp(`"reason":"${why}"`));
    assert.ok(!fs.existsSync(path.join(h, 'upgrade-check.lock')), 'the lock is released');
  }
  // an unreleased install, by its record
  const {h, where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  require('./store-helpers').editHome(h, (rec) => ({...rec, unreleased: true}));
  const out = await run(where, {status: 0, stdout: 'installed\n'}, Date.now());
  assert.deepStrictEqual([out.r.why, out.runs.length], ['override', 0]);
});

test('only the child\'s one line is said; a check still running (under its 15-minute timeout) is never taken for a stale lock', async () => {
  const {where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  const now = Date.now();
  const r = await run(where, {status: 0, stdout: 'fetching 3 package(s)\nGITHUB_TOKEN is set\nupgraded ch-local 0.1.0 -> 0.1.1; ch-local rollback undoes it\n'}, now);
  assert.deepStrictEqual(r.said, ['upgraded ch-local 0.1.0 -> 0.1.1; ch-local rollback undoes it']);
  // a lock taken 14 minutes ago: that check may still be running
  const later = now + 2 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(where.home, 'upgrade-check.lock'), String(later - 14 * 60 * 1000));
  assert.strictEqual((await run(where, undefined, later)).r.why, 'another start is checking');
  // one older than the timeout and its margin: stale, taken over
  fs.writeFileSync(path.join(where.home, 'upgrade-check.lock'), String(later - 21 * 60 * 1000));
  assert.strictEqual((await run(where, {status: 0, stdout: ''}, later)).r.checked, true);
});

test('the re-check of #48: a stamp start\'s check can\'t trust is not read, and that is recorded', {skip: process.platform === 'win32'}, async () => {
  const {h, where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  const f = path.join(h, 'upgrade-check.json');
  fs.writeFileSync(f, JSON.stringify({lastCheck: Date.now()}), {mode: 0o666});
  fs.chmodSync(f, 0o666);
  const r = await run(where, {status: 0, stdout: ''}, Date.now());
  assert.strictEqual(r.r.checked, true, 'its lastCheck was not taken');
  assert.match(fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8'), /"outcome":"stamp-reset".*group or others/);
});

