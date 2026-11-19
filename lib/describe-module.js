'use strict';
// What the release pins say of a module (#413 section 9.3; L5b): from its
// own package.json, the credential its remote declares (variable and
// origin), the modules it calls (as package names), and each setting it
// marks confirm: true with that setting's default. One pure reader, used by
// the release step that writes the description (scripts/describe-release.js),
// by install's check that a fetched package matches it, and by the upgrade
// preview, so the three never judge a manifest differently.
//
// It describes; it does not allow. The store's binding says where a key may
// go, and the runtime checks calls and settings from the manifests it loads.
// The description exists so that a release can be compared with the one
// installed before anything is fetched, and so that what was shown is what
// is installed.
const store = require('./credential-store');

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const MAX_VARIABLE = 128;
// the roles the runtime knows (module-store roleOf): a scenario, a part
// (the medium on #98's high round, 10)
const ROLE = /^(?:scenario|part)$/;
// one credential the same as another: its variable and its origin
const sameCredential = (a, b) => a != null && b != null && a.variable === b.variable && a.origin === b.origin;

// {api.json of each package (or null)} -> {map: Map(friendly name ->
// package)} or {problem}: two packages with one name. A call names a module by the friendly name before its slash, as
// the runtime matches it (lib/availability.js callsOf).
function friendlyNames(apis) {
  const map = new Map();
  for (const [pkg, api] of Object.entries(apis)) {
    const name = isObject(api) && isObject(api.device) && typeof api.device.friendlyName === 'string' && api.device.friendlyName !== '' ? api.device.friendlyName : null;
    if (name == null) continue;   // no friendly name: nothing can call it
    if (map.has(name)) return {problem: `${name} is the friendly name of both ${map.get(name)} and ${pkg}`};
    map.set(name, pkg);
  }
  return {map};
}

// The credential, as lib/module-credentials.js declared() reads it: the one
// remote with a credential; its variable is the string form or {env}; its
// destination the origin of the remote's url. fallbackEnv is never described
// (section 6.1: never read).
// The one reader of a module's credential (the Reviewer's high review of
// #98, 2: install's description, the runtime binding and uninstall all read
// it here). remotes: countinghouse.remotes, a list -> {credential: null |
// {variable, origin, remote, fallback}} or {problem}. The string form
// ("credential": "GITHUB_TOKEN", 0.2.0's) and the object form ({env, ...})
// both name the variable; fallbackEnv is never the variable.
function credentialOf(remotes) {
  const withCredential = (Array.isArray(remotes) ? remotes : []).filter((r) => isObject(r) && r.credential != null);
  if (withCredential.length === 0) return {credential: null};
  if (withCredential.length > 1) return {problem: 'it declares more than one credential', code: 'multiple'};
  const r = withCredential[0];
  const variable = typeof r.credential === 'string' ? r.credential : (isObject(r.credential) ? r.credential.env : null);
  if (typeof variable !== 'string' || variable.length > MAX_VARIABLE || !store.VARIABLE.test(variable)) return {problem: 'its credential\'s variable cannot be read', code: 'variable'};
  let origin = null;
  try { origin = new URL(r.url).origin; } catch (err) { origin = null; }
  if (!store.isOrigin(origin)) return {problem: 'its credential\'s remote is not an https origin', code: 'origin'};
  const fallback = isObject(r.credential) && typeof r.credential.fallbackEnv === 'string' ? r.credential.fallbackEnv : null;
  return {credential: {variable, origin, remote: typeof r.name === 'string' ? r.name : null, fallback}};
}
function credentialsOf(remotes) {
  const c = credentialOf(remotes);
  if (c.problem != null) return c;
  return {list: c.credential == null ? [] : [{variable: c.credential.variable, origin: c.credential.origin}]};
}

// manifest: the package's package.json, parsed; friendly: Map(friendly name
// -> package) of the release's modules -> {credentials: [{variable,
// origin}], calls: [package], confirmSettings: {name: default | null}}, or
// {problem}
function describeModule(manifest, friendly) {
  if (!isObject(manifest)) return {problem: 'it has no package.json'};
  const ch = manifest.countinghouse == null ? {} : manifest.countinghouse;
  if (!isObject(ch)) return {problem: 'its countinghouse field is not an object'};
  if (ch.remotes != null && !Array.isArray(ch.remotes)) return {problem: 'its countinghouse.remotes is not a list'};
  if (ch.calls != null && !Array.isArray(ch.calls)) return {problem: 'its countinghouse.calls is not a list'};
  if (ch.settings != null && !isObject(ch.settings)) return {problem: 'its countinghouse.settings is not an object'};
  // its role, recorded: a part's settings are set at a terminal only, so a
  // module that stops being a part is an addition (the Reviewer's high
  // review of #98, 6)
  if (ch.role != null && (typeof ch.role !== 'string' || !ROLE.test(ch.role))) return {problem: 'its countinghouse.role is neither scenario nor part'};
  const role = ch.role == null ? null : ch.role;
  const cred = credentialsOf(ch.remotes || []);
  if (cred.problem != null) return {problem: cred.problem};
  const calls = new Set();
  for (const c of (ch.calls || [])) {
    if (typeof c !== 'string' || !c.includes('/')) continue;   // as the runtime: a call names module/action
    const name = c.slice(0, c.indexOf('/'));
    const pkg = friendly.get(name);
    // (unknownCall: the name, for install's check to tell this from a
    // manifest it cannot read: the medium on L5b, 2)
    if (pkg == null) return {problem: `it calls ${name}, which is no module of this release`, unknownCall: name};
    calls.add(pkg);
  }
  const confirmSettings = {};
  for (const name of Object.keys(ch.settings || {}).sort()) {
    const s = ch.settings[name];
    // confirm as the runtime rules it (countinghouse lib/module-settings.js
    // confirmRule): marked confirm, or any string setting (the medium on
    // L5b, 5)
    if (isObject(s) && (s.confirm === true || s.type === 'string')) confirmSettings[name] = Object.prototype.hasOwnProperty.call(s, 'default') ? s.default : null;
  }
  return {role, credentials: cred.list, calls: [...calls].sort(), confirmSettings};
}

// What differs between the pins' description and a package's: null, or the
// part, as install's refusal names it.
function describeProblem(want, got) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (want.role !== got.role) return 'its role';
  // field by field, never by serialisation (the Reviewer's high review of
  // #98, 9)
  if (want.credentials.length !== got.credentials.length || want.credentials.some((c, i) => !sameCredential(c, got.credentials[i]))) return 'its credential destination';
  if (!same(want.calls, got.calls)) return 'its calls';
  const names = [...new Set([...Object.keys(want.confirmSettings), ...Object.keys(got.confirmSettings)])].sort();
  for (const n of names) {
    const has = (o) => Object.prototype.hasOwnProperty.call(o, n);
    if (has(want.confirmSettings) !== has(got.confirmSettings) || !same(want.confirmSettings[n], got.confirmSettings[n])) return `its confirm setting ${n}`;
  }
  return null;
}

module.exports = {describeModule, friendlyNames, describeProblem, credentialOf, sameCredential, ROLE};
