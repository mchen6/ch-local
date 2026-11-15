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
// The entrypoint gate is a hint for honest unattended hosts only: a session
// nested under a shell inherits 'cli'. That residual is documented (the
// plan's Q1: "this start only" is one runtime process).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const MAX_BYTES = 1024 * 1024;
const MAX_PLUGINS = 2000;
const EVENTS = ['Elicitation', 'ElicitationResult'];

const MANAGED = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
};

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

// A directory's entries: [] when it does not exist, or Unreadable.
function list(dir) {
  try { return fs.readdirSync(dir, {withFileTypes: true}).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw new Unreadable(dir);
  }
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
function clientConditions({client, home = os.homedir(), cwd = process.cwd(), env = process.env, platform = process.platform, managedFile, parentCommandLines = () => readAncestry(process.ppid, 4)} = {}) {
  if (client == null || client.name !== 'claude-code') return {mayElicit: false, why: 'no conditions known'};
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli' || env.CLAUDECODE !== '1') return {mayElicit: false, why: 'not an interactive session'};
  const projectDir = env.CLAUDE_PROJECT_DIR;
  let projectOk = false;
  try { projectOk = typeof projectDir === 'string' && path.isAbsolute(projectDir) && fs.statSync(projectDir).isDirectory(); } catch (err) { projectOk = false; }
  if (!projectOk) return {mayElicit: false, why: 'project directory unknown'};

  const found = new Set();
  let unreadable = false;
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

  // hooks in every settings scope
  const settingsFiles = [path.join(configDir, 'settings.json')];
  const managed = managedFile || MANAGED[platform] || MANAGED.linux;
  settingsFiles.push(managed);
  attempt(() => {
    const d = path.join(path.dirname(managed), 'managed-settings.d');
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')); } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new Unreadable(d);
    }
    for (const n of names) settingsFiles.push(path.join(d, n));
  });
  const projectFiles = [];
  for (const dir of new Set([...ancestorsOf(projectDir), ...ancestorsOf(cwd)])) {
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
        s = readJson(path.resolve(cwd, v));
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
      const abs = path.resolve(cwd, d);
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch (err) { isDir = false; }
      if (!isDir) throw new Unreadable(d);
      dirs.push(abs);
    }
    for (const d of dirs) attempt(() => { if (pluginHasHook(d)) found.add('plugin hook present'); });
  });

  for (const why of ['client hook present', 'project plugin or marketplace', 'plugin hook present']) {
    if (found.has(why)) return {mayElicit: false, why};
  }
  if (unreadable) return {mayElicit: false, why: 'client settings unreadable'};
  return {mayElicit: true, why: null};
}

// A hit holds for the whole start: once a hook (or a project's plugin) has
// been seen, no dialog until restart, though it is removed (a hook deleted
// just before a form does not help). Every check re-scans as well.
const LATCHED = new Set(['client hook present', 'project plugin or marketplace', 'plugin hook present']);
function conditionsLatch() {
  let latched = null;
  return (args) => {
    if (latched != null) return {mayElicit: false, why: latched};
    const r = clientConditions(args);
    if (LATCHED.has(r.why)) latched = r.why;
    return r;
  };
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

// The command lines of pid and up to `depth` of its ancestors, nearest
// first: [[argv...], ...], or null when one cannot be read.
function readAncestry(pid, depth = 4, platform = process.platform) {
  try {
    if (platform === 'win32') {
      const script = [
        "$ErrorActionPreference='Stop'",
        "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Management')",
        `$p=${Number(pid)}`,
        `for($i=0;$i -le ${Number(depth)} -and $p -gt 0;$i++){`,
        "$s=[System.Management.ManagementObjectSearcher]::new(\"SELECT ParentProcessId,CommandLine FROM Win32_Process WHERE ProcessId=$p\")",
        '$o=$null; foreach($x in $s.Get()){$o=$x}',
        'if($o -eq $null){break}',
        "$c=[string]$o['CommandLine']",
        "[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c)))",
        "$p=[int]$o['ParentProcessId']}"
      ].join(';');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', timeout: 15000, windowsHide: true});
      const lines = out.split(/\r?\n/).filter(Boolean).map((b) => splitWindows(Buffer.from(b, 'base64').toString('utf8')));
      return lines.length > 0 ? lines : null;
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
        const out = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(p)], {encoding: 'utf8', timeout: 5000}).trim();
        const m = /^(\d+)\s+(.*)$/s.exec(out);
        if (m == null) return null;
        ppid = Number(m[1]);
        argv = m[2].split(/\s+/);
      }
      lines.push(argv);
      if (!Number.isInteger(ppid) || ppid <= 1) break;
      p = ppid;
    }
    return lines.length > 0 ? lines : null;
  } catch (err) {
    return null;
  }
}

module.exports = {clientConditions, conditionsLatch, readAncestry, splitWindows, hasElicitationHook};
