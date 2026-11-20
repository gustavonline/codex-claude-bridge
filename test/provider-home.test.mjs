import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, cpSync, openSync, closeSync, symlinkSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { prepareProviderHome, providerControls } from '../plugins/codex-claude/home/provider-controls.mjs';
import { ProviderRegistry, CredentialBroker, credentialToken, localModelId, LocalResponsesRouter } from '../plugins/codex-claude/home/providers.mjs';
import { session, homeHtml, homeResource } from '../plugins/codex-claude/home/server.mjs';
import { harness, hostReply, handshakeId, toolResult } from './support/home-host.mjs';
import { main as cli } from '../cli.mjs';
const endpointA = 'https://provider-a.example.invalid/v1', endpointB = 'https://provider-b.example.invalid/api/v1';
const temp = () => mkdtempSync(join(tmpdir(), 'bridge-provider-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function inventory(root) {
  const out = {};
  const walk = (dir, prefix = '') => { for (const name of readdirSync(dir)) {
    const p = join(dir, name), rel = prefix + name, s = lstatSync(p);
    if (s.isDirectory()) walk(p, rel + '/'); else { assert.ok(s.isFile()); out[rel] = sha(readFileSync(p)); }
  } }; walk(root); return out;
}
function syntheticCredentials() {
  const dir = temp(), a = join(dir, 'credential-a'), b = join(dir, 'credential-b'), path = join(dir, 'references.json');
  writeFileSync(a, 'SYNTHETIC-A-NOT-A-REAL-KEY\n', { mode: 0o600 }); writeFileSync(b, 'SYNTHETIC-B-NOT-A-REAL-KEY\n', { mode: 0o600 });
  writeFileSync(path, JSON.stringify({ version: 1, references: [{ id: 'fixture-a', baseUrl: endpointA, credentialFile: a }, { id: 'fixture-b', baseUrl: endpointB, credentialFile: b }] }), { mode: 0o600 });
  return { dir, path };
}
function requestFixture({ status = 200, model = 'fixture-model', onCall = () => {} } = {}) {
  const calls = [];
  const request = (url, options, done) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      onCall(); const res = new EventEmitter(); res.statusCode = status; res.destroy = () => { res.closed = true; };
      done(res); if (!res.closed) { res.emit('data', Buffer.from(JSON.stringify({ data: [{ id: model }] }))); res.emit('end'); }
    }); calls.push({ url, options }); return req;
  }; return { request, calls };
}
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } };
const ready = c => { const h = session(undefined, c); h(initialize); h({ jsonrpc: '2.0', method: 'notifications/initialized' }); return h; };
const home = h => h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } }).result.structuredContent;
const nodes = n => [n, ...n.children.flatMap(nodes)];
// v11: the Connections gear sits in the header actions and the breadcrumbs in the page title.
const buttons = h => [...nodes(h.elements['page-title']), ...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)].filter(n => n.tag === 'button');
const find = (h, label) => buttons(h).find(b => b.textContent === label || b.getAttribute('aria-label') === label);
const click = (h, label) => { const b = find(h, label); assert.ok(b, label); assert.equal(b.disabled, false, label + ' enabled'); for (const fn of b.listeners.click ?? []) fn({}); };
const field = (h, label) => nodes(h.elements.controls).find(n => n.tag === 'label' && (n.own === label || n.own === label + ' '))?.children.at(-1);
// v11 navigation: the gear (Home) or the breadcrumb (a connection page) leads to Connections; an open form is cancelled.
const toConnections = h => { if (find(h, 'Connections')) click(h, 'Connections'); if (field(h, 'Name')) click(h, 'Cancel'); };
const input = (h, label, value) => { if (label === 'Name' && !field(h, label)) { toConnections(h); click(h, 'Add connection'); } const f = field(h, label); assert.ok(f, label); f.value = value; for (const fn of f.listeners.input ?? []) fn({}); };
// A connection's own page replaces the v7 provider pick buttons and selected-provider panel.
const openProvider = (h, name) => { toConnections(h); click(h, name); };
// Entries of the open connection's "Default for new chats" menu (v7: the Model select plus "Use selected model").
const entries = h => buttons(h).filter(b => (b.getAttribute('data-focus-key') ?? '').startsWith('default-bridge-responses/'));
const defaults = h => { if (!entries(h).length) click(h, 'Default for new chats'); return entries(h); };
async function round(h, server, label) {
  if (label === 'Use selected model') { const [entry] = defaults(h); assert.equal(entry.disabled, false); entry.listeners.click.forEach(fn => fn({})); } else click(h, label);
  const m = h.sent('tools/call').at(-1); h.deliver(await server(m)); return m;
}

test('generic URL/auth references remain per provider; discovery uses only its exact credential and never follows HTTPS redirects', async () => {
  const root = temp(), creds = syntheticCredentials(), before = inventory(creds.dir), registry = new ProviderRegistry(root, creds.path);
  const a = registry.create({ name: 'Provider A', baseUrl: endpointA, authRef: 'fixture-a' });
  const b = registry.create({ name: 'Provider B', baseUrl: endpointB, authRef: 'fixture-b' });
  const first = requestFixture(), second = requestFixture();
  await registry.refresh(a, first); await registry.refresh(b, second);
  assert.equal(first.calls[0].url, endpointA + '/models'); assert.equal(second.calls[0].url, endpointB + '/models');
  assert.equal(first.calls[0].options.headers.Authorization, 'Bearer SYNTHETIC-A-NOT-A-REAL-KEY');
  assert.equal(second.calls[0].options.headers.Authorization, 'Bearer SYNTHETIC-B-NOT-A-REAL-KEY');
  assert.ok(!('rejectUnauthorized' in first.calls[0].options), 'TLS validation remains the native https default');
  const after = inventory(root);
  assert.throws(() => registry.create({ name: 'Edited endpoint', baseUrl: endpointB, authRef: 'fixture-a' }), { code: 'credential_endpoint_mismatch' });
  assert.deepEqual(inventory(root), after, 'URL edit cannot silently carry a credential');
  const redirect = requestFixture({ status: 302 }); await assert.rejects(registry.refresh(a, redirect));
  assert.equal(redirect.calls.length, 1); assert.equal(redirect.calls[0].url, endpointA + '/models');
  assert.equal(registry.read(a).catalog.status, 'stale'); assert.equal(registry.read(b).catalog.status, 'fresh');
  assert.deepEqual(inventory(creds.dir), before);
  assert.doesNotMatch(JSON.stringify(registry.all()), /SYNTHETIC-[AB]-NOT/);
});

test('credential helper is fixed/bounded and URL-bound; native auth config has references only and never combines incompatible auth controls', async () => {
  const root = temp(), creds = syntheticCredentials(), registry = new ProviderRegistry(root, creds.path);
  assert.throws(() => credentialToken(creds.path, 'fixture-a', endpointB), { code: 'credential_endpoint_mismatch' });
  const broker = new CredentialBroker(creds.path);
  assert.equal(await broker.token('fixture-a', endpointA), 'SYNTHETIC-A-NOT-A-REAL-KEY');
  const a = registry.create({ name: 'A', baseUrl: endpointA, authRef: 'fixture-a' }); await registry.refresh(a, requestFixture());
  const chosen = localModelId(a, 'fixture-model'); registry.select(a, chosen); const calls = [];
  const router = new LocalResponsesRouter({ root, credentialBindings: creds.path, native: { request: async (method, p) => {
    calls.push({ method, p }); if (method === 'model/list') return { data: [], nextCursor: null };
    return { thread: { id: 'fixture-auth-thread' }, model: p.model, modelProvider: p.modelProvider };
  } } });
  await router.request('thread/start', { model: chosen, sandbox: 'read-only', approvalPolicy: 'untrusted' }, () => { throw new Error('not native route'); });
  const p = calls.find(c => c.method === 'thread/start').p, def = p.config['model_providers.' + p.modelProvider];
  assert.equal(def.wire_api, 'responses'); assert.equal(def.base_url, endpointA); assert.equal(def.auth.command, process.execPath);
  assert.equal(def.auth.args.at(-1), endpointA); assert.equal(def.auth.timeout_ms, 3000);
  for (const key of ['env_key', 'experimental_bearer_token', 'requires_openai_auth']) assert.ok(!(key in def));
  assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC-A-NOT-A-REAL-KEY/);
  assert.equal(p.sandbox, 'read-only'); assert.equal(p.approvalPolicy, 'untrusted');
});

test('shipped Home public MCP lifecycle connects/discovers/selects/enables real provider semantics on fixture transport; no normal profile inference', async () => {
  const parent = temp(), prepared = prepareProviderHome(join(parent, 'scope')), net = requestFixture({ model: '<model&name>' });
  const controls = providerControls(prepared.bindingPath, { request: net.request }), server = ready(controls);
  const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(home(server)));
  input(h, 'Name', '<A&provider>'); input(h, 'Base URL', endpointA);
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  assert.equal(field(h, 'Name').value, '<A&provider>'); assert.equal(field(h, 'Base URL').value, endpointA);
  await round(h, server, 'Connect'); assert.equal(net.calls.length, 0, 'saving does not contact an endpoint');
  openProvider(h, '<A&provider>'); await round(h, server, 'Discover models'); assert.equal(net.calls.length, 1);
  assert.match(h.text('controls'), /<A&provider>|<model&name>/); assert.ok(h.created.every(n => n.tag !== 'img' && n.tag !== 'script'));
  await round(h, server, 'Use selected model');
  const beforeDisable = home(server).controls, provider = beforeDisable.providers.find(p => p.protocol === 'responses');
  assert.equal(provider.selected, provider.models[0].id); assert.equal(provider.protocol, 'responses');
  await round(h, server, 'Disconnect'); assert.equal(home(server).controls.providers.at(-1).enabled, false);
  await round(h, server, 'Reconnect'); assert.equal(home(server).controls.providers.at(-1).enabled, true);
  const registry = new ProviderRegistry(prepared.state); assert.equal(registry.all()[0].selected, provider.selected);
  const reopened = ready(providerControls(prepared.bindingPath, { request: net.request })); assert.equal(home(reopened).controls.providers.at(-1).selected, provider.selected);
  const list = server({ jsonrpc: '2.0', id: 3, method: 'tools/list' }).result.tools;
  assert.deepEqual(list.map(t => t.name), ['bridge_home', ...['status', 'auth_begin', 'auth_cancel', 'connect', 'refresh', 'select', 'enabled', 'harness', 'slots'].map(a => 'bridge_provider_' + a)]); assert.ok(list.slice(1).every(t => t._meta.ui.visibility[0] === 'app'));
  assert.equal(list.find(t => t.name === 'bridge_provider_refresh').annotations.openWorldHint, true);
  assert.match(homeHtml(), /A discovered catalog does not prove authentication, tool support, inference compatibility or native picker refresh/);
  input(h, 'Name', 'Retained draft'); const retainedConnect = buttons(h).find(b => b.textContent === 'Connect');
  h.deliver({ jsonrpc: '2.0', id: 'close', method: 'ui/resource-teardown' });
  for (const fn of retainedConnect.listeners.click ?? []) fn({});
  assert.equal(h.sent('tools/call').length, 5, 'teardown blocks every new action');
});

test('unbound/wrong-profile/malformed/stale/unknown-ref Home requests leave state unchanged; no file/command/token argument exists', async () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')), c = providerControls(p.bindingPath), server = ready(c), initial = inventory(p.state);
  const args = { ...p.scope, revision: 0, name: 'A', baseUrl: endpointA, authRef: null };
  const invoke = a => server({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bridge_provider_connect', arguments: a } });
  for (const bad of [{ ...args, profileId: 'f'.repeat(32) }, { ...args, revision: 9 }, { ...args, path: '/not-read' }, { ...args, command: 'not-executed' },
    { ...args, token: 'not-a-token' }, { ...args, authRef: 'not-bound' }, { ...args, name: '' }, { ...args, baseUrl: endpointA + '?api_key=refused' }]) {
    assert.equal((await invoke(bad)).result.isError, true); assert.deepEqual(inventory(p.state), initial);
  }
  const unbound = ready(null);
  assert.equal(unbound({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bridge_provider_connect', arguments: args } }).error.code, -32602);
  assert.deepEqual(inventory(p.state), initial);
  const ui = harness(); ui.deliver(hostReply(handshakeId(ui), { hostCapabilities: { serverTools: {} } })); ui.deliver(toolResult(home(server)));
  input(ui, 'Name', 'A');
  for (const url of ['https://user:synthetic-secret@provider.example.invalid/v1', endpointA + '?api_key=synthetic-secret', endpointA + '#synthetic-secret']) {
    input(ui, 'Base URL', url); click(ui, 'Connect');
    assert.equal(ui.sent('tools/call').length, 0, 'URL-carried secrets never enter public tool-input traces');
  }
  assert.deepEqual(inventory(p.state), initial);
});

test('uncertain provider write retains public-MCP status recovery without replay; disable denies new local turns while reads/GPT stay separate', async () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')), net = requestFixture(), c = providerControls(p.bindingPath, { request: net.request }), server = ready(c);
  const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(home(server)));
  input(h, 'Name', 'A'); input(h, 'Base URL', endpointA); click(h, 'Connect');
  const call = h.sent('tools/call').at(-1), answer = await server(call);
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' }); h.deliver(answer);
  assert.equal(h.sent('tools/call').length, 1); assert.deepEqual(buttons(h).map(b => b.textContent), ['Retry state update']);
  const status = await round(h, server, 'Retry state update'); assert.equal(status.params.name, 'bridge_provider_status'); assert.deepEqual(status.params.arguments, p.scope);
  assert.equal(home(server).controls.providers.filter(v => v.protocol === 'responses').length, 1, 'cancelled committed connect was not repeated');
  assert.equal(h.sent('tools/call').filter(m => m.params.name === 'bridge_provider_connect').length, 1);
  openProvider(h, 'A'); await round(h, server, 'Discover models'); await round(h, server, 'Use selected model');
  const provider = home(server).controls.providers.at(-1), nativeCalls = [], router = new LocalResponsesRouter({ root: p.state, native: { request: async (method, args) => {
    nativeCalls.push({ method, args }); if (method === 'model/list') return { data: [], nextCursor: null };
    return { thread: { id: 'declared-provider-thread' }, model: args.model, modelProvider: args.modelProvider };
  } } });
  await router.request('thread/start', { model: provider.selected }, () => { throw new Error(); });
  await round(h, server, 'Disconnect'); const n = nativeCalls.length;
  await assert.rejects(router.request('turn/start', { threadId: 'declared-provider-thread', input: [] }, () => {}), { code: 'provider_disabled' });
  assert.equal(nativeCalls.length, n);
  assert.equal(await router.request('thread/read', { threadId: 'declared-provider-thread' }, async () => 'retained native read'), 'retained native read');
  assert.equal(await router.request('thread/start', { model: 'gpt-test' }, async () => 'unchanged GPT'), 'unchanged GPT');
  // Custom-chat queueing is qualified now (desktop-provider-affinity covers the enabled path); a disabled connection refuses it before dispatch.
  await assert.rejects(router.request('thread/queue/add', { threadId: 'declared-provider-thread' }, () => {}), { code: 'provider_disabled' }); assert.equal(nativeCalls.length, n);
});

test('copied plugin serves the actual provider entrypoint and current Home HTML over regular-file public MCP stdio, without owner environment or setup', async () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')), copy = join(parent, 'plugin');
  cpSync(fileURLToPath(new URL('../plugins/codex-claude', import.meta.url)), copy, { recursive: true, force: false, errorOnExist: true });
  const messages = [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: homeResource } }];
  const input = join(parent, 'input'), output = join(parent, 'output'), error = join(parent, 'error');
  writeFileSync(input, messages.map(m => JSON.stringify(m)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const fds = [openSync(input, 'r'), openSync(output, 'wx', 0o600), openSync(error, 'wx', 0o600)];
  const child = spawn(process.execPath, [join(copy, 'home/provider-server.mjs'), '--provider-binding', p.bindingPath], { env: { HOME: parent, CODEX_HOME: parent, PATH: '/usr/bin:/bin' }, stdio: fds });
  let result; const closed = new Promise(resolve => child.on('close', (code, signal) => { result = { code, signal }; resolve(); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    await closed; assert.deepEqual(result, { code: 0, signal: null }); assert.equal(readFileSync(error, 'utf8'), '');
    const rows = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 4); assert.equal(rows.find(r => r.id === 2).result.tools.length, 10);
    assert.equal(rows.find(r => r.id === 3).result.structuredContent.controls.kind, 'responses-trial');
    assert.equal(rows.find(r => r.id === 4).result.contents[0].text, homeHtml());
    assert.equal(homeResource, 'ui://codex-claude/home-v11.html'); assert.doesNotMatch(JSON.stringify(rows), new RegExp(parent));
    assert.deepEqual(readdirSync(p.state), [], 'only status/resources were requested; no registry, HTTP, model or profile changes');
  } finally { clearTimeout(timer); if (!result) { child.kill('SIGKILL'); await closed; } fds.forEach(closeSync); }
});

test('Home switches among providers without losing per-provider choices; unrelated context keeps the form draft and each connection default', async () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')), server = ready(providerControls(p.bindingPath, { request: requestFixture().request }));
  const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(home(server)));
  input(h, 'Name', 'A'); input(h, 'Base URL', endpointA); await round(h, server, 'Connect'); openProvider(h, 'A'); await round(h, server, 'Discover models'); await round(h, server, 'Use selected model');
  const a = home(server).controls.providers.find(v => v.name === 'A');
  input(h, 'Name', 'B'); input(h, 'Base URL', endpointB); await round(h, server, 'Connect'); openProvider(h, 'B'); await round(h, server, 'Discover models'); await round(h, server, 'Use selected model');
  const all = home(server).controls.providers, b = all.find(v => v.name === 'B');
  assert.notEqual(a.selected, b.selected, 'same model slug gets a distinct provider namespace');
  openProvider(h, 'A');
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  // v11 has no provider pick buttons or Model select: the connection page and its default menu show A's own choice.
  assert.equal(h.text('page-title'), 'Model Bridge/Connections/A');
  assert.deepEqual(defaults(h).map(e => [e.getAttribute('data-focus-key'), e.textContent.startsWith('✓ ')]), [['default-' + a.selected, true]]);
  toConnections(h); click(h, 'Add connection');
  assert.equal(field(h, 'Name').value, 'B', 'form draft is not silently replaced on context renders or reopening');
  openProvider(h, 'A'); await round(h, server, 'Disconnect');
  const next = home(server).controls.providers; assert.equal(next.find(v => v.id === a.id).enabled, false); assert.equal(next.find(v => v.id === b.id).enabled, true);
  assert.equal(next.find(v => v.id === a.id).selected, a.selected); assert.equal(next.find(v => v.id === b.id).selected, b.selected);
});

test('Home outage preserves stale catalog, reports unknown action outcome and recovers only through a same-scope status read without replay', async () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')); let down = false;
  const live = requestFixture(), outage = requestFixture({ status: 503 });
  const server = ready(providerControls(p.bindingPath, { request: (...args) => (down ? outage : live).request(...args) }));
  const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(home(server)));
  input(h, 'Name', 'A'); input(h, 'Base URL', endpointA); await round(h, server, 'Connect'); openProvider(h, 'A'); await round(h, server, 'Discover models');
  const kept = home(server).controls.providers.at(-1).models;
  down = true; const refresh = await round(h, server, 'Refresh catalog'), calls = h.sent('tools/call').length;
  assert.deepEqual(buttons(h).map(b => b.textContent), ['Retry state update']); assert.match(h.text('controls'), /The catalog request failed\..*Its current state is unknown/);
  // v11 reads status automatically once uncertain (home-dashboard covers it); the refresh itself is never retried.
  assert.equal(outage.calls.length, 1); h.advance(60000); assert.equal(outage.calls.length, 1, 'no automatic retry');
  const status = h.sent('tools/call').at(-1); assert.equal(status.params.name, 'bridge_provider_status'); assert.deepEqual(status.params.arguments, p.scope);
  assert.ok(h.sent('tools/call').slice(calls).every(m => m.params.name === 'bridge_provider_status')); assert.equal(h.sent('tools/call').filter(m => m.id === refresh.id).length, 1);
  h.deliver(await server(status));
  assert.match(h.text('controls'), /Catalog: stale/); assert.ok(defaults(h).length && defaults(h).every(e => e.disabled), 'a stale catalog offers no default choice');
  assert.deepEqual(home(server).controls.providers.at(-1).models, kept);
  down = false; await round(h, server, 'Refresh catalog');
  assert.ok(defaults(h).length && defaults(h).every(e => !e.disabled));
});

test('generic provider CLI operates only on explicit task state and shares Home selection/enable persistence', async () => {
  const root = temp(), saved = console.log, output = [];
  console.log = text => output.push(JSON.parse(text));
  try {
    await assert.rejects(cli(['provider', 'list']), /explicit task/);
    await cli(['provider', 'connect', '--state', root, '--name', 'Explicit provider', '--url', endpointA]);
    const id = output.at(-1).providerId, registry = new ProviderRegistry(root);
    await registry.refresh(id, requestFixture());
    await cli(['provider', 'list', '--state', root]);
    const model = output.at(-1)[0].catalog.models[0].id;
    await cli(['provider', 'select', '--state', root, '--provider', id, '--model', model]);
    await cli(['provider', 'enabled', '--state', root, '--provider', id, '--enabled', 'false']);
    assert.equal(output.at(-1).enabled, false); assert.equal(output.at(-1).selected, model);
    assert.equal(registry.read(id).selected, model);
    const before = inventory(root);
    await assert.rejects(cli(['provider', 'connect', '--state', root, '--name', 'Unbound auth', '--url', endpointA, '--auth-ref', 'not-bound']));
    await assert.rejects(cli(['provider', 'list', '--state', root, '--source', '/not-read']));
    await assert.rejects(cli(['provider', 'enabled', '--state', root, '--provider', id, '--enabled', 'yes']));
    assert.deepEqual(inventory(root), before);
  } finally { console.log = saved; }
});

test('correctly named linked provider manifest/backend and credential files are refused before body use without modifying their synthetic targets', () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope'));
  const original = readFileSync(p.bindingPath), saved = join(parent, 'retained-manifest');
  renameSync(p.bindingPath, saved); symlinkSync(saved, p.bindingPath);
  assert.throws(() => providerControls(p.bindingPath), { code: 'unsafe_file' });
  assert.deepEqual(readFileSync(saved), original, 'basename is valid, so NOFOLLOW is exercised');
  const other = temp(), r = new ProviderRegistry(other), id = r.create({ name: 'A', baseUrl: endpointA });
  const path = join(other, 'responses-providers', id, 'local-responses.json'), copy = join(other, 'retained-backend');
  renameSync(path, copy); symlinkSync(copy, path); const before = readFileSync(copy);
  assert.throws(() => r.read(id), { code: 'unsafe_file' }); assert.deepEqual(readFileSync(copy), before);
  const creds = syntheticCredentials(), key = join(creds.dir, 'credential-a'), kept = join(creds.dir, 'retained-key');
  renameSync(key, kept); symlinkSync(kept, key); const bytes = readFileSync(kept);
  assert.throws(() => credentialToken(creds.path, 'fixture-a', endpointA)); assert.deepEqual(readFileSync(kept), bytes);
});
