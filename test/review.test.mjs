import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTools } from '../capabilities.mjs';
import { sessionCall } from '../sessions.mjs';
import { fixture } from './support/fixture.mjs';
import { Bridge } from '../bridge.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const manage = (f, caller, args, signal) => sessionCall(f.bridge,
  { threadId: caller, turnId: 'review-test-turn', tool: 'manage', arguments: args }, signal);

test('F1 auth-free preparation never copies auth; ordinary initial login snapshots stay private and one-time', () => {
  const output = execFileSync('python3', ['-c', `
import importlib.util, pathlib, plistlib, tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('launch', ${JSON.stringify(fileURLToPath(new URL('../launch.py', import.meta.url)))})
launch=importlib.util.module_from_spec(spec); spec.loader.exec_module(launch)
with tempfile.TemporaryDirectory() as root:
    root=pathlib.Path(root).resolve(); source=root/'source'; source.mkdir()
    (source/'auth.json').write_text('SYNTHETIC_AUTH_ONLY')
    (source/'config.toml').write_text('')
    app=root/'Codex.app'; resources=app/'Contents/Resources'
    for name in ['cua_node/bin/node','codex-cli/CodexCLI.app/Contents/MacOS/codex']:
        path=resources/name; path.parent.mkdir(parents=True); path.touch()
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Codex'}))
    with patch.object(launch, 'claude_path', return_value='/synthetic/claude'):
        launch.prepare(root/'check',source,app,copy_auth=False)
        assert not (root/'check/codex/auth.json').exists()
        launch.prepare(root/'desktop',source,app)
        copied=root/'desktop/codex/auth.json'
        assert copied.read_text()=='SYNTHETIC_AUTH_ONLY'
        assert copied.stat().st_mode & 0o777 == 0o600
        copied.write_text('ISOLATED_SYNTHETIC_AUTH')
        launch.prepare(root/'desktop',source,app)
        assert copied.read_text()=='ISOLATED_SYNTHETIC_AUTH'
        assert (source/'auth.json').read_text()=='SYNTHETIC_AUTH_ONLY'
print('auth copy boundary passed')
`], { encoding: 'utf8' });
  assert.match(output, /boundary passed/);
});

test('F2 shell gates untrusted commands, cancellation and permission changes before native dispatch', async () => {
  const calls = [], prompts = [], controller = new AbortController();
  const record = { thread: { id: 'thread', cwd: '/tmp' }, options: {}, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } };
  let answer = 'decline';
  const mcp = makeTools({ record, turn: { id: 'turn' }, signal: controller.signal, item: () => {},
    native: { request: async (method, params) => { calls.push({ method, params }); return { exitCode: 0 }; } },
    desktop: { request: async (method, params) => {
      prompts.push({ method, params });
      if (answer === 'change') record.sandbox = { type: 'dangerFullAccess' };
      if (answer === 'cancel') controller.abort();
      return { action: answer === 'decline' ? 'decline' : 'accept', content: { approve: true } };
    } },
  });
  const client = new Client({ name: 'review-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.instance.connect(a), client.connect(b)]);
  const call = () => client.callTool({ name: 'shell', arguments: { command: 'printf synthetic' } });
  try {
    assert.equal((await call()).isError, true); assert.equal(calls.length, 0);
    assert.match(prompts[0].params.message, /printf synthetic/);
    answer = 'accept'; assert.equal((await call()).isError, false); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.sandboxPolicy, { type: 'readOnly' });
    answer = 'change'; assert.equal((await call()).isError, true); assert.equal(calls.length, 1);
    record.sandbox = undefined; assert.equal((await call()).isError, true); assert.equal(calls.length, 1);
    record.sandbox = { type: 'readOnly' }; answer = 'cancel';
    assert.equal((await call()).isError, true); assert.equal(calls.length, 1);
  } finally { await client.close(); await mcp.instance.close(); }
});

test('F3 session mutation approval cannot be supplied by a model and accepted retries do not ask twice', async () => {
  const f = fixture(); let answer = 'decline', prompts = 0;
  try {
    const caller = await f.start(), target = await f.start();
    for (const id of [caller, target]) f.bridge.records.get(id).approvalPolicy = 'on-request';
    f.bridge.desktop.request = async (method, params) => {
      assert.equal(method, 'mcpServer/elicitation/request');
      assert.match(params.message, /APPROVED_MESSAGE/); assert.match(params.message, new RegExp(target));
      prompts++; return { action: answer, content: { approve: true } };
    };
    const args = { operation: 'send', threadId: target, requestId: randomUUID(), text: 'APPROVED_MESSAGE' };
    await assert.rejects(manage(f, caller, { ...args, approved: true }), /Invalid/);
    await assert.rejects(manage(f, caller, args), /declined/); assert.equal(f.queries.length, 0);
    answer = 'accept'; const accepted = await manage(f, caller, args); await f.done(accepted.turn.id);
    // The fixture's native policy resolver is bypassed here to retain the
    // approval policy under test, as a real native settings response would.
    for (const id of [caller, target]) f.bridge.records.get(id).approvalPolicy = 'on-request';
    assert.equal((await manage(f, caller, args)).turn.id, accepted.turn.id);
    assert.equal(prompts, 2); assert.equal(f.queries.length, 1);
  } finally { f.close(); }
});

test('F2 an unanswered desktop approval cancels without dispatch; noninteractive policy remains usable', async () => {
  let executed = 0, prompts = 0; const asked = deferred(), controller = new AbortController();
  const record = { thread: { id: 'thread', cwd: '/tmp' }, options: {}, approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
  const mcp = makeTools({ record, turn: { id: 'turn' }, signal: controller.signal, item: () => {},
    native: { request: async () => { executed++; return { exitCode: 0 }; } },
    desktop: { request: (_method, _params, _timeout, signal) => {
      prompts++; asked.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  });
  const client = new Client({ name: 'approval-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([mcp.instance.connect(a), client.connect(b)]);
  const call = () => client.callTool({ name: 'shell', arguments: { command: 'printf synthetic' } });
  try {
    for (const policy of ['never', 'on-request']) { record.approvalPolicy = policy; assert.equal((await call()).isError, false); }
    assert.equal(executed, 2); assert.equal(prompts, 0);
    for (const policy of [undefined, 'unknown', { reject: {} }]) { record.approvalPolicy = policy; assert.equal((await call()).isError, true); }
    assert.equal(executed, 2); assert.equal(prompts, 0);
    record.approvalPolicy = 'on-failure';
    const pending = call(); await asked.promise; controller.abort();
    assert.equal((await pending).isError, true); assert.equal(executed, 2); assert.equal(prompts, 1);
  } finally { await client.close(); await mcp.instance.close(); }
});

test('F3 session approval is cancelled or rejected if permissions change while pending', async () => {
  const f = fixture();
  try {
    const caller = await f.start(), target = await f.start();
    const controller = new AbortController();
    for (const id of [caller, target]) f.bridge.records.get(id).approvalPolicy = 'on-request';
    f.bridge.desktop.request = async () => { controller.abort(); return { action: 'accept', content: { approve: true } }; };
    const args = { operation: 'fork', threadId: target, requestId: randomUUID() };
    await assert.rejects(manage(f, caller, args, controller.signal), /abort/i);
    assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 0);
    f.bridge.desktop.request = async () => {
      for (const id of [caller, target]) f.bridge.records.get(id).sandbox = { type: 'dangerFullAccess' };
      return { action: 'accept', content: { approve: true } };
    };
    await assert.rejects(manage(f, caller, args), /permissions|changed/i);
    assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 0);
  } finally { f.close(); }
});

test('F4 streaming session identifiers do not rewrite retained history for every text fragment', async () => {
  const f = fixture();
  try {
    const id = await f.start(); let writes = 0;
    const save = f.bridge.save.bind(f.bridge); f.bridge.save = r => { writes++; save(r); };
    f.bridge.runQuery = () => {
      const stream = (async function* () {
        const session_id = randomUUID();
        yield { type: 'system', session_id };
        yield { type: 'stream_event', session_id, event: { type: 'message_start', message: { id: 'streamed' } } };
        yield { type: 'stream_event', session_id, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } };
        for (let i = 0; i < 500; i++) yield { type: 'stream_event', session_id, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } };
        yield { type: 'stream_event', session_id, event: { type: 'content_block_stop', index: 0 } };
        yield { type: 'result', subtype: 'success', session_id };
      })(); stream.close = () => {}; return stream;
    };
    const sent = await f.send(id); await f.done(sent.turn.id);
    const saved = JSON.parse(readFileSync(join(f.statePath, `${id}.json`), 'utf8'));
    assert.equal(saved.turns[0].items.find(i => i.type === 'agentMessage').text, 'x'.repeat(500));
    assert.ok(writes < 20, `${writes} history writes for 500 text fragments`);
  } finally { f.close(); }
});

test('F5 native canonical input metadata does not break a retry, including after restart', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    f.controls.nativeUserInput = input => input.map(p => ({ ...p, text_elements: [] }));
    const args = { model: 'gpt-test', clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'RETRY' }] };
    const sent = await f.bridge.request('turn/start', { threadId: id, ...args }); await f.done(sent.turn.id);
    const view = await f.bridge.request('thread/read', { threadId: id, includeTurns: true });
    assert.deepEqual(view.thread.turns[0].items[0].content[0].text_elements, []);
    f.restart();
    assert.equal((await f.bridge.request('turn/start', { threadId: id, ...args })).turn.id, sent.turn.id);
    await assert.rejects(f.bridge.request('turn/start', { threadId: id, ...args, input: [{ type: 'text', text: 'DIFFERENT' }] }), /different/);
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(Object.hasOwn(view.thread.turns[0], 'submittedInput'), false);
  } finally { f.close(); }
});

test('F6 invalid fork boundaries do not create uncertain receipts', async () => {
  const f = fixture();
  try {
    const caller = await f.start(), target = await f.start();
    const args = { operation: 'fork', threadId: target, requestId: randomUUID() };
    await assert.rejects(manage(f, caller, { ...args, beforeTurnId: 'not-a-turn' }), /boundary/);
    assert.equal(f.bridge.records.get(target).sessionForks?.[args.requestId], undefined);
    const child = await manage(f, caller, args); assert.notEqual(child.threadId, target);
    assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
  } finally { f.close(); }
});

test('F7 a concurrent edit during session loading cannot restore the old transcript', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const caller = await f.start(), target = await f.start();
    const first = await f.send(target, 'RETAIN'); await f.done(first.turn.id);
    const second = await f.send(target, 'REMOVE'); await f.done(second.turn.id);
    f.bridge.loaded.delete(target);
    f.controls.native = async (method, params) => {
      if (method === 'thread/resume' && params.threadId === target) { entered.resolve(); await release.promise; }
    };
    const pending = manage(f, caller, { operation: 'fork', threadId: target, requestId: randomUUID() });
    await entered.promise;
    await f.bridge.request('thread/revert', { threadId: target, beforeTurnId: second.turn.id });
    release.resolve(); const child = await pending;
    assert.equal(child.turnCount, 1);
    assert.equal(JSON.parse(readFileSync(join(f.statePath, `${target}.json`), 'utf8')).turns.length, 1);
    f.restart(); assert.equal(f.bridge.records.get(target).turns.length, 1);
  } finally { release.resolve(); f.close(); }
});

test('N1 killing the process during a dispatched tool preserves uncertainty without replaying the action or queue', async () => {
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { fixture } from ${JSON.stringify(new URL('./support/fixture.mjs', import.meta.url).href)};
    import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
    import { InMemoryTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/inMemory.js'))};
    import { writeFileSync, writeSync } from 'node:fs';
    import { join } from 'node:path';
    const f = fixture(), id = await f.start();
    writeSync(1, JSON.stringify({ statePath: f.statePath, id }));
    f.controls.native = async method => {
      if (method === 'command/exec') {
        writeFileSync(join(f.statePath, 'synthetic-dispatch'), 'once');
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      }
    };
    f.controls.query = async ({ mcp }) => {
      const client = new Client({ name: 'crash-test', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.instance.connect(a), client.connect(b)]);
      await client.callTool({ name: 'shell', arguments: { command: 'synthetic action' } });
    };
    await f.send(id);
    await f.bridge.request('thread/queue/add', { threadId: id,
      clientUserMessageId: 'queued-after-crash', input: [{ type: 'text', text: 'must stay queued' }] });
  `], { encoding: 'utf8', timeout: 10000 });
  const { statePath, id } = JSON.parse(killed.stdout);
  try {
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(readFileSync(join(statePath, 'synthetic-dispatch'), 'utf8'), 'once');
    const dispatches = [];
    const restored = new Bridge({ statePath,
      native: { request: async method => { dispatches.push(method); throw new Error('Recovery must not dispatch'); } },
      desktop: { notify() {} }, runQuery: () => { throw new Error('Recovery must not resume'); } });
    const saved = JSON.parse(readFileSync(join(statePath, `${id}.json`), 'utf8'));
    assert.equal(saved.turns[0].status, 'interrupted');
    const tool = saved.turns[0].items.find(i => i.type === 'mcpToolCall');
    assert.ok(tool, 'dispatched tool must survive a process crash');
    assert.equal(tool.status, 'failed');
    assert.match(tool.error.message, /may already have run/);
    assert.equal(saved.queue.length, 1);
    assert.equal(restored.active.size, 0); assert.deepEqual(dispatches, []);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});
