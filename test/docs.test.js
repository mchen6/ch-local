'use strict';
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

test('every page with an entry says the token comes from the environment the client is started from', () => {
  for (const client of CLIENTS.filter((c) => c !== 'claude-desktop')) {
    const page = fs.readFileSync(path.join(DOCS, `${client}.md`), 'utf8');
    assert.match(page, /environment\s+[^.]{1,30}?\s+is\s+started\s+from/, client);
    assert.match(page, /dock/, client);
  }
});

test('the Claude Code page adds the marketplace from this repository', () => {
  const page = fs.readFileSync(path.join(DOCS, 'claude-code.md'), 'utf8');
  assert.ok(page.includes('claude plugin marketplace add mchen6/ch-local'));
  assert.ok(page.includes('claude plugin install ch-packs@ch-packs'));
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
