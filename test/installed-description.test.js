'use strict';
require('./tmp-dirs');
// lib/installed-description.js (#413 rev 3 sections 9.3 and 9.6; L4): what
// the home has installed, pins-shaped, each module described from the store
// at the version its record names; unknown (null) when it can't be.
const test = require('node:test');
const assert = require('node:assert');
const {tmp} = require('./fake-io');
const {storeModule} = require('./store-helpers');
const {layout} = require('../lib/home');
const {installedDescription} = require('../lib/installed-description');

const A = '@countinghouse/ch-pack-a';
const P = '@countinghouse/ch-step-p';
const api = (friendlyName) => JSON.stringify({device: {friendlyName, serviceList: {}}});

test('each recorded module described from the store at its recorded version; packs list their modules', () => {
  const home = tmp('ch-home-');
  storeModule(home, A, '1.0.0', {countinghouse: {role: 'scenario', calls: ['ch-step-p/x.y']}, files: {'api.json': api('ch-pack-a')}});
  storeModule(home, P, '2.0.0', {countinghouse: {role: 'part', remotes: [{name: 'r', url: 'https://api.example.test/mcp', credential: 'P_TOKEN'}]}, files: {'api.json': api('ch-step-p')}});
  const record = {packs: {a: {modules: {[A]: '1.0.0', [P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}};
  const d = installedDescription(layout({COUNTINGHOUSE_HOME: home}), record);
  assert.deepStrictEqual(d.packs, {a: {modules: [A, P]}});
  assert.deepStrictEqual(d.modules[A], {role: 'scenario', credentials: [], calls: [P], confirmSettings: {}});
  assert.deepStrictEqual(d.modules[P].credentials, [{variable: 'P_TOKEN', origin: 'https://api.example.test'}]);
});

test('a module the store does not hold at its recorded version, or that cannot be described, is unknown (null), never a guess', () => {
  const home = tmp('ch-home-');
  storeModule(home, A, '1.0.0', {countinghouse: {role: 'scenario', calls: ['nobody/x.y']}, files: {'api.json': api('ch-pack-a')}});
  const record = {packs: {a: {modules: {[A]: '1.0.0', [P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}};
  const d = installedDescription(layout({COUNTINGHOUSE_HOME: home}), record);
  assert.strictEqual(d.modules[A], null, 'a call to no module of the home');
  assert.strictEqual(d.modules[P], null, 'not in the store');
  assert.deepStrictEqual(installedDescription(layout({COUNTINGHOUSE_HOME: home}), null), {packs: {}, modules: {}});
});
