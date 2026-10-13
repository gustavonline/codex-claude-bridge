import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './support/fixture.mjs';
import { RpcError } from '../rpc.mjs';
import { messageStream } from '../steering.mjs';

const text = value => [{ type: 'text', text: value }];
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const users = turn => turn.items.filter(i => i.type === 'userMessage').map(i => i.content);
const queue = (f, id, method, params = {}) => f.bridge.request(`thread/queue/${method}`, { threadId: id, ...params });
const steer = (f, id, turn, input = text('correction'), params = {}) => f.bridge.request('turn/steer',
  { threadId: id, expectedTurnId: turn.id, input, clientUserMessageId: randomUUID(), ...params });
const replay = m => ({ ...m, isReplay: true });
const result = ids => ({ type: 'result', subtype: 'success', user_message_uuids: ids });

test('stream closure wakes an empty reader and refuses further delivery', async () => {
  const stream = messageStream(), reader = stream[Symbol.asyncIterator]();
  const waiting = reader.next(); stream.close();
  assert.deepEqual(await waiting, { value: undefined, done: true });
  assert.throws(() => stream.push({}), /no longer accepting/);
});

test('live Claude steering before startup, rapid messages and retries share one turn, with result-bound delivery', async () => {
  const f = fixture(), gate = deferred(), earlyResult = deferred(), finish = deferred(), messages = [];
  try {
    f.controls.query = () => gate.promise;
    f.controls.messages = async function* (args) {
      yield result([args.promptId]); earlyResult.resolve();
      for await (const m of args.steeringInput) {
        messages.push(m); yield replay(m); await finish.promise; yield result([m.uuid]);
      }
    };
    const id = await f.start(), { turn } = await f.send(id, 'initial');
    const request = { clientUserMessageId: randomUUID(), additionalContext: {
      app: { kind: 'application', value: 'application fragment' }, reference: { kind: 'untrusted', value: 'untrusted fragment' },
    } };
    const [a, b] = await Promise.all([steer(f, id, turn, text('first'), request), steer(f, id, turn, text('first'), request)]);
    assert.equal(a.turnId, turn.id); assert.deepEqual(a, b);
    await steer(f, id, turn, text('second'));
    gate.resolve(); await earlyResult.promise;
    assert.ok(f.bridge.active.has(id)); // The result for the original input is not the end.
    finish.resolve(); await f.done(turn.id);
    assert.equal(messages.length, 2); assert.equal(messages[0].priority, 'next');
    assert.match(JSON.stringify(messages[0]), /application fragment/); assert.match(JSON.stringify(messages[0]), /untrusted fragment/);
    const record = f.bridge.records.get(id);
    assert.equal(record.turns.length, 1); assert.deepEqual(users(record.turns[0]), [text('initial'), text('first'), text('second')]);
    assert.ok(record.turns[0].steering.every(s => s.status === 'delivered'));
    const view = await f.bridge.request('thread/read', { threadId: id, includeTurns: true });
    assert.equal(view.thread.turns[0].steering, undefined);
    f.restart();
    assert.equal((await steer(f, id, turn, text('first'), request)).turnId, turn.id);
    assert.equal((await f.send(id, 'first', { clientUserMessageId: request.clientUserMessageId })).turn.id, turn.id);
    await assert.rejects(steer(f, id, turn, text('changed'), request), /different message/);
    await assert.rejects(steer(f, id, turn, text('first'), { ...request, additionalContext: null }), /different message/);
  } finally { gate.resolve(); finish.resolve(); f.close(); }
});

test('queued start while active and direct queued steering consume exactly once, with durable queue retries', async () => {
  const f = fixture(), gate = deferred();
  try {
    f.controls.query = () => gate.promise;
    f.controls.messages = async function* (args) {
      for await (const m of args.steeringInput) { yield replay(m); yield result([m.uuid]); }
    };
    const id = await f.start(), { turn } = await f.send(id);
    const a = (await queue(f, id, 'add', { clientUserMessageId: 'queued-A', input: text('a') })).queuedSubmission;
    const b = (await queue(f, id, 'add', { clientUserMessageId: 'queued-B', input: text('b') })).queuedSubmission;
    const responses = await Promise.all([queue(f, id, 'start', { queuedSubmissionId: a.id }), queue(f, id, 'start', { queuedSubmissionId: a.id })]);
    assert.ok(responses.every(r => r.turn.id === turn.id));
    await steer(f, id, turn, b.input, { clientUserMessageId: b.clientUserMessageId });
    assert.equal((await queue(f, id, 'list')).data.length, 0);
    gate.resolve(); await f.done(turn.id); f.restart();
    assert.equal((await queue(f, id, 'start', { queuedSubmissionId: a.id })).turn.id, turn.id);
    assert.equal((await queue(f, id, 'start', { queuedSubmissionId: b.id })).turn.id, turn.id);
    assert.equal(f.queries.length, 1);
    assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('hello'), a.input, b.input]);
  } finally { gate.resolve(); f.close(); }
});

test('stale, empty, invalid and changed queued input fail without losing the queued message', async () => {
  const f = fixture(), gate = deferred();
  try {
    f.controls.query = () => gate.promise;
    const id = await f.start(), { turn } = await f.send(id);
    const a = (await queue(f, id, 'add', { clientUserMessageId: 'A', input: text('a') })).queuedSubmission;
    for (const [input, params, pattern] of [
      [[], {}, /non-empty/], [text('a'), { expectedTurnId: 'wrong' }, /no longer active/],
      [text('a'), { expectedTurnId: undefined }, /no longer active/],
      [text('changed'), { clientUserMessageId: 'A' }, /changed before/],
      [[{ type: 'localImage', path: join(f.statePath, 'missing.png') }], {}, /ENOENT/],
      [text('a'), { additionalContext: { bad: { kind: 'system', value: 'wrong' } } }, /Invalid Codex/],
    ]) await assert.rejects(steer(f, id, turn, input, params), pattern);
    assert.deepEqual((await queue(f, id, 'list')).data, [a]);
    assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('hello')]);
    await queue(f, id, 'delete', { queuedSubmissionId: a.id });
    gate.resolve(); await f.done(turn.id);
    await assert.rejects(steer(f, id, turn), /no longer active/);
  } finally { gate.resolve(); f.close(); }
});

test('cancellation retains unconfirmed input, pauses remaining queue and rebuilds Claude context on deliberate follow-up', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  try {
    f.controls.query = () => { entered.resolve(); return gate.promise; };
    const id = await f.start(), { turn } = await f.send(id); await entered.promise;
    const a = (await queue(f, id, 'add', { clientUserMessageId: 'A', input: text('unconfirmed') })).queuedSubmission;
    await queue(f, id, 'add', { clientUserMessageId: 'B', input: text('later') });
    await queue(f, id, 'start', { queuedSubmissionId: a.id });
    await f.bridge.request('turn/interrupt', { threadId: id, turnId: turn.id }); gate.resolve(); await f.done(turn.id);
    let record = f.bridge.records.get(id);
    assert.equal(record.turns[0].status, 'interrupted'); assert.equal(record.turns[0].steering[0].status, 'uncertain');
    assert.equal(record.claudeSessionId, undefined); assert.equal(record.queue.length, 1);
    f.restart(); record = f.bridge.records.get(id);
    await assert.rejects(queue(f, id, 'start', { queuedSubmissionId: a.id }), /uncertain/);
    await assert.rejects(steer(f, id, turn, text('unconfirmed'), { clientUserMessageId: 'A' }), /uncertain/);
    await queue(f, id, 'delete', { queuedSubmissionId: record.queue[0].id });
    delete f.controls.query;
    const follow = await f.send(id, 'deliberate follow-up'); await f.done(follow.turn.id);
    assert.match(f.queries.at(-1).additionalContext.bridge_conversation.value, /unconfirmed/);
  } finally { gate.resolve(); f.close(); }
});

test('managed native steering preserves every canonical user message and forwards only once', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  try {
    f.controls.nativeTurn = () => { entered.resolve(); return gate.promise; };
    const id = await f.start(), { turn } = await f.send(id, 'native initial', { model: 'gpt-test' }); await entered.promise;
    const request = { clientUserMessageId: 'native-steer' };
    await steer(f, id, turn, text('native correction'), request);
    await steer(f, id, turn, text('native correction'), request);
    gate.resolve(); await f.done(turn.id);
    assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
    assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('native initial'), text('native correction')]);
    assert.equal((await steer(f, id, turn, text('native correction'), request)).turnId, turn.id);
    const claude = await f.send(id, 'recall', { model: 'haiku' }); await f.done(claude.turn.id);
    assert.match(f.queries.at(-1).additionalContext.bridge_conversation.value, /native correction/);
    const fork = await f.bridge.request('thread/fork', { threadId: id, lastTurnId: turn.id });
    assert.deepEqual(users(fork.thread.turns[0]), [text('native initial'), text('native correction')]);
    await f.bridge.request('thread/revert', { threadId: id, beforeTurnId: turn.id });
    assert.equal(f.bridge.records.get(id).turns.length, 0);
  } finally { gate.resolve(); f.close(); }
});

test('D1 optional native client IDs never duplicate the opening message, including after restart and handoff', async () => {
  for (const clientUserMessageId of [undefined, null]) {
    const f = fixture();
    try {
      const id = await f.start();
      const { turn } = await f.bridge.request('turn/start', { threadId: id, model: 'gpt-test', input: text('UNIQUE_OPENING'), clientUserMessageId });
      await f.done(turn.id);
      assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('UNIQUE_OPENING')]);
      f.restart();
      assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('UNIQUE_OPENING')]);
      const next = await f.send(id, 'handoff', { model: 'haiku' }); await f.done(next.turn.id);
      assert.equal(f.queries.at(-1).additionalContext.bridge_conversation.value.split('UNIQUE_OPENING').length - 1, 1);
    } finally { f.close(); }
  }
});

for (const uncertain of [false, true]) test(`native steering ${uncertain ? 'uncertain transport' : 'explicit rejection'} preserves retry safety`, async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), dispatch = deferred(), release = deferred();
  try {
    f.controls.nativeTurn = () => { entered.resolve(); return gate.promise; };
    const id = await f.start(), { turn } = await f.send(id, 'initial', { model: 'gpt-test' }); await entered.promise;
    const a = (await queue(f, id, 'add', { clientUserMessageId: 'A', input: text('queued') })).queuedSubmission;
    f.controls.native = async method => {
      if (method === 'turn/steer') { dispatch.resolve(); await release.promise; throw new RpcError(uncertain ? 'RPC connection closed' : 'stale turn', uncertain ? -32603 : -32602); }
    };
    const sent = steer(f, id, turn, a.input, { clientUserMessageId: 'A' }); sent.catch(() => {}); await dispatch.promise;
    const retry = steer(f, id, turn, a.input, { clientUserMessageId: 'A' }); retry.catch(() => {});
    await assert.rejects(queue(f, id, 'update', { queuedSubmissionId: a.id, input: text('changed') }), /accepted/);
    release.resolve(); await assert.rejects(sent); await assert.rejects(retry);
    assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
    const record = f.bridge.records.get(id);
    assert.equal(record.queue.length, uncertain ? 0 : 1);
    assert.equal(record.turns[0].steering.length, uncertain ? 1 : 0);
    if (uncertain) await assert.rejects(steer(f, id, turn, a.input, { clientUserMessageId: 'A' }), /uncertain/);
    else await queue(f, id, 'delete', { queuedSubmissionId: a.id });
    gate.resolve(); await f.done(turn.id);
    f.restart();
    if (uncertain) assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('initial'), a.input]);
  } finally { gate.resolve(); release.resolve(); f.close(); }
});

test('steering is persisted before SDK dispatch and recovery never replays unconfirmed delivery', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  try {
    f.controls.query = () => { entered.resolve(); return gate.promise; };
    const id = await f.start(), { turn } = await f.send(id); await entered.promise;
    await steer(f, id, turn, text('retained across crash'), { clientUserMessageId: 'crash-steer' });
    const disk = JSON.parse(readFileSync(join(f.statePath, `${id}.json`), 'utf8'));
    assert.equal(disk.turns[0].steering[0].status, 'accepted');
    // Read the pre-abort durable record through an independent bridge instance.
    const old = f.bridge; f.restart();
    assert.equal(f.bridge.records.get(id).turns[0].steering[0].status, 'uncertain');
    assert.equal(f.bridge.records.get(id).claudeSessionId, undefined);
    assert.equal(f.bridge.active.size, 0);
    old.active.get(id).controller.abort(); gate.resolve();
    await f.done(turn.id);
  } finally { gate.resolve(); f.close(); }
});

test('failed durable acceptance keeps the queue and sends no SDK message', async () => {
  const f = fixture(), gate = deferred();
  try {
    f.controls.query = () => gate.promise;
    const id = await f.start(), { turn } = await f.send(id);
    const a = (await queue(f, id, 'add', { clientUserMessageId: 'A', input: text('durable') })).queuedSubmission;
    const save = f.bridge.save.bind(f.bridge); let pushed = 0;
    f.bridge.active.get(id).steeringInput.push = () => pushed++;
    f.bridge.save = () => { throw new Error('synthetic disk full'); };
    await assert.rejects(queue(f, id, 'start', { queuedSubmissionId: a.id }), /disk full/);
    f.bridge.save = save;
    assert.deepEqual((await queue(f, id, 'list')).data, [a]);
    assert.deepEqual(users(f.bridge.records.get(id).turns[0]), [text('hello')]); assert.equal(pushed, 0);
    await queue(f, id, 'delete', { queuedSubmissionId: a.id });
    gate.resolve(); await f.done(turn.id);
  } finally { gate.resolve(); f.close(); }
});

test('SDK replay fallback and capped result UUID lists cannot strand accepted steering', async () => {
  for (const capped of [false, true]) {
    const f = fixture(), gate = deferred();
    try {
      f.controls.query = () => gate.promise;
      f.controls.messages = async function* (args) {
        for await (const m of args.steeringInput) {
          yield replay(m);
          yield capped ? result(Array.from({ length: 64 }, () => randomUUID())) : { type: 'result', subtype: 'success' };
        }
      };
      const id = await f.start(), { turn } = await f.send(id);
      await steer(f, id, turn); gate.resolve(); await f.done(turn.id);
      assert.equal(f.bridge.records.get(id).turns[0].steering[0].status, 'delivered');
    } finally { gate.resolve(); f.close(); }
  }
});

test('completed native turn with an unconfirmed dispatch recovers conservatively after restart', async () => {
  const f = fixture();
  try {
    const id = await f.start(), { turn } = await f.send(id, 'initial', { model: 'gpt-test' }); await f.done(turn.id);
    const record = f.bridge.records.get(id);
    record.turns[0].steering = [{ clientUserMessageId: 'uncertain-native', input: text('uncertain'), status: 'accepted' }];
    record.turns[0].items.push({ type: 'userMessage', id: 'uncertain-native', content: text('uncertain') }); f.bridge.save(record);
    f.restart();
    assert.equal(f.bridge.records.get(id).turns[0].steering[0].status, 'uncertain');
    await assert.rejects(steer(f, id, turn, text('uncertain'), { clientUserMessageId: 'uncertain-native' }), /uncertain/);
  } finally { f.close(); }
});
