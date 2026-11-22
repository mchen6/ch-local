'use strict';
// ch-local credentials add <module>                  (at a terminal)
// ch-local credentials add <module> --to <origin>    (the value on standard input)
// ch-local credentials list
// ch-local credentials remove <module>
//
// A credential is bound to one module (#413 sections 6.2, 6.3 and 6.8; L5a):
// the value, for this module's credential of this name, to this origin
// (lib/credential-store.js). The module must be installed and must declare
// a credential; add reads the declaration from its active version in the
// module store (lib/module-credentials.js) and shows the variable and the
// origin before it asks anything: what the user sees before typing is where
// the key will go.
//
// - At a terminal, the gh login is offered only for exactly
//   https://api.githubcopilot.com (whole origin: scheme, host and port), only
//   when gh has one, default No; a yes stores no value (the source gh: each
//   start asks gh). Otherwise the value is read with nothing echoed.
// - On standard input (not a terminal): --to <origin> is required and must
//   equal the declared origin; it never replaces a binding for another
//   origin or variable (a rotated key for the same destination is fine);
//   one line, at most 4096 bytes, no gh offer and no question.
// - A value is never taken from an argument or the environment, never
//   printed, logged or recorded. An argument that is not an installed
//   module's name is never shown back (a token typed in its place would be).
// - add and remove ask a running daemon to restart its runtime (it drains
//   first), and say what a session on a runtime of its own sees.
const {layout} = require('./home');
const store = require('./credential-store');
const mc = require('./module-credentials');
const {readModulesRecord} = require('./module-record');
const {chLocal, hintCommand} = require('./command-line');

class Refused extends Error {}
const short = (name) => String(name).replace(/^@[^/]+\//, '');
// (where: the home's layout, for the commands' launcher form:
// lib/command-line.js)
const notOne = (where, platform) => `that is not an installed module that declares a credential; \`${chLocal(where, 'credentials list', platform)}\` and \`${chLocal(where, 'status', platform)}\` show them. Nothing was changed.`;
const MAX_LINE = 4096;

// The installed module an argument names: its package name, or a short name
// one installed module has. -> name | null; throws Refused for a short name
// two share (the full names are the user's to give).
// where: the home, whose own modules count too (B-own-add)
function moduleNamed(record, arg, where = null) {
  const packNames = Object.keys((record && record.modules) || {});
  const names = packNames.concat(where != null ? Object.keys(mc.ownModules(where)).filter((n) => !packNames.includes(n)) : []);
  if (names.includes(arg)) return arg;
  const matches = names.filter((n) => short(n) === arg);
  if (matches.length > 1) throw new Refused(`more than one installed module is named ${arg}: ${matches.join(', ')}; give the full name`);
  return matches.length === 1 ? matches[0] : null;
}

// a version 1 file is migrated as it is written (section 10), so its other
// entries carry over
const migrateFor = (where, record) => (read) => mc.migrateV1(read, mc.declarations(where, record));

// {action: 'list' | 'add' | 'remove', name?, to?}, io -> exit code
// After a change: a running daemon is asked to restart its runtime (it
// drains first), and what a session on a runtime of its own sees is said.
async function restartAfter(where, io, say, change) {
  let asked = false;
  try { asked = await require('./daemon-requests').requestRestart(where.home, {io}); } catch (e) { asked = false; }
  // (the shared runtime named only when one serves this home: never sending
  // a home with none, a first install's included, to a restart that answers
  // "no shared runtime" -- the reviewer's high on #147, M4)
  let serving = false;
  try { serving = (await require('./daemon').daemonServing(where.home, {platform: io.platform, probePipe: io.probePipe || null})).serving; } catch (e) { serving = false; }
  if (serving && asked) say('The shared runtime restarts once its calls finish (it drains first).');
  // (not asked: its way said, never left on the old key -- the medium on A5, 9)
  else if (serving) say(`The shared runtime was not asked to restart: run \`${require('./command-line').chLocal(where, 'restart')}\` to make it take the change.`);
  say(change === 'removed'
    ? 'A session on a runtime of its own unloads the module at once, until its client restarts.'
    : 'A session on a runtime of its own takes it at its client\'s next start (a changed key unloads the module there at once).');
}

// restart: false leaves the restart to the caller (install's end asks once,
// after every module: the Reviewer's high review of L5a, 7)
async function credentials({action, name, to = null, restart: restartNow = true}, io) {
  const where = layout(io.env, io.homedir);
  const opts = {platform: io.platform || process.platform};
  const fail = (text, code = 1) => { io.stderr.write(`ch-local credentials: ${text}\n`); return code; };
  const say = (text) => io.stdout.write(`${text}\n`);
  // where a key goes reaches the person, beside the prompts: standard
  // error, never standard output (`install > log` would hide it; the Fable
  // pass on L5a, F2)
  const show = (text) => io.stderr.write(`${text}\n`);
  const history = (entry) => {
    try { require('./history').appendHistory(where, {by: 'credentials', ...entry}, {host: io.hostname, pid: io.pid}); } catch (e) { /* history is a record, never in the way */ }
  };
  const restart = async(change) => { if (restartNow) await restartAfter(where, io, say, change); };
  try {
    let record;
    try { record = readModulesRecord(where); } catch (e) { return fail(`${e.message}. Nothing was changed.`); }
    // list and remove work with nothing installed: a key a removed module
    // left is still listed, and still removable (the /code-review medium on
    // L5a, 2)
    if (record == null && action === 'add') return fail(`nothing is installed; run ${hintCommand(where, 'install --pack <name>', opts.platform)} first. Nothing was changed.`);
    const rec = record != null ? record : {modules: {}};
    if (action === 'list') return list(where, rec, opts, say);
    // an argument that is not an installed module is never shown back
    const module = name != null ? moduleNamed(rec, name, where) : null;
    const how = io.terminal === true ? 'terminal' : 'stdin';
    if (action === 'remove') {
      // read, judged and written under the store's lock, the record read
      // again there (post-rel cred-race: a remove made beside another add
      // or remove is never undone by it)
      let removed = false;
      const code = await store.withStoreLock(where.home, io, 'ch-local credentials remove', async(held) => {
        let now;
        try { now = readModulesRecord(where); } catch (e) { return fail(`${e.message}. Nothing was changed.`); }
        const r = now != null ? now : {modules: {}};
        const before = mc.bindings(where, r, opts);
        if (before.problem != null) return fail(`the stored credentials are not used (${before.problem}). Nothing was changed.`);
        // an installed module, or one the store still holds a key for (by
        // its full name, or a short name one stored module has)
        const installedName = name != null ? moduleNamed(r, name, where) : null;
        const removing = installedName != null ? installedName : moduleNamed({modules: Object.fromEntries([...before.bindings.keys()].map((m) => [m, {}]))}, name);
        if (removing == null) return fail(notOne(where, opts.platform), 2);
        const had = before.bindings.get(removing);
        if (!store.unbind(where.home, removing, {...opts, held, migrate: migrateFor(where, r)})) { say(`no credential is stored for ${short(removing)}`); return 0; }
        // (the name it was stored under: a key read from GitHub's earlier
        // name is recorded as removed under that name, the medium on #98's
        // cut, 6)
        const storedAs = new Map((before.carried || []).filter((c) => c.module === removing).map((c) => [c.to, c.from]));
        for (const [variable, b] of had || []) history({module: removing, variable: storedAs.has(variable) ? storedAs.get(variable) : variable, origin: b.origin, source: b.source, how, change: 'removed'});
        say(`the stored credential for ${short(removing)} is removed`);
        removed = true;
        return 0;
      // (no home: never the argument shown back, which may be a pasted key;
      // the reviewer's high on #102, 1)
      }, {missing: () => fail(notOne(where, opts.platform), 2)});
      if (removed) await restart('removed');
      return code;
    }
    if (action !== 'add') return fail('the actions are list, add and remove', 2);
    const decl = module != null ? mc.declared(where, record, module) : null;
    if (module == null || decl == null) return fail(notOne(where, opts.platform), 2);
    if (decl.problem != null) return fail(`${short(module)}: ${decl.problem}. Nothing was changed.`, 2);
    // a pack module's version, an own module's code (B-own-add)
    const at = mc.installedAt(where, record, module);
    const version = at.label;
    // the directory and any file there checked before anything is typed
    const before = mc.bindings(where, record, opts);
    if (before.problem != null) return fail(`the stored credentials are not used (${before.problem}). Nothing was changed.`);
    const vars = before.bindings.get(module);
    const other = vars != null ? [...vars].find(([v, b]) => v !== decl.variable || b.origin !== decl.origin) : null;

    // The key is asked for before the lock (no lock held while a person
    // types); under it, everything judged above is judged again on what is
    // there now, and the store read there is the one written (post-rel
    // cred-race). A module uninstalled meanwhile: nothing stored (uninstall
    // removes the record under this lock). A version changed meanwhile:
    // install, add-pack and rollback hold packs.lock only, so the check here
    // is not atomic against them; a binding that no longer matches what the
    // module declares is refused at start (the reviewer's high on #102, 5).
    const keep = async(entry) => {
      const code = await store.withStoreLock(where.home, io, 'ch-local credentials add', async(held) => {
        let now;
        try { now = readModulesRecord(where); } catch (e) { return fail(`${e.message}. Nothing was stored.`); }
        const changed = `changed while the key was being entered; run \`${addCommand(where, module, opts.platform)}\` again. Nothing was stored.`;
        const atNow = now != null ? mc.installedAt(where, now, module) : null;
        if (atNow == null) return fail(`${short(module)} is no longer installed; nothing was stored`);
        if (atNow.id !== at.id) return fail(`${short(module)} ${changed}`);
        const declNow = mc.declared(where, now, module);
        if (declNow == null || declNow.problem != null || declNow.variable !== decl.variable || declNow.origin !== decl.origin) return fail(`${short(module)}'s declared credential ${changed}`);
        const read = mc.bindings(where, now, opts);
        if (read.problem != null) return fail(`the stored credentials are not used (${read.problem}). Nothing was changed.`);
        const varsNow = read.bindings.get(module);
        const otherNow = varsNow != null ? [...varsNow].find(([v, b]) => v !== decl.variable || b.origin !== decl.origin) : null;
        // on standard input, never re-bind another destination: judged on
        // the store as it is now
        if (how === 'stdin' && otherNow != null) {
          return fail(`the credential stored for ${short(module)} does not match this version: ${mc.declarationChange(decl, otherNow[0], otherNow[1].origin).reason}; run \`${addCommand(where, module, opts.platform)}\` at a terminal to allow that. Nothing was changed.`, 2);
        }
        const hadNow = varsNow != null ? varsNow.get(decl.variable) : null;
        store.bind(where.home, module, decl.variable, entry, {...opts, held, migrate: migrateFor(where, now)});
        history({module, variable: decl.variable, origin: decl.origin, source: entry.source, how, change: hadNow != null || otherNow != null ? 'replaced' : 'added'});
        return 0;
      }, {missing: () => fail(`nothing is installed; run ${hintCommand(where, 'install --pack <name>', opts.platform)} first. Nothing was stored.`)});
      if (code !== 0) return code;
      show(entry.source === 'gh'
        ? `stored for ${short(module)}: your gh login's token, asked at each start, sent to ${decl.origin}`
        : `stored for ${short(module)}: ${decl.variable}, sent to ${decl.origin}; readable by this user only (another program running as this user can read it, as it can read gh's own token)`);
      await restart('added');
      return 0;
    };

    // an origin given is checked wherever the key comes from (the
    // /code-review medium on L5a, 4)
    if (to != null && to !== decl.origin) return fail(`${short(module)} ${version} sends its credential to ${decl.origin}, not the address given. Nothing was stored.`, 2);
    if (io.terminal === true && typeof io.readHidden === 'function') {
      show(`${short(module)} ${version} declares one credential:`);
      show(`  ${decl.variable}, sent to ${decl.origin}${decl.remote != null ? ` (its remote "${decl.remote}")` : ''}`);
      if (other != null) show(`the stored credential for ${short(module)}: ${mc.declarationChange(decl, other[0], other[1].origin).reason}`);
      if (decl.origin === mc.GH_ORIGIN) {
        const gh = await require('./github-token').ghToken(io, where.home);
        if (gh.token != null) {
          // the y/N read hidden, as the key is: a key pasted here is never
          // echoed (the reviewer's targeted high, 11-21); anything but y or n
          // is no, said without showing it
          let answer;
          try {
            answer = String(await io.readHidden(`Use your gh login's token for ${short(module)}? [y/N] (input hidden): `)).trim();
          } catch (e) {
            // any read that failed ends here: a paste too long leaves its
            // tail for the next hidden read, which would take it as the key
            // (the medium on B-shim-allow)
            if (e.code === 'ABORTED') return fail('nothing was entered; nothing was stored');
            return fail(`the answer could not be read (${e.code || 'an error'}); nothing was stored`);
          }
          if (/^y(es)?$/i.test(answer)) return await keep({origin: decl.origin, source: 'gh'});
          if (!/^(n(o)?)?$/i.test(answer)) show('that was not y or n, so your gh login\'s token is not used (what was typed is not kept or shown)');
        }
      }
      let value;
      try {
        value = await io.readHidden(`${decl.variable} for ${short(module)} (input hidden): `);
      } catch (e) {
        return fail(e.code === 'ABORTED' ? 'nothing was entered; nothing was stored' : e.code === 'TOO_LONG' ? `that was ${e.message}; nothing was stored` : 'the input could not be read; nothing was stored');
      }
      // an empty answer stores nothing (install's end skips the module)
      if (value === '') return fail('nothing was entered; nothing was stored');
      return await keep({origin: decl.origin, source: 'stored', value});
    }
    // on standard input nobody is looking at a prompt: the caller states the
    // destination, and ch-local checks it
    // a terminal on standard input but not both ways (its output
    // redirected): the key would echo as it is typed (the /code-review
    // medium on L5a, 3)
    if (io.stdinIsTTY === true) return fail('a key is typed only at a terminal both ways (its prompt seen, its typing hidden), or piped in; standard input is a terminal here but the output is not. Nothing was stored.', 2);
    if (to == null) return fail(`a key on standard input needs \`--to <origin>\`: the address it is for (\`${chLocal(where, 'credentials list', opts.platform)}\` shows what ${short(module)} declares). Nothing was stored.`, 2);
    if (other != null) {
      return fail(`the credential stored for ${short(module)} does not match this version: ${mc.declarationChange(decl, other[0], other[1].origin).reason}; run \`${addCommand(where, module, opts.platform)}\` at a terminal to allow that. Nothing was changed.`, 2);
    }
    if (typeof io.readStdin !== 'function') return fail('standard input could not be read; nothing was stored');
    let text;
    try {
      text = await io.readStdin(MAX_LINE + 2);
    } catch (e) {
      if (e.code === 'TOO_LONG') return fail(`a key on standard input is one line of at most ${MAX_LINE} bytes; nothing was stored`, 2);
      return fail(e.code === 'TIMEOUT' ? `${e.message}: pipe the key in, one line, and close the input. Nothing was stored.` : 'standard input could not be read; nothing was stored');
    }
    const line = String(text == null ? '' : text).replace(/\r?\n$/, '');
    // an input that ended with nothing in it (/dev/null, an empty pipe)
    if (line === '') return fail('standard input held no key; pipe it in, one line. Nothing was stored.', 2);
    if (line.includes('\n') || Buffer.byteLength(line) > MAX_LINE) return fail(`a key on standard input is one line of at most ${MAX_LINE} bytes; nothing was stored`, 2);
    return await keep({origin: decl.origin, source: 'stored', value: line});
  } catch (e) {
    if (e instanceof store.StoreProblem || e instanceof Refused) return fail(`${e.message.replace(/[;.]? *[Nn]othing was (changed|stored)\.?$/, '')}. Nothing was changed.`);
    throw e;
  }
}

// A module's binding as a start would use it: for its declared variable and
// origin (a gh one counts: gh is asked at start). -> the binding or null.
function bindingFor(read, module, decl) {
  if (read.bindings == null || decl == null || decl.problem != null) return null;
  const vars = read.bindings.get(module);
  const b = vars != null ? vars.get(decl.variable) : null;
  // a gh login only ever for GitHub's origin: a hand-written pairing is no
  // usable binding here either (the Reviewer's round 3, 6)
  if (b != null && b.source === 'gh' && decl.origin !== store.GH_ORIGIN) return null;
  return b != null && b.origin === decl.origin ? b : null;
}

// install's and add-pack's end (#413 section 6.2; L5a): each of `modules`
// (installed now) that declares a credential and has none stored for it. At
// a terminal the add conversation runs for it (the gh offer first where it
// applies; nothing entered skips it); otherwise one line says how to add
// it. Never fails the install. -> nothing.
// The command that adds a module's credential, as the person runs it in
// their own terminal: the home's own launcher, which runs as printed
// (nothing puts ch-local on PATH after an npx or a folder install;
// A-firstrun d1, the fixed text business checked)
// The launcher as the runtime's overview names it too (lib/home.js
// safeLauncher: a real path a shell reads as written, or none); with none,
// the bare form, which still names the command
const addCommand = (where, m, platform) => chLocal(where, `credentials add ${short(m)}`, platform);
const credentialLine = (where, m, platform) => `${short(m)} needs a credential: in your own terminal run \`${addCommand(where, m, platform)}\``;
// a line askMissing printed for a module with none (auto-apply carries them
// into its result)
// (the npx form too, a home's hint before its launcher exists, built from
// the one NPX form, with the home before it when it isn't the default; the
// bare form kept: A11 and its medium, 6, and the follow-up's medium, 2)
const NPX_RE = require('./command-line').NPX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const CREDENTIAL_LINE = new RegExp(`^\\S+ needs a credential: in your own terminal run \`(?:node "[^"]+" |(?:COUNTINGHOUSE_HOME="[^"]+" )?${NPX_RE} |ch-local )credentials add [^\`]+\`$`);
const isCredentialLine = (l) => CREDENTIAL_LINE.test(l);

async function askMissing(io, modules) {
  // (standard error: what a module needs reaches the person: F2)
  const say = (text) => io.stderr.write(`${text}\n`);
  const where = layout(io.env, io.homedir);
  let record;
  try { record = readModulesRecord(where); } catch (e) { return; }
  if (record == null) return;
  const opts = {platform: io.platform || process.platform};
  const read = mc.bindings(where, record, opts);
  if (read.problem != null) { say(`the stored credentials are not used (${read.problem}); \`${chLocal(where, 'credentials list', opts.platform)}\` shows them`); return; }
  const atTerminal = io.terminal === true && typeof io.readHidden === 'function';
  let added = 0;
  for (const m of modules) {
    const decl = mc.declared(where, record, m);
    if (decl == null || decl.problem != null || bindingFor(read, m, decl) != null) continue;
    if (!atTerminal) { say(credentialLine(where, m, opts.platform)); continue; }
    if (await credentials({action: 'add', name: m, restart: false}, io) === 0) added += 1;
    else say(`${short(m)} is not loaded until it has one: in your own terminal run \`${addCommand(where, m, opts.platform)}\``);
  }
  // one restart, and one pair of sentences, for all of them
  if (added > 0) await restartAfter(where, io, (text) => io.stdout.write(`${text}\n`), 'added');
}

// list (section 6.2): per binding, the module, the variable, the origin, the
// source and whether the installed version still declares that destination;
// for an installed module with none, what it declares (so --to can be
// written). Never a value.
function list(where, record, opts, say) {
  const decls = mc.declarations(where, record);
  const read = mc.bindings(where, record, opts);
  if (read.problem != null) say(`the stored credentials are not used (${read.problem})`);
  const bound = read.bindings != null ? read.bindings : new Map();
  const byName = ([a], [b]) => (a < b ? -1 : 1);
  let any = false;
  for (const [m, vars] of [...bound].sort(byName)) {
    const d = decls.get(m);
    for (const [variable, b] of vars) {
      any = true;
      const still = d != null && d.problem == null && d.variable === variable && d.origin === b.origin;
      const state = d == null ? 'not installed, or it declares no credential now' : still ? 'its installed version sends it here' : `its installed version sends ${d.variable} to ${d.origin} instead`;
      say(`${short(m)}  ${variable}  ${b.origin}  ${b.source === 'gh' ? 'gh login' : 'stored'}  (${state})`);
    }
  }
  for (const [m, d] of [...decls].sort(byName)) {
    if (bound.has(m) || d.problem != null) continue;
    any = true;
    say(`${short(m)}  ${d.variable}  ${d.origin}  none stored  (\`${addCommand(where, m, opts.platform)}\`)`);
  }
  if (!any) say('no installed module declares a credential');
  return 0;
}

module.exports = {credentials, moduleNamed, askMissing, addCommand, credentialLine, isCredentialLine};
