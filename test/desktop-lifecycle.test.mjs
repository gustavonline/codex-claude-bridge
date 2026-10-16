import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixture } from './support/fixture.mjs';
import { toolName } from '../capabilities.mjs';

test('desktop picker accepts deprecated mode fields when a Claude fork switches to GPT and back', async () => {
  const f = fixture();
  try {
    const parent = await f.start('sonnet'); const first = await f.send(parent); await f.done(first.turn.id);
    const { thread: child } = await f.bridge.request('thread/fork', { threadId: parent });
    for (const model of ['gpt-test', 'sonnet']) {
      await f.bridge.request('thread/settings/update', { threadId: child.id, model, effort: 'low',
        multiAgentMode: 'explicitRequestOnly', personality: 'pragmatic', serviceTier: null });
      const settings = f.events.findLast(e => e.method === 'thread/settings/updated').params.threadSettings;
      assert.equal(settings.model, model);
      assert.equal(settings.effort, 'low');
      assert.equal(settings.modelProvider, model === 'sonnet' ? 'claude_code' : 'openai');
      const sent = await f.send(child.id); await f.done(sent.turn.id);
    }
    assert.equal(f.bridge.records.get(parent).turns.length, 1);
    assert.equal(f.bridge.records.get(child.id).turns.length, 3);
    f.restart();
    const resumed = await f.bridge.request('thread/resume', { threadId: child.id });
    assert.equal(resumed.model, 'sonnet'); assert.equal(resumed.thread.turns.length, 3);
    const count = f.calls.length;
    const logs = []; f.bridge.log = (event, fields) => logs.push({ event, fields });
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: child.id, SYNTHETIC_SECRET_FIELD: true }), /not supported/);
    assert.equal(f.calls.length, count);
    assert.equal(logs[0].event, 'settings.unsupported');
    assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC_SECRET_FIELD/);
  } finally { f.close(); }
});

async function archiveTool(f, args, { disabled = false, deny = false, nativeFailure = false, cancel = false, approve = false, disableAfterDiscovery = false } = {}) {
  const original = f.bridge.native.request;
  let discoveries = 0;
  f.bridge.native.request = async (method, params) => {
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_app', runtimeStatus: disabled || (disableAfterDiscovery && discoveries++ > 0) ? 'disabled' : 'ready',
      tools: { set_thread_archived: { name: 'set_thread_archived', description: 'Archive a chat',
        inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } } } }] };
    if (method === 'config/read' && (deny || cancel || approve)) return { config: { mcp_servers: { codex_app: { default_tools_approval_mode: 'prompt' } } } };
    if (method === 'mcpServer/tool/call') throw new Error('Synthetic MCP transport closed');
    if (method === 'thread/archive' && nativeFailure) throw new Error('Synthetic native archive rejected');
    return original(method, params);
  };
  if (cancel || approve) {
    for (const record of f.bridge.records.values()) record.approvalPolicy = 'on-request';
    f.bridge.desktop.request = async (_, params) => {
      if (cancel) f.bridge.active.get(params.threadId).controller.abort();
      return { action: 'accept', content: { approve: true } };
    };
  }
  let result;
  f.controls.query = async ({ mcp }) => {
    const client = new Client({ name: 'self-archive-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.instance.connect(a), client.connect(b)]);
    try {
      await client.callTool({ name: 'find_tools', arguments: { query: 'set_thread_archived' } });
      result = await client.callTool({ name: 'call_tool', arguments: { name: toolName('codex_app', 'set_thread_archived'), arguments: args } });
    } finally { await client.close(); }
  };
  return () => result;
}

test('self-archive uses the public lifecycle after discovery, without losing its MCP reply', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    const lifecycle = [];
    f.bridge.sessionEvents.on('change', (method, params) => lifecycle.push({ method, params }));
    const result = await archiveTool(f, { archived: true });
    const sent = await f.send(id);
    await f.settled(sent.turn.id);
    assert.equal(result().isError ?? false, false);
    assert.equal(f.bridge.records.get(id).archived, true);
    const turn = f.bridge.records.get(id).turns.find(t => t.id === sent.turn.id);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.items.find(i => i.tool === 'set_thread_archived').status, 'completed');
    assert.equal(f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === sent.turn.id), false);
    assert.equal(lifecycle.filter(e => e.method === 'turn/completed' && e.params.turn.id === sent.turn.id).length, 1);
    assert.equal(f.bridge.active.size, 0);
    await f.bridge.request('thread/unarchive', { threadId: id });
    f.restart();
    const reopened = await f.bridge.request('thread/resume', { threadId: id });
    assert.equal(f.bridge.records.get(id).archived, false);
    assert.equal(reopened.thread.turns[0].items.find(i => i.tool === 'set_thread_archived').status, 'completed');
  } finally { f.close(); }
});

test('self-archive preserves discovery, approval and native failure boundaries', async () => {
  for (const [options, expected] of [[{ disabled: true }, /Find the tool schema/], [{ deny: true }, /requires approval/],
    [{ nativeFailure: true }, /native archive rejected/], [{ disableAfterDiscovery: true }, /no longer enabled/], [{ cancel: true }, /abort/i]]) {
    const f = fixture();
    try {
      const id = await f.start();
      const result = await archiveTool(f, { archived: true }, options);
      const sent = await f.send(id); await f.done(sent.turn.id);
      assert.equal(result().isError, true);
      assert.match(result().content[0].text, expected);
      assert.equal(f.bridge.records.get(id).archived, false);
      assert.equal(f.calls.some(c => c.method === 'thread/archive'), false);
    } finally { f.close(); }
  }
});

test('cross-chat, cross-host, ChatGPT and extended archive requests keep the native app tool route', async () => {
  for (const args of [{ archived: true, threadId: 'other' }, { archived: true, hostId: 'remote' },
    { archived: true, source: 'chatgpt' }, { archived: true, futureOption: true }, { archived: 'true' }]) {
    const f = fixture();
    try {
      const id = await f.start(); const result = await archiveTool(f, args);
      const sent = await f.send(id); await f.done(sent.turn.id);
      assert.equal(result().isError, true); assert.match(result().content[0].text, /MCP transport/);
      assert.equal(f.bridge.records.get(id).archived, false);
      assert.equal(f.calls.some(c => c.method === 'thread/archive'), false);
    } finally { f.close(); }
  }
});

test('an archived chat rejects new and queued starts but acknowledges an already delivered message', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    const message = { clientUserMessageId: 'retained-delivery' };
    const first = await f.send(id, 'hello', message); await f.done(first.turn.id);
    const queued = await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'queued-delivery', input: [{ type: 'text', text: 'queued' }] });
    await f.bridge.request('thread/archive', { threadId: id });
    const calls = f.calls.length, queries = f.queries.length;
    assert.equal((await f.send(id, 'hello', message)).turn.id, first.turn.id);
    await assert.rejects(f.send(id, 'new'), /Unarchive/);
    await assert.rejects(f.bridge.request('thread/queue/start', { threadId: id, queuedSubmissionId: queued.queuedSubmission.id }), /Unarchive/);
    assert.equal(f.calls.length, calls); assert.equal(f.queries.length, queries);
    assert.equal(f.bridge.records.get(id).queue[0].id, queued.queuedSubmission.id);
    assert.equal(f.bridge.records.get(id).turns.length, 1);
    await f.bridge.request('thread/unarchive', { threadId: id });
    const resumed = await f.bridge.request('thread/queue/start', { threadId: id }); await f.done(resumed.turn.id);
    assert.equal(f.bridge.records.get(id).queue.length, 0);
    assert.equal(f.bridge.records.get(id).turns.length, 2);
  } finally { f.close(); }
});

test('accepted prompted self-archive completes only after the native lifecycle succeeds', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    const result = await archiveTool(f, { archived: true, threadId: id, hostId: 'local', source: 'codex' }, { approve: true });
    const sent = await f.send(id); await f.settled(sent.turn.id);
    assert.equal(result().isError ?? false, false);
    assert.equal(f.bridge.records.get(id).archived, true);
    assert.equal(f.calls.filter(c => c.method === 'thread/archive').length, 1);
    assert.equal(f.bridge.records.get(id).turns[0].items.find(i => i.tool === 'set_thread_archived').status, 'completed');
  } finally { f.close(); }
});

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const holdResume = (f, failure) => {
  const entered = gate(), release = gate();
  f.controls.native = async method => {
    if (method !== 'thread/resume') return;
    entered.resolve(); await release.promise;
    if (failure) throw new Error(failure);
  };
  return { entered: entered.promise, release: release.resolve };
};

test('desktop reopening an unarchived chat from two views shares one native resume', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    const sent = await f.send(id, 'RETAINED'); await f.done(sent.turn.id);
    await f.bridge.request('thread/archive', { threadId: id });
    await f.bridge.request('thread/unarchive', { threadId: id });
    const unarchived = f.events.length, count = f.calls.length;
    const held = holdResume(f);
    const first = f.bridge.request('thread/resume', { threadId: id, excludeTurns: true });
    await held.entered;
    const second = f.bridge.request('thread/resume', { threadId: id, initialTurnsPage: { limit: 10 } });
    held.release();
    const [conversation, page] = await Promise.all([first, second]);
    assert.deepEqual(f.calls.slice(count).map(c => c.method), ['thread/resume']);
    for (const result of [conversation, page]) {
      assert.equal(result.thread.id, id); assert.equal(result.thread.status.type, 'idle');
      assert.equal(result.model, 'haiku'); assert.equal(result.modelProvider, 'claude_code');
    }
    assert.deepEqual(conversation.thread.turns, []);
    assert.deepEqual(page.initialTurnsPage.data.map(t => t.id), [sent.turn.id]);
    assert.equal(f.events.length, unarchived);
    assert.equal(f.bridge.changing.size, 0); assert.ok(f.bridge.loaded.has(id));
    assert.equal(f.bridge.records.get(id).archived, false);
    f.controls.native = undefined;
    await f.bridge.request('thread/resume', { threadId: id });
    assert.equal(f.calls.slice(count).filter(c => c.method === 'thread/resume').length, 2);
    const next = await f.send(id, 'AFTER'); await f.done(next.turn.id);
    f.restart();
    assert.equal(f.bridge.records.get(id).archived, false);
    assert.deepEqual(f.bridge.records.get(id).turns.map(t => t.status), ['completed', 'completed']);
  } finally { f.close(); }
});

test('a shared resume still rejects divergent settings, histories, workspaces and lifecycle changes', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    f.bridge.loaded.delete(id);
    const count = f.calls.length, held = holdResume(f);
    const pending = f.bridge.request('thread/resume', { threadId: id });
    await held.entered;
    for (const divergent of [{ model: 'sonnet' }, { developerInstructions: 'SYNTHETIC DIVERGENT' },
      { sandbox: 'danger-full-access' }, { permissions: 'synthetic-profile' }, { approvalPolicy: 'on-request' }])
      await assert.rejects(f.bridge.request('thread/resume', { threadId: id, ...divergent }), /Wait for the current chat change/);
    for (const alternate of [{ history: [] }, { path: '/synthetic-other-rollout' }])
      await assert.rejects(f.bridge.request('thread/resume', { threadId: id, ...alternate }), /alternative history/);
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, cwd: '/synthetic-other-workspace' }), /change workspace/);
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, approvalsReviewer: 'auto_review' }), /only be reviewed by the user/);
    for (const method of ['thread/archive', 'thread/unarchive', 'thread/settings/update'])
      await assert.rejects(f.bridge.request(method, { threadId: id, model: 'sonnet' }), /Wait for the current chat change/);
    await assert.rejects(f.send(id), /Wait for the current chat change/);
    held.release(); await pending;
    assert.deepEqual(f.calls.slice(count).map(c => c.method), ['thread/resume']);
    const record = f.bridge.records.get(id);
    assert.equal(record.model, 'haiku'); assert.equal(record.options.developerInstructions, undefined);
    assert.equal(record.archived, false); assert.equal(record.turns.length, 0);
  } finally { f.close(); }
});

test('a failed shared resume reports the native error to each caller and a retry resumes again', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    await f.bridge.request('thread/archive', { threadId: id });
    await f.bridge.request('thread/unarchive', { threadId: id });
    const count = f.calls.length, held = holdResume(f, 'Synthetic native resume rejected');
    const first = f.bridge.request('thread/resume', { threadId: id });
    await held.entered;
    const second = f.bridge.request('thread/resume', { threadId: id });
    held.release();
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map(r => r.reason?.message), ['Synthetic native resume rejected', 'Synthetic native resume rejected']);
    assert.equal(f.calls.slice(count).filter(c => c.method === 'thread/resume').length, 1);
    assert.equal(f.bridge.changing.size, 0); assert.equal(f.bridge.loaded.has(id), false);
    f.controls.native = undefined;
    const retried = await f.bridge.request('thread/resume', { threadId: id });
    assert.equal(retried.thread.id, id); assert.ok(f.bridge.loaded.has(id));
    assert.equal(f.calls.slice(count).filter(c => c.method === 'thread/resume').length, 2);
    const sent = await f.send(id); await f.done(sent.turn.id);
  } finally { f.close(); }
});

test('resume during an in-flight unarchive keeps the lifecycle change exclusive', async () => {
  const f = fixture(), entered = gate(), release = gate();
  try {
    const id = await f.start();
    await f.bridge.request('thread/archive', { threadId: id });
    f.controls.native = async method => { if (method === 'thread/unarchive') { entered.resolve(); await release.promise; } };
    const pending = f.bridge.request('thread/unarchive', { threadId: id });
    await entered.promise;
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id }), /Wait for the current chat change/);
    release.resolve(); await pending;
    assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 0);
    assert.equal(f.bridge.records.get(id).archived, false);
  } finally { release.resolve(); f.close(); }
});

function panelTools(f, { failure, prompt } = {}) {
  const original = f.bridge.native.request, opened = [];
  f.bridge.native.request = async (method, params) => {
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_app', runtimeStatus: 'ready', tools: {
      set_thread_archived: { name: 'set_thread_archived', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      open_in_codex: { name: 'open_in_codex', description: 'Open a file or browser panel in Codex', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } } } }] };
    if (method === 'config/read' && prompt) return { config: { mcp_servers: { codex_app: { default_tools_approval_mode: 'prompt' } } } };
    if (method === 'mcpServer/tool/call') {
      opened.push(structuredClone(params));
      if (failure) throw new Error(failure);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'queued', threadId: params.threadId }) }], isError: false };
    }
    return original(method, params);
  };
  const results = [];
  const call = calls => async ({ mcp }) => {
    const client = new Client({ name: 'panel-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.instance.connect(a), client.connect(b)]);
    try {
      for (const [tool, args] of calls) {
        await client.callTool({ name: 'find_tools', arguments: { query: tool } });
        results.push(await client.callTool({ name: 'call_tool', arguments: { name: toolName('codex_app', tool), arguments: args } }));
      }
    } finally { await client.close(); }
  };
  return { opened, results, call };
}

const panels = [['open_in_codex', { target: { type: 'file', path: 'synthetic-panel.md' } }],
  ['open_in_codex', { target: { type: 'browser', url: 'https://example.com' } }]];

test('queued panel receipts stay raw and bound to their chat; the next turn sees the current unarchived state', async () => {
  const f = fixture();
  try {
    const other = await f.start(), id = await f.start();
    const app = panelTools(f);
    f.controls.query = app.call([['set_thread_archived', { archived: true }]]);
    const archived = await f.send(id); await f.settled(archived.turn.id);
    assert.equal(f.bridge.records.get(id).archived, true);
    await assert.rejects(f.send(id), /Unarchive/);
    await f.bridge.request('thread/unarchive', { threadId: id });
    f.controls.query = app.call(panels);
    const sent = await f.send(id, 'SYNTHETIC OPEN PANELS'); await f.done(sent.turn.id);
    const prompt = f.queries.at(-1).systemPrompt;
    assert.match(prompt, /not archived when this turn started/);
    assert.match(prompt, /queued means the request was accepted/);
    assert.doesNotMatch(prompt, /verify the visible result/);
    assert.equal(app.opened.length, 2);
    for (const call of app.opened) {
      assert.equal(call.threadId, id); assert.notEqual(call.threadId, other);
      assert.equal(call._meta['x-codex-turn-metadata'].turn_id, sent.turn.id);
    }
    const receipt = { content: [{ type: 'text', text: JSON.stringify({ status: 'queued', threadId: id }) }], isError: false };
    assert.deepEqual(app.results.slice(-2).map(r => ({ content: r.content, isError: r.isError })), [receipt, receipt]);
    const turn = f.bridge.records.get(id).turns.find(t => t.id === sent.turn.id);
    const views = turn.items.filter(i => i.tool === 'open_in_codex');
    assert.deepEqual(views.map(v => [v.status, v.result]), [['completed', receipt], ['completed', receipt]]);
    assert.deepEqual(views.map(v => v.arguments), panels.map(([, args]) => args));
    assert.equal(f.bridge.records.get(id).archived, false); assert.equal(turn.status, 'completed');
  } finally { f.close(); }
});

test('panel requests keep native failure and approval denial visible without an invented receipt', async () => {
  for (const [options, expected] of [[{ failure: 'Synthetic panel dispatch rejected' }, /panel dispatch rejected/], [{ prompt: true }, /declined/]]) {
    const f = fixture();
    try {
      const id = await f.start(), app = panelTools(f, options);
      if (options.prompt) {
        f.bridge.records.get(id).approvalPolicy = 'on-request';
        f.bridge.desktop.request = async () => ({ action: 'decline' });
      }
      f.controls.query = app.call(panels.slice(0, 1));
      const sent = await f.send(id); await f.done(sent.turn.id);
      assert.equal(app.results[0].isError, true); assert.match(app.results[0].content[0].text, expected);
      assert.doesNotMatch(JSON.stringify(app.results), /queued/);
      assert.equal(app.opened.length, options.prompt ? 0 : 1);
      const view = f.bridge.records.get(id).turns[0].items.find(i => i.tool === 'open_in_codex');
      assert.equal(view.status, 'failed'); assert.equal(view.result, null);
    } finally { f.close(); }
  }
});

test('a message queued behind a held turn is announced and listed until its own turn accepts it', async () => {
  const f = fixture(), entered = gate(), release = gate();
  try {
    const id = await f.start();
    f.controls.query = async () => { entered.resolve(); await release.promise; };
    const first = await f.send(id, 'HELD'); await entered.promise;
    const before = f.events.length, input = [{ type: 'text', text: 'SYNTHETIC QUEUED' }];
    const { queuedSubmission } = await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'synthetic-queued', input });
    assert.deepEqual(queuedSubmission, { id: queuedSubmission.id, clientUserMessageId: 'synthetic-queued', input });
    assert.deepEqual(f.events.slice(before).map(e => [e.method, e.params]), [['thread/queue/changed', { threadId: id }]]);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await f.bridge.request('thread/queue/list', { threadId: id }), { data: [queuedSubmission], nextCursor: null });
    assert.equal(f.bridge.active.get(id).turn.id, first.turn.id);
    f.controls.query = undefined; release.resolve(); await f.done(first.turn.id);
    const started = await f.wait(e => e.method === 'turn/started' && e.params.turn.id !== first.turn.id);
    await f.done(started.params.turn.id);
    const after = f.events.slice(before + 1).map(e => e.method);
    const accepted = after.indexOf('thread/queue/changed');
    assert.ok(accepted > after.indexOf('turn/completed') && accepted < after.indexOf('turn/started', accepted));
    assert.deepEqual(await f.bridge.request('thread/queue/list', { threadId: id }), { data: [], nextCursor: null });
    const turn = f.bridge.records.get(id).turns.at(-1);
    assert.deepEqual([turn.status, turn.items[0].id, turn.items[0].content], ['completed', 'synthetic-queued', input]);
    assert.equal(f.queries.length, 2);
  } finally { release.resolve(); f.close(); }
});

test('each Claude turn announces its own user message once, so a queued message appears when its turn starts', async () => {
  const f = fixture(), entered = gate(), release = gate();
  const announced = turnId => f.events.filter(e => ['item/started', 'item/completed'].includes(e.method)
    && e.params.turnId === turnId && e.params.item.type === 'userMessage');
  try {
    const id = await f.start();
    f.controls.query = async () => { entered.resolve(); await release.promise; };
    const direct = [{ type: 'text', text: 'SYNTHETIC DIRECT' }], queued = [{ type: 'text', text: 'SYNTHETIC QUEUED' }];
    const first = await f.bridge.request('turn/start', { threadId: id, input: direct, clientUserMessageId: 'synthetic-direct' });
    await entered.promise;
    await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'synthetic-queued', input: queued });
    f.controls.query = undefined; release.resolve(); await f.done(first.turn.id);
    const started = await f.wait(e => e.method === 'turn/started' && e.params.turn.id !== first.turn.id);
    await f.done(started.params.turn.id);
    for (const [turnId, clientId, content] of [[first.turn.id, 'synthetic-direct', direct], [started.params.turn.id, 'synthetic-queued', queued]]) {
      const user = announced(turnId);
      assert.deepEqual(user.map(e => e.method), ['item/started', 'item/completed'], clientId);
      // Lifecycle times are checked by the contract test below.
      for (const { params: { startedAtMs, completedAtMs, ...rest } } of user)
        assert.deepEqual(rest, { threadId: id, turnId, item: { type: 'userMessage', id: clientId, clientId, content } });
      // turn/started, then the user's message, then Claude's answer.
      const position = predicate => f.events.findIndex(predicate);
      const turnStarted = position(e => e.method === 'turn/started' && e.params.turn.id === turnId);
      const userStarted = f.events.indexOf(user[0]);
      const answer = position(e => e.method === 'item/started' && e.params.turnId === turnId && e.params.item.type === 'agentMessage');
      assert.ok(turnStarted < userStarted && userStarted < answer, clientId);
      const stored = f.bridge.records.get(id).turns.find(t => t.id === turnId).items[0];
      assert.deepEqual([stored.id, stored.content], [clientId, content], 'canonical history holds the same message');
    }
    // A retried start returns the accepted turn without announcing its message again.
    const count = f.events.length;
    assert.equal((await f.bridge.request('turn/start', { threadId: id, input: direct, clientUserMessageId: 'synthetic-direct' })).turn.id, first.turn.id);
    assert.equal(f.events.length, count);
    // Steering keeps its own single announcement per steered message.
    const held = gate(), resume = gate();
    f.controls.query = async () => { held.resolve(); await resume.promise; };
    const third = await f.send(id, 'SYNTHETIC THIRD');
    await held.promise;
    const steer = [{ type: 'text', text: 'SYNTHETIC STEER' }];
    await f.bridge.request('turn/steer', { threadId: id, expectedTurnId: third.turn.id, input: steer, clientUserMessageId: 'synthetic-steer' });
    f.controls.query = undefined; resume.resolve(); await f.done(third.turn.id);
    assert.equal(announced(third.turn.id).filter(e => e.params.item.id === 'synthetic-steer').length, 2);
    assert.equal(announced(third.turn.id).length, 4, 'one started/completed pair each for the turn message and the steer');
    // An interrupted turn still shows the message it was given, exactly once.
    const blocked = gate(), unblock = gate();
    f.controls.query = async () => { blocked.resolve(); await unblock.promise; };
    const fourth = await f.bridge.request('turn/start', { threadId: id, input: direct, clientUserMessageId: 'synthetic-interrupted' });
    await blocked.promise;
    await f.bridge.request('turn/interrupt', { threadId: id, turnId: fourth.turn.id });
    f.controls.query = undefined; unblock.resolve(); await f.done(fourth.turn.id);
    assert.equal(f.bridge.records.get(id).turns.find(t => t.id === fourth.turn.id).status, 'interrupted');
    assert.deepEqual(announced(fourth.turn.id).map(e => [e.method, e.params.item.id]),
      [['item/started', 'synthetic-interrupted'], ['item/completed', 'synthetic-interrupted']]);
  } finally { release.resolve(); f.close(); }
});

// Codex CLI 0.163 ItemStartedNotification requires startedAtMs and
// ItemCompletedNotification requires completedAtMs (int64 Unix milliseconds).
test('item notifications carry their required Unix-millisecond lifecycle time, and native times are kept', async () => {
  const f = fixture(), held = gate(), resume = gate();
  try {
    const id = await f.start();
    f.controls.query = async () => { held.resolve(); await resume.promise; };
    const before = Date.now();
    const sent = await f.bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'SYNTHETIC TIMED' }], clientUserMessageId: 'synthetic-timed' });
    await held.promise;
    await f.bridge.request('turn/steer', { threadId: id, expectedTurnId: sent.turn.id,
      input: [{ type: 'text', text: 'SYNTHETIC TIMED STEER' }], clientUserMessageId: 'synthetic-timed-steer' });
    f.controls.query = undefined; resume.resolve(); await f.done(sent.turn.id);
    const after = Date.now();
    const items = f.events.filter(e => ['item/started', 'item/completed'].includes(e.method) && e.params.turnId === sent.turn.id);
    assert.deepEqual([...new Set(items.map(e => e.params.item.type))].sort(), ['agentMessage', 'userMessage'], 'opening, steered and answer items');
    const started = new Map();
    for (const { method, params } of items) {
      const [own, other] = method === 'item/started' ? ['startedAtMs', 'completedAtMs'] : ['completedAtMs', 'startedAtMs'];
      assert.ok(Number.isInteger(params[own]) && params[own] >= before && params[own] <= after, `${method} ${params.item.id}`);
      assert.equal(params[other], undefined, `${method} carries only its own lifecycle time`);
      if (method === 'item/started') started.set(params.item.id, params.startedAtMs);
      else assert.ok(params.completedAtMs >= started.get(params.item.id), `${params.item.id} completes after it starts`);
    }
    // A notification that native already timed is forwarded unchanged.
    const native = randomUUID(), turnId = randomUUID(), item = { type: 'agentMessage', id: randomUUID(), text: 'SYNTHETIC NATIVE' };
    await f.bridge.nativeNotification('item/started', { threadId: native, turnId, item, startedAtMs: 1000 });
    await f.bridge.nativeNotification('item/completed', { threadId: native, turnId, item, completedAtMs: 2000 });
    assert.deepEqual(f.events.filter(e => e.params.threadId === native).map(e => [e.method, e.params.startedAtMs ?? e.params.completedAtMs]),
      [['item/started', 1000], ['item/completed', 2000]]);
  } finally { resume.resolve(); f.close(); }
});
