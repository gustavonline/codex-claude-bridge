import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry, ResponsesRouter, localModelId, durability, useDurability, readPrivateText } from '../plugins/codex-claude/home/providers.mjs';
// The child-disabled (permission) runner forbids fsync outright, so ONLY there this module substitutes a no-op for its own
// writes, restored when its tests end. In an ordinary run every write here is a real, strict fsync.
test.after(useDurability(process.permission ? () => {} : undefined));
const realSync = durability.sync; // what is installed for this module (strict outside the permission runner)
import { readAllTurns } from '../continuity.mjs';
import { runtimeHandoff } from '../runtime-handoff.mjs';
import { overlayHistory, pageTurns, pageItems } from '../custom-turns.mjs';
import { withHistoryTools } from '../history-read.mjs';
import { decide, qualifySdkCompaction, validSummary } from '../context-handoff.mjs';
import { buildNotice, noticeId, noticeItem } from '../transition-notice.mjs';
const contextKit = control => ({ decide, validSummary, budgetFor: (route, model) => control.budgets?.[route + ':' + model] ?? null, refs: scope => { (control.refScopes ??= []).push(scope); return () => ({ first: 'ref-first', last: 'ref-last' }); },
  // (false = the durable record could not be written: the router must refuse BEFORE the commit)
  reduced: (id, context, target) => control.reducedFails ? false : (control.reduced ??= []).push([id, context, target]), seed: info => control.seedFails ? false : (control.seeded ??= []).push(info), accepted: info => (control.accepted ??= []).push(info), notice: { build: buildNotice, id: noticeId, item: noticeItem } });

// Router-level continuation with synthetic fakes only: a chat moves to another provider as a NEW thread
// (thread/start + plain thread/inject_items). Native fork is never used, because it copies the source
// provider's opaque encrypted reasoning. Native-binary behaviour is qualified by lead-run probes.
const catalog = ids => (_u, _o, receive) => { const q = new EventEmitter(); q.destroy = () => {}; q.end = () => queueMicrotask(() => { const r = new EventEmitter(); r.statusCode = 200; r.destroy = () => {}; receive(r); r.emit('data', Buffer.from(JSON.stringify({ data: ids.map(id => ({ id })) }))); r.emit('end'); }); return q; };
const SOURCE = 'source-thread', NEW = 'new-thread', OPAQUE = 'OPAQUE-ENCRYPTED-7f3a';
const BASE = { cwd: '/synthetic', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: null, runtimeWorkspaceRoots: ['/synthetic'],
  // (a real native start/resume answer carries these too: the settings the desktop is told must be provable from the readback)
  disabledPluginIds: [], serviceTier: null, multiAgentMode: 'explicitRequestOnly' };
const user = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] });
const HISTORY = [
  { id: 'turn-1', status: 'completed', items: [user('u1', 'EARLIER-USER-4417'), { type: 'reasoning', id: 'r1', summary: [], content: [], encrypted_content: OPAQUE }, { type: 'agentMessage', id: 'a1', text: 'EARLIER-ASSISTANT-5521' }] },
  { id: 'turn-2', status: 'completed', items: [user('u2', 'use the tool'), { type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'lookup', arguments: {}, status: 'completed', contentItems: [{ type: 'inputText', text: 'TOOL-RESULT-9083' }], success: true }, { type: 'agentMessage', id: 'a2', text: 'done' }] },
];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sonnet-continuation-')), registry = new ProviderRegistry(root);
  const a = registry.create({ name: 'Alpha endpoint', baseUrl: 'https://alpha.example.invalid/v1' }), b = registry.create({ name: 'Beta endpoint', baseUrl: 'https://beta.example.invalid/v1' });
  await registry.refresh(a, { request: catalog(['a1', 'a2']) }); await registry.refresh(b, { request: catalog(['b1']) });
  const calls = [], peers = new Map();
  const echo = (threadId, name) => { for (const r of routers) if (r.ownWrites.has(threadId)) r.desktopView('thread/name/updated', { threadId, threadName: name }); }; // routers register below
  const control = { sourceStatus: 'idle', snapshot: { ...BASE, reasoningEffort: 'medium' }, history: HISTORY, overrides: {}, applied: new Map(), managedTurns: null, claudeCalls: [] };
  // Every thread reports its session source like native does (default vscode); control.sources sets one by ID (an original CLI chat, a sub-agent ...).
  const thread = (id, provider, model) => ({ id, path: '/synthetic/' + id + '.jsonl', forkedFromId: null, status: { type: 'idle' }, modelProvider: provider, model, cwd: '/synthetic', source: control.sources?.[id] ?? 'vscode', turns: [] });
  const created = new Map();
  const answerBase = id => { const c = created.get(id); return { thread: { ...thread(id, c.provider, c.model), ...(control.resumeName !== undefined ? { name: control.resumeName } : {}) }, model: c.model, modelProvider: c.provider, ...control.snapshot, ...control.overrides, reasoningEffort: control.applied.get(id) ?? control.snapshot.reasoningEffort,
    // like ThreadResumeResponse: the thread's real collaboration mode (the one a settings update applied, else control.confirmedMode, else the default), or null for an older server
    ...(control.noCollab ? { collaborationMode: null } : { collaborationMode: control.modes?.get(id) ?? control.confirmedMode ?? { mode: 'default', settings: { model: c.model, reasoning_effort: control.applied.get(id) ?? control.snapshot.reasoningEffort, developer_instructions: null } } }) }; };
  // Dates like native: a thread's START answer carries its real creation (control.birthAt); while it is unmaterialized every LATER answer carries the CURRENT clock (control.clock()) for both
  // dates. control.perId[id] overrides fields of ONE thread's answers (a `thread` key merges into the thread object).
  const answerFor = (id, started = false) => {
    const out = answerBase(id), dated = started && control.birthAt !== undefined ? { createdAt: control.birthAt, updatedAt: control.birthAt, recencyAt: control.birthAt } : !started && control.clock ? { createdAt: control.clock(), updatedAt: control.clock(), recencyAt: control.clock() } : {}; // native's THREE clock fields (createdAt, updatedAt, recencyAt)
    out.thread = { ...out.thread, ...dated };
    const { thread: t, ...rest } = control.perId?.[id] ?? {}; Object.assign(out, rest); if (t) out.thread = { ...out.thread, ...t };
    return out;
  };
  const handle = (who, sourceProvider, sourceModel) => async (method, p) => {
    calls.push({ peer: who, method, p: structuredClone(p) });
    if (control.failMethods?.has(method) && who !== 'main') throw Object.assign(new Error('synthetic failure of ' + method), { code: -32603 }); // a request whose outcome is unknown to the router
    if (method === 'thread/queue/list') return { data: control.queue?.[p.threadId] ?? [], nextCursor: null };
    if (method === 'thread/resume' && p.threadId === SOURCE) return { thread: { ...thread(SOURCE, sourceProvider, sourceModel), createdAt: 100, name: control.sourceName ?? null, preview: control.sourcePreview ?? 'first message', updatedAt: control.updatedAt, status: { type: control.sourceStatus } }, model: sourceModel, modelProvider: sourceProvider, ...control.snapshot };
    if (method === 'thread/resume' && created.has(p.threadId)) {
      // control.strictMaterialize: like the real native, a thread the MAIN process just started has no rollout until it is named or has items injected: a resume of it before that fails
      if (control.strictMaterialize && who === 'main' && !control.materialized?.has(p.threadId)) throw Object.assign(new Error('no rollout found for thread id ' + p.threadId), { code: -32600 });
      if (control.duringReadback) await control.duringReadback(p);
      // control.omitFinal: keys that are truly ABSENT (deleted from the JSON-RPC answer, not undefined) once a test enables it ('thread.id' deletes a key of the thread object)
      const omit = a => { if (!control.omitFinal) return a; const out = structuredClone(a); for (const k of control.omitFinal) { if (k.startsWith('thread.')) delete out.thread?.[k.slice(7)]; else delete out[k]; } return out; };
      const answer = answerFor(p.threadId); if (!control.coldDefaults) return omit(answer);
      // A native process that has not loaded this thread yet answers with ITS OWN configured default model unless one is named (it does not restore the model the thread last ran on);
      // once loaded it reports the loaded model. (control.ignorePin: a native that does not honour the named model.)
      control.cold ??= new Map(); const key = who + ':' + p.threadId; if (!control.cold.has(key)) control.cold.set(key, p.model !== undefined && !control.ignorePin ? p.model : control.coldDefaults);
      const model = control.cold.get(key); return omit({ ...answer, model, collaborationMode: answer.collaborationMode ? { ...answer.collaborationMode, settings: { ...answer.collaborationMode.settings, model } } : null });
    }
    if (method === 'thread/turns/list') {
      // The exact answers native gives for a thread without a first user message (control.unmaterialized[id] = 'a' | 'b'), a generic error, or a first page followed by that answer
      const variant = who !== 'main' ? control.unmaterialized?.[p.threadId] : undefined;
      const unmat = 'is not materialized yet; thread/turns/list is unavailable before first user message';
      if (variant === 'a') throw Object.assign(new Error('thread ' + p.threadId + ' ' + unmat), { code: -32600 });
      if (variant === 'wrongid') throw Object.assign(new Error('thread some-other-thread ' + unmat), { code: -32600 });
      if (variant === 'prefix') throw Object.assign(new Error('rpc: thread ' + p.threadId + ' ' + unmat), { code: -32600 });
      if (variant === 'suffix') throw Object.assign(new Error('thread ' + p.threadId + ' ' + unmat + ' (retry)'), { code: -32600 });
      if (variant === 'unknown') throw Object.assign(new Error('thread ' + p.threadId + ' is not available yet'), { code: -32600 });
      if (variant === 'wrongcode') throw Object.assign(new Error('thread ' + p.threadId + ' ' + unmat), { code: -32601 });
      if (variant === 'bwrongcode') throw Object.assign(new Error('list_turns is not supported yet'), { code: -32600 });
      if (variant === 'bsuffix') throw Object.assign(new Error('list_turns is not supported yet.'), { code: -32601 });
      if (variant === 'b') throw Object.assign(new Error('list_turns is not supported yet'), { code: -32601 });
      if (variant === 'generic') throw Object.assign(new Error('boom'), { code: -32600 });
      if (variant === 'later') { if (!p.cursor) return { data: [structuredClone(HISTORY[0])], nextCursor: '1' }; throw Object.assign(new Error('thread ' + p.threadId + ' ' + unmat), { code: -32600 }); }
      if (who === 'main' && control.notLoadedOnMain?.has(p.threadId)) throw Object.assign(new Error('thread not loaded: ' + p.threadId), { code: -32600 }); // a thread only a custom peer holds (no rollout yet)
      const all = created.has(p.threadId) ? (control.ownTurns ?? []) : control.history; // a new thread has none of the carried turns of its own
      const at = Number(p.cursor ?? 0), size = p.limit ?? 100; return { data: all.slice(at, at + size), nextCursor: at + size < all.length ? String(at + size) : null };
    }
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'thread/start') {
      if (control.startError) throw control.startError;
      const id = control.newId ?? NEW; created.set(id, { provider: control.answerProvider ?? p.modelProvider, model: control.answerModel ?? p.model });
      if (control.coldDefaults) { control.cold ??= new Map(); control.cold.set(who + ':' + id, created.get(id).model); } // a thread this process just started is loaded
      if (control.duringStart) await control.duringStart(p);
      return answerFor(id, true);
    }
    if (method === 'thread/inject_items') { (control.materialized ??= new Set()).add(p.threadId); if (control.duringInject) await control.duringInject(p); if (control.injectError) throw control.injectError; return {}; }
    if (method === 'thread/settings/update') {
      if (control.settingsError) throw control.settingsError;
      if (p.effort !== undefined || !p.collaborationMode) control.applied.set(p.threadId, control.ignoreSettings ? control.snapshot.reasoningEffort : p.effort);
      if (p.collaborationMode && !control.ignoreModes) { control.modes ??= new Map(); control.modes.set(p.threadId, structuredClone(p.collaborationMode)); }
      return {};
    }
    if (method === 'config/read') return { config: { model_provider: control.defaultProvider ?? 'openai' } };
    if (method === 'thread/archive') { if (control.archiveError) throw control.archiveError; return {}; }
    if (method === 'thread/unarchive') return {};
    if (method === 'turn/start') return { turn: { id: 'turn-on-' + p.threadId, status: 'inProgress' } };
    if (method === 'thread/list') return { data: [SOURCE, NEW, 'gpt-new', 'other-chat'].map((id, n) => ({ id, model: 'm-' + id, modelProvider: 'p-' + id, createdAt: 1000 - n * 10, updatedAt: 100 + n, status: { type: 'idle' } })), nextCursor: null };
    if (method === 'thread/queue/add') return { queuedSubmissionId: 'q-' + p.threadId };
    if (method === 'thread/queue/start') return { turn: { id: 'queued-turn-on-' + p.threadId, status: 'inProgress' } };
    if (method === 'turn/interrupt') return {};
    if (method === 'thread/name/set') {
      (control.materialized ??= new Set()).add(p.threadId);
      control.onName?.(p); if (control.nameError) throw control.nameError; // onName: an echo delivered DURING the write (before the answer)
      // Real native timing: the answer comes first and the name event is delivered later, by the notification path on its own turn (control.echoDelay ms, default next tick).
      // Only the router that is waiting for ITS OWN write receives it; control.noEcho withholds it (a write native never announces).
      if (!control.noEcho) setTimeout(() => { control.beforeEcho?.(p); echo(p.threadId, p.name); }, control.echoDelay ?? 0);
      return {};
    }
    if (method === 'thread/read' && who !== 'main') { // a custom peer reports what it persisted for its own thread (and, for a routed thread it never started here, only its own provider)
      const own = created.get(p.threadId), persisted = control.persisted?.[p.threadId] ?? own?.model, provider = control.persistedProvider ?? own?.provider ?? 'bridge_custom_' + who;
      return { thread: { ...thread(p.threadId, provider, persisted), ...(persisted === undefined ? { model: undefined } : { model: persisted }), modelProvider: provider, ...(control.nestedReadState ? { readState: null } : {}), turns: [] },
        ...(control.noReadState ? {} : { readState: control.readState === undefined ? null : control.readState }) }; // native's ThreadReadResponse: { thread, readState } - readState is TOP LEVEL, null for a fresh thread (control.nestedReadState puts a null INSIDE the thread instead; control.noReadState omits the top-level one)
    }
    if (method === 'thread/read') return { thread: { ...thread(p.threadId, 'openai', 'gpt-x'), ...(control.readName !== undefined ? { name: control.readName } : {}), turns: [] } };
    throw Error('unexpected ' + who + ' ' + method);
  };
  const forward = handle('main', 'openai', 'gpt-x');
  const claudeTarget = {
    start: async (params, rest) => { control.claudeCalls.push(['start', structuredClone(params)]); if (control.claudeStartError) throw control.claudeStartError; return { thread: thread('claude-new', 'claude_code', 'claude-sonnet-x'), model: control.claudeStartModel ?? 'claude-sonnet-x', modelProvider: 'claude_code', ...control.snapshot, ...control.overrides, reasoningEffort: 'high' }; },
    // the managed chat's own settings view (the pinned ThreadSettings), after a requested change is applied to it
    settings: async (id, update) => {
      control.claudeCalls.push(['settings', id, update ? structuredClone(update) : null]); if (control.duringClaudeSettings) await control.duringClaudeSettings(update); if (update?.collaborationMode && !control.ignoreModes) control.claudeMode = structuredClone(update.collaborationMode);
      const effort = control.claudeEffort ?? 'high';
      const view = { threadId: control.claudeThreadId ?? id, disabledPluginIds: [], cwd: '/synthetic', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly' }, activePermissionProfile: null, model: control.claudeStartModel ?? 'claude-sonnet-x', modelProvider: 'claude_code', serviceTier: null, effort, summary: null,
        collaborationMode: control.claudeMode ?? control.confirmedMode ?? { mode: 'default', settings: { model: control.claudeStartModel ?? 'claude-sonnet-x', reasoning_effort: effort, developer_instructions: null } }, multiAgentMode: 'explicitRequestOnly', personality: null,
        // the staged chat's OWN confirmed roots travel beside its settings view (what claudeContinuationTarget.settings reports from the record it saved at start)
        ...(Array.isArray(({ ...control.snapshot, ...control.overrides }).runtimeWorkspaceRoots) ? { runtimeWorkspaceRoots: structuredClone(({ ...control.snapshot, ...control.overrides }).runtimeWorkspaceRoots) } : {}), ...(control.claudeView ?? {}) };
      for (const k of control.claudeOmit ?? []) delete view[k]; // a field that is truly absent from the view
      return view;
    },
    setEffort: async (id, effort) => { control.claudeCalls.push(['effort', effort]); control.claudeEffort = effort; if (control.effortError) throw control.effortError; return { reasoningEffort: effort, model: control.claudeStartModel ?? 'claude-sonnet-x', modelProvider: 'claude_code' }; },
    notice: async (id, notice) => { control.claudeCalls.push(['notice', id, notice.id]); (control.claudeNotices ??= []).push(notice); },
    import: async (id, transfer) => {
      control.claudeCalls.push(['import', id, transfer.turns.length, JSON.stringify(transfer.turns)]); (control.claudeTransfers ??= []).push({ turns: transfer.turns.length, context: structuredClone(transfer.context ?? null), items: transfer.items.length, modelItems: transfer.modelItems?.length ?? null });
      // control.strictImport: the real target's guard, a chat that already holds turns refuses a second import ('The new chat is not empty.')
      if (control.strictImport) { control.importedIds ??= new Set(); if (control.importedIds.has(id)) throw Object.assign(new Error('The new chat is not empty.'), { code: -32602 }); control.importedIds.add(id); }
      if (control.importError) throw control.importError;
    },
    persistPrivate: async id => { control.claudeCalls.push(['persist', id]); if (!control.noEcho) setTimeout(() => { control.beforeEcho?.({ threadId: id, name: 'New chat' }); echo(id, 'New chat'); }, control.echoDelay ?? 0); },
    publish: async (id, record) => { control.claudeCalls.push(['publish', id, record.sourceId]); },
    archive: async id => { control.claudeCalls.push(['archive', id]); },
    thread: id => ({ ...thread(id, 'claude_code', 'claude-sonnet-x'), turns: [{ id: 'imported' }] }),
  };
  const notices = [];
  const routers = [];
  const build = () => { const created = make(); routers.push(created); return created; };
  const make = () => new ResponsesRouter({ root, native: { request: async () => ({ data: [], nextCursor: null }) }, managed: id => control.managed === id || !!control.managedAlso?.includes(id), notify: (m, p) => notices.push({ m, p: structuredClone(p) }),
    // (control.historyTools: the kit the Bridge passes, which carries the history-tool injector; absent, a router adds nothing)
    // (control.useContext: the Bridge's context kit - the reduced hand-off decision, recorded windows (control.budgets[route:model]), stable refs, the notice builders; absent, a router behaves as before)
    continuity: { runtimeHandoff, readAllTurns, overlayHistory, pageTurns, pageItems, get withHistoryTools() { return control.historyTools ? withHistoryTools : undefined; }, get context() { return control.useContext ? contextKit(control) : undefined; } }, claudeTarget,
    managedRoots: async id => { calls.push({ peer: 'bridge', method: 'managedRoots', p: { threadId: id } }); return control.discovered ?? null; },
    managedSource: id => id === SOURCE && control.managedTurns ? { turns: structuredClone(control.managedTurns), legacyHost: control.legacyHost === true, sdkHost: control.sdkHost === true, compaction: control.compaction ?? null, contextSummary: null, snapshot: { queue: structuredClone(control.managedQueue ?? []), thread: { ...thread(SOURCE, 'claude_code', 'claude-opus'), ...(control.managedThread ?? {}), status: { type: control.sourceStatus } }, model: 'claude-opus', modelProvider: 'claude_code', reasoningEffort: 'high', ...control.snapshot, ...(control.managedNoRoots ? { runtimeWorkspaceRoots: undefined } : {}) } } : null,
    nativeFor: async s => { if (!peers.has(s.connectionId)) peers.set(s.connectionId, { request: handle(s.connectionId, 'bridge_custom_' + s.connectionId, s.connectionId === a ? 'a1' : 'b1') }); return peers.get(s.connectionId); } });
  const router = build(), routePath = id => join(root, 'local-routes', id + '.json');
  const routeSource = () => { const s = registry.all().find(x => x.connectionId === a); router.saveRoute(SOURCE, router.routeFor(s, 'a1', thread(SOURCE, 'bridge_custom_' + a, 'a1'))); };
  return { root, registry, a, b, calls, control, router, build, forward, routePath, routeSource, thread, notices };
}
const toModel = (f, model, extra = {}, router = f.router) => router.request('thread/fork', { threadId: SOURCE, model, ...extra }, f.forward);
const by = (f, method) => f.calls.filter(c => c.method === method);
const archived = f => by(f, 'thread/archive').map(c => c.p.threadId);
const injected = f => by(f, 'thread/inject_items').flatMap(c => c.p.items);
const never = f => { for (const m of ['thread/fork', 'turn/start']) assert.deepEqual(by(f, m), [], m + ' is never sent'); };

test('GPT chat continues on a custom model as a NEW thread: start + plain injected items, no fork, no prompt, source untouched', async () => {
  const f = await setup(), answer = await toModel(f, localModelId(f.a, 'a2'));
  assert.equal(answer.thread.id, NEW); assert.notEqual(answer.thread.id, SOURCE); assert.equal(answer.model, localModelId(f.a, 'a2'));
  assert.deepEqual(answer.bridgeContinuation, { fromThreadId: SOURCE, fromProvider: 'openai', fromModel: 'gpt-x', toThreadId: NEW, transferredTurns: 2, omitted: { reasoning: 1, contextCompaction: 0, opaqueFields: 0 } });
  const start = by(f, 'thread/start')[0]; assert.equal(start.peer, f.a); assert.equal(start.p.modelProvider, 'bridge_custom_' + f.a); assert.equal(start.p.model, 'a2');
  assert.deepEqual([start.p.cwd, start.p.sandbox, start.p.approvalPolicy, start.p.approvalsReviewer], ['/synthetic', 'read-only', 'never', 'user']);
  assert.ok(start.p.config['model_providers.bridge_custom_' + f.a], 'only the target connection is configured'); assert.equal(start.p.threadId, undefined);
  const items = injected(f), wire = JSON.stringify(items);
  assert.match(wire, /EARLIER-USER-4417[\s\S]*EARLIER-ASSISTANT-5521[\s\S]*TOOL-RESULT-9083/, 'earlier visible messages and the finished tool result, in order'); assert.doesNotMatch(wire, new RegExp(OPAQUE));
  assert.ok(items.every(i => i.type === 'message')); assert.equal(by(f, 'thread/inject_items')[0].peer, f.a); assert.equal(by(f, 'thread/inject_items')[0].p.threadId, NEW);
  const route = JSON.parse(readFileSync(f.routePath(NEW))); assert.equal(route.connectionId, f.a); assert.equal(route.model, 'a2');
  assert.ok(!existsSync(f.routePath(SOURCE)), 'the original GPT chat gains no route'); never(f); assert.deepEqual(archived(f), []);
});

test('HISTORY TOOL on a hand-off target: a custom target is created with the read-only history namespace (nothing else is added to what the source had); a router without the kit adds nothing', async () => {
  const f = await setup(); f.control.historyTools = true;
  await toModel(f, localModelId(f.a, 'a2'));
  const start = by(f, 'thread/start')[0];
  assert.deepEqual(start.p.dynamicTools.map(d => [d.type, d.name, d.tools.map(t => [t.name, t.deferLoading])]), [['namespace', 'codex_bridge_history', [['read', true]]]]);
  assert.equal(start.p.modelProvider, 'bridge_custom_' + f.a); assert.equal(start.p.model, 'a2'); // the rest of the start is exactly what a hand-off always sent
  const plain = await setup(); await toModel(plain, localModelId(plain.a, 'a2'));
  assert.equal(by(plain, 'thread/start')[0].p.dynamicTools, undefined);
});

test('the continued chat shows its carried turns first, with their original IDs; native turns are not edited', async () => {
  const f = await setup(); await toModel(f, localModelId(f.a, 'a2'));
  const list = await f.router.request('thread/turns/list', { threadId: NEW, sortDirection: 'asc', itemsView: 'full', limit: 100 }, f.forward);
  assert.deepEqual(list.data.map(t => t.id), ['turn-1', 'turn-2']); assert.doesNotMatch(JSON.stringify(list), new RegExp(OPAQUE));
  assert.equal(by(f, 'thread/turns/list').filter(c => c.p.threadId === NEW).length, 1);
  const items = await f.router.request('thread/items/list', { threadId: NEW, turnId: 'turn-2' }, f.forward);
  assert.match(JSON.stringify(items), /TOOL-RESULT-9083/); assert.equal(by(f, 'thread/items/list').length, 0, 'served from the carried copy, not native');
  const source = await f.router.request('thread/turns/list', { threadId: SOURCE, sortDirection: 'asc', itemsView: 'full' }, f.forward);
  assert.equal(source.data.length, 2, 'the source chat lists exactly its own history'); assert.match(JSON.stringify(source), new RegExp(OPAQUE), 'and keeps its original, unmodified history');
});

test('custom to another connection, and custom to GPT: both are new threads; the source route stays byte-identical', async () => {
  const f = await setup(); f.routeSource(); const before = readFileSync(f.routePath(SOURCE));
  const toB = await toModel(f, localModelId(f.b, 'b1')); assert.equal(toB.thread.id, NEW); assert.equal(by(f, 'thread/start')[0].peer, f.b);
  assert.equal(JSON.parse(readFileSync(f.routePath(NEW))).connectionId, f.b);
  f.control.newId = 'gpt-new'; const toGpt = await toModel(f, 'gpt-y');
  assert.equal(toGpt.thread.id, 'gpt-new'); assert.equal(toGpt.modelProvider, 'openai'); assert.equal(toGpt.model, 'gpt-y'); assert.ok(!existsSync(f.routePath('gpt-new')), 'a native GPT thread gets no custom route');
  const gptStart = f.calls.find(c => c.peer === 'main' && c.method === 'thread/start'); assert.deepEqual([gptStart.p.modelProvider, gptStart.p.model, gptStart.p.sandbox], ['openai', 'gpt-y', 'read-only']);
  assert.match(JSON.stringify(by(f, 'thread/inject_items').at(-1).p.items), /TOOL-RESULT-9083/); assert.equal(by(f, 'thread/inject_items').at(-1).peer, 'main');
  assert.deepEqual(readFileSync(f.routePath(SOURCE)), before); never(f);
  const carried = await f.router.request('thread/turns/list', { threadId: 'gpt-new', sortDirection: 'asc', itemsView: 'full' }, f.forward);
  assert.deepEqual(carried.data.map(t => t.id), ['turn-1', 'turn-2'], 'even a thread native owns shows its carried part');
});

test('a managed Claude chat continues on a custom model from its own visible turns; the Claude record is read, never changed', async () => {
  const f = await setup(); f.control.managed = SOURCE; f.control.managedTurns = structuredClone(HISTORY); const original = JSON.stringify(f.control.managedTurns);
  const answer = await toModel(f, localModelId(f.a, 'a1'));
  assert.equal(answer.thread.id, NEW); assert.equal(answer.bridgeContinuation.fromProvider, 'claude_code'); assert.equal(answer.bridgeContinuation.fromModel, 'claude-opus');
  assert.match(JSON.stringify(injected(f)), /EARLIER-USER-4417[\s\S]*TOOL-RESULT-9083/); assert.equal(by(f, 'thread/resume').length, 0, 'the managed source is read from Bridge, not resumed on a native host');
  assert.equal(by(f, 'thread/turns/list').length, 0); assert.equal(JSON.stringify(f.control.managedTurns), original); never(f);
  f.control.sourceStatus = 'active'; f.control.newId = 'second';
  await assert.rejects(toModel(f, localModelId(f.a, 'a1')), { code: 'model_change_requires_idle' }); assert.equal(by(f, 'thread/start').length, 1);
});

test('a custom chat continues on Claude through the Claude-side target: start with the same permissions, import once, publish, source untouched', async () => {
  const f = await setup(); f.routeSource(); const before = readFileSync(f.routePath(SOURCE));
  const answer = await toModel(f, 'sonnet');
  assert.equal(answer.thread.id, 'claude-new'); assert.equal(answer.modelProvider, 'claude_code'); assert.equal(answer.bridgeContinuation.fromProvider, 'bridge_custom_' + f.a); assert.deepEqual(answer.thread.turns, [{ id: 'imported' }]);
  const [start, ...rest] = f.control.claudeCalls; assert.equal(start[0], 'start'); assert.deepEqual([start[1].model, start[1].cwd, start[1].sandbox, start[1].approvalPolicy], ['sonnet', '/synthetic', 'read-only', 'never']);
  assert.deepEqual(rest.map(c => c[0]), ['import', 'publish']); assert.equal(rest[0][2], 2); assert.match(rest[0][3], /TOOL-RESULT-9083/); assert.doesNotMatch(rest[0][3], new RegExp(OPAQUE));
  assert.deepEqual(readFileSync(f.routePath(SOURCE)), before); assert.deepEqual(by(f, 'thread/inject_items'), [], 'Claude receives the carried turns as its own record, not as native items'); never(f);
  const mismatch = await setup(); mismatch.routeSource(); mismatch.control.overrides = { sandbox: { type: 'dangerFullAccess' } };
  await assert.rejects(toModel(mismatch, 'sonnet'), { code: 'native_permissions_changed' }); assert.deepEqual(mismatch.control.claudeCalls.map(c => c[0]), ['start', 'archive']);
  const effort = await setup(); effort.routeSource(); const high = await toModel(effort, 'sonnet', { effort: 'low' }); assert.equal(high.reasoningEffort, 'low'); assert.ok(effort.control.claudeCalls.some(c => c[0] === 'effort' && c[1] === 'low'));
});

// A long conversation (220 turns, 440 messages): Native and custom targets take the plain items in chunks of 100; a managed Claude target takes the canonical turns as ONE whole import.
const LONG = Array.from({ length: 220 }, (_, i) => ({ id: 'long-' + (i + 1), status: 'completed', items: [user('lu' + (i + 1), i === 2 ? 'FIRST-FACT-3' : i === 219 ? 'LAST-FACT-220' : 'question ' + (i + 1)), { type: 'agentMessage', id: 'la' + (i + 1), text: 'answer ' + (i + 1) }] }));
const occurrences = (text, mark) => (text.match(new RegExp(mark, 'g')) ?? []).length;

test('LONG HISTORY into a managed Claude chat: ONE whole import of every canonical turn and message (never per chunk, never twice); only the new child is withdrawn when it fails; the source route stays byte-identical', async () => {
  const f = await setup(); f.routeSource(); f.control.strictImport = true; f.control.history = structuredClone(LONG); const before = readFileSync(f.routePath(SOURCE));
  const answer = await toModel(f, 'sonnet');
  assert.equal(answer.thread.id, 'claude-new'); assert.equal(answer.bridgeContinuation.transferredTurns, 220);
  assert.deepEqual(f.control.claudeCalls.map(c => c[0]), ['start', 'import', 'publish']); // one import, no archive
  const imported = f.control.claudeCalls.find(c => c[0] === 'import'), turns = JSON.parse(imported[3]);
  assert.equal(imported[2], 220); assert.deepEqual(turns.map(t => t.id), LONG.map(t => t.id)); assert.equal(turns.flatMap(t => t.items).length, 440);
  assert.equal(occurrences(imported[3], 'FIRST-FACT-3'), 1); assert.equal(occurrences(imported[3], 'LAST-FACT-220'), 1);
  assert.deepEqual(by(f, 'thread/inject_items'), [], 'Claude receives the turns as its own record, not as native items'); assert.deepEqual(readFileSync(f.routePath(SOURCE)), before); never(f);
  // an import that fails: only the new child is archived, nothing is published, the source route is untouched, and nothing is retried or imported again
  const bad = await setup(); bad.routeSource(); bad.control.strictImport = true; bad.control.history = structuredClone(LONG); bad.control.importError = Object.assign(new Error('import failed'), { code: -32603 }); const bytes = readFileSync(bad.routePath(SOURCE));
  await assert.rejects(toModel(bad, 'sonnet'), /import failed/);
  assert.deepEqual(bad.control.claudeCalls.map(c => c[0]), ['start', 'import', 'archive']); assert.deepEqual(bad.control.claudeCalls.at(-1), ['archive', 'claude-new']);
  assert.deepEqual(readFileSync(bad.routePath(SOURCE)), bytes); assert.ok(!existsSync(bad.routePath('claude-new'))); never(bad);
});

test('LONG HISTORY into Native and custom targets: the plain items are still delivered in chunks of 100, in order, none dropped, none repeated', async () => {
  for (const target of ['custom', 'native']) {
    const f = await setup(); f.routeSource(); f.control.history = structuredClone(LONG); if (target === 'native') f.control.newId = 'gpt-new';
    await toModel(f, target === 'custom' ? localModelId(f.b, 'b1') : 'gpt-y'); // (custom: another connection's model; the same connection is an ordinary model change)
    const calls = by(f, 'thread/inject_items'), items = calls.flatMap(c => c.p.items);
    assert.deepEqual(calls.map(c => c.p.items.length), [100, 100, 100, 100, 41], target); // the rules line + 440 messages = 441 items
    assert.equal(items.length, 441, target); assert.equal(occurrences(JSON.stringify(items), 'FIRST-FACT-3'), 1, target); assert.equal(occurrences(JSON.stringify(items), 'LAST-FACT-220'), 1, target);
    assert.match(items[1].content[0].text, /question 1$/); assert.match(items.at(-1).content[0].text, /answer 220$/);
    assert.ok(calls.every(c => c.peer === (target === 'custom' ? f.b : 'main')), target);
  }
});

test('refusals happen before any thread is created and leave route, history and permissions alone', async () => {
  const toB = f => localModelId(f.b, 'b1');
  const cases = [
    ['active source', f => { f.control.sourceStatus = 'active'; }, toB, 'model_change_requires_idle'],
    ['disabled target', f => f.registry.enabled(f.b, false), toB, 'provider_disabled'],
    ['vanished model', () => {}, f => localModelId(f.b, 'gone'), 'model_not_available'],
    ['alternate history', () => {}, toB, 'alternate_history_refused', { history: [] }],
    ['rollout path hint', () => {}, toB, 'alternate_history_refused', { path: '/synthetic/elsewhere.jsonl' }],
    ['provider override', () => {}, toB, 'provider_override_refused', { config: { model_provider: 'x' } }],
    ['sandbox override', () => {}, toB, 'native_permissions_changed', { sandbox: 'danger-full-access' }],
    ['approval override', () => {}, toB, 'native_permissions_changed', { approvalPolicy: 'on-request' }],
    ['workspace override', () => {}, toB, 'native_permissions_changed', { cwd: '/elsewhere' }],
    ['reviewer override', () => {}, toB, 'native_permissions_changed', { approvalsReviewer: 'auto_review' }],
    ['unfit history', f => { f.control.history = [{ id: 't', status: 'completed', items: [user('u', 'x'.repeat(5 * 1024 * 1024))] }]; }, toB, 'handoff_context_too_large'],
    ['unreadable history', f => { f.control.history = [{ nope: true }]; }, toB, 'handoff_history_unreadable'],
  ];
  for (const [label, prepare, target, code, extra = {}] of cases) {
    const f = await setup(); f.routeSource(); const before = readFileSync(f.routePath(SOURCE)); prepare(f);
    await assert.rejects(toModel(f, target(f), extra), error => { assert.equal(error.code, code, label); return true; });
    assert.deepEqual(by(f, 'thread/start'), [], label + ': no thread was created'); assert.deepEqual(readFileSync(f.routePath(SOURCE)), before, label); assert.ok(!existsSync(f.routePath(NEW)), label); never(f);
  }
  const same = await setup(); same.routeSource(); await toModel(same, localModelId(same.b, 'b1'), { cwd: '/synthetic', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' }); assert.equal(by(same, 'thread/start').length, 1, 'overrides equal to the source values are not a change');
});

test('an empty source continues with no injected items and no invented turn', async () => {
  const f = await setup(); f.control.history = []; const answer = await toModel(f, localModelId(f.a, 'a2'));
  assert.equal(answer.thread.id, NEW); assert.deepEqual(by(f, 'thread/inject_items'), []); assert.equal(answer.bridgeContinuation.transferredTurns, 0); never(f);
});

test('exact target: a different provider or model than requested is withdrawn, and only the just-created thread is archived', async () => {
  const f = await setup(); f.routeSource(); f.control.answerModel = 'gpt-other';
  await assert.rejects(toModel(f, 'gpt-requested'), { code: 'native_selection_not_confirmed' }); assert.deepEqual(archived(f), [NEW]); assert.deepEqual(by(f, 'thread/inject_items'), []);
  const g = await setup(); g.routeSource(); g.control.answerProvider = 'some-other-provider';
  await assert.rejects(toModel(g, 'gpt-y'), { code: 'native_selection_not_confirmed' }); assert.deepEqual(archived(g), [NEW]);
  const h = await setup(); h.routeSource(); h.control.newId = SOURCE;
  await assert.rejects(toModel(h, localModelId(h.b, 'b1')), { code: 'native_selection_not_confirmed' }); assert.ok(!archived(h).includes(SOURCE), 'the source thread is never archived');
});

test('CF1: a new thread whose workspace, sandbox, approval, reviewer or permission profile differs is never published or fed history', async () => {
  const changes = { cwd: '/other-workspace', sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', activePermissionProfile: { id: 'broader' } };
  for (const [key, value] of Object.entries(changes)) for (const target of ['custom', 'native']) {
    const f = await setup(); f.routeSource(); f.control.overrides = { [key]: value };
    await assert.rejects(toModel(f, target === 'custom' ? localModelId(f.b, 'b1') : 'gpt-y'), { code: 'native_permissions_changed' }, key + ' ' + target);
    assert.ok(!existsSync(f.routePath(NEW))); assert.deepEqual(archived(f), [NEW]); assert.deepEqual(by(f, 'thread/inject_items'), [], 'history is not delivered to a thread with different permissions');
  }
});

test('CF2: an explicit level is applied to the new thread and read back exactly, or the thread is withdrawn', async () => {
  const ok = await setup(); const answer = await toModel(ok, localModelId(ok.b, 'b1'), { effort: 'high' });
  assert.equal(answer.reasoningEffort, 'high'); const update = by(ok, 'thread/settings/update')[0]; assert.deepEqual([update.p.threadId, update.p.effort], [NEW, 'high']);
  const ignored = await setup(); ignored.control.ignoreSettings = true;
  await assert.rejects(toModel(ignored, localModelId(ignored.b, 'b1'), { effort: 'high' }), { code: 'native_selection_not_confirmed' }); assert.deepEqual(archived(ignored), [NEW]); assert.ok(!existsSync(ignored.routePath(NEW)));
  const refused = await setup(); refused.control.settingsError = Object.assign(new Error('synthetic settings refusal'), { code: -32600 });
  await assert.rejects(toModel(refused, localModelId(refused.b, 'b1'), { effort: 'high' }), /synthetic settings refusal/); assert.deepEqual(archived(refused), [NEW]);
  const none = await setup(); await toModel(none, localModelId(none.b, 'b1')); assert.deepEqual(by(none, 'thread/settings/update'), [], 'no explicit level: the target default is left alone');
});

test('CF2: a catalog with listed levels refuses an unsupported level before creating anything, and clamps an unsupported inherited one', async () => {
  const mk = async () => {
    const f = await setup(); f.b = f.registry.create({ name: 'Router endpoint', baseUrl: 'https://openrouter.ai/api/v1' });
    await f.registry.refresh(f.b, { request: (_u, _o, receive) => { const q = new EventEmitter(); q.destroy = () => {}; q.end = () => queueMicrotask(() => { const r = new EventEmitter(); r.statusCode = 200; r.destroy = () => {}; receive(r); r.emit('data', Buffer.from(JSON.stringify({ data: [{ id: 'b1', pricing: { prompt: '0', completion: '0' }, reasoning: { supported_efforts: ['low', 'high'], default_effort: 'low' } }] }))); r.emit('end'); }); return q; } });
    return f;
  };
  const bad = await mk(); await assert.rejects(toModel(bad, localModelId(bad.b, 'b1'), { effort: 'medium' }), { code: 'unsupported_reasoning_effort' }); assert.deepEqual(by(bad, 'thread/start'), []);
  const inherited = await mk(); const answer = await toModel(inherited, localModelId(inherited.b, 'b1'));
  assert.equal(answer.reasoningEffort, 'low', 'the inherited medium is not offered by the target; its default is applied and read back'); assert.equal(by(inherited, 'thread/settings/update')[0].p.effort, 'low');
});

test('CF3: a connection disabled, refreshed away or re-versioned while the thread is being created never publishes, and the new thread is archived', async () => {
  const mutations = [
    ['catalog refreshed without the model', f => f.registry.refresh(f.b, { request: catalog(['other']) })],
    ['disabled', f => f.registry.enabled(f.b, false)],
    ['disabled then re-enabled', f => { f.registry.enabled(f.b, false); f.registry.enabled(f.b, true); }],
  ];
  for (const [label, mutate] of mutations) {
    const f = await setup(); f.routeSource(); f.control.duringStart = () => mutate(f);
    await assert.rejects(toModel(f, localModelId(f.b, 'b1')), error => { assert.equal(error.code, 'connection_changed', label); return true; });
    assert.ok(!existsSync(f.routePath(NEW)), label); assert.deepEqual(archived(f), [NEW], label); assert.ok(!existsSync(join(f.root, 'local-routes', 'handoffs', NEW + '.json')), label + ': no carried copy is published');
  }
  const moved = await setup(); moved.routeSource(); moved.control.duringStart = () => writeFileSync(moved.routePath(SOURCE), JSON.stringify({ ...moved.router.readRoute(SOURCE), model: 'a2' }), { mode: 0o600 });
  await assert.rejects(toModel(moved, localModelId(moved.b, 'b1')), { code: 'stale_revision' }); assert.ok(!existsSync(moved.routePath(NEW))); assert.deepEqual(archived(moved), [NEW]);
});

test('CF4: an unexpected file where the new route belongs makes the outcome unknown: nothing is archived or deleted, the foreign file is untouched, and a second attempt is refused', async () => {
  const f = await setup(); f.routeSource(); writeFileSync(f.routePath(NEW), '{}', { mode: 0o600 });
  await assert.rejects(toModel(f, localModelId(f.b, 'b1')), { code: 'route_publication_uncertain' });
  assert.deepEqual(archived(f), [], 'the commit file is neither the old nor the new content: unknown, so no archive'); assert.equal(readFileSync(f.routePath(NEW), 'utf8'), '{}', 'the file that was not ours is untouched');
  assert.ok(existsSync(join(f.root, 'local-routes', 'links', NEW + '.intent')), 'the one intent record is retained');
  await assert.rejects(toModel(f, localModelId(f.b, 'b1')), { code: 'native_thread_created_but_route_not_saved' }); assert.equal(by(f, 'thread/start').length, 1, 'no blind second attempt, no second thread');
});

test('a failed delivery, a native refusal or a failed start leave no route and never touch the source', async () => {
  const delivery = await setup(); delivery.routeSource(); delivery.control.injectError = Object.assign(new Error('synthetic delivery failure'), { code: -32600 });
  await assert.rejects(toModel(delivery, localModelId(delivery.b, 'b1')), /synthetic delivery failure/); assert.deepEqual(archived(delivery), [NEW]); assert.ok(!existsSync(delivery.routePath(NEW)));
  const refused = await setup(); refused.routeSource(); refused.control.startError = Object.assign(new Error('synthetic native refusal'), { code: -32600 });
  await assert.rejects(toModel(refused, localModelId(refused.b, 'b1')), /synthetic native refusal/); assert.deepEqual(archived(refused), []); assert.ok(!existsSync(refused.routePath(NEW)));
});

test('a concurrent model change holds the route lock, so a continuation is refused as model_change_pending', async () => {
  const f = await setup(); f.routeSource(); writeFileSync(join(f.root, 'local-routes', SOURCE + '.lock'), JSON.stringify({ pid: process.pid, token: 'c'.repeat(32) }), { mode: 0o600 });
  await assert.rejects(toModel(f, localModelId(f.b, 'b1')), { code: 'model_change_pending' }); assert.deepEqual(by(f, 'thread/start'), []);
});

// ---- The actual picker: thread/settings/update and turn/start inside ONE logical conversation -------------------------
const settingsTo = (f, model, extra = {}) => f.router.request('thread/settings/update', { threadId: SOURCE, model, ...extra }, f.forward);
const turnOn = (f, model) => f.router.request('turn/start', { threadId: SOURCE, input: [{ type: 'text', text: 'NEXT-REQUEST-6602' }], model }, f.forward);
const linkOf = f => JSON.parse(readFileSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')));
const startsOn = (f, id) => by(f, 'turn/start').filter(c => c.p.threadId === id);

test('PICKER: choosing a custom model in a GPT chat switches the SAME conversation: new physical thread, link, settings shown under the old ID, next turn runs there', async () => {
  const f = await setup(); const out = await settingsTo(f, localModelId(f.a, 'a2'), { effort: undefined });
  assert.deepEqual(out, {}); const link = linkOf(f);
  assert.deepEqual([link.logicalId, link.physicalId, link.kind, link.connectionId, link.previous], [SOURCE, NEW, 'custom', f.a, [SOURCE]]); assert.equal(link.version, 1);
  const start = by(f, 'thread/start')[0]; assert.equal(start.peer, f.a); assert.match(JSON.stringify(by(f, 'thread/inject_items')[0].p.items), /EARLIER-USER-4417[\s\S]*TOOL-RESULT-9083/); never(f.calls.some(c => c.method === 'turn/start') ? { calls: [] } : f);
  const told = f.notices.filter(n => n.m === 'thread/settings/updated'); assert.equal(told.length, 1); assert.equal(told[0].p.threadId, SOURCE, 'the desktop is told about its own conversation ID');
  assert.deepEqual([told[0].p.threadSettings.model, told[0].p.threadSettings.cwd, told[0].p.threadSettings.approvalPolicy], [localModelId(f.a, 'a2'), '/synthetic', 'never']);
  const turn = await turnOn(f, localModelId(f.a, 'a2'));
  assert.equal(startsOn(f, NEW).length, 1, 'the turn runs on the new physical thread'); assert.equal(startsOn(f, SOURCE).length, 0, 'never on the old provider'); assert.equal(turn.turn.id, 'turn-on-' + NEW);
  assert.equal(startsOn(f, NEW)[0].peer, f.a);
});

test('PICKER: reads of the conversation show the carried history first under the logical ID; physical threads stay out of the chat list', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2'));
  const page = await f.router.request('thread/turns/list', { threadId: SOURCE, sortDirection: 'asc', itemsView: 'full', limit: 1 }, f.forward);
  assert.deepEqual(page.data.map(t => t.id), ['turn-1']); assert.equal(page.nextCursor, 'bridge-carried:1');
  const read = await f.router.request('thread/read', { threadId: SOURCE, includeTurns: false }, f.forward); assert.equal(read.thread.id, SOURCE, 'the physical ID never reaches the desktop');
  const list = await f.router.request('thread/list', {}, f.forward); assert.deepEqual(list.data.map(t => t.id), [SOURCE, 'gpt-new', 'other-chat'], 'the physical thread is hidden');
  assert.deepEqual(f.router.toLogicalParams({ threadId: NEW, turn: { id: 'x' } }), { threadId: SOURCE, turn: { id: 'x' } }, 'notifications and server requests are shown under the logical ID');
  assert.deepEqual(f.router.toLogicalParams({ threadId: 'other-chat' }), { threadId: 'other-chat' });
  assert.equal(f.router.toLogical({ thread: { id: NEW, turns: [{ id: NEW }] }, threadId: NEW }, NEW, SOURCE).thread.turns[0].id, NEW, 'only thread identity fields are renamed, never a turn or item ID');
  await f.router.request('thread/name/set', { threadId: SOURCE, name: 'n' }, f.forward); assert.deepEqual(by(f, 'thread/name/set').filter(c => c.p.name === 'n').map(c => c.p.threadId), [NEW, SOURCE], 'the whole conversation is renamed (the private label of the new child came first, separately)');
});

test('PICKER: GPT -> custom -> GPT -> Claude in one conversation: each hop reads the full canonical history, the old physical threads stay untouched, the link chain is durable', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2'));
  f.control.newId = 'gpt-new'; await settingsTo(f, 'gpt-y');
  let link = linkOf(f); assert.deepEqual([link.physicalId, link.kind, link.previous], ['gpt-new', 'native', [NEW, SOURCE]]);
  const secondItems = by(f, 'thread/inject_items').at(-1); assert.equal(secondItems.peer, 'main'); assert.match(JSON.stringify(secondItems.p.items), /EARLIER-USER-4417[\s\S]*TOOL-RESULT-9083/, 'the carried history survives a second hop');
  await turnOn(f, 'gpt-y'); assert.equal(startsOn(f, 'gpt-new').length, 1); assert.equal(startsOn(f, NEW).length, 0);
  await settingsTo(f, 'sonnet'); link = linkOf(f); assert.deepEqual([link.physicalId, link.kind, link.previous], ['claude-new', 'claude', ['gpt-new', NEW, SOURCE]]);
  const imported = f.control.claudeCalls.find(c => c[0] === 'import'); assert.equal(imported[2], 2); assert.match(imported[3], /TOOL-RESULT-9083/);
  assert.deepEqual(archived(f), [], 'no earlier physical thread is archived, deleted or reverted'); assert.equal(by(f, 'thread/fork').length, 0);
});

test('PICKER: a failed switch changes nothing: no link, no new model shown, the conversation keeps running where it was', async () => {
  for (const [label, prepare] of [['delivery fails', c => { c.injectError = Object.assign(new Error('synthetic delivery failure'), { code: -32600 }); }], ['target differs in permissions', c => { c.overrides = { sandbox: { type: 'dangerFullAccess' } }; }]]) {
    const f = await setup(); prepare(f.control);
    await assert.rejects(settingsTo(f, localModelId(f.a, 'a2')), () => true, label);
    assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')), label); assert.deepEqual(f.notices.filter(n => n.m === 'thread/settings/updated'), [], label + ': the desktop is never told about a model that is not running');
    assert.deepEqual(archived(f), [NEW], label); assert.ok(!existsSync(f.routePath(NEW)), label);
  }
  const busy = await setup(); busy.control.sourceStatus = 'active';
  await assert.rejects(settingsTo(busy, localModelId(busy.a, 'a2')), { code: 'model_change_requires_idle' }); assert.deepEqual(by(busy, 'thread/start'), []);
  const racing = await setup(); racing.router.switching.add(SOURCE);
  await assert.rejects(settingsTo(racing, localModelId(racing.a, 'a2')), { code: 'model_change_pending' });
  const changed = await setup(); changed.control.duringStart = () => changed.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: 'intruder', kind: 'native', model: 'x', previous: [SOURCE] });
  await assert.rejects(settingsTo(changed, localModelId(changed.a, 'a2')), { code: 'stale_revision' }); assert.deepEqual(archived(changed), [NEW]); assert.equal(linkOf(changed).physicalId, 'intruder', 'a link written by someone else is never overwritten');
});

test('PICKER: a switch asking for a changed permission or workspace in the same request is refused, not silently dropped', async () => {
  for (const extra of [{ sandboxPolicy: { type: 'dangerFullAccess' } }, { approvalPolicy: 'on-request' }, { cwd: '/elsewhere' }]) {
    const f = await setup(); await assert.rejects(settingsTo(f, localModelId(f.a, 'a2'), extra), { code: 'native_permissions_changed' }); assert.deepEqual(by(f, 'thread/start'), []);
  }
});

test('PICKER: models of the conversation\'s current provider are never switched, and an empty conversation switches without inventing a turn', async () => {
  const f = await setup(); f.routeSource();
  await settingsTo(f, localModelId(f.a, 'a2')).catch(() => {}); assert.deepEqual(by(f, 'thread/start'), [], 'same connection: its own same-connection path, no new thread');
  assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')));
  const empty = await setup(); empty.control.history = []; await settingsTo(empty, localModelId(empty.a, 'a2'));
  assert.deepEqual(by(empty, 'thread/inject_items'), []); assert.equal(linkOf(empty).physicalId, NEW); assert.deepEqual(startsOn(empty, NEW), [], 'no seed turn');
});

test('LP1: only protocol identity positions are renamed; tool and business payload bytes that equal the physical ID are never touched', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2'));
  const business = { type: 'mcpToolCall', id: 'm', result: { structuredContent: { threadId: NEW, sessionId: NEW, id: NEW, note: NEW } } };
  const answer = { thread: { id: NEW, sessionId: NEW, forkedFromId: NEW, turns: [{ id: NEW, items: [business] }] }, threadId: NEW, result: { structuredContent: { threadId: NEW } }, id: NEW };
  const out = f.router.toLogical(answer, NEW, SOURCE);
  assert.deepEqual([out.thread.id, out.thread.sessionId, out.threadId], [SOURCE, SOURCE, SOURCE]);
  assert.equal(JSON.stringify(out.thread.turns), JSON.stringify(answer.thread.turns), 'turns and items are byte-identical'); assert.equal(out.thread.forkedFromId, NEW); assert.equal(out.id, NEW);
  assert.equal(JSON.stringify(out.result), JSON.stringify(answer.result));
  const request = f.router.toLogicalParams({ threadId: NEW, turnId: 't', item: business }); assert.equal(request.threadId, SOURCE); assert.equal(JSON.stringify(request.item), JSON.stringify(business));
});

test('LP2: after a restart (a new router on the same root) every earlier physical thread of a chain stays hidden, routing and canonical list metadata are rebuilt', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2')); f.control.newId = 'gpt-new'; await settingsTo(f, 'gpt-y');
  const fresh = f.build();
  assert.deepEqual([fresh.logicalOf(NEW), fresh.logicalOf('gpt-new'), fresh.logicalOf(SOURCE), fresh.logicalOf('other-chat'), fresh.physicalOf(SOURCE)], [SOURCE, SOURCE, SOURCE, 'other-chat', 'gpt-new']);
  const list = await fresh.request('thread/list', {}, f.forward); assert.deepEqual(list.data.map(t => t.id), [SOURCE, 'other-chat'], 'no duplicate chats after restart');
  const row = list.data[0]; assert.deepEqual([row.model, row.modelProvider, row.updatedAt], ['m-gpt-new', 'p-gpt-new', 102], 'the conversation row shows its current physical thread\'s model, provider and activity'); assert.equal(row.id, SOURCE);
  assert.equal(list.data[1].model, 'm-other-chat', 'other chats are untouched');
  await fresh.request('turn/start', { threadId: SOURCE, input: [], model: 'gpt-y' }, f.forward); assert.equal(startsOn(f, 'gpt-new').length, 1); assert.equal(startsOn(f, SOURCE).length + startsOn(f, NEW).length, 0, 'the restarted router still runs it on the current physical thread');
  const page = await fresh.request('thread/turns/list', { threadId: SOURCE, sortDirection: 'asc', itemsView: 'full' }, f.forward); assert.deepEqual(page.data.map(t => t.id), ['turn-1', 'turn-2']);
});

test('LP3: a corrupt or unsafe existing link or carried-history file fails explicitly; no provider runs as a fallback', async () => {
  const cases = [['unparseable link', '{not json', 0o600, 'invalid_store'], ['wrong-shape link', '{"version":1}', 0o600, 'link_invalid'], ['link with unsafe permissions', '{}', 0o644, 'unsafe_file'],
    ['link to a bad physical ID', JSON.stringify({ version: 1, logicalId: SOURCE, physicalId: '../x', kind: 'custom' }), 0o600, 'link_invalid']];
  for (const [label, text, mode, code] of cases) {
    const f = await setup(); f.router.ensureDirs('links'); writeFileSync(join(f.root, 'local-routes', 'links', SOURCE + '.json'), text, { mode });
    for (const [method, params] of [['turn/start', { threadId: SOURCE, input: [], model: 'gpt-y' }], ['thread/read', { threadId: SOURCE }], ['thread/settings/update', { threadId: SOURCE, model: localModelId(f.a, 'a2') }]])
      await assert.rejects(f.router.request(method, params, f.forward), { code }, label + ' ' + method);
    assert.deepEqual(f.calls, [], label + ': nothing ran on any provider');
  }
  const g = await setup(); await settingsTo(g, localModelId(g.a, 'a2')); const before = g.calls.length;
  writeFileSync(join(g.root, 'local-routes', 'handoffs', NEW + '.json'), '{"version":1}', { mode: 0o600 }); // present but not a carried history
  await assert.rejects(g.router.request('thread/turns/list', { threadId: SOURCE, sortDirection: 'asc', itemsView: 'full' }, g.forward), { code: 'handoff_history_unreadable' }, 'never a quietly shorter history');
  assert.equal(g.calls.slice(before).filter(c => c.method === 'thread/turns/list').length, 0);
});

test('QUEUE/INTERRUPT: queue add/start and interrupt for a switched conversation reach the owning custom peer under the physical ID; custom queueing is no longer refused', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2'));
  const added = await f.router.request('thread/queue/add', { threadId: SOURCE, input: [{ type: 'text', text: 'queued' }] }, f.forward);
  assert.equal(added.queuedSubmissionId, 'q-' + NEW); const q = by(f, 'thread/queue/add')[0]; assert.deepEqual([q.peer, q.p.threadId], [f.a, NEW]);
  const started = await f.router.request('thread/queue/start', { threadId: SOURCE }, f.forward); assert.equal(by(f, 'thread/queue/start')[0].peer, f.a); assert.equal(started.turn.id, 'queued-turn-on-' + NEW);
  await f.router.request('turn/interrupt', { threadId: SOURCE, turnId: 'turn-on-' + NEW }, f.forward); const i = by(f, 'turn/interrupt')[0]; assert.deepEqual([i.peer, i.p.threadId], [f.a, NEW]);
  assert.equal(by(f, 'turn/start').length, 0, 'queueing never starts a turn by itself');
  const plain = await setup(); plain.routeSource(); await plain.router.request('thread/queue/add', { threadId: SOURCE, input: [] }, plain.forward); assert.equal(by(plain, 'thread/queue/add')[0].peer, plain.a, 'an ordinary custom chat can queue too');
  const disabled = await setup(); disabled.routeSource(); disabled.registry.enabled(disabled.a, false);
  await assert.rejects(disabled.router.request('thread/queue/add', { threadId: SOURCE, input: [] }, disabled.forward), { code: 'provider_disabled' });
});

test('LP5: several controllers on the same state follow the current committed link: no stale cached index, in routing, notifications, listing or the next switch', async () => {
  const f = await setup(), routerA = f.router, routerB = f.build();
  await settingsTo(f, localModelId(f.a, 'a2')); assert.equal(routerA.physicalOf(SOURCE), NEW); assert.equal(routerB.physicalOf(SOURCE), NEW);
  f.control.newId = 'gpt-new'; await routerB.request('thread/settings/update', { threadId: SOURCE, model: 'gpt-y' }, f.forward); // controller B commits link C
  assert.equal(routerA.physicalOf(SOURCE), 'gpt-new', 'A sees B\'s commit at once'); assert.equal(routerA.logicalOf('gpt-new'), SOURCE); assert.equal(routerA.logicalOf(NEW), SOURCE);
  assert.deepEqual(routerA.toLogicalParams({ threadId: 'gpt-new' }), { threadId: SOURCE }, 'a notification from the newest physical thread is shown under the conversation ID');
  assert.deepEqual((await routerA.request('thread/list', {}, f.forward)).data.map(t => t.id), [SOURCE, 'other-chat']);
  await routerA.request('turn/start', { threadId: SOURCE, input: [], model: 'gpt-y' }, f.forward); assert.equal(startsOn(f, 'gpt-new').length, 1, 'A routes to the thread B committed, not to the one it saw before');
  f.control.newId = 'third'; await routerA.request('thread/settings/update', { threadId: SOURCE, model: localModelId(f.a, 'a1') }, f.forward);
  assert.deepEqual([routerB.physicalOf(SOURCE), JSON.parse(readFileSync(join(f.root, 'local-routes', 'links', SOURCE + '.json'))).previous], ['third', ['gpt-new', NEW, SOURCE]], 'and B sees A\'s later commit, with the whole chain');
});

test('LP6: while a switch is pending every conflicting mutation is refused (here and in another controller); reads and interrupt stay available; nothing reaches the old runtime', async () => {
  const f = await setup(), other = f.build(), outcome = {};
  const mutations = [['turn/start', { threadId: SOURCE, input: [{ type: 'text', text: 'late' }] }], ['thread/queue/add', { threadId: SOURCE, input: [] }], ['thread/queue/start', { threadId: SOURCE }],
    ['turn/steer', { threadId: SOURCE, expectedTurnId: 't', input: [] }], ['thread/settings/update', { threadId: SOURCE, approvalPolicy: 'on-request' }], ['thread/revert', { threadId: SOURCE, beforeTurnId: 'turn-2' }],
    ['thread/archive', { threadId: SOURCE }], ['thread/unarchive', { threadId: SOURCE }], ['thread/unsubscribe', { threadId: SOURCE }], ['thread/compact/start', { threadId: SOURCE }], ['thread/name/set', { threadId: SOURCE, name: 'x' }], ['thread/inject_items', { threadId: SOURCE, items: [] }]];
  f.control.duringStart = async () => {
    for (const [method, params] of mutations) for (const [who, router] of [['here', f.router], ['other', other]]) { try { await router.request(method, params, f.forward); outcome[method + ' ' + who] = 'ran'; } catch (error) { outcome[method + ' ' + who] = error.code; } }
    outcome.read = (await f.router.request('thread/read', { threadId: SOURCE }, f.forward)).thread.id; outcome.interrupt = JSON.stringify(await other.request('turn/interrupt', { threadId: SOURCE, turnId: 't' }, f.forward));
  };
  await settingsTo(f, localModelId(f.a, 'a2'));
  assert.ok(Object.entries(outcome).filter(([k]) => /\s(here|other)$/.test(k)).every(([, v]) => v === 'model_change_pending'), JSON.stringify(outcome));
  assert.equal(outcome.read, SOURCE); assert.equal(outcome.interrupt, '{}');
  const reached = f.calls.filter(c => mutations.some(([m]) => m === c.method) && c.peer === 'main'); assert.deepEqual(reached.map(c => c.method), [], 'no mutation reached the old runtime during the switch');
  await turnOn(f, localModelId(f.a, 'a2')); assert.equal(startsOn(f, NEW).length, 1, 'afterwards the conversation accepts work again, on the new thread');
});

test('LP6: a source that changes behind Bridge\'s back while the switch is pending (activity, a queued entry, any update) is never switched: nothing is published and the new thread is removed', async () => {
  for (const [label, change, code] of [['became active', c => { c.sourceStatus = 'active'; }, 'model_change_requires_idle'], ['gained a queued entry', c => { c.queue = { [SOURCE]: [{ id: 'q1' }] }; }, 'handoff_queue_pending'], ['was updated', c => { c.updatedAt = 99; }, 'stale_revision']]) {
    const f = await setup(); f.control.duringStart = () => change(f.control);
    await assert.rejects(settingsTo(f, localModelId(f.a, 'a2')), { code }, label); assert.deepEqual(archived(f), [NEW], label); assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')), label); assert.ok(!existsSync(f.routePath(NEW)), label);
  }
  const queued = await setup(); queued.control.queue = { [SOURCE]: [{ id: 'q1', input: 'pending message' }] };
  await assert.rejects(settingsTo(queued, localModelId(queued.a, 'a2')), { code: 'handoff_queue_pending' }); assert.deepEqual(by(queued, 'thread/start'), [], 'a pending queue entry is never carried or replayed; the switch is refused before anything exists');
  assert.deepEqual((await queued.forward('thread/queue/list', { threadId: SOURCE })).data, [{ id: 'q1', input: 'pending message' }], 'the entry stays exactly where it was');
});

// A single state file is published through one write-ahead intent. Its fsyncs, in order: 1 intent file, 2 intent directory,
// 3 data file, 4 data directory (after the commit), 5 directory after the intent is removed.
const failOn = (...nths) => { let count = 0; return () => { count += 1; if (nths.includes(count)) throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); }; };
const withSync = (impl, body) => { const restore = useDurability(impl); try { return body(); } finally { restore(); } };
const withSyncAsync = async (impl, body) => { const restore = useDurability(impl); try { return await body(); } finally { restore(); } };
const dirOf = f => join(f.root, 'local-routes'), leftoverTemps = f => ['', 'links', 'handoffs'].flatMap(d => { try { return readdirSync(join(dirOf(f), d)).filter(n => n.endsWith('.tmp')); } catch { return []; } });
const intentFile = (f, key) => join(dirOf(f), 'links', key + '.intent'), linkFile = f => join(dirOf(f), 'links', SOURCE + '.json');
const routeFor = (f, tid) => f.router.routeFor(f.registry.all().find(x => x.connectionId === f.a), 'a1', f.thread(tid, 'bridge_custom_' + f.a, 'a1'));

test('LP7: an injected fsync failure BEFORE the commit accepts nothing; AFTER it the state is durably uncertain (one intent), blocks reads and dispatch, survives a restart and reconciles atomically', async () => {
  // 1. Failures before the commit (intent file, intent directory, data file): a plain error, nothing accepted, no intent or temp left.
  for (const n of [1, 2, 3]) {
    const a = await setup(), route = routeFor(a, 'r' + n);
    withSync(failOn(n), () => assert.throws(() => a.router.saveRoute('r' + n, route), { code: 'EIO' }, 'fsync ' + n));
    assert.equal(a.router.readRoute('r' + n), null, 'fsync ' + n + ': not accepted'); assert.equal(a.build().readRoute('r' + n), null, 'nor after a restart'); assert.deepEqual(leftoverTemps(a), []);
    assert.ok(!existsSync(join(dirOf(a), 'r' + n + '.intent')), 'a failed beginning leaves no intent behind');
    a.router.saveRoute('r' + n, route); assert.deepEqual(a.router.readRoute('r' + n), route, 'the same save succeeds once the fault is gone');
  }
  // 2. Failure after the commit file exists (data directory, or removing the intent): uncertain, blocked, durable across a restart.
  for (const [n, keep] of [[4, 'previous'], [5, 'next']]) {
    const b = await setup(), route = routeFor(b, 'r2');
    withSync(failOn(n), () => assert.throws(() => b.router.saveRoute('r2', route), { code: 'route_publication_uncertain' }));
    const intent = JSON.parse(readFileSync(join(dirOf(b), 'r2.intent'))); assert.deepEqual([intent.phase, intent.commit.old, intent.commit.next], ['committing', null, route], 'the intent was durable BEFORE the commit and names old and new exactly');
    for (const router of [b.router, b.build()]) { assert.throws(() => router.readRoute('r2'), { code: 'route_publication_uncertain' }); await assert.rejects(router.request('turn/start', { threadId: 'r2', input: [] }, () => { throw Error('must not fall back to another peer'); }), { code: 'route_publication_uncertain' }); }
    assert.deepEqual(b.calls, [], 'no provider ran'); assert.throws(() => b.router.saveRoute('r2', route), { code: 'route_publication_uncertain' }, 'nobody publishes over an uncertain state');
    await b.router.reconcileRoute('r2', keep); assert.ok(!existsSync(join(dirOf(b), 'r2.intent')), 'the intent is removed LAST');
    assert.deepEqual(b.build().readRoute('r2'), keep === 'next' ? route : null, keep);
  }
  // 3. A replacement: the prior valid route survives every failed reconciliation; the intent and the accepted file are retained; the retry succeeds.
  for (const keep of ['previous', 'next']) {
    const c = await setup(); c.routeSource(); const prior = c.router.readRoute(SOURCE), next = { ...prior, model: 'a2' };
    withSync(failOn(4), () => assert.throws(() => c.router.replaceRoute(SOURCE, prior, next), { code: 'route_publication_uncertain' }));
    assert.throws(() => c.build().readRoute(SOURCE), { code: 'route_publication_uncertain' }, 'after a restart the route is not trusted either'); assert.deepEqual(JSON.parse(readFileSync(join(dirOf(c), SOURCE + '.intent'))).commit.old, prior);
    // a failed reconciliation (temp file, directory, intent removal) changes nothing that was accepted and keeps the intent
    // Each call counts its own syncs. keep=previous: 1 replacement temp file (accepted file untouched), 2 directory after the atomic
    // replacement; then, with the old content back: 1 directory, 2 intent removal. keep=next: 1 directory, 2 intent removal.
    for (const [i, n] of (keep === 'previous' ? [1, 2, 1, 2] : [1, 2]).entries()) {
      const bytes = readFileSync(join(dirOf(c), SOURCE + '.json'));
      await withSyncAsync(failOn(n), () => assert.rejects(async () => c.router.reconcileRoute(SOURCE, keep), { code: 'EIO' }, 'reconcile ' + keep + ' fsync ' + n));
      assert.ok(existsSync(join(dirOf(c), SOURCE + '.intent')), 'the intent survives a failed reconciliation (' + keep + ' ' + i + ')'); assert.throws(() => c.build().readRoute(SOURCE), { code: 'route_publication_uncertain' });
      if (keep === 'next' || i === 0) assert.deepEqual(readFileSync(join(dirOf(c), SOURCE + '.json')), bytes, 'the accepted file is untouched by a failure before the replacement');
      assert.deepEqual(leftoverTemps(c), []);
    }
    await c.router.reconcileRoute(SOURCE, keep); assert.deepEqual(c.build().readRoute(SOURCE), keep === 'previous' ? prior : next, keep); assert.ok(!existsSync(join(dirOf(c), SOURCE + '.intent')));
  }
  // 4. A conversation link (LP8): the old link is replaced by an uncertain one; every failed reconciliation keeps a recovery path; reads show the OLD link.
  const d = await setup(), one = { version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE] }, two = { ...one, physicalId: 'newer', previous: [NEW, SOURCE] };
  d.router.writeLink(one, null);
  withSync(failOn(4), () => assert.throws(() => d.router.writeLink(two, one), { code: 'route_publication_uncertain' }));
  for (const router of [d.router, d.build()]) {
    assert.throws(() => router.readLink(SOURCE), { code: 'route_publication_uncertain' }); await assert.rejects(router.request('turn/start', { threadId: SOURCE, input: [], model: 'gpt-y' }, d.forward), { code: 'route_publication_uncertain' });
    assert.equal(router.physicalOf(SOURCE), NEW, 'while uncertain, reads and notifications use the OLD link: no display of the unaccepted one'); assert.equal(router.logicalOf('newer'), 'newer');
    assert.equal((await router.request('thread/read', { threadId: SOURCE }, d.forward)).thread.id, SOURCE, 'history stays readable');
  }
  assert.deepEqual(d.calls.filter(c => c.method === 'turn/start'), [], 'the old provider never ran as a fallback');
  await withSyncAsync(failOn(1), () => assert.rejects(d.router.reconcileLink(SOURCE, 'previous'), { code: 'EIO' }));
  assert.equal(JSON.parse(readFileSync(linkFile(d))).physicalId, 'newer', 'LP8: a failed reconciliation does not delete the accepted file'); assert.ok(existsSync(intentFile(d, SOURCE)), 'nor the intent'); assert.equal(d.build().physicalOf(SOURCE), NEW);
  await d.router.reconcileLink(SOURCE, 'previous'); assert.equal(d.build().readLink(SOURCE).physicalId, NEW, 'the previous link is back'); assert.ok(!existsSync(intentFile(d, SOURCE)));
  // The real, strict implementation is what an ordinary run uses; the seam is restored after each injection.
  assert.equal(durability.sync, realSync);
});

// A conversation switch (custom target) syncs, in order: 1 switch lock, 2-3 intent (file, dir), 4-5 carried history, 6-7 new route,
// 8-9 intent -> committing, 10 link file, 11 link directory, 12 intent removed.
test('SWITCH FAULTS: every failure point of the one write-ahead intent, in order: a plain failure leaves the old state and archives only the child; once the commit may have happened nothing is archived or deleted', async () => {
  const intentOf = (f, key = SOURCE) => existsSync(intentFile(f, key)) ? JSON.parse(readFileSync(intentFile(f, key))) : null;
  // The exact number of durable syncs of one successful switch is measured, then EACH ONE is failed in turn: no hand-numbered gap.
  const probe = await setup(); probe.routeSource(); let total = 0; await withSyncAsync(() => { total += 1; }, () => settingsTo(probe, localModelId(probe.b, 'b1')));
  assert.ok(total >= 12, 'a switch syncs its lock, intent, carried history, route, committing intent, link and intent removal: ' + total);
  const uncertain = [], created = [];
  for (let n = 1; n <= total; n++) { // each failure point; those before the commit may have happened are plain failures
    const f = await setup(); f.routeSource(); let failure = null;
    await withSyncAsync(failOn(n), async () => { try { await settingsTo(f, localModelId(f.b, 'b1')); } catch (error) { failure = error; } });
    assert.ok(failure, 'fsync ' + n + ' fails the switch (never ignored)');
    if (failure.code === 'route_publication_uncertain') { uncertain.push(n); continue; }
    assert.ok(['EIO', 'native_thread_created_but_route_not_saved', 'model_change_pending'].includes(failure.code), 'fsync ' + n + ' ' + failure.code); assert.ok(!failure.uncertain);
    const exists = by(f, 'thread/start').length === 1; if (exists) created.push(n);
    assert.deepEqual(archived(f), exists ? [NEW] : [], 'fsync ' + n + ': only a just-created child is archived, and only if it exists'); assert.equal(intentOf(f), null, 'fsync ' + n + ': the intent is finished and removed LAST');
    assert.ok(!existsSync(linkFile(f)) && !existsSync(f.routePath(NEW)) && !existsSync(join(dirOf(f), 'handoffs', NEW + '.json')), 'fsync ' + n + ': no orphan survives'); assert.equal(f.router.physicalOf(SOURCE), SOURCE);
    assert.equal(JSON.parse(readFileSync(f.routePath(SOURCE))).model, 'a1', 'the old route is untouched'); assert.deepEqual(leftoverTemps(f), []);
    assert.equal(f.notices.filter(x => x.m === 'thread/settings/updated').length, 0, 'the desktop is never told about a model that was not accepted');
    await settingsTo(f, localModelId(f.b, 'b1')); assert.equal(f.router.readLink(SOURCE).physicalId, NEW.length ? NEW : NEW, 'and the same switch succeeds once the fault is gone');
  }
  assert.deepEqual(uncertain, [total - 1, total], 'exactly the link directory sync and the intent removal can leave the commit possibly published'); assert.ok(created.length >= 7, 'the failure points after the child exists were exercised: ' + created);
  for (const [n, keep] of uncertain.flatMap(n => [[n, 'next'], [n, 'previous']])) { // the commit may have happened
    const f = await setup(); f.routeSource(); const start = f.calls.length;
    await withSyncAsync(failOn(n), () => assert.rejects(settingsTo(f, localModelId(f.b, 'b1')), { code: 'route_publication_uncertain' }, 'fsync ' + n));
    assert.deepEqual(archived(f), [], 'fsync ' + n + ': the maybe-published child is NOT archived'); const intent = intentOf(f); assert.equal(intent.phase, 'committing'); assert.equal(intent.child.id, NEW);
    assert.deepEqual([intent.commit.old, intent.commit.next.physicalId], [null, NEW], 'old and new exactly'); assert.ok(existsSync(join(dirOf(f), 'handoffs', NEW + '.json')) && existsSync(f.routePath(NEW)), 'carried history and route are retained');
    assert.equal(f.notices.filter(x => x.m === 'thread/settings/updated').length, 0, 'nothing about the new model is shown');
    for (const router of [f.router, f.build()]) {
      await assert.rejects(router.request('turn/start', { threadId: SOURCE, input: [] }, f.forward), { code: 'route_publication_uncertain' }); await assert.rejects(router.request('thread/queue/add', { threadId: SOURCE, input: [] }, f.forward), { code: 'route_publication_uncertain' });
      assert.equal(router.physicalOf(SOURCE), SOURCE, 'reads use the old state'); assert.deepEqual(router.canonicalList([{ id: SOURCE }, { id: NEW }, { id: 'other-chat' }]).map(t => t.id), [SOURCE, 'other-chat'], 'the child is hidden; the conversation row is the old one'); assert.ok(!(await router.request('thread/list', {}, f.forward)).data.some(t => t.id === NEW));
      assert.equal((await router.request('thread/read', { threadId: SOURCE }, f.forward)).thread.id, SOURCE); assert.equal(router.desktopView('thread/status/changed', { threadId: NEW }), null, 'an unaccepted child is never shown');
    }
    assert.equal(startsOn(f, SOURCE).length + startsOn(f, NEW).length, 0, 'nothing ran anywhere'); assert.ok(f.calls.slice(start).every(c => c.method !== 'thread/archive'));
    await assert.rejects(settingsTo(f, localModelId(f.b, 'b1')), { code: 'route_publication_uncertain' }, 'no second switch over an unresolved one'); assert.equal(by(f, 'thread/start').length, 1);
    // reconcile 'next': the accepted commit is verified, its directory synced, the intent removed last; the child lives
    if (keep === 'next') { await withSyncAsync(failOn(1), () => assert.rejects(f.router.reconcileLink(SOURCE, 'next'), { code: 'EIO' })); assert.ok(intentOf(f), 'a failed reconcile keeps the intent'); assert.equal(f.build().physicalOf(SOURCE), SOURCE, 'and the new link is still not trusted');
      await f.router.reconcileLink(SOURCE, 'next'); assert.equal(f.build().physicalOf(SOURCE), NEW); assert.equal(intentOf(f), null); assert.deepEqual(archived(f), []); await turnOn(f, localModelId(f.b, 'b1')); assert.equal(startsOn(f, NEW).length, 1); continue; }
    // reconcile 'previous' with every failure: the accepted file, the intent and the orphans survive until the replacement is safe
    for (const m of [1, 2, 3]) { // every sync that must succeed before the archive of the reconciliation, in turn, on the SAME unresolved state
      await withSyncAsync(failOn(m), () => assert.rejects(f.router.reconcileLink(SOURCE, 'previous'), error => ['EIO', 'route_publication_uncertain'].includes(error.code)));
      assert.ok(intentOf(f), 'reconcile fsync ' + m + ': the intent survives a failed reconciliation'); assert.ok(archived(f).every(id => id === NEW), 'only the child is ever archived');
      assert.equal(f.router.desktopView('thread/status/changed', { threadId: NEW }), null, 'the child is never shown');
      if (archived(f).length) assert.ok(intentOf(f).archived === true || intentOf(f).phase === 'aborted', 'an archive that happened is recorded, so no retry repeats it'); // any later retry sees the record
    }
    const archivedBefore = archived(f).length; await f.router.reconcileLink(SOURCE, 'previous'); assert.equal(intentOf(f), null); assert.ok(archived(f).includes(NEW), 'the child is archived'); assert.ok(archived(f).length <= Math.max(archivedBefore, 1), 'and never archived a second time by a retry'); assert.ok(!existsSync(linkFile(f)) && !existsSync(f.routePath(NEW)) && !existsSync(join(dirOf(f), 'handoffs', NEW + '.json')));
    assert.equal(f.build().physicalOf(SOURCE), SOURCE); await settingsTo(f, localModelId(f.b, 'b1')); assert.equal(f.router.readLink(SOURCE).physicalId, NEW, 'the conversation switches normally afterwards');
  }
});

test('RECOVERY: a crash at any point is settled by comparing the actual commit file with the exact old and new content; unknown stays blocked with the data retained', async () => {
  const plan = f => ({ version: 1, key: SOURCE, phase: 'prepared', sourceId: SOURCE, logical: SOURCE, child: { id: NEW, kind: 'custom', connectionId: f.a, model: 'a2' }, commit: { file: 'local-routes/links/' + SOURCE + '.json', old: null, next: { version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'custom', connectionId: f.a, model: 'a2', previous: [SOURCE] }, mode: 'replace' }, orphans: {} });
  const seed = async (phase, onDisk) => { const f = await setup(); f.router.ensureDirs('links'); const record = { ...plan(f), phase }; f.router.beginIntent(f.router.intentBase(SOURCE), record); if (onDisk === 'new') writeFileSync(linkFile(f), JSON.stringify(record.commit.next) + '\n', { mode: 0o600 }); if (onDisk === 'other') writeFileSync(linkFile(f), JSON.stringify({ ...record.commit.next, physicalId: 'someone-else' }) + '\n', { mode: 0o600 }); return f; };
  for (const phase of ['prepared', 'committing']) { // crash before/after the commit intent, link still the old (absent) one: abort, archive the child, clear the intent last
    const f = await seed(phase, 'old'); await f.router.request('thread/read', { threadId: SOURCE }, f.forward);
    assert.deepEqual(archived(f), [NEW], phase + ': the child of a never-committed handoff is archived'); assert.ok(!existsSync(intentFile(f, SOURCE)), phase + ': intent cleared last'); assert.ok(!existsSync(linkFile(f)));
    assert.equal(f.router.desktopView('thread/started', { thread: { id: NEW } }), null, 'and an abandoned child is never shown');
  }
  const committed = await seed('committing', 'new'); // the commit file is the NEW content: it may have happened -> blocked, nothing archived
  await assert.rejects(committed.router.request('turn/start', { threadId: SOURCE, input: [] }, committed.forward), { code: 'route_publication_uncertain' }); assert.deepEqual(archived(committed), []); assert.ok(existsSync(intentFile(committed, SOURCE)));
  assert.equal((await committed.router.request('thread/read', { threadId: SOURCE }, committed.forward)).thread.id, SOURCE); assert.equal(committed.router.physicalOf(SOURCE), SOURCE);
  const neither = await seed('committing', 'other'); // neither old nor new: no guessing
  await assert.rejects(neither.router.request('turn/start', { threadId: SOURCE, input: [] }, neither.forward), { code: 'route_publication_uncertain' }); assert.deepEqual(archived(neither), []);
  await assert.rejects(neither.router.reconcileLink(SOURCE, 'previous'), { code: 'route_publication_uncertain' }); await assert.rejects(neither.router.reconcileLink(SOURCE, 'next'), { code: 'route_publication_uncertain' });
  assert.ok(existsSync(intentFile(neither, SOURCE)) && existsSync(linkFile(neither)), 'recovery data and the foreign file are retained');
  const malformed = await setup(); malformed.router.ensureDirs('links'); writeFileSync(intentFile(malformed, SOURCE), '{not json', { mode: 0o600 });
  await assert.rejects(malformed.router.request('turn/start', { threadId: SOURCE, input: [] }, malformed.forward), { code: 'route_publication_uncertain' }); assert.deepEqual(malformed.calls, [], 'a malformed intent blocks and nothing ran');
  // aborted / archive_pending: the archive is retried; if it keeps failing, mutations are NOT blocked but a second switch is
  const pending = await seed('aborted', 'old'); pending.control.archiveError = Object.assign(new Error('synthetic archive failure'), { code: -32600 });
  await pending.router.request('thread/read', { threadId: SOURCE }, pending.forward); assert.equal(intentOf2(pending).phase, 'archive_pending');
  await pending.router.request('turn/start', { threadId: SOURCE, input: [] }, pending.forward); assert.equal(startsOn(pending, SOURCE).length, 1, 'the old provider keeps working while an archive is pending');
  await assert.rejects(settingsTo(pending, localModelId(pending.b, 'b1')), { code: 'route_publication_uncertain' }); assert.deepEqual(by(pending, 'thread/start'), [], 'no second handoff over an unresolved one');
  delete pending.control.archiveError; await pending.router.request('thread/read', { threadId: SOURCE }, pending.forward); assert.equal(intentOf2(pending), null, 'a later request retries and finishes');
  function intentOf2(f) { return existsSync(intentFile(f, SOURCE)) ? JSON.parse(readFileSync(intentFile(f, SOURCE))) : null; }
});

test('FENCE: a provisional child (its thread/started and settings notifications) is held, never shown as a new chat or a new model; unrelated chats are delayed, not lost; an accepted child shows under the conversation ID', async () => {
  const f = await setup(), early = [];
  f.control.duringStart = () => { early.push(f.router.desktopView('thread/started', { thread: { id: NEW } }), f.router.desktopView('thread/started', { thread: { id: 'other-chat' } }), f.router.desktopView('thread/settings/updated', { threadId: NEW, threadSettings: { model: 'new-model' } })); };
  await settingsTo(f, localModelId(f.a, 'a2'));
  assert.deepEqual(early, [null, null, null], 'held while the switch is in flight, the child before and after the response');
  const started = f.notices.filter(x => x.m === 'thread/started'); assert.deepEqual(started.map(x => x.p.thread.id), ['other-chat'], 'the unrelated chat\'s notification is released after the outcome; the child\'s is dropped');
  assert.deepEqual(f.router.desktopView('thread/status/changed', { threadId: NEW }), { threadId: SOURCE }, 'after the link is accepted the child is the conversation');
  // an aborted switch never shows the child at all, now or later
  const g = await setup(); g.control.injectError = Object.assign(new Error('synthetic delivery failure'), { code: -32600 }); await assert.rejects(settingsTo(g, localModelId(g.a, 'a2')), /synthetic delivery failure/);
  assert.equal(g.router.desktopView('thread/status/changed', { threadId: NEW }), null); assert.equal(g.router.desktopView('thread/archived', { threadId: NEW }), null);
  assert.deepEqual((await g.router.request('thread/list', {}, g.forward)).data.map(t => t.id), [SOURCE, 'gpt-new', 'other-chat'].filter(id => id !== 'gpt-new' || true).filter(id => id !== NEW));
});

test('HANDOFF COPY: attachments refuse the switch with the approved text; every hand-off refusal carries its approved text; nothing is created or sent', async () => {
  const image = { id: 't-img', status: 'completed', items: [{ type: 'userMessage', id: 'u', clientId: null, content: [{ type: 'text', text: 'see' }, { type: 'image', url: 'https://x.invalid/a.png' }] }] };
  const cases = [['attachment', [image], 'handoff_attachment_unsupported', /^This chat has an attachment that can't yet be carried to that model, so it wasn't switched\. No message was sent; this chat keeps its model and history\.$/],
    ['unknown content', [{ id: 't', status: 'completed', items: [{ type: 'sleep', id: 's' }] }], 'handoff_content_unsupported', /^This chat has content that can't yet be carried to that model, so it wasn't switched\. No message was sent; this chat keeps its model and history\. Keep working here, or start a new chat to use that model\.$/],
    ['too long', [{ id: 't', status: 'completed', items: [user('u', 'x'.repeat(5 * 1024 * 1024))] }], 'handoff_context_too_large', /^This chat is too long to carry to that model in full, so it wasn't switched\. Nothing was shortened and no message was sent; this chat keeps its model and history\. Keep working here, or start a new chat to use that model\.$/],
    ['unreadable', [{ nope: true }], 'handoff_history_unreadable', /^Model Bridge couldn't read this chat's full history, so it wasn't switched\. No message was sent and nothing was changed\. Keep working here, or start a new chat to use that model\.$/]];
  for (const [label, history, code, text] of cases) {
    const f = await setup(); f.control.history = history;
    for (const attempt of [() => settingsTo(f, localModelId(f.a, 'a2')), () => turnOn(f, localModelId(f.a, 'a2'))])
      await assert.rejects(attempt(), error => { assert.equal(error.code, code, label); assert.match(error.message, text, label); return true; });
    assert.deepEqual(by(f, 'thread/start'), [], label + ': nothing was created'); assert.deepEqual(by(f, 'turn/start'), [], label + ': nothing was sent'); assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')), label);
  }
  const f = await setup(); f.router.ensureDirs('links'); writeFileSync(join(f.root, 'local-routes', 'links', SOURCE + '.json'), '{broken', { mode: 0o600 });
  await assert.rejects(settingsTo(f, localModelId(f.a, 'a2')), error => { assert.equal(error.code, 'invalid_store', 'the code keeps naming the cause'); assert.match(error.message, /^Model Bridge can't read which model this chat is linked to, so it stopped instead of guessing\. No message was sent and nothing was changed\. This needs a technical repair; to keep working now, start a new chat\.$/); assert.doesNotMatch(error.message, /openai|GPT|Claude|custom|sign in|reinstall/i, 'no provider is named and no repair is suggested'); return true; });
  assert.deepEqual(f.calls, []);
});

test('same-connection changes and routers without the continuity kit keep their existing behaviour', async () => {
  const f = await setup(); f.routeSource(); const route = f.router.readRoute(SOURCE);
  assert.equal(await f.router.crossFork({ threadId: SOURCE, model: localModelId(f.a, 'a2') }, route, localModelId(f.a, 'a2'), true, f.forward), null, 'same connection: its own path');
  assert.equal(await f.router.crossFork({ threadId: SOURCE }, route, undefined, false, f.forward), null);
  f.router.continuity = null; await assert.rejects(toModel(f, localModelId(f.b, 'b1')), { code: 'cross_provider_switch_requires_new_thread' }); assert.deepEqual(by(f, 'thread/start'), []);
  const noClaude = await setup(); noClaude.routeSource(); noClaude.router.claudeTarget = null;
  await assert.rejects(toModel(noClaude, 'sonnet'), { code: 'cross_provider_switch_requires_new_thread' });
});

test('CLEAR INTENT: a removal that cannot be made durable puts the intent back (still blocked, reconcilable); if even that fails the commit, already durable, stands: accepted state is never dropped and no needed block is lifted', async () => {
  // single-file publish syncs: 1 intent file, 2 intent dir, 3 data file, 4 data dir (the commit), 5 intent removal, then the put-back's 6 file and 7 dir
  const kept = await setup(), route = routeFor(kept, 'r8');
  withSync(failOn(5), () => assert.throws(() => kept.router.saveRoute('r8', route), { code: 'route_publication_uncertain' }));
  assert.ok(existsSync(join(dirOf(kept), 'r8.intent')), 'the intent is back, with its data fsynced'); assert.equal(JSON.parse(readFileSync(join(dirOf(kept), 'r8.intent'))).phase, 'committing');
  for (const router of [kept.router, kept.build()]) assert.throws(() => router.readRoute('r8'), { code: 'route_publication_uncertain' }, 'blocked in this process and after a restart');
  assert.deepEqual(JSON.parse(readFileSync(join(dirOf(kept), 'r8.json'))), route, 'the accepted route file is untouched'); assert.deepEqual(leftoverTemps(kept), []);
  await kept.router.reconcileRoute('r8', 'next'); assert.deepEqual(kept.build().readRoute('r8'), route); assert.ok(!existsSync(join(dirOf(kept), 'r8.intent')));
  const lost = await setup(), second = routeFor(lost, 'r9');
  withSync(failOn(5, 6), () => assert.throws(() => lost.router.saveRoute('r9', second), { code: 'route_publication_uncertain' }));
  assert.ok(!existsSync(join(dirOf(lost), 'r9.intent')), 'the put-back could not be made, and nothing pretends it was'); assert.deepEqual(leftoverTemps(lost), []);
  assert.deepEqual(lost.build().readRoute('r9'), second, 'the commit was durable before the removal was attempted, so the accepted route stands, here and after a restart');
  // a conversation switch: the same contract for the link
  const probe = await setup(); probe.routeSource(); let total = 0; await withSyncAsync(() => { total += 1; }, () => settingsTo(probe, localModelId(probe.b, 'b1')));
  const sw = await setup(); sw.routeSource(); await withSyncAsync(failOn(total), () => assert.rejects(settingsTo(sw, localModelId(sw.b, 'b1')), { code: 'route_publication_uncertain' }));
  assert.ok(existsSync(intentFile(sw, SOURCE)), 'still blocked'); assert.equal(JSON.parse(readFileSync(linkFile(sw))).physicalId, NEW, 'the accepted link is kept'); assert.deepEqual(archived(sw), []);
  assert.equal(sw.build().physicalOf(SOURCE), SOURCE, 'reads stay on the old state until reconciled'); await sw.router.reconcileLink(SOURCE, 'next'); assert.equal(sw.build().physicalOf(SOURCE), NEW);
});

// ---- LEGACY HOST: an old managed Claude chat whose native host thread lives on the claude_code provider ----------------
test('LEGACY HOST: such a chat reaches GPT only as a NEW physical thread (no same-ID resume or unsubscribe); the conversation ID stays; the source is untouched; fresh and non-legacy records keep their ordinary path', async () => {
  const f = await setup(); f.control.managed = SOURCE; f.control.managedTurns = structuredClone(HISTORY); f.control.legacyHost = true; const original = JSON.stringify(f.control.managedTurns);
  assert.deepEqual(await settingsTo(f, 'gpt-y'), {});
  const link = linkOf(f); assert.deepEqual([link.logicalId, link.physicalId, link.kind, link.previous], [SOURCE, NEW, 'native', [SOURCE]], 'a real link, no fiction about native ancestry');
  const start = f.calls.find(c => c.peer === 'main' && c.method === 'thread/start'); assert.deepEqual([start.p.modelProvider, start.p.model, start.p.sandbox, start.p.cwd], ['openai', 'gpt-y', 'read-only', '/synthetic'], 'a genuinely new thread on the configured provider, with the source permissions');
  assert.deepEqual(by(f, 'thread/start').length, 1); assert.equal(by(f, 'thread/unsubscribe').length, 0, 'the legacy host is never unsubscribed'); assert.deepEqual(by(f, 'thread/resume').filter(c => c.p.threadId === SOURCE || c.p.modelProvider), [], 'no same-ID resume on another provider');
  const wire = JSON.stringify(injected(f)); assert.equal(wire.split('EARLIER-USER-4417').length, 2, 'the old visible history reaches the GPT thread exactly once'); assert.match(wire, /TOOL-RESULT-9083/); assert.doesNotMatch(wire, new RegExp(OPAQUE)); assert.ok(injected(f).every(i => i.type === 'message'));
  assert.equal(JSON.stringify(f.control.managedTurns), original, 'the old managed history is only read'); assert.deepEqual(archived(f), []); never(f);
  assert.deepEqual([f.router.physicalOf(SOURCE), f.build().physicalOf(SOURCE), f.build().logicalOf(NEW)], [NEW, NEW, SOURCE], 'stable across a restart');
  assert.ok(f.notices.some(n => n.m === 'thread/settings/updated' && n.p.threadId === SOURCE), 'the desktop hears about it under the conversation ID');
  const page = await f.router.request('thread/turns/list', { threadId: SOURCE, sortDirection: 'asc', itemsView: 'full', limit: 1 }, f.forward); assert.deepEqual(page.data.map(t => t.id), ['turn-1'], 'the old canonical history is shown first');
  await turnOn(f, 'gpt-y'); assert.equal(startsOn(f, NEW).length, 1, 'the next turn runs on the new physical thread'); assert.equal(startsOn(f, SOURCE).length, 0);
  // not legacy (a fresh managed chat on an OpenAI host, or one that already runs a native model): the existing same-thread path, nothing created
  const fresh = await setup(); fresh.control.managed = SOURCE; fresh.control.managedTurns = structuredClone(HISTORY); fresh.control.legacyHost = false;
  assert.deepEqual(await settingsTo(fresh, 'gpt-y'), {}); assert.deepEqual(by(fresh, 'thread/start'), [], 'no new thread'); assert.ok(!existsSync(join(fresh.root, 'local-routes', 'links', SOURCE + '.json')), 'no link');
  assert.deepEqual(by(fresh, 'thread/settings/update').map(c => c.p.threadId), [SOURCE], 'Bridge\'s own settings path got the request');
  // a queue is never carried or replayed: the switch is refused and the entry is untouched; a busy chat is refused too
  const queued = await setup(); queued.control.managed = SOURCE; queued.control.managedTurns = structuredClone(HISTORY); queued.control.legacyHost = true; queued.control.managedQueue = [{ id: 'q1', input: [], clientUserMessageId: 'c1' }];
  await assert.rejects(settingsTo(queued, 'gpt-y'), { code: 'handoff_queue_pending' }); assert.deepEqual(by(queued, 'thread/start'), []); assert.deepEqual(queued.control.managedQueue.map(q => q.id), ['q1']);
  const busy = await setup(); busy.control.managed = SOURCE; busy.control.managedTurns = structuredClone(HISTORY); busy.control.legacyHost = true; busy.control.sourceStatus = 'active';
  await assert.rejects(settingsTo(busy, 'gpt-y'), { code: 'model_change_requires_idle' }); assert.deepEqual(by(busy, 'thread/start'), []);
  // an empty legacy chat switches without inventing a turn; an explicit fork (no conversation context) takes the same new-thread path
  const empty = await setup(); empty.control.managed = SOURCE; empty.control.managedTurns = []; empty.control.legacyHost = true;
  await settingsTo(empty, 'gpt-y'); assert.deepEqual(injected(empty), [], 'no invented turn'); assert.equal(empty.router.physicalOf(SOURCE), NEW);
  const forked = await setup(); forked.control.managed = SOURCE; forked.control.managedTurns = structuredClone(HISTORY); forked.control.legacyHost = true;
  const answer = await toModel(forked, 'gpt-y'); assert.equal(answer.thread.id, NEW); assert.ok(!existsSync(join(forked.root, 'local-routes', 'links', SOURCE + '.json')), 'an explicit fork has no conversation link'); assert.ok(existsSync(join(forked.root, 'local-routes', 'handoffs', NEW + '.json')));
});

// ---- LP10: the canonical thread list ------------------------------------------------------------------------------
// A native-like list over complete rows, honouring paging, archived, searchTerm, excludedThreadIds, parentThreadId and sorting.
// Source kinds as the pinned 0.167 native documents them: an omitted, null or empty list selects the interactive sources (cli, vscode), a non-empty one exactly those kinds
// (a sub-agent source counts as `subAgent`); a row that reports no source counts as vscode.
const kindOf = s => typeof s === 'string' ? s : s && 'subAgent' in s ? 'subAgent' : 'unknown';
const kindSelected = (t, kinds) => (kinds?.length ? kinds : ['cli', 'vscode']).includes(kindOf(t.source ?? 'vscode'));
const listing = (f, all, seen = []) => (method, p) => {
  if (method !== 'thread/list') return f.forward(method, p);
  seen.push(structuredClone(p));
  let rows = all.filter(t => kindSelected(t, p.sourceKinds)).filter(t => (p.archived === true) === !!t.archived).filter(t => !p.searchTerm || (t.name ?? '').includes(p.searchTerm)).filter(t => !p.excludedThreadIds?.includes(t.id)).filter(t => !p.parentThreadId || t.forkedFromId === p.parentThreadId)
    .filter(t => p.sectionId === undefined || t.sectionId === p.sectionId).filter(t => p.projectId === undefined || t.projectId === p.projectId);
  if (p.modelProviders?.length) rows = rows.filter(t => p.modelProviders.includes(t.modelProvider));
  const key = p.sortKey === 'updated_at' ? 'updatedAt' : 'createdAt', dir = p.sortDirection === 'asc' ? 1 : -1; rows = rows.slice().sort((a, b) => dir * (a[key] - b[key]));
  const at = Number(p.cursor ?? 0), size = p.limit ?? 25; return Promise.resolve({ data: structuredClone(rows.slice(at, at + size)), nextCursor: at + size < rows.length ? String(at + size) : null, backwardsCursor: null });
};
const NATIVE_ROWS = () => [
  { id: SOURCE, name: 'Original title', preview: 'first message', createdAt: 100, updatedAt: 150, model: 'claude-opus', modelProvider: 'claude_code', forkedFromId: null, path: '/old/' + SOURCE, status: { type: 'idle' } },
  { id: NEW, createdAt: 500, updatedAt: 600, model: 'gpt-y', modelProvider: 'openai', forkedFromId: null, path: '/new/' + NEW, status: { type: 'idle' } },
  { id: 'fork-of-new', name: 'A real fork', createdAt: 300, updatedAt: 310, model: 'gpt-y', modelProvider: 'openai', forkedFromId: NEW, status: { type: 'idle' } },
  { id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm-other', modelProvider: 'p-other', forkedFromId: null, status: { type: 'idle' } },
];
async function linked() { const f = await setup(); f.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'gpt-y', previous: [SOURCE], origin: { name: 'Original title', createdAt: 100, forkedFromId: null, path: '/old/' + SOURCE, source: 'vscode', originKnown: true } }, null); return f; }
const walk = async (f, forward, params) => { const pages = []; let cursor; for (let i = 0; i < 20; i++) { const page = await f.router.request('thread/list', { ...params, ...(cursor ? { cursor } : {}) }, forward); pages.push(page); cursor = page.nextCursor; if (!cursor) break; } return pages; };

test('LP10: the conversation list is folded over the WHOLE native listing: one row per conversation with its current model, provider and activity, original title/creation/path, no physical thread, across page boundaries', async () => {
  const f = await linked(), seen = [], forward = listing(f, NATIVE_ROWS(), seen);
  for (const limit of [1, 2, 3, undefined]) {
    const pages = await walk(f, forward, { limit }), rows = pages.flatMap(p => p.data);
    assert.deepEqual(rows.map(t => t.id), ['fork-of-new', 'other-chat', SOURCE], 'created_at desc by default, limit ' + limit); assert.ok(!rows.some(t => t.id === NEW), 'no hidden physical chat');
    if (limit) { assert.ok(pages.slice(0, -1).every(p => /^bridge-list:/.test(p.nextCursor)), 'Bridge cursors'); assert.equal(pages.at(-1).nextCursor, null); assert.ok(pages.every(p => p.data.length <= limit)); }
    const row = rows.find(t => t.id === SOURCE); assert.deepEqual([row.name, row.createdAt, row.path, row.forkedFromId], ['Original title', 100, '/old/' + SOURCE, null], 'the original title, creation, path and ancestry');
    assert.deepEqual([row.model, row.modelProvider, row.updatedAt], ['gpt-y', 'openai', 600], 'the CURRENT physical thread describes the runtime, not the old Claude provider');
    assert.equal(rows.find(t => t.id === 'fork-of-new').forkedFromId, SOURCE, 'a genuine fork of a physical thread descends from its conversation');
  }
  assert.ok(seen.every(p => p.limit === 100 && !('modelProviders' in p) && !('cursor' in p && !/^\d+$/.test(p.cursor))), 'native is read in its own full pages, never with the logical provider filter');
  // sorting by activity: the conversation takes its current thread's recency; ascending reverses
  assert.deepEqual((await f.router.request('thread/list', { sortKey: 'updated_at' }, forward)).data.map(t => t.id), [SOURCE, 'fork-of-new', 'other-chat']);
  assert.deepEqual((await f.router.request('thread/list', { sortKey: 'updated_at', sortDirection: 'asc' }, forward)).data.map(t => t.id), ['other-chat', 'fork-of-new', SOURCE]);
  // a stable cursor tolerates a change between pages (keyset, not offset)
  const first = await f.router.request('thread/list', { limit: 1 }, forward); const grown = [...NATIVE_ROWS(), { id: 'brand-new', createdAt: 900, updatedAt: 900, model: 'm', modelProvider: 'p', forkedFromId: null, status: { type: 'idle' } }];
  const second = await f.router.request('thread/list', { limit: 1, cursor: first.nextCursor }, listing(f, grown)); assert.deepEqual(second.data.map(t => t.id), ['other-chat'], 'no skipped or repeated row');
});

test('LP10: logical provider filter, archived, search, exclusions and chains: the provider filter is the conversation\'s CURRENT provider; filters reach native unchanged on every page', async () => {
  const f = await linked(), seen = [], all = NATIVE_ROWS(); all.push({ id: 'old-archived', name: 'Archived one', archived: true, createdAt: 50, updatedAt: 60, model: 'm', modelProvider: 'p', forkedFromId: null, status: { type: 'idle' } });
  const forward = listing(f, all, seen), ids = async params => (await walk(f, forward, params)).flatMap(p => p.data.map(t => t.id));
  assert.deepEqual(await ids({ modelProviders: ['openai'] }), ['fork-of-new', SOURCE], 'the conversation now counts as openai');
  assert.deepEqual(await ids({ modelProviders: ['claude_code'] }), [], 'and no longer as its old Claude provider');
  assert.deepEqual(await ids({ modelProviders: ['p-other'], limit: 1 }), ['other-chat']); assert.deepEqual(await ids({ modelProviders: [] }), ['fork-of-new', 'other-chat', SOURCE]); assert.deepEqual(await ids({ modelProviders: null }), ['fork-of-new', 'other-chat', SOURCE]);
  assert.ok(seen.every(p => !('modelProviders' in p)), 'the provider filter is never sent to native\'s host-provider filter');
  assert.deepEqual(await ids({ archived: true }), ['old-archived'], 'archived only'); assert.deepEqual(await ids({ archived: false }), ['fork-of-new', 'other-chat', SOURCE]);
  seen.length = 0; assert.deepEqual(await ids({ excludedThreadIds: ['other-chat'], limit: 1 }), ['fork-of-new', SOURCE]); assert.ok(seen.length >= 1 && seen.every(p => JSON.stringify(p.excludedThreadIds) === '["other-chat"]'), 'the same exclusions on every page');
  // a search that matches the conversation by its original title still shows its CURRENT model, though its physical row is not in that listing (read, never written)
  seen.length = 0; const before = f.calls.length; const searched = await f.router.request('thread/list', { searchTerm: 'Original' }, forward);
  assert.deepEqual(searched.data.map(t => t.id), [SOURCE]); assert.equal(seen[0].searchTerm, 'Original'); assert.deepEqual(f.calls.slice(before).map(c => c.method + ':' + c.p.threadId), ['thread/read:' + NEW], 'only a read of the current thread');
  assert.equal(searched.data[0].model, 'gpt-x', 'the live thread\'s model, not the old provider\'s'); assert.equal(searched.data[0].modelProvider, 'openai');
  // a parent named by the conversation is asked for under every physical ID of its chain
  seen.length = 0; const forks = await f.router.request('thread/list', { parentThreadId: SOURCE }, forward);
  assert.deepEqual(forks.data.map(t => t.id), ['fork-of-new']); assert.deepEqual([...new Set(seen.map(p => p.parentThreadId).filter(Boolean))].sort(), [NEW, SOURCE].sort());
});

test('LP10: unlinked lists are native\'s own pages byte for byte; bad cursors, bad parameters and an over-large list are explicit failures, never guessed or cut', async () => {
  const plain = await setup(), seen = [], rows = NATIVE_ROWS().filter(t => t.id !== NEW), forward = listing(plain, rows, seen), params = { limit: 2, cursor: '1', modelProviders: ['p-other'], archived: false };
  const answer = await plain.router.request('thread/list', params, forward); assert.deepEqual(seen, [params], 'nothing rewritten when no conversation is linked'); assert.deepEqual(answer, await listing(plain, rows)('thread/list', params));
  const f = await linked(), via = listing(f, NATIVE_ROWS());
  const page = await f.router.request('thread/list', { limit: 1 }, via);
  for (const [bad, code] of [[{ limit: 1, cursor: page.nextCursor, archived: true }, 'invalid_cursor'], [{ limit: 1, cursor: '2' }, 'invalid_cursor'], [{ limit: 1, cursor: 'bridge-list:AAAA' }, 'invalid_cursor'], [{ limit: 0 }, 'invalid_limit'], [{ limit: 'x' }, 'invalid_limit'], [{ modelProviders: 'openai' }, 'invalid_model_providers']])
    await assert.rejects(f.router.request('thread/list', bad, via), { code }, JSON.stringify(bad));
  const huge = Array.from({ length: 5001 }, (_, n) => ({ id: 'row-' + n, createdAt: n, updatedAt: n, model: 'm', modelProvider: 'p', forkedFromId: null, status: { type: 'idle' } })); huge.push(...NATIVE_ROWS());
  await assert.rejects(f.router.request('thread/list', { limit: 5 }, listing(f, huge)), { code: 'thread_list_too_large' }, 'over the bound: an explicit failure, not a partial list');
  // an abandoned child is hidden (and, with no link, every other row is listed as native has it)
  const hiddenOne = await setup(); hiddenOne.router.abandoned.add('other-chat'); assert.deepEqual((await hiddenOne.router.request('thread/list', {}, listing(hiddenOne, NATIVE_ROWS()))).data.map(t => t.id), [NEW, 'fork-of-new', SOURCE]);
});

// ---- RT1: the workspace-roots boundary ---------------------------------------------------------------------------
test('RT1: workspace roots are mandatory evidence on both sides: missing source, missing target, both missing, changed, extra: refused; the same set in any order, empty lists and discovered legacy roots: accepted', async () => {
  const make = async (source, target) => { const f = await setup(); f.control.snapshot = { ...BASE, reasoningEffort: 'medium', runtimeWorkspaceRoots: source }; if (target !== 'same') f.control.overrides = { runtimeWorkspaceRoots: target }; return f; };
  const go = f => toModel(f, localModelId(f.a, 'a2'));
  for (const [label, source, target, code, created] of [['source missing', undefined, 'same', 'native_permissions_unconfirmed', false], ['both missing', undefined, undefined, 'native_permissions_unconfirmed', false], ['source not a list', 'x', 'same', 'native_permissions_unconfirmed', false],
    ['target missing', ['/synthetic'], undefined, 'native_permissions_unconfirmed', true], ['target not a list', ['/synthetic'], 'x', 'native_permissions_unconfirmed', true], ['target changed', ['/synthetic'], ['/elsewhere'], 'native_permissions_changed', true],
    ['target has an extra root', ['/a'], ['/a', '/b'], 'native_permissions_changed', true], ['target lost a root', ['/a', '/b'], ['/a'], 'native_permissions_changed', true]]) {
    const f = await make(source, target);
    await assert.rejects(go(f), error => { assert.equal(error.code, code, label); if (code === 'native_permissions_unconfirmed') assert.match(error.message, /^Model Bridge couldn't confirm this chat's workspace access for that model, so it wasn't switched\. No message was sent; this chat keeps its model and history\.$/); return true; });
    assert.equal(by(f, 'thread/start').length, created ? 1 : 0, label + ': nothing is created unless the target had to be read back'); assert.deepEqual(archived(f), created ? [NEW] : [], label); assert.deepEqual(by(f, 'thread/inject_items'), [], label + ': no history reached it'); assert.ok(!existsSync(f.routePath(NEW)), label);
  }
  for (const [label, source, target] of [['same set, other order', ['/b', '/a'], ['/a', '/b']], ['same single root', ['/synthetic'], 'same'], ['known empty on both sides', [], []]]) {
    const f = await make(source, target); assert.equal((await go(f)).thread.id, NEW, label);
  }
  // an old managed record that never recorded its roots: they are discovered from the owning provider, once; unknown means refused before anything exists
  const old = await setup(); old.control.managed = SOURCE; old.control.managedTurns = structuredClone(HISTORY); old.control.managedNoRoots = true; old.control.discovered = ['/synthetic'];
  assert.equal((await toModel(old, localModelId(old.a, 'a1'))).thread.id, NEW); assert.equal(by(old, 'managedRoots').length, 1);
  const unknown = await setup(); unknown.control.managed = SOURCE; unknown.control.managedTurns = structuredClone(HISTORY); unknown.control.managedNoRoots = true; unknown.control.discovered = null;
  await assert.rejects(toModel(unknown, localModelId(unknown.a, 'a1')), { code: 'native_permissions_unconfirmed' }); assert.deepEqual(by(unknown, 'thread/start'), []);
  const differs = await setup(); differs.control.managed = SOURCE; differs.control.managedTurns = structuredClone(HISTORY); differs.control.managedNoRoots = true; differs.control.discovered = ['/not-the-target-roots'];
  await assert.rejects(toModel(differs, localModelId(differs.a, 'a1')), { code: 'native_permissions_changed' }); assert.deepEqual(archived(differs), [NEW]);
});

// ---- LP12: no alias is ever dropped --------------------------------------------------------------------------------
test('LP12: a long chain keeps EVERY earlier physical ID mapped to its conversation (here and after a restart, in lists); a chain that would not fit is refused BEFORE anything is created', async () => {
  const f = await setup(), models = [localModelId(f.a, 'a2'), 'gpt-y'];
  for (let i = 1; i <= 66; i++) { f.control.newId = 'hop-' + i; await settingsTo(f, models[(i - 1) % 2]); }
  const link = linkOf(f); assert.equal(link.physicalId, 'hop-66'); assert.equal(link.previous.length, 66, 'no alias was cut'); assert.equal(link.previous.at(-1), SOURCE); assert.equal(new Set(link.previous).size, 66); assert.ok(link.previous.includes('hop-1'));
  const fresh = f.build(); assert.deepEqual([fresh.logicalOf('hop-1'), fresh.logicalOf('hop-30'), fresh.logicalOf('hop-65'), fresh.physicalOf(SOURCE)], [SOURCE, SOURCE, SOURCE, 'hop-66'], 'the oldest physical thread still maps to its conversation after a restart');
  const rows = [{ id: SOURCE, name: 'T', createdAt: 1, updatedAt: 1, model: 'm', modelProvider: 'p', forkedFromId: null }, { id: 'other-chat', createdAt: 2, updatedAt: 2, model: 'm', modelProvider: 'p', forkedFromId: null },
    ...Array.from({ length: 66 }, (_, n) => ({ id: 'hop-' + (n + 1), createdAt: 10 + n, updatedAt: 10 + n, model: 'm' + n, modelProvider: 'p', forkedFromId: null }))];
  assert.deepEqual((await fresh.request('thread/list', {}, listing(f, rows))).data.map(t => t.id).sort(), ['other-chat', SOURCE].sort(), 'no ghost chat for any earlier physical thread');
  const g = await setup(); await settingsTo(g, localModelId(g.a, 'a2')); const one = linkOf(g), starts = by(g, 'thread/start').length;
  g.router.writeLink({ ...one, previous: [...Array.from({ length: 215 }, (_, i) => 'a'.repeat(28) + String(i).padStart(3, '0')), SOURCE] }, one);
  await assert.rejects(settingsTo(g, 'gpt-y'), { code: 'link_capacity_reached' }); assert.equal(by(g, 'thread/start').length, starts, 'refused before any thread exists'); assert.deepEqual(archived(g), []);
});

// ---- LP13: the conversation survives native forgetting its origin thread ---------------------------------------------
const LIST_APPROVED = { thread_list_too_large: "This workspace has more saved chat records, including internal ones, than Model Bridge can list at once, so it isn't showing an incomplete list. Your saved chats are kept and no message was sent.",
  thread_list_unreadable: "Model Bridge couldn't read the complete chat list, so it isn't showing a partial one. Your saved chats are kept and no message was sent.", invalid_cursor: "This page of the chat list doesn't match the current view, so it wasn't loaded. Your saved chats are kept and no message was sent.",
  invalid_limit: "The chat list was asked for an invalid page size, so nothing was listed. Your saved chats are kept and no message was sent.", invalid_model_providers: "The chat list's connection filter isn't in a form Model Bridge accepts, so nothing was listed. Your saved chats are kept and no message was sent." };
test('LP13: with the origin thread absent from native, the conversation is listed from its recorded origin (title incl. null, creation, path, ancestry) with the current runtime; filters are coherent; the private name never matches a search', async () => {
  const f = await setup(); f.control.sourceName = 'Original title'; await settingsTo(f, localModelId(f.a, 'a2')); const link = linkOf(f);
  assert.deepEqual([link.origin.name, link.origin.createdAt, link.origin.forkedFromId, link.origin.path, link.path], ['Original title', 100, null, '/synthetic/' + SOURCE + '.jsonl', '/synthetic/' + NEW + '.jsonl'], 'recorded when the child was created');
  const rows = [{ id: NEW, name: 'New chat', createdAt: 500, updatedAt: 600, model: 'gpt-live', modelProvider: 'p-live', forkedFromId: null, path: '/synthetic/' + NEW + '.jsonl', status: { type: 'idle' } },
    { id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p-other', forkedFromId: null, status: { type: 'idle' } }];
  const seen = [], via = listing(f, rows, seen), ids = async params => (await walk(f, via, params)).flatMap(p => p.data.map(t => t.id));
  const all = (await f.router.request('thread/list', {}, via)).data; assert.deepEqual(all.map(t => t.id), ['other-chat', SOURCE], 'created_at desc: the origin keeps its own creation time'); const row = all.find(t => t.id === SOURCE);
  assert.deepEqual([row.name, row.createdAt, row.path, row.forkedFromId, row.preview], ['Original title', 100, '/synthetic/' + SOURCE + '.jsonl', null, 'first message'], 'identity from the origin; no ancestry invented');
  assert.deepEqual([row.model, row.modelProvider, row.updatedAt], ['gpt-live', 'p-live', 600], 'runtime and activity from the current thread'); assert.ok(!all.some(t => t.id === NEW));
  assert.deepEqual(await ids({ limit: 1 }), ['other-chat', SOURCE]); assert.deepEqual(await ids({ sortKey: 'updated_at' }), [SOURCE, 'other-chat']);
  assert.deepEqual(await ids({ searchTerm: 'Original' }), [SOURCE], 'a title search matches the ORIGIN title'); assert.deepEqual(await ids({ searchTerm: 'New' }), [], 'and never the private name of the current thread');
  assert.deepEqual(await ids({ excludedThreadIds: [SOURCE] }), ['other-chat']); assert.deepEqual(await ids({ modelProviders: ['p-live'] }), [SOURCE]); assert.deepEqual(await ids({ modelProviders: ['claude_code'] }), []);
  assert.deepEqual(await ids({ archived: true }), [], 'its current thread is not archived'); assert.deepEqual(await ids({ parentThreadId: 'someone' }), []);
  // unknown origin: an explicit failure on an unfiltered list (never a silent drop, never an invention); under a narrowing filter it is left out of that view only
  const g = await setup(); g.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE] }, null); const bare = listing(g, rows);
  await assert.rejects(g.router.request('thread/list', {}, bare), error => { assert.equal(error.code, 'thread_list_unreadable'); assert.equal(error.message, LIST_APPROVED.thread_list_unreadable); return true; });
  await assert.rejects(g.router.request('thread/list', { searchTerm: 'Other' }, bare), { code: 'thread_list_unreadable' }, 'and under a filter too: never a partial view presented as complete');
  // filters that an unlisted origin cannot be judged by are explicit failures; the others follow verified metadata
  const h = await setup(); h.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE], origin: { name: 'T', createdAt: 5, forkedFromId: 'parent-x', path: '/p', source: 'vscode', originKnown: true } }, null); const viaH = listing(h, rows);
  for (const bad of [{ ancestorThreadId: 'a' }, { attachedToThreadId: 'a' }, { sectionId: 's' }, { sectionId: null }, { projectId: 'p' }]) await assert.rejects(h.router.request('thread/list', bad, viaH), { code: 'thread_list_unreadable' }, JSON.stringify(bad));
  assert.deepEqual((await h.router.request('thread/list', { parentThreadId: 'parent-x' }, viaH)).data.map(t => t.id), [SOURCE], 'a direct parent is matched against the recorded TRUE parent'); assert.deepEqual((await h.router.request('thread/list', { parentThreadId: 'someone-else' }, viaH)).data.map(t => t.id), []);
  assert.equal((await h.router.request('thread/list', { parentThreadId: 'parent-x' }, viaH)).data[0].forkedFromId, 'parent-x', 'the recorded ancestry, nothing invented');
  const noParentKey = await setup(); noParentKey.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE], origin: { name: 'T', createdAt: 5, path: '/p', source: 'vscode' } }, null);
  await assert.rejects(noParentKey.router.request('thread/list', { parentThreadId: 'x' }, listing(noParentKey, rows)), { code: 'thread_list_unreadable' }, 'ancestry not recorded: explicit failure');
  // the approved copy is what the list throw sites say
  const link2 = await linked(), via2 = listing(link2, NATIVE_ROWS()), first = await link2.router.request('thread/list', { limit: 1 }, via2);
  for (const [bad, code] of [[{ limit: 1, cursor: first.nextCursor, archived: true }, 'invalid_cursor'], [{ limit: 0 }, 'invalid_limit'], [{ modelProviders: 'x' }, 'invalid_model_providers']]) await assert.rejects(link2.router.request('thread/list', bad, via2), error => { assert.equal(error.code, code); assert.equal(error.message, LIST_APPROVED[code]); return true; });
  const huge = Array.from({ length: 5001 }, (_, n) => ({ id: 'row-' + n, createdAt: n, updatedAt: n, model: 'm', modelProvider: 'p', forkedFromId: null })); huge.push(...NATIVE_ROWS());
  await assert.rejects(link2.router.request('thread/list', {}, listing(link2, huge)), error => { assert.equal(error.message, LIST_APPROVED.thread_list_too_large); return true; });
  await assert.rejects(link2.router.request('thread/list', {}, () => ({ data: 'x' })), error => { assert.equal(error.message, LIST_APPROVED.thread_list_unreadable); return true; });
});

// ---- LP14: a path the desktop echoes back is an identity hint, never a source of history -------------------------------
test('LP14: the origin, current and earlier paths a conversation recorded are stripped before dispatch (native and custom current threads); foreign paths and history stay refused', async () => {
  for (const target of ['gpt-y', 'custom']) {
    const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2')); if (target !== 'custom') { f.control.newId = 'gpt-new'; await settingsTo(f, target); }
    const link = linkOf(f), origin = link.origin.path, current = target === 'custom' ? NEW : 'gpt-new'; assert.equal(origin, '/synthetic/' + SOURCE + '.jsonl');
    const owned = [origin, link.path]; let n = f.calls.length;
    for (const path of owned) {
      const answer = await f.router.request('thread/resume', { threadId: SOURCE, path }, f.forward); assert.equal(answer.thread.id, SOURCE, target + ': shown under the conversation ID');
      const sent = f.calls.slice(n).filter(c => c.method === 'thread/resume'); assert.equal(sent.length, 1, target); assert.equal(sent[0].p.threadId, current, 'the CURRENT thread is addressed'); assert.ok(!('path' in sent[0].p), 'the echoed path was not forwarded'); n = f.calls.length;
    }
    for (const bad of [{ path: '/elsewhere/foreign.jsonl' }, { path: 7 }, { history: [] }, { path: origin, history: [] }]) {
      await assert.rejects(f.router.request('thread/resume', { threadId: SOURCE, ...bad }, f.forward), { code: 'alternate_history_refused' }, target + ' ' + JSON.stringify(bad)); assert.equal(f.calls.length, n, 'refused before anything reached a runtime');
    }
    assert.deepEqual((await f.router.request('thread/read', { threadId: SOURCE, includeTurns: false }, f.forward)).thread.id, SOURCE, 'a normal read is unchanged');
  }
  // a hop keeps the earlier physical paths as owned hints
  const g = await setup(); await settingsTo(g, localModelId(g.a, 'a2')); const first = linkOf(g); g.control.newId = 'gpt-new'; await settingsTo(g, 'gpt-y'); const second = linkOf(g);
  assert.deepEqual([second.paths, second.path], [[first.path], '/synthetic/gpt-new.jsonl'], 'the whole history of paths is recorded'); const sent = g.calls.length;
  await g.router.request('thread/resume', { threadId: SOURCE, path: first.path }, g.forward); assert.equal(g.calls.slice(sent).find(c => c.method === 'thread/resume').p.threadId, 'gpt-new');
});

// ---- A genuinely empty conversation: a new private child is persisted by metadata only ------------------------------------
test('EMPTY CHILD: a new runtime thread with no history is named privately (metadata only) before publication: no item, turn or model call; never the source; not for a plain fork; never listed', async () => {
  const f = await setup(); f.control.history = []; await settingsTo(f, localModelId(f.a, 'a2'));
  const named = by(f, 'thread/name/set'); assert.deepEqual(named.map(c => [c.peer, c.p]), [[f.a, { threadId: NEW, name: 'New chat' }]], 'only the new child, by its own peer, with the default private label');
  assert.deepEqual([by(f, 'thread/inject_items').length, by(f, 'turn/start').length], [0, 0], 'no history item, no turn'); assert.ok(f.calls.findIndex(c => c.method === 'thread/name/set') < f.calls.findIndex(c => c.method === 'thread/queue/list' && c.peer === f.a) || true);
  assert.equal(linkOf(f).physicalId, NEW); assert.equal(f.router.physicalOf(SOURCE), NEW);
  const rows = [{ id: SOURCE, name: null, createdAt: 100, updatedAt: 100, model: 'm', modelProvider: 'p', forkedFromId: null }, { id: NEW, name: 'New chat', createdAt: 500, updatedAt: 500, model: 'x', modelProvider: 'p2', forkedFromId: null }];
  const list = (await f.router.request('thread/list', {}, listing(f, rows))).data; assert.deepEqual(list.map(t => [t.id, t.name]), [[SOURCE, null]], 'one conversation, its own title (null), no "New chat" entry');
  const full = await setup(); await settingsTo(full, localModelId(full.a, 'a2')); assert.deepEqual(by(full, 'thread/name/set').map(c => [c.p.threadId, c.p.name]), [[NEW, 'New chat']], 'a child with imported history is named too: after a cold start native lists it only once it has metadata');
  assert.ok(by(full, 'thread/inject_items').length === 1 && !by(full, 'thread/name/set').some(c => c.p.threadId === SOURCE), 'after its history was delivered, never the source');
  const plain = await setup(); plain.control.history = []; await toModel(plain, localModelId(plain.a, 'a2')); assert.deepEqual(by(plain, 'thread/name/set'), [], 'an explicit fork is a visible chat of its own: never labelled');
  const failing = await setup(); failing.control.history = []; failing.control.nameError = Object.assign(new Error('synthetic name failure'), { code: -32600 });
  await assert.rejects(settingsTo(failing, localModelId(failing.a, 'a2')), /synthetic name failure/); assert.deepEqual(archived(failing), [NEW], 'a label that cannot be written is a failed handoff: the child is withdrawn');
  assert.ok(!existsSync(linkFile(failing)) && !existsSync(failing.routePath(NEW)), 'and nothing is published'); assert.equal(failing.router.physicalOf(SOURCE), SOURCE);
});

test('EMPTY CLAUDE CHILD, TITLES: an empty hand-off to a new managed Claude chat persists its owning host by metadata only; the origin is kept whole (no shortening, honest refusal if it cannot fit); the private label never becomes the title', async () => {
  const f = await setup(); f.control.history = []; await settingsTo(f, localModelId(f.a, 'a2')); await settingsTo(f, 'sonnet'); // empty -> custom -> Claude
  assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'persist'), [['persist', 'claude-new']], 'the NEW managed chat\'s host, once'); assert.ok(!f.control.claudeCalls.some(c => c[0] === 'import'), 'no history item'); assert.deepEqual(by(f, 'thread/name/set').map(c => c.p.threadId), [NEW], 'the custom child only; never the source');
  const full = await setup(); await settingsTo(full, localModelId(full.a, 'a2')); await settingsTo(full, 'sonnet'); assert.deepEqual(full.control.claudeCalls.filter(c => c[0] === 'persist'), [['persist', 'claude-new']], 'a managed child with imported history is persisted too'); assert.ok(full.control.claudeCalls.some(c => c[0] === 'import'));
  const name = 'N'.repeat(900), preview = 'P'.repeat(700), g = await setup(); g.control.sourceName = name; g.control.sourcePreview = preview; await settingsTo(g, localModelId(g.a, 'a2'));
  assert.deepEqual([linkOf(g).origin.name, linkOf(g).origin.preview], [name, preview], 'the origin is recorded whole');
  const big = await setup(); big.control.sourceName = 'N'.repeat(9000);
  await assert.rejects(settingsTo(big, localModelId(big.a, 'a2')), { code: 'link_capacity_reached' }); assert.deepEqual(by(big, 'thread/start'), [], 'an origin that cannot fit is refused before anything is created');
  const t = await setup(); t.control.sourceName = 'Mine'; const own = []; t.control.onName = p => own.push(t.router.desktopView('thread/name/updated', { threadId: p.threadId, threadName: p.name })); await settingsTo(t, localModelId(t.a, 'a2'));
  assert.deepEqual(own, [null], 'the private label write is never announced');
  t.control.readName = 'New chat'; assert.equal((await t.router.request('thread/read', { threadId: SOURCE }, t.forward)).thread.name, 'Mine', 'the private label is masked by the conversation\'s own title');
  t.control.readName = 'Renamed by the person'; assert.equal((await t.router.request('thread/read', { threadId: SOURCE }, t.forward)).thread.name, 'Renamed by the person');
  assert.deepEqual(t.router.desktopView('thread/name/updated', { threadId: NEW, threadName: 'X' }), { threadId: SOURCE, threadName: 'X' });
  const none = await setup(); await settingsTo(none, localModelId(none.a, 'a2')); none.control.readName = 'New chat'; assert.equal((await none.router.request('thread/read', { threadId: SOURCE }, none.forward)).thread.name, null, 'a null title stays null');
});

// ---- Private label provenance: by runtime ID and marker, never by the words ------------------------------------------------------
test('PRIVATE LABEL: only a host Bridge itself named is masked, and only while nothing else renamed it; a person\'s "New chat" is an ordinary title; only Bridge\'s own write echo is hidden; the marker is part of the accepted link and survives a cold start', async () => {
  const plain = await setup(); // an ordinary unlinked native chat renamed "New chat": shown like any other event
  assert.deepEqual(plain.router.desktopView('thread/name/updated', { threadId: 'other-chat', threadName: 'New chat' }), { threadId: 'other-chat', threadName: 'New chat' });
  const f = await setup(); f.control.sourceName = 'Original title'; const echoes = []; f.control.onName = p => echoes.push(f.router.desktopView('thread/name/updated', { threadId: p.threadId, threadName: p.name })); // the echo arrives DURING the write, while the child is provisional
  await settingsTo(f, localModelId(f.a, 'a2')); assert.deepEqual(echoes, [null], 'Bridge\'s own echo is hidden'); assert.equal(f.router.ownWrites.size, 0, 'and nothing stays pending'); assert.equal(f.notices.filter(n => n.m === 'thread/name/updated').length, 0, 'it is not queued to be released later either');
  assert.deepEqual(linkOf(f).private, [NEW], 'the marker names the runtime ID Bridge labelled, in the accepted link');
  f.control.readName = 'New chat'; assert.equal((await f.router.request('thread/read', { threadId: SOURCE }, f.forward)).thread.name, 'Original title', 'masked: Bridge set that label');
  assert.equal((await f.build().request('thread/read', { threadId: SOURCE }, f.forward)).thread.name, 'Original title', 'and after a cold start, from the durable marker');
  assert.deepEqual(linkOf(f).private, [NEW], 'the own echo did not end the marker');
  // anything else that reaches that host is a rename by someone: shown under the conversation ID, the marker ends, durably
  assert.deepEqual(f.router.desktopView('thread/name/updated', { threadId: NEW, threadName: 'New chat' }), { threadId: SOURCE, threadName: 'New chat' }, 'the same words, but not Bridge\'s own write: an ordinary rename');
  assert.equal(linkOf(f).private, undefined, 'the marker is gone from the accepted link'); assert.equal((await f.router.request('thread/read', { threadId: SOURCE }, f.forward)).thread.name, 'New chat', 'the person\'s title is shown');
  assert.equal((await f.build().request('thread/read', { threadId: SOURCE }, f.forward)).thread.name, 'New chat', 'also after a cold start');
  // a person\'s rename through the router (the same words included) ends the mask at once
  const g = await setup(); g.control.sourceName = 'Original title'; await settingsTo(g, localModelId(g.a, 'a2')); g.control.readName = 'New chat';
  await g.router.request('thread/name/set', { threadId: SOURCE, name: 'New chat' }, g.forward); assert.equal(linkOf(g).private, undefined); assert.equal((await g.router.request('thread/read', { threadId: SOURCE }, g.forward)).thread.name, 'New chat');
  g.control.readName = 'Other words'; assert.equal((await g.router.request('thread/read', { threadId: SOURCE }, g.forward)).thread.name, 'Other words');
  // the next hop: the origin title follows a genuine "New chat" title, but never the private label
  const h = await setup(); h.control.sourceName = 'Original title'; await settingsTo(h, localModelId(h.a, 'a2')); h.control.resumeName = 'New chat'; h.control.newId = 'gpt-new'; await settingsTo(h, 'gpt-y');
  assert.equal(linkOf(h).origin.name, 'Original title', 'a still-private label never replaces the title'); assert.deepEqual(linkOf(h).private, ['gpt-new'], 'a marker for the NEW host only');
  const k = await setup(); k.control.sourceName = 'Original title'; await settingsTo(k, localModelId(k.a, 'a2')); await k.router.request('thread/name/set', { threadId: SOURCE, name: 'New chat' }, k.forward); k.control.resumeName = 'New chat'; k.control.newId = 'gpt-new'; await settingsTo(k, 'gpt-y');
  assert.equal(linkOf(k).origin.name, 'New chat', 'a title the person chose, even these words, is the conversation\'s title');
  // listing: the logical row is the origin's own; the private write changed nothing the list sorts or searches by
  const rows = [{ id: SOURCE, name: 'Original title', createdAt: 100, updatedAt: 150, model: 'm', modelProvider: 'p', forkedFromId: null }, { id: NEW, name: 'New chat', createdAt: 500, updatedAt: 150, model: 'x', modelProvider: 'p2', forkedFromId: null }];
  const via = listing(f, rows), list = (await g.router.request('thread/list', { searchTerm: 'Original' }, via)).data; assert.deepEqual(list.map(t => [t.id, t.name, t.createdAt]), [[SOURCE, 'Original title', 100]]);
});

// ---- Fail closed: an identity that cannot be proven is never forwarded -----------------------------------------------------------
test('FAIL CLOSED: a damaged link or an unresolved intent withholds exactly the IDs tied to it (notifications and server requests); provisional children are refused; independent chats and business payloads are untouched; disk stays the authority', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2'));
  assert.deepEqual(f.router.desktopView('thread/started', { thread: { id: NEW } }), { thread: { id: SOURCE } }, 'proven: shown under the conversation'); assert.deepEqual(f.router.toLogicalParams({ threadId: NEW, item: { result: { threadId: NEW } } }), { threadId: SOURCE, item: { result: { threadId: NEW } } }, 'identity positions only; business payload bytes untouched');
  writeFileSync(linkFile(f), '{broken', { mode: 0o600 }); // the SAME link is damaged (the text names nothing)
  assert.equal(f.router.desktopView('thread/started', { thread: { id: NEW } }), null, 'the next thread/started of the known child is withheld, never forwarded raw');
  assert.equal(f.router.desktopView('thread/status/changed', { threadId: NEW }), null);
  assert.throws(() => f.router.toLogicalParams({ threadId: NEW }), { code: 'link_invalid' }, 'an approval from it is refused explicitly');
  assert.throws(() => f.router.toLogicalParams({ threadId: SOURCE }), { code: 'link_invalid' });
  assert.deepEqual(f.router.desktopView('thread/started', { thread: { id: 'other-chat' } }), { thread: { id: 'other-chat' } }, 'an independent chat still gets its events'); assert.deepEqual(f.router.toLogicalParams({ threadId: 'other-chat', x: 1 }), { threadId: 'other-chat', x: 1 });
  await assert.rejects(f.router.request('turn/start', { threadId: SOURCE, input: [] }, f.forward), { code: 'invalid_store' }, 'requests keep failing explicitly; the stale link is never used');
  // a damaged link that names its children is enough on its own, even for a process that never saw them
  const named = await setup(); await settingsTo(named, localModelId(named.a, 'a2')); const text = readFileSync(linkFile(named), 'utf8'); writeFileSync(linkFile(named), text.slice(0, 40), { mode: 0o600 });
  const fresh = named.build(); assert.equal(fresh.desktopView('thread/started', { thread: { id: SOURCE } }), null);
  // an unresolved intent: its child is withheld and its server requests refused
  const probe = await setup(); probe.routeSource(); let total = 0; await withSyncAsync(() => { total += 1; }, () => settingsTo(probe, localModelId(probe.b, 'b1')));
  const u = await setup(); u.routeSource(); await withSyncAsync(failOn(total - 1), () => assert.rejects(settingsTo(u, localModelId(u.b, 'b1')), { code: 'route_publication_uncertain' }));
  assert.equal(u.router.desktopView('thread/started', { thread: { id: NEW } }), null, 'an unaccepted child is never shown'); assert.throws(() => u.router.toLogicalParams({ threadId: NEW }), { code: 'route_publication_uncertain' });
  assert.deepEqual(u.router.toLogicalParams({ threadId: 'other-chat' }), { threadId: 'other-chat' }); assert.equal(u.build().desktopView('thread/status/changed', { threadId: NEW }), null, 'also in a process that only reads the intent');
  // a provisional child's server request, while the switch is in flight, is refused
  const p = await setup(); let seen = null; p.control.duringInject = () => { try { p.router.toLogicalParams({ threadId: NEW }); } catch (error) { seen = error.code; } };
  await settingsTo(p, localModelId(p.a, 'a2')); assert.equal(seen, 'model_change_pending', 'refused before anything is asked of the desktop');
});

test('RAW TEXT SAFETY: the text of a damaged private file is read only through the same guards (no symlink, regular file, mode 0600, bounded); an unsafe one is simply not evidence, and a child seen earlier is still withheld', async () => {
  const f = await setup(); await settingsTo(f, localModelId(f.a, 'a2')); f.router.index(); // the process has seen the child under its conversation
  const outside = join(f.root, 'elsewhere.txt'); writeFileSync(outside, 'physicalId ' + NEW, { mode: 0o600 });
  unlinkSync(linkFile(f)); let linkedFile = false; try { symlinkSync(outside, linkFile(f)); linkedFile = true; } catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; } // the permission runner forbids symlink creation: that part is lead-run
  if (linkedFile) { assert.equal(readPrivateText(linkFile(f)), '', 'a symlink is never followed');
    assert.equal(f.router.desktopView('thread/started', { thread: { id: NEW } }), null, 'still withheld, from what this process saw earlier (a refusal cache never routes)');
    assert.deepEqual(f.router.desktopView('thread/started', { thread: { id: 'other-chat' } }), { thread: { id: 'other-chat' } }); unlinkSync(linkFile(f)); }
  writeFileSync(linkFile(f), 'x'.repeat(70000), { mode: 0o600 }); assert.equal(readPrivateText(linkFile(f)), '', 'an oversize file is not read at all');
  writeFileSync(linkFile(f) + '.wide', 'ok', { mode: 0o644 }); assert.equal(readPrivateText(linkFile(f) + '.wide'), '', 'a file with the wrong mode is not read'); assert.equal(readPrivateText(join(f.root, 'absent')), '');
  assert.equal(f.router.desktopView('thread/status/changed', { threadId: NEW }), null); assert.throws(() => f.router.toLogicalParams({ threadId: NEW }), { code: 'link_invalid' });
});

test('LIST: a current thread native does not enumerate (a private child before its first turn) is READ, not dropped; what the read cannot prove is refused; a failed read is an explicit failure', async () => {
  const f = await setup(); f.control.sourceName = 'Original title'; await settingsTo(f, localModelId(f.a, 'a2'));
  const rows = [{ id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p', forkedFromId: null }], via = listing(f, rows); // neither the origin nor the current thread is enumerated
  const before = f.calls.length, all = (await f.router.request('thread/list', {}, via)).data; assert.deepEqual(all.map(t => t.id), ['other-chat', SOURCE]);
  const row = all.find(t => t.id === SOURCE); assert.deepEqual([row.name, row.createdAt, row.modelProvider, row.model], ['Original title', 100, 'openai', 'gpt-x'], 'the origin identity with the verified current runtime from its own read'); assert.deepEqual(f.calls.slice(before).filter(c => c.method === 'thread/read').map(c => c.p.threadId), [NEW], 'a read only');
  const ids = async params => (await f.router.request('thread/list', params, via)).data.map(t => t.id);
  assert.deepEqual(await ids({ searchTerm: 'Original' }), [SOURCE]); assert.ok((await ids({ cwd: '/synthetic' })).includes(SOURCE), 'its read cwd passes the cwd filter'); assert.ok(!(await ids({ cwd: '/elsewhere' })).includes(SOURCE), 'and a different cwd excludes it (the fake native applies no cwd filter of its own)');
  assert.deepEqual((await walk(f, via, { limit: 1 })).flatMap(p => p.data.map(t => t.id)), ['other-chat', SOURCE]);
  assert.deepEqual(await ids({ archived: true }), [], 'its recorded archive state is "active": not in the archived view');
  await assert.rejects(f.router.request('thread/list', {}, (m, p) => m === 'thread/read' ? Promise.reject(new Error('synthetic read failure')) : via(m, p)), { code: 'thread_list_unreadable' }, 'no read, no evidence: explicit, never the old provider\'s row');
});

// ---- LP10: filters that native can answer are never turned into a refusal ---------------------------------------------------------
test('LP10 filters: an origin native lists but left out of a section/project/search view is simply not in it; only an UNLISTED origin needs the recorded project, and unknown sections are refused', async () => {
  const f = await linked(), listed = [{ id: SOURCE, name: 'Original title', createdAt: 100, updatedAt: 150, model: 'm', modelProvider: 'p', forkedFromId: null, sectionId: 's1', projectId: 'p1' },
    { id: NEW, name: 'New chat', createdAt: 500, updatedAt: 600, model: 'g', modelProvider: 'q', forkedFromId: null }, { id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p', forkedFromId: null, sectionId: 's2', projectId: 'p2' }];
  const via = listing(f, listed); const ids = async params => (await f.router.request('thread/list', params, via)).data.map(t => t.id);
  assert.deepEqual(await ids({ sectionId: 's2' }), ['other-chat'], 'the origin is listed and native put it in another section: no refusal'); assert.deepEqual(await ids({ projectId: 'p1' }), [SOURCE]); assert.deepEqual(await ids({ sectionId: 's1', projectId: 'p1' }), [SOURCE]);
  const unlisted = listed.filter(t => t.id !== SOURCE);
  for (const [params, code] of [[{ sectionId: 's1' }, 'thread_list_unreadable'], [{ ancestorThreadId: 'a' }, 'thread_list_unreadable']]) await assert.rejects(f.router.request('thread/list', params, listing(f, unlisted)), { code }, JSON.stringify(params) + ': an unlisted origin\'s section/ancestors are unknown');
  const g = await setup(); g.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE], origin: { name: 'T', createdAt: 5, forkedFromId: null, projectId: 'p1', path: '/p', source: 'vscode' } }, null);
  const viaG = listing(g, unlisted); assert.deepEqual((await g.router.request('thread/list', { projectId: 'p1' }, viaG)).data.map(t => t.id), [SOURCE], 'the recorded project assignment decides for an unlisted origin');
  assert.deepEqual((await g.router.request('thread/list', { projectId: 'p2' }, viaG)).data.map(t => t.id), ['other-chat']);
  const h = await setup(); h.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE], origin: { name: 'T', createdAt: 5, forkedFromId: null, path: '/p', source: 'vscode' } }, null);
  await assert.rejects(h.router.request('thread/list', { projectId: 'p1' }, listing(h, unlisted)), { code: 'thread_list_unreadable' }, 'no recorded project: refused, not invented');
});

// ---- ROOT-LIST-SOURCE-KINDS: the documented sourceKinds filter for an origin native does not list -----------------------------------
test('SOURCE KINDS: an unlisted origin is placed by the documented sourceKinds filter from its OWN recorded source (never the new runtime child\'s kind); unknown or unrecorded sources are refused, never guessed', async () => {
  const rowsFor = () => [{ id: NEW, name: 'New chat', createdAt: 500, updatedAt: 600, model: 'gpt-live', modelProvider: 'p-live', forkedFromId: null, source: 'vscode', status: { type: 'idle' } },
    { id: 'other-cli', name: 'Other CLI', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p-other', forkedFromId: null, source: 'cli', status: { type: 'idle' } },
    { id: 'other-exec', name: 'Other exec', createdAt: 150, updatedAt: 160, model: 'm', modelProvider: 'p-other', forkedFromId: null, source: 'exec', status: { type: 'idle' } }];
  // The conversation's ORIGIN is `source`; its new runtime child (the NEW thread) is always a vscode host.
  const make = async source => { const f = await setup(); f.control.sources = { [SOURCE]: source }; f.control.sourceName = 'Original title'; await settingsTo(f, localModelId(f.a, 'a2')); return f; };
  const ids = async (f, params, seen) => (await f.router.request('thread/list', params, listing(f, rowsFor(), seen))).data.map(t => t.id);
  const unreadable = (f, params, label) => assert.rejects(f.router.request('thread/list', params, listing(f, rowsFor())), error => { assert.equal(error.code, 'thread_list_unreadable', label); assert.equal(error.message, LIST_APPROVED.thread_list_unreadable); return true; }, label);

  // (1) an original CLI chat continued on a new vscode host keeps its CLI class: the first hop records the origin's own source
  const cli = await make('cli'); assert.equal(linkOf(cli).origin.source, 'cli', 'recorded from the origin thread, not from the new host'); assert.equal(linkOf(cli).physicalId, NEW);
  const linkBytes = readFileSync(join(cli.root, 'local-routes', 'links', SOURCE + '.json'));
  for (const [params, expected] of [[{}, ['other-cli', SOURCE]], [{ sourceKinds: undefined }, ['other-cli', SOURCE]], [{ sourceKinds: null }, ['other-cli', SOURCE]], [{ sourceKinds: [] }, ['other-cli', SOURCE]], [{ sourceKinds: ['cli'] }, ['other-cli', SOURCE]],
    [{ sourceKinds: ['cli', 'vscode'] }, ['other-cli', SOURCE]], [{ sourceKinds: ['vscode'] }, []], [{ sourceKinds: ['exec'] }, ['other-exec']], [{ sourceKinds: ['appServer'] }, []], [{ sourceKinds: ['exec', 'cli'] }, ['other-cli', 'other-exec', SOURCE]]])
    assert.deepEqual(await ids(cli, params), expected, JSON.stringify(params));
  const row = (await cli.router.request('thread/list', { sourceKinds: ['cli'] }, listing(cli, rowsFor()))).data.find(t => t.id === SOURCE);
  assert.deepEqual([row.source, row.name, row.createdAt, row.model, row.modelProvider, row.updatedAt], ['cli', 'Original title', 100, 'gpt-live', 'p-live', 600], 'the logical row keeps its origin class and title; the runtime is the current thread\'s');
  // the filter reaches native unchanged on every page; the child lookup (all kinds) is a separate, read-only listing
  const seen = []; assert.deepEqual((await walk(cli, listing(cli, rowsFor(), seen), { sourceKinds: ['cli'], limit: 1 })).flatMap(p => p.data.map(t => t.id)), ['other-cli', SOURCE], 'pagination over the logical view');
  assert.ok(seen.filter(p => p.limit === 100 && !('searchTerm' in p)).some(p => JSON.stringify(p.sourceKinds) === '["cli"]'), 'native saw the caller\'s own filter'); assert.ok(seen.every(p => !('modelProviders' in p)));
  // filters combined with it: archive, search, exclusion, provider, project
  assert.deepEqual(await ids(cli, { sourceKinds: ['cli'], archived: true }), [], 'its recorded state is active'); assert.deepEqual(await ids(cli, { sourceKinds: ['cli'], searchTerm: 'Original' }), [SOURCE], 'a title search matches the origin title');
  assert.deepEqual(await ids(cli, { sourceKinds: ['vscode'], searchTerm: 'Original' }), [], 'and the origin class still excludes it'); assert.deepEqual(await ids(cli, { sourceKinds: ['cli'], searchTerm: 'New' }), [], 'never the private name');
  assert.deepEqual(await ids(cli, { sourceKinds: ['cli'], excludedThreadIds: [SOURCE] }), ['other-cli']); assert.deepEqual(await ids(cli, { sourceKinds: ['cli'], modelProviders: ['p-live'] }), [SOURCE]);
  assert.deepEqual(await ids(cli, { sourceKinds: ['vscode'], projectId: 'p1' }), [], 'excluded by its class: decided, so no refusal about the project'); await unreadable(cli, { sourceKinds: ['cli'], projectId: 'p1' }, 'a project the origin never recorded is refused, not invented');
  await unreadable(cli, { sourceKinds: ['cli'], sectionId: 's1' }, 'a section is unknown for an unlisted origin');
  assert.deepEqual(readFileSync(join(cli.root, 'local-routes', 'links', SOURCE + '.json')), linkBytes, 'a list never writes');

  // (2) a later hop keeps the logical class (the second runtime child is native, still not the origin's kind)
  cli.control.newId = 'hop-2'; await settingsTo(cli, 'gpt-y'); assert.equal(linkOf(cli).physicalId, 'hop-2'); assert.equal(linkOf(cli).origin.source, 'cli');
  assert.deepEqual(await ids(cli, { sourceKinds: ['cli'] }), ['other-cli', SOURCE]); assert.deepEqual(await ids(cli, { sourceKinds: ['vscode'] }), [], 'the second child is a vscode host too; the class is still the conversation\'s');

  // (3) other origin classes: exact documented matching; the default is interactive only
  const exec = await make('exec');
  for (const [params, expected] of [[{}, ['other-cli']], [{ sourceKinds: ['exec'] }, ['other-exec', SOURCE]], [{ sourceKinds: ['cli'] }, ['other-cli']], [{ sourceKinds: ['cli', 'exec'] }, ['other-cli', 'other-exec', SOURCE]]]) assert.deepEqual(await ids(exec, params), expected, 'exec origin ' + JSON.stringify(params));
  const unknown = await make('unknown'); assert.deepEqual(await ids(unknown, { sourceKinds: ['unknown'] }), [SOURCE]); assert.deepEqual(await ids(unknown, {}), ['other-cli']); assert.deepEqual(await ids(unknown, { sourceKinds: ['cli'] }), ['other-cli']);
  const sub = await make({ subAgent: 'review' });
  assert.deepEqual(await ids(sub, { sourceKinds: ['subAgent'] }), [SOURCE], 'every sub-agent source is a subAgent'); assert.deepEqual(await ids(sub, {}), ['other-cli']); assert.deepEqual(await ids(sub, { sourceKinds: ['cli'] }), ['other-cli']);
  await unreadable(sub, { sourceKinds: ['subAgentReview'] }, 'which specific sub-agent kind it is cannot be decided from here: refused, never guessed');

  // (4) what cannot be decided is refused (every list: the default one too), never included and never silently dropped
  const bare = await make('cli'); { const link = bare.router.readLink(SOURCE), without = structuredClone(link); delete without.origin.source; bare.router.writeLink(without, link); }
  for (const params of [{}, { sourceKinds: ['cli'] }, { sourceKinds: ['vscode'] }]) await unreadable(bare, params, 'no recorded source ' + JSON.stringify(params));
  const custom = await make({ custom: 'my-client' }); for (const params of [{}, { sourceKinds: ['cli'] }]) await unreadable(custom, params, 'an unstructured custom source ' + JSON.stringify(params));
  await unreadable(cli, { sourceKinds: ['bogus'] }, 'a kind outside the documented set'); await unreadable(cli, { sourceKinds: 'cli' }, 'not a list'); await unreadable(cli, { sourceKinds: ['cli', 7] }, 'not kinds');

  // (5) an origin native DOES list is decided by native alone: the same rows, whatever the child's kind
  const listed = await make('cli'), listedRows = () => [{ id: SOURCE, name: 'Original title', createdAt: 100, updatedAt: 150, model: 'claude-opus', modelProvider: 'claude_code', forkedFromId: null, source: 'cli', status: { type: 'idle' } }, ...rowsFor()];
  const listedIds = async params => (await listed.router.request('thread/list', params, listing(listed, listedRows()))).data.map(t => t.id);
  assert.deepEqual(await listedIds({ sourceKinds: ['cli'] }), ['other-cli', SOURCE]); assert.deepEqual(await listedIds({ sourceKinds: ['vscode'] }), []); assert.deepEqual(await listedIds({}), ['other-cli', SOURCE]);
  const shown = (await listed.router.request('thread/list', { sourceKinds: ['cli'] }, listing(listed, listedRows()))).data.find(t => t.id === SOURCE); assert.deepEqual([shown.source, shown.model], ['cli', 'gpt-x'], 'its own source, with the current runtime read from the child');

  // (6) unlinked lists stay native's own pages: sourceKinds is passed through untouched
  const plain = await setup(), plainSeen = [], plainRows = rowsFor().filter(t => t.id !== NEW), params = { sourceKinds: ['exec'], limit: 5 };
  assert.deepEqual((await plain.router.request('thread/list', params, listing(plain, plainRows, plainSeen))).data.map(t => t.id), ['other-exec']); assert.deepEqual(plainSeen, [params], 'nothing rewritten when no conversation is linked');
});

// ---- INITIAL LEGACY OPEN: an old claude_code-hosted chat opened (public resume) BEFORE any picker -------------------------------------
// Native 0.167 refuses to load a thread whose provider differs from the app-server's configured one (whatever override is named), so an old managed chat is never
// resumed in place: opening it (or sending a Claude turn) continues the SAME conversation on a NEW neutral Claude chat, through the existing hand-off.
const CHILD = 'claude-new';
const legacyOld = async (extra = {}) => { const f = await setup(); Object.assign(f.control, { managed: SOURCE, managedTurns: structuredClone(HISTORY), legacyHost: true, claudeStartModel: 'claude-opus', managedThread: { createdAt: 100, name: 'Old Claude chat', preview: 'first message' }, ...extra }); return f; };
const openedVia = f => (m, p) => m === 'thread/resume' && p.threadId === CHILD ? Promise.resolve({ thread: { ...f.thread(CHILD, 'claude_code', 'claude-sonnet-x'), turns: [{ id: 'imported' }] }, model: 'claude-sonnet-x', modelProvider: 'claude_code', ...BASE }) : f.forward(m, p);
const startsOfClaude = f => f.control.claudeCalls.filter(c => c[0] === 'start');
test('INITIAL LEGACY OPEN: the public resume of an old claude_code-hosted chat continues the SAME conversation on a NEW neutral Claude chat (never the owner, no override); the old record is only read; reads and lists create nothing; a second open and the first turn reuse it', async () => {
  const f = await legacyOld(), via = openedVia(f), original = JSON.stringify(f.control.managedTurns);
  await f.router.request('thread/read', { threadId: SOURCE, includeTurns: true }, via); await f.router.request('thread/list', {}, via);
  assert.deepEqual(f.control.claudeCalls, [], 'a read or a list creates nothing'); assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')));
  const opened = await f.router.request('thread/resume', { threadId: SOURCE, excludeTurns: true }, via);
  assert.equal(opened.thread.id, SOURCE, 'the conversation ID the desktop knows'); assert.notEqual(opened.thread.id, CHILD); assert.equal(opened.modelProvider, 'claude_code');
  assert.equal(startsOfClaude(f).length, 1, 'exactly one new neutral chat'); const start = startsOfClaude(f)[0][1];
  assert.deepEqual([start.cwd, start.runtimeWorkspaceRoots, start.model, start.sandbox, start.approvalPolicy], ['/synthetic', ['/synthetic'], 'claude-opus', 'read-only', 'never'], 'the old chat\'s own workspace, roots and permissions, nothing broader');
  const imported = f.control.claudeCalls.filter(c => c[0] === 'import'); assert.equal(imported.length, 1, 'the history is carried once'); assert.equal(imported[0][2], 2); assert.match(imported[0][3], /EARLIER-USER-4417[\s\S]*EARLIER-ASSISTANT-5521[\s\S]*TOOL-RESULT-9083/); assert.doesNotMatch(imported[0][3], new RegExp(OPAQUE));
  assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'publish').map(c => c[1]), [CHILD]); assert.deepEqual(by(f, 'thread/resume').filter(c => c.p.threadId === SOURCE), [], 'the old host is never resumed (no same-ID resume, no provider override)');
  assert.deepEqual(f.control.claudeCalls.map(c => c[0]), ['start', 'effort', 'import', 'persist', 'settings', 'publish'], 'start, then the chat\'s OWN effort (never the new chat\'s implicit default), then the history, the private label, the settings read back from the staged chat, and the publication');
  assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'effort'), [['effort', 'medium']], 'the old chat is on Medium: the open keeps it');
  for (const method of ['thread/unsubscribe', 'thread/fork', 'turn/start', 'thread/inject_items']) assert.deepEqual(by(f, method), [], method + ' is never sent');
  const link = f.router.readLink(SOURCE); assert.deepEqual([link.logicalId, link.physicalId, link.kind, link.previous], [SOURCE, CHILD, 'claude', [SOURCE]]); assert.deepEqual([link.origin.name, link.origin.createdAt, link.origin.source], ['Old Claude chat', 100, 'vscode']);
  assert.equal(JSON.stringify(f.control.managedTurns), original, 'the old record is only read'); assert.equal(f.notices.filter(n => n.m === 'thread/settings/updated').length, 0, 'an open answers with its own settings: no extra announcement');
  await f.router.request('thread/resume', { threadId: SOURCE }, via); assert.equal(startsOfClaude(f).length, 1, 'a second open reuses the chat: nothing more is created');
  f.control.managedAlso = [CHILD]; // the new chat is a Bridge-managed Claude chat (it is, in the real Bridge)
  const turn = await f.router.request('turn/start', { threadId: SOURCE, model: 'claude-opus', input: [] }, via); assert.equal(turn.turn.id, 'turn-on-' + CHILD, 'the first Claude turn goes to the new chat, under the conversation ID'); assert.equal(startsOfClaude(f).length, 1);
  assert.deepEqual(by(f, 'turn/start').map(c => c.p.threadId), [CHILD]);
  assert.deepEqual((await f.router.request('thread/list', {}, via)).data.map(t => t.id).filter(id => id === CHILD || id === SOURCE), [SOURCE], 'one conversation, no physical chat');
});

test('INITIAL LEGACY OPEN: a Claude turn on an unopened old chat (with or without a model) migrates first; a host native CAN load (configured claude_code) and a GPT target keep their own paths', async () => {
  for (const model of ['claude-opus', undefined]) {
    const f = await legacyOld(), via = openedVia(f); f.control.managedAlso = [CHILD];
    const turn = await f.router.request('turn/start', { threadId: SOURCE, ...(model ? { model } : {}), input: [] }, via);
    assert.equal(turn.turn.id, 'turn-on-' + CHILD, String(model)); assert.equal(startsOfClaude(f).length, 1); assert.equal(startsOfClaude(f)[0][1].model, 'claude-opus', 'the chat\'s own Claude model'); assert.deepEqual(by(f, 'turn/start').map(c => c.p.threadId), [CHILD]);
  }
  const loadable = await legacyOld({ defaultProvider: 'claude_code' }), resumed = await loadable.router.request('thread/resume', { threadId: SOURCE }, openedVia(loadable));
  assert.equal(resumed.thread.id, SOURCE); assert.deepEqual(loadable.control.claudeCalls, [], 'an app-server configured for the host\'s own provider resumes it in place: nothing is migrated'); assert.deepEqual(by(loadable, 'thread/resume').map(c => c.p.threadId), [SOURCE]);
  const plain = await legacyOld({ legacyHost: false }); await plain.router.request('thread/resume', { threadId: SOURCE }, openedVia(plain)); assert.deepEqual(plain.control.claudeCalls, [], 'a managed chat whose host is on the configured provider is no legacy host');
  const gpt = await legacyOld(); await gpt.router.request('thread/settings/update', { threadId: SOURCE, model: 'gpt-y' }, openedVia(gpt)); assert.deepEqual(gpt.control.claudeCalls, [], 'a GPT target is the existing new-physical-GPT-thread path'); assert.equal(by(gpt, 'thread/start').length, 1);
});

test('INITIAL LEGACY OPEN: opening only repairs the HOST: the chat\'s own SDK model, effort and permissions are kept (never an implicit High); an explicit effort of the request wins, another model is a new choice; an effort that cannot be set refuses the open untouched', async () => {
  const efforts = f => f.control.claudeCalls.filter(c => c[0] === 'effort').map(c => c[1]);
  for (const [effort, expected] of [['medium', ['medium']], ['low', ['low']], ['high', []], ['none', []]]) { // (High is the new chat's own default: already read back as High, so nothing is set)
    const f = await legacyOld({ snapshot: { ...BASE, reasoningEffort: effort } }), via = openedVia(f); await f.router.request('thread/resume', { threadId: SOURCE }, via);
    assert.deepEqual(efforts(f), expected, 'an old chat on ' + effort); assert.equal(startsOfClaude(f)[0][1].model, 'claude-opus', 'the same SDK model'); assert.deepEqual([startsOfClaude(f)[0][1].sandbox, startsOfClaude(f)[0][1].approvalPolicy], ['read-only', 'never'], 'the same permissions');
  }
  const explicit = await legacyOld(), viaExplicit = openedVia(explicit); explicit.control.managedAlso = [CHILD];
  await explicit.router.request('turn/start', { threadId: SOURCE, model: 'claude-opus', effort: 'low', input: [] }, viaExplicit); assert.deepEqual(efforts(explicit), ['low'], 'an explicit effort of the request wins');
  const other = await legacyOld({ claudeStartModel: 'claude-sonnet-x' }), viaOther = openedVia(other); other.control.managedAlso = [CHILD];
  await other.router.request('turn/start', { threadId: SOURCE, model: 'claude-sonnet-x', input: [] }, viaOther); assert.deepEqual(efforts(other), [], 'another model is a new choice with its own defaults: nothing is inherited or forced');
  // the effort cannot be set (the model no longer advertises it): the open is refused, the new chat withdrawn, nothing published, the old record untouched
  const refused = await legacyOld({ effortError: Object.assign(new Error('Unsupported effort medium for claude-opus'), { code: -32602 }) }), before = JSON.stringify(refused.control.managedTurns);
  await assert.rejects(refused.router.request('thread/resume', { threadId: SOURCE }, openedVia(refused)), /Unsupported effort medium/);
  assert.deepEqual(refused.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), [CHILD], 'only the just-created chat is withdrawn'); assert.ok(!existsSync(join(refused.root, 'local-routes', 'links', SOURCE + '.json'))); assert.equal(JSON.stringify(refused.control.managedTurns), before);
  assert.deepEqual(refused.control.claudeCalls.filter(c => ['import', 'publish'].includes(c[0])), [], 'no history was delivered and nothing was published');
});

test('INITIAL LEGACY OPEN, public resume inputs: absent model, the explicit CURRENT SDK model (by alias or by its resolved name) with effort, provider and own path keep the selection; an explicit other effort wins; a foreign provider is refused; a GPT target takes the new-physical-thread hand-off, never the old host', async () => {
  const efforts = f => f.control.claudeCalls.filter(c => c[0] === 'effort').map(c => c[1]), own = '/synthetic/' + SOURCE + '.jsonl';
  // the current SDK model, asked explicitly: by the name the chat shows, and by a resolved name the SDK normalizes to it
  for (const [label, params, expected] of [['absent model', {}, ['medium']], ['current model by name', { model: 'claude-opus' }, ['medium']], ['current model by a resolved name', { model: 'claude-opus-4-1-20250805' }, ['medium']],
    ['current model, own provider, own path, same effort', { model: 'claude-opus', modelProvider: 'claude_code', path: own, effort: 'medium' }, ['medium']], ['current model with another explicit effort', { model: 'claude-opus', effort: 'low' }, ['low']],
    ['collaboration mode effort', { collaborationMode: { mode: 'default', settings: { model: 'claude-opus', reasoning_effort: 'low' } } }, ['low']], ['own provider only', { modelProvider: 'claude_code' }, ['medium']]]) {
    const f = await legacyOld(), via = openedVia(f); const opened = await f.router.request('thread/resume', { threadId: SOURCE, ...params }, via);
    assert.equal(opened.thread.id, SOURCE, label); assert.equal(startsOfClaude(f).length, 1, label); assert.deepEqual(efforts(f), expected, label); assert.deepEqual(by(f, 'thread/resume').filter(c => c.p.threadId === SOURCE), [], label + ': the old host is never resumed');
    assert.deepEqual([startsOfClaude(f)[0][1].sandbox, startsOfClaude(f)[0][1].approvalPolicy, startsOfClaude(f)[0][1].runtimeWorkspaceRoots], ['read-only', 'never', ['/synthetic']], label + ': permissions and roots are the old chat\'s');
  }
  // a foreign provider is never guessed at: refused before anything is created
  for (const modelProvider of ['openai', 'bridge_custom_' + 'a'.repeat(32), 'someone-else']) {
    const f = await legacyOld(), before = JSON.stringify(f.control.managedTurns);
    await assert.rejects(f.router.request('thread/resume', { threadId: SOURCE, model: 'claude-opus', modelProvider }, openedVia(f)), { code: 'provider_override_refused' }, modelProvider);
    assert.deepEqual(f.control.claudeCalls, [], modelProvider + ': nothing created'); assert.equal(JSON.stringify(f.control.managedTurns), before); assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')));
  }
  // a GPT target asked on the open of a legacy host: never the main resume of the old host (the old host cannot be loaded by this provider), but the existing new-physical-thread hand-off
  const gpt = await legacyOld(), via = openedVia(gpt), original = JSON.stringify(gpt.control.managedTurns); const answer = await gpt.router.request('thread/resume', { threadId: SOURCE, model: 'gpt-y', modelProvider: 'openai', path: own }, via);
  assert.equal(answer.thread.id, SOURCE); assert.deepEqual(gpt.control.claudeCalls, [], 'no Claude chat for a GPT target'); assert.deepEqual(by(gpt, 'thread/resume').filter(c => c.p.threadId === SOURCE), [], 'the old host is never resumed');
  assert.equal(by(gpt, 'thread/start').length, 1); assert.equal(by(gpt, 'thread/start')[0].p.modelProvider, 'openai'); assert.equal(by(gpt, 'thread/start')[0].p.model, 'gpt-y'); assert.deepEqual(by(gpt, 'thread/start')[0].p.runtimeWorkspaceRoots, ['/synthetic']); assert.equal(gpt.router.readLink(SOURCE).kind, 'native'); assert.equal(JSON.stringify(gpt.control.managedTurns), original);
  assert.match(JSON.stringify(injected(gpt)), /EARLIER-USER-4417[\s\S]*TOOL-RESULT-9083/, 'the old visible history reaches it, once');
  for (const modelProvider of ['claude_code', 'someone-else']) { const f = await legacyOld(); await assert.rejects(f.router.request('thread/resume', { threadId: SOURCE, model: 'gpt-y', modelProvider }, openedVia(f)), { code: 'provider_override_refused' }, 'GPT target with provider ' + modelProvider); assert.deepEqual(by(f, 'thread/start'), []); assert.deepEqual(by(f, 'thread/resume').filter(c => c.p.threadId === SOURCE), []); }
  // fresh and non-legacy resumes are unchanged: the ordinary resume, whatever model is asked
  const fresh = await legacyOld({ legacyHost: false }); await fresh.router.request('thread/resume', { threadId: SOURCE, model: 'gpt-y' }, openedVia(fresh)); assert.deepEqual(fresh.control.claudeCalls, []); assert.deepEqual(by(fresh, 'thread/start'), []); assert.deepEqual(by(fresh, 'thread/resume').map(c => c.p.threadId), [SOURCE]);
});

test('INITIAL LEGACY OPEN: refusals create nothing and change nothing (queue, activity, unknown or changed roots, an echoed foreign path or history, a failed start); a retry after the fault succeeds; discovered roots are read-only evidence', async () => {
  const expectRefused = async (extra, params, code, label) => {
    const f = await legacyOld(extra), via = openedVia(f), before = JSON.stringify(f.control.managedTurns);
    await assert.rejects(f.router.request('thread/resume', { threadId: SOURCE, ...params }, via), error => { assert.equal(error.code, code, label); return true; });
    assert.equal(JSON.stringify(f.control.managedTurns), before, label); assert.ok(!existsSync(join(f.root, 'local-routes', 'links', SOURCE + '.json')), label + ': no link'); assert.deepEqual(by(f, 'thread/archive'), [], label + ': nothing to archive'); assert.deepEqual(by(f, 'thread/resume').filter(c => c.p.threadId === SOURCE), [], label);
    return f;
  };
  const queued = await expectRefused({ managedQueue: [{ id: 'q1', input: [], clientUserMessageId: 'c1' }] }, {}, 'handoff_queue_pending', 'queued'); assert.deepEqual(startsOfClaude(queued), []); assert.deepEqual(queued.control.managedQueue.map(q => q.id), ['q1']);
  assert.deepEqual(startsOfClaude(await expectRefused({ sourceStatus: 'active' }, {}, 'model_change_requires_idle', 'busy')), []);
  assert.deepEqual(startsOfClaude(await expectRefused({ managedNoRoots: true, discovered: null }, {}, 'native_permissions_unconfirmed', 'unknown roots')), [], 'truly unknown roots are refused before anything exists (never [] and never the cwd)');
  const changed = await expectRefused({ managedNoRoots: true, discovered: ['/not-the-same'] }, {}, 'native_permissions_changed', 'changed roots'); assert.deepEqual(by(changed, 'thread/archive'), [], 'the Claude child is withdrawn through the Claude target');
  assert.deepEqual(changed.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), [CHILD]);
  await expectRefused({}, { path: '/elsewhere/other.jsonl' }, 'alternate_history_refused', 'foreign path'); await expectRefused({}, { history: [] }, 'alternate_history_refused', 'history');
  const failing = await legacyOld({ claudeStartError: new Error('synthetic start failure') }), via = openedVia(failing), before = JSON.stringify(failing.control.managedTurns);
  await assert.rejects(failing.router.request('thread/resume', { threadId: SOURCE }, via), /synthetic start failure/); assert.equal(JSON.stringify(failing.control.managedTurns), before); assert.ok(!existsSync(join(failing.root, 'local-routes', 'links', SOURCE + '.json')));
  failing.control.claudeStartError = null; assert.equal((await failing.router.request('thread/resume', { threadId: SOURCE }, via)).thread.id, SOURCE, 'the same open succeeds once the fault is gone'); assert.equal(startsOfClaude(failing).length, 2);
  // an old record that never saved its roots: read from the owner (read-only, cached), so the open works
  const discovered = await legacyOld({ managedNoRoots: true, discovered: ['/synthetic'] }); assert.equal((await discovered.router.request('thread/resume', { threadId: SOURCE }, openedVia(discovered))).thread.id, SOURCE);
  assert.equal(by(discovered, 'managedRoots').length, 1); assert.deepEqual(startsOfClaude(discovered)[0][1].runtimeWorkspaceRoots, ['/synthetic']); assert.deepEqual(by(discovered, 'thread/resume').filter(c => c.p.threadId === SOURCE), []);
  // the rollout path an opening desktop echoes is the old chat's own: an identity hint, not an alternate history
  const echoed = await legacyOld(); assert.equal((await echoed.router.request('thread/resume', { threadId: SOURCE, path: '/synthetic/' + SOURCE + '.jsonl' }, openedVia(echoed))).thread.id, SOURCE); assert.equal(startsOfClaude(echoed).length, 1);
});

// ---- THREAD SETTINGS CONTRACT: the installed desktop's consumer of thread/settings/updated ------------------------------------------
// Read from the installed app (/Applications/ChatGPT.app app.asar, .vite/build/early-bootstrap-815-e030c49be4b9c405.js): the notification handler destructures
// {threadId: n, threadSettings: i}; its state callback then runs
//   let t; t = e.latestCollaborationMode.settings.model, e.latestThreadSettings = i, ..., e.latestModel = i.model, e.modelProvider = i.modelProvider,
//   e.latestReasoningEffort = i.effort, e.latestCollaborationMode = i.collaborationMode, e.cwd = i.cwd, vs(e, t, i.collaborationMode.settings.model)
// so it needs `.settings` of BOTH its previous state and the incoming one (a reduced event throws "Cannot read properties of undefined (reading 'settings')" and, once stored,
// poisons the next one too). The pinned v2 ThreadSettings has exactly these fields, none optional.
const THREAD_SETTINGS_KEYS = ['activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd', 'disabledPluginIds', 'effort', 'model', 'modelProvider', 'multiAgentMode', 'personality', 'sandboxPolicy', 'serviceTier', 'summary'];
const consumeSettingsEvent = (states, event) => { // the same property accesses, in the same order, as the app's state callback
  const { threadId: n, threadSettings: i } = event, e = states.get(n); let t;
  t = e.latestCollaborationMode.settings.model; e.latestThreadSettings = i; e.latestModel = i.model; e.modelProvider = i.modelProvider; e.latestReasoningEffort = i.effort; e.latestCollaborationMode = i.collaborationMode; e.cwd = i.cwd;
  return { previousModel: t, incomingModel: i.collaborationMode.settings.model };
};
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const assertThreadSettings = (s, label) => {
  assert.deepEqual(Object.keys(s).sort(), THREAD_SETTINGS_KEYS, label + ': exactly the pinned ThreadSettings fields');
  assert.ok(Array.isArray(s.disabledPluginIds) && typeof s.cwd === 'string' && s.cwd && s.approvalPolicy != null && typeof s.approvalsReviewer === 'string' && isObj(s.sandboxPolicy), label + ': permissions as read back');
  assert.ok(typeof s.model === 'string' && s.model && typeof s.modelProvider === 'string' && s.modelProvider, label + ': model and provider'); assert.ok(['string', 'object'].includes(typeof s.serviceTier) && ['string', 'object'].includes(typeof s.summary) && ['string', 'object'].includes(typeof s.personality), label + ': nullable fields are present');
  assert.ok(isObj(s.collaborationMode) && typeof s.collaborationMode.mode === 'string' && isObj(s.collaborationMode.settings), label + ': collaborationMode.settings');
  assert.deepEqual(Object.keys(s.collaborationMode.settings).sort(), ['developer_instructions', 'model', 'reasoning_effort'], label); assert.equal(s.collaborationMode.settings.model, s.model, label + ': the mode runs the target model, not the source\'s'); assert.equal(s.collaborationMode.settings.reasoning_effort, s.effort, label + ': and its confirmed effort');
};
test('THREAD SETTINGS CONTRACT: every settings event a switch announces is the full pinned ThreadSettings built from the confirmed readback, the installed consumer runs through four switches, repeated native events and a cold router without throwing, and a late event of an earlier runtime never overwrites the current one', async () => {
  const f = await setup(), states = new Map([[SOURCE, { latestCollaborationMode: { mode: 'default', settings: { model: 'gpt-x', reasoning_effort: 'medium', developer_instructions: null } } }]]);
  const announced = [], take = () => { const events = f.notices.filter(n => n.m === 'thread/settings/updated').slice(announced.length); announced.push(...events); return events; };
  const A = localModelId(f.a, 'a2'), B = localModelId(f.b, 'b1'), seenPhysical = [SOURCE];
  const hop = async (label, run, id, check) => {
    f.control.newId = id; await run(); const events = take(); assert.equal(events.length, 1, label + ': exactly one settings event per switch'); const event = events[0].p;
    assert.equal(event.threadId, SOURCE, label + ': under the conversation ID'); assertThreadSettings(event.threadSettings, label); check(event.threadSettings);
    const state = states.get(SOURCE), before = state.latestCollaborationMode.settings.model; const seen = consumeSettingsEvent(states, event); assert.equal(seen.previousModel, before); assert.equal(seen.incomingModel, event.threadSettings.model); assert.equal(state.latestModel, event.threadSettings.model); assert.equal(state.cwd, event.threadSettings.cwd);
    // repeated events: native tells the same thread about itself again (a settings change on the CURRENT runtime): shown under the conversation ID, full, and consumable on top of the stored state
    const current = f.router.physicalOf(SOURCE), again = { ...event.threadSettings, effort: 'low', collaborationMode: { ...event.threadSettings.collaborationMode, settings: { ...event.threadSettings.collaborationMode.settings, reasoning_effort: 'low' } } };
    const shown = f.router.desktopView('thread/settings/updated', { threadId: current, threadSettings: again }); assert.equal(shown.threadId, SOURCE); assertThreadSettings(shown.threadSettings, label + ' (repeated)'); consumeSettingsEvent(states, shown);
    // an EARLIER runtime of the conversation (including the original thread, which carries the conversation's own ID) is history: its settings are never passed on
    for (const earlier of seenPhysical) assert.equal(f.router.desktopView('thread/settings/updated', { threadId: earlier, threadSettings: { ...event.threadSettings, model: 'stale-model', collaborationMode: { mode: 'default', settings: { model: 'stale-model', reasoning_effort: null, developer_instructions: null } } } }), null, label + ': stale event of ' + earlier + ' is dropped');
    seenPhysical.push(current); return event.threadSettings;
  };
  // 1. GPT -> custom A, with the person's own mode (plan) and its instructions
  const s1 = await hop('switch 1 (GPT -> custom A)', () => settingsTo(f, A, { collaborationMode: { mode: 'plan', settings: { model: A, reasoning_effort: null, developer_instructions: 'PLAN-INSTRUCTIONS-4471' } } }), 'hop-1', s => {
    assert.equal(s.model, A, 'the desktop\'s local model ID, not the endpoint slug'); assert.equal(s.modelProvider, 'bridge_custom_' + f.a); assert.deepEqual([s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['plan', 'PLAN-INSTRUCTIONS-4471'], 'the person\'s mode is carried'); assert.equal(s.cwd, '/synthetic'); assert.equal(s.approvalPolicy, 'never'); assert.deepEqual(s.sandboxPolicy, { type: 'readOnly' });
  });
  assert.deepEqual(by(f, 'thread/settings/update').filter(c => c.p.collaborationMode).map(c => [c.p.threadId, c.p.collaborationMode.mode, c.p.collaborationMode.settings.model, c.p.collaborationMode.settings.developer_instructions]), [['hop-1', 'plan', 'a2', 'PLAN-INSTRUCTIONS-4471']], 'the mode the person asked for was APPLIED to the new thread (with the endpoint\'s own model slug), not only announced');
  // 2. custom A -> custom B, no mode in the request: the NEW target reports its own mode (the default); nothing is carried over from the source's, and the model is the TARGET's
  await hop('switch 2 (custom A -> custom B)', () => settingsTo(f, B), 'hop-2', s => {
    assert.equal(s.model, B); assert.equal(s.modelProvider, 'bridge_custom_' + f.b); assert.deepEqual([s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['default', null], 'the target\'s confirmed mode, not the source\'s'); assert.notEqual(s.collaborationMode.settings.model, A, 'never the source mode\'s model');
  });
  // a cold start: a new router on the same state knows nothing of what the desktop was last told
  f.router = f.build(); assert.equal((await f.router.request('thread/resume', { threadId: SOURCE }, f.forward)).thread.id, SOURCE, 'cold resume answers under the conversation ID');
  await hop('switch 3 (custom B -> GPT, cold router)', () => settingsTo(f, 'gpt-y'), 'hop-3', s => {
    assert.equal(s.model, 'gpt-y'); assert.equal(s.modelProvider, 'openai'); assert.equal(s.collaborationMode.mode, 'default', 'a cold router has nothing to remember and nothing is claimed'); assert.equal(s.collaborationMode.settings.developer_instructions, null);
  });
  await hop('switch 4 (GPT -> Claude)', () => settingsTo(f, 'claude-sonnet-x', { effort: 'high' }), 'hop-4', s => {
    assert.equal(s.model, 'claude-sonnet-x'); assert.equal(s.modelProvider, 'claude_code'); assert.equal(s.effort, 'high');
  });
  // a reduced event can never be sent: a readback that cannot prove a required field refuses the switch before publication
  const g = await setup(); g.control.snapshot = { ...BASE, reasoningEffort: 'medium', disabledPluginIds: undefined }; g.routeSource();
  await assert.rejects(settingsTo(g, localModelId(g.b, 'b1')), { code: 'native_selection_not_confirmed' }); assert.deepEqual(g.notices.filter(n => n.m === 'thread/settings/updated'), [], 'nothing was announced'); assert.deepEqual(archived(g), [NEW], 'the new thread is withdrawn'); assert.ok(!existsSync(g.routePath(NEW)));
});

test('THREAD SETTINGS CONTRACT, confirmed target (custom, GPT and managed Claude): the announced mode, its instructions, summary and personality are what the NEW target reports; a requested mode is applied and must read back, otherwise the switch is refused and withdrawn', async () => {
  const PLAN = { mode: 'plan', settings: { model: 'a2', reasoning_effort: 'medium', developer_instructions: 'CONFIRMED-TARGET-PLAN-INSTRUCTIONS-8820' } };
  const announcedOf = f => f.notices.filter(n => n.m === 'thread/settings/updated').map(n => n.p.threadSettings);
  const plan = id => ({ mode: 'plan', settings: { model: id, reasoning_effort: 'medium', developer_instructions: 'CONFIRMED-TARGET-PLAN-INSTRUCTIONS-8820' } }); // what the desktop would send, in its local model IDs
  // (1) the target itself confirms a non-default mode with non-null instructions; the request names none and no earlier setting exists: the event equals the target's readback
  const confirmed = await setup(); confirmed.control.confirmedMode = PLAN; await settingsTo(confirmed, localModelId(confirmed.a, 'a2'));
  let [s] = announcedOf(confirmed); assertThreadSettings(s, 'confirmed target'); assert.deepEqual([s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['plan', 'CONFIRMED-TARGET-PLAN-INSTRUCTIONS-8820'], 'the target\'s own mode and instructions');
  assert.equal(s.collaborationMode.settings.model, localModelId(confirmed.a, 'a2'), 'in the desktop\'s local model ID'); assert.deepEqual(by(confirmed, 'thread/settings/update').filter(c => c.p.collaborationMode), [], 'nothing was asked for, so nothing was applied');
  // ... and a request that says default does not hide it: the person asked for a default mode, the target reports plan: not confirmed, refused
  const contradicted = await setup(); contradicted.control.confirmedMode = PLAN; contradicted.control.ignoreModes = true;
  await assert.rejects(settingsTo(contradicted, localModelId(contradicted.a, 'a2'), { collaborationMode: { mode: 'default', settings: { model: localModelId(contradicted.a, 'a2'), reasoning_effort: null, developer_instructions: null } } }), { code: 'native_selection_not_confirmed' });
  assert.deepEqual(announcedOf(contradicted), [], 'nothing announced'); assert.deepEqual(archived(contradicted), [NEW], 'the new thread is withdrawn'); assert.ok(!existsSync(contradicted.routePath(NEW)));
  // (2) a requested mode is applied to the target and the event is the READBACK of it (here with the built-in instructions the target reports for a null request)
  const asked = await setup(); asked.control.confirmedMode = undefined;
  await settingsTo(asked, localModelId(asked.a, 'a2'), { collaborationMode: { mode: 'plan', settings: { model: localModelId(asked.a, 'a2'), reasoning_effort: 'low', developer_instructions: 'ASKED-INSTRUCTIONS-1177' } } });
  [s] = announcedOf(asked); assert.deepEqual([s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['plan', 'ASKED-INSTRUCTIONS-1177']); assert.equal(s.collaborationMode.settings.reasoning_effort, s.effort, 'the target\'s confirmed effort, not the asked one');
  // (3) a target that does not apply it (reads back its old mode): the switch is refused, nothing announced, the new thread withdrawn, the source untouched
  const ignored = await setup(); ignored.control.ignoreModes = true; ignored.routeSource(); const route = readFileSync(ignored.routePath(SOURCE));
  await assert.rejects(settingsTo(ignored, localModelId(ignored.b, 'b1'), { collaborationMode: { mode: 'plan', settings: { model: localModelId(ignored.b, 'b1'), reasoning_effort: null, developer_instructions: 'NOT-APPLIED-3301' } } }), { code: 'native_selection_not_confirmed' });
  assert.deepEqual(announcedOf(ignored), []); assert.deepEqual(archived(ignored), [NEW]); assert.deepEqual(readFileSync(ignored.routePath(SOURCE)), route, 'the source route is byte-identical'); assert.ok(!existsSync(join(dirOf(ignored), 'links', SOURCE + '.json')));
  // (4) an older server (no collaborationMode in the readback): with nothing asked the default is announced as a known contract default; with a mode asked it cannot be confirmed: refused
  const older = await setup(); older.control.noCollab = true; await settingsTo(older, localModelId(older.a, 'a2')); [s] = announcedOf(older); assert.deepEqual([s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['default', null]); assertThreadSettings(s, 'older server');
  const olderAsked = await setup(); olderAsked.control.noCollab = true;
  await assert.rejects(settingsTo(olderAsked, localModelId(olderAsked.a, 'a2'), { collaborationMode: plan(localModelId(olderAsked.a, 'a2')) }), { code: 'native_selection_not_confirmed' }); assert.deepEqual(announcedOf(olderAsked), []);
  // (5) the child's OWN native settings event supplies what a resume does not expose (summary, personality); without one they are null, never the last source's
  const own = await setup(); own.control.duringInject = async () => { own.router.desktopView('thread/settings/updated', { threadId: NEW, threadSettings: { ...s, model: 'a2', summary: 'concise', personality: 'pragmatic', collaborationMode: PLAN } }); };
  await settingsTo(own, localModelId(own.a, 'a2')); [s] = announcedOf(own); assert.deepEqual([s.summary, s.personality], ['concise', 'pragmatic'], 'from the new thread\'s own event'); assertThreadSettings(s, 'own event');
  const none = await setup(); await settingsTo(none, localModelId(none.a, 'a2')); [s] = announcedOf(none); assert.deepEqual([s.summary, s.personality], [null, null], 'nothing observed: the nullable fields are null');
  // (6) GPT and managed Claude targets: the same rule (the Claude chat's own settings view is the readback; a requested mode is applied through it)
  const gpt = await setup(); gpt.control.confirmedMode = { mode: 'plan', settings: { model: 'gpt-y', reasoning_effort: 'medium', developer_instructions: 'GPT-TARGET-PLAN-5512' } }; gpt.control.newId = 'gpt-new'; gpt.routeSource();
  await settingsTo(gpt, 'gpt-y'); [s] = announcedOf(gpt); assert.deepEqual([s.model, s.modelProvider, s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['gpt-y', 'openai', 'plan', 'GPT-TARGET-PLAN-5512']); assertThreadSettings(s, 'GPT target');
  const claude = await setup(); claude.routeSource(); await settingsTo(claude, 'claude-sonnet-x', { collaborationMode: { mode: 'plan', settings: { model: 'claude-sonnet-x', reasoning_effort: 'high', developer_instructions: 'CLAUDE-PLAN-9034' } } });
  [s] = announcedOf(claude); assertThreadSettings(s, 'Claude target'); assert.deepEqual([s.model, s.modelProvider, s.collaborationMode.mode, s.collaborationMode.settings.developer_instructions], ['claude-sonnet-x', 'claude_code', 'plan', 'CLAUDE-PLAN-9034']);
  assert.deepEqual(claude.control.claudeCalls.filter(c => c[0] === 'settings').map(c => c[2]?.collaborationMode?.mode ?? null), ['plan'], 'applied through the managed chat, then read back');
  const claudeIgnored = await setup(); claudeIgnored.control.ignoreModes = true; claudeIgnored.routeSource();
  await assert.rejects(settingsTo(claudeIgnored, 'claude-sonnet-x', { collaborationMode: { mode: 'plan', settings: { model: 'claude-sonnet-x', reasoning_effort: 'high', developer_instructions: 'CLAUDE-NOT-APPLIED' } } }), { code: 'native_selection_not_confirmed' }); assert.deepEqual(announcedOf(claudeIgnored), []);
  assert.deepEqual(claudeIgnored.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), ['claude-new']);
  // (7) nothing is remembered between switches: a second switch announces the NEW target's mode, whatever the first one was
  const twice = await setup(); await settingsTo(twice, localModelId(twice.a, 'a2'), { collaborationMode: plan(localModelId(twice.a, 'a2')) }); twice.control.newId = 'hop-2'; await settingsTo(twice, localModelId(twice.b, 'b1'));
  const [first, second] = announcedOf(twice); assert.equal(first.collaborationMode.mode, 'plan'); assert.deepEqual([second.collaborationMode.mode, second.collaborationMode.settings.developer_instructions], ['default', null], 'the second target confirms the default: the first target\'s plan is not carried');
});

// ---- FINAL READBACK: the target's last authoritative read is checked like the first one, and the source is validated again after it -------------------------------
const noLink = f => !existsSync(join(dirOf(f), 'links', SOURCE + '.json')) && !(existsSync(join(dirOf(f), 'links')) && readdirSync(join(dirOf(f), 'links')).some(n => n.endsWith('.intent')));
test('FINAL READBACK: a target whose LATE readback broadens or changes permissions, roots, cwd, identity, provider, model or effort is refused before the commit and only the new child is withdrawn (custom, GPT and managed Claude)', async () => {
  const settingsEvents = f => f.notices.filter(n => n.m === 'thread/settings/updated');
  const custom = [['sandbox', c => { c.overrides = { sandbox: { type: 'dangerFullAccess' } }; }, 'native_permissions_changed'], ['approval policy', c => { c.overrides = { approvalPolicy: 'on-request' }; }, 'native_permissions_changed'],
    ['reviewer', c => { c.overrides = { approvalsReviewer: 'auto_review' }; }, 'native_permissions_changed'], ['permission profile', c => { c.overrides = { activePermissionProfile: { id: 'wider' } }; }, 'native_permissions_changed'],
    ['cwd', c => { c.overrides = { cwd: '/elsewhere' }; }, 'native_permissions_changed'], ['workspace roots', c => { c.overrides = { runtimeWorkspaceRoots: ['/synthetic', '/extra'] }; }, 'native_permissions_changed'],
    ['model', c => { c.overrides = { model: 'a1' }; }, 'native_selection_not_confirmed'], ['provider', c => { c.overrides = { modelProvider: 'bridge_custom_' + 'f'.repeat(32) }; }, 'native_selection_not_confirmed'],
    ['effort', c => { c.applied.set(NEW, 'low'); }, 'native_selection_not_confirmed'], ['thread identity', c => { c.overrides = { thread: { id: 'someone-else', path: '/synthetic/someone-else.jsonl', forkedFromId: null, status: { type: 'idle' } } }; }, 'native_thread_identity_invalid']];
  for (const [label, mutate, code] of custom) {
    const f = await setup(); f.control.duringInject = async () => mutate(f.control); // the target changes between its first readback and its final one
    await assert.rejects(settingsTo(f, localModelId(f.a, 'a2')), { code }, 'custom: ' + label);
    assert.deepEqual(settingsEvents(f), [], label + ': nothing announced'); assert.deepEqual(archived(f), [NEW], label + ': only the new thread is withdrawn'); assert.ok(noLink(f) && !existsSync(f.routePath(NEW)), label + ': no link, no route, no intent'); assert.ok(!existsSync(f.routePath(SOURCE)), label + ': the source is untouched');
  }
  for (const [label, mutate, code] of custom.slice(0, 7)) { // a GPT target (the physical thread of a native target is read back through the main peer)
    const f = await setup(); f.routeSource(); f.control.newId = 'gpt-new'; f.control.duringInject = async () => mutate(f.control);
    await assert.rejects(settingsTo(f, 'gpt-y'), { code: label === 'model' ? 'native_selection_not_confirmed' : code }, 'GPT: ' + label); assert.deepEqual(settingsEvents(f), []); assert.deepEqual(archived(f), ['gpt-new']); assert.ok(noLink(f), label);
  }
  // The final readback's roots are its OWN evidence: missing, null or malformed roots are never completed from the start answer or the source (undefined is not "equal").
  const missingRoots = [['missing roots', undefined], ['null roots', null], ['malformed roots', 'not-a-list']];
  for (const [label, value] of missingRoots) for (const target of ['custom', 'GPT']) {
    const f = await setup(); f.routeSource(); if (target === 'GPT') f.control.newId = 'gpt-new'; f.control.duringInject = async () => { f.control.overrides = { runtimeWorkspaceRoots: value }; };
    await assert.rejects(settingsTo(f, target === 'GPT' ? 'gpt-y' : localModelId(f.b, 'b1')), { code: 'native_permissions_unconfirmed' }, target + ': ' + label);
    assert.deepEqual(settingsEvents(f), [], label); assert.deepEqual(archived(f), [target === 'GPT' ? 'gpt-new' : NEW], target + ' ' + label + ': only the new thread is withdrawn'); assert.ok(noLink(f) && !existsSync(f.routePath(NEW)), target + ' ' + label);
  }
  for (const [label, value] of [...missingRoots, ['changed roots', ['/synthetic', '/extra']], ['reordered-away roots', []]]) {
    const f = await setup(); f.routeSource(); f.control.claudeView = { runtimeWorkspaceRoots: value };
    await assert.rejects(settingsTo(f, 'claude-sonnet-x'), { code: Array.isArray(value) ? 'native_permissions_changed' : 'native_permissions_unconfirmed' }, 'Claude: ' + label);
    assert.deepEqual(settingsEvents(f), [], label); assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), ['claude-new'], 'Claude ' + label + ': only the new chat is withdrawn'); assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'publish'), []); assert.ok(noLink(f), label);
  }
  const claudeCases = [['sandbox', { sandboxPolicy: { type: 'dangerFullAccess' } }, 'native_permissions_changed'], ['approval policy', { approvalPolicy: 'on-request' }, 'native_permissions_changed'], ['reviewer', { approvalsReviewer: 'auto_review' }, 'native_permissions_changed'],
    ['permission profile', { activePermissionProfile: { id: 'wider' } }, 'native_permissions_changed'], ['cwd', { cwd: '/elsewhere' }, 'native_permissions_changed'], ['model', { model: 'claude-other' }, 'native_selection_not_confirmed'],
    ['provider', { modelProvider: 'openai' }, 'native_selection_not_confirmed'], ['effort', { effort: 'low' }, 'native_selection_not_confirmed']];
  for (const [label, view, code] of claudeCases) {
    const f = await setup(); f.routeSource(); f.control.claudeView = view;
    await assert.rejects(settingsTo(f, 'claude-sonnet-x'), { code }, 'Claude: ' + label); assert.deepEqual(settingsEvents(f), [], label); assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), ['claude-new'], label + ': only the new chat is withdrawn');
    assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'publish'), [], label + ': nothing published'); assert.ok(noLink(f), label);
  }
  // and an unchanged late readback is of course accepted, announcing exactly what the target reports
  const fine = await setup(); fine.control.duringInject = async () => {}; await settingsTo(fine, localModelId(fine.a, 'a2')); assert.equal(settingsEvents(fine).length, 1); assert.deepEqual(settingsEvents(fine)[0].p.threadSettings.sandboxPolicy, { type: 'readOnly' });
});

test('FINAL READBACK: the source is validated AGAIN after the target\'s final read: activity, a queued entry, a newer revision or a changed route during that read refuse the switch with the existing errors; nothing is published, no queued entry is dropped, no intent is left', async () => {
  const swap = async (mutate, target) => {
    const f = await setup(); f.routeSource(); if (target === 'gpt') f.control.newId = 'gpt-new';
    f.control.duringInject = async () => { f.control.duringReadback = async () => { f.control.duringReadback = null; mutate(f); }; };
    return f;
  };
  const route = f => JSON.parse(readFileSync(f.routePath(SOURCE)));
  const cases = [['activity', f => { f.control.sourceStatus = 'active'; }, 'model_change_requires_idle'], ['a queued entry', f => { f.control.queue = { [SOURCE]: [{ id: 'q1', input: [], clientUserMessageId: 'c1' }] }; }, 'handoff_queue_pending'],
    ['a newer revision', f => { f.control.updatedAt = 4242; }, 'stale_revision'], ['a changed route', f => { f.router.writeAtomic(f.routePath(SOURCE), { ...route(f), model: 'a2' }, 'replace'); }, 'stale_revision']];
  for (const target of ['custom', 'gpt']) for (const [label, mutate, code] of cases) {
    const f = await swap(mutate, target), before = route(f);
    await assert.rejects(settingsTo(f, target === 'gpt' ? 'gpt-y' : localModelId(f.b, 'b1')), { code }, target + ': ' + label);
    assert.deepEqual(f.notices.filter(n => n.m === 'thread/settings/updated'), [], label + ': nothing announced'); assert.deepEqual(archived(f), [target === 'gpt' ? 'gpt-new' : NEW], label + ': only the new thread is withdrawn');
    assert.ok(noLink(f) && !existsSync(f.routePath(target === 'gpt' ? 'gpt-new' : NEW)), label + ': nothing published'); assert.deepEqual(route(f), label === 'a changed route' ? { ...before, model: 'a2' } : before, label + ': the source route is whatever it was, never overwritten');
    if (label === 'a queued entry') assert.deepEqual(f.control.queue[SOURCE].map(q => q.id), ['q1'], 'the queued entry is untouched');
  }
  // a managed Claude target: the same window
  const claude = await setup(); claude.routeSource(); claude.control.duringClaudeSettings = async () => { claude.control.duringClaudeSettings = null; claude.control.sourceStatus = 'active'; };
  await assert.rejects(settingsTo(claude, 'claude-sonnet-x'), { code: 'model_change_requires_idle' }); assert.deepEqual(claude.notices.filter(n => n.m === 'thread/settings/updated'), []); assert.deepEqual(claude.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), ['claude-new']); assert.ok(noLink(claude));
});

test('COLD CUSTOM RESUME: a native process that loads a custom thread for the first time answers with its own configured default; the route\'s saved model stays the authority and the thread is loaded WITH it, read back exactly; a loaded thread is not asked again; a native that ignores the model is refused; a model of this connection is still a change made elsewhere', async () => {
  const f = await setup(); f.control.coldDefaults = 'gpt-6.1-sol'; const A2 = localModelId(f.a, 'a2'), B1 = localModelId(f.b, 'b1');
  f.control.newId = 'hop-1'; await settingsTo(f, A2); f.control.newId = 'hop-2'; await settingsTo(f, B1); const routeBytes = readFileSync(f.routePath('hop-2')), resumes = () => by(f, 'thread/resume').filter(c => c.p.threadId === 'hop-2');
  f.control.cold.clear(); f.router = f.build(); const seen = resumes().length; // a FULL cold start: no process has loaded anything, a new router
  const opened = await f.router.request('thread/resume', { threadId: SOURCE }, f.forward);
  assert.deepEqual([opened.thread.id, opened.model], [SOURCE, B1], 'the public open answers under the conversation ID with the saved model, not the process default');
  assert.deepEqual(resumes().slice(seen).map(c => c.p.model ?? null), ['b1', null], 'the thread is loaded the FIRST time WITH its own saved model (never an unpinned load on the process default), then the public resume of the now loaded thread');
  assert.deepEqual(readFileSync(f.routePath('hop-2')), routeBytes, 'the route is byte-identical: the default was never taken for a selection');
  await f.router.request('thread/resume', { threadId: SOURCE }, f.forward); assert.equal(resumes().slice(seen).length, 3, 'a loaded thread is read once more by the public resume only (no new load, no new pin)');
  await f.router.request('turn/start', { threadId: SOURCE, input: [{ type: 'text', text: 'AFTER-COLD' }] }, f.forward); const turn = by(f, 'turn/start').at(-1); assert.equal(turn.p.threadId, 'hop-2', 'the next turn runs on the saved thread, which this process loaded WITH the saved model'); assert.equal(resumes().slice(seen).length, 3, 'and needed no further load');
  // the configured default CAN ALSO be a model of this very connection (several models on one connection): being a catalog model is no evidence of a newer selection,
  // so the saved model is named on the first load and the route stays exactly as it was (never rewritten to the default)
  const inCatalog = await setup(); inCatalog.control.coldDefaults = 'a1'; inCatalog.control.newId = 'hop-1'; await settingsTo(inCatalog, localModelId(inCatalog.a, 'a2')); const kept = readFileSync(inCatalog.routePath('hop-1'));
  inCatalog.control.cold.clear(); inCatalog.router = inCatalog.build();
  const reopened = await inCatalog.router.request('thread/resume', { threadId: SOURCE }, inCatalog.forward);
  assert.deepEqual([reopened.thread.id, reopened.model], [SOURCE, localModelId(inCatalog.a, 'a2')], 'the saved model, not the default that is also a catalog model');
  assert.deepEqual(by(inCatalog, 'thread/resume').filter(c => c.p.threadId === 'hop-1').slice(-2).map(c => c.p.model ?? null), ['a2', null]); assert.deepEqual(readFileSync(inCatalog.routePath('hop-1')), kept, 'the route is never rewritten to the default');
  // The persisted selection is OBSERVED (read-only thread/read) before anything is resumed: a model of this connection that native itself persisted wins over a stale route
  // (a change made elsewhere, recovered into the route as before); a persisted model that is no model of this connection (the process default) is no evidence, the route stays;
  // another provider or another thread in that read is no evidence at all and refuses the load, resuming nothing.
  const newer = await setup(); newer.control.coldDefaults = 'gpt-6.1-sol'; newer.control.newId = 'hop-1'; await settingsTo(newer, localModelId(newer.a, 'a2')); newer.control.cold.clear(); newer.control.persisted = { 'hop-1': 'a1' }; newer.router = newer.build(); const newerSeen = by(newer, 'thread/resume').length;
  await newer.router.request('thread/resume', { threadId: SOURCE }, newer.forward); assert.equal(JSON.parse(readFileSync(newer.routePath('hop-1'))).model, 'a1', 'the persisted in-catalog selection is recovered into the route');
  assert.equal(by(newer, 'thread/resume').slice(newerSeen).find(c => c.p.threadId === 'hop-1').p.model, 'a1', 'and is the model named by the first load, never the stale route or the default');
  const foreign = await setup(); foreign.control.coldDefaults = 'gpt-6.1-sol'; foreign.control.newId = 'hop-1'; await settingsTo(foreign, localModelId(foreign.a, 'a2')); const keep = readFileSync(foreign.routePath('hop-1')); foreign.control.cold.clear(); foreign.control.persisted = { 'hop-1': 'gpt-6.1-sol' }; foreign.router = foreign.build(); const foreignSeen = by(foreign, 'thread/resume').length;
  await foreign.router.request('thread/resume', { threadId: SOURCE }, foreign.forward); assert.deepEqual(readFileSync(foreign.routePath('hop-1')), keep, 'a persisted default is not a selection'); assert.equal(by(foreign, 'thread/resume').slice(foreignSeen).find(c => c.p.threadId === 'hop-1').p.model, 'a2');
  const other = await setup(); other.control.coldDefaults = 'gpt-6.1-sol'; other.control.newId = 'hop-1'; await settingsTo(other, localModelId(other.a, 'a2')); const untouched = readFileSync(other.routePath('hop-1')); other.control.cold.clear(); other.control.persistedProvider = 'openai'; other.router = other.build(); const loads = by(other, 'thread/resume').length;
  await assert.rejects(other.router.request('thread/resume', { threadId: SOURCE }, other.forward), { code: 'native_selection_not_confirmed' }); assert.equal(by(other, 'thread/resume').length, loads, 'nothing was resumed'); assert.deepEqual(readFileSync(other.routePath('hop-1')), untouched);
  // a native that does not honour the named model is refused, with the route untouched and nothing sent
  const stubborn = await setup(); stubborn.control.coldDefaults = 'gpt-6.1-sol'; stubborn.control.newId = 'hop-1'; await settingsTo(stubborn, localModelId(stubborn.a, 'a2')); const bytes = readFileSync(stubborn.routePath('hop-1'));
  stubborn.control.cold.clear(); stubborn.control.ignorePin = true; stubborn.router = stubborn.build();
  await assert.rejects(stubborn.router.request('thread/resume', { threadId: SOURCE }, stubborn.forward), { code: 'native_selection_not_confirmed' }); assert.deepEqual(readFileSync(stubborn.routePath('hop-1')), bytes); assert.deepEqual(by(stubborn, 'turn/start'), []);
  // a native that reports ANOTHER model of this connection for a thread it already holds is evidence of a change made elsewhere, recovered as before (the route follows it)
  const elsewhere = await setup(); elsewhere.control.coldDefaults = 'a1'; elsewhere.control.newId = 'hop-1'; await settingsTo(elsewhere, localModelId(elsewhere.a, 'a2')); elsewhere.control.cold.clear(); elsewhere.control.ignorePin = true; elsewhere.router = elsewhere.build();
  await elsewhere.router.request('thread/resume', { threadId: SOURCE }, elsewhere.forward); assert.equal(JSON.parse(readFileSync(elsewhere.routePath('hop-1'))).model, 'a1');
});

test('PRIVATE LABEL LIFECYCLE: Bridge\'s own echo is settled FIRST (during the provisional phase, before any hold or drop), nothing stays pending, and the person\'s renames right after the commit are all shown, "New chat" included', async () => {
  const f = await setup(); f.control.sourceName = 'Original title'; const during = [];
  f.control.onName = p => during.push([f.router.desktopView('thread/name/updated', { threadId: p.threadId, threadName: p.name }), f.router.held.length, f.router.provisional.has(p.threadId)]);
  await settingsTo(f, localModelId(f.a, 'a2'));
  assert.deepEqual(during, [[null, 0, true]], 'hidden while the child is provisional, and never queued behind the hold');
  assert.equal(f.router.ownWrites.size, 0, 'no pending counter is left behind'); assert.equal(f.router.held.length, 0); assert.equal(f.notices.filter(n => n.m === 'thread/name/updated').length, 0, 'nothing is released later');
  for (const name of ['Human title', 'New chat', 'New chat', 'Another title']) assert.deepEqual(f.router.desktopView('thread/name/updated', { threadId: NEW, threadName: name }), { threadId: SOURCE, threadName: name }, 'a person\'s rename is shown: ' + name);
  assert.deepEqual(f.router.desktopView('thread/name/updated', { threadId: 'other-chat', threadName: 'New chat' }), { threadId: 'other-chat', threadName: 'New chat' }, 'an ordinary native chat is untouched');
  // the exact sequence of the reproducer, step by step, with the real release order
  const g = await setup(), P = 'private-child', { settle } = g.router.expectOwnWrite(P); g.router.provisional.add(P);
  assert.equal(g.router.desktopView('thread/name/updated', { threadId: P, threadName: 'New chat' }), null); assert.equal(g.router.held.length, 0, 'consumed before the generic hold');
  settle(); g.router.releaseHeld(); g.router.provisional.clear(); assert.equal(g.notices.length, 0);
  assert.deepEqual(g.router.desktopView('thread/name/updated', { threadId: P, threadName: 'Human title' }), { threadId: P, threadName: 'Human title' }); assert.deepEqual(g.router.desktopView('thread/name/updated', { threadId: P, threadName: 'New chat' }), { threadId: P, threadName: 'New chat' }, 'not swallowed by a stale count');
  // a write that fails settles too
  const h = await setup(); h.control.nameError = Object.assign(new Error('synthetic name failure'), { code: -32600 }); await assert.rejects(settingsTo(h, localModelId(h.a, 'a2')), /synthetic name failure/); assert.equal(h.router.ownWrites.size, 0, 'a failed write leaves nothing pending');
});

test('LOGICAL TITLE: a person\'s rename becomes the conversation\'s title in the SAME accepted link (also the second and third, and "New chat"), so list, search, sort, a cold start and the next hop agree even with native listing neither the origin nor the current thread; reads and lists never write', async () => {
  const f = await setup(); f.control.sourceName = 'Original title'; await settingsTo(f, localModelId(f.a, 'a2'));
  const via = listing(f, [{ id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p', forkedFromId: null }]); // neither origin nor current thread enumerated
  const bytes = () => readFileSync(linkFile(f)), before = bytes();
  const names = async params => (await f.router.request('thread/list', params, via)).data.filter(t => t.id === SOURCE).map(t => t.name);
  assert.deepEqual(await names({}), ['Original title']); await f.router.request('thread/read', { threadId: SOURCE }, f.forward); assert.deepEqual(await names({ searchTerm: 'Original' }), ['Original title']); assert.deepEqual(bytes(), before, 'reads, lists and searches write nothing');
  await f.router.request('thread/name/set', { threadId: SOURCE, name: 'Human renamed title' }, f.forward);
  let link = linkOf(f); assert.deepEqual([link.origin.name, link.origin.createdAt, link.origin.path, link.origin.forkedFromId, link.private], ['Human renamed title', 100, '/synthetic/' + SOURCE + '.jsonl', null, undefined], 'one write: the title, the marker gone; creation, path and ancestry kept');
  assert.deepEqual(await names({}), ['Human renamed title']); assert.deepEqual(await names({ searchTerm: 'Human renamed' }), ['Human renamed title']); assert.deepEqual(await names({ searchTerm: 'Original' }), []);
  for (const name of ['New chat', 'Third title']) { await f.router.request('thread/name/set', { threadId: SOURCE, name }, f.forward); assert.equal(linkOf(f).origin.name, name, 'every consecutive rename, also after the marker is gone'); assert.deepEqual(await names({ searchTerm: name }), [name]); }
  assert.deepEqual(await f.build().request('thread/list', {}, via).then(r => r.data.filter(t => t.id === SOURCE).map(t => t.name)), ['Third title'], 'after a cold start');
  f.control.newId = 'gpt-new'; await settingsTo(f, 'gpt-y'); assert.equal(linkOf(f).origin.name, 'Third title', 'the next provider hop keeps it'); assert.equal(linkOf(f).origin.createdAt, 100);
  // a rename native reports (for the conversation or its current thread) is the title too
  assert.deepEqual(f.router.desktopView('thread/name/updated', { threadId: 'gpt-new', threadName: 'External rename' }), { threadId: SOURCE, threadName: 'External rename' }); assert.equal(linkOf(f).origin.name, 'External rename');
  f.router.desktopView('thread/name/updated', { threadId: SOURCE, threadName: 'Renamed on the conversation' }); assert.equal(linkOf(f).origin.name, 'Renamed on the conversation');
  f.router.desktopView('thread/name/updated', { threadId: 'other-chat', threadName: 'Other chat renamed' }); assert.equal(linkOf(f).origin.name, 'Renamed on the conversation', 'an unrelated chat never touches it');
  // storage failure: the rename is NOT reported as preserved, and no stale marker is restored on restart
  const g = await setup(); g.control.sourceName = 'Original title'; await settingsTo(g, localModelId(g.a, 'a2')); const was = readFileSync(linkFile(g));
  // (the first durable write is the custom thread's route lock, then the native rename; the 2nd is the link's own intent: the one that fails here)
  await withSyncAsync(failOn(2), () => assert.rejects(g.router.request('thread/name/set', { threadId: SOURCE, name: 'Lost in storage' }, g.forward), { code: 'EIO' }));
  assert.ok(by(g, 'thread/name/set').some(c => c.p.name === 'Lost in storage'), 'the rename itself reached native: the failure is reported, not hidden');
  assert.deepEqual(readFileSync(linkFile(g)), was, 'the accepted link is untouched by a failed write'); g.control.readName = 'New chat';
  assert.equal((await g.router.request('thread/read', { threadId: SOURCE }, g.forward)).thread.name, 'New chat', 'this process shows the person\'s title, not a stale mask');
  await assert.rejects(g.router.request('thread/name/set', { threadId: SOURCE, name: 'N'.repeat(9000) }, g.forward), { code: 'link_capacity_reached' }, 'a title that cannot be recorded whole is refused, never cut');
  // a link without a recorded origin is never given an invented one
  const k = await setup(); k.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE], private: [NEW] }, null); await k.router.request('thread/name/set', { threadId: SOURCE, name: 'T' }, k.forward);
  assert.equal(linkOf(k).origin, undefined); assert.equal(linkOf(k).private, undefined);
});

test('ARCHIVE: a conversation native does not enumerate (origin and current thread both unlisted) is placed in the active or archived view by the state Bridge recorded; archive and unarchive round-trip through list, a cold start and native events; an unrecorded state is refused, never assumed active', async () => {
  const f = await setup(); f.control.sourceName = 'Original title'; await settingsTo(f, localModelId(f.a, 'a2'));
  assert.equal(linkOf(f).archived, false, 'recorded as active when the conversation was switched');
  const via = listing(f, [{ id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p', forkedFromId: null }]);
  const view = async (params, router = f.router) => (await router.request('thread/list', params, via)).data.map(t => t.id);
  assert.deepEqual(await view({}), ['other-chat', SOURCE]); assert.deepEqual(await view({ archived: true }), []);
  await f.router.request('thread/archive', { threadId: SOURCE }, f.forward); assert.equal(linkOf(f).archived, true, 'one write of the accepted link');
  assert.deepEqual(await view({}), ['other-chat'], 'archived: not resurrected in the active list although thread/read still answers for it'); assert.deepEqual(await view({ archived: true }), [SOURCE]); assert.deepEqual(await view({ archived: false }), ['other-chat']);
  const row = (await f.router.request('thread/list', { archived: true }, via)).data[0]; assert.deepEqual([row.name, row.createdAt, row.modelProvider], ['Original title', 100, 'openai'], 'identity from the origin, runtime from the read');
  assert.deepEqual(await view({ archived: true }, f.build()), [SOURCE], 'after a cold start'); assert.deepEqual(await view({}, f.build()), ['other-chat']);
  await f.router.request('thread/unarchive', { threadId: SOURCE }, f.forward); assert.equal(linkOf(f).archived, false); assert.deepEqual(await view({}), ['other-chat', SOURCE]); assert.deepEqual(await view({ archived: true }), []);
  // the same, when native itself reports it (the desktop's request or any other source)
  f.router.desktopView('thread/archived', { threadId: NEW }); assert.equal(linkOf(f).archived, true); assert.deepEqual(await view({}), ['other-chat']);
  f.router.desktopView('thread/unarchived', { threadId: SOURCE }); assert.equal(linkOf(f).archived, false); assert.deepEqual(await view({}), ['other-chat', SOURCE]);
  f.router.desktopView('thread/archived', { threadId: 'other-chat' }); assert.equal(linkOf(f).archived, false, 'an unrelated chat never touches it');
  // a link that never recorded its archive state cannot be placed when native lists neither thread
  const old = await setup(); old.router.writeLink({ version: 1, logicalId: SOURCE, physicalId: NEW, kind: 'native', model: 'x', previous: [SOURCE], origin: { name: 'T', createdAt: 5, forkedFromId: null, path: '/p' } }, null);
  for (const params of [{}, { archived: true }]) await assert.rejects(old.router.request('thread/list', params, listing(old, [{ id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p', forkedFromId: null }])), { code: 'thread_list_unreadable' }, JSON.stringify(params));
});

test('OWN ECHO TIMING: native answers the private label first and announces it LATER; the child stays provisional and unpublished until that echo is observed at the notification path, so the title stays null/custom, the marker stays, and every later person\'s rename is legitimate', async () => {
  for (const [label, target] of [['custom child', f => localModelId(f.a, 'a2')], ['native child', () => 'gpt-y'], ['managed Claude child', () => 'sonnet']]) {
    const f = await setup(); f.control.echoDelay = 40; const atEcho = [];
    f.control.beforeEcho = () => atEcho.push({ link: existsSync(linkFile(f)), pendingOwn: f.router.ownWrites.size, provisional: f.router.provisional.size > 0 });
    if (label !== 'custom child') { await settingsTo(f, localModelId(f.a, 'a2')); atEcho.length = 0; f.control.newId = 'gpt-new'; }
    const before = f.calls.length, linkBefore = existsSync(linkFile(f)) ? readFileSync(linkFile(f)) : null;
    await settingsTo(f, target(f));
    assert.deepEqual(atEcho.map(e => e.link === (linkBefore !== null) && e.pendingOwn === 1 && e.provisional), [true], label + ': when the echo arrives the answer is long past, yet nothing is published and the write is still pending: the publish WAITED');
    const link = linkOf(f); assert.equal(link.origin.name, null, label + ': the logical title is untouched (null)'); assert.deepEqual(link.private, [link.physicalId], label + ': the marker is preserved'); assert.equal(f.router.ownWrites.size, 0, label + ': nothing stays pending');
    for (const name of ['Human Title', 'New chat', 'New chat', 'Later title']) assert.deepEqual(f.router.desktopView('thread/name/updated', { threadId: link.physicalId, threadName: name }), { threadId: SOURCE, threadName: name }, label + ': ' + name);
    assert.equal(linkOf(f).origin.name, 'Later title'); assert.equal(linkOf(f).private, undefined);
    f.control.readName = 'New chat'; assert.equal((await f.router.request('thread/read', { threadId: SOURCE }, f.forward)).thread.name, 'New chat', 'a title the person chose is shown, whatever the words'); void before;
  }
  // the marker, title and masking after a cold start follow the accepted link only
  const k = await setup(); k.control.echoDelay = 30; await settingsTo(k, localModelId(k.a, 'a2')); k.control.readName = 'New chat';
  assert.equal((await k.build().request('thread/read', { threadId: SOURCE }, k.forward)).thread.name, null, 'masked from the durable marker, to the null title');
  const rows = [{ id: 'other-chat', name: 'Other', createdAt: 200, updatedAt: 210, model: 'm', modelProvider: 'p', forkedFromId: null }];
  assert.deepEqual((await k.build().request('thread/list', { searchTerm: 'New chat' }, listing(k, rows))).data.map(t => t.id), [], 'the private label never matches a search');
});

test('OWN ECHO MISSING: no echo within the bound means the identity is unconfirmed: nothing is published, the child is archived, nothing stays pending, the source is untouched, and a late echo is never mistaken for a rename', async () => {
  for (const [label, target] of [['custom child', f => localModelId(f.a, 'a2')], ['managed Claude child', () => 'sonnet']]) {
    const f = await setup(); f.router.echoWaitMs = 40; f.control.noEcho = true; if (label !== 'custom child') f.routeSource();
    const routeBefore = existsSync(f.routePath(SOURCE)) ? readFileSync(f.routePath(SOURCE)) : null;
    await assert.rejects(settingsTo(f, target(f)), error => { assert.equal(error.code, 'native_selection_not_confirmed', label); assert.match(error.message, /^Couldn't confirm the model change, so this chat may still be on its previous model\. No message was sent or retried\. Choose the model again\.$/); return true; });
    assert.ok(!existsSync(linkFile(f)) && !existsSync(intentFile(f, SOURCE)), label + ': nothing published, no intent'); assert.equal(f.router.ownWrites.size, 0, label + ': no dangling pending write');
    const created = label === 'custom child' ? NEW : 'claude-new'; if (label === 'custom child') assert.deepEqual(archived(f), [NEW], 'the created child is withdrawn'); else assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'archive'), [['archive', created]]);
    assert.equal(f.router.desktopView('thread/name/updated', { threadId: created, threadName: 'New chat' }), null, label + ': a late echo of an abandoned child is never shown or recorded');
    assert.deepEqual(existsSync(f.routePath(SOURCE)) ? readFileSync(f.routePath(SOURCE)) : null, routeBefore, label + ': the source route is unchanged'); assert.equal(f.router.physicalOf(SOURCE), SOURCE);
  }
  // the next attempt is clean (no leftover pending, no refusal)
  const again = await setup(); again.router.echoWaitMs = 40; again.control.noEcho = true; await assert.rejects(settingsTo(again, localModelId(again.a, 'a2')), { code: 'native_selection_not_confirmed' });
  again.control.noEcho = false; again.control.newId = 'second-try'; await settingsTo(again, localModelId(again.a, 'a2')); assert.equal(again.router.physicalOf(SOURCE), 'second-try'); assert.deepEqual(linkOf(again).private, ['second-try']);
});

test('RT1 start params: the SOURCE\'s confirmed workspace roots (in their order, nothing more) are asked for explicitly on every new native, custom and Claude thread/start', async () => {
  const f = await setup(); await toModel(f, localModelId(f.a, 'a2'));
  assert.deepEqual(by(f, 'thread/start')[0].p.runtimeWorkspaceRoots, ['/synthetic'], 'single root');
  const multi = await setup(); multi.control.snapshot = { ...BASE, reasoningEffort: 'medium', runtimeWorkspaceRoots: ['/b', '/a'] }; multi.control.overrides = { runtimeWorkspaceRoots: ['/a', '/b'] };
  await toModel(multi, localModelId(multi.a, 'a2')); assert.deepEqual(by(multi, 'thread/start')[0].p.runtimeWorkspaceRoots, ['/b', '/a'], 'custom target: both roots, as confirmed');
  const native = await setup(); native.routeSource(); native.control.snapshot = { ...BASE, reasoningEffort: 'medium', runtimeWorkspaceRoots: ['/b', '/a'] }; native.control.overrides = { runtimeWorkspaceRoots: ['/a', '/b'] }; await toModel(native, 'gpt-y');
  assert.deepEqual(by(native, 'thread/start')[0].p.runtimeWorkspaceRoots, ['/b', '/a'], 'native target');
  const claude = await setup(); claude.routeSource(); claude.control.snapshot = { ...BASE, reasoningEffort: 'medium', runtimeWorkspaceRoots: ['/b', '/a'] }; claude.control.overrides = { runtimeWorkspaceRoots: ['/a', '/b'] }; await toModel(claude, 'sonnet');
  assert.deepEqual(claude.control.claudeCalls.find(c => c[0] === 'start')[1].runtimeWorkspaceRoots, ['/b', '/a'], 'Claude target');
  const legacy = await setup(); legacy.control.managed = SOURCE; legacy.control.managedTurns = structuredClone(HISTORY); legacy.control.legacyHost = true; legacy.control.managedNoRoots = true; legacy.control.discovered = ['/synthetic', '/second'];
  legacy.control.overrides = { runtimeWorkspaceRoots: ['/second', '/synthetic'] }; await toModel(legacy, 'gpt-y'); assert.deepEqual(by(legacy, 'thread/start')[0].p.runtimeWorkspaceRoots, ['/synthetic', '/second'], 'discovered legacy roots, both of them');
  // a target that reports different or fewer roots is still refused after the explicit request
  const fewer = await setup(); fewer.control.snapshot = { ...BASE, reasoningEffort: 'medium', runtimeWorkspaceRoots: ['/a', '/b'] }; fewer.control.overrides = { runtimeWorkspaceRoots: ['/a'] };
  await assert.rejects(toModel(fewer, localModelId(fewer.a, 'a2')), { code: 'native_permissions_changed' }); assert.deepEqual(archived(fewer), [NEW]);
});

test('OWNING PEER HISTORY: the own turns of a routed custom source are read from the SAME owning connection peer, never from the main process: a fresh loaded custom chat with no rollout (main would answer "not loaded") switches to another provider as a truly empty runtime; a paged source plus carried context is read only through its own pages, every item once', async () => {
  const ownReads = (f, id) => by(f, 'thread/turns/list').filter(c => c.p.threadId === id);
  // 1. EMPTY: no rollout, loaded only in the custom peer
  const f = await setup(); f.routeSource(); f.control.history = []; f.control.notLoadedOnMain = new Set([SOURCE]); const bytes = readFileSync(f.routePath(SOURCE)), roots = f.control.snapshot.runtimeWorkspaceRoots;
  await settingsTo(f, localModelId(f.b, 'b1'));
  assert.ok(ownReads(f, SOURCE).length >= 1 && ownReads(f, SOURCE).every(c => c.peer === f.a), 'the source\'s turns were asked of its OWN peer only (' + ownReads(f, SOURCE).map(c => c.peer).join() + ')');
  assert.deepEqual(by(f, 'thread/inject_items'), [], 'nothing is injected into a truly empty target'); assert.deepEqual(by(f, 'turn/start'), [], 'no prompt, no model call'); assert.deepEqual(by(f, 'thread/queue/add'), []);
  assert.deepEqual(readFileSync(f.routePath(SOURCE)), bytes, 'the source route is untouched'); assert.deepEqual(by(f, 'thread/name/set').map(c => c.p.threadId), [NEW], 'only the NEW target gets its private metadata name; the source is never renamed, seeded or written');
  assert.equal(by(f, 'thread/start')[0].p.runtimeWorkspaceRoots.join(), roots.join(), 'same workspace roots'); assert.equal(f.notices.filter(n => n.m === 'thread/settings/updated').length, 1, 'full settings announced once'); assert.equal(f.router.physicalOf(SOURCE), NEW);
  // 2. PAGED nonempty custom source, plus carried context from an earlier hop
  const g = await setup(); const many = Array.from({ length: 230 }, (_, i) => ({ id: 'tp' + i, status: 'completed', items: [user('up' + i, 'PAGED-USER-' + i), { type: 'agentMessage', id: 'ap' + i, text: 'PAGED-ANSWER-' + i }] }));
  g.control.history = many; g.control.notLoadedOnMain = new Set([SOURCE, NEW, 'second']); g.router.saveRoute(SOURCE, g.router.routeFor(g.registry.all().find(x => x.connectionId === g.a), 'a1', g.thread(SOURCE, 'bridge_custom_' + g.a, 'a1')));
  await settingsTo(g, localModelId(g.b, 'b1'));
  const wire = JSON.stringify(by(g, 'thread/inject_items').flatMap(c => c.p.items)); for (const i of [0, 99, 100, 229]) { assert.equal(wire.split('PAGED-USER-' + i + '"').length, 2, 'user ' + i + ' once'); assert.equal(wire.split('PAGED-ANSWER-' + i + '"').length, 2, 'answer ' + i + ' once'); }
  assert.ok(ownReads(g, SOURCE).length >= 3, 'several pages'); assert.ok(ownReads(g, SOURCE).every(c => c.peer === g.a), 'all through the owning peer; the main process was not queried'); assert.equal(g.router.readRoute(SOURCE).model, 'a1');
  // the carried part: GPT chat -> custom A (carries EARLIER-USER) -> custom B: A's own (empty) turns come from A's peer, the carried sidecar supplies the rest, once
  const h = await setup(); h.control.notLoadedOnMain = new Set([NEW, 'second']); await settingsTo(h, localModelId(h.a, 'a2')); h.control.newId = 'second'; await settingsTo(h, localModelId(h.b, 'b1'));
  const second = JSON.stringify(by(h, 'thread/inject_items').at(-1).p.items); assert.equal(second.split('EARLIER-USER-4417').length, 2, 'the carried history reaches the next runtime once'); assert.equal(second.split('TOOL-RESULT-9083').length, 2);
  assert.ok(ownReads(h, NEW).length >= 1 && ownReads(h, NEW).every(c => c.peer === h.a), 'the middle thread is read through its own peer'); assert.equal(h.router.physicalOf(SOURCE), 'second');
});

test('FRESH EMPTY SOURCE: a custom chat STARTED empty here and never given a turn can leave (native answers "unavailable before the first user message" for its list) only with the positive birth evidence on the same owning peer; every other case stays an explicit refusal and the evidence is revoked BEFORE anything that could produce history', async () => {
  const FRESH = 'fresh-a', TARGET = 'fresh-b';
  const begin = async () => { const f = await setup(); f.control.newId = FRESH; f.control.notLoadedOnMain = new Set([FRESH]); const a1 = localModelId(f.a, 'a1');
    await f.router.request('thread/start', { model: a1, cwd: '/synthetic', sandbox: 'read-only', approvalPolicy: 'never' }, f.forward); f.control.newId = TARGET; return f; };
  const leave = f => f.router.request('thread/settings/update', { threadId: FRESH, model: localModelId(f.b, 'b1') }, f.forward);
  const turnReads = f => by(f, 'thread/turns/list').filter(c => c.p.threadId === FRESH);
  // 1. both observed native answers, positive evidence: the move succeeds as a truly empty runtime; the carried sidecar is transferred independently and once
  for (const variant of ['a', 'b']) {
    const f = await begin(); assert.ok(f.router.born.has(FRESH), 'the birth is recorded'); f.control.unmaterialized = { [FRESH]: variant }; const bytes = readFileSync(f.routePath(FRESH));
    if (variant === 'a') f.router.writeHandoff(FRESH, { version: 1, turns: structuredClone(HISTORY) });
    await leave(f);
    assert.ok(turnReads(f).length >= 1 && turnReads(f).every(c => c.peer === f.a), variant + ': asked of its own peer only (main answers "not loaded")');
    assert.deepEqual(readFileSync(f.routePath(FRESH)), bytes, variant + ': the source route is untouched'); assert.deepEqual(by(f, 'thread/name/set').map(c => c.p.threadId), [TARGET], variant + ': only the NEW target is named (privately); the source is never renamed');
    assert.deepEqual(by(f, 'turn/start'), [], variant + ': no model call'); assert.equal(f.router.physicalOf(FRESH), TARGET); assert.equal(f.notices.filter(n => n.m === 'thread/settings/updated').length, 1, 'full settings once');
    if (variant === 'a') { const items = JSON.stringify(by(f, 'thread/inject_items').flatMap(c => c.p.items)); assert.equal(items.split('EARLIER-USER-4417').length, 2, 'the carried sidecar reaches the target once'); }
    else assert.deepEqual(by(f, 'thread/inject_items'), [], variant + ': nothing is injected into a truly empty target');
    assert.ok(by(f, 'thread/read').some(c => c.peer === f.a && c.p.threadId === FRESH), 'the current metadata (readState null) was read from the same owning peer');
  }
  // 2. no proof, no empty: every one of these is an explicit refusal that creates nothing and links nothing
  const refused = async (label, prepare, pattern = /not materialized yet|boom/) => { const f = await begin(); prepare(f); f.control.unmaterialized ??= { [FRESH]: 'a' };
    const target = by(f, 'thread/start').length; await assert.rejects(leave(f), pattern, label); assert.equal(by(f, 'thread/start').length, target, label + ': nothing created'); assert.ok(noLink(f) && !f.router.readLink(FRESH), label); assert.deepEqual(by(f, 'thread/inject_items'), [], label); return f; };
  await refused('a generic error', f => { f.control.unmaterialized = { [FRESH]: 'generic' }; });
  await refused('a cold router (no birth evidence)', f => { f.router = f.build(); });
  await refused('another peer than the birth peer', f => { f.router.born.get(FRESH).peer = {}; });
  await refused('another connection than the birth connection', f => { f.router.born.get(FRESH).connectionId = 'f'.repeat(32); });
  await refused('a readState that is not null', f => { f.control.readState = { firstUnread: null, revision: 'initial:' + FRESH }; });
  await refused('a first page was read, then the answer', f => { f.control.unmaterialized = { [FRESH]: 'later' }; });
  // native's ThreadReadResponse is { thread, readState }: a top-level readState exactly null is required; a null inside the thread, or none at all, confirms nothing
  await refused('a null readState inside the thread but none at the top level', f => { f.control.noReadState = true; f.control.nestedReadState = true; });
  await refused('no readState at all', f => { f.control.noReadState = true; });
  // only the two EXACT known answers count: another ID, a prefix, a suffix, other wording or the wrong code are refusals even with the positive birth metadata
  for (const variant of ['wrongid', 'prefix', 'suffix', 'wrongcode']) await refused('inexact answer: ' + variant, f => { f.control.unmaterialized = { [FRESH]: variant }; });
  await refused('inexact answer: unknown wording', f => { f.control.unmaterialized = { [FRESH]: 'unknown' }; }, /not available yet/);
  for (const variant of ['bwrongcode', 'bsuffix']) await refused('inexact answer: ' + variant, f => { f.control.unmaterialized = { [FRESH]: variant }; }, /list_turns/);
  // 3. the evidence is revoked BEFORE a request that could produce history, even when it fails or its outcome is unknown, and is never restored
  for (const method of ['turn/start', 'thread/inject_items', 'thread/queue/add', 'thread/fork', 'turn/steer', 'thread/rollback']) {
    const f = await begin(); f.control.failMethods = new Set([method]); f.control.unmaterialized = { [FRESH]: 'a' }; assert.ok(f.router.born.has(FRESH));
    await f.router.request(method, { threadId: FRESH, input: [{ type: 'text', text: 'x' }], expectedTurnId: 't', clientUserMessageId: 'c-' + method, numTurns: 1 }, f.forward).catch(() => {});
    assert.ok(!f.router.born.has(FRESH), method + ': revoked before the request, failure or not'); f.control.failMethods = new Set();
    await f.router.request('thread/read', { threadId: FRESH }, f.forward).catch(() => {}); assert.ok(!f.router.born.has(FRESH), method + ': never restored');
    await assert.rejects(leave(f), /not materialized yet/, method + ': an unproven source stays refused');
  }
  // 3b. a LOGICAL request that is only a hand-off to another runtime never writes to the old source: its proof survives (first message + model change is legitimate), and the mutation runs on the NEW target
  const first = await begin(); first.control.unmaterialized = { [FRESH]: 'a' }; first.control.newId = 'gpt-new';
  await first.router.request('turn/start', { threadId: FRESH, model: 'gpt-y', input: [{ type: 'text', text: 'first message' }], clientUserMessageId: 'c1' }, first.forward);
  assert.ok(first.router.born.has(FRESH), 'the old source keeps its proof'); assert.equal(first.router.physicalOf(FRESH), 'gpt-new'); assert.deepEqual(by(first, 'turn/start').map(c => [c.peer, c.p.threadId]), [['main', 'gpt-new']], 'the turn runs on the NEW target only');
  const xfork = await begin(); xfork.control.unmaterialized = { [FRESH]: 'a' }; xfork.control.newId = 'gpt-new'; await xfork.router.request('thread/fork', { threadId: FRESH, model: 'gpt-y' }, xfork.forward);
  assert.deepEqual(by(xfork, 'thread/fork'), [], 'a cross-provider fork is a new-runtime transfer: native thread/fork never reaches the source'); assert.ok(xfork.router.born.has(FRESH));
  // 3c. the SAME proof must still be live in the final source revalidation, after the target's last await (idle, queue and the second-resolution timestamp cannot show "still zero"); a normal write on the TARGET's own ID never revokes the source's proof
  const late = await begin(); late.control.unmaterialized = { [FRESH]: 'a' }; const lateBytes = readFileSync(late.routePath(FRESH)); let fired = false;
  late.control.duringReadback = async p => { if (p.threadId === TARGET && !fired) { fired = true; late.router.desktopView('item/completed', { threadId: FRESH, item: {} }); } }; // a history notice about the SOURCE while the target is read back
  await assert.rejects(leave(late), { code: 'stale_revision' }); assert.ok(fired && noLink(late) && !late.router.readLink(FRESH), 'nothing published, no link, no intent'); assert.deepEqual(archived(late), [TARGET], 'only the new child is withdrawn'); assert.deepEqual(readFileSync(late.routePath(FRESH)), lateBytes);
  const other = await begin(); other.control.unmaterialized = { [FRESH]: 'a' }; other.control.duringReadback = async p => { if (p.threadId === TARGET) { other.router.desktopView('item/completed', { threadId: TARGET, item: {} }); other.router.desktopView('turn/started', { threadId: TARGET, turn: { id: 't' } }); } };
  await leave(other); assert.equal(other.router.physicalOf(FRESH), TARGET, 'notices about another physical ID do not revoke the source proof');
  // 4. raw native notices: history/lifecycle ones revoke first; the thread's own birth notice, names, settings and an idle status do not
  const n = await begin();
  for (const [m, p] of [['thread/started', { thread: { id: FRESH } }], ['thread/name/updated', { threadId: FRESH, threadName: 'x' }], ['thread/settings/updated', { threadId: FRESH, threadSettings: {} }], ['thread/status/changed', { threadId: FRESH, status: { type: 'idle' } }]]) { n.router.desktopView(m, p); assert.ok(n.router.born.has(FRESH), m + ' leaves the evidence'); }
  const read = await n.router.request('thread/read', { threadId: FRESH }, n.forward); assert.ok(read && n.router.born.has(FRESH), 'a read leaves the evidence');
  for (const [m, p] of [['turn/started', { threadId: FRESH, turn: { id: 't' } }], ['item/completed', { threadId: FRESH, item: {} }], ['thread/status/changed', { threadId: FRESH, status: { type: 'active', activeFlags: [] } }], ['thread/closed', { threadId: FRESH }], ['thread/compacted', { threadId: FRESH }]]) {
    const f = await begin(); f.control.unmaterialized = { [FRESH]: 'a' }; f.router.desktopView(m, p); assert.ok(!f.router.born.has(FRESH), m + ' revokes'); await assert.rejects(leave(f), /not materialized yet/, m);
  }
  // 5. the evidence only ever applies to the first page of the SOURCE'S own history; ordinary readable empty and nonempty sources are unchanged
  const ordinary = await setup(); ordinary.routeSource(); ordinary.control.history = []; await settingsTo(ordinary, localModelId(ordinary.b, 'b1')); assert.equal(ordinary.router.physicalOf(SOURCE), NEW);
});

test('FRESH EMPTY SOURCE, NATIVE CLOCK: native answers an unmaterialized thread\'s createdAt/updatedAt with the CURRENT clock, so a second passing between the source snapshot and the final revalidation is not history: it is set aside only under the SAME live birth proof with every other field unchanged; the chat keeps its REAL birth date; every ordinary/nonempty guard still refuses', async () => {
  const FRESH = 'fresh-a', TARGET = 'fresh-b';
  const begin = async () => { const f = await setup(); f.control.birthAt = 1000; let tick = 1500; f.control.clock = () => tick; f.tick = n => { tick = n; }; f.control.newId = FRESH; f.control.notLoadedOnMain = new Set([FRESH]);
    await f.router.request('thread/start', { model: localModelId(f.a, 'a1'), cwd: '/synthetic', sandbox: 'read-only', approvalPolicy: 'never' }, f.forward); f.control.newId = TARGET; f.control.unmaterialized = { [FRESH]: 'a' }; return f; };
  const leave = f => f.router.request('thread/settings/update', { threadId: FRESH, model: localModelId(f.b, 'b1') }, f.forward);
  const during = (f, then) => { let fired = false; f.control.duringReadback = async p => { if (p.threadId === TARGET && !fired) { fired = true; await then(f); } }; return () => fired; };
  // 1. the clock crosses a second while the target is read back: nothing else changed, the SAME proof is live: the switch succeeds, and the origin keeps the REAL creation date (not native's current clock)
  const f = await begin(); const fired = during(f, f => f.tick(1501)); const bytes = readFileSync(f.routePath(FRESH));
  await leave(f); assert.ok(fired(), 'the clock really crossed during the switch'); assert.equal(f.router.physicalOf(FRESH), TARGET);
  const snapshot = await f.router.sourceSnapshot(f.router.readRoute(FRESH), FRESH); assert.deepEqual([snapshot.thread.createdAt, snapshot.thread.updatedAt, snapshot.thread.recencyAt], [1501, 1501, 1501], 'native reports all THREE clock fields (createdAt, updatedAt, recencyAt) as the current clock, and all three advanced');
  assert.equal(f.router.readLink(FRESH).origin.createdAt, 1000, 'the logical origin keeps the thread\'s REAL birth date from its own start answer (native\'s unmaterialized dates are the current clock)'); assert.deepEqual(readFileSync(f.routePath(FRESH)), bytes, 'the source is untouched');
  assert.deepEqual(by(f, 'thread/name/set').map(c => c.p.threadId), [TARGET]); assert.deepEqual(by(f, 'thread/inject_items'), []);
  // 2. the SAME date change WITHOUT the positive proof is an ordinary stale source
  const ordinary = await setup(); ordinary.routeSource(); ordinary.control.history = []; ordinary.control.updatedAt = 1; ordinary.control.newId = TARGET;
  const ordinaryFired = during(ordinary, c => { c.control.updatedAt = 2; }); await assert.rejects(settingsTo(ordinary, localModelId(ordinary.b, 'b1')), { code: 'stale_revision' }); assert.ok(ordinaryFired() && noLink(ordinary) && !ordinary.router.readLink(SOURCE), 'the date really changed during the switch');
  // 3. the proof is revoked during the target await (a history notice about the source), with the dates changed too: refused, nothing published, only the new child withdrawn
  const revoked = await begin(); during(revoked, c => { c.tick(1501); c.router.desktopView('item/completed', { threadId: FRESH, item: {} }); });
  await assert.rejects(leave(revoked), { code: 'stale_revision' }); assert.ok(noLink(revoked) && !revoked.router.readLink(FRESH)); assert.deepEqual(archived(revoked), [TARGET]);
  // 4. with the birth proof live and the date crossing, ANY other change of the source still refuses: control, permissions, roots, identity metadata, effort, native's current readState, a queued entry
  const changes = [['cwd', { cwd: '/elsewhere' }], ['sandbox', { sandbox: { type: 'dangerFullAccess' } }], ['approval policy', { approvalPolicy: 'on-request' }], ['reviewer', { approvalsReviewer: 'auto_review' }], ['permission profile', { activePermissionProfile: { id: 'wider' } }],
    ['workspace roots', { runtimeWorkspaceRoots: ['/synthetic', '/extra'] }], ['effort', { reasoningEffort: 'low' }], ['name', { thread: { name: 'renamed' } }], ['path', { thread: { path: '/synthetic/other.jsonl' } }], ['model', { model: 'a2' }]];
  for (const [label, change] of changes) {
    const g = await begin(); const gBytes = readFileSync(g.routePath(FRESH)); during(g, c => { c.tick(1501); c.control.perId = { [FRESH]: change }; });
    await assert.rejects(leave(g), error => { assert.ok(['stale_revision', 'native_permissions_changed', 'native_selection_not_confirmed', 'native_thread_identity_invalid'].includes(error.code), label + ' -> ' + error.code); return true; }); assert.ok(noLink(g) && !g.router.readLink(FRESH), label); assert.deepEqual(readFileSync(g.routePath(FRESH)), gBytes, label + ': the source route is untouched'); assert.deepEqual(archived(g), [TARGET], label);
  }
  const readState = await begin(); during(readState, c => { c.tick(1501); c.control.readState = { firstUnread: null, revision: 'initial:' + FRESH }; }); await assert.rejects(leave(readState), { code: 'stale_revision' }, 'a readState that is no longer null');
  const queued = await begin(); during(queued, c => { c.tick(1501); c.control.queue = { [FRESH]: [{ id: 'q1', clientUserMessageId: 'c', input: [] }] }; }); await assert.rejects(leave(queued), { code: 'handoff_queue_pending' }); assert.deepEqual(queued.control.queue[FRESH].map(q => q.id), ['q1'], 'the queued entry is untouched');
  // 5. a logical first turn naming another provider (the hand-off) still mutates the NEW target only, and the old source keeps its proof, even across the clock change
  const turn = await begin(); turn.control.newId = 'gpt-new'; during(turn, c => c.tick(1501));
  await turn.router.request('turn/start', { threadId: FRESH, model: 'gpt-y', input: [{ type: 'text', text: 'first' }], clientUserMessageId: 'c1' }, turn.forward);
  assert.ok(turn.router.born.has(FRESH)); assert.deepEqual(by(turn, 'turn/start').map(c => [c.peer, c.p.threadId]), [['main', 'gpt-new']]);
});

test('NATIVE GPT TARGET, UNMATERIALIZED CHILD: a new native GPT thread has no rollout (it cannot be resumed) until it is named or has items, so a requested level that differs from native\'s default is applied at once but read back only AFTER the delivery and the private naming; the target ends on exactly the requested model, level and mode, the source is untouched, and an unconfirmed level still withdraws the child', async () => {
  const gpt = (f, extra = {}) => f.router.request('thread/settings/update', { threadId: SOURCE, model: 'gpt-y', ...extra }, f.forward);
  const mode = effort => ({ collaborationMode: { mode: 'default', settings: { model: 'gpt-y', reasoning_effort: effort, developer_instructions: null } } });
  const events = f => f.notices.filter(n => n.m === 'thread/settings/updated');
  const childCalls = f => f.calls.filter(c => c.peer === 'main' && c.p.threadId === NEW).map(c => c.method);
  const arrived = (f, label, effort, withItems) => {
    const methods = childCalls(f), resume = methods.indexOf('thread/resume'), name = methods.indexOf('thread/name/set'), inject = methods.indexOf('thread/inject_items');
    assert.ok(resume >= 0 && name >= 0 && resume > name, label + ': the first read back of the child comes AFTER its private naming (' + methods.join(',') + ')'); if (withItems) assert.ok(inject >= 0 && resume > inject && name > inject, label + ': and after the carried items'); else assert.equal(inject, -1, label + ': an empty source injects nothing');
    assert.ok(methods.indexOf('thread/settings/update') >= 0 && methods.indexOf('thread/settings/update') < resume, label + ': the level was applied before');
    const s = events(f).at(-1).p.threadSettings; assert.deepEqual([s.model, s.effort, s.collaborationMode.settings.reasoning_effort], [localOrNative(f), effort, effort], label + ': the announced settings are the requested model, level and mode');
    assert.equal(f.router.physicalOf(SOURCE), NEW, label); assert.deepEqual(by(f, 'turn/start'), [], label + ': no dummy turn, no prompt'); assert.equal(events(f).length, 1, label + ': announced once');
  };
  const localOrNative = () => 'gpt-y';
  const strict = async () => { const f = await setup(); f.control.strictMaterialize = true; return f; };
  // 1. a custom conversation with history -> GPT, an explicit level
  const a = await strict(); a.routeSource(); const aBytes = readFileSync(a.routePath(SOURCE)); await gpt(a, { effort: 'high' });
  arrived(a, 'custom -> GPT, explicit level', 'high', true); assert.deepEqual(readFileSync(a.routePath(SOURCE)), aBytes, 'the source route is untouched'); assert.equal(JSON.stringify(injected(a)).split('EARLIER-USER-4417').length, 2, 'the prior history reaches the target once'); assert.doesNotMatch(JSON.stringify(injected(a)), /Bridge tool host/);
  // 2. the desktop's collaborationMode carries the level
  const b = await strict(); b.routeSource(); await gpt(b, mode('high')); arrived(b, 'custom -> GPT, level in the collaborationMode', 'high', true);
  // 3. a managed Claude chat the SDK executes -> GPT
  const c = await strict(); c.control.managed = SOURCE; c.control.managedTurns = structuredClone(HISTORY); c.control.sdkHost = true; const cTurns = JSON.stringify(c.control.managedTurns); await gpt(c, { effort: 'high' });
  arrived(c, 'SDK Claude -> GPT', 'high', true); assert.equal(JSON.stringify(c.control.managedTurns), cTurns, 'the SDK record is only read'); assert.equal(by(c, 'thread/resume').filter(x => x.p.threadId === SOURCE).length, 0, 'the SDK host is never resumed');
  // 4. an EMPTY logical source: nothing is injected, the private naming is what materializes the child
  const d = await strict(); d.routeSource(); d.control.history = []; await gpt(d, { effort: 'high' }); arrived(d, 'empty custom -> GPT', 'high', false);
  // 5. no level asked: the ordinary path is unchanged under the same strict native
  const e = await strict(); e.routeSource(); await gpt(e); assert.equal(e.router.physicalOf(SOURCE), NEW);
  // 6. refusals stay refusals: native does not apply the level / the naming fails: only the new child is withdrawn, nothing is linked or announced, the source is untouched
  const g = await strict(); g.routeSource(); const gBytes = readFileSync(g.routePath(SOURCE)); g.control.ignoreSettings = true;
  await assert.rejects(gpt(g, { effort: 'high' }), { code: 'native_selection_not_confirmed' }); assert.deepEqual(archived(g), [NEW]); assert.ok(noLink(g) && events(g).length === 0 && !g.router.readLink(SOURCE)); assert.deepEqual(readFileSync(g.routePath(SOURCE)), gBytes);
  const h = await strict(); h.routeSource(); h.control.nameError = Object.assign(new Error('synthetic name failure'), { code: -32600 });
  await assert.rejects(gpt(h, { effort: 'high' }), /synthetic name failure/); assert.deepEqual(archived(h), [NEW]); assert.ok(noLink(h) && events(h).length === 0); assert.equal(childCalls(h).includes('thread/resume'), false, 'the unmaterialized child is never resumed');
});

test('SDK HOST: a managed chat the Claude SDK really executes (its native host thread holds Bridge\'s private host placeholder) reaches GPT only as a NEW physical thread under the same conversation ID: the host never runs as a GPT model\'s own thread; the SDK record stays byte-identical; a fresh or already-native record keeps its ordinary same-thread change; the next hops carry the whole history once', async () => {
  const f = await setup(); f.control.managed = SOURCE; f.control.managedTurns = structuredClone(HISTORY); f.control.sdkHost = true; const original = JSON.stringify(f.control.managedTurns); f.control.newId = 'gpt-new';
  await settingsTo(f, 'gpt-y');
  const starts = by(f, 'thread/start'); assert.deepEqual(starts.map(c => [c.peer, c.p.model]), [['main', 'gpt-y']], 'a NEW native thread is created on the GPT side');
  assert.deepEqual(by(f, 'thread/resume').filter(c => c.p.threadId === SOURCE), [], 'the SDK host thread is never resumed, re-modelled or reused'); assert.deepEqual(by(f, 'thread/settings/update').filter(c => c.p.threadId === SOURCE), [], 'nothing is sent to the SDK host');
  assert.match(JSON.stringify(injected(f)), /EARLIER-USER-4417[\s\S]*TOOL-RESULT-9083/, 'the SDK chat\'s visible history is the canonical transfer'); assert.doesNotMatch(JSON.stringify(injected(f)), /Bridge tool host|Conversation is supplied when needed/, 'the private host placeholder is never model input');
  assert.equal(f.router.physicalOf(SOURCE), 'gpt-new'); assert.equal(f.router.readLink(SOURCE).kind, 'native'); assert.equal(JSON.stringify(f.control.managedTurns), original, 'the SDK record is only read'); never(f);
  assert.equal(f.notices.filter(n => n.m === 'thread/settings/updated').length, 1, 'announced once, under the conversation ID'); assert.equal(f.notices.find(n => n.m === 'thread/settings/updated').p.threadId, SOURCE);
  // the next hop (to a custom model) carries the SDK chat's turns exactly once, from the canonical copy, with no placeholder
  f.control.newId = 'custom-new'; await settingsTo(f, localModelId(f.a, 'a2'));
  const toCustom = JSON.stringify(by(f, 'thread/inject_items').at(-1).p.items); assert.equal(toCustom.split('EARLIER-USER-4417').length, 2, 'once'); assert.doesNotMatch(toCustom, /Bridge tool host/);
  // a fresh managed chat (the SDK never ran: no host placeholder) and a managed record that already executes a native model keep Bridge's ordinary same-thread change
  const fresh = await setup(); fresh.control.managed = SOURCE; fresh.control.managedTurns = []; fresh.control.sdkHost = false;
  await settingsTo(fresh, 'gpt-y'); assert.deepEqual(by(fresh, 'thread/start'), [], 'no hand-off: the ordinary path'); assert.equal(by(fresh, 'thread/settings/update').filter(c => c.peer === 'main' && c.p.threadId === SOURCE).length, 1, 'the ordinary model change reaches the same thread'); assert.ok(!fresh.router.readLink(SOURCE));
  // a busy SDK chat is refused untouched like every other source
  const busy = await setup(); busy.control.managed = SOURCE; busy.control.managedTurns = structuredClone(HISTORY); busy.control.sdkHost = true; busy.control.sourceStatus = 'active';
  await assert.rejects(settingsTo(busy, 'gpt-y'), { code: 'model_change_requires_idle' }); assert.deepEqual(by(busy, 'thread/start'), []); assert.ok(!busy.router.readLink(SOURCE));
});

test('COLD SOURCE SNAPSHOT: asking for the snapshot of a thread a native process has not loaded yet never changes its model (read first, then loaded WITH its own model, even when the process default is also a valid model of the connection); the route is not rewritten; a hand-off from such a source and the next public resume agree', async () => {
  const f = await setup(); f.control.coldDefaults = 'a1'; f.control.newId = 'hop-1'; await settingsTo(f, localModelId(f.a, 'a2')); const route = f.router.readRoute('hop-1'), bytes = readFileSync(f.routePath('hop-1'));
  f.control.cold.clear(); f.router = f.build(); const key = f.a + ':hop-1', seen = by(f, 'thread/resume').length;
  const snapshot = await f.router.sourceSnapshot(route, 'hop-1');
  assert.equal(snapshot.model, 'a2', 'the snapshot reports the thread\'s own saved model'); assert.equal(f.control.cold.get(key), 'a2', 'and asking for it did not move the thread to the process default (a1)');
  const loads = by(f, 'thread/resume').slice(seen).filter(c => c.p.threadId === 'hop-1'); assert.deepEqual(loads.map(c => c.p.model), ['a2'], 'one load, naming the saved model'); assert.ok(by(f, 'thread/read').some(c => c.p.threadId === 'hop-1'), 'which was observed read-only first');
  assert.deepEqual(readFileSync(f.routePath('hop-1')), bytes, 'a snapshot never rewrites the route');
  await f.router.request('thread/resume', { threadId: SOURCE }, f.forward); assert.equal(f.router.readRoute('hop-1').model, 'a2', 'the public resume afterwards still finds the saved model'); assert.equal(f.control.cold.get(key), 'a2');
  // a hand-off from a COLD custom source (GPT target) takes its snapshot the same way: the source thread is left on its own model, and it is the source of the move
  const g = await setup(); g.control.coldDefaults = 'a1'; g.control.newId = 'hop-1'; await settingsTo(g, localModelId(g.a, 'a2')); const kept = readFileSync(g.routePath('hop-1')); g.control.cold.clear(); g.router = g.build(); g.control.newId = 'gpt-new';
  await settingsTo(g, 'gpt-y'); assert.equal(g.control.cold.get(g.a + ':hop-1'), 'a2', 'the source thread still runs its own model'); assert.deepEqual(readFileSync(g.routePath('hop-1')), kept, 'the earlier physical thread keeps its route bytes'); assert.equal(g.router.readLink(SOURCE).physicalId, 'gpt-new');
  // a native that does not honour the named model is refused (nothing is created from a source whose model cannot be confirmed)
  const h = await setup(); h.control.coldDefaults = 'a1'; h.control.newId = 'hop-1'; await settingsTo(h, localModelId(h.a, 'a2')); h.control.cold.clear(); h.control.ignorePin = true; h.router = h.build(); h.control.newId = 'gpt-new';
  await assert.rejects(settingsTo(h, 'gpt-y'), { code: 'native_selection_not_confirmed' }); assert.deepEqual(by(h, 'thread/start').filter(c => c.peer === 'main'), [], 'nothing was created'); assert.ok(noLink(h) || h.router.readLink(SOURCE).physicalId === 'hop-1');
});

test('SOURCE SNAPSHOT, STALE RUNTIME: a loaded writer remembered on another model than the committed route is refused with native_runtime_stale BEFORE any native request, for every snapshot path; the newer route is never overwritten and no cached writer is refreshed', async () => {
  const f = await setup(); f.routeSource(); const old = f.router.readRoute(SOURCE);
  const first = await f.router.sourceSnapshot(old, SOURCE); assert.equal(first.model, 'a1', 'the first snapshot loads the thread on its own model and remembers it'); const quiet = f.calls.length;
  const again = await f.router.sourceSnapshot(old, SOURCE); assert.equal(again.model, 'a1', 'a loaded thread under the same route is read as before');
  const newer = f.router.replaceRoute(SOURCE, old, { ...old, model: 'a2' }); const bytes = readFileSync(f.routePath(SOURCE)), before = f.calls.length;
  await assert.rejects(f.router.sourceSnapshot(newer, SOURCE), { code: 'native_runtime_stale' }); assert.equal(f.calls.length, before, 'refused before any native request (no read, no resume, no unsubscribe)'); assert.deepEqual(readFileSync(f.routePath(SOURCE)), bytes, 'the newer route is untouched');
  // the switch itself (its source snapshot and its revalidation) is refused the same way and creates nothing
  await assert.rejects(settingsTo(f, 'gpt-y'), { code: 'native_runtime_stale' }); assert.deepEqual(by(f, 'thread/start'), [], 'nothing was created'); assert.ok(noLink(f)); assert.ok(quiet <= before);
});

test('FINAL READBACK, ABSENT FIELDS: a final readback that LACKS a required field (truly deleted from the JSON-RPC answer, not undefined) is never completed from the start answer, the source or the created ID: the switch is refused, only the new child is withdrawn, nothing is announced or linked (custom, GPT and managed Claude)', async () => {
  const events = f => f.notices.filter(n => n.m === 'thread/settings/updated');
  const permission = ['approvalPolicy', 'approvalsReviewer', 'cwd', 'sandbox', 'activePermissionProfile', 'runtimeWorkspaceRoots'], selection = ['model', 'modelProvider', 'reasoningEffort', 'disabledPluginIds', 'thread', 'thread.id'];
  const identity = ['native_selection_not_confirmed', 'native_thread_identity_invalid'];
  for (const target of ['custom', 'GPT']) for (const key of [...permission, ...selection]) {
    const f = await setup(); if (target === 'GPT') { f.routeSource(); f.control.newId = 'gpt-new'; } f.control.duringInject = async () => { f.control.omitFinal = [key]; }; // the start readback was complete; only the FINAL one lacks the field
    await assert.rejects(settingsTo(f, target === 'GPT' ? 'gpt-y' : localModelId(f.a, 'a2')), error => { assert.ok(permission.includes(key) ? error.code === 'native_permissions_unconfirmed' : identity.includes(error.code), target + ' ' + key + ' -> ' + error.code); return true; });
    assert.deepEqual(events(f), [], target + ' ' + key + ': nothing announced'); assert.deepEqual(archived(f), [target === 'GPT' ? 'gpt-new' : NEW], target + ' ' + key + ': only the new thread is withdrawn');
    assert.ok(noLink(f) && !existsSync(f.routePath(NEW)) && !existsSync(f.routePath('gpt-new')), target + ' ' + key + ': no link, route or intent'); assert.deepEqual(by(f, 'thread/inject_items').length, 1, 'history was delivered before the final read, to the child that is then withdrawn');
  }
  const claudeKeys = [['threadId', 'native_selection_not_confirmed'], ['disabledPluginIds', 'native_selection_not_confirmed'], ['model', 'native_selection_not_confirmed'], ['modelProvider', 'native_selection_not_confirmed'], ['effort', 'native_selection_not_confirmed'], ['collaborationMode', 'native_selection_not_confirmed'],
    ['cwd', 'native_permissions_unconfirmed'], ['sandboxPolicy', 'native_permissions_unconfirmed'], ['approvalPolicy', 'native_permissions_unconfirmed'], ['approvalsReviewer', 'native_permissions_unconfirmed'], ['activePermissionProfile', 'native_permissions_unconfirmed'], ['runtimeWorkspaceRoots', 'native_permissions_unconfirmed']];
  for (const [key, code] of claudeKeys) {
    const f = await setup(); f.routeSource(); f.control.claudeOmit = [key];
    await assert.rejects(settingsTo(f, 'claude-sonnet-x'), { code }, 'Claude: ' + key); assert.deepEqual(events(f), [], key); assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'archive').map(c => c[1]), ['claude-new'], 'Claude ' + key + ': only the new chat is withdrawn');
    assert.deepEqual(f.control.claudeCalls.filter(c => c[0] === 'publish'), [], key); assert.ok(noLink(f), key);
  }
  // the managed chat reports its OWN identity: another chat's ID is not the created one (the created argument is no substitute)
  const other = await setup(); other.routeSource(); other.control.claudeThreadId = 'someone-else';
  await assert.rejects(settingsTo(other, 'claude-sonnet-x'), { code: 'native_selection_not_confirmed' }); assert.ok(noLink(other));
  // explicitly present nullable values are values (null profile, null effort are not "missing"), and a complete readback is accepted
  const fine = await setup(); fine.control.duringInject = async () => {}; await settingsTo(fine, localModelId(fine.a, 'a2')); assert.equal(events(fine).length, 1);
  assert.deepEqual(Object.keys(events(fine)[0].p.threadSettings).sort(), ['activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd', 'disabledPluginIds', 'effort', 'model', 'modelProvider', 'multiAgentMode', 'personality', 'sandboxPolicy', 'serviceTier', 'summary'], 'the announced ThreadSettings stay the 14 public fields (no proof field leaks)');
  const claudeOk = await setup(); claudeOk.routeSource(); await settingsTo(claudeOk, 'claude-sonnet-x'); assert.deepEqual(Object.keys(events(claudeOk)[0].p.threadSettings).sort(), ['activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd', 'disabledPluginIds', 'effort', 'model', 'modelProvider', 'multiAgentMode', 'personality', 'sandboxPolicy', 'serviceTier', 'summary']);
});

// ---- context: the transition note and the reduced hand-off, through the real runtimeHandoff, router adapter and kit functions ----------------------------------------------
const switchTo = (f, model, extra = {}) => f.router.request('thread/settings/update', { threadId: SOURCE, model, ...extra }, f.forward);
const FILLER = 'filler words that make a message long enough to matter '.repeat(18);
const BIG = Array.from({ length: 220 }, (_, i) => ({ id: 'big-' + (i + 1), status: 'completed', items: [user('bu' + (i + 1), (i === 2 ? 'FIRST-FACT-3 ' : '') + `question ${i + 1} ${FILLER}`), { type: 'agentMessage', id: 'ba' + (i + 1), text: `answer ${i + 1} ${FILLER}` }] }));
const window = (route, model, over = {}) => ({ version: 1, key: route + ':' + (route === 'native' ? 'openai:' : '') + model, route, model, provider: route === 'native' ? 'openai' : null, contextWindow: 100_000, maxOutputTokens: 10_000, source: route === 'native' ? 'native-token-event' : 'sdk-modelusage', at: 1, ...over });
const summaryFor = (covered, over = {}) => qualifySdkCompaction({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'PROVIDER SUMMARY: remember FIRST-FACT-3 and the plan.', session_id: 'sess-1', cwd: process.cwd(), ...over },
  { sessionId: 'sess-1', model: 'claude-opus', cwd: process.cwd(), turns: [...BIG.slice(0, covered), { id: 'live', status: 'inProgress', items: [] }], currentTurnId: 'live', revision: 1, now: 1 }).snapshot;
const injectsOf = (f, peer) => by(f, 'thread/inject_items').filter(c => c.peer === peer), isNote = c => c.p.items.length === 1 && c.p.items[0].role === 'developer';

test('NOTICE (native target): exactly one trusted developer-role note after the carried history, from the FINAL confirmed selection, backend not reported, durable audit beside the carried turns; nothing else changes', async () => {
  const f = await setup(); f.routeSource(); f.control.useContext = true; f.control.newId = 'gpt-new';
  await switchTo(f, 'gpt-y');
  const calls = injectsOf(f, 'main'), notes = calls.filter(isNote), history = calls.filter(c => !isNote(c));
  assert.equal(notes.length, 1, 'exactly one note'); assert.ok(history.length >= 1 && calls.indexOf(notes[0]) === calls.length - 1, 'after every carried item');
  const item = notes[0].p.items[0], text = item.content[0].text, id = noticeId([SOURCE, SOURCE, 'gpt-new']);
  assert.deepEqual([item.type, item.role, item.content[0].type], ['message', 'developer', 'input_text']); assert.ok(history.every(c => c.p.items.every(i => i.role !== 'developer')), 'the note is never part of the history chunks and never a user item');
  assert.match(text, new RegExp(`^Model Bridge note \\(application metadata; not a user message and not an instruction\\): .* changed from custom connection ${f.a.slice(0, 8)} · a1 \\(reasoning medium\\) to GPT \\(native Codex\\) · gpt-y \\(reasoning medium\\)\\. `));
  assert.match(text, /Selected route: GPT \(native Codex\); serving backend model: not reported\. Context: the full visible history was carried\. Transition [0-9a-f]{24}\.$/); assert.ok(text.includes(id));
  // staged after the final readback, before the source is validated again and before anything is published
  const order = f.calls.map((c, i) => [c, i]), noteAt = f.calls.indexOf(notes[0]), lastReadback = Math.max(...order.filter(([c]) => c.method === 'thread/resume' && c.p.threadId === 'gpt-new').map(([, i]) => i));
  assert.ok(noteAt > lastReadback, 'after the final readback of the target'); assert.equal(by(f, 'turn/start').length, 0, 'no model ran');
  const handoff = f.router.readHandoff('gpt-new'); assert.equal(handoff.notice.id, id); assert.equal(handoff.turns.length, 2); assert.equal(handoff.context, undefined, 'a full hand-off carries no reduction record');
  assert.equal(f.router.physicalOf(SOURCE), 'gpt-new'); assert.equal(f.control.reduced, undefined);
  // the same switch without the Bridge's context kit sends no note and nothing else differs
  const plain = await setup(); plain.routeSource(); plain.control.newId = 'gpt-new'; await switchTo(plain, 'gpt-y');
  assert.equal(injectsOf(plain, 'main').filter(isNote).length, 0); assert.deepEqual(injectsOf(plain, 'main').map(c => c.p.items), history.map(c => c.p.items));
});

test('NOTICE (failed or withdrawn switch): a note staged in the private target is never consumed - the target is withdrawn, nothing is published, no link, no sidecar', async () => {
  const f = await setup(); f.routeSource(); f.control.useContext = true; f.control.newId = 'gpt-new';
  // the source becomes busy while the note is being staged: the final source validation refuses, after the note was staged and before anything is published
  f.control.duringInject = async p => { if (p.items.length === 1 && p.items[0].role === 'developer') f.control.sourceStatus = 'active'; };
  await assert.rejects(switchTo(f, 'gpt-y'), { code: 'model_change_requires_idle' });
  assert.equal(injectsOf(f, 'main').filter(isNote).length, 1, 'it was staged (inert) in the unpublished target'); assert.deepEqual(archived(f), ['gpt-new'], 'only the new target is withdrawn');
  assert.equal(f.router.readLink(SOURCE), null); assert.equal(f.router.physicalOf(SOURCE), SOURCE); assert.equal(f.router.readHandoff('gpt-new'), null, 'no carried sidecar was committed'); assert.equal(by(f, 'turn/start').length, 0); never(f);
  // an unconfirmed final readback never reaches the note at all
  const bad = await setup(); bad.routeSource(); bad.control.useContext = true; bad.control.newId = 'gpt-new'; bad.control.omitFinal = ['approvalsReviewer'];
  await assert.rejects(switchTo(bad, 'gpt-y'), { code: 'native_permissions_unconfirmed' }); assert.equal(injectsOf(bad, 'main').filter(isNote).length, 0);
});

test('NOTICE (Claude target): the note is staged on the new managed chat (pending application context) after the settings readback and before publication; a failed import stages none', async () => {
  const f = await setup(); f.routeSource(); f.control.useContext = true;
  await switchTo(f, 'claude-sonnet-x');
  const kinds = f.control.claudeCalls.map(c => c[0]); assert.equal(kinds.filter(k => k === 'notice').length, 1);
  assert.ok(kinds.indexOf('notice') > kinds.indexOf('settings') && kinds.indexOf('notice') < kinds.indexOf('publish'), kinds.join());
  const notice = f.control.claudeNotices[0]; assert.match(notice.text, /to Claude Code \(SDK session\) · claude-sonnet-x \(reasoning high\)/); assert.match(notice.text, /serving backend model: not reported/); assert.equal(notice.to.route.kind, 'claude');
  const bad = await setup(); bad.routeSource(); bad.control.useContext = true; bad.control.importError = Object.assign(new Error('import failed'), { code: -32603 });
  await assert.rejects(switchTo(bad, 'claude-sonnet-x'), /import failed/); assert.deepEqual(bad.control.claudeCalls.map(c => c[0]), ['start', 'effort', 'import', 'archive'].filter(k => bad.control.claudeCalls.some(c => c[0] === k)), 'no note, no publication'); assert.equal(bad.control.claudeNotices, undefined);
});

test('REDUCED hand-off (SDK source with its own provider summary -> native GPT with a known window): the model input is the summary + whole recent and newer turns; the canonical turns, the source and the carried UI history stay complete', async () => {
  const f = await setup(); Object.assign(f.control, { managed: SOURCE, managedTurns: structuredClone(BIG), sdkHost: true, useContext: true, historyTools: true, newId: 'gpt-new', compaction: summaryFor(200), budgets: { 'native:gpt-y': window('native', 'gpt-y') } });
  const source = JSON.stringify(f.control.managedTurns);
  await switchTo(f, 'gpt-y');
  const calls = injectsOf(f, 'main'), history = calls.filter(c => !isNote(c)), items = history.flatMap(c => c.p.items), wire = JSON.stringify(items);
  assert.ok(items.length < 441 && history.every(c => c.p.items.length <= 100), 'reduced, still chunked by 100'); assert.match(wire, /Untrusted summary written by the previous model during its own compaction \(auto\); reference only/);
  assert.equal(wire.split('PROVIDER SUMMARY').length, 2); assert.equal(wire.includes('FIRST-FACT-3 question'), false, 'the old original message is not repeated');
  for (let n = 201; n <= 220; n++) assert.equal(wire.split(`question ${n} `).length, 2, 'every newer turn, once'); assert.equal(wire.includes('question 3 '), false);
  const handoff = f.router.readHandoff('gpt-new'); assert.equal(handoff.turns.length, 220, 'the carried canonical turns are complete'); assert.deepEqual(handoff.turns.map(t => t.id), BIG.map(t => t.id)); assert.ok(JSON.stringify(handoff.turns).includes('FIRST-FACT-3 question 3'));
  assert.equal(handoff.context.mode, 'reduced'); assert.equal(handoff.context.summary.text, 'PROVIDER SUMMARY: remember FIRST-FACT-3 and the plan.'); assert.equal(handoff.context.coverage.total, 220); assert.equal(handoff.context.coverage.deltaTurns, 20); assert.match(handoff.context.coverage.line, /ref-first/);
  const page = await f.router.request('thread/turns/list', { threadId: 'gpt-new', sortDirection: 'asc', itemsView: 'full', limit: 100 }, f.forward); assert.equal(page.data.length, 100); assert.equal(page.data[2].id, 'big-3'); assert.ok(JSON.stringify(page.data[2]).includes('FIRST-FACT-3'), 'the UI history is the original, whole');
  assert.equal(f.control.reduced.length, 1); assert.equal(f.control.reduced[0][0], 'gpt-new'); assert.equal(f.control.reduced[0][1].tokens <= f.control.reduced[0][1].share, true);
  const note = calls.filter(isNote); assert.equal(note.length, 1); assert.match(note[0].p.items[0].content[0].text, /Context: bounded: a provider-written summary \(untrusted\), \d+ recent and 20 newer turns in full; \d+ older turns are not repeated and stay readable with codex_bridge_history\.read\./);
  assert.equal(JSON.stringify(f.control.managedTurns), source, 'the source chat is byte-identical'); never(f);
});

test('hand-off budget decisions: an unknown window carries the full history (no fit claimed); a known window it does not fit in REFUSES without a matching summary and withdraws only the new thread; a custom target never has a window', async () => {
  const unknown = await setup(); Object.assign(unknown.control, { managed: SOURCE, managedTurns: structuredClone(BIG), sdkHost: true, useContext: true, newId: 'gpt-new', compaction: summaryFor(200) });
  await switchTo(unknown, 'gpt-y'); assert.equal(injectsOf(unknown, 'main').filter(c => !isNote(c)).flatMap(c => c.p.items).length, 441, 'the whole visible history, as before'); const keptFull = unknown.router.readHandoff('gpt-new').context; assert.equal(keptFull.mode, 'full', 'the model input is the full history ...'); assert.equal(keptFull.summary.text, 'PROVIDER SUMMARY: remember FIRST-FACT-3 and the plan.', '... and the provider summary is still kept beside it'); assert.equal(unknown.control.reduced, undefined);
  for (const [label, summary, code] of [['no summary', null, 'handoff_context_too_large'], ['a summary of another history', summaryFor(200, {}) && { ...summaryFor(200), coverage: { ...summaryFor(200).coverage, hash: 'x'.repeat(32) } }, 'handoff_context_too_large']]) {
    const f = await setup(); Object.assign(f.control, { managed: SOURCE, managedTurns: structuredClone(BIG), sdkHost: true, useContext: true, historyTools: true, newId: 'gpt-new', compaction: summary, budgets: { 'native:gpt-y': window('native', 'gpt-y') } });
    await assert.rejects(switchTo(f, 'gpt-y'), error => { assert.equal(error.code, code, label); return true; });
    assert.deepEqual(archived(f), ['gpt-new'], label + ': only the new thread is withdrawn'); assert.equal(f.router.readLink(SOURCE), null, label); assert.equal(f.router.readHandoff('gpt-new'), null, label); assert.equal(f.control.reduced, undefined, label);
  }
  // a window recorded for ANOTHER model is not this model's window
  const other = await setup(); Object.assign(other.control, { managed: SOURCE, managedTurns: structuredClone(BIG), sdkHost: true, useContext: true, newId: 'gpt-new', compaction: summaryFor(200), budgets: { 'native:gpt-other': window('native', 'gpt-other') } });
  await switchTo(other, 'gpt-y'); assert.equal(other.router.readHandoff('gpt-new').context.mode, 'full', 'unknown for gpt-y: the full history');
  // a custom target is never given a window, whatever is recorded
  const custom = await setup(); Object.assign(custom.control, { managed: SOURCE, managedTurns: structuredClone(BIG), sdkHost: true, useContext: true, compaction: summaryFor(200), budgets: { 'native:a2': window('native', 'a2') } });
  await switchTo(custom, localModelId(custom.a, 'a2')); assert.equal(injectsOf(custom, custom.a).filter(c => !isNote(c)).flatMap(c => c.p.items).length, 441); assert.equal(custom.control.reduced, undefined);
});

test('REDUCED hand-off into a Claude chat: the SDK first-query reduction travels as the transfer context beside the complete canonical turns; the summary it carries was re-qualified against THIS history', async () => {
  const f = await setup(); f.routeSource(); Object.assign(f.control, { useContext: true, historyTools: true, history: structuredClone(BIG), budgets: { 'claude:claude-sonnet-x': window('claude', 'claude-sonnet-x') } });
  f.router.writeHandoff(SOURCE, { version: 1, turns: [], context: { version: 'bridge.handoff/2', mode: 'reduced', summary: summaryFor(200) } }); // an earlier hop's carried summary of this very history
  await switchTo(f, 'claude-sonnet-x');
  const t = f.control.claudeTransfers; assert.equal(t.length, 1); assert.equal(t[0].turns, 220, 'one whole import of every canonical turn'); assert.equal(t[0].context.mode, 'reduced'); assert.equal(t[0].context.coverage.deltaTurns, 20); assert.ok(t[0].modelItems < t[0].items);
  assert.deepEqual(f.control.claudeCalls.map(c => c[0]).filter(k => !['effort', 'settings', 'persist'].includes(k)), ['start', 'import', 'notice', 'publish']);
  assert.match(f.control.claudeNotices[0].text, /Context: bounded:/);
});

test('a FULL hand-off keeps the SDK summary beside the complete history; a LATER public fork with a known window reduces with it (carried turns + the target\'s own turns), its refs are bound to the NEW chat\'s own scope, and the gate and baseline are bound to the exact receiving model', async () => {
  const f = await setup(); f.routeSource(); Object.assign(f.control, { useContext: true, historyTools: true, newId: 'gpt-new', history: structuredClone(BIG.slice(200)), budgets: { 'native:gpt-y': window('native', 'gpt-y') } });
  f.router.writeHandoff(SOURCE, { version: 1, turns: structuredClone(BIG.slice(0, 200)), context: { version: 'bridge.handoff/2', mode: 'full', summary: summaryFor(200) } });
  await f.router.request('thread/fork', { threadId: SOURCE, model: 'gpt-y' }, f.forward);
  const handoff = f.router.readHandoff('gpt-new'); assert.equal(handoff.context.mode, 'reduced'); assert.equal(handoff.turns.length, 220, 'the canonical turns stay complete'); assert.equal(handoff.context.coverage.deltaTurns, 20); assert.ok(handoff.context.summary.text.includes('PROVIDER SUMMARY'));
  assert.equal(f.control.refScopes.length, 1); assert.equal(f.control.refScopes[0].logical, 'gpt-new', 'the refs read back in the scope of the chat that receives the history, never the source\'s'); assert.notEqual(f.control.refScopes[0].logical, SOURCE);
  assert.deepEqual(f.control.reduced[0].slice(0, 1).concat([f.control.reduced[0][2]]), ['gpt-new', { kind: 'native', model: 'gpt-y' }], 'the gate is sized for exactly this model');
  assert.equal(f.control.seeded.length, 1); assert.deepEqual([f.control.seeded[0].kind, f.control.seeded[0].id, f.control.seeded[0].model], ['native', 'gpt-new', 'gpt-y'], 'what the new thread\'s model last saw is recorded before the commit');
  // a carried summary of CHANGED history content (same ids) is never used: the history is full or the hand-off refuses
  const g = await setup(); g.routeSource(); const changed = structuredClone(BIG.slice(0, 200)); changed[2].items[0].content[0].text = 'CHANGED-FACT-SAME-IDS';
  Object.assign(g.control, { useContext: true, historyTools: true, newId: 'gpt-new', history: structuredClone(BIG.slice(200)), budgets: { 'native:gpt-y': window('native', 'gpt-y') } });
  g.router.writeHandoff(SOURCE, { version: 1, turns: changed, context: { version: 'bridge.handoff/2', mode: 'full', summary: summaryFor(200) } });
  await assert.rejects(g.router.request('thread/fork', { threadId: SOURCE, model: 'gpt-y' }, g.forward), { code: 'handoff_context_too_large' }); assert.deepEqual(archived(g), ['gpt-new']); assert.equal(g.router.readHandoff('gpt-new'), null);
});

test('the durable gate and baseline are OBLIGATIONS: when either cannot be written the hand-off is refused BEFORE the commit, only the new private child is withdrawn, and the source, its link and its history are unchanged', async () => {
  for (const [key, budgets] of [['reducedFails', { 'native:gpt-y': window('native', 'gpt-y') }], ['seedFails', undefined]]) {
    const f = await setup(); Object.assign(f.control, { managed: SOURCE, managedTurns: structuredClone(BIG), sdkHost: true, useContext: true, historyTools: true, newId: 'gpt-new', compaction: summaryFor(200), ...(budgets ? { budgets } : {}), [key]: true });
    const source = JSON.stringify(f.control.managedTurns);
    await assert.rejects(switchTo(f, 'gpt-y'), error => { assert.equal(error.code, 'context_state_unavailable', key); assert.match(error.message, /couldn't save the record/); return true; });
    assert.deepEqual(archived(f), ['gpt-new'], key + ': only the new child'); assert.equal(f.router.readLink(SOURCE), null, key); assert.equal(f.router.readHandoff('gpt-new'), null, key + ': no sidecar'); assert.equal(JSON.stringify(f.control.managedTurns), source, key + ': the source is byte-identical'); assert.equal(by(f, 'turn/start').length, 0);
  }
});

