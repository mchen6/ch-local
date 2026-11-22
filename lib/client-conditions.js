'use strict';
// Before every dialog (countinghouse part 3 P2, Task 4; plan
// docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md in countinghouse):
// may the client be asked to confirm a loosening? The runtime asks start
// (control may-elicit); start answers from the client's own configuration.
//
// The scan follows Claude Code 2.1.323's known parsing (its front matter,
// its sources); drift in a later version is covered by the exact-version
// tested list and the automated re-test's surface diff, not by this file.
//
// MCP elicitation is not proof of a person: a client's own configuration can
// answer a dialog for the user. For Claude Code that is any Elicitation or
// ElicitationResult hook (whatever its matcher: start cannot know the name
// the user gave this server), a plugin a project brings, or an installed
// plugin's hook. So the answer is yes only when none is found in any source
// below, the session says it is an interactive CLI one, and its project
// directory is known. Anything that cannot be read is no.
//
// A list of sources is fail-open by nature: the next Claude Code version may
// read one more. So what start does not know is no too: a flag on the
// client's command line that is not on SAFE_FLAGS (known not to touch hooks
// or plugins), and a CLAUDE_CODE_* variable naming a plugin, settings, hook,
// managed or policy source that the scan does not handle. And the runtime's
// tested-client list (countinghouse lib/elicitation-clients.json) names
// exact tested version ranges, so a new version gets no form until it is
// re-tested (automatically: lib/client-conditions-fixtures.js holds that
// harness's fixtures, one per source).
//
// A relative --settings, --plugin-dir or --add-dir (the client's own
// directory is not known for certain) is unreadable: no dialog. A plugin
// developer running Claude Code with one uses the terminal command instead.
//
// The entrypoint gate is a hint for honest unattended hosts only: a session
// nested under a shell inherits 'cli'. That residual is documented (the
// plan's Q1: "this start only" is one runtime process).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');

const MAX_BYTES = 1024 * 1024;
const MAX_PLUGINS = 2000;
const MAX_TEXT_FILES = 2000;
const EVENTS = ['Elicitation', 'ElicitationResult'];
const CLAUDE_CODE = 'claude-code';
// the hits, in the order they are said; each holds for the whole start
const HITS = Object.freeze(['client hook present', 'project plugin or marketplace', 'plugin hook present']);
const UNREADABLE = 'client settings unreadable';
// every reason a verdict of no can carry: a closed set, so a why that leaves
// this process (the conditions line) is never free text
const REASONS = Object.freeze([...HITS, UNREADABLE, 'no conditions known', 'not an interactive session', 'project directory unknown']);

const MANAGED = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
};
// Other managed sources (said by the reviews of Task 4; checked by the
// re-test): read as JSON when they are JSON; when they are not (a
// configuration profile, a policy key), present is unreadable, so no form.
const MANAGED_JSON_ALSO = {win32: ['C:\\ProgramData\\ClaudeCode\\managed-settings.json']};
const MANAGED_WSL = '/mnt/c/Program Files/ClaudeCode/managed-settings.json';
const MANAGED_PRESENT = {darwin: ['/Library/Managed Preferences/com.anthropic.claudecode.plist']};

// The client's flags known not to add a hook or a plugin. Any other flag
// (one a new version adds) is unreadable. A flag's value is never checked
// here: a token that does not start with '-' is a value or the prompt.
const SAFE_FLAGS = new Set([
  '--resume', '-r', '--continue', '-c', '--model', '--fallback-model', '--verbose', '--debug', '-d', '--mcp-debug',
  '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools',
  '--mcp-config', '--strict-mcp-config', '--append-system-prompt', '--system-prompt', '--session-id', '--fork-session',
  '--ide', '--setting-sources', '--version', '-v', '--help', '-h'
]);
// The flags the scan reads (on any ancestor's command line), and those that
// are unreadable whatever their value.
const SCANNED_FLAGS = {'--settings': 'settings', '--managed-settings': 'settings', '--plugin-dir': 'pluginDirs', '--plugin-dir-no-mcp': 'pluginDirs', '--add-dir': 'addDirs'};
const UNREADABLE_FLAGS = new Set(['--plugin-url']);

// Environment: the plugin sources the scan reads, those it cannot, and the
// rule for any other.
// Names compared in upper case (Windows' environment is case-insensitive).
const ENV_SCANNED = new Set(['CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_SEED_DIR', 'CLAUDE_CONFIG_DIR']);
const ENV_UNREADABLE = new Set(['CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE', 'CLAUDE_CODE_USE_COWORK_PLUGINS']);
// What Claude Code (2.1.326-2.1.330, read in its binary) sets for a plugin's
// own process -- its stdio MCP server, a hook: CLAUDE_PLUGIN_ROOT, the
// plugin's directory, scanned below as a plugin (on its real path, as a
// --plugin-dir); CLAUDE_PLUGIN_DATA, the plugin's data directory
// (<plugins>/data/<id>, only ever handed to the plugin's processes, never
// loaded from); CLAUDE_PLUGIN_OPTION_<KEY>, its user-config values (a hook's
// environment). Each by its exact name; any other CLAUDE_PLUGIN_* is still
// unreadable. In the process environment only: a settings file's env block
// naming them stays unreadable.
const ENV_PLUGIN_OWN = new Set(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']);
const ENV_PLUGIN_OPTION = /^CLAUDE_PLUGIN_OPTION_[A-Z0-9_]+$/;
const envRisky = (name) => /^CLAUDE_/.test(String(name).toUpperCase())
  && /(PLUGIN|SETTINGS|HOOK|MANAGED|POLICY|SKILL|MARKETPLACE|MODS|CONFIG_DIR)/.test(String(name).toUpperCase());

class Unreadable extends Error {}

// A file's bytes as text: null when it does not exist, or Unreadable.
function readText(file) {
  let st;
  try { st = fs.statSync(file); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Unreadable(file);
  }
  if (!st.isFile() || st.size > MAX_BYTES) throw new Unreadable(file);
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { throw new Unreadable(file); }
}

// A JSON file: its value, null when it does not exist, or Unreadable.
function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch (err) { throw new Unreadable(file); }
}

// A directory's subdirectories (or files), a symlink to one included: []
// when it does not exist, or Unreadable (an entry that cannot be told counts).
function list(dir, {files = false} = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw new Unreadable(dir);
  }
  const out = [];
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch (err) { throw new Unreadable(p); }
    if (files ? st.isFile() : st.isDirectory()) out.push(p);
  }
  return out;
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// A hooks configuration, as a settings file or hooks.json has it ({hooks:
// {Event: [...]}}) or inline ({Event: [...]}): any Elicitation or
// ElicitationResult entry that is not an empty list counts.
function hasElicitationHook(config) {
  for (const o of [config, isObject(config) ? config.hooks : null]) {
    if (!isObject(o)) continue;
    for (const e of EVENTS) {
      if (Object.prototype.hasOwnProperty.call(o, e) && !(Array.isArray(o[e]) && o[e].length === 0)) return true;
    }
  }
  return false;
}

// A settings object's env block naming a source (a project file can set
// one): unreadable.
function envBlockUnreadable(settings) {
  if (!isObject(settings) || settings.env == null) return false;
  if (!isObject(settings.env)) return true;
  return Object.keys(settings.env).some((k) => envRisky(k) || ENV_SCANNED.has(String(k).toUpperCase()) || ENV_UNREADABLE.has(String(k).toUpperCase()));
}

// Markdown a hook may be declared in (skills, agents and commands carry
// hooks in their front matter): any mention of the events counts, unparsed.
// What could spell one without the plain word is unreadable: a NUL or a
// UTF-16 byte-order mark in the file, a backslash in its front matter (a
// YAML escape), a tree past the depth limit.
const MD_DEPTH = 8;
function mdMentions(file) {
  let st;
  try { st = fs.statSync(file); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw new Unreadable(file);
  }
  if (!st.isFile() || st.size > MAX_BYTES) throw new Unreadable(file);
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (err) { throw new Unreadable(file); }
  if (bytes.includes(0) || (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))) throw new Unreadable(file);
  const text = bytes.toString('utf8');
  if (EVENTS.some((e) => text.includes(e))) return true;
  // front matter as broadly as any parser could take it (2.1.323's is
  // /^---\s*\n([\s\S]*?)---\s*\n?/): after a byte-order mark and leading
  // white space, a '---' opens it, whatever follows on its line, and it runs
  // to the next '---' anywhere, or to the end
  const lead = text.replace(/^\uFEFF/, '').replace(/^\s*/, '');
  if (lead.startsWith('---')) {
    const rest = lead.slice(3);
    const end = rest.indexOf('---');
    if ((end === -1 ? rest : rest.slice(0, end)).includes('\\')) throw new Unreadable(file);
  }
  return false;
}
// Every *.md under dir, to MD_DEPTH (past it: unreadable, never skipped).
function mdFiles(dir, count, depth = 0) {
  if (depth > MD_DEPTH) throw new Unreadable(dir);
  const out = [];
  for (const f of list(dir, {files: true})) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    count.n += 1;
    if (count.n > MAX_TEXT_FILES) throw new Unreadable(dir);
    out.push(f);
  }
  for (const sub of list(dir)) { if (path.basename(sub) !== '.git') out.push(...mdFiles(sub, count, depth + 1)); }
  return out;
}
// A .claude directory's skills, agents and commands.
function textMentions(dir, count) {
  for (const sub of ['skills', 'agents', 'commands']) {
    for (const f of mdFiles(path.join(dir, sub), count)) if (mdMentions(f)) return true;
  }
  return false;
}

// One plugin's directory: its hooks/hooks.json, plugin.json's inline hooks,
// every hook file plugin.json lists (one that is missing: unreadable), and
// every *.md in its whole tree (its skills, agents and commands, wherever
// plugin.json points them).
function pluginHasHook(dir, count) {
  if (hasElicitationHook(readJson(path.join(dir, 'hooks', 'hooks.json')))) return true;
  const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  if (isObject(manifest) && manifest.hooks != null) {
    for (const h of Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks]) {
      if (typeof h === 'string') {
        const config = readJson(path.resolve(dir, h));
        if (config == null) throw new Unreadable(h);
        if (hasElicitationHook(config)) return true;
      } else if (hasElicitationHook(h)) {
        return true;
      }
    }
  }
  for (const f of mdFiles(dir, count)) if (mdMentions(f)) return true;
  return false;
}

// A token naming the client: Claude Code's native binary (claude,
// claude.exe) or its npm package (a path with claude-code).
const isClientToken = (a) => {
  const base = path.basename(String(a).replace(/\\/g, '/')).toLowerCase();
  return /^claude(\.exe|\.cmd)?$/.test(base) || /claude-code/i.test(String(a));
};

// Flags from every ancestor's command line: the scanned ones, anything
// unreadable, and after the client's own token (wherever it sits) any flag
// not known safe. Never stopped at '--' (macOS splits a command line on
// whitespace, so a prompt's own '--' could hide a later flag). --add-dir
// takes every following token that is not a flag.
const VARIADIC = new Set(['--add-dir']);
function flagsOf(lines) {
  const out = {settings: [], pluginDirs: [], addDirs: [], unreadable: false};
  for (const argv of lines) {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) { out.unreadable = true; continue; }
    const at = argv.findIndex(isClientToken);
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (!t.startsWith('-') || t === '-' || t === '--') continue;
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      if (Object.prototype.hasOwnProperty.call(SCANNED_FLAGS, name)) {
        const into = out[SCANNED_FLAGS[name]];
        if (eq !== -1) {
          into.push(t.slice(eq + 1));
        } else if (VARIADIC.has(name)) {
          let n = 0;
          while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) { into.push(argv[i + 1]); i += 1; n += 1; }
          if (n === 0) out.unreadable = true;
        } else if (i + 1 < argv.length) {
          into.push(argv[i + 1]);
          i += 1;
        } else {
          out.unreadable = true;
        }
      } else if (UNREADABLE_FLAGS.has(name)) {
        out.unreadable = true;
      } else if (at !== -1 && i > at && !SAFE_FLAGS.has(name)) {
        out.unreadable = true;   // a flag start does not know
      }
    }
  }
  return out;
}

// dir and every directory above it, up to the filesystem root, or up to
// stopAt (included) when dir is inside it: a test's own world, so the walk
// never reaches the developer's real home whatever the temp directory
const ancestorsOf = (dir, stopAt = null) => {
  const out = [];
  const stop = stopAt != null ? path.resolve(stopAt) : null;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(d);
    if (d === stop || path.dirname(d) === d) return out;
  }
};

// Directories from depth 0 (root itself) to `depth` below it.
function dirsUnder(root, depth) {
  const out = [root];
  let level = [root];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const dir of level) next.push(...list(dir));
    if (out.length + next.length > MAX_PLUGINS) throw new Unreadable(root);
    out.push(...next);
    level = next;
  }
  return out;
}

// parentCommandLines: the client's ancestry as clientLines gives it (start
// reads it once, asynchronously: readClientContext). managedPresent: a
// managed source start cannot read (a policy key). Any error is no.
function clientConditions(args = {}) {
  try {
    return scan(args);
  } catch (err) {
    return {mayElicit: false, why: UNREADABLE};
  }
}

// stopAt: tests only, their own temp root: the walk up from the project
// stops there. withAt: a hit's verdict also says where it was first seen (`at`: a file or
// directory, or null), for the conditions line's why; otherwise the verdict
// is {mayElicit, why} alone
function scan({client, home = os.homedir(), cwd, env = process.env, platform = process.platform, managedFile, managedPresent = false, parentCommandLines = () => null, withAt = false, stopAt = null} = {}) {
  if (client == null || client.name !== CLAUDE_CODE) return {mayElicit: false, why: 'no conditions known'};
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli' || env.CLAUDECODE !== '1') return {mayElicit: false, why: 'not an interactive session'};
  const projectDir = env.CLAUDE_PROJECT_DIR;
  let projectOk = false;
  try { projectOk = typeof projectDir === 'string' && path.isAbsolute(projectDir) && fs.statSync(projectDir).isDirectory(); } catch (err) { projectOk = false; }
  if (!projectOk) return {mayElicit: false, why: 'project directory unknown'};

  const found = new Set();
  // where each hit was first seen (a file or a directory), for the why
  const firstAt = new Map();
  const hit = (why, at = null) => { found.add(why); if (!firstAt.has(why) && typeof at === 'string') firstAt.set(why, at); };
  // a cwd removed or unknown; a managed source start cannot read
  let unreadable = typeof cwd !== 'string' || !path.isAbsolute(cwd) || managedPresent === true;
  const attempt = (fn) => {
    try { fn(); } catch (err) {
      if (err instanceof Unreadable) unreadable = true; else throw err;
    }
  };
  const count = {n: 0};
  const sameDir = (a, b) => ((platform === 'win32' || platform === 'darwin') ? a.toLowerCase() === b.toLowerCase() : a === b);

  // the environment: a source the scan does not know is unreadable
  for (const [k, v] of Object.entries(env)) {
    if (v == null || v === '') continue;
    const K = String(k).toUpperCase();
    // (the plugin's own, by its exact name: known; ROOT and DATA absolute)
    if (K === k && (ENV_PLUGIN_OWN.has(K) || ENV_PLUGIN_OPTION.test(K))) {
      if (ENV_PLUGIN_OWN.has(K) && !path.isAbsolute(v)) unreadable = true;
      continue;
    }
    if (ENV_UNREADABLE.has(K) || (envRisky(K) && !ENV_SCANNED.has(K))) unreadable = true;
    if (ENV_SCANNED.has(K) && K !== k) unreadable = true;   // read by its exact name below: another spelling is not
  }
  if (env.CLAUDE_CONFIG_DIR && !path.isAbsolute(env.CLAUDE_CONFIG_DIR)) unreadable = true;
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude'));

  // the command lines (every ancestor's; the client's own against SAFE_FLAGS)
  let lines = null;
  try { lines = parentCommandLines(); } catch (err) { lines = null; }
  const flags = Array.isArray(lines) ? flagsOf(lines) : {settings: [], pluginDirs: [], addDirs: [], unreadable: true};
  if (flags.unreadable) unreadable = true;

  // settings: hooks, a project's plugins, an env block naming a source
  const check = (s, {project = false, file = null} = {}) => {
    if (hasElicitationHook(s)) hit('client hook present', file);
    if (project && isObject(s) && (s.enabledPlugins != null || s.extraKnownMarketplaces != null)) hit('project plugin or marketplace', file);
    if (envBlockUnreadable(s)) unreadable = true;
  };
  const settingsFiles = ['settings.json', 'settings.local.json', 'remote-settings.json'].map((n) => path.join(configDir, n));
  const managed = managedFile || MANAGED[platform] || MANAGED.linux;
  const managedFiles = [managed];
  if (managedFile == null) {
    managedFiles.push(...(MANAGED_JSON_ALSO[platform] || []));
    if (platform === 'linux' && env.WSL_DISTRO_NAME) managedFiles.push(MANAGED_WSL);
    for (const p of MANAGED_PRESENT[platform] || []) { if (fs.existsSync(p)) unreadable = true; }
  }
  for (const m of managedFiles) {
    settingsFiles.push(m);
    attempt(() => {
      const d = path.join(path.dirname(m), 'managed-settings.d');
      let names = [];
      try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')); } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new Unreadable(d);
      }
      for (const n of names) settingsFiles.push(path.join(d, n));
    });
  }
  for (const file of settingsFiles) attempt(() => check(readJson(file), {file}));
  // server-managed settings: any mention of the events, anywhere in it
  attempt(() => {
    const text = readText(path.join(configDir, 'remote-settings.json'));
    if (text != null && EVENTS.some((e) => text.includes(e))) hit('client hook present', path.join(configDir, 'remote-settings.json'));
  });

  // projects: the project's, the cwd's and every --add-dir's .claude, with
  // their ancestors (the user's own .claude, met on the way, read above)
  const dirs = new Set([...ancestorsOf(projectDir, stopAt), ...(typeof cwd === 'string' && path.isAbsolute(cwd) ? ancestorsOf(cwd, stopAt) : [])]);
  for (const d of flags.addDirs) {
    if (!path.isAbsolute(d)) { unreadable = true; continue; }
    for (const a of ancestorsOf(d, stopAt)) dirs.add(a);
  }
  const claudeDirs = [configDir];
  for (const dir of dirs) {
    const claudeDir = path.join(dir, '.claude');
    if (sameDir(path.resolve(claudeDir), configDir)) continue;
    claudeDirs.push(claudeDir);
    for (const n of ['settings.json', 'settings.local.json']) attempt(() => check(readJson(path.join(claudeDir, n)), {project: true, file: path.join(claudeDir, n)}));
  }
  // skills, agents and commands, in the user's and every project's .claude
  for (const d of claudeDirs) attempt(() => { if (textMentions(d, count)) hit('client hook present', d); });

  // the flags' settings: a file (absolute) or inline JSON
  for (const v of flags.settings) {
    attempt(() => {
      let s;
      if (v.trim().startsWith('{')) {
        try { s = JSON.parse(v); } catch (err) { throw new Unreadable('--settings'); }
      } else {
        if (!path.isAbsolute(v)) throw new Unreadable(v);
        s = readJson(v);
        if (s == null) throw new Unreadable(v);   // a flag naming nothing readable
      }
      check(s, {file: v.trim().startsWith('{') ? null : v});
    });
  }

  // installed plugins' hooks: <root>/cache/<marketplace>/<plugin>/<version>/
  // (the root is CLAUDE_CODE_PLUGIN_CACHE_DIR, or <config>/plugins), every
  // --plugin-dir and CLAUDE_CODE_PLUGIN_DIRS entry with its children, and
  // CLAUDE_CODE_PLUGIN_SEED_DIR to four levels
  attempt(() => {
    const root = env.CLAUDE_CODE_PLUGIN_CACHE_DIR ? env.CLAUDE_CODE_PLUGIN_CACHE_DIR : path.join(configDir, 'plugins');
    if (!path.isAbsolute(root)) throw new Unreadable(root);
    const plugins = [];
    for (const m of list(path.join(root, 'cache'))) for (const p of list(m)) for (const v of list(p)) plugins.push(v);
    const split = (v) => v.split(path.delimiter === ';' ? /[;,]/ : /[:,]/).filter(Boolean);
    const given = [...flags.pluginDirs];
    if (env.CLAUDE_CODE_PLUGIN_DIRS) given.push(...split(env.CLAUDE_CODE_PLUGIN_DIRS));
    for (const d of given) {
      if (!path.isAbsolute(d)) throw new Unreadable(d);
      let isDir = false;
      try { isDir = fs.statSync(d).isDirectory(); } catch (err) { isDir = false; }
      if (!isDir) throw new Unreadable(d);
      plugins.push(...dirsUnder(d, 1));   // a plugin, or a folder of them
    }
    // the plugin this process is (the plugin route's CLAUDE_PLUGIN_ROOT): on
    // its real path, a directory, scanned as one plugin -- beside the cache
    // and the rest, never in their place
    if (env.CLAUDE_PLUGIN_ROOT) {
      const r = env.CLAUDE_PLUGIN_ROOT;
      if (!path.isAbsolute(r)) throw new Unreadable(r);
      let real;
      try { real = fs.realpathSync.native(r); } catch (err) { throw new Unreadable(r); }
      let isDir = false;
      try { isDir = fs.statSync(real).isDirectory(); } catch (err) { isDir = false; }
      if (!isDir) throw new Unreadable(r);
      plugins.push(real);
    }
    for (const seed of env.CLAUDE_CODE_PLUGIN_SEED_DIR ? split(env.CLAUDE_CODE_PLUGIN_SEED_DIR) : []) {
      if (!path.isAbsolute(seed)) throw new Unreadable(seed);
      plugins.push(...dirsUnder(seed, 4));
    }
    if (plugins.length > MAX_PLUGINS) throw new Unreadable(root);
    for (const d of plugins) attempt(() => { if (pluginHasHook(d, count)) hit('plugin hook present', d); });
  });

  // at: where it was first seen, when a file or directory (never inline
  // settings), for the conditions line's why
  for (const why of HITS) {
    if (found.has(why)) return withAt ? {mayElicit: false, why, at: firstAt.has(why) ? firstAt.get(why) : null} : {mayElicit: false, why};
  }
  if (unreadable) return {mayElicit: false, why: UNREADABLE};
  return {mayElicit: true, why: null};
}

// A hit holds for the whole start: once a hook (or a project's plugin) has
// been seen, no dialog until restart, though it is removed (a hook deleted
// just before a form does not help). Every check re-scans as well.
function conditionsLatch() {
  let latched = null;
  return (args) => {
    if (latched != null) return {mayElicit: false, why: latched};
    const r = clientConditions(args);
    if (HITS.includes(r.why)) latched = r.why;
    return r;
  };
}

// The client among start's ancestors: every line read (a wrapper above or
// below the client cannot hide a flag: each is scanned), when one of them is
// the client; null when none is, or a command line on the way is empty
// (unread, as on Windows for an elevated process).
function clientLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (lines.some((argv) => !Array.isArray(argv) || argv.length === 0 || argv.every((a) => a === ''))) return null;
  return lines.some((argv) => argv.some(isClientToken)) ? lines : null;
}

// Windows command lines, split as CommandLineToArgvW does (quotes, and
// backslashes before a quote); a misread names nothing readable, which is no.
function splitWindows(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2 === 1) { cur += '"'; } else { quoted = !quoted; } any = true; } else { cur += '\\'.repeat(n); i--; any = true; }
    } else if (c === '"') { quoted = !quoted; any = true; } else if (!quoted && (c === ' ' || c === '\t')) {
      if (any) { out.push(cur); cur = ''; any = false; }
    } else { cur += c; any = true; }
  }
  if (any) out.push(cur);
  return out;
}

const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, {encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024}, (err, out, errOut) => {
    if (err) { err.stdout = out; err.stderr = errOut; reject(err); } else resolve(out);
  });
});

// The command lines of pid and up to `depth` of its ancestors, nearest
// first: [[argv...], ...], or null when one cannot be read.
async function readAncestry(pid, depth = 8, platform = process.platform) {
  return (await readClientContext(pid, depth, platform)).lines;
}

// Whether a Claude Code policy key exists, by reg.exe (WSL): present, or a
// failure to tell, is true.
async function wslPolicyPresent() {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      await run('reg.exe', ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`], 10000);
      return true;   // found
    } catch (err) {
      // reg.exe exits 1 and says so when the key is not there
      if (!(err && err.code === 1 && /unable to find/i.test(String(err.stderr || '') + String(err.stdout || '')))) return true;
    }
  }
  return false;
}

// The ancestry, and whether a managed source start cannot read is present
// (on Windows, and under WSL, a Claude Code policy key: HKLM or HKCU
// \SOFTWARE\Policies\ClaudeCode; whether Claude Code reads hooks from it is
// on the re-test's list). Never blocks the event loop (PowerShell takes
// seconds); start reads it once, and the client's command line does not
// change while it runs. -> {lines | null, policyPresent}
async function readClientContext(pid, depth = 8, platform = process.platform, env = process.env) {
  try {
    if (platform === 'win32') {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$k='SOFTWARE\\Policies\\ClaudeCode'",
        "if(([Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($k) -ne $null) -or ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($k) -ne $null)){[Console]::Out.WriteLine('POLICY')}else{[Console]::Out.WriteLine('NOPOLICY')}",
        "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Management')",
        `$p=${Number(pid)}`,
        `for($i=0;$i -le ${Number(depth)} -and $p -gt 0;$i++){`,
        "$s=[System.Management.ManagementObjectSearcher]::new(\"SELECT ParentProcessId,CommandLine FROM Win32_Process WHERE ProcessId=$p\")",
        '$o=$null; foreach($x in $s.Get()){$o=$x}',
        'if($o -eq $null){break}',
        "$c=[string]$o['CommandLine']",
        // an empty command line (unread) is said as '-', never dropped
        "if($c -eq ''){[Console]::Out.WriteLine('-')}else{[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c)))}",
        "$p=[int]$o['ParentProcessId']}"
      ].join(';');
      // by its absolute path in the Windows directory, never by name: the
      // search for a program looks in the current directory first
      const out = await run(require('./win-acl').powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], 30000);
      const raw = out.split(/\r?\n/).filter((l) => l !== '');
      const policy = raw.shift();
      if (policy !== 'POLICY' && policy !== 'NOPOLICY') return {lines: null, policyPresent: true};
      const lines = raw.map((b) => (b === '-' ? [] : splitWindows(Buffer.from(b, 'base64').toString('utf8'))));
      return {lines: lines.length > 0 ? lines : null, policyPresent: policy === 'POLICY'};
    }
    const lines = [];
    let p = Number(pid);
    for (let i = 0; i <= depth && p > 0; i++) {
      let argv;
      let ppid;
      if (platform === 'linux') {
        argv = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0');
        if (argv[argv.length - 1] === '') argv.pop();
        const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
        ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      } else {
        const out = (await run('ps', ['-o', 'ppid=,args=', '-p', String(p)], 5000)).trim();
        const m = /^(\d+)\s+(.*)$/s.exec(out);
        if (m == null) return {lines: null, policyPresent: false};
        ppid = Number(m[1]);
        argv = m[2].split(/\s+/);
      }
      lines.push(argv);
      if (!Number.isInteger(ppid) || ppid <= 1) break;
      p = ppid;
    }
    const policyPresent = platform === 'linux' && env.WSL_DISTRO_NAME ? await wslPolicyPresent() : false;
    return {lines: lines.length > 0 ? lines : null, policyPresent};
  } catch (err) {
    return {lines: null, policyPresent: true};
  }
}

// start's service: the client's ancestry read once, in the background; a
// first scan latching a hit for the whole start once it is in; check(client)
// answers within waitMs (under the runtime's 5 s), unreadable while the
// ancestry is still being read. ancestry: a promise of the client's lines
// (clientLines), or of {lines, policyPresent}.
function conditionsService(args, {ancestry, waitMs = 3000} = {}) {
  if (ancestry === undefined) {
    ancestry = readClientContext(process.ppid, 8, args.platform, args.env).then((c) => ({lines: clientLines(c.lines), policyPresent: c.policyPresent}));
  }
  const latch = conditionsLatch();
  let lines;   // undefined while being read
  let policyPresent = false;
  const ready = Promise.resolve(ancestry).then((l) => {
    if (l != null && !Array.isArray(l)) { lines = l.lines; policyPresent = l.policyPresent === true; } else { lines = l; }
  }, () => { lines = null; });
  ready.then(() => latch({...args, managedPresent: policyPresent, client: {name: CLAUDE_CODE, version: '0.0.0'}, parentCommandLines: () => lines}));
  return {
    ready,
    async check(client) {
      if (lines === undefined) {
        await Promise.race([ready, new Promise((r) => { const t = setTimeout(r, waitMs); if (typeof t.unref === 'function') t.unref(); })]);
      }
      if (lines === undefined) return {mayElicit: false, why: UNREADABLE};
      return latch({...args, managedPresent: policyPresent, client, parentCommandLines: () => lines});
    }
  };
}

module.exports = {clientConditions, conditionsLatch, conditionsService, readAncestry, readClientContext, clientLines, splitWindows,
  hasElicitationHook, flagsOf, CLAUDE_CODE, HITS, UNREADABLE, REASONS, SAFE_FLAGS, SCANNED_FLAGS};
