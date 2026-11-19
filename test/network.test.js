'use strict';
require('./tmp-dirs');
// No command other than install and upgrade makes a network call (spec §2):
// every lib file loads with the network stubbed to throw, and only
// lib/registry.js may name a network module or fetch. lib/daemon.js names
// node:net for its PROVE probe only: a connect to its own runtime's unix
// socket under <home>/run/daemon, never a host and port. lib/npm-fetch.js
// (upgrades from npm) calls io.fetch only, an HTTPS GET on
// https://registry.npmjs.org's exact origin: no other host, and no URL the
// environment chooses. A fake registry reaches it only as a test's own
// `registry` argument.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {fakeIo, tmp} = require('./fake-io');

const LIB = path.join(__dirname, '..', 'lib');

test('only lib/registry.js names a network module or fetch', () => {
  for (const f of fs.readdirSync(LIB)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    const net = /require\(['"](node:)?(http|https|net|tls|dns|http2|dgram)['"]\)|\bfetch\(/.test(src);
    assert.strictEqual(net, f === 'registry.js' || f === 'daemon.js' || f === 'npm-fetch.js', f);
  }
});

test('lib/npm-fetch.js: its one network use is io.fetch, on registry.npmjs.org\'s exact origin, chosen by no environment', () => {
  const src = fs.readFileSync(path.join(LIB, 'npm-fetch.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /require\(['"](node:)?(http|https|net|tls|dns|http2|dgram|undici)['"]\)/, 'no network module');
  assert.deepStrictEqual([...code.matchAll(/(\S*)\bfetch\(/g)].map((m) => m[1]), ['io.'], 'one fetch call, through io');
  assert.match(code, /redirect: 'error'/, 'a redirect never leaves the origin');
  assert.doesNotMatch(code, /process\.env|\benv\b|process\.argv/, 'nothing in the environment chooses a URL');
  const npmFetch = require('../lib/npm-fetch');
  assert.strictEqual(npmFetch.REGISTRY, 'https://registry.npmjs.org/');
  assert.strictEqual(new URL(npmFetch.REGISTRY).origin, 'https://registry.npmjs.org');
  // every `registry` it takes defaults to REGISTRY
  const defaults = [...code.matchAll(/\bregistry = ([^,}]+)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual([...new Set(defaults)], ['REGISTRY']);
  assert.strictEqual(defaults.length, 3, 'packument, attestations and fetchTarball');
});

test('lib/npm-fetch.js: every request is an HTTPS GET to registry.npmjs.org, whatever the environment says', async () => {
  const npmFetch = require('../lib/npm-fetch');
  const NAME = '@countinghouse/ch-local';
  const integrity = `sha512-${'A'.repeat(86)}==`;
  const seen = [];
  const answer = (status, body) => new Response(body, {status, headers: {'content-type': 'application/json'}});
  const fetch = async (url, opts) => {
    seen.push({url, opts});
    if (url === `${npmFetch.REGISTRY}${NAME.replace('/', '%2F')}`) {
      return answer(200, JSON.stringify({versions: {'0.2.0': {dist: {tarball: npmFetch.tarballUrl(npmFetch.REGISTRY, NAME, '0.2.0'), integrity}}}}));
    }
    return answer(404, '{}');
  };
  const env = {npm_config_registry: 'http://elsewhere.invalid/', NPM_CONFIG_REGISTRY: 'http://elsewhere.invalid/', CH_LOCAL_REMOTE_MAP: 'https://registry.npmjs.org/=http://elsewhere.invalid/', CH_LOCAL_DEV: '1'};
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const io = {env, fetch};
    assert.notStrictEqual(await npmFetch.packument(NAME, io), null);
    assert.strictEqual(await npmFetch.attestations(NAME, '0.2.0', io), null);
    await assert.rejects(npmFetch.fetchTarball(NAME, '0.2.0', io), {code: 'NOT_PUBLISHED'});
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.strictEqual(seen.length, 4, 'packument; attestations; packument and tarball');
  for (const {url, opts} of seen) {
    const u = new URL(url);
    assert.strictEqual(u.origin, 'https://registry.npmjs.org', url);
    assert.strictEqual(u.protocol, 'https:', url);
    assert.ok(opts.method == null || opts.method === 'GET', url);
    assert.strictEqual(opts.body, undefined, url);
    assert.strictEqual(opts.redirect, 'error', url);
  }
  assert.ok(seen.some(({url}) => url.endsWith('/-/ch-local-0.2.0.tgz')), 'the tarball, on the same origin');
});

test('a fake registry reaches lib/npm-fetch.js only as a test\'s own argument: no lib or bin file picks another', () => {
  const files = [...fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => path.join(LIB, f)),
    ...fs.readdirSync(path.join(LIB, '..', 'bin')).filter((f) => f.endsWith('.js')).map((f) => path.join(LIB, '..', 'bin', f))];
  for (const file of files) {
    if (path.basename(file) === 'npm-fetch.js') continue;
    const code = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const f = path.relative(path.join(LIB, '..'), file);
    assert.doesNotMatch(code, /fake-registry|require\(['"]\.\.?\/test\//, f);
    // a `registry` it takes defaults to npm-fetch's own; one it passes on is that one, or REGISTRY
    for (const m of code.matchAll(/\bregistry = ([^,})]+)/g)) assert.strictEqual(m[1].trim(), 'npmFetch.REGISTRY', `${f}: registry = ${m[1]}`);
    for (const m of code.matchAll(/\bregistry: ([^,})]+)/g)) assert.ok(['REGISTRY', 'npmFetch.REGISTRY'].includes(m[1].trim()), `${f}: registry: ${m[1]}`);
    if (/require\(['"]\.\/npm-fetch['"]\)/.test(code)) assert.doesNotMatch(code, /\b(npm_config_registry|NPM_CONFIG_REGISTRY)\b/i, f);
  }
});

test('lib/daemon.js\'s one use of node:net is a connect to a socket path, never a host and port', async () => {
  const src = fs.readFileSync(path.join(LIB, 'daemon.js'), 'utf8');
  const uses = [...src.matchAll(/\bnet\.(\w+)\(([^)]*)\)/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(uses, [['createConnection', 'socket']]);
  // and the probe refuses anything that is not an absolute path, connecting nowhere
  const {probe} = require('../lib/daemon');
  const net = require('node:net');
  const saved = net.createConnection;
  let connected = 0;
  net.createConnection = (...a) => { connected += 1; return saved(...a); };
  try {
    for (const target of ['localhost:443', 'example.invalid', 443, {host: 'example.invalid', port: 443}, 'relative/sock']) {
      assert.strictEqual(await probe(target, Buffer.alloc(32, 1), 200), false, String(target));
    }
    assert.strictEqual(connected, 0);
  } finally {
    net.createConnection = saved;
  }
});

test('snippet, add and uninstall run with the network stubbed to throw', async () => {
  const user = tmp('ch-user-');
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call'); };
  try {
    const home = path.join(user, '.countinghouse');
    fs.mkdirSync(path.join(home, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), '');
    const run = async (argv, answers) => { const io = fakeIo({env: {}, homedir: user, answers}); const code = await main(argv, io); return {code, io}; };
    for (const [argv, answers] of [[['snippet', 'cursor']], [['add', 'cursor']], [['uninstall'], ['yes']]]) {
      const {code, io} = await run(argv, answers);
      assert.strictEqual(code, 0, `${argv.join(' ')}: ${io.err}`);
      assert.deepStrictEqual(io.fetches, [], argv.join(' '));
    }
  } finally {
    globalThis.fetch = saved;
    fs.rmSync(user, {recursive: true, force: true});
  }
});
