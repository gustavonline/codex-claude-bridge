import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ProviderRegistry, localModelId } from '../plugins/codex-claude/home/providers.mjs';
import { providerControls, prepareProviderHome } from '../plugins/codex-claude/home/provider-controls.mjs';
import { session, homeHtml, homeResource } from '../plugins/codex-claude/home/server.mjs';
import { fixture } from './support/fixture.mjs';
import { harness, hostReply, handshakeId, toolResult } from './support/home-host.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'bridge-slots-'));
const hash = b => createHash('sha256').update(b).digest('hex');
function inventory(root, prefix = '') {
  return Object.fromEntries(readdirSync(root).sort().flatMap(name => {
    const path = join(root, name), s = lstatSync(path), rel = prefix + name;
    return s.isDirectory() ? Object.entries(inventory(path, rel + '/')) : [[rel, hash(readFileSync(path))]];
  }));
}
function transport(models) {
  return { request: (_url, _options, receive) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {};
      receive(res); res.emit('data', Buffer.from(JSON.stringify({ data: models.map(id => ({ id })) }))); res.emit('end');
    }); return req;
  } };
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
function ready(controls) { const server = session(undefined, controls); server(init); server({ jsonrpc: '2.0', method: 'notifications/initialized' }); return server; }
const home = server => server({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } }).result.structuredContent;
const nodes = n => [n, ...n.children.flatMap(nodes)];
const buttons = h => nodes(h.elements.controls).filter(n => n.tag === 'button');
const find = (h, name) => buttons(h).find(n => n.getAttribute('aria-label') === name || n.textContent === name);
function click(h, name) { const b = find(h, name); assert.ok(b, name); assert.equal(b.disabled, false, name + ' enabled'); b.focus?.(); for (const fn of b.listeners.click ?? []) fn({}); }
async function round(h, server, name) { click(h, name); const call = h.sent('tools/call').at(-1); h.deliver(await server(call)); return call; }
async function setup() {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')), registry = new ProviderRegistry(p.state);
  const a = registry.create({ name: 'Provider A', baseUrl: 'https://a.example.invalid/v1' }), b = registry.create({ name: 'Provider B', baseUrl: 'https://b.example.invalid/v1' });
  await registry.refresh(a, transport(['small', 'large'])); await registry.refresh(b, transport(['other']));
  const ids = [localModelId(a, 'small'), localModelId(a, 'large'), localModelId(b, 'other')];
  const server = ready(providerControls(p.bindingPath));
  return { ...p, registry, a, b, ids, server };
}
function ui(server) { const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(home(server))); return h; }

test('explicit saved slots filter actual model/list across providers, reopen/restart, and discovery never silently expands the curated set', async () => {
  const x = await setup(), f = fixture('openai', { connectionRoot: x.state }), initial = inventory(x.state);
  const before = (await f.bridge.request('model/list', {})).data;
  assert.equal(before.length, 7); assert.deepEqual(x.registry.slots(), { version: 1, revision: 0, models: null });
  assert.deepEqual(inventory(x.state), initial, 'legacy read/list does not migrate provider records or create slot policy');
  x.registry.saveSlots([x.ids[0], x.ids[2]], 0);
  const first = (await f.bridge.request('model/list', {})).data;
  assert.deepEqual(first.slice(0, 4), before.slice(0, 4)); assert.deepEqual(new Set(first.slice(4).map(m => m.id)), new Set([x.ids[0], x.ids[2]]));
  assert.ok(first.slice(4).every(m => !m.isDefault));
  const changed = Object.keys(inventory(x.state)).filter(p => initial[p] !== inventory(x.state)[p]);
  assert.deepEqual(changed, ['model-slots.json'], 'only the explicit separate setting changes');
  f.restart(); assert.deepEqual((await f.bridge.request('model/list', {})).data, first);
  assert.deepEqual(new ProviderRegistry(x.state).slots().models, [x.ids[0], x.ids[2]]);
  await x.registry.refresh(x.a, transport(['small', 'large', 'newly-discovered']));
  assert.deepEqual((await f.bridge.request('model/list', {})).data.slice(4).map(m => m.id).sort(), [x.ids[0], x.ids[2]].sort());
});

test('all-hidden and unavailable slots preserve existing thread/history; visibility is not a permission boundary and GPT/Claude remain unchanged', async () => {
  const x = await setup(), f = fixture('openai', { connectionRoot: x.state });
  const tid = await f.start(x.ids[0]), turn = await f.send(tid, 'synthetic retained history'); await f.done(turn.turn.id);
  const retained = structuredClone(f.hosts.get(tid).thread.turns); x.registry.saveSlots([], 0);
  assert.deepEqual((await f.bridge.request('model/list', {})).data.map(m => m.id), ['gpt-test', 'gpt-other', 'haiku', 'sonnet']);
  f.restart(); assert.equal((await f.bridge.request('thread/resume', { threadId: tid })).model, x.ids[0]);
  assert.deepEqual(f.hosts.get(tid).thread.turns, retained);
  assert.ok(await f.start(x.ids[1]), 'explicit hidden model ID remains subject to normal provider admission, not a secrecy boundary');
  assert.ok(await f.start('gpt-test')); assert.ok(await f.start('haiku'));
  x.registry.saveSlots([x.ids[0]], 1); x.registry.enabled(x.a, false);
  assert.equal((await f.bridge.request('model/list', {})).data.length, 4);
  assert.deepEqual(x.registry.slots().models, [x.ids[0]]);
  await assert.rejects(f.send(tid, 'disabled'), { code: 'provider_disabled' });
  assert.equal((await f.bridge.request('thread/resume', { threadId: tid })).model, x.ids[0]);
  x.registry.enabled(x.a, true); await x.registry.refresh(x.a, transport(['replacement']));
  assert.equal((await f.bridge.request('model/list', {})).data.length, 4, 'removed model is not replaced in a saved slot');
  assert.deepEqual(x.registry.slots().models, [x.ids[0]], 'unavailable slot retained for explicit removal');
  x.registry.saveSlots([], 2); assert.deepEqual(x.registry.slots().models, []);
});

test('stale, invalid, duplicate, wrong-scope and competing slot saves do not write; expected revisions reject stale decisions', async () => {
  const x = await setup(), before = inventory(x.state), c = home(x.server).controls;
  const args = { ...x.scope, revision: c.revision, slotsRevision: c.slots.revision, models: [x.ids[0]] };
  const call = a => x.server({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bridge_provider_slots', arguments: a } });
  for (const bad of [{ ...args, profileId: 'f'.repeat(32) }, { ...args, revision: c.revision + 1 }, { ...args, slotsRevision: 99 },
    { ...args, path: '/not-read' }, { ...args, models: ['gpt-test'] }, { ...args, models: [x.ids[0], x.ids[0]] }, { ...args, models: [localModelId(x.a, 'not-discovered')] }]) {
    assert.equal((await call(bad)).result.isError, true); assert.deepEqual(inventory(x.state), before);
  }
  assert.notEqual((await call(args)).result.isError, true);
  const saved = inventory(x.state); await assert.rejects(Promise.resolve().then(() => new ProviderRegistry(x.state).saveSlots([x.ids[1]], 0)), { code: 'stale_revision' });
  assert.deepEqual(inventory(x.state), saved);
  x.registry.enabled(x.b, false); const disabled = inventory(x.state);
  assert.throws(() => x.registry.saveSlots([x.ids[0], x.ids[2]], 1), { code: 'slot_model_unavailable' }); assert.deepEqual(inventory(x.state), disabled);
  writeFileSync(join(x.state, 'model-slots.json'), '{retained invalid');
  assert.equal(home(x.server).controls, null, 'unreadable policy never silently restores all models');
  assert.equal(readFileSync(join(x.state, 'model-slots.json'), 'utf8'), '{retained invalid');
});

test('shipped dashboard has explicit add flow and accessible slot actions; local drafts do not write before Save and reach model/list after Save', async () => {
  const x = await setup(), h = ui(x.server), before = inventory(x.state);
  assert.equal(nodes(h.elements.controls).some(n => n.tag === 'input' && n.id === 'name'), false);
  click(h, 'Add connection'); assert.equal(h.sandbox.document.activeElement.id, 'name');
  const name = nodes(h.elements.controls).find(n => n.id === 'name'); name.value = '<Draft & name>'; name.listeners.input[0]({});
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });
  assert.equal(nodes(h.elements.controls).find(n => n.id === 'name').value, '<Draft & name>');
  assert.equal(h.sandbox.document.activeElement.id, 'name');
  click(h, 'Cancel'); click(h, 'All providers'); click(h, 'Clear slots');
  click(h, 'Add small from Provider A to slots'); click(h, 'Add other from Provider B to slots');
  assert.deepEqual(inventory(x.state), before); assert.match(h.text('controls'), /Unsaved slot changes/);
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light', displayMode: 'fullscreen' } });
  const save = await round(h, x.server, 'Save slots'); assert.equal(save.params.name, 'bridge_provider_slots');
  assert.deepEqual(save.params.arguments.models, [x.ids[0], x.ids[2]]);
  assert.deepEqual(x.registry.slots().models, [x.ids[0], x.ids[2]]);
  const f = fixture('openai', { connectionRoot: x.state }); assert.deepEqual(new Set((await f.bridge.request('model/list', {})).data.slice(4).map(m => m.id)), new Set([x.ids[0], x.ids[2]]));
  assert.ok(nodes(h.elements.controls).filter(n => n.tag === 'button').every(b => b.type === 'button'), 'native keyboard-operable buttons, no click-only divs');
  assert.equal(h.sandbox.document.activeElement.textContent, 'Model slots');
  assert.equal(h.layout.unstable, false);
});

test('cancelled possibly committed slot Save ignores late reply, preserves draft and requires explicit same-scope read without write replay', async () => {
  const x = await setup(), h = ui(x.server); click(h, 'All providers'); click(h, 'Clear slots'); click(h, 'Add small from Provider A to slots');
  click(h, 'Save slots'); const save = h.sent('tools/call').at(-1), committed = await x.server(save);
  const after = inventory(x.state); h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' });
  h.deliver(committed); h.advance(30000); assert.equal(h.sent('tools/call').length, 1);
  assert.deepEqual(buttons(h).map(b => b.textContent), ['Read current state']);
  await round(h, x.server, 'Read current state'); assert.deepEqual(inventory(x.state), after);
  assert.equal(h.sent('tools/call').filter(c => c.params.name === 'bridge_provider_slots').length, 1);
  assert.match(h.text('controls'), /small/); assert.deepEqual(x.registry.slots().models, [x.ids[0]]);
});

test('unsaved draft survives status recovery when another writer saved different slots; rebasing requires an explicit local choice', async () => {
  const x = await setup(), h = ui(x.server); click(h, 'All providers'); click(h, 'Clear slots'); click(h, 'Add small from Provider A to slots');
  x.registry.saveSlots([x.ids[1]], 0); await round(h, x.server, 'Read current state');
  assert.match(h.text('controls'), /Your draft is kept/); assert.equal(find(h, 'Save slots').disabled, true);
  const before = inventory(x.state); click(h, 'Keep my draft'); assert.deepEqual(inventory(x.state), before);
  const saved = await round(h, x.server, 'Save slots'); assert.equal(saved.params.arguments.slotsRevision, 1);
  assert.deepEqual(x.registry.slots().models, [x.ids[0]]);
});

test('sidebar/global Home auto-load calls only the no-argument read tool, has bounded retry and preserves global/thread metadata', async () => {
  const x = await setup(), h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.advance(0);
  const request = h.sent('tools/call'); assert.equal(request.length, 1); assert.deepEqual(request[0].params, { name: 'bridge_home', arguments: {} });
  h.deliver(await x.server(request[0])); assert.match(h.text('controls'), /Model slots/); h.advance(30000); assert.equal(h.sent('tools/call').length, 1);
  const listed = x.server({ jsonrpc: '2.0', id: 9, method: 'tools/list' }).result.tools;
  assert.deepEqual(listed[0]._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.deepEqual(listed[0].inputSchema.properties, {}); assert.equal(listed.filter(t => t.name === 'bridge_home').length, 1);
  const failed = harness(); failed.deliver(hostReply(handshakeId(failed), { hostCapabilities: { serverTools: {} } })); failed.advance(0); failed.advance(8000); failed.advance(60000);
  assert.equal(failed.sent('tools/call').length, 1, 'a timeout never retries automatically');
  click(failed, 'Reload Home'); assert.equal(failed.sent('tools/call').length, 2);
});

test('dashboard shell is responsive, native-theme/font based, diagnostics collapsed and needs no assets, model or network API', () => {
  const html = homeHtml(); assert.equal(homeResource, 'ui://codex-claude/home-v7.html');
  assert.match(html, /dashboard-grid/); assert.match(html, /@media\(max-width:680px\)/); assert.match(html, /:focus-visible/);
  assert.match(html, /system-ui/); assert.match(html, /data-theme=dark/); assert.match(html, /data-theme=light/);
  assert.ok(html.indexOf('<section id="controls"') < html.indexOf('<details id="technical"'));
  assert.ok(html.indexOf('<details id="technical"') < html.indexOf('<ul id="facts"'));
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/); assert.doesNotMatch(html, /https?:\/\/[^'"< ]+\.(?:css|js|woff)/);
  assert.match(html, /connect-src 'none'/); assert.doesNotMatch(html, /<iframe|<img|<link|fetch\(|localStorage|WebSocket\(/);
});

test('stale saved slots remain visible as unavailable with explicit removal; discovery failure does not rewrite saved curation', async () => {
  const x = await setup(); x.registry.saveSlots([x.ids[0]], 0); const h = ui(x.server);
  const request = (_url, _options, receive) => { const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => receive({ statusCode: 503, destroy() {} })); return req; };
  await assert.rejects(x.registry.refresh(x.a, { request }));
  await round(h, x.server, 'Read current state'); click(h, 'All providers');
  assert.match(h.text('controls'), /Unavailable in picker/); assert.deepEqual(x.registry.slots().models, [x.ids[0]]);
  assert.equal(find(h, 'Add large from Provider A to slots').disabled, true);
  click(h, 'Remove small from Provider A from slots'); await round(h, x.server, 'Save slots');
  assert.deepEqual(x.registry.slots().models, []);
});

test('public MCP stdio accepts a many-model saved selection without a small slot cap; unrelated requests retain the 64KiB bound', async () => {
  const parent = temp(), p = prepareProviderHome(join(parent, 'scope')), registry = new ProviderRegistry(p.state);
  const provider = registry.create({ name: 'Many models fixture', baseUrl: 'https://many.example.invalid/v1' });
  const names = Array.from({ length: 120 }, (_, i) => 'model-' + i + '-' + 'x'.repeat(495));
  await registry.refresh(provider, transport(names)); const ids = names.map(m => localModelId(provider, m));
  const c = home(ready(providerControls(p.bindingPath))).controls;
  const save = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_provider_slots', arguments: { ...p.scope, revision: c.revision, slotsRevision: 0, models: ids } } };
  assert.ok(Buffer.byteLength(JSON.stringify(save)) > 65536);
  const messages = [init, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home', arguments: { padding: 'x'.repeat(70000) } } }, save];
  const input = join(parent, 'input'), output = join(parent, 'output'), error = join(parent, 'error');
  writeFileSync(input, messages.map(m => JSON.stringify(m)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const fds = [openSync(input, 'r'), openSync(output, 'wx', 0o600), openSync(error, 'wx', 0o600)];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/codex-claude/home/provider-server.mjs', import.meta.url)), '--provider-binding', p.bindingPath],
    { env: { HOME: parent, CODEX_HOME: parent, PATH: '/usr/bin:/bin' }, stdio: fds });
  let result; const done = new Promise(resolve => child.on('close', (code, signal) => { result = { code, signal }; resolve(); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    await done; assert.deepEqual(result, { code: 0, signal: null }); assert.equal(readFileSync(error, 'utf8'), '');
    const rows = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 3); assert.equal(rows.find(r => r.id === null).error.code, -32700);
    assert.notEqual(rows.find(r => r.id === 3).result.isError, true); assert.deepEqual(registry.slots().models, ids);
    assert.equal(registry.slots().revision, 1);
  } finally { clearTimeout(timer); if (!result) { child.kill('SIGKILL'); await done; } fds.forEach(closeSync); }
});


test('top tile targets precede the library; drag/drop is a guarded local draft with equivalent labeled keyboard actions', async () => {
  const x = await setup(), h = ui(x.server); click(h, 'All providers'); click(h, 'Clear slots');
  const before = inventory(x.state), all = () => nodes(h.elements.controls);
  const section = () => all().find(n => n.className === 'panel slots');
  const workspace = all().find(n => n.className === 'workspace');
  assert.deepEqual(workspace.children.map(n => n.getAttribute('aria-label')), ['Model slots', 'Model library']);
  assert.equal(all().find(n => n.className === 'library-list').tabIndex, 0);
  assert.equal(all().find(n => n.className === 'slot-list').tabIndex, 0, 'bounded lists can be scrolled by keyboard');
  assert.ok(all().filter(n => n.tag === 'button' && ['Provider A', 'Provider B'].includes(n.textContent)).every(n => n.getAttribute('aria-pressed') === 'false'));
  assert.equal(find(h, 'All providers').getAttribute('aria-pressed'), 'true', 'one active library filter, not checkbox semantics');
  const card = all().find(n => n.tag === 'article' && n.textContent.includes('small'));
  const transfer = { data: '', setData(type, value) { assert.equal(type, 'text/plain'); this.data = value; }, getData(type) { assert.equal(type, 'text/plain'); return this.data; } };
  card.listeners.dragstart[0]({ dataTransfer: transfer, preventDefault() { assert.fail('valid discovered drag'); } });
  assert.equal(transfer.data, x.ids[0]);
  let prevented = 0; section().listeners.drop[0]({ dataTransfer: transfer, preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.deepEqual(inventory(x.state), before);
  assert.ok(find(h, 'Remove small from Provider A from slots'));
  for (const id of [x.ids[0], 'https://outside.invalid', 'not-a-discovered-model']) {
    transfer.data = id; section().listeners.drop[0]({ dataTransfer: transfer, preventDefault() {} });
  }
  assert.equal(nodes(section()).filter(b => b.tag === 'button' && b.getAttribute('aria-label') === 'Remove small from Provider A from slots').length, 1, 'duplicate/foreign drops cannot add slots');
  click(h, 'Add other from Provider B to slots');
  await round(h, x.server, 'Save slots'); assert.deepEqual(x.registry.slots().models, [x.ids[0], x.ids[2]]);
  const retainedTarget = section();
  h.deliver({ jsonrpc: '2.0', method: 'ui/resource-teardown', id: 'close' });
  transfer.data = x.ids[1]; const count = h.sent('tools/call').length;
  retainedTarget.listeners.drop[0]({ dataTransfer: transfer, preventDefault() {} });
  assert.equal(h.sent('tools/call').length, count); assert.deepEqual(x.registry.slots().models, [x.ids[0], x.ids[2]]);
  const html = homeHtml(); assert.match(html, /grid-template-columns:repeat\(auto-fill,minmax\(148px,1fr\)\)/);
  assert.match(html, /max-height:min\(46vh,420px\);overflow:auto/); assert.match(html, /aspect-ratio:1/);
});
