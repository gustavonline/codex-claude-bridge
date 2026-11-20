// The harnesses Model Bridge knows beneath the unmodified Codex desktop, and the explicit identity of a route to one of them.
// Codex stays native and Claude Code runs through the official Agent SDK: those two execute. Every other entry is a genuine upstream route,
// the one pinned T3 (pingdotgg/t3code df09ced, MIT) uses, listed with its real requirement and the exact reason it does not execute here.
// Nothing is offered in the model picker or started for a harness that is not qualified, and no generic chat proxy stands in for one.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// A route is (harness, connection, model). A harness model is always named with this prefix and its own harness and connection, so a model
// that ANOTHER harness serves under a familiar name (Antigravity lists Claude and GPT models) can never be read as a Claude Code or Codex model.
export const harnessPrefix = 'bridge-harness/';
const b64 = value => Buffer.from(value, 'utf8').toString('base64url');
const part = /^[a-z][a-z0-9-]{1,31}$/;
export function harnessModelId(harness, connectionId, model) {
  if (!part.test(harness) || !/^[a-z0-9-]{1,64}$/.test(connectionId) || typeof model !== 'string' || !model || model.length > 512) throw Object.assign(new Error('Invalid harness route'), { code: 'route_invalid' });
  return `${harnessPrefix}${harness}/${connectionId}/${b64(model)}`;
}
export function parseHarnessModelId(id) {
  if (typeof id !== 'string' || !id.startsWith(harnessPrefix)) return null;
  const [harness, connectionId, encoded, extra] = id.slice(harnessPrefix.length).split('/');
  if (extra !== undefined || !part.test(harness ?? '') || !/^[a-z0-9-]{1,64}$/.test(connectionId ?? '') || !/^[A-Za-z0-9_-]{1,700}$/.test(encoded ?? '')) return null;
  const model = Buffer.from(encoded, 'base64url').toString('utf8');
  return b64(model) === encoded ? { harness, connectionId, model } : null;
}
// The route a model ID names. Bare Claude names keep resolving to Claude Code (the compatibility aliases saved chats use); custom Responses
// endpoints keep their own prefix; anything else is Codex's own. `isClaude` is passed in so this module has one definition of each family.
export function routeOf(id, { isClaude }) {
  const harness = parseHarnessModelId(id);
  if (harness) return harness;
  if (typeof id === 'string' && id.startsWith('bridge-responses/')) return { harness: 'custom-responses', connectionId: id.split('/')[1] ?? null, model: id };
  if (isClaude(id)) return { harness: 'claude-agent-sdk', connectionId: 'subscription', model: id };
  return { harness: 'codex', connectionId: 'native', model: id };
}

// Static descriptors. `executes` is a qualification in THIS project (tool boundary, lifecycle, history and denial tested), not an upstream claim.
const descriptors = [
  { id: 'codex', label: 'Codex', transport: 'Codex app-server (native)', executes: true, toolBoundary: 'codex' },
  { id: 'claude-agent-sdk', label: 'Claude Code', transport: '@anthropic-ai/claude-agent-sdk', executes: true, toolBoundary: 'codex-mcp', executable: 'claude' },
  { id: 'antigravity', label: 'Gemini (Antigravity)', transport: 'ACP: agy acp', executable: 'agy', minimumVersion: '1.5.0', auth: 'Google account in the browser (oauth-personal)',
    reason: 'Antigravity runs its own shell and file edits. ACP approval prompts are not a sandbox, so it stays off until an enforced boundary matching Codex permissions is proven.' },
  { id: 'cursor', label: 'Cursor', transport: '@cursor/sdk', auth: 'Cursor account',
    reason: 'The Cursor SDK reports no command or file approval support, so Codex permissions cannot be honoured.' },
  { id: 'muse', label: 'Muse Code', transport: '@muse-code/sdk', auth: 'Muse account', reason: 'Not qualified in Model Bridge yet.' },
  { id: 'grok', label: 'Grok', transport: 'ACP', executable: 'grok', reason: 'ACP agent with its own tools; not qualified in Model Bridge yet.' },
  { id: 'fx', label: 'fx', transport: 'ACP', executable: 'fx', reason: 'ACP agent with its own tools; not qualified in Model Bridge yet.' },
  { id: 'kiro', label: 'Kiro', transport: 'ACP', executable: 'kiro-cli', reason: 'ACP agent with its own tools; not qualified in Model Bridge yet.' },
  { id: 'acp-registry', label: 'ACP registry agents', transport: 'ACP registry', reason: 'Each registry agent brings its own tools; none is qualified in Model Bridge yet.' },
  { id: 'pi', label: 'Pi', transport: 'Pi RPC', executable: 'pi', reason: 'Not qualified in Model Bridge yet.' },
  { id: 'opencode', label: 'OpenCode', transport: '@opencode-ai/sdk over HTTP', executable: 'opencode', reason: 'Runs its own tools and server; not qualified in Model Bridge yet.' },
].map(d => Object.freeze(d));
export const harnesses = Object.freeze(descriptors);
export const harness = id => harnesses.find(h => h.id === id) ?? null;

// An executable found on PATH (or at an explicit absolute path) is only "found": it is never run here, so its version, sign-in and models stay unknown.
export function findExecutable(name, { path = process.env.PATH ?? '' } = {}) {
  for (const dir of isAbsolute(name) ? [''] : path.split(delimiter).filter(isAbsolute)) {
    const candidate = dir ? join(dir, name) : name;
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* not here */ }
  }
  return null;
}
// What Home shows for every harness that is not one of the executing two. States are separate facts, never folded into "ready":
// runtime (found / not_found / not_applicable), sign-in and models (unknown: nothing is probed), execution (not_qualified + reason).
export function harnessStatuses({ find = findExecutable } = {}) {
  return harnesses.filter(h => !h.executes).map(h => ({ id: h.id, label: h.label, transport: h.transport,
    runtime: h.executable ? (find(h.executable) ? 'found' : 'not_found') : 'not_applicable', ...(h.executable ? { executable: h.executable } : {}),
    ...(h.minimumVersion ? { minimumVersion: h.minimumVersion } : {}), ...(h.auth ? { auth: h.auth } : {}),
    signIn: 'unknown', catalog: 'unknown', execution: 'not_qualified', reason: h.reason }));
}
// The refusal for a harness route that reached execution anyway (a pasted or stale model ID): explicit, before anything is created.
export function harnessRefusal(route) {
  const h = harness(route.harness);
  return Object.assign(new Error(`${h ? h.label : 'This harness'} is not available in Model Bridge yet, so nothing was sent. ${h?.reason ?? ''}`.trim()), { code: 'harness_not_qualified' });
}

// Prepared launch for Antigravity's official ACP server (flags of `agy acp --help`, 1.5.x), used once its tool boundary is qualified. The
// subscription route signs in with the Google account (oauth-personal) in its OWN app-data directory, and ambient Gemini/Google/ADC variables
// are removed so a parent shell can never switch it to API-key or Vertex billing. Nothing here runs agy.
const googleOverride = /^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|VERTEX|ANTIGRAVITY_)/;
export function antigravityLaunch({ executable, appDataDir, env = process.env }) {
  if (!isAbsolute(executable ?? '') || !isAbsolute(appDataDir ?? '')) throw Object.assign(new Error('Antigravity needs an absolute executable and app-data path'), { code: 'route_invalid' });
  return { command: executable, args: ['acp', '--app-data-dir', appDataDir, '--disable-telemetry', '--sandbox'], authMethod: 'oauth-personal',
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !googleOverride.test(key) && !/^(OPENAI_|ANTHROPIC_|CODEX_|BRIDGE_|CLAUDE_CODE_)/.test(key))) };
}
