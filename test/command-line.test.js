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

// the reviewer's high on #113: the invisible characters a terminal shows as
// nothing (fillers, variation selectors, tag characters) are unsafe too
test('terminalText shows every unsafe character as ?, the invisible fillers and tag characters included', () => {
  const {terminalText, folderArg} = require('../lib/command-line');
  assert.strictEqual(terminalText('aㅤb͏c️d\u{e0041}e᠎fᅟg'), 'a?b?c?d?e?f?g');
  assert.strictEqual(folderArg('/home/u/myㅤtool', 'linux'), '"<its folder>"');
});

// the medium on #113's round 1: every format character, and a cut that
// never splits a surrogate pair
test('terminalText: every control or format character is ?; a cut keeps whole code points', () => {
  const {terminalText} = require('../lib/command-line');
  assert.strictEqual(terminalText('a⁫b\u{1d173}c؀d۝e'), 'a?b?c?d?e');
  const cut = terminalText(`${'x'.repeat(79)}\u{1F600}yy`, 80);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), JSON.stringify(cut));
});

// A command template's lines to parse: each ${...} (scanned with its braces
// balanced, so a nested {} or a literal holding } stays inside it) stands
// for one word, and in turn for each string literal it holds, an empty or a
// multi-word one included (the reviewer's high on #124, 8 and 9); a
// <placeholder> is one word. -> [line, ...]
function variantsOf(template) {
  const parts = [];   // text, or {expr}
  let i = 0; let text = '';
  while (i < template.length) {
    if (template[i] === '$' && template[i + 1] === '{') {
      let depth = 1; let j = i + 2; let quote = null;
      for (; j < template.length && depth > 0; j++) {
        const c = template[j];
        if (quote != null) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      parts.push(text, {expr: template.slice(i + 2, j - 1)});
      text = ''; i = j; continue;
    }
    text += template[i]; i++;
  }
  parts.push(text);
  const word = (x) => x.replace(/<[^>]*>/g, 'x');
  const join = (choose) => word(parts.map((p, k) => (typeof p === 'string' ? p : choose(p, k))).join(''));
  const lines = [join(() => 'x')];
  parts.forEach((p, k) => {
    if (typeof p === 'string') return;
    // (a literal the expansion can be: an alternative after ?, :, || or ??,
    // never an argument inside it, such as a replace's '')
    for (const m of p.expr.matchAll(/(?:\?\?|\|\||\?|:)\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g)) {
      const lit = m[1] !== undefined ? m[1] : m[2];
      lines.push(join((q, n) => (n === k ? lit : 'x')));
    }
  });
  return lines;
}

test('the pin\'s reading of a template: nested braces, a } in a literal, an empty or a multi-word alternative', () => {
  assert.deepStrictEqual(variantsOf('install --pack ${packArg(Object.keys(record.packs || {})[0])} --from <dir>'), ['install --pack x --from x']);
  assert.deepStrictEqual(variantsOf("credentials add ${gh != null ? gh[0] : '<module>'}"), ['credentials add x', 'credentials add x']);
  assert.deepStrictEqual(variantsOf("rollback${yes ? ' --yes' : ''}"), ['rollbackx', 'rollback --yes', 'rollback']);
  assert.deepStrictEqual(variantsOf("snippet ${x || '}'}"), ['snippet x', 'snippet }']);
  assert.deepStrictEqual(variantsOf("credentials add ${m.replace(/^@[^/]+\\//, '')}"), ['credentials add x'], 'an argument is not an alternative');
});

// The reviewer on #120's high: a printed hint must name a command that
// parses. Every command line made by chLocal(where, '<command>') in lib/ and
// bin/ch-local.js is read lexically (a template's ${...} stands for one
// word) and parsed by the CLI's own parser, never a copy of its rules.
// (A shell command, such as a chmod line, is not chLocal's and is not read.)
test('every ch-local command a hint prints parses as the command line takes it', () => {
  const {parseCommand} = require('../bin/ch-local.js');
  const CALL = /chLocal\(\s*[^,()]+,\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g;
  // (every .js under lib/, its subdirectories too, and the CLI)
  const walk = (d) => fs.readdirSync(d, {withFileTypes: true}).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && e.name !== 'command-line.js' ? [path.join(d, e.name)] : []);
  const files = [...walk(LIB), BIN];
  const seen = [];
  const unread = [];
  const bad = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // a call the pattern can't read (a first argument with ( or ,, a
    // command that is not a literal) is a failure too, the medium's 8
    const calls = (text.match(/\bchLocal\(/g) || []).length - (text.match(/function chLocal\(/g) || []).length;
    const read = [...text.matchAll(CALL)].length;
    if (read !== calls) unread.push(`${path.relative(LIB, file)}: ${calls - read} chLocal call(s) not read`);
    for (const m of text.matchAll(CALL)) {
      const lines = variantsOf(m[2]);
      seen.push(lines[0]);
      for (const line of lines) {
        const argv = line.split(/\s+/).filter((w) => w !== '');
        if (parseCommand(argv) == null) bad.push(`${path.basename(file)}: ch-local ${line}`);
      }
    }
  }
  assert.ok(seen.length >= 40, `the scan found ${seen.length} hints: it reads them`);
  assert.ok(seen.includes('install'), 'the bare install hint is among them');
  assert.deepStrictEqual(unread, [], 'every chLocal call is read');
  assert.deepStrictEqual(bad, [], `hints that do not parse:\n${bad.join('\n')}`);
  // and the parser refuses what it should (the pin is not vacuous)
  for (const argv of [['install', 'extra'], ['nope'], ['status', 'x'], ['credentials', 'add']]) {
    assert.strictEqual(parseCommand(argv), null, argv.join(' '));
  }
});
