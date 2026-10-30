import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture } from './support/fixture.mjs';
import { receiptPath, sessionNamespace } from '../sessions.mjs';

// Synthetic app-server protocol proof for primary mode. No desktop, model or
// Claude runtime is involved; this is not Mac or GUI acceptance.
const primary = () => fixture('openai', { coordinateNative: true });
// Native reports each GPT turn's start and completion; calls belong to a started turn.
const turnOn = (bridge, threadId, turnId = 'native-turn') => bridge.nativeNotification('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
const turnOff = (bridge, threadId, turnId = 'native-turn', status = 'completed') => bridge.nativeNotification('turn/completed', { threadId, turn: { id: turnId, status } });
const gpt = async (f, params = {}, bridge = f.bridge) => {
  const id = (await bridge.request('thread/start', { cwd: f.statePath, ...params })).thread.id;
  await turnOn(bridge, id); return id;
};
const tool = async (f, threadId, tool, args, { turnId = 'native-turn', signal, bridge = f.bridge } = {}) => {
  const result = await bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId, turnId, callId: randomUUID(), tool, arguments: args }, undefined, signal);
  const text = result.contentItems[0].text;
  return result.success ? JSON.parse(text) : { error: text };
};
const create = (f, caller, extra = {}, options) => tool(f, caller, 'manage', { operation: 'create', model: 'sonnet', text: 'SYNTHETIC FIRST MESSAGE', requestId: 'create-request-0001', ...extra }, options);
const receipt = (f, caller, requestId = 'create-request-0001') => JSON.parse(readFileSync(receiptPath(f.statePath, caller, requestId), 'utf8'));
const holdStarts = (f, hold, entered) => { f.controls.native = async (method, params) => { if (method === 'thread/start' && params.sandbox) { entered.resolve(); await hold.promise; } }; };
// A created chat whose first message was never sent: the caller's turn is
// stopped while the native start is held (the repaired R17-1 path).
async function primeCancelled(f, { caller, requestId = 'create-request-0001' } = {}) {
  const hold = deferred(), entered = deferred(), turnId = `prime-${requestId}`;
  caller ??= (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
  await turnOn(f.bridge, caller, turnId);
  holdStarts(f, hold, entered);
  const pending = create(f, caller, { requestId }, { turnId });
  await entered.promise;
  await f.bridge.request('turn/interrupt', { threadId: caller, turnId }); await turnOff(f.bridge, caller, turnId, 'interrupted');
  hold.resolve(); assert.ok((await pending).error); f.controls.native = null;
  const child = receipt(f, caller, requestId).threadId;
  assert.equal(f.bridge.records.get(child).turns.length, 0);
  return { caller, child };
}
const persistedTurns = (f, threadId) => JSON.parse(readFileSync(join(f.statePath, `${threadId}.json`), 'utf8')).turns.map(t => t.id);
const starts = f => f.calls.filter(c => c.method === 'thread/start');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('isolated mode still passes a GPT thread start through unchanged', async () => {
  const f = fixture();
  try {
    const id = await gpt(f, { dynamicTools: [{ type: 'function', name: 'desktop_tool', description: 'x', inputSchema: { type: 'object' } }] });
    assert.deepEqual(starts(f)[0].params.dynamicTools.map(t => t.name), ['desktop_tool']);
    assert.equal(f.bridge.records.has(id), false);
    assert.equal(f.bridge.nativeCallers.size, 0);
    assert.equal((await tool(f, id, 'read', { operation: 'list' })).error, 'Session tool call does not belong to the active turn');
  } finally { f.close(); }
});

test('primary GPT chats stay native and GPT-default, and only gain the session tools', async () => {
  const f = primary();
  try {
    const id = await gpt(f, { dynamicTools: [{ type: 'function', name: 'desktop_tool', description: 'x', inputSchema: { type: 'object' } }] });
    const [start] = starts(f);
    assert.equal(start.params.model, undefined, 'the configured GPT default is not replaced');
    assert.equal(start.params.modelProvider, undefined);
    assert.deepEqual(start.params.dynamicTools.map(t => t.name), ['desktop_tool', sessionNamespace]);
    assert.equal(f.bridge.records.has(id), false, 'the native host keeps owning the GPT chat');
    assert.equal(f.hosts.get(id).settings.model, 'gpt-test');
    const sent = await f.bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'native' }] });
    assert.ok(sent.turn.id); assert.equal(f.queries.length, 0, 'GPT turns never reach Claude');
    await assert.rejects(f.bridge.request('thread/start', { cwd: f.statePath, dynamicTools: [{ type: 'namespace', name: sessionNamespace, tools: [] }] }), /Reserved/);
    const claude = await f.start('sonnet');
    assert.equal(f.bridge.records.get(claude).provider, 'claude', 'Claude chats keep the existing managed route');
    assert.equal(f.bridge.nativeCallers.has(claude), false);
  } finally { f.close(); }
});

test('primary GPT creates a real Claude chat with the same workspace and permissions, once per requestId', async () => {
  const f = primary();
  try {
    const caller = await gpt(f);
    const created = await create(f, caller);
    assert.ok(created.threadId, JSON.stringify(created));
    const record = f.bridge.records.get(created.threadId);
    assert.equal(record.provider, 'claude'); assert.equal(record.model, 'sonnet');
    const host = starts(f).at(-1).params;
    assert.deepEqual([host.cwd, host.sandbox, host.approvalPolicy, host.model], [f.statePath, 'read-only', 'never', 'gpt-test'],
      'a native host thread in the caller workspace and permissions, without a GPT model change');
    assert.equal(created.turn.id, record.turns[0].id);
    await f.done(created.turn.id);
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0].input[0].text, 'SYNTHETIC FIRST MESSAGE');
    const retry = await create(f, caller);
    assert.deepEqual([retry.threadId, retry.turn.id], [created.threadId, created.turn.id], 'a retry returns the same chat and turn');
    assert.equal(starts(f).length, 2); assert.equal(f.queries.length, 1);
    assert.match((await create(f, caller, { text: 'changed' })).error, /another chat creation/);
    f.restart();
    await f.bridge.request('thread/resume', { threadId: caller }); await turnOn(f.bridge, caller, 'native-turn-after-restart');
    assert.equal((await create(f, caller, {}, { turnId: 'native-turn-after-restart' })).threadId, created.threadId, 'the receipt survives a Bridge restart');
    await turnOff(f.bridge, caller, 'native-turn-after-restart'); await turnOn(f.bridge, caller);
    const follow = await tool(f, caller, 'manage', { operation: 'send', threadId: created.threadId, requestId: 'follow-request-0001', text: 'SECOND' });
    await f.done(follow.turn.id);
    const view = await tool(f, caller, 'read', { operation: 'read', threadId: created.threadId });
    assert.deepEqual(view.turns.map(t => t.items[0].text), ['SECOND', 'SYNTHETIC FIRST MESSAGE']);
    assert.equal((await tool(f, caller, 'read', { operation: 'list' })).data[0].threadId, created.threadId);
  } finally { f.close(); }
});

test('create refuses wrong models, missing fields, unknown callers and widened or changed permissions', async () => {
  const f = primary();
  try {
    const caller = await gpt(f);
    for (const [args, expected] of [[{ model: 'gpt-test' }, /Claude model/], [{ model: 'claude-unknown' }, /does not advertise/],
      [{ text: ' ' }, /nonempty/], [{ requestId: 'short' }, /requestId/], [{ threadId: caller }, /does not take threadId/]])
      assert.match((await create(f, caller, args)).error, expected);
    assert.match((await create(f, randomUUID())).error, /does not belong/);
    f.bridge.nativeCallers.get(caller).sandbox = { type: 'workspaceWrite', writableRoots: [] };
    assert.match((await create(f, caller, { requestId: 'widened-request-01' })).error, /same permissions; it was archived/);
    const archived = starts(f).at(-1).params;
    assert.equal(archived.sandbox, 'workspace-write');
    assert.ok(f.calls.some(c => c.method === 'thread/archive'));
    f.bridge.nativeCallers.get(caller).sandbox = { type: 'externalSandbox' };
    assert.match((await create(f, caller, { requestId: 'unknown-perms-01' })).error, /permissions are unknown/);
    assert.equal(f.queries.length, 0, 'no refused create reaches Claude');
  } finally { f.close(); }
});

test('create follows the caller approval policy and permission changes from native settings', async () => {
  const f = primary();
  try {
    const caller = await gpt(f);
    const prompts = [];
    let answer = 'decline';
    f.bridge.desktop.request = async (method, params) => { prompts.push({ method, params }); return { action: answer, content: { approve: true } }; };
    await f.bridge.nativeNotification('thread/settings/updated', { threadId: caller, threadSettings: { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'on-request', activePermissionProfile: null } });
    const count = starts(f).length;
    assert.match((await create(f, caller)).error, /declined/);
    assert.equal(prompts[0].method, 'mcpServer/elicitation/request'); assert.equal(prompts[0].params.threadId, caller);
    assert.equal(starts(f).length, count, 'a declined create starts nothing');
    answer = 'accept';
    // The shared fixture always reports a never policy; this host applies the requested one.
    const original = f.bridge.native.request;
    f.bridge.native.request = async (method, params) => {
      const result = await original(method, params);
      return method === 'thread/start' && params.approvalPolicy ? { ...result, approvalPolicy: params.approvalPolicy } : result;
    };
    const created = await create(f, caller, { requestId: 'approved-request-1' });
    assert.ok(created.threadId, JSON.stringify(created));
    assert.equal(prompts.length, 2);
    assert.equal(starts(f).at(-1).params.approvalPolicy, 'on-request');
    await f.done(created.turn.id);
  } finally { f.close(); }
});

test('an uncertain create blocks retry, including after restart, instead of starting a second chat', async () => {
  const f = primary();
  try {
    const caller = await gpt(f);
    f.controls.native = async (method, params) => { if (method === 'thread/start' && params.model === 'gpt-test' && params.dynamicTools?.length === 1 && params.sandbox) throw new Error('RPC disconnected after dispatch'); };
    assert.match((await create(f, caller)).error, /disconnected/);
    f.controls.native = null;
    assert.match((await create(f, caller)).error, /uncertain/);
    const before = starts(f).length;
    f.restart();
    await f.bridge.request('thread/resume', { threadId: caller });
    assert.ok(f.bridge.nativeCallers.has(caller), 'a reopened GPT chat is tracked again from its native response');
    assert.match((await create(f, caller)).error, /does not belong/, 'before native reports a new turn, no call is admitted');
    await turnOn(f.bridge, caller);
    assert.match((await create(f, caller)).error, /uncertain/);
    assert.equal(starts(f).length, before);
  } finally { f.close(); }
});

test('a create retry revalidates workspace, permissions and the receipt’s own chat before any message', async () => {
  const f = primary();
  try {
    const caller = await gpt(f);
    const created = await create(f, caller); await f.done(created.turn.id);
    const entry = f.bridge.nativeCallers.get(caller), turns = () => f.bridge.records.get(created.threadId).turns.length;
    entry.sandbox = { type: 'workspaceWrite', writableRoots: [] };
    assert.match((await create(f, caller)).error, /permissions differ/, 'a widened caller does not reuse an older narrower chat');
    entry.sandbox = { type: 'readOnly' }; entry.options.config = { 'apps._default.default_tools_approval_mode': 'approve' };
    assert.match((await create(f, caller)).error, /permissions differ/);
    entry.options.config = {}; entry.thread.cwd = join(f.statePath, 'other-workspace');
    assert.match((await create(f, caller)).error, /not available in this workspace/);
    entry.thread.cwd = f.statePath;
    const other = await f.start('sonnet'), path = receiptPath(f.statePath, caller, 'create-request-0001');
    writeFileSync(path, JSON.stringify({ ...receipt(f, caller), threadId: other }));
    assert.match((await create(f, caller)).error, /no longer matches/, 'a receipt never redirects a message to another chat');
    writeFileSync(path, JSON.stringify({ ...receipt(f, caller), threadId: created.threadId }));
    await f.bridge.request('thread/archive', { threadId: created.threadId });
    assert.match((await create(f, caller)).error, /Unarchive/);
    await f.bridge.request('thread/unarchive', { threadId: created.threadId });
    assert.equal((await create(f, caller)).turn.id, created.turn.id, 'the original retry still returns its turn');
    assert.equal(turns(), 1); assert.equal(f.queries.length, 1, 'no refused retry sent a message');
  } finally { f.close(); }
});

test('a caller settings change while the native start is pending archives the new chat and sends nothing', async () => {
  const f = primary(), hold = deferred(), entered = deferred();
  try {
    const caller = await gpt(f);
    f.controls.native = async (method, params) => { if (method === 'thread/start' && params.sandbox) { entered.resolve(); await hold.promise; } };
    const pending = create(f, caller);
    await entered.promise;
    await f.bridge.nativeNotification('thread/settings/updated', { threadId: caller,
      threadSettings: { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [] }, approvalPolicy: 'never', activePermissionProfile: null } });
    hold.resolve();
    assert.match((await pending).error, /same permissions; it was archived/);
    const created = starts(f).length;
    const archived = [...f.bridge.records.values()].find(r => r.sessionCreate?.callerThreadId === caller);
    assert.equal(archived.archived, true); assert.equal(archived.turns.length, 0);
    assert.match((await create(f, caller)).error, /permissions differ/, 'its retry sends nothing either');
    assert.equal(starts(f).length, created); assert.equal(f.queries.length, 0);
  } finally { hold.resolve(); f.close(); }
});

test('concurrent creates share one chat per requestId and refuse a different message under it', async () => {
  const f = primary(), hold = deferred(), entered = deferred();
  try {
    const caller = await gpt(f);
    f.controls.native = async (method, params) => { if (method === 'thread/start' && params.sandbox) { entered.resolve(); await hold.promise; } };
    const first = create(f, caller), second = create(f, caller), changed = create(f, caller, { text: 'DIFFERENT' });
    await entered.promise;
    assert.match((await changed).error, /another chat creation/, 'refused while the original start is still held');
    assert.equal(starts(f).filter(s => s.params.sandbox).length, 1, 'only one native start before release');
    hold.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual([b.threadId, b.turn.id], [a.threadId, a.turn.id]);
    assert.equal(starts(f).filter(s => s.params.sandbox).length, 1, 'one native start');
    await f.done(a.turn.id);
    assert.equal(f.queries.length, 1); assert.equal(f.bridge.sessionCreating.size, 0);
  } finally { hold.resolve(); f.close(); }
});

test('R17-1: a create held while its GPT turn is stopped, ends or is cancelled keeps the chat and receipt but sends no first message', async () => {
  for (const ending of ['interrupt', 'completion', 'unsubscribe', 'signal']) {
    const f = primary(), hold = deferred(), entered = deferred(), controller = new AbortController();
    try {
      const caller = await gpt(f);
      holdStarts(f, hold, entered);
      const pending = create(f, caller, {}, ending === 'signal' ? { signal: controller.signal } : {});
      await entered.promise;
      if (ending === 'interrupt') await f.bridge.request('turn/interrupt', { threadId: caller, turnId: 'native-turn' });
      if (ending === 'completion') await turnOff(f.bridge, caller, 'native-turn', 'interrupted');
      if (ending === 'unsubscribe') await f.bridge.request('thread/unsubscribe', { threadId: caller });
      if (ending === 'signal') controller.abort(new Error('SYNTHETIC CALLER CANCELLATION'));
      hold.resolve();
      assert.ok((await pending).error, ending);
      const child = [...f.bridge.records.values()].find(r => r.sessionCreate?.callerThreadId === caller);
      assert.equal(child.turns.length, 0, `${ending}: the undispatched first message is not sent`);
      assert.equal(receipt(f, caller).threadId, child.thread.id, `${ending}: the dispatched creation keeps its identity`);
      assert.equal(f.queries.length, 0);
      f.controls.native = null;
      if (ending !== 'signal') {
        assert.match((await tool(f, caller, 'read', { operation: 'list' })).error, /does not belong/, `${ending}: the ended turn admits no further call`);
        await turnOn(f.bridge, caller, 'native-turn-2');
        const retried = await create(f, caller, {}, { turnId: 'native-turn-2' });
        assert.equal(retried.threadId, child.thread.id, `${ending}: a later turn's retry reuses the created chat`);
        await f.done(retried.turn.id); assert.equal(f.queries.length, 1);
      }
    } finally { hold.resolve(); f.close(); }
  }
});

test('R17-1: unmanaged GPT calls are admitted only for the started, unfinished native turn', async () => {
  const f = primary();
  try {
    const caller = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
    assert.match((await tool(f, caller, 'read', { operation: 'list' })).error, /does not belong/, 'no turn started yet');
    await turnOn(f.bridge, caller);
    assert.ok(Array.isArray((await tool(f, caller, 'read', { operation: 'list' })).data));
    assert.match((await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'not-an-active-turn' })).error, /does not belong/, 'a stale or invented turn ID');
    await turnOn(f.bridge, caller, 'native-turn-2');
    assert.match((await tool(f, caller, 'read', { operation: 'list' })).error, /does not belong/, 'a superseded turn');
    await turnOff(f.bridge, caller, 'native-turn-2');
    assert.match((await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'native-turn-2' })).error, /does not belong/, 'a completed turn');
    await turnOn(f.bridge, caller, 'native-turn-3');
    await f.bridge.nativeNotification('thread/closed', { threadId: caller });
    assert.match((await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'native-turn-3' })).error, /does not belong/, 'a closed chat');
  } finally { f.close(); }
});

test('R17-2: after a native-confirmed workspace change, a new GPT turn lists and creates only in the new workspace', async () => {
  const f = primary();
  try {
    const caller = await gpt(f), workspaceB = join(f.statePath, 'workspace-b');
    const first = await create(f, caller); await f.done(first.turn.id);
    await turnOff(f.bridge, caller);
    await f.bridge.request('thread/settings/update', { threadId: caller, cwd: workspaceB });
    await turnOn(f.bridge, caller, 'native-turn-b');
    const list = await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'native-turn-b' });
    assert.deepEqual(list.data, [], 'the previous workspace’s chat is not listed');
    assert.match((await tool(f, caller, 'read', { operation: 'read', threadId: first.threadId }, { turnId: 'native-turn-b' })).error, /not available in this workspace/);
    const second = await create(f, caller, { requestId: 'create-request-0002' }, { turnId: 'native-turn-b' });
    assert.equal(starts(f).at(-1).params.cwd, workspaceB, 'the new chat uses the new workspace');
    await f.done(second.turn.id);
    // A change confirmed during a turn ends that turn's calls rather than crossing workspaces.
    await f.bridge.request('thread/settings/update', { threadId: caller, cwd: f.statePath });
    assert.match((await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'native-turn-b' })).error, /does not belong/);
    // A reopened chat follows the response-level workspace, and an unknown one gets no coordination.
    const original = f.bridge.native.request;
    f.bridge.native.request = async (method, params) => {
      const result = await original(method, params);
      return method === 'thread/resume' ? { ...result, cwd: workspaceB } : result;
    };
    await f.bridge.request('thread/resume', { threadId: caller }); await turnOn(f.bridge, caller, 'native-turn-c');
    assert.equal((await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'native-turn-c' })).data[0].threadId, second.threadId);
    f.bridge.native.request = async (method, params) => {
      const result = await original(method, params);
      return method === 'thread/resume' ? { ...result, cwd: undefined, thread: { ...result.thread, cwd: undefined } } : result;
    };
    await f.bridge.request('thread/resume', { threadId: caller }); await turnOn(f.bridge, caller, 'native-turn-d');
    assert.match((await tool(f, caller, 'read', { operation: 'list' }, { turnId: 'native-turn-d' })).error, /does not belong/, 'unknown workspace');
  } finally { f.close(); }
});

test('R17-3: receipts are per request and exclusive across Bridge instances sharing a state, across restart and crashes', async () => {
  const f = primary(), hold = deferred(), entered = deferred();
  try {
    const a = f.bridge, callerA = await gpt(f, {}, a);
    f.restart(); const b = f.bridge, callerB = await gpt(f, {}, b);
    const [createdA, createdB] = await Promise.all([create(f, callerA, { requestId: 'shared-create-a-0001' }, { bridge: a }),
      create(f, callerB, { requestId: 'shared-create-b-0001' }, { bridge: b })]);
    await f.done(createdA.turn.id); await f.done(createdB.turn.id);
    assert.equal(receipt(f, callerA, 'shared-create-a-0001').threadId, createdA.threadId);
    assert.equal(receipt(f, callerB, 'shared-create-b-0001').threadId, createdB.threadId, 'neither instance’s receipt replaces the other’s');
    f.restart(); const c = f.bridge;
    await c.request('thread/resume', { threadId: callerA }); await turnOn(c, callerA);
    const retried = await create(f, callerA, { requestId: 'shared-create-a-0001' }, { bridge: c });
    assert.deepEqual([retried.threadId, retried.turn.id], [createdA.threadId, createdA.turn.id], 'a retry after restart returns the original chat and turn');
    assert.equal(starts(f).filter(s => s.params.sandbox).length, 2); assert.equal(f.queries.length, 2);
    // The same request in two instances: only the reserving one starts a chat; the other refuses its unknown outcome.
    b.trackCaller({ thread: { id: callerA, cwd: f.statePath }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', disabledPluginIds: [] }, {});
    await turnOn(b, callerA);
    holdStarts(f, hold, entered);
    const owner = create(f, callerA, { requestId: 'same-key-0001' }, { bridge: c });
    await entered.promise;
    assert.match((await create(f, callerA, { requestId: 'same-key-0001' }, { bridge: b })).error, /uncertain or still in progress in another Codex window/);
    assert.match((await create(f, callerA, { requestId: 'same-key-0001', text: 'DIFFERENT' }, { bridge: b })).error, /another chat creation/);
    hold.resolve();
    const owned = await owner; await f.done(owned.turn.id);
    assert.ok((await create(f, callerA, { requestId: 'same-key-0001' }, { bridge: b })).error, 'an instance that cannot see the chat sends nothing');
    assert.equal(starts(f).filter(s => s.params.sandbox).length, 3); assert.equal(f.queries.length, 3);
    // A reservation left by a crash, or an unreadable receipt, is never treated as safe to repeat.
    const crashed = receiptPath(f.statePath, callerA, 'crashed-create-0001');
    mkdirSync(dirname(crashed), { recursive: true });
    writeFileSync(crashed, JSON.stringify({ callerThreadId: callerA, requestId: 'crashed-create-0001', input: { model: 'sonnet', text: 'SYNTHETIC FIRST MESSAGE' } }));
    assert.match((await create(f, callerA, { requestId: 'crashed-create-0001' }, { bridge: c })).error, /uncertain/);
    writeFileSync(receiptPath(f.statePath, callerA, 'broken-create-0001'), '{broken');
    assert.match((await create(f, callerA, { requestId: 'broken-create-0001' }, { bridge: c })).error, /cannot be read/);
    assert.equal(starts(f).filter(s => s.params.sandbox).length, 3); assert.equal(f.queries.length, 3);
  } finally { hold.resolve(); f.close(); }
});

test('R17-4: a failed cleanup archive is reported as failed, with the chat and receipt kept, and no message', async () => {
  const f = primary(), hold = deferred(), entered = deferred();
  try {
    const caller = await gpt(f);
    holdStarts(f, hold, entered);
    const pending = create(f, caller);
    await entered.promise;
    await f.bridge.nativeNotification('thread/settings/updated', { threadId: caller,
      threadSettings: { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', activePermissionProfile: null } });
    f.controls.native = async method => { if (method === 'thread/archive') throw new Error('SYNTHETIC ARCHIVE FAILURE'); };
    hold.resolve();
    const reply = await pending;
    const child = [...f.bridge.records.values()].find(r => r.sessionCreate?.callerThreadId === caller);
    assert.match(reply.error, /could not be confirmed archived \(SYNTHETIC ARCHIVE FAILURE\); no message was sent/);
    assert.doesNotMatch(reply.error, /it was archived/);
    assert.ok(reply.error.includes(child.thread.id), 'the chat to recover is named');
    assert.equal(child.archived, false); assert.equal(receipt(f, caller).threadId, child.thread.id);
    assert.equal(f.queries.length, 0);
    f.controls.native = null;
    assert.match((await create(f, caller)).error, /permissions differ/, 'a retry sends nothing either');
    assert.equal(f.queries.length, 0);
  } finally { hold.resolve(); f.close(); }
});

test('R18-1: a create retry whose destination is still being prepared sends nothing after Stop, cancellation, a workspace or a permission change', async () => {
  for (const ending of ['none', 'interrupt', 'signal', 'workspace', 'permissions']) {
    const f = primary(), hold = deferred(), entered = deferred(), controller = new AbortController();
    try {
      const { caller, child } = await primeCancelled(f);
      f.restart(); const b = f.bridge;
      await b.request('thread/resume', { threadId: caller }); await turnOn(b, caller, 'retry-turn');
      // Hold the destination's own native resume inside turn preparation.
      f.controls.native = async (method, params) => { if (method === 'thread/resume' && params.threadId === child) { entered.resolve(); await hold.promise; } };
      const pending = create(f, caller, {}, { turnId: 'retry-turn', signal: ending === 'signal' ? controller.signal : undefined });
      await entered.promise;
      assert.equal(b.records.get(child).turns.length, 0); assert.equal(f.queries.length, 0);
      if (ending === 'interrupt') { await b.request('turn/interrupt', { threadId: caller, turnId: 'retry-turn' }); await turnOff(b, caller, 'retry-turn', 'interrupted'); }
      if (ending === 'signal') controller.abort(new Error('SYNTHETIC CALLER CANCELLATION'));
      if (['workspace', 'permissions'].includes(ending)) await b.nativeNotification('thread/settings/updated', { threadId: caller, threadSettings: {
        cwd: ending === 'workspace' ? join(f.statePath, 'workspace-b') : f.statePath, sandboxPolicy: { type: ending === 'permissions' ? 'dangerFullAccess' : 'readOnly' },
        approvalPolicy: 'never', activePermissionProfile: null, disabledPluginIds: [] } });
      hold.resolve();
      const reply = await pending;
      if (ending === 'none') {
        assert.ok(reply.turn?.id, JSON.stringify(reply)); await f.done(reply.turn.id);
        assert.equal(f.queries.length, 1, 'the unchanged control delivers exactly once');
        assert.equal(receipt(f, caller).turnId, reply.turn.id, 'the accepted turn is recorded in the receipt');
        continue;
      }
      assert.ok(reply.error, `${ending}: ${JSON.stringify(reply)}`);
      assert.equal(f.queries.length, 0, `${ending}: no first message`); assert.equal(b.records.get(child).turns.length, 0);
      assert.deepEqual([receipt(f, caller).threadId, receipt(f, caller).turnId], [child, undefined], `${ending}: the chat stays identified, unsent`);
      assert.equal(existsSync(`${receiptPath(f.statePath, caller, 'create-request-0001')}.delivery`), false, `${ending}: nothing accepted, so the delivery claim is released`);
      if (ending === 'interrupt') {
        f.controls.native = null; await turnOn(b, caller, 'retry-turn-2');
        const later = await create(f, caller, {}, { turnId: 'retry-turn-2' });
        assert.equal(later.threadId, child); await f.done(later.turn.id);
        assert.equal(f.queries.length, 1, 'a later legitimate retry delivers it once');
      }
    } finally { hold.resolve(); f.close(); }
  }
});

test('R18-1: a session send still in turn preparation is not sent after the calling turn stops; unchanged, it is sent once', async () => {
  for (const stop of [false, true]) {
    const f = primary(), hold = deferred(), entered = deferred();
    try {
      const caller = await gpt(f);
      const { threadId, turn } = await create(f, caller); await f.done(turn.id);
      // The second ensureLoaded is the one inside turn preparation, after manage()'s own checks.
      const original = f.bridge.ensureLoaded.bind(f.bridge); let loads = 0;
      f.bridge.ensureLoaded = async record => { if (record.thread.id === threadId && ++loads === 2) { entered.resolve(); await hold.promise; } return original(record); };
      const pending = tool(f, caller, 'manage', { operation: 'send', threadId, requestId: 'send-request-0001', text: 'SECOND' });
      await entered.promise;
      if (stop) await f.bridge.request('turn/interrupt', { threadId: caller, turnId: 'native-turn' });
      hold.resolve();
      const reply = await pending;
      if (stop) {
        assert.match(reply.error, /stopped/); assert.equal(f.bridge.records.get(threadId).turns.length, 1);
        assert.equal(f.queries.length, 1, 'no message after the caller stopped');
      } else {
        assert.ok(reply.turn?.id, JSON.stringify(reply)); await f.done(reply.turn.id); assert.equal(f.queries.length, 2);
      }
    } finally { hold.resolve(); f.close(); }
  }
});

test('R18-2: a first message accepted by one Bridge instance is never started again by a stale one, and history is kept', async () => {
  const f = primary();
  try {
    const { caller, child } = await primeCancelled(f);
    const a = f.bridge; f.restart(); const b = f.bridge;
    assert.equal(b.records.get(child).turns.length, 0, 'the second instance cached the chat before any delivery');
    await turnOn(a, caller, 'retry-a');
    const first = await create(f, caller, {}, { turnId: 'retry-a', bridge: a });
    await f.done(first.turn.id); await turnOff(a, caller, 'retry-a');
    await b.request('thread/resume', { threadId: caller }); await turnOn(b, caller, 'retry-b');
    const second = await create(f, caller, {}, { turnId: 'retry-b', bridge: b });
    assert.deepEqual([second.threadId, second.turn.id], [child, first.turn.id], 'the stale instance reports the accepted turn');
    assert.match(second.note, /already accepted/);
    assert.equal(f.queries.length, 1, 'the same message ran once');
    assert.deepEqual(persistedTurns(f, child), [first.turn.id], 'the accepted turn stays in canonical history');
    assert.equal(b.records.get(child).turns.length, 0, 'the stale cache neither ran nor saved anything');
    assert.equal(starts(f).filter(s => s.params.sandbox).length, 1);
    f.restart(); const c = f.bridge;
    await c.request('thread/resume', { threadId: caller }); await turnOn(c, caller, 'retry-c');
    const third = await create(f, caller, {}, { turnId: 'retry-c', bridge: c });
    assert.equal(third.turn.id, first.turn.id); assert.equal(f.queries.length, 1);
    assert.match((await create(f, caller, { text: 'DIFFERENT' }, { turnId: 'retry-c', bridge: c })).error, /another chat creation/);
  } finally { f.close(); }
});

test('R18-2: a concurrent delivery in another instance, or a delivery claim left by a crash, is refused as uncertain and never replayed', async () => {
  const f = primary(), hold = deferred(), entered = deferred();
  try {
    const { caller, child } = await primeCancelled(f);
    const a = f.bridge; f.restart(); const b = f.bridge;
    await b.request('thread/resume', { threadId: caller }); await turnOn(b, caller, 'retry-b'); await turnOn(a, caller, 'retry-a');
    f.controls.native = async (method, params) => { if (method === 'thread/resume' && params.threadId === child) { entered.resolve(); await hold.promise; } };
    const owner = create(f, caller, {}, { turnId: 'retry-b', bridge: b });
    await entered.promise;
    assert.match((await create(f, caller, {}, { turnId: 'retry-a', bridge: a })).error, /delivery is uncertain or still in progress in another Codex window/);
    hold.resolve();
    const delivered = await owner; await f.done(delivered.turn.id);
    assert.equal(f.queries.length, 1);
    const late = await create(f, caller, {}, { turnId: 'retry-a', bridge: a });
    assert.equal(late.turn.id, delivered.turn.id); assert.equal(f.queries.length, 1);
    assert.deepEqual(persistedTurns(f, child), [delivered.turn.id]);
    // A claim with no recorded turn and no delivery in progress here (a crash): refused, also after restart.
    f.controls.native = null;
    const { child: unsent } = await primeCancelled(f, { caller, requestId: 'crash-request-0001' });
    writeFileSync(`${receiptPath(f.statePath, caller, 'crash-request-0001')}.delivery`, '{}');
    await turnOn(f.bridge, caller, 'retry-crash');
    assert.match((await create(f, caller, { requestId: 'crash-request-0001' }, { turnId: 'retry-crash' })).error, /uncertain/);
    f.restart(); await f.bridge.request('thread/resume', { threadId: caller }); await turnOn(f.bridge, caller, 'retry-crash-2');
    assert.match((await create(f, caller, { requestId: 'crash-request-0001' }, { turnId: 'retry-crash-2' })).error, /uncertain/);
    assert.equal(f.bridge.records.get(unsent).turns.length, 0); assert.equal(f.queries.length, 1);
  } finally { hold.resolve(); f.close(); }
});

test('R19-1: a managed GPT session send held in its native history reset sends nothing after Stop, cancellation, a workspace or a permission change', async () => {
  for (const ending of ['none', 'interrupt', 'signal', 'workspace', 'permissions']) {
    const f = primary(), hold = deferred(), entered = deferred(), controller = new AbortController();
    try {
      const caller = await gpt(f), child = await f.start('sonnet');
      // GPT and Claude history, then GPT selected again, through the public routes.
      const gptTurn = await f.send(child, 'SYNTHETIC NATIVE HISTORY', { model: 'gpt-test' }); await f.done(gptTurn.turn.id);
      const claudeTurn = await f.send(child, 'SYNTHETIC CLAUDE HISTORY', { model: 'sonnet' }); await f.done(claudeTurn.turn.id);
      await f.bridge.request('thread/settings/update', { threadId: child, model: 'gpt-test' });
      const record = f.bridge.records.get(child);
      assert.deepEqual([record.provider, record.nativeResetRequired, record.nativeFirstTurnId], ['native', true, gptTurn.turn.id]);
      const nativeStarts = () => f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === child).length;
      const before = nativeStarts(), turns = record.turns.length;
      f.controls.native = async (method, params) => { if (method === 'thread/revert' && params.threadId === child) { entered.resolve(); await hold.promise; } };
      const send = (requestId, options) => tool(f, caller, 'manage', { operation: 'send', threadId: child, requestId, text: 'SYNTHETIC NATIVE MESSAGE' }, options);
      const pending = send('native-send-0001', { signal: ending === 'signal' ? controller.signal : undefined });
      await entered.promise;
      assert.equal(nativeStarts(), before, 'held before native dispatch');
      if (ending === 'interrupt') { await f.bridge.request('turn/interrupt', { threadId: caller, turnId: 'native-turn' }); await turnOff(f.bridge, caller, 'native-turn', 'interrupted'); }
      if (ending === 'signal') controller.abort(new Error('SYNTHETIC CALLER CANCELLATION'));
      if (['workspace', 'permissions'].includes(ending)) await f.bridge.nativeNotification('thread/settings/updated', { threadId: caller, threadSettings: {
        cwd: ending === 'workspace' ? join(f.statePath, 'workspace-b') : f.statePath, sandboxPolicy: { type: ending === 'permissions' ? 'dangerFullAccess' : 'readOnly' },
        approvalPolicy: 'never', activePermissionProfile: null, disabledPluginIds: [] } });
      hold.resolve();
      const reply = await pending;
      if (ending === 'none') {
        assert.ok(reply.turn?.id, JSON.stringify(reply)); await f.done(reply.turn.id);
        assert.equal(nativeStarts(), before + 1, 'the unchanged native send dispatches once');
        continue;
      }
      assert.ok(reply.error, `${ending}: ${JSON.stringify(reply)}`);
      assert.equal(nativeStarts(), before, `${ending}: nothing dispatched to native`);
      assert.equal(record.turns.length, turns, `${ending}: nothing accepted`);
      if (ending === 'interrupt') {
        f.controls.native = null; await turnOn(f.bridge, caller, 'native-turn-2');
        const later = await send('native-send-0001', { turnId: 'native-turn-2' });
        assert.ok(later.turn?.id, JSON.stringify(later)); await f.done(later.turn.id);
        assert.equal(nativeStarts(), before + 1, 'a later legitimate retry dispatches once');
      }
    } finally { hold.resolve(); f.close(); }
  }
});

test('R19-2: an unsent created chat switched to GPT refuses its first message, also in a window that saw it as Claude, until Claude is selected again', async () => {
  const f = primary();
  try {
    const { caller, child } = await primeCancelled(f);
    const a = f.bridge, nativeStarts = () => f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === child).length;
    f.restart(); const b = f.bridge; // b caches the chat as an unsent Claude chat
    await a.request('thread/settings/update', { threadId: child, model: 'gpt-test' }); // the person selects GPT in window a
    assert.deepEqual([a.records.get(child).provider, b.records.get(child).provider], ['native', 'claude']);
    await turnOn(a, caller, 'retry-a');
    assert.match((await create(f, caller, {}, { turnId: 'retry-a', bridge: a })).error, /no longer uses a Claude model/);
    await b.request('thread/resume', { threadId: caller }); await turnOn(b, caller, 'retry-b');
    assert.match((await create(f, caller, {}, { turnId: 'retry-b', bridge: b })).error, /out of date/, 'a stale Claude view does not authorize it');
    assert.equal(nativeStarts(), 0, 'never sent to GPT'); assert.equal(f.queries.length, 0, 'nor to Claude');
    assert.equal(existsSync(`${receiptPath(f.statePath, caller, 'create-request-0001')}.delivery`), false);
    assert.equal(receipt(f, caller).turnId, undefined);
    await a.request('thread/settings/update', { threadId: child, model: 'sonnet' }); // the person selects Claude again
    const delivered = await create(f, caller, {}, { turnId: 'retry-a', bridge: a });
    assert.ok(delivered.turn?.id, JSON.stringify(delivered)); await f.done(delivered.turn.id);
    assert.equal(f.queries.length, 1);
    // After acceptance, switching to GPT keeps the acknowledgement and sends nothing.
    await a.request('thread/settings/update', { threadId: child, model: 'gpt-test' });
    const replay = await create(f, caller, {}, { turnId: 'retry-a', bridge: a });
    assert.equal(replay.turn.id, delivered.turn.id); assert.equal(nativeStarts(), 0); assert.equal(f.queries.length, 1);
    f.restart(); const c = f.bridge;
    await c.request('thread/resume', { threadId: caller }); await turnOn(c, caller, 'retry-c');
    assert.equal((await create(f, caller, {}, { turnId: 'retry-c', bridge: c })).turn.id, delivered.turn.id);
    assert.deepEqual(persistedTurns(f, child), [delivered.turn.id], 'history kept'); assert.equal(f.queries.length, 1);
  } finally { f.close(); }
});

test('R19-2: a first-delivery claim is kept when the Claude message was accepted despite an error, and released only when it was not', async () => {
  const f = primary();
  try {
    const { caller, child } = await primeCancelled(f);
    const path = receiptPath(f.statePath, caller, 'create-request-0001');
    f.restart(); // the chat is no longer loaded here, so preparation resumes it
    await f.bridge.request('thread/resume', { threadId: caller }); await turnOn(f.bridge, caller, 'retry-1');
    f.controls.native = async (method, params) => { if (method === 'thread/resume' && params.threadId === child) throw new Error('SYNTHETIC RESUME FAILURE'); };
    assert.match((await create(f, caller, {}, { turnId: 'retry-1' })).error, /SYNTHETIC RESUME FAILURE/, 'a genuine preparation failure propagates');
    assert.equal(existsSync(`${path}.delivery`), false, 'nothing accepted: claim released'); assert.equal(f.queries.length, 0);
    f.controls.native = null;
    // Accepted, but its response is lost: the claim and accepted turn are kept.
    const prepare = f.bridge.prepareTurn.bind(f.bridge);
    f.bridge.prepareTurn = async (...args) => { await prepare(...args); throw new Error('SYNTHETIC LOST RESPONSE'); };
    assert.match((await create(f, caller, {}, { turnId: 'retry-1' })).error, /SYNTHETIC LOST RESPONSE/);
    f.bridge.prepareTurn = prepare;
    const turnId = receipt(f, caller).turnId;
    assert.ok(turnId, 'the accepted turn is recorded'); assert.ok(existsSync(`${path}.delivery`));
    await f.done(turnId); assert.equal(f.queries.length, 1);
    const retry = await create(f, caller, {}, { turnId: 'retry-1' });
    assert.equal(retry.turn.id, turnId); assert.equal(f.queries.length, 1, 'never replayed');
  } finally { f.close(); }
});

test('created chats keep the Claude history, steering and fork routes of managed chats', async () => {
  const f = primary();
  try {
    const caller = await gpt(f);
    const { threadId, turn } = await create(f, caller);
    await f.done(turn.id);
    const fork = await tool(f, caller, 'manage', { operation: 'fork', threadId, requestId: 'fork-request-0001' });
    assert.equal(fork.turnCount, 1); assert.notEqual(fork.threadId, threadId);
    assert.equal(f.bridge.records.get(fork.threadId).provider, 'claude');
    const resumed = await f.bridge.request('thread/resume', { threadId });
    assert.equal(resumed.model, 'sonnet'); assert.equal(resumed.modelProvider, 'claude_code');
    assert.equal(resumed.thread.turns[0].items[0].content[0].text, 'SYNTHETIC FIRST MESSAGE');
    assert.equal(join(f.bridge.records.get(threadId).thread.cwd), f.statePath);
  } finally { f.close(); }
});
