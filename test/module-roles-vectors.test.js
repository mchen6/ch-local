'use strict';
require('./tmp-dirs');
// ch-local's top-level rule against the runtime's, so the two can't drift
// apart (countinghouse #449, M5b): lib/module-roles.js topLevel, by
// lib/packs.js packScenario, held to the shared vectors' topLevelModules
// (test/vectors/top-level-modules.json, copied from countinghouse). A
// top-level module is the one with an enabled.<module>; a part has none.
const test = require('node:test');
const assert = require('node:assert');
const {topLevel, isPart} = require('../lib/module-roles');
const {topLevelModules} = require('./vectors/top-level-modules.json');

test('the shared vectors\' topLevelModules: each record\'s top-level modules, exactly; every other module it holds a part', () => {
  assert.ok(topLevelModules.cases.length > 0);
  for (const c of topLevelModules.cases) {
    assert.deepStrictEqual([...topLevel(c.record)].sort(), [...c.topLevel].sort(), c.why);
    for (const m of Object.keys((c.record && c.record.modules) || {})) {
      assert.strictEqual(isPart(c.record, m), !c.topLevel.includes(m), `${c.why}: ${m}`);
    }
  }
});
