import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, symlinkSync, renameSync, openSync, closeSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareHomeTest } from '../scripts/prepare-home-test.mjs';
import { testControls } from '../plugins/codex-claude/home/test-controls.mjs';
import { session, homeHtml, observeHome, homeResource } from '../plugins/codex-claude/home/server.mjs';
import { readConnections, setEnabled, storeFile } from '../connections.mjs';
import { fixture } from './support/fixture.mjs';
import { harness, hostReply, toolResult, handshakeId } from './support/home-host.mjs';

// All paths, profiles, catalogs, native responses and queries here are synthetic.
// Retain these task-owned fixture roots; no FIFO, real SDK query or owner data.
const make = () => {
  const parent = mkdtempSync(join(tmpdir(), 'bridge-home-controls-'));
  const root = join(parent, 'scope'), prepared = prepareHomeTest(root);
  return { root, parent, ...prepared };
};
const state = x => readConnections(join(x.root, 'state')).store;
const c = x => state(x).connections.claude_code;
const scopeArgs = x => ({ bindingId: x.scope.bindingId, profileId: x.scope.profileId, bridgeId: x.scope.bridgeId });
const init = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } };
const ready = controls => { const handle = session(undefined, controls); handle(init); handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); return handle; };
const call = (handle, action, args) => handle({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'bridge_connection_' + action, arguments: args } });
const home = handle => handle({ jsonrpc: '2.0', id: 'home', method: 'tools/call', params: { name: 'bridge_home', arguments: {} } }).result.structuredContent;
function inventory(root, prefix = '') {
  return Object.fromEntries(readdirSync(root).sort().flatMap(name => {
    const p = join(root, name), rel = prefix + name, s = lstatSync(p);
    if (s.isDirectory()) return Object.entries(inventory(p, rel + '/'));
    assert.ok(s.isFile(), 'only ordinary test files are inventoried');
    return [[rel, createHash('sha256').update(readFileSync(p)).digest('hex')]];
  }));
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
const buttons = h => h.elements.controls.children.filter(n => n.tag === 'button');
const click = (h, text) => { const b = buttons(h).find(n => n.textContent === text); assert.ok(b, text); for (const f of b.listeners.click ?? []) f({}); };
const connect = (value, capabilities = { serverTools: {} }) => {
  const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: capabilities })); h.deliver(toolResult(value)); return h;
};
async function uiRoundTrip(h, handle, text) {
  click(h, text); const request = h.sent('tools/call').at(-1); assert.ok(request);
  const answer = await handle(request); h.deliver(answer); return answer;
}

test('an exclusive synthetic binding declares fixed children and a pinned backend; no caller path or environment selects another store', async () => {
  const x = make(), before = inventory(x.root), controls = await testControls(x.bindingPath), h = ready(controls);
  assert.equal(home(h).controls.profileId, x.scope.profileId);
  assert.deepEqual(inventory(x.root), before, 'status and Home reads write nothing');
  assert.throws(() => prepareHomeTest(x.root), /EEXIST/);
  const unbound = session();
  assert.equal((await call(unbound, 'enabled', { ...scopeArgs(x), revision: 1, enabled: false })).error.code, -32600);
  const initializing = session(undefined, controls); initializing(init);
  assert.equal((await call(initializing, 'enabled', { ...scopeArgs(x), revision: 1, enabled: false })).error.code, -32600);
  for (const extra of [{ path: x.parent }, { command: 'sh' }, { provider: 'openrouter' }, { token: 'not-a-token' }]) {
    const answer = await call(h, 'enabled', { ...scopeArgs(x), revision: 1, enabled: false, ...extra });
    assert.equal(answer.result.isError, true); assert.equal(answer.result.structuredContent.error, 'invalid_request');
  }
  assert.deepEqual(inventory(x.root), before);
});

test('wrong binding, profile and Bridge IDs, stale revisions and invalid values are refused without changing any file', async () => {
  const x = make(), h = ready(await testControls(x.bindingPath)), before = inventory(x.root);
  for (const key of ['bindingId', 'profileId', 'bridgeId']) {
    const answer = await call(h, 'enabled', { ...scopeArgs(x), [key]: 'f'.repeat(32), revision: 1, enabled: false });
    assert.equal(answer.result.structuredContent.error, 'wrong_scope');
  }
  for (const [action, extra] of [['enabled', { revision: 0, enabled: false }], ['enabled', { revision: 1, enabled: 'false' }], ['visible', { revision: 1, visible: ['not-discovered'] }]])
    assert.equal((await call(h, action, { ...scopeArgs(x), ...extra })).result.isError, true);
  assert.deepEqual(inventory(x.root), before);
});

test('public MCP actions change only the declared store: discover, visible selection, disable and re-enable with durable generation', async () => {
  const x = make(), h = ready(await testControls(x.bindingPath)), before = inventory(x.root);
  const invoke = async (action, extra = {}) => {
    const result = (await call(h, action, { ...scopeArgs(x), revision: state(x).revision, ...extra })).result;
    assert.notEqual(result.isError, true); return result.structuredContent.controls;
  };
  const discovered = await invoke('refresh'); assert.equal(discovered.catalogState, 'fresh');
  assert.deepEqual(discovered.models.map(m => m.id), ['haiku', 'sonnet']);
  assert.equal(discovered.authentication, 'unknown'); assert.equal(discovered.inference, 'unverified');
  await invoke('visible', { visible: ['sonnet'] }); await invoke('enabled', { enabled: false });
  assert.equal(c(x).disableGeneration, 1); assert.equal(c(x).enabled, false);
  await invoke('enabled', { enabled: true }); assert.equal(c(x).disableGeneration, 1);
  assert.deepEqual(c(x).visible, ['sonnet']);
  await invoke('visible', { visible: null }); assert.equal(c(x).visible, null);
  assert.deepEqual(changed(before, inventory(x.root)), ['state/connections.json']);
  assert.deepEqual(readdirSync(join(x.root, 'state')), [storeFile], 'no leftover lock or scratch');
});

test('failed, malformed and timed-out synthetic discovery persist nothing; concurrent changes reject the stale result', async () => {
  for (const discover of [async () => { throw new Error('PRIVATE DETAILS'); }, async () => [{ value: 'same' }, { value: 'same' }], () => new Promise(() => {})]) {
    const x = make(), h = ready(await testControls(x.bindingPath, { discover })), before = inventory(x.root);
    const answer = await call(h, 'refresh', { ...scopeArgs(x), revision: 1 });
    assert.equal(answer.result.isError, true); assert.doesNotMatch(JSON.stringify(answer), /PRIVATE DETAILS/);
    assert.deepEqual(inventory(x.root), before);
  }
  const x = make(); let finish;
  const h = ready(await testControls(x.bindingPath, { discover: () => new Promise(r => { finish = r; }) }));
  const pending = call(h, 'refresh', { ...scopeArgs(x), revision: 1 });
  while (!finish) await new Promise(r => setImmediate(r));
  setEnabled(join(x.root, 'state'), false); const otherWriter = inventory(x.root);
  finish([{ value: 'haiku' }]);
  assert.equal((await pending).result.structuredContent.error, 'stale_revision');
  assert.deepEqual(inventory(x.root), otherWriter, 'refresh did not overwrite the other decision');
});

test('binding/marker/store replacement is refused, and a linked or modified backend is never imported', async () => {
  const x = make(), controls = await testControls(x.bindingPath), h = ready(controls);
  writeFileSync(join(x.root, 'profile/bridge-home-test.json'), 'wrong-profile'); const before = inventory(x.root);
  assert.equal(home(h).controls, null);
  assert.equal((await call(h, 'enabled', { ...scopeArgs(x), revision: 1, enabled: false })).result.isError, true);
  assert.deepEqual(inventory(x.root), before);
  const y = make(); writeFileSync(join(y.root, 'backend/connections.mjs'), 'globalThis.HOME_BAD_IMPORT = true;');
  await assert.rejects(testControls(y.bindingPath)); assert.equal(globalThis.HOME_BAD_IMPORT, undefined);
  const z = make(), manifestTarget = join(z.root, 'retained-binding.json');
  renameSync(z.bindingPath, manifestTarget); symlinkSync(manifestTarget, z.bindingPath);
  assert.ok(lstatSync(z.bindingPath).isSymbolicLink());
  await assert.rejects(testControls(z.bindingPath), { code: 'binding_invalid' }, 'correct basename reaches manifest link refusal');
  const linkedBackend = make(), backendPath = join(linkedBackend.root, 'backend/connections.mjs'), backendTarget = join(linkedBackend.root, 'backend/retained-connections.mjs');
  renameSync(backendPath, backendTarget); symlinkSync(backendTarget, backendPath);
  assert.ok(lstatSync(backendPath).isSymbolicLink());
  await assert.rejects(testControls(linkedBackend.bindingPath), { code: 'binding_invalid' }, 'valid manifest reaches backend link refusal');
  const a = make(), b = make(), aControls = await testControls(a.bindingPath);
  writeFileSync(join(a.root, 'state/connections.json'), readFileSync(join(b.root, 'state/connections.json')));
  assert.throws(() => aControls.snapshot(), /store_unavailable/);
});

test('the actual shipped UI performs public tools/call through MCP and displays state only after a correlated same-scope result', async () => {
  const x = make(), handle = ready(await testControls(x.bindingPath)), before = inventory(x.root), h = connect(home(handle));
  assert.match(h.text('controls'), /Synthetic test only/);
  const sizeBefore = h.sent('ui/notifications/size-changed').at(-1).params.height;
  await uiRoundTrip(h, handle, 'Discover models');
  assert.ok(h.sent('ui/notifications/size-changed').at(-1).params.height > sizeBefore, 'new model controls resize the content box');
  h.resize(200); const count = h.sent('ui/notifications/size-changed').length;
  h.layout.viewport = 9999; h.resize(200);
  assert.equal(h.sent('ui/notifications/size-changed').length, count, 'no viewport feedback loop');
  h.toggle(true); assert.equal(h.layout.unstable, false);
  const labels = h.elements.controls.children.filter(n => n.tag === 'label');
  assert.equal(labels.length, 2); labels[0].children[0].checked = false;
  await uiRoundTrip(h, handle, 'Save visible models'); assert.deepEqual(c(x).visible, ['sonnet']);
  click(h, 'Disable'); const request = h.sent('tools/call').at(-1);
  assert.equal(c(x).enabled, true, 'posting the request itself is not success');
  assert.ok(buttons(h).every(b => b.disabled));
  h.deliver({ jsonrpc: '2.0', id: request.id, result: {} }, h.stranger); assert.equal(c(x).enabled, true);
  h.deliver(await handle(request)); assert.equal(c(x).enabled, false); assert.match(h.text('controls'), /disabled for new test work/);
  await uiRoundTrip(h, handle, 'Enable'); assert.equal(c(x).enabled, true); assert.equal(c(x).disableGeneration, 1);
  assert.deepEqual(changed(before, inventory(x.root)), ['state/connections.json']);
  assert.equal(homeResource, 'ui://codex-claude/home-v11.html');
  const listed = handle({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }).result.tools;
  assert.equal(listed.length, 5);
  assert.deepEqual(listed.slice(1).map(t => [t.annotations.readOnlyHint, t._meta.ui.visibility]), [[true, ['app']], [false, ['app']], [false, ['app']], [false, ['app']]]);
});

test('unbound/wrong-capability/early/closed views send no control calls; denial and timeout require an explicit read, never an automatic retry', async () => {
  const x = make(), handle = ready(await testControls(x.bindingPath)), data = home(handle);
  const unbound = connect(observeHome({ connected: true })); assert.deepEqual(buttons(unbound).map(b => b.textContent), ['Reload Home'], 'unbound view has only a no-argument read action');
  const noTools = connect(data, {}); click(noTools, 'Disable'); assert.equal(noTools.sent('tools/call').length, 0);
  const early = harness(); early.deliver(toolResult(data)); click(early, 'Disable'); assert.equal(early.sent('tools/call').length, 0);
  const h = connect(data), staleDisable = buttons(h).find(b => b.textContent === 'Disable');
  click(h, 'Disable'); const old = h.sent('tools/call').at(-1);
  h.advance(8000); assert.match(h.text('controls'), /Outcome unknown/);
  assert.deepEqual(buttons(h).map(b => b.textContent), ['Read current state'], 'no stale mutation controls remain');
  for (const listener of staleDisable.listeners.click ?? []) listener({});
  assert.equal(h.sent('tools/call').length, 1, 'even a retained old click handler cannot retry the write');
  click(h, 'Read current state'); const read = h.sent('tools/call').at(-1);
  h.deliver({ jsonrpc: '2.0', id: old.id, result: { structuredContent: data } });
  assert.match(h.text('controls'), /Reading test state/);
  h.deliver({ jsonrpc: '2.0', id: read.id, error: { code: -1, message: 'denied' } });
  assert.match(h.text('controls'), /not confirmed/);
  assert.equal(h.sent('tools/call').length, 2, 'no automatic retry');
  click(h, 'Read current state'); const finalRead = h.sent('tools/call').at(-1);
  h.deliver({ ...(await handle(finalRead)), result: { structuredContent: { ...data, controls: { ...data.controls, profileId: 'f'.repeat(32) } } } });
  assert.match(h.text('controls'), /not confirmed/);
  h.deliver({ jsonrpc: '2.0', id: 'close', method: 'ui/resource-teardown' }); click(h, 'Read current state');
  assert.equal(h.sent('tools/call').length, 3); h.advance(30000); assert.equal(h.window.listeners.length, 0);
});

test('cancelled pending Disable keeps only recovery scope, ignores late replies and requires an explicit same-scope status read', async () => {
  const x = make(), handle = ready(await testControls(x.bindingPath)), h = connect(home(handle));
  click(h, 'Disable'); const mutation = h.sent('tools/call').at(-1);
  const committed = await handle(mutation);
  assert.equal(c(x).enabled, false, 'server committed before the host cancellation');
  const afterCommit = inventory(x.root);
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' });
  assert.equal(h.elements.facts.children.length, 0, 'stale facts are removed');
  assert.match(h.text('controls'), /outcome is unknown/i);
  assert.doesNotMatch(h.text('controls'), /Claude Code: (enabled|disabled)/, 'last state is not presented as current');
  const readButton = buttons(h).find(b => b.textContent === 'Read current state');
  assert.ok(readButton && !readButton.disabled, 'explicit recovery remains available');
  assert.ok(buttons(h).every(b => b === readButton || b.disabled));
  h.deliver(committed);
  h.deliver(toolResult(committed.result.structuredContent));
  h.advance(30000);
  assert.equal(h.sent('tools/call').length, 1, 'late replies/notifications/timers never retry the write');
  assert.match(h.text('controls'), /outcome is unknown/i);
  click(h, 'Read current state'); const wrongRead = h.sent('tools/call').at(-1);
  assert.equal(wrongRead.params.name, 'bridge_connection_status');
  assert.deepEqual(wrongRead.params.arguments, scopeArgs(x), 'recovery uses the last verified context only');
  const wrongHome = committed.result.structuredContent;
  h.deliver({ jsonrpc: '2.0', id: wrongRead.id, result: { structuredContent: { ...wrongHome, controls: { ...wrongHome.controls, profileId: 'f'.repeat(32) } } } });
  assert.match(h.text('controls'), /not confirmed/);
  assert.equal(h.elements.facts.children.length, 0);
  click(h, 'Read current state'); const read = h.sent('tools/call').at(-1);
  h.deliver(committed); assert.match(h.text('controls'), /Reading test state/);
  h.deliver(await handle(read));
  assert.match(h.text('controls'), /Claude Code: disabled for new test work/);
  assert.equal(buttons(h).find(b => b.textContent === 'Enable').disabled, false);
  assert.equal(h.sent('tools/call').length, 3);
  assert.deepEqual(inventory(x.root), afterCommit, 'recovery reads make no second mutation');
});

test('unsaved visible-model draft survives unrelated host context, theme, width and details updates; Save submits that draft', async () => {
  const x = make(), handle = ready(await testControls(x.bindingPath)), h = connect(home(handle));
  await uiRoundTrip(h, handle, 'Discover models');
  const boxes = () => h.elements.controls.children.filter(n => n.tag === 'label').map(n => n.children[0]);
  boxes()[0].checked = false;
  for (const change of boxes()[0].listeners.change ?? []) change({});
  const beforeSave = inventory(x.root);
  for (const params of [{ theme: 'dark' }, { displayMode: 'fullscreen' }, { theme: 'light' }, { unrelated: 'ignored' }]) {
    h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params });
    assert.deepEqual(boxes().map(b => [b.value, b.checked]), [['haiku', false], ['sonnet', true]]);
  }
  h.resize(200); h.toggle(true); h.resize(600); h.toggle(false);
  assert.deepEqual(inventory(x.root), beforeSave, 'editing and context updates persist nothing');
  await uiRoundTrip(h, handle, 'Save visible models');
  assert.deepEqual(h.sent('tools/call').at(-1).params.arguments.visible, ['sonnet']);
  assert.deepEqual(c(x).visible, ['sonnet']);
  assert.deepEqual(boxes().map(b => [b.value, b.checked]), [['haiku', false], ['sonnet', true]]);
});

test('untrusted catalog labels remain text and invalid control data does not enable writes; theme, late initialization and teardown stay standard', async () => {
  const x = make(), controls = await testControls(x.bindingPath, { discover: async () => [{ value: 'evil', displayName: '<img src=x onerror=alert(1)>' }] }), handle = ready(controls);
  await call(handle, 'refresh', { ...scopeArgs(x), revision: 1 });
  const h = harness(); h.deliver(toolResult(home(handle))); h.advance(9000);
  h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} }, hostContext: { theme: 'dark' } }));
  assert.equal(h.root.attributes['data-theme'], 'dark'); assert.match(h.text('controls'), /<img src=x/);
  assert.ok(!h.created.some(n => n.tag === 'img'));
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } }); assert.equal(h.root.attributes['data-theme'], 'light');
  for (const bad of [{ ...home(handle).controls, kind: 'production' }, { ...home(handle).controls, revision: -1 }, { ...home(handle).controls, models: [{ id: 'a', name: 'a' }, { id: 'a', name: 'a' }] }]) {
    h.deliver(toolResult({ ...home(handle), controls: bad })); assert.deepEqual(buttons(h).map(b => b.textContent), ['Reload Home'], 'invalid controls expose no write, only a read-only reload');
  }
  assert.doesNotMatch(homeHtml().replace(/<script>[\s\S]*?<\/script>/, ''), /<iframe|https?:\/\/|\bsrc=/, 'no shell resource; URL placeholders are inert');
});

test('Home changes the same store enforced by the real Bridge fixture: GPT/history remain readable and disabled queues survive re-enable/restart until an explicit start', async () => {
  const x = make(), handle = ready(await testControls(x.bindingPath)), f = fixture('openai', { connectionRoot: join(x.root, 'state') });
  const id = await f.start('haiku'), first = await f.send(id, 'retained synthetic history'); await f.settled(first.turn.id);
  const queued = (await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'Q', input: [{ type: 'text', text: 'retained queue' }] })).queuedSubmission;
  const transcript = readFileSync(join(f.statePath, id + '.json'));
  const h = connect(home(handle)); await uiRoundTrip(h, handle, 'Disable');
  await assert.rejects(f.start('haiku'), /disabled/);
  const list = await f.bridge.request('thread/list', {}); assert.ok(list.data.some(t => t.id === id));
  assert.equal((await f.bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns.length, 1);
  const native = await f.start('gpt-test'), turn = await f.send(native, 'native control'); await f.done(turn.turn.id);
  assert.equal(f.queries.length, 1, 'GPT used the fake native host, not Claude');
  await uiRoundTrip(h, handle, 'Enable'); f.restart();
  assert.equal(f.bridge.records.get(id).queuePaused, 'provider_disabled');
  assert.equal(f.bridge.records.get(id).queue[0].id, queued.id); assert.equal(f.queries.length, 1);
  const saved = JSON.parse(readFileSync(join(f.statePath, id + '.json'))), old = JSON.parse(transcript);
  assert.deepEqual(saved.turns, old.turns, 'only the durable pause metadata changed, not history');
  const started = await f.bridge.request('thread/queue/start', { threadId: id, queuedSubmissionId: queued.id }); await f.settled(started.turn.id);
  assert.equal(f.queries.length, 2); assert.equal(f.bridge.records.get(id).queue.length, 0);
});

test('the real synthetic stdio entrypoint exposes the public control tools; invalid paths/scopes do not become filesystem APIs', async () => {
  const x = make();
  const plugin = fileURLToPath(new URL('../plugins/codex-claude', import.meta.url)), copy = join(x.parent, 'plugin-copy');
  cpSync(plugin, copy, { recursive: true, errorOnExist: true, force: false });
  const manifest = JSON.parse(readFileSync(join(copy, 'mcp.json')));
  assert.deepEqual(manifest.mcpServers['model-bridge-home'].args, ['${PLUGIN_ROOT}/home/server.mjs'], 'ordinary plugin registration remains unbound');
  const server = join(copy, 'home/test-server.mjs'), audit = fileURLToPath(new URL('./support/home-controls-audit.mjs', import.meta.url)), log = join(x.parent, 'fs-audit.jsonl');
  const decoy = join(x.parent, 'unrelated'); mkdirSync(decoy, { mode: 0o700 }); writeFileSync(join(decoy, 'auth.json'), 'UNREAD-DECOY');
  const before = inventory(x.root);
  const messages = [init, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_connection_enabled', arguments: { ...scopeArgs(x), profileId: '0'.repeat(32), revision: 1, enabled: false, path: decoy } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bridge_connection_refresh', arguments: { ...scopeArgs(x), revision: 1 } } }];
  const input = join(x.parent, 'input.jsonl'), output = join(x.parent, 'output.jsonl'), error = join(x.parent, 'error.txt');
  writeFileSync(input, messages.map(m => JSON.stringify(m)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const fds = [openSync(input, 'r'), openSync(output, 'wx', 0o600), openSync(error, 'wx', 0o600)];
  const child = spawn(process.execPath, ['--import', audit, server, '--test-binding', x.bindingPath], { env: { PATH: '/usr/bin:/bin', HOME: decoy, CODEX_HOME: decoy, FS_AUDIT_LOG: log }, stdio: fds });
  let rawExit;
  const closed = new Promise(resolve => child.on('close', (code, signal) => { rawExit = { code, signal }; resolve(); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    await closed;
    const replies = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.length, 4);
    const tools = replies.find(r => r.id === 2); assert.equal(tools.result.tools.length, 5);
    const bad = replies.find(r => r.id === 3); assert.equal(bad.result.isError, true);
    const result = replies.find(r => r.id === 4);
    assert.equal(result.result.structuredContent.controls.catalogState, 'fresh'); assert.equal(result.result.structuredContent.controls.enabled, true, 'the invalid disable did not apply');
    assert.deepEqual(changed(before, inventory(x.root)), ['state/connections.json']);
    assert.deepEqual(rawExit, { code: 0, signal: null }); assert.equal(readFileSync(error, 'utf8'), ''); assert.equal(readFileSync(join(decoy, 'auth.json'), 'utf8'), 'UNREAD-DECOY');
    const accesses = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(accesses.some(a => a.writes));
    for (const a of accesses) for (const path of a.paths) {
      assert.ok(path !== decoy && !path.startsWith(decoy + '/'), 'no decoy profile, auth, history or config path was accessed');
      if (a.writes) assert.ok(path.startsWith(join(x.root, 'state') + '/'), 'all server writes stay in the one declared store directory');
    }
  } finally { clearTimeout(timer); if (rawExit === undefined) { child.kill('SIGKILL'); await closed; } fds.forEach(closeSync); }
});
