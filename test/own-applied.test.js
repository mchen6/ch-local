'use strict';
require('./tmp-dirs');
// R-add-module-says-early: add-module's and remove-module's line is printed
// once the running runtimes have applied the change, and says how it ended
// (lib/own-applied.js, from each live start's run.json: ownSeen, written by
// the applier after the loads and unloads are answered). Several starts: the
// worst of them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {layout} = require('../lib/home');
const {chLocal} = require('../lib/command-line');
const {installedHome} = require('./install-helpers');
const {addModule, removeModule} = require('../lib/own-command');
const {readOwnRecord} = require('../lib/own-record');

const SVC = 'urn:countinghouse-test:serviceID:toolService';
const ENFORCE = process.platform !== 'win32' ? false : 'enforce on Windows: countinghouse#195';
const WAITING = 'Waiting for the running runtime to apply it (up to 40 s)…\n';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const base = fs.realpathSync.native(tmp('ch-ownapplied-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.chmodSync(home, 0o700);
  installedHome(home, ['ci-failure-triage']);
  const where = layout({COUNTINGHOUSE_HOME: home});
  fs.mkdirSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker'), {recursive: true});
  fs.writeFileSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker', 'virtual-drive.js'), '');
  const dir = path.join(base, 'work', 'mine');
  fs.mkdirSync(path.join(dir, 'handlers', 'toolService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'my-tool', version: '1.0.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'my-tool', serviceList: {[SVC]: {actionList: [{name: 'run', description: 'runs'}]}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
  const alive = new Set();
  // a live start's run.json, written whole as start writes it
  const write = (pid, fields) => {
    alive.add(pid);
    const d = path.join(where.run, `box-1-${pid}-0a1b2c3d`);
    fs.mkdirSync(d, {recursive: true});
    const file = path.join(d, 'run.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({host: 'box-1', pid, startedAt: 1, shared: true, loaded: {}, stopped: {}, ownSeen: null, ownAt: null, ...fields}));
    fs.renameSync(`${file}.tmp`, file);
  };
  // a start whose process goes on (the daemon's, restarting its runtime), and one that ended
  const gone = (pid) => fs.rmSync(path.join(where.run, `box-1-${pid}-0a1b2c3d`), {recursive: true, force: true});
  const end = (pid) => { alive.delete(pid); gone(pid); };
  const io = (more = {}) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}, answers: ['y']}),
    {interactive: true, stdoutTTY: true, hostname: 'box-1', alive: (pid) => alive.has(pid), appliedWaitMs: 5000, appliedPollMs: 10, appliedSayMs: 4000, ...more});
  // own.json as it is now, as the applier stamps the one it read
  const at = () => require('../lib/own-applied').stampOf(where);
  // what the applier would write of my-tool as recorded now
  const seen = (state, more = {}) => {
    const e = readOwnRecord(where).modules['my-tool'];
    return {ownAt: at(), ownSeen: {'my-tool': {addedAt: e.addedAt, state, ...more}}, loaded: state === 'loaded' ? {'my-tool': e.tree} : {}};
  };
  const recorded = async () => { for (let i = 0; i < 500; i++) { const r = readOwnRecord(where); if (r != null && r.modules['my-tool'] != null) return; await tick(10); } throw new Error('never recorded'); };
  const removed = async () => { for (let i = 0; i < 500; i++) { const r = readOwnRecord(where); if (r != null && r.modules['my-tool'] == null) return; await tick(10); } throw new Error('never removed'); };
  const add = async (then, more) => {
    const f = io(more);
    const done = addModule({dir}, f, {where});
    await recorded();
    await then(f);
    assert.strictEqual(await done, 0, f.err);
    return f.out.slice(f.out.lastIndexOf('\nAdded ') + 1);
  };
  const added = async () => { assert.strictEqual(await addModule({dir}, io(), {where}), 0); };
  const remove = async (then, more) => {
    const f = io(more);
    const done = removeModule({name: 'my-tool'}, f, {where});
    await removed();
    await then(f);
    assert.strictEqual(await done, 0, f.err);
    return f.out;
  };
  const status = chLocal(where, 'status');
  const restart = chLocal(where, 'restart');
  const own = () => `Added my-tool (own, ${readOwnRecord(where).modules['my-tool'].tree.slice(0, 12)})`;
  return {home, where, dir, io, write, gone, end, at, seen, add, added, remove, status, restart, own};
}
const opt = {skip: ENFORCE};

test('add-module: no runtime runs: seen when the clients next start, and nothing is waited for', opt, async () => {
  const h = setup();
  assert.strictEqual(await h.add(async () => {}), `${h.own()}: your clients see it when they next start.\n`);
});

test('add-module: the line is printed only once the running runtime has loaded it', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  const line = await h.add(async (f) => {
    await tick(300);
    assert.ok(!f.out.includes('Added '), `printed before it was applied: ${f.out}`);
    assert.ok(!f.out.includes('Waiting'), 'nothing said of the wait yet');
    h.write(11, h.seen('loaded'));
  });
  assert.strictEqual(line, `${h.own()}: your clients see it now.\n`);
});

test('add-module: past about 2 s the wait is said, once', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  const f0 = {};
  const line = await h.add(async (f) => {
    f0.io = f;
    for (let i = 0; i < 300 && !f.out.includes('Waiting'); i++) await tick(10);
    h.write(11, h.seen('loaded'));
  }, {appliedSayMs: 50});
  assert.strictEqual(line, `${h.own()}: your clients see it now.\n`);
  assert.strictEqual(f0.io.out.split(WAITING).length, 2, f0.io.out);
});

test('add-module: an entry seen from an earlier add of the same code is not this one', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {'my-tool': {addedAt: '2026-01-01T00:00:00.000Z', state: 'loaded'}}, loaded: {'my-tool': 'f'.repeat(64)}});
  const line = await h.add(async (f) => {
    await tick(200);
    assert.ok(!f.out.includes('Added '), f.out);
    h.write(11, h.seen('loaded'));
  });
  assert.strictEqual(line, `${h.own()}: your clients see it now.\n`);
});

test('add-module: refused, kept out, not in time: each its own line', opt, async () => {
  const refused = setup();
  refused.write(11, {ownSeen: {}});
  assert.strictEqual(await refused.add(async () => refused.write(11, refused.seen('refused', {code: 'MODULE_INVALID'}))),
    `${refused.own()}, but the running runtime refused it (MODULE_INVALID): \`${refused.status}\` says why.\n`);
  const kept = setup();
  kept.write(11, {ownSeen: {}});
  assert.strictEqual(await kept.add(async () => kept.write(11, kept.seen('kept'))),
    `${kept.own()}, but the running runtime has not loaded it: \`${kept.status}\` says why.\n`);
  const late = setup();
  late.write(11, {ownSeen: {}});
  assert.strictEqual(await late.add(async () => {}, {appliedWaitMs: 150}),
    `${late.own()}. The running runtime has not taken it up yet: your clients see it once it has.\n`);
  const waits = setup();
  waits.write(11, {ownSeen: {}});
  assert.strictEqual(await waits.add(async () => waits.write(11, waits.seen('waits'))),
    `${waits.own()}. The running runtime has not taken it up yet: your clients see it once it has.\n`);
});

test('add-module: taken up only by a restart: the shared runtime\'s, or the client\'s; a shared one named first', opt, async () => {
  const shared = setup();
  shared.write(11, {ownSeen: {}});
  assert.strictEqual(await shared.add(async () => shared.write(11, shared.seen('restart'))),
    `${shared.own()}. The running runtime takes it up when it restarts: \`${shared.restart}\` asks for that.\n`);
  const own = setup();
  own.write(11, {ownSeen: {}, shared: false});
  assert.strictEqual(await own.add(async () => own.write(11, {shared: false, ...own.seen('restart')})),
    `${own.own()}. The running runtime takes it up when your client restarts.\n`);
  const both = setup();
  both.write(11, {ownSeen: {}, shared: false});
  both.write(12, {ownSeen: {}});
  assert.match(await both.add(async () => { both.write(11, {shared: false, ...both.seen('restart')}); both.write(12, both.seen('restart')); }), /asks for that/);
});

test('add-module: a code of another form, or an entry of another shape, is never printed nor taken for loaded', opt, async () => {
  for (const bad of ['rm -rf', 'A'.repeat(65), 'lower', 'MODULE_INVALID\u001b[2J', 7, null]) {
    const h = setup();
    h.write(11, {ownSeen: {}});
    assert.match(await h.add(async () => h.write(11, h.seen('refused', {code: bad})), {appliedWaitMs: 150}), /has not taken it up yet/, JSON.stringify(bad));
  }
  for (const shape of [[], 'x', 7, {'my-tool': 'loaded'}, {'my-tool': null}]) {
    const h = setup();
    h.write(11, {ownSeen: {}});
    assert.match(await h.add(async () => h.write(11, {ownSeen: shape}), {appliedWaitMs: 150}), /has not taken it up yet/, JSON.stringify(shape));
  }
  // said loaded, but not in what is loaded
  const h = setup();
  h.write(11, {ownSeen: {}});
  assert.match(await h.add(async () => h.write(11, {...h.seen('loaded'), loaded: {}}), {appliedWaitMs: 150}), /has not taken it up yet/);
});

test('add-module: a start of an older ch-local tells nothing: not in time, at once', opt, async () => {
  const h = setup();
  h.write(11, {});
  const file = path.join(h.where.run, 'box-1-11-0a1b2c3d', 'run.json');
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete run.ownSeen;
  fs.writeFileSync(file, JSON.stringify(run));
  const began = Date.now();
  assert.match(await h.add(async () => {}, {appliedWaitMs: 20000}), /has not taken it up yet: your clients see it once it has\.\n$/);
  assert.ok(Date.now() - began < 10000, 'not waited for');
});

test('add-module: several runtimes: the worst is said (refused, kept out, a restart, not in time, loaded)', opt, async () => {
  const ADD = [['refused', /refused it \(MODULE_INVALID\)/], ['kept', /has not loaded it/], ['restart', /takes it up when it restarts/], ['waits', /has not taken it up yet/], ['loaded', /see it now/]];
  for (let i = 0; i < ADD.length; i++) {
    for (let j = i; j < ADD.length; j++) {
      for (const [a, b] of [[i, j], [j, i]]) {
        const h = setup();
        h.write(11, {ownSeen: {}});
        h.write(12, {ownSeen: {}});
        const line = await h.add(async () => {
          h.write(11, h.seen(ADD[a][0], {code: 'MODULE_INVALID'}));
          h.write(12, h.seen(ADD[b][0], {code: 'MODULE_INVALID'}));
        });
        assert.match(line, ADD[i][1], `${ADD[a][0]} and ${ADD[b][0]}`);
      }
    }
  }
});

test('add-module: a runtime that ends while waited on drops out; none left: when they next start', opt, async () => {
  const two = setup();
  two.write(11, {ownSeen: {}});
  two.write(12, {ownSeen: {}});
  assert.strictEqual(await two.add(async () => { two.write(12, two.seen('loaded')); await tick(100); two.end(11); }), `${two.own()}: your clients see it now.\n`);
  const one = setup();
  one.write(11, {ownSeen: {}});
  assert.strictEqual(await one.add(async () => { await tick(100); one.end(11); }), `${one.own()}: your clients see it when they next start.\n`);
  // (one refused, then gone: what it said is gone with it)
  const said = setup();
  said.write(11, {ownSeen: {}});
  said.write(12, {ownSeen: {}});
  assert.strictEqual(await said.add(async () => { said.write(11, said.seen('refused', {code: 'MODULE_INVALID'})); await tick(100); said.end(11); said.write(12, said.seen('loaded')); }),
    `${said.own()}: your clients see it now.\n`);
});

test('add-module: a runtime that starts while one is waited on is not waited for', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  assert.strictEqual(await h.add(async () => { await tick(100); h.write(12, {}); await tick(50); h.write(11, h.seen('loaded')); }), `${h.own()}: your clients see it now.\n`);
});

test('add-module: a run.json that can\'t be read for a moment is read again', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  const file = path.join(h.where.run, 'box-1-11-0a1b2c3d', 'run.json');
  assert.strictEqual(await h.add(async () => { fs.writeFileSync(file, '{'); await tick(100); h.write(11, h.seen('loaded')); }), `${h.own()}: your clients see it now.\n`);
});

test('remove-module: printed once the running runtime has dropped it; still served, or not in time: said', opt, async () => {
  const h = setup();
  await h.added();
  h.write(11, h.seen('loaded'));
  assert.strictEqual(await h.remove(async (f) => { await tick(200); assert.strictEqual(f.out, ''); h.write(11, {ownSeen: {}, ownAt: h.at()}); }), 'Removed my-tool.\n');
  const still = setup();
  await still.added();
  const held = still.seen('loaded');
  still.write(11, held);
  assert.strictEqual(await still.remove(async () => still.write(11, {ownSeen: {}, ownAt: still.at(), loaded: held.loaded})),
    `Removed my-tool, but the running runtime still serves it: \`${still.restart}\` stops it.\n`);
  const own = setup();
  await own.added();
  const loaded = own.seen('loaded');
  own.write(11, {...loaded, shared: false});
  assert.strictEqual(await own.remove(async () => own.write(11, {ownSeen: {}, ownAt: own.at(), loaded: loaded.loaded, shared: false})),
    'Removed my-tool, but the running runtime still serves it: restart your client to stop it.\n');
  const late = setup();
  await late.added();
  late.write(11, late.seen('loaded'));
  assert.strictEqual(await late.remove(async () => {}, {appliedWaitMs: 150}),
    'Removed my-tool. The running runtime has not dropped it yet: your clients see it go once it has.\n');
});

test('remove-module: no runtime runs: the plain line; its data still named after any line', opt, async () => {
  const h = setup();
  await h.added();
  assert.strictEqual(await h.remove(async () => {}), 'Removed my-tool.\n');
  const kept = setup();
  await kept.added();
  kept.write(11, kept.seen('loaded'));
  const data = path.join(kept.where.moduleData, 'my-tool');
  fs.mkdirSync(data, {recursive: true});
  assert.strictEqual(await kept.remove(async () => {}, {appliedWaitMs: 100}),
    `Removed my-tool. The running runtime has not dropped it yet: your clients see it go once it has. Its data is kept in ${data}.\n`);
});

test('remove-module: several runtimes: the worst is said (still served, not in time, removed)', opt, async () => {
  const REMOVE = [['still', /still serves it/], ['late', /has not dropped it yet/], ['removed', /^Removed my-tool\.\n$/]];
  for (let i = 0; i < REMOVE.length; i++) {
    for (let j = i; j < REMOVE.length; j++) {
      for (const [a, b] of [[i, j], [j, i]]) {
        const h = setup();
        await h.added();
        const before = h.seen('loaded');
        h.write(11, before);
        h.write(12, before);
        const line = await h.remove(async () => { const as = {still: {ownSeen: {}, ownAt: h.at(), loaded: before.loaded}, late: before, removed: {ownSeen: {}, ownAt: h.at()}}; h.write(11, as[REMOVE[a][0]]); h.write(12, as[REMOVE[b][0]]); }, {appliedWaitMs: 200});
        assert.match(line, REMOVE[i][1], `${REMOVE[a][0]} and ${REMOVE[b][0]}`);
      }
    }
  }
});

test('remove-module: an own.json applied before the removal is not this one (an add still loading, then removed)', opt, async () => {
  const h = setup();
  // (no module seen yet, nothing loaded: the add's load is under way)
  h.write(11, {ownSeen: {}, ownAt: h.at()});
  const f = h.io({appliedWaitMs: 100});
  assert.strictEqual(await addModule({dir: h.dir}, f, {where: h.where}), 0);
  assert.strictEqual(await h.remove(async (g) => { await tick(150); assert.strictEqual(g.out, ''); h.write(11, {ownSeen: {}, ownAt: h.at()}); }), 'Removed my-tool.\n');
});

test('remove-module: a pack\'s module of the same name in what is loaded is not the own one', opt, async () => {
  const h = setup();
  await h.added();
  h.write(11, {ownSeen: {'my-tool': {addedAt: 'x', state: 'kept'}}, loaded: {'my-tool': '1.2.0'}});
  assert.strictEqual(await h.remove(async () => h.write(11, {ownSeen: {}, ownAt: h.at(), loaded: {'my-tool': '1.2.0'}})), 'Removed my-tool.\n');
  // (an own one's earlier code still loaded is)
  const old = setup();
  await old.added();
  old.write(11, {});
  assert.match(await old.remove(async () => old.write(11, {ownSeen: {}, ownAt: old.at(), loaded: {'my-tool': ['1.2.0', 'f'.repeat(64)]}})), /still serves it/);
});

test('remove-module: added again meanwhile by another command: this removal was applied', opt, async () => {
  const h = setup();
  await h.added();
  h.write(11, {});
  assert.strictEqual(await h.remove(async () => {
    await tick(30);
    const later = h.at();
    later.at = String(BigInt(later.at) + 1000000n);
    h.write(11, {ownSeen: {'my-tool': {addedAt: '2026-11-24T00:00:00.000Z', state: 'loaded'}}, ownAt: later, loaded: {'my-tool': 'e'.repeat(64)}});
  }), 'Removed my-tool.\n');
});

test('remove-module: the same code added again meanwhile, of the start\'s own plan: not said to be stopped by a restart', opt, async () => {
  const h = setup();
  await h.added();
  const tree = readOwnRecord(h.where).modules['my-tool'].tree;
  h.write(11, h.seen('waits'));
  assert.strictEqual(await h.remove(async () => {
    const later = h.at();
    later.at = String(BigInt(later.at) + 1000000n);
    h.write(11, {ownSeen: {'my-tool': {addedAt: '2026-11-24T00:00:00.000Z', state: 'waits'}}, ownAt: later, loaded: {'my-tool': tree}});
  }), 'Removed my-tool.\n');
});

test('a hand-over to a runtime whose run.json can\'t be read yet: waited for, then judged; and one past the bound is late, never "none"', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  const file = path.join(h.where.run, 'box-1-12-0a1b2c3d', 'run.json');
  assert.strictEqual(await h.add(async (f) => {
    h.write(12, {});
    fs.writeFileSync(file, '');
    h.end(11);
    await tick(100);
    assert.ok(!f.out.includes('Added '), f.out);
    h.write(12, h.seen('loaded'));
  }), `${h.own()}: your clients see it now.\n`);
  // (the old one ends as the bound passes, the new one live)
  const p = setup();
  p.write(11, {ownSeen: {}});
  assert.match(await p.add(async () => { p.write(12, {}); await tick(60); p.end(11); }, {appliedWaitMs: 150, appliedPollMs: 400}), /has not taken it up yet/);
});

test('own.json\'s stamp is read again, after a pause, where Windows refuses it while it is replaced', opt, async () => {
  const h = setup();
  await h.added();
  const stat = fs.statSync;
  const until = performance.now() + 12;
  fs.statSync = (f, ...o) => { if (f === h.where.ownRecord && performance.now() < until) throw Object.assign(new Error('EBUSY'), {code: 'EBUSY'}); return stat(f, ...o); };
  let got;
  try { got = h.at(); } finally { fs.statSync = stat; }
  assert.ok(got != null);
});

test('a run.json that can\'t be read: a dead start\'s is nothing; a live one\'s is waited for', opt, async () => {
  const dead = setup();
  const d = path.join(dead.where.run, 'box-1-77-0a1b2c3d');
  fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(d, 'run.json'), '');
  const began = Date.now();
  assert.strictEqual(await dead.add(async () => {}), `${dead.own()}: your clients see it when they next start.\n`);
  assert.ok(Date.now() - began < 3000, 'not waited for');
  const live = setup();
  live.write(11, {});
  fs.writeFileSync(path.join(live.where.run, 'box-1-11-0a1b2c3d', 'run.json'), '');
  assert.match(await live.add(async () => {}, {appliedWaitMs: 150}), /has not taken it up yet/);
});

test('an io that can\'t tell which starts are alive is an error, never a wait', opt, async () => {
  const h = setup();
  await assert.rejects(require('../lib/own-applied').addApplied(h.where, h.io({alive: undefined}), {name: 'my-tool', tree: 'f'.repeat(64), addedAt: 'x'}), /alive/);
});

test('remove-module: an own.json older by its content than its time says (the clock set back) is not this removal', opt, async () => {
  const h = setup();
  await h.added();
  const ahead = h.at();
  ahead.at = String(BigInt(ahead.at) + 60000000000n);
  const before = h.seen('loaded');
  h.write(11, {...before, ownAt: ahead});
  assert.strictEqual(await h.remove(async (f) => { await tick(200); assert.strictEqual(f.out, ''); h.write(11, {ownSeen: {}, ownAt: ahead}); }), 'Removed my-tool.\n');
});

test('remove-module: added again meanwhile with other code, the removed code still loaded: still served', opt, async () => {
  const h = setup();
  await h.added();
  const tree = readOwnRecord(h.where).modules['my-tool'].tree;
  h.write(11, {});
  assert.match(await h.remove(async () => {
    const later = h.at();
    later.at = String(BigInt(later.at) + 1000000n);
    h.write(11, {ownSeen: {'my-tool': {addedAt: '2026-11-24T00:00:00.000Z', state: 'restart'}}, ownAt: later, loaded: {'my-tool': tree}});
  }), /still serves it/);
});

test('add-module: the only runtime hands over to another process meanwhile: that one is judged', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  assert.strictEqual(await h.add(async (f) => {
    h.write(12, {startedAt: 2});
    h.end(11);
    await tick(100);
    assert.ok(!f.out.includes('Added '), f.out);
    h.write(12, {startedAt: 2, ...h.seen('waits')});
  }), `${h.own()}. The running runtime has not taken it up yet: your clients see it once it has.\n`);
});

test('add-module: the shared runtime restarting meanwhile is waited for (its daemon lives), and judged as it starts again', opt, async () => {
  const h = setup();
  h.write(11, {ownSeen: {}});
  assert.strictEqual(await h.add(async (f) => {
    h.gone(11);
    await tick(150);
    assert.ok(!f.out.includes('Added '), f.out);
    h.write(11, {startedAt: 2});
    await tick(50);
    // (a module of the new start's plan: whether it loaded is not told)
    h.write(11, {startedAt: 2, ...h.seen('waits')});
  }), `${h.own()}. The running runtime has not taken it up yet: your clients see it once it has.\n`);
});

test('status: an own module a running client keeps out for its sandbox is not said to be on', opt, async () => {
  const {status} = require('../lib/packs-command');
  const h = setup();
  await h.added();
  h.write(11, h.seen('kept', {kind: 'sandbox'}));
  const f = h.io();
  assert.strictEqual(await status({}, f), 0, f.err);
  assert.match(f.out, /^ {2}my-tool \(own, unpinned, [0-9a-f]{12}\) +not loaded: own modules run only with the sandbox enforced$/m);
});

test('status: an own module a running runtime refused in place is not said to be on; a code of another form is not shown', opt, async () => {
  const {status} = require('../lib/packs-command');
  const h = setup();
  await h.added();
  h.write(11, h.seen('refused', {code: 'MODULE_INVALID'}));
  const f = h.io();
  assert.strictEqual(await status({}, f), 0, f.err);
  assert.match(f.out, /^ {2}my-tool \(own, unpinned, [0-9a-f]{12}\) +not loaded: this release's runtime refuses it \(MODULE_INVALID\); fix it and add it again with /m);
  // (of an earlier add, or a code of another form: nothing said of it)
  const e = readOwnRecord(h.where).modules['my-tool'];
  for (const entry of [{addedAt: '2026-01-01T00:00:00.000Z', state: 'refused', code: 'MODULE_INVALID'}, {addedAt: e.addedAt, state: 'refused', code: 'no\u001b[2J'}]) {
    h.write(11, {ownSeen: {'my-tool': entry}});
    const g = h.io();
    assert.strictEqual(await status({}, g), 0, g.err);
    assert.match(g.out, /^ {2}my-tool \(own, unpinned, [0-9a-f]{12}\) +on; tools: run$/m, JSON.stringify(entry));
  }
});

// (as the user stops it: the signal ends the command, the lock already released)
test('an interrupt while it waits: the change stays recorded, no line is said, the lock is not left', {skip: process.platform === 'win32' && 'no SIGINT to another process on Windows'}, async () => {
  const {spawn} = require('node:child_process');
  const os = require('node:os');
  const {hostTag} = require('../lib/run-liveness');
  const h = setup();
  await h.added();
  const d = path.join(h.where.run, 'live');
  fs.mkdirSync(d, {recursive: true});
  const e = readOwnRecord(h.where).modules['my-tool'];
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({host: hostTag(os.hostname()), pid: process.pid, startedAt: 1, shared: true, stopped: {},
    loaded: {'my-tool': e.tree}, ownSeen: {'my-tool': {addedAt: e.addedAt, state: 'loaded'}}}));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'ch-local.js'), 'remove-module', 'my-tool'],
    {env: {...process.env, COUNTINGHOUSE_HOME: h.home, HOME: path.dirname(h.home)}, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve({code, signal})));
  try {
    for (let i = 0; i < 1500 && !out.includes('Waiting'); i++) await tick(10);
    assert.strictEqual(out, WAITING, 'waiting, said once');
    child.kill('SIGINT');
    const {code, signal} = await ended;
    assert.ok(signal === 'SIGINT' || (Number.isInteger(code) && code !== 0), `${code} ${signal}`);
    assert.strictEqual(out, WAITING, 'no line of how it ended');
    assert.strictEqual(readOwnRecord(h.where).modules['my-tool'], undefined, 'recorded');
    assert.ok(!fs.existsSync(path.join(h.home, 'packs.lock')), 'the home\'s lock released');
  } finally {
    child.kill('SIGKILL');
  }
});
