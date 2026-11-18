'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {compareVersions} = require('../lib/semver-order');

test('semver precedence, prereleases included, both ways', () => {
  // the spec's own chain (SemVer 2.0.0, section 11)
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i < chain.length; i++) {
    for (let j = 0; j < chain.length; j++) assert.strictEqual(compareVersions(chain[i], chain[j]), Math.sign(i - j), `${chain[i]} vs ${chain[j]}`);
  }
  // an rc against its final, both ways (the Reviewer on L2a)
  assert.strictEqual(compareVersions('1.2.0-rc.1', '1.2.0'), -1);
  assert.strictEqual(compareVersions('1.2.0', '1.2.0-rc.1'), 1);
  // build metadata is ignored; numbers are numbers
  assert.strictEqual(compareVersions('1.2.0+build.7', '1.2.0'), 0);
  assert.strictEqual(compareVersions('1.10.0', '1.9.0'), 1);
});

test('anything that is not a version compares as null', () => {
  for (const bad of ['1.2', '01.2.3', '1.2.3-', '1.2.3-01', 'v1.2.3', null, 3]) assert.strictEqual(compareVersions(bad, '1.2.3'), null, String(bad));
});
