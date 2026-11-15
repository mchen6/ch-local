'use strict';
// <home>/history.jsonl (packs in place, part 2): one line per change to the
// packs or the settings, by whoever made it (start, cli, auto-upgrade, the
// settings tool), appended, never rewritten, so several writers never race.
// Never a value of a credential.
const fs = require('node:fs');
const path = require('node:path');

// entry: {by, ...what changed}; host and pid say which start, when one did.
// strict: a failed append is answered false, for a caller that makes no
// change it cannot record. -> true when appended.
function appendHistory(where, entry, {host = null, pid = null, now = Date.now(), strict = false} = {}) {
  const line = {at: new Date(now).toISOString(), ...(host != null ? {host} : {}), ...(pid != null ? {pid} : {}), ...entry};
  try {
    fs.appendFileSync(path.join(where.home, 'history.jsonl'), JSON.stringify(line) + '\n');
    return true;
  } catch (err) {
    if (strict) return false;
    return false;
  }
}

module.exports = {appendHistory};
