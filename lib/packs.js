'use strict';
// The packs a home holds, which of them a start loads, and the remote
// credentials those may use (spec §2, many packs; plan Tasks 11 and 12b).
const fs = require('node:fs');
const path = require('node:path');
const {pickCredential} = require('./credential');

// A pack's scenario package, by the family's naming rule.
const scenarioOf = (pack) => `@countinghouse/ch-pack-${pack}`;

// where: layout(). -> [{name, scenario, packages, credentials}];
// [] when nothing is installed. Today the home holds one pack (installed.json).
function installedPacks(where) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(where.installed, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`${where.installed} is not readable JSON; run \`ch-local install\` again`);
  }
  return [{
    name: record.pack,
    scenario: scenarioOf(record.pack),
    packages: Object.keys(record.versions || {}),
    credentials: Array.isArray(record.credentials) ? record.credentials : []
  }];
}

// A pack's package is a direct dependency of the app, so npm puts it at the
// top of node_modules; missing or unreadable, the install is broken, and a
// start must not go ahead as if it declared no remotes.
function readManifest(appDir, name) {
  const file = path.join(appDir, 'node_modules', ...name.split('/'), 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `${name} is not installed under ${appDir}` : `${name}'s package.json is not readable (${err.code})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name}'s package.json is not readable JSON`);
  }
}

// The remotes the named packages declare (countinghouse.remotes), each as
// {origin, variables, from}; origin is null when the URL cannot be read, so
// the caller refuses it rather than skipping it. Throws for a package that is
// missing or unreadable.
function declaredRemotes(appDir, packages) {
  const out = [];
  for (const name of packages) {
    const manifest = readManifest(appDir, name);
    const remotes = manifest != null && manifest.countinghouse != null && Array.isArray(manifest.countinghouse.remotes) ? manifest.countinghouse.remotes : [];
    for (const remote of remotes) {
      const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
      if (!isObject(remote) || (remote.credential != null && !isObject(remote.credential))) { out.push({origin: null, variables: [], from: name}); continue; }
      let origin = null;
      try { origin = new URL(remote.url).origin; } catch (err) { origin = null; }
      const c = remote.credential || {};
      out.push({origin, variables: origin == null ? [] : [c.env, c.fallbackEnv].filter((v) => typeof v === 'string' && v !== ''), from: name});
    }
  }
  return out;
}

// -> {credentials: {origin: [variable, ...]}, refused: [{from, origin, variable?}]}.
// An origin not in `allowed`, or a variable not pinned to it, is refused.
function credentialUnion(remotes, allowed) {
  const credentials = {};
  const refused = [];
  for (const {origin, variables, from} of remotes) {
    if (origin == null || !Object.prototype.hasOwnProperty.call(allowed, origin)) { refused.push({from, origin}); continue; }
    const list = credentials[origin] || (credentials[origin] = []);
    for (const variable of variables) {
      if (!allowed[origin].includes(variable)) refused.push({from, origin, variable});
      else if (!list.includes(variable)) list.push(variable);
    }
  }
  return {credentials, refused};
}

// -> {load: [pack + {credential: <variable name>}], missing: [{name, variables}]}.
// Names only: the value is the runtime's to read.
function loadablePacks(packs, env) {
  const load = [];
  const missing = [];
  for (const pack of packs) {
    const chosen = pickCredential(env, pack.credentials);
    if (chosen == null && pack.credentials.length > 0) missing.push({name: pack.name, variables: pack.credentials});
    else load.push({...pack, credential: chosen == null ? null : chosen.name});
  }
  return {load, missing};
}

module.exports = {installedPacks, declaredRemotes, credentialUnion, loadablePacks, scenarioOf};
