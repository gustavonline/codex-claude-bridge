import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import { ownedProcess, bounded, capabilities } from '../claude.mjs';
import { fixture } from './support/fixture.mjs';

// The Claude adapter's process ownership and boot bound, with real OS children (node itself, never the Claude executable or a model),
// and the Bridge barrier that releases a chat only after its query's child has exited.
const text = x => [{ type: 'text', text: x }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const child = script => ({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env });

test('an owned child that exits on its own is awaited; one that outlives the grace is killed and awaited; an unspawned query waits for nothing', async () => {
  assert.deepEqual(await ownedProcess().exited(), { state: 'none' });
  const quick = ownedProcess({ graceMs: 2000 }); quick.spawnClaudeCodeProcess(child('setTimeout(() => {}, 100)'));
  assert.deepEqual(await quick.exited(), { state: 'exited' }); assert.equal(alive(quick.pid), false);
  const stuck = ownedProcess({ graceMs: 100 }); stuck.spawnClaudeCodeProcess(child('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'));
  const pid = stuck.pid; assert.equal(alive(pid), true);
  assert.deepEqual(await stuck.exited(), { state: 'killed' }); assert.equal(alive(pid), false, 'nothing of it is left running');
});

test('a CLI that never produces its first message fails the turn with a bounded, explicit error and is closed', async () => {
  let closed = 0;
  const session = { close: () => { closed++; }, [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const q = bounded(session, ownedProcess(), { firstMs: 50 });
  await assert.rejects(q.next(), { code: 'claude_start_timeout' }); assert.equal(closed, 1);
  // the SDK's own pending read may reject once it is closed: that must not become an unhandled rejection (which would end the process)
  let rejectLate; const unhandled = []; const onUnhandled = e => unhandled.push(e); process.on('unhandledRejection', onUnhandled);
  const closing = bounded({ close: () => rejectLate(new Error('closed')), [Symbol.asyncIterator]: () => ({ next: () => new Promise((_, reject) => { rejectLate = reject; }) }) }, ownedProcess(), { firstMs: 20 });
  await assert.rejects(closing.next(), { code: 'claude_start_timeout' }); await new Promise(r => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled); assert.deepEqual(unhandled, []);
  // after the first message the stream is the SDK's own, unbounded (a long model turn is normal work, not a fault)
  let n = 0; const next = async () => (++n === 1 ? { value: 'init', done: false } : new Promise(r => setTimeout(() => r({ value: 'late', done: false }), 120)));
  const later = bounded({ close() {}, [Symbol.asyncIterator]: () => ({ next }) }, ownedProcess(), { firstMs: 50 });
  assert.equal((await later.next()).value, 'init'); assert.equal((await later.next()).value, 'late');
  assert.deepEqual([capabilities.nativeTools, capabilities.toolBoundary], [false, 'codex-mcp']);
});

test('interrupt then immediate resend: the chat is released only after the first query\'s child exited, so at most one child exists and each prompt is sent once', async () => {
  const f = fixture(); try {
    const id = await f.start('haiku'), a = (await f.send(id, 'warm')).turn; await f.done(a.id);
    let live = 0, peak = 0; const exits = [], base = f.bridge.runQuery;
    f.bridge.runQuery = args => {
      const stream = base(args), exit = deferred(); live++; peak = Math.max(peak, live); exits.push(exit);
      stream.exited = async () => { await exit.promise; live--; return { state: 'exited' }; };
      return stream;
    };
    const gate = deferred(); f.controls.query = () => gate.promise;
    const first = (await f.send(id, 'FIRST')).turn;
    while (exits.length < 1) await new Promise(r => setTimeout(r, 5)); // the query (and so its child) exists before the interrupt
    await f.bridge.request('turn/interrupt', { threadId: id, turnId: first.id }); gate.resolve(); f.controls.query = undefined;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === first.id), false, 'not completed while its child still runs');
    await assert.rejects(f.send(id, 'RESEND'), /already running/, 'a resend cannot start a second child on the same session');
    // The rest of the window, as docs/harnesses.md states it: no steer, no queue start; a message can still be queued.
    await assert.rejects(f.bridge.request('turn/steer', { threadId: id, expectedTurnId: first.id, input: text('steer') }), /no longer active|accepting steering/);
    const waiting = (await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'QUEUED-IN-WINDOW', input: text('QUEUED') })).queuedSubmission;
    await assert.rejects(f.bridge.request('thread/queue/start', { threadId: id, queuedSubmissionId: waiting.id }), /no longer active|accepting steering/);
    exits[0].resolve(); await f.done(first.id);
    const second = (await f.send(id, 'RESEND')).turn; while (exits.length < 2) await new Promise(r => setTimeout(r, 5)); exits[1].resolve(); await f.done(second.id);
    assert.equal(peak, 1, 'never two children');
    // The message queued in the window is not started by the interrupted turn's end; it runs once, after the next completed turn.
    // Bounded waits with a diagnostic: the queued turn's own synthetic child is released explicitly, then the chat must settle.
    const until = async (ok, what) => { for (let i = 0; i < 1000 && !ok(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(ok(), `${what}: ${JSON.stringify(f.bridge.records.get(id).turns.map(t => t.status))}, children ${exits.length}, active ${f.bridge.active.has(id)}`); };
    await until(() => exits.length >= 3, 'the queued message started its own child'); exits[2].resolve();
    await until(() => !f.bridge.active.has(id), 'the queued turn settled');
    assert.equal(peak, 1, 'never two children, the queued turn included');
    assert.deepEqual(f.bridge.records.get(id).turns.map(t => [t.status, t.items.find(i => i.type === 'userMessage').content[0].text]).slice(1, 4),
      [['interrupted', 'FIRST'], ['completed', 'RESEND'], ['completed', 'QUEUED']]);
    assert.deepEqual(f.bridge.records.get(id).queue, []); assert.equal(f.bridge.records.get(id).turns.find(t => t.id === first.id).status, 'interrupted');
    const sent = f.queries.map(q => q.input?.[0]?.text); assert.deepEqual(sent.filter(t => t === 'FIRST' || t === 'RESEND'), ['FIRST', 'RESEND']);
  } finally { f.close(); }
});

test('a real spawned process is reaped through the SDK-shaped spawn hook with the SDK\'s forwarded signal', async () => {
  const controller = new AbortController(), owned = ownedProcess({ graceMs: 3000, spawnProcess: spawn });
  owned.spawnClaudeCodeProcess({ ...child('setInterval(() => {}, 1000)'), signal: controller.signal });
  const pid = owned.pid; controller.abort();
  assert.deepEqual(await owned.exited(), { state: 'exited' }); assert.equal(alive(pid), false);
});

test('a CLI that fails still reports why: its stderr, even a chunk arriving after the exit, is appended to the SDK error as the SDK does for its own spawn', async () => {
  const { EventEmitter } = await import('node:events');
  const fake = () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4242; c.exitCode = null; c.signalCode = null; c.kill = () => true; return c; };
  let c; const owned = ownedProcess({ spawnProcess: () => (c = fake()) }); owned.spawnClaudeCodeProcess(child(''));
  c.stderr.emit('data', Buffer.from('No conversation found ')); c.exitCode = 1; c.emit('exit', 1, null); // the SDK raises its error on this plain exit
  setTimeout(() => { c.stderr.emit('data', Buffer.from('with session ID: x\n')); c.stderr.emit('close'); }, 30); // the last chunk comes later
  const failing = bounded({ close() {}, [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('Claude Code process exited with code 1'); } }) }, owned, { firstMs: 1000 });
  await assert.rejects(failing.next(), e => e.message === 'Claude Code process exited with code 1. stderr: No conversation found with session ID: x');
  // a Stop is not explained with stderr: the SDK's own AbortError (whose name is 'Error') is recognised by its class
  const aborted = bounded({ close() {}, [Symbol.asyncIterator]: () => ({ next: async () => { throw new AbortError('Claude Code process aborted by user'); } }) }, owned, { firstMs: 1000 });
  await assert.rejects(aborted.next(), e => e.message === 'Claude Code process aborted by user');
});
