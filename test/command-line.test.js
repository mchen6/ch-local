'use strict';
require('./tmp-dirs');
// A-chhints: every printed hint that names a ch-local command is made by
// lib/command-line.js chLocal (the home's launcher, as the credential line
// already was), never written bare. A lexical pin over lib/: a line of code
// (not a comment) that names `ch-local <command>` is a failure, unless it is
// in the list below, which says why each is not a command to run.
//
// Forms it catches, in any quote: a literal naming `ch-local <subcommand>`
// ('...', "...", `...`); a template's `ch-local ${...}`; and a literal that
// ends in `ch-local ` and is joined with + to what follows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {chLocal} = require('../lib/command-line');
const {layout} = require('../lib/home');

const LIB = path.join(__dirname, '..', 'lib');
// (the CLI's own lines too: its usage text, which names each command as
// the command line takes it, is allowed below)
const BIN = path.join(__dirname, '..', 'bin', 'ch-local.js');
const SUB = '(install|add-pack|remove-pack|rollback|upgrade|status|settings|credentials|snippet|add|uninstall|start|conditions|daemon|dev-server)';
const FORMS = [
  new RegExp(`ch-local ${SUB}\\b`),
  /ch-local \$\{/,
  /ch-local ['"`]\s*\+/
];
// Not a command to run: what each names, and why it stays bare
const ALLOWED = [
  // the program's own name before its error, as every CLI writes it
  // (only at a string's start: one later in a line is a hint followed by a colon)
  /[`'"]ch-local [a-z-]+: /,
  // a lock's owner label, said when another command waits on it
  /withStoreLock\([^)]*'ch-local (credentials add|credentials remove|uninstall)'/,
  // a version of ch-local, not a command
  /ch-local \$\{(found\.to|from|ours)\}/,
  /on ch-local \$\{v\}; restart/,
  /comes back with ch-local \$\{to\};/,
  // ... the same, as the daemon's handover, status's header and its held
  // packs, and rollback's held packs name the version
  /ch-local \$\{(mine\.daemonVersion|installedSelf \|\| '\(unknown\)'|under)\}/,
  /needs ch-local \$\{h\.from != null && h\.from\.release != null \? h\.from\.release : 'a later release'\}/,
  // the usage text: each command as `ch-local` takes it, at the line's start
  // (bin/ch-local.js's USAGE only: see usageLines below)
  // ch-local's own start, named as what refuses (not something to run)
  /ch-local start refuses to start/,
  /cannot be passed to ch-local start/
];

function violations() {
  const out = [];
  const files = [...fs.readdirSync(LIB).filter((n) => n.endsWith('.js') && n !== 'command-line.js').map((n) => path.join(LIB, n)), BIN];
  for (const file of files) {
    const name = path.relative(path.join(LIB, '..'), file).replace(/^lib\//, '');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    // (bin/ch-local.js's USAGE text, from its `const USAGE` line to the
    // closing backquote: each command as ch-local takes it)
    const usageLines = new Set();
    if (file === BIN) {
      const from = lines.findIndex((l) => /^const USAGE = `/.test(l));
      for (let k = from; k >= 0 && k < lines.length; k++) { usageLines.add(k); if (k > from && /`;\s*$/.test(lines[k])) break; }
    }
    lines.forEach((line, i) => {
      if (usageLines.has(i)) return;
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
      // (a trailing comment is not printed)
      const body = line.replace(/\s\/\/ .*$/, '');
      if (!FORMS.some((f) => f.test(body))) return;
      // (each match on the line allowed, or the line fails)
      const rest = ALLOWED.reduce((l, a) => l.replace(new RegExp(a.source, 'g'), ''), body);
      if (FORMS.some((f) => f.test(rest))) out.push(`${name.startsWith('bin/') ? name : `lib/${name}`}:${i + 1}: ${code.slice(0, 160)}`);
    });
  }
  return out;
}

test('no printed hint in lib/ or bin/ch-local.js names a bare ch-local command outside lib/command-line.js', () => {
  const found = violations();
  assert.deepStrictEqual(found, [], `bare ch-local commands:\n${found.join('\n')}`);
});

test('the pin catches each form: a quoted command, a template\'s ${...}, a literal joined with +', () => {
  for (const line of ["'run `ch-local install` again'", '`run ch-local ${what}`', "'ch-local ' + sub", '"ch-local settings get"']) {
    assert.ok(FORMS.some((f) => f.test(line)), line);
  }
  assert.ok(!FORMS.some((f) => f.test("'ch-local is the launcher'")), 'prose naming ch-local itself');
});

test('chLocal: the home\'s launcher by its real path, else the bare command', () => {
  const h = tmp('ch-cmdline-');
  const where = layout({COUNTINGHOUSE_HOME: h});
  assert.strictEqual(chLocal(where, 'install'), 'ch-local install', 'no launcher yet');
  fs.mkdirSync(path.join(h, 'bin'));
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  assert.strictEqual(chLocal(where, 'credentials add x'), `node "${fs.realpathSync.native(path.join(h, 'bin', 'ch-local.js'))}" credentials add x`);
  assert.strictEqual(chLocal(null, 'status'), 'ch-local status');
  void fakeIo;
});

// the reviewer on ch-local#110, 2: the launcher written into a home runs on
// that home when COUNTINGHOUSE_HOME is unset, so a printed command acts on
// the home it names; an explicit variable still wins
test('the home\'s launcher runs on its own home unless COUNTINGHOUSE_HOME names another', () => {
  const {spawnSync} = require('node:child_process');
  const {launcherText} = require('../lib/install');
  const h = tmp('ch-launcher-');
  // (an installed ch-local that says which home it was given)
  const bin = path.join(h, 'fake-bin.js');
  fs.writeFileSync(bin, "module.exports = {run: () => process.stdout.write(String(process.env.COUNTINGHOUSE_HOME))};\n");
  const launcher = path.join(h, 'ch-local.js');
  fs.writeFileSync(launcher, launcherText(bin, '/alt/home'));
  const env = {...process.env};
  delete env.COUNTINGHOUSE_HOME;
  assert.strictEqual(spawnSync(process.execPath, [launcher], {env, encoding: 'utf8'}).stdout, '/alt/home', 'unset: its own home');
  assert.strictEqual(spawnSync(process.execPath, [launcher], {env: {...env, COUNTINGHOUSE_HOME: '/elsewhere'}, encoding: 'utf8'}).stdout, '/elsewhere', 'set: the variable wins');
  assert.strictEqual(spawnSync(process.execPath, [launcher], {env: {...env, COUNTINGHOUSE_HOME: ''}, encoding: 'utf8'}).stdout, '/alt/home', 'empty: its own home');
});
