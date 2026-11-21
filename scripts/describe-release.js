'use strict';
// The release step that describes each module (#413 section 9.3; L5b):
// from the release's own tarballs, it writes lib/release-pins.json's
// packs.<p>.modules and modules.<package> (lib/describe-module.js), so the
// descriptions are never written by hand.
//
//   node scripts/describe-release.js <directory of tarballs> [--check]
//   node scripts/describe-release.js <directory of tarballs> --unreleased-pins <file> [--check]
//
// The directory holds one .tgz per module of every pack the file lists
// (npm pack's names). Each tarball's package.json and api.json are read in
// memory (lib/tar.js readMembers), nothing unpacked. The packs and what they
// hold come from the file: the step never adds a pack, and refuses a module
// with no tarball, a tarball no pack lists, two tarballs of one module, a
// tarball whose version is not its pin (where the file pins it), and any
// module that cannot be described.
//
// It writes the descriptions only. Never the pins (versions, integrities,
// identities: the maintainer's release gating writes those), never a tag,
// never a publish.
//
// --unreleased-pins <file>: a development pins file (lib/pins.js), which
// carries its own descriptions of the pack modules it pins (the Reviewer on
// L5b, Q2), checked at install as a release's are. Its packs are the
// release's; the directory holds a tarball of each module it pins.
// --check: writes nothing; exits 1 when the file's descriptions differ from
// the tarballs'.
const fs = require('node:fs');
const path = require('node:path');
const {readMembers} = require('../lib/tar');
const {describeModule, friendlyNames} = require('../lib/describe-module');
const {belowFloor, modulesProblem, parseReleasePins} = require('../lib/release-pins');

const root = path.resolve(__dirname, '..');
const RELEASE_PINS = path.join(root, 'lib', 'release-pins.json');

class StepError extends Error {}
const refuse = (why) => { throw new StepError(why); };

// -> {<package>: {version, manifest, api}} from every .tgz in dir, or with
// only ({package: version}) from those packages' tarballs alone, by npm
// pack's file name, before any is opened: a directory install's --from
// holds also has the runtime's and ch-local's, which bundles what the strict
// reader refuses (the Reviewer's high review of #98, 1)
function readTarballs(dir, {only = null} = {}) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort(); } catch (err) { refuse(`cannot read ${dir} (${err.code})`); }
  if (only != null) {
    const wanted = new Set(Object.entries(only).map(([name, version]) => require('../lib/unpack').tarballName(name, version)));
    files = files.filter((f) => wanted.has(f));
  }
  const out = {};
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    // (both members from one read of the archive)
    let members;
    try { members = readMembers(buf, ['package.json', 'api.json']); } catch (err) { refuse(`${f}: ${err.message}`); }
    const json = (member) => {
      const b = members[member];
      if (b == null) return null;
      try { return JSON.parse(b.toString('utf8')); } catch (err) { refuse(`${f}: its ${member} is not JSON`); }
    };
    const manifest = json('package.json');
    if (manifest == null || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') refuse(`${f}: it has no package.json with a name and a version`);
    if (Object.prototype.hasOwnProperty.call(out, manifest.name)) refuse(`${f}: a second tarball of ${manifest.name}`);
    out[manifest.name] = {file: f, version: manifest.version, manifest, api: json('api.json')};
  }
  return out;
}

// release: the release's pins document (its packs); pins: the pins to hold
// each tarball's version to (the release's, or the development file's);
// tarballs: readTarballs' -> {packs, modules}
// only: describe only the pack modules pins names (a development file)
function describeRelease(release, pins, tarballs, {only = false} = {}) {
  const listed = [...new Set(Object.values(release.packs).flatMap((p) => p.modules || p.packages))].filter((m) => !only || pins[m] != null).sort();
  for (const m of listed) if (tarballs[m] == null) refuse(`no tarball of ${m}, a module of this release`);
  for (const [m, t] of Object.entries(tarballs)) {
    if (!listed.includes(m)) refuse(`${t.file}: ${m} is no module of this release's packs`);
    if (pins[m] != null && pins[m].version !== t.version) refuse(`${t.file}: ${m} ${t.version} is not its pin (${pins[m].version})`);
    // (the release's floor: no release is described from a part below it)
    const floor = release.floors != null ? release.floors[m] : undefined;
    if (floor != null && belowFloor(t.version, floor)) refuse(`${t.file}: ${m} ${t.version} is below its floor ${floor}`);
  }
  const friendly = friendlyNames(Object.fromEntries(listed.map((m) => [m, tarballs[m].api])));
  if (friendly.problem != null) refuse(friendly.problem);
  const modules = {};
  for (const m of listed) {
    const d = describeModule(tarballs[m].manifest, friendly.map);
    if (d.problem != null) refuse(`${m} ${tarballs[m].version}: ${d.problem}`);
    modules[m] = d;
  }
  // what it writes, held to the format the pins are read by: a description
  // the parser would refuse is refused here, never written (the medium on
  // L5b, 4)
  const bad = modulesProblem(modules, new Set(listed));
  if (bad != null) refuse(bad);
  const packs = Object.fromEntries(Object.entries(release.packs).map(([p, e]) => [p, {modules: [...(e.modules || e.packages)]}]));
  return {packs, modules};
}

// A development pins file's descriptions: the pack modules `pins` names,
// from their tarballs in dir (dir may hold others: the runtime's, ch-local's,
// which are never described) -> {<package>: description}. Throws a
// StepError when one cannot be described. (dogfood and acceptance: their
// --unreleased-pins file carries its own descriptions, lib/pins.js.)
// the pack modules `pins` pins -> {package: version}
function pinnedModules(release, pins) {
  const packModules = new Set(Object.values(release.packs).flatMap((p) => p.modules || []));
  return Object.fromEntries([...packModules].filter((m) => pins[m] != null && typeof pins[m].version === 'string').map((m) => [m, pins[m].version]));
}
function describePinned(release, pins, dir) {
  return describeRelease(release, pins, readTarballs(dir, {only: pinnedModules(release, pins)}), {only: true}).modules;
}

function main(argv, {stdout = process.stdout, stderr = process.stderr, releasePins = RELEASE_PINS} = {}) {
  const check = argv.includes('--check');
  const at = argv.indexOf('--unreleased-pins');
  const devFile = at >= 0 ? argv[at + 1] : null;
  const dir = argv.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1))[0];
  if (dir == null || (at >= 0 && devFile == null)) {
    stderr.write('usage: node scripts/describe-release.js <directory of tarballs> [--unreleased-pins <file>] [--check]\n');
    return 2;
  }
  try {
    const release = JSON.parse(fs.readFileSync(releasePins, 'utf8'));
    const target = devFile != null ? devFile : releasePins;
    const doc = devFile != null ? JSON.parse(fs.readFileSync(devFile, 'utf8')) : release;
    // (a development file: only the pack modules it pins, the runtime's and
    // ch-local's tarballs beside them, as install's --from holds them: the
    // medium on L5b, 1)
    const tarballs = devFile != null ? readTarballs(dir, {only: pinnedModules(release, doc.pins || {})}) : readTarballs(dir);
    const described = describeRelease(release, doc.pins || {}, tarballs, {only: devFile != null});
    let next;
    if (devFile != null) {
      next = {...doc, modules: described.modules};
    } else {
      // the release's own document, version 2 (an earlier one converted:
      // its allowedOrigins are derived now), held whole to the parser every
      // command loads it with before it is written: a document it would
      // refuse crashes every command at the next require (the Reviewer's
      // high review of #98, 4)
      next = {...doc, v: 2, packs: described.packs, modules: described.modules};
      delete next.allowedOrigins;
    }
    if (check) {
      // the release's own document is also checked as every command reads
      // it: one a write would convert, or the parser would refuse, does not
      // match (the medium on #98's high round, 6)
      if (devFile == null) {
        const parsed = parseReleasePins(JSON.parse(JSON.stringify(doc)));
        if (doc.v !== 2 || Object.prototype.hasOwnProperty.call(doc, 'allowedOrigins') || parsed.problem != null) {
          stdout.write(`${target}: not a document this ch-local reads as it is${parsed.problem != null ? ` (${parsed.problem})` : ''}; run without --check to write it\n`);
          return 1;
        }
      }
      const same = JSON.stringify(next.modules) === JSON.stringify(doc.modules) && (devFile != null || JSON.stringify(next.packs) === JSON.stringify(doc.packs));
      stdout.write(same ? `${target}: the descriptions match the tarballs\n` : `${target}: the descriptions differ from the tarballs; run without --check to write them\n`);
      return same ? 0 : 1;
    }
    if (devFile == null) {
      const parsed = parseReleasePins(JSON.parse(JSON.stringify(next)));
      if (parsed.problem != null) refuse(parsed.problem);
    }
    fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
    stdout.write(`${target}: described ${Object.keys(described.modules).length} modules\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof StepError) && !(err instanceof SyntaxError) && err.code == null) throw err;
    stderr.write(`describe-release: ${err.message}; nothing was written\n`);
    return 1;
  }
}

module.exports = {describeRelease, describePinned, readTarballs, main};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
