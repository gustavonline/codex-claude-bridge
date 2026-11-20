import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RpcError } from './rpc.mjs';
import { errorMetadata } from './logging.mjs';

const input = value => {
  if (!Array.isArray(value) || !value.length) throw new RpcError('Queued input must be non-empty', -32602);
  return structuredClone(value);
};

// Stored with the transcript so accepting a queued turn and removing its
// submission is one atomic save. Native GPT-only chats keep their native queue.
export async function queueRequest(bridge, record, method, params, internal = {}) {
  const queue = record.queue ??= [];
  if (method === 'thread/queue/list') return structuredClone(bridge.page(queue, params));
  if (method === 'thread/queue/start') {
    const pending = params.queuedSubmissionId && [...(bridge.pendingSteers.get(record.thread.id) ?? [])]
      .find(s => s.queuedSubmissionId === params.queuedSubmissionId);
    if (pending) await pending.promise;
    const old = params.queuedSubmissionId && record.turns.find(t => t.queuedSubmissionId === params.queuedSubmissionId
      || t.steering?.some(s => s.queuedSubmissionId === params.queuedSubmissionId));
    if (old?.steering?.some(s => s.queuedSubmissionId === params.queuedSubmissionId && s.status === 'uncertain'))
      throw new RpcError('Steering delivery is uncertain; inspect this turn before sending a new message.');
    if (old) return { turn: { id: old.id, status: old.status, items: [], itemsView: 'notLoaded', error: old.error } };
    const queued = params.queuedSubmissionId ? queue.find(q => q.id === params.queuedSubmissionId) : queue[0];
    if (!queued) throw new RpcError('Queued submission not found', -32602);
    bridge.log('queue.start_requested', { threadId: record.thread.id, queuedSubmissionId: queued.id, queueLength: queue.length });
    // The generation this start binds the rest of the queue to is read now, before any await: a disable and
    // re-enable that lands while the start is in flight must stay a mismatch for what remains queued.
    const bound = bridge.claudeState().token;
    const running = bridge.active.get(record.thread.id);
    if (running) {
      const result = await bridge.request('turn/steer', { threadId: record.thread.id, expectedTurnId: running.turn.id,
        input: queued.input, clientUserMessageId: queued.clientUserMessageId });
      resumeQueue(bridge, record, bound);
      return { turn: { id: result.turnId, status: running.turn.status, items: [], itemsView: 'notLoaded', error: running.turn.error } };
    }
    const started = await bridge.begin(record, { threadId: record.thread.id, input: queued.input,
      clientUserMessageId: queued.clientUserMessageId, queuedSubmissionId: queued.id }, internal);
    resumeQueue(bridge, record, bound);
    return started;
  }
  if (bridge.changing.has(record.thread.id) || bridge.reverting.has(record.thread.id))
    throw new RpcError('Wait for the current chat change before editing its queue');
  const accepting = bridge.pendingStarts.get(record.thread.id)?.params.queuedSubmissionId;
  if (accepting && (['thread/queue/reorder'].includes(method) || params.queuedSubmissionId === accepting))
    throw new RpcError('Wait until this queued submission has been accepted');
  if ([...(bridge.pendingSteers.get(record.thread.id) ?? [])].some(s => s.queuedSubmissionId
    && (method !== 'thread/queue/add' || params.clientUserMessageId === s.params.clientUserMessageId)))
    throw new RpcError('Wait until this queued steering message has been accepted');
  let response;
  if (method === 'thread/queue/add') {
    if (!params.clientUserMessageId) throw new RpcError('clientUserMessageId is required', -32602);
    const duplicate = queue.find(q => q.clientUserMessageId === params.clientUserMessageId);
    if (duplicate) {
      if (!isDeepStrictEqual(duplicate.input, params.input)) throw new RpcError('Message ID already belongs to different queued input', -32602);
      return { queuedSubmission: structuredClone(duplicate) };
    }
    if (record.turns.some(t => t.clientUserMessageId === params.clientUserMessageId || t.items.some(i => i.type === 'userMessage' && (i.id === params.clientUserMessageId || i.clientId === params.clientUserMessageId))))
      throw new RpcError('This message has already been accepted as a turn', -32602);
    const queuedSubmission = { id: randomUUID(), clientUserMessageId: params.clientUserMessageId, input: input(params.input) };
    queue.push(queuedSubmission); response = { queuedSubmission };
    if ((record.provider ?? 'claude') === 'claude') {
      const { denied, token } = bridge.claudeState();
      // A Claude-owned queue is bound to the disable generation when it becomes nonempty.
      if (queue.length === 1) stampQueue(record, token);
      // Queued while Claude Code is disabled: it waits for an explicit start, even after re-enabling.
      if (denied) record.queuePaused = pauseReason;
    }
  } else if (method === 'thread/queue/reorder') {
    const ids = params.queuedSubmissionIds;
    if (!Array.isArray(ids) || new Set(ids).size !== queue.length || ids.length !== queue.length || ids.some(id => !queue.some(q => q.id === id)))
      throw new RpcError('Reordering must contain every queued submission exactly once', -32602);
    record.queue = ids.map(id => queue.find(q => q.id === id)); response = {};
  } else {
    const index = queue.findIndex(q => q.id === params.queuedSubmissionId);
    if (method === 'thread/queue/delete') {
      if (index >= 0) queue.splice(index, 1);
      response = { deleted: index >= 0 };
    } else if (method === 'thread/queue/update') {
      if (index < 0) throw new RpcError('Queued submission not found', -32602);
      queue[index].input = input(params.input); response = { queuedSubmission: queue[index] };
    } else throw new RpcError('Unknown queue operation', -32601);
  }
  if (!record.queue.length) clearQueueState(record);
  bridge.save(record); bridge.emit('thread/queue/changed', { threadId: record.thread.id });
  bridge.log('queue.changed', { threadId: record.thread.id, method, queuedSubmissionId: params.queuedSubmissionId ?? response.queuedSubmission?.id, queueLength: record.queue.length });
  return structuredClone(response);
}

// The pause set by disabling Claude Code is durable: it is saved with the chat, survives a restart and is
// not cleared by re-enabling, by another turn finishing, by a slow operation ending or by a move to GPT.
// Only an explicit queue start (or an empty queue) ends it. Other pause reasons are unchanged.
//
// The pause does not depend on the Bridge having seen the disable. A Claude-owned queue carries the
// generation token it was bound to (record.queueGeneration: when it became nonempty, when it became
// Claude's by a provider change, and when it was explicitly resumed); a different or unknown token at
// restore, at an automatic continuation or just before an automatic commit is the same pause. The
// stamp stays with the record across a handoff to GPT. A plain GPT queue has neither stamp nor marker.
const pauseReason = 'provider_disabled';

// Records the generation token a queue is bound to. An unknown token (unreadable or earlier-layout store) is
// recorded as a stamp that never matches any token, not deleted: the queue keeps its Claude provenance (a missing
// stamp on a chat that is on GPT would read as a plain GPT queue), and it can only wait for an explicit start.
// Real tokens are 'none' or '<32 hex>:<n>', so this value cannot equal one.
const unknownStamp = 'unknown';
function stampQueue(record, token) { record.queueGeneration = token === null ? unknownStamp : token; }
function clearQueueState(record) { delete record.queuePaused; delete record.queueGeneration; }

// Why this chat's queued work must wait for an explicit start, or null. Claude-owned: refused by the
// current decision, or bound to another or an unknown generation. A chat now on GPT is held only by what
// its Claude-owned queue carries (a stamp that no longer matches); GPT's own queue has none.
function pauseCause(bridge, record) {
  const claude = (record.provider ?? 'claude') === 'claude', stamp = record.queueGeneration;
  if (!claude && stamp === undefined) return null;
  const { denied, token } = bridge.claudeState();
  if (claude && denied) return pauseReason;
  if (token === null || stamp === undefined || stamp === unknownStamp) return 'generation_unknown';
  return stamp === token ? null : 'generation_changed';
}
// True once this chat's queue is paused by the connection decision: an existing marker is honoured first,
// whatever provider the chat has now; otherwise the pause is set the first time the decision (or the
// generation) refuses it, and kept.
function providerPause(bridge, record) {
  if (record.queuePaused === pauseReason) return true;
  const cause = pauseCause(bridge, record);
  if (!cause) return false;
  record.queuePaused = pauseReason; bridge.save(record);
  if (cause !== pauseReason) bridge.log('queue.pause_marked', { threadId: record.thread.id, cause, queueLength: record.queue?.length ?? 0 });
  return true;
}
// A restored nonempty queue is settled against the current decision at once, so the pause is saved even
// if nothing else happens before the next restart.
export function restoreQueue(bridge, record) {
  if (record.queue?.length) providerPause(bridge, record);
}
// An explicit start ends the pause and binds what remains of the queue to the generation read when the start
// began (never one read after an await), so an unobserved disable during the start is not erased.
function resumeQueue(bridge, record, token) {
  const paused = record.queuePaused === pauseReason, before = record.queueGeneration;
  if (paused) delete record.queuePaused;
  // A plain GPT queue (no marker, no stamp) is not Claude-owned and gets no stamp from this.
  if (!record.queue?.length) delete record.queueGeneration;
  else if (paused || before !== undefined || (record.provider ?? 'claude') === 'claude') stampQueue(record, token);
  if (paused || record.queueGeneration !== before) bridge.save(record);
}
// A queue that becomes Claude's through a provider change is bound at that point; one that already carries a
// stamp keeps it.
export function adoptQueue(bridge, record) {
  if (record.queue?.length && record.queueGeneration === undefined && record.queuePaused !== pauseReason) stampQueue(record, bridge.claudeState().token);
}

export function acceptQueued(record, params, turn) {
  if (!params.queuedSubmissionId) return false;
  const index = record.queue?.findIndex(q => q.id === params.queuedSubmissionId) ?? -1;
  if (index < 0 || !isDeepStrictEqual(record.queue[index].input, params.input))
    throw new RpcError('Queued submission changed before acceptance', -32602);
  turn.queuedSubmissionId = params.queuedSubmissionId;
  record.queue.splice(index, 1);
  if (!record.queue.length) clearQueueState(record); // an empty queue ends the pause and has nothing to be bound to
  return true;
}

export function continueQueue(bridge, record, status) {
  if (!record.queue?.length) {
    if (record.queuePaused || record.queueGeneration !== undefined) { clearQueueState(record); bridge.save(record); }
    return;
  }
  // Queued Claude work stays paused once Claude Code was disabled, until it is started explicitly.
  if (providerPause(bridge, record)) {
    bridge.log('queue.paused', { threadId: record.thread.id, reason: pauseReason, queueLength: record.queue.length }); return;
  }
  if (bridge.pendingSteers.has(record.thread.id) || record.turns.at(-1)?.steering?.some(s => s.status === 'uncertain')) return;
  if (status !== 'completed' || record.archived) {
    bridge.log('queue.paused', { threadId: record.thread.id, reason: record.archived ? 'archived' : status, queueLength: record.queue.length }); return;
  }
  setImmediate(() => {
    if (!record.queue?.length || record.archived || record.turns.at(-1)?.status !== 'completed') return;
    // The decision may change between scheduling and this start: re-check, and pause durably.
    if (providerPause(bridge, record)) { bridge.log('queue.paused', { threadId: record.thread.id, reason: pauseReason, queueLength: record.queue.length }); return; }
    if (bridge.active.has(record.thread.id) || bridge.starting.has(record.thread.id) || bridge.pendingSteers.has(record.thread.id) || bridge.changing.has(record.thread.id) || bridge.reverting.has(record.thread.id)) return;
    // The decision and the generation are checked once more at the instant the queued message would be
    // accepted, after the asynchronous preparation: a disable and re-enable in between is caught too.
    const admit = () => { if (providerPause(bridge, record)) throw new RpcError('Queued work is paused by the Claude Code connection decision; start it explicitly.', -32602); };
    bridge.request('thread/queue/start', { threadId: record.thread.id }, { admit }).catch(error => {
      if (providerPause(bridge, record)) return; // refused by the connection decision, not a failure to report
      bridge.log('queue.paused', { threadId: record.thread.id, reason: 'start_failed', queueLength: record.queue.length, ...errorMetadata(error) });
      bridge.emit('warning', { threadId: record.thread.id, message: `Queued message was not started: ${error.message}` });
    });
  });
}
