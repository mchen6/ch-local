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
const SUB = '(install|add-pack|remove-pack|rollback|upgrade|status|settings|credentials|snippet|add|uninstall|restart|start|conditions|daemon|dev-server)';
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
  /on ch-local \$\{v\}; \$\{restartIt\}/,
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

test('chLocal: the home\'s launcher by its real path, else the npx form', () => {
  const h = tmp('ch-cmdline-');
  const where = layout({COUNTINGHOUSE_HOME: h});
  // (POSIX names the home before it; Windows not yet: A-chlocal-func)
  assert.strictEqual(chLocal(where, 'install'), `${process.platform === 'win32' ? '' : `COUNTINGHOUSE_HOME="${h}" `}npx @countinghouse/ch-local install`, 'no launcher yet (a home that is not the default, named on POSIX)');
  fs.mkdirSync(path.join(h, 'bin'));
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  assert.strictEqual(chLocal(where, 'credentials add x'), `node "${fs.realpathSync.native(path.join(h, 'bin', 'ch-local.js'))}" credentials add x`);
  assert.strictEqual(chLocal(null, 'status'), 'npx @countinghouse/ch-local status');
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
  // (chLocalSelf's commands too: the running ch-local's own)
  // (hintCommand's too: the hints it prints are chLocal's, with Windows' home words)
  const CALL = /(?:chLocal(?:Self)?|npxLatest|hintCommand)\(\s*[^,()]+,\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g;
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
    const calls = (text.match(/\b(?:chLocal(?:Self)?|npxLatest|hintCommand)\(/g) || []).length - (text.match(/function (?:chLocal(?:Self)?|npxLatest|hintCommand)\(/g) || []).length;
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

// the final pass's ch-local part, A11: before any install nothing puts
// ch-local on PATH, so a hint with no launcher names the npx form, which
// runs as printed
test('chLocal with no launcher yet names the npx form', () => {
  const h = tmp('ch-cmdline-npx-');
  assert.strictEqual(chLocal(layout({COUNTINGHOUSE_HOME: h}), 'install --pack <name>'), `${process.platform === 'win32' ? '' : `COUNTINGHOUSE_HOME="${h}" `}npx @countinghouse/ch-local install --pack <name>`);
  assert.strictEqual(chLocal(null, 'status'), 'npx @countinghouse/ch-local status');
});

// the reviewer on #129, (5): the npx form for a home that isn't the default
// names it (POSIX: before the command), or the printed command acts on
// ~/.countinghouse when it's pasted into a new terminal
test('the npx form names a home that is not the default (POSIX)', {skip: process.platform === 'win32' && 'POSIX form'}, () => {
  const h = tmp('ch-cmdline-npx-home-');
  assert.strictEqual(chLocal(layout({COUNTINGHOUSE_HOME: h}), 'status'), `COUNTINGHOUSE_HOME="${h}" npx @countinghouse/ch-local status`);
  assert.strictEqual(chLocal(layout({}, require('node:os').homedir), 'status'), 'npx @countinghouse/ch-local status', 'the default home: no variable');
});

// the medium on the follow-up to #129, 3: a home a shell wouldn't read
// plainly is named by the placeholder, never left out (which would act on
// ~/.countinghouse) -- by chLocal, npxLatest and chLocalSelf's npx form alike
test('a home a shell would not read plainly is named by the placeholder, never left out (POSIX)', {skip: process.platform === 'win32' && 'POSIX form'}, () => {
  const {npxLatest, homePrefix} = require('../lib/command-line');
  const odd = {home: '/home/a$b/ch'};
  assert.strictEqual(chLocal(odd, 'install', 'linux'), 'COUNTINGHOUSE_HOME="<its folder>" npx @countinghouse/ch-local install');
  assert.strictEqual(npxLatest(odd, 'upgrade', 'linux'), 'COUNTINGHOUSE_HOME="<its folder>" npx @countinghouse/ch-local@latest upgrade');
  assert.strictEqual(homePrefix({home: '/home/dev/ch'}, 'linux'), 'COUNTINGHOUSE_HOME="/home/dev/ch" ');
  assert.strictEqual(homePrefix({home: '/home/dev/ch'}, 'win32'), '', 'Windows: not yet (A-chlocal-func)');
});

// the reviewer, 11-21: on Windows a printed npx hint (before any install)
// names a home that isn't the default, in words after the backticks; POSIX
// before the command; the launcher's form names its home already
test('hintCommand: the npx form names a non-default home on every platform; the default home and the launcher form need nothing', () => {
  const {hintCommand} = require('../lib/command-line');
  const w = {home: 'D:\\ch'};
  assert.strictEqual(hintCommand(w, 'install --pack <name>', 'win32'), '`npx @countinghouse/ch-local install --pack <name>` (with COUNTINGHOUSE_HOME set to "D:\\ch")');
  assert.strictEqual(hintCommand({home: '/home/dev/ch'}, 'status', 'linux'), '`COUNTINGHOUSE_HOME="/home/dev/ch" npx @countinghouse/ch-local status`');
  assert.strictEqual(hintCommand(layout({}, require('node:os').homedir), 'status', 'linux'), '`npx @countinghouse/ch-local status`', 'the default home');
  assert.strictEqual(hintCommand(layout({}, require('node:os').homedir), 'status', 'win32'), '`npx @countinghouse/ch-local status`', 'the default home on Windows: no words');
  // (the launcher's form names its home: no words, on Windows either)
  const h = tmp('ch-cmdline-hint-');
  fs.mkdirSync(path.join(h, 'bin'));
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  const withLauncher = hintCommand(layout({COUNTINGHOUSE_HOME: h}), 'status', 'win32');
  assert.ok(withLauncher.startsWith('`node "') && withLauncher.endsWith(' status`'), withLauncher);
});

// the closing pass: a notice within the runtime's 200-character cut, its
// last command whole (fitAny), plain text cut at the end
test('fitAny: within 200 code points; the last command in backticks kept whole; plain text cut', () => {
  const {fitAny, NOTICE_MAX} = require('../lib/command-line');
  const cmd = '`node "/home/alexandra/.countinghouse/bin/ch-local.js" settings set enabled.@countinghouse/ch-pack-other on`';
  const long = `ch-pack-ci-failure-triage unloaded: it calls ch-pack-other, which is not available (it is turned off (${cmd}))`;
  const fitted = fitAny(long);
  assert.ok([...fitted].length <= NOTICE_MAX, fitted);
  assert.ok(fitted.endsWith(`${cmd}))`), fitted);
  assert.strictEqual(fitAny('short'), 'short');
  // (the words that join the explanation to its command stay with it)
  const c = `\`node "/home/${'u'.repeat(100)}/ch-local.js" restart\``;
  const why = `x unloaded, since ${'w'.repeat(90)} was changed`;
  for (const tail of [`: ${c}`, `; ${c} shows them`, `: run ${c} now to stop it`, `; stopped until ${c} is run`, ` (${c}) (NOT_NOW)`]) {
    const t = fitAny(`${why}${tail}`);
    assert.ok([...t].length <= NOTICE_MAX && t.startsWith('x unloaded') && t.endsWith(`…${tail}`), t);
  }
  const plain = fitAny('x'.repeat(300));
  assert.ok([...plain].length <= NOTICE_MAX);
});

test('fitHeld: the command whole; a folder that passes the cut named in words; a launcher that does, the reason alone', () => {
  const {fitHeld, NOTICE_MAX} = require('../lib/command-line');
  const line = (launcher, folder) => `not loading my-tool: its files changed since you added it: run \`node "${launcher}" add-module "${folder}"\` again`;
  const launcher = '/home/alexandra/.countinghouse/bin/ch-local.js';
  assert.strictEqual(fitHeld(line(launcher, '/w/a')), line(launcher, '/w/a'));
  const cut = fitHeld(line(launcher, `/w/${'a'.repeat(80)}`));
  assert.ok(cut.startsWith('not loading my-') && cut.endsWith(`\`node "${launcher}" add-module "/w/${'a'.repeat(80)}"\` again`), cut);
  const words = fitHeld(line(launcher, `/w/${'a'.repeat(200)}`));
  assert.ok(words.endsWith(`\`node "${launcher}" add-module "<its folder>"\` again`), words);
  const reason = fitHeld(line(`/${'h'.repeat(200)}/ch-local.js`, '/w/a'));
  assert.strictEqual(reason, 'not loading my-tool: its files changed since you added it');
  assert.strictEqual(fitHeld(`not loading x: its files are missing; run \`node "/${'h'.repeat(200)}/ch-local.js" install\` again`), 'not loading x: its files are missing');
  // (cut back to a whole clause, whatever the words around the command; a quote kept)
  const far = `\`node "/${'h'.repeat(200)}/ch-local.js" restart\``;
  assert.strictEqual(fitHeld(`not loading x: its credential changed; unloaded until ${far} is run, or the earlier key is back`), 'not loading x: its credential changed');
  assert.strictEqual(fitHeld(`not loading x: it calls y, which is not available (its copy is gone: run ${far} again)`), 'not loading x: it calls y, which is not available (its copy is gone)');
  assert.strictEqual(fitHeld(`not loading x: "y" changed and is not loaded, until you run ${far}`), 'not loading x: "y" changed and is not loaded');
  assert.strictEqual(fitHeld(`not loading x: ${far}`), 'not loading x');
  // (never nothing: the runtime would drop it and answer ok; never half a command)
  assert.strictEqual(fitHeld(`${far} shows them`, 'ch-x'), 'ch-x');
  assert.strictEqual(fitHeld(`not loading x: it calls y, which is not available (it is turned off (${far}))`), 'not loading x: it calls y, which is not available (it is turned off)');
  assert.strictEqual(fitHeld(`not loading x: it is turned off (${far})`), 'not loading x: it is turned off');
  // (an earlier command is whole or not there)
  const long = fitHeld(`not loading x: first, run \`node "${'a'.repeat(100)}" one\`; then ${'b'.repeat(60)}: run ${far}`);
  assert.strictEqual(long, `not loading x: first, run \`node "${'a'.repeat(100)}" one\``);
  assert.strictEqual(fitHeld(`not loading x: first, run \`node "${'a'.repeat(190)}" one\`; then: run ${far}`), 'not loading x: first');
  for (const t of [cut, words, reason]) assert.ok([...t].length <= NOTICE_MAX, t);
});

// what a notice drops, whatever the command's length: the explanation first,
// then the module's name, never the command
test('fitHeld: the module\'s name stays whenever it fits beside the command; the command is never dropped for it', () => {
  const {fitHeld, NOTICE_MAX} = require('../lib/command-line');
  const n = (x) => [...x].length;
  for (const about of ['x1', 'ch-pack-ci-failure-triage']) for (let len = 40; len <= 199; len++) {
    const c = `\`${'c'.repeat(len - 2)}\``;
    const line = `module ${about} could not be stopped in place after a credential was removed or changed and what goes on: run ${c}`;
    const t = fitHeld(line, about);
    const said = `${len}: ${t}`;
    if (n(line) <= NOTICE_MAX) { assert.strictEqual(t, line); continue; }
    assert.ok(n(t) <= NOTICE_MAX, said);
    assert.ok(t.endsWith(c), said);
    // (the words that join it, while they fit with the name)
    if (n(`${about}: run ${c}`) <= NOTICE_MAX) assert.ok(t.endsWith(`run ${c}`), said);
    if (n(`${about}: ${c}`) <= NOTICE_MAX) assert.ok(t.includes(about), said);
    // (the explanation as long as any of it fits with the name)
    if (n(`: run ${c}`) + n(`module ${about} `) + 20 <= NOTICE_MAX) assert.ok(t.startsWith(`module ${about} `), said);
  }
});

test('fitHeld: a name late in the line is put first, the explanation kept; what a head opened is closed; the trailing words go before the command', () => {
  const {fitHeld, beforeCommand, NOTICE_MAX} = require('../lib/command-line');
  const c = `\`${'c'.repeat(100)}\``;
  const t = fitHeld(`ch-step-redact was moved back to 0.0.9 by the rollback just made; ch-pack-ci-failure-triage calls it and is stopped with it; stopped until ${c} is run`, 'ch-pack-ci-failure-triage');
  assert.ok([...t].length <= NOTICE_MAX && t.startsWith('ch-pack-ci-failure-triage: ch-step-redact was') && t.endsWith(`; stopped until ${c} is run`), t);
  assert.strictEqual(beforeCommand(`x unloaded: it calls y, which is not available (it is turned off (${c}))`), 'x unloaded: it calls y, which is not available (it is turned off)');
  const long = `\`${'c'.repeat(180)}\``;
  assert.strictEqual(fitHeld(`x gets no key, and is not loaded, until you run ${long} again`, 'x'), `x: ${long} again`);
  const longer = `\`${'c'.repeat(197)}\``;
  assert.strictEqual(fitHeld(`x gets no key, and is not loaded, until you run ${longer} again`, 'x'), longer);
});

// a loosening is told with no restart command, which would apply it unasked;
// a settings command, which asks first, may stand in it
test('fitHeld, fitNotice, beforeCommand: a loosening\'s line gets no restart command, at any length; a settings command stays', () => {
  const {fitHeld, fitNotice, beforeCommand, NOTICE_MAX} = require('../lib/command-line');
  for (const len of [20, 190, 199, 200, 201, 400]) {
    const line = `maxOutputBytes loosened from 16MiB to 32MiB, ${'w'.repeat(len)} when the shared runtime restarts (NOT_NOW)`;
    for (const t of [fitHeld(line), fitHeld(line, 'ch-x'), fitNotice(line, ' when the shared runtime restarts', NOTICE_MAX, 'ch-x'), beforeCommand(line)]) assert.doesNotMatch(t, / restart(?:[`?]|$)/, t);
    const set = '`node "/home/alexandra/.countinghouse/bin/ch-local.js" settings set maxOutputBytes 32MiB`';
    const asked = `maxOutputBytes is not loosened ${'w'.repeat(len)}: ${set} asks first`;
    assert.ok(fitHeld(asked, 'ch-x').endsWith(`${set} asks first`), fitHeld(asked, 'ch-x'));
  }
  const c = '`node "/home/u/.countinghouse/bin/ch-local.js" restart`';
  assert.strictEqual(beforeCommand(`ch-x added 0.3.0: run ${c} now to apply it`), 'ch-x added 0.3.0');
  assert.strictEqual(beforeCommand('ch-x added 0.3.0'), 'ch-x added 0.3.0');
});

test('fitNotice: a cut explanation carries no backtick, so no half command; the one at the end is whole', () => {
  const {fitNotice} = require('../lib/command-line');
  const first = '`node "/home/alexandra/.countinghouse/bin/ch-local.js" install --pack ci-failure-triage`';
  const tail = '; `node "/home/alexandra/.countinghouse/bin/ch-local.js" restart` applies it';
  // (the room before the tail ends inside the first command)
  const head = `${'a module unloaded, its pack missing: '.padEnd(60, '.')}${first} again, then add it back`;
  const room = 200 - [...tail].length;
  assert.ok(head.indexOf(first) < room && room < head.indexOf(first) + first.length, 'the cut lands inside the first command');
  const out = fitNotice(head, tail);
  assert.ok([...out].length <= 200, out);
  assert.ok(out.endsWith(tail), out);
  assert.ok(!out.slice(0, out.length - tail.length).includes('`'), `a backtick left in the cut explanation: ${out}`);
});
