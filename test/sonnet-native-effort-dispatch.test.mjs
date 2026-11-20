// Owner regression 697: a GPT turn failed BEFORE any inference with "Unsupported value: 'none' is not supported with 'gpt-6.1-sol'" while the composer showed Medium. The final native turn/start
// carried the accepted level at the top (`effort: 'medium'`) AND a stale one from the previous provider inside collaborationMode.settings.reasoning_effort ('none') - and native honours the nested one.
//
// These tests capture the FINAL PUBLIC DISPATCH PAYLOAD (what the native connection really receives), through the real Bridge request path (raw native thread: beforeTurn; managed chat: prepareTurn ->
// beginNative) and, for the GPT hand-off target, the real router crossFork with the real Bridge kit (kit.nativeEffort -> model/list). The reasoning levels are the injected runtime's own per-model
// model/list answer (no hardcoded model family anywhere): gpt-6.1-sol offers low/medium/high/xhigh/max (default medium); gpt-none-ok offers none/low/high (default none); the shared fixture's own
// gpt-test offers low/high (default low). No real native process, no model call.
//
// MUTATION RECIPE (throwaway QA copies only; each mutant must make the named tests FAIL):
//   M1  native-turns.mjs beginNative: send `{ ...request, model: record.model, effort: record.effort }` (drop `withEffort(..., record.effort)`)
//       -> 'managed native' fails (the wire still carries the stale nested 'none').
//   M2  bridge.mjs beforeTurn: delete the line `if (kind === 'native') params = await normalizeNativeEffort(...)`
//       -> 'raw native thread' fails (contradictory medium + none on the wire; cold restart too).
//   M3  providers.mjs chooseEffort: make `explicit` win even when the model does not offer it (return asked[0] ?? inherited first)
//       -> 'raw native thread', 'managed native' and the hand-off test fail (the stale 'none' wins).
//   M4  plugins/codex-claude/home/providers.mjs crossFork: delete the `if (nativeEffort) wanted = nativeEffort.effort;` line (and/or the `nativeEffort ? answer => ... :` branch of wantedEffort)
//       -> the hand-off test fails (a 'none' target stays 'none' / the stale 'none' is applied).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry, ResponsesRouter, useDurability } from '../plugins/codex-claude/home/providers.mjs';
import { readAllTurns } from '../continuity.mjs';
import { runtimeHandoff } from '../runtime-handoff.mjs';
import { overlayHistory, pageTurns, pageItems } from '../custom-turns.mjs';
import { fixture } from './support/fixture.mjs';

test.after(useDurability(process.permission ? () => {} : undefined)); // only the permission runner forbids fsync; an ordinary run stays strict

// ---- the injected runtime's per-model catalog ----------------------------------------------------------------------------------------------------------------------
const row = (model, levels, fallback) => ({ id: model, model, defaultReasoningEffort: fallback, supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort })) });
const CATALOG = [row('gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'), row('gpt-none-ok', ['none', 'low', 'high'], 'none'), row('gpt-test', ['low', 'high'], 'low'), row('gpt-other', ['low', 'high'], 'low')];
const catalogCalls = f => f.calls.filter(c => c.method === 'model/list');
// The runtime's public model/list (the shared fixture's own synthetic list is low/high only); everything else is the fixture's native host. Applied again after a restart (a new Bridge).
// `how` = what the runtime answers: 'ok' (the catalog above), 'throw' (model/list fails), 'missing' (the exact model is not listed), 'empty' (the exact row advertises no levels).
const withCatalog = (f, how = 'ok') => { const real = f.bridge.native.request; f.bridge.native.request = async (method, p) => {
  if (method !== 'model/list') return real(method, p);
  f.calls.push({ method, params: structuredClone(p) });
  if (how === 'throw') throw new Error('model/list is unavailable');
  const rows = how === 'missing' ? [row('some-other-model', ['low', 'high'], 'low')] : how === 'empty' ? [row('gpt-6.1-sol', [], undefined), row('gpt-test', [], undefined)] : CATALOG;
  return { data: structuredClone(rows), nextCursor: null };
}; return f; };
const starts = f => f.calls.filter(c => c.method === 'turn/start');
const mode = (model, effort) => ({ mode: 'default', settings: { model, reasoning_effort: effort, developer_instructions: null } });
const update = (f, id, params) => f.bridge.request('thread/settings/update', { threadId: id, ...params });
const turn = async (f, id, text, params) => { const before = starts(f).length, sent = await f.send(id, text, params); await f.done(sent.turn.id); assert.equal(starts(f).length, before + 1, 'exactly one turn/start'); return starts(f).at(-1).params; };
const levelsOf = wire => [wire.effort, wire.collaborationMode?.settings?.reasoning_effort];
const refused = async (f, id, params, pattern) => { const before = starts(f).length; await assert.rejects(f.send(id, 'REFUSED-INPUT', params), pattern); assert.equal(starts(f).length, before, 'nothing was dispatched'); };

// ---- 1. a raw native thread (Bridge.beforeTurn) ----------------------------------------------------------------------------------------------------------------------
test('raw native thread: the final public turn/start carries ONE level on both fields; a stale none never overrides a valid Medium/High; cold restart; per-model catalogs; none kept where offered; other invalid levels refused', async () => {
  const f = withCatalog(fixture('openai')), id = await f.start('gpt-6.1-sol');
  // both fields agree on a valid level: the request goes exactly as it came, and nothing is asked of the runtime
  let wire = await turn(f, id, 'one', { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'medium') });
  assert.deepEqual(levelsOf(wire), ['medium', 'medium']); assert.deepEqual(catalogCalls(f), [], 'no catalog read when nothing disagrees');
  // THE OWNER'S PAYLOAD: accepted Medium on top, stale none inside the mode
  wire = await turn(f, id, 'two', { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') });
  assert.deepEqual(levelsOf(wire), ['medium', 'medium'], 'the contradictory medium + none is one level on the wire'); assert.equal(wire.input[0].text, 'two'); assert.equal(wire.input.length, 1);
  assert.equal(catalogCalls(f).length, 1, 'the model\'s own advertised levels were asked for');
  // the stale none is inside the mode ONLY: the model's advertised default (not a global Medium coercion, not none)
  wire = await turn(f, id, 'three', { collaborationMode: mode('gpt-6.1-sol', 'none') }); assert.deepEqual(levelsOf(wire), [undefined, 'medium']);
  // a legitimate High (mode) and Medium (top) are both offered: the mode keeps its normal precedence and BOTH fields say it
  wire = await turn(f, id, 'four', { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'high') }); assert.deepEqual(levelsOf(wire), ['high', 'high']);
  wire = await turn(f, id, 'five', { effort: 'high', collaborationMode: mode('gpt-6.1-sol', 'none') }); assert.deepEqual(levelsOf(wire), ['high', 'high'], 'a valid explicit High is never overridden by none');
  // a model-level default of ANOTHER catalog is that catalog's own (gpt-test: low/high, default low)
  const other = await f.start('gpt-test'); wire = await turn(f, other, 'six', { collaborationMode: mode('gpt-test', 'none') }); assert.deepEqual(levelsOf(wire), [undefined, 'low']);
  // a model whose catalog really offers none keeps it (both fields, consistently), even beside another valid level
  const nonable = await f.start('gpt-none-ok');
  wire = await turn(f, nonable, 'seven', { effort: 'low', collaborationMode: mode('gpt-none-ok', 'none') }); assert.deepEqual(levelsOf(wire), ['none', 'none'], 'none is offered by this model: it stays');
  wire = await turn(f, nonable, 'eight', { effort: 'none', collaborationMode: mode('gpt-none-ok', 'none') }); assert.deepEqual(levelsOf(wire), ['none', 'none']);
  // an invalid level that is NOT the stale none is refused, never relabeled
  await refused(f, id, { effort: 'none', collaborationMode: mode('gpt-6.1-sol', 'bogus') }, /Unsupported effort bogus for gpt-6\.1-sol/);
  // ... even beside a valid level: only the stale none is ignored, an unsupported explicit level never loses silently to another one
  await refused(f, id, { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'bogus') }, /Unsupported effort bogus for gpt-6\.1-sol/);
  // COLD RESTART: a new Bridge, the same thread, the same stale client state
  f.restart(); withCatalog(f);
  wire = await turn(f, id, 'nine', { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') }); assert.deepEqual(levelsOf(wire), ['medium', 'medium']);
  assert.equal(wire.input[0].text, 'nine');
  // the thread's own setting update carries the same one-level rule
  const before = f.calls.filter(c => c.method === 'thread/settings/update').length;
  await update(f, id, { model: 'gpt-6.1-sol', effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') });
  assert.deepEqual(levelsOf(f.calls.filter(c => c.method === 'thread/settings/update')[before].params), ['medium', 'medium']);
});

test('raw native thread: the transition note announces the VALID level that runs, never none', async () => {
  const f = withCatalog(fixture('openai')), id = await f.start('gpt-6.1-sol');
  // what the runtime itself confirmed for this thread (the shared fake host does not call the Bridge's observer): gpt-6.1-sol on High, which the model has seen
  f.bridge.acceptSelection({ peer: f.bridge.native, kind: 'native', id, model: 'gpt-6.1-sol', effort: 'high', hadTurn: true });
  await turn(f, id, 'first', { effort: 'high', collaborationMode: mode('gpt-6.1-sol', 'high') });
  const wire = await turn(f, id, 'second', { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') });
  assert.deepEqual(levelsOf(wire), ['medium', 'medium']);
  const note = wire.additionalContext?.bridge_transition?.value; assert.equal(typeof note, 'string', 'the change from High to Medium is announced');
  assert.match(note, /medium/i); assert.doesNotMatch(note, /\bnone\b/i);
});

// ---- 2. a managed chat that runs a native model (Bridge.prepareTurn -> beginNative) ----------------------------------------------------------------------------------
test('managed native chat: accepted selection, canonical readback and the public turn/start agree; stale none (also after a cold restart) never contradicts them; none kept where offered; invalid refused', async () => {
  const f = withCatalog(fixture('openai')), id = await f.start('sonnet');
  await update(f, id, { model: 'gpt-6.1-sol', effort: 'medium' });
  const record = () => f.bridge.records.get(id); assert.equal(record().provider, 'native'); assert.equal(record().effort, 'medium');
  // the owner's payload on the managed path: top Medium, stale none in the mode
  let wire = await turn(f, id, 'one', { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') });
  assert.deepEqual(levelsOf(wire), ['medium', 'medium']); assert.equal(wire.model, 'gpt-6.1-sol'); assert.equal(wire.input.length, 1); assert.equal(wire.input[0].text, 'one');
  assert.equal((await f.bridge.request('thread/read', { threadId: id })).thread.reasoningEffort, 'medium', 'the canonical readback is the level that ran');
  // stale none ALONE: the accepted current choice stands (it is offered), on both fields
  wire = await turn(f, id, 'two', { collaborationMode: mode('gpt-6.1-sol', 'none') }); assert.deepEqual(levelsOf(wire), ['medium', 'medium']);
  // a legitimate explicit High is preserved and becomes the accepted choice
  wire = await turn(f, id, 'three', { effort: 'high', collaborationMode: mode('gpt-6.1-sol', 'none') }); assert.deepEqual(levelsOf(wire), ['high', 'high']); assert.equal(record().effort, 'high');
  // COLD RESTART: the accepted High is still the choice; a stale none in the client's mode cannot override it
  f.restart(); withCatalog(f);
  wire = await turn(f, id, 'four', { collaborationMode: mode('gpt-6.1-sol', 'none') }); assert.deepEqual(levelsOf(wire), ['high', 'high']);
  assert.equal(f.bridge.records.get(id).turns.filter(t => JSON.stringify(t.items).includes('"four"')).length, 1, 'the current input is recorded once');
  // an invalid level that is not the stale none is refused (nothing dispatched, nothing relabeled)
  await refused(f, id, { effort: 'none', collaborationMode: mode('gpt-6.1-sol', 'bogus') }, /Unsupported effort bogus for gpt-6\.1-sol/);
  assert.equal(f.bridge.records.get(id).effort, 'high');
  await refused(f, id, { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'bogus') }, /Unsupported effort bogus for gpt-6\.1-sol/); // (refused beside a valid level too)
  // another catalog that offers none: an explicit none is a real choice there, on both fields
  await update(f, id, { model: 'gpt-none-ok', effort: 'none' }); assert.equal(f.bridge.records.get(id).effort, 'none');
  wire = await turn(f, id, 'five', { effort: 'none', collaborationMode: mode('gpt-none-ok', 'none') }); assert.deepEqual(levelsOf(wire), ['none', 'none']);
});

// ---- 3. the GPT hand-off target (router crossFork + the Bridge's kit) ------------------------------------------------------------------------------------------------
const BASE = { cwd: '/synthetic', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: null, runtimeWorkspaceRoots: ['/synthetic'], disabledPluginIds: [], serviceTier: null, multiAgentMode: 'explicitRequestOnly' };
const SOURCE = 'source-thread', CREATED = 'gpt-target-thread';
const HISTORY = [{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'EARLIER-USER-4417' }] }, { type: 'agentMessage', id: 'a1', text: 'EARLIER-ASSISTANT-5521' }] }];
// A managed Claude chat (its SDK really executes it: it reaches GPT only as a NEW physical thread) continues on a GPT model. `born` is the level the NEW thread starts with (the app-server's own configured
// default, or what a previous provider left): the test decides what the hand-off makes of it. The kit is the REAL Bridge kit (kit.nativeEffort asks the injected runtime's model/list).
async function handoff({ born, model, params = {}, source = 'none', catalog = 'ok', ignoreApply = false }) {
  const f = withCatalog(fixture('openai'), catalog), root = mkdtempSync(join(tmpdir(), 'sonnet-effort-')); new ProviderRegistry(root);
  const calls = [], applied = new Map(); let createdModel;
  const thread = (id, m) => ({ id, path: '/synthetic/' + id + '.jsonl', forkedFromId: null, status: { type: 'idle' }, modelProvider: 'openai', model: m, cwd: '/synthetic', source: 'vscode', turns: [], createdAt: 100, updatedAt: 100 });
  const answer = id => ({ thread: thread(id, createdModel), model: createdModel, modelProvider: 'openai', ...BASE, reasoningEffort: applied.get(id) ?? born,
    collaborationMode: { mode: 'default', settings: { model: createdModel, reasoning_effort: applied.get(id) ?? born, developer_instructions: null } } });
  const forward = async (method, p) => {
    calls.push({ method, p: structuredClone(p) });
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method === 'thread/start') { createdModel = p.model; return answer(CREATED); }
    if (method === 'thread/settings/update') { if (p.effort !== undefined && !ignoreApply) applied.set(p.threadId, p.effort); return {}; } // (ignoreApply: a host that accepts the write but does not hold it)
    if (method === 'thread/resume' && p.threadId === CREATED) return answer(CREATED);
    if (['thread/inject_items', 'thread/archive'].includes(method)) return {};
    throw Error('unexpected ' + method);
  };
  const router = new ResponsesRouter({ root, native: { request: async () => ({ data: [], nextCursor: null }) }, managed: id => id === SOURCE, notify: () => {},
    continuity: { runtimeHandoff, readAllTurns, overlayHistory, pageTurns, pageItems, context: f.bridge.contextKit() },
    managedSource: id => id === SOURCE ? { turns: structuredClone(HISTORY), legacyHost: false, sdkHost: true, compaction: null, contextSummary: null,
      snapshot: { queue: [], thread: { ...thread(SOURCE, 'claude-opus'), modelProvider: 'claude_code' }, model: 'claude-opus', modelProvider: 'claude_code', reasoningEffort: source, ...BASE } } : null,
    nativeFor: async () => { throw Error('no custom connection here'); } });
  const result = router.request('thread/fork', { threadId: SOURCE, model, ...params }, forward);
  const effortUpdates = () => calls.filter(c => c.method === 'thread/settings/update').map(c => c.p.effort);
  return { f, root, calls, result, effortUpdates, created: () => answer(CREATED) };
}

test('GPT hand-off target: the new thread runs on a level the TARGET model offers - a stale none or the source/default none never survives; valid explicit levels and none-offering models are preserved; invalid refused', async () => {
  // the owner's request: Medium asked at the top, the stale none inside the mode; the new thread was born on the app-server default (low)
  let t = await handoff({ born: 'low', model: 'gpt-6.1-sol', params: { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') } }); let done = await t.result;
  assert.deepEqual(t.effortUpdates(), ['medium'], 'Medium is applied, never none'); assert.equal(done.reasoningEffort, 'medium'); assert.equal(done.thread.id, CREATED);
  assert.ok(t.calls.every(c => c.p.threadId !== SOURCE), 'the source is never touched'); assert.equal(JSON.stringify(t.calls.filter(c => c.method === 'thread/inject_items')).split('EARLIER-USER-4417').length, 2, 'the history is carried once');
  // the NEW thread was born on none (the source's / the app-server's default) and nothing was asked: the target model's advertised default, not none, not a global Medium
  t = await handoff({ born: 'none', model: 'gpt-6.1-sol' }); done = await t.result; assert.deepEqual(t.effortUpdates(), ['medium']); assert.equal(done.reasoningEffort, 'medium');
  t = await handoff({ born: 'none', model: 'gpt-test' }); done = await t.result; assert.deepEqual(t.effortUpdates(), ['low'], 'this model\'s own catalog: low, not a global Medium'); assert.equal(done.reasoningEffort, 'low');
  // a born level the model offers stays (nothing is changed, nothing invented)
  t = await handoff({ born: 'high', model: 'gpt-6.1-sol' }); done = await t.result; assert.deepEqual(t.effortUpdates(), []); assert.equal(done.reasoningEffort, 'high');
  // a stale none ALONE asked of a model that does not offer it is no choice: the born level (offered) stands
  t = await handoff({ born: 'low', model: 'gpt-6.1-sol', params: { collaborationMode: mode('gpt-6.1-sol', 'none') } }); done = await t.result; assert.deepEqual(t.effortUpdates(), []); assert.equal(done.reasoningEffort, 'low');
  // a legitimate explicit High is preserved
  t = await handoff({ born: 'low', model: 'gpt-6.1-sol', params: { effort: 'high', collaborationMode: mode('gpt-6.1-sol', 'none') } }); done = await t.result; assert.deepEqual(t.effortUpdates(), ['high']); assert.equal(done.reasoningEffort, 'high');
  // a model whose catalog offers none: an explicit none is preserved
  t = await handoff({ born: 'low', model: 'gpt-none-ok', params: { effort: 'none' } }); done = await t.result; assert.deepEqual(t.effortUpdates(), ['none']); assert.equal(done.reasoningEffort, 'none');
  // another invalid level is refused BEFORE any thread exists, never relabeled
  t = await handoff({ born: 'low', model: 'gpt-6.1-sol', params: { effort: 'bogus' } }); await assert.rejects(t.result, { code: 'unsupported_reasoning_effort' });
  assert.deepEqual(t.calls.filter(c => ['thread/start', 'thread/inject_items', 'thread/settings/update'].includes(c.method)), [], 'nothing was created, delivered or applied');
});

// ---- 4. levels that cannot be established --------------------------------------------------------------------------------------------------------------------------------
// When the exact target's levels are unknown (model/list fails, the exact row is missing, or it advertises no levels) two DISAGREEING explicit levels cannot be settled: the request is refused with a clear
// error BEFORE anything is dispatched or created - no default is guessed and no none is sent or applied. One level, or none, is not contradictory and is left exactly as it always was.
//
// MUTATION RECIPE: providers.mjs normalizeNativeEffort - return `params` instead of throwing levelsUnconfirmed in its three unconfirmed branches (and drop the `contradictory` throw of chooseEffort)
//   -> the raw / managed test fails; plugins/codex-claude/home/providers.mjs crossFork - delete the `fail('reasoning_levels_unconfirmed')` line -> the hand-off test fails.
const unconfirmed = /could not confirm which reasoning levels/;
const conflict = { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'none') };

test('raw native thread and managed chat: disagreeing levels with unconfirmed target levels are refused before any dispatch or write (initial and cold); ordinary requests ask nothing and go as they came', async () => {
  const f = fixture('openai'), id = await f.start('gpt-6.1-sol');
  const hostTurns = () => JSON.stringify(f.hosts.get(id).thread.turns), writes = () => f.calls.filter(c => c.method === 'thread/settings/update').length;
  for (const how of ['throw', 'missing', 'empty']) {
    withCatalog(f, how); const looked = catalogCalls(f).length, snapshot = hostTurns(), written = writes();
    await refused(f, id, conflict, unconfirmed);
    await assert.rejects(update(f, id, { model: 'gpt-6.1-sol', ...conflict }), unconfirmed); assert.equal(writes(), written, 'no settings write reached the host'); assert.equal(hostTurns(), snapshot, 'the visible state is unchanged');
    assert.ok(catalogCalls(f).length > looked, 'the capability lookup was attempted (' + how + ')');
    // ordinary paths: no level at all, or the same level in both fields, ask nothing and are sent as they came
    const asked = catalogCalls(f).length;
    assert.deepEqual(levelsOf(await turn(f, id, 'plain ' + how, {})), [undefined, undefined]);
    assert.deepEqual(levelsOf(await turn(f, id, 'same ' + how, { effort: 'medium', collaborationMode: mode('gpt-6.1-sol', 'medium') })), ['medium', 'medium']); assert.equal(catalogCalls(f).length, asked, 'no extra lookup');
    // one stale none alone is not contradictory: nothing is guessed, it goes exactly as it came
    assert.deepEqual(levelsOf(await turn(f, id, 'only none ' + how, { collaborationMode: mode('gpt-6.1-sol', 'none') })), [undefined, 'none']);
  }
  // COLD restart: the same refusal, then the known catalog settles it
  f.restart(); withCatalog(f, 'throw'); await refused(f, id, conflict, unconfirmed); withCatalog(f, 'empty'); await refused(f, id, conflict, unconfirmed);
  withCatalog(f); assert.deepEqual(levelsOf(await turn(f, id, 'known again', conflict)), ['medium', 'medium']);
  // a MANAGED chat: the selection is refused before anything is applied or sent, its accepted level and history stay
  const g = withCatalog(fixture('openai')), mid = await g.start('sonnet'); await update(g, mid, { model: 'gpt-6.1-sol', effort: 'medium' });
  const state = () => JSON.stringify([g.bridge.records.get(mid).effort, g.bridge.records.get(mid).model, g.bridge.records.get(mid).turns.length, g.hosts.get(mid).settings.effort]), saved = state();
  for (const how of ['throw', 'missing', 'empty']) { withCatalog(g, how); await refused(g, mid, conflict, /unavailable|does not advertise|could not confirm/); assert.equal(state(), saved, 'accepted level, model and history are unchanged (' + how + ')'); }
  withCatalog(g); assert.deepEqual(levelsOf(await turn(g, mid, 'managed known', conflict)), ['medium', 'medium']);
  // (one explicit level with unknown levels is not contradictory: it goes as it came, never replaced by a guessed default)
  withCatalog(g, 'empty'); assert.deepEqual(levelsOf(await turn(g, mid, 'managed one level', { effort: 'medium' })), ['medium', undefined]);
});

test('GPT hand-off: disagreeing levels with unconfirmed target levels are refused before any thread exists; one level goes as before; an apply/readback failure withdraws the provisional child', async () => {
  for (const catalog of ['throw', 'missing', 'empty']) {
    const t = await handoff({ born: 'low', model: 'gpt-6.1-sol', catalog, params: conflict });
    await assert.rejects(t.result, { code: 'reasoning_levels_unconfirmed' });
    assert.deepEqual(t.calls.filter(c => ['thread/start', 'thread/inject_items', 'thread/settings/update', 'thread/archive', 'turn/start'].includes(c.method)), [], 'no thread was created, written to, applied to or withdrawn (' + catalog + ')');
    assert.ok(t.calls.every(c => c.p.threadId !== SOURCE), 'the source is untouched');
    // one level is not contradictory: it goes exactly as it always did
    const one = await handoff({ born: 'low', model: 'gpt-6.1-sol', catalog, params: { effort: 'medium' } }); const done = await one.result;
    assert.deepEqual(one.effortUpdates(), ['medium']); assert.equal(done.reasoningEffort, 'medium');
  }
  // a host that accepts the level write but does not hold it: the readback refuses, the provisional child is withdrawn, nothing is committed or sent to a model, the source is unchanged
  const bad = await handoff({ born: 'low', model: 'gpt-6.1-sol', params: { effort: 'medium' }, ignoreApply: true });
  await assert.rejects(bad.result, { code: 'native_selection_not_confirmed' });
  assert.deepEqual(bad.calls.filter(c => c.method === 'thread/archive').map(c => c.p.threadId), [CREATED], 'only the provisional child is archived');
  assert.equal(bad.calls.filter(c => c.method === 'turn/start').length, 0, 'no model dispatch'); assert.ok(bad.calls.every(c => c.p.threadId !== SOURCE), 'the source is untouched');
  assert.equal(existsSync(join(bad.root, 'local-routes', 'handoffs', CREATED + '.json')), false, 'nothing was committed');
});
