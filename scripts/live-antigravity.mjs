// Explicit opt-in (--run): the Antigravity adapter (antigravity.mjs) end to end on an EXISTING agy login, inside its process boundary. A few
// short Gemini turns in a throwaway workspace: catalog, model/level choice, one Bridge MCP tool call, a cancel mid-turn and the teardown.
// The MCP-only agent definition is written to agy's own config/agents under a unique name and removed afterwards. Never signs in.
// Usage: node scripts/live-antigravity.mjs --run <absolute agy> [model] [level]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { open } from '../antigravity.mjs';

const [consent, agy, model = 'gemini-3.8-flash', level = 'low'] = process.argv.slice(2);
if (consent !== '--run' || !isAbsolute(agy ?? '')) throw new Error('Usage: --run <absolute agy> [model] [level]. This sends a few short real Antigravity turns on an existing login.');
const home = homedir(), agents = join(home, '.gemini', 'config', 'agents'), name = 'bridge-mcp-' + randomBytes(6).toString('hex'), hadAgents = existsSync(agents);
mkdirSync(agents, { recursive: true }); writeFileSync(join(agents, name + '.md'), (await import('../antigravity.mjs')).agentDefinition(name));
const ws = mkdtempSync(join(tmpdir(), 'bridge-agy-live-')); writeFileSync(join(ws, 'README.txt'), 'live workspace\n');
const calls = [], events = [];
const mcpHandler = async (req, res) => {
  const server = new McpServer({ name: 'codex', version: '0' });
  server.tool('probe_echo', 'Echo text back (Model Bridge live check).', { text: z.string() }, async ({ text }) => { calls.push(text); return { content: [{ type: 'text', text: 'echo:' + text }] }; });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport); let body = ''; req.on('data', b => { body += b; }); req.on('end', () => transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
};
const report = {}; const t0 = performance.now(); let session;
try {
  session = await open({ executable: agy, cwd: ws, home, agentName: name, mcpHandler, codexTools: new Set(['probe_echo']), onEvent: e => events.push({ ...e, at: Math.round(performance.now() - t0) }) });
  report.openMs = Math.round(performance.now() - t0); report.catalog = session.catalog;
  await session.configure({ model, level });
  let t = performance.now(); const first = await session.prompt('Call the probe_echo tool with text live, then reply with its result.');
  report.toolTurn = { stopReason: first.stopReason, ms: Math.round(performance.now() - t), mcpCalls: [...calls] };
  t = performance.now(); const started = events.length;
  const long = session.prompt('Count from 1 to 400, one number per line, nothing else.');
  while (!events.slice(started).some(e => e.type === 'text')) await new Promise(r => setTimeout(r, 20));
  const cancelAt = performance.now(); session.cancel(); const stopped = await long;
  report.cancel = { stopReason: stopped.stopReason, firstTextMs: Math.round(cancelAt - t), cancelToStopMs: Math.round(performance.now() - cancelAt) };
  report.permissions = events.filter(e => e.type === 'permission').map(e => ({ title: e.title, allowed: e.allowed }));
  report.deniedHosts = [...new Set(session.decisions.filter(d => !d.allowed).map(d => d.target))];
} catch (error) { report.error = { code: error.code, message: error.message }; }
finally {
  const t = performance.now(); report.close = session ? await session.close() : null; report.closeMs = Math.round(performance.now() - t);
  report.leftover = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).split('\n').filter(l => l.includes(ws)).length;
  report.workspaceFiles = readdirSync(ws, { recursive: true });
  rmSync(join(agents, name + '.md'), { force: true }); if (!hadAgents) rmSync(agents, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 1));
