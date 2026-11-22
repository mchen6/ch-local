'use strict';
require('./tmp-dirs');
// B-own-settings (the maintainer's decision: own-module settings are adjustable in
// release 1): `ch-local settings modules/set/reset` for the user's own
// modules, the declaration read from the module's checked copy (own.json's
// tree), under the same rules as a pack's: the installed runtime's reader,
// the operator's ceiling, a setting's own confirm asked at a terminal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {install} = require('../lib/install');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');
const {layout} = require('../lib/home');
const ownTree = require('../lib/own-tree');
const {readOwnRecord, writeOwnRecord} = require('../lib/own-record');
const {addModule, removeModule} = require('../lib/own-command');

const READER = `
const allowed = (d) => d.type === 'enum' ? d.values.join(' or ') : d.type === 'boolean' ? 'true or false' : d.format === 'repo' ? 'owner/name' : 'text of at most ' + (d.maxLength || 256) + ' characters';
module.exports = {
  parseDeclaration: (pkg) => {
    const s = pkg && pkg.countinghouse && pkg.countinghouse.settings;
    if (s == null) return {settings: null, problems: [], warnings: []};
    const out = Object.create(null);
    for (const [n, d] of Object.entries(s)) out[n] = Object.freeze(Object.assign({name: n, maxLength: d.maxLength || 256}, d));
    return {settings: out, problems: [], warnings: []};
  },
  checkValue: (d, v) => {
    const no = {ok: false, code: 'SETTING_OUT_OF_BOUNDS', reason: d.name + ' is ' + allowed(d)};
    if (d.type === 'enum') return d.values.includes(v) ? {ok: true, value: v} : no;
    if (d.type === 'boolean') return typeof v === 'boolean' ? {ok: true, value: v} : no;
    if (typeof v !== 'string' || v.length > d.maxLength) return no;
    if (d.format === 'repo' && !/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(v)) return no;
    return {ok: true, value: v};
  }
};
`;

const SVC = 'urn:countinghouse-test:serviceID:toolService';
const MINE = {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric', title: 'Units'},
  shareStats: {type: 'boolean', default: false, confirm: true, title: 'Share stats'}};
// ceiling: the runtime ceiling reader's answer (as settings-modules stubs it)
async function installed({ceiling = null} = {}) {
  const base = fs.realpathSync.native(tmp('ch-ownset-'));
  const home = path.join(base, 'home');
  const r = release();
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()}), r.allow), 0);
  const lib = path.join(home, 'app', 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(path.join(lib, 'fs-broker'), {recursive: true});
  fs.writeFileSync(path.join(lib, 'module-settings.js'), READER);
  fs.writeFileSync(path.join(lib, 'fs-broker', 'virtual-drive.js'), '');
  if (ceiling != null) {
    require('../lib/ceiling').resetForTests();
    fs.writeFileSync(path.join(lib, 'settings-ceiling.js'), `module.exports = {readCeiling: () => (${JSON.stringify(ceiling)}),
  moduleSettingRule: (c, pkg, setting) => {
    const m = (c != null && c.state === 'trusted' && c.ceiling != null) ? c.ceiling.moduleSettings : null;
    if (m == null) return null;
    const own = (m.byModule[pkg] != null) ? m.byModule[pkg][setting] : undefined;
    if (own != null && Object.prototype.hasOwnProperty.call(own, 'fixed')) return own;
    if (m.conversation === false) return {conversation: false};
    return own != null ? own : null;
  }};\n`);
  }
  require('../lib/module-values').resetForTests();
  const where = layout({COUNTINGHOUSE_HOME: home});
  let n = 0;
  // an own module, placed and recorded as add-module does it
  const own = (settings = MINE, name = 'my-tool') => {
    const src = path.join(base, 'work', `${name}-${n++}`);
    fs.mkdirSync(path.join(src, 'handlers', 'toolService'), {recursive: true});
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario', settings}}));
    fs.writeFileSync(path.join(src, 'api.json'), JSON.stringify({device: {friendlyName: name, serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
    fs.writeFileSync(path.join(src, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
    const c = ownTree.checkFolder(src, home);
    const tree = ownTree.treeHash(c.real, c.entries);
    ownTree.placeCopy(where, name, c.real, c.entries, tree);
    const modules = (readOwnRecord(where) || {modules: {}}).modules;
    writeOwnRecord(where, {v: 1, modules: {...modules, [name]: {tree, version: '1.0.0', friendlyName: name, addedAt: new Date(0).toISOString(), from: c.real, calls: []}}});
    return {tree, src: c.real};
  };
  return {base, home, where, own};
}
const cli = async (home, argv, {interactive = true, answers = []} = {}) => {
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {interactive});
  const left = [...answers];
  io.ask = async (q) => { io.asked.push(q); return left.length > 0 ? left.shift() : ''; };
  const code = await main(argv, io);
  return {code, io};
};
const fileValues = (home) => (fs.existsSync(path.join(home, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).values : {});

test('settings modules lists an own module\'s settings, from its copy', async () => {
  const h = await installed();
  h.own();
  const r = await cli(h.home, ['settings', 'modules']);
  assert.strictEqual(r.code, 0, r.io.err);
  assert.match(r.io.out, /^my-tool\.units = metric {2}\(Units; default metric; metric or imperial\)$/m);
  const one = await cli(h.home, ['settings', 'modules', 'my-tool']);
  assert.match(one.io.out, /^my-tool\.shareStats = off {2}\(Share stats; default off; true or false; asks before a change\)$/m);
});

test('settings set and reset an own module\'s setting; its own confirm is asked at a terminal, refused elsewhere', async () => {
  const h = await installed();
  h.own();
  const set = await cli(h.home, ['settings', 'set', 'my-tool.units', 'imperial']);
  assert.strictEqual(set.code, 0, set.io.err);
  assert.strictEqual(fileValues(h.home)['module.my-tool.units'], 'imperial');
  const off = await cli(h.home, ['settings', 'set', 'my-tool.shareStats', 'true'], {interactive: false});
  assert.strictEqual(off.code, 2);
  assert.match(off.io.err, /shareStats for my-tool is confirmed at a terminal/);
  const yes = await cli(h.home, ['settings', 'set', 'my-tool.shareStats', 'true'], {answers: ['y']});
  assert.strictEqual(yes.code, 0, yes.io.err);
  assert.match(yes.io.asked[0], /^Change shareStats for my-tool from false to true\? \[y\/N\] $/);
  const reset = await cli(h.home, ['settings', 'reset', 'my-tool']);
  assert.strictEqual(reset.code, 0, reset.io.err);
  assert.deepStrictEqual(Object.keys(fileValues(h.home)).filter((k) => k.startsWith('module.my-tool.')), []);
});

test('an own module whose copy changed since the yes: its settings are not read; the line says to add it again', async () => {
  const h = await installed();
  const {tree, src} = h.own();
  const api = path.join(ownTree.copyDir(h.where, 'my-tool', tree), 'package.json');
  fs.chmodSync(api, 0o644);
  fs.appendFileSync(api, ' ');
  const r = await cli(h.home, ['settings', 'set', 'my-tool.units', 'imperial']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.io.err.includes(`my-tool's files changed since you added it: run \``) && r.io.err.includes(`add-module "${src}"\` again; nothing was changed`), r.io.err);
  assert.strictEqual(fileValues(h.home)['module.my-tool.units'], undefined);
});

test('a re-add whose declaration changed: read from the new copy, as a pack upgrade is; a leftover value is reset by name', async () => {
  const h = await installed();
  h.own();
  assert.strictEqual((await cli(h.home, ['settings', 'set', 'my-tool.units', 'imperial'])).code, 0);
  h.own({mode: {type: 'enum', values: ['fast', 'slow'], default: 'fast', title: 'Mode'}});
  const list = await cli(h.home, ['settings', 'modules', 'my-tool']);
  assert.match(list.io.out, /^my-tool\.mode = fast/m);
  assert.ok(!/my-tool\.units/.test(list.io.out), list.io.out);
  const gone = await cli(h.home, ['settings', 'set', 'my-tool.units', 'metric']);
  assert.strictEqual(gone.code, 2);
  assert.match(gone.io.err, /my-tool declares no setting units; it declares mode/);
  assert.strictEqual((await cli(h.home, ['settings', 'reset', 'my-tool'])).code, 0);
  assert.strictEqual(fileValues(h.home)['module.my-tool.units'], undefined, 'the leftover reset');
});

test('stored settings are said before the yes (8a), and kept by remove-module, with how to reset them', async () => {
  const h = await installed();
  const {src} = h.own();
  assert.strictEqual((await cli(h.home, ['settings', 'set', 'my-tool.units', 'imperial'])).code, 0);
  const rm = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h.home}}), {alive: () => false, hostname: 'box-1'});
  assert.strictEqual(await removeModule({name: 'my-tool'}, rm, {where: h.where}), 0, rm.err);
  assert.match(rm.out, /^Removed my-tool\. Its settings stay stored: `.*settings reset my-tool` resets them\.$/m);
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h.home}, answers: ['n']}), {interactive: true, stdoutTTY: true});
  await addModule({dir: src}, io, {where: h.where});
  assert.match(io.out, /^It will use the settings stored for my-tool \(units\)\. Remove it first if this is a different module: `.*settings reset my-tool`\.$/m);
  // the advised command works on a removed module's name (the medium, 1)
  const reset = await cli(h.home, ['settings', 'reset', 'my-tool']);
  assert.strictEqual(reset.code, 0, reset.io.err);
  assert.strictEqual(fileValues(h.home)['module.my-tool.units'], undefined);
});

// the /code-review medium on B-own-settings
test('a declared title or description is shown with nothing that moves the cursor (2)', async () => {
  const h = await installed();
  h.own({units: {type: 'enum', values: ['a', 'b'], default: 'a', title: 'Units\u001b[2K', description: 'x‮y'}});
  const r = await cli(h.home, ['settings', 'modules', 'my-tool']);
  assert.ok(!/[\u001b‮]/.test(r.io.out), JSON.stringify(r.io.out));
  assert.match(r.io.out, /\(Units\?\[2K; default a/);
});

// the reviewer on #116: an exact installed full name wins over a short-name
// match (add-module refuses such a name now; a home from before may hold one)
test('an installed module\'s exact full name wins over another\'s short name; the pack by its own full name', async () => {
  const h = await installed();
  h.own(MINE, 'ch-step-redact');
  const own = await cli(h.home, ['settings', 'set', 'ch-step-redact.units', 'imperial']);
  assert.strictEqual(own.code, 0, own.io.err);
  assert.strictEqual(fileValues(h.home)['module.ch-step-redact.units'], 'imperial');
  const pack = await cli(h.home, ['settings', 'modules', '@countinghouse/ch-step-redact']);
  assert.strictEqual(pack.code, 0, pack.io.err);
});

test('an own.json that cannot be read is said, not taken for no own module (5)', async () => {
  const h = await installed();
  h.own();
  fs.writeFileSync(h.where.ownRecord, '{');
  const set = await cli(h.home, ['settings', 'set', 'my-tool.units', 'imperial']);
  assert.strictEqual(set.code, 2);
  assert.match(set.io.err, /your own modules could not be read \(.*own\.json/);
  const list = await cli(h.home, ['settings', 'modules']);
  assert.match(list.io.out + list.io.err, /your own modules could not be read/);
});

// the reviewer on #116, 1: a removed own module's stored name that an
// installed module's short name also takes is ambiguous -- never the pack's
// settings reset by the advice; module.<name> is the exact name
test('reset of a removed own module\'s name a pack\'s short name also takes: ambiguous; module.<name> resets only the own one\'s', async () => {
  const h = await installed();
  h.own(MINE, 'ch-step-redact');
  assert.strictEqual((await cli(h.home, ['settings', 'set', 'ch-step-redact.units', 'imperial'])).code, 0);
  require('../lib/settings').writeModuleValues(h.where, {'module.@countinghouse/ch-step-redact.mode': 'tight'}, {by: 'cli'});
  writeOwnRecord(h.where, {v: 1, modules: {}});
  const amb = await cli(h.home, ['settings', 'reset', 'ch-step-redact']);
  assert.strictEqual(amb.code, 2);
  assert.match(amb.io.err, /ch-step-redact names more than one module: ch-step-redact \(no longer installed; its settings stored\) and @countinghouse\/ch-step-redact; give module\.<full name>/);
  assert.strictEqual(fileValues(h.home)['module.@countinghouse/ch-step-redact.mode'], 'tight', 'the pack\'s setting untouched');
  const exact = await cli(h.home, ['settings', 'reset', 'module.ch-step-redact']);
  assert.strictEqual(exact.code, 0, exact.io.err);
  assert.strictEqual(fileValues(h.home)['module.ch-step-redact.units'], undefined);
  assert.strictEqual(fileValues(h.home)['module.@countinghouse/ch-step-redact.mode'], 'tight');
});

// the reviewer on #116: the operator's ceiling binds an own module's
// settings as a pack's -- fixed, confirm, untrusted
test('the ceiling on an own module: a fixed value refuses, a confirm asks, an untrusted ceiling changes nothing', async () => {
  const fixed = await installed({ceiling: {state: 'trusted', file: '/etc/c.json', ceiling: {forbid: [], moduleSettings: {conversation: true, byModule: {'my-tool': {units: {fixed: 'metric'}}}}}}});
  fixed.own();
  const f = await cli(fixed.home, ['settings', 'set', 'my-tool.units', 'imperial']);
  assert.strictEqual(f.code, 2);
  assert.match(f.io.err, /units for my-tool is fixed by this machine's operator ceiling/);
  const conf = await installed({ceiling: {state: 'trusted', file: '/etc/c.json', ceiling: {forbid: [], moduleSettings: {conversation: true, byModule: {'my-tool': {units: {confirm: true}}}}}}});
  conf.own();
  const c = await cli(conf.home, ['settings', 'set', 'my-tool.units', 'imperial'], {interactive: false});
  assert.strictEqual(c.code, 2);
  assert.match(c.io.err, /units for my-tool is confirmed at a terminal/);
  const unt = await installed({ceiling: {state: 'untrusted', file: '/etc/c.json', problem: 'not this user\'s'}});
  unt.own();
  const u = await cli(unt.home, ['settings', 'set', 'my-tool.units', 'imperial']);
  assert.strictEqual(u.code, 2);
  assert.match(u.io.err, /cannot be trusted/);
  assert.strictEqual(fileValues(unt.home)['module.my-tool.units'], undefined);
});
