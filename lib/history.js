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

// The newest entry `pick` takes, from the file's last `max` bytes (a long
// history is never read whole) -> the entry, or null (none, or no file)
function lastHistory(where, pick, {max = 256 * 1024} = {}) {
  let text = '';
  let fd = null;
  try {
    fd = fs.openSync(path.join(where.home, 'history.jsonl'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, max);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    text = buf.toString('utf8');
  } catch (err) {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch (err) { continue; }
    if (e != null && typeof e === 'object' && pick(e)) return e;
  }
  return null;
}

module.exports = {appendHistory, lastHistory};
