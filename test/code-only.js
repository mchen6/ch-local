'use strict';
// A JavaScript source with its comments, string literals and template text
// removed, the code inside a template's ${...} kept (it is code), for the
// tests that scan lib/ for what it names. A small tokenizer, not a parser:
// enough for this repository's code (no regular expression literal holds a
// quote or a backtick).
function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // reads code until `stop` (a closing brace at depth 0, for a ${...}) or the end
  const code = (stopAtBrace) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
      if (c === '\'' || c === '"') {
        i++;
        while (i < n && src[i] !== c) { if (src[i] === '\\') i++; if (src[i] === '\n') break; i++; }
        i++;
        out += '\'\'';
        continue;
      }
      if (c === '`') { i++; template(); out += '\'\''; continue; }
      if (stopAtBrace) {
        if (c === '{') depth++;
        if (c === '}') { if (depth === 0) { i++; return; } depth--; }
      }
      out += c;
      i++;
    }
  };
  // reads a template's text to its closing backtick, its ${...} as code
  const template = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; out += ' '; code(true); out += ' '; continue; }
      i++;
    }
  };
  code(false);
  return out;
}

module.exports = {codeOnly};
