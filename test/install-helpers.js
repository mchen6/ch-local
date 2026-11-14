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
const GITHUB_REMOTE = {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};
// name -> [version, countinghouse block, extra manifest fields]
const PACKAGES = {
  '@countinghouse/ch-pack-ci-failure-triage': ['0.1.0', {role: 'scenario', calls: ['ch-access-github/githubService.listRuns', 'ch-step-redact/redactService.redact']}],
  '@countinghouse/ch-access-github': ['0.1.0', {role: 'part', remotes: [GITHUB_REMOTE]}],
  '@countinghouse/ch-step-redact': ['0.1.0', {role: 'part'}],
  '@countinghouse/ch-pack-other': ['0.3.0', {role: 'scenario', calls: ['ch-step-redact/redactService.redact', 'ch-step-other/otherService.go']}],
  '@countinghouse/ch-step-other': ['0.2.0', {role: 'part'}]
};
const api = (tool) => JSON.stringify({device: {friendlyName: tool, serviceList: {'urn:x:serviceID:s': {actionList: [{name: tool, description: `the ${tool} tool`}, {name: 'hidden'}]}}}});

function release({versions = {}, extra = {}} = {}) {
  const from = tmp('ch-release-');
  const pins = {};
  for (const [name, version] of RUNTIME) {
    const bytes = Buffer.from(`fake tarball of ${name}@${version}`);
    fs.writeFileSync(path.join(from, tarballName(name, version)), bytes);
    pins[name] = {version, integrity: integrityOf(bytes)};
  }
  for (const [name, [v, countinghouse]] of Object.entries(PACKAGES)) {
    const version = versions[name] || v;
    const tool = name === '@countinghouse/ch-pack-ci-failure-triage' ? 'ci_failure_triage' : name.split('/')[1].replace(/-/g, '_');
    const bytes = packageTgz({name, version, countinghouse, ...(extra[name] || {})}, {'api.json': api(tool), 'lib/index.js': `// ${name}\n`});
    fs.writeFileSync(path.join(from, tarballName(name, version)), bytes);
    pins[name] = {version, integrity: integrityOf(bytes)};
  }
  // The shape npm writes: the runtime from its tarballs, a dependency from the registry.
  const lockfile = {name: 'countinghouse-home-app', lockfileVersion: 3, requires: true, packages: {'': {},
    ...Object.fromEntries(RUNTIME.map(([n, v]) => [`node_modules/${n}`, {version: v, resolved: `file:tarballs/${tarballName(n, v)}`}])),
    'node_modules/left-pad': {version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: pins.countinghouse.integrity}}};
  const allow = {
    runtime: {packages: RUNTIME.map(([n]) => n), lockfile},
    packs: {
      'ci-failure-triage': {packages: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'], credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']},
      other: {packages: ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-redact', '@countinghouse/ch-step-other'], credentials: ['OTHER_TOKEN']}
    },
    pins
  };
  return {from, allow, pins, lockfile};
}

// npm as the stub sees it: ci installs the launcher at the given version.
const npm = (version = '0.2.0') => (cmd, args, {cwd}) => {
  if (args.includes('ci')) {
    const dir = path.join(cwd, 'node_modules', '@countinghouse', 'ch-local');
    fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: '@countinghouse/ch-local', version}));
    fs.writeFileSync(path.join(dir, 'bin', 'ch-local.js'), '');
  }
  return {status: 0, stdout: '', stderr: ''};
};

const record = (home) => JSON.parse(fs.readFileSync(path.join(home, 'packs.json'), 'utf8'));
// A package's directory: in the tree of the recorded pack that has it
// (<home>/packs/<pack>/<version>/node_modules; packs in place, part 2), the
// first such pack unless `pack` is named; in the flat app when no recorded
// pack has it (what a test checks is gone).
const pkgDir = (home, name, pack = null) => {
  let rec = null;
  try { rec = record(home); } catch (e) { rec = null; }
  const packs = (rec != null) ? rec.packs : {};
  const owner = pack != null ? pack : Object.keys(packs).find((p) => packs[p].packages[name] != null);
  if (owner == null || packs[owner] == null) return path.join(home, 'app', 'node_modules', ...name.split('/'));
  return path.join(home, 'packs', owner, require('../lib/pack-dir').packKey(packs[owner].packages), 'node_modules', ...name.split('/'));
};

module.exports = {release, npm, pkgDir, record, integrityOf, RUNTIME, PACKAGES};
