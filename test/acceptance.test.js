'use strict';
require('./tmp-dirs');
// (CI runs this file on its own: its ch-* temporary directories are
// removed at its end as npm test's are; test/tmp-dirs.js)
// scripts/acceptance.js (plan Task 13; reviewer, 2026-11-12): the parts that
// run without a build, and the whole run, gated on local clones
// (CH_ACCEPTANCE_SRC, with CH_ACCEPTANCE_CLONES and CH_ACCEPTANCE_REFS as
// repo=value pairs, like dogfood's).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A run's failure as the assertion says it: the failed checks first (each
// FAIL line with the start of its detail), then the run's tail. CI keeps
// neither a run's report file nor its whole output.
function failureText(text) {
  const lines = text.split('\n');
  const failed = [];
  for (let i = 0; i < lines.length; i++) if (/^FAIL /.test(lines[i])) failed.push(lines.slice(i, i + 4).join('\n').slice(0, 1500));
  return `${failed.join('\n')}\n--- the run's last lines ---\n${text.slice(-2500)}`;
}
const {tmp} = require('./fake-io');
const acceptance = require('../scripts/acceptance');

// A fixtures directory in the recorded shape, small.
function fixtures() {
  const dir = tmp('ch-acc-fx-');
  const env = (result) => JSON.stringify({_recorded: 'test', request: {}, result});
  fs.writeFileSync(path.join(dir, 'tools-list.json'), JSON.stringify({_recorded: 'test', tools: [{name: 'actions_list', inputSchema: {type: 'object'}}]}));
  fs.writeFileSync(path.join(dir, 'list_workflow_runs.json'), env({content: [{type: 'text', text: '{"workflow_runs": []}'}]}));
  fs.writeFileSync(path.join(dir, 'get_job_logs-7.json'), env({content: [{type: 'text', text: 'log'}]}));
  return dir;
}
const post = async (port, token, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp/`, {method: 'POST', headers: {'content-type': 'application/json', ...headers, ...(token != null ? {authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body)});
  return {status: r.status, body: r.status === 200 ? await r.json() : await r.text()};
};

test('requiring the script runs nothing', () => {
  assert.strictEqual(typeof acceptance.main, 'function');
});

test('the stand-in takes only the run\'s token, lists the recorded tools and answers from the recordings', async () => {
  const s = await acceptance.startStandIn({fixtures: fixtures(), token: 'chacc_right'});
  try {
    assert.strictEqual((await post(s.port, 'chacc_wrong', {jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 401);
    assert.strictEqual((await post(s.port, null, {jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 401);
    assert.strictEqual(s.state.refused, 2);
    const init = await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}});
    assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
    assert.deepStrictEqual((await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 2, method: 'tools/list'})).body.result.tools.map((t) => t.name), ['actions_list']);
    const runs = await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'actions_list', arguments: {method: 'list_workflow_runs'}}});
    assert.deepStrictEqual(runs.body.result, {content: [{type: 'text', text: '{"workflow_runs": []}'}]});
    const odd = await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'get_job_logs', arguments: {job_id: '../../etc/passwd'}}});
    assert.strictEqual(odd.body.result.isError, true, 'no recording, and no path from the arguments');
    assert.deepStrictEqual(s.state.unexpected.map((u) => u.tool), ['get_job_logs']);
  } finally {
    await s.close();
  }
});

// A-own-skill: the own module's key is a token of its own; the stand-in
// takes exactly the run's tokens and records whose each call carried
test('the stand-in takes exactly the run\'s tokens, and records whose token each call carried', async () => {
  const s = await acceptance.startStandIn({fixtures: fixtures(), tokens: {pack: 'chacc_pack', own: 'chacc_own'}});
  try {
    assert.strictEqual((await post(s.port, 'chacc_other', {jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 401);
    const call = (token, id) => post(s.port, token, {jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'actions_list', arguments: {method: 'list_workflow_runs'}}});
    await call('chacc_pack', 2);
    await call('chacc_own', 3);
    await post(s.port, 'chacc_own', {jsonrpc: '2.0', id: 4, method: 'initialize', params: {}}, {'X-CH-Acceptance-Module': 'own-acceptance'});
    assert.deepStrictEqual([s.state.calls, s.state.by, s.state.refused], [['actions_list', 'actions_list'], ['pack', 'own'], 1]);
    assert.deepStrictEqual(s.state.seen, [{method: 'tools/call', who: 'pack', module: null}, {method: 'tools/call', who: 'own', module: null},
      {method: 'initialize', who: 'own', module: 'own-acceptance'}], 'every request, with its token and module header');
  } finally {
    await s.close();
  }
});

test('reportText with the run\'s two tokens: either in a log fails the run, and neither is written', () => {
  const report = {checks: [{name: 'x', ok: true}], detail: 'chacc_own_value'};
  const text = acceptance.reportText(report, ['chacc_pack_value', 'chacc_own_value'], ['a line with chacc_pack_value']);
  assert.ok(!text.includes('chacc_pack_value') && !text.includes('chacc_own_value'), text);
  assert.strictEqual(JSON.parse(text).ok, false);
});

test('the acceptance own module passes ch-local\'s own folder check, declares its own key for GitHub\'s origin, and its tool counts the recorded commits', async () => {
  const base = fs.realpathSync.native(tmp('ch-acc-own-'));
  try {
    const own = acceptance.writeOwnModule(path.join(base, 'work', 'own'));
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const checked = require('../lib/own-tree').checkFolder(own.dir, home);
    assert.ok(checked.problems == null && checked.real === own.dir, JSON.stringify(checked.problems));
    assert.strictEqual(checked.pkg.countinghouse.role, 'scenario');
    const {credential} = require('../lib/describe-module').credentialOf(checked.pkg.countinghouse.remotes);
    assert.deepStrictEqual([credential.variable, credential.origin], ['OWN_GITHUB_TOKEN', 'https://api.githubcopilot.com']);
    const handler = require(path.join(own.dir, 'handlers', 'ownService', 'own_commit_count.js'));
    const asked = [];
    assert.deepStrictEqual(checked.pkg.countinghouse.remotes[0].headers, {'X-CH-Acceptance-Module': own.name});
    const ctx = {call: async (address, args) => { asked.push([address, args]); return {content: [{type: 'text', text: '[{"sha":"a"},{"sha":"b"}]'}]}; },
      error: (code, message) => Object.assign(new Error(message), {code})};
    assert.deepStrictEqual(await handler({repo: 'octo/x'}, ctx), {output: {commits: 2}});
    assert.deepStrictEqual(asked, [['remote:github/list_commits', {owner: 'octo', repo: 'x', perPage: 5}]]);
    await assert.rejects(handler({repo: 'octo/x'}, {...ctx, call: async () => ({isError: true, content: []})}), {code: 'REMOTE_FAILED'});
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

// The Windows step (no pty there): the installed ch-local's own addModule,
// answered y in process. Run here on any OS, the home's installed ch-local
// being this tree: asked once, the copy placed is the one recorded, whole,
// with what add-module records (its calls among them), and addOwn says its
// hash.
test('addOwn on Windows stands the yes in with the installed add-module, answered y: the copy recorded is the copy placed, whole', async () => {
  const base = fs.realpathSync.native(tmp('ch-acc-win-'));
  try {
    const own = acceptance.writeOwnModule(path.join(base, 'work', 'own'));
    const home = path.join(base, 'home');
    // (an installed home: add-module refuses one with nothing installed)
    fs.mkdirSync(home, {recursive: true, mode: 0o700});
    fs.chmodSync(home, 0o700);
    require('./install-helpers').installedHome(home, ['ci-failure-triage']);
    // (its installed runtime can enforce on Windows, as a release-1 one does:
    // the fs-broker virtual drive, countinghouse#195; B's 5d3a7e0)
    const drive = path.join(home, 'app', 'node_modules', 'countinghouse', 'lib', 'fs-broker');
    fs.mkdirSync(drive, {recursive: true});
    fs.writeFileSync(path.join(drive, 'virtual-drive.js'), '');
    const installed = path.join(home, 'app', 'node_modules', '@countinghouse');
    fs.mkdirSync(installed, {recursive: true});
    fs.rmSync(path.join(installed, 'ch-local'), {recursive: true, force: true});
    fs.symlinkSync(path.join(__dirname, '..'), path.join(installed, 'ch-local'), process.platform === 'win32' ? 'junction' : 'dir');
    const env = {COUNTINGHOUSE_HOME: home};
    const added = await acceptance.addOwn({home, node: process.execPath, launcher: null, dir: own.dir, env, platform: 'win32'});
    assert.ok(added.ok, added.output);
    assert.strictEqual(added.name, 'the yes stood in (no pty on Windows): the installed add-module, answered y');
    assert.match(added.output, /^It runs inside the same countinghouse runtime as your packs\.$/m);
    const where = require('../lib/home').layout(env);
    const rec = require('../lib/own-record').readOwnRecord(where).modules[own.name];
    assert.ok(rec.tree.startsWith(added.hash) && added.hash.length === 12, `${added.hash} ${rec.tree}`);
    assert.strictEqual(require('../lib/own-tree').copyIntact(where, own.name, rec.tree), true);
    assert.deepStrictEqual([rec.version, rec.friendlyName, rec.from, rec.calls], ['1.0.0', own.name, own.dir, []]);
  } finally {
    acceptance.removeTree(base, path.join(base, 'home'));
  }
});

// (on every OS, so acceptance's no-skip guard holds: a read-only file is
// the read-only attribute on Windows, which a plain rm refuses there too, and
// the link is a junction, which needs no privilege)
test('removeTree removes a work directory whose home holds read-only copies, never follows a link out of it, and never throws', () => {
  const base = fs.realpathSync.native(tmp('ch-acc-rm-'));
  const outside = path.join(base, 'outside');
  const kept = path.join(outside, 'kept');
  try {
    fs.mkdirSync(outside);
    fs.writeFileSync(kept, 'x');
    fs.chmodSync(kept, 0o444);
    const work = path.join(base, 'work');
    const own = path.join(work, 'home', 'own');
    fs.mkdirSync(path.join(own, 'a'), {recursive: true});
    fs.writeFileSync(path.join(own, 'a', 'f.js'), 'x');
    fs.symlinkSync(outside, path.join(own, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.chmodSync(path.join(own, 'a', 'f.js'), 0o444);
    fs.chmodSync(path.join(own, 'a'), 0o555);
    fs.chmodSync(own, 0o555);
    assert.strictEqual(acceptance.removeTree(work), null);
    assert.ok(!fs.existsSync(work));
    assert.ok(fs.existsSync(kept), 'the link\'s target kept');
    assert.strictEqual(fs.statSync(kept).mode & 0o200, 0, 'and still read-only: nothing made writable through the link');
    assert.strictEqual(acceptance.removeTree(path.join(base, 'gone')), null, 'nothing there: nothing to do');
  } finally {
    try { fs.chmodSync(kept, 0o644); } catch (e) { /* not made */ }
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('filesContaining finds a needle in any file below a directory, and nothing in an absent one', () => {
  const dir = tmp('ch-acc-scan-');
  fs.mkdirSync(path.join(dir, 'a', 'b'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'a', 'b', 'x.jsonl'), '{"k": "chacc_123"}\n');
  fs.writeFileSync(path.join(dir, 'y'), 'nothing');
  assert.deepStrictEqual(acceptance.filesContaining(dir, 'chacc_123'), [path.join('a', 'b', 'x.jsonl')]);
  assert.deepStrictEqual(acceptance.filesContaining(path.join(dir, 'none'), 'x'), []);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('the launcher environment carries no token of this shell\'s unless given one', () => {
  const before = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_from_the_shell';
  try {
    // (the pack's variable, GITHUB_TOKEN since ch-access-github 0.2.0: the
    // shell's dropped, one given kept)
    const env = acceptance.launcherEnv('/h');
    assert.strictEqual(env.GITHUB_TOKEN, undefined);
    assert.strictEqual(acceptance.launcherEnv('/h', {GITHUB_TOKEN: 'chacc_x'}).GITHUB_TOKEN, 'chacc_x');
    assert.strictEqual(env.CH_LOCAL_DEV, '1');
    assert.strictEqual(env.COUNTINGHOUSE_HOME, '/h');
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = before;
  }
});

// (the no-outbound-connection check: the runtime opens no connection off
// the machine; on Linux the server runs under strace, and every connect()
// it made is read)
test('outboundOf: every connect() strace saw, and every send that names its address, loopback or not; a refused or pending one counts too; DNS is off the machine', () => {
  const trace = [
    '4242  connect(21, {sa_family=AF_INET, sin_port=htons(41237), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
    '4243  connect(22, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28) = -1 ECONNREFUSED (Connection refused)',
    '4244  connect(23, {sa_family=AF_UNIX, sun_path="/run/x.sock"}, 110) = 0',
    '4245  connect(24, {sa_family=AF_INET6, sin6_port=htons(80), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::ffff:127.0.0.1", &sin6_addr), sin6_scope_id=0}, 28) = 0',
    '4246  connect(25, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.21")}, 16) = -1 EINPROGRESS (Operation now in progress)',
    '4247  connect(26, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:db8::153", &sin6_addr), sin6_scope_id=0}, 28) = 0',
    '4248  connect(27, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("127.0.0.53")}, 16) = 0',
    '4249  connect(28, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("0.0.0.0")}, 16) = 0',
    // (a datagram sent with no connect: strace 6.19's sendmsg, as node's dgram writes it)
    '4251  sendmsg(20, {msg_name={sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("192.0.2.1")}, msg_namelen=16, msg_iov=[{iov_base="x", iov_len=1}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, 0) = 1',
    '4252  sendto(21, "x", 1, 0, {sa_family=AF_INET6, sin6_port=htons(8125), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "::1", &sin6_addr), sin6_scope_id=0}, 28) = 1',
    // (a send on a connected socket names no address: its connect is what counts)
    '4253  sendto(22, "x", 1, MSG_NOSIGNAL, NULL, 0) = 1',
    '4254  sendmmsg(23, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("198.51.100.8")}, msg_namelen=16}, msg_len=40}], 1, 0) = 1',
    // (one sendmmsg, two messages: the second's address read too)
    '4255  sendmmsg(24, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("127.0.0.1")}, msg_namelen=16}, msg_len=1}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.2")}, msg_namelen=16}, msg_len=1}], 2, 0) = 2',
    // (a name looked up through a local resolver's own socket; another unix socket is the machine's)
    '4256  connect(25, {sa_family=AF_UNIX, sun_path="/run/systemd/resolve/io.systemd.Resolve"}, 42) = 0',
    '4257  connect(26, {sa_family=AF_UNIX, sun_path="/run/nscd/socket"}, 19) = -1 ENOENT (No such file or directory)',
    '4250  +++ exited with 0 +++'
  ].join('\n');
  const o = acceptance.outboundOf(trace);
  assert.deepStrictEqual(o.away, ['192.0.2.21:443', '[2001:db8::153]:443', 'dns: 127.0.0.53:53', '192.0.2.1:9', 'dns: 198.51.100.8:53', '192.0.2.2:443',
    'dns: unix:/run/systemd/resolve/io.systemd.Resolve', 'dns: unix:/run/nscd/socket']);
  assert.deepStrictEqual(o.loopback, ['127.0.0.1:41237', '[::1]:443', '[::ffff:127.0.0.1]:80', '0.0.0.0:9', '[::1]:8125', '127.0.0.1:9']);
  assert.deepStrictEqual(acceptance.outboundOf(''), {loopback: [], away: []});
});

test('traceCommand: the server under strace on Linux, as it is elsewhere; none, or one that can\'t trace, is the run\'s failure unless waived, and never waived on CI', () => {
  const at = (platform, can, env = {}) => acceptance.traceCommand({platform, node: '/n', args: ['l', 'start', '--stdio'], file: '/t/trace', env, has: () => can});
  assert.deepStrictEqual(at('linux', 'ok'), {command: 'strace', args: ['-f', '-qq', '--seccomp-bpf', '-e', 'trace=connect,sendto,sendmsg,sendmmsg', '-o', '/t/trace', '/n', 'l', 'start', '--stdio'], traced: true});
  assert.deepStrictEqual(at('darwin', 'missing'), {command: '/n', args: ['l', 'start', '--stdio'], traced: false});
  assert.deepStrictEqual(at('win32', 'missing'), {command: '/n', args: ['l', 'start', '--stdio'], traced: false});
  assert.match(at('linux', 'missing').problem, /^strace is not installed: .*waives it, locally only\)$/);
  assert.match(at('linux', 'blocked').problem, /^strace is installed but cannot trace here \(ptrace refused\): /);
  assert.match(at('linux', 'old').problem, /^strace is too old here \(it needs --seccomp-bpf: 5\.3 or later\): /);
  assert.deepStrictEqual(at('linux', 'missing', {CH_ACCEPTANCE_NO_TRACE: '1'}), {command: '/n', args: ['l', 'start', '--stdio'], traced: false, waived: true});
  assert.deepStrictEqual(at('linux', 'blocked', {CH_ACCEPTANCE_NO_TRACE: '1', CI: 'false'}).waived, true, 'CI=false is not CI');
  for (const CI of ['true', '1']) assert.match(at('linux', 'missing', {CH_ACCEPTANCE_NO_TRACE: '1', CI}).problem, /CH_ACCEPTANCE_NO_TRACE=1 is refused on CI\)$/, CI);
});

test('the shared run\'s daemon-log aid is a local one too: refused on CI, no workflow sets it, and with it the trace\'s checks are skipped', () => {
  const shared = require('../scripts/shared-acceptance');
  assert.deepStrictEqual(shared.daemonLogMode({}, 'linux'), {on: false});
  assert.deepStrictEqual(shared.daemonLogMode({CH_SHARED_ACCEPTANCE_DAEMON_LOG: '1'}, 'linux'), {on: true});
  assert.deepStrictEqual(shared.daemonLogMode({CH_SHARED_ACCEPTANCE_DAEMON_LOG: '1', CI: 'false'}, 'darwin'), {on: true});
  assert.deepStrictEqual(shared.daemonLogMode({CH_SHARED_ACCEPTANCE_DAEMON_LOG: '1'}, 'win32'), {on: false});
  for (const CI of ['true', '1']) {
    const m = shared.daemonLogMode({CH_SHARED_ACCEPTANCE_DAEMON_LOG: '1', CI}, 'linux');
    assert.strictEqual(m.on, false, CI);
    assert.match(m.problem, /^CH_SHARED_ACCEPTANCE_DAEMON_LOG=1 is refused on CI/, CI);
  }
  assert.strictEqual(shared.DAEMON_LOG_SKIPPED, 'not checked: daemon started untraced for its log (CH_SHARED_ACCEPTANCE_DAEMON_LOG=1)');
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('CH_SHARED_ACCEPTANCE_DAEMON_LOG'), f);
});

test('the shared trace\'s verdict: whole, the socket reached (once attached) and nothing off the machine; not whole, a failure', () => {
  const shared = require('../scripts/shared-acceptance');
  const sock = '/tmp/x/run/daemon/countinghouse-1.sock';
  const reached = `9  connect(5, {sa_family=AF_UNIX, sun_path="${sock}"}, 110) = 0`;
  const away = '9  connect(6, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.9")}, 16) = 0';
  const v = (text, whole, sessionSocket) => shared.traceVerdict({text, whole, sessionSocket}).map((c) => [c.name, c.ok]);
  assert.deepStrictEqual(v(reached, true, sock), [[shared.TRACE_SAW, true], [shared.TRACE_NONE_LEFT, true]]);
  assert.deepStrictEqual(v(`${reached}\n${away}`, true, sock), [[shared.TRACE_SAW, true], [shared.TRACE_NONE_LEFT, false]]);
  assert.deepStrictEqual(v('', true, sock), [[shared.TRACE_SAW, false], [shared.TRACE_NONE_LEFT, true]], 'an empty trace never passes');
  assert.deepStrictEqual(v(away, true, null), [[shared.TRACE_NONE_LEFT, false]], 'not attached: the socket is not asked');
  assert.deepStrictEqual(v(reached, false, sock), [[shared.TRACE_NONE_LEFT, false]], 'not whole');
  assert.match(shared.traceVerdict({text: '', whole: false, sessionSocket: sock})[0].detail, /not whole/);
  assert.deepStrictEqual(v(null, true, sock), [[shared.TRACE_NONE_LEFT, false]], 'no trace file');
  const vd = (daemon) => shared.traceVerdict({text: reached, whole: true, sessionSocket: sock, daemon}).map((c) => [c.name, c.ok]);
  assert.deepStrictEqual(vd({}), [[shared.TRACE_SAW, true], [shared.TRACE_NONE_LEFT, true]], 'the daemon traced, the same to the end');
  assert.deepStrictEqual(vd({problem: 'the daemon serving at the end (pid 2) is not the one traced at attach (pid 1)'}), [[shared.TRACE_NONE_LEFT, false]]);
  assert.match(shared.traceVerdict({text: away, whole: true, sessionSocket: sock})[1].detail, /^192\.0\.2\.9:443; 1 connects:\n9  connect\(6/);
});

test('onCi: CI set and not "false" or "0"', () => {
  for (const [env, on] of [[{}, false], [{CI: ''}, false], [{CI: 'false'}, false], [{CI: '0'}, false], [{CI: 'true'}, true], [{CI: '1'}, true]]) assert.strictEqual(acceptance.onCi(env), on, JSON.stringify(env));
});

// (on every OS, so acceptance's no-skip guard holds: off Linux it is not asked)
test('canTrace: strace tracing a node that does nothing: ok where it can, missing, old or blocked where not (Linux)', () => {
  if (process.platform !== 'linux') return;
  const word = acceptance.canTrace(process.execPath);
  assert.ok(['ok', 'missing', 'old', 'blocked'].includes(word), word);
  const installed = require('node:child_process').spawnSync('strace', ['-V'], {stdio: 'ignore'}).status === 0;
  if (!installed) assert.strictEqual(word, 'missing');
  else assert.notStrictEqual(word, 'missing');
});

test('the trace\'s waiver is a local one: no workflow sets it, and a waived run says the check was not run', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('CH_ACCEPTANCE_NO_TRACE'), f);
  assert.match(acceptance.TRACE_SKIPPED, /^trace skipped: the no-outbound-connection check was NOT run/);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'acceptance.js'), 'utf8').includes('report.skipped = [...(report.skipped || []), TRACE_SKIPPED]'));
});

test('the receipt pattern: a stand-in run, and only that', () => {
  assert.match('read 226.1 KB in 9 calls to github (acceptance stand-in); 1.6 KB reached the model.', acceptance.RECEIPT);
  assert.match('read 812 B in 1 call to github (acceptance stand-in); 1.2 MB reached the model.', acceptance.RECEIPT);
  assert.doesNotMatch('read 226.1 KB in 9 calls to github; 1.6 KB reached the model.', acceptance.RECEIPT);
  assert.doesNotMatch('read 226.1 KB in 9 calls to github (acceptance stand-in) and 2 to linear; 1.6 KB reached the model.', acceptance.RECEIPT);
  // (no line counts: countinghouse #544)
  assert.doesNotMatch('read 1,204 lines (88.1 KB) in 4 calls to github (acceptance stand-in); 31 lines (2.4 KB) reached the model.', acceptance.RECEIPT);
});

test('the receipt object: the calls to github, all the stand-in\'s, in bytes and no line counts', () => {
  const {standInReceipt} = acceptance;
  const good = {calls: 9, bytesIn: 231526, bytesOut: 1638, servers: ['github'], standIn: ['github']};
  assert.strictEqual(standInReceipt(good), true);
  for (const [what, bad] of Object.entries({
    'none': null, 'no call': {...good, calls: 0}, 'another server': {...good, servers: ['github', 'linear']},
    'not marked': (({standIn, ...rest}) => rest)(good), 'another marked': {...good, standIn: ['linear']},
    'nothing read': {...good, bytesIn: 0}, 'nothing sent': {...good, bytesOut: 0}, 'lines in': {...good, linesIn: 1}, 'lines out': {...good, linesOut: 0}, 'no bytes in': {...good, bytesIn: undefined}, 'bytes out': {...good, bytesOut: '1638'}
  })) assert.strictEqual(standInReceipt(bad), false, what);
});

// (the run answered as cancelled too, so the window lists five; and the 429
// that one listing of the limited repository's name answers)
test('the stand-in answers one recorded success as cancelled, and one listing of the limited repository with GitHub\'s 429', () => {
  const dir = fixtures();
  const env = (result) => JSON.stringify({_recorded: 'test', request: {}, result});
  const runs = [{id: 42775507169, conclusion: 'failure'}, {id: 42954667398, conclusion: 'success'}, {id: 42774486556, conclusion: 'cancelled'}];
  fs.writeFileSync(path.join(dir, 'list_workflow_runs.json'), env({content: [{type: 'text', text: JSON.stringify({total_count: runs.length, workflow_runs: runs})}]}));
  const listed = JSON.parse(acceptance.recordedAnswer(dir, 'actions_list', {method: 'list_workflow_runs'}).content[0].text).workflow_runs;
  assert.deepStrictEqual(listed.map((r) => [r.id, r.conclusion]), [[42775507169, 'failure'], [42954667398, 'cancelled'], [42774486556, 'cancelled']]);
  const jobs = (owner, repo, id) => acceptance.recordedAnswer(dir, 'actions_list', {method: 'list_workflow_jobs', owner, repo, resource_id: id});
  assert.deepStrictEqual(jobs('mchen6', 'countinghouse', '42954667398'), {content: [{type: 'text', text: '{"jobs":{"total_count":0,"jobs":[]}}'}]}, 'answered as cancelled: no jobs');
  const limited = jobs('mchen6', 'countinghouse-limited', '42774486556');
  assert.strictEqual(limited.isError, true);
  assert.match(limited.content[0].text, /: 429 Too Many Requests/);
  // (the same run of the recorded repository is answered as any cancelled one)
  assert.deepStrictEqual(jobs('mchen6', 'countinghouse', '42774486556'), {content: [{type: 'text', text: '{"jobs":{"total_count":0,"jobs":[]}}'}]});
});

// (the pack lists the failed jobs of every run of the window that did not pass;
// recorded ones but the one had none. A call it has no reason to make is still
// one the stand-in has no recording for)
test('the stand-in answers the failed jobs of the recorded runs that neither passed nor failed, and of no other', async () => {
  const dir = fixtures();
  const env = (result) => JSON.stringify({_recorded: 'test', request: {}, result});
  const runs = [{id: 42775507169, conclusion: 'failure'}, {id: 41, conclusion: 'cancelled'}, {id: 42, conclusion: 'success'}, {id: 43, conclusion: 'failure'},
    {id: 45, conclusion: 'timed_out'}, {id: 46, conclusion: 'startup_failure'}, {id: 47, conclusion: null}];
  fs.writeFileSync(path.join(dir, 'list_workflow_runs.json'), env({content: [{type: 'text', text: JSON.stringify({total_count: runs.length, workflow_runs: runs})}]}));
  fs.writeFileSync(path.join(dir, 'list_workflow_jobs.json'), env({content: [{type: 'text', text: '{"jobs": {"total_count": 1, "jobs": [{"id": 7}]}}'}]}));
  const jobs = (id) => acceptance.recordedAnswer(dir, 'actions_list', {method: 'list_workflow_jobs', resource_id: id});
  assert.deepStrictEqual(jobs('42775507169'), {content: [{type: 'text', text: '{"jobs": {"total_count": 1, "jobs": [{"id": 7}]}}'}]}, 'the recorded one');
  for (const id of ['41', '47']) assert.deepStrictEqual(jobs(id), {content: [{type: 'text', text: '{"jobs":{"total_count":0,"jobs":[]}}'}]}, id);
  // (one that failed has failed jobs, which the recording would need; the id is a string, as GitHub's tool declares it)
  for (const id of ['42', '43', '45', '46', '44', '', undefined, '__proto__', 41]) assert.strictEqual(jobs(id), null, `${id}: a run that passed or failed, or none of the recorded`);
  const s = await acceptance.startStandIn({fixtures: dir, token: 'chacc_right'});
  try {
    const call = (id) => post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'actions_list', arguments: {method: 'list_workflow_jobs', resource_id: id}}});
    await call('41');
    assert.deepStrictEqual(s.state.unexpected, []);
    assert.strictEqual((await call('42')).body.result.isError, true);
    assert.deepStrictEqual(s.state.unexpected.map((u) => u.args.resource_id), ['42']);
  } finally {
    await s.close();
  }
});

// The review of the acceptance branch (2026-11-12).
test('the launcher environment drops every credential the pack\'s allowlist names', () => {
  const {ALLOWLIST} = require('../lib/allowlist');
  const names = require('../lib/packs').packVariables(ALLOWLIST, require('../scripts/dogfood').PACK);
  assert.ok(names.length > 0, 'the pack names a credential');
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = 'from-this-shell';
    const env = acceptance.launcherEnv('/h');
    for (const n of names) assert.ok(!(n in env), n);
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
});

test('waitForText waits for a line that comes later, and gives up after its time', async () => {
  let text = '';
  setTimeout(() => { text += 'module sandbox: mode enforce\n'; }, 150);
  assert.strictEqual(await acceptance.waitForText(() => text, /mode enforce/, 2000), true);
  assert.strictEqual(await acceptance.waitForText(() => text, /never/, 200), false);
});

test('stopTree ends the launcher and what it started, which holds the same pipes (on Windows, taskkill /T)', async () => {
  const {spawn} = require('node:child_process');
  // A launcher that starts a long-lived child on inherited pipes, as start does.
  const code = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'}); console.log(c.pid); setInterval(() => {}, 1000);";
  const launcher = spawn(process.execPath, ['-e', code], {stdio: ['pipe', 'pipe', 'pipe'], detached: true});
  const grandchild = await new Promise((resolve) => launcher.stdout.once('data', (d) => resolve(parseInt(String(d), 10))));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return false; } };
  assert.ok(alive(grandchild));
  await acceptance.stopTree(launcher, 3000);
  for (const until = Date.now() + 3000; (alive(grandchild) || alive(launcher.pid)) && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!alive(launcher.pid), 'the launcher ended');
  assert.ok(!alive(grandchild), 'what it started ended too');
});

// The report is uploaded (an artifact of the run): the run's token is in no
// line the runtime or the launcher wrote, and in nothing the report holds.
test('reportText: a token in a log fails the run, and is never written', () => {
  const token = 'chacc_00000000000000000000000000000000fake';
  const clean = {checks: [{name: 'a', ok: true}], ok: true};
  const text = acceptance.reportText(clean, token, ['no secret here']);
  assert.strictEqual(JSON.parse(text).ok, true);
  assert.ok(JSON.parse(text).checks.some((c) => c.name === 'the run\'s token is in no log line' && c.ok === true));

  const leaked = {checks: [{name: 'a', ok: true, detail: `saw Bearer ${token}`}], ok: true, runtimeLog: `x ${token} y`};
  const out = acceptance.reportText(leaked, token, [`x ${token} y`]);
  assert.ok(!out.includes(token), 'the token is never in the report text');
  const r = JSON.parse(out);
  assert.strictEqual(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === 'the run\'s token is in no log line' && c.ok === false));
  assert.ok(r.checks.some((c) => c.name === 'the run\'s token is in nothing the report holds' && c.ok === false));
});

test('trapSignals: SIGINT and SIGTERM run the cleanup once, then exit 130 and 143; untrapped, nothing runs', async () => {
  for (const [signal, want] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    let cleaned = 0;
    let exited = null;
    const untrap = acceptance.trapSignals(async () => { cleaned += 1; }, (code) => { exited = code; });
    process.emit(signal, signal);
    process.emit(signal, signal);
    for (const until = Date.now() + 2000; exited == null && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(cleaned, 1, `${signal}: cleaned once`);
    assert.strictEqual(exited, want, signal);
    untrap();
  }
  let ran = false;
  const before = process.listenerCount('SIGTERM');
  acceptance.trapSignals(async () => { ran = true; }, () => {})();
  assert.strictEqual(process.listenerCount('SIGTERM'), before, 'untrap removes its handlers');
  assert.strictEqual(ran, false);
});

const SRC = process.env.CH_ACCEPTANCE_SRC;
test('the whole acceptance run', {timeout: 1200000, skip: SRC == null && 'CH_ACCEPTANCE_SRC is not set (a directory of clones)'}, async () => {
  const pairs = (v, flag) => (v || '').split(',').filter(Boolean).flatMap((p) => [flag, p]);
  // CI keeps the report as an artifact (.github/workflows/acceptance.yml).
  const reportFile = process.env.CH_ACCEPTANCE_REPORT != null ? path.resolve(process.env.CH_ACCEPTANCE_REPORT) : path.join(tmp('ch-acc-report-'), 'report.json');
  const out = {text: '', write(s) { this.text += s; }};
  const code = await acceptance.main(['--src', SRC, ...pairs(process.env.CH_ACCEPTANCE_CLONES, '--clone'), ...pairs(process.env.CH_ACCEPTANCE_REFS, '--ref'), '--report', reportFile], {stdout: out, stderr: out});
  // The exit code first: a preflight that fails writes no report.
  assert.strictEqual(code, 0, failureText(out.text));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.strictEqual(report.ok, true);
  assert.ok(report.checks.length >= 15, `${report.checks.length} checks`);
  assert.ok(Number.isInteger(report.timings.firstResult));
  assert.ok(typeof report.work === 'string' && !fs.existsSync(report.work), `this run's work directory is removed: ${report.work}`);
});

// The shared runtime through the native shim (MCP completeness M17;
// scripts/shared-acceptance.js has what it covers and what it does not yet).
const shared = require('../scripts/shared-acceptance');

test('shared: the client harness is a `claude` beside a script and an empty configuration, all in the run\'s directory', () => {
  const dir = path.join(tmp('ch-shared-h-'), 'client');
  const h = shared.claudeHarness(dir);
  assert.strictEqual(path.basename(h.claude).replace(/\.exe$/, ''), 'claude');
  for (const p of [h.claude, h.script, h.config]) assert.ok(p.startsWith(dir + path.sep), p);
  assert.deepStrictEqual(fs.readdirSync(h.config), []);
  fs.rmSync(path.dirname(dir), {recursive: true, force: true});
});

// M17 (b), 2026-11-16: a run under a home whose .claude held the person's
// plugins answered "no" for the tested client, and (b) read as declined.
test('shared: the client\'s repository goes in the runner\'s temporary directory on CI, else /tmp on POSIX, never the run\'s TMPDIR', () => {
  assert.strictEqual(shared.clientRepoRoot({RUNNER_TEMP: '/runner/_temp'}, 'linux'), '/runner/_temp');
  assert.strictEqual(shared.clientRepoRoot({TMPDIR: '/home/someone/tmp'}, 'linux'), '/tmp');
  assert.strictEqual(shared.clientRepoRoot({TMPDIR: '/home/someone/tmp'}, 'darwin'), '/tmp');
  assert.strictEqual(shared.clientRepoRoot({RUNNER_TEMP: 'relative'}, 'linux'), '/tmp', 'a relative RUNNER_TEMP is not one');
  assert.strictEqual(shared.clientRepoRoot({}, 'win32'), os.tmpdir());
});

test('shared: every .claude at or above the client\'s repository is found, except the client\'s own configuration', () => {
  const top = tmp('ch-shared-stray-');
  const repo = path.join(top, 'a', 'b', 'repo');
  fs.mkdirSync(repo, {recursive: true});
  const config = path.join(top, 'config');
  fs.mkdirSync(config);
  // only what is inside this test's directory: the machine's own may sit higher
  const ours = (found) => found.filter((d) => d.startsWith(top + path.sep));
  assert.deepStrictEqual(ours(shared.strayClaudeDirs(repo, config)), []);
  fs.mkdirSync(path.join(top, 'a', '.claude'));
  fs.mkdirSync(path.join(repo, '.claude'));
  assert.deepStrictEqual(ours(shared.strayClaudeDirs(repo, config)), [path.join(repo, '.claude'), path.join(top, 'a', '.claude')]);
  assert.deepStrictEqual(ours(shared.strayClaudeDirs(repo, path.join(top, 'a', '.claude'))), [path.join(repo, '.claude')], 'the client\'s own configuration is not a stray');
  fs.rmSync(top, {recursive: true, force: true});
});

test('shared: the client\'s configuration directory must be an absolute path to an existing, empty directory', () => {
  const top = tmp('ch-shared-config-');
  assert.match(shared.configProblem(''), /not an absolute path/);
  assert.match(shared.configProblem(undefined), /not an absolute path/);
  assert.match(shared.configProblem('relative/config'), /not an absolute path/);
  assert.match(shared.configProblem(path.join(top, 'missing')), /ENOENT/);
  fs.writeFileSync(path.join(top, 'file'), '');
  assert.match(shared.configProblem(path.join(top, 'file')), /not a directory/);
  fs.mkdirSync(path.join(top, 'full'));
  fs.writeFileSync(path.join(top, 'full', 'settings.json'), '{}');
  assert.match(shared.configProblem(path.join(top, 'full')), /not empty/);
  fs.mkdirSync(path.join(top, 'empty'));
  assert.strictEqual(shared.configProblem(path.join(top, 'empty')), null);
  assert.strictEqual(shared.configProblem(shared.claudeHarness(path.join(top, 'client')).config), null, 'the harness\'s own');
  fs.rmSync(top, {recursive: true, force: true});
});

test('shared: the shim goes in a private <home>/shim, its owner\'s only (POSIX modes; on Windows a DACL of this user and SYSTEM)', () => {
  const home = tmp('ch-shared-home-');
  const bin = path.join(home, 'built');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const to = shared.installShim(home, bin);
  if (process.platform === 'win32') {
    const winAcl = require('../lib/win-acl');
    assert.strictEqual(to, path.join(home, 'shim', 'ch-shim.exe'));
    // private as ch-local's secrets are, and made so here: the temporary
    // directory's inherited rules (Administrators among them) are gone, and
    // only this user and SYSTEM are allowed anything
    for (const [what, acl, opts] of [['the shim\'s directory', winAcl.fileAcl(path.join(home, 'shim')), {directory: true}], ['the shim', winAcl.fileAcl(to), {}]]) {
      assert.strictEqual(winAcl.privateProblem(what, acl, opts), null, JSON.stringify(acl));
      const rules = (Array.isArray(acl.rules) ? acl.rules : [acl.rules]).filter((r) => r != null && r.type === 'Allow' && r.inheritOnly !== true);
      assert.deepStrictEqual([...new Set(rules.map((r) => r.sid))].sort(), [acl.user, winAcl.SYSTEM].sort(), `${what}: ${JSON.stringify(acl)}`);
    }
  } else {
    assert.strictEqual(to, path.join(home, 'shim', 'ch-shim'));
    assert.strictEqual(fs.statSync(path.join(home, 'shim')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(to).mode & 0o777, 0o700);
  }
  fs.rmSync(home, {recursive: true, force: true});
});

test('shared: daemonPid reads daemon.json\'s pid, and null for none or a bad one', () => {
  const home = tmp('ch-shared-d-');
  assert.strictEqual(shared.daemonPid(home), null);
  fs.mkdirSync(path.join(home, 'run', 'daemon'), {recursive: true});
  fs.writeFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), '{"pid": "7"}');
  assert.strictEqual(shared.daemonPid(home), null);
  fs.writeFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), '{"pid": 4242}');
  assert.strictEqual(shared.daemonPid(home), 4242);
  fs.rmSync(home, {recursive: true, force: true});
});

// A failed run explains itself in CI (#54): with no live daemon, one is
// started exactly as the shim would start it, and what it says is shown.
test('shared: daemonDiagnosis starts the daemon as shim.json says and shows its output, ended within its bound', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shared-diag-'));
  try {
    assert.match(await shared.daemonDiagnosis(home), /no shim\.json/);
    const fake = path.join(home, 'fake-ch-local.js');
    // real paths: on macOS the temporary directory is a link (/var ->
    // /private/var), and a child's cwd is where it leads (#54's macOS leg)
    fs.writeFileSync(fake, "console.log('args', process.argv.slice(2).join(' '), 'cwd', process.cwd() === require('fs').realpathSync(process.env.HOME_WANTED), 'env', process.env.CH_DIAG_X);\n" +
      // never process.exit(): on macOS a pipe is written asynchronously, and
      // an exit can drop what was written (#54's macOS run); exitCode lets the
      // output drain first
      "console.error('refusing: something'); if (process.env.CH_DIAG_STAY === '1') setInterval(() => {}, 1000); else process.exitCode = 3;\n");
    const shimJson = (env) => fs.writeFileSync(path.join(home, 'shim.json'), JSON.stringify({node: process.execPath, chLocal: fake, env: Object.assign({PATH: process.env.PATH, HOME_WANTED: home}, env)}));
    shimJson({CH_DIAG_X: 'seen'});
    const out = await shared.daemonDiagnosis(home);
    assert.match(out, /args daemon --home .* cwd true env seen/);
    assert.match(out, /refusing: something/);
    assert.match(out, /exit 3/);
    shimJson({CH_DIAG_STAY: '1'});
    const started = Date.now();
    const stayed = await shared.daemonDiagnosis(home, 1500);
    assert.ok(Date.now() - started < 8000, 'ended at its bound');
    assert.match(stayed, /still running after 1500 ms; ended/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('shared: treeOf lists a process and its descendants, and nothing else (on Windows through WMI)', async () => {
  const {spawn} = require('node:child_process');
  const parent = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {stdio: 'ignore'}); setTimeout(()=>{}, 60000)"], {stdio: 'ignore'});
  try {
    let tree = [];
    for (const until = Date.now() + (process.platform === 'win32' ? 30000 : 5000); Date.now() < until && tree.length < 2;) {
      tree = shared.treeOf(parent.pid) || [];
      await new Promise((r) => setTimeout(r, 50));
    }
    // its node child, by its command line (on Windows a console-less node
    // may also have a conhost.exe below it, which is its descendant too)
    const nodes = tree.filter((p) => p.pid !== parent.pid && /setTimeout/.test(p.args));
    if (process.platform !== 'win32') assert.strictEqual(tree.length, 2, JSON.stringify(tree));
    assert.ok(tree.some((p) => p.pid === parent.pid), JSON.stringify(tree));
    assert.strictEqual(nodes.length, 1, JSON.stringify(tree));
    assert.ok(!tree.some((p) => p.pid === process.pid), 'not its parent');
  } finally {
    for (const p of shared.treeOf(parent.pid) || []) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  }
});

// Gated as the whole run is, Windows included: there daemon.json names a
// live daemon and its named pipe (C4c).
test('the shared runtime through the native shim', {timeout: 2400000, skip: SRC == null && 'CH_ACCEPTANCE_SRC is not set (a directory of clones)'}, async () => {
  const pairs = (v, flag) => (v || '').split(',').filter(Boolean).flatMap((p) => [flag, p]);
  const reportFile = path.join(tmp('ch-shared-report-'), 'report.json');
  const out = {text: '', write(s) { this.text += s; }};
  const code = await shared.main(['--src', SRC, ...pairs(process.env.CH_ACCEPTANCE_CLONES, '--clone'), ...pairs(process.env.CH_ACCEPTANCE_REFS, '--ref'), '--report', reportFile],
    {stdout: out, stderr: out});
  assert.strictEqual(code, 0, failureText(out.text));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.strictEqual(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
});

// (b-latched), the checks the gated run makes against two sessions
// (countinghouse #337, #545), here against stand-ins: what a refusal must say to
// pass, and what each wrong answer fails on.
test('shared: (b-latched) with no tested client a latched session is refused as any session is, with the terminal command; never as a decline', async () => {
  const why = {reason: 'client hook present', at: '~/x/.claude/settings.json'};
  // (the launcher form at the run's own home, as the runtime names it since
  // countinghouse #536; on Windows its backslashes are escaped in the JSON too)
  const LAUNCHER = process.platform === 'win32' ? 'C:\\t\\home\\bin\\ch-local.js' : '/t/home/bin/ch-local.js';
  const COMMAND = `node "${LAUNCHER}" settings set requestTimeout 60s`;
  const refusal = (code, text) => ({result: {isError: true, _meta: {'countinghouse/code': code}, content: [{type: 'text', text}]}});
  const TEXT = 'Changing requestTimeout to 60s loosens a guarding setting, so it needs your own confirmation; nothing was changed. To allow this, run `' + COMMAND + '` in a terminal yourself. That change is kept, not just for this session, and a value above what this runtime started with takes effect when it next starts.';
  const good = refusal('SETTING_NEEDS_CONFIRMATION', TEXT);
  const LOCKED = 'not confirmed (locked in this session)';
  const history = (...changes) => changes.map((change) => ({setting: 'requestTimeout', change}));
  const failed = async (loosening, {firstValue = 10000, handed = why, unlatched = loosening, second: mine = history(LOCKED), first: theirs = history('not confirmed (not tested yet)'), tightened = 20000} = {}) => {
    const checks = [];
    const check = (name, ok, detail) => { checks.push({name, ok: ok === true, detail}); return ok === true; };
    const session = (loosen, settings, lines) => async (a) => (a.action === 'get' ? {result: {structuredContent: {settings, history: lines}}}
      : a.value === '60s' ? loosen : {result: {structuredContent: {new: tightened, applies: 'this session'}}});
    const second = session(loosening, [], mine);
    const first = session(unlatched, [{name: 'requestTimeout', value: firstValue}], theirs);
    await shared.latchedChecks({second, first, why: handed, reason: 'client hook present', launcher: LAUNCHER, check});
    assert.strictEqual(checks.length, 7);
    return checks.filter((c) => !c.ok).map((c) => c.name.replace('(b-latched) ', ''));
  };
  const REFUSED = 'a loosening is refused with the terminal command; never as a decline';
  const SAME = 'word for word as the first session\'s, which is not latched';
  assert.deepStrictEqual(await failed(good), []);
  assert.deepStrictEqual(await failed(refusal('SETTING_DECLINED_THIS_SESSION', TEXT)), [REFUSED]);
  assert.deepStrictEqual(await failed(refusal('SETTING_CLIENT_NOT_CONFIRMED', TEXT)), [REFUSED], 'the latch\'s own refusal, while no client is tested');
  // (any word of its client's configuration, anywhere in the answer)
  const leaks = [`${TEXT} (client hook present: ~/x/.claude/settings.json)`, `${TEXT} This client's configuration could answer forms by itself.`, `${TEXT} (~/x/.claude/settings.json)`];
  for (const text of leaks) assert.deepStrictEqual(await failed(refusal('SETTING_NEEDS_CONFIRMATION', text), {unlatched: good}), [SAME], text);
  assert.deepStrictEqual(await failed({result: {...good.result, structuredContent: {why}}}, {unlatched: good}), [SAME]);
  // (the bare command is on no PATH, and another home's launcher is not this run's)
  const other = (form) => refusal('SETTING_NEEDS_CONFIRMATION', TEXT.replace(COMMAND, form));
  assert.deepStrictEqual(await failed(other('ch-local settings set requestTimeout 60s')), [REFUSED], 'the bare command');
  assert.deepStrictEqual(await failed(other('node "/elsewhere/bin/ch-local.js" settings set requestTimeout 60s')), [REFUSED], 'another home\'s launcher');
  assert.deepStrictEqual(await failed(good, {second: history('not confirmed (not tested yet)')}), ['the second session\'s history says it is locked'], 'a second session that never latched');
  assert.deepStrictEqual(await failed(good, {first: history(LOCKED)}), ['the first session\'s does not'], 'a first session that latched');
  assert.deepStrictEqual(await failed(good, {first: []}), ['the first session\'s does not'], 'a first session that was never asked');
  assert.deepStrictEqual(await failed(good, {tightened: 60000}), ['a tightening still applies to that session']);
  assert.deepStrictEqual(await failed(good, {firstValue: 20000}), ['the first session\'s settings are its own (its 10 s kept)']);
  assert.deepStrictEqual(await failed(good, {handed: {reason: 'plugin hook present'}}), ['the conditions handed over for the second client say no, with the fixture\'s reason']);
});

// Not yet through the real shim (scripts/shared-acceptance.js says where it
// is covered meanwhile): a todo, never a skip, so the acceptance workflow's
// "skipped 0" still holds.
test('shared: (b1) the settings confirmation form round trip, through the shim', {todo: 'once a tested Claude Code range is in countinghouse lib/elicitation-clients.json (the maintainer\'s hand test); (b-latched)\'s refusal is then the latch\'s own, with its reason'});

// (a), (c) and (b2): the checks the gated run makes through the shim, with
// the acceptance fixture pack turned on from the terminal, here against
// stand-ins: a good run passes every check, and each wrong one fails its own.
const checksOf = async (fn) => {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({name, ok: ok === true, detail}); return ok === true; };
  await fn(check);
  return {all: checks, failed: checks.filter((c) => !c.ok).map((c) => c.name)};
};

test('shared: (a) progress frames before an answer, through the shim: the checks', async () => {
  const token = 'tok';
  const frame = (progress, t = token) => ({jsonrpc: '2.0', method: 'notifications/progress', params: {progressToken: t, progress}});
  const answer = {jsonrpc: '2.0', id: 7, result: {structuredContent: {hopped: true, said: 'back'}}};
  const run = (r) => (check) => shared.progressChecks({token, check, run: async () => Object.assign({response: answer, before: [frame(25), frame(75)], after: []}, r)});
  assert.deepStrictEqual((await checksOf(run({}))).failed, []);
  assert.ok((await checksOf(run({before: []}))).failed.some((n) => /before its answer/.test(n)), 'no frame before the answer');
  assert.ok((await checksOf(run({before: [frame(75), frame(25)]}))).failed.some((n) => /rises/.test(n)), 'progress that falls');
  assert.ok((await checksOf(run({after: [frame(90)]}))).failed.some((n) => /after the answer/.test(n)), 'a frame after the answer');
  assert.ok((await checksOf(run({before: [frame(25, 'other')]}))).failed.some((n) => /token/.test(n)), 'another call\'s frame');
  assert.ok((await checksOf(run({response: {jsonrpc: '2.0', id: 7, result: {structuredContent: {hopped: false}}}}))).failed.some((n) => /through its part/.test(n)), 'no hop');
});

test('shared: (c) a cancelled call leaves no in-flight entry, through the shim: the checks', async () => {
  const holdMs = 20000;
  const controlHoldMs = 5000;
  // the control's own answer, waited for at the close (within the grace)
  const answered = [{jsonrpc: '2.0', id: 3, result: {structuredContent: {waited: controlHoldMs}}}];
  const crash = [{jsonrpc: '2.0', id: 3, error: {code: -32603, message: 'countinghouse\'s runtime restarted before answering; the call may have run', data: {'countinghouse/code': 'RUNTIME_RESTARTED'}}}];
  const run = (c, k) => (check) => shared.cancelChecks({holdMs, controlHoldMs, check,
    cancelled: async () => Object.assign({exitMs: 300, answers: []}, c), control: async () => Object.assign({exitMs: 3200, answers: answered}, k)});
  assert.deepStrictEqual((await checksOf(run({}, {}))).failed, []);
  assert.ok((await checksOf(run({answers: answered}, {}))).failed.some((n) => /never answered/.test(n)), 'a cancelled call answered');
  assert.ok((await checksOf(run({answers: crash}, {}))).failed.some((n) => /never answered/.test(n)), 'a cancelled call crash-answered');
  assert.ok((await checksOf(run({exitMs: 19000}, {}))).failed.some((n) => /promptly/.test(n)), 'the shim waited on the cancelled call');
  assert.ok((await checksOf(run({exitMs: null}, {}))).failed.some((n) => /promptly/.test(n)), 'the shim never ended');
  // the control is what makes the check sensitive: a call in flight at the close must get its own answer
  assert.ok((await checksOf(run({}, {answers: []}))).failed.some((n) => /control/.test(n)), 'a control left unanswered');
  assert.ok((await checksOf(run({}, {exitMs: 5, answers: crash}))).failed.some((n) => /control/.test(n)), 'a control crash-answered (the bye sent at the close)');
  assert.ok((await checksOf(run({}, {exitMs: 10500}))).failed.some((n) => /control/.test(n)), 'a control ended past the grace');
});

test('shared: (b2) ctx.ask through the shim: the checks', async () => {
  const what = 'acceptance';
  // a state as countinghouse mints it (#412, F2-4): v2, its payload sealed
  const state = `v2.${Buffer.alloc(64, 0xa5).toString('base64url')}.${'b'.repeat(43)}`;
  const question = {result: {resultType: 'input_required', requestState: state,
    inputRequests: {answer: {method: 'elicitation/create', params: {mode: 'form', message: `ch-pack-accept: Proceed with ${what}?`, requestedSchema: {type: 'object'}}}}}};
  const refused = (code) => ({result: {isError: true, _meta: {'countinghouse/code': code}, content: [{type: 'text', text: code}]}});
  // the runtime as it should answer: the question, the answer once, then the state used
  const runtime = (over) => {
    const used = new Set();
    return async (extra) => {
      if (extra.requestState == null) return over.first || question;
      if (extra.requestState !== state) return over.forged || refused('ASK_STATE_INVALID');
      if (used.has(state)) return over.again || refused('ASK_STATE_INVALID');
      used.add(state);
      return over.retry || {result: {structuredContent: {asked: true, answer: extra.inputResponses.answer.content}}};
    };
  };
  const run = (over) => (check) => shared.askChecks({what, check, call: runtime(over)});
  assert.deepStrictEqual((await checksOf(run({}))).failed, []);
  // the state must be opaque, whatever its version: one whose payload a
  // client can read (v1's JSON in the clear), or that shows the question's
  // name, fails the first check
  const firstWith = (requestState) => ({first: {result: Object.assign({}, question.result, {requestState})}});
  const st = (bytes) => `v1.${Buffer.from(bytes).toString('base64url')}.${'b'.repeat(43)}`;
  const cases = [
    [st(JSON.stringify({n: 'x', r: 1})), 'a payload readable as JSON'],
    [st(Buffer.concat([Buffer.alloc(28, 0xa5), Buffer.from(JSON.stringify({n: 'x', e: 1}))])), 'JSON in the clear after a binary prefix (sealed but not encrypted)'],
    [st('\u0000answer\u0001'), 'the question\'s name in the payload'],
    [st('\u0000ch-pack-accept\u0001'), 'the asking module\'s name in the payload'],
    ['opaque', 'no version'],
  ];
  for (const [s, why] of cases) {
    const c = await checksOf(run(firstWith(s)));
    assert.ok(c.failed.some((n) => /InputRequiredResult/.test(n)), why);
  }
  const v7 = await checksOf(run(firstWith(`v7.${'a'.repeat(40)}.${'b'.repeat(43)}`)));
  assert.ok(!v7.failed.some((n) => /InputRequiredResult/.test(n)), 'another version, opaque: accepted (the privacy is pinned, not the number)');
  const none = await checksOf(run({first: {result: {structuredContent: {asked: false, code: 'ASK_UNAVAILABLE'}}}}));
  assert.deepStrictEqual([none.all.length, none.failed.length], [1, 1], 'no question: the rest is not tried');
  assert.ok((await checksOf(run({retry: {result: {structuredContent: {asked: true, answer: {yes: false}}}}}))).failed.some((n) => /gets it/.test(n)), 'the wrong answer');
  assert.ok((await checksOf(run({again: {result: {structuredContent: {asked: true, answer: {yes: true}}}}}))).failed.some((n) => /used once/.test(n)), 'a state used twice');
  assert.ok((await checksOf(run({forged: {result: {structuredContent: {asked: true, answer: {yes: true}}}}}))).failed.some((n) => /tampered/.test(n)), 'a tampered state served');
});

// The acceptance fixture pack is the run's own: never in a shipped allowlist,
// release-pins.json or the published package (the reviewer's condition).
test('shared: the acceptance fixture pack is in no shipped allowlist, release pin or published file, and npm refuses to publish it', () => {
  const {ALLOWLIST} = require('../lib/allowlist');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ALLOWLIST.packs, shared.ACCEPT), false);
  const shipped = new Set([...ALLOWLIST.runtime.packages, ...Object.values(ALLOWLIST.packs).flatMap((p) => p.modules), ...Object.keys(ALLOWLIST.pins || {})]);
  for (const name of shared.ACCEPT_PACKAGES) assert.strictEqual(shipped.has(name), false, name);
  const pinsText = fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8');
  for (const name of [...shared.ACCEPT_PACKAGES, 'fixtures']) assert.ok(!pinsText.includes(name), name);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.every((f) => !/^test\b/.test(f)), JSON.stringify(pkg.files));
  for (const dir of shared.ACCEPT_DIRS) {
    assert.ok(dir.startsWith(path.join(__dirname, 'fixtures')), dir);
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(own.private, true, `${own.name}: npm refuses to publish it`);
    assert.ok(shared.ACCEPT_PACKAGES.includes(own.name), own.name);
  }
  // the release the run adds it with only adds it: the shipped packs unchanged
  const added = shared.acceptRelease(ALLOWLIST);
  assert.deepStrictEqual(Object.keys(added.packs).filter((k) => k !== shared.ACCEPT), Object.keys(ALLOWLIST.packs));
  assert.deepStrictEqual(added.packs[shared.ACCEPT], {modules: shared.ACCEPT_PACKAGES});
});

// A work tree that Windows keeps locked a moment after the daemon is gone
// (EPERM, EBUSY) is retried; one still not removed is said on its own line
// and never ends the run: the verdict already reported stands.
test('shared: the run\'s folders are removed with retries; one left behind is said, never thrown, and leaves the verdict alone', () => {
  const said = [];
  const calls = [];
  const eperm = (dir, opts) => { calls.push({dir, opts}); throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${dir}'`), {code: 'EPERM'}); };
  assert.strictEqual(shared.removeRunFolder('/x/work', {rm: eperm, say: (s) => said.push(s), holders: () => ['pid 7: node /x/work/daemon.js']}), false);
  assert.deepStrictEqual(said, ['cleanup: /x/work was not removed (EPERM); the verdict above stands', 'cleanup: what names /x/work now: pid 7: node /x/work/daemon.js']);
  // (each system's own line when nothing names it: Windows can't read a working folder)
  for (const [platform, line] of [['linux', 'no process names it (one may hold a file in it without naming it)'], ['darwin', 'no process names it (one may hold a file in it without naming it)'],
    ['win32', 'no process names it on its command line (a working folder can\'t be read on Windows)']]) {
    const none = [];
    shared.removeRunFolder('/x/work', {rm: eperm, say: (s) => none.push(s), holders: () => [], platform});
    assert.strictEqual(none[1], `cleanup: what names /x/work now: ${line}`, platform);
  }
  assert.ok(calls[0].opts.recursive === true && calls[0].opts.force === true && calls[0].opts.maxRetries >= 5 && calls[0].opts.retryDelay >= 100, JSON.stringify(calls[0].opts));
  const unread = [];
  shared.removeRunFolder('/x/work', {rm: eperm, say: (s) => unread.push(s), holders: () => { throw new Error('the process list could not be read'); }});
  assert.strictEqual(unread[1], 'cleanup: what names /x/work could not be looked for: the process list could not be read');
  const quiet = [];
  assert.strictEqual(shared.removeRunFolder('/x/repo', {rm: () => {}, say: (s) => quiet.push(s)}), true);
  assert.deepStrictEqual(quiet, []);
});

test('shared: what holds a folder: a process whose command line or working folder is under it, never one beside it', () => {
  const rows = [{pid: 1, ppid: 0, args: 'node /x/work/bin/daemon.js'}, {pid: 2, ppid: 0, args: 'node /x/workshop/a.js'}, {pid: 3, ppid: 0, args: 'sleep 9'}, {pid: 4, ppid: 0, args: 'x'.repeat(400) + ' /x/work'}];
  const cwdOf = (pid) => (pid === 3 ? '/x/work/sub' : null);
  const held = shared.holdersOf('/x/work', rows, cwdOf);
  assert.deepStrictEqual(held.map((h) => h.split(':')[0]), ['pid 1', 'pid 3', 'pid 4']);
  assert.ok(held[1].includes('working folder /x/work/sub'), held[1]);
  assert.ok(held.every((h) => h.length <= 260), 'a long command line is cut');
});

test('shared: a path that only ends in the folder\'s name is not it; on Windows, case and slashes do not matter', () => {
  const none = () => null;
  assert.deepStrictEqual(shared.holdersOf('/tmp/acc-1', [{pid: 1, ppid: 0, args: 'cp /home/u/tmp/acc-1 x'}, {pid: 2, ppid: 0, args: 'node --home=/tmp/acc-1/home'}, {pid: 5, ppid: 0, args: 'env NODE_PATH=/a:/tmp/acc-1/lib node'}], none).map((h) => h.split(':')[0]), ['pid 2', 'pid 5']);
  const win = shared.holdersOf(['C:\\Users\\R\\AppData\\Local\\Temp\\acc-2'], [{pid: 3, ppid: 0, args: '"c:/users/r/appdata/local/temp/ACC-2/bin/ch-shim.exe" --x'}, {pid: 4, ppid: 0, args: 'C:\\other\\acc-2'}], none, 'win32');
  assert.deepStrictEqual(win.map((h) => h.split(':')[0]), ['pid 3']);
});

test('shared: an interrupted run removes its folders without retries and looks for no process', () => {
  const said = []; let opts = null; let looked = false;
  const rm = (dir, o) => { opts = o; throw Object.assign(new Error('EBUSY'), {code: 'EBUSY'}); };
  assert.strictEqual(shared.removeRunFolder('/x/work', {rm, say: (s) => said.push(s), quick: true, holders: () => { looked = true; return []; }}), false);
  assert.ok(opts.maxRetries == null, JSON.stringify(opts));
  assert.strictEqual(looked, false);
  assert.deepStrictEqual(said, ['cleanup: /x/work was not removed (EBUSY); the verdict above stands', 'cleanup: what names /x/work was not looked for: the run was interrupted']);
});
