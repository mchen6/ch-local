'use strict';
// Today's on/off and ceiling rules, and the device config, by the pack whose
// scenario a module is: the seams of what loads by module
// (lib/availability.js) that L2b replaces (L3's enabled.<module> and its
// ceiling by module; the credential seam is per module already,
// lib/module-credentials.js credentialSeam), and the device
// config that goes once ch-pack-ci-failure-triage's P1 reads defaultRepo as
// a setting (#413 section 16, rule 6). Nothing else in L2a reads pack.<p>,
// the ceiling's packs.
const fs = require('node:fs');
const path = require('node:path');
const {valueOf} = require('./settings');
const {packAllowed, packRefusal} = require('./ceiling');

// settings: the settings in effect; ceiling: ceilingFor()'s; on(pack):
// turned on for this start in the client's dialog, whatever the file says.
// -> seams for availability(): ceiling and off (each null or the reason).
function packSeams({settings, ceiling, on = () => false}) {
  const allowed = (packs) => packs.filter((p) => packAllowed(ceiling, p));
  const isOff = (n) => valueOf(settings, `pack.${n}`) === false && !on(n);
  // the packs that turn the module on: allowed by the ceiling, and on
  const enabling = (packs) => allowed(packs).filter((p) => !isOff(p));
  // a module two packs record loads while one pack is both allowed and on
  // (the high review of L2a, 8; its medium review, 3). L3 makes both per
  // module.
  return {
    ceiling: (m, packs) => (allowed(packs).length > 0 ? null : packRefusal(ceiling, packs[0])),
    off: (m, packs) => {
      const a = allowed(packs);
      return a.length === 0 || enabling(packs).length > 0 ? null : `it is turned off (\`ch-local settings set pack.${a[0]} on\`)`;
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
