'use strict';
require('./tmp-dirs');
// docs/install: one page per client, each with the way in and the way out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {CLIENTS} = require('../lib/snippets');

const DOCS = path.join(__dirname, '..', 'docs', 'install');

test('every client has an install page with its snippet command and a removal section', () => {
  for (const client of CLIENTS) {
    const page = fs.readFileSync(path.join(DOCS, `${client}.md`), 'utf8');
    assert.ok(page.includes(`ch-local snippet ${client}`), client);
    assert.match(page, /^## Remove/m, client);
  }
});

// #413 section 6.9 (L5a): no page sends a user to a client environment for a
// credential; each names credentials add
test('every page with an entry says a credential is stored with credentials add, never taken from the client\'s environment', () => {
  for (const client of CLIENTS.filter((c) => c !== 'claude-desktop')) {
    const page = fs.readFileSync(path.join(DOCS, `${client}.md`), 'utf8');
    assert.match(page, /ch-local credentials add ch-access-github/, client);
    assert.match(page, /a token in the\s+environment your client starts from is not used/, client);
    assert.ok(!/GITHUB_TOKEN|env_vars/.test(page), client);
  }
});

test('the Claude Code page adds the marketplace from this repository', () => {
  const page = fs.readFileSync(path.join(DOCS, 'claude-code.md'), 'utf8');
  assert.ok(page.includes('claude plugin marketplace add mchen6/ch-local'));
  assert.ok(page.includes('claude plugin install ch-packs@ch-packs'));
});

// A-firstrun d2: the page an agent follows before the plugin is installed
test('the Claude Code page\'s agent section: the proxy check first, then the install, the plugin and one restart, and the pre-release command', () => {
  const page = fs.readFileSync(path.join(DOCS, 'claude-code.md'), 'utf8');
  const at = page.indexOf('## For an agent: install by conversation');
  assert.ok(at > 0);
  // (as read: the page wraps its sentences across lines)
  const section = page.slice(at, page.indexOf('\n## ', at + 1)).replace(/\s+/g, ' ');
  const proxy = section.indexOf('HTTPS_PROXY');
  const install = section.indexOf('npx @countinghouse/ch-local install --pack ci-failure-triage');
  const plugin = section.indexOf('claude plugin install ch-packs@ch-packs');
  const restart = section.indexOf('restart Claude Code');
  // (the skill's order: the plugin's server starts only after the install,
  // once, at the one restart: the medium on d2, 9)
  assert.ok(proxy > 0 && proxy < install && install < plugin && plugin < restart, 'in that order');
  // (presence only: a proxy address can hold a password; the medium on d2, 3)
  assert.ok(section.includes('never print its value'));
  assert.ok(section.includes('INSTALL.txt'));
  assert.ok(section.includes('does not work through an HTTP proxy, so it can\'t install or run on a network that reaches the internet only through one.'));
  assert.ok(section.includes('Never ask for, accept or repeat a token, key or password'));
  assert.ok(section.includes('CH_LOCAL_DEV=1 node <checkout>/bin/ch-local.js install --pack ci-failure-triage --from <dir>/release --unreleased-pins <dir>/pins.json'));
  assert.ok(section.includes('`countinghouse_overview`'));
});

test('the Claude Code page says which shells the add line is for', () => {
  const page = fs.readFileSync(path.join(DOCS, 'claude-code.md'), 'utf8');
  assert.match(page, /cmd\.exe/);
  assert.match(page, /PowerShell[\s\S]{0,80}drops the `--`/, 'says why not PowerShell');
});

test('every package name the docs, skill and launcher print uses the scope', () => {
  const SCOPE = require('../package.json').name.split('/')[0];
  const files = [...fs.readdirSync(DOCS).map((f) => path.join(DOCS, f)), path.join(__dirname, '..', 'clients', 'claude-code', 'skills', 'ci-failure-triage', 'SKILL.md'), path.join(__dirname, '..', 'clients', 'claude-code', 'bin', 'launch.js')];
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/npx (\S+)\/ch-local/g)) assert.strictEqual(m[1], SCOPE, file);
  }
});

test('pages that pin a node say an upgrade changes it and how to reprint', () => {
  for (const client of CLIENTS.filter((c) => c !== 'claude-desktop')) {
    const page = fs.readFileSync(path.join(DOCS, `${client}.md`), 'utf8');
    assert.match(page, /upgrade\s+changes\s+(this|that|the)\s+path/i, client); // across a line wrap
  }
});
