import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { observeHome, homeText, homeHtml, session, homeResource, locations, protocolVersions } from '../plugins/codex-claude/home/server.mjs';

const server = fileURLToPath(new URL('../plugins/codex-claude/home/server.mjs', import.meta.url));
const desktop = '/Applications/Codex.app/Contents/MacOS/Codex';
const appServer = '/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled';
const notActive = 'To add Claude here, quit Codex once its chats are idle, then open it with “Codex + Claude (main app)”.';
const escaped = text => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// A synthetic home: nothing outside the temporary directory is read.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bridge-home-'));
  const { runtime, state } = locations(home);
  mkdirSync(join(state, 'threads'), { recursive: true });
  const install = (pkg = { name: 'codex-claude-bridge-local', version: '9.9.9-test' }) => {
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  };
  const settings = value => {
    mkdirSync(join(home, '.config/codex-claude-bridge'), { recursive: true });
    writeFileSync(join(home, '.config/codex-claude-bridge/settings.json'), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const write = turns => writeFileSync(join(state, 'threads', `${randomUUID()}.json`), JSON.stringify({ thread: { id: randomUUID() }, turns }));
  const observe = (...commands) => observeHome({ home, chain: () => commands });
  const bridge = `node ${join(runtime, 'bridge.mjs')} app-server`;
  const window = `${desktop} --user-data-dir=${join(state, 'desktop')}`;
  return { home, runtime, state, install, settings, write, observe, bridge, window, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('installed is green only for the installed Bridge runtime package', () => {
  const f = fixture();
  try {
    const missing = f.observe(appServer, desktop);
    assert.equal(missing.facts.payload.state, 'not-observed');
    assert.match(missing.next, /^Install the Bridge/);
    f.install({ name: 'some-other-package', version: '1.0.0' });
    const other = f.observe(appServer, desktop);
    assert.equal(other.facts.payload.state, 'unknown', 'another package is not the Bridge');
    assert.equal(other.next, 'Ask Codex to “Check my Codex + Claude installation.”');
    f.install('{broken');
    assert.equal(f.observe(appServer, desktop).facts.payload.state, 'unknown');
    f.install();
    const installed = f.observe(appServer, desktop);
    assert.deepEqual(installed.facts.payload, { state: 'observed', detail: 'Bridge runtime 9.9.9-test is installed.' });
  } finally { f.close(); }
});

test('activation is green only for the main-app launcher’s current Bridge record, under the selected app, in this process chain', () => {
  const f = fixture();
  try {
    f.install();
    f.settings({ app: '/Applications/Codex.app' });
    const startedAt = 1_900_000_000_000;
    // A record as logging.mjs publishes it; body overrides fields, a string is written raw.
    const record = (pid, body = {}, dir = 'primary/runtime') => {
      mkdirSync(join(f.state, dir), { recursive: true });
      const runId = randomUUID();
      writeFileSync(join(f.state, dir, `${pid}-${runId}.json`), typeof body === 'string' ? body : JSON.stringify({ pid, runId, startedAt, ...body }));
    };
    // The process start time `ps` reports for each synthetic PID.
    // null is an unknown start (as processStart returns), so it must stay null.
    const starts = { 200: startedAt, 201: startedAt + 1500, 202: startedAt, 203: startedAt, 205: startedAt + 60_000, 206: startedAt, 207: null };
    const started = pid => Object.hasOwn(starts, pid) ? starts[pid] : startedAt;
    const chain = (bridgePid, parent = desktop, server = appServer) => () => [{ pid: 300, command: server }, { pid: bridgePid, command: f.bridge },
      ...(parent === null ? [] : [{ pid: 100, command: parent }])];
    const view = (pid, ...args) => observeHome({ home: f.home, chain: chain(pid, ...args), started });
    assert.equal(view(200).facts.activation.state, 'unknown', 'no record yet');
    record(201); record(202, { pid: 999 }); record(203, '{broken'); record(205); record(206, { runId: randomUUID() }); record(207);
    for (const [pid, reason] of [[200, 'no record'], [202, 'another PID'], [203, 'unreadable'], [205, 'a stale record: the PID now belongs to a later process'],
      [206, 'a run ID that does not match its file'], [207, 'an unknown process start']])
      assert.equal(view(pid).facts.activation.state, 'unknown', reason);
    const active = view(201);
    assert.deepEqual([active.facts.activation.state, active.next], ['observed', 'Choose a Claude model in the model picker.']);
    assert.match(active.facts.activation.detail, /running in this Codex app for this session/);
    assert.equal(view(201, f.window).facts.activation.state, 'other-profile', 'the separate test window never counts as the main app');
    for (const [parent, reason] of [[`${desktop} --user-data-dir=/other/profile`, 'another profile'], ['-zsh', 'an ordinary shell'],
      ['/Applications/Other.app/Contents/MacOS/Codex', 'another app'], [null, 'no parent']])
      assert.equal(view(201, parent).facts.activation.state, 'unknown', reason);
    assert.equal(view(201, desktop, '/usr/bin/node /other/server.mjs').facts.activation.state, 'unknown', 'not above this Codex app-server');
    record(204, {}, 'runtime');
    assert.equal(view(204).facts.activation.state, 'unknown', 'a record in the separate test window’s state does not count');
    f.settings({});
    assert.equal(view(201).facts.activation.state, 'unknown', 'without the selected app nothing ties the Bridge to it');
    f.settings({ state: 42, app: '/Applications/Codex.app' });
    assert.equal(view(201).facts.activation.state, 'unknown', 'without valid settings the main-app state is unknown');
  } finally { f.close(); }
});

test('activation is never green without that binding, and no update or restart is suggested', () => {
  const f = fixture();
  try {
    f.install();
    const states = home => [home.facts.activation.state, home.next];
    assert.deepEqual(states(f.observe(appServer, desktop)), ['not-observed', notActive]);
    assert.deepEqual(states(f.observe(appServer, 'node /elsewhere/bridge.mjs app-server', desktop)), ['not-observed', notActive],
      'a similarly named process is not the installed Bridge');
    assert.deepEqual(states(f.observe(appServer, `node ${join(f.runtime, 'bridge.mjs.bak')} x`, desktop)), ['not-observed', notActive]);
    const isolated = f.observe(appServer, f.bridge, f.window);
    assert.deepEqual(states(isolated), ['other-profile', 'Open this view from the main Codex app to check it there.']);
    assert.match(isolated.facts.activation.detail, /separate test window/);
    for (const parent of [desktop, `${desktop} --user-data-dir=/other/profile`, undefined]) {
      const exact = f.observe(appServer, f.bridge, ...(parent ? [parent] : []));
      assert.deepEqual(states(exact), ['unknown', notActive], 'the exact runtime alone does not prove the main app');
    }
    assert.deepEqual(states(f.observe('-zsh', 'login')), ['unknown', 'Open this view from a chat in the Codex app.']);
    assert.equal(observeHome({ home: f.home, chain: () => { throw new Error('ps unavailable'); } }).facts.activation.state, 'unknown');
    const connected = observeHome({ home: f.home, chain: () => [appServer, f.bridge, desktop], connected: true });
    assert.deepEqual([connected.facts.connection.state, connected.facts.activation.state, connected.next], ['observed', 'unknown', notActive],
      'a plugin connection is not Claude activation');
    for (const home of [f.observe(appServer, f.bridge, desktop), connected, isolated])
      assert.doesNotMatch(JSON.stringify(home) + homeText(home), /"activation":\{"state":"observed"|restart|updat|not supported/i);
  } finally { f.close(); }
});

test('corrupt settings and timestamps give fixed unknown facts, and later valid data is observed again', () => {
  const f = fixture();
  try {
    f.install();
    const leaks = home => assert.doesNotMatch(JSON.stringify(home) + homeText(home) + homeHtml(home), /Error|Received|Invalid time|\/tmp\/|bridge-home-/);
    for (const saved of [{ state: 42 }, { state: '' }, { state: 'relative/state' }, { state: `${f.state}\0x` }, '{broken', 'null']) {
      f.settings(saved);
      const home = f.observe(appServer, f.bridge, f.window);
      assert.deepEqual(home.facts.payload.state, 'observed', 'other facts survive');
      assert.equal(home.facts.activation.state, 'unknown', 'the test window cannot be identified without valid settings');
      assert.deepEqual(home.facts.evidence, { state: 'unknown', detail: 'The Bridge settings could not be read.' });
      assert.equal(home.next, notActive);
      leaks(home);
    }
    f.settings({ state: f.state });
    assert.equal(f.observe(appServer, f.bridge, f.window).facts.activation.state, 'other-profile', 'valid settings recover');
    for (const completedAt of [Number.MAX_SAFE_INTEGER, 253402300800, 1e13, 1.5, -1, 0, '1800000000', null])
      f.write([{ provider: 'claude', status: 'completed', completedAt }]);
    f.write([null, 7, { provider: 'claude', status: 'completed' }]);
    const corrupt = f.observe(appServer, desktop);
    assert.deepEqual(corrupt.facts.evidence, { state: 'unknown', detail: 'No completed Claude conversation has been recorded.' });
    leaks(corrupt);
    f.write([{ provider: 'claude', status: 'completed', completedAt: 1_800_000_000 }]);
    const recovered = f.observe(appServer, desktop);
    assert.deepEqual([recovered.facts.evidence.state, recovered.facts.evidence.at], ['other-profile', 1_800_000_000]);
    assert.match(recovered.facts.evidence.detail, /2027-01-15 08:00 UTC/);
    const failing = observeHome({ home: f.home, chain: () => 42 });
    assert.deepEqual(failing.facts.activation, { state: 'unknown', detail: "This app's processes could not be inspected." }, 'an unreadable chain is contained');
    assert.equal(failing.facts.payload.state, 'observed');
    const malformed = observeHome({ home: f.home, chain: () => [{ pid: 1, command: 42 }] });
    assert.deepEqual(malformed.facts.activation, { state: 'unknown', detail: 'This could not be checked.' }, 'any other failing fact is contained');
    assert.equal(malformed.facts.payload.state, 'observed');
  } finally { f.close(); }
});

test('evidence is content-free conversation metadata from the test window, never this app', () => {
  const f = fixture();
  try {
    assert.equal(f.observe(desktop).facts.evidence.state, 'unknown');
    f.write([{ provider: 'claude', status: 'failed', completedAt: 1_900_000_000 }, { provider: 'native', status: 'completed', completedAt: 1_900_000_100 }]);
    assert.equal(f.observe(desktop).facts.evidence.state, 'unknown', 'failed and GPT turns are not Claude evidence');
    f.write([{ provider: 'claude', status: 'completed', completedAt: 1_800_000_000, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'SYNTHETIC SECRET TEXT' }] }] }]);
    writeFileSync(join(f.state, 'threads', `${randomUUID()}.json`), '{broken');
    writeFileSync(join(f.state, 'threads', 'notes.json'), JSON.stringify({ turns: [{ provider: 'claude', status: 'completed', completedAt: 1_999_999_999 }] }));
    const home = f.observe(desktop);
    assert.equal(home.facts.evidence.state, 'other-profile');
    assert.equal(home.facts.evidence.at, 1_800_000_000);
    assert.match(home.facts.evidence.detail, /separate test window\. This does not show Claude working in this app, and file, browser and page actions are not checked\./);
    assert.doesNotMatch(JSON.stringify(home) + homeText(home) + homeHtml(home), /SYNTHETIC SECRET TEXT/);
  } finally { f.close(); }
});

test('only observed facts are marked done, and the view shows setup and one next step without paths or markup', () => {
  const f = fixture();
  try {
    f.install();
    f.write([{ provider: 'claude', status: 'completed', completedAt: 1_800_000_000 }]);
    const home = f.observe(appServer, f.bridge, desktop);
    const text = homeText(home);
    assert.deepEqual(text.split('\n').filter(line => line.startsWith('✓')), ['✓ Installed: Bridge runtime 9.9.9-test is installed.']);
    assert.equal(text.split('\n').filter(line => line.startsWith('Next:')).length, 1);
    const html = homeHtml({ ...home, next: '<script>alert(1)</script>' });
    assert.match(html, /<details><summary>Setup<\/summary>/);
    assert.equal(html.match(/class="next"/g).length, 1);
    assert.doesNotMatch(html, /<script>/);
    assert.equal(html.match(/class="observed"/g).length, 1);
    assert.equal(home.facts.connection.state, 'unknown', 'a direct observation does not invent a plugin connection');
    assert.doesNotMatch(text + homeHtml(home), escaped(f.home));
  } finally { f.close(); }
});

const initialize = (id, protocolVersion = '2025-06-18', extra = {}) => ({ jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'synthetic-client', version: '0' }, ...extra } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

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
  assert.deepEqual(observations, [false, false, false, true, true], 'unconnected before initialize and until the client confirms it');
  assert.equal(handle(initialize(7)).error.code, -32600, 'a second initialize is rejected');
  assert.equal(handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'other' } }).error.code, -32602);
  assert.equal(handle({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'ui://other' } }).error.code, -32602);
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 10, method: 'shell/run' }), { jsonrpc: '2.0', id: 10, error: { code: -32601, message: 'Method not found' } });
  assert.equal(handle({ jsonrpc: '2.0', id: 11, result: {} }), null, 'a client response gets no reply');
  session(observe)({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: homeResource } });
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
  assert.deepEqual(broken({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: homeResource } }).error, { code: -32603, message: 'Home could not be observed' });
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

test('the plugin entrypoint speaks MCP on stdout from the plugin directory and survives bad input and corrupt settings', async () => {
  const f = fixture();
  try {
    f.settings({ state: 42 });
    const child = spawn(process.execPath, [server], { cwd: join(server, '../..'), env: { PATH: process.env.PATH, HOME: f.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const call = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bridge_home' } });
    const noVersion = initialize(5);
    noVersion.params.clientInfo = { name: 'synthetic' };
    child.stdin.end(['not json', 'null', '[]', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 7 } }),
      JSON.stringify(noVersion), call(2), JSON.stringify(initialize(3)), JSON.stringify({ ...initialized, params: [] }), call(6),
      JSON.stringify(initialized), call(4)].join('\n') + '\n');
    const [code, signal] = await once(child, 'close');
    // Every request line must have produced exactly one parseable response line.
    const lines = stdout.split('\n').slice(0, -1);
    const parsed = lines.map(line => { try { return JSON.parse(line); } catch { return undefined; } });
    assert.ok(stdout.endsWith('\n') && lines.length === 9 && parsed.every(Boolean),
      `server output ${JSON.stringify({ code, signal, lines: lines.length, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) })}`);
    const [parse, nul, array, badInit, badClient, before, init, early, after] = parsed;
    assert.equal(parse.error.code, -32700);
    assert.deepEqual([nul.error.code, array.error.code, badInit.error.code, badClient.error.code], [-32600, -32600, -32602, -32602]);
    assert.equal(before.result.structuredContent.facts.connection.state, 'unknown');
    assert.deepEqual([init.id, init.result.protocolVersion], [3, '2025-06-18']);
    assert.deepEqual([early.id, early.result.structuredContent.facts.connection.state], [6, 'unknown'], 'a malformed confirmation does not connect');
    const { facts } = after.result.structuredContent;
    assert.deepEqual([facts.payload.state, facts.connection.state, facts.evidence.detail], ['not-observed', 'observed', 'The Bridge settings could not be read.']);
    assert.notEqual(facts.activation.state, 'observed');
    assert.doesNotMatch(stdout, escaped(f.home));
    assert.equal(stderr, '');
  } finally { f.close(); }
});
