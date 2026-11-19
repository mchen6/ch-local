'use strict';
// The scenario's device config, {defaultRepo}, where the runtime reads it
// (<deviceConfigPath>/<package name>.json); none without a defaultRepo.
// Kept until #413's P1 (ch-pack-ci-failure-triage reads defaultRepo as a
// module setting) has merged, then removed with its callers in start and
// the applier (the Reviewer on L2b's Q2).
const fs = require('node:fs');
const path = require('node:path');

function writeDeviceConfig(configDir, unit, defaultRepo) {
  if (defaultRepo == null) return;
  const file = path.join(configDir, ...`${unit.scenario}.json`.split('/'));
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({defaultRepo}) + '\n');
}

module.exports = {writeDeviceConfig};
