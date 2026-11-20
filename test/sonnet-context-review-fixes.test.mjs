// Focused regressions for the two findings of the cumulative review of b683358 (child-disabled, no real model, no real native process):
//  1. the SDK's last-safe-point budget counts EVERYTHING the query really carries in ONE check (actual system instructions + the untrusted context claude.inputContent serializes beside the input
//     + the input + the output schema + the reserves), not the instructions alone;
//  2. an existing MANAGED NATIVE chat that carries a model-change note makes its dispatch durable BEFORE it is sent and, after an unknown outcome (also across a restart), is HELD until the public
//     record positively shows its client message id.
// They go through the real Bridge (request -> prepareTurn -> run / beginNative) with the shared fixture's injected SDK / native host.
//
// MUTATION SENSITIVITY (for a throwaway QA copy; never the working tree). Each mutant must make the named tests FAIL:
//   M1  bridge.mjs, the combined check in run(): delete the `+ (untrusted.length ? estimateTokens(untrusted) : 0)` term (the old check, instructions only)
//       -> 'SDK combined budget: each component alone fits ... the combination is refused' fails (a query is dispatched).
//   M2  native-turns.mjs beginNative: delete the `if (notice) { record.nativeAttempt = ...; bridge.save(record) }` block (no durable attempt)
//       -> 'managed native: an unknown dispatch ...' fails (nothing is held after the restart; a second turn/start is sent), and 'failed critical persistence' fails.
//   M3  bridge.mjs prepareTurn: delete `await this.resolveNativeAttempt(record);`
//       -> the same tests fail (the held cases send a turn/start).
//   M4  bridge.mjs resolveNativeAttempt: replace `if (!match) throw hold();` by clearing the attempt (absence read as "not accepted")
//       -> the 'other ids / read failure / stuck cursor' holds fail.
//   M5  native-turns.mjs: clear the attempt on ANY thrown error instead of only `neverSent(error)`
//       -> the 'lost response' test fails (no attempt remains after the lost response).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { Peer, neverSent } from '../rpc.mjs';
import { fixture } from './support/fixture.mjs';

// ---- 1. the SDK's combined actual input ---------------------------------------------------------------------------------------------------------------------------
const earlier = (n, text) => ({ id: 'old-' + n, status: 'completed', provider: 'imported', items: [{ type: 'userMessage', id: 'ou' + n, clientId: null, content: [{ type: 'text', text }] }, { type: 'agentMessage', id: 'oa' + n, text: 'ack ' + n }] });
// A chat that was handed history (no SDK session yet: its first query carries it as UNTRUSTED context) with `instructions` characters of trusted instructions, on a known 100,000-token window.
function carriedChat(f, { history, instructions }) {
  return f.start('sonnet').then(id => {
    const record = f.bridge.records.get(id);
    Object.assign(record, { runtimeWorkspaceRoots: [f.statePath], instructionSources: [join(f.statePath, 'AGENTS.md')], claudeSessionId: null, modeInstructions: 'm'.repeat(instructions) });
    record.turns = Array.from({ length: 5 }, (_, i) => earlier(i + 1, ('history ' + (i + 1) + ' ').padEnd(history, 'x'))); f.bridge.save(record);
    f.bridge.budgets.set({ version: 1, key: 'claude:sonnet', route: 'claude', model: 'sonnet', provider: null, contextWindow: 100_000, maxOutputTokens: 10_000, source: 'sdk-modelusage', at: 1 });
    return { id, record };
  });
}
const run = async (f, id, text = 'current request') => { const sent = await f.send(id, text); await f.done(sent.turn.id); await f.settled(sent.turn.id); return f.bridge.records.get(id).turns.at(-1); };

test('SDK combined budget: each component alone fits the known window, the COMBINATION does not - the query spy sees ZERO dispatch; a combination that fits is dispatched with the current request once', async () => {
  // the carried history alone (about 37k tokens) fits
  { const f = fixture(); const { id } = await carriedChat(f, { history: 22_000, instructions: 0 }); const last = await run(f, id);
    assert.equal(last.status, 'completed'); assert.equal(f.queries.length, 1, 'the history alone fits and is dispatched'); }
  // very large instructions alone (about 50k tokens) fit
  { const f = fixture(); const { id } = await carriedChat(f, { history: 100, instructions: 150_000 }); const last = await run(f, id);
    assert.equal(last.status, 'completed'); assert.equal(f.queries.length, 1, 'the instructions alone fit and are dispatched'); }
  // together they do not: neither the preparation check (history + default reserves) nor the instructions-only check could see it; the combined check refuses, nothing reaches the SDK
  { const f = fixture(); const { id, record } = await carriedChat(f, { history: 22_000, instructions: 150_000 }); const turns = record.turns.length;
    const last = await run(f, id);
    assert.equal(last.status, 'failed'); assert.match(last.error.message, /does not fit its known context window together with its instructions/); assert.equal(f.queries.length, 0, 'ZERO dispatch: the query spy was never called');
    assert.equal(f.bridge.records.get(id).turns.length, turns + 1, 'the history is untouched and the request is recorded once'); assert.equal(JSON.stringify(f.bridge.records.get(id).turns).split('current request').length, 2); }
  // a combination that fits (about 20k + 37k tokens + reserves) is dispatched, the current request once, the carried history once
  { const f = fixture(); const { id } = await carriedChat(f, { history: 22_000, instructions: 60_000 }); const last = await run(f, id);
    assert.equal(last.status, 'completed'); assert.equal(f.queries.length, 1); const q = f.queries[0];
    assert.equal(JSON.stringify(q.input).split('current request').length, 2, 'the current request once'); assert.match(q.additionalContext.bridge_conversation.value, /history 1 /); assert.equal(q.additionalContext.bridge_conversation.kind, 'untrusted'); assert.ok(q.systemPrompt.includes('mmmm')); }
});

// ---- 2. an existing MANAGED NATIVE chat -------------------------------------------------------------------------------------------------------------------------------
const update = (f, id, params) => f.bridge.request('thread/settings/update', { threadId: id, ...params });
const starts = f => f.calls.filter(c => c.method === 'turn/start');
// A native chat adopted as a managed record (through a Claude selection) and returned to a native model: it now holds a PENDING model-change note and runs through beginNative.
async function managedNative(f) {
  const id = await f.start('gpt-test'), first = await f.send(id, 'native hello'); await f.done(first.turn.id);
  await update(f, id, { model: 'sonnet', effort: 'high' });
  const record = f.bridge.records.get(id); Object.assign(record, { runtimeWorkspaceRoots: [f.statePath], instructionSources: [join(f.statePath, 'AGENTS.md')] }); f.bridge.save(record);
  await update(f, id, { model: 'gpt-other', effort: 'low' });
  assert.equal(record.provider, 'native'); assert.equal(record.transitionNotice.pending, true, 'a note is owed to the native model');
  return { id, record, note: record.transitionNotice };
}
const hooks = f => { const flags = { lose: false, readFails: false, brand: null }; f.controls.native = async method => {
  if (method === 'turn/start' && flags.lose) throw new Error('RPC connection closed'); // the host may or may not have it: an unbranded failure
  if (method === 'turn/start' && flags.brand) throw flags.brand;
  if (method === 'thread/turns/list' && flags.readFails) throw new Error('the public record could not be read');
}; return flags; };
// the host's public record, paged: the first page holds other client ids and says there is more; the second page (`cursor: 'p2'`) holds `matching` (or never ends, if `stuck`)
const paged = (f, matching, { stuck = false } = {}) => { const real = f.bridge.native.request; f.bridge.native.request = async (method, params) => {
  if (method !== 'thread/turns/list') return real(method, params);
  f.calls.push({ method, params: structuredClone(params) });
  if (stuck) return { data: Array.from({ length: 20 }, (_, i) => ({ id: 'later-' + i, items: [{ type: 'userMessage', id: 'u' + i, clientId: 'other-' + i }] })), nextCursor: 'same' };
  return params.cursor === 'p2' ? { data: [{ id: 't-accepted', status: 'completed', items: [{ type: 'userMessage', id: 'um-x', clientId: matching, content: [] }] }], nextCursor: null }
    : { data: Array.from({ length: 20 }, (_, i) => ({ id: 'later-' + i, items: [{ type: 'userMessage', id: 'u' + i, clientId: 'other-' + i }] })), nextCursor: 'p2' };
}; return real; };
const held = async (f, id, text) => { const before = starts(f).length, reverts = f.calls.filter(c => c.method === 'thread/revert').length;
  await assert.rejects(f.send(id, text), { code: 'transition_uncertain' }); assert.equal(starts(f).length, before, 'ZERO extra turn/start'); assert.equal(f.calls.filter(c => c.method === 'thread/revert').length, reverts, 'nothing was reset before the hold'); };

test('managed native: an unknown dispatch (response AND notifications lost) is durable, survives a restart, and HOLDS every further dispatch (no match, other ids, a failed read, a stuck cursor); only the exact client id in the public record settles it, and the new request then goes once without the old task or the old note', async () => {
  const f = fixture('openai'); const { id, record, note } = await managedNative(f), flags = hooks(f);
  // the dispatch that carries the note is lost: no answer, no notifications, the host never replies
  flags.lose = true; await assert.rejects(f.send(id, 'LOST-TASK')); flags.lose = false;
  const lost = starts(f).at(-1).params; assert.equal(lost.input[0].text, 'LOST-TASK'); assert.equal(typeof lost.clientUserMessageId, 'string'); assert.equal(lost.additionalContext.bridge_transition.value, note.text);
  assert.deepEqual([record.nativeAttempt.threadId, record.nativeAttempt.clientUserMessageId, record.nativeAttempt.noticeId, record.nativeAttempt.state], [id, lost.clientUserMessageId, note.id, 'dispatched'], 'exactly this chat, client id and note were made durable before the send');
  assert.equal(record.nativeAttempt.to.model, 'gpt-other'); assert.equal(record.transitionNotice.pending, true, 'not consumed: an error is not an acknowledgement');
  // a COLD restart: the pending note AND the uncertain obligation are both read back
  f.restart(); const cold = f.bridge.records.get(id); assert.equal(cold.transitionNotice.pending, true); assert.equal(cold.nativeAttempt.clientUserMessageId, lost.clientUserMessageId);
  // no matching client id anywhere: ZERO extra dispatch
  await held(f, id, 'NEXT-TASK');
  // other ids present is no proof
  f.hosts.get(id).thread.turns.push({ id: 'someone-elses', status: 'completed', items: [{ type: 'userMessage', id: 'x', clientId: 'another-client-id', content: [] }] }); await held(f, id, 'NEXT-TASK');
  // a failed read is no proof
  const flags2 = hooks(f); flags2.readFails = true; await held(f, id, 'NEXT-TASK'); flags2.readFails = false;
  // a record that never ends (a repeated cursor) is no proof
  const real = paged(f, lost.clientUserMessageId, { stuck: true }); await held(f, id, 'NEXT-TASK'); f.bridge.native.request = real;
  assert.ok(f.bridge.records.get(id).nativeAttempt, 'every hold kept the obligation exactly as recorded'); assert.equal(f.bridge.records.get(id).transitionNotice.pending, true);
  // the exact client id, found on the SECOND page: accepted. The new request goes once, with neither the old task nor the old note, and the retained history is not repeated
  paged(f, lost.clientUserMessageId); const before = starts(f).length; const sent = await f.send(id, 'NEXT-TASK'); await f.done(sent.turn.id);
  assert.equal(starts(f).length, before + 1, 'exactly one new turn/start'); const next = starts(f).at(-1).params;
  assert.equal(next.input.length, 1); assert.equal(next.input[0].text, 'NEXT-TASK'); assert.equal(JSON.stringify(next).includes('LOST-TASK'), false, 'the failed user task is never replayed');
  assert.equal(next.additionalContext?.bridge_transition, undefined, 'the accepted note is not sent again'); assert.equal(next.additionalContext?.bridge_conversation, undefined, 'the history the accepted dispatch carried is not repeated');
  const settled = f.bridge.records.get(id); assert.equal(settled.nativeAttempt, undefined); assert.equal(settled.transitionNotice.pending, false);
});

test('managed native: a newer selection never overwrites the unknown attempt; the positive match consumes ONLY the old note and the newer change is still owed', async () => {
  const f = fixture('openai'); const { id, record, note } = await managedNative(f), flags = hooks(f);
  flags.lose = true; await assert.rejects(f.send(id, 'LOST-TASK')); flags.lose = false; const lost = starts(f).at(-1).params, attempt = structuredClone(record.nativeAttempt);
  await update(f, id, { model: 'gpt-test', effort: 'high' }); // an accepted change while the earlier dispatch is unknown
  assert.deepEqual(record.nativeAttempt, attempt, 'the unknown attempt, with its own copy of the note, is untouched'); assert.equal(record.nativeAttempt.noticeId, note.id); assert.notEqual(record.transitionNotice.id, note.id, 'the pending note merged the newer selection');
  await held(f, id, 'NEXT-TASK');
  paged(f, lost.clientUserMessageId); const sent = await f.send(id, 'NEXT-TASK'); await f.done(sent.turn.id);
  const next = starts(f).at(-1).params, current = f.bridge.records.get(id);
  assert.equal(next.additionalContext.bridge_transition.value.includes('· gpt-other (reasoning low) to'), true, 'only the NEWER change is announced, from what the accepted dispatch told the model'); assert.notEqual(next.additionalContext.bridge_transition.value, note.text);
  assert.equal(current.nativeAttempt, undefined); assert.equal(current.transitionNotice.pending, false, 'and it too is consumed by its accepted dispatch');
});

test('managed native: ONLY the trusted local never-sent brand (a connection already closed) retires an attempt; the note stays owed and the next turn carries it once; a remote error, even one claiming it was never sent, stays unknown', async () => {
  const dead = new Peer(new PassThrough(), new PassThrough()); dead.end(); const branded = await dead.request('turn/start', {}).catch(error => error); assert.equal(neverSent(branded), true);
  { const f = fixture('openai'); const { id, record, note } = await managedNative(f), flags = hooks(f), startsBefore = starts(f).length;
    flags.brand = branded; await assert.rejects(f.send(id, 'NEVER-SENT-TASK')); flags.brand = null;
    // The host-side turn COUNT is not the property (the existing native-history reset legitimately de-duplicates old host turns before any dispatch). The property: the dispatch was attempted
    // exactly once at the transport boundary (where the brand was thrown, before the host handler ran), and neither the new task nor its client id exists anywhere in the host's record.
    assert.equal(starts(f).length, startsBefore + 1, 'one attempt reached the transport boundary'); const tried = starts(f).at(-1).params; assert.equal(tried.input[0].text, 'NEVER-SENT-TASK'); assert.equal(typeof tried.clientUserMessageId, 'string');
    const hostRecord = JSON.stringify(f.hosts.get(id).thread.turns); assert.equal(hostRecord.includes('NEVER-SENT-TASK'), false, 'the new task never reached the host'); assert.equal(hostRecord.includes(tried.clientUserMessageId), false, 'its client id is not in the host record');
    assert.match(JSON.stringify(record.turns), /native hello/, 'the original visible canonical history is retained'); assert.equal(record.nativeAttempt, undefined, 'a provably unsent attempt is retired'); assert.equal(record.transitionNotice.pending, true, 'the note is still owed');
    const sent = await f.send(id, 'NEXT-TASK'); await f.done(sent.turn.id); const next = starts(f).at(-1).params;
    assert.equal(next.input[0].text, 'NEXT-TASK'); assert.equal(next.additionalContext.bridge_transition.value, note.text, 'carried once, now'); assert.equal(f.bridge.records.get(id).transitionNotice.pending, false); }
  // a REMOTE error claiming it was never sent is a plain error: unknown, held
  { const f = fixture('openai'); const { id, record } = await managedNative(f), flags = hooks(f);
    f.controls.native = async method => { if (method === 'turn/start') throw Object.assign(new Error('refused'), { code: -32603, data: { notSent: true, neverSent: true }, answered: false }); };
    await assert.rejects(f.send(id, 'REFUSED-TASK')); assert.ok(record.nativeAttempt, 'a claim in an error is not a proof'); f.controls.native = undefined; void flags;
    await held(f, id, 'NEXT-TASK'); }
});

test('managed native: failed critical persistence sends NOTHING (the attempt cannot be made durable, so the dispatch does not happen), and the note stays owed', async () => {
  const f = fixture('openai'); const { id, record, note } = await managedNative(f); let failing = true;
  const save = f.bridge.save.bind(f.bridge); f.bridge.save = r => { if (failing && r.nativeAttempt) throw new Error('disk full'); return save(r); };
  const before = starts(f).length;
  await assert.rejects(f.send(id, 'UNSAVED-TASK'), { code: 'context_state_unwritable' }); assert.equal(starts(f).length, before, 'ZERO dispatch'); assert.equal(record.nativeAttempt, undefined); assert.equal(record.transitionNotice.pending, true);
  failing = false; const sent = await f.send(id, 'NEXT-TASK'); await f.done(sent.turn.id); assert.equal(starts(f).length, before + 1); assert.equal(starts(f).at(-1).params.additionalContext.bridge_transition.value, note.text); assert.equal(f.bridge.records.get(id).transitionNotice.pending, false);
});

test('managed native: a normal accepted first native query still delivers its note once, with the current input once and the retained history once, and leaves no obligation behind; a chat with no note records no attempt', async () => {
  const f = fixture('openai'); const { id, note } = await managedNative(f);
  const sent = await f.send(id, 'FIRST-NATIVE-REQUEST'); await f.done(sent.turn.id); const start = starts(f).at(-1).params;
  assert.equal(start.input.length, 1); assert.equal(start.input[0].text, 'FIRST-NATIVE-REQUEST'); assert.equal(start.additionalContext.bridge_transition.value, note.text); assert.match(start.additionalContext.bridge_conversation.value, /native hello/, 'the retained history, once');
  const record = f.bridge.records.get(id); assert.equal(record.nativeAttempt, undefined); assert.equal(record.transitionNotice.pending, false);
  const again = await f.send(id, 'SECOND'); await f.done(again.turn.id); const second = starts(f).at(-1).params; assert.equal(second.additionalContext?.bridge_transition, undefined); assert.equal(second.additionalContext?.bridge_conversation, undefined);
  // a native chat whose model never changed carries no note, records no attempt, and an error answer cannot hold it
  const g = fixture('openai'); const gid = await g.start('gpt-test'), first = await g.send(gid, 'plain'); await g.done(first.turn.id); assert.equal(g.bridge.records.get(gid)?.nativeAttempt, undefined);
});
