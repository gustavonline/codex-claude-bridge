import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harnessModelId, parseHarnessModelId, routeOf, harnessStatuses, harnesses, antigravityLaunch, findExecutable } from '../plugins/codex-claude/home/harnesses.mjs';
import { prepareProviderHome, providerControls } from '../plugins/codex-claude/home/provider-controls.mjs';
import { session } from '../plugins/codex-claude/home/server.mjs';
import { isClaude } from '../providers.mjs';
import { fixture } from './support/fixture.mjs';
import { harness, hostReply, handshakeId, toolResult } from './support/home-host.mjs';

// Route identity is explicit (harness, connection, model), and a harness that is not qualified here is shown truthfully and never executed.
const text = x => [{ type: 'text', text: x }];

test('a Claude-named model served by another harness routes to that harness, never to Claude Code or Codex; saved aliases keep their routes', () => {
  const id = harnessModelId('antigravity', 'google-1', 'claude-opus-4-5');
  assert.deepEqual(routeOf(id, { isClaude }), { harness: 'antigravity', connectionId: 'google-1', model: 'claude-opus-4-5' });
  assert.equal(isClaude(id), false); assert.equal(isClaude(harnessModelId('antigravity', 'google-1', 'opus')), false);
  assert.deepEqual(routeOf('opus', { isClaude }), { harness: 'claude-agent-sdk', connectionId: 'subscription', model: 'opus' });
  assert.deepEqual(routeOf('claude-sonnet-4-5', { isClaude }).harness, 'claude-agent-sdk');
  assert.deepEqual(routeOf('gpt-5', { isClaude }), { harness: 'codex', connectionId: 'native', model: 'gpt-5' });
  assert.equal(routeOf('bridge-responses/abc/cXdlbg', { isClaude }).harness, 'custom-responses');
  for (const bad of ['bridge-harness/antigravity/c', 'bridge-harness/Antigravity/c/eA', 'bridge-harness/antigravity/c/eA/x', 'bridge-harness/antigravity/c/e+A', 'bridge-harness/antigravity/c/eA=']) assert.equal(parseHarnessModelId(bad), null, bad);
  assert.throws(() => harnessModelId('antigravity', 'C', 'm'), { code: 'route_invalid' });
});

test('a harness route is refused before any host, router or SDK sees it, for every model-carrying request', async () => {
  const f = fixture(); try {
    const claude = await f.start('haiku'), route = harnessModelId('antigravity', 'google-1', 'gemini-3-pro'), n = f.calls.length;
    for (const [method, params] of [['thread/start', { model: route }], ['thread/start', { collaborationMode: { mode: 'default', settings: { model: route } } }], ['turn/start', { threadId: claude, model: route, input: text('x') }],
      ['thread/settings/update', { threadId: claude, model: route }], ['thread/resume', { threadId: claude, model: route }], ['thread/fork', { threadId: claude, model: route }]])
      await assert.rejects(f.bridge.request(method, params), e => e.code === -32602 && /Gemini \(Antigravity\) is not available in Model Bridge yet, so nothing was sent/.test(e.message), method);
    assert.equal(f.calls.length, n, 'nothing reached native'); assert.equal(f.queries.length, 0, 'nor the Claude SDK'); assert.equal(f.bridge.records.get(claude).model, 'haiku');
  } finally { f.close(); }
});

test('statuses keep runtime, sign-in, models and execution as separate facts; a found runtime is never reported as ready', () => {
  const none = harnessStatuses({ find: () => null }), found = harnessStatuses({ find: name => name === 'agy' ? '/opt/agy' : null });
  assert.deepEqual(none.map(h => h.id), harnesses.filter(h => !h.executes).map(h => h.id)); assert.ok(!none.some(h => h.id === 'codex' || h.id === 'claude-agent-sdk'));
  for (const h of [...none, ...found]) assert.deepEqual([h.signIn, h.catalog, h.execution, typeof h.reason], ['unknown', 'unknown', 'not_qualified', 'string']);
  const agy = found.find(h => h.id === 'antigravity'); assert.deepEqual([agy.runtime, agy.minimumVersion, agy.executable], ['found', '1.5.0', 'agy']); assert.match(agy.reason, /not a sandbox/);
  assert.equal(none.find(h => h.id === 'antigravity').runtime, 'not_found'); assert.equal(none.find(h => h.id === 'cursor').runtime, 'not_applicable');
});

test('Home lists each other harness with its real state and reason, offers no action for it, and refuses a malformed list whole', async () => {
  const p = prepareProviderHome(join(mkdtempSync(join(tmpdir(), 'bridge-harness-')), 'scope')), server = session(undefined, providerControls(p.bindingPath));
  server({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }); server({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const status = server({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } }).result.structuredContent, list = status.controls.harnesses;
  const nodes = n => [n, ...n.children.flatMap(nodes)], show = content => { const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(content)); return h; };
  const open = h => { const gear = [...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)].find(n => n.tag === 'button' && n.getAttribute('aria-label') === 'Connections'); for (const fn of gear.listeners.click ?? []) fn({}); };
  const h = show(status); open(h);
  const rows = nodes(h.elements.controls).filter(n => /(^| )harness-row( |$)/.test(n.className));
  assert.ok(list.length >= 9); assert.equal(rows.length, list.length); assert.ok(rows.every(r => !nodes(r).some(n => n.tag === 'button')), 'no action for a harness that does not run here');
  const agy = rows.find(r => nodes(r).some(n => n.tag === 'h3' && n.textContent === 'Gemini (Antigravity)'));
  assert.match(nodes(agy).map(n => n.textContent).join(' '), /(Needs agy|agy found) · Not available in Bridge yet/); assert.match(h.text('controls'), /approval prompts are not a sandbox/);
  const forged = structuredClone(status); forged.controls.harnesses[0].execution = 'qualified';
  const g = show(forged); assert.equal(nodes(g.elements.controls).some(n => /harness-row/.test(n.className ?? '')), false, 'a claimed qualification is not shown');
});

test('the prepared Antigravity launch pins the Google-account route in its own app data and drops every ambient Gemini, Google, ADC or other provider override', () => {
  const env = { HOME: '/h', PATH: '/bin', GEMINI_API_KEY: 'x', GOOGLE_API_KEY: 'x', GOOGLE_APPLICATION_CREDENTIALS: '/adc.json', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_GENAI_USE_VERTEXAI: 'true', CLOUDSDK_CONFIG: '/c', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x' };
  const spec = antigravityLaunch({ executable: '/opt/agy', appDataDir: '/state/antigravity', env });
  assert.deepEqual(spec.env, { HOME: '/h', PATH: '/bin' }); assert.equal(spec.authMethod, 'oauth-personal');
  assert.deepEqual(spec.args, ['acp', '--app-data-dir', '/state/antigravity', '--disable-telemetry', '--sandbox']);
  assert.throws(() => antigravityLaunch({ executable: 'agy', appDataDir: '/s' }), { code: 'route_invalid' });
});

test('every ID the builder makes parses back, and a malformed harness-namespace ID is refused too, never passed on as a native model', async () => {
  for (const model of ['é'.repeat(256), 'x'.repeat(512), '🙂'.repeat(128)]) assert.equal(parseHarnessModelId(harnessModelId('antigravity', 'g1', model)).model, model);
  assert.throws(() => harnessModelId('antigravity', 'g1', 'é'.repeat(257)), { code: 'route_invalid' });
  const f = fixture(); try {
    const n = f.calls.length;
    await assert.rejects(f.bridge.request('thread/start', { model: 'bridge-harness/antigravity/c/not=base64' }), e => e.code === -32602 && /not available in Model Bridge yet/.test(e.message));
    assert.equal(f.calls.length, n);
  } finally { f.close(); }
});

test('a runtime installed in the usual per-user or Homebrew place is found even when a desktop PATH omits it', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-home-')), bin = join(home, '.local/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findExecutable('agy', { path: '/usr/bin', home }), join(bin, 'agy')); assert.equal(findExecutable('agy', { path: '/usr/bin', home: '' }), null);
});
