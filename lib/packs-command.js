'use strict';
const {notAllowed} = require('./ceiling');
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
const {own} = require('./record');
const {readModulesRecord, writeModulesRecord, livePacks, activeVersions} = require('./module-record');
const {placeModule, wholeAt} = require('./module-store');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');
const {collectStore, liveRuns} = require('./gc');
const {loadTarballs} = require('./install');
const plan = require('./install-plan');
const {installedPacks, withdrawnNames, withdrawnStatusLine, releaseOf} = require('./packs');

// The home's record (modules.json), or null after printing why it cannot be
// read (an earlier ch-local's packs.json: install migrates it).
function recordOf(where, io) {
  try {
    return {record: readModulesRecord(where)};
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
  // the operator's allowlist of packs (start enforces it as well)
  const unlisted = notAllowed(layout(io.env, io.homedir), pack, io, spec.packages);
  if (unlisted != null) return fail(unlisted, 2);
  if (from == null) return fail('installing from npm arrives with the first release; pass --from <directory of tarballs>', 2);
  const eff = effectiveAllow(release, unreleasedPins, io.env);
  if (eff.problem != null) return fail(eff.problem, 2);
  const allow = eff.allow;
  const where = layout(io.env, io.homedir);
  const code = await withLock(where, io, () => addPackLocked({pack, from, spec, eff, allow, where}, io, {say, fail}));
  // each of its modules that needs a credential and has none stored (#413
  // section 6.2): after the lock, never holding it while someone types
  if (code === 0) await require('./credentials-command').askMissing(io, spec.packages);
  return code;
}

// Released, the pins decide (#413 section 9.4): each of the pack's modules
// at this release's pin, placed in the store or, when an installed pack
// records it there already, skipped ("it shares ..."). Between packs from
// different pins (a module installed at another version), still refused
// here: L1b brings the table and its questions.
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
  // A runtime holds one version of a module (countinghouse's
  // PART_VERSION_CONFLICT): one a live pack has must be at the pin. A
  // withdrawn pack never loads, so its versions are no conflict (#83's high
  // review, 3)
  const live = activeVersions(livePacks(record.packs, record.withdrawn), []);
  const shared = [];
  for (const name of spec.packages) {
    const pinned = allow.pins[name].version;
    if (record.runtime.versions[name] != null) return fail(`${name} is part of the runtime, not a pack's; run \`ch-local install\` again`);
    const active = own(live, name) ? live[name] : null;
    if (active != null) {
      if (active !== pinned) return fail(`${name} is installed at ${active}, but this release pins ${pinned} for "${pack}"; ${reinstall}`);
      shared.push(name);
    }
  }
  // only what the store lacks at its pin is read
  // a marker that cannot be read fails the add cleanly, never out of the lock
  let toPlace;
  try {
    toPlace = spec.packages.filter((m) => !wholeAt(where, m, allow.pins[m]));
  } catch (err) {
    return fail(`${err.message}; nothing was added`);
  }
  const {problems, bytes} = loadTarballs(from, toPlace, allow.pins);
  if (problems.length > 0) {
    for (const p of problems) fail(p);
    return fail('nothing was added');
  }
  try {
    const inUse = plan.inUseFor(where, io);
    for (const m of toPlace) placeModule(where, m, bytes[m], allow.pins[m], {inUse});
  } catch (err) {
    return fail(`${err.message}; nothing was added`);
  }
  const modules = Object.fromEntries(spec.packages.map((name) => [name, allow.pins[name].version]));
  const held = {...(record.held || {})};
  delete held[pack];
  writeModulesRecord(where, {...record, packs: {...record.packs, [pack]: {from: plan.fromRelease(allow, eff), modules}}, held, unreleased: record.unreleased || eff.unreleased},
    {roleOf: plan.roleFor(where), release: allow});
  collectStore(where, {alive: io.alive, hostname: io.hostname});
  const short = (n) => n.replace(/^@[^/]+\//, '');
  say(`added the pack "${pack}"${shared.length > 0 ? `; it shares ${shared.map(short).join(', ')} with the packs already installed` : ''}`);
  if (record.unreleased || eff.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  return 0;
}

async function removePack({pack}, io) {
  const where = layout(io.env, io.homedir);
  return withLock(where, io, () => removePackLocked({pack, where}, io));
}

// The pack leaves the record, and each of its module versions no other pack
// records goes with collection, once no running start uses it and the
// rollback's kept record does not name it (#413 sections 9.5, 9.10).
async function removePackLocked({pack, where}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const got = recordOf(where, io);
  if (got == null) return 1;
  const {record} = got;
  const release = releaseOf(io);
  if (record != null && !own(record.packs, pack) && own(record.held, pack)) {
    // held after a rollback: nothing of it is in this release's record
    const held = {...record.held};
    delete held[pack];
    writeModulesRecord(where, {...record, held}, {roleOf: plan.roleFor(where), release});
    collectStore(where, {alive: io.alive, hostname: io.hostname});
    say(`removed the held pack "${pack}"; nothing of it was installed under this release`);
    return 0;
  }
  if (record == null || !own(record.packs, pack)) { io.stderr.write(`ch-local: the pack "${pack}" is not installed\n`); return 1; }
  const withdrawn = withdrawnNames(record, [{name: pack}], release).has(pack);
  const others = Object.fromEntries(Object.entries(record.packs).filter(([name]) => name !== pack));
  const stillRecorded = new Set(Object.values(others).flatMap((p) => Object.keys(p.modules)));
  const own_ = Object.entries(record.packs[pack].modules).filter(([m]) => !stillRecorded.has(m));
  writeModulesRecord(where, {...record, packs: others}, {roleOf: plan.roleFor(where), release});
  // a withdrawn pack leaves the rollback's kept record too, so a rollback
  // never brings back what the user removed (the deep review of #77); that
  // record keeps its own derived fields, less this pack's
  if (withdrawn) {
    try {
      const {readModulesRecord: readKept, writeRecordAsIs, derive} = require('./module-record');
      const kept = readKept({modulesRecord: where.previousModulesRecord});
      if (kept != null && own(kept.packs, pack)) {
        const rest = Object.fromEntries(Object.entries(kept.packs).filter(([n]) => n !== pack));
        const recorded = new Set(Object.values(rest).flatMap((p) => Object.keys(p.modules)));
        const withdrawn = kept.withdrawn.filter((m) => recorded.has(m));
        const modules = derive(rest, (m, v) => (kept.modules[m] != null && kept.modules[m].version === v ? kept.modules[m].role : plan.roleFor(where)(m, v)), withdrawn);
        writeRecordAsIs(where.previousModulesRecord, {...kept, packs: rest, modules, withdrawn});
      }
    } catch (err) { /* no kept record, or one rollback refuses anyway */ }
  }
  const {kept} = collectStore(where, {alive: io.alive, hostname: io.hostname});
  // why its own versions stay, if they do
  const dirs = new Set(own_.map(([m, v]) => require('./store-paths').versionDir(where, m, v)));
  const why = ((kept || []).find((k) => dirs.has(k.dir)) || {}).why;
  say(`removed the ${withdrawn ? 'withdrawn ' : ''}pack "${pack}"${why === 'rollback' ? '; its files stay while `ch-local rollback` can return to the release that had it'
    : why === 'running' ? '; its files go once no running client uses them'
      : why != null && why !== 'current' ? `; its files were not removed (${why}): \`ch-local install\` or the next clean-up removes them` : ''}`);
  return 0;
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
  // still pack by pack (L1b: by module, #413 section 9.9)
  const packs = installedPacks(where, record, io);
  const gone = withdrawnNames(record, packs, releaseOf(io));
  const {statusLine} = require('./credentials-command');
  const read = require('./module-credentials').bindings(where, record, {platform: io.platform || process.platform});
  if (read.problem != null) say(`the stored credentials are not used (${read.problem})`);
  const credentialStatus = (m) => statusLine(where, record, read, m);
  if (packs.length === 0 && Object.keys(record.held || {}).length === 0) say('no pack is installed; add one with `ch-local add-pack <name> --from <dir>`');
  // a module a running client's runtime stopped for good (module-stopped:
  // #413 sections 7.3 and 9.9), from the live starts' run.json; none read
  // when they cannot be (status still says the rest)
  const stoppedIn = new Map();
  try {
    for (const r of liveRuns(where, {alive: io.alive, hostname: io.hostname})) {
      for (const [m, code] of Object.entries(r.stopped || {})) if (!stoppedIn.has(m)) stoppedIn.set(m, code);
    }
  } catch (err) { /* unknown: nothing said about stopped modules */ }
  for (const p of packs) {
    if (gone.has(p.name)) { say(withdrawnStatusLine(p.name)); continue; }
    say(`${p.name} ${p.version}`);
    if (stoppedIn.has(p.scenario)) say(`  stopped in a running client (${stoppedIn.get(p.scenario)}): restart that client`);
    const tools = toolsOf(p.dir);
    say(`  tools: ${tools.length > 0 ? tools.join(', ') : '(none found: run `ch-local install` again)'}`);
    // each of its modules' credential, from the store (#413 section 6.7)
    const lines = p.packages.map((m) => credentialStatus(m)).filter((l) => l != null);
    if (lines.length === 0) say('  credential: none needed');
    for (const l of lines) say(`  ${l}`);
  }
  const running = releaseOf(io);
  for (const [name, h] of Object.entries(record.held || {})) {
    // listed by this release: add-pack brings it back (the medium review of
    // L1a-2, 3); otherwise it needs the release it was installed under
    if (running != null && running.packs != null && own(running.packs, name)) { say(require('./packs').relistedStatusLine(name)); continue; }
    const under = h.from != null && typeof h.from.release === 'string' ? h.from.release : 'another release';
    say(`${name}: installed under ch-local ${under}; this release does not have it, so it is not loaded`);
  }
  return 0;
}

module.exports = {addPack, removePack, status, toolsOf};
