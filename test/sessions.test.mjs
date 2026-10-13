import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixture } from './support/fixture.mjs';
import { sessionCall, sessionNamespace } from '../sessions.mjs';
import { search, discover, makeTools } from '../capabilities.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const read = (f, caller, args, signal) => sessionCall(f.bridge, { threadId: caller, tool: 'read', arguments: args }, signal);
const manage = (f, caller, args, signal) => sessionCall(f.bridge, { threadId: caller, tool: 'manage', arguments: args }, signal);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('session reads expose canonical mixed history, bound output, omit reasoning and preserve workspace/profile isolation', async () => {
  const f = fixture();
  try {
    const caller = await f.start(), target = await f.start();
    await f.start('haiku', { cwd: join(f.statePath, 'other-workspace') });
    await f.start('haiku', { ephemeral: true });
    const a = await f.send(target, 'First Claude input'); await f.done(a.turn.id);
    const b = await f.send(target, 'Second GPT input', { model: 'gpt-test' }); await f.done(b.turn.id);
    f.bridge.records.get(target).turns[0].items.push({ type: 'reasoning', text: 'HIDDEN_REASONING' },
      { type: 'mcpToolCall', result: { text: 'HIDDEN_BY_DEFAULT' } });
    const list = await read(f, caller, { operation: 'list' }); assert.equal(list.data.length, 2);
    const view = await read(f, caller, { operation: 'read', threadId: target });
    assert.equal(view.turnCount, 2); assert.match(JSON.stringify(view), /CLAUDE RESULT/); assert.match(JSON.stringify(view), /NATIVE RESULT/);
    assert.doesNotMatch(JSON.stringify(view), /HIDDEN_/);
    const output = await read(f, caller, { operation: 'read', threadId: target, includeOutputs: true });
    assert.match(JSON.stringify(output), /HIDDEN_BY_DEFAULT/); assert.doesNotMatch(JSON.stringify(output), /HIDDEN_REASONING/);
    f.bridge.records.get(target).turns[1].items[1].text = 'x'.repeat(40000);
    const bounded = await read(f, caller, { operation: 'read', threadId: target, maxCharacters: 256, limit: 1 });
    assert.ok(bounded.truncated); assert.ok(bounded.turns[0].items.reduce((n, i) => n + i.text.length, 0) <= 256);
    const next = await read(f, caller, { operation: 'read', threadId: target, cursor: bounded.nextCursor, limit: 1 });
    assert.equal(next.turns[0].id, a.turn.id);
    await assert.rejects(read(f, caller, { operation: 'read', threadId: randomUUID() }), /not available/);
    await assert.rejects(read(f, caller, { operation: 'list', limit: 999 }), /bound/);
    await assert.rejects(read(f, caller, { operation: 'read', threadId: target, includeOutputs: 'true' }), /type/);
  } finally { f.close(); }
});

test('authorized send, busy queue, retry and fork use existing histories and survive restart without duplicate execution', async () => {
  const f = fixture(), hold = deferred();
  try {
    const caller = await f.start(), target = await f.start();
    const request = { operation: 'send', threadId: target, requestId: randomUUID(), text: 'ONLY ONCE' };
    f.controls.query = () => hold.promise;
    const accepted = await manage(f, caller, request);
    const replay = await manage(f, caller, request); assert.equal(replay.turn.id, accepted.turn.id);
    const queue = { operation: 'send', threadId: target, requestId: randomUUID(), text: 'QUEUED ONCE' };
    const q = await manage(f, caller, queue);
    assert.equal((await manage(f, caller, queue)).queuedSubmission.id, q.queuedSubmission.id);
    await assert.rejects(manage(f, caller, { ...queue, text: 'changed' }), /different/);
    hold.resolve(); await f.done(accepted.turn.id);
    await f.wait(e => e.method === 'turn/completed' && e.params.turn.id !== accepted.turn.id);
    assert.equal(f.queries.length, 2);
    const forkArgs = { operation: 'fork', threadId: target, requestId: randomUUID(), lastTurnId: accepted.turn.id };
    const fork = await manage(f, caller, forkArgs);
    assert.equal(fork.turnCount, 1); assert.notEqual(fork.threadId, target);
    f.restart();
    assert.equal((await manage(f, caller, request)).turn.id, accepted.turn.id);
    assert.equal((await manage(f, caller, forkArgs)).threadId, fork.threadId);
    assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
    assert.deepEqual(f.bridge.records.get(fork.threadId).sessionForks, {});
  } finally { hold.resolve(); f.close(); }
});

test('session waits wake on completion, report timeout, reject self-wait and release listeners on caller cancellation', async () => {
  const f = fixture(), hold = deferred();
  try {
    const caller = await f.start(), target = await f.start(); f.controls.query = () => hold.promise;
    const turn = await f.send(target);
    const timed = await read(f, caller, { operation: 'wait', threadId: target, timeoutMs: 1 }); assert.ok(timed.timedOut);
    const controller = new AbortController();
    const stopped = read(f, caller, { operation: 'wait', threadId: target }, controller.signal);
    assert.equal(f.bridge.sessionEvents.listenerCount('change'), 1); controller.abort();
    await assert.rejects(stopped, /abort/i); assert.equal(f.bridge.sessionEvents.listenerCount('change'), 0);
    await assert.rejects(read(f, caller, { operation: 'wait', threadId: caller }), /itself/);
    const pending = read(f, caller, { operation: 'wait', threadId: target });
    hold.resolve(); const finished = await pending;
    assert.equal(finished.timedOut, false); assert.equal(finished.status, 'completed');
    assert.equal(finished.turnId, turn.turn.id); assert.equal(f.bridge.sessionEvents.listenerCount('change'), 0);
  } finally { hold.resolve(); f.close(); }
});

test('session management refuses wider permissions, unknown schemas, archived chats and cancelled requests', async () => {
  const f = fixture();
  try {
    const caller = await f.start(), target = await f.start();
    const args = { operation: 'send', threadId: target, requestId: randomUUID(), text: 'test' };
    const record = f.bridge.records.get(target);
    record.sandbox = { type: 'dangerFullAccess' };
    await assert.rejects(manage(f, caller, args), /permissions differ/);
    record.sandbox = { type: 'readOnly' }; record.disabledPluginIds = ['disabled-plugin'];
    await assert.rejects(manage(f, caller, args), /permissions differ/);
    record.disabledPluginIds = []; record.options.config = { 'apps._default.default_tools_approval_mode': 'approve' };
    await assert.rejects(manage(f, caller, args), /permissions differ/);
    record.options.config = {}; record.archived = true;
    await assert.rejects(manage(f, caller, args), /Unarchive/);
    record.archived = false;
    await assert.rejects(manage(f, caller, { ...args, permissions: ':danger-full-access' }), /Invalid/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(manage(f, caller, args, controller.signal), /abort/i);
    assert.equal(f.queries.length, 0);
  } finally { f.close(); }
});

test('an uncertain fork receipt blocks retry after restart rather than allocating a second host', async () => {
  const f = fixture();
  try {
    const caller = await f.start(), target = await f.start();
    f.controls.native = async method => { if (method === 'thread/fork') throw new Error('RPC disconnected after dispatch'); };
    const args = { operation: 'fork', threadId: target, requestId: randomUUID() };
    await assert.rejects(manage(f, caller, args), /disconnected/);
    f.restart(); f.controls.native = null;
    await assert.rejects(manage(f, caller, args), /uncertain/);
    assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1);
  } finally { f.close(); }
});

test('Claude discovers session schemas lazily and invokes the same dynamic route exposed to GPT', async () => {
  const f = fixture(); let mcp, client;
  try {
    const caller = await f.start(), target = await f.start();
    const record = f.bridge.records.get(caller), turn = { id: randomUUID() };
    const controller = new AbortController(); f.bridge.active.set(caller, { turn, controller });
    const native = { request: async (method, params) => method === 'mcpServerStatus/list' ? { data: [] } : f.bridge.native.request(method, params) };
    const found = search(await discover(native, record), 'codex_bridge_sessions read');
    assert.ok(found.matches.some(t => t.route.namespace === sessionNamespace));
    mcp = makeTools({ native, desktop: { request: (...args) => f.bridge.toolRequest(...args) }, record, turn, item: () => {}, signal: controller.signal });
    client = new Client({ name: 'session-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.instance.connect(b); await client.connect(a);
    assert.equal((await client.listTools()).tools.length, 5);
    const matches = JSON.parse((await client.callTool({ name: 'find_tools', arguments: { query: 'codex_bridge_sessions read' } })).content[0].text).matches;
    const name = matches.find(m => m.name.includes('_read_')).name;
    const result = await client.callTool({ name: 'call_tool', arguments: { name, arguments: { operation: 'read', threadId: target } } });
    assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).threadId, target);
    const stale = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId: caller, turnId: 'old', tool: 'read', arguments: { operation: 'list' } });
    assert.equal(stale.success, false);
  } finally { await client?.close(); await mcp?.instance.close(); f.close(); }
});

test('concurrent chats and longer retained histories remain independent through pagination and restart', async () => {
  const f = fixture();
  try {
    const ids = await Promise.all(Array.from({ length: 6 }, () => f.start()));
    await Promise.all(ids.map(async (id, n) => {
      for (let i = 0; i < 18; i++) {
        const turn = await f.send(id, `SYNTHETIC_CHAT_${n}_TURN_${i}`); await f.done(turn.turn.id);
      }
    }));
    f.restart();
    for (let n = 0; n < ids.length; n++) {
      let cursor, turns = [];
      do { const page = await read(f, ids[n], { operation: 'read', threadId: ids[n], limit: 7, ...(cursor ? { cursor } : {}) }); turns.push(...page.turns); cursor = page.nextCursor; } while (cursor);
      assert.equal(turns.length, 18); assert.equal(new Set(turns.map(t => t.id)).size, 18);
      assert.equal(turns.filter(t => t.items.some(i => i.text.includes(`SYNTHETIC_CHAT_${n}_`))).length, 18);
    }
    assert.equal(f.events.filter(e => e.method === 'turn/completed').length, 108);
    assert.equal(f.bridge.active.size, 0);
  } finally { f.close(); }
});
