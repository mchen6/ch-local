'use strict';
// The on/off and ceiling rules of what loads (lib/availability.js rules 3
// and 4), by module (#413 sections 5.1, 5.2 and 8; L2b):
//   - the ceiling: the operator's `modules` list allows the module, a part
//     included (a module that calls one not listed goes by rule 6); a
//     ceiling that cannot be trusted allows none;
//   - off: a top-level module whose enabled.<package> is off, or a leftover
//     pack.<name> off for a pack whose scenario it is (off wins:
//     lib/settings.js isOn).
const {moduleAllowed, modulesRefusal} = require('./ceiling');
const {isOn} = require('./settings');

// settings: the settings in effect; ceiling: ceilingFor()'s; record:
// modules.json. -> seams for availability(): ceiling and off, each
// (module) -> null or the reason.
function moduleSeams({settings, ceiling, record}) {
  return {
    ceiling: (m) => (moduleAllowed(ceiling, m) ? null
      : ceiling != null && ceiling.state === 'trusted' ? 'it is not on the operator\'s list' : modulesRefusal(ceiling, [m])),
    off: (m) => (isOn(settings, record, m) ? null : `it is turned off (\`ch-local settings set enabled.${m} on\`)`)
  };
}

module.exports = {moduleSeams};
