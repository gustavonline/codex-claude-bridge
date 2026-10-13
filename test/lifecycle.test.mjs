import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTools, toolName } from '../capabilities.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const id = '99999999-9999-4999-8999-999999999999';
const input = [{ type: 'text', text: 'Synthetic lifecycle test' }];
function fixture() {
  const statePath = mkdtempSync(join(tmpdir(), 'bridge-lifecycle-'));
  const calls = [], queries = [], events = [], waiters = [];
  const metadata = { id, cwd: statePath, name: 'Original', projectId: 'old', preview: 'native preview', updatedAt: 1 };
  const settings = { model: 'opus', effort: 'high', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', disabledPluginIds: [] };
  let bridge;
  const controls = {};
  const native = { request: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (controls.native) await controls.native(method, params);
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { ...metadata }, sandbox: settings.sandboxPolicy,
      approvalPolicy: settings.approvalPolicy, disabledPluginIds: settings.disabledPluginIds };
    if (method === 'thread/settings/update') {
      Object.assign(settings, params);
      bridge.nativeNotification('thread/settings/updated', { threadId: id, threadSettings: { ...settings } });
      return {};
    }
    if (method === 'thread/list') return { data: [{ ...metadata, turns: [{ id: 'native-only' }] }] };
    if (method === 'thread/metadata/update') {
      if ('projectId' in params) metadata.projectId = params.projectId || null;
      return { thread: { ...metadata, turns: [{ id: 'native-only' }] } };
    }
    if (method === 'thread/unarchive') return { thread: { ...metadata, turns: [{ id: 'native-only' }] } };
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') return { data: [] };
    return {};
  } };
  const build = () => new Bridge({ statePath, native, desktop: { notify: (method, params) => {
    const event = { method, params: structuredClone(params) }; events.push(event);
    for (const w of [...waiters]) if (w.test(event)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(event); }
  } }, history: { checkpoint: async () => null },
  getModels: async () => [{ value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
    { value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'haiku' }],
  runQuery: args => {
    queries.push({ model: args.record.model, effort: args.record.effort, input: args.input });
    const stream = controls.query ? controls.query(args) : (async function* () { yield { type: 'result', subtype: 'success' }; })();
    stream.close ??= () => {}; return stream;
  } });
  bridge = build();
  const f = { get bridge() { return bridge; }, controls, calls, queries, metadata, settings, events,
    start: () => bridge.request('thread/start', { model: 'opus' }),
    send: params => bridge.request('turn/start', { threadId: id, input, ...params }),
    wait(test) {
      const old = events.find(test); if (old) return Promise.resolve(old);
      return new Promise((resolve, reject) => {
        const w = { test, resolve, timer: setTimeout(() => reject(new Error('Expected lifecycle event was not emitted')), 2000) };
        waiters.push(w);
      });
    },
    done: turnId => f.wait(e => e.method === 'turn/completed' && e.params.turn.id === turnId),
    restart: () => { bridge = build(); },
    close: () => { for (const w of waiters) clearTimeout(w.timer); rmSync(statePath, { recursive: true, force: true }); },
  };
  return f;
}

test('same client message is accepted once across concurrent delivery, completion and backend restart', async () => {
  const f = fixture();
  try {
    await f.start();
    const args = { clientUserMessageId: 'stable-delivery' };
    const [a, b] = await Promise.all([f.send(args), f.send(args)]);
    assert.equal(a.turn.id, b.turn.id); await f.done(a.turn.id);
    assert.equal((await f.send(args)).turn.id, a.turn.id);
    f.restart();
    assert.equal((await f.send(args)).turn.status, 'completed');
    assert.equal(f.queries.length, 1);
    assert.equal(f.calls.filter(c => c.method === 'thread/inject_items').length, 1);
    await assert.rejects(f.send({ ...args, input: [{ type: 'text', text: 'different action' }] }), /different message/);
    const deliberate = await f.send({ clientUserMessageId: 'new-delivery' }); await f.done(deliberate.turn.id);
    assert.equal(f.queries.length, 2);
  } finally { f.close(); }
});

test('settings-only model change waits for native confirmation and survives resume without turn overrides', async () => {
  const f = fixture(), entered = deferred(), apply = deferred();
  try {
    await f.start();
    f.controls.native = async method => { if (method === 'thread/settings/update') { entered.resolve(); await apply.promise; } };
    const change = f.bridge.request('thread/settings/update', { threadId: id, model: 'sonnet', effort: 'low' });
    await entered.promise;
    assert.equal(f.bridge.records.get(id).model, 'opus');
    await assert.rejects(f.send(), /chat change/);
    apply.resolve(); await change;
    const notified = f.events.filter(e => e.method === 'thread/settings/updated').at(-1).params.threadSettings;
    assert.equal(notified.model, 'sonnet'); assert.equal(notified.effort, 'low');
    f.restart(); await f.bridge.request('thread/resume', { threadId: id });
    const next = await f.send(); await f.done(next.turn.id);
    assert.deepEqual(f.queries[0], { model: 'sonnet', effort: 'low', input });
  } finally { apply.resolve(); f.close(); }
});

test('unadvertised models, incompatible effort and failed native settings do not change Claude state', async () => {
  const f = fixture();
  try {
    await f.start(); const count = f.calls.length;
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test' }), /does not advertise/);
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, effort: 'ultra' }), /Unsupported effort/);
    assert.deepEqual(f.calls.slice(count).map(c => c.method), ['model/list']);
    f.controls.native = async method => { if (method === 'thread/settings/update') throw new Error('native rejected settings'); };
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, model: 'sonnet' }), /native rejected/);
    assert.equal(f.bridge.records.get(id).model, 'opus'); assert.equal(f.bridge.changing.size, 0);
  } finally { f.close(); }
});

test('workspace changes and alternate histories fail before native resume or settings can mutate the tool host', async () => {
  const f = fixture();
  try {
    await f.start(); const count = f.calls.length;
    for (const method of ['thread/resume', 'thread/settings/update', 'turn/start'])
      await assert.rejects(f.bridge.request(method, { threadId: id, cwd: '/other-workspace', input }), /change workspace/);
    for (const override of [{ history: [] }, { path: '/other-rollout' }])
      await assert.rejects(f.bridge.request('thread/resume', { threadId: id, ...override }), /alternative history/);
    assert.equal(f.calls.length, count);
    const alias = join(f.metadata.cwd, 'workspace-alias'); symlinkSync(f.metadata.cwd, alias);
    await f.bridge.request('thread/resume', { threadId: id, cwd: alias });
  } finally { f.close(); }
});

test('resolved approval changes persist through resume, and unsupported review routing is explicit', async () => {
  const f = fixture();
  try {
    await f.start();
    await f.bridge.request('thread/settings/update', { threadId: id, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    f.restart(); await f.bridge.request('thread/resume', { threadId: id });
    const resume = f.calls.findLast(c => c.method === 'thread/resume');
    assert.equal(resume.params.approvalPolicy, 'on-request'); assert.equal(resume.params.approvalsReviewer, 'user');
    assert.equal(f.bridge.records.get(id).approvalPolicy, 'on-request');
    for (const method of ['thread/settings/update', 'thread/resume', 'turn/start'])
      await assert.rejects(f.bridge.request(method, { threadId: id, approvalsReviewer: 'auto_review', input }), /only be reviewed by the user/);
  } finally { f.close(); }
});

test('model selected during resume normalizes inherited effort and is saved for later turns', async () => {
  const f = fixture();
  try {
    await f.start();
    await f.bridge.request('thread/settings/update', { threadId: id, effort: 'max' });
    const resumed = await f.bridge.request('thread/resume', { threadId: id, model: 'haiku' });
    assert.equal(resumed.model, 'haiku'); assert.equal(resumed.reasoningEffort, 'none');
    f.restart(); const sent = await f.send(); await f.done(sent.turn.id);
    assert.equal(f.queries[0].model, 'haiku'); assert.equal(f.queries[0].effort, 'none');
  } finally { f.close(); }
});

test('a backend restart marks an unfinished tool uncertain instead of leaving a running card', async () => {
  const f = fixture();
  try {
    await f.start(); const record = f.bridge.records.get(id);
    record.turns.push({ id: 'crashed', status: 'inProgress', items: [
      { id: 'partial', type: 'agentMessage', text: 'Partial answer' },
      { id: 'pending-tool', type: 'mcpToolCall', status: 'inProgress' },
    ] });
    f.bridge.save(record); f.restart();
    assert.equal(JSON.parse(readFileSync(join(f.bridge.statePath, `${id}.json`))).turns[0].status, 'interrupted');
    const read = await f.bridge.request('thread/read', { threadId: id, includeTurns: true });
    const turn = read.thread.turns[0];
    assert.equal(turn.status, 'interrupted'); assert.equal(turn.items[0].text, 'Partial answer');
    assert.equal(turn.items[1].status, 'failed'); assert.match(turn.items[1].error.message, /may already have run/);
    assert.equal(f.queries.length, 0);
  } finally { f.close(); }
});

test('native metadata updates and unarchive responses retain Claude history instead of native seed turns', async () => {
  const f = fixture();
  try {
    await f.start(); const sent = await f.send(); await f.done(sent.turn.id);
    f.metadata.projectId = 'moved'; f.metadata.name = null;
    const list = await f.bridge.request('thread/list', {});
    assert.equal(list.data[0].projectId, 'moved'); assert.equal(list.data[0].name, null); assert.deepEqual(list.data[0].turns, []);
    const updated = await f.bridge.request('thread/metadata/update', { threadId: id, projectId: '' });
    assert.equal(updated.thread.projectId, null); assert.deepEqual(updated.thread.turns, []);
    await f.bridge.request('thread/archive', { threadId: id });
    const restored = await f.bridge.request('thread/unarchive', { threadId: id });
    assert.deepEqual(restored.thread.turns, []);
    f.restart();
    const read = await f.bridge.request('thread/read', { threadId: id, includeTurns: true });
    assert.equal(read.thread.turns[0].id, sent.turn.id); assert.equal(read.thread.projectId, null);
  } finally { f.close(); }
});

test('early interrupt is explicit; interrupt after acceptance closes partial text once and permits a follow-up', async () => {
  const f = fixture(), selecting = deferred(), release = deferred();
  try {
    await f.start();
    const original = f.bridge.selectModel.bind(f.bridge);
    f.bridge.selectModel = async value => { selecting.resolve(); await release.promise; return original(value); };
    const start = f.send(); await selecting.promise;
    await assert.rejects(f.bridge.request('turn/interrupt', { threadId: id, turnId: 'not-allocated' }), /still starting/);
    f.controls.query = ({ controller }) => (async function* () {
      yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'partial' } } };
      yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial text' } } };
      if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    })();
    release.resolve(); const { turn } = await start;
    await f.wait(e => e.method === 'item/agentMessage/delta');
    await f.bridge.request('turn/interrupt', { threadId: id, turnId: turn.id });
    assert.equal((await f.done(turn.id)).params.turn.status, 'interrupted');
    assert.equal(f.events.filter(e => e.method === 'item/completed' && e.params.item.id === 'partial-0').length, 1);
    assert.equal(f.events.filter(e => e.method === 'turn/completed' && e.params.turn.id === turn.id).length, 1);
    delete f.controls.query;
    const next = await f.send(); assert.equal((await f.done(next.turn.id)).params.turn.status, 'completed');
  } finally { release.resolve(); f.close(); }
});

test('archive/settings transitions cannot race a new turn or history edit', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    await f.start(); const sent = await f.send(); await f.done(sent.turn.id);
    f.controls.native = async method => { if (method === 'thread/archive') { entered.resolve(); await release.promise; } };
    const archive = f.bridge.request('thread/archive', { threadId: id }); await entered.promise;
    await assert.rejects(f.send(), /chat change/);
    await assert.rejects(f.bridge.request('thread/revert', { threadId: id, beforeTurnId: sent.turn.id }), /chat change/);
    release.resolve(); await archive;
    assert.equal(f.bridge.changing.size, 0); assert.equal(f.bridge.loaded.has(id), false);
  } finally { release.resolve(); f.close(); }
});

test('stopping a pending MCP request releases its local waiter and closes the tool item without retrying the action', async () => {
  const controller = new AbortController(), dispatched = deferred(), events = [];
  let invocations = 0;
  const spec = { name: 'read', description: 'Read synthetic document', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
  const native = { request: async (method, _params, _timeout, signal) => {
    if (method === 'config/read') return { config: {} };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'docs', tools: { read: spec } }] };
    assert.equal(method, 'mcpServer/tool/call'); invocations++; dispatched.resolve();
    assert.equal(signal, controller.signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  const mcp = makeTools({ native, desktop: {}, record: { thread: { id, cwd: '/tmp' }, options: {}, loadedTools: [toolName('docs', 'read')] },
    turn: { id: 'turn' }, signal: controller.signal, item: (phase, value) => events.push({ phase, value: structuredClone(value) }) });
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'test', version: '1' });
  await Promise.all([mcp.instance.connect(left), client.connect(right)]);
  try {
    const pending = client.callTool({ name: 'call_tool', arguments: { name: toolName('docs', 'read'), arguments: {} } });
    await dispatched.promise; controller.abort(); const result = await pending;
    assert.equal(result.isError, true); assert.equal(invocations, 1);
    assert.deepEqual(events.map(e => e.phase), ['started', 'completed']);
    assert.equal(events.at(-1).value.status, 'failed');
  } finally { controller.abort(); await client.close(); await mcp.instance.close(); }
});
