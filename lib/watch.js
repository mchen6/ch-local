'use strict';
// Watching the home for pack changes (packs in place, part 2, plan Task B3):
// fs.watch on the home, filtered to the files that matter, and a poll every
// pollMs as a fallback (a watch can miss events on some file systems). A burst
// of changes is debounced into one call.
const fs = require('node:fs');
const path = require('node:path');

// -> {stop()}
function watchFiles(dir, names, onChange, {pollMs = 2000, debounceMs = 150} = {}) {
  let timer = null;
  let last = new Map(names.map((n) => [n, stamp(path.join(dir, n))]));
  const fire = () => {
    if (timer != null) return;
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  let watcher = null;
  try {
    watcher = fs.watch(dir, (event, file) => { if (file == null || names.includes(String(file))) fire(); });
    watcher.on('error', () => { /* the poll goes on */ });
  } catch (err) { watcher = null; }
  const poll = setInterval(() => {
    const now = new Map(names.map((n) => [n, stamp(path.join(dir, n))]));
    if (names.some((n) => now.get(n) !== last.get(n))) fire();
    last = now;
  }, pollMs);
  if (typeof poll.unref === 'function') poll.unref();
  return {stop: () => { clearInterval(poll); if (timer != null) clearTimeout(timer); if (watcher != null) watcher.close(); }};
}

function stamp(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch (err) { return 'none'; }
}

module.exports = {watchFiles};
