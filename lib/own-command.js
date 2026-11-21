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
const {chLocal, folderArg} = require('./command-line');
const {withLock} = require('./lock');
const {checkFolder, treeHash, placeCopy, copyDir, readPlain} = require('./own-tree');
const {readOwnRecord, writeOwnRecord} = require('./own-record');
const {readModulesRecord} = require('./module-record');
const {versionDir} = require('./store-paths');
const {credentialOf} = require('./describe-module');
const {readSettings, valueOf} = require('./settings');
const {enforceAvailable} = require('./sandbox-support');

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const ADDRESS = /^([^/\s]{1,214})\/([^.\s/]{1,128})\.([^.\s/]{1,128})$/;
const MAX_JSON = 4 * 1024 * 1024;
const readJson = (file) => JSON.parse(readPlain(file, MAX_JSON).toString('utf8'));

// Every module installed here, by package name and by device name:
// {byName: Map(name -> m), byDevice: Map(friendlyName -> m)}, m = {name,
// kind: 'pack'|'own', dir, pkg, friendlyName}. A pack's from the store, an
// own module's from its copy; one that can't be read is left out (start
// says so for it).
function installedModules(where) {
  const byName = new Map();
  const byDevice = new Map();
  const add = (name, kind, dir) => {
    let pkg = null;
    let spec = null;
    try { pkg = readJson(path.join(dir, 'package.json')); spec = readJson(path.join(dir, 'api.json')); } catch (e) { return; }
    const friendlyName = isObject(spec) && isObject(spec.device) && typeof spec.device.friendlyName === 'string' ? spec.device.friendlyName : null;
    const m = {name, kind, dir, pkg, friendlyName};
    byName.set(name, m);
    if (friendlyName != null && !byDevice.has(friendlyName)) byDevice.set(friendlyName, m);
  };
  const record = readModulesRecord(where);
  if (record != null) for (const [name, e] of Object.entries(record.modules)) add(name, 'pack', versionDir(where, name, e.version));
  const own = readOwnRecord(where);
  if (own != null) for (const [name, e] of Object.entries(own.modules)) add(name, 'own', copyDir(where, name, e.tree));
  return {byName, byDevice};
}

const callsOf = (pkg) => (isObject(pkg) && isObject(pkg.countinghouse) && Array.isArray(pkg.countinghouse.calls) ? pkg.countinghouse.calls.filter((c) => typeof c === 'string') : []);
// the keys stored for a module: Map(variable -> {origin, ...}) | null (the
// store's modules is a map; a version 1 store holds none of an own module's)
const keysFor = (where, name, platform) => {
  try {
    const m = require('./credential-store').readStore(where.home, {platform}).modules;
    return m instanceof Map && m.get(name) instanceof Map && m.get(name).size > 0 ? m.get(name) : null;
  } catch (e) { return null; }
};
// text from the module's package.json, as the terminal shows it: a control,
// bidi or invisible character as "?", so none can move the cursor or hide a
// line of the question
const plain = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, '?');
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
// a module's own declared credential's origin, or null
const credentialOfPkg = (pkg) => {
  const c = credentialOf(isObject(pkg) && isObject(pkg.countinghouse) ? pkg.countinghouse.remotes : []);
  return c.credential != null ? c.credential.origin : null;
};

// The module's declared calls resolved against what is installed (a pack's
// scenarios and parts, other own modules) -> {unknown: [address] | null,
// callees: [name] (in order)}. What those callees reach in turn -- a
// pack's keys -- is not walked: R7/R8, release 1.1 (Matt, 2026-11-20).
function resolveCalls(calls, installed) {
  const unknown = [];
  const callees = [];
  for (const address of calls) {
    const m = ADDRESS.exec(address);
    const callee = m != null ? installed.byDevice.get(m[1]) : null;
    if (callee == null) { unknown.push(address); continue; }
    if (!callees.includes(callee.name)) callees.push(callee.name);
  }
  return {unknown: unknown.length > 0 ? unknown : null, callees};
}

const short = (name) => name.replace(/^@[^/]+\//, '');

async function addModule({dir}, io, {where = layout(io.env, io.homedir), now = () => new Date()} = {}) {
  const fail = (code, message) => { io.stderr.write(`ch-local: ${message}\n`); return code; };
  const shownDir = typeof dir === 'string' ? path.resolve(dir) : '';
  // the user's own act, at their own terminal, its lines seen (line 1)
  if (io.interactive !== true || io.stdoutTTY !== true) return fail(2, `add-module asks you, in your own terminal: run \`${chLocal(where, `add-module ${folderArg(shownDir, io.platform)}`)}\` there.`);
  // only under enforce (line 7; §2.1 step 7): start holds one back under
  // audit, so adding one there is refused first
  if (!enforceAvailable(where, io.platform || process.platform)) return fail(2, 'Own modules run only with the sandbox enforced, and the installed runtime can\'t enforce it on this computer.');
  const settings = readSettings(where);
  if (settings.error != null) return fail(1, `${settings.error}: nothing was added`);
  if (valueOf(settings, 'moduleSandbox') === 'audit') return fail(2, `Own modules run only with the sandbox enforced: run \`${chLocal(where, 'settings set moduleSandbox enforce')}\` first.`);
  const checked = checkFolder(shownDir, where.home);
  if (checked.problems != null) return fail(2, `${shownDir}: ${checked.problems.join('; ')}`);
  const {real, pkg, spec, entries} = checked;
  const name = pkg.name;
  const friendlyName = spec.device.friendlyName;
  const calls = callsOf(pkg);
  const tree = treeHash(real, entries);
  let installed;
  let own;
  try {
    installed = installedModules(where);
    own = readOwnRecord(where);
  } catch (err) {
    return fail(1, err.message);
  }
  const previous = own != null ? own.modules[name] : undefined;
  // the same code already added: nothing to ask (line 10)
  if (previous != null && previous.tree === tree) {
    io.stdout.write(`${short(name)} ${tree.slice(0, 12)} is already added: nothing changed.\n`);
    return 0;
  }
  // no other module's name or device name (lines 4, 5)
  const taken = installed.byName.get(name);
  if (taken != null && taken.kind !== 'own') return fail(2, `${name} is already used here by pack module ${name}: give your module another name in its package.json.`);
  const device = installed.byDevice.get(friendlyName);
  if (device != null && device.name !== name) return fail(2, `${name}'s device name ${friendlyName} is already used by ${device.name}: change it in its api.json.`);
  // what it calls: each one installed here (line 8c)
  const resolved = resolveCalls(calls, installed);
  if (resolved.unknown != null) return fail(2, `${name} calls ${resolved.unknown[0]}, and nothing installed here answers it: install the pack it belongs to, or remove the call.`);
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
  if (keptKey != null || keptData) {
    const origins = keptKey != null ? [...new Set([...keptKey.values()].map((b) => b != null && b.origin).filter(Boolean))] : [];
    lines.push(`It will use ${origins.length > 0 ? `the key already stored for ${name} (sent only to ${origins.join(', ')})` : 'no stored key'}${keptData ? ` and the data kept in ${dataDir}` : ''}. Remove them first if this is a different module: \`${chLocal(where, `credentials remove ${name}`)}\`${keptData ? `, and delete ${dataDir}` : ''}.`);
  }
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
      throw err;
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
  io.stdout.write(`Removed ${short(removed)}.${tail}\n`);
  return 0;
}

module.exports = {addModule, removeModule, installedModules, resolveCalls, folderArg};
