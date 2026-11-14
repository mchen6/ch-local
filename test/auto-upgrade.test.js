'use strict';
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

const registry = (latest) => async (url) => {
  const name = decodeURIComponent(url.split('/').pop());
  if (latest === 'down') return {status: 503, ok: false};
  return latest[name] == null ? {status: 404, ok: false} : {status: 200, ok: true, json: async () => ({'dist-tags': {latest: latest[name]}})};
};
async function home() {
  const h = tmp('ch-home-');
  const r = release();
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()}), r.allow), 0);
  return {h, where: layout({COUNTINGHOUSE_HOME: h})};
}
const run = (where, latest, now) => {
  const said = [];
  const io = Object.assign(fakeIo({fetch: registry(latest)}), {pid: 1});
  return autoCheck({where, io, say: (s) => said.push(s), host: 'box', now}).then((r) => ({r, said, fetches: io.fetches}));
};

test('off by default: no check, no network', async () => {
  const {where} = await home();
  const {r, fetches} = await run(where, {}, Date.now());
  assert.deepStrictEqual([r.checked, r.why, fetches.length], [false, 'off', 0]);
});

test('on: a newer version is said and recorded; the next start within the day does not check again', async () => {
  const {h, where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  const now = Date.now();
  const first = await run(where, {'@countinghouse/ch-step-redact': '0.2.0'}, now);
  assert.strictEqual(first.r.checked, true);
  assert.deepStrictEqual(first.r.newer.map((n) => [n.name, n.have, n.latest]), [['@countinghouse/ch-step-redact', '0.1.0', '0.2.0']]);
  assert.match(first.said[0], /^@countinghouse\/ch-step-redact 0\.2\.0 is available \(installed 0\.1\.0\)/);
  const lines = fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.by === 'auto-upgrade' && e.change === 'upgrade available'));
  const again = await run(where, {}, now + 60 * 60 * 1000);
  assert.deepStrictEqual([again.r.checked, again.r.why, again.fetches.length], [false, 'not due', 0]);
  const nextDay = await run(where, {}, now + 25 * 60 * 60 * 1000);
  assert.strictEqual(nextDay.r.checked, true);
});

test('weekly waits a week; never never checks; a failed check is said, recorded, and changes nothing', async () => {
  const {where} = await home();
  setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
  setSetting(where, 'upgradeCheck', 'weekly', {by: 'cli'});
  const now = Date.now();
  assert.strictEqual((await run(where, {}, now)).r.checked, true);
  assert.strictEqual((await run(where, {}, now + 2 * 24 * 60 * 60 * 1000)).r.why, 'not due');
  setSetting(where, 'upgradeCheck', 'never', {by: 'cli'});
  assert.strictEqual((await run(where, {}, now + 30 * 24 * 60 * 60 * 1000)).r.why, 'never');
  setSetting(where, 'upgradeCheck', 'daily', {by: 'cli'});
  const failed = await run(where, 'down', now + 31 * 24 * 60 * 60 * 1000);
  assert.ok(failed.r.failed);
  assert.match(failed.said[0], /^automatic upgrade check failed \(the npm registry answered 503/);
});
