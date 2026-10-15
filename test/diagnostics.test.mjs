import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, symlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPriority, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger, logContext, errorMetadata } from '../logging.mjs';
import { diagnose, readLogs, saveReport, threadId, summarizeCalls } from '../diagnose.mjs';
import { configuration, settingsPath, shortcut } from '../cli.mjs';
import { options } from '../claude.mjs';
import { Peer } from '../rpc.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'bridge-diagnostic-'));
const root = fileURLToPath(new URL('../', import.meta.url));
const secret = 'PRIVATE-prompt-token-email@example.test';

test('steering logs correlate expected turn IDs and expose receipt counts without input content', async () => {
  const state = temp(), log = createLogger(join(state, 'logs')), id = randomUUID(), turn = randomUUID();
  const a = new PassThrough(), b = new PassThrough();
  const client = new Peer(a, b, { name: 'desktop', log });
  const server = new Peer(b, a, { request: async () => ({ turnId: turn }) });
  try {
    await client.request('turn/steer', { threadId: id, expectedTurnId: turn, input: [{ type: 'text', text: secret }] });
    log('steer.delivered', { threadId: id, turnId: turn, input: secret });
    mkdirSync(join(state, 'threads'));
    writeFileSync(join(state, 'threads', `${id}.json`), JSON.stringify({ thread: { id }, neutralNativeSeed: true,
      turns: [{ id: turn, status: 'completed', steering: [{ input: secret, status: 'delivered' }, { input: secret, status: 'uncertain' }] }] }));
    const report = diagnose(state, { thread: id, isAlive: () => false });
    assert.deepEqual(report.threads[0].steering, { accepted: 0, delivered: 1, uncertain: 1 });
    assert.equal(readLogs(state).entries.find(e => e.method === 'turn/steer').turnId, turn);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(errorMetadata({ code: -32601, message: 'interrupt' }).errorCategory, 'unsupported_method');
  } finally { client.end(); server.end(); rmSync(state, { recursive: true, force: true }); }
});

test('session coordination logs are discoverable from both caller and destination without message payloads', () => {
  const state = temp(), log = createLogger(join(state, 'logs')), caller = randomUUID(), target = randomUUID();
  try {
    log('session.operation_finished', { sourceThreadId: caller, threadId: target, method: 'session/send', status: 'completed', text: secret });
    for (const thread of [caller, target]) {
      const entries = readLogs(state, { thread }).entries;
      assert.equal(entries.length, 1); assert.equal(entries[0].sourceThreadId, caller);
      assert.equal(JSON.stringify(entries).includes(secret), false);
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('slow RPC and lifecycle events share a trace without retaining messages or account data', async () => {
  const state = temp(), log = createLogger(join(state, 'logs'));
  const a = new PassThrough(), b = new PassThrough();
  const thread = randomUUID();
  const client = new Peer(a, b, { name: 'native', log, slowMs: 5 });
  const server = new Peer(b, a, { name: 'desktop', log, slowMs: 5, request: async () => {
    await new Promise(r => setTimeout(r, 20));
    log('model.changed', { model: 'sonnet', prompt: secret });
    return { message: secret };
  } });
  try {
    await client.request('thread/settings/update', { threadId: thread, message: secret });
    const { entries } = readLogs(state);
    const change = entries.find(e => e.event === 'model.changed');
    assert.equal(change.threadId, thread);
    assert.ok(entries.some(e => e.event === 'rpc.slow' && e.traceId === change.traceId));
    assert.ok(entries.every(e => e.runId === log.runId));
    assert.equal(JSON.stringify(entries).includes(secret), false);
    assert.equal(summarizeCalls(entries, []).length, 0);
  } finally { client.end(); server.end(); a.destroy(); b.destroy(); rmSync(state, { recursive: true, force: true }); }
});

test('diagnosis filters a chat and connected traces, tolerates truncated logs and strips on-disk payloads', () => {
  const state = temp(), log = createLogger(join(state, 'logs')), id = randomUUID(), other = randomUUID(), trace = randomUUID();
  try {
    log('process.started');
    logContext.run({ traceId: trace }, () => {
      log('rpc.start', { peer: 'native', direction: 'outbound', rpcId: 'bridge-1', method: 'thread/start' });
      log('rpc.finish', { peer: 'native', direction: 'outbound', rpcId: 'bridge-1', method: 'thread/start', threadId: id, status: 'completed' });
      log('rpc.start', { peer: 'native', direction: 'outbound', rpcId: 'bridge-2', method: 'mcpServer/tool/call', threadId: id });
    });
    log('turn.error', { threadId: other, ...errorMetadata(new Error(secret)) });
    const injected = { time: new Date().toISOString(), pid: process.pid, event: 'turn.error', threadId: id, message: secret, arguments: { token: secret }, ...errorMetadata(new Error('timeout ' + secret)) };
    appendFileSync(log.path, JSON.stringify(injected) + '\n{"partial":');
    mkdirSync(join(state, 'threads'));
    writeFileSync(join(state, 'threads', `${id}.json`), JSON.stringify({ thread: { id, name: secret, cwd: secret }, model: 'haiku',
      turns: [{ id: randomUUID(), status: 'failed', items: [{ text: secret }], error: { message: secret } }], queue: [{ input: secret }], options: { apiKey: secret } }));
    const report = diagnose(state, { thread: id, isAlive: () => true });
    assert.equal(report.scope, id); assert.equal(report.threads.length, 1); assert.equal(report.threads[0].queueLength, 1);
    assert.equal(report.coverage.invalidLines, 1); assert.equal(report.pendingCalls.length, 1);
    assert.equal(report.pendingCalls[0].status, 'in_flight');
    assert.equal(JSON.stringify(report).includes(secret), false); assert.equal(JSON.stringify(report).includes(other), false);
    assert.ok(report.recentEvents.some(e => e.rpcId === 'bridge-1' && e.event === 'rpc.start'));
    const path = join(state, 'report.json'); saveReport(path, report);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    appendFileSync(log.path, '\n'); log('process.stopping');
    assert.equal(diagnose(state, { thread: id, isAlive: () => true }).pendingCalls[0].status, 'process_ended_or_log_incomplete');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('bounded diagnostics ignore log symlinks and classify provider failures without exporting raw errors', () => {
  const state = temp();
  try {
    mkdirSync(join(state, 'logs'));
    writeFileSync(join(state, 'secret'), secret);
    symlinkSync(join(state, 'secret'), join(state, 'logs/bridge-1.jsonl'));
    writeFileSync(join(state, 'logs/bridge-2.jsonl'), 'x'.repeat(1024));
    const result = readLogs(state, { maxBytes: 100 });
    assert.equal(result.coverage.skippedFiles, 2); assert.equal(result.entries.length, 0);
    assert.equal(errorMetadata(new Error('Missing environment variable ' + secret)).errorCategory, 'provider_environment');
    assert.equal(errorMetadata(new Error('previous_response_id not found ' + secret)).errorCategory, 'response_cache');
    assert.equal(threadId('codex://threads/01234567-1234-5678-1234-123456789abc'), '01234567-1234-5678-1234-123456789abc');
    assert.throws(() => threadId('../../auth.json'));
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('runtime metadata covers turn preparation and native turns without prompt content', () => {
  const state = temp(), id = randomUUID(), turn = randomUUID();
  const log = createLogger(join(state, 'logs'), { runtimeDirectory: join(state, 'runtime') });
  const path = join(state, 'runtime', `${process.pid}-${log.runId}.json`);
  const read = () => JSON.parse(readFileSync(path));
  try {
    log('process.started');
    assert.equal(read().pid, process.pid); assert.equal(read().runId, log.runId);
    assert.ok(Math.abs(read().startedAt - (Date.now() - process.uptime() * 1000)) < 2000);
    assert.equal(read().nice, getPriority());
    log('rpc.start', { peer: 'desktop', direction: 'inbound', method: 'turn/start', rpcId: 42, threadId: id, input: secret });
    assert.equal(read().pendingStarts, 1);
    log('turn.started', { threadId: id, turnId: turn, provider: 'native' });
    log('rpc.finish', { peer: 'desktop', direction: 'inbound', method: 'turn/start', rpcId: 42, threadId: id });
    assert.equal(read().pendingStarts, 0); assert.deepEqual(read().activeThreads, [id]);
    log('turn.finished', { threadId: id, turnId: turn, status: 'completed' });
    assert.deepEqual(read().activeThreads, []); assert.equal(readFileSync(path, 'utf8').includes(secret), false);
    log('turn.preparing', { threadId: id }); // Auto-next queue preparation has no inbound desktop RPC.
    assert.equal(read().pendingStarts, 1);
    log('turn.prepared', { threadId: id, status: 'failed' });
    assert.equal(read().pendingStarts, 0);
  } finally { log.close(); rmSync(state, { recursive: true, force: true }); }
});

test('CLI keeps a stable user profile, adopts old snapshots and refuses corrupt settings', () => {
  const home = temp();
  try {
    const first = configuration({}, home);
    assert.ok(first.state.startsWith(home)); assert.ok(!first.state.includes('node_modules'));
    const legacy = join(home, 'earlier prototype'); mkdirSync(legacy);
    writeFileSync(join(legacy, 'snapshot.json'), JSON.stringify({ source: '/original-profile' }));
    assert.equal(configuration({ state: legacy }, home).source, '/original-profile');
    const path = settingsPath(home); mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ state: legacy, source: '/original-profile', app: '/App with spaces.app' }));
    assert.equal(configuration({}, home).state, legacy);
    const launcher = shortcut(first, home);
    const result = spawnSync('/bin/sh', ['-n', launcher], { encoding: 'utf8', timeout: 3000 });
    // Only syntax-check the generated launcher; invoking it would launch the real app.
    // (No execution below: the shell test is performed via -n.)
    assert.equal(result.status, 0);
    assert.ok(readFileSync(launcher, 'utf8').includes('# Managed by codex-claude-bridge'));
    writeFileSync(path, '{broken'); assert.throws(() => configuration({}, home), /could not be read/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('subscription runtime excludes API/proxy overrides and retains the official local login location', () => {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR'];
  const old = new Map(names.map(k => [k, process.env[k]]));
  try {
    for (const k of names) process.env[k] = secret;
    const env = options().env;
    for (const k of names.slice(0, -1)) assert.equal(env[k], undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, secret);
  } finally { for (const [k, v] of old) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('launcher retains declared provider credentials and header variables only in its child environment', () => {
  execFileSync('python3', ['-c', `
import importlib.util,sys,tempfile,pathlib,plistlib,json,os,uuid
spec=importlib.util.spec_from_file_location('launch',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 r=pathlib.Path(d);s=r/'source';s.mkdir();a=r/'App.app';state=r/'state'
 for name in ['cua_node/bin/node','codex-cli/CodexCLI.app/Contents/MacOS/codex']:
  p=a/'Contents/Resources'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('fixture')
 with (a/'Contents/Info.plist').open('wb') as f:plistlib.dump({'CFBundleExecutable':'Codex'},f)
 m.claude_path=lambda:'/fixture/claude'
 provider='gateway-'+uuid.uuid4().hex
 (s/'config.toml').write_text('model_provider="'+provider+'"\\n[model_providers.'+provider+']\\nenv_key="CODEX_FIXTURE_API_KEY"\\nenv_http_headers={"X-Workspace"="CODEX_FIXTURE_WORKSPACE"}\\n')
 os.environ.update(CODEX_FIXTURE_API_KEY='PRIVATE_KEY',CODEX_FIXTURE_WORKSPACE='PRIVATE_HEADER',CODEX_FIXTURE_UNRELATED='PRIVATE_CONTEXT')
 env,_,wrapper=m.prepare(state,s,a)
 assert env.get('CODEX_FIXTURE_API_KEY')=='PRIVATE_KEY'
 assert env.get('CODEX_FIXTURE_WORKSPACE')=='PRIVATE_HEADER', 'declared header variable was dropped'
 assert 'CODEX_FIXTURE_UNRELATED' not in env
 assert os.environ['CODEX_FIXTURE_UNRELATED']=='PRIVATE_CONTEXT'
 assert all('PRIVATE_' not in p.read_text() for p in [wrapper,state/'codex/config.toml',state/'snapshot.json'])
 (s/'config.toml').write_text('model_provider="openai"\\n')
 env,_,_=m.prepare(r/'standard-state',s,a)
 assert 'CODEX_FIXTURE_API_KEY' not in env and 'CODEX_FIXTURE_WORKSPACE' not in env
`, join(root, 'launch.py')], { stdio: 'pipe' });
});

test('preflight verifies official auth without returning account fields and rejects nested/source drift', () => {
  execFileSync('python3', ['-c', `
import importlib.util,sys,tempfile,pathlib,plistlib,json,os
spec=importlib.util.spec_from_file_location('launch',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 r=pathlib.Path(d);s=r/'source';s.mkdir();a=r/'App.app';state=r/'state'
 for name in ['cua_node/bin/node','codex-cli/CodexCLI.app/Contents/MacOS/codex']:
  p=a/'Contents/Resources'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('#!/bin/sh\\necho 1.2.3\\n');p.chmod(0o700)
 with (a/'Contents/Info.plist').open('wb') as f:plistlib.dump({'CFBundleExecutable':'Codex','CFBundleShortVersionString':'1.2.3'},f)
 cli=r/'claude';m.claude_path=lambda:str(cli)
 def auth(logged,method='claude.ai'):
  payload=json.dumps({'loggedIn':logged,'authMethod':method,'apiProvider':'firstParty','email':'PRIVATE','token':'PRIVATE'})
  cli.write_text("#!/bin/sh\\nif [ \\"$1\\" = --version ]; then echo 2.1.2; else echo '"+payload+"'; fi\\n");cli.chmod(0o700)
 auth(True);out=m.preflight(state,s,a);assert out['claudeAuthenticated'];assert 'PRIVATE' not in json.dumps(out)
 (s/'config.toml').write_text('model_provider="test"\\n[model_providers.test]\\nenv_key="BRIDGE_TEST_ABSENT_PROVIDER_KEY"\\n')
 os.environ.pop('BRIDGE_TEST_ABSENT_PROVIDER_KEY',None)
 try:m.preflight(state,s,a);raise AssertionError('accepted missing GPT key')
 except RuntimeError as e:assert 'GPT provider environment key' in str(e)
 (s/'config.toml').unlink()
 auth(False)
 try:m.preflight(state,s,a);raise AssertionError('accepted unauthenticated')
 except RuntimeError as e:assert 'auth login' in str(e)
 auth(True,'apiKey')
 try:m.preflight(state,s,a);raise AssertionError('accepted API key')
 except RuntimeError as e:assert 'subscription' in str(e)
 try:m.validate_paths(s/'nested',s);raise AssertionError('accepted nested')
 except RuntimeError:pass
`, join(root, 'launch.py')]);
});

test('stop identifies profile paths containing spaces and refuses busy preparation before any turn is saved', async () => {
  const original = temp(), path = original + ' with spaces'; mkdirSync(path); const state = realpathSync(path);
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', 'bridge.mjs', `--user-data-dir=${join(state, 'desktop')}`], { stdio: 'ignore' });
  const done = new Promise(resolve => child.on('exit', resolve));
  const runId = randomUUID(), record = join(state, 'runtime', `${child.pid}-${runId}.json`);
  const runtime = work => writeFileSync(record, JSON.stringify({ pid: child.pid, runId, startedAt, updatedAt: new Date().toISOString(), nice: getPriority(child.pid), ...work }));
  try {
    writeFileSync(join(state, 'desktop.pid'), String(child.pid)); mkdirSync(join(state, 'runtime'));
    runtime({ activeThreads: [], startingThreads: [randomUUID()], pendingStarts: 1 });
    const args = [join(root, 'launch.py'), '--state', state];
    const status = JSON.parse(execFileSync('python3', [...args, '--status'], { encoding: 'utf8' }));
    assert.equal(status.running, true); assert.equal(status.activeThreads.length, 1);
    const refused = spawnSync('python3', [...args, '--stop'], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /chat is active/); assert.doesNotThrow(() => process.kill(child.pid, 0));
    runtime({ activeThreads: [], startingThreads: [], pendingStarts: 0 });
    const stopped = JSON.parse(execFileSync('python3', [...args, '--stop'], { encoding: 'utf8' }));
    assert.equal(stopped.running, false); await done;
    assert.equal(JSON.parse(execFileSync('python3', [...args, '--stop'], { encoding: 'utf8' })).running, false);
  } finally { child.kill(); await done; rmSync(state, { recursive: true, force: true }); rmSync(original, { recursive: true, force: true }); }
});
