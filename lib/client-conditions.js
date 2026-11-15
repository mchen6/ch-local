'use strict';
// Before every dialog (countinghouse part 3 P2, Task 4; plan
// docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md in countinghouse):
// may the client be asked to confirm a loosening? The runtime asks start
// (control may-elicit); start answers from the client's own configuration.
//
// MCP elicitation is not proof of a person: a client's own configuration can
// answer a dialog for the user. For Claude Code that is any Elicitation or
// ElicitationResult hook (whatever its matcher: start cannot know the name
// the user gave this server), a plugin a project brings, or an installed
// plugin's hook. So the answer is yes only when none is found in any scope
// Claude Code reads, the session says it is an interactive CLI one, and its
// project directory is known. Anything that cannot be read is no.
//
// A relative --settings or --plugin-dir (the client's own directory is not
// known for certain) is unreadable: no dialog. A plugin developer running
// Claude Code with one uses the terminal command instead.
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
const EVENTS = ['Elicitation', 'ElicitationResult'];
const CLAUDE_CODE = 'claude-code';
// the hits, in the order they are said; each holds for the whole start
const HITS = Object.freeze(['client hook present', 'project plugin or marketplace', 'plugin hook present']);
const UNREADABLE = 'client settings unreadable';

const MANAGED = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
};
// Other managed sources (said by the review of Task 4; checked again by the
// hand test): read as JSON when they are JSON, and when they are not (a
// configuration profile, a policy key), present is unreadable, so no form.
const MANAGED_JSON_ALSO = {win32: ['C:\\ProgramData\\ClaudeCode\\managed-settings.json']};
const MANAGED_PRESENT = {darwin: ['/Library/Managed Preferences/com.anthropic.claudecode.plist']};

class Unreadable extends Error {}

// A JSON file: its value, null when it does not exist, or Unreadable.
function readJson(file) {
  let st;
  try { st = fs.statSync(file); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Unreadable(file);
  }
  if (!st.isFile() || st.size > MAX_BYTES) throw new Unreadable(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Unreadable(file); }
}

// A directory's subdirectories, a symlink to one included: [] when it does
// not exist, or Unreadable (an entry that cannot be told counts).
function list(dir) {
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
    if (st.isDirectory()) out.push(p);
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

// One plugin's directory: its hooks/hooks.json, plugin.json's inline hooks,
// and every hook file plugin.json lists (one that is missing: unreadable).
function pluginHasHook(dir) {
  if (hasElicitationHook(readJson(path.join(dir, 'hooks', 'hooks.json')))) return true;
  const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  if (!isObject(manifest) || manifest.hooks == null) return false;
  for (const h of Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks]) {
    if (typeof h === 'string') {
      const config = readJson(path.resolve(dir, h));
      if (config == null) throw new Unreadable(h);
      if (hasElicitationHook(config)) return true;
    } else if (hasElicitationHook(h)) {
      return true;
    }
  }
  return false;
}

// The client's own flags, from any ancestor's command line: --settings (a
// file or inline JSON) and --plugin-dir, each as `--flag v` or `--flag=v`.
function flagsOf(lines) {
  const settings = [];
  const pluginDirs = [];
  for (const argv of lines) {
    for (let i = 0; i < argv.length; i++) {
      for (const [flag, into] of [['--settings', settings], ['--plugin-dir', pluginDirs]]) {
        if (argv[i] === flag && i + 1 < argv.length) into.push(argv[i + 1]);
        else if (argv[i].startsWith(`${flag}=`)) into.push(argv[i].slice(flag.length + 1));
      }
    }
  }
  return {settings, pluginDirs};
}

const ancestorsOf = (dir) => {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(d);
    if (path.dirname(d) === d) return out;
  }
};

// {client: {name, version}, home, cwd, env, platform, managedFile,
// parentCommandLines: () => [[argv...], ...] | null} -> {mayElicit, why}
// parentCommandLines: the client's ancestry as clientLines gives it (start
// reads it once, asynchronously: readAncestryAsync). Any error is no.
function clientConditions(args = {}) {
  try {
    return scan(args);
  } catch (err) {
    return {mayElicit: false, why: UNREADABLE};
  }
}

function scan({client, home = os.homedir(), cwd, env = process.env, platform = process.platform, managedFile, managedPresent = false, parentCommandLines = () => null} = {}) {
  if (client == null || client.name !== CLAUDE_CODE) return {mayElicit: false, why: 'no conditions known'};
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli' || env.CLAUDECODE !== '1') return {mayElicit: false, why: 'not an interactive session'};
  const projectDir = env.CLAUDE_PROJECT_DIR;
  let projectOk = false;
  try { projectOk = typeof projectDir === 'string' && path.isAbsolute(projectDir) && fs.statSync(projectDir).isDirectory(); } catch (err) { projectOk = false; }
  if (!projectOk) return {mayElicit: false, why: 'project directory unknown'};

  const found = new Set();
  // a cwd removed or unknown; a managed source start cannot read (a policy key)
  let unreadable = typeof cwd !== 'string' || !path.isAbsolute(cwd) || managedPresent === true;
  const attempt = (fn) => {
    try { fn(); } catch (err) {
      if (err instanceof Unreadable) unreadable = true; else throw err;
    }
  };
  const configDir = path.resolve(env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude'));

  // the client's command line (its --settings and --plugin-dir)
  let lines = null;
  try { lines = parentCommandLines(); } catch (err) { lines = null; }
  const flags = Array.isArray(lines) ? flagsOf(lines) : {settings: [], pluginDirs: []};
  if (!Array.isArray(lines)) unreadable = true;

  // hooks in every settings scope (the user's local file too, which is the
  // local scope when the project is the home)
  const settingsFiles = [path.join(configDir, 'settings.json'), path.join(configDir, 'settings.local.json')];
  const managed = managedFile || MANAGED[platform] || MANAGED.linux;
  settingsFiles.push(managed);
  if (managedFile == null) {
    settingsFiles.push(...(MANAGED_JSON_ALSO[platform] || []));
    for (const p of MANAGED_PRESENT[platform] || []) { if (fs.existsSync(p)) unreadable = true; }
  }
  attempt(() => {
    const d = path.join(path.dirname(managed), 'managed-settings.d');
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')); } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new Unreadable(d);
    }
    for (const n of names) settingsFiles.push(path.join(d, n));
  });
  const projectFiles = [];
  for (const dir of new Set([...ancestorsOf(projectDir), ...(unreadable && typeof cwd !== 'string' ? [] : ancestorsOf(cwd))])) {
    const claudeDir = path.join(dir, '.claude');
    if (path.resolve(claudeDir) === configDir) continue;   // the user's own, read above
    for (const n of ['settings.json', 'settings.local.json']) projectFiles.push(path.join(claudeDir, n));
  }
  for (const file of [...settingsFiles, ...projectFiles]) {
    attempt(() => {
      const s = readJson(file);
      if (hasElicitationHook(s)) found.add('client hook present');
      if (projectFiles.includes(file) && isObject(s) && (s.enabledPlugins != null || s.extraKnownMarketplaces != null)) found.add('project plugin or marketplace');
    });
  }
  for (const v of flags.settings) {
    attempt(() => {
      let s;
      if (v.trim().startsWith('{')) {
        try { s = JSON.parse(v); } catch (err) { throw new Unreadable('--settings'); }
      } else {
        // relative to the client's own directory, which start cannot know
        // for certain: unreadable
        if (!path.isAbsolute(v)) throw new Unreadable(v);
        s = readJson(v);
        if (s == null) throw new Unreadable(v);   // a flag naming nothing readable
      }
      if (hasElicitationHook(s)) found.add('client hook present');
    });
  }

  // installed plugins' hooks: <cache>/<marketplace>/<plugin>/<version>/, and
  // every --plugin-dir
  attempt(() => {
    const cache = env.CLAUDE_CODE_PLUGIN_CACHE_DIR ? path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR) : path.join(configDir, 'plugins', 'cache');
    const dirs = [];
    for (const m of list(cache)) for (const p of list(m)) for (const v of list(p)) {
      dirs.push(v);
      if (dirs.length > MAX_PLUGINS) throw new Unreadable(cache);
    }
    for (const d of flags.pluginDirs) {
      if (!path.isAbsolute(d)) throw new Unreadable(d);
      const abs = d;
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch (err) { isDir = false; }
      if (!isDir) throw new Unreadable(d);
      dirs.push(abs);
    }
    for (const d of dirs) attempt(() => { if (pluginHasHook(d)) found.add('plugin hook present'); });
  });

  for (const why of HITS) {
    if (found.has(why)) return {mayElicit: false, why};
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

// The client among start's ancestors: Claude Code's native binary (argv[0]
// claude, claude.exe) or its npm package (a path with claude-code). ->
// the lines up to and including it, nearest first, or null (not found, or a
// command line on the way that is empty: unread, as on Windows for an
// elevated process).
function clientLines(lines) {
  if (!Array.isArray(lines)) return null;
  const out = [];
  for (const argv of lines) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.every((a) => a === '')) return null;
    out.push(argv);
    const base = path.basename(String(argv[0]).replace(/\\/g, '/')).toLowerCase();
    if (/^claude(\.exe|\.cmd)?$/.test(base) || argv.slice(0, 2).some((a) => /claude-code/i.test(String(a)))) return out;
  }
  return null;
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
  execFile(cmd, args, {encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024}, (err, out) => (err ? reject(err) : resolve(out)));
});

// The command lines of pid and up to `depth` of its ancestors, nearest
// first: [[argv...], ...], or null when one cannot be read. Never blocks the
// event loop (on Windows it runs PowerShell, which takes seconds): start reads
// it once, and the client's command line does not change while it runs.
async function readAncestry(pid, depth = 8, platform = process.platform) {
  return (await readClientContext(pid, depth, platform)).lines;
}

// The ancestry, and on Windows whether a Claude Code policy key exists
// (HKLM or HKCU \\SOFTWARE\\Policies\\ClaudeCode): present, it is unreadable,
// so no form (whether Claude Code reads hooks from it is on the hand test's
// list), read by the same PowerShell. -> {lines | null, policyPresent}
async function readClientContext(pid, depth = 8, platform = process.platform) {
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
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30000);
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
        if (m == null) return null;
        ppid = Number(m[1]);
        argv = m[2].split(/\s+/);
      }
      lines.push(argv);
      if (!Number.isInteger(ppid) || ppid <= 1) break;
      p = ppid;
    }
    return {lines: lines.length > 0 ? lines : null, policyPresent: false};
  } catch (err) {
    return {lines: null, policyPresent: true};
  }
}

// start's service: the client's ancestry read once, in the background; a
// first scan latching a hit for the whole start once it is in; check(client)
// answers within waitMs (under the runtime's 5 s), unreadable while the
// ancestry is still being read.
// ancestry: a promise of the client's lines (clientLines), or of {lines,
// policyPresent}.
function conditionsService(args, {ancestry = readClientContext(process.ppid).then((c) => ({lines: clientLines(c.lines), policyPresent: c.policyPresent})), waitMs = 3000} = {}) {
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

module.exports = {clientConditions, conditionsLatch, conditionsService, readAncestry, readClientContext, clientLines, splitWindows, hasElicitationHook, CLAUDE_CODE, HITS};
