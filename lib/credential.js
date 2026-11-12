'use strict';
// The credential a launcher uses: the first of `names` whose value is real.
// No client entry sets one (the child inherits its client's environment), but
// as a defence an empty value, or an unresolved `${...}` placeholder from a
// hand-written entry, counts as missing, so the fallback is reached.
const isPlaceholder = (v) => /^\$\{[^}]*\}$/.test(v.trim());

function pickCredential(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '' && !isPlaceholder(value)) return {name, value};
  }
  return null;
}

module.exports = {pickCredential};
