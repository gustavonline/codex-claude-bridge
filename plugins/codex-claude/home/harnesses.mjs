// The harnesses Model Bridge knows beneath the unmodified Codex desktop, and the explicit identity of a route to one of them.
// Codex stays native and Claude Code runs through the official Agent SDK: those two execute. Every other entry is a genuine upstream route,
// the one pinned T3 (pingdotgg/t3code df09ced, MIT) uses, listed with its real requirement and the exact reason it does not execute here.
// Nothing is offered in the model picker or started for a harness that is not qualified, and no generic chat proxy stands in for one.
import { accessSync, constants, statSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// A route is (harness, connection, model). A harness model is always named with this prefix and its own harness and connection, so a model
// that ANOTHER harness serves under a familiar name (Antigravity lists Claude and GPT models) can never be read as a Claude Code or Codex model.
export const harnessPrefix = 'bridge-harness/';
const b64 = value => Buffer.from(value, 'utf8').toString('base64url');
const part = /^[a-z][a-z0-9-]{1,31}$/;
export function harnessModelId(harness, connectionId, model) {
  if (!part.test(harness) || !/^[a-z0-9-]{1,64}$/.test(connectionId) || typeof model !== 'string' || !model || Buffer.byteLength(model) > 512) throw Object.assign(new Error('Invalid harness route'), { code: 'route_invalid' });
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
  { id: 'antigravity', label: 'Gemini (Antigravity)', transport: 'ACP: agy acp', executable: 'agy', minimumVersion: '1.5.0', auth: 'Google account in the browser (oauth-personal)', boundary: ['linux'],
    reason: 'A workspace\'s own Antigravity hooks run commands outside the Codex sandbox, without asking, at every session start and model call. It stays off until its whole process runs inside a boundary that matches Codex permissions.',
    reasonWhereSupported: 'Runs inside Model Bridge\'s process boundary, with only the Codex tools Bridge supplies. Sign in once with agy itself; Bridge never sees your Google password. Your account\'s models appear in the model list for new chats.' },
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
// A desktop app's PATH usually lacks the per-user and Homebrew locations installers use, so those are searched too.
const usual = home => [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
export function findExecutable(name, { path = process.env.PATH ?? '', home = process.env.HOME ?? '' } = {}) {
  const dirs = [...new Set([...path.split(delimiter), ...(isAbsolute(home) ? usual(home) : [])])].filter(isAbsolute);
  for (const dir of isAbsolute(name) ? [''] : dirs) {
    const candidate = dir ? join(dir, name) : name;
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* not here */ }
  }
  return null;
}
// What Home shows for every harness that is not one of the executing two. States are separate facts, never folded into "ready":
// runtime (found / not_found / not_applicable), sign-in and models (unknown: nothing is probed), execution (not_qualified + reason).
export function harnessStatuses({ find = findExecutable, platform = process.platform, root = null } = {}) {
  const settings = root ? readHarnessSettings(root) : null;
  return harnesses.filter(h => !h.executes).map(h => {
    const found = h.executable ? find(h.executable) : null, supported = !!h.boundary?.includes(platform);
    return { id: h.id, label: h.label, transport: h.transport,
      runtime: h.executable ? (found ? 'found' : 'not_found') : 'not_applicable', ...(h.executable ? { executable: h.executable } : {}),
      ...(h.minimumVersion ? { minimumVersion: h.minimumVersion } : {}), ...(h.auth ? { auth: h.auth } : {}),
      signIn: 'unknown', catalog: 'unknown', execution: supported ? 'qualified_here' : 'not_qualified', reason: supported ? h.reasonWhereSupported : h.reason,
      ...(supported ? { enabled: settings?.[h.id]?.enabled === true, canEnable: !!found } : {}) };
  });
}
// The persisted choice to run a harness in new chats (Home's Enable), in the connection store Bridge reads. Only a harness whose boundary is
// supported on this platform can be enabled, and only with a runtime that is found; the resolved path is stored, never a name from PATH later.
export const harnessSettingsFile = 'harnesses.json';
export function readHarnessSettings(root) {
  try {
    const v = JSON.parse(readFileSync(join(root, harnessSettingsFile), 'utf8'));
    if (v?.version !== 1 || !Number.isSafeInteger(v.revision)) return { version: 1, revision: 0 };
    const out = { version: 1, revision: v.revision };
    for (const h of harnesses) { const e = v[h.id]; if (e && typeof e.enabled === 'boolean' && (!e.enabled || isAbsolute(e.executable ?? ''))) out[h.id] = { enabled: e.enabled, ...(e.enabled ? { executable: e.executable } : {}) }; }
    return out;
  } catch { return { version: 1, revision: 0 }; }
}
export function setHarnessEnabled(root, id, enabled, { expectedRevision, find = findExecutable, platform = process.platform } = {}) {
  const h = harness(id); if (!h || h.executes || typeof enabled !== 'boolean') throw Object.assign(new Error('Unknown harness'), { code: 'invalid_request' });
  if (enabled && !h.boundary?.includes(platform)) throw Object.assign(new Error(`${h.label} cannot run on this system yet`), { code: 'harness_not_qualified' });
  const current = readHarnessSettings(root);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw Object.assign(new Error('stale'), { code: 'stale_revision' });
  const found = enabled ? find(h.executable) : null;
  if (enabled && !found) throw Object.assign(new Error(`${h.label} is not installed`), { code: 'harness_runtime_not_found' });
  const next = { ...current, revision: current.revision + 1, [id]: enabled ? { enabled: true, executable: realpathSync(found) } : { enabled: false } };
  const path = join(root, harnessSettingsFile), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); renameSync(temp, path);
  return next;
}
// Any model ID in the harness namespace, well formed or not: it never names a Codex or Claude model, so it is never passed on.
export const isHarnessModel = id => typeof id === 'string' && id.toLowerCase().startsWith(harnessPrefix);
// The refusal for a harness route that reached execution anyway (a pasted or stale model ID): explicit, before anything is created.
export function harnessRefusal(route) {
  const h = harness(route.harness);
  return Object.assign(new Error(`${h ? h.label : 'This harness'} is not available in Model Bridge yet, so nothing was sent. ${h?.reason ?? ''}`.trim()), { code: 'harness_not_qualified' });
}

// Prepared launch for Antigravity's official ACP server (`agy acp`, flags verified on 1.5.13). Nothing calls it: Antigravity is not qualified
// (docs/antigravity-qualification.md). The Google-account route (oauth-personal) runs with auto-update off and file credential storage, and every
// ambient Gemini/Google/ADC/agy and other provider variable is removed, so a parent shell can never switch it to API-key or Agent Platform billing.
// It does NOT isolate the profile: on 1.5.13 the login and state live under $HOME/.gemini whatever GEMINI_HOME says (an own profile would need
// --gemini-dir and its own sign-in). Only the server log is moved, into `logDir`. `--sandbox` is not passed: it can silently do nothing.
const inherited = /^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|VERTEX|ANTIGRAVITY_|AGY_|OPENAI_|ANTHROPIC_|CODEX_|BRIDGE_|CLAUDE_CODE_)/;
export function antigravityLaunch({ executable, logDir, env = process.env }) {
  if (!isAbsolute(executable ?? '') || !isAbsolute(logDir ?? '')) throw Object.assign(new Error('Antigravity needs an absolute executable and log directory'), { code: 'route_invalid' });
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !inherited.test(key)));
  return { command: executable, args: ['acp', '--process-per-session', '--disable-telemetry', '--include-default-customizations=false', '--log-file', join(logDir, 'acp-server.log')], authMethod: 'oauth-personal',
    env: { ...kept, AGY_CLI_DISABLE_AUTO_UPDATE: '1', AGY_ACP_FORCE_FILE_STORAGE: '1' } };
}
