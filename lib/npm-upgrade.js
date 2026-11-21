'use strict';
// Whether there is a newer ch-local to upgrade to, and what it pins
// (docs/development/auto-upgrade.md, "The trust chain", steps 1-5):
// 1. the registry's `latest` @countinghouse/ch-local, considered only if it
//    is strict MAJOR.MINOR.PATCH and newer by precedence than the installed
//    one. Another major is {kind: 'major'}, fetched no further, unless
//    allowMajor (ch-local upgrade, the Reviewer's ruling on #48): then it is
//    checked exactly as any other (provenance, pins, identity changes and
//    additions) and returned as available with major: true. The automatic
//    upgrade never passes it;
// 2-3. its tarball, fetched with no pin to hold it to, checked by its
//    provenance against the INSTALLED release's own identity (self) and the
//    tag v<version>;
// 4. its digest, so verified, is its pin, held in memory;
// 5. its lib/release-pins.json, read from those verified bytes in memory
//    (lib/tar.js readMember: nothing written, nothing of it run), parsed as
//    this release's own is; what it adds that needs the user's yes
//    (additions), and its identity changes, which block an automatic
//    upgrade (identityChanges), are listed.
// A 0.x minor (0.1 -> 0.2) or a 0.0.x patch is `breaking`: under semver
// either may break, so the automatic upgrade treats it as a major (the
// Reviewer's ruling on #48); ch-local upgrade shows it so and asks.
// The registry and trust are only ever a test's own arguments.
const npmFetch = require('./npm-fetch');
const provenance = require('./provenance');
const {readMember} = require('./tar');
const {parseReleasePins, additions, identityChanges} = require('./release-pins');

const SELF = '@countinghouse/ch-local';
const STRICT = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

const failure = (code, message) => Object.assign(new Error(message), {code});
const parts = (v) => v.split('.').map(Number);

// a newer than b, both strict MAJOR.MINOR.PATCH; anything else is never newer
function newer(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !STRICT.test(a) || !STRICT.test(b)) return false;
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// a release's parsed pins and version -> the allow object install takes.
// found and installedSelf: an upgrade's verified ch-local (findUpgrade's
// bytes, integrity and publish time) and the INSTALLED release's self, so
// install installs those same bytes (lib/npm-release.js verifiedSelf).
function releaseAllow(data, version, {found = null, installedSelf = null} = {}) {
  const allow = {release: {version, security: data.release.security}, self: data.self, runtime: data.runtime, packs: data.packs, modules: data.modules, pins: data.pins};
  if (found != null) {
    allow.verifiedSelf = {version, bytes: found.bytes, integrity: found.integrity, publishedAt: found.publishedAt, identity: installedSelf};
  }
  return allow;
}

// {data (the installed release's parsed pins), installed (its version),
//  packs (the installed packs' names), io, registry?, trust?} ->
//  {kind: 'up-to-date'} | {kind: 'major', to} |
//  {kind: 'available', to, data, additions, adds, integrity, publishedAt, builtAt}
// remembered(version): a version an automatic upgrade already refused under
// this root, not fetched or checked again -> {kind: 'remembered', to}
// now: what the home has installed, pins-shaped (lib/installed-description.js:
// the record, each module described from the store), the baseline additions
// are judged against (#413 rev 3 section 9.3; L4); identity stays the pins'
async function findUpgrade({data, now = data, installed, packs, io, registry = npmFetch.REGISTRY, trust = null, remembered = () => false, allowMajor = false}) {
  const doc = await npmFetch.packument(SELF, io, {registry});
  const latest = doc != null && doc['dist-tags'] != null ? doc['dist-tags'].latest : null;
  if (!newer(latest, installed)) return {kind: 'up-to-date'};
  const major = parts(latest)[0] !== parts(installed)[0];
  if (major && allowMajor !== true) return {kind: 'major', to: latest};
  if (remembered(latest)) return {kind: 'remembered', to: latest};
  try {
    return Object.assign(await check(data, latest, packs, io, registry, trust, installed, now), {major});
  } catch (e) {
    // which version failed, for the announcement and the history record
    throw Object.assign(e, {package: SELF, version: latest});
  }
}

// a 0.x minor or a 0.0.x patch change, from installed to latest
function breaking(latest, installed) {
  const [x, y] = [parts(latest), parts(installed)];
  if (x[0] !== 0 || y[0] !== 0) return false;
  return x[1] !== y[1] || (x[1] === 0 && x[2] !== y[2]);
}

// the Claude Code plugin's manifest in a ch-local package, and its version:
// a plain x.y.z, or null (none, unreadable, or anything else)
const PLUGIN_MANIFEST = 'clients/claude-code/.claude-plugin/plugin.json';
function pluginVersionOf(read) {
  try {
    const text = read();
    if (text == null) return null;
    const v = JSON.parse(String(text)).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch (e) { return null; }
}

async function check(data, latest, packs, io, registry, trust, installed, now = data) {
  const {bytes, integrity} = await npmFetch.fetchTarball(SELF, latest, io, {registry, pin: null});
  const attestations = await npmFetch.attestations(SELF, latest, io, {registry});
  const times = provenance.verifyRelease({name: SELF, version: latest, attestations, trust,
    pin: Object.assign({version: latest, integrity}, data.self, {tag: `v${latest}`})});
  let member;
  try {
    member = readMember(bytes, 'lib/release-pins.json');
  } catch (e) {
    throw failure('RELEASE_PINS', `${SELF}@${latest}'s tarball could not be read (${e.message})`);
  }
  if (member == null) throw failure('RELEASE_PINS', `${SELF}@${latest} carries no lib/release-pins.json`);
  const parsed = parseReleasePins(member);
  // its Claude Code plugin's version (clients/claude-code/.claude-plugin/
  // plugin.json in the same verified bytes; absent or unreadable: null), for
  // upgrade's plugin step (A-own-skill's easy upgrades)
  const plugin = pluginVersionOf(() => readMember(bytes, PLUGIN_MANIFEST));
  if (parsed.problem != null) throw failure('RELEASE_PINS', `${SELF}@${latest}: ${parsed.problem}`);
  // identity changes (self's, a pin's) block an automatic upgrade; a manual
  // one shows them and asks (the review of #42)
  const identity = identityChanges(data, parsed.pins, packs);
  // additions: the items (lib/release-pins.js: kind, key, packs, module,
  // line, ...); adds: their lines, as upgrade and the automatic upgrade show
  // them (C's L4 shows the items in its preview)
  // (now may be a function: the home's description, read only here, once a
  // release is found: the medium on L4, 8)
  const adds = additions(typeof now === 'function' ? now() : now, parsed.pins, packs);
  return {kind: 'available', to: latest, plugin, breaking: breaking(latest, installed), data: parsed.pins, additions: adds, adds: adds.map((x) => x.line), identity: identity.blocking, named: identity.named, integrity, bytes,
    publishedAt: times.publishedAt, builtAt: times.builtAt};
}

module.exports = {findUpgrade, releaseAllow, newer, breaking, SELF, pluginVersionOf, PLUGIN_MANIFEST};
