import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inputContent, contextFragments } from './claude.mjs';
import { RpcError } from './rpc.mjs';
import { errorMetadata } from './logging.mjs';
import { continueQueue } from './queue.mjs';

// One input stream belongs to one official SDK query. Closing it wakes the
// reader on completion/cancellation; no second query or model proxy is used.
export function messageStream() {
  const pending = []; let wake, closed = false;
  return {
    push(message) {
      if (closed) throw new RpcError('Turn is no longer accepting steering', -32602);
      pending.push(message); wake?.();
    },
    close() { closed = true; pending.length = 0; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (pending.length) yield pending.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}

export function submission(record, clientId) {
  if (!clientId) return;
  for (const turn of record.turns) {
    const steer = turn.steering?.find(s => s.clientUserMessageId === clientId);
    if (steer) return { turn, input: steer.input, context: steer.additionalContext, steer };
    const item = turn.items.find(i => i.type === 'userMessage' && (i.id === clientId || i.clientId === clientId));
    if (turn.clientUserMessageId === clientId || item)
      return { turn, input: turn.submittedInput ?? item?.content };
  }
}

function active(bridge, record, params) {
  const running = bridge.active.get(record.thread.id);
  if (!params.expectedTurnId || !running || running.turn.id !== params.expectedTurnId
    || running.turn.status !== 'inProgress' || running.acceptingSteering === false || running.controller.signal.aborted
    || bridge.nativeCompletions.has(running.turn.id))
    throw new RpcError('Turn is no longer active or accepting steering', -32602);
  if (bridge.changing.has(record.thread.id) || bridge.reverting.has(record.thread.id))
    throw new RpcError('Wait for the current chat change to finish');
  return running;
}

export async function steerTurn(bridge, record, params) {
  if (!Array.isArray(params.input) || !params.input.length) throw new RpcError('input must be non-empty', -32602);
  const threadId = record.thread.id;
  const pending = bridge.pendingSteers.get(threadId) ?? new Set();
  const duplicate = params.clientUserMessageId && [...pending].find(e => e.params.clientUserMessageId === params.clientUserMessageId);
  if (duplicate) {
    if (!isDeepStrictEqual(duplicate.params, params)) throw new RpcError('This steering message is already being submitted with different input.', -32602);
    return duplicate.promise;
  }
  const previous = submission(record, params.clientUserMessageId);
  if (previous) {
    if (previous.turn.id !== params.expectedTurnId || !isDeepStrictEqual(previous.input, params.input)
      || !isDeepStrictEqual(previous.context ?? null, params.additionalContext ?? null))
      throw new RpcError('This clientUserMessageId already belongs to a different message or turn.', -32602);
    if (previous.steer?.status === 'uncertain') throw new RpcError('Steering delivery is uncertain; inspect this turn before sending a new message.');
    bridge.log('steer.replayed', { threadId: record.thread.id, turnId: previous.turn.id });
    return { turnId: previous.turn.id };
  }
  active(bridge, record, params);
  const queued = record.queue?.find(q => q.clientUserMessageId === params.clientUserMessageId);
  if (queued && !isDeepStrictEqual(queued.input, params.input)) throw new RpcError('Queued submission changed before steering', -32602);
  const entry = { params: structuredClone(params), queuedSubmissionId: queued?.id };
  const preceding = [...pending].at(-1)?.promise;
  pending.add(entry); bridge.pendingSteers.set(threadId, pending);
  // Serialise preparation, not the model: rapid distinct messages retain order,
  // and concurrent retries share one acceptance operation.
  const promise = (async () => {
    await preceding?.catch(() => {});
    const running = active(bridge, record, params);
    const application = contextFragments(params.additionalContext, 'application');
    const content = running.native ? null : await inputContent(params.input, params.additionalContext);
    active(bridge, record, params); // Images/context may have taken time to read.
    if (application.length && !running.native)
      content.push({ type: 'text', text: 'Additional application context supplied by Codex:\n' + JSON.stringify(application) });
    const turn = running.turn, clientId = params.clientUserMessageId ?? randomUUID();
    const receipt = { clientUserMessageId: clientId, input: structuredClone(params.input),
      ...(params.additionalContext ? { additionalContext: structuredClone(params.additionalContext) } : {}),
      promptId: randomUUID(), status: 'accepted', ...(queued ? { queuedSubmissionId: queued.id } : {}) };
    const item = { type: 'userMessage', id: clientId, clientId, content: structuredClone(params.input) };
    const queueIndex = queued ? record.queue.indexOf(queued) : -1;
    const oldUpdatedAt = record.updatedAt;
    const rollback = () => {
      turn.steering = turn.steering.filter(s => s !== receipt);
      turn.items = turn.items.filter(i => i.id !== clientId);
      if (queued && !record.queue.some(q => q.id === queued.id)) record.queue.splice(queueIndex, 0, queued);
      record.updatedAt = oldUpdatedAt;
    };
    (turn.steering ??= []).push(receipt); turn.items.push(item);
    if (queued) record.queue.splice(queueIndex, 1);
    record.updatedAt = Math.floor(Date.now() / 1000);
    try { bridge.save(record); } catch (error) { rollback(); throw error; }
    bridge.log('steer.accepted', { threadId, turnId: turn.id, queuedSubmissionId: queued?.id, provider: running.native ? 'native' : 'claude', queueLength: record.queue?.length ?? 0 });
    if (queued) bridge.emit('thread/queue/changed', { threadId });
    if (running.native) {
      try {
        const result = await bridge.native.request('turn/steer', { ...params, clientUserMessageId: clientId });
        if (result.turnId !== turn.id) throw new Error('Native steering returned a different turn');
        receipt.status = 'delivered'; bridge.save(record);
      } catch (error) {
        if (receipt.status !== 'delivered') {
          if ([-32600, -32601, -32602].includes(error.code)) { rollback(); bridge.save(record); }
          else { receipt.status = 'uncertain'; record.nativeResetRequired = true; bridge.save(record); }
          bridge.log('steer.failed', { threadId, turnId: turn.id, ...errorMetadata(error) });
          if (queued) bridge.emit('thread/queue/changed', { threadId });
          throw error;
        }
      }
    } else {
      // 'next' folds input into the live agent loop at its next boundary. 'now'
      // interrupts SDK tool-result processing and can race rapid user messages.
      running.steeringInput.push({ type: 'user', uuid: receipt.promptId, priority: 'next',
        message: { role: 'user', content }, parent_tool_use_id: null, session_id: record.claudeSessionId ?? '' });
      bridge.emit('item/started', { threadId, turnId: turn.id, item });
      bridge.emit('item/completed', { threadId, turnId: turn.id, item });
    }
    return { turnId: turn.id };
  })();
  entry.promise = promise;
  try { return await promise; }
  finally {
    pending.delete(entry); if (!pending.size) bridge.pendingSteers.delete(threadId);
    if (!bridge.active.has(threadId)) continueQueue(bridge, record, record.turns.at(-1)?.status);
  }
}

export function settleSteering(bridge, record, turn) {
  if (!turn.steering?.some(s => s.status === 'accepted')) return;
  for (const receipt of turn.steering) if (receipt.status === 'accepted') receipt.status = 'uncertain';
  // Retain every accepted message in canonical history. A later deliberate
  // follow-up rebuilds Claude context, including input not confirmed by the SDK.
  if (turn.provider === 'claude') { record.claudeSessionId = undefined; turn.claudeCheckpoint = null; }
  else record.nativeResetRequired = true;
  bridge.log('steer.uncertain', { threadId: record.thread.id, turnId: turn.id, provider: turn.provider });
  bridge.emit('warning', { threadId: record.thread.id,
    message: 'This turn ended before every steering message was confirmed. The messages are retained in chat history and will not be retried automatically.' });
}

// Replay events acknowledge ingestion; result UUIDs (when available) establish
// which sends the response actually answered. Never finish on an earlier result
// while another accepted message is still waiting in the same SDK session.
export function steeringResult(bridge, record, running, message) {
  const receipts = running.turn.steering ?? [];
  if (message.type === 'user' && message.isReplay) {
    const receipt = receipts.find(s => s.promptId === message.uuid);
    if (receipt) receipt.replayed = true;
  }
  if (message.type !== 'result') return;
  const ids = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : null);
  for (const receipt of receipts) if (receipt.status === 'accepted'
    && (ids ? ids.includes(receipt.promptId) || (ids.length >= 64 && receipt.replayed) : receipt.replayed)) {
    receipt.status = 'delivered'; bridge.save(record);
    bridge.log('steer.delivered', { threadId: record.thread.id, turnId: running.turn.id, queuedSubmissionId: receipt.queuedSubmissionId, provider: 'claude' });
  }
  if (receipts.every(s => s.status === 'delivered')) {
    running.acceptingSteering = false; running.steeringInput.close();
  }
}
