'use strict';
// Which installed modules are top-level and which are parts (#413 section
// 5.1), by the rule availability uses (lib/availability.js): a module that is
// some pack's scenario (lib/packs.js packScenario) is top-level, whatever
// role it declares; every other module is a part.

// record: modules.json as read (lib/module-record.js), or null.
// -> Set of the top-level modules' package names
function topLevel(record) {
  const {packScenario, entryOf} = require('./packs');
  const out = new Set();
  if (record == null || record.packs == null) return out;
  for (const pack of Object.keys(record.packs)) {
    const m = packScenario(record, pack);
    // (the record's own entry only: #449's review)
    if (m != null && entryOf(record, m) != null) out.add(m);
  }
  return out;
}

// The top-level modules a part runs for: the scenarios of the packs that
// record it. -> [package name], sorted
function callersOf(record, part) {
  const {packScenario, hasOwn} = require('./packs');
  const out = new Set();
  for (const [pack, p] of Object.entries((record && record.packs) || {})) {
    if (p == null || !hasOwn(p.modules, part)) continue;
    const m = packScenario(record, pack);
    if (m != null && m !== part) out.add(m);
  }
  return [...out].sort();
}

// The packs whose scenario a module is (a leftover pack.<name> is its
// entry: section 10). -> [pack name]
function packsOf(record, module) {
  const {packScenario} = require('./packs');
  return Object.keys((record && record.packs) || {}).filter((pack) => packScenario(record, pack) === module);
}

// A module is a part when the record has it and it is no pack's scenario.
const isPart = (record, module) => require('./packs').entryOf(record, module) != null && !topLevel(record).has(module);

module.exports = {topLevel, callersOf, packsOf, isPart};
