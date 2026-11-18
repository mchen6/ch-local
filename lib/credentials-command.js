'use strict';
// ch-local credentials list
// ch-local credentials add <name> [--module <package>]
// ch-local credentials remove <name>
//
// The credentials ch-local holds for its packs (lib/credential-store.js). In
// release 1 the one name is `github`, a read-only GitHub token, stored as
// COUNTINGHOUSE_GITHUB_TOKEN. It is taken in the one order
// (lib/github-token.js): the client's own COUNTINGHOUSE_GITHUB_TOKEN, then
// this, then `gh auth token`, then GITHUB_TOKEN.
//
// - add reads the value at a terminal only, with nothing echoed
//   (lib/hidden-input.js), and never from an argument, the environment or a
//   pipe: a value in argv or a script is in a shell's history and a process
//   list. It is never printed, logged or recorded, and one that does not look
//   like a token is refused without being shown back.
// - The value is bound to the access module that declared its variable, as
//   the installed packs' manifests have it (lib/packs.js declaredRemotes):
//   with none installed it is refused; with more than one, --module names
//   which, and it is never guessed.
// - add and remove ask a running daemon to restart its runtime (it drains
//   first), which then takes the token; and each says so.
const {layout} = require('./home');
const store = require('./credential-store');

const NAMES = Object.freeze({github: 'COUNTINGHOUSE_GITHUB_TOKEN'});
// the variables a name's credential stands for, as start gives it: the
// GitHub token under either GitHub variable
const COVERS = Object.freeze({github: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']});

class Refused extends Error {}

// the access modules the installed packs say declare one of `variables` for
// a remote whose origin the release allows that variable to go to. A pack
// whose manifests can't be read is refused, never skipped: a module missing
// from the count could leave one module where there are two.
function declaringModules(where, variables) {
  const {installedPacks, declaredRemotes} = require('./packs');
  const {ALLOWED_ORIGINS} = require('./allowlist');
  const out = new Set();
  for (const p of installedPacks(where)) {
    if (p.dirs == null) throw new Refused(`the installed pack ${p.name} can't be read; run \`ch-local install\` again`);
    let remotes;
    try { remotes = declaredRemotes(p.dirs, p.packages); } catch (e) { throw new Refused(`the installed pack ${p.name} can't be read; run \`ch-local install\` again`); }
    for (const r of remotes) {
      const allowed = r.origin != null && Object.prototype.hasOwnProperty.call(ALLOWED_ORIGINS, r.origin) ? ALLOWED_ORIGINS[r.origin] : [];
      if (r.variables.some((v) => variables.includes(v) && allowed.includes(v))) out.add(r.from);
    }
  }
  return [...out].sort();
}

// {action: 'list' | 'add' | 'remove', name?, module?}, io -> exit code
async function credentials({action, name, module = null}, io) {
  const where = layout(io.env, io.homedir);
  const opts = {platform: io.platform || process.platform};
  const fail = (text, code = 1) => { io.stderr.write(`ch-local credentials: ${text}\n`); return code; };
  const history = (entry) => {
    try { require('./history').appendHistory(where, {by: 'credentials', ...entry}, {host: io.hostname, pid: io.pid}); } catch (e) { /* history is a record, never in the way */ }
  };
  const restart = async(what) => {
    let asked = false;
    try { asked = await require('./daemon-requests').requestRestart(where.home, {io}); } catch (e) { asked = false; }
    io.stdout.write(`${asked ? `The shared runtime, if one is running, ${what} once its calls finish (it drains, then restarts). ` : ''}A session on a runtime of its own ${what} at its next start.\n`);
  };
  try {
    if (action === 'list') {
      const held = store.list(where.home, opts);
      if (held.length === 0) { io.stdout.write('no credentials are stored\n'); return 0; }
      const nameOf = (variable) => Object.keys(NAMES).find((n) => NAMES[n] === variable) || variable;
      for (const {variable, module: m} of held) io.stdout.write(`${nameOf(variable)}  ${variable}  (for ${m})\n`);
      return 0;
    }
    // a name not known is never shown back: a token typed in its place
    // would be printed
    if (!Object.prototype.hasOwnProperty.call(NAMES, name)) return fail(`that is not a credential's name; the names are: ${Object.keys(NAMES).join(', ')}. Nothing was changed.`, 2);
    const variable = NAMES[name];
    if (action === 'remove') {
      if (!store.remove(where.home, variable, opts)) { io.stdout.write(`no ${name} credential is stored\n`); return 0; }
      history({credential: name, change: 'removed'});
      io.stdout.write(`the stored ${name} credential is removed\n`);
      await restart('stops using it');
      return 0;
    }
    if (action !== 'add') return fail('the actions are list, add and remove', 2);
    // a terminal, both ways: the prompt is seen and the typing is not
    if (io.terminal !== true || typeof io.readHidden !== 'function') {
      return fail(`add reads the ${name} credential at a terminal, with nothing shown; run it in one (never from a pipe, an argument or the environment). Nothing was stored.`, 2);
    }
    const modules = declaringModules(where, COVERS[name]);
    let bound = module;
    if (bound != null && !modules.includes(bound)) {
      // the value given is never shown back: it could be a token
      return fail(`that --module does not declare the ${name} credential${modules.length > 0 ? `; ${modules.length === 1 ? 'the one that does is' : 'those that do are'} ${modules.join(', ')}` : ''}. Nothing was stored.`, 2);
    }
    if (bound == null) {
      if (modules.length === 0) return fail(`no installed pack declares the ${name} credential (${COVERS[name].join(' or ')}): install the pack that uses it first. Nothing was stored.`);
      if (modules.length > 1) return fail(`more than one installed module declares the ${name} credential (${modules.join(', ')}): name the one with --module. Nothing was stored.`, 2);
      bound = modules[0];
    }
    // the directory and any file there checked before anything is typed:
    // a home that fails is said now, not after the token is entered
    store.readStore(where.home, opts);
    let value;
    try {
      value = await io.readHidden(`${name} credential for ${bound} (input hidden): `);
    } catch (e) {
      return fail(e.code === 'ABORTED' ? 'nothing was entered; nothing was stored' : e.code === 'TOO_LONG' ? `that was ${e.message}; nothing was stored` : 'the input could not be read; nothing was stored');
    }
    store.add(where.home, variable, value, bound, opts);
    history({credential: name, change: 'added', module: bound});
    io.stdout.write(`the ${name} credential is stored for ${bound}, readable by this user only (another program running as this user can read it, as it can read gh's own token)\n`);
    await restart('takes it');
    return 0;
  } catch (e) {
    if (e instanceof store.StoreProblem || e instanceof Refused) return fail(`${e.message}. Nothing was changed.`);
    throw e;
  }
}

module.exports = {credentials, declaringModules, NAMES};
