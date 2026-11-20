// OpenRouter's documented browser PKCE flow. Only the fixed official origins
// are used; the callback is finite loopback, not a hosted platform or daemon.
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const openRouterBase = 'https://openrouter.ai/api/v1';
export function exchangeCode(code, verifier, { request = httpsRequest, signal } = {}) {
  return new Promise((resolve, reject) => {
    let req, response, bytes = 0, chunks = [], done = false;
    const finish = (error, key) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); response?.destroy(); req?.destroy(); error ? reject(Object.assign(new Error(error), { code: error })) : resolve(key); };
    const abort = () => finish('auth_cancelled');
    const timer = setTimeout(() => finish('auth_timeout'), 10000);
    if (signal?.aborted) { abort(); return; } signal?.addEventListener('abort', abort, { once: true });
    try {
      const body = JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' });
      req = request('https://openrouter.ai/api/v1/auth/keys', { method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        response = res;
        // Never follow redirects or expose response bodies/credentials in errors.
        if (res.statusCode !== 200) { finish(res.statusCode === 429 ? 'auth_rate_limited' : [400, 401, 403].includes(res.statusCode) ? 'auth_denied' : 'auth_exchange_failed'); return; }
        res.on('data', b => { bytes += b.length; if (bytes > 8192) finish('auth_exchange_failed'); else chunks.push(b); });
        res.on('error', () => finish('auth_exchange_failed')); res.on('aborted', () => finish('auth_exchange_failed'));
        res.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v.key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(v.key)) throw Error(); finish(null, v.key); } catch { finish('auth_exchange_failed'); } chunks = []; });
      });
      req.on('error', () => finish('auth_unreachable')); req.end(body);
    } catch { finish('auth_exchange_failed'); }
  });
}
export async function callbackListener(handler) {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, handler);
  server.maxHeadersCount = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close() { server.close(); server.closeIdleConnections(); const timer = setTimeout(() => server.closeAllConnections(), 100); timer.unref(); } };
}
export class BrowserAuth {
  constructor({ secrets, listen = callbackListener, exchange = exchangeCode, onAuthorized, guard = () => {}, now = Date.now, ttlMs = 180000 } = {}) {
    Object.assign(this, { secrets, listen, exchange, onAuthorized, guard, now, ttlMs });
    this.attempt = null; this.phase = 'idle'; this.error = null; this.providerId = null;
  }
  status() { return { phase: this.phase, error: this.error, providerId: this.providerId,
    authorizationUrl: this.phase === 'waiting' ? this.attempt?.authorizationUrl ?? null : null,
    storageAvailable: this.secrets.available() }; }
  async begin() {
    this.guard(); if (!this.secrets.available()) fail('secret_storage_unavailable');
    if (this.attempt) fail('auth_already_pending');
    const a = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), controller: new AbortController(), expires: this.now() + this.ttlMs,
      listener: null, timer: null, authorizationUrl: null, used: false, invalid: 0 };
    this.attempt = a; this.phase = 'starting'; this.error = null; this.providerId = null;
    try { a.listener = await this.listen((req, res) => { this.receive(a, req, res).catch(() => this.finish(a, 'failed', 'auth_exchange_failed')); }); }
    catch { this.finish(a, 'failed', 'auth_callback_unavailable'); fail('auth_callback_unavailable'); }
    if (this.attempt !== a) { a.listener.close(); fail('auth_cancelled'); }
    if (!Number.isInteger(a.listener.port) || a.listener.port < 1 || a.listener.port > 65535) { this.finish(a, 'failed', 'auth_callback_unavailable'); fail('auth_callback_unavailable'); }
    const callback = 'http://127.0.0.1:' + a.listener.port + '/callback';
    const url = new URL('https://openrouter.ai/auth');
    url.search = new URLSearchParams({ callback_url: callback, code_challenge: createHash('sha256').update(a.verifier).digest('base64url'), code_challenge_method: 'S256', state: a.state }).toString();
    a.authorizationUrl = url.href; this.phase = 'waiting';
    a.timer = setTimeout(() => this.finish(a, 'expired', 'auth_expired'), this.ttlMs); a.timer.unref?.();
    return this.status();
  }
  async receive(a, req, res) {
    const reply = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); res.end(message); };
    if (this.attempt !== a || a.used || this.now() >= a.expires) { reply(410, 'This connection request is no longer active.'); return; }
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:' + a.listener.port || req.url.length > 8192 || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { reply(400, 'Invalid callback.'); return; }
    let url;
    try { url = new URL(req.url, 'http://' + req.headers.host); } catch { reply(400, 'Invalid callback.'); return; }
    const states = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code');
    if (url.pathname !== '/callback' || url.origin !== 'http://' + req.headers.host || states.length !== 1 || !equal(states[0], a.state)
      || codes.length !== 1 || !/^[\x21-\x7e]{1,4096}$/.test(codes[0]) || [...url.searchParams.keys()].some(k => !['state', 'code'].includes(k))) {
      reply(400, 'Invalid or expired authorization response.'); if (++a.invalid >= 16) this.finish(a, 'failed', 'auth_invalid_callback'); return;
    }
    // Consume before awaiting: replay and double exchange cannot race.
    a.used = true; this.phase = 'exchanging';
    let enrolled = null;
    try {
      this.guard(); let key = await this.exchange(codes[0], a.verifier, { signal: a.controller.signal });
      if (this.attempt !== a || a.controller.signal.aborted) { reply(410, 'Connection cancelled.'); return; }
      this.guard(); const reference = this.secrets.enroll(openRouterBase, key, () => { this.guard(); if (this.attempt !== a || a.controller.signal.aborted) fail('auth_cancelled'); }); key = null;
      if (this.attempt !== a) { reply(410, 'Connection cancelled.'); return; }
      enrolled = reference;
      const providerId = this.onAuthorized(reference);
      if (typeof providerId !== 'string' || !/^[a-f0-9]{32}$/.test(providerId)) fail('auth_exchange_failed');
      this.providerId = providerId; reply(200, 'Connected. Return to Model Bridge and read current state.');
      this.finish(a, 'complete');
    } catch (e) { if (enrolled) try { this.secrets.discard(enrolled, openRouterBase); } catch { /* keep safe reference for explicit recovery, never output key */ }
      reply(400, 'Connection could not be completed. Return to Model Bridge.'); this.finish(a, 'failed', ['auth_rate_limited', 'auth_denied', 'auth_timeout', 'auth_cancelled', 'auth_unreachable', 'secret_storage_unavailable', 'stale_revision'].includes(e.code) ? e.code : 'auth_exchange_failed'); }
  }
  finish(a, phase, error = null) {
    if (this.attempt !== a) return;
    clearTimeout(a.timer); a.controller.abort(); a.listener?.close(); a.verifier = null; a.state = null;
    this.attempt = null; this.phase = phase; this.error = error;
  }
  cancel() { this.guard(); if (this.attempt) this.finish(this.attempt, 'cancelled', 'auth_cancelled'); return this.status(); }
  close() { if (this.attempt) this.finish(this.attempt, 'cancelled', 'auth_cancelled'); }
}
