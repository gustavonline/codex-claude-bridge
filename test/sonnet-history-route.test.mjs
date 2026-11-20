import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge, ProviderNativePool, connectNative } from '../bridge.mjs';
import { ProviderRegistry, localModelId, useDurability } from '../plugins/codex-claude/home/providers.mjs';
import { createCodec, historyBinding, historyInputSchema, historyNamespace, historyRef } from '../history-read.mjs';
import { sessionNamespace, sessionTools } from '../sessions.mjs';
import { fixture } from './support/fixture.mjs';
// The child-disabled runner forbids fsync; only there the router's own writes use a no-op (restored when this file ends).
test.after(useDurability(process.permission ? () => {} : undefined));

// ---- a synthetic conversation: >200 turns, the early fact in the 3rd -------------------------------------------------------------------------
const FACT = 'the launch code is PELICAN-7731', SECRET = 'OTHER-CHAT-SECRET-5520';
const user = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] });
const agent = (id, text) => ({ type: 'agentMessage', id, text, phase: null });
const plain = id => ({ id, status: 'completed', items: [user(id + '-u', `question ${id}`), agent(id + '-a', `answer ${id}`)] });
const CARRIED = Array.from({ length: 100 }, (_, i) => i === 2 ? { id: 'c-3', status: 'completed', items: [user('c-3-u', 'remember ' + FACT), agent('c-3-a', 'noted')] } : plain('c-' + (i + 1)));
// the runtime's own list repeats the last carried turn (same original turn ID, its own copy wins) and then continues
const OWN = [{ id: 'c-100', status: 'completed', items: [user('c-100-u', 'question c-100 (own copy)'), agent('c-100-a', 'answer c-100 (own copy)')] }, ...Array.from({ length: 119 }, (_, i) => plain('n-' + (i + 1)))];
const MERGED = [...CARRIED.slice(0, 99), OWN[0], ...OWN.slice(1)];
const ITEM_IDS = MERGED.flatMap(t => t.items.map(i => i.id));
const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

// ---- a public line-delimited seam: a Peer on one side, a scripted app-server on the other ----------------------------------------------------------
function fakeServer(label, handler) {
  const toBridge = new PassThrough(), fromBridge = new PassThrough(), seen = [], pending = new Map(); let sequence = 0;
  const frame = message => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
  createInterface({ input: fromBridge, crlfDelay: Infinity }).on('line', async line => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      seen.push({ method: message.method, params: structuredClone(message.params ?? {}) });
      try { toBridge.write(frame({ id: message.id, result: await handler(message.method, message.params ?? {}, server) })); }
      catch (error) { toBridge.write(frame({ id: message.id, error: { code: error.code ?? -32603, message: error.message } })); }
    } else if (message.method) seen.push({ method: message.method, params: message.params, notification: true });
    else { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const server = { label, seen, toBridge, fromBridge, threads: new Map(), starts: [], hold: null,
    notify: (method, params) => toBridge.write(frame({ method, params })),
    // one chunk: the notifications in `before` and the request arrive together, as a fast native may send them
    call: (method, params, before = []) => new Promise(resolve => { const id = 'srv-' + ++sequence; pending.set(id, resolve); toBridge.write([...before, { id, method, params }].map(frame).join('')); }) };
  return server;
}
const settings = (over = {}, { model = 'gpt-test', provider = 'openai', cwd } = {}) => ({ cwd, sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: null, disabledPluginIds: [],
  model, modelProvider: provider, serviceTier: null, effort: null, summary: null, collaborationMode: { mode: 'default', settings: { model, reasoning_effort: null, developer_instructions: null } }, multiAgentMode: 'explicitRequestOnly', personality: null, ...over });
const catalog = ids => (_u, _o, receive) => { const q = new EventEmitter(); q.destroy = () => {}; q.end = () => queueMicrotask(() => { const r = new EventEmitter(); r.statusCode = 200; r.destroy = () => {}; receive(r); r.emit('data', Buffer.from(JSON.stringify({ data: ids.map(id => ({ id })) }))); r.emit('end'); }); return q; };

async function world({ coordinate = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sonnet-history-route-')), ws = join(root, 'ws'), ws2 = join(root, 'ws2');
  mkdirSync(ws); mkdirSync(ws2); mkdirSync(join(root, 'rollouts'));
  const registry = new ProviderRegistry(root), a = registry.create({ name: 'Alpha endpoint', baseUrl: 'https://alpha.example.invalid/v1' }), b = registry.create({ name: 'Beta endpoint', baseUrl: 'https://beta.example.invalid/v1' });
  await registry.refresh(a, { request: catalog(['a1']) }); await registry.refresh(b, { request: catalog(['b1']) });
  const w = { root, ws, ws2, a, b, counter: 0, origins: new Map() };
  const handler = (provider, model) => async (method, p, server) => {
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { model: 'gpt-test', model_provider: 'openai' } };
    if (method === 'model/list') return { data: [{ id: 'gpt-test', model: 'gpt-test' }], nextCursor: null };
    if (method === 'thread/start') {
      const id = server.label + '-thread-' + ++w.counter; server.starts.push(structuredClone(p));
      const answer = { thread: { id, path: join(root, 'rollouts', id + '.jsonl'), cwd: p.cwd, status: { type: 'idle' }, turns: [], modelProvider: provider, model, forkedFromId: null, createdAt: 100, updatedAt: 100 }, model, modelProvider: provider, serviceTier: null,
        disabledPluginIds: [], cwd: p.cwd, runtimeWorkspaceRoots: [p.cwd], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
      // state: what the runtime itself reports from now on (a later resume answer); omit: required fields it fails to report
      server.threads.set(id, { turns: [], answer, state: {}, omit: [] });
      const out = structuredClone(answer); for (const key of server.omitOnStart ?? []) delete out[key];
      return out;
    }
    if (method === 'thread/resume') {
      const t = server.threads.get(p.threadId); if (!t) throw Object.assign(new Error('no rollout found for thread id ' + p.threadId), { code: -32600 });
      const out = { ...structuredClone(t.answer), ...structuredClone(t.state) }; for (const key of t.omit) delete out[key];
      return out;
    }
    if (method === 'turn/start') return { turn: { id: 'turn-from-rpc', status: 'inProgress', items: [] } };
    if (method === 'turn/interrupt') return {};
    if (method === 'thread/turns/list') {
      const all = server.threads.get(p.threadId)?.turns; if (!all) throw Object.assign(new Error('thread not loaded: ' + p.threadId), { code: -32600 });
      if (server.hold) await server.hold;
      const at = Number(p.cursor ?? 0), size = p.limit ?? 100;
      return { data: structuredClone(all.slice(at, at + size)), nextCursor: at + size < all.length ? String(at + size) : null };
    }
    throw Object.assign(new Error('unexpected ' + method), { code: -32601 });
  };
  w.main = fakeServer('N', handler('openai', 'gpt-test'));
  w.servers = { [a]: fakeServer('A', handler('bridge_custom_' + a, 'a1')), [b]: fakeServer('B', handler('bridge_custom_' + b, 'b1')) };
  let bridge;
  w.native = connectNative(() => bridge, w.main.toBridge, w.main.fromBridge);
  w.pool = new ProviderNativePool({ executable: '/synthetic/pinned-codex', args: ['app-server'], env: { PATH: '/usr/bin' }, initialization: () => ({ clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } }),
    request: (method, params, origin) => bridge.toolRequest(method, params, undefined, undefined, origin), notify: (method, params, origin) => bridge.nativeNotification(method, params, origin),
    observe: (phase, method, params, result, origin) => bridge?.observeNative(origin, phase, method, params, result),
    spawnProcess: (_exe, argv) => {
      const id = JSON.parse(argv.find(x => x.startsWith('model_provider=')).slice(15)).slice('bridge_custom_'.length), server = w.servers[id];
      const child = new EventEmitter(); child.stdout = server.toBridge; child.stdin = server.fromBridge; child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { if (child.signalCode !== null) return; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); };
      return child;
    } });
  bridge = new Bridge({ native: w.native, desktop: { notify() {}, request: async () => ({}) }, statePath: join(root, 'state'), connectionRoot: root, coordinateNative: coordinate,
    providerNative: (s, definition) => w.pool.get(s, definition), history: { checkpoint: async () => ({}), before: async () => undefined } });
  w.bridge = bridge; w.router = bridge.localResponses;
  // Remember the origin each transport passes to Bridge.toolRequest, so a test can replay a call with the very same transport identity (and with forged ones).
  const toolRequest = bridge.toolRequest.bind(bridge);
  bridge.toolRequest = (method, params, timeout, signal, origin) => { if (origin) w.origins.set(origin.kind === 'native' ? 'native' : origin.connectionId, origin); return toolRequest(method, params, timeout, signal, origin); };
  w.peers = {};
  for (const s of registry.all()) w.peers[s.connectionId] = await w.router.nativeForConnection(s, s.catalog.models[0]);
  w.close = () => { try { w.pool.stop(); } catch { /* already stopped */ } w.native.end(); rmSync(root, { recursive: true, force: true }); };
  return w;
}
let callCounter = 0;
// A chat as the model's runtime has it: a physical thread of a runtime, the conversation (logical) ID it belongs to, and the history it was given.
async function nativeChat(w, { logical, carried = [], own = [] } = {}) {
  const physical = (await w.bridge.request('thread/start', { model: 'gpt-test', cwd: w.ws })).thread.id;
  return link(w, { logical: logical ?? physical, physical, kind: 'native', server: w.main, carried, own });
}
async function customChat(w, { logical, connection = w.a, model = 'a1', carried = [], own = [] } = {}) {
  const physical = (await w.bridge.request('thread/start', { model: localModelId(connection, model), cwd: w.ws })).thread.id;
  return link(w, { logical: logical ?? physical, physical, kind: 'custom', server: w.servers[connection], connectionId: connection, carried, own });
}
function link(w, { logical, physical, kind, server, connectionId, carried, own }) {
  server.threads.get(physical).turns = structuredClone(own);
  if (carried.length) w.router.writeHandoff(physical, { version: 1, turns: structuredClone(carried) });
  if (logical !== physical) w.router.writeLink({ version: 1, logicalId: logical, physicalId: physical, kind, ...(connectionId ? { connectionId } : {}), model: kind === 'native' ? 'gpt-test' : 'a1', previous: [logical], path: null, archived: false });
  return { logical, physical, kind, server, connectionId, turnId: null };
}
async function begin(chat, turnId) {
  const turns = chat.server.threads.get(chat.physical).turns;
  for (const earlier of turns) if (earlier.status === 'inProgress') earlier.status = 'completed'; // the earlier turn finished before this one began
  chat.turnId = turnId; turns.push({ id: turnId, status: 'inProgress', items: [user(turnId + '-u', 'the question being answered right now')] });
  chat.server.notify('turn/started', { threadId: chat.physical, turn: { id: turnId, status: 'inProgress', items: [], itemsView: 'notLoaded' } }); await tick();
}
const callParams = (chat, args, over = {}) => ({ threadId: chat.physical, turnId: chat.turnId, callId: 'call-' + ++callCounter, namespace: historyNamespace, tool: 'read', arguments: args, ...over });
async function ask(chat, args = {}, { server = chat.server, params = {}, before } = {}) {
  const message = await server.call('item/tool/call', callParams(chat, args, params), before);
  assert.ok(message.result, JSON.stringify(message));
  return { success: message.result.success, ...JSON.parse(message.result.contentItems[0].text) };
}
async function pageAll(chat, args = {}) {
  const entries = []; let cursor, pages = 0;
  do {
    const page = await ask(chat, { limit: 20, maxCharacters: 20000, ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(page.success, true, JSON.stringify(page.error)); entries.push(...page.entries); cursor = page.nextCursor; assert.ok(++pages < 400, 'paging must end');
  } while (cursor);
  return entries;
}
const denied = async (promise, code) => { const out = await promise; assert.equal(out.success, false, JSON.stringify(out).slice(0, 200)); assert.equal(out.error.code, code, JSON.stringify(out.error)); return out; };
const files = dir => { const out = {}; const walk = d => { for (const name of readdirSync(d).sort()) { const path = join(d, name), stat = statSync(path); if (stat.isDirectory()) walk(path); else out[path.slice(dir.length)] = createHash('sha256').update(readFileSync(path)).digest('hex'); } }; walk(dir); return out; };

// ---- 1. the conversation survives three runtimes: the exact early fact comes back through each route's own handler ----------------------------------------
test('NATIVE main thread: >200 carried + own turns of one conversation; the exact early fact comes back through item/tool/call → Peer → Bridge.toolRequest; carried/own deduped; the running turn is excluded', async t => {
  const w = await world(); t.after(w.close);
  const chat = await nativeChat(w, { logical: 'logical-native', carried: CARRIED, own: OWN }); await begin(chat, 'turn-now');
  assert.equal(MERGED.length, 219);
  const entries = await pageAll(chat);
  assert.deepEqual(entries.map(e => e.itemId), ITEM_IDS);
  const fact = entries.filter(e => e.text.includes('PELICAN-7731')); assert.equal(fact.length, 1); assert.equal(fact[0].turnId, 'c-3'); assert.equal(fact[0].role, 'user');
  assert.equal(entries.find(e => e.itemId === 'c-100-u').text, 'question c-100 (own copy)'); // the same original turn is one turn: the runtime's own copy
  assert.equal(entries.some(e => e.text.includes('being answered right now')), false); // the active turn is not part of its own history
  const newest = await ask(chat, { direction: 'desc', limit: 2 }); assert.deepEqual(newest.entries.map(e => e.itemId), ['n-119-a', 'n-119-u']);
  const small = await pageAll(chat, { limit: 7, maxCharacters: 256, direction: 'desc' }); assert.deepEqual(small.map(e => e.itemId), [...ITEM_IDS].reverse());
  assert.equal(JSON.stringify(newest).includes('tokens'), false);
  // the logical chat is the one the tool reports against: a cursor made here is bound to it
  const first = await ask(chat, { limit: 3 }); assert.ok(first.nextCursor);
  const other = await nativeChat(w, { logical: 'logical-other', own: [plain('o-1')] }); await begin(other, 'turn-other');
  await denied(ask(other, { cursor: first.nextCursor }), 'cursor_mismatch');
});

test('CUSTOM provider thread (real ProviderNativePool peer): the same conversation, read from the owning connection; the early fact comes back; start carried the namespace', async t => {
  const w = await world(); t.after(w.close);
  const chat = await customChat(w, { logical: 'logical-custom', carried: CARRIED, own: OWN }); await begin(chat, 'turn-now');
  const entries = await pageAll(chat);
  assert.deepEqual(entries.map(e => e.itemId), ITEM_IDS);
  assert.equal(entries.filter(e => e.text.includes('PELICAN-7731'))[0].turnId, 'c-3');
  assert.equal(w.servers[w.a].seen.some(c => c.method === 'thread/turns/list' && c.params.threadId === chat.physical), true); // asked of the connection that owns the thread
  assert.equal(w.main.seen.some(c => c.method === 'thread/turns/list'), false); // never the main process, which does not hold it
  const start = w.servers[w.a].starts[0];
  assert.deepEqual(start.dynamicTools.map(d => [d.type, d.name, d.tools.map(x => [x.name, x.deferLoading])]), [['namespace', historyNamespace, [['read', true]]]]);
  assert.equal(start.modelProvider, 'bridge_custom_' + w.a);
});

test('CLAUDE SDK chat: >200 turns, the early fact through the real MCP server handler over a transport; discovery lists the five original tools plus read_history; spoofed arguments reach nothing', async t => {
  const f = fixture(); t.after(() => f.close());
  const id = await f.start('sonnet'), other = await f.start('sonnet');
  const record = f.bridge.records.get(id), foreign = f.bridge.records.get(other);
  record.runtimeWorkspaceRoots = [f.statePath]; record.instructionSources = [join(f.statePath, 'AGENTS.md')]; record.claudeSessionId = 'session-1'; // (the roots its host's start answer confirmed) // (no workspace file is read outside the test directory; no carried-context build)
  record.turns = structuredClone(MERGED).map(turn => ({ ...turn, provider: 'imported' }));
  foreign.turns = [{ ...plain('x-1'), items: [user('x-1-u', SECRET), agent('x-1-a', 'noted')] }];
  const preloaded = JSON.stringify(record.turns); f.bridge.save(record);
  const out = { pages: [] };
  f.controls.query = async args => {
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); await args.mcp.instance.connect(serverSide);
      const client = new Client({ name: 'history-test', version: '1' }); await client.connect(clientSide);
      out.tools = (await client.listTools()).tools;
      const call = async (name, argumentsObject) => { const r = await client.callTool({ name, arguments: argumentsObject }); return { isError: !!r.isError, body: JSON.parse(r.content[0].text) }; };
      let cursor;
      do { const r = await call('read_history', { limit: 20, maxCharacters: 20000, ...(cursor ? { cursor } : {}) }); out.pages.push(r); cursor = r.body.nextCursor; } while (cursor && out.pages.length < 100);
      out.unknown = await call('read_history', { limit: 2, threadId: other });
      out.spoofPath = await call('read_history', { path: '/etc/passwd', provider: 'claude_code', profile: 'x' });
      out.desc = await call('read_history', { direction: 'desc', limit: 2 });
      out.found = await call('find_tools', { query: 'read bridge sessions' });
      out.running = f.bridge.active.get(id); out.turn = out.running.turn;
      await client.close();
    } catch (error) { out.error = error; }
  };
  const sent = await f.send(id, 'what was the launch code?'); await f.done(sent.turn.id); await f.settled(sent.turn.id);
  assert.equal(out.error, undefined, String(out.error?.stack));
  assert.deepEqual(out.tools.map(x => x.name), ['find_tools', 'call_tool', 'find_skills', 'read_skill', 'shell', 'read_history']); // the five original tools are unchanged, in order
  assert.deepEqual(out.tools.at(-1).inputSchema, historyInputSchema);
  assert.ok(out.pages.every(p => !p.isError), JSON.stringify(out.pages.find(p => p.isError)));
  const entries = out.pages.flatMap(p => p.body.entries); assert.deepEqual(entries.map(e => e.itemId), ITEM_IDS);
  assert.equal(entries.filter(e => e.text.includes('PELICAN-7731'))[0].turnId, 'c-3');
  assert.equal(JSON.stringify(out.pages).includes(SECRET), false); assert.equal(JSON.stringify(out.pages).includes('what was the launch code'), false); // another chat, and the running turn, are not here
  assert.equal(out.unknown.isError, true); assert.equal(out.unknown.body.error.code, 'invalid_arguments');
  assert.equal(out.spoofPath.body.error.code, 'invalid_arguments');
  assert.deepEqual(out.desc.body.entries.map(e => e.itemId), ['n-119-a', 'n-119-u']);
  assert.equal(out.found.isError, false); assert.ok(Array.isArray(out.found.body.matches)); // the existing discovery still answers
  // the transcript records THAT a read happened, never its output (reads must not grow the history they read)
  const saved = f.bridge.records.get(id), calls = saved.turns.at(-1).items.filter(i => i.type === 'mcpToolCall' && i.tool === 'read_history');
  assert.ok(calls.length >= 20); assert.equal(calls.every(c => /^\[history read: \d+ entries; output not repeated here\]$|invalid_arguments/.test(c.result.content[0].text)), true);
  assert.equal(JSON.stringify(calls).includes('PELICAN'), false);
  assert.equal(JSON.stringify(saved.turns.slice(0, MERGED.length)), preloaded); // the conversation's bytes: unchanged by reads
  // a closure outlives its turn only as a refusal
  const late = await f.bridge.sdkHistory(saved, out.running, out.turn, new AbortController().signal)({});
  assert.equal(late.error.code, 'turn_not_current');
  assert.equal(sessionNamespace, 'codex_bridge_sessions');
  assert.deepEqual(sessionTools.tools.map(x => x.name), ['read', 'manage', 'mailbox']); // sessions.manage is not expanded; mailbox carries correlated child-to-creator messages
  assert.deepEqual(sessionTools.tools[1].inputSchema.properties.operation.enum, ['create', 'send', 'queue', 'start_queue', 'interrupt', 'fork']);
  assert.deepEqual(f.calls.find(c => c.method === 'thread/start').params.dynamicTools.map(d => d.name), ['codex_bridge_sessions']); // a Claude chat's host keeps its session tools; the SDK gets read_history directly
});

// ---- 2. the tool is advertised on every new runtime thread --------------------------------------------------------------------------------------------
test('ADVERTISING: every new native, custom and hand-off-target thread/start carries the namespace beside existing dynamic tools; the reserved name is refused; resume is untouched', async t => {
  const w = await world(); t.after(w.close);
  const desktopTool = { type: 'function', name: 'desktop_tool', description: 'x', inputSchema: { type: 'object', properties: {} } };
  await w.bridge.request('thread/start', { model: 'gpt-test', cwd: w.ws, dynamicTools: [desktopTool] });
  await w.bridge.request('thread/start', { model: localModelId(w.a, 'a1'), cwd: w.ws, dynamicTools: [desktopTool] });
  // exactly the call a hand-off to a GPT target makes (the router's `forward`): a localRouted thread/start
  await w.bridge.request('thread/start', { model: 'gpt-test', cwd: w.ws, modelProvider: 'openai' }, { localRouted: true });
  const names = start => start.dynamicTools.map(d => d.name);
  assert.deepEqual(w.main.starts.map(names), [['desktop_tool', historyNamespace], [historyNamespace]]);
  assert.deepEqual(w.servers[w.a].starts.map(names), [['desktop_tool', historyNamespace]]);
  for (const start of [...w.main.starts, ...w.servers[w.a].starts]) assert.deepEqual(start.dynamicTools.at(-1), { ...start.dynamicTools.at(-1), type: 'namespace', name: historyNamespace });
  for (const call of [{ model: 'gpt-test' }, { model: localModelId(w.a, 'a1') }])
    await assert.rejects(w.bridge.request('thread/start', { ...call, cwd: w.ws, dynamicTools: [{ type: 'namespace', name: historyNamespace, tools: [] }] }), e => e.code === -32602 && /Reserved/.test(e.message));
  assert.equal(w.main.starts.length, 2); assert.equal(w.servers[w.a].starts.length, 1); // refused before anything reached a runtime
  // primary (coordinating) mode: the session tools stay, the history tool is added after them
  const primary = await world({ coordinate: true }); t.after(primary.close);
  await primary.bridge.request('thread/start', { model: 'gpt-test', cwd: primary.ws, dynamicTools: [desktopTool] });
  assert.deepEqual(primary.main.starts.map(names), [['desktop_tool', sessionNamespace, historyNamespace]]);
  // thread/resume has no dynamicTools in the pinned contract and none is invented
  const thread = (await w.bridge.request('thread/start', { model: 'gpt-test', cwd: w.ws })).thread.id;
  assert.equal(w.main.seen.filter(c => c.method !== 'thread/start' && c.params.dynamicTools).length, 0); assert.ok(thread);
});

// ---- 3. who may call: trusted transport, current turn, current runtime, confirmed scope -----------------------------------------------------------------
test('NATIVE caller denials: unknown argument, no / other / finished / replaced turn, other thread, changed workspace or permission, unknown scope, stale physical thread; recovery is honest', async t => {
  const w = await world(); t.after(w.close);
  const chat = await nativeChat(w, { logical: 'logical-d', own: [plain('t-1'), plain('t-2')] }), stranger = await nativeChat(w, { own: [plain('s-1')] });
  chat.turnId = 'turn-0'; await denied(ask(chat, {}), 'turn_not_current'); // no turn has been seen on this connection for this thread
  await begin(chat, 'turn-1');
  assert.equal((await ask(chat, {})).success, true);
  await denied(ask(chat, { threadId: stranger.physical }), 'invalid_arguments'); // a model argument names nothing
  await denied(ask(chat, {}, { params: { turnId: 'turn-announced-by-nobody' } }), 'turn_not_current');
  await denied(ask(chat, {}, { params: { threadId: stranger.physical } }), 'turn_not_current'); // another thread of the same connection with no live turn
  await begin(stranger, 'turn-s'); // a live turn of the stranger does not make this call the stranger's: the thread named is the thread read
  const read = await ask(chat, { limit: 20, maxCharacters: 20000 }); assert.equal(JSON.stringify(read).includes('question s-1'), false);
  assert.equal((await ask(chat, {}, { params: { threadId: stranger.physical, turnId: 'turn-1' } })).error.code, 'turn_not_current');
  // workspace and permissions: captured at turn start, compared on every read
  const event = over => { chat.server.notify('thread/settings/updated', { threadId: chat.physical, threadSettings: settings({ cwd: w.ws, ...over }) }); return tick(); };
  const reconfirm = () => w.bridge.request('thread/resume', { threadId: chat.physical }); // the runtime's OWN answer, with its confirmed roots
  await event({ cwd: w.ws2 }); await denied(ask(chat, {}), 'scope_unconfirmed'); // a settings event carries no roots: a changed workspace has none confirmed
  await event({}); await denied(ask(chat, {}), 'scope_unconfirmed'); // and a later event cannot bring roots back from nothing
  await reconfirm(); assert.equal((await ask(chat, {})).success, true); // only the runtime's own start / resume answer does: back to what the turn started under
  await event({ sandboxPolicy: { type: 'dangerFullAccess' } }); await denied(ask(chat, {}), 'scope_changed');
  await event({ approvalPolicy: 'on-request' }); await denied(ask(chat, {}), 'scope_changed');
  await event({ activePermissionProfile: { id: ':workspace' } }); await denied(ask(chat, {}), 'scope_changed');
  await event({ disabledPluginIds: ['plugin'] }); await denied(ask(chat, {}), 'scope_changed');
  await event({}); assert.equal((await ask(chat, {})).success, true);
  chat.server.notify('thread/settings/updated', { threadId: chat.physical, threadSettings: { cwd: w.ws, model: 'gpt-test' } }); await tick(); // an incomplete event: the scope is unknown, never guessed from the cwd
  await denied(ask(chat, {}), 'scope_unconfirmed');
  // a new turn captures the scope that is confirmed at ITS start; an unconfirmed one refuses for that whole turn
  await event({}); await denied(ask(chat, {}), 'scope_unconfirmed'); // (an event cannot resurrect what an incomplete event dropped)
  await reconfirm(); await begin(chat, 'turn-2'); assert.equal((await ask(chat, {})).success, true);
  await denied(ask(chat, {}, { params: { turnId: 'turn-1' } }), 'turn_not_current'); // a replaced turn is no longer the caller
  // finished
  chat.server.notify('turn/completed', { threadId: chat.physical, turn: { id: 'turn-2', status: 'completed', items: [], itemsView: 'notLoaded' } }); await tick();
  await denied(ask(chat, {}), 'turn_not_current');
  // an old physical thread of the conversation: the link now points elsewhere
  await begin(chat, 'turn-3'); assert.equal((await ask(chat, {})).success, true);
  const current = w.router.readLink('logical-d');
  w.router.writeLink({ ...current, physicalId: 'physical-next', previous: ['logical-d', chat.physical] }, current);
  await denied(ask(chat, {}), 'stale_runtime');
});

test('NATIVE: a turn that never had a confirmed scope, a managed record, an unannounced thread, and a notification race (turn/started and the call in ONE chunk) are all decided from observed transport facts', async t => {
  const w = await world(); t.after(w.close);
  // a thread that this connection never started or resumed: its first turn has no confirmed scope
  const ghost = { logical: 'ghost-thread', physical: 'ghost-thread', kind: 'native', server: w.main, turnId: 'ghost-turn' };
  w.main.threads.set('ghost-thread', { turns: [plain('g-1')] });
  w.main.notify('turn/started', { threadId: 'ghost-thread', turn: { id: 'ghost-turn', status: 'inProgress', items: [] } }); await tick();
  await denied(ask(ghost, {}), 'scope_unconfirmed');
  // a Bridge-managed chat's host thread is never a history caller
  const host = { logical: 'host-thread', physical: 'host-thread', kind: 'native', server: w.main, turnId: 'host-turn' };
  w.bridge.records.set('host-thread', { thread: { id: 'host-thread' }, turns: [], options: {}, queue: [] });
  w.main.notify('turn/started', { threadId: 'host-thread', turn: { id: 'host-turn', status: 'inProgress', items: [] } }); await tick();
  await denied(ask(host, {}), 'turn_not_current');
  // the notification and the call arrive in one chunk, in order: the turn is known by the time the call is handled
  const chat = await nativeChat(w, { own: [plain('r-1')] }); chat.turnId = 'turn-race';
  w.main.threads.get(chat.physical).turns.push({ id: 'turn-race', status: 'inProgress', items: [user('r-u', 'now')] });
  const raced = await ask(chat, {}, { before: [{ method: 'turn/started', params: { threadId: chat.physical, turn: { id: 'turn-race', status: 'inProgress', items: [] } } }] });
  assert.equal(raced.success, true); assert.deepEqual(raced.entries.map(e => e.itemId), ['r-1-u', 'r-1-a']);
  // an answer to turn/start is not a turn: only a turn/started that arrived on this connection counts
  chat.turnId = 'turn-from-an-rpc-answer'; await denied(ask(chat, {}), 'turn_not_current');
});

test('CUSTOM caller denials: a foreign custom peer, the main process, a forged origin, an aborted call and a turn ended while reading; another connection\'s events change nothing', async t => {
  const w = await world(); t.after(w.close);
  const chat = await customChat(w, { logical: 'logical-c', own: [plain('t-1')] }); await begin(chat, 'turn-1');
  assert.equal((await ask(chat, {})).success, true);
  const other = await customChat(w, { connection: w.b, model: 'b1', own: [plain('b-1')] }); await begin(other, 'turn-b');
  // connection B (and the main process) calling for connection A's thread, even after announcing a turn of its own for that ID
  const B = w.servers[w.b];
  await denied(ask(chat, {}, { server: B }), 'foreign_peer');
  B.threads.set(chat.physical, { turns: [plain('evil')] }); B.notify('turn/started', { threadId: chat.physical, turn: { id: 'turn-1', status: 'inProgress', items: [] } }); await tick();
  await denied(ask(chat, {}, { server: B }), 'foreign_peer');
  await denied(ask(chat, {}, { server: w.main }), 'foreign_peer');
  assert.equal((await ask(chat, {})).success, true); // B's announcement for a thread it does not run is not evidence: the rightful peer's live turn stands
  await begin(chat, 'turn-2'); const mine = await ask(chat, { limit: 20, maxCharacters: 20000 }); assert.equal(mine.success, true); assert.equal(JSON.stringify(mine).includes('evil'), false);
  // B's settings events for A's thread change nothing A is held to
  B.notify('thread/settings/updated', { threadId: chat.physical, threadSettings: settings({ cwd: w.ws2 }, { model: 'a1', provider: 'bridge_custom_' + w.a }) }); await tick();
  assert.equal((await ask(chat, {})).success, true);
  // a custom connection calling for a native thread, and a native call for a custom one
  const native = await nativeChat(w, { own: [plain('n-1')] }); await begin(native, 'turn-n');
  await denied(ask(native, {}, { server: w.servers[w.a] }), 'foreign_peer');
  // forged transport identities replayed through the very entry the Peers use
  const params = callParams(chat, {}), call = (origin, signal) => w.bridge.toolRequest('item/tool/call', params, undefined, signal, origin).then(r => JSON.parse(r.contentItems[0].text));
  const real = w.origins.get(w.a), nativeOrigin = w.origins.get('native');
  assert.equal(real.kind, 'custom'); assert.equal(real.peer, w.peers[w.a]); assert.equal(Object.isFrozen(real), true); // bound at creation to the actual Peer object
  assert.equal((await call(real)).error, undefined);
  assert.equal((await call(undefined)).error.code, 'caller_unverified');
  assert.equal((await call({})).error.code, 'caller_unverified');
  assert.equal((await call({ kind: 'custom', connectionId: w.a, peer: { request: async () => ({}) } })).error.code, 'caller_unverified'); // not a Peer of this Bridge
  assert.equal((await call({ kind: 'native', connectionId: null, peer: w.peers[w.a] })).error.code, 'caller_unverified');
  assert.equal((await call({ kind: 'custom', connectionId: w.a, peer: nativeOrigin.peer })).error.code, 'caller_unverified'); // the main process cannot claim a custom identity
  assert.equal((await call({ kind: 'custom', connectionId: w.a, peer: w.peers[w.b] })).error.code, 'foreign_peer'); // a real peer claiming another connection's name
  assert.equal((await call({ kind: 'custom', connectionId: w.b, peer: w.peers[w.b] })).error.code, 'foreign_peer');
  assert.equal((await call(nativeOrigin)).error.code, 'foreign_peer');
  const aborted = new AbortController(); aborted.abort(new Error('stop')); assert.equal((await call(real, aborted.signal)).error.code, 'aborted');
  // a turn that ends while the history is being read returns nothing
  const gate = Promise.withResolvers(); w.servers[w.a].hold = gate.promise;
  const inFlight = ask(chat, {}); await tick(60);
  w.servers[w.a].notify('turn/completed', { threadId: chat.physical, turn: { id: 'turn-2', status: 'interrupted', items: [], itemsView: 'notLoaded' } }); await tick();
  gate.resolve(); w.servers[w.a].hold = null;
  const result = await inFlight; assert.equal(result.success, false); assert.equal(result.error.code, 'aborted'); assert.equal(JSON.stringify(result).includes('question t-1'), false);
});

test('LIFETIME: a stop, an unload or a close ends the caller; a turn that asks for a different workspace or permission leaves the scope unconfirmed until the runtime itself confirms it', async t => {
  const w = await world(); t.after(w.close);
  const chat = await nativeChat(w, { own: [plain('t-1')] });
  const settle = (over = {}) => { chat.server.notify('thread/settings/updated', { threadId: chat.physical, threadSettings: settings({ cwd: w.ws, ...over }) }); return tick(); };
  // (the Peer sees the Bridge's own outbound requests, so every request below goes through the real Bridge.request → router → Peer path)
  // a request that repeats what the thread already runs under changes nothing
  await w.bridge.request('turn/start', { threadId: chat.physical, input: [{ type: 'text', text: 'again' }], cwd: w.ws, runtimeWorkspaceRoots: [w.ws], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, approvalsReviewer: 'user' });
  await begin(chat, 'turn-1'); assert.equal((await ask(chat, {})).success, true);
  // a request for another workspace: nothing confirms it yet, so the next turn has no confirmed scope (never guessed from the request)
  await w.bridge.request('turn/start', { threadId: chat.physical, input: [{ type: 'text', text: 'elsewhere' }], cwd: w.ws2 });
  await begin(chat, 'turn-2'); await denied(ask(chat, {}), 'scope_unconfirmed');
  await settle({ cwd: w.ws2 }); await begin(chat, 'turn-3'); await denied(ask(chat, {}), 'scope_unconfirmed'); // a settings event has no roots: the dropped confirmation does not come back from it
  chat.server.threads.get(chat.physical).state = { cwd: w.ws2, runtimeWorkspaceRoots: [w.ws2] };
  await w.bridge.request('thread/resume', { threadId: chat.physical }); await begin(chat, 'turn-3b'); assert.equal((await ask(chat, {})).success, true); // the runtime's OWN answer confirmed it; THIS turn started under it
  await w.bridge.request('turn/start', { threadId: chat.physical, input: [{ type: 'text', text: 'wider' }], sandboxPolicy: { type: 'dangerFullAccess' } });
  await begin(chat, 'turn-4'); await denied(ask(chat, {}), 'scope_unconfirmed');
  await settle({ cwd: w.ws2, sandboxPolicy: { type: 'dangerFullAccess' } }); await begin(chat, 'turn-5'); assert.equal((await ask(chat, {})).success, true);
  // stop
  await w.bridge.request('turn/interrupt', { threadId: chat.physical, turnId: 'turn-5' }); await denied(ask(chat, {}), 'turn_not_current');
  await begin(chat, 'turn-6'); assert.equal((await ask(chat, {})).success, true);
  await w.bridge.request('turn/interrupt', { threadId: chat.physical, turnId: 'not-the-running-turn' }); assert.equal((await ask(chat, {})).success, true); // another turn's stop is not this one's
  // unload / close
  await w.bridge.request('thread/unsubscribe', { threadId: chat.physical }).catch(() => {}); await denied(ask(chat, {}), 'turn_not_current');
  await begin(chat, 'turn-7'); assert.equal((await ask(chat, {})).success, true);
  chat.server.notify('thread/closed', { threadId: chat.physical }); await tick();
  await denied(ask(chat, {}), 'turn_not_current');
  await begin(chat, 'turn-8'); await denied(ask(chat, {}), 'scope_unconfirmed'); // a closed thread forgot its scope: the next resume / start answer must confirm it again
  // a peer that closed is no caller at all
  const custom = await customChat(w, { own: [plain('c-1')] }); await begin(custom, 'turn-c'); assert.equal((await ask(custom, {})).success, true);
  const origin = w.origins.get(w.a); w.peers[w.a].end();
  assert.equal(JSON.parse((await w.bridge.toolRequest('item/tool/call', callParams(custom, {}), undefined, undefined, origin)).contentItems[0].text).error.code, 'caller_unverified');
});

// ---- 3b. the scope is the cwd, the FULL sandbox policy AND the runtime's own confirmed workspace roots ---------------------------------------------------------
for (const kind of ['native', 'custom']) test(`SCOPE ROOTS (${kind}): a roots-only or same-type policy change is never read under the old scope; only the runtime's own answer confirms roots; unknown or malformed roots are unconfirmed; an unchanged override keeps reads working`, async t => {
  const w = await world(); t.after(w.close);
  const chat = await (kind === 'native' ? nativeChat(w, { own: [plain('t-1')] }) : customChat(w, { own: [plain('t-1')] }));
  const thread = () => chat.server.threads.get(chat.physical), extra = w.ws2;
  const identity = kind === 'native' ? {} : { model: 'a1', provider: 'bridge_custom_' + w.a };
  const settle = over => { chat.server.notify('thread/settings/updated', { threadId: chat.physical, threadSettings: settings({ cwd: w.ws, ...over }, { cwd: w.ws, ...identity }) }); return tick(); };
  const resume = (state = {}, omit = []) => { Object.assign(thread(), { state: { runtimeWorkspaceRoots: [w.ws], ...state }, omit }); return w.bridge.request('thread/resume', { threadId: chat.physical }); }; // the runtime's own answer
  const request = over => w.bridge.request('turn/start', { threadId: chat.physical, input: [{ type: 'text', text: 'again' }], ...over });
  const write = (roots = [w.ws]) => ({ type: 'workspaceWrite', writableRoots: roots, networkAccess: false });
  let n = 0; const turn = () => begin(chat, 'turn-' + ++n);
  await turn(); assert.equal((await ask(chat, {})).success, true);
  // an override that repeats exactly what the runtime confirmed changes nothing
  await request({ cwd: w.ws, runtimeWorkspaceRoots: [w.ws], sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', permissions: undefined, disabledPluginIds: [] });
  assert.equal((await ask(chat, {})).success, true);
  // roots only (same cwd, same sandbox type, same profile): the confirmation is dropped BEFORE the request is sent; an event (no roots in it) cannot bring it back
  await request({ runtimeWorkspaceRoots: [w.ws, extra] }); await denied(ask(chat, {}), 'scope_unconfirmed');
  await settle({}); await denied(ask(chat, {}), 'scope_unconfirmed');
  await turn(); await denied(ask(chat, {}), 'scope_unconfirmed'); // a turn that starts unconfirmed stays refused for its whole life
  // the runtime's OWN answer (with its roots) confirms; a turn started under it reads; the same cwd/type/profile with other roots is a changed scope
  await resume({ runtimeWorkspaceRoots: [w.ws, extra] }); await turn(); assert.equal((await ask(chat, {})).success, true);
  await resume({ runtimeWorkspaceRoots: [w.ws] }); await denied(ask(chat, {}), 'scope_changed');
  await resume({ runtimeWorkspaceRoots: [w.ws, extra] }); assert.equal((await ask(chat, {})).success, true); // back to what this turn started under
  // an environments override and a workspace config override may change the actual roots: dropped
  await request({ environments: [{ cwd: extra }] }); await denied(ask(chat, {}), 'scope_unconfirmed');
  await resume({ runtimeWorkspaceRoots: [w.ws, extra] }); await turn(); assert.equal((await ask(chat, {})).success, true);
  await request({ config: { 'projects.x.trust_level': 'trusted' } }); await denied(ask(chat, {}), 'scope_unconfirmed');
  await resume({ runtimeWorkspaceRoots: [w.ws, extra] }); await turn(); assert.equal((await ask(chat, {})).success, true);
  // the same sandbox TYPE with a different full policy (writableRoots): not the old scope, not before the runtime acknowledges it
  await resume({ runtimeWorkspaceRoots: [w.ws], sandbox: write() }); await turn(); assert.equal((await ask(chat, {})).success, true);
  await request({ sandboxPolicy: write() }); assert.equal((await ask(chat, {})).success, true); // identical policy: nothing changed
  await request({ sandboxPolicy: write([w.ws, extra]) }); await denied(ask(chat, {}), 'scope_unconfirmed'); // asked, not yet acknowledged
  await settle({ sandboxPolicy: write([w.ws, extra]) }); await denied(ask(chat, {}), 'scope_changed'); // acknowledged by the runtime's own event: this turn started under the old policy
  await turn(); assert.equal((await ask(chat, {})).success, true); // the next turn starts under the acknowledged one (roots kept: nothing could have changed them)
  // a request for another workspace or an approval change, then an event for another cwd: the roots cannot be carried to a different workspace
  await request({ approvalPolicy: 'on-request' }); await denied(ask(chat, {}), 'scope_unconfirmed');
  await settle({ sandboxPolicy: write([w.ws, extra]), approvalPolicy: 'on-request' }); await turn(); assert.equal((await ask(chat, {})).success, true);
  await settle({ cwd: extra, sandboxPolicy: write([w.ws, extra]), approvalPolicy: 'on-request' }); await denied(ask(chat, {}), 'scope_unconfirmed');
  // roots that are unknown or malformed are unconfirmed, never inferred from the cwd
  for (const [state, omit] of [[{ runtimeWorkspaceRoots: 'not-a-list' }, []], [{ runtimeWorkspaceRoots: [w.ws, 7] }, []], [{ runtimeWorkspaceRoots: [''] }, []], [{}, ['runtimeWorkspaceRoots']]]) {
    await resume(); await turn(); assert.equal((await ask(chat, {})).success, true, 'a good answer first');
    await resume(state, omit); await turn(); await denied(ask(chat, {}), 'scope_unconfirmed');
  }
  // a thread whose start answer carried no roots has no scope at all
  chat.server.omitOnStart = new Set(['runtimeWorkspaceRoots']);
  const bare = await (kind === 'native' ? nativeChat(w, { own: [plain('b-1')] }) : customChat(w, { own: [plain('b-1')] })); chat.server.omitOnStart = null;
  await begin(bare, 'turn-bare'); await denied(ask(bare, {}), 'scope_unconfirmed');
});

test('READ LIMIT (honest): every call re-reads the runtime\'s whole own history; one over the 500-page bound is refused as history_too_large, never silently cut; a full-size one still reads', async t => {
  const w = await world(); t.after(w.close);
  const empty = id => ({ id, status: 'completed', items: [] });
  const fits = await nativeChat(w, { own: Array.from({ length: 49_900 }, (_, i) => empty('f-' + i)).concat(plain('last')) }); await begin(fits, 'turn-fits');
  const newest = await ask(fits, { direction: 'desc', limit: 2 }); assert.equal(newest.success, true); assert.deepEqual(newest.entries.map(e => e.itemId), ['last-a', 'last-u']);
  const tooLong = await nativeChat(w, { own: Array.from({ length: 50_100 }, (_, i) => empty('x-' + i)) }); await begin(tooLong, 'turn-long');
  const refused = await denied(ask(tooLong, {}), 'history_too_large'); assert.equal(refused.entries, undefined);
});

// ---- 4. nothing is written ---------------------------------------------------------------------------------------------------------------------------
test('READ-ONLY: reads write, rename and inject nothing — route, link and carried-history bytes and the runtime\'s own turns are identical, and only thread/turns/list reached the runtimes', async t => {
  const w = await world(); t.after(w.close);
  const chat = await customChat(w, { logical: 'logical-ro', carried: CARRIED.slice(0, 5), own: OWN.slice(0, 6) }), nat = await nativeChat(w, { logical: 'logical-ro-n', carried: CARRIED.slice(0, 5), own: OWN.slice(0, 6) });
  await begin(chat, 'turn-c'); await begin(nat, 'turn-n');
  const before = { files: files(join(w.root, 'local-routes')), turns: JSON.stringify([...w.servers[w.a].threads.entries()]), main: JSON.stringify([...w.main.threads.entries()]) };
  const mark = [w.servers[w.a].seen.length, w.main.seen.length];
  for (const c of [chat, nat]) { await pageAll(c); await pageAll(c, { direction: 'desc', includeTools: true }); const page = await ask(c, { limit: 1 }); await ask(c, { ref: page.entries[0].ref }); await denied(ask(c, { cursor: 'h1.x.y' }), 'invalid_cursor'); }
  assert.deepEqual(files(join(w.root, 'local-routes')), before.files);
  assert.equal(JSON.stringify([...w.servers[w.a].threads.entries()]), before.turns); assert.equal(JSON.stringify([...w.main.threads.entries()]), before.main);
  const methods = [...w.servers[w.a].seen.slice(mark[0]), ...w.main.seen.slice(mark[1])].filter(c => !c.notification).map(c => c.method);
  assert.deepEqual([...new Set(methods)], ['thread/turns/list']);
  assert.ok(Object.keys(before.files).some(name => name.includes('handoffs'))); // (the carried history is a real file here, and is untouched)
});

test('COLD RESTART at the route: refs stored before the restart reopen the exact old item through the real handler (segments join exactly), cursors fail clearly, and every binding check still applies', async t => {
  const w = await world(); t.after(w.close);
  const big = 'ö' + 'x'.repeat(60_000) + '😀'.repeat(20_000) + 'END', digest = value => createHash('sha256').update(value).digest('hex');
  const chat = await nativeChat(w, { logical: 'logical-cold', carried: CARRIED.slice(0, 3), own: [plain('t-1'), { id: 't-big', status: 'completed', items: [user('ub', 'keep this safe'), agent('big', big)] }, plain('t-3')] });
  await begin(chat, 'turn-1');
  const before = await pageAll(chat), segments = before.filter(e => e.itemId === 'big');
  const stored = { item: segments[0].ref, middle: segments[0].nextRef, user: before.find(e => e.itemId === 'ub').ref, early: before.find(e => e.itemId === 'c-3-u').ref };
  const cursor = (await ask(chat, { limit: 2 })).nextCursor; assert.ok(cursor && segments.length >= 5);
  // the ref is derived from the conversation's own stable IDs: it can be rebuilt without any state of this process
  const binding = historyBinding({ chat: 'logical-cold', profile: w.bridge.historyProfile(), workspace: realpathSync(w.ws) });
  assert.equal(historyRef(binding, { turnId: 't-big', ordinal: 1, itemId: 'big' }, 0), stored.item);
  // ---- COLD RESTART: the in-memory cursor key is gone, the model's turn is a later one (the earlier turn has settled into the history)
  w.bridge.historyCodec = createCodec(); await begin(chat, 'turn-2');
  await denied(ask(chat, { cursor }), 'invalid_cursor');
  assert.match((await ask(chat, { cursor })).error.message, /restart/);
  let part = await ask(chat, { ref: stored.item, maxCharacters: 20000 }), text = part.entries[0].text;
  assert.equal(part.success, true); assert.equal(part.entries[0].total, big.length);
  while (part.entries[0].nextRef) { part = await ask(chat, { ref: part.entries[0].nextRef, maxCharacters: 20000 }); assert.equal(part.entries[0].offset, text.length); text += part.entries[0].text; }
  assert.equal(digest(text), digest(big));
  const tail = await ask(chat, { ref: stored.middle, maxCharacters: 20000 }); assert.equal(tail.entries[0].offset, segments[0].length); assert.equal(tail.entries[0].text, segments[1].text);
  assert.equal((await ask(chat, { ref: stored.user })).entries[0].text, 'keep this safe');
  assert.equal((await ask(chat, { ref: stored.early })).entries[0].text, 'remember ' + FACT); // an item that came from the carried history of an earlier runtime
  const fresh = await ask(chat, { limit: 3 }); assert.ok(fresh.nextCursor); assert.equal((await ask(chat, { cursor: fresh.nextCursor })).success, true);
  // the checks that make a stored ref safe to keep are all still there
  const other = await nativeChat(w, { logical: 'logical-other-cold', own: [plain('o-1')] }); await begin(other, 'turn-o');
  await denied(ask(other, { ref: stored.item }), 'ref_mismatch');
  await denied(ask(chat, { ref: stored.item }, { params: { turnId: 'turn-1' } }), 'turn_not_current'); // an old turn cannot use it
  chat.server.notify('thread/settings/updated', { threadId: chat.physical, threadSettings: settings({ cwd: w.ws2 }) }); await tick();
  await denied(ask(chat, { ref: stored.item }), 'scope_unconfirmed'); // (no roots come with an event: the workspace is unconfirmed, a ref is no way past that)
  chat.server.threads.get(chat.physical).turns = chat.server.threads.get(chat.physical).turns.filter(x => x.id !== 't-big');
  await w.bridge.request('thread/resume', { threadId: chat.physical }); // the runtime's own answer confirms the unchanged scope again
  await denied(ask(chat, { ref: stored.item }), 'ref_not_found');
});

test('A cursor made before a turn settles is explicitly stale afterwards; a ref to an earlier item stays good', async t => {
  const w = await world(); t.after(w.close);
  const chat = await nativeChat(w, { logical: 'logical-rev', own: [plain('t-1'), plain('t-2'), plain('t-3')] }); await begin(chat, 'turn-1');
  const first = await ask(chat, { limit: 2 }); assert.ok(first.nextCursor);
  assert.equal((await ask(chat, { cursor: first.nextCursor, limit: 2 })).entries[0].itemId, 't-2-u');
  chat.server.threads.get(chat.physical).turns.splice(3, 0, plain('t-4')); // a settled turn appears before the running one
  await denied(ask(chat, { cursor: first.nextCursor }), 'history_revision_changed');
  assert.equal((await ask(chat, { ref: first.entries[0].ref })).entries[0].text, 'question t-1');
  await denied(ask(chat, { ref: first.nextCursor }), 'invalid_ref');
});

test('SDK CLAUDE denials: a changed workspace or permission, an unknown scope, an aborted turn and an ended turn are all refused by the closure bound to the record, turn and controller', async t => {
  const f = fixture(); t.after(() => f.close());
  const id = await f.start('sonnet'), record = f.bridge.records.get(id), elsewhere = mkdtempSync(join(tmpdir(), 'sonnet-history-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  record.runtimeWorkspaceRoots = [f.statePath]; record.instructionSources = [join(f.statePath, 'AGENTS.md')]; record.claudeSessionId = 'session-1'; record.turns = [{ ...plain('p-1'), provider: 'claude' }]; // (the roots its host's start answer confirmed)
  const out = {};
  f.controls.query = async args => {
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); await args.mcp.instance.connect(serverSide);
      const client = new Client({ name: 'history-test', version: '1' }); await client.connect(clientSide);
      const read = async () => { const r = await client.callTool({ name: 'read_history', arguments: { limit: 20 } }); return JSON.parse(r.content[0].text); };
      const mutate = async (change, restore) => { const before = change(); const result = await read(); restore(before); return result; };
      out.ok = await read();
      const cwd = record.thread.cwd, sandbox = record.sandbox, policy = record.approvalPolicy;
      out.cwd = await mutate(() => { record.thread.cwd = elsewhere; }, () => { record.thread.cwd = cwd; });
      out.sandbox = await mutate(() => { record.sandbox = { type: 'dangerFullAccess' }; }, () => { record.sandbox = sandbox; });
      out.policy = await mutate(() => { record.approvalPolicy = 'on-request'; }, () => { record.approvalPolicy = policy; });
      out.unknown = await mutate(() => { record.sandbox = undefined; }, () => { record.sandbox = sandbox; });
      const roots = record.runtimeWorkspaceRoots, policy2 = record.sandbox;
      out.rootsOnly = await mutate(() => { record.runtimeWorkspaceRoots = [...roots, elsewhere]; }, () => { record.runtimeWorkspaceRoots = roots; }); // same cwd, same sandbox type and profile
      out.rootsAbsent = await mutate(() => { record.runtimeWorkspaceRoots = undefined; }, () => { record.runtimeWorkspaceRoots = roots; });
      out.rootsReordered = await mutate(() => { record.runtimeWorkspaceRoots = [...roots]; }, () => { record.runtimeWorkspaceRoots = roots; }); // an equal set is not a change
      out.sameTypePolicy = await mutate(() => { record.sandbox = { ...policy2, type: policy2.type, writableRoots: [elsewhere] }; }, () => { record.sandbox = policy2; }); // same TYPE, different full policy
      out.recovered = await read();
      out.running = f.bridge.active.get(id); out.turn = out.running.turn;
      out.history = f.bridge.sdkHistory(record, out.running, out.turn, out.running.controller.signal);
      out.running.controller.abort(); // the turn is stopped: the very next read from its closure is refused
      out.aborted = await out.history({});
      out.afterAbort = await client.callTool({ name: 'read_history', arguments: {} }).then(r => ({ isError: r.isError }), error => ({ rejected: error.message }));
    } catch (error) { out.error = error; }
  };
  const sent = await f.send(id, 'hello'); await f.done(sent.turn.id); await f.settled(sent.turn.id);
  assert.equal(out.error, undefined, String(out.error?.stack));
  assert.deepEqual(out.ok.entries.map(e => e.itemId), ['p-1-u', 'p-1-a']);
  assert.equal(out.cwd.error.code, 'scope_changed'); assert.equal(out.sandbox.error.code, 'scope_changed'); assert.equal(out.policy.error.code, 'scope_changed'); assert.equal(out.unknown.error.code, 'scope_unconfirmed');
  assert.equal(out.rootsOnly.error.code, 'scope_changed'); assert.equal(out.rootsAbsent.error.code, 'scope_unconfirmed'); assert.equal(out.rootsReordered.error, undefined); assert.equal(out.sameTypePolicy.error.code, 'scope_changed');
  assert.deepEqual(out.recovered.entries.map(e => e.itemId), ['p-1-u', 'p-1-a']);
  assert.equal(out.aborted.error.code, 'aborted');
  assert.ok(out.afterAbort.rejected || out.afterAbort.isError); // the MCP handler itself refuses once the controller is aborted
  const ended = await f.bridge.sdkHistory(record, out.running, out.turn, new AbortController().signal)({});
  assert.equal(ended.error.code, 'turn_not_current'); // the turn has finished: bridge.active no longer holds it
});
