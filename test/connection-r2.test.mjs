import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnections, setEnabled, setVisible, readConnections } from '../connections.mjs';
import { fixture } from './support/fixture.mjs';

// The independent ROUND2 review probes (r2-probes.test.mjs and r2-probes2.test.mjs, review of candidate a94219c),
// ported from the reviewer's historical import path to this source. Every case and assertion is kept as the
// reviewer wrote it: C1-C4 are controls that must keep passing, N1-N4b, N6, N6b and N7 state the contract and
// failed on a94219c, N5 only observes. The only changes are the imports, one helper shared by both files, and the
// lifecycle of N2 (see there). They use only the fixture's seams: no Claude executable, login, model request,
// network, FIFO or real profile. A fixture host is not native or GUI proof.
const text = x => [{ type: 'text', text: x }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ticks = (ms = 80) => new Promise(r => setTimeout(r, ms));
const q = (f, id, m, p = {}) => f.bridge.request(`thread/queue/${m}`, { threadId: id, ...p });
function setup() { const root = mkdtempSync(join(tmpdir(), 'bridge-r2-')); createConnections(root); return { root, f: fixture('openai', { connectionRoot: root }) }; }
const clean = (root, f) => { f.close(); rmSync(root, { recursive: true, force: true }); };
const obs = (t, value) => t.diagnostic('OBSERVED ' + JSON.stringify(value));
const view = (f, id, n) => { const r = f.bridge.records.get(id); return { queue: r.queue?.map(x => x.clientUserMessageId), paused: r.queuePaused ?? null, provider: r.provider, queries: f.queries.length - n, turns: r.turns.length }; };

// ---- Controls: the harness must be able to pass where the repaired path applies.
test('C1 control: completion while disabled, then re-enable, then ordinary message keeps the item (repaired order)', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    setEnabled(root, true); const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks();
    obs(t, view(f, id, 0)); assert.deepEqual(view(f, id, 0).queue, ['A']);
  } finally { gate.resolve(); await ticks(30); clean(root, f); }
});
test('C2 control: resume with a hidden model in collaborationMode refuses; same-model mode reopen while disabled works', async t => {
  const { root, f } = setup(); try {
    const id = await f.start('sonnet'), a = (await f.send(id, 'a')).turn; await f.done(a.id);
    await f.bridge.request('model/list', {}); setVisible(root, ['sonnet']);
    const mode = model => ({ collaborationMode: { mode: 'default', settings: { model, reasoning_effort: 'high', developer_instructions: null } } });
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, ...mode('haiku') }), /hidden/);
    setEnabled(root, false);
    const r = await f.bridge.request('thread/resume', { threadId: id, ...mode('sonnet') });
    assert.equal(r.model, 'sonnet'); assert.equal(f.bridge.records.get(id).model, 'sonnet');
  } finally { clean(root, f); }
});
test('C3 control: after re-enable, explicit queue/start into a running ordinary turn consumes once and ends the pause', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'), a = (await f.send(id, 'x')).turn; await f.done(a.id);
    setEnabled(root, false); const sub = (await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') })).queuedSubmission;
    setEnabled(root, true); f.controls.query = () => gate.promise;
    f.controls.messages = async function* (args) { for await (const m of args.steeringInput) { yield { ...m, isReplay: true }; yield { type: 'result', subtype: 'success', user_message_uuids: [args.promptId, m.uuid] }; break; } };
    const running = (await f.send(id, 'running')).turn; await ticks(20);
    const r = await q(f, id, 'start', { queuedSubmissionId: sub.id }); assert.equal(r.turn.id, running.id);
    assert.equal(f.bridge.records.get(id).queuePaused, undefined); assert.deepEqual((await q(f, id, 'list')).data, []);
    gate.resolve(); await f.done(running.id); obs(t, view(f, id, 0));
    assert.deepEqual(f.bridge.records.get(id).turns.at(-1).steering.map(s => [s.clientUserMessageId, s.status]), [['A', 'delivered']]);
  } finally { gate.resolve(); await ticks(30); clean(root, f); }
});

// ---- N: orderings the suite does not cover. Contract: addendum item 4 "Re-enable does NOT replay queued, uncertain,
// failed or interrupted work; an explicit start is needed. Include restart/restored queue state and the
// completion/re-enable race"; lead disposition: provider-disabled queued work needs an explicit queue/start even after
// a later ordinary message.
test('N1 disable and re-enable both happen before the running turn completes: queued work must wait for an explicit start', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); await ticks(20); setEnabled(root, true); await ticks(20);
    f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks(150);
    const v = view(f, id, 0); obs(t, v); assert.deepEqual([v.queue, v.queries], [['A'], 1]);
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
test('N1b as N1, with an explicit queue/start refused while disabled: the refused item must not then start by itself', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); await assert.rejects(q(f, id, 'start'), /disabled/); obs(t, { afterRefusal: view(f, id, 0) });
    setEnabled(root, true);
    f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks(150);
    const v = view(f, id, 0); obs(t, v); assert.deepEqual([v.queue, v.queries], [['A'], 1]);
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
test('N2 restart while disabled with an interrupted turn and restored queue, then re-enable and an ordinary message: the restored item must wait', async t => {
  const { root, f } = setup(), gate = deferred(); let held; try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; held = (await f.send(id, 'running')).turn; await ticks(20);
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); f.restart(); await ticks(20); // the earlier instance's held query stays held while the new instance is observed
    obs(t, { afterRestart: view(f, id, 0), lastStatus: f.bridge.records.get(id).turns.at(-1).status });
    setEnabled(root, true); f.controls.query = undefined;
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    const v = view(f, id, 0); obs(t, v); assert.deepEqual(v.queue, ['A']);
  } finally { gate.resolve(); if (held) await f.done(held.id).catch(() => {}); await ticks(50); clean(root, f); } // settle the earlier instance's turn before its root goes
});
test('N3 an idle chat whose queued item sat through a disable, with send and queue/start refused, then re-enable and an ordinary message: the item must wait', async t => {
  const { root, f } = setup(); try {
    const id = await f.start('haiku'), a = (await f.send(id, 'x')).turn; await f.done(a.id);
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false);
    await assert.rejects(f.send(id, 'no'), /disabled/); await assert.rejects(q(f, id, 'start'), /disabled/); obs(t, { whileDisabled: view(f, id, 0) });
    setEnabled(root, true);
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    const v = view(f, id, 0); obs(t, v); assert.deepEqual(v.queue, ['A']);
  } finally { await ticks(50); clean(root, f); }
});
test('N4 a durably paused Claude queue on a chat moved to GPT must not drain automatically when the GPT turn completes', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'A', input: text('CLAUDE_INTENDED') })).queuedSubmission;
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    obs(t, { paused: view(f, id, 0) }); assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
    await f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
    const g = await f.send(id, 'ordinary gpt'); await f.done(g.turn.id); await ticks(200);
    const v = view(f, id, 0), r = f.bridge.records.get(id); obs(t, { ...v, ranOn: r.turns.at(-1).provider ?? 'native', lastInput: JSON.stringify(r.turns.at(-1).items[0]).slice(0, 120) });
    assert.deepEqual((await q(f, id, 'list')).data, [sub], 'only an explicit queue/start or an empty queue ends the pause');
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
test('N5 observation: paused [A,B], re-enable, explicit start of A: what happens to B', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    const a = (await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') })).queuedSubmission;
    await q(f, id, 'add', { clientUserMessageId: 'B', input: text('B') });
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    setEnabled(root, true); const st = await q(f, id, 'start', { queuedSubmissionId: a.id }); await f.done(st.turn.id); await ticks(200);
    obs(t, view(f, id, 0));
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
test('N6 a fork of a paused chat has an empty queue and must not inherit the pause', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    setEnabled(root, true);
    const fork = await f.bridge.request('thread/fork', { threadId: id }); const child = fork.thread.id, rec = f.bridge.records.get(child);
    obs(t, { childQueue: rec.queue, childPaused: rec.queuePaused ?? null });
    assert.equal(rec.queuePaused, undefined);
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
test('N7 offered evidence after disable: what model/list actually offers now', async t => {
  const { root, f } = setup(); try {
    await f.bridge.request('model/list', {}); setEnabled(root, false);
    const list = (await f.bridge.request('model/list', {})).data.map(m => m.model);
    const offered = readConnections(root).store.connections.claude_code.evidence.offered?.ids;
    obs(t, { listed: list, offeredEvidence: offered });
    assert.deepEqual(offered, [], 'evidence.offered is documented as what model/list last offered');
  } finally { clean(root, f); }
});

// ---- from r2-probes2.test.mjs
test('C4 control: a GPT chat queue still auto-continues after its native turn while Claude is disabled (GPT stays usable)', async t => {
  const { root, f } = setup(), hold = deferred(); try {
    f.controls.nativeTurn = () => hold.promise;
    const id = await f.start('gpt-test'); const c = await f.start('haiku'), first = (await f.send(c, 'c')).turn; await f.done(first.id);
    await f.bridge.request('thread/settings/update', { threadId: c, model: 'gpt-test', effort: 'low' }); setEnabled(root, false);
    const nt = (await f.send(c, 'gpt')).turn; await q(f, c, 'add', { clientUserMessageId: 'G', input: text('g') });
    hold.resolve(); f.controls.nativeTurn = undefined; await f.done(nt.id); await ticks(200);
    const r = f.bridge.records.get(c); obs(t, { queue: r.queue.length, turns: r.turns.length, paused: r.queuePaused ?? null });
    assert.deepEqual([r.queue.length, r.turns.length, r.queuePaused], [0, 3, undefined]);
  } finally { hold.resolve(); await ticks(50); clean(root, f); }
});
test('N6b the pause a fork inherited blocks the normal automatic queue in the child until its first completion with an empty queue', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    setEnabled(root, true);
    const child = (await f.bridge.request('thread/fork', { threadId: id })).thread.id;
    await q(f, child, 'add', { clientUserMessageId: 'CHILD', input: text('child') });
    const s = await f.send(child, 'ordinary'); await f.done(s.turn.id); await ticks(200);
    const r = f.bridge.records.get(child); obs(t, { queue: r.queue.map(x => x.clientUserMessageId), paused: r.queuePaused ?? null, turns: r.turns.length });
    assert.deepEqual(r.queue, [], 'the child was never disabled while this item was queued: it should behave as an ordinary queue');
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
test('N4b same as N4 but after re-enable while the chat stays on GPT: paused item and later Claude return', async t => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') });
    setEnabled(root, false); f.controls.query = undefined; gate.resolve(); await f.done(turn.id); await ticks();
    await f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
    setEnabled(root, true);
    const g = await f.send(id, 'gpt'); await f.done(g.turn.id); await ticks(200);
    const r = f.bridge.records.get(id); obs(t, { queue: r.queue.length, paused: r.queuePaused ?? null, turns: r.turns.length });
    assert.equal(r.queue.length, 1);
  } finally { gate.resolve(); await ticks(50); clean(root, f); }
});
