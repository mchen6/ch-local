'use strict';
// A line read from a terminal with nothing echoed (a credential typed or
// pasted at `ch-local credentials add`). The terminal is put in raw mode
// before the prompt is shown (so nothing typed early is echoed either), and
// back as it was whatever happens. Enter (or a pasted line's CR, LF or CRLF)
// ends it, so a trailing line ending is never part of the value; Ctrl-C or
// Ctrl-D aborts (ABORTED), as does the input ending, closing or failing (a
// terminal gone mid-prompt never leaves this waiting in raw mode); backspace
// takes back one character. Over MAX_CHARS is refused (TOO_LONG). Nothing
// read is ever written anywhere.
const MAX_CHARS = 4096;

// stdin: a TTY stream with setRawMode; stderr: where the prompt goes.
// -> Promise of the line
function readHidden(prompt, {stdin = process.stdin, stderr = process.stderr} = {}) {
  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const wasRaw = stdin.isRaw === true;
    const failure = (code, message) => Object.assign(new Error(message), {code});
    const finish = (err, v) => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      stdin.removeListener('error', onEnd);
      try { stdin.setRawMode(wasRaw); } catch (e) { /* the terminal is gone */ }
      if (typeof stdin.pause === 'function') stdin.pause();
      try { stderr.write('\n'); } catch (e) { /* gone too */ }
      if (err != null) reject(err); else resolve(v);
    };
    const onEnd = () => finish(failure('ABORTED', 'the input ended'));
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003' || ch === '\u0004') return finish(failure('ABORTED', 'nothing was entered'));
        if (ch === '\r' || ch === '\n') return finish(null, value);
        if (ch === '\u007f' || ch === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        value += ch;
        if (value.length > MAX_CHARS) return finish(failure('TOO_LONG', `more than ${MAX_CHARS} characters`));
      }
      return undefined;
    };
    try {
      stdin.setRawMode(true);
    } catch (e) {
      settled = true;
      reject(failure('NO_TERMINAL', 'the input is not a terminal'));
      return;
    }
    if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    stdin.on('error', onEnd);
    stderr.write(prompt);
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}

module.exports = {readHidden, MAX_CHARS};
