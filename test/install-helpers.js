'use strict';
// A release directory for tests: the runtime's tarballs (fake bytes: npm is
// stubbed) and the packs' packages as real package tarballs (they are
// unpacked), with an allowlist pinning exactly those bytes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {packageTgz} = require('./tgz');
const {tarballName} = require('../lib/install');

const integrityOf = (bytes) => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const RUNTIME = [['@countinghouse/ch-local', '0.2.0'], ['countinghouse', '8.0.0']];
// (as ch-access-github 0.2.0 declares it: the short form, its own
// GITHUB_TOKEN)
const GITHUB_REMOTE = {name: 'github', url: 'https://api.githubcopilot.com/mcp/', credential: 'GITHUB_TOKEN'};
// name -> [version, countinghouse block, extra manifest fields]
const PACKAGES = {
  '@countinghouse/ch-pack-ci-failure-triage': ['0.1.0', {role: 'scenario', calls: ['ch-access-github/githubService.listRuns', 'ch-step-redact/redactService.redact']}],
  '@countinghouse/ch-access-github': ['0.1.0', {role: 'part', remotes: [GITHUB_REMOTE]}],
  '@countinghouse/ch-step-redact': ['0.1.0', {role: 'part'}],
  '@countinghouse/ch-pack-other': ['0.3.0', {role: 'scenario', calls: ['ch-step-redact/redactService.redact', 'ch-step-other/otherService.go']}],
  '@countinghouse/ch-step-other': ['0.2.0', {role: 'part'}]
};
// friendlyName: the module's short name, which countinghouse.calls name it by
const api = (tool, friendly = tool) => JSON.stringify({device: {friendlyName: friendly, serviceList: {'urn:x:serviceID:s': {actionList: [{name: tool, description: `the ${tool} tool`}, {name: 'hidden'}]}}}});

// describe: {package: description} in place of what the release step would
// write (lib/describe-module.js over the tarball's own manifest), for a
// release whose description differs from what it ships
const {describeModule} = require('../lib/describe-module');
const describeAll = (manifests, describe) => {
  const friendly = new Map(Object.keys(manifests).map((n) => [n.replace(/^@[^/]+\//, ''), n]));
  return Object.fromEntries(Object.entries(manifests).map(([n, m]) => {
    if (Object.prototype.hasOwnProperty.call(describe, n)) return [n, describe[n]];
    const d = describeModule(m, friendly);
    if (d.problem != null) throw new Error(`the test release cannot describe ${n}: ${d.problem}`);
    return [n, d];
  }));
};

function release({versions = {}, extra = {}, describe = {}} = {}) {
  const from = tmp('ch-release-');
  const pins = {};
  const manifests = {};
  const apis = {};
  for (const [name, pinned] of RUNTIME) {
    // versions may move a runtime package too (but ch-local's own, which the
    // npm stub installs at its fixed version)
    const version = (name !== '@countinghouse/ch-local' && versions[name]) || pinned;
    const bytes = Buffer.from(`fake tarball of ${name}@${version}`);
    fs.writeFileSync(path.join(from, tarballName(name, version)), bytes);
    pins[name] = {version, integrity: integrityOf(bytes)};
  }
  for (const [name, [v, countinghouse]] of Object.entries(PACKAGES)) {
    const version = versions[name] || v;
    const tool = name === '@countinghouse/ch-pack-ci-failure-triage' ? 'ci_failure_triage' : name.split('/')[1].replace(/-/g, '_');
    manifests[name] = {name, version, countinghouse, ...(extra[name] || {})};
    apis[name] = api(tool, name.replace(/^@[^/]+\//, ''));
    const bytes = packageTgz(manifests[name], {'api.json': apis[name], 'lib/index.js': `// ${name}\n`});
    fs.writeFileSync(path.join(from, tarballName(name, version)), bytes);
    pins[name] = {version, integrity: integrityOf(bytes)};
  }
  // The shape npm writes: the runtime from its tarballs, a dependency from the registry.
  const lockfile = {name: 'countinghouse-home-app', lockfileVersion: 3, requires: true, packages: {'': {},
    // (at the versions pinned above, a moved runtime package's included)
    ...Object.fromEntries(RUNTIME.map(([n]) => [`node_modules/${n}`, {version: pins[n].version, resolved: `file:tarballs/${tarballName(n, pins[n].version)}`, integrity: pins[n].integrity}])),
    'node_modules/left-pad': {version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: pins.countinghouse.integrity}}};
  const allow = {
    runtime: {packages: RUNTIME.map(([n]) => n), lockfile},
    packs: {
      'ci-failure-triage': {modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']},
      other: {modules: ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-redact', '@countinghouse/ch-step-other']}
    },
    // what the release step writes (pins version 2: #413 section 9.3)
    modules: describeAll(manifests, describe),
    pins
  };
  return {from, allow, pins, lockfile, manifests, apis};
}

// npm as the stub sees it: ci installs the launcher at the given version,
// and a current countinghouse (one with countinghouse#195's
// lib/fs-broker/virtual-drive.js, so Windows runs like every platform; the
// older-runtime test removes it).
const npm = (version = '0.2.0') => (cmd, args, {cwd}) => {
  if (args.includes('ci')) {
    const dir = path.join(cwd, 'node_modules', '@countinghouse', 'ch-local');
    fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: '@countinghouse/ch-local', version}));
    fs.writeFileSync(path.join(dir, 'bin', 'ch-local.js'), '');
    const drive = path.join(cwd, 'node_modules', 'countinghouse', 'lib', 'fs-broker', 'virtual-drive.js');
    fs.mkdirSync(path.dirname(drive), {recursive: true});
    fs.writeFileSync(drive, 'module.exports = {};\n');
  }
  return {status: 0, stdout: '', stderr: ''};
};

const record = (home) => JSON.parse(fs.readFileSync(path.join(home, 'modules.json'), 'utf8'));
// A package's directory: in the module store at the version the record has
// active (<home>/module-store/<name>/<version>; #413 section 9.1); under the
// app when the record has no such module (what a test checks is gone).
const pkgDir = (home, name) => {
  let rec = null;
  try { rec = record(home); } catch (e) { rec = null; }
  const m = rec != null && rec.modules != null ? rec.modules[name] : null;
  if (m == null) return path.join(home, 'app', 'node_modules', ...name.split('/'));
  return path.join(home, 'module-store', ...name.split('/'), m.version);
};

// a development pins file's descriptions: the release's, of the pack
// modules pins names (what describe-release.js --unreleased-pins writes)
const devModules = (allow, pins) => Object.fromEntries(Object.entries(allow.modules).filter(([m]) => Object.prototype.hasOwnProperty.call(pins, m)));

// A home as an install of release r leaves it (L4: what an upgrade's
// additions are judged against is the home's own modules, described from
// the store): every module of the named packs at r's pins, in the store
// with r's own manifest and api.json, and the record naming them.
// -> the record's packs, as written
function installedHome(home, packs, {r = release(), runtime = {}, unreleased = false} = {}) {
  const {storeModule, writeHome} = require('./store-helpers');
  const out = {};
  for (const p of packs) {
    out[p] = {};
    for (const m of r.allow.packs[p].modules) {
      const v = r.pins[m].version;
      const {name, version, ...rest} = r.manifests[m];
      const dir = storeModule(home, m, v, {countinghouse: rest.countinghouse, files: {'api.json': r.apis[m]}});
      // (its marker names the release's own integrity, as install's does:
      // a later install never takes it for other contents)
      const marker = JSON.parse(fs.readFileSync(`${dir}.json`, 'utf8'));
      fs.writeFileSync(`${dir}.json`, JSON.stringify({...marker, integrity: r.pins[m].integrity}) + '\n');
      out[p][m] = v;
    }
  }
  writeHome(home, out, {runtime, unreleased});
  return out;
}

module.exports = {release, npm, pkgDir, record, integrityOf, devModules, installedHome, RUNTIME, PACKAGES};
