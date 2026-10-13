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
export async function queueRequest(bridge, record, method, params) {
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
    const running = bridge.active.get(record.thread.id);
    if (running) {
      const result = await bridge.request('turn/steer', { threadId: record.thread.id, expectedTurnId: running.turn.id,
        input: queued.input, clientUserMessageId: queued.clientUserMessageId });
      return { turn: { id: result.turnId, status: running.turn.status, items: [], itemsView: 'notLoaded', error: running.turn.error } };
    }
    return bridge.begin(record, { threadId: record.thread.id, input: queued.input,
      clientUserMessageId: queued.clientUserMessageId, queuedSubmissionId: queued.id });
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
  bridge.save(record); bridge.emit('thread/queue/changed', { threadId: record.thread.id });
  bridge.log('queue.changed', { threadId: record.thread.id, method, queuedSubmissionId: params.queuedSubmissionId ?? response.queuedSubmission?.id, queueLength: record.queue.length });
  return structuredClone(response);
}

export function acceptQueued(record, params, turn) {
  if (!params.queuedSubmissionId) return false;
  const index = record.queue?.findIndex(q => q.id === params.queuedSubmissionId) ?? -1;
  if (index < 0 || !isDeepStrictEqual(record.queue[index].input, params.input))
    throw new RpcError('Queued submission changed before acceptance', -32602);
  turn.queuedSubmissionId = params.queuedSubmissionId;
  record.queue.splice(index, 1); return true;
}

export function continueQueue(bridge, record, status) {
  if (!record.queue?.length) return;
  if (bridge.pendingSteers.has(record.thread.id) || record.turns.at(-1)?.steering?.some(s => s.status === 'uncertain')) return;
  if (status !== 'completed' || record.archived) {
    bridge.log('queue.paused', { threadId: record.thread.id, reason: record.archived ? 'archived' : status, queueLength: record.queue.length }); return;
  }
  setImmediate(() => {
    if (bridge.active.has(record.thread.id) || bridge.starting.has(record.thread.id) || bridge.pendingSteers.has(record.thread.id) || bridge.changing.has(record.thread.id) || bridge.reverting.has(record.thread.id)) return;
    bridge.request('thread/queue/start', { threadId: record.thread.id }).catch(error => {
      bridge.log('queue.paused', { threadId: record.thread.id, reason: 'start_failed', queueLength: record.queue.length, ...errorMetadata(error) });
      bridge.emit('warning', { threadId: record.thread.id, message: `Queued message was not started: ${error.message}` });
    });
  });
}
