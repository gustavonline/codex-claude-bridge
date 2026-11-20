import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { errorMetadata, logContext, unsafeActivity } from './logging.mjs';
const context = params => {
  const threadId = params.threadId ?? params.thread?.id, turnId = params.turnId ?? params.expectedTurnId ?? params.turn?.id;
  return { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
};

export class RpcError extends Error {
  constructor(message, code = -32603, data) { super(message); this.code = code; if (data !== undefined) this.data = data; }
}

// A locally generated, UNSPOOFABLE proof that a request was never written to its connection: only this module can add an error to the set, and only for a failure that happened before
// any write (here: the connection was already closed). A reply from the peer (including one that merely CLAIMS it was not sent, in its data), a timeout, an abort, a closed connection with the
// request pending, or any failure after the write is NOT in it: such an outcome is unknown (the runtime may have received the request, or may still apply it later).
const unsent = new WeakSet();
export const neverSent = error => error instanceof RpcError && unsent.has(error);

// Each connection owns its IDs; forwarding never mixes desktop and native IDs.
export class Peer {
  // observe(phase, method, params, result): a read-only tap on THIS connection's own outbound requests ('request', when sent) and their
  // successful answers ('response', synchronously when the answer is read, before anything else can be read from the stream). It is how the Bridge
  // learns what a thread's own runtime confirmed (its start / resume answer) without trusting a notification or a model argument. It cannot change a message.
  constructor(input, output, { request, notify, close, observe, log = () => {}, name = 'rpc', slowMs = 15000 } = {}) {
    this.output = output; this.observe = observe;
    this.log = log; this.name = name; this.slowMs = slowMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.lines.on('line', async line => {
      let message;
      try { message = JSON.parse(line); }
      catch { log('rpc.invalid_json', { peer: name, errorCode: -32700 }); this.send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
      if (!message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) { log('rpc.unmatched_response', { peer: name, rpcId: message.id }); return; }
        this.pending.delete(message.id); clearTimeout(pending.timer); pending.removeAbort?.();
        if (!message.error) this.watch('response', pending.method, pending.params, message.result);
        // `answered`: the peer itself replied with this error (the request was understood and refused), as opposed to a closed connection, a timeout or an abort, whose outcome is unknown.
        message.error ? pending.reject(Object.assign(new RpcError(message.error.message, message.error.code, message.error.data), { answered: true })) : pending.resolve(message.result);
      } else if (message.id !== undefined) {
        const fields = { peer: name, direction: 'inbound', rpcId: message.id, method: message.method,
          traceId: randomUUID(), ...context(message.params ?? {}) };
        const started = performance.now();
        // false: a start could not be recorded and older idle evidence could not
        // be invalidated. Refuse it before any Bridge or native dispatch.
        const recorded = log('rpc.start', fields) !== false;
        const slow = this.slow(fields, started);
        await logContext.run({ traceId: fields.traceId, ...context(message.params ?? {}) }, async () => {
          try {
            if (!recorded) throw new RpcError(unsafeActivity);
            const result = await request(message.method, message.params ?? {});
            log('rpc.finish', { ...fields, ...context(result ?? {}), status: 'completed', durationMs: Math.round(performance.now() - started) });
            this.send({ id: message.id, result });
          } catch (error) {
            log('rpc.finish', { ...fields, status: 'failed', durationMs: Math.round(performance.now() - started), ...errorMetadata(error) });
            const numericCode = Number.isInteger(error.code) ? error.code : -32603;
            const data = typeof error.code === 'string' ? { ...(error.data !== undefined ? { nativeData: error.data } : {}), bridgeErrorCode: error.code } : error.data;
            this.send({ id: message.id, error: { code: numericCode, message: error.message, ...(data !== undefined ? { data } : {}) } });
          } finally { clearTimeout(slow); }
        });
      } else {
        try { await notify?.(message.method, message.params ?? {}); }
        catch (error) { log('rpc.notification_failed', { peer: name, method: message.method, ...errorMetadata(error) }); }
      }
    });
    this.lines.on('close', () => { this.end(); close?.(); });
    output.on('error', () => this.end());
  }
  // A failing tap never affects the connection; whatever it was to record is simply not recorded (callers treat unrecorded as unconfirmed).
  watch(phase, method, params, result) { try { this.observe?.(phase, method, params, result); } catch { /* the tap is advisory */ } }
  send(message) { if (!this.closed) this.output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  notify(method, params) { this.send({ method, params }); }
  slow(fields, started) {
    const timer = setTimeout(() => this.log('rpc.slow', { ...fields, durationMs: Math.round(performance.now() - started) }), this.slowMs);
    timer.unref(); return timer;
  }
  async request(method, params, timeout = 60_000, signal) {
    if (this.closed) { const error = new RpcError('RPC connection closed'); unsent.add(error); return Promise.reject(error); } // (nothing was written: a trusted local proof)
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = `bridge-${++this.sequence}`;
    const fields = { ...logContext.getStore(), peer: this.name, direction: 'outbound', rpcId: id, method, ...context(params ?? {}) };
    const started = performance.now();
    this.log('rpc.start', fields);
    const slow = this.slow(fields, started);
    try {
      const result = await new Promise((resolve, reject) => {
      const removeAbort = () => signal?.removeEventListener('abort', abort);
      const abort = () => { this.pending.delete(id); clearTimeout(timer); removeAbort(); reject(signal.reason); };
      const timer = setTimeout(() => { this.pending.delete(id); removeAbort(); reject(new RpcError(`${method} timed out`)); }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, timer, removeAbort, method, params }); this.watch('request', method, params); this.send({ id, method, params });
      });
      this.log('rpc.finish', { ...fields, ...context(result ?? {}), status: 'completed', durationMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      this.log('rpc.finish', { ...fields, status: 'failed', durationMs: Math.round(performance.now() - started), ...errorMetadata(error) });
      throw error;
    } finally { clearTimeout(slow); }
  }
  end() {
    if (this.closed) return;
    this.log('rpc.closed', { peer: this.name });
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.removeAbort?.(); item.reject(new RpcError('RPC connection closed')); }
    this.pending.clear(); this.lines.close();
  }
}
