import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, ProviderNativePool, connectNative } from '../bridge.mjs';
import { RpcError, neverSent } from '../rpc.mjs';
import { ProviderRegistry, localModelId, useDurability } from '../plugins/codex-claude/home/providers.mjs';
import { buildTransfer } from '../continuity.mjs';
import { decide, qualifySdkCompaction } from '../context-handoff.mjs';
import { fixture } from './support/fixture.mjs';
test.after(useDurability(process.permission ? () => {} : undefined));

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
const FILL = 'filler words that make a message long enough to matter '.repeat(18);
const earlier = (n, text = 'earlier ' + n) => ({ id: 'old-' + n, status: 'completed', provider: 'imported', items: [{ type: 'userMessage', id: 'ou' + n, clientId: null, content: [{ type: 'text', text }] }, { type: 'agentMessage', id: 'oa' + n, text: 'ack ' + n }] });
const budgetEntry = (route, model, over = {}) => ({ version: 1, key: route + ':' + (route === 'native' ? 'openai:' : '') + model, route, model, provider: route === 'native' ? 'openai' : null, contextWindow: 100_000, maxOutputTokens: 10_000, source: route === 'native' ? 'native-token-event' : 'sdk-modelusage', at: 1, ...over });
async function claudeChat(f, { turns = 1, session = 'session-1' } = {}) { // session: null = a chat whose Claude session does not exist yet
  const id = await f.start('sonnet'), record = f.bridge.records.get(id);
  Object.assign(record, { runtimeWorkspaceRoots: [f.statePath], instructionSources: [join(f.statePath, 'AGENTS.md')], claudeSessionId: session });
  record.turns = Array.from({ length: turns }, (_, i) => earlier(i + 1)); f.bridge.save(record); CWD = record.thread.cwd;
  return { id, record };
}
const turn = async (f, id, text) => { const sent = await f.send(id, text); await f.done(sent.turn.id); await f.settled(sent.turn.id); return sent; };
let CURRENT = null; // the world of the running test (helpers that name only a thread use it)
let CWD = null; // the workspace of the chat the current test built (the SDK's hook input names it)
const hook = (over = {}) => ({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'SUMMARY ONE: the launch code is PELICAN-7731', session_id: 'session-1', cwd: CWD, ...over });

// ---- 1. the provider's own compaction, observed through the real query options of Bridge.run --------------------------------------------------------------------
test('PostCompact through the real Bridge.run: the callback of THIS live turn, session and model is kept beside the canonical turns; stale, foreign, empty, wrong-model, late and aborted callbacks are ignored; no turn changes', async () => {
  const f = fixture(); const { id, record } = await claudeChat(f, { turns: 5 }); const canonical = JSON.stringify(record.turns), out = {};
  f.controls.query = async args => {
    out.hook = typeof args.onCompact;
    await args.onCompact(hook({ session_id: 'another-session' })); out.other = record.compaction;
    await args.onCompact(hook({ hook_event_name: 'PreCompact' })); out.pre = record.compaction;
    await args.onCompact(hook({ compact_summary: '' })); out.empty = record.compaction;
    await args.onCompact(hook({ agent_id: 'subagent-1' })); out.agent = record.compaction;
    await args.onCompact(hook({ cwd: join(f.statePath, 'another-workspace') })); out.cwd = record.compaction;
    await args.onCompact(hook({ cwd: undefined })); out.nocwd = record.compaction;
    record.model = 'haiku'; await args.onCompact(hook()); out.model = record.compaction; record.model = 'sonnet';
    await args.onCompact(hook()); out.first = structuredClone(record.compaction);
    await args.onCompact(hook({ compact_summary: 'SUMMARY TWO', trigger: 'manual' })); out.second = structuredClone(record.compaction);
  };
  await turn(f, id, 'request');
  assert.equal(out.hook, 'function'); assert.deepEqual([out.other, out.pre, out.empty, out.agent, out.cwd, out.nocwd, out.model], Array(7).fill(undefined), 'another session, a PreCompact event, an empty summary, a subagent, another or no workspace, another model');
  const first = out.first; assert.deepEqual([first.version, first.kind, first.untrusted, first.text, first.trigger, first.sessionId, first.model, first.route, first.revision], [1, 'sdk-postcompact', true, 'SUMMARY ONE: the launch code is PELICAN-7731', 'auto', 'session-1', 'sonnet', 'claude', 1]);
  assert.deepEqual(first.coverage.ids, ['old-1', 'old-2', 'old-3', 'old-4', 'old-5']); assert.equal(first.coverage.count, 5); assert.equal(first.coverage.coversActiveTurn, true, 'the live turn is recorded as uncertain coverage'); assert.equal(first.coverage.lastTurnId, 'old-5');
  assert.deepEqual([out.second.text, out.second.trigger, out.second.revision], ['SUMMARY TWO', 'manual', 2]);
  const saved = f.bridge.records.get(id); assert.equal(JSON.stringify(saved.turns.slice(0, 5)), canonical, 'the visible canonical turns are unchanged'); assert.equal(saved.turns.length, 6);
  assert.equal(JSON.parse(readFileSync(join(f.statePath, id + '.json'), 'utf8')).compaction.text, 'SUMMARY TWO', 'saved beside the history');
  // late (after the turn ended): ignored
  await f.queries[0].onCompact(hook({ compact_summary: 'LATE' })); assert.equal(saved.compaction.text, 'SUMMARY TWO');
  // aborted turn: ignored
  f.controls.query = async args => { f.bridge.active.get(id).controller.abort(); await args.onCompact(hook({ compact_summary: 'ABORTED' })); };
  const stopped = await f.send(id, 'second request'); await f.done(stopped.turn.id); await f.settled(stopped.turn.id); assert.equal(saved.compaction.text, 'SUMMARY TWO');
  // the SDK session is the record's: a callback naming another session is never this turn's
  f.controls.query = async args => { await args.onCompact(hook({ session_id: 'session-2', compact_summary: 'FOREIGN' })); };
  await turn(f, id, 'third request'); assert.equal(saved.compaction.text, 'SUMMARY TWO');
});

test('a resumed SDK session repeats nothing: no history, no prefix, no stored summary; the current request is in the record once', async () => {
  const f = fixture(); const { id, record } = await claudeChat(f, { turns: 3 });
  record.compaction = qualifySdkCompaction(hook(), { sessionId: 'session-1', model: 'sonnet', cwd: CWD, turns: [...record.turns, { id: 'cur', status: 'inProgress', items: [] }], currentTurnId: 'cur', revision: 1, now: 1 }).snapshot;
  await turn(f, id, 'resumed request'); const q = f.queries[0];
  for (const key of ['bridge_conversation', 'bridge_history_rules', 'bridge_transition']) assert.equal(q.additionalContext?.[key], undefined, key); assert.equal(JSON.stringify({ additionalContext: q.additionalContext, input: q.input, systemPrompt: q.systemPrompt }).includes('SUMMARY ONE'), false, 'the stored summary is never replayed into the same session');
  assert.equal(q.input[0].text, 'resumed request'); assert.equal(JSON.stringify(f.bridge.records.get(id).turns).split('resumed request').length, 2);
  // a native GPT thread continuing in its own thread is the same: its own context, nothing carried
  const g = fixture('openai'); const gid = await g.start('gpt-test'); await (async () => { const a = await g.send(gid, 'first'); await g.done(a.turn.id); const b = await g.send(gid, 'second'); await g.done(b.turn.id); })();
  assert.equal(g.calls.filter(c => c.method === 'thread/inject_items').length, 0); const starts = g.calls.filter(c => c.method === 'turn/start');
  assert.deepEqual(starts.map(c => c.params.input[0].text), ['first', 'second']); assert.ok(starts.every(c => c.params.additionalContext === undefined));
});

// ---- 2. the window of the selected model -----------------------------------------------------------------------------------------------------------------
test('ModelUsage: the window of the SELECTED model in THIS session is recorded with its source and time (and survives a restart); another session, another model or no entry leaves it unknown', async () => {
  const usage = (over = {}) => ({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000, ...over });
  const run = async (modelUsage, sessionId = 'session-1') => {
    const f = fixture(); const { id } = await claudeChat(f); f.controls.messages = async function* () { yield { type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'ok' }] } }; yield { type: 'result', subtype: 'success', session_id: sessionId, modelUsage }; };
    await turn(f, id, 'measure'); return f;
  };
  const f = await run({ sonnet: usage(), 'claude-haiku-5': usage({ contextWindow: 50_000 }) });
  const entry = f.bridge.budgets.get('claude', 'sonnet'); assert.deepEqual([entry.contextWindow, entry.maxOutputTokens, entry.source, entry.sessionId, entry.route, entry.model], [200_000, 32_000, 'sdk-modelusage', 'session-1', 'claude', 'sonnet']); assert.ok(entry.at > 0);
  assert.equal(f.bridge.budgets.get('claude', 'haiku'), null, 'a subagent model in the same map is not the selected model');
  f.restart(); assert.equal(f.bridge.budgets.get('claude', 'sonnet').contextWindow, 200_000, 'it is part of the state, with its source');
  assert.equal((await run({ sonnet: usage() }, 'session-OTHER')).bridge.budgets.get('claude', 'sonnet'), null, 'another session');
  assert.equal((await run({ 'claude-opus-5': usage() })).bridge.budgets.get('claude', 'sonnet'), null, 'no entry for the selected model');
  assert.equal((await run({ sonnet: usage({ contextWindow: 800 }) })).bridge.budgets.get('claude', 'sonnet'), null, 'an implausible window');
  assert.equal(f.bridge.budgets.get('native', 'a1'), null, 'a custom endpoint\'s window is never inferred from anything'); assert.equal(f.bridge.budgets.get('native', 'gpt-test'), null);
});

// ---- 3. the first query after a reduced hand-off into a Claude chat -------------------------------------------------------------------------------------
test('reduced hand-off into a Claude chat: the FIRST query carries the reduction (summary, whole recent and newer turns) checked with the real request; a later query resumes and repeats nothing; refusals and bad context fall back honestly', async () => {
  const f = fixture(); const { id, record } = await claudeChat(f, { turns: 0, session: null });
  record.turns = Array.from({ length: 220 }, (_, i) => earlier(i + 1, (i === 2 ? 'FIRST-FACT-3 ' : '') + `question ${i + 1} ${FILL}`));
  const covered = qualifySdkCompaction(hook({ session_id: 's0' }), { sessionId: 's0', model: 'opus', cwd: CWD, turns: [...record.turns.slice(0, 200), { id: 'cur', status: 'inProgress', items: [] }], currentTurnId: 'cur', revision: 1, now: 1 }).snapshot;
  f.bridge.budgets.set(budgetEntry('claude', 'sonnet'));
  const decided = decide({ transfer: buildTransfer(record.turns), summary: covered, budget: f.bridge.budgets.get('claude', 'sonnet'), reachable: true, claude: true }); assert.equal(decided.mode, 'reduced');
  record.contextHandoff = decided.context; f.bridge.save(record);
  // a request too large for the known window is refused with nothing sent and nothing lost
  const turnsBefore = record.turns.length;
  await assert.rejects(f.send(id, 'x'.repeat(400_000)), /too large to send together with the shortened context/); assert.equal(f.queries.length, 0); assert.equal(record.turns.length, turnsBefore); assert.equal(f.bridge.active.has(id), false);
  // a window that is no longer known is refused too, never assumed
  const kept = new Map(f.bridge.budgets.entries); f.bridge.budgets.entries.clear();
  await assert.rejects(f.send(id, 'hello'), /context window of this model is no longer known/); assert.equal(f.queries.length, 0); f.bridge.budgets.entries = kept;
  // the real request fits: the reduction travels once
  await turn(f, id, 'CURRENT-REQUEST-MARK'); const q = f.queries[0], context = JSON.parse(q.additionalContext.bridge_conversation.value);
  assert.equal(q.additionalContext.bridge_conversation.kind, 'untrusted'); assert.equal(context.untrustedSummaryByPreviousModel, 'SUMMARY ONE: the launch code is PELICAN-7731'); assert.ok(context.turns.length < 220 && context.turns.at(-1).id === 'old-220');
  assert.equal(context.turns.length, decided.context.includedTurnIds.length); assert.equal(JSON.stringify(q.additionalContext).includes('CURRENT-REQUEST-MARK'), false, 'the current request is the prompt, never part of the context'); assert.equal(JSON.stringify(q.additionalContext).includes('FIRST-FACT-3 question'), false);
  assert.equal(q.input[0].text, 'CURRENT-REQUEST-MARK'); const saved = f.bridge.records.get(id); assert.equal(saved.turns.length, turnsBefore + 1); assert.ok(JSON.stringify(saved.turns).includes('FIRST-FACT-3 question 3'), 'every original turn is still in the record');
  assert.ok(saved.claudeSessionId, 'the session exists now');
  await turn(f, id, 'second'); assert.equal(f.queries[1].additionalContext?.bridge_conversation, undefined, 'resumed: nothing repeated'); assert.equal(f.queries[1].additionalContext?.bridge_history_rules, undefined);
  // a stored context that no longer matches this history is discarded as a reduction: the full, honest history path is used
  const g = fixture(); const bad = await claudeChat(g, { turns: 0, session: null }); bad.record.turns = record.turns.slice(0, 20).map(t => structuredClone(t)); g.bridge.budgets.set(budgetEntry('claude', 'sonnet'));
  bad.record.contextHandoff = { ...decided.context, includedTurnIds: ['not-a-turn-of-this-history'] }; await turn(g, bad.id, 'go');
  assert.equal(JSON.parse(g.queries[0].additionalContext.bridge_conversation.value).length, 20, 'the full visible conversation, as before (a history that fits the known window)'); assert.match(g.queries[0].additionalContext.bridge_history_rules.value, /retained conversation in chronological order/);
  // ... but over a KNOWN window that the full history does not fit in, an invalid stored reduction never falls back to sending everything: refused, nothing sent
  const h = fixture(); const big = await claudeChat(h, { turns: 0, session: null }); big.record.turns = record.turns.map(t => structuredClone(t)); h.bridge.budgets.set(budgetEntry('claude', 'sonnet'));
  big.record.contextHandoff = { ...decided.context, includedTurnIds: ['not-a-turn-of-this-history'] };
  await assert.rejects(h.send(big.id, 'hello'), /does not fit its known context window together with this message/); assert.equal(h.queries.length, 0); assert.equal(h.bridge.active.has(big.id), false);
  big.record.contextHandoff = undefined; await assert.rejects(h.send(big.id, 'hello'), /no valid shortened context exists/, 'no reduction at all, a known window the whole history does not fit: refused too');
  h.bridge.budgets.entries.clear(); await turn(h, big.id, 'unknown window: the full visible history, as before, no fit claimed'); assert.equal(JSON.parse(h.queries[0].additionalContext.bridge_conversation.value).length, record.turns.length);
});

// ---- 4. native and custom threads over the real Peers and ProviderNativePool -------------------------------------------------------------------------------
function fakeServer(label, handler) {
  const toBridge = new PassThrough(), fromBridge = new PassThrough(), seen = [];
  const frame = message => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
  createInterface({ input: fromBridge, crlfDelay: Infinity }).on('line', async line => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      seen.push({ method: message.method, params: structuredClone(message.params ?? {}) });
      try { toBridge.write(frame({ id: message.id, result: await handler(message.method, message.params ?? {}, server) })); }
      catch (error) { toBridge.write(frame({ id: message.id, error: { code: error.code ?? -32603, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } })); }
    } else if (message.method) seen.push({ method: message.method, params: message.params, notification: true });
  });
  const server = { label, seen, toBridge, fromBridge, threads: new Map(), failInject: false, notify: (method, params) => toBridge.write(frame({ method, params })) };
  return server;
}
const settings = (over = {}, { model = 'gpt-test', provider = 'openai', cwd } = {}) => ({ cwd, sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: null, disabledPluginIds: [],
  model, modelProvider: provider, serviceTier: null, effort: null, summary: null, collaborationMode: { mode: 'default', settings: { model, reasoning_effort: null, developer_instructions: null } }, multiAgentMode: 'explicitRequestOnly', personality: null, ...over });
const catalog = ids => (_u, _o, receive) => { const q = new EventEmitter(); q.destroy = () => {}; q.end = () => queueMicrotask(() => { const r = new EventEmitter(); r.statusCode = 200; r.destroy = () => {}; receive(r); r.emit('data', Buffer.from(JSON.stringify({ data: ids.map(id => ({ id })) }))); r.emit('end'); }); return q; };
async function world() {
  const root = mkdtempSync(join(tmpdir(), 'sonnet-context-integration-')), ws = join(root, 'ws'); mkdirSync(ws); mkdirSync(join(root, 'rollouts'));
  const registry = new ProviderRegistry(root), a = registry.create({ name: 'Alpha endpoint', baseUrl: 'https://alpha.example.invalid/v1' }); await registry.refresh(a, { request: catalog(['a1', 'a2']) });
  const w = CURRENT = { root, ws, a, counter: 0 };
  const handler = (provider, model) => async (method, p, server) => {
    if (method === 'initialize') return {};
    if (method === 'config/read') return { config: { model: 'gpt-test', model_provider: 'openai' } };
    if (method === 'model/list') return { data: [{ id: 'gpt-test', model: 'gpt-test' }], nextCursor: null };
    if (method === 'thread/start') {
      const id = server.label + '-thread-' + ++w.counter, answer = { thread: { id, path: join(root, 'rollouts', id + '.jsonl'), cwd: p.cwd, status: { type: 'idle' }, turns: [], modelProvider: provider, model, forkedFromId: null, createdAt: 100, updatedAt: 100 }, model, modelProvider: provider, serviceTier: null,
        disabledPluginIds: [], cwd: p.cwd, runtimeWorkspaceRoots: [p.cwd], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
      server.threads.set(id, { answer, state: {} }); return structuredClone(answer);
    }
    if (method === 'thread/resume') { const t = server.threads.get(p.threadId); if (!t) throw Object.assign(new Error('no rollout found'), { code: -32600 }); return { ...structuredClone(t.answer), ...structuredClone(t.state) }; }
    if (method === 'thread/inject_items') { if (server.failInject) throw Object.assign(new Error('inject refused'), { code: -32603 }); return {}; }
    if (method === 'turn/start') {
      // an ERROR ANSWER from the runtime (nothing was recorded here, but that is not something the Bridge can know); `spoof` makes it claim in its data that it was never sent
      if (server.failTurn) throw Object.assign(new Error('turn refused'), { code: -32603, ...(server.spoof ? { data: { notSent: true, neverSent: true, answered: false, bridgeErrorCode: 'never_sent' } } : {}) });
      (server.turns ??= []).push({ id: 'turn-' + (server.turns?.length ?? 0), status: 'inProgress', items: [{ type: 'userMessage', id: 'um-' + (server.turns?.length ?? 0), clientId: p.clientUserMessageId ?? null, content: p.input ?? [] }] });
      if (server.acceptThenFail) throw Object.assign(new Error('turn accepted, then an error was answered'), { code: -32603 }); // the turn IS recorded; the answer is an error
      return { turn: { id: 'turn-from-rpc', status: 'inProgress', items: [] } };
    }
    if (method === 'thread/settings/update' && server.label === 'A') { // a custom connection applies a model / level change and announces it with its own settings event
      const t = server.threads.get(p.threadId); if (!t) throw Object.assign(new Error('no rollout found'), { code: -32600 });
      t.state = { ...t.state, ...(p.model ? { model: p.model } : {}), ...('effort' in p ? { reasoningEffort: p.effort } : {}) }; const a = { ...t.answer, ...t.state };
      server.notify('thread/settings/updated', { threadId: p.threadId, threadSettings: settings({ effort: a.reasoningEffort ?? null }, { model: a.model, provider: a.modelProvider, cwd: a.cwd }) }); return {};
    }
    if (method === 'thread/turns/list') { // newest first; pages of server.pageSize when set; server.stuckCursor never ends (the same cursor again)
      if (server.unmaterialized) throw Object.assign(new Error('thread ' + p.threadId + ' is not materialized yet; thread/turns/list is unavailable before first user message'), { code: -32600 });
      const all = [...(server.turns ?? [])].reverse(), size = server.pageSize ?? all.length, start = typeof p.cursor === 'string' ? Number(p.cursor.replace('at-', '')) : 0;
      if (server.stuckCursor) return { data: all.slice(0, size), nextCursor: 'at-stuck' };
      return { data: all.slice(start, start + size), nextCursor: start + size < all.length ? 'at-' + (start + size) : null };
    }
    if (method === 'thread/read') return { thread: { ...structuredClone(server.threads.get(p.threadId)?.answer.thread ?? { id: p.threadId }), status: { type: server.busy ? 'active' : 'idle', ...(server.busy ? { activeFlags: [] } : {}) } }, readState: null };
    throw Object.assign(new Error('unexpected ' + method), { code: -32601 });
  };
  w.main = fakeServer('N', handler('openai', 'gpt-test')); w.custom = fakeServer('A', handler('bridge_custom_' + a, 'a1'));
  let bridge; w.native = connectNative(() => bridge, w.main.toBridge, w.main.fromBridge);
  w.pool = new ProviderNativePool({ executable: '/synthetic/pinned-codex', args: ['app-server'], env: { PATH: '/usr/bin' }, initialization: () => ({ clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } }),
    request: (method, params, origin) => bridge.toolRequest(method, params, undefined, undefined, origin), notify: (method, params, origin) => bridge.nativeNotification(method, params, origin),
    observe: (phase, method, params, result, origin) => bridge?.observeNative(origin, phase, method, params, result),
    spawnProcess: () => { const child = new EventEmitter(); child.stdout = w.custom.toBridge; child.stdin = w.custom.fromBridge; child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { if (child.signalCode !== null) return; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); }; return child; } });
  bridge = new Bridge({ native: w.native, desktop: { notify() {}, request: async () => ({}) }, statePath: join(root, 'state'), connectionRoot: root, providerNative: (s, definition) => w.pool.get(s, definition), history: { checkpoint: async () => ({}), before: async () => undefined } });
  w.bridge = bridge; w.router = bridge.localResponses;
  const s = registry.all()[0]; await w.router.nativeForConnection(s, s.catalog.models[0]);
  w.close = () => { try { w.pool.stop(); } catch { /* stopped */ } w.native.end(); rmSync(root, { recursive: true, force: true }); };
  return w;
}
const nativeChat = async w => (await w.bridge.request('thread/start', { model: 'gpt-test', cwd: w.ws })).thread.id;
const customChat = async w => (await w.bridge.request('thread/start', { model: localModelId(w.a, 'a1'), cwd: w.ws })).thread.id;
const running = (server, id, turnId = 'turn-1') => { server.notify('turn/started', { threadId: id, turn: { id: turnId, status: 'inProgress', items: [], itemsView: 'notLoaded' } }); return tick(); };
const finished = (server, id, turnId = 'turn-1') => { server.notify('turn/completed', { threadId: id, turn: { id: turnId, status: 'completed', items: [], itemsView: 'notLoaded' } }); return tick(); };
const change = (w, server, id, over = {}, identity = {}) => { server.notify('thread/settings/updated', { threadId: id, threadSettings: settings({ cwd: w.ws, ...over }, { cwd: w.ws, ...identity }) }); return tick(); };
const notes = (server, id) => server.seen.filter(c => c.method === 'thread/inject_items' && c.params.threadId === id);

test('native window: a native OpenAI thread\'s own token event on the main connection records that model\'s window; a custom endpoint, another provider, another thread or a bad value records nothing', async t => {
  const w = await world(); t.after(w.close);
  const id = await nativeChat(w), custom = await customChat(w);
  await running(w.main, id, 'turn-1'); await running(w.custom, custom, 'turn-1');
  w.main.notify('thread/tokenUsage/updated', { threadId: id, turnId: 'turn-1', tokenUsage: { total: {}, last: {}, modelContextWindow: 272_000 } }); await tick();
  const e = w.bridge.budgets.get('native', 'gpt-test'); assert.deepEqual([e.contextWindow, e.source, e.provider, e.maxOutputTokens, e.key], [272_000, 'native-token-event', 'openai', null, 'native:openai:gpt-test']);
  w.custom.notify('thread/tokenUsage/updated', { threadId: custom, turnId: 'turn-1', tokenUsage: { modelContextWindow: 8192 } }); await tick(); assert.equal(w.bridge.budgets.get('native', 'a1'), null, 'a custom endpoint\'s window is never taken from a native-style event');
  assert.equal(w.bridge.budgets.get('native', 'bridge_custom_' + w.a), null);
  w.main.notify('thread/tokenUsage/updated', { threadId: 'someone-elses-thread', tokenUsage: { modelContextWindow: 999_999 } }); w.main.notify('thread/tokenUsage/updated', { threadId: id, turnId: 'turn-1', tokenUsage: { modelContextWindow: 'big' } }); w.main.notify('thread/tokenUsage/updated', { threadId: id, turnId: 'turn-1', tokenUsage: { modelContextWindow: 12 } }); await tick();
  assert.equal(w.bridge.budgets.get('native', 'gpt-test').contextWindow, 272_000, 'unchanged by an unknown thread or a bad value');
  w.custom.notify('thread/tokenUsage/updated', { threadId: id, turnId: 'turn-1', tokenUsage: { modelContextWindow: 1_000_000 } }); await tick(); assert.equal(w.bridge.budgets.get('native', 'gpt-test').contextWindow, 272_000, 'another connection\'s claim about this thread is nothing');
});

// A native / custom thread's note travels WITH its next accepted turn (turn/start additionalContext.bridge_transition, trusted application context): never a separate request that could be
// lost or repeated. It is durable (the Bridge's own outbox) from the moment the selection change is confirmed, and cleared only when a turn that carried it was accepted.
const owed = w => [...w.bridge.outbox.entries.values()].filter(e => e.pending || e.intent || e.dispatching).length; // obligations (a baseline of what a model last saw is not one)
const carried = (server, id) => server.seen.filter(c => c.method === 'turn/start' && c.params.threadId === id);
const noteOf = call => call?.params.additionalContext?.bridge_transition ?? null;
const start = (w, id, text = 'next request', extra = {}) => w.bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text }], ...extra });
const cold = w => { w.bridge.selections.clear(); w.bridge.outbox.entries.clear(); w.bridge.outbox.load(); }; // memory gone, the durable file read again

test('native thread, same runtime: an accepted change after a turn is ONE note on the next accepted turn (merged, durable across a cold start, once, never for repeats, a new thread or a change back); no separate request is ever made', async t => {
  const w = await world(); t.after(w.close); const id = await nativeChat(w);
  await change(w, w.main, id, { effort: 'high' }); assert.equal(owed(w), 0, 'a thread that has had no turn has nothing to be told');
  await running(w.main, id); await finished(w.main, id);
  await change(w, w.main, id, { effort: 'low' });
  const saved = w.bridge.outbox.get(id); assert.equal(saved.kind, 'native'); assert.equal(saved.pending.to.effort, 'low'); assert.equal(saved.pending.from.effort, 'high');
  assert.equal(notes(w.main, id).length, 0, 'no thread/inject_items is used for a same-runtime change');
  await change(w, w.main, id, { effort: 'low' }); assert.equal(w.bridge.outbox.get(id).pending.id, saved.pending.id, 'the same selection again is no new transition');
  // several accepted changes before a turn are ONE note from what the model last saw; a change back clears it
  await change(w, w.main, id, { effort: 'medium' }); await change(w, w.main, id, { model: 'gpt-other', effort: 'medium' });
  const merged = w.bridge.outbox.get(id).pending; assert.equal(merged.from.effort, 'high'); assert.equal(merged.from.model, 'gpt-test'); assert.deepEqual([merged.to.model, merged.to.effort], ['gpt-other', 'medium']);
  await change(w, w.main, id, { model: 'gpt-test', effort: 'high' }); assert.equal(owed(w), 0, 'back to what the model last saw: nothing to announce');
  await change(w, w.main, id, { model: 'gpt-other', effort: 'medium' }); assert.equal(owed(w), 1);
  // a cold start between the change and the next turn keeps the note; a repeated resume of the same selection adds nothing
  const pendingId = w.bridge.outbox.get(id).pending.id;
  cold(w); w.main.threads.get(id).state = { model: 'gpt-other', reasoningEffort: 'medium' };
  await w.bridge.request('thread/resume', { threadId: id }); await w.bridge.request('thread/resume', { threadId: id });
  assert.equal(w.bridge.outbox.get(id).pending.id, pendingId, 'the same note after a cold start and two resumes'); assert.equal(owed(w), 1);
  // a failing turn keeps the note pending and changes nothing; the accepted one carries it exactly once, as trusted application context
  // (the connection is already closed: a trusted LOCAL proof that nothing was written, so the attempt is cleared and the note stays owed)
  w.native.closed = true; await assert.rejects(start(w, id, 'fails')); w.native.closed = false; assert.equal(owed(w), 1); assert.equal(w.bridge.selections.get(id).dispatching, null); assert.equal(sentTurns(w.main), 0, 'nothing reached the runtime');
  cold(w); await start(w, id, 'now');
  const sent = carried(w.main, id), last = sent.at(-1), note = noteOf(last); assert.equal(note.kind, 'application');
  assert.match(note.value, /changed from GPT \(native Codex\) · gpt-test \(reasoning high\) to GPT \(native Codex\) · gpt-other \(reasoning medium\)\./); assert.match(note.value, /serving backend model: not reported/); assert.match(note.value, /this runtime keeps its own context/);
  assert.deepEqual(last.params.input, [{ type: 'text', text: 'now' }], 'the request is exactly what was asked, once'); assert.equal(owed(w), 0, 'cleared only because the turn was accepted');
  assert.equal(sent.length, 1, 'the never-sent attempt is the only reason for a second try; this is the one and only turn');
  await running(w.main, id, 'turn-2'); await finished(w.main, id, 'turn-2'); await start(w, id, 'again'); assert.equal(noteOf(carried(w.main, id).at(-1)), null, 'never again once a turn carried it');
  assert.equal(w.main.seen.some(c => c.method === 'thread/inject_items'), false);
  // another connection's event about this thread is not evidence
  w.custom.notify('thread/settings/updated', { threadId: id, threadSettings: settings({ cwd: w.ws, effort: 'xhigh' }, { cwd: w.ws }) }); await tick(); assert.equal(owed(w), 0);
});

test('native thread: a model or level asked ON the turn/start is announced with that very turn, only once the turn is accepted; a refused turn changes nothing; the settings event that confirms it is not a second transition', async t => {
  const w = await world(); t.after(w.close); const id = await nativeChat(w);
  await running(w.main, id); await finished(w.main, id);
  w.native.closed = true; await assert.rejects(start(w, id, 'refused', { model: 'gpt-third', effort: 'low' })); w.native.closed = false; // never written: provably not sent
  assert.equal(w.bridge.selections.get(id).now.model, 'gpt-test', 'a request that was not accepted is no transition'); assert.equal(w.bridge.selections.get(id).seen.model, 'gpt-test');
  assert.equal(owed(w), 0, 'nothing is owed: the note of the never-sent attempt is dropped with it'); assert.equal(w.bridge.selections.get(id).dispatching, null, 'the never-sent attempt is cleared'); assert.equal(w.bridge.selections.get(id).pending, null);
  await start(w, id, 'accepted', { model: 'gpt-third', effort: 'low' });
  const note = noteOf(carried(w.main, id).at(-1)); assert.match(note.value, /from GPT \(native Codex\) · gpt-test \(reasoning not set\) to GPT \(native Codex\) · gpt-third \(reasoning low\)\./);
  assert.equal(w.bridge.selections.get(id).now.model, 'gpt-third'); assert.equal(owed(w), 0);
  await change(w, w.main, id, { model: 'gpt-third', effort: 'low' }); assert.equal(owed(w), 0, 'the confirming event is the same selection');
  await running(w.main, id, 'turn-2'); await finished(w.main, id, 'turn-2'); await start(w, id, 'plain'); assert.equal(noteOf(carried(w.main, id).at(-1)), null);
  // the same model and level asked again is nothing
  await start(w, id, 'same', { model: 'gpt-third', effort: 'low' }); assert.equal(noteOf(carried(w.main, id).at(-1)), null);
});

test('custom thread, same runtime: a change confirmed by the custom connection\'s own event (or the router\'s own commit) is ONE note on that thread\'s next accepted turn, sent to THAT connection, durable across a cold start, once', async t => {
  const w = await world(); t.after(w.close); const id = await customChat(w); const identity = { model: 'a1', provider: 'bridge_custom_' + w.a };
  await running(w.custom, id); await finished(w.custom, id);
  await change(w, w.custom, id, { effort: 'high' }, identity);
  const saved = w.bridge.outbox.get(id); assert.equal(saved.kind, 'custom'); assert.equal(saved.connectionId, w.a); assert.equal(notes(w.custom, id).length + notes(w.main, id).length, 0, 'no separate request');
  await change(w, w.custom, id, { effort: 'high' }, identity); assert.equal(w.bridge.outbox.get(id).pending.id, saved.pending.id);
  // the router's own same-connection commit reports through the same single point
  const kit = w.bridge.contextKit(); assert.equal(typeof kit.accepted, 'function'); kit.accepted({ peer: w.bridge.selections.get(id).peer, kind: 'custom', connectionId: w.a, id, model: 'a1', effort: 'low' });
  assert.equal(w.bridge.outbox.get(id).pending.to.effort, 'low'); assert.equal(w.bridge.outbox.get(id).pending.from.effort, null, 'still from what the model last saw');
  cold(w); w.custom.threads.get(id).state = { reasoningEffort: 'low' }; // a cold start: the thread is resumed first, and its own answer reports what was last accepted
  await w.bridge.request('thread/resume', { threadId: id }); assert.equal(owed(w), 1, 'the resume does not lose the note');
  await start(w, id, 'custom request');
  const sent = carried(w.custom, id); assert.equal(sent.length, 1, 'the turn goes to the connection that runs the thread'); assert.equal(carried(w.main, id).length, 0);
  const note = noteOf(sent[0]); assert.equal(note.kind, 'application'); assert.match(note.value, new RegExp(`changed from custom connection ${w.a.slice(0, 8)} · a1 \\(reasoning not set\\) to custom connection ${w.a.slice(0, 8)} · a1 \\(reasoning low\\)\\.`));
  assert.equal(owed(w), 0); await running(w.custom, id, 'turn-2'); await finished(w.custom, id, 'turn-2'); await start(w, id, 'again'); assert.equal(noteOf(carried(w.custom, id).at(-1)), null);
  // a refused custom turn keeps nothing consumed
  await change(w, w.custom, id, { effort: 'medium' }, identity); w.custom.failTurn = true; await assert.rejects(start(w, id, 'refused')); assert.equal(owed(w), 1); w.custom.failTurn = false;
});

test('native window binding: only the event of the LIVE turn that names this thread counts and it belongs to the model that turn started on; late, finished, wrong-turn and old-model events never describe the current model', async t => {
  const w = await world(); t.after(w.close); const id = await nativeChat(w);
  const usage = (turnId, window, server = w.main, threadId = id) => { server.notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: {}, last: {}, modelContextWindow: window } }); return tick(); };
  await usage('turn-1', 100_000); assert.equal(w.bridge.budgets.get('native', 'gpt-test'), null, 'no live turn: nothing');
  await running(w.main, id, 'turn-1'); await usage('turn-0', 111_111); assert.equal(w.bridge.budgets.get('native', 'gpt-test'), null, 'a turn that is not the live one');
  await usage('turn-1', 200_000); assert.equal(w.bridge.budgets.get('native', 'gpt-test').contextWindow, 200_000);
  await finished(w.main, id, 'turn-1'); await usage('turn-1', 123_456); assert.equal(w.bridge.budgets.get('native', 'gpt-test').contextWindow, 200_000, 'a late event of a finished turn');
  // the model is changed; a delayed event of the old turn must not become the new model's window
  await change(w, w.main, id, { model: 'gpt-other', effort: null }); await usage('turn-1', 333_333); assert.equal(w.bridge.budgets.get('native', 'gpt-other'), null); assert.equal(w.bridge.budgets.get('native', 'gpt-test').contextWindow, 200_000);
  await running(w.main, id, 'turn-2'); await usage('turn-1', 444_444); assert.equal(w.bridge.budgets.get('native', 'gpt-other'), null, 'the old turn is not the live one');
  await usage('turn-2', 500_000); assert.equal(w.bridge.budgets.get('native', 'gpt-other').contextWindow, 500_000, 'the live turn, on the model it started on'); assert.equal(w.bridge.budgets.get('native', 'gpt-test').contextWindow, 200_000);
  // a model change DURING a live turn does not move that turn's window to the new model
  await change(w, w.main, id, { model: 'gpt-late', effort: null }); await usage('turn-2', 600_000); assert.equal(w.bridge.budgets.get('native', 'gpt-late'), null); assert.equal(w.bridge.budgets.get('native', 'gpt-other').contextWindow, 600_000, 'recorded for the model the turn is running on');
  await finished(w.main, id, 'turn-2');
  // another connection's turn and a custom thread record nothing
  const custom = await customChat(w); await running(w.custom, custom, 'c-1'); await usage('c-1', 8192, w.custom, custom); assert.equal(w.bridge.budgets.get('native', 'a1'), null);
  await usage('c-1', 8192, w.main, custom); assert.equal(w.bridge.budgets.get('native', 'a1'), null);
});

// ---- the first request after a reduced hand-off: the actual input, the exact receiving model, durable ------------------------------------------------------------
const REDUCED = { window: 100_000, tokens: 30_000, reserves: { instructions: 6000, tools: 3000, request: 8000, output: 10_000, margin: 15_000 }, budget: { key: 'native:openai:gpt-test', route: 'native', model: 'gpt-test', source: 'native-token-event', at: 1 } };
const gateFor = (...args) => { const [w, id, model = 'gpt-test'] = typeof args[0] === 'string' ? [CURRENT, ...args] : args; return w.bridge.contextKit().reduced(id, REDUCED, { kind: 'native', model }); };
const gatesCold = w => { w.bridge.gates.load(); w.bridge.gatesDone.clear(); };
const sentTurns = (server, since = 0) => server.seen.slice(since).filter(c => c.method === 'turn/start').length;

test('the first request after a REDUCED hand-off counts everything it carries (input, additionalContext, output schema, note) against the budget of the model that RECEIVES it; durable across a cold start; refused (nothing sent) otherwise; cleared once the first turn was accepted', async t => {
  const w = await world(); t.after(w.close); w.bridge.budgets.set(budgetEntry('native', 'gpt-test'));
  const id = await nativeChat(w); assert.equal(gateFor(w, id), true); gatesCold(w); assert.equal(w.bridge.gates.get(id).target.model, 'gpt-test', 'the exact model is bound, read back from the durable file'); assert.equal(w.bridge.gates.get(id).budget.source, 'native-token-event');
  const before = w.main.seen.length, refused = async (extra, text = 'small current request') => { await assert.rejects(start(w, id, text, extra), { code: 'handoff_request_too_large' }); assert.equal(sentTurns(w.main, before), 0, 'nothing was sent'); };
  await refused({}, 'x'.repeat(200_000));
  await refused({ additionalContext: { synthetic: { kind: 'untrusted', value: 'z'.repeat(150_000) } } }); // a small input must not hide an enormous context fragment
  await refused({ outputSchema: { type: 'object', description: 'y'.repeat(150_000) } });
  assert.equal(w.bridge.gates.get(id).state, 'required', 'still required after every refusal'); gatesCold(w); assert.ok(w.bridge.gateFor(id));
  await start(w, id, 'a normal request'); assert.equal(sentTurns(w.main, before), 1);
  assert.equal(w.bridge.gates.get(id).state, 'done'); gatesCold(w); assert.equal(w.bridge.gateFor(id).state, 'done', 'cleared durably (nothing is owed any more)');
  await start(w, id, 'x'.repeat(200_000)); assert.equal(sentTurns(w.main, before), 2, 'only the FIRST request is gated');
  // another model than the one the hand-off was sized for: its OWN window decides, an unknown one refuses, model A's window is never used for model B
  const other = await nativeChat(w); gateFor(other); const base = w.main.seen.length;
  await assert.rejects(start(w, other, 'hello', { model: 'gpt-other' }), { code: 'handoff_request_too_large' }); assert.equal(sentTurns(w.main, base), 0, 'no window known for gpt-other');
  w.bridge.budgets.set(budgetEntry('native', 'gpt-other', { contextWindow: 20_000, maxOutputTokens: 2000 })); // far smaller: the 30k handoff cannot fit there
  await assert.rejects(start(w, other, 'hello', { model: 'gpt-other' }), { code: 'handoff_request_too_large' }); assert.equal(sentTurns(w.main, base), 0);
  w.bridge.budgets.set(budgetEntry('native', 'gpt-other', { contextWindow: 200_000, maxOutputTokens: 2000 })); await start(w, other, 'hello', { model: 'gpt-other' }); assert.equal(sentTurns(w.main, base), 1, 'its own known window holds it');
  // a refused first turn keeps the requirement
  const third = await nativeChat(w); gateFor(third); w.main.failTurn = true; await assert.rejects(start(w, third, 'small')); w.main.failTurn = false; assert.equal(w.bridge.gates.get(third).state, 'required');
  const none = await nativeChat(w); await start(w, none, 'x'.repeat(200_000)); // a thread that never had a reduction is never gated
});

test('a damaged gate file is never read as "no gate": the gate is rebuilt from the same durable hand-off sidecar, a thread without one is unaffected, and the explicit recovery sets the file aside', async t => {
  const w = await world(); t.after(w.close); w.bridge.budgets.set(budgetEntry('native', 'gpt-test'));
  const guarded = await nativeChat(w), plain = await nativeChat(w);
  w.router.writeHandoff(guarded, { version: 1, turns: [], context: { version: 'bridge.handoff/2', mode: 'reduced', ...REDUCED } });
  writeFileSync(w.bridge.gates.path, '{ not json'); w.bridge.gates.load(); assert.equal(w.bridge.gates.isDamaged(guarded), true);
  const before = w.main.seen.length;
  await assert.rejects(start(w, guarded, 'x'.repeat(200_000)), { code: 'handoff_request_too_large' }); assert.equal(sentTurns(w.main, before), 0);
  await start(w, plain, 'x'.repeat(200_000)); assert.equal(sentTurns(w.main, before), 1, 'no sidecar, no gate');
  await start(w, guarded, 'small'); assert.equal(sentTurns(w.main, before), 2, 'the rebuilt gate passes a request that fits');
  assert.equal(gateFor(await nativeChat(w)), false, 'no new gate can be written over a damaged file'); assert.equal(w.bridge.gates.lastError, 'damaged');
  const aside = w.bridge.repairContextState('gates'); assert.match(aside, /context-gates\.json\.damaged-\d+$/); assert.equal(w.bridge.gates.isDamaged('anything'), false); assert.equal(gateFor(await nativeChat(w)), true, 'healthy again');
});

test('critical state is durable or refused, never best effort: a failed write, a full map and a damaged entry all fail closed, before the hand-off commits or the runtime is asked', async t => {
  const w = await world(); t.after(w.close); const id = await nativeChat(w), calls = [];
  w.bridge.gates.sync = fd => { calls.push(fd); }; assert.equal(gateFor(id), true); assert.equal(calls.length, 2, 'the file and then its directory are fsynced through the injected sync');
  // a write that fails leaves memory and the old file exactly as they were
  const other = await nativeChat(w); w.bridge.gates.sync = () => { throw new Error('disk full'); };
  assert.equal(gateFor(other), false); assert.equal(w.bridge.gates.get(other), null, 'no undurable obligation in memory'); w.bridge.gates.sync = () => {}; w.bridge.gates.load(); assert.equal(w.bridge.gates.get(other), null); assert.ok(w.bridge.gates.get(id));
  // capacity: an unfinished gate is never evicted; a finished one may be reaped
  w.bridge.gates.limit = 2; const c = await nativeChat(w), d = await nativeChat(w);
  assert.equal(gateFor(c), true); assert.equal(gateFor(d), false); assert.equal(w.bridge.gates.lastError, 'capacity'); w.bridge.gates.load(); assert.ok(w.bridge.gates.get(id) && w.bridge.gates.get(c), 'both earlier obligations survive a cold start');
  w.bridge.gates.set(id, { ...w.bridge.gates.get(id), state: 'done' }); assert.equal(gateFor(d), true, 'the finished one made room'); assert.equal(w.bridge.gates.get(id), null); assert.ok(w.bridge.gates.get(c));
  // an invalid entry is damage for ITS key: reported, kept untouched in the file, never "absent"
  const text = JSON.parse(readFileSync(w.bridge.gates.path, 'utf8')); text.entries.broken = { window: 'x' }; writeFileSync(w.bridge.gates.path, JSON.stringify(text)); w.bridge.gates.load();
  assert.equal(w.bridge.gates.isDamaged('broken'), true); assert.equal(w.bridge.gates.isDamaged(c), false); w.bridge.gates.limit = 8; assert.equal(gateFor(await nativeChat(w)), true); assert.ok(JSON.parse(readFileSync(w.bridge.gates.path, 'utf8')).entries.broken, 'the damaged entry is preserved');
});

test('a model-change note that cannot be made durable fails closed: nothing is sent while it is only in memory, and a change is not made to the runtime unless its intent was written first', async t => {
  const w = await world(); t.after(w.close); const id = await nativeChat(w);
  await running(w.main, id); await finished(w.main, id);
  // the confirmed change arrives (the runtime already changed) but the disk refuses: the obligation is held in memory, dispatch is refused until it can be written
  w.bridge.outbox.sync = () => { throw new Error('disk full'); }; await change(w, w.main, id, { effort: 'low' });
  assert.equal(w.bridge.selections.get(id).unsaved, true); const before = w.main.seen.length;
  await assert.rejects(start(w, id, 'blocked'), { code: 'context_state_unwritable' }); assert.equal(sentTurns(w.main, before), 0);
  w.bridge.outbox.sync = () => {}; await start(w, id, 'now'); assert.equal(noteOf(carried(w.main, id).at(-1)).kind, 'application'); assert.equal(owed(w), 0);
  // the intent is written BEFORE the runtime is asked: when it cannot be, the runtime is not asked
  await running(w.main, id, 'turn-2'); await finished(w.main, id, 'turn-2'); w.bridge.outbox.sync = () => { throw new Error('disk full'); }; const asked = w.main.seen.length;
  await assert.rejects(w.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-other' }), { code: 'context_state_unwritable' }); assert.equal(w.main.seen.slice(asked).some(c => c.method === 'thread/settings/update'), false);
  w.bridge.outbox.sync = () => {};
  // with the intent written, an unconfirmed outcome is settled from the runtime's public readback at the next dispatch (no event ever came, the runtime did not change): nothing is announced
  w.main.threads.get(id).state = { reasoningEffort: 'low' };
  await w.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-other' }).catch(() => {}); // (the fake has no settings handler: refused)
  assert.equal(w.bridge.selections.get(id).intent !== null, true, 'an error answer does not prove nothing happened: the intent stays'); const resumes = w.main.seen.length;
  await start(w, id, 'after'); assert.ok(w.main.seen.slice(resumes).some(c => c.method === 'thread/resume'), 'settled by the public readback'); assert.equal(w.bridge.selections.get(id).intent, null); assert.equal(noteOf(carried(w.main, id).at(-1)), null, 'the runtime did not change: no note');
});

test('EXACTLY ONCE with an uncertain turn: only a POSITIVE public match of the stable client message id settles it (accepted-then-error, reply lost + cold start); every absence, error answer, spoofed claim, "not materialized" and busy thread HOLDS dispatch with the record intact; only a trusted LOCAL never-sent proof (connection already closed) clears it; the prompt and the note are never sent again to find out', async t => {
  const prime = async () => { const w = await world(); t.after(w.close); const id = await nativeChat(w); await running(w.main, id); await finished(w.main, id); await change(w, w.main, id, { effort: 'low' }); return { w, id }; };
  const notesIn = (w, id) => carried(w.main, id).filter(c => noteOf(c)).length;
  // 1. the runtime accepted the turn, then answered with an ERROR: the note was consumed once; the next turn carries none
  { const { w, id } = await prime(); w.main.acceptThenFail = true; await assert.rejects(start(w, id, 'first'));
    const entry = JSON.parse(readFileSync(w.bridge.outbox.path, 'utf8')).entries[id]; assert.ok(entry.dispatching.clientId && entry.dispatching.noticeId === entry.pending.id, 'bound durably, before transport, to the client message id and the note id');
    assert.equal(carried(w.main, id)[0].params.clientUserMessageId, entry.dispatching.clientId); w.main.acceptThenFail = false;
    await start(w, id, 'second'); assert.equal(notesIn(w, id), 1, 'one consumption'); assert.equal(noteOf(carried(w.main, id).at(-1)), null); assert.equal(owed(w), 0); assert.equal(carried(w.main, id).length, 2, 'no prompt was sent again'); }
  // 2. the reply is LOST (the connection broke after the runtime accepted the turn); a cold start; the public record shows it was accepted
  { const { w, id } = await prime(); const real = w.native.request.bind(w.native); w.native.request = async (m, p, ...rest) => { const r = await real(m, p, ...rest); if (m === 'turn/start') throw new Error('RPC connection closed'); return r; };
    await assert.rejects(start(w, id, 'first')); w.native.request = real; cold(w); w.bridge.selections.clear();
    await start(w, id, 'second'); assert.equal(notesIn(w, id), 1); assert.equal(carried(w.main, id).length, 2); assert.equal(owed(w), 0); }
  // 3. an ERROR ANSWER from the runtime is not "never sent" (it may have applied part of the request, or an earlier send may still arrive): ABSENCE settles nothing - not with the thread idle and
  //    the whole record read, not with other client ids present, not after a cold start. Dispatch is held, nothing extra is sent, the dispatch and the note stay exactly as recorded.
  { const { w, id } = await prime(); w.main.failTurn = true; await assert.rejects(start(w, id, 'first')); w.main.failTurn = false; const recorded = JSON.stringify(w.bridge.outbox.get(id));
    for (const phase of ['idle, complete record, nothing in it', 'other client ids present', 'after a cold start']) {
      if (phase === 'other client ids present') filler(w.main, 3); if (phase === 'after a cold start') cold(w); const before = w.main.seen.length;
      await assert.rejects(start(w, id, 'second'), { code: 'transition_uncertain' }, phase); assert.equal(sentTurns(w.main, before), 0, phase + ': no extra dispatch'); assert.equal(JSON.stringify(w.bridge.outbox.get(id)), recorded, phase + ': the durable record is exactly as it was'); }
    assert.equal(owed(w), 1); }
  // 4. "not materialized yet" AFTER an unknown send, and a thread that is busy, are no negative proof either
  { const { w, id } = await prime(); w.main.failTurn = true; await assert.rejects(start(w, id, 'first')); w.main.failTurn = false; let before = w.main.seen.length;
    w.main.unmaterialized = true; await assert.rejects(start(w, id, 'second'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0); assert.equal(owed(w), 1); w.main.unmaterialized = false;
    w.main.busy = true; await assert.rejects(start(w, id, 'third'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0); w.main.busy = false; assert.equal(owed(w), 1); }
  // 5. a remote error that CLAIMS in its data that the request was never sent (or not answered) is just a remote error: unknown: it holds
  { const { w, id } = await prime(); w.main.failTurn = true; w.main.spoof = true; await assert.rejects(start(w, id, 'first'), error => { assert.equal(neverSent(error), false); assert.equal(error.data.notSent, true, '(the claim reached the Bridge as plain data)'); return true; }); w.main.failTurn = false; w.main.spoof = false;
    assert.ok(w.bridge.outbox.get(id).dispatching, 'the dispatch is still recorded'); const before = w.main.seen.length; await assert.rejects(start(w, id, 'second'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0);
    assert.equal(owed(w), 1, 'still held and still owed: a claim in data is no proof and there is no bypass'); assert.equal(sentTurns(w.main, before), 0); }
  // 6. the connection was ALREADY CLOSED: a trusted local proof that nothing was written: the attempt is cleared, the note stays owed, nothing was sent, and the next turn carries it once
  { const { w, id } = await prime(); const before = w.main.seen.length; w.native.closed = true; await assert.rejects(start(w, id, 'first'), error => neverSent(error) === true); w.native.closed = false;
    assert.equal(sentTurns(w.main, before), 0, 'zero actual sends'); assert.equal(w.bridge.selections.get(id).dispatching, null); assert.equal(owed(w), 1, 'the note is still owed'); assert.equal(w.bridge.outbox.get(id).dispatching ?? null, null, 'cleared durably');
    await start(w, id, 'second'); assert.equal(notesIn(w, id), 1); assert.equal(owed(w), 0);
    // ... but a connection that closed AFTER the write is unknown (the runtime may have it): not branded
    const { w: v, id: vid } = await prime(); const real = v.native.request.bind(v.native); v.native.request = async (m, p, ...rest) => { const r = await real(m, p, ...rest); if (m === 'turn/start') { v.native.end(); throw new RpcError('RPC connection closed'); } return r; }; // (the runtime took it; the connection ended before the answer was read)
    await assert.rejects(start(v, vid, 'first'), error => neverSent(error) === false); assert.ok(v.bridge.outbox.get(vid).dispatching, 'a closed connection after the write stays unknown'); }
  // a lost-peer failure never claims anything either: the unbranded errors the Peer itself produces
  assert.equal(neverSent(new RpcError('RPC connection closed')), false); assert.equal(neverSent(new RpcError('turn/start timed out')), false); assert.equal(neverSent(Object.assign(new RpcError('x', -32603, { notSent: true }), { answered: false })), false); assert.equal(neverSent({ message: 'RPC connection closed' }), false);
});

test('a CUSTOM turn carries the model-change note on THAT turn when its own request changes the effective level (the route\'s mapped selection at the validated peer boundary), once; a custom turn answered with an error is unknown: it holds the next dispatch', async t => {
  const w = await world(); t.after(w.close); const id = await customChat(w);
  await running(w.custom, id); await finished(w.custom, id);
  await start(w, id, 'with a new level', { effort: 'none' });
  const sent = carried(w.custom, id); assert.equal(sent.length, 1); assert.equal(carried(w.main, id).length, 0);
  const note = noteOf(sent[0]); assert.equal(note.kind, 'application'); assert.match(note.value, new RegExp(`changed from custom connection ${w.a.slice(0, 8)} · a1 \\(reasoning not set\\) to custom connection ${w.a.slice(0, 8)} · a1 \\(reasoning none\\)\\.`));
  assert.equal(sent[0].params.effort, 'none'); assert.equal(w.bridge.selections.get(id).now.effort, 'none'); assert.equal(owed(w), 0);
  await running(w.custom, id, 'turn-2'); await finished(w.custom, id, 'turn-2'); await start(w, id, 'again with the same level', { effort: 'none' }); assert.equal(noteOf(carried(w.custom, id).at(-1)), null, 'the same level again is no transition');
  // a cold start keeps what the model last saw: the next turn-level change is still announced from it
  cold(w); w.custom.threads.get(id).state = { reasoningEffort: 'none' }; await w.bridge.request('thread/resume', { threadId: id });
  await running(w.custom, id, 'turn-3'); await finished(w.custom, id, 'turn-3'); await start(w, id, 'cold', { effort: 'high' }); assert.match(noteOf(carried(w.custom, id).at(-1)).value, /\(reasoning none\) to custom connection .* \(reasoning high\)/);
  // the same request answered with an ERROR by the runtime is unknown (not provably unsent): the dispatch stays recorded, nothing changes, the next dispatch is held (nothing extra is sent)
  await running(w.custom, id, 'turn-4'); await finished(w.custom, id, 'turn-4');
  w.custom.failTurn = true; await assert.rejects(start(w, id, 'refused', { effort: 'low' })); w.custom.failTurn = false; assert.equal(owed(w), 1); assert.equal(w.bridge.selections.get(id).now.effort, 'high'); const held = carried(w.custom, id).length;
  await assert.rejects(start(w, id, 'retry', { effort: 'low' }), { code: 'transition_uncertain' }); assert.equal(carried(w.custom, id).length, held, 'no extra dispatch');
});

test('a same-connection custom model change writes its INTENT first (refused, the runtime not asked, if it cannot be written); once committed the note goes with the next turn; a hand-off child (seeded baseline) is announced from it on its FIRST turn, also after a cold start', async t => {
  const w = await world(); t.after(w.close); const id = await customChat(w); await running(w.custom, id); await finished(w.custom, id);
  const a2 = localModelId(w.a, 'a2'), asked = () => w.custom.seen.filter(c => c.method === 'thread/settings/update').length;
  w.bridge.outbox.sync = () => { throw new Error('disk full'); };
  await assert.rejects(w.bridge.request('thread/settings/update', { threadId: id, model: a2 }), { code: 'context_state_unavailable' }); assert.equal(asked(), 0, 'the runtime was not asked'); assert.equal(w.bridge.selections.get(id).now.model, 'a1');
  w.bridge.outbox.sync = () => {}; await w.bridge.request('thread/settings/update', { threadId: id, model: a2 }); assert.equal(asked(), 1); assert.equal(owed(w), 1); assert.equal(w.bridge.selections.get(id).intent, null, 'the confirmed change settled the intent');
  await start(w, id, 'next'); assert.match(noteOf(carried(w.custom, id).at(-1)).value, new RegExp(`· a1 \\(reasoning not set\\) to custom connection ${w.a.slice(0, 8)} · a2 \\(reasoning not set\\)\\.`)); assert.equal(owed(w), 0);
  // a hand-off child has had no turn of its own, but its model was given the history and the note: that selection is what it last saw
  const child = await customChat(w), kit = w.bridge.contextKit(); assert.equal(kit.seed({ peer: w.bridge.selections.get(child).peer, kind: 'custom', connectionId: w.a, id: child, model: 'a1', effort: 'medium' }), true);
  cold(w); w.custom.threads.get(child).state = { reasoningEffort: 'medium' }; await w.bridge.request('thread/resume', { threadId: child });
  await start(w, child, 'first', { effort: 'none' }); const first = carried(w.custom, child); assert.equal(first.length, 1); assert.match(noteOf(first[0]).value, /\(reasoning medium\) to custom connection .* \(reasoning none\)/, 'on the FIRST receiving turn, not one turn late');
});

// ---- edge repairs: the public record is read to the END before absence is believed; a rebuilt gate is validated strictly ------------------------------------------------
const filler = (server, n, clientId = i => 'filler-' + i) => { server.turns ??= []; for (let i = 0; i < n; i++) server.turns.push({ id: 'f' + i, status: 'completed', items: [{ type: 'userMessage', id: 'fu' + i, clientId: clientId(i), content: [] }] }); };

test('EXACTLY ONCE across PAGES: an accepted turn that is on a LATER page of the public record is found (bounded pagination), settles the note once and sends nothing again; an incomplete, repeating, over-long or unrepresented record is UNDETERMINED and holds dispatch', async t => {
  const prime = async () => { const w = await world(); t.after(w.close); const id = await nativeChat(w); await running(w.main, id); await finished(w.main, id); await change(w, w.main, id, { effort: 'low' }); return { w, id }; };
  const listCalls = w => w.main.seen.filter(c => c.method === 'thread/turns/list');
  // 1. the dispatch was accepted (the answer was an error); 30 later turns push it to the SECOND page; a cold start; the next dispatch finds it and sends neither the note nor the prompt again
  { const { w, id } = await prime(); w.main.acceptThenFail = true; await assert.rejects(start(w, id, 'first')); w.main.acceptThenFail = false; filler(w.main, 30); w.main.pageSize = 20; cold(w);
    const before = w.main.seen.length; await start(w, id, 'second');
    assert.ok(listCalls(w).some(c => c.params.cursor === 'at-20'), 'the second page was read'); assert.equal(carried(w.main, id).filter(c => noteOf(c)).length, 1, 'one consumption'); assert.equal(carried(w.main, id).length, 2, 'the first prompt was not sent again'); assert.equal(noteOf(carried(w.main, id).at(-1)), null); assert.equal(owed(w), 0); assert.equal(sentTurns(w.main, before), 1); }
  // 2. not found on a first page that says there is more: NOT declared absent; with a cursor that never ends (repeated) the outcome is undetermined, nothing is sent; and even a COMPLETE record that
  //    does not hold it is no negative proof (the earlier send may still arrive): still held
  { const { w, id } = await prime(); w.main.failTurn = true; await assert.rejects(start(w, id, 'first')); w.main.failTurn = false; filler(w.main, 30); w.main.pageSize = 20; w.main.stuckCursor = true; const before = w.main.seen.length;
    await assert.rejects(start(w, id, 'second'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0); assert.equal(owed(w), 1, 'the dispatch and the note are still owed, not cleared');
    w.main.stuckCursor = false; await assert.rejects(start(w, id, 'third'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0, 'a complete record without it is not a negative barrier'); assert.equal(owed(w), 1); }
  // 3. a record longer than the bound (one turn per page, more pages than the bound) is undetermined, never "absent"
  { const { w, id } = await prime(); w.main.failTurn = true; await assert.rejects(start(w, id, 'first')); w.main.failTurn = false; filler(w.main, 80); w.main.pageSize = 1; const before = w.main.seen.length;
    await assert.rejects(start(w, id, 'second'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0); assert.equal(listCalls(w).length <= 52, true, 'the read is bounded'); assert.equal(owed(w), 1); }
  // 4. a complete record of user messages none of which carries a client id: the runtime may not echo them, so absence is unproven: held
  { const { w, id } = await prime(); w.main.failTurn = true; await assert.rejects(start(w, id, 'first')); w.main.failTurn = false; filler(w.main, 3, () => null); const before = w.main.seen.length;
    await assert.rejects(start(w, id, 'second'), { code: 'transition_uncertain' }); assert.equal(sentTurns(w.main, before), 0); assert.equal(owed(w), 1); }
  // 5. the exact synthetic shape of a partial public history (20 later turns, nextCursor, the client id on the second page, thread idle), called directly
  { const { w, id } = await prime(); const clientId = 'target-client-id', from = { route: { kind: 'native' }, model: 'gpt-test', effort: 'high' }, to = { route: { kind: 'native' }, model: 'gpt-test', effort: 'low' }, calls = [];
    const peer = { request: async (m, p) => { calls.push([m, p]); if (m === 'thread/turns/list') return p.cursor ? { data: [{ id: 'earlier', items: [{ type: 'userMessage', id: 'x', clientId }] }], nextCursor: null } : { data: Array.from({ length: 20 }, (_, i) => ({ id: 'later-' + i, items: [] })), nextCursor: 'next-page' }; if (m === 'thread/read') return { thread: { id, status: { type: 'idle' } } }; throw new Error('unexpected ' + m); } };
    const entry = w.bridge.selections.get(id); Object.assign(entry, { pending: entry.pending, dispatching: { noticeId: entry.pending.id, clientId, from, to } });
    await w.bridge.reconcileDispatch(id, entry, peer); assert.equal(entry.dispatching, null); assert.equal(entry.pending, null, 'accepted: the note is consumed'); assert.deepEqual(entry.seen, to); assert.equal(calls.filter(([m]) => m === 'thread/turns/list').length, 2); assert.equal(calls.some(([m]) => m === 'thread/read'), false, 'found: nothing else is asked'); }
});

test('a gate rebuilt from the durable hand-off sidecar (the gate file damaged) is validated STRICTLY: malformed, missing, non-finite, negative or foreign values are damage reported before anything is sent; nothing is defaulted; the sidecar and the damaged file are left as they were; a full or absent context owes no gate', async t => {
  const w = await world(); t.after(w.close); w.bridge.budgets.set(budgetEntry('native', 'gpt-test'));
  writeFileSync(w.bridge.gates.path, '{ invalid synthetic gates'); w.bridge.gates.load();
  const good = { version: 'bridge.handoff/2', mode: 'reduced', window: 10_000, tokens: 2000, reserves: { instructions: 1000, tools: 1000, output: 1000, margin: 500 }, budget: { key: 'native:openai:gpt-test', route: 'native', model: 'gpt-test', source: 'native-token-event', at: 1 } };
  const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
  const variants = {
    'a reserve that is a string': { ...good, reserves: { instructions: 'broken' } }, 'reserves with missing parts': { ...good, reserves: { instructions: 1000, tools: 1000 } }, 'a reserve that is not a number (NaN serialized)': { ...good, reserves: { ...good.reserves, output: null } },
    'a negative reserve': { ...good, reserves: { ...good.reserves, margin: -1 } }, 'a fractional reserve': { ...good, reserves: { ...good.reserves, tools: 10.5 } }, 'no reserves at all': without(good, 'reserves'), 'reserves that are not an object': { ...good, reserves: 5 },
    'window a string': { ...good, window: '10000' }, 'window below the minimum': { ...good, window: 500 }, 'window missing': without(good, 'window'), 'tokens negative': { ...good, tokens: -5 }, 'tokens missing': without(good, 'tokens'), 'tokens a string': { ...good, tokens: '2000' },
    'no budget provenance': without(good, 'budget'), 'budget not an object': { ...good, budget: 'x' }, 'a budget of another route': { ...good, budget: { ...good.budget, route: 'custom' } }, 'a budget without a model': { ...good, budget: { ...good.budget, model: '' } }, 'a budget without a source': { ...good, budget: { ...good.budget, source: null } },
    'an unknown mode': { ...good, mode: 'bogus' }, 'a context that is not an object': 'reduced',
  };
  for (const [label, context] of Object.entries(variants)) {
    const id = await nativeChat(w), side = { version: 1, turns: [], context }; w.router.writeHandoff(id, side); const bytes = readFileSync(w.router.handoffPath(id), 'utf8'), before = w.main.seen.length;
    await assert.rejects(start(w, id, 'q'.repeat(100_000)), { code: 'context_state_damaged' }, label); assert.equal(sentTurns(w.main, before), 0, label + ': nothing was sent');
    await assert.rejects(start(w, id, 'small'), { code: 'context_state_damaged' }, label + ' (even a small one: the gate cannot be known)'); assert.equal(readFileSync(w.router.handoffPath(id), 'utf8'), bytes, label + ': the sidecar is untouched'); assert.deepEqual(w.router.readHandoff(id).turns, [], label + ': no history was made up');
  }
  assert.equal(readFileSync(w.bridge.gates.path, 'utf8'), '{ invalid synthetic gates', 'the damaged file is untouched');
  // the same record, valid: the rebuilt gate refuses what does not fit and passes what does
  const ok = await nativeChat(w); w.router.writeHandoff(ok, { version: 1, turns: [], context: { ...good, window: 100_000, tokens: 30_000, reserves: { instructions: 6000, tools: 3000, output: 10_000, margin: 15_000 } } }); const base = w.main.seen.length;
  await assert.rejects(start(w, ok, 'q'.repeat(200_000)), { code: 'handoff_request_too_large' }); await start(w, ok, 'fits'); assert.equal(sentTurns(w.main, base), 1);
  // a FULL context, and no context, owe no gate: the history stays full
  for (const context of [{ version: 'bridge.handoff/2', mode: 'full', summary: { text: 'kept' } }, undefined]) { const id = await nativeChat(w); w.router.writeHandoff(id, { version: 1, turns: [], ...(context ? { context } : {}) }); const sent = w.main.seen.length; await start(w, id, 'q'.repeat(200_000)); assert.equal(sentTurns(w.main, sent), 1); }
  // the arithmetic guard itself: a NaN anywhere refuses, never "fits"
  const nan = await nativeChat(w); w.bridge.gates.entries.set(nan, { state: 'required', window: 10_000, handoffTokens: NaN, parts: { instructions: 1, tools: 1, output: 1, margin: 1 } }); const guard = w.main.seen.length;
  await assert.rejects(start(w, nan, 'x'.repeat(100_000)), { code: 'context_state_damaged' }); assert.equal(sentTurns(w.main, guard), 0);
});

test('SDK first query: the ACTUAL system instructions are measured at the last safe point (a known window that cannot hold them sends nothing to the model); a stored reduction whose visible prefix CONTENT changed under the same ids is no reduction', async () => {
  const f = fixture(); const { id, record } = await claudeChat(f, { turns: 3, session: null });
  record.turns = record.turns.map(t => t); f.bridge.save(record); f.bridge.budgets.set(budgetEntry('claude', 'sonnet')); record.modeInstructions = 'm'.repeat(300_000); // (~100k tokens of instructions, invisible to the earlier estimate)
  const sent = await f.send(id, 'hello'); await f.done(sent.turn.id); const last = f.bridge.records.get(id).turns.at(-1);
  assert.equal(last.status, 'failed'); assert.match(last.error.message, /does not fit its known context window together with its instructions/); assert.equal(f.queries.length, 0, 'nothing was sent to the model'); assert.equal(f.bridge.records.get(id).turns.length, 4, 'the history is unchanged and the request is recorded once');
  // the same instructions with no known window are carried as before (no fit is claimed)
  const g = fixture(); const open = await claudeChat(g, { turns: 3, session: null }); open.record.modeInstructions = 'm'.repeat(300_000); await turn(g, open.id, 'hello'); assert.equal(g.queries.length, 1);
  // the reduction is bound to the exact visible content, not to ids
  const h = fixture(); const big = await claudeChat(h, { turns: 0, session: null }); big.record.turns = Array.from({ length: 220 }, (_, i) => earlier(i + 1, `question ${i + 1} ${FILL}`));
  const covered = qualifySdkCompaction(hook({ session_id: 's0' }), { sessionId: 's0', model: 'opus', cwd: CWD, turns: [...big.record.turns.slice(0, 200), { id: 'cur', status: 'inProgress', items: [] }], currentTurnId: 'cur', revision: 1, now: 1 }).snapshot;
  h.bridge.budgets.set(budgetEntry('claude', 'sonnet')); const decided = decide({ transfer: buildTransfer(big.record.turns), summary: covered, budget: h.bridge.budgets.get('claude', 'sonnet'), reachable: true, claude: true }); assert.equal(decided.mode, 'reduced');
  big.record.contextHandoff = decided.context; big.record.turns[2].items[0].content[0].text = 'CHANGED-FACT-SAME-IDS';
  await assert.rejects(h.send(big.id, 'hello'), /no valid shortened context exists/); assert.equal(h.queries.length, 0); assert.equal(big.record.turns.length, 220, 'nothing was recorded, nothing was sent');
});
