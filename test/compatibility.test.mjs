import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Copy-free compatibility checks (RC13), as fixture proof only. The real smoke.mjs,
// launch.py, wrapper, bridge.mjs, pinned Agent SDK, CLI and installer run against a
// synthetic app, a synthetic Codex app-server and a synthetic Claude Code. No real
// Codex, Claude, model, account, owner data or Mac is used: a pass here shows the
// Bridge's own protocol path with synthetic peers, not provider or desktop behavior.
const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repo, 'cli.mjs'), smoke = pathToFileURL(join(repo, 'smoke.mjs')).href;
const fingerprint = message => createHash('sha256').update(message).digest('hex').slice(0, 16);
const allChecks = ['initialize', 'both_model_catalogs', 'native_thread', 'claude_thread', 'claude_to_native_settings',
  'native_to_claude_settings', 'queue_contract', 'synthetic_profile', 'no_auth_copy'];
const catalogFailure = { errorCategory: 'other', errorFingerprint: fingerprint('Unsupported protocol shape: both_model_catalogs') };
const outcome = report => ({ errorCategory: report.errorCategory, errorCode: report.errorCode, errorFingerprint: report.errorFingerprint });

const put = (path, text, mode = 0o600) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); chmodSync(path, mode); };
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

// Relative path, mode, size, mtime and content hash of every entry under root.
function tree(root) {
  const entries = [];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      entries.push({ path: relative(root, path), mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs,
        sha256: stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null });
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root); return entries;
}

// Test-only Python audit (loaded as sitecustomize through PYTHONPATH): records, without
// content, each audited open, listing, copy or process start of a Python process that
// names the synthetic owner profile, and whether that process's arguments name it.
// Independent of any folder layout, so it exposes copying even if the launcher then fails.
const auditHook = `import json, os, sys

_root, _log = os.environ.get('FAKE_OWNER_ROOT'), os.environ.get('FAKE_ACCESS_LOG')
_events = {'open', 'os.listdir', 'os.scandir', 'os.walk', 'shutil.copyfile', 'shutil.copytree', 'shutil.copymode',
           'shutil.copystat', 'subprocess.Popen', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.chmod', 'os.rename',
           'os.remove', 'os.mkdir', 'os.symlink'}


def _paths(value):
    if isinstance(value, (str, bytes, os.PathLike)):
        try:
            yield os.fsdecode(os.fspath(value))
        except TypeError:
            pass
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _paths(item)


def _inside(path):
    return path == _root or path.startswith(_root + os.sep)


def _write(record):
    with open(_log, 'a') as f:
        f.write(json.dumps(record) + '\\n')


if _root and _log:
    _root = os.path.realpath(_root)
    # The full command line, available to sitecustomize (Python 3.10+).
    _argv = list(getattr(sys, 'orig_argv', None) or getattr(sys, 'argv', None) or [])
    _mode = next((flag for flag in ('--stdio', '--check', '--prepare', '--primary') if flag in _argv), 'other')
    _write({'event': 'start', 'mode': _mode, 'ownerInArgv': any(_inside(p) for p in _paths(_argv))})

    def _hook(event, args):
        if event in _events:
            hits = sorted({p for p in _paths(args) if _inside(p)})
            if hits:
                _write({'event': event, 'mode': _mode, 'paths': hits})

    sys.addaudithook(_hook)
`;

// Synthetic Codex CLI. As app-server it records its arguments, environment, the files
// of its CODEX_HOME and of its source profile (and whether any holds the owner
// sentinel), then answers the public requests the check uses. FAKE_NATIVE_MODE:
// fail-initialize, hang or no-gpt. It runs no model.
const nativeCli = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.0.0-synthetic'); process.exit(0); }
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(entry => entry.isDirectory() ? [entry.name + '/', ...walk(path.join(dir, entry.name)).map(name => entry.name + '/' + name)] : [entry.name]);
const list = dir => { try { return walk(dir); } catch (error) { return error.code ?? 'unreadable'; } };
const home = process.env.CODEX_HOME, files = home ? list(home) : null;
const sentinel = Array.isArray(files) && files.some(name => !name.endsWith('/') && fs.readFileSync(path.join(home, name), 'utf8').includes(process.env.FAKE_OWNER_SENTINEL));
fs.appendFileSync(process.env.FAKE_NATIVE_LOG, JSON.stringify({ args, env: process.env, files, sentinel,
  sourceFiles: process.env.BRIDGE_SOURCE_CODEX_HOME ? list(process.env.BRIDGE_SOURCE_CODEX_HOME) : null }) + '\\n');
const mode = process.env.FAKE_NATIVE_MODE ?? '';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const gpt = { id: 'gpt-synthetic', model: 'gpt-synthetic', displayName: 'GPT synthetic', hidden: false, isDefault: true,
  defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }] };
const threads = new Map();
const view = id => { const { thread, settings } = threads.get(id); return { thread, model: settings.model, modelProvider: settings.modelProvider,
  reasoningEffort: settings.effort, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', instructionSources: [], disabledPluginIds: [] }; };
const handlers = {
  initialize: () => ({ userAgent: 'synthetic-native' }),
  'model/list': () => ({ data: mode === 'no-gpt' ? [] : [gpt], nextCursor: null }),
  'config/read': () => ({ config: { model: gpt.model, model_provider: 'openai' } }),
  'thread/start': p => { const id = randomUUID();
    threads.set(id, { thread: { id, cwd: p.cwd, ephemeral: !!p.ephemeral, status: { type: 'idle' }, turns: [] },
      settings: { model: p.model ?? gpt.model, modelProvider: p.modelProvider ?? 'openai', effort: 'low' } });
    return view(id); },
  'thread/resume': p => { const entry = threads.get(p.threadId);
    if (p.model) entry.settings.model = p.model; if (p.modelProvider) entry.settings.modelProvider = p.modelProvider; return view(p.threadId); },
  'thread/unsubscribe': p => { setImmediate(() => send({ method: 'thread/closed', params: { threadId: p.threadId } })); return { status: 'unsubscribed' }; },
  'thread/settings/update': p => { const entry = threads.get(p.threadId); Object.assign(entry.settings, p);
    setImmediate(() => send({ method: 'thread/settings/updated', params: { threadId: p.threadId,
      threadSettings: { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', ...entry.settings } } }));
    return {}; },
  'thread/queue/list': () => ({ data: [], nextCursor: null }),
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method || mode === 'hang') return;
  if (message.method === 'initialize' && mode === 'fail-initialize')
    return send({ id: message.id, error: { code: -32603, message: 'Synthetic native initialize rejected' } });
  const handler = handlers[message.method];
  if (!handler) return send({ id: message.id, error: { code: -32601, message: 'Synthetic native: unsupported ' + message.method } });
  try { send({ id: message.id, result: handler(message.params ?? {}) }); }
  catch { send({ id: message.id, error: { code: -32603, message: 'Synthetic native: invalid request' } }); }
});
`;

// Synthetic Claude Code: \`--version\` and \`auth status\` for preflight and the installer;
// otherwise the Agent SDK's stream-json control protocol, answering the SDK's initialize
// control request with a synthetic model list (FAKE_CLAUDE_MODE: models, no-models or
// corrupt) and any other control request with an empty success. It logs only message
// types and flag names. No model runs and no account data exists.
const fakeClaude = `#!${process.execPath}
const fs = require('node:fs'), readline = require('node:readline');
const args = process.argv.slice(2), mode = process.env.FAKE_CLAUDE_MODE ?? 'models';
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0); }
const log = record => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(record) + '\\n'); };
log({ event: 'start', mode, flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]) });
const models = { models: [{ value: 'default', displayName: 'Default', description: 'Synthetic default' },
  { value: 'sonnet', displayName: 'Sonnet (synthetic)', description: 'Synthetic fixture model', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
  'no-models': [], corrupt: 'not-a-model-list' }[mode];
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { log({ event: 'invalid' }); return; }
  log({ event: 'received', type: message.type, subtype: message.request?.subtype });
  if (message.type !== 'control_request') return;
  const response = message.request?.subtype === 'initialize'
    ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models, account: {} } : {};
  send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
});
`;

// Test-only shasum (Linux hosts may lack it): SHA-256 with Node's crypto, in shasum's
// output format. Any other use is refused. The installer's comparison is unchanged.
const shasum = `#!${process.execPath}
const { createHash } = require('node:crypto'), { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '-a' || args[1] !== '256') { console.error('synthetic shasum supports only -a 256 FILE'); process.exit(2); }
process.stdout.write(createHash('sha256').update(readFileSync(args[2])).digest('hex') + '  ' + args[2] + '\\n');
`;

function world({ nativeCli: withCli = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-copy-free-')));
  const home = join(root, 'home'), owner = join(home, '.codex'), bin = join(root, 'bin'), temp = join(root, 'tmp'), hooks = join(root, 'python');
  const app = join(home, 'Applications/Codex.app'), ran = join(root, 'owner-plugin-ran'), preload = join(root, 'darwin.mjs');
  const logs = { native: join(root, 'native.jsonl'), access: join(root, 'access.jsonl'), claude: join(root, 'claude.jsonl') };
  const sentinel = `OWNER_SENTINEL_${randomUUID()}`;
  // A protected synthetic owner profile: configuration, instructions, model cache,
  // auth, a skill and an executable plugin that would leave a marker if run.
  put(join(owner, 'config.toml'), `model = "gpt-owner"\n# ${sentinel}\n`);
  put(join(owner, 'AGENTS.md'), `${sentinel} owner instructions\n`, 0o644);
  put(join(owner, 'models_cache.json'), JSON.stringify({ sentinel, models: [{ slug: 'gpt-owner-cached' }] }));
  put(join(owner, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: sentinel }));
  put(join(owner, 'skills/owner/SKILL.md'), `---\nname: owner\ndescription: ${sentinel}\n---\n`, 0o644);
  put(join(owner, 'plugins/cache/owner/plugin/run.sh'), `#!/bin/sh\necho ${sentinel} > '${ran}'\n`, 0o755);
  put(join(owner, 'plugins/cache/owner/plugin/plugin.json'), JSON.stringify({ name: 'owner', sentinel }), 0o644);
  // A synthetic app: not com.openai.codex, so the main-app launcher refuses it before opening anything.
  put(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.synthetic-compatibility</string>
<key>CFBundleExecutable</key><string>Codex</string><key>CFBundleShortVersionString</key><string>0.0.0</string></dict></plist>
`, 0o644);
  put(join(app, 'Contents/MacOS/Codex'), '#!/bin/sh\nexit 64\n', 0o755);
  mkdirSync(join(app, 'Contents/Resources/cua_node/bin'), { recursive: true });
  symlinkSync(process.execPath, join(app, 'Contents/Resources/cua_node/bin/node'));
  if (withCli) put(join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'), nativeCli, 0o755);
  put(join(bin, 'claude'), fakeClaude, 0o755);
  put(join(bin, 'shasum'), shasum, 0o755);
  symlinkSync(process.execPath, join(bin, 'node'));
  put(join(hooks, 'sitecustomize.py'), auditHook, 0o644);
  // Test-only: lets the macOS-only CLI gate run in this synthetic world.
  put(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n", 0o644);
  mkdirSync(temp, { mode: 0o700 });
  return { root, home, owner, app, bin, temp, ran, preload, sentinel,
    env: (extra = {}) => ({ PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: temp, PYTHONPATH: hooks,
      FAKE_OWNER_ROOT: owner, FAKE_OWNER_SENTINEL: sentinel, FAKE_NATIVE_LOG: logs.native, FAKE_ACCESS_LOG: logs.access,
      FAKE_CLAUDE_LOG: logs.claude, ...extra }),
    runs: () => lines(logs.native), audit: () => lines(logs.access), claude: () => lines(logs.claude),
    tree: () => tree(owner),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

// The real compatibilityCheck in its own Node process, with the owner profile as
// config.source (as the CLI passes it) and this world's environment.
function check(w, { python = 'python3', timeout = 30000, env = {} } = {}) {
  const code = `import { compatibilityCheck } from ${JSON.stringify(smoke)};
const before = JSON.stringify(process.env);
const [config, python, timeout] = JSON.parse(process.argv[1]);
const report = await compatibilityCheck(config, python, { bridgeVersion: 'synthetic' }, { timeout });
process.stdout.write(JSON.stringify({ report, envUnchanged: JSON.stringify(process.env) === before }));`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([{ source: w.owner, app: w.app }, python, timeout])],
    { encoding: 'utf8', env: w.env(env), timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), elapsed: Date.now() - started };
}

// 1. Layout-independent: every audited compatibility launcher (launch.py --stdio)
// started, and none was given the owner profile or opened, listed, copied or ran
// anything in it.
function launcherNeverUsedOwner(w, context = '') {
  const records = w.audit(), launchers = records.filter(record => record.mode === '--stdio');
  assert.ok(launchers.some(record => record.event === 'start'), `the audited compatibility launcher ran: ${context} ${JSON.stringify(records)}`);
  assert.deepEqual(launchers.filter(record => record.event !== 'start' || record.ownerInArgv), [],
    'the compatibility launcher was given, opened, listed, copied or ran the owner profile');
}

// The only owner-profile access on these paths is preflight's in-place read of
// config.toml (provider-key presence), once per preflight; nothing else.
function onlyPreflightReads(w, count) {
  const access = w.audit().filter(record => record.event !== 'start');
  assert.deepEqual(access, Array.from({ length: count }, () => ({ event: 'open', mode: '--check', paths: [join(w.owner, 'config.toml')] })),
    'owner-profile access other than the preflight read');
}

// 2. What the app-server was given: no owner content or owner-derived files in its
// profile, no argument or environment value naming the owner profile, and an empty
// synthetic source profile.
function profileFree(w, run) {
  assert.equal(run.sentinel, false, 'owner content reached the profile');
  assert.deepEqual(run.files.filter(name => name !== 'config.toml'), [],
    'owner configuration, instructions, model cache, auth, skills or plugins in the profile');
  const named = [...run.args, ...Object.entries(run.env).filter(([key]) => !key.startsWith('FAKE_')).map(([, value]) => value)]
    .filter(value => value.includes(w.owner));
  assert.deepEqual(named, [], 'an argument or environment value names the owner profile');
  assert.deepEqual(run.sourceFiles, [], 'the profile source is not an empty synthetic directory');
}

// 3. Location only: the profile was inside the check's own temporary directory, now removed.
function cleaned(w, run) {
  const profile = run.env.CODEX_HOME, top = relative(w.temp, profile).split(sep)[0];
  assert.ok(profile.startsWith(w.temp + sep) && top.startsWith('codex-claude-check-'), `the profile is in the check's own temporary directory: ${profile}`);
  assert.equal(existsSync(join(w.temp, top)), false, 'the check removed its own temporary directory');
}

// Fixture outcome. If the copy-free assertions passed but this fails, inspect the
// synthetic Claude Code's content-free log: the fixture's SDK handshake, not copying.
function passedSynthetically(w, report) {
  assert.deepEqual([report.passed, report.checks], [true, allChecks], `fixture outcome: ${JSON.stringify({ report, claude: w.claude() })}`);
  assert.deepEqual([report.scope, report.ownerProfileVerified, report.guiVerified, report.modelCalls], ['synthetic-profile/1', false, false, 0]);
}

test('copy-free: a readable owner profile is never read, copied or named by the compatibility check', () => {
  const w = world();
  try {
    const before = w.tree();
    const { report, envUnchanged } = check(w);
    launcherNeverUsedOwner(w, JSON.stringify(report));
    onlyPreflightReads(w, 0);
    const runs = w.runs();
    assert.equal(runs.length, 1, `one app-server start: ${JSON.stringify(report)}`);
    profileFree(w, runs[0]);
    assert.deepEqual(w.tree(), before, 'owner profile bytes, modes and files changed');
    assert.equal(existsSync(w.ran), false, 'an owner plugin ran');
    assert.equal(envUnchanged, true, 'the caller environment changed');
    cleaned(w, runs[0]);
    passedSynthetically(w, report);
  } finally { w.close(); }
});

test('copy-free: an unreadable owner profile is never needed by the compatibility check', () => {
  const w = world();
  try {
    const before = w.tree(), mode = lstatSync(w.owner).mode & 0o777;
    // Any access would fail while the profile is unreadable (unless tests run as root;
    // the audit and the recorded profile are checked either way).
    chmodSync(w.owner, 0o000);
    let result;
    try { result = check(w); } finally { chmodSync(w.owner, mode); }
    launcherNeverUsedOwner(w, JSON.stringify(result.report));
    onlyPreflightReads(w, 0);
    const runs = w.runs();
    assert.equal(runs.length, 1, `one app-server start: ${JSON.stringify(result.report)}`);
    profileFree(w, runs[0]);
    assert.deepEqual(w.tree(), before, 'owner profile bytes, modes and files changed');
    cleaned(w, runs[0]);
    passedSynthetically(w, result.report);
  } finally { w.close(); }
});

test('copy-free: the installer check takes the synthetic path, and its failed check stops the installation', () => {
  const w = world();
  try {
    const before = w.tree();
    const bundle = join(w.root, 'bundle'), archive = join(w.root, 'archive'), events = join(w.root, 'installer-events');
    put(join(bundle, 'install.command'), readFileSync(join(repo, 'plugins/codex-claude/install.command'), 'utf8'), 0o755);
    put(join(bundle, 'stage-runtime.sh'), readFileSync(join(repo, 'plugins/codex-claude/stage-runtime.sh'), 'utf8'), 0o755);
    // The staged package's CLI: its `check` is this checkout's real CLI; any other step is only recorded.
    put(join(archive, 'package/cli.mjs'), `#!/bin/sh
case "$1" in
  --version) echo 0.0.0-synthetic;;
  check) exec "$BRIDGE_TEST_NODE" --import "$BRIDGE_TEST_PRELOAD" "$BRIDGE_TEST_CLI" "$@";;
  *) echo "$1" >> "$BRIDGE_TEST_EVENTS";;
esac
`, 0o755);
    put(join(w.bin, 'uname'), '#!/bin/sh\necho Darwin\n', 0o755);
    put(join(w.bin, 'npm'), '#!/bin/sh\n[ "$1" = ci ]\n', 0o755);
    const tgz = join(bundle, 'codex-claude-bridge-local-0.0.0-synthetic.tgz');
    const packed = spawnSync('tar', ['-czf', tgz, '-C', archive, 'package']);
    assert.equal(packed.status, 0, packed.stderr?.toString());
    put(join(bundle, 'bundle.json'), JSON.stringify({ version: '0.0.0-synthetic', sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex') }));
    // The synthetic Claude catalog is empty, so this check fails at the catalog.
    const result = spawnSync('sh', [join(bundle, 'install.command'), '--app', w.app], { encoding: 'utf8', timeout: 180000,
      env: w.env({ FAKE_CLAUDE_MODE: 'no-models', BRIDGE_TEST_NODE: process.execPath, BRIDGE_TEST_PRELOAD: pathToFileURL(w.preload).href,
        BRIDGE_TEST_CLI: cli, BRIDGE_TEST_EVENTS: events }) });
    launcherNeverUsedOwner(w, result.stderr);
    onlyPreflightReads(w, 1);
    const runs = w.runs();
    assert.equal(runs.length, 1, `the installer reached one compatibility check: ${result.stderr}`);
    profileFree(w, runs[0]);
    assert.deepEqual(w.tree(), before, 'owner profile bytes, modes and files changed');
    assert.equal(existsSync(w.ran), false, 'an owner plugin ran');
    cleaned(w, runs[0]);
    assert.notEqual(result.status, 0, 'the failed compatibility check stops the installation');
    assert.match(result.stderr, /Compatibility check failed after 1 checks/);
    assert.equal(existsSync(events), false, 'no stop, main-app or setup step ran');
    assert.deepEqual(readdirSync(join(w.home, '.local/share')), [], 'nothing installed; the stage and lock were removed');
  } finally { w.close(); }
});

test('copy-free: the first main-app start takes the synthetic path, reuses only a same-scope pass, and opens nothing', () => {
  const w = world();
  try {
    const before = w.tree();
    const state = join(w.home, 'Library/Application Support/Codex Claude Bridge'), report = join(state, 'diagnostics/compatibility.json');
    const primary = (env = {}) => spawnSync(process.execPath, ['--import', pathToFileURL(w.preload).href, cli, 'primary', '--app', w.app],
      { encoding: 'utf8', timeout: 120000, env: w.env(env) });
    const refusedApp = /not the Codex desktop app/;
    // An unreadable earlier report is not reused. With an empty synthetic Claude catalog
    // the check fails, which stops the start before the app is considered.
    put(report, '{broken');
    let result = primary({ FAKE_CLAUDE_MODE: 'no-models' });
    launcherNeverUsedOwner(w, result.stderr);
    assert.equal(w.runs().length, 1, result.stderr);
    profileFree(w, w.runs()[0]); cleaned(w, w.runs()[0]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Compatibility check failed after 1 checks/); assert.doesNotMatch(result.stderr, refusedApp);
    const failed = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual([failed.passed, failed.scope, failed.ownerProfileVerified, failed.guiVerified], [false, 'synthetic-profile/1', false, false]);
    // A failed report is not reused either: the check runs again and passes (synthetically),
    // and the start continues to the app identity check, which refuses this synthetic app.
    result = primary();
    launcherNeverUsedOwner(w, result.stderr);
    assert.equal(w.runs().length, 2, result.stderr);
    profileFree(w, w.runs()[1]); cleaned(w, w.runs()[1]);
    const saved = JSON.parse(readFileSync(report, 'utf8'));
    passedSynthetically(w, saved);
    assert.notEqual(result.status, 0); assert.match(result.stderr, refusedApp);
    // A passing report without this scope (as earlier versions wrote it) is not reused.
    const legacy = { ...saved }; delete legacy.scope;
    put(report, JSON.stringify(legacy));
    result = primary();
    assert.equal(w.runs().length, 3, 'the earlier-scope pass was reused'); profileFree(w, w.runs()[2]); cleaned(w, w.runs()[2]);
    assert.match(result.stderr, refusedApp);
    // A pass of this scope for the same versions is reused: no new check.
    put(report, JSON.stringify(saved));
    result = primary();
    assert.equal(w.runs().length, 3, 'a same-scope pass was not reused'); assert.match(result.stderr, refusedApp);
    launcherNeverUsedOwner(w); onlyPreflightReads(w, 4);
    assert.equal(existsSync(join(state, 'primary')), false, 'the app was not opened');
    assert.deepEqual(w.tree(), before, 'owner profile bytes, modes and files changed');
    assert.equal(existsSync(w.ran), false, 'an owner plugin ran');
  } finally { w.close(); }
});

test('compatibility protocol (fixture): a missing or corrupted catalog fails at the catalog; a synthetic run completes every check', () => {
  const w = world();
  try {
    for (const [name, env] of [['an empty Claude model list', { FAKE_CLAUDE_MODE: 'no-models' }],
      ['a corrupted Claude model list', { FAKE_CLAUDE_MODE: 'corrupt' }], ['no GPT model from the app-server', { FAKE_NATIVE_MODE: 'no-gpt' }]]) {
      const { report } = check(w, { env });
      assert.deepEqual([report.passed, report.checks], [false, ['initialize']], `${name}: ${JSON.stringify(report)}`);
      assert.deepEqual(outcome(report), { errorCode: undefined, ...catalogFailure }, name);
    }
    const passed = check(w);
    assert.ok(w.claude().some(record => record.event === 'received' && record.type === 'control_request' && record.subtype === 'initialize'),
      `the pinned SDK sent its initialize control request: ${JSON.stringify(w.claude())}`);
    passedSynthetically(w, passed.report);
    launcherNeverUsedOwner(w); onlyPreflightReads(w, 0);
    assert.equal(w.runs().length, 4);
    for (const run of w.runs()) { profileFree(w, run); cleaned(w, run); }
  } finally { w.close(); }
});

test('compatibility failures: a native error, a hung app-server, a launcher refusal and a missing interpreter report honestly and leave nothing behind', () => {
  // A closed connection rejects pending requests with RpcError('RPC connection closed'),
  // whose default code is -32603 (rpc.mjs: RpcError, Peer.end).
  const closed = { errorCategory: 'connection_closed', errorCode: -32603, errorFingerprint: fingerprint('RPC connection closed') };
  for (const [name, options, expected, { native, launcher }] of [
    ['native initialize error', { env: { FAKE_NATIVE_MODE: 'fail-initialize' } },
      { errorCategory: 'other', errorCode: -32603, errorFingerprint: fingerprint('Synthetic native initialize rejected') }, { native: true, launcher: true }],
    // Long enough for the Bridge and the synthetic app-server to start on a slow host.
    ['hung app-server', { env: { FAKE_NATIVE_MODE: 'hang' }, timeout: 10000 }, closed, { native: true, launcher: true }],
    ['launcher refusal: no bundled Codex CLI', { nativeCli: false }, closed, { native: false, launcher: true }],
    ['missing interpreter', { python: '/nonexistent/synthetic-python3' }, closed, { native: false, launcher: false }],
  ]) {
    const w = world({ nativeCli: options.nativeCli !== false });
    try {
      const before = w.tree();
      const { report, envUnchanged, elapsed } = check(w, options);
      if (launcher) launcherNeverUsedOwner(w, name); else assert.deepEqual(w.audit(), [], name);
      onlyPreflightReads(w, 0);
      assert.equal(w.runs().length, native ? 1 : 0, name);
      if (native) { profileFree(w, w.runs()[0]); cleaned(w, w.runs()[0]); }
      assert.deepEqual([report.passed, report.checks], [false, []], name);
      assert.deepEqual(outcome(report), { errorCode: undefined, ...expected }, `${name}: ${JSON.stringify(report)}`);
      assert.deepEqual([report.scope, report.ownerProfileVerified, report.modelCalls], ['synthetic-profile/1', false, 0], name);
      if (name === 'hung app-server') assert.ok(elapsed >= 10000 && elapsed < 60000, `${name}: ended by the check's timeout (${elapsed} ms)`);
      // The launcher refusal is shown by the audited launcher start with no app-server
      // start. report.stderrBytes is not asserted: it is counted when the report is built,
      // and the launcher's stderr may arrive after its stdout has closed.
      assert.equal(envUnchanged, true, name);
      assert.deepEqual(readdirSync(w.temp), [], `${name}: the check left nothing in its temporary directory`);
      assert.deepEqual(w.tree(), before, name);
    } finally { w.close(); }
  }
});
