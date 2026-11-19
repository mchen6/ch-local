'use strict';
require('./tmp-dirs');
// The root fix for prototype keys (the Reviewer's high review of #96): the
// record's maps (packs, each pack's modules, modules, held) and the
// versions derived from them (highest, livePacks, activeVersions, derive)
// have no prototype, so a module or pack named "constructor", "toString"
// or "__proto__" is never found on Object.prototype, wherever the record
// goes (availability, pack-table's live and othersAt, in-place). The shared
// vectors' topLevelModules "constructor" cases, through availability.
const test = require('node:test');
const assert = require('node:assert');
const {readModulesRecord, activeVersions, derive} = require('../lib/module-record');
const {availability} = require('../lib/availability');
const {layout} = require('../lib/home');
const {tmp} = require('./fake-io');
const {storeModule, writeHome} = require('./store-helpers');

const PROTO_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
const NONE = {ceiling: () => null, off: () => null, credential: () => null};

test('the record read from disk, and what is derived from it, have no prototype: a prototype key is absent', () => {
  const dir = tmp('ch-proto-');
  storeModule(dir, '@t/ch-pack-a', '1.0.0', {countinghouse: {role: 'scenario', calls: []}});
  writeHome(dir, {a: {'@t/ch-pack-a': '1.0.0'}});
  const r = readModulesRecord(layout({COUNTINGHOUSE_HOME: dir}));
  const maps = {packs: r.packs, 'packs.a.modules': r.packs.a.modules, modules: r.modules, held: r.held,
    activeVersions: activeVersions(r.packs, r.withdrawn), derive: derive(r.packs, () => 'part', r.withdrawn)};
  for (const [what, m] of Object.entries(maps)) {
    assert.strictEqual(Object.getPrototypeOf(m), null, what);
    for (const k of PROTO_KEYS) assert.strictEqual(m[k], undefined, `${what}[${k}]`);
  }
  assert.strictEqual(r.modules['@t/ch-pack-a'].version, '1.0.0', 'its own entries read as before');
  const file = JSON.parse(require('node:fs').readFileSync(require('node:path').join(dir, 'modules.json'), 'utf8'));
  assert.strictEqual(JSON.stringify(r.packs), JSON.stringify(file.packs), 'and serialise as the file has them');
});

test('a held module named "constructor", of role scenario, is top-level through availability, as the vectors have it', () => {
  const dir = tmp('ch-proto-');
  const where = layout({COUNTINGHOUSE_HOME: dir});
  storeModule(dir, 'constructor', '1.0.0', {countinghouse: {role: 'scenario', calls: []}});
  storeModule(dir, '@t/ch-step-x', '1.0.0', {countinghouse: {role: 'part', calls: []}});
  const packs = {c: {'@t/ch-step-x': '1.0.0', constructor: '1.0.0'}};
  const record = writeHome(dir, packs);
  const release = {packs: {c: {packages: Object.keys(packs.c)}}, pins: {constructor: {version: '1.0.0'}, '@t/ch-step-x': {version: '1.0.0'}}};
  const av = availability(where, record, {release, seams: NONE});
  assert.deepStrictEqual(av.units.map((u) => u.name), ['constructor']);
  // (its closure is what it calls: nothing here)
  assert.deepStrictEqual(Object.keys(av.units[0].modules), ['constructor']);
  const {topLevel, isPart} = require('../lib/module-roles');
  assert.deepStrictEqual([...topLevel(record)], ['constructor']);
  assert.strictEqual(isPart(record, '@t/ch-step-x'), true);
});
