'use strict';
// Many packs in one home (plan Task 12b; spec §2, "Packs after the first
// release"; reviewer, 2026-11-12):
//   ch-local add-pack <name> --from <dir> [--unreleased-pins <file>]
//   ch-local remove-pack <name>
//   ch-local status
// No client file is touched: a client's entry runs `start`, which loads every
// installed pack.
const fs = require('node:fs');
const path = require('node:path');
const {ALLOWLIST} = require('./allowlist');
const {layout} = require('./home');
const {pickCredential} = require('./credential');
const {readRecord, writeRecord, packVersions, own, withoutHeld} = require('./record');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');
const {unpackInto, removePackage} = require('./unpack');
const {loadTarballs, credentialLines} = require('./install');

// The home's record, or null after printing why it cannot be read.
function recordOf(where, io) {
  try {
    return {record: readRecord(where)};
  } catch (err) {
    io.stderr.write(`ch-local: ${err.message}\n`);
    return null;
  }
}

async function addPack({pack, from, unreleasedPins}, io, release = ALLOWLIST) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s, code = 1) => { io.stderr.write(`ch-local: ${s}\n`); return code; };
  const spec = own(release.packs, pack) ? release.packs[pack] : null;
  if (spec == null) return fail(`the pack "${pack}" is not in this ch-local release's allowlist; one of: ${Object.keys(release.packs).join(', ')}`, 2);
  if (from == null) return fail('installing from npm arrives with the first release; pass --from <directory of tarballs>', 2);
  const eff = effectiveAllow(release, unreleasedPins, io.env);
  if (eff.problem != null) return fail(eff.problem, 2);
  const allow = eff.allow;
  const where = layout(io.env, io.homedir);
  return withLock(where, io, () => addPackLocked({pack, from, spec, eff, allow, where}, io, {say, fail}));
}

async function addPackLocked({pack, from, spec, eff, allow, where}, io, {say, fail}) {
  const got = recordOf(where, io);
  if (got == null) return 1;
  const {record} = got;
  if (record == null) return fail(`nothing is installed yet; run \`ch-local install --pack ${pack} --from <dir>\` first`);
  if (own(record.packs, pack)) { say(`the pack "${pack}" is already installed`); return 0; }
  if (!spec.packages.every((name) => allow.pins[name] != null)) return fail(`no release of the pack "${pack}" is pinned in this ch-local yet`);
  // A pack is built against its release's runtime: the pins in use must name the installed one.
  const firstPack = Object.keys(record.packs)[0] || pack;
  const reinstall = `install the newer release with \`ch-local install --pack ${firstPack} --from <its directory>\`, then add-pack ${pack}`;
  for (const name of allow.runtime.packages) {
    const installedVersion = record.runtime.versions[name];
    if (allow.pins[name] != null && installedVersion != null && allow.pins[name].version !== installedVersion) {
      return fail(`this release pins ${name} ${allow.pins[name].version}, but the installed runtime is ${installedVersion}; ${reinstall}`);
    }
  }

  const have = packVersions(record);
  const nodeModules = path.join(where.app, 'node_modules');
  const shared = [];
  const add = [];
  for (const name of spec.packages) {
    const pinned = allow.pins[name].version;
    if (have[name] != null) {
      if (have[name] !== pinned) return fail(`${name} is installed at ${have[name]}, but this release pins ${pinned} for "${pack}"; ${reinstall}`);
      shared.push(name);
    } else if (fs.existsSync(path.join(nodeModules, ...name.split('/'))) || record.runtime.versions[name] != null) {
      return fail(`${name} is in ${where.app} but no installed pack records it; run \`ch-local install\` again`);
    } else {
      add.push(name);
    }
  }
  const {problems, bytes} = loadTarballs(from, add, allow.pins);
  if (problems.length > 0) {
    for (const p of problems) fail(p);
    return fail('nothing was added');
  }
  try {
    unpackInto(nodeModules, bytes, add, allow.pins);
  } catch (err) {
    return fail(`${err.message}; nothing was added`);
  }
  const packages = Object.fromEntries(spec.packages.map((name) => [name, allow.pins[name].version]));
  const held = {...(record.held || {})};
  delete held[pack];
  writeRecord(where, {...withoutHeld(record), ...(Object.keys(held).length > 0 ? {held} : {}), packs: {...record.packs, [pack]: {packages, credentials: spec.credentials}}, unreleased: record.unreleased || eff.unreleased});
  say(`added the pack "${pack}"${shared.length > 0 ? `; it shares ${shared.join(', ')} with the packs already installed` : ''}`);
  if (record.unreleased || eff.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  credentialLines(io, say, spec.credentials);
  return 0;
}

async function removePack({pack}, io) {
  const where = layout(io.env, io.homedir);
  return withLock(where, io, () => removePackLocked({pack, where}, io));
}

async function removePackLocked({pack, where}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const got = recordOf(where, io);
  if (got == null) return 1;
  const {record} = got;
  if (record != null && !own(record.packs, pack) && record.held != null && own(record.held, pack)) {
    // Held after a rollback: nothing of it is in this release's app.
    const held = {...record.held};
    delete held[pack];
    writeRecord(where, {...withoutHeld(record), ...(Object.keys(held).length > 0 ? {held} : {})});
    say(`removed the held pack "${pack}"; nothing of it was installed under this release`);
    return 0;
  }
  if (record == null || !own(record.packs, pack)) { io.stderr.write(`ch-local: the pack "${pack}" is not installed\n`); return 1; }
  const others = Object.entries(record.packs).filter(([name]) => name !== pack);
  const keep = new Set(others.flatMap(([, p]) => Object.keys(p.packages)));
  const nodeModules = path.join(where.app, 'node_modules');
  // The record first: a package that cannot be deleted (a client holding it
  // open on Windows) is then a leftover directory, not a pack start loads.
  writeRecord(where, {...record, packs: Object.fromEntries(others)});
  const removed = [];
  const kept = [];
  const stuck = [];
  for (const name of Object.keys(record.packs[pack].packages)) {
    if (keep.has(name)) { kept.push(name); continue; }
    try {
      removePackage(nodeModules, name);
      removed.push(name);
    } catch (err) {
      stuck.push(`could not delete ${path.join(nodeModules, ...name.split('/'))} (${err.code || err.message}); is a client running it? delete it by hand, or run \`ch-local install\` again`);
    }
  }
  say(`removed the pack "${pack}"${removed.length > 0 ? `: ${removed.join(', ')}` : ''}`);
  if (kept.length > 0) say(`kept ${kept.join(', ')}: another installed pack calls ${kept.length === 1 ? 'it' : 'them'}`);
  for (const s of stuck) io.stderr.write(`ch-local: ${s}\n`);
  return stuck.length > 0 ? 1 : 0;
}

// A scenario's tools: its listed actions (those with a description), by name.
function toolsOf(dir) {
  let api;
  try { api = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8')); } catch (err) { return []; }
  const services = api != null && api.device != null && api.device.serviceList != null && typeof api.device.serviceList === 'object' ? Object.values(api.device.serviceList) : [];
  return services.flatMap((s) => (s != null && Array.isArray(s.actionList) ? s.actionList : []))
    .filter((a) => a != null && typeof a.name === 'string' && typeof a.description === 'string' && a.description.trim() !== '')
    .map((a) => a.name);
}

async function status(_, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  const got = recordOf(where, io);
  if (got == null) return 1;
  const {record} = got;
  if (record == null) { say('nothing is installed; run `ch-local install --pack <name> --from <dir>`'); return 1; }
  if (record.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  const names = Object.keys(record.packs);
  if (names.length === 0 && record.held == null) say('no pack is installed; add one with `ch-local add-pack <name> --from <dir>`');
  for (const name of names) {
    const p = record.packs[name];
    const scenario = Object.keys(p.packages)[0];
    say(`${name} ${p.packages[scenario]}`);
    const tools = toolsOf(path.join(where.app, 'node_modules', ...scenario.split('/')));
    say(`  tools: ${tools.length > 0 ? tools.join(', ') : '(none found: run `ch-local install` again)'}`);
    const chosen = pickCredential(io.env, p.credentials);
    // The same rule as start's loadablePacks: no credential needed, or one set.
    if (p.credentials.length === 0) say('  credential: none needed');
    else say(chosen != null ? `  credential: ${chosen.name}` : `  not loaded: set ${p.credentials.join(' or ')} in the environment your client starts from`);
  }
  for (const [name, h] of Object.entries(record.held || {})) say(`${name}: installed under ch-local ${h.installedUnder}; this release does not have it, so it is not loaded`);
  return 0;
}

module.exports = {addPack, removePack, status, toolsOf};
