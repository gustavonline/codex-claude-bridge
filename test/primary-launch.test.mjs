import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Startup proof with a synthetic home, a fake signed app and a fake `open`.
// The real wrapper and bridge.mjs run; no Codex, Claude, model or Mac is used.
// This is not Mac activation, GUI or model acceptance.
const launcher = fileURLToPath(new URL('../launch.py', import.meta.url));
const bridgeProgram = realpathSync(fileURLToPath(new URL('../bridge.mjs', import.meta.url)));
const executableName = 'CodexSyntheticPrimaryTest';
// The synthetic desktop is a shell named like the app. Like Codex, it starts
// CODEX_CLI_PATH app-server and holds that app-server's stdin open for its own
// lifetime: an OS pipe whose writer (sleep) never closes it. Run28/29's Node
// fake desktops saw the app-server's stdin end at once (retained evidence); this
// fixture does not depend on Node child-pipe behaviour. The pipeline element
// execs the wrapper, so the app shell stays the only process with the app's
// command line and is the Bridge's parent. App-server stderr (content-free) is
// kept for diagnosis; the Bridge's own log records its lifecycle.
const appCode = 'sleep 600 | exec "$CODEX_CLI_PATH" app-server --analytics-default-enabled 2>>"$FAKE_APP_DIR/app-server.stderr"';
// The fake bundled CLI keeps its stdout open and reads nothing, like an idle
// app-server. (`exec cat >/dev/null` closed the Bridge's native stdout at once.)
const fakeCli = '#!/bin/sh\nexec sleep 600\n';

// Runs launch.py functions in-process with the fake app's tools; never the real open/codesign.
const python = (code, args, env = {}) => {
  const result = spawnSync('python3', ['-B', '-c', `import importlib.util, json, pathlib, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('launch', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${code}`, launcher, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

function world({ bundleId = 'com.openai.codex', cli = 'nested', signed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-primary-'));
  const home = join(root, 'home'), state = join(root, 'state'), app = join(root, 'Codex.app');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex/config.toml'), 'model = "gpt-synthetic"\n');
  writeFileSync(join(home, '.codex/AGENTS.md'), 'SYNTHETIC PRIMARY INSTRUCTIONS\n');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>${executableName}</string></dict></plist>`);
  symlinkSync('/bin/sh', join(app, 'Contents/MacOS', executableName));
  mkdirSync(join(app, 'Contents/Resources/cua_node/bin'), { recursive: true });
  symlinkSync(process.execPath, join(app, 'Contents/Resources/cua_node/bin/node'));
  if (cli) {
    const path = join(app, cli === 'nested' ? 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' : 'Contents/Resources/codex');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, fakeCli); chmodSync(path, 0o755);
  }
  const tools = join(root, 'tools'); mkdirSync(tools);
  const codesign = join(tools, 'codesign'); writeFileSync(codesign, `#!/bin/sh\nexit ${signed ? 0 : 1}\n`); chmodSync(codesign, 0o755);
  const open = join(tools, 'open');
  writeFileSync(open, `#!${process.execPath}
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_OPEN_LOG, JSON.stringify({ args, inherited: Object.keys(process.env).filter(key => /^(CODEX_|BRIDGE_)/.test(key)).sort() }));
const env = { ...process.env };
for (let i = 0; i < args.length; i++) if (args[i] === '--env') { const [key, ...value] = args[i + 1].split('='); env[key] = value.join('='); }
const child = spawn(args[args.indexOf('-a') + 1] + '/Contents/MacOS/${executableName}', ['-c', ${JSON.stringify(appCode)}], { env, detached: true, stdio: 'ignore' });
fs.writeFileSync(process.env.FAKE_APP_PID, String(child.pid)); child.unref();
`); chmodSync(open, 0o755);
  // An inherited override and the separate test profile's settings must not reach the app.
  const env = { HOME: home, CODEX_CLI_PATH: '/inherited/must-not-pass', CODEX_HOME: join(state, 'codex'),
    CODEX_ELECTRON_USER_DATA_PATH: join(state, 'desktop'), BRIDGE_CLAUDE: '/nonexistent/unit-test-must-not-start-claude',
    FAKE_OPEN_LOG: join(root, 'open.json'), FAKE_APP_PID: join(root, 'app.pid'), FAKE_APP_DIR: root };
  const run = (mode = 'start') => python(`m.OPEN, m.CODESIGN, m.PRIMARY_START_SECONDS = sys.argv[4], sys.argv[5], 20
state, app, mode = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[6]
with patch.object(m, 'claude_path', return_value='/nonexistent/unit-test-must-not-start-claude'):
    try:
        if mode == 'unknown':
            with patch.object(m, 'process_table', side_effect=OSError('ps unavailable')):
                print(json.dumps(m.start_primary(state, app)))
        else:
            print(json.dumps(m.primary_status(state, app) if mode == 'status' else m.start_primary(state, app)))
    except RuntimeError as error:
        print(json.dumps({'error': str(error)}))`, [state, app, open, codesign, mode], env);
  const stop = async () => {
    if (!existsSync(join(root, 'app.pid'))) return;
    const pid = Number(readFileSync(join(root, 'app.pid'), 'utf8'));
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 100; i++) {
      try { process.kill(-pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  };
  const read = (path, parse = false) => existsSync(path) ? (parse ? JSON.parse(readFileSync(path, 'utf8')) : readFileSync(path, 'utf8')) : null;
  // Content-free evidence for a failed start: app-server exit, its stderr and Bridge log event names.
  const diagnose = () => {
    const logs = join(state, 'primary/logs'), runtime = join(state, 'primary/runtime');
    return JSON.stringify({ appServerStderr: read(join(root, 'app-server.stderr')), runtime: existsSync(runtime) ? readdirSync(runtime) : null,
      events: existsSync(logs) ? readdirSync(logs).flatMap(name => read(join(logs, name)).trim().split('\n').map(line => JSON.parse(line).event)) : null });
  };
  const profile = () => Object.fromEntries(readdirSync(join(home, '.codex')).map(name => [name, readFileSync(join(home, '.codex', name), 'utf8')]));
  return { root, home, state, app, run, stop, profile, diagnose, opened: () => read(join(root, 'open.json'), true) ?? false,
    close: async () => { await stop(); rmSync(root, { recursive: true, force: true }); } };
}

test('primary launch opens the unchanged app once with the Bridge, without copying or changing the normal profile', async () => {
  const w = world();
  try {
    const before = w.profile();
    const started = w.run();
    assert.equal(started.bridge, true, `${JSON.stringify(started)} ${w.diagnose()}`);
    assert.equal(started.mode, 'primary');
    const wrapper = join(w.state, 'primary/codex-bridge');
    assert.deepEqual(w.opened(), { args: ['-a', w.app, '--env', `CODEX_CLI_PATH=${wrapper}`], inherited: [] },
      'only this launch gets the wrapper; inherited Codex/Bridge settings are not passed on');
    const script = readFileSync(wrapper, 'utf8');
    assert.equal(statSync(wrapper).mode & 0o777, 0o700);
    assert.match(script, /export BRIDGE_COORDINATOR=1/);
    assert.match(script, /unset BRIDGE_SOURCE_CODEX_HOME BRIDGE_MIRROR/);
    assert.doesNotMatch(script, /export CODEX_HOME|user-data-dir|auth/);
    assert.deepEqual(w.profile(), before, 'the normal Codex profile is unchanged');
    assert.deepEqual(readdirSync(w.state).sort(), ['primary'], 'no isolated profile, desktop data or snapshot is created');
    assert.ok(existsSync(join(w.state, 'primary/logs')), 'Bridge-owned logs stay under the primary state');
    const status = w.run('status');
    assert.deepEqual([status.running, status.bridge, status.pid], [true, true, started.pid]);
    const again = w.run();
    assert.match(again.error, /already running/, 'a running app is never reopened or restarted');
    await w.stop();
    const after = w.run('status');
    assert.deepEqual([after.running, after.bridge], [false, false]);
  } finally { await w.close(); }
});

test('primary launch refuses an unknown app state, another app, an unsigned app or a missing CLI, and opens nothing', async () => {
  for (const [options, mode, expected] of [[{}, 'unknown', /could not be checked/], [{ bundleId: 'com.example.other' }, 'start', /not the Codex desktop app/],
    [{ signed: false }, 'start', /code-signature/], [{ cli: null }, 'start', /bundled Codex CLI/]]) {
    const w = world(options);
    try {
      assert.match(w.run(mode).error, expected);
      assert.equal(w.opened(), false);
      assert.equal(existsSync(join(w.state, 'primary/codex-bridge')), false);
    } finally { await w.close(); }
  }
});

test('primary launch refuses while any copy of the app runs, then succeeds once it has exited', async () => {
  const w = world({ cli: 'flat' });
  // `; true` keeps the shell itself (named like the app) from exec-ing sleep.
  const running = spawn(join(w.app, 'Contents/MacOS', executableName), ['-c', 'sleep 600; true'], { stdio: 'ignore', detached: true });
  const quit = () => { try { process.kill(-running.pid, 'SIGTERM'); } catch {} };
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.match(w.run().error, /already running/);
    assert.equal(w.opened(), false, 'nothing is opened, quit or restarted');
    const exited = new Promise(resolve => running.once('exit', resolve)); quit(); await exited;
    const started = w.run();
    assert.equal(started.bridge, true, `${JSON.stringify(started)} ${w.diagnose()}`);
    // The wrapper names the selected CLI, shell-quoted only when its path needs it.
    const flat = join(w.app, 'Contents/Resources/codex'), script = readFileSync(join(w.state, 'primary/codex-bridge'), 'utf8');
    assert.ok([`BRIDGE_REAL_CODEX=${flat}\n`, `BRIDGE_REAL_CODEX='${flat}'\n`].some(line => script.includes(line)), 'the flat signed CLI layout is used');
    assert.doesNotMatch(script, /codex-cli\/CodexCLI\.app/);
  } finally { quit(); await w.close(); }
});

// Separates product from fixture: the real wrapper and Bridge under a Node
// parent holding stdio pipes, as the Codex desktop does, with no launcher or app.
test('the primary wrapper keeps this checkout’s Bridge up while its desktop pipe is open, publishes this state’s record, and stops when it closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-primary-lifecycle-'));
  const state = join(root, 'state'), cli = join(root, 'codex'), wrapper = join(root, 'codex-bridge'), runtime = join(state, 'primary/runtime');
  writeFileSync(cli, fakeCli); chmodSync(cli, 0o755); mkdirSync(join(root, 'home'));
  python(`state = pathlib.Path(sys.argv[2])
pathlib.Path(sys.argv[3]).write_text(m.wrapper_script(sys.argv[4], pathlib.Path(sys.argv[5]), state / 'primary', None, '/nonexistent/unit-test-must-not-start-claude', primary=True, isolated=state))
print('{}')`, [state, wrapper, process.execPath, cli]);
  chmodSync(wrapper, 0o700);
  const child = spawn(wrapper, ['app-server', '--analytics-default-enabled'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: join(root, 'home') } });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const records = () => existsSync(runtime) ? readdirSync(runtime).filter(name => name.startsWith(`${child.pid}-`)) : [];
  const events = () => existsSync(join(state, 'primary/logs')) ? readdirSync(join(state, 'primary/logs'))
    .flatMap(name => readFileSync(join(state, 'primary/logs', name), 'utf8').trim().split('\n').map(line => JSON.parse(line).event)) : [];
  try {
    for (let i = 0; i < 100 && !records().length && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, `the Bridge stopped while its desktop pipe was open: ${JSON.stringify({ exit: child.exitCode, signal: child.signalCode, stderr, events: events() })}`);
    assert.equal(records().length, 1, 'the Bridge published its record in this state');
    child.stdin.end();
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))]);
    assert.notEqual(result, 'timeout', 'closing the desktop pipe stops the Bridge');
    assert.deepEqual(records(), [], 'and it removes its record');
    assert.ok(events().includes('process.stopping'));
  } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('the primary wrapper refuses the separate test profile instead of serving it', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-primary-wrapper-'));
  try {
    const state = join(root, 'state'), wrapper = join(root, 'codex-bridge');
    python(`state = pathlib.Path(sys.argv[2])
pathlib.Path(sys.argv[3]).write_text(m.wrapper_script(sys.executable, pathlib.Path('/bin/false'), state / 'primary', None, '/nonexistent/claude', primary=True, isolated=state))
print('{}')`, [state, wrapper]);
    chmodSync(wrapper, 0o700);
    for (const env of [{ CODEX_HOME: join(state, 'codex') }, { CODEX_HOME: join(state, 'codex/nested') }, { CODEX_ELECTRON_USER_DATA_PATH: join(state, 'desktop') }]) {
      const result = spawnSync(wrapper, ['app-server'], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, ...env } });
      assert.equal(result.status, 78, JSON.stringify(env));
      assert.match(result.stderr, /separate test profile/);
    }
    assert.equal(existsSync(join(state, 'primary/logs')), false, 'no Bridge started');
    const isolated = python(`print(json.dumps(m.wrapper_script('/node', pathlib.Path('/codex'), pathlib.Path('/s/threads'), pathlib.Path('/src'), '/claude')))`, []);
    assert.match(isolated, /unset BRIDGE_COORDINATOR/); assert.doesNotMatch(isolated, /separate test profile|BRIDGE_COORDINATOR=1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('primary activation counts only this checkout’s current Bridge, under the one primary app, with this state’s fresh record', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-primary-binding-'));
  try {
    const state = join(root, 'state'), other = join(root, 'other');
    // Records as logging.mjs publishes them (start in ms); fields can be overridden.
    const record = (dir, pid, fields = {}) => {
      mkdirSync(join(dir, 'primary/runtime'), { recursive: true });
      const runId = randomUUID();
      writeFileSync(join(dir, 'primary/runtime', `${pid}-${runId}.json`), JSON.stringify({ pid, runId, startedAt: 2_000_000_000_000,
        updatedAt: new Date().toISOString(), stopping: false, nice: 0, activeThreads: [], startingThreads: [], pendingStarts: 0, ...fields }));
    };
    record(state, 200); record(state, 300); record(other, 400); record(state, 500, { startedAt: 1_000_000_000_000 });
    record(state, 800);
    record(state, 810, { startedAt: 1_000_000_000_000, updatedAt: '2001-09-09T01:46:40+00:00' });
    record(state, 811, { updatedAt: '2001-09-09T01:46:40+00:00' }); record(state, 820, { stopping: true }); record(state, 830);
    writeFileSync(join(state, 'primary/runtime', `600-${randomUUID()}.json`), '{broken');
    // Each live PID's actual start (seconds) as `ps` reports it; null is unknown.
    const starts = { 200: 2_000_000_000, 300: 2_000_000_000, 400: 2_000_000_000, 500: 1_000_000_000, 600: 2_000_000_000, 700: 2_000_000_000,
      800: 2_000_000_600, 810: 2_000_000_000, 811: 2_000_000_000, 820: 2_000_000_000, 830: null };
    const app = '/Applications/Codex.app/Contents/MacOS/Codex';
    const node = '/Applications/Codex.app/Contents/Resources/cua_node/bin/node';
    const observe = (table, since = null) => python(`table = {int(k): tuple(v) for k, v in json.loads(sys.argv[2]).items()}
starts = json.loads(sys.argv[6])
with patch.object(m, 'process_table', return_value=table), patch.object(m, 'process_start', side_effect=lambda pid: starts.get(str(pid))):
    print(json.dumps(m.primary_bridge(pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]) / 'primary', since=json.loads(sys.argv[5]))))`,
    [JSON.stringify(table), app, state, JSON.stringify(since), JSON.stringify(starts)]);
    const base = { 100: [1, app], 101: [100, `${app.replace('MacOS/Codex', 'Frameworks/Codex Helper')} --type=renderer`] };
    const ours = [100, `${node} ${bridgeProgram} app-server`];
    assert.deepEqual(observe({ ...base, 200: ours }), [100, true], 'the current Bridge with a fresh record');
    assert.deepEqual(observe({ ...base, 200: ours }, 1_999_999_990), [100, true], 'started after this launch');
    assert.deepEqual(observe({ ...base, 500: ours }, 1_999_999_990), [100, false], 'a Bridge from before this launch does not count');
    assert.deepEqual(observe({ ...base, 800: ours }), [100, false], 'a reused PID: the record’s start is not this process’s');
    assert.deepEqual(observe({ ...base, 810: ours }), [100, false], 'a stale record from 2001 for a current process with that PID');
    assert.deepEqual(observe({ ...base, 811: ours }), [100, null], 'this process’s own record, but its lease expired: unknown');
    assert.deepEqual(observe({ ...base, 820: ours }), [100, null], 'a stopping Bridge: unknown');
    assert.deepEqual(observe({ ...base, 830: ours }), [100, null], 'its process start cannot be read: unknown');
    assert.deepEqual(observe({ ...base, 600: ours }), [100, null], 'an unreadable record: unknown');
    assert.deepEqual(observe({ ...base, 830: ours, 200: ours }), [100, true], 'one confirmed current Bridge suffices');
    assert.deepEqual(observe({ ...base, 300: [100, `${node} /elsewhere/bridge.mjs app-server`] }), [100, false], 'another program named bridge.mjs');
    assert.deepEqual(observe({ ...base, 200: [1, `${node} ${bridgeProgram} app-server`] }), [100, false], 'not under the primary app');
    assert.deepEqual(observe({ ...base, 400: ours }), [100, false], 'its record is in another state');
    assert.deepEqual(observe({ ...base, 700: ours }), [100, false], 'no record at all');
    assert.deepEqual(observe({ 100: [1, `${app} --user-data-dir=/x`], 200: ours }), [null, false], 'the separate test window is not the primary app');
    assert.deepEqual(observe({ 100: [1, app], 102: [1, app], 200: ours }), [null, false], 'two primary processes are ambiguous');
    assert.deepEqual(observe({ ...base }), [100, false], 'the app runs without a Bridge: not observed, not unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the replacement guard requires that no Bridge from the installed payload runs, and refuses unknown state', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-primary-stopped-'));
  try {
    const state = join(root, 'state'), payload = join(root, 'installed/node_modules/codex-claude-bridge-local');
    const program = join(payload, 'bridge.mjs'), runtime = join(state, 'primary/runtime');
    const stopped = (table, { fail = false } = {}) => python(`table = {int(k): tuple(v) for k, v in json.loads(sys.argv[2]).items()}
try:
    with patch.object(m, 'process_table', **({'side_effect': OSError('ps unavailable')} if sys.argv[5] == 'fail' else {'return_value': table})):
        print(json.dumps(m.primary_stopped(pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]))))
except RuntimeError as error:
    print(json.dumps({'error': str(error)}))`, [JSON.stringify(table), state, payload, fail ? 'fail' : 'ok']);
    const shell = [1, '-zsh'];
    assert.deepEqual(stopped({ 1: shell }), { stopped: true, state: join(state, 'primary') }, 'missing runtime evidence and no process: stopped');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, `4321-${randomUUID()}.json`), '{}');
    writeFileSync(join(runtime, `4322-${randomUUID()}.json`), '{}');
    assert.equal(stopped({ 1: shell, 4322: [1, '/usr/bin/vim notes.txt'] }).stopped, true, 'stale records of a dead or reused PID');
    for (const [table, reason] of [[{ 1: shell, 50: [1, `/A/node ${program} app-server`] }, 'the main-app Bridge from this payload'],
      [{ 1: shell, 51: [1, `/A/node ${program} app-server --user-data-dir=x`] }, 'the separate window’s Bridge from this payload'],
      [{ 1: shell, 4321: [1, '/other/node /older/copy/bridge.mjs app-server'] }, 'any live Bridge with a record in this primary state']])
      assert.match(stopped(table).error, /still running.*Nothing was replaced/, reason);
    assert.match(stopped({}, { fail: true }).error, /could not be checked, so nothing was replaced/, 'unknown process state');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
