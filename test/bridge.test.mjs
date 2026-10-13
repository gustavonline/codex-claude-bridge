import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Peer } from '../rpc.mjs';
import { Bridge } from '../bridge.mjs';
import { codexModels } from '../claude.mjs';
import { makeTools, toolName, availableSkills, instructions, allowedTool, requiresApproval, discover } from '../capabilities.mjs';
import { createLogger, errorMetadata } from '../logging.mjs';

test('diagnostic log correlates errors without retaining request, result or error content and rotates privately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-log-test-'));
  const secret = 'PRIVATE-PROMPT-sk-ant-api-test';
  const id = '33333333-3333-4333-8333-333333333333';
  const a = new PassThrough(), b = new PassThrough();
  const log = createLogger(directory);
  assert.equal(errorMetadata('trusted Node process exited unexpectedly').errorCategory, 'helper_startup');
  assert.equal(errorMetadata('untrusted-code-signing-identity').errorCategory, 'code_signing');
  assert.equal(errorMetadata('MCP server requires OAuth reauthentication').errorCategory, 'authentication');
  assert.equal(errorMetadata('No such file or directory (os error 2)').errorCategory, 'file_not_found');
  const client = new Peer(a, b, { name: 'native', log });
  const server = new Peer(b, a, { name: 'desktop', log, request: async method => {
    if (method === 'thread/resume') throw new Error(`no rollout found for thread id ${id}: ${secret}`);
    if (method === 'turn/start') return { turn: { id } };
    return { thread: { id }, text: secret, accessToken: secret };
  } });
  try {
    await client.request('thread/start', { input: [{ text: secret }], token: secret });
    await client.request('turn/start', { threadId: id, input: [{ text: secret }] });
    await assert.rejects(client.request('thread/resume', { threadId: id, command: secret }), /no rollout/);
    const pending = client.request('wait', {}, 60000); client.end();
    await assert.rejects(pending, /closed/);
    let text = readFileSync(log.path, 'utf8');
    assert.equal(text.includes(secret), false);
    const rows = text.trim().split('\n').map(JSON.parse);
    const failed = rows.find(r => r.status === 'failed' && r.method === 'thread/resume');
    assert.equal(failed.threadId, id); assert.equal(failed.errorCategory, 'rollout_not_found');
    assert.ok(failed.traceId); assert.equal(failed.errorFingerprint.length, 16);
    assert.ok(rows.some(r => r.event === 'rpc.start' && r.rpcId === failed.rpcId && r.traceId === failed.traceId));
    assert.ok(rows.filter(r => r.method === 'turn/start' && r.event === 'rpc.finish').every(r => r.threadId === id && r.turnId === id));
    assert.ok(rows.some(r => r.errorCategory === 'connection_closed'));
    assert.equal(statSync(log.path).mode & 0o777, 0o600);
    const rotating = createLogger(directory, { maxBytes: 500 });
    for (let i = 0; i < 12; i++) rotating('turn.error', { threadId: id, ...errorMetadata(new Error(secret)), input: secret, token: secret });
    assert.ok(statSync(log.path).size <= 500);
    assert.ok(statSync(log.path + '.1').size <= 500);
    text = readFileSync(log.path, 'utf8') + readFileSync(log.path + '.1', 'utf8');
    assert.equal(text.includes(secret), false);
    assert.equal(statSync(log.path + '.1').mode & 0o777, 0o600);
  } finally { client.end(); server.end(); a.destroy(); b.destroy(); rmSync(directory, { recursive: true, force: true }); }
});

test('first message uses live permissions before persistence and waits for changed permissions before starting Claude', async () => {
  for (const selected of [':danger-full-access', ':read-only', ':invalid']) {
    const statePath = mkdtempSync(join(tmpdir(), 'first-message-test-'));
    const id = '44444444-4444-4444-8444-444444444444';
    let bridge, calls = 0, permissionApplied = false, persisted = false, finish;
    const done = new Promise(resolve => { finish = resolve; });
    const native = { request: async (method, params) => {
      if (method === 'thread/start') return { thread: { id, cwd: statePath }, sandbox: { type: 'dangerFullAccess' },
        activePermissionProfile: { id: ':danger-full-access' }, approvalPolicy: 'never' };
      if (method === 'thread/resume') {
        if (!persisted) throw new Error(`no rollout found for thread id ${id}`);
        assert.equal(!!(params.permissions && params.sandbox), false);
        return { thread: { id, cwd: statePath }, sandbox: { type: permissionApplied ? 'readOnly' : 'dangerFullAccess' }, approvalPolicy: 'never' };
      }
      if (method === 'thread/inject_items') { persisted = true; return {}; }
      if (method === 'thread/settings/update') {
        if (params.permissions === ':invalid') throw new Error('Unknown permission profile');
        setImmediate(() => {
          bridge.nativeNotification('thread/settings/updated', { threadId: id, threadSettings: {
            sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: { id: ':danger-full-access' }, approvalPolicy: 'never',
          } });
          setImmediate(() => {
            permissionApplied = true;
            bridge.nativeNotification('thread/settings/updated', { threadId: id, threadSettings: {
              sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: { id: ':read-only' }, approvalPolicy: 'never',
            } });
          });
        });
        return {};
      }
      if (method === 'config/read') return { config: {} };
      return {};
    } };
    try {
      bridge = new Bridge({ native, desktop: { notify: method => { if (method === 'turn/completed') finish(); } }, statePath,
        getModels: async () => [{ value: 'opus' }], runQuery: ({ record }) => {
          calls++;
          if (selected === ':read-only') { assert.equal(permissionApplied, true); assert.equal(record.sandbox.type, 'readOnly'); }
          const stream = (async function* () { yield { type: 'result', subtype: 'success' }; })();
          stream.close = () => {}; return stream;
        } });
      await bridge.request('thread/start', { model: 'opus', ...(selected === ':read-only' ? { sandbox: 'danger-full-access' } : { permissions: ':danger-full-access' }) });
      const request = bridge.request('turn/start', { threadId: id, permissions: selected, input: [{ type: 'text', text: 'first message' }] });
      if (selected === ':invalid') {
        await assert.rejects(request, /Unknown permission/); assert.equal(calls, 0);
        assert.equal(bridge.records.get(id).turns.length, 0);
      } else {
        await request; await done;
        assert.equal(calls, 1); assert.equal(bridge.records.get(id).turns[0].status, 'completed');
        const restarted = new Bridge({ native, desktop: {}, statePath });
        await restarted.ensureLoaded(restarted.records.get(id));
        assert.equal(restarted.records.get(id).sandbox.type, permissionApplied ? 'readOnly' : 'dangerFullAccess');
      }
      assert.equal(bridge.settingsWaiters.size, 0);
    } finally { rmSync(statePath, { recursive: true, force: true }); }
  }
});

test('RPC preserves concurrent identities, remote errors and disconnects', async () => {
  const a = new PassThrough(), b = new PassThrough();
  const client = new Peer(a, b);
  const server = new Peer(b, a, { request: async (method, { value }) => {
    if (method === 'fail') throw new Error('real failure');
    await new Promise(resolve => setTimeout(resolve, value === 1 ? 20 : 1)); return value;
  } });
  assert.deepEqual(await Promise.all([client.request('echo', { value: 1 }), client.request('echo', { value: 2 })]), [1, 2]);
  await assert.rejects(client.request('fail', {}), /real failure/);
  const pending = client.request('wait', {}, 60000); client.end();
  await assert.rejects(pending, /closed/); server.end(); a.destroy(); b.destroy();
});

test('model picker uses only SDK-advertised reasoning levels', () => {
  const [model] = codexModels([{ value: 'opus', displayName: 'Opus', description: 'Test', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] }]);
  assert.deepEqual(model.supportedReasoningEfforts.map(e => e.reasoningEffort), ['low', 'high', 'max']);
  assert.equal(model.isDefault, true);
});

test('MCP relays real schemas, metadata, media and errors; shell retains Codex sandbox', async () => {
  const calls = [], events = [];
  const sandbox = { type: 'readOnly' };
  const spec = { name: 'read', description: 'Read a document', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  let disabled = false;
  const mcp = makeTools({ native: { request: async (method, params) => {
    if (method === 'config/read') return { config: { mcp_servers: { docs: { enabled: !disabled } } } };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'docs', tools: { read: spec } }] };
    calls.push({ method, params });
    return method === 'command/exec' ? { exitCode: 0, stdout: 'ok', stderr: '' }
      : { content: [{ type: 'text', text: 'native output' }], _meta: { test: true }, isError: false };
  } }, desktop: { request: async (method, params) => {
    calls.push({ method, params });
    return { success: false, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,YQ==' }] };
  } }, record: { thread: { id: 'thread', cwd: '/tmp' }, sandbox, options: { dynamicTools: [{ type: 'function', name: 'desktop', description: 'Desktop callback', inputSchema: { type: 'object' } }] } }, turn: { id: 'turn' },
    item: (phase, value) => events.push({ phase, value: structuredClone(value) }), signal: new AbortController().signal });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([mcp.instance.connect(left), client.connect(right)]);
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 5);
  assert.equal(JSON.stringify(listing).includes('Read a document'), false);
  const found = await client.callTool({ name: 'find_tools', arguments: { query: 'read document', limit: 1 } });
  const selected = JSON.parse(found.content[0].text).matches[0];
  assert.deepEqual(selected.inputSchema.required, ['path']);
  const result = await client.callTool({ name: 'call_tool', arguments: { name: selected.name, arguments: { path: '/allowed' } } });
  assert.equal(result._meta.test, true);
  assert.deepEqual(calls[0].params._meta['x-codex-turn-metadata'], { thread_id: 'thread', session_id: 'thread', turn_id: 'turn' });
  await client.callTool({ name: 'find_tools', arguments: { query: 'desktop' } });
  const dynamic = await client.callTool({ name: 'call_tool', arguments: { name: toolName('desktop', 'desktop'), arguments: {} } });
  assert.equal(dynamic.isError, true); assert.equal(dynamic.content[0].type, 'image');
  assert.equal(calls[1].method, 'item/tool/call');
  await client.callTool({ name: 'shell', arguments: { command: 'pwd', sandboxPolicy: { type: 'dangerFullAccess' } } });
  assert.deepEqual(calls[2].params.sandboxPolicy, sandbox);
  const bad = await client.callTool({ name: 'shell', arguments: { command: 'pwd', timeoutMs: -1 } });
  assert.equal(bad.isError, true); assert.equal(calls.length, 3);
  disabled = true;
  const removed = await client.callTool({ name: 'call_tool', arguments: { name: selected.name, arguments: { path: '/allowed' } } });
  assert.equal(removed.isError, true); assert.equal(calls.length, 3);
  assert.equal(events.filter(e => e.phase === 'started').length, events.filter(e => e.phase === 'completed').length);
  await client.close(); await mcp.instance.close();
});

test('GPT catalog, turns and opaque native history pages pass through without starting Claude', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'mixed-bridge-test-'));
  const calls = [];
  const native = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [{ id: 'gpt-test', model: 'gpt-test', isDefault: true }], nextCursor: null };
    if (method === 'thread/list') return { data: [{ id: 'gpt-thread', modelProvider: 'openai' }], nextCursor: 'native:opaque' };
    return { native: true, method, params };
  } };
  try {
    const bridge = new Bridge({ native, desktop: {}, statePath, getModels: async () => [{ value: 'opus' }], runQuery: () => { throw new Error('GPT must not start Claude'); } });
    const models = await bridge.request('model/list', {});
    assert.deepEqual(models.data.map(m => m.model), ['gpt-test', 'opus']);
    assert.equal(models.data.filter(m => m.isDefault).length, 1);
    assert.equal((await bridge.request('thread/start', { model: 'gpt-test' })).native, true);
    assert.equal((await bridge.request('turn/start', { threadId: 'gpt-thread', model: 'gpt-test', input: [] })).native, true);
    assert.equal((await bridge.request('thread/list', { cursor: 'native:start' })).nextCursor, 'native:opaque');
    assert.deepEqual(calls.at(-1).params.modelProviders, []);
    assert.equal(bridge.records.size, 0);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('skills respect disabled selectors and plugins; session prompt does not enumerate catalogs', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'skills-bridge-test-'));
  const native = { request: async method => {
    if (method === 'config/read') return { config: { skills: { config: [{ name: 'disabled-skill', enabled: false }] }, plugins: { 'disabled-plugin': { enabled: false } } } };
    if (method === 'skills/list') return { data: [{ skills: [
      { name: 'active-skill', path: '/tmp/active/SKILL.md', enabled: true, description: 'Test' },
      { name: 'disabled-skill', path: '/tmp/disabled/SKILL.md', enabled: true },
      { name: 'plugin-skill', enabled: true, pluginId: 'disabled-plugin' },
      { name: 'off', enabled: false },
    ] }] };
    throw new Error('Unexpected request');
  } };
  try {
    const record = { thread: { cwd: statePath }, options: { developerInstructions: 'Inherited instruction' }, instructionSources: [] };
    assert.deepEqual((await availableSkills(native, record)).map(s => s.name), ['active-skill']);
    const prompt = await instructions(native, record);
    assert.ok(prompt.includes('Inherited instruction'));
    assert.ok(!prompt.includes('active-skill'));
    assert.ok(!prompt.includes('disabled-skill'));
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('Codex app enablement and approval modes retain explicit overrides', () => {
  const spec = { name: 'notion.write', _meta: { connector_id: 'notion', link_id: 'account' }, annotations: { destructiveHint: false, openWorldHint: true } };
  const config = { apps: { notion: { enabled: false, tools: { 'notion.write': { enabled: true, approval_mode: 'approve' } } } } };
  assert.equal(allowedTool({ name: 'codex_apps' }, spec, config, {}), false);
  config.apps.notion.enabled = true;
  assert.equal(allowedTool({ name: 'codex_apps' }, spec, config, {}), true);
  assert.equal(requiresApproval(spec, 'codex_apps', config), false);
  config.apps.notion.tools['notion.write'].approval_mode = 'prompt';
  assert.equal(requiresApproval(spec, 'codex_apps', config), true);
  assert.equal(requiresApproval({ annotations: { readOnlyHint: true } }, 'docs', {}), false);
  assert.equal(requiresApproval({}, 'unknown', {}), true);
  assert.equal(requiresApproval({}, 'local', { apps: { _default: { default_tools_approval_mode: 'approve' } } }), true);
});

test('native full-access profiles preserve Codex MCP permission behavior without granting access to restricted profiles', async () => {
  const server = { name: 'codex_app', tools: { open: { name: 'open', inputSchema: { type: 'object' } } } };
  const config = { approval_policy: 'never' };
  const native = { request: async method => method === 'config/read' ? { config } : { data: [server] } };
  const record = { thread: { id: 'thread', cwd: '/tmp' }, options: {}, sandbox: { type: 'dangerFullAccess' } };
  assert.equal((await discover(native, record))[0].route.requiresApproval, false);
  for (const type of ['readOnly', 'workspaceWrite', undefined]) {
    record.sandbox = { type };
    assert.equal((await discover(native, record))[0].route.requiresApproval, true);
  }
  record.sandbox = { type: 'dangerFullAccess' }; record.approvalPolicy = 'on-request';
  assert.equal((await discover(native, record))[0].route.requiresApproval, true);
  record.approvalPolicy = 'never';
  config.mcp_servers = { codex_app: { enabled: false } };
  assert.equal((await discover(native, record)).length, 0);
});

test('decline, never and plugin removal during approval all prevent dispatch', async () => {
  let policy = 'on-request', answer = 'decline', enabled = true, executed = 0, prompts = 0;
  const spec = { name: 'write', description: 'Write a test document', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } };
  const native = { request: async method => {
    if (method === 'config/read') return { config: { approval_policy: policy, mcp_servers: { docs: { enabled } } } };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'docs', tools: { write: spec } }] };
    if (method === 'mcpServer/tool/call') { executed++; return { content: [] }; }
    throw new Error('Unexpected request');
  } };
  const mcp = makeTools({ native, desktop: { request: async () => {
    prompts++;
    if (answer === 'remove') enabled = false;
    return { action: answer === 'decline' ? 'decline' : 'accept', content: { approve: true } };
  } }, record: { thread: { id: 'test', cwd: '/tmp' }, options: {} }, turn: { id: 'turn' }, item: () => {}, signal: new AbortController().signal });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([mcp.instance.connect(left), client.connect(right)]);
  try {
    await client.callTool({ name: 'find_tools', arguments: { query: 'write document' } });
    const call = () => client.callTool({ name: 'call_tool', arguments: { name: toolName('docs', 'write'), arguments: {} } });
    assert.equal((await call()).isError, true); assert.equal(executed, 0); assert.equal(prompts, 1);
    policy = 'never'; answer = 'accept';
    assert.equal((await call()).isError, true); assert.equal(executed, 0); assert.equal(prompts, 1);
    policy = 'on-request'; answer = 'remove';
    assert.equal((await call()).isError, true); assert.equal(executed, 0);
    enabled = true; answer = 'accept';
    assert.equal((await call()).isError, undefined); assert.equal(executed, 1);
  } finally { await client.close(); await mcp.instance.close(); }
});

test('history cursors page and reverse around stable turn identities', () => {
  const statePath = mkdtempSync(join(tmpdir(), 'history-bridge-test-'));
  try {
    const bridge = new Bridge({ native: {}, desktop: {}, statePath });
    const record = { turns: ['one', 'two', 'three'].map(id => ({ id, items: [] })) };
    const first = bridge.turnPage(record, { limit: 2 });
    assert.deepEqual(first.data.map(t => t.id), ['three', 'two']);
    assert.deepEqual(bridge.turnPage(record, { cursor: first.nextCursor }).data.map(t => t.id), ['one']);
    assert.deepEqual(bridge.turnPage(record, { cursor: first.backwardsCursor, sortDirection: 'asc' }).data.map(t => t.id), ['three']);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('quota failures finish the turn once, retain the session, and resume after restart', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'codex-bridge-test-'));
  const events = [], nativeCalls = [];
  const metadata = { id: '11111111-1111-4111-8111-111111111111', cwd: statePath, ephemeral: false, preview: '' };
  const native = { request: async (method, params) => {
    nativeCalls.push(method);
    if (method === 'thread/start' || method === 'thread/resume') return { thread: metadata, sandbox: { type: 'readOnly' } };
    if (method === 'mcpServerStatus/list') return { data: [] };
    if (method === 'skills/list') return { data: [{ skills: [] }] };
    if (method === 'config/read') return { config: {} };
    return {};
  } };
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  const desktop = { notify: (method, params) => { events.push({ method, params }); if (method === 'turn/completed') completed(); } };
  const getModels = async () => [{ value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }];
  const runQuery = () => {
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'actual-claude-session' };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached'] };
    })(); stream.close = () => {}; return stream;
  };
  try {
    const bridge = new Bridge({ native, desktop, statePath, getModels, runQuery });
    const start = await bridge.request('thread/start', { cwd: statePath, model: 'opus' });
    await assert.rejects(bridge.request('turn/start', { threadId: metadata.id, input: [{ type: 'text', text: 'x' }], effort: 'ultra' }), /Unsupported effort/);
    const first = await bridge.request('turn/start', { threadId: start.thread.id, input: [{ type: 'text', text: 'hello' }], effort: 'low' });
    await assert.rejects(bridge.request('turn/start', { threadId: metadata.id, input: [{ type: 'text', text: 'duplicate' }] }), /already running/);
    await done;
    const endings = events.filter(e => e.method === 'turn/completed');
    assert.equal(endings.length, 1); assert.equal(endings[0].params.turn.id, first.turn.id);
    assert.equal(endings[0].params.turn.error.codexErrorInfo, 'usageLimitExceeded');
    assert.equal(bridge.records.get(metadata.id).claudeSessionId, 'actual-claude-session');
    const restarted = new Bridge({ native, desktop, statePath, getModels, runQuery });
    const resumed = await restarted.request('thread/resume', { threadId: metadata.id });
    assert.equal(resumed.thread.turns[0].status, 'failed');
    assert.equal(restarted.records.get(metadata.id).claudeSessionId, 'actual-claude-session');
    assert.equal(nativeCalls.includes('turn/start'), false);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('interrupt stops a pending Claude turn and emits a single interrupted completion', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'interrupt-bridge-test-'));
  const id = '22222222-2222-4222-8222-222222222222';
  let ready, finish;
  const started = new Promise(resolve => { ready = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const endings = [];
  const native = { request: async method => {
    if (method === 'thread/start') return { thread: { id, cwd: statePath, ephemeral: true }, sandbox: { type: 'readOnly' } };
    if (method === 'config/read') return { config: {} };
    return {};
  } };
  try {
    const bridge = new Bridge({ native, desktop: { notify: (method, params) => {
      if (method === 'turn/completed') { endings.push(params); finish(); }
    } }, statePath, getModels: async () => [{ value: 'opus', supportsEffort: false }], runQuery: ({ controller }) => {
      const stream = (async function* () {
        ready();
        await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'result', subtype: 'success' };
      })(); stream.close = () => {}; return stream;
    } });
    await bridge.request('thread/start', { model: 'opus' });
    const response = await bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'wait' }] });
    await started;
    await bridge.request('turn/interrupt', { threadId: id, turnId: response.turn.id });
    await done;
    assert.equal(endings.length, 1); assert.equal(endings[0].turn.status, 'interrupted');
    assert.equal(bridge.active.size, 0);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});
