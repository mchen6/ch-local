'use strict';
// ch-local install --pack <name> --from <dir> (spec §2, "Install at exact
// versions"): the pack's allowlisted tarballs, each checked against its pinned
// version and integrity, into <home>/app as an npm project with a lockfile,
// by `npm ci --omit=optional`. The new app is built beside the old one and
// replaces it only when it is complete; then <home>/bin/ch-local.js runs it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {ALLOWLIST} = require('./allowlist');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {npm} = require('./npm');
const {pickCredential} = require('./credential');

const SELF = require('../package.json').name;
const NPM_FLAGS = ['--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'];

// npm pack's file name: @scope/name@1.2.3 -> scope-name-1.2.3.tgz
const tarballName = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
const integrityOf = (file) => 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

// Every problem with the directory, or [] when it holds exactly the pinned tarballs.
function checkTarballs(from, packages, pins) {
  let files;
  try {
    files = fs.readdirSync(from).filter((f) => f.endsWith('.tgz'));
  } catch (err) {
    return [`cannot read ${from} (${err.code})`];
  }
  const wanted = new Map(packages.map((name) => [tarballName(name, pins[name].version), name]));
  const problems = files.filter((f) => !wanted.has(f)).map((f) => `${f} is not on this launcher's allowlist`);
  for (const [file, name] of wanted) {
    const at = `${name}@${pins[name].version}`;
    if (!files.includes(file)) problems.push(`${at}: no ${file} in ${from}`);
    else if (integrityOf(path.join(from, file)) !== pins[name].integrity) problems.push(`${at}: the tarball's integrity is not the pinned one`);
  }
  return problems;
}

const shim = (installedBin) => `#!/usr/bin/env node
'use strict';
// Written by \`ch-local install\`: runs the installed launcher. Every install
// writes it again; edits are lost.
require(${JSON.stringify(installedBin)}).run();
`;

async function install({pack, from}, io, allow = ALLOWLIST) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const spec = Object.prototype.hasOwnProperty.call(allow.packs, pack) ? allow.packs[pack] : null;
  if (spec == null) { fail(`unknown pack "${pack}"; one of: ${Object.keys(allow.packs).join(', ')}`); return 2; }
  if (from == null) { fail('installing from npm arrives with the first release; pass --from <directory of tarballs>'); return 2; }
  if (!spec.packages.every((name) => allow.pins[name] != null)) { fail(`no release of the pack "${pack}" is pinned in this ch-local yet`); return 1; }

  const problems = checkTarballs(from, spec.packages, allow.pins);
  if (problems.length > 0) {
    for (const p of problems) fail(p);
    fail('nothing was installed');
    return 1;
  }

  const where = layout(io.env, io.homedir);
  const build = `${where.app}.new`;
  const old = `${where.app}.old`;
  const files = Object.fromEntries(spec.packages.map((name) => [name, tarballName(name, allow.pins[name].version)]));
  const versions = Object.fromEntries(spec.packages.map((name) => [name, allow.pins[name].version]));
  fs.rmSync(build, {recursive: true, force: true});
  try {
    fs.mkdirSync(path.join(build, 'tarballs'), {recursive: true});
    for (const file of Object.values(files)) fs.copyFileSync(path.join(from, file), path.join(build, 'tarballs', file));
    fs.writeFileSync(path.join(build, 'package.json'), JSON.stringify({
      name: 'countinghouse-home-app',
      private: true,
      dependencies: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, `file:tarballs/${file}`])),
      chLocal: {pack, versions}
    }, null, 2) + '\n');
    for (const [step, args] of [['install --package-lock-only', ['install', '--package-lock-only', ...NPM_FLAGS]], ['ci', ['ci', ...NPM_FLAGS]]]) {
      say(`npm ${step} in ${build}`);
      const r = await npm(io, args, build);
      if (r.status !== 0) {
        fail(`npm ${step} failed (exit ${r.status}); the previous install, if any, is unchanged`);
        if (r.stderr) io.stderr.write(String(r.stderr).split('\n').slice(-20).join('\n') + '\n');
        return 1;
      }
    }
    const installed = path.join(build, 'node_modules', ...SELF.split('/'));
    const got = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
    if (got !== versions[SELF]) { fail(`the installed ${SELF} is ${got}, not the pinned ${versions[SELF]}; nothing was installed`); return 1; }
    // The swap: the old app moves aside, the new one takes its place.
    fs.rmSync(old, {recursive: true, force: true});
    if (fs.existsSync(where.app)) fs.renameSync(where.app, old);
    fs.renameSync(build, where.app);
    fs.rmSync(old, {recursive: true, force: true});
  } finally {
    fs.rmSync(build, {recursive: true, force: true});
  }
  writeAtomic(where.launcher, shim(path.join(where.app, 'node_modules', ...SELF.split('/'), 'bin', 'ch-local.js')));
  writeAtomic(where.installed, JSON.stringify({pack, versions, credentials: spec.credentials, at: new Date().toISOString()}, null, 2) + '\n');
  say(`installed the pack "${pack}" into ${where.app}; clients run ${where.launcher}`);
  for (const name of spec.credentials) say(`${name} is ${pickCredential(io.env, [name]) != null ? 'set' : 'not set'}`);
  const chosen = pickCredential(io.env, spec.credentials);
  say(chosen != null ? `start will use ${chosen.name}` : `set ${spec.credentials.join(' or ')} in the environment your client starts from`);
  return 0;
}

module.exports = {install, tarballName, checkTarballs};
