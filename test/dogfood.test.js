'use strict';
// scripts/dogfood.js (reviewer, 2026-11-12): pack 1 for our own sessions, from
// the current mains, into a home with --unreleased-pins. It prints the client
// line with a placeholder for the token, never a value, and touches no client
// file. The full run needs local clones (CH_DOGFOOD_SRC) and reaches only the
// npm registry; without them it is skipped and says why.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {tmp} = require('./fake-io');
const dogfood = require('../scripts/dogfood');

test('requiring the script runs nothing', () => {
  assert.strictEqual(typeof dogfood.main, 'function');
  assert.strictEqual(typeof dogfood.instructions, 'function');
});

// The printed commands are for bash (dogfood is a developer path; reviewer,
// 2026-11-12): Windows paths are another form.
const BASH_ONLY = process.platform === 'win32' && 'the printed commands are for bash (Git Bash or WSL on Windows)';

test('the instructions: gh auth login, the claude mcp add line with no token, claude --resume; never a token value', {skip: BASH_ONLY}, () => {
  const before = process.env.COUNTINGHOUSE_GITHUB_TOKEN;
  const value = `t${require('node:crypto').randomBytes(12).toString('hex')}`;
  process.env.COUNTINGHOUSE_GITHUB_TOKEN = value;
  try {
    const text = dogfood.instructions({node: '/usr/bin/node', home: '/home/me/.countinghouse', defaultHome: '/home/me/.countinghouse'});
    assert.match(text, /^  gh auth login$/m, 'the token is gh\'s, held in memory by the launcher');
    assert.ok(text.includes('  claude mcp add --scope user countinghouse -- /usr/bin/node /home/me/.countinghouse/bin/ch-local.js start --stdio'), text);
    assert.match(text, /^  claude --resume$/m);
    assert.ok(!text.includes(value));
    assert.ok(!/COUNTINGHOUSE_GITHUB_TOKEN|read -rs/.test(text), 'no token variable goes into Claude Code\'s configuration');
    assert.ok(!/claude mcp add.*[<>]/.test(text), 'nothing a shell would read as a redirection');
    assert.ok(!text.includes('COUNTINGHOUSE_HOME'), 'the default home needs no variable');
  } finally {
    if (before === undefined) delete process.env.COUNTINGHOUSE_GITHUB_TOKEN; else process.env.COUNTINGHOUSE_GITHUB_TOKEN = before;
  }
});

test('another home is carried into the line, status and uninstall, quoted when it has spaces', {skip: BASH_ONLY}, () => {
  const text = dogfood.instructions({node: '/opt/my node/bin/node', home: '/home/me/my home', defaultHome: '/home/me/.countinghouse'});
  assert.ok(text.includes(`-e "COUNTINGHOUSE_HOME=/home/me/my home" -- '/opt/my node/bin/node' '/home/me/my home/bin/ch-local.js' start --stdio`), text);
  assert.ok(text.includes(`COUNTINGHOUSE_HOME='/home/me/my home' '/opt/my node/bin/node' '/home/me/my home/bin/ch-local.js' status`), text);
  assert.ok(text.includes(`COUNTINGHOUSE_HOME='/home/me/my home' '/opt/my node/bin/node' '/home/me/my home/bin/ch-local.js' uninstall`), text);
});

test('the home: --home, else COUNTINGHOUSE_HOME as every ch-local command reads it, else ~/.countinghouse', () => {
  assert.strictEqual(dogfood.homeFor({home: '/h'}, {COUNTINGHOUSE_HOME: '/e'}), path.resolve('/h'));
  assert.strictEqual(dogfood.homeFor({home: null}, {COUNTINGHOUSE_HOME: '/e'}), path.resolve('/e'));
  assert.strictEqual(dogfood.homeFor({home: null}, {}), path.join(os.homedir(), '.countinghouse'));
});

test('the plan: a repo missing under --src is cloned from GitHub; an explicit --clone must exist; a ref without a clone must be a branch', () => {
  const src = tmp('ch-dogfood-src-');
  fs.mkdirSync(path.join(src, 'ch-step-redact', '.git'), {recursive: true});
  const plan = dogfood.planSources(dogfood.parseArgs(['--src', src]));
  assert.ok(plan.problem == null, plan.problem);
  assert.strictEqual(plan.sources.find((s) => s.repo === 'ch-step-redact').dir, path.join(src, 'ch-step-redact'));
  assert.strictEqual(plan.sources.find((s) => s.repo === 'countinghouse').dir, null, 'not under --src: cloned');
  assert.match(dogfood.planSources(dogfood.parseArgs(['--clone', `countinghouse=${path.join(src, 'nope')}`])).problem, /no clone of countinghouse at/);
  assert.match(dogfood.planSources(dogfood.parseArgs(['--ref', 'ch-access-github=3f2a9c1'])).problem, /ch-access-github has no clone, so its ref must be a branch/);
  assert.strictEqual(dogfood.planSources(dogfood.parseArgs(['--ref', 'ch-access-github=origin/feature-x'])).problem, undefined);
  fs.rmSync(src, {recursive: true, force: true});
});

test('the sources: countinghouse at master, ch-local from this checkout, the pack and every part at main', () => {
  const {sources} = dogfood;
  const names = sources().map((s) => s.repo);
  assert.deepStrictEqual(names, ['countinghouse', 'ch-pack-ci-failure-triage', 'ch-access-github', 'ch-step-redact', 'ch-step-log-clean', 'ch-step-error-patterns', 'ch-step-failure-signature', 'ch-step-dedupe', 'ch-step-owner-hint', 'ch-step-report']);
  assert.strictEqual(sources()[0].ref, 'origin/master');
  assert.ok(sources().slice(1).every((s) => s.ref === 'origin/main'));
});

test('arguments: --src, --clone repo=path, --ref repo=ref, --home; anything else is refused', () => {
  const a = dogfood.parseArgs(['--src', '/c', '--clone', 'countinghouse=/x/ch', '--ref', 'countinghouse=origin/lm1-c-compose-wait', '--home', '/h']);
  assert.deepStrictEqual(a, {src: '/c', clones: {countinghouse: '/x/ch'}, refs: {countinghouse: 'origin/lm1-c-compose-wait'}, home: '/h'});
  for (const bad of [['--token', 'x'], ['--clone', 'nope'], ['--ref', 'unknown-repo=main'], ['stray']]) assert.throws(() => dogfood.parseArgs(bad), /usage|unknown|repo=/, bad.join(' '));
});

test('a missing explicit clone is named before anything is built or installed', async () => {
  const parent = tmp('ch-dogfood-');
  const home = path.join(parent, 'home');
  const out = {text: '', write(s) { this.text += s; }};
  const code = await dogfood.main(['--clone', `countinghouse=${path.join(parent, 'none')}`, '--home', home], {stdout: out, stderr: out});
  assert.strictEqual(code, 1);
  assert.match(out.text, /no clone of countinghouse at /);
  assert.ok(!fs.existsSync(home));
  fs.rmSync(parent, {recursive: true, force: true});
});

const SRC = process.env.CH_DOGFOOD_SRC;
test('the whole path into a temporary home', {timeout: 900000, skip: BASH_ONLY || (SRC == null && 'CH_DOGFOOD_SRC is not set (a directory of clones; CH_DOGFOOD_CLONES and CH_DOGFOOD_REFS may add repo=path and repo=ref pairs)')}, async () => {
  const parent = tmp('ch-dogfood-');
  const home = path.join(parent, 'home');
  const works = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ch-dogfood-work-')).length;
  const worksBefore = works();
  const pairs = (v, flag) => (v || '').split(',').filter(Boolean).flatMap((p) => [flag, p]);
  const out = {text: '', write(s) { this.text += s; }};
  const before = process.env.COUNTINGHOUSE_GITHUB_TOKEN;
  const value = `t${require('node:crypto').randomBytes(12).toString('hex')}`;
  process.env.COUNTINGHOUSE_GITHUB_TOKEN = value;
  let code;
  try {
    code = await dogfood.main(['--src', SRC, ...pairs(process.env.CH_DOGFOOD_CLONES, '--clone'), ...pairs(process.env.CH_DOGFOOD_REFS, '--ref'), '--home', home], {stdout: out, stderr: out});
  } finally {
    if (before === undefined) delete process.env.COUNTINGHOUSE_GITHUB_TOKEN; else process.env.COUNTINGHOUSE_GITHUB_TOKEN = before;
  }
  assert.strictEqual(code, 0, out.text.slice(-3000));
  const record = JSON.parse(fs.readFileSync(path.join(home, 'packs.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(record.packs), ['ci-failure-triage']);
  assert.strictEqual(record.unreleased, true);
  assert.ok(fs.existsSync(path.join(home, 'app', 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js')));
  assert.ok(out.text.includes(`claude mcp add --scope user countinghouse -e "COUNTINGHOUSE_HOME=${home}" -- ${process.execPath} ${path.join(home, 'bin', 'ch-local.js')} start --stdio`), out.text.slice(-1500));
  assert.ok(!out.text.includes(value), 'never a token value');
  assert.ok(!/COUNTINGHOUSE_GITHUB_TOKEN is set|start will use/.test(out.text), 'install did not look at this shell\'s token');
  assert.deepStrictEqual(fs.readdirSync(parent), ['home'], 'nothing beside the home');
  assert.strictEqual(works(), worksBefore, 'the work directory is removed');
  fs.rmSync(parent, {recursive: true, force: true});
});
