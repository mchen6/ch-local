'use strict';
// ch-local install --pack <name> --from <dir> [--unreleased-pins <file>]
// (spec §2, "Install at exact versions"; reviewer, 2026-11-12): every tarball
// is checked against its pinned version and integrity first. Then:
// - the runtime (this launcher and countinghouse) goes into <home>/app as an
//   npm project with its pinned lockfile, by `npm ci --omit=optional`, which
//   checks every dependency against that lockfile too;
// - the pack's dependency-free packages are unpacked beside it (lib/unpack.js).
// The new app is built beside the old one and replaces it only when it is
// complete; then <home>/bin/ch-local.js runs it and <home>/packs.json records
// it. An install replaces the whole app: other packs the home held are
// dropped, and install names them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {ALLOWLIST} = require('./allowlist');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {npm} = require('./npm');
const {pickCredential} = require('./credential');
const {unpackInto, tarballName} = require('./unpack');
const {readRecord, writeRecord, own, withoutHeld} = require('./record');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');

const SELF = require('../package.json').name;
const NPM_FLAGS = ['--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'];

const integrityOf = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

// The tarballs for `packages`, each read once: {problems, bytes}. Only
// bytes whose integrity is the pinned one are returned, and those same bytes
// are what is unpacked or handed to npm (reviewer, 2026-11-12), so a file
// changed after the check is never installed. A tarball no pin names is a
// problem; another pinned package's tarball (a release directory holds every
// pack) is not.
function loadTarballs(from, packages, pins) {
  let files;
  try {
    files = fs.readdirSync(from).filter((f) => f.endsWith('.tgz'));
  } catch (err) {
    return {problems: [`cannot read ${from} (${err.code})`], bytes: {}};
  }
  const known = new Set(Object.entries(pins).map(([name, pin]) => tarballName(name, pin.version)));
  const problems = files.filter((f) => !known.has(f)).map((f) => `${f} is not on this launcher's allowlist`);
  const bytes = {};
  for (const name of packages) {
    const file = tarballName(name, pins[name].version);
    const at = `${name}@${pins[name].version}`;
    if (!files.includes(file)) { problems.push(`${at}: no ${file} in ${from}`); continue; }
    let buf;
    try {
      buf = fs.readFileSync(path.join(from, file));
    } catch (err) {
      problems.push(`${at}: cannot read ${file} (${err.code || err.message})`);
      continue;
    }
    if (integrityOf(buf) !== pins[name].integrity) problems.push(`${at}: the tarball's integrity is not the pinned one`);
    else bytes[name] = buf;
  }
  return {problems, bytes};
}

// The app's package.json: each runtime tarball as a file: dependency. A
// release generates the runtime's lockfile from exactly this.
function appManifest(runtime, pins) {
  return {
    name: 'countinghouse-home-app',
    private: true,
    dependencies: Object.fromEntries(runtime.packages.map((name) => [name, `file:tarballs/${tarballName(name, pins[name].version)}`])),
    chLocal: {runtime: Object.fromEntries(runtime.packages.map((name) => [name, pins[name].version]))}
  };
}

const shim = (installedBin) => `#!/usr/bin/env node
'use strict';
// Written by \`ch-local install\`: runs the installed launcher. Every install
// writes it again; edits are lost.
require(${JSON.stringify(installedBin)}).run();
`;

function credentialLines(io, say, credentials) {
  for (const name of credentials) say(`${name} is ${pickCredential(io.env, [name]) != null ? 'set' : 'not set'}`);
  const chosen = pickCredential(io.env, credentials);
  say(chosen != null ? `start will use ${chosen.name}` : `set ${credentials.join(' or ')} in the environment your client starts from`);
}

async function install({pack, from, unreleasedPins}, io, release = ALLOWLIST) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const spec = own(release.packs, pack) ? release.packs[pack] : null;
  if (spec == null) { fail(`unknown pack "${pack}"; one of: ${Object.keys(release.packs).join(', ')}`); return 2; }
  if (from == null) { fail('installing from npm arrives with the first release; pass --from <directory of tarballs>'); return 2; }
  const eff = effectiveAllow(release, unreleasedPins, io.env);
  if (eff.problem != null) { fail(eff.problem); return 2; }
  const allow = eff.allow;
  const names = [...allow.runtime.packages, ...spec.packages];
  if (!names.every((name) => allow.pins[name] != null)) { fail(`no release of the pack "${pack}" is pinned in this ch-local yet`); return 1; }
  if (allow.runtime.lockfile == null) { fail('no lockfile is pinned for the runtime: its dependencies would be unpinned'); return 1; }

  const {problems, bytes} = loadTarballs(from, names, allow.pins);
  if (problems.length > 0) {
    for (const p of problems) fail(p);
    fail('nothing was installed');
    return 1;
  }

  const where = layout(io.env, io.homedir);
  // The home is install's to create; the lock only guards it.
  fs.mkdirSync(where.home, {recursive: true});
  return withLock(where, io, () => installLocked({pack, spec, eff, allow, bytes, where}, io, {say, fail}));
}

async function installLocked({pack, spec, eff, allow, bytes, where}, io, {say, fail}) {
  let previous = null;
  try { previous = readRecord(where); } catch (err) { previous = null; }
  const build = `${where.app}.new`;
  const old = `${where.app}.old`;
  const runtimeVersions = Object.fromEntries(allow.runtime.packages.map((name) => [name, allow.pins[name].version]));
  fs.rmSync(build, {recursive: true, force: true});
  try {
    fs.mkdirSync(path.join(build, 'tarballs'), {recursive: true});
    for (const name of allow.runtime.packages) fs.writeFileSync(path.join(build, 'tarballs', tarballName(name, allow.pins[name].version)), bytes[name]);
    fs.writeFileSync(path.join(build, 'package.json'), JSON.stringify(appManifest(allow.runtime, allow.pins), null, 2) + '\n');
    fs.writeFileSync(path.join(build, 'package-lock.json'), JSON.stringify(allow.runtime.lockfile, null, 2) + '\n');
    say(`npm ci in ${build}`);
    const r = await npm(io, ['ci', ...NPM_FLAGS], build);
    if (r.status !== 0) {
      fail(`npm ci failed (exit ${r.status}); the previous install, if any, is unchanged`);
      if (r.stderr) io.stderr.write(String(r.stderr).split('\n').slice(-20).join('\n') + '\n');
      return 1;
    }
    const installed = path.join(build, 'node_modules', ...SELF.split('/'));
    const got = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
    if (got !== runtimeVersions[SELF]) { fail(`the installed ${SELF} is ${got}, not the pinned ${runtimeVersions[SELF]}; nothing was installed`); return 1; }
    try {
      unpackInto(path.join(build, 'node_modules'), bytes, spec.packages, allow.pins);
    } catch (err) {
      fail(`${err.message}; nothing was installed`);
      return 1;
    }
    // The swap: the old app moves aside, the new one takes its place; if that
    // fails (a client holding files open on Windows), the old one goes back.
    fs.rmSync(old, {recursive: true, force: true});
    const hadApp = fs.existsSync(where.app);
    const busy = (err) => { fail(`could not replace ${where.app} (${err.code || err.message}); is a client running it? the previous install is unchanged`); return 1; };
    try {
      if (hadApp) fs.renameSync(where.app, old);
    } catch (err) {
      return busy(err);
    }
    try {
      fs.renameSync(build, where.app);
    } catch (err) {
      if (hadApp) fs.renameSync(old, where.app);
      return busy(err);
    }
    // The replaced release's programs are kept, one level, for rollback
    // (<home>/previous: its app and its record). Data is never moved.
    fs.rmSync(where.previous, {recursive: true, force: true});
    if (hadApp && previous != null) {
      fs.mkdirSync(where.previous, {recursive: true});
      fs.renameSync(old, where.previousApp);
      writeRecord({packs: where.previousRecord}, withoutHeld(previous));
    }
    fs.rmSync(old, {recursive: true, force: true});
  } finally {
    fs.rmSync(build, {recursive: true, force: true});
  }
  writeAtomic(where.launcher, shim(path.join(where.app, 'node_modules', ...SELF.split('/'), 'bin', 'ch-local.js')));
  writeRecord(where, {
    runtime: {versions: runtimeVersions},
    packs: {[pack]: {packages: Object.fromEntries(spec.packages.map((name) => [name, allow.pins[name].version])), credentials: spec.credentials}},
    unreleased: eff.unreleased,
    release: allow.release != null ? allow.release : null
  });
  fs.rmSync(where.installed, {force: true});
  say(`installed the pack "${pack}" into ${where.app}; clients run ${where.launcher}`);
  for (const dropped of [...Object.keys(previous != null ? previous.packs : {}), ...Object.keys(previous != null && previous.held != null ? previous.held : {})].filter((p) => p !== pack)) {
    say(`the pack "${dropped}" was dropped; add it again with \`ch-local add-pack ${dropped}\``);
  }
  if (eff.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  credentialLines(io, say, spec.credentials);
  return 0;
}

module.exports = {install, tarballName, loadTarballs, appManifest, credentialLines};
