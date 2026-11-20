import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderNativePool } from '../bridge.mjs';
const id = 'a'.repeat(32), definition = { name: 'Synthetic only', base_url: 'https://fixture.example.invalid/v1', wire_api: 'responses', requires_openai_auth: false, request_max_retries: 0 };
const initialize = { clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } };
function setup({ badInit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-pool-')), launches = [], children = [], events = [], notifications = [];
  // Public line-delimited protocol seam; no socket/process or denied operation.
  // Real matching-binary consumption remains a separate operator gate.
  const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, LC_ALL: 'C' };
  const pool = new ProviderNativePool({ executable: '/synthetic/pinned-codex', args: ['app-server'], overrides: ['-c', 'permissions="fixture-only"'], env,
    initialization: () => initialize, request: async () => ({}), notify: (method, params) => notifications.push({ method, params }), log: (name, data) => events.push({ name, data }),
    spawnProcess: (exe, args, options) => {
      launches.push({ exe, args, options });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null;
      let initialized = false;
      const provider = JSON.parse(args.find(a => a.startsWith('model_provider=')).slice(15));
      const answer = value => queueMicrotask(() => child.stdout.write(JSON.stringify(value) + '\n'));
      child.stdin.on('data', bytes => {
        for (const line of bytes.toString().trim().split('\n')) {
          const m = JSON.parse(line);
          if (m.method === 'initialized') { initialized = true; continue; }
          if (m.method === 'notifications/initialized') throw Error('MCP handshake must not be used for native app-server');
          if (m.id === undefined) continue;
          if (m.method !== 'initialize') assert.equal(initialized, true, 'native initialized precedes independent requests');
          if (m.method === 'initialize' && badInit) { answer({ id: m.id, error: { code: -32600, message: 'synthetic init refusal', data: { type: 'modelProviderPolicyConflict' } } }); continue; }
          if (m.method === 'fixture/error') { answer({ id: m.id, error: { code: -32600, message: 'synthetic mismatch', data: { type: 'modelProviderMismatch', modelProvider: provider, currentModelProvider: 'other' } } }); continue; }
          if (m.method === 'fixture/notice') answer({ method: 'thread/status/changed', params: { threadId: 'synthetic-thread', status: { type: 'idle' } } });
          answer({ id: m.id, result: { provider, method: m.method, params: m.params } });
        }
      });
      child.kill = () => { if (child.signalCode !== null) return; child.signalCode = 'SIGTERM'; child.stdout.end(); queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); };
      children.push(child); return child;
    } });
  return { pool, launches, children, events, notifications, env };
}
async function exit(child) { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise(resolve => child.once('exit', resolve)); }

test('on-demand public stdio seam uses launch-scoped provider/definition and unchanged home/permissions; concurrent acquisition initializes exactly once', async t => {
  const f = setup(); t.after(async () => { f.pool.stop(); await Promise.all(f.children.map(exit)); });
  const [a, b] = await Promise.all([f.pool.get({ connectionId: id }, definition), f.pool.get({ connectionId: id }, definition)]);
  assert.equal(a, b); assert.equal(f.launches.length, 1);
  const l = f.launches[0]; assert.equal(l.exe, '/synthetic/pinned-codex'); assert.deepEqual(l.options.env, f.env);
  assert.deepEqual(l.args.slice(0, 3), ['-c', 'permissions="fixture-only"', '--no-daemon']);
  assert.ok(l.args.includes('--no-daemon')); assert.ok(l.args.includes('app-server'));
  assert.ok(l.args.includes('model_provider="bridge_custom_' + id + '"'));
  assert.match(l.args.at(-1), /^model_providers\.bridge_custom_a+={"name"="Synthetic only",/);
  const r = await a.request('fixture/notice', { threadId: 'synthetic-thread' });
  assert.equal(r.provider, 'bridge_custom_' + id); assert.equal(f.notifications[0].params.threadId, 'synthetic-thread');
  await assert.rejects(a.request('fixture/error', {}), e => e.code === -32600 && e.data.type === 'modelProviderMismatch');
  await assert.rejects(f.pool.get({ connectionId: id }, { ...definition, base_url: 'https://changed.example.invalid' }), /binding changed/);
  assert.equal(f.launches.length, 1); f.pool.stop(); await exit(f.children[0]);
  await assert.rejects(f.pool.get({ connectionId: id }, definition), /stopped/);
});

test('native init refusal or unexpected child exit is retained and never retried/fallen back to GPT', async t => {
  const f = setup({ badInit: true }); t.after(async () => { f.pool.stop(); await Promise.all(f.children.map(exit)); });
  for (let i = 0; i < 2; i++) await assert.rejects(f.pool.get({ connectionId: id }, definition), e => e.data.type === 'modelProviderPolicyConflict');
  assert.equal(f.launches.length, 1);
  const good = setup(); t.after(async () => { good.pool.stop(); await Promise.all(good.children.map(exit)); });
  await good.pool.get({ connectionId: id }, definition); good.children[0].kill(); await exit(good.children[0]);
  await assert.rejects(good.pool.get({ connectionId: id }, definition), /closed/); assert.equal(good.launches.length, 1);
});

test('no child before initialize; endpoint/helper literals are TOML-escaped without shell interpolation', async t => {
  const f = setup(); t.after(async () => { f.pool.stop(); await Promise.all(f.children.map(exit)); });
  f.pool.initialization = () => null;
  await assert.rejects(f.pool.get({ connectionId: id }, definition), /Initialize/); assert.equal(f.launches.length, 0);
  f.pool.initialization = () => initialize;
  const value = { ...definition, name: 'Synthetic "quote" $(no shell)', auth: { command: '/fixed/node', args: ['/fixed/helper', 'reference-only'], cwd: '/fixed', timeout_ms: 3000 } };
  await f.pool.get({ connectionId: id }, value);
  assert.ok(f.launches[0].args.at(-1).includes('"args"=["/fixed/helper","reference-only"]'));
  assert.ok(f.launches[0].args.at(-1).includes('Synthetic \\"quote\\" $(no shell)'));
  assert.equal(f.launches[0].options.shell, undefined);
});
