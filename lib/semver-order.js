'use strict';
// Semantic Versioning 2.0.0 precedence (section 11), prereleases included:
// 1.2.0-rc.1 < 1.2.0, 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta, numeric
// identifiers compare numerically and below alphanumeric ones; build
// metadata (+...) is ignored. Used to tell whose record a start holds
// (lib/packs.js recordRelease).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC = /^\d+$/;

function parse(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null;
  if (m == null) return null;
  return {core: [m[1], m[2], m[3]].map(BigInt), pre: m[4] != null ? m[4].split('.') : []};
}

function compareIds(a, b) {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// -> -1, 0 or 1 (a against b), or null when either is not a version
function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (x == null || y == null) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  // a version with a prerelease is below the same version without one
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const c = compareIds(x.pre[i], y.pre[i]);
    if (c !== 0) return c;
  }
  return x.pre.length === y.pre.length ? 0 : x.pre.length < y.pre.length ? -1 : 1;
}

module.exports = {compareVersions};
