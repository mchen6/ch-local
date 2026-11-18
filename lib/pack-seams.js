'use strict';
// Today's on/off, ceiling and credential rules, and the device config, by
// the pack whose scenario a module is: the seams of what loads by module
// (lib/availability.js) that L2b replaces (L3's enabled.<module> and its
// ceiling by module, L5's slots matched against the store), and the device
// config that goes once ch-pack-ci-failure-triage's P1 reads defaultRepo as
// a setting (#413 section 16, rule 6). Nothing else in L2a reads pack.<p>,
// the ceiling's packs or the release's version 1 credentials.
const fs = require('node:fs');
const path = require('node:path');
const {valueOf} = require('./settings');
const {packAllowed, packRefusal} = require('./ceiling');
const {pickCredential} = require('./credential');

// installed: installedPacks(); settings: the settings in effect; ceiling:
// ceilingFor()'s; env: start's (with any token); on(pack): turned on for
// this start in the client's dialog, whatever the file says;
// credentialReason(variables): what is said when none of them is set.
// -> seams for availability(): ceiling, off, credential (each null or the
// reason). credential also records on the unit the variables it takes and
// the one chosen (start's --own-runtime line names it).
function packSeams({installed, settings, ceiling, env, on = () => false, credentialReason}) {
  const credsOf = new Map(installed.map((p) => [p.name, p.credentials]));
  return {
    ceiling: (m, packs) => { for (const p of packs) if (!packAllowed(ceiling, p)) return packRefusal(ceiling, p); return null; },
    off: (m, packs) => {
      const p = packs.find((n) => valueOf(settings, `pack.${n}`) === false && !on(n));
      return p == null ? null : `it is turned off (\`ch-local settings set pack.${p} on\`)`;
    },
    credential: (m, packs, unit) => {
      const vars = [...new Set(packs.flatMap((p) => credsOf.get(p) || []))];
      const pick = pickCredential(env, vars);
      unit.credentials = vars;
      unit.credential = pick == null ? null : pick.name;
      return vars.length > 0 && pick == null ? credentialReason(vars) : null;
    }
  };
}

// The scenario's device config, {defaultRepo}, where the runtime reads it
// (<deviceConfigPath>/<package name>.json); none without a defaultRepo.
function writeDeviceConfig(configDir, unit, defaultRepo) {
  if (defaultRepo == null) return;
  const file = path.join(configDir, ...`${unit.scenario}.json`.split('/'));
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({defaultRepo}) + '\n');
}

module.exports = {packSeams, writeDeviceConfig};
