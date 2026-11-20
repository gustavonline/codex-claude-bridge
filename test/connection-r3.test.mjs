import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeDecision, createConnections, defaultStore, setEnabled, storeFile } from '../connections.mjs';
import { fixture } from './support/fixture.mjs';

// Review R2 of 6ff3bd2 (blocking item B1): a queue start must not re-bind the rest of the queue to a generation
// token read AFTER an await. The token is read once, when the start begins, so a disable and re-enable that lands
// while the start is in flight is still a mismatch for what remains queued. RV1 is the native (GPT handoff) path,
// RV2 the Claude path, RV2b the steering call site (a queued message started into a running turn); RV3 and RV3n
// are the controls (the same disable and re-enable once the start has finished, which was always handled).
// Written from the review's description. Fixture seams only: no Claude executable, model, network, FIFO or profile.
// RC13: a runtime switch is a hand-off to a NEW private physical thread, and a chat with a pending queue is not switched (handoff_queue_pending),
// so a Claude-owned queue can no longer be moved to GPT through the router. The GPT cases assert that refusal, then keep the review's scenario on a
// record moved in place before RC13 (`inPlace`, the Bridge's own un-routed model change), whose GPT queue Bridge still runs.
const text = x => [{ type: 'text', text: x }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ticks = (ms = 80) => new Promise(r => setTimeout(r, ms));
const q = (f, id, m, p = {}) => f.bridge.request(`thread/queue/${m}`, { threadId: id, ...p });
const ids = (f, id) => f.bridge.records.get(id).queue.map(x => x.clientUserMessageId);
const cycle = root => { setEnabled(root, false); setEnabled(root, true); }; // a disable nobody was told about
const gptOnly = f => id => f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
const inPlace = f => id => f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' }, { localRouted: true });
async function refused(f, id, request) { // refused whole: the saved chat, its queue, stamp and marker unchanged; nothing native created, started or queued; no link, no query
  const file = join(f.statePath, `${id}.json`), bytes = readFileSync(file), queue = JSON.stringify(f.bridge.records.get(id).queue), n = f.calls.length, k = f.queries.length;
  await assert.rejects(request, { code: 'handoff_queue_pending' });
  assert.ok(readFileSync(file).equals(bytes), 'the saved chat is byte-identical'); assert.equal(JSON.stringify(f.bridge.records.get(id).queue), queue, 'same queue IDs and content');
  assert.deepEqual(f.calls.slice(n).filter(c => ['thread/start', 'turn/start', 'thread/queue/add', 'thread/inject_items'].includes(c.method)), [], 'nothing created, started or queued natively');
  assert.equal(f.bridge.localResponses.readLink(id), null, 'no link'); assert.equal(f.bridge.records.get(id).provider, 'claude'); assert.equal(f.queries.length, k, 'no Claude query');
}
const toGpt = async (f, id) => { await refused(f, id, gptOnly(f)(id)); await refused(f, id, f.send(id, 'gpt', { model: 'gpt-test' })); await inPlace(f)(id); assert.equal(f.bridge.records.get(id).provider, 'native'); };
const ack = () => async function* (a) {
  for await (const m of a.steeringInput) { yield { ...m, isReplay: true }; yield { type: 'result', subtype: 'success', user_message_uuids: [a.promptId, m.uuid] }; break; }
};
function setup(logs = []) { const root = mkdtempSync(join(tmpdir(), 'bridge-r3-')); createConnections(root); return { root, f: fixture('openai', { connectionRoot: root, log: (event, meta) => { logs.push({ event, ...meta }); } }) }; }
const clean = (root, f) => { f.close(); rmSync(root, { recursive: true, force: true }); };
// A Claude chat with one finished turn and an idle queue [A, B], both bound to the current generation.
async function idleQueue(f) {
  const id = await f.start('haiku'), first = (await f.send(id, 'x')).turn; await f.done(first.id);
  for (const name of ['A', 'B']) await q(f, id, 'add', { clientUserMessageId: name, input: text(`MSG_${name}`) });
  return id;
}
// Runs `action` once, synchronously, the first time the bridge announces a queue change after it is armed.
function onQueueChange(f, action) {
  const emit = f.bridge.emit.bind(f.bridge); let armed = false;
  f.bridge.emit = (method, params) => { emit(method, params); if (armed && method === 'thread/queue/changed') { armed = false; action(); } };
  return () => { armed = true; };
}

test('RV1 a queued chat\'s GPT hand-off is refused intact; on a chat moved in place before RC13, a disable and re-enable during the automatic native start of A keeps B from draining on GPT', async () => {
  const { root, f } = setup(); try {
    const id = await idleQueue(f); await toGpt(f, id); let starts = 0;
    // The second native turn/start is the automatic start of A (the first is the ordinary GPT message); the
    // change lands at the start of that RPC, after the last admission check and before its response.
    f.controls.native = async method => { if (method === 'turn/start' && ++starts === 2) cycle(root); };
    const s = await f.send(id, 'ordinary gpt'); await f.done(s.turn.id); await ticks(250);
    const record = f.bridge.records.get(id);
    assert.equal(starts, 2, 'two native starts in all: the ordinary message and A; B was not started');
    assert.deepEqual(ids(f, id), ['B'], 'B stays queued'); assert.equal(record.queuePaused, 'provider_disabled');
    assert.equal(record.turns.length, 3); assert.doesNotMatch(JSON.stringify(record.turns.at(-1)), /MSG_B/, 'B did not run on GPT');
    assert.equal(f.queries.length, 1, 'no Claude query either');
  } finally { clean(root, f); }
});

test('RV2 Claude path: a disable and re-enable right after A is accepted keeps B from starting by itself', async () => {
  const { root, f } = setup(); try {
    const id = await idleQueue(f), n = f.queries.length;
    const arm = onQueueChange(f, () => cycle(root)); arm(); // the first queue change from now is A's acceptance
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(250);
    const record = f.bridge.records.get(id);
    assert.equal(f.queries.length, n + 2, 'the ordinary message and A only');
    assert.deepEqual(ids(f, id), ['B'], 'B stays queued'); assert.equal(record.queuePaused, 'provider_disabled');
    assert.ok(JSON.stringify(record.turns.at(-1)).includes('MSG_A') && !JSON.stringify(record.turns).includes('MSG_B'));
  } finally { clean(root, f); }
});

test('RV2b steering call site: a disable and re-enable while an explicit start of A is folded into a running turn keeps B queued', async () => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await idleQueue(f), n = f.queries.length;
    f.controls.query = () => gate.promise; f.controls.messages = ack();
    const running = (await f.send(id, 'running')).turn; await ticks(30);
    const arm = onQueueChange(f, () => cycle(root)); arm(); // the first queue change from now is A being consumed by the steer
    const sub = f.bridge.records.get(id).queue[0];
    await q(f, id, 'start', { queuedSubmissionId: sub.id });
    f.controls.query = undefined; gate.resolve(); await f.done(running.id); await ticks(250);
    assert.equal(f.queries.length, n + 1, 'only the running turn made a query: A was steered into it, B did not start');
    assert.deepEqual(ids(f, id), ['B']); assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
  } finally { gate.resolve(); clean(root, f); }
});

test('RV3 control: the same disable and re-enable while A is running (the start has finished) pauses B', async () => {
  const { root, f } = setup(), gate = deferred(); try {
    const id = await idleQueue(f), n = f.queries.length; let queries = 0;
    f.controls.query = () => (++queries === 2 ? gate.promise : undefined); // the second query is A
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id);
    for (let i = 0; i < 100 && f.queries.length < n + 2; i++) await ticks(5);
    assert.equal(f.queries.length, n + 2, 'A is running'); const turn = f.bridge.records.get(id).turns.at(-1);
    assert.deepEqual(ids(f, id), ['B']);
    cycle(root); gate.resolve(); await f.done(turn.id); await ticks(250);
    assert.equal(f.queries.length, n + 2); assert.deepEqual(ids(f, id), ['B']); assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
  } finally { gate.resolve(); clean(root, f); }
});

test('RV3n control, native path (refused hand-off, then a chat moved in place before RC13): the same change while A runs on GPT pauses B; with no change the queue continues as before', async () => {
  for (const change of [true, false]) {
    const { root, f } = setup(), hold = deferred(); try {
      const id = await idleQueue(f); await toGpt(f, id); let nativeTurns = 0;
      f.controls.nativeTurn = () => (++nativeTurns === 2 ? hold.promise : undefined); // the second native turn is A
      const s = await f.send(id, 'ordinary gpt'); await f.done(s.turn.id);
      for (let i = 0; i < 100 && nativeTurns < 2; i++) await ticks(5);
      assert.equal(nativeTurns, 2, 'A is running'); const turn = f.bridge.records.get(id).turns.at(-1);
      if (change) cycle(root);
      hold.resolve(); f.controls.nativeTurn = undefined; await f.done(turn.id); await ticks(250);
      assert.deepEqual(ids(f, id), change ? ['B'] : [], change ? 'paused' : 'no change: the queue ran on to the end as before');
      assert.equal(f.bridge.records.get(id).queuePaused, change ? 'provider_disabled' : undefined);
      assert.equal(claudeDecision(root).token === null, false);
    } finally { hold.resolve(); clean(root, f); }
  }
});

// ---- Review R3 (second fresh review of 870d988, blocking item B1): at an unknown generation (unreadable or
// earlier-layout store) a queue must keep its Claude provenance. P1 and P4 are the review's counterexamples,
// P1c the control with a readable store, P5 checks that the never-matching stamp and odd saved values cannot
// be taken for a match. Written from the review's description.
const legacyBytes = () => { const store = defaultStore(); delete store.connections.claude_code.disableGeneration; delete store.connections.claude_code.storeId; return Buffer.from(JSON.stringify(store)); };
const writeStore = (root, bytes) => { writeFileSync(join(root, storeFile), bytes, { mode: 0o600 }); chmodSync(join(root, storeFile), 0o600); };

for (const [name, unreadable] of [['P1', true], ['P1c control', false]]) test(`${name}: a Claude-owned queue (its GPT hand-off refused intact) moved in place before RC13 and explicitly started${unreadable ? ' while the store is unreadable' : ' with a readable store'} still holds B after a disable and re-enable while A runs`, async () => {
  const logs = [], { root, f } = setup(logs), hold = deferred(); try {
    const id = await idleQueue(f); await toGpt(f, id); const good = readFileSync(join(root, storeFile));
    if (unreadable) writeStore(root, '{broken');
    f.controls.nativeTurn = () => hold.promise; // A runs on GPT until released
    const sub = f.bridge.records.get(id).queue[0]; const started = await q(f, id, 'start', { queuedSubmissionId: sub.id });
    if (unreadable) writeStore(root, good);
    cycle(root); hold.resolve(); f.controls.nativeTurn = undefined; await f.done(started.turn.id); await ticks(250);
    const record = f.bridge.records.get(id);
    assert.deepEqual(ids(f, id), ['B'], 'B stays queued'); assert.equal(record.queuePaused, 'provider_disabled');
    assert.doesNotMatch(JSON.stringify(record.turns.at(-1)), /MSG_B/, 'B did not run on GPT');
    assert.equal(f.queries.length, 1, 'no Claude query');
    // The log tells the causes apart: an unknown stamp is 'generation_unknown' even once the store is readable again.
    assert.deepEqual(logs.filter(l => l.event === 'queue.pause_marked').map(l => l.cause), [unreadable ? 'generation_unknown' : 'generation_changed']);
  } finally { hold.resolve(); clean(root, f); }
});

test('P4: on an earlier-layout store, a Claude-owned queue is not handed off to GPT (refused intact) and, moved in place before RC13, is not started by an ordinary GPT message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-r3-')), logs = []; writeStore(root, legacyBytes());
  const f = fixture('openai', { connectionRoot: root, log: (event, meta) => { logs.push({ event, ...meta }); } }); try {
    const id = await idleQueue(f); await toGpt(f, id); const n = f.queries.length;
    assert.equal(f.bridge.records.get(id).provider, 'native');
    const s = await f.send(id, 'ordinary gpt'); await f.done(s.turn.id); await ticks(250);
    const record = f.bridge.records.get(id);
    assert.deepEqual(ids(f, id), ['A', 'B'], 'neither queued message was started by anyone'); assert.equal(record.queuePaused, 'provider_disabled');
    assert.equal(record.turns.length, 2, 'the Claude turn and the ordinary GPT turn only'); assert.equal(f.queries.length, n);
    assert.ok(logs.some(l => l.event === 'queue.pause_marked' && l.cause === 'generation_unknown'), 'the log tells an unknown generation from a disable');
    assert.deepEqual(readFileSync(join(root, storeFile)), legacyBytes(), 'the earlier-layout store was only read, never rewritten or migrated');
  } finally { clean(root, f); }
});

test('P5 the never-matching stamp and odd saved stamps are held on both providers (GPT: its hand-off refused, then moved in place before RC13) and cannot be forged into a match', async () => {
  for (const provider of ['claude', 'native']) for (const stamp of ['unknown', null, 7, '', 'none', 'x:1']) {
    const { root, f } = setup(); try {
      const id = await idleQueue(f); if (provider === 'native') await toGpt(f, id);
      const path = join(f.statePath, `${id}.json`), saved = JSON.parse(readFileSync(path, 'utf8'));
      saved.queueGeneration = stamp; delete saved.queuePaused; writeFileSync(path, JSON.stringify(saved), { mode: 0o600 }); f.restart();
      const record = f.bridge.records.get(id);
      assert.equal(record.queuePaused, 'provider_disabled', `${provider} with stamp ${JSON.stringify(stamp)} is held at restore`);
      const n = f.queries.length, s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
      assert.deepEqual(ids(f, id), ['A', 'B'], `${provider} ${JSON.stringify(stamp)}: nothing started by itself`);
      assert.equal(f.queries.length, n + (provider === 'claude' ? 1 : 0));
    } finally { clean(root, f); }
  }
  // A fork never inherits the sentinel.
  const { root, f } = setup(); try {
    const id = await idleQueue(f); const rec = f.bridge.records.get(id); rec.queueGeneration = 'unknown'; rec.queuePaused = 'provider_disabled';
    const child = f.bridge.records.get((await f.bridge.request('thread/fork', { threadId: id })).thread.id);
    assert.deepEqual([child.queue, child.queuePaused, child.queueGeneration], [[], undefined, undefined]);
  } finally { clean(root, f); }
});
