import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { observeHome, homeText, homeHtml, appScript, session, homeResource, protocolVersions } from '../plugins/codex-claude/home/server.mjs';

const server = fileURLToPath(new URL('../plugins/codex-claude/home/server.mjs', import.meta.url));
const pluginDirectory = join(server, '../..');
const audit = fileURLToPath(new URL('./support/fs-audit.mjs', import.meta.url));
const escaped = text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const unscoped = 'This view cannot tell which Codex profile it runs in. Establish the intended profile first; Bridge diagnostics apply only to the profile they are run for.';

// ---- What the server observes: only its own MCP connection ----

test('without a proven profile scope only the plugin connection can be observed, and the rest is a fixed unknown', () => {
  const direct = observeHome();
  assert.deepEqual(Object.keys(direct.facts), ['payload', 'connection', 'activation', 'evidence']);
  assert.deepEqual(Object.values(direct.facts).map(fact => fact.state), ['unknown', 'unknown', 'unknown', 'unknown'], 'a direct observation does not invent a connection');
  const connected = observeHome({ connected: true });
  assert.deepEqual(Object.values(connected.facts).map(fact => fact.state), ['unknown', 'observed', 'unknown', 'unknown']);
  assert.equal(connected.next, unscoped);
  const text = homeText(connected);
  assert.deepEqual(text.split('\n').filter(line => line.startsWith('✓')), ["✓ Plugin connection: This view was requested over the plugin's MCP connection."]);
  assert.equal(text.split('\n').filter(line => line.startsWith('Next:')).length, 1);
  assert.doesNotMatch(JSON.stringify(connected) + text, /quit Codex|restart|Codex \+ Claude \(main app\)|updat|not supported|Install and start|codex-claude|Check my Codex/i, 'no install, normal-app setup, restart, update or unscoped-command advice');
  assert.doesNotMatch(JSON.stringify(connected) + text, /\/Users\/|\/home\/|\.local\/share|Application Support|settings\.json/, 'names no location');
});

// ---- The real stdio server, with a filesystem audit ----

const initialize = (id, protocolVersion = '2025-06-18', extra = {}) => ({ jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'synthetic-client', version: '0' }, ...extra } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

// A synthetic home holding decoys at every location the earlier Home read.
// None of it may be read, and nothing from it may reach the output.
function decoyHome() {
  const home = mkdtempSync(join(tmpdir(), 'bridge-home-'));
  const write = (path, body) => { mkdirSync(join(home, path, '..'), { recursive: true }); writeFileSync(join(home, path), JSON.stringify(body)); };
  const uuid = '11111111-2222-3333-4444-555555555555';
  write('.local/share/codex-claude-bridge/node_modules/codex-claude-bridge-local/package.json', { name: 'codex-claude-bridge-local', version: '9.9.9-DECOY' });
  write('.config/codex-claude-bridge/settings.json', { state: join(home, 'DECOYSTATE'), app: '/Applications/Codex.app' });
  write(`Library/Application Support/Codex Claude Bridge/threads/${uuid}.json`, { turns: [{ provider: 'claude', status: 'completed', completedAt: 1_800_000_000, text: 'DECOY-HISTORY' }] });
  write(`Library/Application Support/Codex Claude Bridge/primary/runtime/1-${uuid}.json`, { pid: 1, runId: uuid, startedAt: 1 });
  write('.codex/auth.json', { token: 'DECOY-SECRET' });
  return home;
}

async function runServer(messages, { home = decoyHome(), env = {} } = {}) {
  const log = join(home, 'fs-audit.log');
  writeFileSync(log, '');
  // Finite batch stdio over ordinary files: no claim about the retained Z13
  // asynchronous pipe failure or an interactive native Desktop transport.
  const input = join(home, 'stdio-input.jsonl'), output = join(home, 'stdio-output.jsonl'), error = join(home, 'stdio-error.txt');
  writeFileSync(input, messages.map(message => typeof message === 'string' ? message : JSON.stringify(message)).join('\n') + '\n');
  const fds = [openSync(input, 'r'), openSync(output, 'w', 0o600), openSync(error, 'w', 0o600)];
  const child = spawn(process.execPath, ['--import', audit, server], { cwd: pluginDirectory, stdio: fds,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), FS_AUDIT_LOG: log, ...env } });
  const [code, signal] = await once(child, 'close');
  fds.forEach(closeSync);
  const stdout = readFileSync(output, 'utf8'), stderr = readFileSync(error, 'utf8');
  const lines = stdout.split('\n').slice(0, -1);
  const parsed = lines.map(line => { try { return JSON.parse(line); } catch { return undefined; } });
  assert.ok(stdout.endsWith('\n') && parsed.every(Boolean), `server output ${JSON.stringify({ code, signal, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) })}`);
  const accessed = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.slice(line.indexOf(' ') + 1));
  return { parsed, stdout, stderr, accessed, home, close: () => rmSync(home, { recursive: true, force: true }) };
}

const insidePlugin = path => path === pluginDirectory || path.startsWith(pluginDirectory + sep);

test('the stdio server initializes, lists, calls and serves the view with an exact MIME type, URI, empty CSP and text fallback, touching only its own plugin files', async () => {
  const run = await runServer([initialize(1, '2025-11-25'), initialized, request(2, 'tools/list'), request(3, 'tools/call', { name: 'bridge_home', arguments: {} }),
    request(4, 'resources/list'), request(5, 'resources/read', { uri: homeResource }), request(6, 'resources/read', { uri: 'ui://codex-claude/home.html' }), request(7, 'resources/read', { uri: 'ui://codex-claude/home-v2.html' })]);
  try {
    const [init, list, called, resources, read, old, oldV2] = run.parsed;
    assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ['2025-11-25', 'model-bridge-home']);
    const [tool] = list.result.tools;
    assert.deepEqual([tool.name, tool.annotations.readOnlyHint, tool._meta.ui.resourceUri], ['bridge_home', true, 'ui://codex-claude/home-v11.html']);
    assert.equal(homeResource, 'ui://codex-claude/home-v11.html', 'a new URI replaces the earlier home.html and home-v2.html that hosts may have cached');
    assert.match(called.result.content[0].text, /^\? Installed: Not checked.*\n✓ Plugin connection: .*\n.*\nNext: /s, 'the text fallback is complete without the view');
    assert.equal(called.result.structuredContent.facts.connection.state, 'observed');
    const csp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
    assert.deepEqual(resources.result.resources.map(({ uri, mimeType, _meta }) => [uri, mimeType, _meta.ui.csp]), [[homeResource, 'text/html;profile=mcp-app', csp]]);
    const [view] = read.result.contents;
    assert.deepEqual([view.uri, view.mimeType, view._meta.ui.csp], [homeResource, 'text/html;profile=mcp-app', csp]);
    // OpenAI's documented extension layer sits beside the complete standard one.
    assert.deepEqual(tool._meta['openai/ui'], { entrypoints: [{ type: 'global' }, { type: 'thread' }] });
    assert.deepEqual(view._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' });
    assert.equal(view._meta.ui.prefersBorder, true);
    assert.deepEqual(resources.result.resources[0]._meta['openai/ui'], view._meta['openai/ui']);
    assert.deepEqual(Object.keys(view._meta).sort(), ['openai/ui', 'ui'], 'no other host-specific metadata');
    assert.equal(view.text, homeHtml());
    assert.deepEqual([old.error.code, oldV2.error.code], [-32602, -32602], 'the earlier URIs are not served');
    // Zero reads outside this plugin: no home, settings, runtime, state, history or auth path.
    for (const path of run.accessed) assert.ok(insidePlugin(path), `unexpected read: ${path}`);
    assert.doesNotMatch(run.stdout, /DECOY|9\.9\.9|completedAt/);
    assert.doesNotMatch(run.stdout, escaped(run.home));
    assert.equal(run.stderr, '');
  } finally { run.close(); }
});

test('the filesystem audit really observes reads, and no tool argument or environment selects a path', async () => {
  const home = decoyHome();
  try {
    const other = join(home, 'elsewhere');
    const withArgs = await runServer([initialize(1), initialized, request(2, 'tools/call', { name: 'bridge_home', arguments: { path: other, state: other, home: other } })], { home });
    const withEnv = await runServer([initialize(1), initialized, request(2, 'tools/call', { name: 'bridge_home', arguments: {} })],
      { home, env: { BRIDGE_STATE: other, CODEX_HOME: other, BRIDGE_REAL_CODEX: other } });
    assert.ok(withArgs.accessed.some(path => path.endsWith(join('.codex-plugin', 'plugin.json'))), 'the audit saw the server read its own manifest');
    const facts = run => run.parsed[1].result.structuredContent.facts;
    assert.deepEqual(facts(withArgs), facts(withEnv));
    assert.equal(facts(withArgs).payload.state, 'unknown');
    for (const run of [withArgs, withEnv]) for (const path of run.accessed) assert.ok(insidePlugin(path), `unexpected read: ${path}`);
    const [tool] = (await runServer([initialize(1), initialized, request(2, 'tools/list')], { home })).parsed[1].result.tools;
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the tool accepts empty arguments, absent arguments and ignores extra ones, with the entrypoint declarations on the listed tool only', async () => {
  const run = await runServer([initialize(1), initialized, request(2, 'tools/call', { name: 'bridge_home', arguments: {} }), request(3, 'tools/call', { name: 'bridge_home' }),
    request(4, 'tools/call', { name: 'bridge_home', arguments: { path: '/etc', command: 'sh' } }), request(5, 'tools/list')]);
  try {
    const [, empty, absent, extra, list] = run.parsed;
    for (const response of [empty, absent, extra]) assert.deepEqual(Object.keys(response.result.structuredContent.facts), ['payload', 'connection', 'activation', 'evidence']);
    assert.deepEqual(extra.result.structuredContent.facts, empty.result.structuredContent.facts, 'an argument selects nothing');
    assert.equal(list.result.tools.length, 1);
    assert.deepEqual(list.result.tools[0]._meta, { ui: { resourceUri: homeResource }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } });
    assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
    for (const path of run.accessed) assert.ok(insidePlugin(path), `unexpected read: ${path}`);
  } finally { run.close(); }
});

test('the server source reads only its plugin manifest and starts no process', () => {
  const source = readFileSync(server, 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]).sort(), ['node:fs', 'node:readline', 'node:url']);
  assert.deepEqual([...source.matchAll(/\b(readFileSync|readdirSync|statSync|spawnSync|execFileSync|homedir)\(/g)].map(match => match[1]), ['readFileSync']);
});

// ---- MCP session behaviour (unchanged protocol rules) ----

test('the MCP server lists one read-only tool bound to its app view, connected only after a valid handshake', () => {
  const observations = [];
  const observe = ({ connected }) => { observations.push(connected); return { pluginVersion: 'test', observedAt: 'now', next: 'Wait.', facts: { payload: { state: 'unknown', detail: 'x' } } }; };
  const handle = session(observe);
  const call = id => handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } });
  call(0);
  assert.equal(handle(initialized), null);
  call(1);
  const init = handle(initialize(2));
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name], ['2025-06-18', 'model-bridge-home']);
  call(3);
  assert.equal(handle(initialized), null);
  const [tool] = handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }).result.tools;
  assert.deepEqual([tool.name, tool.annotations.readOnlyHint, tool._meta.ui.resourceUri], ['bridge_home', true, homeResource]);
  const called = call(5).result;
  assert.equal(called.structuredContent.next, 'Wait.');
  assert.match(called.content[0].text, /Next: Wait\./);
  const [resource] = handle({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: homeResource } }).result.contents;
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /^<!doctype html>/);
  assert.deepEqual(observations, [false, false, false, true], 'unconnected before initialize and until the client confirms it; the static view observes nothing');
  assert.equal(handle(initialize(7)).error.code, -32600, 'a second initialize is rejected');
  assert.equal(handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'other' } }).error.code, -32602);
  assert.equal(handle({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'ui://other' } }).error.code, -32602);
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 10, method: 'shell/run' }), { jsonrpc: '2.0', id: 10, error: { code: -32601, message: 'Method not found' } });
  assert.equal(handle({ jsonrpc: '2.0', id: 11, result: {} }), null, 'a client response gets no reply');
  session(observe)({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'bridge_home' } });
  assert.equal(observations.at(-1), false, 'each connection starts unconnected');
});

test('invalid requests and initializations are rejected without certifying a connection or stopping the session', () => {
  const observations = [];
  const handle = session(({ connected }) => { observations.push(connected); return { pluginVersion: 't', observedAt: 'n', next: 'n', facts: {} }; });
  const invalid = (message, id = null) => assert.deepEqual(handle(message), { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
  for (const message of [null, 5, 'text', true, [], [{ jsonrpc: '2.0', id: 1, method: 'ping' }]]) invalid(message);
  invalid({ id: 1, method: 'ping' }, 1);
  invalid({ jsonrpc: '1.0', id: 'a', method: 'ping' }, 'a');
  invalid({ jsonrpc: '2.0', id: null, method: 'ping' });
  invalid({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' });
  invalid({ jsonrpc: '2.0', id: 1.5, method: 'ping' });
  invalid({ jsonrpc: '2.0', id: 2, method: 7 }, 2);
  invalid({ jsonrpc: '2.0', id: 3 }, 3);
  invalid({ jsonrpc: '2.0', id: 4, method: 'ping', params: [] }, 4);
  invalid({ ...initialize(5), jsonrpc: undefined }, 5);
  const client = { name: 'c', version: '0' };
  for (const params of [undefined, { protocolVersion: 7, capabilities: {}, clientInfo: client }, { protocolVersion: '2025-06-18', capabilities: {} },
    { protocolVersion: '2025-06-18', clientInfo: client }, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 7, version: '0' } },
    { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic' } }, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: 1 } }])
    assert.deepEqual(handle({ jsonrpc: '2.0', id: 6, method: 'initialize', ...(params ? { params } : {}) }).error,
      { code: -32602, message: 'Invalid initialize parameters' });
  invalid({ ...initialize(6), params: { ...initialize(6).params, _meta: 5 } }, 6);
  assert.equal(handle({ ...initialized, jsonrpc: '1.0' }), null);
  handle(initialized);
  handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bridge_home' } });
  assert.deepEqual(observations, [false], 'no malformed initialize or early confirmation connects');
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 8, method: 'ping' }), { jsonrpc: '2.0', id: 8, result: {} }, 'the session still answers');
  const unsupported = handle(initialize(9, '1999-01-01'));
  assert.equal(unsupported.result.protocolVersion, protocolVersions[0], 'an unknown version is offered the newest supported one');
  assert.deepEqual(protocolVersions, ['2025-11-25', '2025-06-18']);
  assert.equal(session(() => ({}))(initialize(1, '2025-11-25')).result.protocolVersion, '2025-11-25');
  const broken = session(() => { throw new Error('/private/path SECRET'); });
  assert.deepEqual(broken({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_home' } }).error, { code: -32603, message: 'Home could not be observed' });
  assert.equal(broken({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: homeResource } }).result.contents[0].text, homeHtml(), 'the static view needs no observation');
  assert.deepEqual(broken({ jsonrpc: '2.0', id: 3, method: 'ping' }).result, {});
});

test('a malformed initialized notification does not connect, and a later valid one still does', () => {
  const observations = [];
  const handle = session(({ connected }) => { observations.push(connected); return { pluginVersion: 't', observedAt: 'n', next: 'n', facts: {} }; });
  const call = id => handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bridge_home' } });
  assert.equal(handle(initialize(1)).result.protocolVersion, '2025-06-18');
  for (const params of [[], 'text', 5, null, { _meta: 5 }, { _meta: [] }]) {
    assert.equal(handle({ ...initialized, params }), null, 'notifications get no reply');
    call(2);
  }
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/other' }), null);
  call(3);
  assert.deepEqual(observations, [false, false, false, false, false, false, false]);
  assert.equal(handle({ ...initialized, params: { _meta: {} } }), null);
  call(4);
  assert.equal(observations.at(-1), true, 'a valid confirmation with params connects');
  const plain = session(({ connected }) => { observations.push(connected); return { facts: {}, next: 'n' }; });
  plain(initialize(1, '2025-11-25'));
  plain(initialized);
  plain({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home' } });
  assert.equal(observations.at(-1), true, 'a valid confirmation without params connects');
});

test('the plugin entrypoint answers every line once, survives bad input, and connects only after a valid confirmation', async () => {
  const noVersion = initialize(5);
  noVersion.params.clientInfo = { name: 'synthetic' };
  const call = id => JSON.stringify(request(id, 'tools/call', { name: 'bridge_home' }));
  const run = await runServer(['not json', 'null', '[]', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 7 } }),
    JSON.stringify(noVersion), call(2), JSON.stringify(initialize(3)), JSON.stringify({ ...initialized, params: [] }), call(6), JSON.stringify(initialized), call(4)]);
  try {
    assert.equal(run.parsed.length, 9);
    const [parse, nul, array, badInit, badClient, before, init, early, after] = run.parsed;
    assert.equal(parse.error.code, -32700);
    assert.deepEqual([nul.error.code, array.error.code, badInit.error.code, badClient.error.code], [-32600, -32600, -32602, -32602]);
    assert.equal(before.result.structuredContent.facts.connection.state, 'unknown');
    assert.deepEqual([init.id, init.result.protocolVersion], [3, '2025-06-18']);
    assert.deepEqual([early.id, early.result.structuredContent.facts.connection.state], [6, 'unknown'], 'a malformed confirmation does not connect');
    assert.equal(after.result.structuredContent.facts.connection.state, 'observed');
    assert.equal(run.stderr, '');
  } finally { run.close(); }
});

// ---- The shipped view, executed against a synthetic MCP Apps host ----
// This runs the exact script the server serves in a Node VM with a fake DOM,
// a fake window and a fake ResizeObserver over a simple layout model. It is
// behavioural proof of the lifecycle code, not a screenshot or a real browser
// or host: it cannot show that any Codex build displays the view.

import { viewOf, harness, hostReply, toolResult, sample, marksOf, handshakeId, sizes } from './support/home-host.mjs';

test('the view performs ui/initialize, waits for the reply, then confirms; results render only as data received', () => {
  const h = harness();
  assert.deepEqual(h.events, ['listen:message', 'listen:resize', 'post'], 'the handler is registered before the handshake request is sent');
  assert.equal(h.posted.length, 1);
  const [{ message: init, target }] = h.posted;
  assert.deepEqual([init.jsonrpc, init.method, typeof init.id], ['2.0', 'ui/initialize', 'number']);
  assert.deepEqual([init.params.protocolVersion, init.params.appInfo.name], ['2026-01-26', 'model-bridge-home']);
  assert.deepEqual(init.params.appCapabilities, { availableDisplayModes: ['inline', 'fullscreen'] }, 'the view declares the display modes it supports');
  assert.equal(target, '*', 'the host origin is opaque to a sandboxed view; only the handshake is sent');
  assert.match(h.text('status'), /waiting for the host to answer initialization/);
  assert.match(h.text('status'), /Result: none received yet/);
  assert.equal(h.text('alert'), 'Connecting to the host…');
  assert.equal(h.elements.facts.children.length, 0, 'no fact is shown before any result');
  assert.equal(h.sent('ui/notifications/initialized').length, 0, 'not confirmed before the reply');
  assert.equal(sizes(h).length, 0, 'no size before the handshake');
  // A tool result delivered early (before the reply) is shown as data, but the handshake is not claimed.
  h.deliver(toolResult(sample()));
  assert.match(h.text('status'), /waiting for the host to answer initialization/);
  assert.match(h.text('status'), /Result: received from the host\. This shows data arrived, not that this panel is visible on screen/);
  assert.equal(h.text('alert'), 'Connecting to the host…', 'data alone does not clear the connection notice');
  assert.deepEqual(marksOf(h), [['unknown', '?'], ['observed', '✓'], ['unknown', '?'], ['unknown', '?']]);
  assert.equal(h.sent('ui/notifications/initialized').length, 0);
  assert.equal(sizes(h).length, 0);
  // The reply completes it: initialized follows, then the size, and the notice goes away.
  h.deliver(hostReply(handshakeId(h)));
  assert.match(h.text('status'), /Host: initialization completed \(MCP Apps protocol 2026-01-26\)/);
  assert.deepEqual(h.posted.slice(1).map(({ message }) => message.method), ['ui/notifications/initialized', 'ui/notifications/size-changed']);
  assert.equal(h.elements.alert.hidden, true);
  assert.equal(h.text('alert'), '');
  // Input is ignored; a later result replaces the first.
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } });
  h.deliver(toolResult(sample({ next: 'Second.', facts: { ...sample().facts, activation: { state: 'observed', detail: 'Seen.' } } })));
  assert.match(h.text('next'), /^Next: Second\.$/);
  assert.deepEqual(marksOf(h).map(([, mark]) => mark), ['?', '✓', '✓', '?']);
  // Requests from the host get answers with their own id.
  h.deliver({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' });
  h.deliver({ jsonrpc: '2.0', id: 7, method: 'something/else' });
  const answers = h.posted.map(({ message }) => message).filter(message => 'id' in message && message.id !== init.id);
  assert.deepEqual(answers, [{ jsonrpc: '2.0', id: 'ping-1', result: {} }, { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } }]);
  // A cancelled call clears the result and says so; a failing one shows an error; neither is success.
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: { reason: 'user' } });
  assert.match(h.text('status'), /Result: the host cancelled the tool call/);
  assert.equal(h.text('alert'), 'The host cancelled the tool call.');
  assert.equal(h.elements.facts.children.length, 0);
  h.deliver(toolResult(sample(), { isError: true }));
  assert.match(h.text('status'), /Result: the tool call reported an error/);
  assert.equal(h.text('alert'), 'The tool call reported an error.');
  assert.equal(h.elements.facts.children.length, 0, 'an error result shows no facts');
  h.deliver(toolResult(sample()));
  assert.equal(h.elements.facts.children.length, 4);
  assert.equal(h.elements.alert.hidden, true);
  // Teardown: answered with the same id, then the view ignores the host.
  h.deliver({ jsonrpc: '2.0', id: 'bye', method: 'ui/resource-teardown', params: { reason: 'closed' } });
  assert.deepEqual(h.posted.at(-1).message, { jsonrpc: '2.0', id: 'bye', result: {} });
  assert.match(h.text('status'), /Host: closed this view/);
  assert.equal(h.text('alert'), 'The host closed this view.');
  assert.equal(h.sent('ui/request-display-mode').length, 0, 'the view never asks the host to change mode');
});

test('a host that answers late is still confirmed exactly once; the time bound only changes the status', () => {
  const h = harness();
  const id = handshakeId(h);
  h.advance(7999);
  assert.match(h.text('status'), /waiting for the host to answer/);
  h.advance(1);
  assert.match(h.text('status'), /no answer to initialization within 8 s; still waiting for a late answer/);
  assert.equal(h.text('alert'), 'The host has not answered initialization yet.');
  assert.equal(h.sent('ui/notifications/initialized').length, 0);
  // Data that arrives meanwhile is shown as received, and nothing claims that nothing was received.
  h.deliver(toolResult(sample()));
  assert.match(h.text('status'), /Result: received from the host/);
  assert.doesNotMatch(h.text('status'), /Nothing was received|none received/i);
  assert.equal(h.elements.facts.children.length, 4);
  // Wrong id and foreign answers do not count, and neither does a reply to another request.
  h.deliver(hostReply(id + 1)); h.deliver(hostReply(id), h.stranger); h.deliver({ ...hostReply(id + 2), error: { code: 1, message: 'x' } });
  assert.equal(h.sent('ui/notifications/initialized').length, 0);
  assert.match(h.text('status'), /still waiting for a late answer/);
  // The matching valid answer completes the handshake once.
  h.deliver(hostReply(id, { hostContext: { theme: 'dark' } }));
  assert.equal(h.sent('ui/notifications/initialized').length, 1);
  assert.match(h.text('status'), /initialization completed/);
  assert.equal(h.elements.alert.hidden, true);
  assert.equal(h.root.attributes['data-theme'], 'dark');
  assert.ok(sizes(h).length >= 1);
  // Repeated, denied or foreign answers afterwards change nothing.
  h.deliver(hostReply(id)); h.deliver({ jsonrpc: '2.0', id, error: { code: 1, message: 'late no' } }); h.deliver(hostReply(id), h.stranger);
  assert.equal(h.sent('ui/notifications/initialized').length, 1, 'confirmed exactly once');
  assert.match(h.text('status'), /initialization completed/);
  assert.equal(h.sent('ui/initialize').length, 1, 'the request is never repeated');
});

test('the first answer is final: a late denial, unusable answer or answer after teardown never confirms', () => {
  const denied = harness();
  denied.advance(8000);
  denied.deliver({ jsonrpc: '2.0', id: handshakeId(denied), error: { code: -32601, message: 'no' } });
  assert.match(denied.text('status'), /refused initialization/);
  denied.deliver(hostReply(handshakeId(denied)));
  assert.equal(denied.sent('ui/notifications/initialized').length, 0, 'a later valid answer does not undo a denial');
  assert.match(denied.text('status'), /refused initialization/);
  assert.equal(denied.observers.length, 0, 'no size observer without a handshake');
  assert.equal(sizes(denied).length, 0);

  const torn = harness();
  torn.advance(8000);
  torn.deliver({ jsonrpc: '2.0', id: 'bye', method: 'ui/resource-teardown' });
  assert.deepEqual(torn.posted.at(-1).message, { jsonrpc: '2.0', id: 'bye', result: {} });
  torn.deliver(hostReply(handshakeId(torn)));
  torn.deliver(toolResult(sample()));
  assert.equal(torn.sent('ui/notifications/initialized').length, 0, 'nothing is confirmed after teardown');
  assert.match(torn.text('status'), /closed this view/);
  assert.equal(torn.elements.facts.children.length, 0);
  assert.equal(torn.window.listeners.length, 0, 'the message handler is gone');
});

test('a hung, denied, malformed or unsupported host never produces a confirmation or a success state', () => {
  const variants = [
    ['denied', { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } }, /refused initialization/],
    ['no host capabilities', hostReply(1, { hostCapabilities: undefined }), /does not understand/],
    ['non-string version', hostReply(1, { protocolVersion: 2026 }), /does not understand/],
    ['array result', { jsonrpc: '2.0', id: 1, result: [] }, /does not understand/],
    ['null result', { jsonrpc: '2.0', id: 1, result: null }, /does not understand/],
    ['unsupported version', hostReply(1, { protocolVersion: '2099-01-01' }), /version this view does not support/],
  ];
  for (const [name, reply, expected] of variants) {
    const h = harness();
    h.deliver({ ...reply, id: handshakeId(h) });
    assert.match(h.text('status'), expected, name);
    assert.equal(h.sent('ui/notifications/initialized').length, 0, name);
    assert.equal(h.observers.length, 0, name);
    h.advance(60_000);
    assert.doesNotMatch(h.text('status'), /initialization completed/, name);
    assert.notEqual(h.text('alert'), '', name);
  }
  // Replies that are not the answer to this view's request do not count.
  const h = harness();
  const id = handshakeId(h);
  h.deliver(hostReply(id + 1));
  h.deliver({ ...hostReply(id), error: { code: 1, message: 'x' } });
  h.deliver({ ...hostReply(id), jsonrpc: '1.0' });
  h.deliver('initialized'); h.deliver(null); h.deliver([hostReply(id)]); h.deliver(undefined);
  h.deliver(hostReply(id), h.stranger);
  h.deliver(hostReply(id), null);
  h.deliver(hostReply(id), 'parent');
  assert.equal(h.sent('ui/notifications/initialized').length, 0);
  assert.match(h.text('status'), /waiting for the host to answer initialization/);
  h.deliver(hostReply(id));
  assert.equal(h.sent('ui/notifications/initialized').length, 1);
  h.deliver(hostReply(id));
  assert.equal(h.sent('ui/notifications/initialized').length, 1, 'a repeated reply confirms once');
});

test('size is reported from the content box only when it changed, once observed, with no loop and no viewport feedback', () => {
  const h = harness();
  h.deliver(hostReply(handshakeId(h)));
  assert.equal(h.observers.length, 1, 'one observer');
  assert.deepEqual(h.observers[0].targets, [h.elements.app], 'it watches the page content box');
  assert.deepEqual(sizes(h), [{ width: 320, height: 188 }], 'the first content report includes the loading heading and read-only Reload action');
  // Content changes produce exactly one report each.
  h.deliver(toolResult(sample()));
  assert.deepEqual(sizes(h).at(-1), { width: 320, height: 168 }, 'technical facts stay collapsed; the unbound heading and Reload action remain');
  const count = sizes(h).length;
  h.deliver(toolResult(sample()));
  h.deliver(toolResult(sample({ next: 'Same size, other text.' })));
  assert.equal(sizes(h).length, count, 'an unchanged box is not reported again');
  // Opening and closing the details changes the box and is reported once each.
  h.toggle(true);
  assert.deepEqual(sizes(h).at(-1), { width: 320, height: 168 + 4 * 24 + 100 });
  h.toggle(true);
  h.toggle(false);
  assert.deepEqual(sizes(h).slice(count).map(size => size.height), [364, 168]);
  // A narrower frame wraps the text: a taller, narrower box, once.
  const before = sizes(h).length;
  h.resize(200);
  assert.deepEqual(sizes(h).slice(before), [{ width: 200, height: 228 }]);
  // The viewport height changing, or the host following the reported height, never feeds back.
  for (const viewport of [10, 9999, 600, 1]) { h.layout.viewport = viewport; h.resize(200); h.advance(1000); }
  assert.equal(sizes(h).length, before + 1);
  assert.equal(h.layout.unstable, false, 'the observer settled');
  const seen = sizes(h).map(size => `${size.width}x${size.height}`);
  assert.ok(seen.every((value, index) => value !== seen[index - 1]), 'no two identical reports in a row');
});

test('without ResizeObserver, or when it cannot be created, size still follows content, details and the host', () => {
  for (const observer of ['absent', 'throws']) {
    const h = harness(homeHtml(), { observer });
    assert.equal(sizes(h).length, 0, observer);
    h.deliver(hostReply(handshakeId(h)));
    assert.equal(h.observers.length, 0, observer);
    assert.equal(sizes(h).length, 1, observer);
    h.deliver(toolResult(sample()));
    assert.deepEqual(sizes(h).at(-1), { width: 320, height: 168 }, observer);
    h.toggle(true);
    assert.deepEqual(sizes(h).at(-1), { width: 320, height: 364 }, observer);
    const count = sizes(h).length;
    h.toggle(true); h.deliver(toolResult(sample()));
    assert.equal(sizes(h).length, count, `${observer}: no repeated identical report`);
    assert.equal(h.text('alert'), '');
  }
});

test('teardown stops everything: the observer, both listeners, the timer and all further messages', () => {
  const h = harness();
  h.deliver(hostReply(handshakeId(h)));
  h.deliver(toolResult(sample()));
  const sent = h.posted.length;
  h.deliver({ jsonrpc: '2.0', id: 'bye', method: 'ui/resource-teardown' });
  assert.equal(h.posted.length, sent + 1, 'only the teardown answer is sent');
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.window.listeners.length, 0);
  assert.deepEqual(h.elements.technical.listeners.toggle, []);
  assert.equal(h.events.filter(event => event === 'unlisten:message').length, 1);
  h.toggle(true); h.resize(100); h.advance(60_000);
  h.deliver(toolResult(sample({ next: 'After teardown.' })));
  h.deliver({ jsonrpc: '2.0', id: 'again', method: 'ping' });
  assert.equal(h.posted.length, sent + 1, 'nothing is sent after teardown');
  assert.doesNotMatch(h.text('next'), /After teardown/);
  // Teardown before any handshake also cleans up and leaves no timer to fire.
  const early = harness();
  early.deliver({ jsonrpc: '2.0', id: 'bye', method: 'ui/resource-teardown' });
  early.advance(60_000);
  assert.match(early.text('status'), /closed this view/);
  assert.equal(early.window.listeners.length, 0);
});

test('the colour scheme follows valid host context, ignores the rest, and defaults to the system scheme', () => {
  const h = harness();
  assert.deepEqual([h.root.attributes['data-theme'], h.root.style.colorScheme], [undefined, undefined], 'no host theme: the page follows the system (prefers-color-scheme)');
  h.deliver(hostReply(handshakeId(h), { hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen', 'bogus'] } }));
  assert.deepEqual([h.root.attributes['data-theme'], h.root.style.colorScheme], ['dark', 'dark'], 'attribute and the real CSS colour scheme move together');
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  assert.deepEqual([h.root.attributes['data-theme'], h.root.style.colorScheme], ['light', 'light']);
  for (const theme of ['"><script>', 'DARK', 7, null, ['dark'], {}, 'auto', '']) {
    h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } });
    assert.deepEqual([h.root.attributes['data-theme'], h.root.style.colorScheme], ['light', 'light'], `ignored: ${JSON.stringify(theme)}`);
  }
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: 'dark' });
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed' });
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
  assert.deepEqual([h.root.attributes['data-theme'], h.root.style.colorScheme], ['light', 'light'], 'a partial update keeps the theme');
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  assert.deepEqual([h.root.attributes['data-theme'], h.root.style.colorScheme], ['dark', 'dark']);
  assert.equal(h.sent('ui/request-display-mode').length, 0);
  // The shipped styles define both the system scheme and the host-chosen one.
  const html = homeHtml();
  // Light tokens are the :root default; a host-chosen light theme must beat a dark system scheme.
  for (const rule of [':root{color-scheme:light dark;--surface:#f6f6f6;', '--fg:#171717', '@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--surface:#141414', '[data-theme=dark]{--surface:#141414', '--fg:#ededed', '<meta name="color-scheme" content="light dark">'])
    assert.ok(html.includes(rule), rule);
});

test('the display mode is only reported as the host states it, from capability data, never from a product name', () => {
  const mode = h => h.text('meta').match(/Display mode: (.*?)(?=Plugin:)/)?.[1];
  const none = harness();
  none.deliver(hostReply(handshakeId(none)));
  assert.equal(mode(none), 'not reported');
  const full = harness();
  full.deliver(hostReply(handshakeId(full), { hostContext: { displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] } }));
  assert.equal(mode(full), 'fullscreen (host offers: inline, fullscreen)');
  full.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline' } });
  assert.equal(mode(full), 'inline (host offers: inline, fullscreen)', 'the actual mode follows the host');
  const odd = harness();
  odd.deliver(hostReply(handshakeId(odd), { hostContext: { displayMode: '<script>', availableDisplayModes: ['sidebar', 7, null] } }));
  assert.equal(mode(odd), 'not reported (host offers: none)', 'unknown modes are not shown');
  const inlineOnly = harness();
  inlineOnly.deliver(hostReply(handshakeId(inlineOnly), { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] } }));
  inlineOnly.deliver(toolResult(sample()));
  assert.equal(inlineOnly.elements.facts.children.length, 4, 'a host without fullscreen still shows the view inline');
  for (const h of [none, full, odd, inlineOnly]) assert.equal(h.sent('ui/request-display-mode').length, 0);
  // Nothing is read from the host's name or version to choose behaviour.
  const a = harness(), b = harness();
  a.deliver(hostReply(handshakeId(a), { hostInfo: { name: 'Codex', version: '26.1' } }));
  b.deliver(hostReply(handshakeId(b), { hostInfo: { name: 'Unknown', version: '0' } }));
  assert.deepEqual(a.posted.map(({ message }) => message.method), b.posted.map(({ message }) => message.method));
});

test('a render failure is shown as an internal error, not as success or a blank page', () => {
  const h = harness();
  let failures = 1;
  const replace = h.elements.status.replaceChildren.bind(h.elements.status);
  h.elements.status.replaceChildren = (...nodes) => { if (failures-- > 0) throw new Error('layout failed'); replace(...nodes); };
  h.deliver(hostReply(handshakeId(h)));
  assert.equal(h.text('alert'), 'The view hit an internal error.');
  assert.equal(h.elements.alert.hidden, false);
  h.deliver(toolResult(sample()));
  assert.equal(h.text('alert'), 'The view hit an internal error.', 'the error stays visible');
});

test('messages from any window but the parent are ignored and leak nothing', () => {
  const h = harness();
  h.deliver(toolResult(sample({ next: 'FROM-A-STRANGER' })), h.stranger);
  h.deliver({ jsonrpc: '2.0', id: 1, method: 'ui/resource-teardown' }, h.stranger);
  h.deliver({ jsonrpc: '2.0', id: 2, method: 'ping' }, h.stranger);
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } }, h.stranger);
  assert.equal(h.elements.facts.children.length, 0);
  assert.doesNotMatch(h.elements.next.textContent + h.text('status'), /STRANGER|closed this view/);
  assert.equal(h.root.attributes['data-theme'], undefined);
  assert.equal(h.posted.length, 1, 'only the handshake request was ever sent; strangers get no answer');
  h.deliver(toolResult(sample({ next: 'FROM-THE-HOST' })));
  assert.match(h.text('next'), /FROM-THE-HOST/);
});

test('a page that is not inside a host reports that and sends or watches nothing', () => {
  const h = harness(homeHtml(), { standalone: true });
  assert.deepEqual(h.events, []);
  assert.match(h.text('status'), /not running inside an MCP Apps host/);
  assert.equal(h.text('alert'), 'This page is not running inside an MCP Apps host.');
  assert.equal(h.elements.facts.children.length, 0);
  assert.equal(h.observers.length, 0);
  h.advance(60_000);
  assert.equal(h.posted.length, 0);
});

test('host data is shown as text only: malicious values create no script, markup or unknown class, and missing data is never green', () => {
  const payloads = ['<script>window.pwned=1</script>', '<img src=x onerror="window.pwned=1">', '"><svg onload=1>', "'; window.pwned=1; //", '`${window.pwned=1}`', 'javascript:window.pwned=1', '&lt;b&gt;'];
  const h = harness();
  h.deliver(hostReply(handshakeId(h), { hostInfo: { name: payloads[1], version: payloads[0] }, hostContext: { displayMode: payloads[2] } }));
  const hostile = payloads.map((value, index) => ({ state: ['observed', 'not-observed', 'other-profile', 'unknown'][index % 4], detail: value }));
  h.deliver(toolResult({ pluginVersion: payloads[0], observedAt: payloads[1], next: payloads[2],
    facts: { payload: hostile[0], connection: hostile[1], activation: hostile[2], evidence: hostile[3], extra: hostile[4], constructor: hostile[6] } }));
  assert.deepEqual([...new Set(h.created.map(node => node.tag))].sort(), ['#text', 'b', 'button', 'h2', 'li', 'p', 'span']);
  assert.equal(h.sandbox.window.pwned, undefined);
  assert.ok(h.text('facts').includes(payloads[0]) && h.text('next').includes(payloads[2]), 'the value is visible as inert text');
  assert.ok(h.text('meta').includes(payloads[1]) && h.text('meta').includes('Observed by the plugin server: ' + payloads[1]), 'host name and timestamp are only text');
  assert.doesNotMatch(h.text('meta'), /Display mode: <svg|Display mode: "><svg/, 'a hostile display mode is not shown');
  assert.ok(h.created.every(node => Object.keys(node.attributes).length === 0), 'no attribute is ever set from host data');
  assert.deepEqual(h.elements.facts.children.map(li => li.className), ['observed', 'not-observed', 'other-profile', 'unknown'], 'class names come from the fixed state list');

  // States and details that are not understood stay unknown, never green.
  for (const fact of [{ state: 'observed' }, { state: 'observed', detail: 7 }, { state: 'observed" onclick="x', detail: 'x' }, { state: 'OBSERVED', detail: 'x' },
    { state: '__proto__', detail: 'x' }, { state: ['observed'], detail: 'x' }, null, 'observed', 7, []]) {
    const view = harness();
    view.deliver(toolResult(sample({ facts: { ...sample().facts, activation: fact } })));
    assert.deepEqual(marksOf(view)[2], ['unknown', '?'], JSON.stringify(fact));
  }
  const empty = harness();
  empty.deliver(toolResult(sample({ facts: {} })));
  assert.deepEqual(marksOf(empty), [['unknown', '?'], ['unknown', '?'], ['unknown', '?'], ['unknown', '?']], 'missing facts are unknown, not green');

  // Unusable results show nothing and say so.
  for (const bad of [undefined, null, 'text', 5, [], {}, { facts: [] }, { facts: {}, next: 7 }, { facts: null, next: 'x' }]) {
    const view = harness();
    view.deliver(toolResult(sample()));
    view.deliver(toolResult(bad));
    assert.match(view.text('status'), /Result: received but not in the expected form, so nothing is shown/, JSON.stringify(bad));
    assert.equal(view.elements.facts.children.length, 0, 'no stale facts remain');
  }
  const noParams = harness();
  noParams.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result' });
  assert.match(noParams.text('status'), /not in the expected form/);
  noParams.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: 'x' });
  assert.match(noParams.text('status'), /not in the expected form/);

  // Long values are cut.
  const long = harness();
  long.deliver(toolResult(sample({ next: 'n'.repeat(5000), facts: { ...sample().facts, payload: { state: 'unknown', detail: 'd'.repeat(5000) } } })));
  assert.ok(long.text('next').length < 400 && long.text('facts').length < 1000);
});

test('the shipped markup is a static, concise shell: one inline script, a closed CSP, no remote origin, no side-channel API, no invented provider status', () => {
  const html = homeHtml();
  const { script, ids } = viewOf(html);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.deepEqual(ids.sort(), ['alert', 'announcement', 'app', 'controls', 'facts', 'header-actions', 'meta', 'next', 'page-header', 'page-title', 'status', 'technical']);
  assert.doesNotMatch(script, /<\/script/i);
  assert.doesNotMatch(script, /`|\\/, 'the script uses no template literal or escape');
  assert.doesNotMatch(script, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eval|Function|import|require|localStorage|sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|location|navigator|cookie|Worker|openai|userAgent)\b|document\.write|window\.open/);
  assert.doesNotMatch(script, /createElement\('(?:script|iframe|a|img|link|object|embed)'\)/);
  assert.doesNotMatch(script, /view\.input|request-display-mode/, 'no dead state and no mode request');
  assert.doesNotMatch(html.replace('<script>' + script + '</script>', ''), /https?:\/\/|\bsrc=|\bhref=|<iframe|<link|<img|<form|<a |<input/i, 'the shell loads no origin; a URL input placeholder in the script is inert text');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "img-src 'none'", "base-uri 'none'", "form-action 'none'", "script-src 'unsafe-inline'"])
    assert.ok(csp.includes(directive), directive);
  assert.doesNotMatch(csp, /https?:|\*/);
  assert.ok(html.includes(appScript), 'the served script is the exported one');
  assert.doesNotMatch(html, /9\.9\.9|DECOY|"observedAt"/, 'no observation is embedded in the static view');
  assert.match(html, /This view needs scripts; nothing has been checked\./, 'without scripts nothing is claimed');
  assert.match(html, /The default unbound view[^<]+changes nothing\./);
  assert.match(html, /Explicitly bound controls act only on their declared store/);
  assert.match(html, /A discovered catalog does not prove authentication, tool support, inference compatibility or native picker refresh/);
  assert.doesNotMatch(html, /authenticated|logged in|signed in|detected|connected to/i, 'no detection or login claim is made by the static page');
  assert.doesNotMatch(html, /@font-face|@import|url\(/, 'no remote or bundled font or asset');
  // The technical protocol detail is collapsed by default; the summary view is the page itself.
  assert.match(html, /<details id="technical" class="technical"><summary>Diagnostics<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test('the view served by the real server completes its handshake and shows exactly the server’s own result', async () => {
  const run = await runServer([initialize(1), initialized, request(2, 'tools/call', { name: 'bridge_home', arguments: {} }), request(3, 'resources/read', { uri: homeResource })]);
  try {
    const [, called, read] = run.parsed;
    const h = harness(read.result.contents[0].text);
    h.deliver(hostReply(handshakeId(h)));
    h.deliver(toolResult(called.result.structuredContent, { content: called.result.content }));
    assert.match(h.text('status'), /initialization completed/);
    assert.deepEqual(marksOf(h), [['unknown', '?'], ['observed', '✓'], ['unknown', '?'], ['unknown', '?']]);
    assert.equal(h.elements.facts.children.filter(li => li.className === 'observed').length, 1, 'only the plugin connection is green');
    assert.match(h.text('next'), /Establish the intended profile first/);
    assert.doesNotMatch(h.text('facts') + h.text('next') + h.text('meta'), /DECOY|quit Codex|restart|Install and start|codex-claude/);
    // The modes the view declares are exactly the modes the server's resource metadata offers.
    assert.deepEqual(h.sent('ui/initialize')[0].params.appCapabilities.availableDisplayModes, read.result.contents[0]._meta['openai/ui'].availableDisplayModes);
    assert.equal(h.elements.alert.hidden, true, 'a complete, valid exchange shows no notice');
  } finally { run.close(); }
});
