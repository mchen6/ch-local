'use strict';
// Text that reaches a client's notice or the runtime from outside (a why, a
// path): cut and cleaned at the source. A hidden character (control,
// line-separator, bidi, zero-width, soft-hyphen, interlinear, tag,
// variation-selector, filler, lone surrogate: text a model reads and a person
// doesn't see) becomes a space, and the text is cut by code point, never half
// a surrogate pair.
//
// HIDDEN_CLASS is countinghouse's shared-runtime-wire conditionsWhy
// hiddenClass, the one definition both sides check against (a RegExp class
// body, u flag); test/shim-node.test.js holds it equal to the vectors' copy.
// It is spelled in escapes only, so this file holds none of those characters.
const HIDDEN_CLASS = '\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\u2800\\u3164\\ud800-\\udfff\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}';
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, 'gu');

function cleanText(v, max = 200) {
  return Array.from(String(v).replace(HIDDEN, ' ')).slice(0, max).join('');
}

module.exports = {cleanText, HIDDEN_CLASS};
