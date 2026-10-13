import test from 'node:test';
import assert from 'node:assert/strict';
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
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: child.id, futureSetting: true }), /not supported/);
    assert.equal(f.calls.length, count);
  } finally { f.close(); }
});

async function archiveTool(f, args, { disabled = false, deny = false, nativeFailure = false, cancel = false, disableAfterDiscovery = false } = {}) {
  const original = f.bridge.native.request;
  let discoveries = 0;
  f.bridge.native.request = async (method, params) => {
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'codex_app', runtimeStatus: disabled || (disableAfterDiscovery && discoveries++ > 0) ? 'disabled' : 'ready',
      tools: { set_thread_archived: { name: 'set_thread_archived', description: 'Archive a chat',
        inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } } } }] };
    if (method === 'config/read' && (deny || cancel)) return { config: { mcp_servers: { codex_app: { default_tools_approval_mode: 'prompt' } } } };
    if (method === 'mcpServer/tool/call') throw new Error('Synthetic MCP transport closed');
    if (method === 'thread/archive' && nativeFailure) throw new Error('Synthetic native archive rejected');
    return original(method, params);
  };
  if (cancel) {
    for (const record of f.bridge.records.values()) record.approvalPolicy = 'on-request';
    f.bridge.desktop.request = async (_, params) => {
      f.bridge.active.get(params.threadId).controller.abort();
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
