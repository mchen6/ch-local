'use strict';
// The native shim for this platform (agreed with A and the Reviewer): the
// one @countinghouse/ch-shim-<os>-<arch> a release's shim.packages names for
// ${platform}-${arch}, fetched by its pin from the registry
// (lib/npm-fetch.js), checked by its provenance (lib/provenance.js
// verifyRelease: shim.yml, shim-v<version>), unpacked by the strict tar
// reader, and its binary put at <home>/shim/ch-shim (ch-shim.exe on
// Windows), 0755, in <home>/shim (0700; an owner-only DACL on Windows).
// - No shim for the platform: 'unsupported'; none pinned in this release:
//   'unpinned'. Nothing is fetched, and the platform runs the per-session
//   mode, as today.
// - The binary goes in by renames: the new one written beside it, the one
//   there moved to ch-shim.previous (Windows renames a running executable,
//   but won't overwrite one), then the new one renamed into place.
//   swapShim swaps the two back, for rollback.
// - Anything refused places nothing.
// Only a test's own code passes a fake registry and trust, as the rest of
// the arguments, which go on untouched.
const fs = require('node:fs');
const path = require('node:path');
const npmFetch = require('./npm-fetch');
const provenance = require('./provenance');
const {extractPackage} = require('./tar');

const failure = (code, message) => Object.assign(new Error(message), {code});
const exe = (platform) => (platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
const previousName = (platform) => (platform === 'win32' ? 'ch-shim.previous.exe' : 'ch-shim.previous');

function privateDir(dir, platform) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (platform === 'win32') {
    const winAcl = require('./win-acl');
    const [acl] = winAcl.makePrivateDirs([dir], [dir]);
    const why = winAcl.privateProblem(dir, acl, {directory: true});
    if (why != null) throw failure('SHIM_DIR', why);
  } else {
    fs.chmodSync(dir, 0o700);
  }
}

// {home, data (parsed release pins), io, platform, arch, ...fromNpm} ->
// {status: 'installed', path, version} | {status: 'unsupported' | 'unpinned'}
async function installShim({home, data, io, platform = process.platform, arch = process.arch, ...fromNpm}) {
  const key = `${platform}-${arch}`;
  const name = Object.prototype.hasOwnProperty.call(data.shim.packages, key) ? data.shim.packages[key] : null;
  if (name == null) return {status: 'unsupported'};
  const pin = data.pins[name];
  if (pin == null) return {status: 'unpinned', package: name};
  const {bytes} = await npmFetch.fetchTarball(name, pin.version, io, Object.assign({pin}, fromNpm));
  const attestations = await npmFetch.attestations(name, pin.version, io, fromNpm);
  provenance.verifyRelease(Object.assign({name, version: pin.version, pin, attestations}, fromNpm));

  const dir = path.join(home, 'shim');
  privateDir(dir, platform);
  const stage = path.join(dir, `.stage-${process.pid}-${Date.now()}`);
  const target = path.join(dir, exe(platform));
  const temp = path.join(dir, `.${exe(platform)}.${process.pid}.tmp`);
  try {
    try {
      extractPackage(bytes, stage);
    } catch (e) {
      throw failure('SHIM_TARBALL', `${name}@${pin.version}'s tarball was refused (${e.message})`);
    }
    const binary = path.join(stage, 'bin', exe(platform));
    if (!fs.existsSync(binary)) throw failure('SHIM_NO_BINARY', `${name}@${pin.version} holds no bin/${exe(platform)}`);
    fs.copyFileSync(binary, temp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temp, 0o755);
    const previous = path.join(dir, previousName(platform));
    if (fs.existsSync(target)) {
      fs.rmSync(previous, {force: true});
      fs.renameSync(target, previous);
    }
    try {
      fs.renameSync(temp, target);
    } catch (e) {
      // the one there goes back
      if (fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target);
      throw e;
    }
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
    fs.rmSync(temp, {force: true});
  }
  return {status: 'installed', path: target, version: pin.version};
}

// rollback: the shim and the one before it swap places, by renames ->
// whether there were two to swap
function swapShim(home, {platform = process.platform} = {}) {
  const dir = path.join(home, 'shim');
  const target = path.join(dir, exe(platform));
  const previous = path.join(dir, previousName(platform));
  if (!fs.existsSync(target) || !fs.existsSync(previous)) return false;
  const aside = path.join(dir, `.swap-${process.pid}-${Date.now()}`);
  fs.renameSync(target, aside);
  try {
    fs.renameSync(previous, target);
  } catch (e) {
    fs.renameSync(aside, target);
    throw e;
  }
  fs.renameSync(aside, previous);
  return true;
}

// rollback, by the two releases' records: kept (the release left) and
// restored (the one coming back), each its shim {version} or null. Both with
// a shim of other versions: swapped; only the kept one had one: set aside as
// ch-shim.previous (the restored release runs per session); only the
// restored one: put back from ch-shim.previous; otherwise nothing moves.
function alignShim(home, {kept, restored, platform = process.platform}) {
  const dir = path.join(home, 'shim');
  const target = path.join(dir, exe(platform));
  const previous = path.join(dir, previousName(platform));
  const had = kept != null;
  const want = restored != null;
  if (had && want) { if (kept.version !== restored.version) swapShim(home, {platform}); return; }
  if (had && !want) { if (fs.existsSync(target)) { fs.rmSync(previous, {force: true}); fs.renameSync(target, previous); } return; }
  if (!had && want) { if (fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target); }
}

module.exports = {installShim, swapShim, alignShim};
