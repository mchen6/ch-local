'use strict';
// The npm registry, asked only by `ch-local upgrade` (spec §2: the only command
// that contacts it besides install, and only when the user runs it), and by
// start's automatic check when the user has turned automatic upgrades on
// (lib/auto-upgrade.js; packs in place, part 2).
const REGISTRY = 'https://registry.npmjs.org/';

// [names] -> {name: latest version | null when npm does not have it}.
// signal: an AbortSignal that abandons the lookups (start's automatic check).
async function latestVersions(names, io, {signal} = {}) {
  const one = async (name) => {
    const res = await io.fetch(REGISTRY + name.replace('/', '%2F'), {headers: {accept: 'application/vnd.npm.install-v1+json'}, ...(signal != null ? {signal} : {})});
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the npm registry answered ${res.status} for ${name}`);
    const body = await res.json();
    return body != null && body['dist-tags'] != null && typeof body['dist-tags'].latest === 'string' ? body['dist-tags'].latest : null;
  };
  const latest = await Promise.all(names.map(one));
  return Object.fromEntries(names.map((name, i) => [name, latest[i]]));
}

module.exports = {latestVersions};
