'use strict';
const {notAllowed, ceilingFor, forbiddenBy, startUnderCeiling} = require('./ceiling');
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
const {readModulesRecord, writeModulesRecord, livePacks, activeVersions, compareVersions} = require('./module-record');
const {placeModule, wholeAt} = require('./module-store');
const {versionDir} = require('./store-paths');
const {availability, short} = require('./availability');
const {readSettings, valueOf} = require('./settings');
const {outsideEdits} = require('./outside-edits');
const {ghToken} = require('./github-token');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');
const {collectStore, liveRuns} = require('./gc');
const {loadTarballs} = require('./install');
const table = require('./pack-table');
const plan = require('./install-plan');
const {installedPacks, withdrawnNames, withdrawnStatusLine, releaseOf, recordRelease, staleLine, installLine} = require('./packs');

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

// Whether a pack meets section 9.4's table: the home is a development one,
// or this pack comes from other pins than the installed packs did. In a
// released home of one release the pins decide, and nothing is asked.
function tableApplies(record, allow, eff) {
  if (record.unreleased === true || eff.unreleased === true) return true;
  const from = JSON.stringify(plan.fromRelease(allow, eff));
  return Object.values(record.packs || {}).some((p) => JSON.stringify(p.from) !== from);
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
  // Between packs from different pins (#413 section 9.4; L1b-2): the
  // table's questions, every one asked before anything is written and
  // before the lock is taken (no one holds it while someone types); any No
  // ends the operation. The answers are checked again under the lock: a home
  // that changed meanwhile is refused, never taken as answered.
  let asked = null;
  const pre = recordOf(where, io);
  if (pre == null) return 1;
  // (pins of another runtime are refused under the lock, as before: nothing is asked of them)
  const sameRuntime = (r) => allow.runtime.packages.every((n) => allow.pins[n] == null || r.runtime.versions[n] == null || allow.pins[n].version === r.runtime.versions[n]);
  if (pre.record != null && !own(pre.record.packs, pack) && sameRuntime(pre.record) && tableApplies(pre.record, allow, eff) && spec.packages.every((m) => allow.pins[m] != null)) {
    const {problems, bytes} = loadTarballs(from, table.preLockNeeds(where, spec, allow.pins), allow.pins);
    if (problems.length > 0) {
      for (const p of problems) fail(p);
      return fail('nothing was added');
    }
    const got = await table.askAll(where, table.decide(where, pre.record, pack, spec, allow.pins, {bytes}), pack, io, (s) => fail(s));
    if (got.code != null) return got.code;
    asked = got.signature;
  }
  const code = await withLock(where, io, () => addPackLocked({pack, from, spec, eff, allow, where, asked}, io, {say, fail}));
  // each of its modules that needs a credential and has none stored (#413
  // section 6.2): after the lock, never holding it while someone types
  if (code === 0) await require('./credentials-command').askMissing(io, spec.packages);
  return code;
}

// Released, the pins decide (#413 section 9.4): each of the pack's modules
// at this release's pin, placed in the store or, when an installed pack
// records it there already, skipped ("it shares ..."). Between packs from
// different pins, section 9.4's table (lib/pack-table.js), its questions
// answered before the lock.
async function addPackLocked({pack, from, spec, eff, allow, where, asked = null}, io, {say, fail}) {
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
  for (const name of spec.packages) {
    if (record.runtime.versions[name] != null) return fail(`${name} is part of the runtime, not a pack's; run \`ch-local install\` again`);
  }
  // Between packs from different pins: section 9.4's table, as decided and
  // answered before the lock (a change since is refused). Released, the
  // pins decide: a module a live pack has must be at the pin (a runtime
  // holds one version of a module: countinghouse's PART_VERSION_CONFLICT;
  // a withdrawn pack never loads, so its versions are no conflict: #83's
  // high review, 3).
  let rows = null;
  if (tableApplies(record, allow, eff)) {
    const again = table.recheck(where, record, pack, spec, allow.pins, asked);
    if (again.problem != null) return fail(again.problem);
    rows = again.rows;
  } else {
    const live = activeVersions(livePacks(record.packs, record.withdrawn), []);
    rows = [];
    for (const name of spec.packages) {
      const pinned = allow.pins[name].version;
      const active = own(live, name) ? live[name] : null;
      if (active != null && active !== pinned) return fail(`${name} is installed at ${active}, but this release pins ${pinned} for "${pack}"; ${reinstall}`);
      rows.push({module: name, a: active, p: pinned, case: active == null ? 'new' : 'same', place: active == null, recordAs: pinned, callers: [], question: null});
    }
  }
  // only what the store lacks at its pin is read
  // a marker that cannot be read fails the add cleanly, never out of the lock
  let toPlace;
  try {
    toPlace = rows.filter((r) => r.place || r.case === 'same').map((r) => r.module).filter((m) => !wholeAt(where, m, allow.pins[m]));
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
  const modules = Object.fromEntries(rows.map((r) => [r.module, r.recordAs]));
  const shared = rows.filter((r) => r.case === 'same' || r.case === 'newer').map((r) => r.module);
  const held = {...(record.held || {})};
  delete held[pack];
  writeModulesRecord(where, {...record, packs: {...record.packs, [pack]: {from: plan.fromRelease(allow, eff), modules}}, held, unreleased: record.unreleased || eff.unreleased},
    {roleOf: plan.roleFor(where), release: allow});
  collectStore(where, {alive: io.alive, hostname: io.hostname});
  const short = (n) => n.replace(/^@[^/]+\//, '');
  say(`added the pack "${pack}"${shared.length > 0 ? `; it shares ${shared.map(short).join(', ')} with the packs already installed` : ''}`);
  // what the table changed, and how to go back (section 9.4)
  for (const line of table.changedLines(rows, pack)) say(line);
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
  // the active versions before and after (rule 2: the highest any pack
  // records), for the way back (section 9.5); a removed module's stored
  // credential, read before the record changes
  const before = activeVersions(livePacks(record.packs, record.withdrawn), []);
  const after = activeVersions(livePacks(others, record.withdrawn), []);
  let storedFor = new Set();
  try {
    const read = require('./module-credentials').bindings(where, record, {platform: io.platform || process.platform});
    if (read.bindings != null) storedFor = new Set(own_.map(([m]) => m).filter((m) => read.bindings.get(m) != null && read.bindings.get(m).size > 0));
  } catch (err) { /* the store is read again by credentials; nothing said here */ }
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
  // Between packs from different pins, the way back (section 9.5): a module
  // this pack raised goes back to the highest the remaining packs record;
  // one a remaining pack was installed with at the same version stays, and
  // which pack is said. In a released home the pins decide, and a shared
  // module is simply unchanged: nothing is said.
  const mixed = record.unreleased === true || new Set(Object.values(record.packs).map((e) => JSON.stringify(e.from))).size > 1;
  const short = (n) => n.replace(/^@[^/]+\//, '');
  if (mixed) {
    for (const [m, v] of Object.entries(record.packs[pack].modules)) {
      if (!stillRecorded.has(m) || before[m] == null || after[m] == null) continue;
      if (compareVersions(after[m], before[m]) < 0) {
        say(`put back ${short(m)} ${before[m]} -> ${after[m]} (it was updated when ${pack} was installed)`);
      } else if (v === before[m]) {
        const q = Object.entries(others).find(([, e]) => e.modules[m] === before[m]);
        if (q != null) say(`${short(m)} stays at ${before[m]}: the pack ${q[0]} was installed with it`);
      }
    }
  }
  // a module that left the record keeps its stored credential (section 9.5)
  for (const m of storedFor) say(`the credential stored for ${short(m)} is kept: \`ch-local credentials remove ${short(m)}\` removes it`);
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

// `status` by module (#413 section 9.9; L1b-1): the modules first, each with
// what it is (on, with its tools; a part; or why it would not load, in the
// sentence a start says: lib/availability.js), its credential, and a running
// client's word on it (a module it stopped for good); then the packs as what
// they are, by their module count; then the held packs, as before.
// The settings as a start takes them, without writing anything: a file
// that cannot be used stops a start (and so is a problem here); an outside
// loosening the ceiling forbids is not applied; the values the ceiling
// bounds are bounded. -> {settings} | {problem}
function statusSettings(where, ceiling) {
  const settings = readSettings(where);
  if (settings.error != null) return {problem: `${settings.error}: no client starts until it is fixed (\`ch-local settings reset\` replaces every setting with its default, asking first if that loosens one)`};
  const refused = forbiddenBy(ceiling);
  for (const e of outsideEdits(where, settings)) {
    // (as start's reportOutsideEdits: only a loosening is refused)
    if (!e.loosened || refused(e.setting, e.new) == null) continue;
    if (valueOf({values: {}}, e.setting) === e.old) delete settings.values[e.setting]; else settings.values[e.setting] = e.old;
  }
  const bounded = startUnderCeiling(settings, ceiling, {});
  if (bounded.problem != null) return {problem: bounded.problem.replace(/: not starting;/, ': no client starts;')};
  return {settings: Object.assign({}, settings, {values: bounded.values})};
}
const OLDER = '\0older';

async function status(_, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  const got = recordOf(where, io);
  if (got == null) return 1;
  const {record} = got;
  if (record == null) { say('nothing is installed; run `ch-local install --pack <name> --from <dir>`'); return 1; }
  if (record.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  const versions = (record.runtime && record.runtime.versions) || {};
  const installedSelf = versions['@countinghouse/ch-local'];
  say(`ch-local ${installedSelf || '(unknown)'}, countinghouse ${versions.countinghouse || '(unknown)'}`);
  // the live starts (as collection reads them): a module one stopped for
  // good (module-stopped, section 7.3), and one still on another ch-local.
  // None read when they cannot be: status still says the rest
  const stoppedIn = new Map();
  const otherSelf = new Set();
  try {
    for (const r of liveRuns(where, {alive: io.alive, hostname: io.hostname})) {
      for (const [m, code] of Object.entries(r.stopped || {})) if (!stoppedIn.has(m)) stoppedIn.set(m, code);
      // a run with no chLocal was started by a ch-local before L1b-1 (an
      // older one); null: one not run from the home (a checkout), unknown
      if (r.chLocal === undefined) otherSelf.add(OLDER);
      else if (typeof r.chLocal === 'string' && installedSelf != null && r.chLocal !== installedSelf) otherSelf.add(r.chLocal);
    }
  } catch (err) { /* unknown: nothing said about running clients */ }
  for (const v of otherSelf) say(v === OLDER ? 'a running client is still on an older ch-local; restart it' : `a running client is still on ch-local ${v}; restart it`);
  // each installed module's credential, from the store (#413 section 6.7)
  const read = require('./module-credentials').bindings(where, record, {platform: io.platform || process.platform});
  if (read.problem != null) say(`the stored credentials are not used (${read.problem})`);
  // what a start decides, by the same rules (section 5.2): the settings as
  // a start takes them (statusSettings), the ceiling now, and each
  // credential's state, the gh login asked only when a binding uses it, as
  // a start asks it
  const ceiling = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
  const taken = statusSettings(where, ceiling);
  if (taken.problem != null) {
    // a start would not run: nothing would load, and nothing is guessed
    say(taken.problem);
    for (const m of Object.keys(record.modules || {})) say(`  ${short(m)} ${record.modules[m].version}: not loaded (no client starts until that is fixed)`);
    return 0;
  }
  const mc = require('./module-credentials');
  const decls = mc.declarations(where, record);
  const usesGh = read.bindings != null && [...decls].some(([m, d]) => {
    const vars = read.bindings.get(m);
    const b = vars != null && d.variable != null ? vars.get(d.variable) : null;
    // (as forStart asks it: only a gh binding gh could serve)
    return b != null && b.source === 'gh' && b.origin === d.origin && d.origin === mc.GH_ORIGIN;
  });
  const gh = usesGh ? await ghToken(io, where.home) : null;
  const states = new Map([...decls].map(([m, d]) => [m, mc.stateOf(m, d, read, gh)]));
  // (the record too: a module's enabled.* is read beside pack.<name>, off
  // winning, as start reads it: L3)
  const seams = Object.assign(require('./module-seams').moduleSeams({settings: taken.settings, ceiling, record}), {credential: mc.credentialSeam(states)});
  // whose record this is, said as a start says it (lib/packs.js)
  const whose = recordRelease(record, io, where);
  if (whose.state === 'stale') say(staleLine(whose.installed, whose.how));
  if (whose.state === 'other') say(installLine(whose.ours));
  const av = availability(where, record, {release: releaseOf(io), pins: whose.state !== 'stale', seams});
  const dirOf = new Map(av.units.map((u) => [u.name, u.dir]));
  // a module's credential as it is stored, whatever the module's state (a
  // module turned off still has its binding)
  const credentialOf = (m) => {
    const st = states.get(m);
    const b = st != null && st.binding != null ? st.binding : null;
    if (b == null || st.state === 'elsewhere') return null;
    return `credential ${b.variable} -> ${b.origin} (${b.source === 'gh' ? 'gh login' : 'stored'})`;
  };
  // a start's reason, said of the module named on its line: "it is turned
  // off ..." reads "turned off ...", "it calls ..." reads "calls ..."
  const why = (reason) => String(reason).replace(/^it (is )?/, '');
  const rows = Object.keys(record.modules || {}).map((m) => {
    const v = record.modules[m].version;
    const s = av.states.get(m) || {ok: true};
    const parts = [];
    if (!av.tops.has(m)) {
      parts.push(s.ok ? 'part' : `part; not available: ${why(s.reason)}`);
    } else if (!s.ok) {
      parts.push(`not loaded: ${why(s.reason)}`);
    } else if (stoppedIn.has(m)) {
      parts.push(`on; stopped in a running client (${stoppedIn.get(m)}): restart that client`);
    } else {
      const tools = toolsOf(dirOf.get(m) || versionDir(where, m, v));
      parts.push(`on; tools: ${tools.length > 0 ? tools.join(', ') : '(none found: run `ch-local install` again)'}`);
    }
    const c = credentialOf(m);
    if (c != null) parts.push(c);
    return [`${short(m)} ${v}`, parts.join('; ')];
  });
  const packs = installedPacks(where, record, io);
  const gone = withdrawnNames(record, packs, releaseOf(io));
  const width = Math.max(0, ...rows.map(([l]) => l.length), ...packs.map((p) => p.name.length)) + 3;
  if (rows.length > 0) {
    say('modules:');
    for (const [l, r] of rows) say(`  ${l.padEnd(width)}${r}`);
  }
  if (packs.length === 0 && Object.keys(record.held || {}).length === 0) say('no pack is installed; add one with `ch-local add-pack <name> --from <dir>`');
  if (packs.length > 0) {
    say('packs:');
    for (const p of packs) {
      if (gone.has(p.name)) { say(`  ${withdrawnStatusLine(p.name)}`); continue; }
      const n = Object.keys((record.packs[p.name] && record.packs[p.name].modules) || {}).length;
      say(`  ${p.name.padEnd(width)}${n} module${n === 1 ? '' : 's'}`);
    }
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
