'use strict';
// `ch-local add-module <dir>`: the user's own module, added by the user's
// own act in their own terminal (B-own-add; the own-modules design,
// ch-business tech/plans/2026-11-20-own-modules-design.md §2.1, §5). Asked
// at a terminal only (an agent's shell is not one; its consent would be its
// client's command prompt: R6), never with --yes. The folder is judged and
// hashed (lib/own-tree.js); its name and device name must be no other
// module's; each module it calls must be installed here (composition with
// the packs: start passes those modules along); a key or data already kept
// for its name is said. The question makes no claim about what its calls
// reach through other modules (a pack's keys): R7/R8, accepted for release
// 1 (Matt, 2026-11-20). On yes the folder is copied into the home under its
// hash -- the code that runs is the code the user saw -- and recorded in
// own.json (lib/own-record.js). Every line is business-checked text (§5).
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {chLocal, folderArg, terminalText} = require('./command-line');
const {withLock} = require('./lock');
const {checkFolder, treeHash, placeCopy, copyDir, copyIntact, readPlain} = require('./own-tree');
const {readOwnRecord, writeOwnRecord} = require('./own-record');
const {readModulesRecord} = require('./module-record');
const {versionDir} = require('./store-paths');
const {PACKAGE, SCOPE, nameKey} = require('./names');
const {credentialOf} = require('./describe-module');
const {readSettings, valueOf} = require('./settings');
const {enforceAvailable} = require('./sandbox-support');

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const callsOf = (pkg) => (isObject(pkg) && isObject(pkg.countinghouse) && Array.isArray(pkg.countinghouse.calls) ? pkg.countinghouse.calls.filter((c) => typeof c === 'string') : []);
const ADDRESS = /^([^/\s]{1,214})\/([^.\s/]{1,128})\.([^.\s/]{1,128})$/;
const MAX_JSON = 4 * 1024 * 1024;
const readJson = (file) => JSON.parse(readPlain(file, MAX_JSON).toString('utf8'));

// a spec's action names: a scenario's tools, by their bare names
const actionNames = (spec) => {
  const list = isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList) ? Object.values(spec.device.serviceList) : [];
  return list.flatMap((s) => (isObject(s) && Array.isArray(s.actionList) ? s.actionList : [])).map((a) => (isObject(a) ? a.name : null)).filter((n) => typeof n === 'string');
};

// Every name the home holds (§2.4): {byName: Map(name -> m), byDevice:
// Map(friendlyName -> m), unreadable: [name] (an installed pack module whose
// files can't be read: the names it holds are not known), calledBy:
// Map(device name -> the pack module that calls it)}, m = {name, kind:
// 'pack'|'held'|'store'|'own', dir, pkg, spec, friendlyName, tools}. The
// record's modules and its held packs' from the store; any other name the
// store holds (a leftover version); an own module's from its copy, or by
// its recorded device name when the copy can't be read.
function installedModules(where) {
  const byName = new Map();
  const byDevice = new Map();
  const unreadable = [];
  const calledBy = new Map();
  const add = (name, kind, dir, recordedDevice = null) => {
    if (byName.has(name)) return;
    let pkg = null;
    let spec = null;
    try { pkg = readJson(path.join(dir, 'package.json')); spec = readJson(path.join(dir, 'api.json')); } catch (e) {
      if (kind === 'pack') unreadable.push(name);
      const m = {name, kind, dir, pkg: null, spec: null, friendlyName: recordedDevice, tools: []};
      byName.set(name, m);
      if (recordedDevice != null && !byDevice.has(recordedDevice)) byDevice.set(recordedDevice, m);
      return;
    }
    const friendlyName = isObject(spec) && isObject(spec.device) && typeof spec.device.friendlyName === 'string' ? spec.device.friendlyName : null;
    // (a scenario's tools: every own module's, a pack module's that says so)
    const scenario = kind === 'own' || (isObject(pkg) && isObject(pkg.countinghouse) && pkg.countinghouse.role === 'scenario');
    const m = {name, kind, dir, pkg, spec, friendlyName, tools: scenario ? actionNames(spec) : []};
    byName.set(name, m);
    if (friendlyName != null && !byDevice.has(friendlyName)) byDevice.set(friendlyName, m);
    // the device names a pack module calls, installed or not
    if (kind !== 'own') for (const c of callsOf(pkg)) { const d = c.slice(0, c.indexOf('/')); if (d !== '' && !calledBy.has(d)) calledBy.set(d, name); }
  };
  const record = readModulesRecord(where);
  if (record != null) {
    for (const [name, e] of Object.entries(record.modules)) add(name, 'pack', versionDir(where, name, e.version));
    for (const p of Object.values(record.held || {})) for (const [name, v] of Object.entries((p && p.modules) || {})) if (typeof v === 'string') add(name, 'held', versionDir(where, name, v));
  }
  // every name the store holds
  const list = (d) => { try { return fs.readdirSync(d, {withFileTypes: true}); } catch (e) { return []; } };
  for (const top of list(where.moduleStore)) {
    if (!top.isDirectory()) continue;
    const names = SCOPE.test(top.name) ? list(path.join(where.moduleStore, top.name)).filter((e) => e.isDirectory()).map((e) => `${top.name}/${e.name}`) : [top.name];
    for (const n of names) if (PACKAGE.test(n) && !byName.has(n)) byName.set(n, {name: n, kind: 'store', dir: null, pkg: null, spec: null, friendlyName: null, tools: []});
  }
  const own = readOwnRecord(where);
  if (own != null) for (const [name, e] of Object.entries(own.modules)) add(name, 'own', copyDir(where, name, e.tree), e.friendlyName);
  // (and by each name's key: two names Windows lays out as one are one)
  // (every holder of a key, not the first: the medium on #113's round 1)
  const byKey = new Map();
  for (const m of byName.values()) { const k = nameKey(m.name); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(m); }
  return {byName, byDevice, byKey, unreadable, calledBy};
}

// the keys stored for a module: Map(variable -> {origin, ...}) | null (the
// store's modules is a map; a version 1 store holds none of an own module's)
const keysFor = (where, name, platform) => {
  try {
    const m = require('./credential-store').readStore(where.home, {platform}).modules;
    return m instanceof Map && m.get(name) instanceof Map && m.get(name).size > 0 ? m.get(name) : null;
  } catch (e) { return null; }
};
// text from the module's package.json, as the terminal shows it: no
// character that can move the cursor or hide a line, no run of spaces, and
// cut short, so nothing can push the question's own lines away
const plain = (s) => terminalText(s, 80);
// the permissions it declares (countinghouse.permissions: fs, net, env), as
// one line, or null: under ch-local's enforce, with no operator policy,
// none is granted (countinghouse lib/module-permissions.js narrow)
function permissionsLine(pkg) {
  const p = isObject(pkg.countinghouse) && isObject(pkg.countinghouse.permissions) ? pkg.countinghouse.permissions : null;
  if (p == null) return null;
  const few = (list) => `${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}`;
  const s = (list) => (list.length > 1 ? 's' : '');
  const parts = [];
  const paths = (Array.isArray(p.fs) ? p.fs : []).filter(isObject).map((e) => `${plain(e.path)} (${e.access === 'rw' ? 'read and write' : 'read'})`);
  if (paths.length > 0) parts.push(`the path${s(paths)} ${few(paths)}`);
  const hosts = (Array.isArray(p.net) ? p.net : []).filter(isObject).map((e) => plain(e.host));
  if (hosts.length > 0) parts.push(`the network host${s(hosts)} ${few(hosts)}`);
  const envs = (Array.isArray(p.env) ? p.env : []).map(plain);
  if (envs.length > 0) parts.push(`the environment variable${s(envs)} ${few(envs)}`);
  return parts.length > 0 ? `It asks for ${parts.join(', ')}; under the enforced sandbox it gets none of them.` : null;
}
// the settings stored for a module's name (module.<name>.<setting>): the
// setting names, [] when none or when the settings file can't be read
const storedSettingsOf = (where, name) => {
  const read = require('./settings').readSettings(where);
  if (read.error != null || read.kept == null) return [];
  return require('./module-values').storedNamesOf(read.kept, name).map((n) => n.slice(`module.${name}.`.length));
};
// a module's own declared credential's origin, or null
const credentialOfPkg = (pkg) => {
  const c = credentialOf(isObject(pkg) && isObject(pkg.countinghouse) ? pkg.countinghouse.remotes : []);
  return c.credential != null ? c.credential.origin : null;
};

// The module's declared calls resolved against what is installed (a pack's
// scenarios and parts, other own modules), each to one of the callee's
// actions as the runtime resolves it (lib/call-address.js: the service by
// its URN's last label, once) -> {unknown: [address] | null, wrong:
// {address, callee} | null, callees: [name] (in order)}. What those callees
// reach in turn -- a pack's keys -- is not walked: R7/R8, release 1.1
// (Matt, 2026-11-20).
function resolveCalls(calls, installed) {
  const unknown = [];
  let wrong = null;
  const callees = [];
  for (const address of calls) {
    const m = ADDRESS.exec(address);
    const callee = m != null ? installed.byDevice.get(m[1]) : null;
    if (callee == null) { unknown.push(address); continue; }
    const list = isObject(callee.spec) && isObject(callee.spec.device) && isObject(callee.spec.device.serviceList) ? callee.spec.device.serviceList : {};
    const services = Object.keys(list).filter((urn) => urn.split(':').pop() === m[2]);
    const actions = services.length === 1 && isObject(list[services[0]]) && Array.isArray(list[services[0]].actionList) ? list[services[0]].actionList.map((a) => (isObject(a) ? a.name : null)) : [];
    if (!actions.includes(m[3])) { if (wrong == null) wrong = {address, callee: callee.name}; continue; }
    if (!callees.includes(callee.name)) callees.push(callee.name);
  }
  return {unknown: unknown.length > 0 ? unknown : null, wrong, callees};
}

const short = (name) => name.replace(/^@[^/]+\//, '');

// options: where; now; ceiling (the operator's, read when not given);
// afterRead (a test's seam: called once the folder's files were read)
async function addModule({dir}, io, {where = layout(io.env, io.homedir), now = () => new Date(), ceiling = undefined, afterRead = () => {}} = {}) {
  const fail = (code, message) => { io.stderr.write(`ch-local: ${message}\n`); return code; };
  const shownDir = typeof dir === 'string' ? path.resolve(dir) : '';
  // the user's own act, at their own terminal, its lines seen (line 1)
  if (io.interactive !== true || io.stdoutTTY !== true) return fail(2, `add-module asks you, in your own terminal: run \`${chLocal(where, `add-module ${folderArg(shownDir, io.platform)}`)}\` there.`);
  // only under enforce (line 7; §2.1 step 7): start holds one back under
  // audit, so adding one there is refused first
  if (!enforceAvailable(where, io.platform || process.platform)) return fail(2, 'Own modules run only with the sandbox enforced, and the installed runtime can\'t enforce it on this computer.');
  // (as a start decides it: the settings under the operator's ceiling)
  const settings = readSettings(where);
  if (settings.error != null) return fail(1, `${settings.error}: nothing was added`);
  const {ceilingFor, startUnderCeiling} = require('./ceiling');
  const bounded = startUnderCeiling(settings, ceiling !== undefined ? ceiling : ceilingFor(where, {platform: io.platform || process.platform, env: io.env}), {where});
  if (bounded.problem != null) return fail(1, `${bounded.problem}; nothing was added`);
  if (valueOf({values: bounded.values}, 'moduleSandbox') === 'audit') return fail(2, `Own modules run only with the sandbox enforced: run \`${chLocal(where, 'settings set moduleSandbox enforce')}\` first.`);
  // an own module runs with what an install placed: none without one (the
  // reviewer's high on #113, 3)
  let installedRecord;
  try { installedRecord = readModulesRecord(where); } catch (err) { return fail(1, `${err.message}; nothing was added`); }
  if (installedRecord == null) return fail(2, `nothing is installed yet: run \`${chLocal(where, 'install --pack <name>')}\` first; your own modules run with what it installs.`);
  const checked = checkFolder(shownDir, where.home);
  if (checked.problems != null) return fail(2, `${terminalText(shownDir, 512)}: ${checked.problems.join('; ')}`);
  const {real, pkg, spec, entries} = checked;
  const name = pkg.name;
  const friendlyName = spec.device.friendlyName;
  const calls = callsOf(pkg);
  afterRead();
  // what the question shows is what is hashed, and so what loads: the
  // package.json and api.json read above must be the bytes hashed now
  const hashed = {'package.json': null, 'api.json': null};
  const tree = treeHash(real, entries, hashed);
  if (hashed['package.json'] == null || hashed['api.json'] == null || !hashed['package.json'].equals(checked.pkgBytes) || !hashed['api.json'].equals(checked.specBytes)) {
    return fail(1, 'the folder changed while it was being added: run add-module again');
  }
  let installed;
  let own;
  try {
    installed = installedModules(where);
    own = readOwnRecord(where);
  } catch (err) {
    return fail(1, err.message);
  }
  // an installed module whose files can't be read: the names it holds are
  // not known, so none is taken (§2.4)
  if (installed.unreadable.length > 0) return fail(1, `${installed.unreadable[0]}'s files can't be read here, so the names it holds are not known: run \`${chLocal(where, 'install')}\` again first.`);
  const previous = own != null ? own.modules[name] : undefined;
  // the same code already added, its copy whole: nothing to ask (line 10)
  if (previous != null && previous.tree === tree && copyIntact(where, name, tree)) {
    io.stdout.write(`${short(name)} ${tree.slice(0, 12)} is already added: nothing changed.\n`);
    return 0;
  }
  // no name this release holds: its runtime's packages, its pinned modules
  // (§2.4; their data and keys are kept by name)
  const allow = require('./packs').releaseOf(io);
  const held = new Set([...((allow.runtime && allow.runtime.packages) || []), ...Object.keys(allow.pins || {})].map(nameKey));
  if (held.has(nameKey(name))) return fail(2, `${name} is a name this release holds: give your module another name in its package.json.`);
  // no other module's name or device name (lines 4, 5)
  // (any holder of its key but this own module itself)
  const taken = (installed.byKey.get(nameKey(name)) || []).find((m) => !(m.kind === 'own' && m.name === name));
  if (taken != null) return fail(2, `${name} is already used here by ${taken.kind === 'own' ? 'your own module' : 'pack module'} ${terminalText(taken.name)}: give your module another name in its package.json.`);
  const device = installed.byDevice.get(friendlyName);
  if (device != null && device.name !== name) return fail(2, `${name}'s device name ${terminalText(friendlyName)} is already used by ${device.name}: change it in its api.json.`);
  // nor one a pack module calls, installed or not: a pack never calls user
  // code that took the name it calls
  const caller = installed.calledBy.get(friendlyName);
  if (caller != null) return fail(2, `${name}'s device name ${terminalText(friendlyName)} is one ${caller} calls: change it in its api.json.`);
  // no tool name another scenario lists (§2.4: the runtime would refuse it,
  // TOOL_NAME_TAKEN; the runtime's own tools it refuses at load)
  for (const t of actionNames(spec)) {
    const holder = [...installed.byName.values()].find((m) => m.name !== name && m.tools.includes(t));
    if (holder != null) return fail(2, `${name}'s tool ${terminalText(t)} is already a tool of ${holder.name}: rename the action in its api.json.`);
  }
  // each call listed once, at most 256 (own.json's bounds, said before the
  // yes: the reviewer's high on #113, 4)
  // (the bound first, then one pass: the medium on #113's round 1)
  if (calls.length > 256) return fail(2, `${name} lists more than 256 calls: an own module lists at most 256.`);
  const seenCalls = new Set();
  const twice = calls.find((c) => (seenCalls.has(c) ? true : (seenCalls.add(c), false)));
  if (twice != null) return fail(2, `${name} lists the call ${terminalText(twice)} twice: list each call once in its package.json.`);
  // what it calls: each one installed here (line 8c)
  const resolved = resolveCalls(calls, installed);
  if (resolved.unknown != null) return fail(2, `${name} calls ${terminalText(resolved.unknown[0])}, and nothing installed here answers it: install the pack it belongs to, or remove the call.`);
  if (resolved.wrong != null) return fail(2, `${name} calls ${terminalText(resolved.wrong.address)}, and ${short(resolved.wrong.callee)} has no such action: correct the call in its package.json.`);
  // the question (lines 8, 8a, 8c)
  const lines = [`Add your own module ${name} ${pkg.version} (code ${tree.slice(0, 12)}, ${entries.filter((e) => e.kind === 'file').length} files)?`,
    'It runs inside the same countinghouse runtime as your packs.',
    'It can connect to the internet and send what it is given.'];
  for (const callee of resolved.callees) lines.push(`It calls ${short(callee)}.`);
  const ownOrigin = credentialOfPkg(pkg);
  if (ownOrigin != null) lines.push(`It calls ${ownOrigin}; add its key with \`${chLocal(where, `credentials add ${name}`)}\`.`);
  const asks = permissionsLine(pkg);
  if (asks != null) lines.push(asks);
  // a key or data kept for this name (a remove-module keeps them; line 8a)
  const keptKey = keysFor(where, name, io.platform);
  const dataDir = path.join(where.moduleData, ...name.split('/'));
  const keptData = fs.existsSync(dataDir);
  // (and its settings: a re-add, or a new module under a removed one's
  // name, takes them as it takes a key or data -- B-own-settings)
  const keptSettings = storedSettingsOf(where, name);
  // (only what is kept is named, each with its own remedy: the medium on
  // B-own-settings, 9)
  const uses = [];
  const remedies = [];
  if (keptKey != null) {
    const origins = [...new Set([...keptKey.values()].map((b) => b != null && b.origin).filter(Boolean))];
    uses.push(`the key already stored for ${name}${origins.length > 0 ? ` (sent only to ${origins.join(', ')})` : ''}`);
    remedies.push(`\`${chLocal(where, `credentials remove ${name}`)}\``);
  }
  if (keptData) { uses.push(`the data kept in ${dataDir}`); remedies.push(`delete ${dataDir}`); }
  if (keptSettings.length > 0) {
    uses.push(`the settings stored for ${name} (${keptSettings.map((s) => terminalText(s, 40)).slice(0, 8).join(', ')}${keptSettings.length > 8 ? ', …' : ''})`);
    remedies.push(`\`${chLocal(where, `settings reset ${name}`)}\``);
  }
  const listed = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  if (uses.length > 0) lines.push(`It will use ${listed(uses)}. Remove ${uses.length > 1 ? 'them' : 'it'} first if this is a different module: ${remedies.join(', and ')}.`);
  io.stdout.write(`${lines.join('\n')}\n`);
  const answer = String(await io.ask('Add it? [y/N] ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return fail(1, `${short(name)} was not added`);
  // the copy and the record, under the home's lock
  const code = await withLock(where, io, () => {
    let current;
    try { current = readOwnRecord(where); } catch (err) { return fail(1, err.message); }
    try {
      placeCopy(where, name, real, entries, tree, {now});
    } catch (err) {
      if (err.code === 'OWN_TREE_CHANGED') return fail(1, err.message);
      // (after the yes, never a crash: the old copy, if any, stays marked)
      return fail(1, `your module's copy could not be replaced (${err.code || 'an error'}): nothing was added`);
    }
    const modules = current != null ? current.modules : Object.create(null);
    modules[name] = {tree, version: pkg.version, friendlyName, addedAt: now().toISOString(), from: real, calls};
    writeOwnRecord(where, {v: 1, modules});
    return 0;
  });
  if (code !== 0) return code;
  // (line 9)
  io.stdout.write(`Added ${short(name)} (own, ${tree.slice(0, 12)}): your clients see it now.\n`);
  return 0;
}

// `ch-local remove-module <name>` (the own-modules design §2.6, §5 line
// 15): the module dropped from own.json, by its package name or, when one
// own module has it, its short name; its copies no live start runs
// collected (the rest at the next collection). A tightening: asked of no
// one. Its data and its key are kept, and said, with how to remove them.
async function removeModule({name}, io, {where = layout(io.env, io.homedir)} = {}) {
  const fail = (code, message) => { io.stderr.write(`ch-local: ${message}\n`); return code; };
  let removed = null;
  const code = await withLock(where, io, () => {
    let record;
    try { record = readOwnRecord(where); } catch (err) { return fail(1, err.message); }
    const names = record != null ? Object.keys(record.modules) : [];
    const matches = names.includes(name) ? [name] : names.filter((n) => short(n) === name);
    if (matches.length === 0) return fail(2, `${name} is not one of your own modules: \`${chLocal(where, 'status')}\` lists them.`);
    if (matches.length > 1) return fail(2, `${name} names more than one of your own modules (${matches.join(', ')}): name it in full.`);
    removed = matches[0];
    delete record.modules[removed];
    writeOwnRecord(where, record);
    require('./gc').collectOwn(where, {alive: io.alive, hostname: io.hostname});
    return 0;
  });
  if (code !== 0) return code;
  const hasKey = keysFor(where, removed, io.platform) != null;
  const dataDir = path.join(where.moduleData, ...removed.split('/'));
  const hasData = fs.existsSync(dataDir);
  const keyCmd = `\`${chLocal(where, `credentials remove ${removed}`)}\``;
  const tail = hasData && hasKey ? ` Its data is kept in ${dataDir}, and its key with it: ${keyCmd} removes the key.`
    : hasData ? ` Its data is kept in ${dataDir}.`
      : hasKey ? ` Its key is kept: ${keyCmd} removes it.` : '';
  // (its settings stay stored, as its data and key: B-own-settings)
  const settingsTail = storedSettingsOf(where, removed).length > 0 ? ` Its settings stay stored: \`${chLocal(where, `settings reset ${removed}`)}\` resets them.` : '';
  io.stdout.write(`Removed ${short(removed)}.${tail}${settingsTail}\n`);
  return 0;
}

module.exports = {addModule, removeModule, installedModules, resolveCalls, folderArg};
