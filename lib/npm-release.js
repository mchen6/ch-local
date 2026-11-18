'use strict';
// A release's packages from npm (docs/development/auto-upgrade.md, "The trust
// chain", steps 2-7), for install with no --from and for upgrades.
// - Each package but ch-local is fetched at its pinned version and must match
//   its pin (lib/npm-fetch.js), then pass its provenance against the pin's
//   identity (lib/provenance.js).
// - ch-local itself can't be pinned by its own release: it is fetched at the
//   release's version, and its provenance, against release-pins.json's self
//   identity and the tag v<version>, is its only anchor. The digest so
//   verified becomes its pin, held in memory.
// - Nothing is written until every package has passed. Then each checked
//   tarball goes into `dir` under its release name, for install's
//   loadTarballs, which re-reads each one against these pins.
// - The runtime lockfile is copied with ch-local's entry filled in from that
//   digest (the lockfile is inside ch-local's tarball, so it can't carry it).
//   The copy is held to lib/lockfile-rules.js, the rules --unreleased-pins
//   uses too, with the verified tarballs (the review of #42).
// Each failure is an Error with a code, and `package` naming the one at fault.
const fs = require('node:fs');
const path = require('node:path');
const npmFetch = require('./npm-fetch');
const provenance = require('./provenance');
const {tarballName} = require('./unpack');
const {lockfileProblem} = require('./lockfile-rules');

const SELF = '@countinghouse/ch-local';
// the runtime's packages, whose verified tarballs cover what they bundle
const RUNTIME = [SELF, 'countinghouse'];
const STRICT = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

const failure = (code, message, pkg = null) => Object.assign(new Error(message), {code}, pkg != null ? {package: pkg} : {});

// the runtime lockfile, with ch-local's entry's integrity -> a copy, held to
// lib/lockfile-rules.js against the pins and the verified tarballs; null
// stays null (no release has made one yet)
function fillLockfile(lockfile, selfIntegrity, {pins, tarballs = null}) {
  if (lockfile == null) return null;
  const copy = JSON.parse(JSON.stringify(lockfile));
  const selfKey = `node_modules/${SELF}`;
  if (copy.packages == null || copy.packages[selfKey] == null) throw failure('LOCKFILE_INTEGRITY', `the runtime lockfile has no entry for ${SELF}`);
  copy.packages[selfKey].integrity = selfIntegrity;
  const why = lockfileProblem(copy, {runtime: RUNTIME, pins, tarballs});
  if (why != null) throw failure('LOCKFILE_INTEGRITY', why);
  return copy;
}

// {data (parsed release pins), version (ch-local's), names, dir, io,
//  registry?, trust?} -> {pins (with ch-local's), lockfile, published: {name: Date}}
// registry and trust: only a test's own code passes them.
// verifiedSelf: an upgrade's ch-local, already fetched and checked by its
// provenance (lib/npm-upgrade.js), {version, bytes, integrity, publishedAt,
// identity: the INSTALLED release's self}: installed as given, never fetched
// again, so the bytes its pins were read from are the bytes installed.
async function fetchRelease({data, version, names, dir, io, registry = npmFetch.REGISTRY, trust = null, verifiedSelf = null}) {
  if (names.includes(SELF) && (typeof version !== 'string' || !STRICT.test(version))) {
    throw failure('NOT_STRICT', `${SELF}'s version ${JSON.stringify(version)} is not strict MAJOR.MINOR.PATCH`, SELF);
  }
  for (const name of names) {
    if (name !== SELF && data.pins[name] == null) throw failure('NOT_PINNED', `no pin names ${name} in this release`, name);
  }
  const pins = Object.assign({}, data.pins);
  const fetched = {};
  const published = {};
  for (const name of names) {
    const own = name === SELF;
    const at = own ? version : data.pins[name].version;
    if (own && verifiedSelf != null) {
      if (verifiedSelf.version !== version) throw failure('SELF_MISMATCH', `the verified ${SELF} is ${verifiedSelf.version}, not ${version}`, SELF);
      const got = require('./integrity').integrityOf(verifiedSelf.bytes);
      if (got !== verifiedSelf.integrity) throw failure('INTEGRITY_MISMATCH', `the verified ${SELF}'s bytes are not its integrity`, SELF);
      fetched[name] = verifiedSelf.bytes;
      pins[name] = Object.assign({version, integrity: verifiedSelf.integrity}, verifiedSelf.identity, {tag: `v${version}`});
      published[name] = verifiedSelf.publishedAt;
      continue;
    }
    try {
      // ch-local: no pin to hold its fetch to; its provenance decides
      const {bytes, integrity} = await npmFetch.fetchTarball(name, at, io, {registry, pin: own ? null : data.pins[name]});
      const pin = own ? Object.assign({version: at, integrity}, data.self, {tag: `v${at}`}) : data.pins[name];
      const attestations = await npmFetch.attestations(name, at, io, {registry});
      const times = provenance.verifyRelease({name, version: at, pin, attestations, trust});
      fetched[name] = bytes;
      pins[name] = pin;
      published[name] = times.publishedAt;
    } catch (e) {
      throw Object.assign(e, {package: name});
    }
  }
  // the runtime's lockfile, when the runtime is among them (a pack alone
  // needs none), checked before anything is written
  const lockfile = names.includes(SELF) ? fillLockfile(data.runtime.lockfile, pins[SELF].integrity, {pins, tarballs: fetched}) : null;
  // all passed: only now is anything written
  fs.mkdirSync(dir, {recursive: true});
  for (const name of names) fs.writeFileSync(path.join(dir, tarballName(name, pins[name].version)), fetched[name], {flag: 'wx'});
  return {pins, lockfile, published};
}

module.exports = {fetchRelease, fillLockfile, SELF};
