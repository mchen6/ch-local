'use strict';
require('./tmp-dirs');
// lib/description-check.js (#413 section 9.3; L5b): install's and
// add-pack's check that each module is what the release's pins describe,
// read from its own package.json (lib/describe-module.js). Fails closed: a
// call it cannot resolve is never accepted unverified.
const test = require('node:test');
const assert = require('node:assert');
const {tmp} = require('./fake-io');
const {packageTgz} = require('./tgz');
const {storeModule} = require('./store-helpers');
const {layout} = require('../lib/home');
const {descriptionRefusal} = require('../lib/description-check');

const SCENARIO = '@countinghouse/ch-pack-a';
const PART = '@countinghouse/ch-step-b';
const OTHER = '@countinghouse/ch-pack-other';
const OTHER_PART = '@countinghouse/ch-step-c';
const api = (friendlyName) => JSON.stringify({device: {friendlyName, serviceList: {}}});
const none = {role: 'part', credentials: [], calls: [], confirmSettings: {}};
const top = {...none, role: 'scenario'};
// a release: pack a {SCENARIO, PART}, pack other {OTHER, OTHER_PART}
const release = (scenarioCalls = [PART]) => ({
  packs: {a: {modules: [SCENARIO, PART]}, other: {modules: [OTHER, OTHER_PART]}},
  modules: {[SCENARIO]: {...top, calls: scenarioCalls}, [PART]: none, [OTHER]: top, [OTHER_PART]: none},
  pins: {[SCENARIO]: {version: '1.0.0'}, [PART]: {version: '1.0.0'}, [OTHER]: {version: '1.0.0'}, [OTHER_PART]: {version: '1.0.0'}}
});
const bytesOf = (calls, {friendly = 'ch-pack-a'} = {}) => ({
  [SCENARIO]: packageTgz({name: SCENARIO, version: '1.0.0', countinghouse: {role: 'scenario', calls}}, {'api.json': api(friendly)}),
  [PART]: packageTgz({name: PART, version: '1.0.0', countinghouse: {role: 'part'}}, {'api.json': api('ch-step-b')})
});
const where = () => { const home = tmp('ch-home-'); return {...layout({COUNTINGHOUSE_HOME: home}), home}; };

test('what matches its description passes; a call that differs is refused as its calls', () => {
  assert.strictEqual(descriptionRefusal(where(), [SCENARIO, PART], release(), bytesOf(['ch-step-b/x.y'])), null);
  assert.match(descriptionRefusal(where(), [SCENARIO, PART], release([]), bytesOf(['ch-step-b/x.y'])),
    /^@countinghouse\/ch-pack-a 1\.0\.0 does not match this release's description of it \(its calls\)$/);
});

test('a call into a pack not installed: refused naming the pack to install first, never as a mismatch', () => {
  const r = descriptionRefusal(where(), [SCENARIO, PART], release([OTHER, PART]), bytesOf(['ch-step-b/x.y', 'ch-pack-other/x.y']));
  assert.strictEqual(r, `${SCENARIO} calls ${OTHER}, from pack other, which isn't installed; install other first`);
  // installed (the home holds it): resolved and passes
  const w = where();
  storeModule(w.home, OTHER, '1.0.0', {countinghouse: {role: 'scenario'}});
  assert.strictEqual(descriptionRefusal(w, [SCENARIO, PART], release([OTHER, PART]), bytesOf(['ch-step-b/x.y', 'ch-pack-other/x.y']), undefined, {[OTHER]: '1.0.0'}), null);
});

test('a manifest whose calls cannot be read is refused for that, never told to install another pack (the medium on L5b, 2)', () => {
  const bytes = bytesOf(['ch-step-b/x.y']);
  bytes[SCENARIO] = packageTgz({name: SCENARIO, version: '1.0.0', countinghouse: {role: 'scenario', calls: 'ch-pack-other/x.y'}}, {'api.json': api('ch-pack-a')});
  const r = descriptionRefusal(where(), [SCENARIO, PART], release([OTHER, PART]), bytes);
  assert.match(r, /\(its countinghouse\.calls is not a list\)$/);
  assert.ok(!/install other first/.test(r), r);
});

test('the home\'s modules add names only: two of them sharing one never refuse an operation that does not call it; a call to it is refused (the medium on L5b, 3)', () => {
  const w = where();
  // two installed modules, one friendly name between them
  storeModule(w.home, OTHER, '1.0.0', {countinghouse: {role: 'scenario'}, files: {'api.json': api('twin')}});
  storeModule(w.home, OTHER_PART, '1.0.0', {countinghouse: {role: 'part'}, files: {'api.json': api('twin')}});
  const context = {[OTHER]: '1.0.0', [OTHER_PART]: '1.0.0'};
  assert.strictEqual(descriptionRefusal(w, [SCENARIO, PART], release(), bytesOf(['ch-step-b/x.y']), undefined, context), null);
  // a call to the shared name maps to no one: refused, never guessed
  assert.match(descriptionRefusal(w, [SCENARIO, PART], release([OTHER, PART]), bytesOf(['ch-step-b/x.y', 'twin/x.y']), undefined, context),
    /does not match this release's description of it \(its calls\)/);
  // a name the operation shares with a module the home holds: a call to it
  // is refused too (the Reviewer's high review of #98, 5)
  const both = where();
  storeModule(both.home, OTHER, '1.0.0', {countinghouse: {role: 'scenario'}, files: {'api.json': api('ch-step-b')}});
  assert.match(descriptionRefusal(both, [SCENARIO, PART], release(), bytesOf(['ch-step-b/x.y']), undefined, {[OTHER]: '1.0.0'}),
    /does not match this release's description of it \(its calls\)/);
  // the operation's own names must still be one each
  const dup = bytesOf(['ch-step-b/x.y'], {friendly: 'ch-step-b'});
  assert.match(descriptionRefusal(where(), [SCENARIO, PART], release(), dup), /ch-step-b is the friendly name of both/);
});

test('only an active pack\'s modules count as installed for a call: a withdrawn or held pack\'s never load (the Reviewer\'s high review of #98, 7)', () => {
  const {activeContext} = require('../lib/description-check');
  const record = {packs: {other: {modules: {[OTHER]: '1.0.0'}}, gone: {modules: {[OTHER_PART]: '1.0.0'}}},
    withdrawn: [OTHER_PART], held: {kept: {modules: {'@countinghouse/ch-held': '1.0.0'}}},
    modules: {[OTHER]: {version: '1.0.0'}, [OTHER_PART]: {version: '1.0.0'}, '@countinghouse/ch-held': {version: '1.0.0'}}};
  assert.deepStrictEqual(activeContext(record), {[OTHER]: '1.0.0'});
  assert.deepStrictEqual(activeContext(null), {});
});
