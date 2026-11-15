'use strict';
// Whether there is a newer ch-local to upgrade to, and what it pins
// (docs/development/auto-upgrade.md, "The trust chain", steps 1-5):
// 1. the registry's `latest` @countinghouse/ch-local, considered only if it
//    is strict MAJOR.MINOR.PATCH, newer by precedence than the installed
//    one, and of the same major (a major is announced, never installed
//    here);
// 2-3. its tarball, fetched with no pin to hold it to, checked by its
//    provenance against the INSTALLED release's own identity (self) and the
//    tag v<version>;
// 4. its digest, so verified, is its pin, held in memory;
// 5. its lib/release-pins.json, read from those verified bytes in memory
//    (lib/tar.js readMember: nothing written, nothing of it run), parsed as
//    this release's own is; a release that changes self is refused, and
//    what it adds that needs the user's yes (lib/release-pins.js additions)
//    is listed.
// The registry and trust are only ever a test's own arguments.
const npmFetch = require('./npm-fetch');
const provenance = require('./provenance');
const {readMember} = require('./tar');
const {parseReleasePins, additions} = require('./release-pins');

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

// a release's parsed pins and version -> the allow object install takes
function releaseAllow(data, version) {
  return {release: {version, security: data.release.security}, self: data.self, runtime: data.runtime, packs: data.packs, pins: data.pins};
}

// {data (the installed release's parsed pins), installed (its version),
//  packs (the installed packs' names), io, registry?, trust?} ->
//  {kind: 'up-to-date'} | {kind: 'major', to} |
//  {kind: 'available', to, data, adds, integrity, publishedAt, builtAt}
async function findUpgrade({data, installed, packs, io, registry = npmFetch.REGISTRY, trust = null}) {
  const doc = await npmFetch.packument(SELF, io, {registry});
  const latest = doc != null && doc['dist-tags'] != null ? doc['dist-tags'].latest : null;
  if (!newer(latest, installed)) return {kind: 'up-to-date'};
  if (parts(latest)[0] !== parts(installed)[0]) return {kind: 'major', to: latest};
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
  if (parsed.problem != null) throw failure('RELEASE_PINS', `${SELF}@${latest}: ${parsed.problem}`);
  if (JSON.stringify(parsed.pins.self) !== JSON.stringify(data.self)) {
    throw failure('SELF_CHANGED', `${SELF}@${latest} names another identity for itself: only a hand install takes it`);
  }
  return {kind: 'available', to: latest, data: parsed.pins, adds: additions(data, parsed.pins, packs), integrity,
    publishedAt: times.publishedAt, builtAt: times.builtAt};
}

module.exports = {findUpgrade, releaseAllow, newer, SELF};
