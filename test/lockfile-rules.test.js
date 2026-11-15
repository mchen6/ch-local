'use strict';
// lib/lockfile-rules.js (the review of #42): one set of rules for the runtime
// lockfile, released or --unreleased-pins. A runtime package from its own
// tarball at its pin; every dependency from registry.npmjs.org with a
// sha512; nothing linked, nothing from git or another host; and a bundled
// entry exempt only when its parent really bundles it: no resolved, no link,
// the runtime parent's lockfile entry listing it in bundleDependencies, and
// the parent's verified tarball holding it.
const test = require('node:test');
const assert = require('node:assert');
const {lockfileProblem} = require('../lib/lockfile-rules');
const {packageTgz} = require('./tgz');

const SHA = (c) => `sha512-${c.repeat(86)}==`;
const pins = {'@countinghouse/ch-local': {version: '0.4.0', integrity: SHA('A')}, countinghouse: {version: '8.0.0', integrity: SHA('B')}};
const runtime = ['@countinghouse/ch-local', 'countinghouse'];
const lock = (extra = {}, parents = {}) => ({lockfileVersion: 3, packages: Object.assign({'': {},
  'node_modules/@countinghouse/ch-local': Object.assign({version: '0.4.0', resolved: 'file:tarballs/countinghouse-ch-local-0.4.0.tgz', integrity: SHA('A')}, parents['@countinghouse/ch-local'] || {}),
  'node_modules/countinghouse': Object.assign({version: '8.0.0', resolved: 'file:tarballs/countinghouse-8.0.0.tgz', integrity: SHA('B')}, parents.countinghouse || {}),
  'node_modules/ajv': {version: '8.17.1', resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz', integrity: SHA('C')}}, extra)});
const tarballs = {
  '@countinghouse/ch-local': packageTgz({name: '@countinghouse/ch-local', version: '0.4.0'}, {'node_modules/@sigstore/verify/package.json': '{"name":"@sigstore/verify"}'}),
  countinghouse: packageTgz({name: 'countinghouse', version: '8.0.0'})
};
const check = (l, t = tarballs) => lockfileProblem(l, {runtime, pins, tarballs: t});

test('a good lockfile passes, a bundled entry its parent really bundles included', () => {
  assert.strictEqual(check(lock()), null);
  const bundled = lock({'node_modules/@countinghouse/ch-local/node_modules/@sigstore/verify': {version: '3.1.1', inBundle: true}},
    {'@countinghouse/ch-local': {bundleDependencies: ['@sigstore/verify']}});
  assert.strictEqual(check(bundled), null);
});

test('the review\'s case: an inBundle entry whose parent does not bundle it is refused (npm ci would fetch it)', () => {
  const sneaky = lock({'node_modules/countinghouse/node_modules/evil': {version: '6.6.6', inBundle: true}});
  assert.match(String(check(sneaky)), /node_modules\/countinghouse\/node_modules\/evil/);
  const resolved = lock({'node_modules/@countinghouse/ch-local/node_modules/@sigstore/verify': {version: '3.1.1', inBundle: true, resolved: 'https://elsewhere.example.invalid/v.tgz'}},
    {'@countinghouse/ch-local': {bundleDependencies: ['@sigstore/verify']}});
  assert.match(String(check(resolved)), /@sigstore\/verify/, 'a bundled entry has no resolved');
  const notInTarball = lock({'node_modules/@countinghouse/ch-local/node_modules/@sigstore/core': {version: '3.2.1', inBundle: true}},
    {'@countinghouse/ch-local': {bundleDependencies: ['@sigstore/core']}});
  assert.match(String(check(notInTarball)), /not in the tarball/);
  const loose = lock({'node_modules/evil': {version: '6.6.6', inBundle: true}});
  assert.match(String(check(loose)), /node_modules\/evil/, 'beneath no runtime package');
});

test('a dependency from another host, from git, linked, or without a sha512 is refused', () => {
  for (const entry of [{version: '1.0.0', resolved: 'https://registry.example.invalid/x/-/x-1.0.0.tgz', integrity: SHA('D')},
    {version: '1.0.0', resolved: 'git+ssh://git@github.com/x/x.git#abc', integrity: SHA('D')},
    {version: '1.0.0', link: true, resolved: '../x', integrity: SHA('D')},
    {version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'},
    {version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk='}]) {
    assert.ok(check(lock({'node_modules/x': entry})) != null, JSON.stringify(entry));
  }
});

test('a runtime package must resolve to its own tarball at its pinned version and integrity', () => {
  const wrongVersion = lock();
  wrongVersion.packages['node_modules/countinghouse'].version = '8.0.1';
  assert.match(String(check(wrongVersion)), /countinghouse at version 8\.0\.1/);
  const wrongFile = lock();
  wrongFile.packages['node_modules/countinghouse'].resolved = 'https://registry.npmjs.org/countinghouse/-/countinghouse-8.0.0.tgz';
  assert.match(String(check(wrongFile)), /not its tarball/);
  const wrongSha = lock();
  wrongSha.packages['node_modules/countinghouse'].integrity = SHA('E');
  assert.match(String(check(wrongSha)), /integrity for countinghouse/);
  const legacy = lock();
  legacy.dependencies = {};
  assert.match(String(check(legacy)), /v3 lockfile/);
});

test('without the tarballs (the early check), a bundled entry is held to everything but the tarball\'s contents', () => {
  const bundled = lock({'node_modules/@countinghouse/ch-local/node_modules/@sigstore/core': {version: '3.2.1', inBundle: true}},
    {'@countinghouse/ch-local': {bundleDependencies: ['@sigstore/core']}});
  assert.strictEqual(check(bundled, null), null);
  const sneaky = lock({'node_modules/countinghouse/node_modules/evil': {version: '6.6.6', inBundle: true}});
  assert.ok(check(sneaky, null) != null);
});
