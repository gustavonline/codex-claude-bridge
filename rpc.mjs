import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { errorMetadata, logContext } from './logging.mjs';
const context = params => {
  const threadId = params.threadId ?? params.thread?.id, turnId = params.turnId ?? params.expectedTurnId ?? params.turn?.id;
  return { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
};

export class RpcError extends Error {
  constructor(message, code = -32603) { super(message); this.code = code; }
}

// Each connection owns its IDs; forwarding never mixes desktop and native IDs.
export class Peer {
  constructor(input, output, { request, notify, close, log = () => {}, name = 'rpc', slowMs = 15000 } = {}) {
    this.output = output;
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
        message.error ? pending.reject(new RpcError(message.error.message, message.error.code)) : pending.resolve(message.result);
      } else if (message.id !== undefined) {
        const fields = { peer: name, direction: 'inbound', rpcId: message.id, method: message.method,
          traceId: randomUUID(), ...context(message.params ?? {}) };
        const started = performance.now();
        log('rpc.start', fields);
        const slow = this.slow(fields, started);
        await logContext.run({ traceId: fields.traceId, ...context(message.params ?? {}) }, async () => {
          try {
            const result = await request(message.method, message.params ?? {});
            log('rpc.finish', { ...fields, ...context(result ?? {}), status: 'completed', durationMs: Math.round(performance.now() - started) });
            this.send({ id: message.id, result });
          } catch (error) {
            log('rpc.finish', { ...fields, status: 'failed', durationMs: Math.round(performance.now() - started), ...errorMetadata(error) });
            this.send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
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
  send(message) { if (!this.closed) this.output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  notify(method, params) { this.send({ method, params }); }
  slow(fields, started) {
    const timer = setTimeout(() => this.log('rpc.slow', { ...fields, durationMs: Math.round(performance.now() - started) }), this.slowMs);
    timer.unref(); return timer;
  }
  async request(method, params, timeout = 60_000, signal) {
    if (this.closed) return Promise.reject(new RpcError('RPC connection closed'));
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
      this.pending.set(id, { resolve, reject, timer, removeAbort }); this.send({ id, method, params });
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
