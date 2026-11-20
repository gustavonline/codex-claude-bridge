// Explicit opt-in (--run): signed-in Antigravity qualification (docs/antigravity-qualification.md). Reuses an EXISTING agy login; never signs in.
// One ACP session in a throwaway workspace, a few short turns on the cheapest model. Native permission requests are answered by POLICY
// (deny | mcp-only | allow) and a Bridge-hosted HTTP MCP echo tool is offered. Optional PROBE_AGENT / PROBE_HOOKS put a custom agent or hooks
// file in the THROWAWAY workspace only. Prints tool calls, permission requests, file effects inside/outside the workspace and the teardown.
// agy itself still records each probe session in the signed-in profile ($HOME/.gemini/antigravity-cli/conversations on 1.5.13).
// Usage: node scripts/qualify-antigravity.mjs --run <agy> <scratch-parent-dir> <policy> '<json prompts>' ['<json extra acp args>']
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
const [consent, agy, parent, policy = 'deny', promptJson, extraJson = '[]'] = process.argv.slice(2);
if (consent !== '--run') throw new Error('This sends real Antigravity turns on an existing login. Pass --run to authorize a few short synthetic turns.');
if (!isAbsolute(agy ?? '') || !isAbsolute(parent ?? '') || !['deny', 'mcp-only', 'allow'].includes(policy)) throw new Error('Usage: --run <absolute agy> <absolute scratch dir> <deny|mcp-only|allow> <json prompts> [json acp args]');
const prompts = JSON.parse(promptJson), extraArgs = JSON.parse(extraJson);
// A fresh run directory inside the given parent: nothing that already exists is ever removed or reused.
mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'agy-qualification-'));
const ws = join(root, 'workspace'), outside = join(root, 'outside'); mkdirSync(ws); mkdirSync(outside);
writeFileSync(join(ws, 'README.txt'), 'probe workspace\n');
if (process.env.PROBE_HOOKS) { mkdirSync(join(ws, '.agents'), { recursive: true }); writeFileSync(join(ws, '.agents/hooks.json'), process.env.PROBE_HOOKS.replaceAll('$WS', ws)); }
if (process.env.PROBE_AGENT) { mkdirSync(join(ws, '.agents/agents'), { recursive: true }); writeFileSync(join(ws, '.agents/agents/bridge-mcp.md'), process.env.PROBE_AGENT); }
const report = { policy, prompts: prompts.length, mcpCalls: [], permissionRequests: [], toolCalls: [], updates: {}, text: '', errors: [] };
// The Bridge side of an MCP tool: what Codex would run. Here it only echoes.
const http = createServer(async (req, res) => {
  const server = new McpServer({ name: 'codex', version: '0' });
  server.tool('probe_echo', 'Echo text back (Model Bridge probe tool).', { text: z.string() }, async ({ text }) => { report.mcpCalls.push(text); return { content: [{ type: 'text', text: 'echo:' + text }] }; });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport); let body = ''; req.on('data', b => { body += b; }); req.on('end', () => transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
});
await new Promise(r => http.listen(0, '127.0.0.1', r)); const port = http.address().port;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|VERTEX|AGY_|OPENAI_|ANTHROPIC_|CLAUDE|CODEX_|BRIDGE_)/.test(k)));
Object.assign(env, { ...(process.env.GEMINI_HOME ? { GEMINI_HOME: process.env.GEMINI_HOME } : {}), AGY_CLI_DISABLE_AUTO_UPDATE: '1', AGY_ACP_FORCE_FILE_STORAGE: '1', BROWSER: '/bin/false', SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', TMPDIR: join(root, 'tmp') });
mkdirSync(env.TMPDIR);
const t0 = performance.now();
const child = spawn(agy, ['acp', '--process-per-session', '--disable-telemetry', '--include-default-customizations=false', '--log-file', join(root, 'acp.log'), ...extraArgs],
  { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
let buf = '', id = 0; const waiting = new Map(); child.stderr.on('data', b => { report.stderr = ((report.stderr ?? '') + b).slice(-800); });
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
const rpc = (method, params, ms = 120000) => new Promise((resolve, reject) => { const i = ++id; const t = setTimeout(() => { waiting.delete(i); reject(new Error(method + ' timeout')); }, ms); waiting.set(i, m => { clearTimeout(t); m.error ? reject(Object.assign(new Error(method + ': ' + m.error.message), { rpc: m.error })) : resolve(m.result); }); send({ jsonrpc: '2.0', id: i, method, params }); });
child.stdout.on('data', b => {
  buf += b; let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1); let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
    if (m.method === 'session/request_permission') {
      const tc = m.params.toolCall ?? {}, opts = m.params.options ?? [];
      const allow = policy === 'allow' || (policy === 'mcp-only' && /^Run mcp_codex_/.test(tc.title ?? ''));
      const pick = allow ? opts.find(o => o.kind === 'allow_once') : opts.find(o => o.kind === 'reject_once') ?? opts.find(o => o.kind?.startsWith('reject'));
      report.permissionRequests.push({ title: tc.title, kind: tc.kind, toolCallId: tc.toolCallId, raw: JSON.stringify(tc.rawInput ?? tc.content ?? null).slice(0, 300), options: opts.map(o => o.kind), answered: pick?.kind ?? 'cancelled' });
      send({ jsonrpc: '2.0', id: m.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } }); continue;
    }
    if (m.method && m.id != null) { report.errors.push('client method ' + m.method); send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by Model Bridge' } }); continue; }
    if (m.method === 'session/update') {
      const u = m.params.update; report.updates[u.sessionUpdate] = (report.updates[u.sessionUpdate] ?? 0) + 1;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { report.text += u.content.text; report.firstTextMs ??= Math.round(performance.now() - report.promptAt); }
      if (u.sessionUpdate === 'tool_call') report.toolCalls.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status, raw: JSON.stringify(u.rawInput ?? null).slice(0, 300) });
      if (u.sessionUpdate === 'tool_call_update') { const c = report.toolCalls.find(t => t.id === u.toolCallId); if (c && u.status) c.status = u.status; }
    }
  }
});
try {
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'model-bridge', version: '0.3.0' } });
  report.initMs = Math.round(performance.now() - t0); report.agent = init.agentInfo?.version;
  await rpc('authenticate', { methodId: 'oauth-personal' }); report.authMs = Math.round(performance.now() - t0);
  const s = await rpc('session/new', { cwd: ws, mcpServers: [{ type: 'http', name: 'codex', url: `http://127.0.0.1:${port}/mcp`, headers: [] }] });
  report.sessionMs = Math.round(performance.now() - t0); const sessionId = s.sessionId;
  report.models = s.models?.availableModels?.map(m => m.modelId);
  await rpc('session/set_config_option', { sessionId, configId: 'model', value: 'gemini-3.8-flash' }).catch(e => report.errors.push('set model: ' + e.message));
  await rpc('session/set_config_option', { sessionId, configId: 'thought_level', value: 'low' }).catch(e => report.errors.push('set level: ' + e.message));
  report.turns = [];
  for (const text of prompts) {
    report.promptAt = performance.now(); report.firstTextMs = undefined;
    const r = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: text.replaceAll('$OUTSIDE', outside) }] }, 240000);
    report.turns.push({ calls: report.toolCalls.length, asks: report.permissionRequests.length, stopReason: r.stopReason, firstTextMs: report.firstTextMs, totalMs: Math.round(performance.now() - report.promptAt) });
  }
} catch (e) { report.errors.push(e.message); }
// Effects, then owned teardown of the whole process group.
report.workspaceFiles = readdirSync(ws, { recursive: true }).filter(f => !f.startsWith('.agents')); report.outsideFiles = readdirSync(outside, { recursive: true });
const tree = () => { try { return execFileSync('ps', ['-o', 'pid=', '-g', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
report.processesBeforeClose = tree();
const t1 = performance.now(); child.stdin.end();
const exited = await Promise.race([new Promise(r => child.once('exit', () => r(true))), new Promise(r => setTimeout(() => r(false), 5000))]);
if (!exited) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await new Promise(r => setTimeout(r, 2000)); }
report.stdinCloseExited = exited; report.closeToExitMs = Math.round(performance.now() - t1);
await new Promise(r => setTimeout(r, 500)); report.processesAfterClose = tree();
if (report.processesAfterClose) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
http.close(); delete report.promptAt;
report.runDirectory = root;
console.log(JSON.stringify(report, null, 1));
process.exit(0);
