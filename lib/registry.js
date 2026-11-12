'use strict';
// The npm registry, asked only by `ch-local upgrade` (spec §2: the only command
// that contacts it besides install, and only when the user runs it).
const REGISTRY = 'https://registry.npmjs.org/';

// [names] -> {name: latest version | null when npm does not have it}.
async function latestVersions(names, io) {
  const out = {};
  for (const name of names) {
    const res = await io.fetch(REGISTRY + name.replace('/', '%2F'), {headers: {accept: 'application/vnd.npm.install-v1+json'}});
    if (res.status === 404) { out[name] = null; continue; }
    if (!res.ok) throw new Error(`the npm registry answered ${res.status} for ${name}`);
    const body = await res.json();
    out[name] = body != null && body['dist-tags'] != null && typeof body['dist-tags'].latest === 'string' ? body['dist-tags'].latest : null;
  }
  return out;
}

module.exports = {latestVersions};
