'use strict';
// A user's own module folder, judged, hashed and copied into the home
// (B-own-add; the own-modules design §2.1). The same rules the runtime's
// profile validation applies (countinghouse lib/own-module-check.js),
// checked here again since this copy is what loads:
//   - checkFolder: an absolute folder reached through no link, neither
//     inside the home nor holding it; walked by lstat alone first -- a link,
//     a file with a second name, anything neither a file nor a folder, more
//     than MAX_ENTRIES entries or MAX_TREE_BYTES, a node_modules folder, a
//     native file -- and only then package.json and api.json read, plainly
//     (no link followed, no blocking, a regular file under one name,
//     bounded): a package name not in @countinghouse/, role "scenario", no
//     npm dependencies, a device friendlyName.
//   - treeHash: sha256 over the sorted (relative path, kind, executable bit,
//     sha256 of content) of every entry: the identity a yes binds to.
//   - placeCopy: the folder copied into <own>/<name>/<tree>.new-<random>,
//     the copy hashed -- it must be the tree the user saw -- then renamed
//     to <own>/<name>/<tree>/ with its marker <tree>.json (ch-local's own,
//     so gc and remove-module may take it).
// Answers name files, never their content.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {PACKAGE} = require('./names');
const {writeAtomic} = require('./atomic');

const MAX_ENTRIES = 20000;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const PLAIN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
const isWin = () => process.platform === 'win32';
const norm = (p) => (isWin() ? p.toLowerCase() : p);
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

// whether p is root or inside it (real paths); <root>/..mine is inside
function inside(p, root) {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// A file's bytes, read only if it is a plain one: opened without following
// a link and without blocking, judged on its descriptor. Throws ENOTPLAIN.
function readPlain(file, maxBytes) {
  const fd = fs.openSync(file, PLAIN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) throw Object.assign(new Error('not a plain file'), {code: 'ENOTPLAIN'});
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}
const readJsonPlain = (file) => JSON.parse(readPlain(file, MAX_JSON_BYTES).toString('utf8'));

// Every entry under dir, by lstat alone: [{rel, kind: 'dir'|'file', exec,
// size}] sorted by rel, and the problems that stop any read
function walk(dir) {
  const entries = [];
  const problems = [];
  const links = [];
  const twice = [];
  const special = [];
  let bytes = 0;
  let over = false;
  const visit = (at, rel) => {
    if (over) return;
    let names;
    try { names = fs.readdirSync(at); } catch (e) { problems.push(`${rel || '.'} cannot be read`); return; }
    for (const name of names.sort()) {
      if (over) return;
      if (entries.length >= MAX_ENTRIES) { over = true; return; }
      const full = path.join(at, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      let st;
      try { st = fs.lstatSync(full); } catch (e) { problems.push(`${r} cannot be read`); continue; }
      if (st.isSymbolicLink()) { links.push(r); continue; }
      if (st.isDirectory()) {
        if (name === 'node_modules') problems.push('the folder has a node_modules folder: an own module has none in this release; copy the code it needs into its folder');
        entries.push({rel: r, kind: 'dir', exec: false, size: 0});
        visit(full, r);
      } else if (st.isFile()) {
        if (st.nlink > 1) twice.push(r);
        if (name.endsWith('.node') || name === 'binding.gyp') problems.push(`${r} is native code: an own module holds none`);
        bytes += st.size;
        entries.push({rel: r, kind: 'file', exec: (st.mode & 0o111) !== 0, size: st.size});
      } else {
        special.push(r);
      }
    }
  };
  visit(dir, '');
  const few = (list) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}`;
  if (over) problems.push(`the folder has more than ${MAX_ENTRIES} entries`);
  if (links.length > 0) problems.push(`the folder holds a link (${few(links)}): an own module's files are its own, never links`);
  if (twice.length > 0) problems.push(`the folder holds a file with a second name (${few(twice)}): an own module's files are its own, one name each`);
  if (special.length > 0) problems.push(`the folder holds something that is neither a file nor a folder (${few(special)}): an own module holds files only`);
  if (bytes > MAX_TREE_BYTES) problems.push(`the folder holds more than ${MAX_TREE_BYTES / (1024 * 1024)} MiB of files`);
  return {entries, problems};
}

// input: the folder the user named; home: the ch-local home -> {real, pkg,
// spec, entries} or {problems: [message]} (the first a path refusal alone)
function checkFolder(input, home) {
  if (typeof input !== 'string' || input === '' || input.includes('\0') || !path.isAbsolute(path.resolve(input))) return {problems: ['name your module\'s folder']};
  const resolved = path.resolve(input);
  // no link on the way: each part of the path as written, from its root
  let at = path.parse(resolved).root;
  for (const part of resolved.split(path.sep).filter((s) => s !== '')) {
    at = path.join(at, part);
    let st;
    try { st = fs.lstatSync(at); } catch (e) { return {problems: ['the folder is not there']}; }
    if (st.isSymbolicLink()) return {problems: ['the path goes through a link: name the folder by its real path']};
  }
  let st;
  try { st = fs.statSync(resolved); } catch (e) { return {problems: ['the folder is not there']}; }
  if (!st.isDirectory()) return {problems: ['the path is not a folder']};
  const real = fs.realpathSync.native(resolved);
  let homeReal = null;
  try { homeReal = fs.realpathSync.native(home); } catch (e) { homeReal = null; }
  if (homeReal != null && inside(real, homeReal)) return {problems: ['the folder is inside the ch-local home: keep your own module\'s folder elsewhere']};
  if (homeReal != null && inside(homeReal, real)) return {problems: ['the folder holds the ch-local home: name your module\'s own folder']};
  // the walk first: nothing read until it passes
  const {entries, problems} = walk(real);
  if (problems.length > 0) return {problems};
  let pkg;
  try { pkg = readJsonPlain(path.join(real, 'package.json')); } catch (e) { return {problems: ['package.json cannot be read as JSON']}; }
  if (!isObject(pkg)) return {problems: ['package.json is not a JSON object']};
  const out = [];
  if (typeof pkg.name !== 'string' || !PACKAGE.test(pkg.name)) out.push('package.json\'s name is not a package name');
  else if (pkg.name.startsWith('@countinghouse/')) out.push('The @countinghouse/ scope is countinghouse\'s own: give your module another name.');
  if (typeof pkg.version !== 'string' || pkg.version === '' || pkg.version.length > 64) out.push('package.json has no version');
  const ch = isObject(pkg.countinghouse) ? pkg.countinghouse : null;
  if (ch == null || ch.role !== 'scenario') out.push('An own module is a scenario: set "countinghouse": {"role": "scenario"} in its package.json, or its tools are never listed.');
  const declared = DEPENDENCY_FIELDS.filter((f) => pkg[f] != null && (Array.isArray(pkg[f]) ? pkg[f].length > 0 : (isObject(pkg[f]) && Object.keys(pkg[f]).length > 0)));
  if (declared.length > 0) out.push(`package.json declares npm dependencies (${declared.join(', ')}): an own module has none in this release; copy the code it needs into its folder`);
  let spec = null;
  try { spec = readJsonPlain(path.join(real, 'api.json')); } catch (e) { out.push('api.json cannot be read as JSON'); }
  const friendlyName = (spec != null && isObject(spec.device)) ? spec.device.friendlyName : null;
  if (spec != null && (typeof friendlyName !== 'string' || friendlyName === '' || friendlyName.length > 64)) out.push('api.json has no device friendlyName');
  if (out.length > 0) return {problems: out};
  return {real, pkg, spec, entries};
}

// dir (a checked folder, or a copy) and its entries -> the tree's sha256
function treeHash(dir, entries) {
  const h = crypto.createHash('sha256');
  for (const e of entries) {
    if (e.kind === 'dir') {
      h.update(`${e.rel}\0dir\n`);
    } else {
      const content = crypto.createHash('sha256').update(readPlain(path.join(dir, ...e.rel.split('/')), MAX_TREE_BYTES)).digest('hex');
      h.update(`${e.rel}\0file\0${e.exec ? 'x' : '-'}\0${content}\n`);
    }
  }
  return h.digest('hex');
}

// the copy's folder and marker for a module and tree
const copyDir = (where, name, tree) => path.join(where.own, ...name.split('/'), tree);
const markerOf = (where, name, tree) => `${copyDir(where, name, tree)}.json`;

// Copies the checked folder into the home: staged, hashed -- the copy must
// hash to `tree`, what the user saw -- then renamed in, its marker last.
// -> the copy's folder. Throws when the folder changed since it was hashed
// (OWN_TREE_CHANGED). The caller holds packs.lock.
function placeCopy(where, name, real, entries, tree, {now = () => new Date()} = {}) {
  const dir = copyDir(where, name, tree);
  if (fs.existsSync(dir) && fs.existsSync(markerOf(where, name, tree))) return dir;
  const stage = `${dir}.new-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(dir), {recursive: true});
  try {
    fs.mkdirSync(stage, {mode: 0o755});
    for (const e of entries) {
      const to = path.join(stage, ...e.rel.split('/'));
      if (e.kind === 'dir') { fs.mkdirSync(to, {mode: 0o755}); continue; }
      fs.writeFileSync(to, readPlain(path.join(real, ...e.rel.split('/')), MAX_TREE_BYTES), {mode: e.exec ? 0o755 : 0o644, flag: 'wx'});
    }
    const copied = walk(stage);
    if (copied.problems.length > 0 || treeHash(stage, copied.entries) !== tree) {
      throw Object.assign(new Error('the folder changed while it was being added: run add-module again'), {code: 'OWN_TREE_CHANGED'});
    }
    fs.rmSync(dir, {recursive: true, force: true});
    fs.renameSync(stage, dir);
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
  writeAtomic(markerOf(where, name, tree), `${JSON.stringify({name, tree, placedAt: now().toISOString()})}\n`);
  return dir;
}

// -> whether the copy at <own>/<name>/<tree> is whole (its marker) and
// still hashes to tree (the start's check: a changed copy is never loaded)
function copyIntact(where, name, tree) {
  const dir = copyDir(where, name, tree);
  try {
    const marker = JSON.parse(fs.readFileSync(markerOf(where, name, tree), 'utf8'));
    if (marker == null || marker.name !== name || marker.tree !== tree) return false;
    const w = walk(dir);
    return w.problems.length === 0 && treeHash(dir, w.entries) === tree;
  } catch (e) {
    return false;
  }
}

module.exports = {checkFolder, treeHash, placeCopy, copyIntact, copyDir, markerOf, readPlain, walk, MAX_ENTRIES, MAX_TREE_BYTES};
