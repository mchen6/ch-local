'use strict';
require('./tmp-dirs');
// lib/npm-release.js (docs/development/auto-upgrade.md, "The trust chain",
// steps 2-7): a release's packages fetched from the registry, each checked
// against its pin and its provenance, ch-local's own by its provenance alone,
// and written to a release directory for install's loadTarballs; the runtime
// lockfile with ch-local's entry filled from its verified digest. Against a
// fake registry and the test root, offline.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fakeRegistry, sri} = require('./fake-registry');
const {testRoot} = require('./sigstore-fixture');
const provenance = require('../lib/provenance');
const {parseReleasePins} = require('../lib/release-pins');
const {fetchRelease, fillLockfile} = require('../lib/npm-release');
const {tarballName} = require('../lib/unpack');

const SELF = '@countinghouse/ch-local';
const io = {env: {}, fetch: (url, opts) => globalThis.fetch(url, opts)};
const root = testRoot();
const trust = provenance.trustMaterial(root.trustedRoot, root.npmKeys);
const at = new Date(Date.now() - 100 * 3600e3);
const hex = (bytes) => crypto.createHash('sha512').update(bytes).digest('hex');
const ids = {'countinghouse': [3000001, 2000002], '@countinghouse/ch-pack-ci-failure-triage': [3000002, 2000002]};
const repoOf = (name) => `mchen6/${name.split('/').pop()}`;

// a release whose pins name countinghouse and the triage pack's scenario,
// each published to `reg` with its provenance; ch-local at `selfVersion`
async function world({selfVersion = '0.4.0', lie = {}} = {}) {
  const reg = await fakeRegistry();
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
  // (version 2: a pack lists its modules, and each is described)
  shipped.packs['ci-failure-triage'].modules = ['@countinghouse/ch-pack-ci-failure-triage'];
  shipped.modules = {'@countinghouse/ch-pack-ci-failure-triage': {role: null, credentials: [], calls: [], confirmSettings: {}}};
  const publish = (name, version, identity) => {
    const bytes = Buffer.from(`the ${name}@${version} tarball`);
    const integrity = reg.publish(name, version, bytes);
    const prov = root.provenance(name, version, lie[name] === 'digest' ? hex(Buffer.from('other')) : hex(bytes), identity, at);
    reg.attest(name, version, lie[name] === 'none' ? {attestations: []} : {attestations: [{predicateType: provenance.PROVENANCE, bundle: prov},
      {predicateType: provenance.PUBLISH, bundle: root.publish(name, version, hex(bytes), at)}]});
    return integrity;
  };
  for (const name of ['countinghouse', '@countinghouse/ch-pack-ci-failure-triage']) {
    const identity = {repository: repoOf(name), repositoryId: ids[name][0], ownerId: ids[name][1], workflow: '.github/workflows/publish.yml', tag: 'v1.2.3'};
    shipped.pins[name] = Object.assign({version: '1.2.3', integrity: publish(name, '1.2.3', identity)}, identity);
  }
  const self = Object.assign({}, shipped.self, {tag: `v${selfVersion}`});
  const selfIntegrity = publish(SELF, selfVersion, lie[SELF] === 'repo' ? Object.assign({}, self, {repository: 'someone/ch-local'}) : self);
  shipped.runtime.lockfile = {name: 'countinghouse-home-app', lockfileVersion: 3, requires: true, packages: {
    '': {name: 'countinghouse-home-app'},
    [`node_modules/${SELF}`]: {version: selfVersion, resolved: `file:tarballs/${tarballName(SELF, selfVersion)}`},
    'node_modules/countinghouse': {version: '1.2.3', resolved: 'file:tarballs/countinghouse-1.2.3.tgz', integrity: shipped.pins.countinghouse.integrity},
    'node_modules/ajv': {version: '8.17.1', resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz', integrity: `sha512-${'B'.repeat(86)}==`}
  }};
  const data = parseReleasePins(shipped);
  assert.strictEqual(data.problem, undefined, data.problem);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rel-'));
  return {reg, data: data.pins, dir, selfVersion, selfIntegrity, close: async() => { await reg.close(); fs.rmSync(dir, {recursive: true, force: true}); }};
}
const names = [SELF, 'countinghouse', '@countinghouse/ch-pack-ci-failure-triage'];
const codeOf = async(p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };

test('a release: every package fetched, checked and written; ch-local pinned by its verified digest; the lockfile\'s ch-local entry filled', async() => {
  const w = await world();
  try {
    const r = await fetchRelease({data: w.data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust});
    assert.deepStrictEqual(fs.readdirSync(w.dir).sort(), names.map((n) => tarballName(n, n === SELF ? w.selfVersion : '1.2.3')).sort());
    assert.strictEqual(r.pins[SELF].integrity, w.selfIntegrity);
    assert.deepStrictEqual(Object.keys(r.pins[SELF]).sort(), ['integrity', 'ownerId', 'repository', 'repositoryId', 'tag', 'version', 'workflow']);
    assert.strictEqual(r.pins[SELF].tag, `v${w.selfVersion}`);
    assert.strictEqual(r.lockfile.packages[`node_modules/${SELF}`].integrity, w.selfIntegrity, 'filled from the verified digest');
    assert.strictEqual(w.data.runtime.lockfile.packages[`node_modules/${SELF}`].integrity, undefined, 'the release\'s own data untouched');
    for (const n of names) assert.strictEqual(r.published[n].getTime(), Math.floor(at.getTime() / 1000) * 1000, n);
    for (const n of names) {
      const file = path.join(w.dir, tarballName(n, n === SELF ? w.selfVersion : '1.2.3'));
      assert.strictEqual(sri(fs.readFileSync(file)), r.pins[n].integrity, `${n}: the bytes written are the ones checked`);
    }
  } finally {
    await w.close();
  }
});

test('one package that fails its provenance, or has none, fails the release, naming it, and nothing is written', async() => {
  for (const [name, lie, code] of [['countinghouse', 'digest', 'PROVENANCE_IDENTITY'], ['@countinghouse/ch-pack-ci-failure-triage', 'none', 'NO_PROVENANCE'], [SELF, 'repo', 'PROVENANCE_IDENTITY']]) {
    const w = await world({lie: {[name]: lie}});
    try {
      let err = null;
      try { await fetchRelease({data: w.data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust}); } catch (e) { err = e; }
      assert.ok(err != null, name);
      assert.strictEqual(err.code, code, name);
      assert.strictEqual(err.package, name);
      assert.deepStrictEqual(fs.readdirSync(w.dir), [], `${name}: nothing written`);
    } finally {
      await w.close();
    }
  }
});

test('a lockfile entry without integrity fails the release before anything is written; a pack alone needs no lockfile', async() => {
  const w = await world();
  try {
    const data = JSON.parse(JSON.stringify(w.data));
    delete data.runtime.lockfile.packages['node_modules/ajv'].integrity;
    let err = null;
    try { await fetchRelease({data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust}); } catch (e) { err = e; }
    assert.strictEqual(err && err.code, 'LOCKFILE_INTEGRITY');
    assert.deepStrictEqual(fs.readdirSync(w.dir), [], 'nothing written');
    const packOnly = await fetchRelease({data: w.data, version: w.selfVersion, names: ['@countinghouse/ch-pack-ci-failure-triage'], dir: w.dir, io, registry: w.reg.url, trust});
    assert.strictEqual(packOnly.lockfile, null);
  } finally {
    await w.close();
  }
});

test('ch-local\'s version must be strict MAJOR.MINOR.PATCH, before anything is fetched', async() => {
  const w = await world();
  try {
    for (const v of ['0.4.0-rc.1', '0.4', 'v0.4.0', '00.4.0']) {
      assert.strictEqual(await codeOf(fetchRelease({data: w.data, version: v, names, dir: w.dir, io, registry: w.reg.url, trust})), 'NOT_STRICT', v);
    }
    assert.deepStrictEqual(w.reg.requests, []);
  } finally {
    await w.close();
  }
});

test('an upgrade\'s verified ch-local: its bytes installed as given, under the installed self, never fetched again (the review of #42, 4)', async() => {
  const w = await world();
  try {
    const bytes = Buffer.from(`the ${SELF}@${w.selfVersion} tarball`);
    const integrity = sri(bytes);
    const publishedAt = new Date(at.getTime() - 3600e3);
    const r = await fetchRelease({data: w.data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust,
      verifiedSelf: {version: w.selfVersion, bytes, integrity, publishedAt, identity: w.data.self}});
    assert.ok(!w.reg.requests.some((u) => u.includes('ch-local')), 'ch-local not fetched again');
    assert.strictEqual(r.pins[SELF].integrity, integrity);
    assert.strictEqual(r.published[SELF], publishedAt);
    assert.ok(fs.readFileSync(path.join(w.dir, tarballName(SELF, w.selfVersion))).equals(bytes), 'the same bytes written');
    // bytes that are not what it says, or for another version: refused
    const w2 = await world();
    try {
      assert.strictEqual(await codeOf(fetchRelease({data: w2.data, version: w2.selfVersion, names, dir: w2.dir, io, registry: w2.reg.url, trust,
        verifiedSelf: {version: w2.selfVersion, bytes: Buffer.from('other'), integrity, publishedAt, identity: w2.data.self}})), 'INTEGRITY_MISMATCH');
      assert.strictEqual(await codeOf(fetchRelease({data: w2.data, version: w2.selfVersion, names, dir: w2.dir, io, registry: w2.reg.url, trust,
        verifiedSelf: {version: '9.9.9', bytes, integrity, publishedAt, identity: w2.data.self}})), 'SELF_MISMATCH');
    } finally {
      await w2.close();
    }
  } finally {
    await w.close();
  }
});

test('a package no pin names (other than ch-local) is refused before anything is fetched', async() => {
  const w = await world();
  try {
    assert.strictEqual(await codeOf(fetchRelease({data: w.data, version: w.selfVersion, names: [...names, '@countinghouse/ch-step-redact'], dir: w.dir, io, registry: w.reg.url, trust})), 'NOT_PINNED');
    assert.deepStrictEqual(w.reg.requests, []);
  } finally {
    await w.close();
  }
});

test('the lockfile: ch-local\'s entry filled from its verified digest, then held to the shared rules (lib/lockfile-rules.js)', () => {
  const SHA = `sha512-${'C'.repeat(86)}==`;
  const pins = {[SELF]: {version: '0.4.0', integrity: SHA}, countinghouse: {version: '1.2.3', integrity: `sha512-${'D'.repeat(86)}==`}};
  const lock = {lockfileVersion: 3, packages: {'': {}, [`node_modules/${SELF}`]: {version: '0.4.0', resolved: `file:tarballs/${tarballName(SELF, '0.4.0')}`},
    'node_modules/countinghouse': {version: '1.2.3', resolved: 'file:tarballs/countinghouse-1.2.3.tgz', integrity: pins.countinghouse.integrity},
    'node_modules/a': {version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: SHA}}};
  const filled = fillLockfile(lock, SHA, {pins});
  assert.strictEqual(filled.packages[`node_modules/${SELF}`].integrity, SHA);
  assert.strictEqual(lock.packages[`node_modules/${SELF}`].integrity, undefined, 'a copy');
  const missing = JSON.parse(JSON.stringify(lock));
  delete missing.packages['node_modules/a'].integrity;
  assert.throws(() => fillLockfile(missing, SHA, {pins}), (e) => e.code === 'LOCKFILE_INTEGRITY' && /node_modules\/a/.test(e.message));
  const noSelf = JSON.parse(JSON.stringify(lock));
  delete noSelf.packages[`node_modules/${SELF}`];
  assert.throws(() => fillLockfile(noSelf, SHA, {pins}), (e) => e.code === 'LOCKFILE_INTEGRITY' && /ch-local/.test(e.message));
  assert.strictEqual(fillLockfile(null, SHA, {pins}), null, 'no lockfile yet (before the first release)');
});

// the review of #41, for the callers ----------------------------------------

test('no lib/ code names `trust` or `registry` but the three that take them; install passes on only its test-only fromNpm, exactly so', () => {
  const lib = path.join(__dirname, '..', 'lib');
  // code only: comments and strings set nothing
  // code only: comments, strings and template text set nothing (test/code-only.js)
  const code = (f) => require('./code-only').codeOnly(fs.readFileSync(path.join(lib, f), 'utf8'));
  const allowed = new Set(['npm-fetch.js', 'npm-release.js', 'provenance.js', 'npm-upgrade.js']);
  const found = [];
  for (const f of fs.readdirSync(lib).filter((x) => x.endsWith('.js') && !allowed.has(x))) {
    // any identifier, shorthand and destructuring included (the review of #42)
    for (const m of code(f).matchAll(/\b(trust|registry)\b/g)) found.push(`${f}: ${m[1]}`);
  }
  assert.deepStrictEqual(found, [], `named outside the three: ${found.join(', ')}`);
  // the three set them only as signature defaults, or pass on what they took
  for (const f of allowed) {
    assert.doesNotMatch(code(f), /[{,]\s*(trust|registry)\s*:(?!\s*(?:null|REGISTRY|npmFetch\.REGISTRY|trust|registry)\b)/, `${f} sets trust or registry to something of its own`);
  }
  // and inside the three: no environment read, and trust and registry
  // assigned only their defaults (a signature's `registry = REGISTRY`)
  for (const f of allowed) {
    const src = code(f);
    assert.doesNotMatch(src, /\b(io|process)\.env\b/, `${f} reads the environment`);
    assert.doesNotMatch(src, /\b(trust|registry)\s*=(?!=)(?!\s*(?:null|REGISTRY|npmFetch\.REGISTRY)\b)/, `${f} assigns trust or registry`);
  }
  // install: fromNpm in its signature and its one pass-on, verbatim, and nowhere else
  const install = fs.readFileSync(path.join(lib, 'install.js'), 'utf8');
  const lines = install.split('\n').filter((l) => /fromNpm/.test(l) && !/^\s*\/\//.test(l)).map((l) => l.trim());
  assert.deepStrictEqual(lines, [
    'async function install({pack, from, unreleasedPins, runtimeOnly = false, judged = null}, io, release = ALLOWLIST, fromNpm = {}) {',
    'version: allow.release.version, names, dir: path.join(fetched, \'release\'), io, verifiedSelf: allow.verifiedSelf || null, ...fromNpm});',
    // (the shim, fetched and verified before the lock: B-shim-allow)
    'if (allow.shim != null) shimReady = await require(\'./shim-install\').prepareShim({data: {shim: allow.shim, pins: allow.pins}, record: home0.record, home: where0.home, io, ...fromNpm});'
  ]);
  // upgrade: likewise, its signature and its two pass-ons
  const upgrade = fs.readFileSync(path.join(lib, 'upgrade.js'), 'utf8');
  assert.deepStrictEqual(upgrade.split('\n').filter((l) => /fromNpm/.test(l) && !/^\s*\/\//.test(l)).map((l) => l.trim()), [
    // (its own --check rides on this same signature: A-own-skill's easy upgrades)
    'async function upgrade({auto, check = false}, io, fromNpm = {}) {',
    'found = await findUpgrade({data, now, installed: from, packs, io, allowMajor: true, ...fromNpm});',
    'const code = await require(\'./install\').install({...target, judged: judgedDigest(record)}, io, allow, fromNpm);'
  ]);
});

// the re-check of #42: the scan covers bin/ too, and install's test-only
// arguments are never passed: every install( call has exactly two arguments
// (a fourth from bin/ or another lib/ file, say from io.env, would choose
// the registry or the trust)
const topLevelArgs = (code, open) => {
  // code[open] is '(' -> the number of top-level arguments to its ')'
  let depth = 0; let args = 0; let any = false;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { depth++; if (depth > 1) any = true; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return any ? args + 1 : 0; continue; }
    if (depth === 1 && c === ',') { args++; continue; }
    if (depth >= 1 && !/\s/.test(c)) any = true;
  }
  return -1;
};

test('bin/ and lib/: no code names `trust` or `registry` outside the three, and every install( call has exactly two arguments', () => {
  const root = path.join(__dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ...fs.readdirSync(path.join(root, 'bin')).filter((f) => f.endsWith('.js')).map((f) => `bin/${f}`)];
  const code = (f) => require('./code-only').codeOnly(fs.readFileSync(path.join(root, f), 'utf8'));
  const three = new Set(['lib/npm-fetch.js', 'lib/npm-release.js', 'lib/provenance.js', 'lib/npm-upgrade.js']);
  const named = [];
  const calls = [];
  for (const f of files) {
    const src = code(f);
    if (!three.has(f)) for (const m of src.matchAll(/\b(trust|registry)\b/g)) named.push(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/\b(install|upgrade|autoApply)\s*\(/g)) {
      if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index)).trim();
      calls.push([f, m[1], topLevelArgs(src, m.index + m[0].length - 1), line]);
    }
    // (lib/npm.js's fromNpm is npm's own path, npm_execpath: another thing)
    if (!['lib/install.js', 'lib/upgrade.js', 'lib/auto-apply.js', 'lib/shim-install.js', 'lib/npm.js'].includes(f)) assert.doesNotMatch(src, /\bfromNpm\b/, `${f} names fromNpm`);
  }
  assert.deepStrictEqual(named, [], `named outside the three: ${named.join(', ')}`);
  assert.ok(calls.some(([f, fn]) => f === 'bin/ch-local.js' && fn === 'install'), 'bin/ch-local.js calls install');
  // install( with two arguments, but for upgrade's and the automatic
  // upgrade's own calls, verbatim: the verified release's allow, and their
  // own test-only fromNpm (pinned by the scan above); upgrade( with two, and
  // autoApply( with {io} alone, so nothing passes theirs on
  // (the automatic upgrade's install says nothing of its own: its io is a quiet copy)
  // (target: {pack} or, for a release that withdraws the pack, {runtimeOnly: true})
  const passOn = {'lib/upgrade.js': 'const code = await require(\'\').install({...target, judged: judgedDigest(record)}, io, allow, fromNpm);',
    'lib/auto-apply.js': 'const code = await require(\'\').install({...target, judged: judgedDigest(record)}, quiet, allow, fromNpm);'};
  const odd = calls.filter(([f, fn, n, line]) => {
    if (fn === 'install') return !(n === 2 || passOn[f] === line);
    if (fn === 'upgrade') return n !== 2;
    return !/autoApply\(\{io\}\)/.test(line);
  });
  assert.deepStrictEqual(odd, [], 'a call that could pass a test-only argument');
  assert.deepStrictEqual(calls.filter(([f, fn]) => fn !== 'install' || f !== 'bin/ch-local.js').map(([f, fn]) => `${f} ${fn}`).sort(),
    ['bin/ch-local.js autoApply', 'bin/ch-local.js upgrade', 'lib/auto-apply.js install', 'lib/upgrade.js install']);
  // the counter itself
  assert.deepStrictEqual(['f()', 'f(a)', 'f({a, b}, io)', 'f(a, io, undefined, JSON.parse(io.env.X))', 'f({x: [1, 2]}, g(h, i))'].map((s) => topLevelArgs(s, 1)), [0, 1, 2, 4, 2]);
});

test('install and upgrade reach provenance only through verifyRelease (refs/tags/v<version>): no lib/ code but provenance.js names verifyAttestations', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const callers = fs.readdirSync(lib).filter((f) => f.endsWith('.js') && f !== 'provenance.js')
    .filter((f) => /verifyAttestations/.test(fs.readFileSync(path.join(lib, f), 'utf8')));
  assert.deepStrictEqual(callers, []);
  assert.match(fs.readFileSync(path.join(lib, 'npm-release.js'), 'utf8'), /provenance\.verifyRelease\(/);
});

test('a bundled lockfile entry its parent does not bundle fails the release (the review of #42; the rules: test/lockfile-rules.test.js)', () => {
  const SHA = `sha512-${'C'.repeat(86)}==`;
  const pins = {[SELF]: {version: '0.4.0', integrity: SHA}, countinghouse: {version: '1.2.3', integrity: SHA}};
  const lock = {lockfileVersion: 3, packages: {'': {}, [`node_modules/${SELF}`]: {version: '0.4.0', resolved: `file:tarballs/${tarballName(SELF, '0.4.0')}`},
    'node_modules/countinghouse': {version: '1.2.3', resolved: 'file:tarballs/countinghouse-1.2.3.tgz', integrity: SHA},
    'node_modules/countinghouse/node_modules/evil': {version: '6.6.6', inBundle: true}}};
  assert.throws(() => fillLockfile(lock, SHA, {pins}), (e) => e.code === 'LOCKFILE_INTEGRITY' && /evil/.test(e.message));
});
