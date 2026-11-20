import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { claudeDecision, createConnections, defaultStore, limits, readConnections, setEnabled, setVisible, storeFile } from '../connections.mjs';
import { fixture } from './support/fixture.mjs';

// Bridge-level coverage of the durable disable generation: Claude-owned queued work is bound to the store's
// generation, so a disable that nobody observed (before a restart, in another instance or process, or between a
// check and a commit) still keeps it waiting for an explicit start. Synthetic roots and the fixture's seams only:
// no Claude executable, model, network, FIFO or real profile. A fixture host is not native or GUI proof.
const modulePath = fileURLToPath(new URL('../connections.mjs', import.meta.url));
const text = x => [{ type: 'text', text: x }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ticks = (ms = 80) => new Promise(r => setTimeout(r, ms));
const q = (f, id, m, p = {}) => f.bridge.request(`thread/queue/${m}`, { threadId: id, ...p });
const ids = (f, id) => f.bridge.records.get(id).queue.map(x => x.clientUserMessageId);
const onDisk = (f, id) => JSON.parse(readFileSync(join(f.statePath, `${id}.json`), 'utf8'));
function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-genb-')); createConnections(root); const logs = [];
  return { root, logs, f: fixture('openai', { connectionRoot: root, log: (event, meta) => { logs.push({ event, ...meta }); }, ...extra }) };
}
const clean = (root, ...fs) => { for (const f of fs) f.close(); rmSync(root, { recursive: true, force: true }); };
const cycle = root => { setEnabled(root, false); setEnabled(root, true); }; // a disable nobody was told about
const gptOnly = async (f, id) => f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
// A Claude chat with one finished turn and an idle queue [A].
async function idleQueue(f, ...names) {
  const id = await f.start('haiku'), a = (await f.send(id, 'x')).turn; await f.done(a.id);
  const subs = []; for (const name of names) subs.push((await q(f, id, 'add', { clientUserMessageId: name, input: text(`MSG_${name}`) })).queuedSubmission);
  return { id, subs };
}

test('G-B1 a queue stamped under a generation records it with the chat, and an unchanged generation continues as before', async () => {
  const { root, f } = setup(); try {
    const { id } = await idleQueue(f, 'A');
    assert.equal(onDisk(f, id).queueGeneration, claudeDecision(root).token, 'bound when the queue became nonempty, saved with the chat');
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), [], 'no disable, no pause: the queued message ran');
    assert.equal(onDisk(f, id).queueGeneration, undefined, 'an empty queue holds no stamp');
  } finally { clean(root, f); }
});

test('G-B2 a disable and re-enable while no Bridge ran: the restored queue is paused at restore, saved, and survives a further restart', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A', 'B'); const stamp = onDisk(f, id).queueGeneration, n = f.queries.length;
    cycle(root); f.restart();
    const record = f.bridge.records.get(id);
    assert.equal(record.queuePaused, 'provider_disabled', 'marked when restored, before anything could continue it');
    assert.equal(onDisk(f, id).queuePaused, 'provider_disabled', 'and saved');
    assert.deepEqual(record.queue.map(x => [x.id, x.clientUserMessageId, x.input]), subs.map(x => [x.id, x.clientUserMessageId, x.input]), 'IDs and content kept');
    assert.equal(onDisk(f, id).queueGeneration, stamp, 'the old stamp is kept as evidence, not rewritten');
    f.restart(); assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled', 'durable across another restart');
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), ['A', 'B']); assert.equal(f.queries.length, n + 1, 'only the ordinary message ran');
    const started = await q(f, id, 'start', { queuedSubmissionId: subs[0].id }); await f.done(started.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), [], 'an explicit start resumes the batch once'); assert.equal(f.queries.length, n + 3);
  } finally { clean(root, f); }
});

test('G-B3 two instances share one store: a disable neither saw still pauses both queues, and a child process can be the disabler', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-genb-')); createConnections(root);
  const a = fixture('openai', { connectionRoot: root }), b = fixture('openai', { connectionRoot: root }), gateA = deferred(), gateB = deferred(); try {
    const run = async (f, gate) => {
      const id = await f.start('haiku'); f.controls.query = () => gate.promise; const turn = (await f.send(id, 'running')).turn;
      await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') }); return { id, turn };
    };
    const ra = await run(a, gateA), rb = await run(b, gateB);
    const script = `import { setEnabled } from ${JSON.stringify(modulePath)}; setEnabled(${JSON.stringify(root)}, false); setEnabled(${JSON.stringify(root)}, true);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', d => { stderr += d; }); assert.equal((await once(child, 'exit'))[0], 0, stderr);
    a.controls.query = undefined; b.controls.query = undefined; gateA.resolve(); gateB.resolve();
    await a.done(ra.turn.id); await b.done(rb.turn.id); await ticks(150);
    for (const [f, r] of [[a, ra], [b, rb]]) {
      assert.deepEqual(ids(f, r.id), ['A'], 'kept'); assert.equal(f.queries.length, 1, 'nothing started by itself'); assert.equal(f.bridge.records.get(r.id).queuePaused, 'provider_disabled');
    }
  } finally { gateA.resolve(); gateB.resolve(); await ticks(30); clean(root, a, b); }
});

test('G-B4 a disable and re-enable between the last check and the commit of an automatic start is caught at the commit', async () => {
  const { root, f } = setup(), hold = deferred(), entered = deferred(); try {
    const { id, subs } = await idleQueue(f, 'A'); const n = f.queries.length; let calls = 0;
    // Turn preparation awaits the configuration mirror: the ordinary message passes it, the automatic start of A waits in it.
    f.bridge.mirror = { refresh: async () => { if (++calls === 2) { entered.resolve(); await hold.promise; } } };
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await entered.promise;
    assert.equal(f.bridge.records.get(id).queuePaused, undefined, 'the automatic start had passed its earlier checks');
    cycle(root); hold.resolve(); await ticks(150);
    assert.deepEqual((await q(f, id, 'list')).data, subs, 'refused at the commit'); assert.equal(f.queries.length, n + 1, 'only the ordinary message ran');
    assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled', 'and the pause is saved');
    assert.equal(onDisk(f, id).queuePaused, 'provider_disabled');
  } finally { hold.resolve(); clean(root, f); }
});

test('G-B5 provenance survives a handoff to GPT: an unobserved disable keeps Claude-intended work from draining on a GPT turn', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A'); const n = f.queries.length;
    cycle(root); await gptOnly(f, id);
    assert.equal(f.bridge.records.get(id).provider, 'native'); assert.equal(f.bridge.records.get(id).queuePaused, undefined, 'no marker yet: only the stamp carries the provenance');
    const g = await f.send(id, 'ordinary gpt'); await f.done(g.turn.id); await ticks(200);
    assert.deepEqual((await q(f, id, 'list')).data, subs, 'the Claude-intended item did not run on GPT');
    assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled'); assert.equal(f.queries.length, n, 'no Claude query either');
    assert.equal(f.bridge.records.get(id).turns.at(-1).provider, 'native');
  } finally { clean(root, f); }
});

test('G-B6 a plain GPT queue is not Claude-owned: no stamp, and disables never pause it', async () => {
  const { root, f } = setup(), hold = deferred(); try {
    f.controls.nativeTurn = () => hold.promise;
    const c = await f.start('haiku'), first = (await f.send(c, 'c')).turn; await f.done(first.id); await gptOnly(f, c);
    const nt = (await f.send(c, 'gpt')).turn; await q(f, c, 'add', { clientUserMessageId: 'G', input: text('g') });
    assert.equal(f.bridge.records.get(c).queueGeneration, undefined, 'a queue that becomes nonempty on GPT is not stamped');
    cycle(root); cycle(root);
    hold.resolve(); f.controls.nativeTurn = undefined; await f.done(nt.id); await ticks(200);
    const r = f.bridge.records.get(c); assert.deepEqual([r.queue.length, r.turns.length, r.queuePaused], [0, 3, undefined], 'continued normally');
  } finally { hold.resolve(); clean(root, f); }
});

test('G-B7 an explicit start binds what remains to the current generation, so a later disable pauses it again', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A', 'B', 'C'); const n = f.queries.length;
    cycle(root); const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), ['A', 'B', 'C']);
    const gate = deferred(); f.controls.query = () => gate.promise;
    const started = await q(f, id, 'start', { queuedSubmissionId: subs[0].id });
    assert.equal(f.bridge.records.get(id).queuePaused, undefined, 'an explicit start ends the pause'); assert.equal(f.bridge.records.get(id).queueGeneration, claudeDecision(root).token, 'and binds the rest');
    cycle(root); // a new disable while A runs
    f.controls.query = undefined; gate.resolve(); await f.done(started.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), ['B', 'C'], 'the rest paused again at the new generation'); assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
    assert.equal(f.queries.length, n + 2);
  } finally { clean(root, f); }
});

test('G-B8 an explicit start refused while disabled keeps the pause and the stamp untouched; after re-enable it works once', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A'); const n = f.queries.length, stamp = onDisk(f, id).queueGeneration;
    setEnabled(root, false); await assert.rejects(q(f, id, 'start', { queuedSubmissionId: subs[0].id }), /disabled/);
    assert.equal(onDisk(f, id).queueGeneration, stamp, 'stamp unchanged by a refusal'); setEnabled(root, true);
    assert.deepEqual((await q(f, id, 'list')).data, subs); assert.equal(f.queries.length, n, 're-enable replays nothing');
    const started = await q(f, id, 'start', { queuedSubmissionId: subs[0].id }); await f.done(started.turn.id);
    assert.deepEqual((await q(f, id, 'list')).data, []); assert.equal(f.queries.length, n + 1, 'consumed once');
  } finally { clean(root, f); }
});

test('G-B9 a queue saved before generations existed has no stamp: it waits for an explicit start, keeping IDs, content and history', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A', 'B'); const n = f.queries.length, turns = JSON.stringify(onDisk(f, id).turns);
    const path = join(f.statePath, `${id}.json`), saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.queueGeneration; delete saved.queuePaused; writeFileSync(path, JSON.stringify(saved), { mode: 0o600 }); // the earlier record layout
    f.restart();
    const record = f.bridge.records.get(id);
    assert.equal(record.queuePaused, 'provider_disabled', 'unknown provenance is not proof that nothing was disabled');
    assert.deepEqual(record.queue.map(x => x.id), subs.map(x => x.id)); assert.equal(JSON.stringify(onDisk(f, id).turns), turns, 'history unchanged');
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), ['A', 'B']); assert.equal(f.queries.length, n + 1);
    const started = await q(f, id, 'start', { queuedSubmissionId: subs[0].id }); await f.done(started.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), [], 'an explicit start binds the rest, and the batch runs'); assert.equal(f.queries.length, n + 3);
    // A GPT chat's unstamped queue is not Claude's: restoring it holds nothing.
    const c = await f.start('haiku'), first = (await f.send(c, 'c')).turn; await f.done(first.id); await gptOnly(f, c);
    await q(f, c, 'add', { clientUserMessageId: 'G', input: text('g') }); f.restart();
    assert.equal(f.bridge.records.get(c).queuePaused, undefined); assert.deepEqual(ids(f, c), ['G']);
  } finally { clean(root, f); }
});

test('G-B10 an unreadable store at restore pauses a restored Claude queue durably; repairing the file does not replay it', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A'); const n = f.queries.length, good = readFileSync(join(root, storeFile));
    writeFileSync(join(root, storeFile), '{broken', { mode: 0o600 }); f.restart();
    assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled', 'fail closed when observed');
    await assert.rejects(f.send(id, 'n'), /could not be read safely/); await f.start('gpt-test');
    writeFileSync(join(root, storeFile), good, { mode: 0o600 }); chmodSync(join(root, storeFile), 0o600);
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual((await q(f, id, 'list')).data, subs, 'stays until an explicit start'); assert.equal(f.queries.length, n + 1);
  } finally { clean(root, f); }
});

test('G-B11 an out-of-range or malformed generation on disk is an unreadable store: Claude refused, GPT works, queue paused, nothing repaired', async () => {
  const { root, f } = setup(); try {
    const { id } = await idleQueue(f, 'A');
    const bad = defaultStore(); bad.connections.claude_code.disableGeneration = limits.generation + 1;
    const bytes = Buffer.from(JSON.stringify(bad)); writeFileSync(join(root, storeFile), bytes, { mode: 0o600 }); f.restart();
    assert.equal(readConnections(root).status, 'corrupt');
    assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
    await assert.rejects(f.send(id, 'n'), /could not be read safely/); await assert.rejects(f.start('haiku'), /could not be read safely/);
    const started = await f.bridge.request('thread/start', { cwd: f.statePath }); assert.equal(started.model, 'gpt-test', 'GPT is untouched');
    assert.deepEqual(readFileSync(join(root, storeFile)), bytes, 'not repaired');
  } finally { clean(root, f); }
});

test('G-B12 a store of the earlier layout keeps its enablement, stamps nothing, and holds Claude queues for an explicit start; GPT is untouched', async () => {
  const { root, f, logs } = setup(); try {
    const legacy = defaultStore(); delete legacy.connections.claude_code.disableGeneration; delete legacy.connections.claude_code.storeId;
    const bytes = Buffer.from(JSON.stringify(legacy)); writeFileSync(join(root, storeFile), bytes, { mode: 0o600 });
    const id = await f.start('haiku'), a = (await f.send(id, 'x')).turn; await f.done(a.id); const n = f.queries.length;
    const sub = (await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') })).queuedSubmission;
    assert.equal(f.bridge.records.get(id).queueGeneration, 'unknown', 'no token to bind to: the never-matching sentinel, not a deleted stamp');
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual((await q(f, id, 'list')).data, [sub], 'unknown provenance waits'); assert.equal(f.queries.length, n + 1);
    const started = await q(f, id, 'start', { queuedSubmissionId: sub.id }); await f.done(started.turn.id); assert.equal(f.queries.length, n + 2);
    await f.bridge.request('model/list', {}); // evidence is not written to a store this code does not migrate
    assert.deepEqual(readFileSync(join(root, storeFile)), bytes, 'never rewritten or migrated');
    assert.ok(logs.some(l => l.event === 'connections.record_failed'), 'the refused evidence write is logged, not silent');
    legacy.connections.claude_code.enabled = false; writeFileSync(join(root, storeFile), JSON.stringify(legacy), { mode: 0o600 });
    await assert.rejects(f.send(id, 'n'), /disabled/, 'the earlier store still disables');
    assert.equal((await f.bridge.request('thread/start', { cwd: f.statePath })).model, 'gpt-test');
  } finally { clean(root, f); }
});

test('G-B13 documented limit: an unreadable interval nobody observed cannot manufacture a disable event', async () => {
  const { root, f } = setup(); try {
    const { id } = await idleQueue(f, 'A'); const good = readFileSync(join(root, storeFile));
    writeFileSync(join(root, storeFile), '{broken', { mode: 0o600 }); // corrupt and repaired in place with identical bytes, with no Bridge call in between
    writeFileSync(join(root, storeFile), good, { mode: 0o600 }); chmodSync(join(root, storeFile), 0o600);
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), [], 'no event was recorded, so none can be detected: this is the stated limit');
  } finally { clean(root, f); }
});

test('G-B14 a fork starts with no pause and no stamp, the source queue stays intact, and the child gets its own binding', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A'); cycle(root); f.restart(); // the source is now paused with a stale stamp
    const source = f.bridge.records.get(id), stamp = source.queueGeneration;
    assert.equal(source.queuePaused, 'provider_disabled');
    const child = (await f.bridge.request('thread/fork', { threadId: id })).thread.id, rec = f.bridge.records.get(child);
    assert.deepEqual([rec.queue, rec.queuePaused, rec.queueGeneration], [[], undefined, undefined], 'nothing inherited');
    assert.deepEqual([onDisk(f, child).queuePaused, onDisk(f, child).queueGeneration], [undefined, undefined]);
    assert.deepEqual([source.queue.map(x => x.id), source.queuePaused, source.queueGeneration], [subs.map(x => x.id), 'provider_disabled', stamp], 'source untouched');
    await q(f, child, 'add', { clientUserMessageId: 'CHILD', input: text('child') });
    assert.equal(f.bridge.records.get(child).queueGeneration, claudeDecision(root).token, 'its own current binding');
    const s = await f.send(child, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, child), [], 'the child queue behaves as an ordinary queue');
  } finally { clean(root, f); }
});

test('G-B15 offered evidence follows model/list while disabled and starts no SDK; an unreadable store is not written', async () => {
  const { root, f } = setup(); try {
    await f.bridge.request('model/list', {}); let calls = 0; f.bridge.getModels = async () => { calls++; return []; };
    setEnabled(root, false);
    assert.deepEqual((await f.bridge.request('model/list', {})).data.map(m => m.model), ['gpt-test', 'gpt-other']);
    assert.deepEqual(readConnections(root).store.connections.claude_code.evidence.offered.ids, [], 'the empty offer is the evidence');
    assert.equal(calls, 0, 'no SDK was started');
    setEnabled(root, true); setVisible(root, ['sonnet']); await f.bridge.request('model/list', {});
    assert.deepEqual(readConnections(root).store.connections.claude_code.evidence.offered.ids, ['sonnet']);
    const bytes = Buffer.from('{broken'); writeFileSync(join(root, storeFile), bytes, { mode: 0o600 });
    await f.bridge.request('model/list', {}); assert.deepEqual(readFileSync(join(root, storeFile)), bytes, 'an unreadable store is not repaired');
  } finally { clean(root, f); }
});

test('G-B16 no replay on re-enable, restart, a later ordinary message or a provider switch, whichever order they come in', async () => {
  const { root, f } = setup(); try {
    const { id, subs } = await idleQueue(f, 'A'); const n = f.queries.length;
    setEnabled(root, false); f.restart(); setEnabled(root, true); await ticks(100); f.restart(); await ticks(100);
    await gptOnly(f, id); const g = await f.send(id, 'gpt'); await f.done(g.turn.id); await ticks(100);
    await f.bridge.request('thread/settings/update', { threadId: id, model: 'haiku', effort: 'none' }); const c = await f.send(id, 'claude'); await f.done(c.turn.id); await ticks(150);
    assert.deepEqual((await q(f, id, 'list')).data, subs, 'still queued, same ID and content'); assert.equal(f.queries.length, n + 1, 'only the explicit ordinary Claude message ran');
    const started = await q(f, id, 'start', { queuedSubmissionId: subs[0].id }); await f.done(started.turn.id);
    assert.equal(f.queries.length, n + 2); assert.deepEqual((await q(f, id, 'list')).data, []);
  } finally { clean(root, f); }
});

test('G-B17 a GPT-owned queue handed to Claude is bound at that point: it still continues when nothing was disabled, and waits after an unobserved disable', async () => {
  for (const disable of [false, true]) {
    const { root, f } = setup(); try {
      const id = await f.start('haiku'), first = (await f.send(id, 'c')).turn; await f.done(first.id); await gptOnly(f, id);
      await q(f, id, 'add', { clientUserMessageId: 'G', input: text('queued on GPT') });
      assert.equal(f.bridge.records.get(id).queueGeneration, undefined, 'GPT-owned: no stamp');
      await f.bridge.request('thread/settings/update', { threadId: id, model: 'haiku', effort: 'none' });
      assert.equal(f.bridge.records.get(id).provider, 'claude'); assert.equal(f.bridge.records.get(id).queueGeneration, claudeDecision(root).token, 'bound when it became Claude\'s');
      if (disable) cycle(root); const n = f.queries.length;
      const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
      assert.deepEqual(ids(f, id), disable ? ['G'] : [], disable ? 'paused after the disable' : 'continued as before'); assert.equal(f.queries.length, n + (disable ? 1 : 2));
    } finally { clean(root, f); }
  }
});

test('G-B18 an existing pause marker is honoured before the chat\'s provider: queued while disabled, or a marker-only saved record, then moved to GPT', async () => {
  for (const variant of ['queued while disabled', 'marker-only saved record']) {
    const { root, f } = setup(); try {
      const id = await f.start('haiku'), first = (await f.send(id, 'c')).turn; await f.done(first.id); const n = f.queries.length;
      let sub;
      if (variant === 'queued while disabled') {
        setEnabled(root, false); sub = (await q(f, id, 'add', { clientUserMessageId: 'A', input: text('CLAUDE_INTENDED') })).queuedSubmission; setEnabled(root, true);
        assert.equal(f.bridge.records.get(id).queueGeneration, claudeDecision(root).token, 'the stamp matches the current generation: only the marker holds this queue');
      } else {
        sub = (await q(f, id, 'add', { clientUserMessageId: 'A', input: text('CLAUDE_INTENDED') })).queuedSubmission;
        const path = join(f.statePath, `${id}.json`), saved = JSON.parse(readFileSync(path, 'utf8'));
        delete saved.queueGeneration; saved.queuePaused = 'provider_disabled'; writeFileSync(path, JSON.stringify(saved), { mode: 0o600 }); f.restart();
      }
      await gptOnly(f, id); const g = await f.send(id, 'ordinary gpt'); await f.done(g.turn.id); await ticks(200);
      assert.deepEqual((await q(f, id, 'list')).data, [sub], `${variant}: the Claude-intended item did not run on GPT`);
      assert.equal(f.queries.length, n); assert.equal(f.bridge.records.get(id).turns.at(-1).provider, 'native');
    } finally { clean(root, f); }
  }
});

test('G-B19 without a store the earlier behaviour is kept (queues continue); a store created later is a change a none-stamped queue waits for', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-genb-')); const f = fixture('openai', { connectionRoot: root }); try {
    const id = await f.start('haiku'), a = (await f.send(id, 'x')).turn; await f.done(a.id);
    await q(f, id, 'add', { clientUserMessageId: 'A', input: text('A') }); assert.equal(onDisk(f, id).queueGeneration, 'none');
    const s = await f.send(id, 'ordinary'); await f.done(s.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), [], 'no store, no pause: unchanged behaviour'); assert.equal(readConnections(root).status, 'absent', 'nothing created a store');
    await q(f, id, 'add', { clientUserMessageId: 'B', input: text('B') }); assert.equal(onDisk(f, id).queueGeneration, 'none');
    createConnections(root); // a store appears after the queue was bound to "none"
    const t = await f.send(id, 'ordinary two'); await f.done(t.turn.id); await ticks(150);
    assert.deepEqual(ids(f, id), ['B'], 'held: the token is no longer the one the queue was bound to'); assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
  } finally { clean(root, f); }
});
