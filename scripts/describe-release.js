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
// memory (lib/tar.js readMember), nothing unpacked. The packs and what they
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
const {readMember} = require('../lib/tar');
const {describeModule, friendlyNames} = require('../lib/describe-module');

const root = path.resolve(__dirname, '..');
const RELEASE_PINS = path.join(root, 'lib', 'release-pins.json');

class StepError extends Error {}
const refuse = (why) => { throw new StepError(why); };

// -> {<package>: {version, manifest, api}} from every .tgz in dir
function readTarballs(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort(); } catch (err) { refuse(`cannot read ${dir} (${err.code})`); }
  const out = {};
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const json = (member) => {
      const b = readMember(buf, member);
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
  }
  const friendly = friendlyNames(Object.fromEntries(listed.map((m) => [m, tarballs[m].api])));
  if (friendly.problem != null) refuse(friendly.problem);
  const modules = {};
  for (const m of listed) {
    const d = describeModule(tarballs[m].manifest, friendly.map);
    if (d.problem != null) refuse(`${m} ${tarballs[m].version}: ${d.problem}`);
    modules[m] = d;
  }
  const packs = Object.fromEntries(Object.entries(release.packs).map(([p, e]) => [p, {modules: [...(e.modules || e.packages)]}]));
  return {packs, modules};
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
    const described = describeRelease(release, doc.pins || {}, readTarballs(dir), {only: devFile != null});
    const next = devFile != null ? {...doc, modules: described.modules} : {...doc, packs: described.packs, modules: described.modules};
    if (check) {
      const same = JSON.stringify(next.modules) === JSON.stringify(doc.modules) && (devFile != null || JSON.stringify(next.packs) === JSON.stringify(doc.packs));
      stdout.write(same ? `${target}: the descriptions match the tarballs\n` : `${target}: the descriptions differ from the tarballs; run without --check to write them\n`);
      return same ? 0 : 1;
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

module.exports = {describeRelease, readTarballs, main};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
