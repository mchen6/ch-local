'use strict';
// What a release pins, as data (docs/development/auto-upgrade.md, "The trust
// chain", step 5): lib/release-pins.json, never code, so a new release's pins
// are read from its verified tarball's bytes in memory, and nothing of it runs
// before it is installed. lib/allowlist.js reads this release's own copy.
//
//   {v: 2,
//    release: {security: {fixes} | null},
//    self: {repository, repositoryId, ownerId, workflow},
//    shim: {packages: {<platform>-<arch>: "@countinghouse/ch-shim-<platform>-<arch>"}},
//    runtime: {packages: ["@countinghouse/ch-local", "countinghouse"], lockfile: <npm v3 lockfile> | null},
//    packs: {<pack>: {modules: [<package>...]}},
//    modules: {<package>: {credentials: [{variable, origin}], calls: [<package>...],
//                          confirmSettings: {<setting>: <its default> | null}}},
//    pins: {<name>: {version, integrity, repository, repositoryId, ownerId, workflow, tag}},
//    floors?: {<package>: <the least version a release may pin>}}
//
// floors (the reviewer on the redaction fixes, A-redact): a home's parts are
// only as new as its release's pins, so a module whose version carries a fix
// every release must hold names that version here. No pin may go below it
// (refused here), and the release step refuses a tarball below it
// (scripts/describe-release.js). Optional: a document without floors names
// none. The checklist line (docs/development/release-checklist.md) says
// why each is there.
//
// Version 2 (#413 section 9.3; L5b): packs.<p>.modules replaces packages,
// and its order means nothing (a module's role is its manifest's). modules
// DESCRIBES each package of each pack, from its own manifest
// (lib/describe-module.js), written by the release step
// (scripts/describe-release.js), never by hand. It is not a list of what is
// allowed: the store's binding says where a key may go, and the runtime
// checks calls and settings from the manifests it loads. It exists so that
// a release can be compared with the one installed before anything is
// fetched (additions), and install refuses a package that differs from it,
// so what was shown is what is installed. A pack's credentials and the
// top-level allowedOrigins are gone. A version 1 document is refused: a
// breaking change, acceptable only because no release has been published.
//
// self is ch-local's own identity. A release can't pin its own digest (its
// tarball holds this file), so ch-local's pin is the digest its provenance
// verifies, with this identity and the tag v<version>; no pin may name it.
// shim names the native shim's package for each of the six targets
// (${process.platform}-${process.arch}). A pin's tag is exactly its workflow's
// prefix and its version (lib/provenance.js tagFor), and a package's kind
// fixes its workflow: the shim's six from shim.yml, every other from
// publish.yml.
// The key sets are exact, at every level. A pin names a package of this
// release (the runtime's or a pack's), a strict MAJOR.MINOR.PATCH version, a
// sha512, and the identity its provenance must carry (lib/provenance.js).
// The runtime's lockfile, when present, is npm's v3. Its entries are checked
// at install, where ch-local's own entry is filled in from its verified
// digest.
const MAX_BYTES = 1024 * 1024;
const STRICT = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const {PACKAGE, PACK} = require('./names');
const {VARIABLE, isOrigin} = require('./credential-store');
const SETTING = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const TAG = /^[A-Za-z0-9_.-]+$/;
const RUNTIME = ['@countinghouse/ch-local', 'countinghouse'];
const SHIM_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const SHIM_WORKFLOW = '.github/workflows/shim.yml';
const PUBLISH_WORKFLOW = '.github/workflows/publish.yml';
const {tagFor} = require('./release-tags');

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (o, keys) => isObject(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const listOf = (a, re, {nonEmpty = false} = {}) => Array.isArray(a) && (!nonEmpty || a.length > 0) && a.every((x) => typeof x === 'string' && re.test(x)) && new Set(a).size === a.length;

const deepFreeze = (v) => {
  if (v != null && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

function pinProblem(name, p, shimNames) {
  if (!keysAre(p, ['version', 'integrity', 'repository', 'repositoryId', 'ownerId', 'workflow', 'tag'])) return `the pin for ${name} must be exactly {version, integrity, repository, repositoryId, ownerId, workflow, tag}`;
  if (typeof p.version !== 'string' || !STRICT.test(p.version)) return `the pin for ${name} has no strict MAJOR.MINOR.PATCH version`;
  if (typeof p.integrity !== 'string' || !SHA512.test(p.integrity)) return `the pin for ${name} has no sha512 integrity`;
  if (typeof p.repository !== 'string' || !REPOSITORY.test(p.repository)) return `the pin for ${name} names no repository`;
  for (const k of ['repositoryId', 'ownerId']) if (!Number.isSafeInteger(p[k]) || p[k] <= 0) return `the pin for ${name} has no numeric ${k}`;
  if (typeof p.workflow !== 'string' || !WORKFLOW.test(p.workflow)) return `the pin for ${name} names no workflow`;
  if (typeof p.tag !== 'string' || !TAG.test(p.tag)) return `the pin for ${name} names no tag`;
  // its kind fixes its workflow, and its workflow fixes its tag
  const workflow = shimNames.has(name) ? SHIM_WORKFLOW : PUBLISH_WORKFLOW;
  if (p.workflow !== workflow) return `the pin for ${name} must be built from ${workflow}, not ${p.workflow}`;
  const tag = tagFor(p.workflow, p.version);
  if (p.tag !== tag) return `the pin for ${name}: its tag must be ${tag}, not ${p.tag}`;
  return null;
}

// modules: the descriptions; listed: every package some pack names. Exactly
// one description for each, none for another; at most one credential (one
// remote per module in release 1, section 6.1); calls stay inside the
// release; a confirm setting's default a scalar or null. -> problem | null
function modulesProblem(modules, listed) {
  if (!isObject(modules)) return 'modules must be an object';
  for (const m of listed) if (!Object.prototype.hasOwnProperty.call(modules, m)) return `modules must describe ${m}`;
  for (const [m, e] of Object.entries(modules)) {
    if (!listed.has(m)) return `modules describes ${m}, which no pack lists`;
    if (!keysAre(e, ['role', 'credentials', 'calls', 'confirmSettings'])) return `the description of ${m} must be exactly {role, credentials, calls, confirmSettings}`;
    if (!(e.role === null || (typeof e.role === 'string' && require('./describe-module').ROLE.test(e.role)))) return `the role in the description of ${m} must be a role or null`;
    if (!Array.isArray(e.credentials) || e.credentials.length > 1) return `the description of ${m} must list at most one credential`;
    for (const c of e.credentials) {
      if (!keysAre(c, ['variable', 'origin']) || typeof c.variable !== 'string' || c.variable.length > 128 || !VARIABLE.test(c.variable) || !isOrigin(c.origin)) {
        return `the credential in the description of ${m} must be {variable, origin} (a variable name, an https origin)`;
      }
    }
    if (!listOf(e.calls, PACKAGE) || JSON.stringify(e.calls) !== JSON.stringify([...e.calls].sort())) return `the description of ${m} must list its calls as package names, each once, sorted`;
    for (const c of e.calls) if (!listed.has(c)) return `${m} calls ${c}, which no pack of this release lists`;
    if (!isObject(e.confirmSettings)) return `the description of ${m} must give its confirm settings as an object`;
    for (const [k, v] of Object.entries(e.confirmSettings)) {
      if (!SETTING.test(k)) return `the description of ${m} names no setting ${JSON.stringify(k)}`;
      if (!(v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) return `the confirm setting ${k} of ${m} must default to a value or null`;
    }
  }
  return null;
}

// a parsed document, checked -> its problem, or null
function documentProblem(d) {
  if (isObject(d) && d.v === 1) return 'it is version 1, which this ch-local no longer reads (version 2 describes each module)';
  const KEYS = ['v', 'release', 'self', 'shim', 'runtime', 'packs', 'modules', 'pins'];
  if (!keysAre(d, KEYS) && !keysAre(d, [...KEYS, 'floors'])) return 'must be exactly {v, release, self, shim, runtime, packs, modules, pins}, with an optional floors';
  if (d.v !== 2) return `v must be 2, not ${JSON.stringify(d.v)}`;
  if (!keysAre(d.release, ['security'])) return 'release must be exactly {security}';
  if (d.release.security !== null && !(keysAre(d.release.security, ['fixes']) && typeof d.release.security.fixes === 'string' && d.release.security.fixes.length <= 500)) {
    return 'release.security must be null or {fixes: <text>}';
  }
  if (!keysAre(d.self, ['repository', 'repositoryId', 'ownerId', 'workflow'])) return 'self must be exactly {repository, repositoryId, ownerId, workflow}';
  if (typeof d.self.repository !== 'string' || !REPOSITORY.test(d.self.repository)) return 'self names no repository';
  for (const k of ['repositoryId', 'ownerId']) if (!Number.isSafeInteger(d.self[k]) || d.self[k] <= 0) return `self has no numeric ${k}`;
  if (typeof d.self.workflow !== 'string' || !WORKFLOW.test(d.self.workflow)) return 'self names no workflow';
  if (d.self.workflow !== PUBLISH_WORKFLOW) return `self must be built from ${PUBLISH_WORKFLOW}`;
  if (!keysAre(d.shim, ['packages']) || !keysAre(d.shim.packages, SHIM_TARGETS)) return `shim must be exactly {packages: {${SHIM_TARGETS.join(', ')}}}`;
  for (const [k, name] of Object.entries(d.shim.packages)) if (name !== `@countinghouse/ch-shim-${k}`) return `shim.packages.${k} must be @countinghouse/ch-shim-${k}`;
  if (!keysAre(d.runtime, ['packages', 'lockfile'])) return 'runtime must be exactly {packages, lockfile}';
  if (JSON.stringify(d.runtime.packages) !== JSON.stringify(RUNTIME)) return `runtime.packages must be ${JSON.stringify(RUNTIME)}`;
  const lock = d.runtime.lockfile;
  if (lock !== null && !(isObject(lock) && lock.lockfileVersion === 3 && isObject(lock.packages) && lock.dependencies === undefined)) {
    return 'runtime.lockfile must be null or an npm v3 lockfile (lockfileVersion 3, packages, no dependencies tree)';
  }
  if (!isObject(d.packs) || Object.keys(d.packs).length === 0) return 'packs must name at least one pack';
  for (const [name, p] of Object.entries(d.packs)) {
    if (!PACK.test(name)) return `the pack name ${JSON.stringify(name)} is not one`;
    if (!keysAre(p, ['modules'])) return `the pack ${name} must be exactly {modules}`;
    if (!listOf(p.modules, PACKAGE, {nonEmpty: true})) return `the pack ${name} must list its modules, each once`;
  }
  const why = modulesProblem(d.modules, new Set(Object.values(d.packs).flatMap((p) => p.modules)));
  if (why != null) return why;
  if (!isObject(d.pins)) return 'pins must be an object';
  const shimNames = new Set(Object.values(d.shim.packages));
  const known = new Set([...d.runtime.packages, ...Object.values(d.packs).flatMap((p) => p.modules), ...shimNames]);
  for (const [name, p] of Object.entries(d.pins)) {
    if (name === RUNTIME[0]) return `no pin may name ${RUNTIME[0]}: its digest is the one its provenance verifies (self)`;
    if (!known.has(name)) return `the pin for ${name} names no package of this release`;
    const why = pinProblem(name, p, shimNames);
    if (why != null) return why;
  }
  if (d.floors !== undefined) {
    if (!isObject(d.floors)) return 'floors must be an object';
    const listed = new Set(Object.values(d.packs).flatMap((p) => p.modules));
    for (const [name, v] of Object.entries(d.floors)) {
      if (!listed.has(name)) return `the floor for ${name} names no module of this release's packs`;
      if (typeof v !== 'string' || !STRICT.test(v)) return `the floor for ${name} is no strict MAJOR.MINOR.PATCH version`;
      const p = d.pins[name];
      if (p != null && belowFloor(p.version, v)) return `the pin for ${name} ${p.version} is below its floor ${v}`;
    }
  }
  return null;
}

// a version below its floor, by semver precedence (lib/semver-order.js: a
// pre-release comes before its version); what is not a version is below
// every floor (fail closed: the medium on the floors, 1)
function belowFloor(version, floor) {
  const c = require('./semver-order').compareVersions(version, floor);
  return c == null || c < 0;
}

const KNOWN_TOP = new Set(['v', 'release', 'self', 'shim', 'runtime', 'packs', 'modules', 'pins', 'floors']);
function laterFormat(d) {
  if (!isObject(d)) return false;
  if (typeof d.v === 'number' && Number.isInteger(d.v) && d.v > 2) return true;
  return d.v === 2 && Object.keys(d).some((k) => !KNOWN_TOP.has(k));
}

// a document (an object, or the bytes of one) -> {pins} (frozen) or {problem}
function parseReleasePins(input) {
  let doc = input;
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_BYTES) return {problem: `release-pins.json is over ${MAX_BYTES} bytes`};
    try {
      doc = JSON.parse(input.toString('utf8'));
    } catch (e) {
      return {problem: 'release-pins.json is not JSON'};
    }
  }
  const why = documentProblem(doc);
  // later: a format this ch-local doesn't know (a newer v, or a top-level key
  // it doesn't read), so a later ch-local reads it; a broken file is not
  // (the medium on the upgrade fix, A1)
  if (why != null) return {problem: `release-pins.json: ${why}`, later: laterFormat(doc)};
  return {pins: deepFreeze(JSON.parse(JSON.stringify(doc)))};
}

// What `next` adds over `now` that the user must see before it is
// installed (#413 section 9.3; docs/development/auto-upgrade.md, step 5),
// for the installed packs; any one holds an automatic upgrade back (section
// 9.6). now and next are pins-shaped: {packs: {<p>: {modules}}, modules:
// {<package>: description}} (the running release's, or the home's installed
// modules, each known only when verifiably the running release's pin:
// lib/installed-description.js). Anything
// removed, and a pack not installed, reports nothing.
// -> [{kind, key, packs, module, line, ...detail}], by pack, module, kind:
//   served      a pack the record has withdrawn that next lists again
//               (now.packs.<p>.withdrawn): its modules are added (one per pack)
//   module      a module added to an installed pack (one per pack)
//   unknown     an installed module now describes as null (not at its
//               verified pin: installed-description), so nothing it changes
//               can be judged: held, and every credential and call of the
//               new version listed, as for a new module
//   role        a part no longer one: {was: 'part', now}
//   credential  a credential destination new or changed: {variable, origin, was}
//   keyCaller   a module newly calls a module that holds a key: {callee}
//   confirm     a confirm setting lost its mark, or its default changed:
//               {setting, was: {default}, now: {default} | null}
// The module-level kinds come once per module, packs naming every installed
// pack that holds it (C's L4: never one line per pack).
const KINDS = ['served', 'module', 'unknown', 'role', 'credential', 'keyCaller', 'confirm'];
// a package's name without its scope
const short = (m) => String(m).replace(/^@[^/]+\//, '');
function additions(now, next, installed) {
  const {own} = require('./module-record');
  const out = [];
  const nowModules = (now && now.modules) || {};
  const packsOf = new Map();   // module -> installed packs that hold it in next
  for (const pack of installed) {
    if (!own(next.packs, pack)) continue;
    const had = own(now.packs, pack) ? now.packs[pack].modules : [];
    // a pack the record has withdrawn, listed again: served again, each of
    // its modules new to the running set (the Reviewer's high on L4, 4)
    if (own(now.packs, pack) && now.packs[pack].withdrawn === true) {
      out.push({kind: 'served', key: `served\0${pack}`, packs: [pack], module: '', line: `${pack} is served again: its modules start after the upgrade`});
    }
    for (const m of next.packs[pack].modules) {
      if (!packsOf.has(m)) packsOf.set(m, []);
      packsOf.get(m).push(pack);
      if (!had.includes(m)) out.push({kind: 'module', key: `module\0${pack}\0${m}`, packs: [pack], module: m, line: `a module in ${pack}: ${m}`});
    }
  }
  const S = JSON.stringify;
  for (const [m, packList] of packsOf) {
    const packs = [...packList].sort();
    const b = next.modules[m];
    const a = own(nowModules, m) ? nowModules[m] : null;
    // (installed, but its description unknown: one item, then on as for a
    // new module, so every credential and call of the new version is listed:
    // the medium on L4, 1; the Reviewer's high on L4, 2)
    if (own(nowModules, m) && a === null) {
      out.push({kind: 'unknown', key: `unknown\0${m}`, packs, module: m, line: `${short(m)} as installed can't be verified, so all of what this release has it do is listed`});
    }
    // a part no longer one: its settings, set at a terminal only until now,
    // can be changed in conversation (the Reviewer's high review of #98, 6)
    if (a != null && a.role === 'part' && b.role !== 'part') {
      out.push({kind: 'role', key: `role\0${m}`, packs, module: m, was: 'part', now: b.role, line: `${short(m)} is no longer a part: its settings can be changed in conversation`});
    }
    const was = a != null && a.credentials.length > 0 ? a.credentials[0] : null;
    for (const c of b.credentials) {
      // (field by field: the Reviewer's high review of #98, 9)
      if (require('./describe-module').sameCredential(was, c)) continue;
      out.push({kind: 'credential', key: `credential\0${m}\0${c.variable}@${c.origin}`, packs, module: m, variable: c.variable, origin: c.origin, was: was == null ? null : {variable: was.variable, origin: was.origin},
        line: was == null ? `${short(m)} sends a key (${c.variable}) to ${c.origin}` : `${short(m)}'s key goes to ${c.origin} as ${c.variable} (was ${was.origin} as ${was.variable})`});
    }
    for (const callee of b.calls) {
      const holds = own(next.modules, callee) && next.modules[callee].credentials.length > 0;
      if (!holds || (a != null && a.calls.includes(callee))) continue;
      out.push({kind: 'keyCaller', key: `keyCaller\0${m}\0${callee}`, packs, module: m, callee, line: `${short(m)} now calls ${short(callee)}, which holds a key`});
    }
    if (a == null) continue;
    for (const setting of Object.keys(a.confirmSettings).sort()) {
      const before = a.confirmSettings[setting];
      if (!own(b.confirmSettings, setting)) {
        out.push({kind: 'confirm', key: `confirm\0${m}\0${setting}`, packs, module: m, setting, was: {default: before}, now: null, line: `${short(m)}'s ${setting} is no longer marked confirm`});
      } else if (S(b.confirmSettings[setting]) !== S(before)) {
        const after = b.confirmSettings[setting];
        out.push({kind: 'confirm', key: `confirm\0${m}\0${setting}`, packs, module: m, setting, was: {default: before}, now: {default: after},
          line: `${short(m)}'s ${setting} (marked confirm) now defaults to ${S(after)} (was ${S(before)})`});
      }
    }
  }
  const order = (x) => [x.packs[0], x.module, KINDS.indexOf(x.kind), x.key];
  return out.sort((x, y) => { const p = order(x); const q = order(y); for (let i = 0; i < p.length; i++) { if (p[i] < q[i]) return -1; if (p[i] > q[i]) return 1; } return 0; });
}

// Identity changes from `now` to `next` (the review of #42): self, or an
// existing pin's repository, repository or owner ID, or workflow. One for
// self, the runtime, an installed pack's package or the shim blocks an
// automatic upgrade (a manual one shows it and asks); one for a pack the
// user has not installed only is named, since an automatic upgrade never
// installs that pack. -> {blocking: [line], named: [line]}
const IDENTITY = ['repository', 'repositoryId', 'ownerId', 'workflow'];
function identityChanges(now, next, installed) {
  const blocking = [];
  const named = [];
  for (const k of IDENTITY) if (now.self[k] !== next.self[k]) blocking.push(`self's ${k}: ${now.self[k]} -> ${next.self[k]}`);
  const packOf = (name) => Object.keys(next.packs).find((p) => next.packs[p].modules.includes(name));
  const mine = new Set([...next.runtime.packages, ...Object.values(next.shim.packages), ...installed.flatMap((p) => (next.packs[p] != null ? next.packs[p].modules : []))]);
  for (const [name, b] of Object.entries(next.pins)) {
    const a = now.pins[name];
    // a first pin for a name this install uses: who builds it is new, so it
    // blocks as an identity change does (the review of #48)
    if (a == null) {
      if (mine.has(name)) blocking.push(`${name}: pinned for the first time (${b.repository}, ${b.workflow})`);
      continue;
    }
    for (const k of IDENTITY) {
      if (a[k] === b[k]) continue;
      const line = `${name}'s ${k}: ${a[k]} -> ${b[k]}`;
      if (mine.has(name)) blocking.push(line);
      else named.push(`${line} (the pack ${packOf(name)}, not installed)`);
    }
  }
  return {blocking, named};
}

module.exports = {belowFloor, parseReleasePins, additions, identityChanges, modulesProblem, short, MAX_BYTES};
