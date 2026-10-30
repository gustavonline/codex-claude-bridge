// Model Bridge Home: a plugin-owned, on-demand MCP stdio server with one
// read-only tool and its MCP Apps view. Dependency-free so it runs from the
// plugin directory. Protocol goes to stdout only; nothing is logged.
// A fact is shown as done only when it was observed for this request.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const homeResource = 'ui://codex-claude/home.html';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pluginVersion = (() => {
  try { return JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
})();

// Fixed locations written by this plugin's installer and setup (see
// install.command and the CLI settings). No other files are read. A missing
// settings file means the default state; unreadable settings or a saved state
// that is not an absolute path leave the state unknown (null).
export function locations(home = homedir()) {
  const runtime = join(home, '.local/share/codex-claude-bridge/node_modules/codex-claude-bridge-local');
  const fallback = join(home, 'Library/Application Support/Codex Claude Bridge');
  const path = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0') ? value : null;
  let saved;
  try { saved = JSON.parse(readFileSync(join(home, '.config/codex-claude-bridge/settings.json'), 'utf8')); }
  catch (error) { return { runtime, state: error.code === 'ENOENT' ? fallback : null, app: null }; }
  if (!isObject(saved)) return { runtime, state: null, app: null };
  // The app selected at setup; without it no process can be tied to the main app.
  return { runtime, state: path(saved.state ?? fallback), app: path(saved.app) };
}

// Unix seconds that format as an ordinary date (years 1970-9999).
const usableTime = value => Number.isSafeInteger(value) && value > 0 && value <= 253402300799;

// Only this process's ancestors, nearest first, as { pid, command }; one ps call each.
export function ancestors(pid = process.pid) {
  const chain = [], seen = new Set();
  for (let current = pid; current > 1 && !seen.has(current);) {
    seen.add(current);
    const result = spawnSync('ps', ['-ww', '-o', 'ppid=,command=', '-p', String(current)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } });
    const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout ?? '');
    if (result.status !== 0 || !match) throw new Error('Process information unavailable');
    if (current !== pid) chain.push({ pid: current, command: match[2] });
    current = Number(match[1]);
  }
  return chain;
}

// When this process started, in Unix ms, from the public `ps` start time; null if unknown.
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function processStart(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } });
  const match = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s*$/.exec(result.stdout ?? '');
  if (result.status !== 0 || !match || !months.includes(match[1])) return null;
  return new Date(+match[6], months.indexOf(match[1]), +match[2], +match[3], +match[4], +match[5]).getTime();
}

// The main-app launcher's Bridge publishes <pid>-<runId>.json in
// <state>/primary/runtime with its own start time. Only a record whose PID,
// run ID and start time match the running process counts, so a stale record
// or a reused PID does not.
function primaryRecord(state, pid, started) {
  if (!state || !Number.isSafeInteger(pid)) return false;
  const directory = join(state, 'primary/runtime');
  let names;
  try { names = readdirSync(directory); } catch { return false; }
  return names.some(name => {
    const match = /^(\d+)-([\da-f-]{36})\.json$/.exec(name);
    if (!match || Number(match[1]) !== pid) return false;
    try {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const actual = started(pid);
      return record?.pid === pid && record.runId === match[2] && Number.isFinite(record.startedAt)
        && actual !== null && Math.abs(record.startedAt - actual) <= 3000;
    } catch { return false; }
  });
}

function payload(runtime) {
  try {
    const { name, version } = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
    if (name !== 'codex-claude-bridge-local' || typeof version !== 'string') throw new Error('Not the Bridge runtime');
    return { state: 'observed', detail: `Bridge runtime ${version} is installed.` };
  } catch (error) {
    return error.code === 'ENOENT' ? { state: 'not-observed', detail: 'The Bridge runtime is not installed.' }
      : { state: 'unknown', detail: 'The installed Bridge runtime could not be read.' };
  }
}

// Only this request's own process chain counts, and only the installed
// runtime's exact bridge.mjs. It counts as active in this main app only when it
// sits above this Codex app-server, its parent is the selected app's own
// executable without a separate profile, and its current record is under the
// main-app launcher's state. A similarly named process, a shell or other
// parent, the separate test window or a stale record never counts.
function activation({ chain, runtime, state, app, started }) {
  let entries;
  try { entries = chain().map(entry => typeof entry === 'string' ? { pid: null, command: entry } : entry); }
  catch { return { state: 'unknown', detail: "This app's processes could not be inspected." }; }
  const bridge = join(runtime, 'bridge.mjs');
  const bridgeIndex = entries.findIndex(({ command }) => command.includes(`${bridge} `) || command.endsWith(bridge));
  const serverIndex = entries.findIndex(({ command }) => /(?:^|\/)codex(?:\s.*)?\sapp-server(?:\s|$)/.test(command));
  if (serverIndex < 0 && bridgeIndex < 0) return { state: 'unknown', detail: 'Not running inside a Codex app.' };
  if (bridgeIndex < 0) return { state: 'not-observed', detail: 'Claude was not found in this Codex app.' };
  const desktop = entries[bridgeIndex + 1]?.command;
  if (state && desktop?.includes(`--user-data-dir=${join(state, 'desktop')}`))
    return { state: 'other-profile', detail: 'This is the separate test window, not the main Codex app.' };
  if (app && desktop?.startsWith(`${app}/Contents/MacOS/`) && !desktop.includes('--user-data-dir=')
    && serverIndex >= 0 && serverIndex < bridgeIndex && primaryRecord(state, entries[bridgeIndex].pid, started))
    return { state: 'observed', detail: 'The Claude Bridge is running in this Codex app for this session.' };
  return { state: 'unknown', detail: 'The Bridge is running here, but that this is the main Codex app could not be confirmed.' };
}

// Conversation-level evidence only, from the Bridge's own records (status and
// time, never content). Those records come from the separate test window.
function evidence(state) {
  if (!state) return { state: 'unknown', detail: 'The Bridge settings could not be read.' };
  let latest = 0, names;
  try { names = readdirSync(join(state, 'threads')).filter(name => /^[\da-f-]{36}\.json$/.test(name)); }
  catch { return { state: 'unknown', detail: 'No Claude conversation has been recorded.' }; }
  for (const name of names) {
    try {
      for (const turn of JSON.parse(readFileSync(join(state, 'threads', name), 'utf8')).turns ?? [])
        if (turn?.provider === 'claude' && turn.status === 'completed' && usableTime(turn.completedAt)) latest = Math.max(latest, turn.completedAt);
    } catch {}
  }
  if (!latest) return { state: 'unknown', detail: 'No completed Claude conversation has been recorded.' };
  return { state: 'other-profile', at: latest,
    detail: `A Claude conversation turn completed ${new Date(latest * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC in the separate test window. This does not show Claude working in this app, and file, browser and page actions are not checked.` };
}

// Only that this request reached Home over an initialized MCP connection;
// it says nothing about the Bridge, Claude or which app is the client.
const connection = connected => connected
  ? { state: 'observed', detail: "This view was requested over the plugin's MCP connection." }
  : { state: 'unknown', detail: "Not requested over the plugin's MCP connection." };

// Each fact fails on its own, to a fixed message without paths or errors.
const unreadable = { state: 'unknown', detail: 'This could not be checked.' };
const contained = observe => { try { return observe(); } catch { return unreadable; } };

export function observeHome({ home, chain = ancestors, connected = false, started = processStart } = {}) {
  let place;
  try { place = locations(home ?? homedir()); } catch { place = null; }
  const facts = {
    payload: place ? contained(() => payload(place.runtime)) : unreadable,
    connection: connection(connected),
    activation: place ? contained(() => activation({ chain, started, ...place })) : unreadable,
    evidence: place ? contained(() => evidence(place.state)) : unreadable,
  };
  const next = facts.payload.state === 'not-observed' ? 'Install the Bridge: ask Codex to “Install and start Claude in Codex”.'
    : facts.payload.state !== 'observed' ? 'Ask Codex to “Check my Codex + Claude installation.”'
    : facts.activation.detail === 'Not running inside a Codex app.' ? 'Open this view from a chat in the Codex app.'
    : facts.activation.state === 'other-profile' ? 'Open this view from the main Codex app to check it there.'
    : facts.activation.state === 'observed' ? 'Choose a Claude model in the model picker.'
    : 'To add Claude here, quit Codex once its chats are idle, then open it with “Codex + Claude (main app)”.';
  return { pluginVersion, observedAt: new Date().toISOString(), facts, next };
}

const labels = { payload: 'Installed', connection: 'Plugin connection', activation: 'This Codex app', evidence: 'Last Claude evidence' };
const marks = { observed: '✓', 'not-observed': '✗', 'other-profile': '–', unknown: '?' };
export const homeText = home => [...Object.entries(home.facts).map(([key, fact]) => `${marks[fact.state]} ${labels[key]}: ${fact.detail}`), `Next: ${home.next}`].join('\n');

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function homeHtml(home) {
  const rows = Object.entries(home.facts).map(([key, fact]) =>
    `<li class="${fact.state}"><span aria-hidden="true">${marks[fact.state]}</span><b>${escape(labels[key])}:</b> ${escape(fact.detail)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Model Bridge</title><style>
body{font:14px system-ui,sans-serif;margin:16px;color:#1f2328;background:transparent}h1{font-size:16px;margin:0 0 4px}
p{margin:4px 0}ul{list-style:none;padding:0;margin:12px 0}li{margin:6px 0}li span{display:inline-block;width:1.4em;font-weight:700}
li.observed span{color:#1a7f37}li.not-observed span{color:#b42318}li.other-profile span,li.unknown span{color:#6b7280}
.next{font-weight:600}ol{padding-left:20px;color:#57606a}small{color:#6b7280}
@media(prefers-color-scheme:dark){body{color:#e6edf3}ol,small{color:#9da7b3}}</style></head><body>
<h1>Model Bridge</h1><p>Claude models in Codex, run by your installed Claude Code.</p>
<ul>${rows}</ul><p class="next">Next: ${escape(home.next)}</p>
<details><summary>Setup</summary><ol><li>Install the Bridge runtime (ask Codex to “Install and start Claude in Codex”).</li>
<li>Sign in to Claude Code with your Claude subscription.</li><li>When Codex is idle, quit it and open “Codex + Claude (main app)”. Opening Codex normally keeps GPT only.</li>
<li>Check this view again.</li></ol></details>
<small>Green means observed for this request (${escape(home.observedAt)}). Plugin ${escape(home.pluginVersion)}.</small>
</body></html>`;
}

// Minimal MCP over newline-delimited JSON-RPC on stdio.
const tool = { name: 'bridge_home', title: 'Model Bridge Home',
  description: 'Show what Model Bridge observed: whether its runtime is installed, this plugin connection, and whether Claude is confirmed in this Codex app, with one next step. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: homeResource } } };

// MCP versions whose tool fields used here (title, structuredContent) exist;
// a client asking for another version is offered the newest.
export const protocolVersions = ['2025-11-25', '2025-06-18'];
const validId = id => typeof id === 'string' || Number.isSafeInteger(id);
// Request and notification params: absent, or an object whose optional _meta is an object.
const validParams = params => params === undefined || (isObject(params) && (params._meta === undefined || isObject(params._meta)));
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// One stdio connection. It counts as connected only after a valid initialize
// was answered and the client confirmed it with notifications/initialized.
export function session(observe = observeHome) {
  let phase = 'new';
  const render = format => { try { return format(observe({ connected: phase === 'connected' })); } catch { return null; } };
  return message => {
    if (!isObject(message)) return failure(null, -32600, 'Invalid request');
    const { id, method, params } = message;
    if (!('id' in message)) { // Notifications need no reply.
      if (message.jsonrpc === '2.0' && method === 'notifications/initialized' && validParams(params) && phase === 'initializing') phase = 'connected';
      return null;
    }
    if (method === undefined && ('result' in message || 'error' in message)) return null; // This server sends no requests.
    if (!validId(id) || message.jsonrpc !== '2.0' || typeof method !== 'string' || !validParams(params))
      return failure(validId(id) ? id : null, -32600, 'Invalid request');
    const reply = result => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      if (phase !== 'new') return failure(id, -32600, 'Already initialized');
      // The required fields of the MCP initialize parameters and its clientInfo.
      if (typeof params?.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo)
        || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') return failure(id, -32602, 'Invalid initialize parameters');
      phase = 'initializing';
      return reply({ protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0],
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'model-bridge-home', version: pluginVersion } });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [tool] });
    if (method === 'tools/call') {
      if (params?.name !== tool.name) return failure(id, -32602, 'Unknown tool');
      const result = render(home => ({ content: [{ type: 'text', text: homeText(home) }], structuredContent: home }));
      return result ? reply(result) : failure(id, -32603, 'Home could not be observed');
    }
    if (method === 'resources/list') return reply({ resources: [{ uri: homeResource, name: 'Model Bridge Home', mimeType: 'text/html;profile=mcp-app' }] });
    if (method === 'resources/read') {
      if (params?.uri !== homeResource) return failure(id, -32602, 'Unknown resource');
      const text = render(homeHtml);
      return text ? reply({ contents: [{ uri: homeResource, mimeType: 'text/html;profile=mcp-app', text }] }) : failure(id, -32603, 'Home could not be observed');
    }
    return failure(id, -32601, 'Method not found');
  };
}

// The plugin cache may reach this file through a symlink.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const handle = session();
  createInterface({ input: process.stdin }).on('line', line => {
    let message, response;
    try { message = JSON.parse(line); } catch { response = failure(null, -32700, 'Parse error'); }
    if (!response) try { response = handle(message); } catch { response = failure(validId(message?.id) ? message.id : null, -32603, 'Internal error'); }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
}
