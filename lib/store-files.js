'use strict';
// The runtime's store files in the home, as `ch-local status` sees them
// (start runs countinghouse with --store local --storePath <home>/store),
// read only. Not metering.json: ch-local's start never meters, and without
// --meter the runtime never reads the ledger, so it refuses nothing for it.
// A file that is there and does not parse as a JSON object is corrupt, by
// the rule countinghouse's store reads it with (lib/store/json-file.js
// readMap). From countinghouse 8.0.0 (RUNTIME), only a runtime that had the
// file open before it became corrupt replaces it; an older one handles it
// its own way, so these lines are said only for a home recorded on 8.0.0 or
// later. Status can't tell whether such a runtime is running, so it says
// what it sees and the user's own safe step, one line a file. A missing or
// good file, or one that can't be read for another reason (the runtime's
// log says that one), says nothing here.
const fs = require('node:fs');
const path = require('node:path');

// the runtime whose store these lines describe (lib/release-pins.json's
// floor for countinghouse holds every release to it)
const RUNTIME = '8.0.0';
const UNTIL = 'until a runtime that had it open before it became corrupt replaces it';
// each store file, in this order, and its line (file: its full path)
const FILES = [
  ['used-nonces.json', (f) => `store: used-nonces.json is corrupt: when a tool asks you a question during a call, your answer is refused, ${UNTIL}; if none does, move it away (${f})`],
  ['kv.json', (f) => `store: kv.json is corrupt: the modules' stored data can't be read or changed, and an uninstall that would remove it is refused, ${UNTIL}; if none does, move it away (${f}), and what the modules stored starts empty`]
];

// file -> whether it is there, readable, and not a JSON object
function corrupt(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { return false; }
  try {
    const data = JSON.parse(raw);
    return !(data != null && typeof data === 'object' && !Array.isArray(data));
  } catch (err) {
    return true;
  }
}

// the store folder, the home's recorded countinghouse -> the lines status
// says, one a corrupt file (none for a runtime older than RUNTIME, or one
// not known)
function storeLines(dir, runtimeVersion) {
  if (typeof runtimeVersion !== 'string' || require('./release-pins').belowFloor(runtimeVersion, RUNTIME)) return [];
  return FILES.filter(([name]) => corrupt(path.join(dir, name))).map(([name, line]) => line(path.join(dir, name)));
}

module.exports = {storeLines, FILES, RUNTIME};
