import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnections, setEnabled, setVisible, readConnections, lockFile, recordCatalog, storeFile } from '../connections.mjs';
import { sessionCall } from '../sessions.mjs';
import { fixture } from './support/fixture.mjs';

// Regression cases for the independent review of candidate a5b29dd (findings F1-F13). Each states the
// owner expectation; the review ran them against the frozen source, where the named ones failed.
// They use only the fixture's existing seams (getModels, runQuery, the fake native host): no Claude
// executable, login, model request, network or real profile. Like the other Bridge tests they need
// the pinned SDK package to import bridge.mjs. A fixture host is not native or GUI proof.
const text = x => [{ type: 'text', text: x }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ticks = (ms = 40) => new Promise(r => setTimeout(r, ms));
const q = (f, id, m, p = {}) => f.bridge.request(`thread/queue/${m}`, { threadId: id, ...p });
const models = result => result.data.map(m => m.model);
// The receipt a real steered turn ends with: the replayed user message, then a result naming its UUID.
const ack = () => async function* (a) {
  for await (const m of a.steeringInput) { yield { ...m, isReplay: true }; yield { type: 'result', subtype: 'success', user_message_uuids: [a.promptId, m.uuid] }; break; }
};
function setup(extra = {}) { const root = mkdtempSync(join(tmpdir(), 'bridge-regress-')); createConnections(root); return { root, f: fixture('openai', { connectionRoot: root, ...extra }) }; }
const clean = (root, f) => { f.close(); rmSync(root, { recursive: true, force: true }); };
async function activeTurn(f, id, gate) { f.controls.query = () => gate.promise; f.controls.messages = ack(); return (await f.send(id, 'running')).turn; }

// ---- F3: history, discovery and reopen while disabled need no SDK
test('O1 a retained Claude chat is listed (paged), read, paged by turns and items, reopened and restarted while disabled, with identity and bytes kept', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku');
    const t1 = (await f.send(id, 'RV_USER_ONE')).turn; await f.done(t1.id);
    const t2 = (await f.send(id, 'RV_USER_TWO')).turn; await f.done(t2.id);
    await f.start('gpt-test'); const gptPeer = await f.start('gpt-test');
    const file = join(f.statePath, `${id}.json`);
    const before = (await f.bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns, n = f.queries.length;
    setEnabled(root, false);
    const listAll = async () => { const out = []; let cursor; do { const page = await f.bridge.request('thread/list', { limit: 2, ...(cursor ? { cursor } : {}) }); out.push(...page.data); cursor = page.nextCursor; } while (cursor); return out; };
    const collected = await listAll();
    assert.deepEqual(f.calls.findLast(c => c.method === 'thread/list').params.modelProviders, [], 'no disabled-provider filter on the native list');
    const row = collected.find(t => t.id === id);
    assert.ok(row, 'discoverable'); assert.equal(row.modelProvider, 'claude_code'); assert.equal(row.model, 'haiku');
    assert.deepEqual(row.turns, [], 'no native seed substituted'); assert.equal(row.status.type, 'idle');
    assert.ok(collected.some(t => t.id === gptPeer));
    assert.deepEqual((await f.bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns, before);
    const page1 = await f.bridge.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'asc' });
    assert.equal(page1.data[0].id, t1.id); assert.ok(page1.nextCursor);
    const page2 = await f.bridge.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'asc', cursor: page1.nextCursor });
    assert.equal(page2.data[0].id, t2.id);
    const items = await f.bridge.request('thread/items/list', { threadId: id, turnId: t2.id });
    assert.ok(items.data.some(e => e.item.content?.some(c => c.text === 'RV_USER_TWO'))); assert.ok(items.data.some(e => e.item.text === 'CLAUDE RESULT'));
    const stored = JSON.parse(readFileSync(file));
    f.restart();
    const reopened = await f.bridge.request('thread/resume', { threadId: id });
    assert.deepEqual(reopened.thread.turns, before); assert.equal(reopened.modelProvider, 'claude_code'); assert.equal(reopened.model, 'haiku');
    const paged = await f.bridge.request('thread/resume', { threadId: id, initialTurnsPage: { limit: 1, sortDirection: 'desc' } });
    assert.equal(paged.initialTurnsPage.data[0].id, t2.id);
    assert.equal(f.queries.length, n, 'no SDK prompt query');
    assert.ok((await listAll()).some(t => t.id === id));
    assert.deepEqual(JSON.parse(readFileSync(file)).turns, stored.turns, 'stored turns equal after reopen');
    await f.bridge.request('thread/archive', { threadId: id }); await f.bridge.request('thread/unarchive', { threadId: id });
    assert.deepEqual((await f.bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns, before);
  } finally { clean(root, f); }
});
test('O1b a true reopen does not depend on the disabled adapter: SDK catalog unavailable', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'); const t = (await f.send(id, 'x')).turn; await f.done(t.id);
    setEnabled(root, false); f.restart(); let calls = 0;
    f.bridge.getModels = async () => { calls++; throw new Error('SYNTHETIC SDK UNAVAILABLE'); };
    assert.ok((await f.bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns.length);
    const r = await f.bridge.request('thread/resume', { threadId: id });
    assert.equal(r.thread.id, id); assert.equal(r.model, 'haiku'); assert.equal(calls, 0, 'the SDK catalog was not asked');
  } finally { clean(root, f); }
});
test('O1c a true reopen works when the chat model has left the SDK catalog, enabled or disabled', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'); const t = (await f.send(id, 'x')).turn; await f.done(t.id);
    for (const enabled of [false, true]) {
      setEnabled(root, enabled); f.restart(); f.bridge.getModels = async () => [{ value: 'sonnet' }];
      const r = await f.bridge.request('thread/resume', { threadId: id });
      assert.equal(r.thread.id, id, `enabled=${enabled}`); assert.equal(f.bridge.records.get(id).model, 'haiku');
    }
  } finally { clean(root, f); }
});
test('O1d a disabled model/list never contacts the SDK; includeHidden shows retained models from the last validated catalog', async () => {
  const { root, f } = setup(); try {
    await f.bridge.request('model/list', {}); // observed and stored while enabled
    setEnabled(root, false); f.restart(); let calls = 0;
    f.bridge.getModels = async () => { calls++; return [{ value: 'other' }]; };
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other']);
    const hidden = (await f.bridge.request('model/list', { includeHidden: true })).data.slice(2);
    assert.deepEqual(hidden.map(m => [m.model, m.hidden]), [['haiku', true], ['sonnet', true]], 'from the stored catalog, not a new one');
    assert.equal(calls, 0, 'no SDK catalog call');
    setEnabled(root, true);
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'other'], 'enabled asks the SDK as before');
    assert.equal(calls, 1);
  } finally { clean(root, f); }
});

// ---- F2: resume cannot change a chat's model around hide and disable
test('F2a thread/resume cannot make a hidden model the chat model', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('sonnet'), t = (await f.send(id, 'x')).turn; await f.done(t.id);
    await f.bridge.request('model/list', {}); setVisible(root, ['sonnet']);
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, model: 'haiku', effort: 'none' }), /hidden/, 'control: the settings route refuses');
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, model: 'haiku' }), /hidden/);
    assert.equal(f.bridge.records.get(id).model, 'sonnet');
    const s = await f.send(id, 'still sonnet'); await f.done(s.turn.id);
    assert.equal(f.queries.at(-1).record.model, 'sonnet');
    assert.equal((await f.bridge.request('thread/resume', { threadId: id, model: 'sonnet' })).model, 'sonnet', 'naming its own model is a true reopen');
  } finally { clean(root, f); }
});
test('F2b thread/resume while disabled does not flip a GPT chat to Claude', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'), t = (await f.send(id, 'x')).turn; await f.done(t.id);
    await f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' }); setEnabled(root, false);
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, model: 'sonnet' }), /disabled/);
    const r = f.bridge.records.get(id);
    assert.equal(r.provider, 'native'); assert.equal(r.model, 'gpt-test');
    const g = await f.send(id, 'still gpt'); assert.equal((await f.done(g.turn.id)).params.turn.status, 'completed');
  } finally { clean(root, f); }
});
test('F2c thread/resume while disabled does not change the Claude model of a retained chat', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'), t = (await f.send(id, 'x')).turn; await f.done(t.id); setEnabled(root, false);
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, model: 'sonnet' }), /disabled/);
    assert.equal(f.bridge.records.get(id).model, 'haiku');
    assert.equal((await f.bridge.request('thread/resume', { threadId: id })).model, 'haiku', 'a plain reopen still works');
  } finally { clean(root, f); }
});

// ---- GPT stays usable
test('O2 GPT works while disabled: default start, new chat, move from Claude, native result, native queue', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'); const t = (await f.send(id, 'x')).turn; await f.done(t.id);
    const n = f.queries.length; setEnabled(root, false);
    const started = await f.bridge.request('thread/start', { cwd: f.statePath }); assert.equal(started.model, 'gpt-test');
    const dflt = started.thread.id, a = await f.send(dflt, 'NATIVE_DEFAULT');
    assert.equal((await f.done(a.turn.id)).params.turn.status, 'completed');
    assert.ok(f.hosts.get(dflt).thread.turns.at(-1).items.some(i => i.text === 'NATIVE RESULT'));
    await f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
    const m = await f.send(id, 'MOVED'); assert.equal((await f.done(m.turn.id)).params.turn.status, 'completed');
    const rec = f.bridge.records.get(id);
    assert.equal(rec.provider, 'native'); assert.ok(rec.turns.at(-1).items.some(i => i.text === 'NATIVE RESULT')); assert.equal(rec.turns[0].id, t.id, 'Claude prefix retained');
    assert.equal(f.queries.length, n);
    const add = (await q(f, id, 'add', { clientUserMessageId: 'GPTQ', input: text('gpt queued') })).queuedSubmission;
    const qs = await q(f, id, 'start', { queuedSubmissionId: add.id });
    assert.equal((await f.done(qs.turn.id)).params.turn.status, 'completed'); assert.equal(f.queries.length, n, 'a GPT queue is not gated');
  } finally { clean(root, f); }
});

// ---- Admission matrix
test('O3 every idle new-Claude route refuses while disabled with no query, no record change and no consumed queue', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'), caller = await f.start('haiku');
    const t = (await f.send(id, 'x')).turn; await f.done(t.id);
    const add = (await q(f, id, 'add', { clientUserMessageId: 'Q-IDLE', input: text('later') })).queuedSubmission;
    const unmanaged = (await f.bridge.request('thread/start', { model: 'gpt-test', cwd: f.statePath })).thread.id;
    const n = f.queries.length, rec = () => JSON.stringify(f.bridge.records.get(id));
    setEnabled(root, false); const snap = rec();
    await assert.rejects(f.bridge.request('thread/start', { model: 'haiku', cwd: f.statePath }), /disabled/);
    await assert.rejects(f.send(id, 'n'), /disabled/);
    await assert.rejects(f.send(id, 'n', { model: 'sonnet' }), /disabled/);
    await assert.rejects(f.send(id, 'n', { collaborationMode: { mode: 'default', settings: { model: 'sonnet', reasoning_effort: 'high', developer_instructions: null } } }), /disabled/);
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, model: 'sonnet' }), /disabled/);
    await assert.rejects(f.bridge.request('thread/fork', { threadId: id }), /disabled/);
    await assert.rejects(q(f, id, 'start', { queuedSubmissionId: add.id }), /disabled/);
    await assert.rejects(q(f, id, 'start'), /disabled/);
    for (const m of ['turn/start', 'thread/settings/update', 'thread/resume'])
      await assert.rejects(f.bridge.request(m, { threadId: unmanaged, model: 'haiku', input: text('a'), clientUserMessageId: 'A1' }), /disabled/, `adoption ${m}`);
    assert.equal(f.bridge.records.has(unmanaged), false, 'not adopted');
    const tool = (tl, a) => sessionCall(f.bridge, { threadId: caller, turnId: 'x', tool: tl, arguments: a });
    await assert.rejects(tool('manage', { operation: 'create', model: 'haiku', text: 'hi', requestId: 'req-create-1' }), /disabled/);
    await assert.rejects(tool('manage', { operation: 'send', threadId: id, text: 'hi', requestId: 'req-send-1' }), /disabled/);
    await assert.rejects(tool('manage', { operation: 'start_queue', threadId: id }), /disabled/);
    await assert.rejects(tool('manage', { operation: 'fork', threadId: id, requestId: 'req-fork-1' }), /disabled/);
    assert.equal((await tool('read', { operation: 'list' })).data.some(r => r.threadId === id), true);
    assert.equal(f.queries.length, n); assert.deepEqual((await q(f, id, 'list')).data, [add]);
    const after = JSON.parse(rec()), base = JSON.parse(snap);
    delete after.sessionForks; delete base.sessionForks;
    assert.deepEqual(after.turns, base.turns); assert.equal(after.model, base.model); assert.equal(after.provider, base.provider);
  } finally { clean(root, f); }
});
test('O3r revert (a data-only edit) stays available and starts nothing while disabled', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku');
    const a = (await f.send(id, 'a')).turn; await f.done(a.id); const b = (await f.send(id, 'b')).turn; await f.done(b.id);
    const n = f.queries.length; setEnabled(root, false);
    await f.bridge.request('thread/revert', { threadId: id, beforeTurnId: b.id });
    assert.deepEqual(f.bridge.records.get(id).turns.map(t => t.id), [a.id]); assert.equal(f.queries.length, n);
  } finally { clean(root, f); }
});
test('O3a an admitted turn finishes after disable, and new steering into it stays one query', async () => {
  const { root, f } = setup(), gate = deferred(); let turn; try {
    const id = await f.start('haiku'); turn = await activeTurn(f, id, gate); setEnabled(root, false);
    await f.bridge.request('turn/steer', { threadId: id, expectedTurnId: turn.id, input: text('S'), clientUserMessageId: 'S-1' }); gate.resolve();
    assert.equal((await f.done(turn.id)).params.turn.status, 'completed'); assert.equal(f.queries.length, 1);
    assert.equal(f.bridge.records.get(id).turns[0].steering[0].status, 'delivered');
    await assert.rejects(f.send(id, 'n'), /disabled/); assert.equal(f.queries.length, 1);
  } finally { gate.resolve(); clean(root, f); }
});

// ---- F1: queued steering is queued-start work on all four routes
for (const [label, route] of [
  ['queue/start with id', (f, id, turn, sub) => q(f, id, 'start', { queuedSubmissionId: sub.id })],
  ['queue/start head', (f, id) => q(f, id, 'start')],
  ['session manage start_queue', (f, id, turn, sub, caller) => sessionCall(f.bridge, { threadId: caller, turnId: 'x', tool: 'manage', arguments: { operation: 'start_queue', threadId: id } })],
  ['turn/steer naming the queued message', (f, id, turn, sub) => f.bridge.request('turn/steer', { threadId: id, expectedTurnId: turn.id, input: sub.input, clientUserMessageId: sub.clientUserMessageId })],
]) for (const [state, disable] of [['disabled', root => setEnabled(root, false)], ['unreadable', root => writeFileSync(join(root, storeFile), '{broken', { mode: 0o600 })]])
  test(`F1 ${label} does not consume paused queued work into an active turn while ${state}`, async () => {
    const { root, f } = setup(), gate = deferred(); let turn; try {
      const caller = await f.start('haiku'), id = await f.start('haiku'); turn = await activeTurn(f, id, gate);
      f.controls.messages = undefined; // nothing is steered, so the default stream (answer, result) ends the turn
      const sub = (await q(f, id, 'add', { clientUserMessageId: 'Q-ACTIVE', input: text('MUST_STAY_QUEUED') })).queuedSubmission;
      disable(root);
      await assert.rejects(route(f, id, turn, sub, caller), state === 'disabled' ? /disabled/ : /could not be read safely/);
      assert.deepEqual((await q(f, id, 'list')).data, [sub], 'the queued message is kept');
      assert.equal(f.bridge.records.get(id).turns.at(-1).steering, undefined, 'no steering receipt was created');
      gate.resolve(); assert.equal((await f.done(turn.id)).params.turn.status, 'completed');
      assert.equal(f.queries.length, 1, 'only the running turn made a query: the queued message reached no SDK input');
      assert.deepEqual((await q(f, id, 'list')).data, [sub], 'and it is still queued after the turn ended');
    } finally { gate.resolve(); clean(root, f); }
  });
test('F1 the decision is checked again just before the queued message is committed, after its input is prepared', async () => {
  const { root, f } = setup(), gate = deferred(); let turn; try {
    const id = await f.start('haiku'); turn = await activeTurn(f, id, gate);
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'Q-LATE', input: text('MUST_STAY_QUEUED') })).queuedSubmission;
    // Input preparation awaits; the decision changes while it does.
    f.controls.messages = undefined;
    const pending = f.bridge.request('turn/steer', { threadId: id, expectedTurnId: turn.id, input: sub.input, clientUserMessageId: sub.clientUserMessageId });
    setEnabled(root, false);
    await assert.rejects(pending, /disabled/);
    assert.deepEqual((await q(f, id, 'list')).data, [sub]);
  } finally { gate.resolve(); if (turn) await f.done(turn.id).catch(() => {}); clean(root, f); } // the admitted turn is still saving
});
test('F1 replays stay idempotent: a repeated start or steer of an already accepted queued message is not refused after disable', async () => {
  const { root, f } = setup(), gate = deferred(); let turn; try {
    const id = await f.start('haiku'); turn = await activeTurn(f, id, gate);
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'Q-ONCE', input: text('ACCEPTED') })).queuedSubmission;
    const first = await q(f, id, 'start', { queuedSubmissionId: sub.id });
    setEnabled(root, false);
    assert.equal((await q(f, id, 'start', { queuedSubmissionId: sub.id })).turn.id, first.turn.id);
    assert.equal((await f.bridge.request('turn/steer', { threadId: id, expectedTurnId: turn.id, input: sub.input, clientUserMessageId: sub.clientUserMessageId })).turnId, turn.id);
    assert.deepEqual((await q(f, id, 'list')).data, []);
    gate.resolve(); await f.done(turn.id);
    assert.equal(f.bridge.records.get(id).turns[0].steering.length, 1, 'accepted exactly once');
  } finally { gate.resolve(); clean(root, f); }
});
test('F1g control: a GPT chat queue/start while its native turn is active still steers', async () => {
  const { root, f } = setup(), hold = deferred(); try {
    f.controls.nativeTurn = () => hold.promise;
    const id = await f.start('haiku'), first = (await f.send(id, 'c')).turn; await f.done(first.id);
    await f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
    const nt = (await f.send(id, 'gpt')).turn;
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'GQ', input: text('g') })).queuedSubmission;
    setEnabled(root, false);
    const r = await q(f, id, 'start', { queuedSubmissionId: sub.id }); assert.equal(r.turn.id, nt.id);
    hold.resolve(); await f.done(nt.id);
  } finally { hold.resolve(); clean(root, f); }
});

// ---- F4: the provider-disable pause is durable until an explicit start
test('F4a a slow exclusive operation outliving disable, completion and re-enable does not replay the queue', async () => {
  const { root, f } = setup(), gate = deferred(), hold = deferred(), entered = deferred(); let turn; try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'Q-RACE', input: text('NO_REPLAY') });
    f.controls.native = async m => { if (m === 'thread/resume') { entered.resolve(); await hold.promise; } };
    const resuming = f.bridge.request('thread/resume', { threadId: id }); await entered.promise;
    setEnabled(root, false); f.controls.query = undefined; gate.resolve();
    assert.equal((await f.done(turn.id)).params.turn.status, 'completed'); await ticks();
    assert.equal(f.queries.length, 1, 'paused at completion');
    setEnabled(root, true); await ticks(); assert.equal(f.queries.length, 1, 're-enable alone does nothing');
    f.controls.native = undefined; hold.resolve(); await resuming; await ticks(80);
    assert.equal(f.queries.length, 1, 'no automatic replay'); assert.equal(f.bridge.records.get(id).queue.length, 1);
  } finally { gate.resolve(); hold.resolve(); clean(root, f); }
});
test('F4b after re-enable a new ordinary message does not silently drain work paused by disable; an explicit start does, once', async () => {
  const { root, f } = setup(), gate = deferred(); let turn; try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; turn = (await f.send(id, 'running')).turn;
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'Q-DRAIN', input: text('PAUSED') })).queuedSubmission;
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    setEnabled(root, true); await ticks();
    const s = await f.send(id, 'NEW_EXPLICIT'); await f.done(s.turn.id); await ticks(80);
    assert.deepEqual((await q(f, id, 'list')).data, [sub], 'the paused item stays'); assert.equal(f.queries.length, 2);
    const started = await q(f, id, 'start', { queuedSubmissionId: sub.id }); await f.done(started.turn.id);
    assert.equal(f.queries.length, 3); assert.deepEqual((await q(f, id, 'list')).data, [], 'consumed exactly once');
  } finally { gate.resolve(); clean(root, f); }
});
test('F4c a message queued while disabled waits for an explicit start even after re-enable and a later turn', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'); const t = (await f.send(id, 'x')).turn; await f.done(t.id);
    setEnabled(root, false);
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'Q-OFF', input: text('QUEUED_OFF') })).queuedSubmission;
    setEnabled(root, true);
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(80);
    assert.deepEqual((await q(f, id, 'list')).data, [sub]); assert.equal(f.queries.length, 2, 'not drained');
    const started = await q(f, id, 'start', { queuedSubmissionId: sub.id }); await f.done(started.turn.id);
    assert.equal(f.queries.length, 3);
  } finally { clean(root, f); }
});
test('F4d the pause survives a restart, and an emptied queue clears it so later queued work behaves as before', async () => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; await f.send(id, 'running'); await ticks();
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'Q-RS', input: text('RESTORED') })).queuedSubmission;
    setEnabled(root, false); gate.resolve(); f.controls.query = undefined; await ticks(80);
    assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
    f.restart(); setEnabled(root, true); await ticks();
    assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled', 'durable');
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(60);
    assert.deepEqual((await q(f, id, 'list')).data, [sub]);
    await q(f, id, 'delete', { queuedSubmissionId: sub.id });
    assert.equal(f.bridge.records.get(id).queuePaused, undefined, 'an empty queue clears it');
    const later = (await q(f, id, 'add', { clientUserMessageId: 'Q-LATER', input: text('normal again') })).queuedSubmission;
    const n = f.queries.length; const t = await f.send(id, 'trigger'); await f.done(t.turn.id); await ticks(150);
    assert.deepEqual((await q(f, id, 'list')).data, [], `the queued ${later.id} drained normally once the pause was cleared`);
    assert.equal(f.queries.length, n + 2);
  } finally { gate.resolve(); clean(root, f); }
});

// ---- F12 / F13: the last checks
test('F12 hide applied while a new model choice is being prepared applies at the last check', async () => {
  const { root, f } = setup(), hold = deferred(), entered = deferred(); try {
    const id = await f.start('sonnet'), t = (await f.send(id, 'x')).turn; await f.done(t.id); f.bridge.loaded.delete(id);
    f.controls.native = async m => { if (m === 'thread/resume') { entered.resolve(); await hold.promise; } };
    const pending = f.send(id, 'switch', { model: 'haiku', effort: 'none' }); await entered.promise;
    setVisible(root, ['sonnet']); f.controls.native = undefined; hold.resolve();
    await assert.rejects(pending, /hidden/); assert.equal(f.bridge.records.get(id).model, 'sonnet');
  } finally { hold.resolve(); clean(root, f); }
});
test('R2 disable during real asynchronous preparation (no admit callback) refuses', async () => {
  const { root, f } = setup(), hold = deferred(), entered = deferred(); try {
    const id = await f.start('sonnet'), t = (await f.send(id, 'x')).turn; await f.done(t.id); f.bridge.loaded.delete(id); const n = f.queries.length;
    f.controls.native = async m => { if (m === 'thread/resume') { entered.resolve(); await hold.promise; } };
    const pending = f.send(id, 'n'); await entered.promise;
    setEnabled(root, false); f.controls.native = undefined; hold.resolve();
    await assert.rejects(pending, /disabled/); assert.equal(f.queries.length, n); assert.equal(f.bridge.records.get(id).turns.length, 1);
  } finally { hold.resolve(); clean(root, f); }
});
test('F13 a create refused because the policy changed during approval leaves no uncertain receipt: the same requestId works once after re-enable', async () => {
  const { root, f } = setup(); let resumed; try {
    // The native host reports the approval policy the chat was started with, so the retried create
    // can show the same permissions as its caller (the production same-permission check stays strict).
    f.controls.honorApprovalPolicy = true;
    const caller = await f.start('haiku'); f.bridge.records.get(caller).approvalPolicy = 'on-request';
    const args = { operation: 'create', model: 'haiku', text: 'hi', requestId: 'req-create-race' }, real = f.bridge.desktop;
    const created = () => [...f.bridge.records.values()].filter(r => r.sessionCreate?.requestId === 'req-create-race');
    const queries = f.queries.length, starts = f.calls.filter(c => c.method === 'thread/start').length;
    f.bridge.desktop = { notify: real.notify, request: async () => { setEnabled(root, false); return { action: 'accept', content: { approve: true } }; } };
    let first, second;
    try { await sessionCall(f.bridge, { threadId: caller, turnId: 'x', tool: 'manage', arguments: args }); } catch (e) { first = e; }
    assert.match(first?.message ?? '', /disabled/);
    assert.deepEqual([created().length, f.queries.length, f.calls.filter(c => c.method === 'thread/start').length], [0, queries, starts], 'refused before anything was reserved or started');
    setEnabled(root, true); f.bridge.desktop = { notify: real.notify, request: async () => ({ action: 'accept', content: { approve: true } }) };
    try { resumed = await sessionCall(f.bridge, { threadId: caller, turnId: 'x', tool: 'manage', arguments: args }); } catch (e) { second = e; }
    assert.equal(second, undefined, `the retry was ${second?.message}`);
    // Created exactly once, with the caller's permissions, and exactly one first message, which is waited for.
    assert.equal(created().length, 1); const [chat] = created();
    assert.equal(chat.approvalPolicy, 'on-request'); assert.equal(chat.archived, false);
    assert.equal(f.calls.filter(c => c.method === 'thread/start').length, starts + 1);
    assert.ok(resumed?.turn?.id, 'the retry returned the accepted first turn');
    assert.equal((await f.done(resumed.turn.id)).params.turn.status, 'completed');
    assert.equal(chat.turns.length, 1); assert.equal(f.queries.length, queries + 1, 'one first message');
    assert.match(JSON.stringify(chat.turns[0].items[0]), /"hi"/, 'the first message is the requested text');
  } finally { if (resumed?.turn?.id) await f.done(resumed.turn.id).catch(() => {}); clean(root, f); }
});
test('H1 hide is not disable: an existing enabled chat continues, including its queue', async () => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'), a = (await f.send(id, 'a')).turn; await f.done(a.id); setVisible(root, ['sonnet']);
    const b = (await f.send(id, 'b')).turn; await f.done(b.id); assert.equal(f.queries.at(-1).record.model, 'haiku');
    const qq = (await q(f, id, 'add', { clientUserMessageId: 'HQ', input: text('h') })).queuedSubmission;
    const c = await q(f, id, 'start', { queuedSubmissionId: qq.id }); await f.done(c.turn.id);
    await assert.rejects(f.start('haiku'), /hidden/); assert.ok(await f.start('sonnet'));
    assert.equal((await f.bridge.request('thread/resume', { threadId: id })).thread.id, id);
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'sonnet']);
  } finally { clean(root, f); }
});

// ---- F8 / F9 on the Bridge
test('F8 a catalog the store rejects is not offered and not selectable: excess models and repeated ids', async () => {
  const { root, f } = setup(); try {
    f.bridge.modelPromise = null; f.bridge.getModels = async () => Array.from({ length: 65 }, (_, i) => ({ value: `claude-x-${i}` }));
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other']);
    assert.equal(readConnections(root).store.connections.claude_code.evidence.catalog, 'failed');
    await assert.rejects(f.start('claude-x-1'), /more than 64|catalog/i);
    f.bridge.modelPromise = null; f.bridge.getModels = async () => [{ value: 'haiku' }, { value: 'haiku' }];
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other']);
    await assert.rejects(f.start('haiku'), /repeats|catalog/i, 'a repeating catalog is not startable either');
    f.bridge.modelPromise = null; f.bridge.getModels = async () => [{ value: 'haiku' }];
    assert.ok(await f.start('haiku'), 'a valid catalog works again: the failure was not cached');
  } finally { clean(root, f); }
});
test('F9 a stale lock cannot stall the Bridge event loop on the model/list path', async () => {
  const { root, f } = setup(); try {
    await f.bridge.request('model/list', {}); setVisible(root, ['sonnet']);
    writeFileSync(join(root, lockFile), '99999', { mode: 0o600 });
    let beats = 0; const beat = setInterval(() => beats++, 50), t0 = Date.now();
    const list = await f.bridge.request('model/list', {}), elapsed = Date.now() - t0; clearInterval(beat);
    assert.deepEqual(models(list), ['gpt-test', 'gpt-other', 'sonnet'], 'still answers');
    assert.equal(readFileSync(join(root, lockFile), 'utf8'), '99999', 'not reclaimed');
    assert.ok(elapsed < 500, `blocked ${elapsed}ms`);
    // The catalog evidence write on a refresh does not wait either.
    f.bridge.getModels = async () => [{ value: 'haiku' }, { value: 'sonnet' }, { value: 'opus' }];
    const t1 = Date.now(); await f.bridge.refreshCatalog(); assert.ok(Date.now() - t1 < 500);
  } finally { clean(root, f); }
});
test('F10 on the Bridge: a transient partial catalog does not erase the saved visible models', async () => {
  const { root, f } = setup(); try {
    await f.bridge.request('model/list', {}); setVisible(root, ['haiku', 'sonnet']);
    f.bridge.getModels = async () => [{ value: 'sonnet' }]; await f.bridge.refreshCatalog();
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'sonnet'], 'haiku is unavailable now');
    f.bridge.getModels = async () => [{ value: 'haiku' }, { value: 'sonnet' }]; await f.bridge.refreshCatalog();
    assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'haiku', 'sonnet'], 'and returns as chosen');
  } finally { clean(root, f); }
});
