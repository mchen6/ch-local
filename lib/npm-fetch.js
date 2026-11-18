'use strict';
// The registry fetch for upgrades from npm (docs/development/auto-upgrade.md,
// "The trust chain", step 2): a package's packument and one version's
// tarball, from https://registry.npmjs.org/ only.
// - The tarball URL must be the registry's own path for that name and
//   version, with nothing after it, on the registry's origin. Anything else is
//   NOT_ON_REGISTRY, and nothing is fetched.
// - dist.integrity must be a sha512 (NO_SHA512 otherwise), and the tarball's
//   own sha512 must equal it (INTEGRITY_MISMATCH).
// - With a pin ({version, integrity}), the pin must name that version and
//   integrity, or it is PIN_MISMATCH before the tarball is fetched.
// - Every answer is bounded: a packument at most 16 MB, a tarball at most
//   50 MB (FETCH_TOO_LARGE), and each fetch 15 s or 60 s (FETCH_FAILED, as is
//   a failed connection or an error status).
// Each failure is an Error with one of those codes, which the announcements
// name. Nothing here runs or unpacks what it fetches.

const REGISTRY = 'https://registry.npmjs.org/';
const PACKUMENT_MAX = 16 * 1024 * 1024;
const TARBALL_MAX = 50 * 1024 * 1024;
const ATTESTATIONS_MAX = 1024 * 1024;
const PACKUMENT_MS = 15000;
const TARBALL_MS = 60000;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

const failure = (code, message) => Object.assign(new Error(message), {code});

// The registry is always registry.npmjs.org. A test's fake one reaches these
// functions only as their `registry` argument, passed by the test's own code:
// no variable, argument or file selects another (docs/development/
// auto-upgrade.md, "Development overrides never reach a real upgrade").

// body of a fetch, at most maxBytes, within the AbortController's time
async function readBounded(res, maxBytes, what) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw failure('FETCH_TOO_LARGE', `${what} is ${declared} bytes, over ${maxBytes}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw failure('FETCH_TOO_LARGE', `${what} is over ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// GET url -> its bytes, bounded in size and time
async function get(url, io, {maxBytes, timeoutMs, accept, what}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await io.fetch(url, {headers: accept != null ? {accept} : {}, signal: abort.signal, redirect: 'error'});
    } catch (e) {
      throw failure('FETCH_FAILED', `${what} could not be fetched (${abort.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : (e.cause && e.cause.code) || e.message})`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw failure('FETCH_FAILED', `the registry answered ${res.status} for ${what}`);
    try {
      return await readBounded(res, maxBytes, what);
    } catch (e) {
      if (e.code === 'FETCH_TOO_LARGE') throw e;
      throw failure('FETCH_FAILED', `${what} could not be read (${abort.signal.aborted ? `no answer in ${timeoutMs / 1000} s` : e.message})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const encoded = (name) => name.replace('/', '%2F');

// name -> its packument (JSON), or null when the registry has no such package
async function packument(name, io, {registry = REGISTRY, maxBytes = PACKUMENT_MAX, timeoutMs = PACKUMENT_MS} = {}) {
  const body = await get(`${registry}${encoded(name)}`, io, {maxBytes, timeoutMs, accept: 'application/json', what: `${name}'s packument`});
  if (body == null) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (e) {
    throw failure('FETCH_FAILED', `${name}'s packument is not JSON`);
  }
}

// name@version's attestations (provenance, lib/provenance.js), as JSON, at
// most 1 MB -> the document, or null when the registry has none
async function attestations(name, version, io, {registry = REGISTRY, maxBytes = ATTESTATIONS_MAX, timeoutMs = PACKUMENT_MS} = {}) {
  const body = await get(`${registry}-/npm/v1/attestations/${encoded(name)}@${version}`, io, {maxBytes, timeoutMs, accept: 'application/json', what: `${name}@${version}'s attestations`});
  if (body == null) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (e) {
    throw failure('FETCH_FAILED', `${name}@${version}'s attestations are not JSON`);
  }
}

// the registry's own tarball URL for name@version
const tarballUrl = (registry, name, version) => `${registry}${name}/-/${name.split('/').pop()}-${version}.tgz`;

// name@version's tarball -> {bytes, integrity}. pin: {version, integrity},
// when this ch-local's pins name the package.
async function fetchTarball(name, version, io, {registry = REGISTRY, pin = null, maxBytes = TARBALL_MAX, timeoutMs = TARBALL_MS} = {}) {
  const doc = await packument(name, io, {registry});
  const entry = doc != null && doc.versions != null && Object.prototype.hasOwnProperty.call(doc.versions, version) ? doc.versions[version] : null;
  if (entry == null || entry.dist == null) throw failure('NOT_PUBLISHED', `${name}@${version} is not on the registry`);
  const {tarball, integrity} = entry.dist;
  if (tarball !== tarballUrl(registry, name, version)) throw failure('NOT_ON_REGISTRY', `${name}@${version} is not served from ${registry}`);
  if (typeof integrity !== 'string' || !SHA512.test(integrity)) throw failure('NO_SHA512', `${name}@${version} has no sha512 integrity on the registry`);
  if (pin != null && (pin.version !== version || pin.integrity !== integrity)) {
    throw failure('PIN_MISMATCH', `${name}@${version} on the registry is not the one this ch-local pins`);
  }
  const bytes = await get(tarball, io, {maxBytes, timeoutMs, what: `${name}@${version}'s tarball`});
  if (bytes == null) throw failure('NOT_PUBLISHED', `${name}@${version}'s tarball is not on the registry`);
  const got = require('./integrity').integrityOf(bytes);
  if (got !== integrity) throw failure('INTEGRITY_MISMATCH', `${name}@${version} did not match its integrity`);
  return {bytes, integrity};
}

module.exports = {REGISTRY, PACKUMENT_MAX, TARBALL_MAX, ATTESTATIONS_MAX, packument, fetchTarball, attestations, tarballUrl};
