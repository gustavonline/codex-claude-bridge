import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, permissionAnswer, catalogOf, agentDefinition, googleEndpoints, mcpRelay } from '../antigravity.mjs';

// The Antigravity adapter's own contract, against a scripted ACP agent (real stdio JSON-RPC, no Google, no agy). The live proof is
// scripts/live-antigravity.mjs; this pins the sequence, the catalog, the permission answer, cancellation and teardown offline.
const AGENT = `
const rl = require('node:readline').createInterface({ input: process.stdin }); const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const log = m => process.stderr.write(JSON.stringify(m) + '\\n'); let pending = null, nextId = 1000;
const options = [{ id: 'model', type: 'select', currentValue: 'gemini-flash', options: [{ value: 'gemini-flash', name: 'Gemini Flash' }, { value: 'claude-sonnet', name: 'Claude Sonnet' }] },
  { id: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }];
rl.on('line', line => { const m = JSON.parse(line); log({ got: m.method ?? 'response', params: m.params, result: m.result });
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } });
  else if (m.method === 'authenticate') send({ jsonrpc: '2.0', id: m.id, result: {} });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', configOptions: options } });
  else if (m.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: m.id, result: {} });
  else if (m.method === 'session/prompt' && m.params.prompt[0].text === 'tools') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREIGN' } } } });
    for (const [i, title] of [['p1', 'Run mcp_codex_find_tools'], ['p2', 'Run mcp_codex_evil'], ['p3', 'Run mcp_other_find_tools'], ['p4', 'touch x']]) send({ jsonrpc: '2.0', id: i, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { title }, options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }] } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }), 50);
  } else if (m.method === 'session/prompt') { pending = m.id; send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '1' } } } }); }
  else if (m.method === 'session/cancel' && pending) { send({ jsonrpc: '2.0', id: pending, result: { stopReason: 'cancelled' } }); pending = null; }
});
rl.on('close', () => process.exit(0));`;
function harness() {
  const calls = { start: null, stderr: '' };
  const start = async opts => {
    calls.start = opts; const child = spawn(process.execPath, ['-e', AGENT], { stdio: ['pipe', 'pipe', 'pipe'] }); child.stderr.on('data', d => { calls.stderr += d; });
    return { child, mcpUrl: 'http://127.0.0.1:18081/mcp', decisions: [], close: async () => { child.stdin.end(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); calls.closed = true; return { state: 'exited' }; } };
  };
  const seen = () => calls.stderr.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { calls, start, seen };
}
const base = h => ({ executable: process.execPath, cwd: mkdtempSync(join(tmpdir(), 'bridge-agy-')), home: '/home/someone', agentName: 'bridge-mcp-abc', mcpServe: stream => stream.destroy(), codexTools: new Set(['find_tools', 'call_tool']), start: h.start, available: () => true });

test('without the process boundary nothing is started and the refusal says why', async () => {
  let started = false;
  await assert.rejects(open({ ...base(harness()), available: () => false, start: async () => { started = true; } }), { code: 'harness_boundary_unavailable' });
  assert.equal(started, false);
});

test('a session runs inside the boundary with the Google-account route, the account\'s own catalog and the Codex MCP endpoint; choices outside the catalog are refused', async () => {
  const h = harness(), s = await open(base(h)), opts = h.calls.start;
  assert.deepEqual(opts.allow, [...googleEndpoints]); assert.deepEqual(opts.writable, ['/home/someone/.gemini']); assert.ok(opts.args.includes('--agent') && opts.args.at(-1) === 'bridge-mcp-abc');
  assert.deepEqual(opts.readable, [mcpRelay], 'only the fixed stdio relay is added inside'); assert.equal(opts.mcpSocket, undefined, 'no loopback TCP forward'); assert.equal(opts.env.TMPDIR, '/tmp'); assert.ok(!Object.keys(opts.env).some(k => /^(GEMINI_API|GOOGLE_)/.test(k)));
  assert.deepEqual(s.catalog, { models: [{ id: 'gemini-flash', name: 'Gemini Flash' }, { id: 'claude-sonnet', name: 'Claude Sonnet' }], levels: ['low', 'high'], current: { model: 'gemini-flash', level: 'high' } });
  await s.configure({ model: 'claude-sonnet', level: 'low' });
  await assert.rejects(s.configure({ model: 'gemini-neon' }), { code: 'model_not_available' }); await assert.rejects(s.configure({ level: 'max' }), { code: 'unsupported_reasoning_effort' });
  const sent = h.seen().map(m => m.got);
  assert.deepEqual(sent.filter(x => x !== 'response'), ['initialize', 'authenticate', 'session/new', 'session/set_config_option', 'session/set_config_option'], 'nothing unknown was sent');
  // ACP's mandatory stdio MCP form: agy launches the fixed relay to Bridge's own Unix socket in the sandbox run directory.
  const sessionNew = h.seen().find(m => m.got === 'session/new').params, [server] = sessionNew.mcpServers;
  assert.deepEqual([sessionNew.mcpServers.length, server.name, server.command, server.args[0], server.env], [1, 'codex', process.execPath, mcpRelay, []]);
  assert.ok(server.args[1].startsWith(opts.runDir + '/') && server.args[1].endsWith('.sock'));
  assert.equal(h.seen().find(m => m.got === 'authenticate').params.methodId, 'oauth-personal');
  await s.close(); assert.equal(h.calls.closed, true);
});

test('only Bridge\'s own Codex tools are allowed; another server, a lookalike name or a native tool is denied; foreign sessions are ignored', async () => {
  const h = harness(), events = [], s = await open({ ...base(h), onEvent: e => events.push(e) });
  assert.deepEqual(await s.prompt('tools'), { stopReason: 'end_turn' });
  assert.deepEqual(events.filter(e => e.type === 'permission').map(e => [e.title, e.allowed]), [['Run mcp_codex_find_tools', true], ['Run mcp_codex_evil', false], ['Run mcp_other_find_tools', false], ['touch x', false]]);
  assert.deepEqual(h.seen().filter(m => m.got === 'response' && m.result?.outcome).map(m => m.result.outcome.optionId), ['a', 'r', 'r', 'r']);
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.text), ['done'], 'the other session\'s text is not shown');
  await s.close();
});

test('cancel ends the running prompt as cancelled, and close ends the harness', async () => {
  const h = harness(), events = [], s = await open({ ...base(h), onEvent: e => events.push(e) });
  const running = s.prompt('count'); while (!events.some(e => e.type === 'text')) await new Promise(r => setTimeout(r, 5));
  s.cancel(); assert.deepEqual(await running, { stopReason: 'cancelled' }); await s.close(); assert.equal(h.calls.closed, true);
});

test('a prompt that outlives its bound is cancelled in the agent, not only abandoned', async () => {
  const h = harness(), s = await open(base(h));
  await assert.rejects(s.prompt('count', { timeoutMs: 100 }), { code: 'harness_timeout' });
  await new Promise(r => setTimeout(r, 50)); assert.ok(h.seen().some(m => m.got === 'session/cancel'), 'session/cancel was sent'); await s.close();
});

test('the permission answer and catalog parsing are total over odd input; the agent definition grants no native tool', () => {
  assert.equal(permissionAnswer({}, new Set(['x'])).allowed, false); assert.deepEqual(permissionAnswer({ toolCall: { title: 'Run mcp_codex_x' }, options: [] }, new Set(['x'])).outcome, { outcome: 'cancelled' });
  assert.deepEqual(catalogOf(null), { models: [], levels: [], current: { model: null, level: null } });
  assert.match(agentDefinition('bridge-mcp-1'), /\ntools: \[\]\n/); assert.match(agentDefinition('bridge-mcp-1'), /\nmainAgent: true\n/);
});
