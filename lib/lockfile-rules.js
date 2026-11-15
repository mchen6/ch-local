'use strict';
// The runtime lockfile's rules (the review of #42), one set for a released
// lockfile and for --unreleased-pins, since npm ci acts on what it says:
// - npm's v3 form: packages, and no legacy dependencies tree;
// - every key node_modules/<name>(/node_modules/<name>)*, scoped names
//   included, and no entry with a link key of any value (npm tests it for
//   truthiness; the re-check of #42);
// - a runtime package (ch-local, countinghouse) from its own tarball in the
//   release directory, file:tarballs/<name>, at its pinned version, with its
//   pin's integrity: always, since npm ci installs whatever tarball is there
//   when the entry has none (the re-check of #42);
// - every other entry from https://registry.npmjs.org/ with a sha512, so npm
//   ci checks it: its resolved a plain URL on that origin, one that is
//   already normalized (no .., nothing that resolves elsewhere), and nothing
//   from git or another host;
// - an entry bundled inside a runtime package's tarball is exempt only when
//   its parent really bundles it, since npm acts on the parent's
//   bundleDependencies, not the entry's own inBundle flag. That means no
//   resolved and no link; beneath a runtime package's own node_modules; that
//   package's lockfile entry listing the first name beneath it in
//   bundleDependencies; and, when the tarballs are given, the package's
//   verified tarball holding node_modules/<path>/package.json.
const {tarballName} = require('./unpack');
const {readMember} = require('./tar');

const REGISTRY = 'https://registry.npmjs.org/';
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
// a package name, scoped or not: no leading . or _, no path separator
const NAME = '(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*';
const KEY = new RegExp(`^node_modules/${NAME}(?:/node_modules/${NAME})*$`);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// a registry tarball URL: https on registry.npmjs.org, as given already the
// URL it parses to
function onRegistry(resolved) {
  if (typeof resolved !== 'string') return false;
  let u;
  try { u = new URL(resolved); } catch (e) { return false; }
  return u.origin === new URL(REGISTRY).origin && u.href === resolved && u.username === '' && u.password === '' && resolved.startsWith(REGISTRY);
}
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

// the runtime package an entry is bundled beneath, and its path below that
// package -> {parent, below: ['@sigstore/verify', ...], first} or null
function bundledBeneath(key, runtime) {
  for (const parent of runtime) {
    const prefix = `node_modules/${parent}/node_modules/`;
    if (!key.startsWith(prefix)) continue;
    const below = key.slice(prefix.length);
    const first = below.startsWith('@') ? below.split('/').slice(0, 2).join('/') : below.split('/')[0];
    return {parent, below, first};
  }
  return null;
}

// lockfile, {runtime: [names], pins: {name: {version, integrity}}, tarballs?:
// {name: Buffer}} -> null, or what is wrong
function lockfileProblem(lockfile, {runtime, pins, tarballs = null}) {
  if (!isObject(lockfile) || lockfile.lockfileVersion !== 3 || !isObject(lockfile.packages) || lockfile.dependencies !== undefined) {
    return 'the runtime lockfile must be an npm v3 lockfile (lockfileVersion 3, packages, and no dependencies tree)';
  }
  const entries = lockfile.packages;
  for (const [key, entry] of Object.entries(entries)) {
    if (key === '') continue;
    if (!isObject(entry)) return `the runtime lockfile's ${key} is not an entry`;
    if (!KEY.test(key)) return `the runtime lockfile's ${JSON.stringify(key)} is not a node_modules path`;
    if (own(entry, 'link')) return `the runtime lockfile links ${key}; nothing may be linked`;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (key === `node_modules/${name}` && runtime.includes(name)) {
      const pin = pins[name];
      const want = pin == null ? null : `file:tarballs/${tarballName(name, pin.version)}`;
      if (pin == null || entry.resolved !== want) return `the runtime lockfile resolves ${name} from ${JSON.stringify(entry.resolved)}, not its tarball ${want}`;
      if (entry.version !== pin.version) return `the runtime lockfile has ${name} at version ${entry.version}, not its pinned ${pin.version}`;
      if (entry.integrity !== pin.integrity) return `the runtime lockfile's integrity for ${name} is not its pin's`;
      continue;
    }
    if (entry.inBundle === true) {
      const at = bundledBeneath(key, runtime);
      const parent = at != null ? entries[`node_modules/${at.parent}`] : null;
      if (at == null || entry.resolved !== undefined || parent == null || !Array.isArray(parent.bundleDependencies) || !parent.bundleDependencies.includes(at.first)) {
        return `the runtime lockfile's ${key} says it is bundled, but no runtime package's lockfile entry bundles it (npm would fetch it)`;
      }
      if (tarballs != null) {
        const bytes = tarballs[at.parent];
        let member = null;
        try { member = bytes != null ? readMember(bytes, `node_modules/${at.below}/package.json`, {}, {bundled: true}) : null; } catch (e) { member = null; }
        if (member == null) return `the runtime lockfile's ${key} is bundled by ${at.parent}, but not in the tarball`;
      }
      continue;
    }
    if (!onRegistry(entry.resolved) || typeof entry.integrity !== 'string' || !SHA512.test(entry.integrity)) {
      return `the runtime lockfile's ${key} must come from ${REGISTRY} with a sha512 integrity`;
    }
  }
  return null;
}

module.exports = {lockfileProblem};
