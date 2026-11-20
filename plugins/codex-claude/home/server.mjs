// Model Bridge Home: a plugin-owned, on-demand MCP stdio server with one
// read-only default tool and its MCP Apps view. Dependency-free so it runs from the
// plugin directory. Protocol goes to stdout only; nothing is logged.
//
// Scope: this process is started by Codex with no verified binding to a Codex
// profile, so it reads no Bridge installation, settings, process list or chat
// history. It reports only what this request itself proves (it arrived over an
// initialized MCP connection); everything else is UNKNOWN with a fixed reason.
// The view (below) separately reports its own MCP Apps host handshake.
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// The URI changes with any change to the served HTML/JS: hosts may cache by URI.
export const homeResource = 'ui://codex-claude/home-v11.html';
export const appMimeType = 'text/html;profile=mcp-app';
// No network, frame or resource origins: the view loads and connects to nothing.
// `openai/ui` is OpenAI's documented extension metadata (mcp-extensions spec): the
// modes this view can be shown in, and inline for an ordinary tool call. The
// standard `ui` layer stays complete without it, so a host that ignores it still works.
const uiMeta = { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true },
  'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' } };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pluginVersion = (() => {
  try { return JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
})();

// Only that this request reached Home over an initialized MCP connection;
// it says nothing about the Bridge, Claude or which app is the client.
const connection = connected => connected
  ? { state: 'observed', detail: "This view was requested over the plugin's MCP connection." }
  : { state: 'unknown', detail: "Not requested over the plugin's MCP connection." };

export function observeHome({ connected = false } = {}) {
  const facts = {
    payload: { state: 'unknown', detail: 'Not checked: this view cannot tell which Codex profile it runs in, so it reads no Bridge installation.' },
    connection: connection(connected),
    activation: { state: 'unknown', detail: 'Not checked: this view does not confirm Claude in this Codex app.' },
    evidence: { state: 'unknown', detail: 'Not checked: this view reads no conversation history.' },
  };
  const next = 'This view cannot tell which Codex profile it runs in. Establish the intended profile first; Bridge diagnostics apply only to the profile they are run for.';
  return { pluginVersion, observedAt: new Date().toISOString(), facts, next };
}

const labels = { payload: 'Installed', connection: 'Plugin connection', activation: 'This Codex app', evidence: 'Last Claude evidence' };
const marks = { observed: '✓', 'not-observed': '✗', 'other-profile': '–', unknown: '?' };
export const homeText = home => [...Object.entries(home.facts).map(([key, fact]) => `${marks[fact.state]} ${labels[key]}: ${fact.detail}`), `Next: ${home.next}`].join('\n');

// The view's whole behaviour, served verbatim and executed by the tests. It
// speaks the public MCP Apps (SEP-1865, spec 2026-01-26) JSON-RPC over
// postMessage to its parent frame: ui/initialize -> reply ->
// ui/notifications/initialized, then host notifications tool-result,
// tool-cancelled and host-context-changed (tool-input carries nothing this
// view shows, so it is ignored), the ping and ui/resource-teardown requests,
// and a size-changed notification. Messages count only from window.parent.
// Every host value is untrusted: it is validated and shown as text
// (textContent), never as markup. A declared synthetic scope may use tools/call
// when the host advertises serverTools; there is no fetch,
// navigation, storage or file access, no display-mode request, and it reads no
// host product name. Size is reported from the content's own box (never the
// viewport height), only when it changed, and only while the handshake is complete.
// Keep this free of backslashes, backticks and the character pair that closes a script element.
const appScript = `'use strict';
var VERSION = ${JSON.stringify(pluginVersion).replace(/</g, '\\u003c')};
var SUPPORTED = ['2026-01-26'];
var MODES = ['inline', 'fullscreen', 'pip'];
var TIMEOUT_MS = 8000;
var STATES = ['observed', 'not-observed', 'other-profile', 'unknown'];
var FACTS = [['payload', 'Installed'], ['connection', 'Plugin connection'], ['activation', 'This Codex app'], ['evidence', 'Last Claude evidence']];
var MARKS = { 'observed': '✓', 'not-observed': '✗', 'other-profile': '–', 'unknown': '?' };
var HANDSHAKE = {
  connecting: 'Host: waiting for the host to answer initialization.',
  connected: 'Host: initialization completed (MCP Apps protocol ' + SUPPORTED[0] + ').',
  timeout: 'Host: no answer to initialization within ' + (TIMEOUT_MS / 1000) + ' s; still waiting for a late answer.',
  denied: 'Host: refused initialization.',
  invalid: 'Host: answered initialization in a form this view does not understand.',
  unsupported: 'Host: uses an MCP Apps protocol version this view does not support.',
  closed: 'Host: closed this view.',
  nohost: 'Host: this page is not running inside an MCP Apps host.'
};
var DATA = {
  waiting: 'Result: none received yet.',
  received: 'Result: received from the host. This shows data arrived, not that this panel is visible on screen.',
  unusable: 'Result: received but not in the expected form, so nothing is shown.',
  error: 'Result: the tool call reported an error.',
  cancelled: 'Result: the host cancelled the tool call.',
  uncertain: 'Result: action outcome unknown; explicitly read current test state.'
};
var HOST_ALERT = {
  connecting: 'Connecting to the host…',
  timeout: 'The host has not answered initialization yet.',
  denied: 'The host refused initialization.',
  invalid: 'The host answered initialization in a form this view does not understand.',
  unsupported: 'The host uses an MCP Apps protocol version this view does not support.',
  closed: 'The host closed this view.',
  nohost: 'This page is not running inside an MCP Apps host.'
};
var DATA_ALERT = {
  waiting: 'Waiting for the host to send the result.',
  received: '',
  unusable: 'The result could not be read, so nothing is shown.',
  error: 'The tool call reported an error.',
  cancelled: 'The host cancelled the tool call.',
  uncertain: 'Action outcome unknown. Read current test state before more changes.'
};
var host = window.parent;
var view = { handshake: 'connecting', replied: false, data: 'waiting', home: null, fault: false, hostName: null, protocol: null, mode: null, modes: null, observer: null, size: '' };
var nextId = 1, initId = null, timer = null;
var linksAvailable = false, linkRequest = null, linkTimer = null;
var toolsAvailable = false, pendingControl = null, controlTimer = null, controlNotice = '', uncertain = false;
// Recovery context is not a displayed fact or authentication. Only a
// correlated status reply may clear uncertainty after an action is interrupted.
var recoveryScope = null, selectionDraft = null, recoveryNotice = '';
var providerDraft = { name: '', baseUrl: '', authRef: '', providerId: '', model: '', search: '', open: false, settings: false, detail: false, filter: 'all', availability: 'all', libraryView: 'all' };
var stateTimer = null, stateRequest = null, stateTimeout = null, stateReadFailed = false, firstStateRead = true;
var filterOpen = false, defaultOpen = false, popoverNodes = [], savedUntil = 0, savedTimer = null;
var slotDisclosure = null, slotsDraft = null, focusNodes = {}, focusAfterRender = null, loadTimer = null, homeRequest = null;
var isObject = function (value) { return value !== null && typeof value === 'object' && !Array.isArray(value); };
var validId = function (id) { return typeof id === 'string' || (typeof id === 'number' && isFinite(id) && Math.floor(id) === id); };
var send = function (message) { host.postMessage(message, '*'); };
function node(tag, value, className) {
  var element = document.createElement(tag);
  if (value !== undefined) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
// Written without a backslash escape: this source sits inside a template literal and
// an escape for a control character would reach the HTML parser as an actual NUL.
function hasControl(text) {
  for (var i = 0; i < text.length; i++) { var code = text.charCodeAt(i); if (code < 32 || code === 127) return true; }
  return false;
}
function limited(value, max) { return typeof value === 'string' ? value.slice(0, max) : null; }
// The structured Home result, reduced to known fields; anything missing or
// malformed stays unknown, never green.
function parseHome(value) {
  if (!isObject(value) || !isObject(value.facts)) return null;
  var next = limited(value.next, 300);
  if (next === null) return null;
  var facts = {};
  FACTS.forEach(function (entry) {
    var fact = value.facts[entry[0]];
    var detail = isObject(fact) ? limited(fact.detail, 400) : null;
    facts[entry[0]] = detail !== null && STATES.indexOf(fact.state) >= 0 ? { state: fact.state, detail: detail } : { state: 'unknown', detail: 'Not reported in a form this view understands.' };
  });
  return { facts: facts, next: next, observedAt: limited(value.observedAt, 40) || 'unknown time', pluginVersion: limited(value.pluginVersion, 40) || 'unknown', controls: parseControls(value.controls), bindingError: limited(value.bindingError, 160) };
}
function parseControls(value) {
  if (isObject(value) && value.kind === 'responses-trial') return parseProviders(value);
  if (!isObject(value) || value.kind !== 'synthetic' || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.enabled !== 'boolean') return null;
  var valid = function (id) { return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id); };
  if (!valid(value.bindingId) || !valid(value.profileId) || !valid(value.bridgeId) || ['unknown', 'fresh', 'stale'].indexOf(value.catalogState) < 0) return null;
  if (!Array.isArray(value.models) || value.models.length > 64 || !(value.visible === null || Array.isArray(value.visible))) return null;
  var seen = [], models = [];
  for (var i = 0; i < value.models.length; i++) {
    var model = value.models[i];
    if (!isObject(model) || typeof model.id !== 'string' || !model.id || model.id.length > 100 || typeof model.name !== 'string' || model.name.length > 200 || seen.indexOf(model.id) >= 0) return null;
    seen.push(model.id); models.push({ id: model.id, name: model.name });
  }
  if (value.visible !== null && (value.visible.length > 64 || value.visible.some(function (id, i) { return typeof id !== 'string' || !id || id.length > 100 || value.visible.indexOf(id) !== i; }))) return null;
  return { kind: 'synthetic', bindingId: value.bindingId, profileId: value.profileId, bridgeId: value.bridgeId, revision: value.revision, enabled: value.enabled,
    catalogState: value.catalogState, models: models, visible: value.visible };
}
function parseProviders(value) {
  var valid = function (id) { return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id); };
  if (!valid(value.bindingId) || !valid(value.profileId) || !valid(value.bridgeId) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.providers) || value.providers.length > 18 || !Array.isArray(value.authReferences) || value.authReferences.length > 32
    || !isObject(value.slots) || !Number.isSafeInteger(value.slots.revision) || value.slots.revision < 0
    || !(value.slots.models === null || Array.isArray(value.slots.models) && value.slots.models.length <= 4096)) return null;
  if (value.slots.models !== null && value.slots.models.some(function (m, i, all) { return typeof m !== 'string' || m.length > 800 || all.indexOf(m) !== i; })) return null;
  var seen = [];
  for (var p of value.providers) {
    if (!isObject(p) || !valid(p.id) || seen.indexOf(p.id) >= 0 || typeof p.name !== 'string' || p.name.length > 80 || typeof p.baseUrl !== 'string' || p.baseUrl.length > 2048
      || ['responses', 'native', 'claude'].indexOf(p.protocol) < 0 || typeof p.enabled !== 'boolean' || ['unknown', 'fresh', 'stale'].indexOf(p.catalogState) < 0
      || !(p.selected === null || typeof p.selected === 'string' && p.selected.length <= 800) || !Array.isArray(p.models) || p.models.length > 4096) return null;
    if (p.protocol !== 'responses' && (p.id !== (p.protocol === 'native' ? '00000000000000000000000000000001' : '00000000000000000000000000000002') || p.kind !== p.protocol || p.baseUrl !== '')) return null;
    if (p.protocol === 'responses' && (p.id === '00000000000000000000000000000001' || p.id === '00000000000000000000000000000002' || p.models.length > 1024)) return null;
    var models = [];
    for (var m of p.models) {
      if (!isObject(m) || typeof m.id !== 'string' || !m.id || m.id.length > 800 || models.indexOf(m.id) >= 0 || typeof m.name !== 'string' || m.name.length > 512 || !validCapabilities(m.capabilities)) return null;
      models.push(m.id);
    }
    seen.push(p.id);
  }
  for (var ref of value.authReferences) if (!isObject(ref) || typeof ref.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ref.id) || typeof ref.baseUrl !== 'string' || ref.baseUrl.length > 2048) return null;
  // Other harnesses are status facts only (never a model, never an action): bounded strings and closed state values.
  if (value.harnesses !== undefined && (!Array.isArray(value.harnesses) || value.harnesses.length > 16 || value.harnesses.some(function (h) {
    return !isObject(h) || !/^[a-z][a-z0-9-]{1,31}$/.test(h.id) || typeof h.label !== 'string' || h.label.length > 60 || typeof h.reason !== 'string' || h.reason.length > 300
      || ['found', 'not_found', 'not_applicable'].indexOf(h.runtime) < 0 || ['not_qualified', 'qualified_here'].indexOf(h.execution) < 0 || (h.execution === 'qualified_here' && (h.id !== 'antigravity' || typeof h.enabled !== 'boolean' || typeof h.canEnable !== 'boolean')) || h.signIn !== 'unknown' || h.catalog !== 'unknown' || !(h.minimumVersion === undefined || /^[0-9]{1,4}([.][0-9]{1,4}){0,3}$/.test(h.minimumVersion)) || !(h.executable === undefined || /^[A-Za-z0-9_.-]{1,40}$/.test(h.executable));
  }))) return null;
  if (value.slots.scope !== undefined && (['all', 'custom'].indexOf(value.slots.scope) < 0 || !Number.isSafeInteger(value.slots.catalogRevision) || value.slots.catalogRevision < 0)) return null;
  if (value.auth !== undefined && (!isObject(value.auth) || ['idle', 'starting', 'waiting', 'exchanging', 'complete', 'failed', 'expired', 'cancelled'].indexOf(value.auth.phase) < 0 || typeof value.auth.storageAvailable !== 'boolean' || !(value.auth.authorizationUrl === null || validAuthUrl(value.auth.authorizationUrl)))) return null;
  return value;
}
// Reasoning capabilities are advertised data, untrusted and bounded: at most 16 listed
// levels, each a short string. Anything else makes the whole result unusable (never partly shown).
function validCapabilities(value) {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  var levels = value.supportedReasoningEfforts, fallback = value.defaultReasoningEffort;
  if (levels !== undefined && (!Array.isArray(levels) || levels.length > 16 || levels.some(function (e) { return !isObject(e) || typeof e.reasoningEffort !== 'string' || e.reasoningEffort.length > 32; }))) return false;
  return fallback === undefined || fallback === null || (typeof fallback === 'string' && fallback.length <= 32);
}
function validAuthUrl(value) {
  try {
    var url = new URL(value);
    var callback = new URL(url.searchParams.get('callback_url'));
    return url.origin === 'https://openrouter.ai' && url.pathname === '/auth' && !url.hash && !url.username && !url.password && value.length < 2048
      && callback.protocol === 'http:' && callback.hostname === '127.0.0.1' && !!callback.port && callback.pathname === '/callback' && !callback.search && !callback.hash && !callback.username && !callback.password
      && url.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge')) && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state'))
      && Array.from(url.searchParams.keys()).length === 4 && new Set(url.searchParams.keys()).size === 4;
  } catch (ignored) { return false; }
}
function clearLink() { clearTimeout(linkTimer); linkTimer = null; linkRequest = null; }
function openAuth(url) {
  if (!linksAvailable || !validAuthUrl(url) || linkRequest || view.handshake !== 'connected') return;
  linkRequest = nextId++;
  send({ jsonrpc: '2.0', id: linkRequest, method: 'ui/open-link', params: { url: url } });
  linkTimer = setTimeout(function () { clearLink(); controlNotice = 'Browser opening outcome unknown. Open it explicitly again, or cancel sign-in.'; render(); }, TIMEOUT_MS);
  render();
}
function readableError(code) {
  var providerErrors = { endpoint_invalid: 'Use an HTTPS endpoint, or a loopback HTTP endpoint with an explicit port.', provider_invalid: 'Enter a connection name and a valid endpoint.', provider_exists: 'This connection is already saved. Select it in settings.', credential_endpoint_mismatch: 'Choose an authentication reference for this exact endpoint.', secret_storage_unavailable: 'Secret storage is unavailable. Check the startup helper.', catalog_failed: 'The catalog request failed. Check the endpoint, then refresh.', free_model_required: 'Choose a catalog-advertised free model.', auth_expired: 'Sign-in expired. Try again.', auth_cancelled: 'Sign-in cancelled.' };
  if (providerErrors[code]) return providerErrors[code];
  return ({ catalog_auth_required: 'The provider refused catalog access. Check its saved sign-in.', catalog_rate_limited: 'The provider rate-limited this catalog request.', catalog_unreachable: 'The endpoint could not be reached.', catalog_protocol_unsupported: 'The endpoint did not return a supported model catalog.', auth_denied: 'Browser authorization was refused.', auth_rate_limited: 'Authorization was rate-limited.', auth_unreachable: 'The authorization service could not be reached.', auth_timeout: 'Authorization timed out.', stale_revision: 'Connection state changed; read current state before trying again.', harness_not_qualified: 'This runtime cannot run on this system yet.', harness_runtime_not_found: 'This runtime is not installed. Install it, then try again.' })[code] || 'The action could not be completed. Read current state before trying again.';
}
function sameScope(a, b) { return a && b && a.bindingId === b.bindingId && a.profileId === b.profileId && a.bridgeId === b.bridgeId; }
function scopeOf(c) { return c ? { kind: c.kind, bindingId: c.bindingId, profileId: c.profileId, bridgeId: c.bridgeId, revision: c.revision } : null; }
function clearStateRead() {
  clearTimeout(stateTimer); clearTimeout(stateTimeout); stateTimer = null; stateTimeout = null; stateRequest = null;
}
// Read only the verified declared scope. A mutation supersedes an outstanding
// read; late replies cannot roll its state back. Never replay an uncertain write.
function readState() {
  var c = view.home && view.home.controls || recoveryScope;
  if (!c || c.kind !== 'responses-trial' || !toolsAvailable || view.handshake !== 'connected' || pendingControl || stateRequest) return;
  clearStateRead(); stateReadFailed = false;
  stateRequest = { id: nextId++, scope: scopeOf(c) };
  send({ jsonrpc: '2.0', id: stateRequest.id, method: 'tools/call', params: { name: 'bridge_provider_status', arguments: { bindingId: c.bindingId, profileId: c.profileId, bridgeId: c.bridgeId } } });
  stateTimeout = setTimeout(function () {
    var scope = stateRequest && stateRequest.scope; clearStateRead(); stateReadFailed = true;
    unknownControl(scope, 'State update unavailable. Retry to check saved changes.'); render();
  }, TIMEOUT_MS);
}
function scheduleStateRead() {
  var c = view.home && view.home.controls || recoveryScope;
  if (!c || c.kind !== 'responses-trial' || !toolsAvailable || view.handshake !== 'connected' || pendingControl || stateRequest || stateTimer !== null || stateReadFailed) return;
  var signingIn = c.auth && ['starting', 'waiting', 'exchanging'].indexOf(c.auth.phase) >= 0;
  var delay = document.hidden === true ? 10000 : firstStateRead || uncertain ? 0 : signingIn ? 1000 : 10000; firstStateRead = false;
  stateTimer = setTimeout(function () { stateTimer = null; if (document.hidden !== true) readState(); else scheduleStateRead(); }, delay);
}
function unknownControl(scope, notice) {
  clearLink();
  if (scope) recoveryScope = scopeOf(scope);
  uncertain = !!recoveryScope; view.home = null; selectionDraft = null; slotDisclosure = null;
  view.data = 'uncertain'; controlNotice = notice;
}
function controlCall(action, extra) {
  var c = view.home && view.home.controls || (uncertain && recoveryScope);
  if (!c || !toolsAvailable || view.handshake !== 'connected' || pendingControl || (uncertain && action !== 'status')) return;
  clearStateRead(); stateReadFailed = false; recoveryNotice = '';
  var args = { bindingId: c.bindingId, profileId: c.profileId, bridgeId: c.bridgeId };
  if (action !== 'status') args.revision = c.revision;
  Object.assign(args, extra || {});
  pendingControl = { id: nextId++, scope: c, action: action };
  controlNotice = c.kind === 'responses-trial' ? (action === 'status' ? 'Reading provider state…' : 'Applying to the declared provider registry…')
    : action === 'status' ? 'Reading test state…' : 'Applying to the declared test store…';
  send({ jsonrpc: '2.0', id: pendingControl.id, method: 'tools/call', params: { name: (c.kind === 'responses-trial' ? 'bridge_provider_' : 'bridge_connection_') + action, arguments: args } });
  controlTimer = setTimeout(function () {
    if (!pendingControl) return;
    var scope = pendingControl.scope; pendingControl = null;
    unknownControl(scope, 'No action result yet. Outcome unknown; read current state before more changes.');
    render();
  }, TIMEOUT_MS);
  render();
}
function renderControls() {
  var headerActions = document.getElementById('header-actions'); if (headerActions) headerActions.replaceChildren();
  var target = document.getElementById('controls'); target.replaceChildren();
  var c = view.home && view.home.controls;
  function button(label, action, blocked) {
    var b = node('button', label); b.type = 'button'; b.disabled = blocked;
    b.addEventListener('click', action); target.append(b); return b;
  }
  var readBlocked = !toolsAvailable || view.handshake !== 'connected' || !!pendingControl;
  if (!c) {
    if (uncertain && recoveryScope) {
      target.append(node('p', controlNotice, 'alert'));
      target.append(node('p', 'Only a status read of the last verified declared scope is available. Its current state is unknown.', 'muted'));
      button(recoveryScope.kind === 'responses-trial' ? 'Retry state update' : 'Read current state', function () { if (recoveryScope.kind === 'responses-trial') readState(); else controlCall('status'); }, readBlocked || !!stateRequest);
    } else {
      target.append(node('h2', view.home ? 'Connection setup is not available here' : 'Loading your connections…'));
      target.append(node('p', view.home ? 'This Home has no verified Bridge binding. Your providers and chats have not been read.' : 'Waiting for Model Bridge to return its current state.', 'empty'));
      button('Reload Home', loadHome, readBlocked || !!homeRequest || uncertain);
    }
    return;
  }
  if (c.kind === 'responses-trial') { renderProviders(target, c, readBlocked); return; }
  target.append(node('p', 'Synthetic test only — no login, native connection or model execution is verified.', 'muted'));
  target.append(node('p', 'Claude Code: ' + (c.enabled ? 'enabled for new test work' : 'disabled for new test work')));
  var disabled = readBlocked || uncertain;
  button(c.enabled ? 'Disable' : 'Enable', function () { controlCall('enabled', { enabled: !c.enabled }); }, disabled);
  button(c.catalogState === 'unknown' ? 'Discover models' : 'Refresh models', function () { controlCall('refresh'); }, disabled);
  button('Read current state', function () { controlCall('status'); }, readBlocked);
  target.append(node('p', 'Catalog: ' + (c.catalogState === 'unknown' ? 'not discovered' : c.catalogState + ' synthetic fixture data') + '. Native picker availability is unverified.', 'muted'));
  var choices = [];
  if (!selectionDraft || !sameScope(selectionDraft.scope, c) || selectionDraft.scope.revision !== c.revision) {
    selectionDraft = { scope: scopeOf(c), visible: c.models.filter(function (model) { return c.visible === null || c.visible.indexOf(model.id) >= 0; }).map(function (model) { return model.id; }) };
  }
  c.models.forEach(function (model) {
    var label = node('label'), box = node('input'); box.type = 'checkbox'; box.value = model.id;
    box.checked = selectionDraft.visible.indexOf(model.id) >= 0; box.disabled = disabled;
    box.addEventListener('change', function () {
      selectionDraft.visible = choices.filter(function (choice) { return choice.checked; }).map(function (choice) { return choice.value; });
    });
    choices.push(box); label.append(box, document.createTextNode(' ' + model.name)); target.append(label);
  });
  if (choices.length) {
    button('Save visible models', function () { controlCall('visible', { visible: choices.filter(function (box) { return box.checked; }).map(function (box) { return box.value; }) }); }, disabled);
    button('Show all models', function () { controlCall('visible', { visible: null }); }, disabled);
  }
  target.append(node('p', 'Disabling keeps chats and queues. Re-enabling does not replay paused work; explicitly start its queue.', 'muted'));
  if (!toolsAvailable) target.append(node('p', 'This host did not advertise server tool calls. Controls stay disabled.', 'alert'));
  if (controlNotice) target.append(node('p', controlNotice, 'muted'));
}
// Original line artwork in a 24 unit box, drawn with currentColor. A DOM without
// createElementNS yields null, and callers then use their plain-text fallback.
function svgIcon(paths) {
  if (!document.createElementNS) return null;
  try {
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    paths.forEach(function (d) { var drawing = document.createElementNS(ns, 'path'); drawing.setAttribute('d', d); svg.append(drawing); });
    return svg;
  } catch (ignored) { return null; }
}
function renderProviders(target, c, blocked) {
  function keyed(el, key) { el.setAttribute('data-focus-key', key); focusNodes[key] = el; return el; }
  function button(parent, label, action, key, unavailable, primary, aria) {
    var b = keyed(node('button', label, primary ? 'primary' : ''), key); b.type = 'button'; b.disabled = blocked || !!unavailable;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', action); parent.append(b); return b;
  }
  function field(parent, label, key, limit) {
    var row = node('label', label), input = keyed(node('input'), key); input.type = 'text'; input.value = providerDraft[key]; input.disabled = blocked;
    input.id = key; input.maxLength = limit; input.autocomplete = 'off'; row.setAttribute('for', key);
    input.addEventListener('input', function () { providerDraft[key] = input.value; }); row.append(input); parent.append(row); return input;
  }
  function select(parent, label, choices, value, key, onChange) {
    var row = node('label', label), input = keyed(node('select'), key); input.disabled = blocked; input.id = key; row.setAttribute('for', key);
    choices.forEach(function (choice) { var option = node('option', choice.label); option.value = choice.value; input.append(option); }); input.value = value;
    input.addEventListener('change', function () { onChange(input.value); }); row.append(input); parent.append(row); return input;
  }
  var known = [];
  c.providers.forEach(function (p) { p.models.forEach(function (m) { known.push({ id: m.id, name: m.name, provider: p, available: m.available, defaultVisible: m.defaultVisible, capabilities: m.capabilities }); }); });
  function available(m) { return m.available !== false && m.provider.enabled && m.provider.catalogState === 'fresh'; }
  var unified = c.slots.scope !== undefined;
  var effective = c.slots.models === null ? known.filter(available).filter(function (m) { return m.defaultVisible !== false; }).map(function (m) { return m.id; }) : c.slots.models.slice();
  if (unified && c.slots.scope === 'custom' && c.slots.models !== null) effective = known.filter(function (m) { return m.provider.protocol !== 'responses' && m.defaultVisible !== false && available(m); }).map(function (m) { return m.id; }).concat(effective);
  if (!slotsDraft || !sameScope(slotsDraft.scope, c)) {
    // A legacy (custom-only) curation shows built-in models that were never saved with it. Offering Save at once
    // adopts exactly what is shown as the one explicit selection, so later catalog additions cannot join silently.
    var adopt = unified && c.slots.scope === 'custom' && c.slots.models !== null;
    slotsDraft = { scope: scopeOf(c), revision: c.slots.revision, models: effective.slice(), dirty: adopt, adopt: adopt };
  }
  if (slotsDraft.dirty && !slotsDraft.adopt && JSON.stringify(slotsDraft.models) === JSON.stringify(effective)) slotsDraft.dirty = false;
  if (!slotsDraft.dirty) { slotsDraft.models = effective.slice(); slotsDraft.revision = c.slots.revision; }
  var conflict = slotsDraft.revision !== c.slots.revision;
  var grid = node('div', undefined, 'dashboard-grid'), connections = node('section', undefined, 'panel connections'), workspace = node('div', undefined, 'workspace');
  var navigation = node('div', undefined, 'dashboard-nav');

  var pageTitle = document.getElementById('page-title');
  function goModels() { providerDraft.settings = false; providerDraft.detail = false; slotDisclosure = null; defaultOpen = false; focusAfterRender = 'settings'; render(); }
  if (providerDraft.settings) {
    pageTitle.replaceChildren();
    button(pageTitle, 'Model Bridge', goModels, 'settings', false, false, 'Return to models').className = 'breadcrumb-link';
    pageTitle.append(node('span', '/', 'breadcrumb-separator'));
    if (providerDraft.detail) {
      button(pageTitle, 'Connections', function () { providerDraft.detail = false; focusAfterRender = 'provider-' + providerDraft.providerId; render(); }, 'connections-back').className = 'breadcrumb-link';
      pageTitle.append(node('span', '/', 'breadcrumb-separator'), node('span', (c.providers.find(function (p) { return p.id === providerDraft.providerId; }) || {}).name || 'Connection'));
    } else pageTitle.append(node('span', 'Connections'));
  } else {
    pageTitle.textContent = 'Model Bridge';
    var settingsToggle = button(navigation, '', function () { providerDraft.settings = true; providerDraft.detail = false; slotDisclosure = null; defaultOpen = false; focusAfterRender = 'settings'; render(); }, 'settings', false, false, 'Connections');
    settingsToggle.setAttribute('aria-expanded', 'false');
    // A discreet 16px line gear. A host without SVG support falls back to the plain text mark.
    var gear = svgIcon(['M10.3 3h3.4l.5 2.3 1.6.9 2.2-.8 1.7 2.9-1.7 1.6v1.8l1.7 1.6-1.7 2.9-2.2-.8-1.6.9-.5 2.3h-3.4l-.5-2.3-1.6-.9-2.2.8-1.7-2.9 1.7-1.6V10.9L4.3 9.3 6 6.4l2.2.8 1.6-.9Z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z']);
    if (gear) { gear.setAttribute('aria-hidden', 'true'); gear.setAttribute('class', 'gear-icon'); settingsToggle.append(gear); } else settingsToggle.textContent = '⚙';
  }
  Array.from(pageTitle.children).forEach(function (crumb, index, all) { if (crumb.className === 'breadcrumb-separator') crumb.setAttribute('aria-hidden', 'true'); else if (index === all.length - 1 && crumb.tag !== 'button') crumb.setAttribute('aria-current', 'page'); });
  var headerActions = document.getElementById('header-actions'); if (headerActions) headerActions.replaceChildren(navigation); else target.append(navigation);
  connections.setAttribute('aria-label', 'Connections');
  var connected = node('section', undefined, 'connection-group'), more = node('section', undefined, 'connection-group');
  connected.append(node('h2', 'Connected')); more.append(node('h2', 'Connect more'));
  var addRow = node('article', undefined, 'provider-card connect-row');
  var addText = node('div'); addText.append(node('h3', 'Compatible endpoint'), node('small', 'Any Responses-compatible server', 'muted')); addRow.append(addText);
  button(addRow, 'Add', function () { providerDraft.open = true; providerDraft.detail = false; focusAfterRender = 'name'; render(); }, 'add-connection', false, false, 'Add connection'); more.append(addRow);
  if (c.auth && !providerDraft.detail) {
    var signIn = node('section', undefined, 'provider-card'); signIn.append(node('h3', 'OpenRouter'));
    var phase = c.auth.phase;
    var connectedRouter = c.providers.find(function (p) { return p.baseUrl === 'https://openrouter.ai/api/v1' && p.authRef && c.authReferences.some(function (r) { return r.id === p.authRef && r.baseUrl === p.baseUrl; }); });
    var authText = { idle: 'Connect in your browser to add free models.', starting: 'Preparing sign-in…', waiting: 'Finish sign-in in your browser. Status updates automatically.', exchanging: 'Completing sign-in…', complete: 'Connection saved.', expired: 'Sign-in expired. Try again.', cancelled: 'Sign-in cancelled.', failed: 'Sign-in could not be completed.' };
    signIn.append(node('p', connectedRouter ? (connectedRouter.enabled ? 'Connected · Free-only' : 'Disconnected · Sign-in saved') : authText[phase], 'muted'));
    if (!connectedRouter && ['waiting', 'starting', 'exchanging'].indexOf(phase) >= 0) {
      if (phase === 'waiting' && c.auth.authorizationUrl) button(signIn, 'Open browser', function () { openAuth(c.auth.authorizationUrl); }, 'open-auth', !linksAvailable || !!linkRequest, true);
      button(signIn, 'Cancel sign-in', function () { controlCall('auth_cancel'); }, 'cancel-auth');
      if (!linksAvailable) signIn.append(node('p', 'This host does not offer browser opening. Sign-in is not available in this view.', 'alert'));
    } else if (!connectedRouter) button(signIn, 'Connect OpenRouter', function () { controlCall('auth_begin'); }, 'begin-auth', !c.auth.storageAvailable || !linksAvailable, true);
    if (!c.auth.storageAvailable) signIn.append(node('p', 'Secret storage is unavailable. Check the startup helper.', 'alert'));
    if (!connectedRouter && c.auth.error && phase === 'failed') signIn.append(node('p', readableError(c.auth.error), 'alert'));
    if (!connectedRouter) more.append(signIn);
  }
  // Every other harness, as it really is here: whether its runtime was found (never run), and why it does not run in Bridge. No button: nothing to start.
  if (!providerDraft.detail && !providerDraft.open) (c.harnesses || []).forEach(function (h) {
    var row = node('article', undefined, 'provider-card harness-row'), info = node('div');
    var needs = h.minimumVersion ? ' ' + h.minimumVersion + ' or newer' : '';
    var found = (h.runtime === 'found' ? h.executable + ' found, version not checked (needs' + (needs || ' a supported version') + ')' : h.runtime === 'not_found' ? 'Needs ' + h.executable + needs : 'Separate runtime');
    var line = found + ' · ' + (h.execution !== 'qualified_here' ? 'Sign-in and models not checked · Not available in Bridge yet'
      : h.enabled ? 'Enabled for new chats · uses its own sign-in' : 'Available on this system · Off');
    var why = node('details'); why.append(node('summary', 'Why'), node('p', h.reason, 'muted'));
    info.append(node('h3', h.label), node('small', line, 'muted'), why); row.append(info);
    // The one action where its boundary is supported and its runtime is found: on or off for new chats. Sign-in stays the runtime's own.
    if (h.execution === 'qualified_here' && h.canEnable) button(row, h.enabled ? 'Turn off' : 'Turn on', function () { controlCall('harness', { harness: h.id, enabled: !h.enabled }); }, 'harness-' + h.id, false, false, (h.enabled ? 'Turn off ' : 'Turn on ') + h.label);
    more.append(row);
  });
  if (providerDraft.open) {
    var form = node('section', undefined, 'connection-form'); form.setAttribute('aria-label', 'New connection'); form.append(node('h3', 'Add a provider'));
    var name = field(form, 'Name', 'name', 80), url = field(form, 'Base URL', 'baseUrl', 2048);
    url.type = 'url'; url.placeholder = 'https://your-provider.example/v1';
    var auth = select(form, 'Authentication', [{ value: '', label: 'None' }].concat(c.authReferences.map(function (r, i) { return { value: r.id, label: 'Saved sign-in ' + (i + 1) + ' — ' + r.baseUrl }; })), providerDraft.authRef, 'auth-ref', function (v) { providerDraft.authRef = v; });
    form.append(node('p', 'Use https://, or http://127.0.0.1 with a port. Choose a saved sign-in if needed.', 'muted'));
    button(form, 'Connect', function () {
      if (url.value.length > 2048 || url.value.indexOf('@') >= 0 || url.value.indexOf('?') >= 0 || url.value.indexOf('#') >= 0) {
        controlNotice = 'Use a base URL without credentials, query or fragment. Choose an authentication reference instead.'; render(); return;
      }
      controlCall('connect', { name: name.value, baseUrl: url.value, authRef: auth.value || null });
    }, 'connect', false, true);
    button(form, 'Cancel', function () { providerDraft.open = false; focusAfterRender = 'add-connection'; render(); }, 'cancel-connection'); connections.append(form);
  }
  if (c.focusedProvider && c.providers.some(function (p) { return p.id === c.focusedProvider; })) providerDraft.providerId = c.focusedProvider;
  var p = c.providers.find(function (p) { return p.id === providerDraft.providerId; }) || c.providers[0];
  if (p && providerDraft.providerId !== p.id) { providerDraft.providerId = p.id; providerDraft.model = ''; }
  c.providers.forEach(function (provider) {
    var card = node('article', undefined, 'provider-card');
    var choose = button(card, provider.name, function () { providerDraft.providerId = provider.id; providerDraft.detail = true; providerDraft.open = false; providerDraft.model = ''; c.focusedProvider = null; focusAfterRender = 'connections-back'; render(); }, 'provider-' + provider.id);
    choose.className = 'connection-pick'; choose.setAttribute('aria-label', provider.name);
    var summary = !provider.enabled ? 'Disconnected · settings saved' : provider.protocol === 'native' ? 'Uses your Codex sign-in' : provider.protocol === 'claude' ? 'Runs on this Mac' : provider.freeOnly ? 'Connected · Free-only' : provider.catalogState === 'fresh' ? provider.models.length + (provider.models.length === 1 ? ' model' : ' models') : provider.catalogState === 'stale' ? 'Catalog unavailable · last known models' : 'Models not loaded';
    choose.replaceChildren(glyph(provider), node('span', provider.name), node('small', summary, 'muted')); card.append(node('span', '›', 'row-chevron'));
    (provider.enabled ? connected : more).append(card);
  });
  if (!providerDraft.detail && !providerDraft.open) {
    if (!c.providers.some(function (provider) { return provider.enabled; })) connected.append(node('p', 'No connected providers yet.', 'empty'));
    connections.append(connected, more, node('p', 'Codex sign-in, permissions and history stay in Codex.', 'muted'));
  }
  if (p && providerDraft.detail) {
    var providerOptions = node('section', undefined, 'connection-options'); providerOptions.setAttribute('aria-label', p.name + ' settings');
    // One status line: a success-coloured check for a connected connection, never a second paragraph about free models.
    var connectionHeading = keyed(node('p', p.name), 'connection-heading'); connectionHeading.tabIndex = -1; connectionHeading.hidden = true;
    var statusLine = p.enabled ? node('p', '✓ Connected' + (p.freeOnly ? ' · free models only' : ''), 'connection-status status-ok') : node('p', 'Disconnected · settings saved', 'connection-status muted');
    providerOptions.append(connectionHeading, statusLine);
    if (p.catalogError) providerOptions.append(node('p', readableError(p.catalogError), 'alert'));
    // Grouped rows, in this order: Models, Default for new chats, Connection.
    var rows = node('section', undefined, 'detail-group'); rows.setAttribute('aria-label', p.name + ' options');
    var modelSettings = node('div', undefined, 'detail-row'), modelText = node('div'); modelText.append(node('h3', 'Models'), node('small', p.models.length + ' models' + (p.catalogState === 'stale' ? ' · Last known models' : p.catalogState === 'unknown' ? ' · Not loaded yet' : ''), 'muted')); modelSettings.append(modelText);
    button(modelSettings, p.catalogState === 'unknown' ? 'Discover models' : 'Refresh catalog', function () { controlCall('refresh', { providerId: p.id }); }, 'discover', p.protocol !== 'responses' && c.pickerRefresh && c.pickerRefresh.requested > c.pickerRefresh.observed);
    rows.append(modelSettings);
    if (p.protocol === 'responses' && p.models.length) {
      // The whole row is the target; the chevron is plain. It opens the default-model menu beside the row.
      var defaultRow = node('div', undefined, 'detail-row row-action'), currentModel = p.models.find(function (model) { return model.id === p.selected; });
      var defaultButton = button(defaultRow, '', function () { defaultOpen = !defaultOpen; slotDisclosure = null; filterOpen = false; focusAfterRender = defaultOpen ? 'default-search' : 'default-model'; render(); }, 'default-model', false, false, 'Default for new chats');
      var defaultText = node('div'); defaultText.append(node('h3', 'Default for new chats'), node('small', currentModel ? currentModel.name : 'Choose a model', 'muted')); defaultButton.className = 'row-target';
      defaultButton.append(defaultText, node('span', '›', 'row-chevron-plain')); defaultButton.setAttribute('data-menu-trigger', 'default'); defaultButton.setAttribute('aria-expanded', String(defaultOpen));
      rows.append(defaultRow);
      if (defaultOpen) {
        var defaults = node('section', undefined, 'filter-popover'); defaults.setAttribute('data-floating', 'default'); defaults.setAttribute('role', 'dialog'); defaults.setAttribute('aria-label', 'Default model'); popoverNodes.push({panel: defaults, key: 'default-model'});
        if (p.models.length > 8) { var defaultSearch = keyed(node('input'), 'default-search'); defaultSearch.type = 'search'; defaultSearch.placeholder = 'Search models'; defaultSearch.setAttribute('aria-label', 'Search default models'); defaultSearch.value = providerDraft.modelSearch || ''; defaultSearch.addEventListener('input', function () { providerDraft.modelSearch = defaultSearch.value; render(); }); defaults.append(defaultSearch); }
        p.models.filter(function (model) { return model.available !== false && model.name.toLowerCase().indexOf((providerDraft.modelSearch || '').toLowerCase()) >= 0; }).forEach(function (model) { button(defaults, (model.id === p.selected ? '✓ ' : '') + model.name, function () { defaultOpen = false; focusAfterRender = 'default-model'; controlCall('select', { providerId: p.id, model: model.id }); }, 'default-' + model.id, p.catalogState !== 'fresh'); });
        target.append(defaults);
      }
    }
    if (p.protocol !== 'native') {
      var admission = node('div', undefined, 'detail-row'), admissionText = node('div'); admissionText.append(node('h3', 'Connection'), node('small', 'Stops new chats from using ' + p.name + '. Keeps your sign-in and chat history.', 'muted')); admission.append(admissionText);
      button(admission, p.enabled ? (p.protocol === 'claude' ? 'Disable Claude' : 'Disconnect') : (p.protocol === 'claude' ? 'Enable Claude' : 'Reconnect'), function () { controlCall('enabled', { providerId: p.id, enabled: !p.enabled }); }, 'provider-enabled');
      rows.append(admission);
    }
    providerOptions.append(rows);
    if (p.protocol === 'native') providerOptions.append(node('p', 'Sign-in stays with Codex.', 'muted'));
    var technical = node('details'); technical.append(node('summary', 'Technical details'), node('p', p.baseUrl || 'Managed by Codex', 'endpoint'), node('p', 'Catalog: ' + p.catalogState, 'muted'));
    // The boundary line stays until the new hand-off is qualified; Technical details come last.
    if (p.protocol === 'responses') providerOptions.append(node('p', 'Chats started with ' + p.name + ' can switch between ' + p.name + ' models. To use another connection, start a new chat.', 'muted boundary'));
    if (p.protocol === 'claude') providerOptions.append(node('p', 'A chat switched to Claude keeps its messages and tool results, but not earlier hidden reasoning.', 'muted boundary'));
    providerOptions.append(technical);
    connections.append(providerOptions);
  }
  function glyph(provider) {
    var box = node('span', undefined, 'connection-glyph'); box.setAttribute('aria-hidden', 'true');
    var initial = ((provider && provider.name || '?').trim().charAt(0) || '?').toUpperCase();
    var path = !provider ? null : provider.protocol === 'native' ? 'M6 16a4 4 0 0 1-.5-8A5 5 0 0 1 15 7a4.5 4.5 0 0 1 0 9Z' : provider.protocol === 'claude' ? 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM7 9l3 3-3 3m6 0h4' : provider.baseUrl === 'https://openrouter.ai/api/v1' ? 'M3 12h7m0 0 5-7h6m-3-3 3 3-3 3m-8 4h11m-3-3 3 3-3 3m-8-3 5 7h6m-3-3 3 3-3 3' : null;
    var drawn = path ? svgIcon([path]) : null;
    if (drawn) box.append(drawn); else { box.className += ' connection-initial'; box.textContent = initial; }
    return box;
  }
  function announce(text) { document.getElementById('announcement').textContent = text; }
  function editSelection(models, text) { slotsDraft.models = models; slotsDraft.dirty = true; announce(text); render(); }
  function resolve(id, index) {
    var model = known.find(function (m) { return m.id === id; }), provider = model && model.provider || c.providers.find(function (p) { return p.id === id.split('/')[1]; });
    var label = model && model.name;
    if (!label) try {
      var parts = id.split('/'); if (parts.length !== 3 || parts[0] !== 'bridge-responses') throw Error();
      label = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(parts[2].replaceAll('-', '+').replaceAll('_', '/')), function (c) { return c.charCodeAt(0); }));
      if (!label || label.length > 512 || hasControl(label)) throw Error();
    } catch (ignored) { label = 'Saved model ' + (index + 1); }
    return { id: id, name: label, provider: provider || { name: 'Connection unavailable' }, unavailable: !model || !available(model), capabilities: model && model.capabilities };
  }
  function optionsButton(parent, model, key) {
    var expanded = !!slotDisclosure && sameScope(slotDisclosure.scope, c) && slotDisclosure.id === model.id && slotDisclosure.key === key;
    var b = button(parent, '···', function () { defaultOpen = false; slotDisclosure = expanded ? null : { scope: scopeOf(c), id: model.id, key: key }; focusAfterRender = expanded ? key : 'detail-heading'; render(); }, key, false, false, 'Options for ' + model.name + ' from ' + model.provider.name);
    b.setAttribute('data-menu-trigger', 'slot'); b.setAttribute('aria-expanded', String(expanded)); if (expanded) b.setAttribute('aria-controls', 'slot-disclosure'); return b;
  }
  var slotSection = node('section', undefined, 'panel slots'); slotSection.setAttribute('aria-label', 'In picker');
  var headingRow = node('div', undefined, 'selection-heading');
  var heading = keyed(node('h2', 'In picker'), 'slots-heading'); heading.tabIndex = -1;
  var headingLabel = node('div', undefined, 'selection-label'); headingLabel.append(heading, node('span', String(slotsDraft.models.length), 'selection-count')); headingRow.append(headingLabel);
  var invalid = slotsDraft.models.some(function (id) { if (c.slots.models && c.slots.models.indexOf(id) >= 0) return false; var m = known.find(function (m) { return m.id === id; }); return !m || !available(m); });
  var noAvailable = !slotsDraft.models.some(function (id) { return known.some(function (m) { return m.id === id && available(m); }); });
  var saveBar = node('section', undefined, 'save-bar'); saveBar.setAttribute('aria-label', 'Picker changes');
  if (conflict) {
    saveBar.append(node('p', 'Changed in another window', 'draft-note'));
    button(saveBar, 'Keep mine', function () { slotsDraft.revision = c.slots.revision; slotsDraft.dirty = true; render(); }, 'keep-draft');
    button(saveBar, 'Use saved', function () { slotsDraft = null; render(); }, 'use-saved');
  } else if (slotsDraft.dirty || pendingControl && pendingControl.action === 'slots') {
    saveBar.append(node('p', pendingControl && pendingControl.action === 'slots' ? 'Saving…' : 'Unsaved', 'draft-note'));
    if (!(slotsDraft.adopt && JSON.stringify(slotsDraft.models) === JSON.stringify(effective))) button(saveBar, 'Discard', function () { slotsDraft = null; slotDisclosure = null; focusAfterRender = 'slots-heading'; render(); }, 'discard-slots');
    button(saveBar, pendingControl && pendingControl.action === 'slots' ? 'Saving…' : 'Save', function () { controlCall('slots', Object.assign({ slotsRevision: slotsDraft.revision, models: slotsDraft.models.slice() }, unified ? { catalogRevision: c.slots.catalogRevision, reset: false } : {})); }, 'save-slots', invalid || unified && (noAvailable || !c.slots.catalogRevision), true);
  } else if (savedUntil > Date.now()) saveBar.append(node('p', '✓ Saved to your model picker.', 'saved-note'));
  headingRow.append(saveBar); slotSection.append(headingRow, node('p', 'Shown in Codex’s model picker, in this order.', 'selection-subtitle'));
  if (c.slots.models === null) slotSection.append(node('p', 'Pick the few models you switch between. 5 to 10 works well.', 'selection-subtitle'));
  if (invalid) slotSection.append(node('p', 'Remove unavailable new draft models or refresh their provider before saving.', 'alert'));
  if (unified && !c.slots.catalogRevision) slotSection.append(node('p', 'Waiting for the native model catalog. Check Connections if it stays empty.', 'alert'));
  if (unified && noAvailable) slotSection.append(node('p', 'Keep at least one available model in the picker.', 'alert'));
  var list = node('ul', undefined, 'slot-list'); list.setAttribute('aria-label', 'Models in picker');
  var dropIndex = null;
  function clearDrop() { dropIndex = null; Array.from(list.children).forEach(function (item) { item.setAttribute('data-insert', ''); }); slotSection.setAttribute('data-drop-active', 'false'); }
  function landing(item, index) {
    item.addEventListener('dragover', function (event) {
      if (blocked || uncertain || pendingControl || view.handshake !== 'connected') return;
      event.preventDefault(); if (event.stopPropagation) event.stopPropagation(); clearDrop();
      var after = false;
      if (item.getBoundingClientRect && typeof event.clientX === 'number') { var rect = item.getBoundingClientRect(); after = event.clientX > rect.left + rect.width / 2; }
      dropIndex = index + (after ? 1 : 0); item.setAttribute('data-insert', after ? 'after' : 'before');
    });
  }
  function draggable(item, model, move) {
    item.draggable = !blocked && !model.unavailable;
    item.addEventListener('dragend', clearDrop);
    item.addEventListener('dragstart', function (event) {
      if (!item.draggable || uncertain || pendingControl || view.handshake !== 'connected' || !event.dataTransfer) { event.preventDefault(); return; }
      slotDisclosure = null; event.dataTransfer.setData('text/plain', model.id); event.dataTransfer.effectAllowed = move ? 'move' : 'copy';
    });
  }
  slotsDraft.models.forEach(function (id, index) {
    var model = resolve(id, index), item = node('li', undefined, 'slot-tile');
    item.setAttribute('aria-label', 'Position ' + (index + 1) + ': ' + model.name + ' from ' + model.provider.name); item.setAttribute('title', model.name + ' — ' + model.provider.name);
    landing(item, index); draggable(item, model, true);
    var top = node('div', undefined, 'slot-top'); top.append(glyph(model.provider), node('span', String(index + 1), 'slot-number'));
    var bottom = node('div', undefined, 'slot-bottom'); bottom.append(node('strong', model.name, 'slot-name'), node('small', model.unavailable ? '! Unavailable' : model.provider.name, 'slot-provider' + (model.unavailable ? ' unavailable' : '')));
    var actions = node('div', undefined, 'slot-actions'); optionsButton(actions, model, 'details-' + id); item.append(top, bottom, actions); list.append(item);
  });
  var empty = node('li', undefined, 'slot-empty');
  var add = button(empty, '', function () { providerDraft.libraryView = 'all'; c.focusedProvider = null; focusAfterRender = 'search'; render(); }, 'add-slot-' + slotsDraft.models.length, false, false, 'Add model: browse all models'); add.className = 'slot-add'; add.append(node('span', '+', 'slot-plus'), node('span', 'Add model')); list.append(empty); slotSection.append(list);
  if (!slotsDraft.models.length) slotSection.append(node('p', 'No models selected. Add at least one available model before saving.', 'empty'));
  var library = node('section', undefined, 'panel library'); library.setAttribute('aria-label', 'Model library');
  var toolbar = node('div', undefined, 'library-toolbar'), searchWrap = node('div', undefined, 'search-wrap');
  var search = field(searchWrap, 'Search models', 'search', 512); search.type = 'search'; search.placeholder = 'Search models or connections'; search.addEventListener('input', function () { render(); }); toolbar.append(searchWrap);
  var segments = node('div', undefined, 'library-segments'); segments.setAttribute('role', 'radiogroup'); segments.setAttribute('aria-label', 'Models shown');
  ['all', 'picker'].forEach(function (value, index) {
    var selected = (providerDraft.libraryView || 'all') === value;
    var b = button(segments, value === 'all' ? 'All models' : 'In picker', function () { slotDisclosure = null; providerDraft.libraryView = value; focusAfterRender = 'view-' + value; render(); }, 'view-' + value); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(selected)); b.tabIndex = selected ? 0 : -1;
    b.addEventListener('keydown', function (event) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) < 0) return; event.preventDefault(); var next = event.key === 'Home' ? 'all' : event.key === 'End' ? 'picker' : index ? 'all' : 'picker'; providerDraft.libraryView = next; slotDisclosure = null; focusAfterRender = 'view-' + next; render(); });
  }); toolbar.append(segments); library.append(toolbar);
  var pickerView = providerDraft.libraryView === 'picker';
  var candidates = pickerView ? slotsDraft.models.map(resolve) : known;
  var shown = candidates.filter(function (m) { return (m.name + ' ' + m.provider.name).toLowerCase().indexOf(providerDraft.search.toLowerCase()) >= 0; });
  // One 20px status line, never absent, so nothing below it moves when its text changes.
  var staleConnection = c.providers.find(function (p) { return p.enabled && p.catalogState === 'stale'; });
  var loadingModels = !known.length && c.providers.some(function (p) { return p.enabled && p.catalogState === 'unknown'; });
  var statusText = providerDraft.search ? shown.length + ' of ' + candidates.length + ' match “' + providerDraft.search + '”' : loadingModels ? 'Loading models…' : staleConnection ? 'Couldn’t update' : pickerView ? shown.length + ' in picker' : known.length + ' models';
  var modelCount = node('p', statusText, 'model-count');
  if (providerDraft.search) button(modelCount, 'Clear', function () { providerDraft.search = ''; focusAfterRender = 'search'; render(); }, 'clear-filters');
  else if (staleConnection && !loadingModels) { modelCount.append(node('span', '·')); button(modelCount, 'Retry', function () { controlCall('refresh', { providerId: staleConnection.id }); }, 'retry-catalog', staleConnection.protocol !== 'responses' && c.pickerRefresh && c.pickerRefresh.requested > c.pickerRefresh.observed); }
  library.append(modelCount);
  var libraryList = node('div', undefined, 'library-list'); libraryList.setAttribute('aria-label', pickerView ? 'Models in picker order' : 'Discovered models');
  var lastProvider = null;
  shown.forEach(function (model) {
    if (!pickerView && lastProvider !== model.provider.id) { var group = node('h3', undefined, 'library-group'); group.append(glyph(model.provider), node('span', model.provider.name)); libraryList.append(group); lastProvider = model.provider.id; }
    var item = node('article', undefined, 'model-row'), text = node('div', undefined, 'model-row-text'); text.append(node('h3', model.name)); item.append(text);
    if (pickerView) { item.className += ' picker-row'; var marker = node('span', '⋮⋮', 'drag-handle'); marker.setAttribute('aria-hidden', 'true'); text.replaceChildren(marker, glyph(model.provider), node('h3', model.name), node('small', 'via ' + model.provider.name)); optionsButton(item, model, 'list-details-' + model.id); landing(item, slotsDraft.models.indexOf(model.id)); }
    else {
      var index = slotsDraft.models.indexOf(model.id), included = index >= 0;
      if (!available(model)) text.append(node('small', 'Unavailable until refresh', 'unavailable'));
      button(item, included ? '✓ ' + (index + 1) : '+', function () { var copy = slotsDraft.models.slice(); if (included) copy.splice(index, 1); else copy.push(model.id); editSelection(copy, model.name + (included ? ' removed from picker.' : ' added to picker.')); }, 'library-' + model.id, !included && !available(model), false, (included ? 'Remove ' : 'Add ') + model.name + ' from ' + model.provider.name + (included ? ' from picker, position ' + (index + 1) : ' to picker')).setAttribute('aria-pressed', String(included));
    }
    draggable(item, pickerView ? model : { id: model.id, unavailable: !available(model) }, pickerView); libraryList.append(item);
  }); library.append(libraryList);
  if (!shown.length) library.append(node('p', !known.length ? 'Discover a connection’s models to see them here.' : 'No models match.', 'empty'));
  if (slotDisclosure && sameScope(slotDisclosure.scope, c) && slotsDraft.models.indexOf(slotDisclosure.id) >= 0) {
    var at = slotsDraft.models.indexOf(slotDisclosure.id), disclosed = resolve(slotDisclosure.id, at), disclosure = node('section', undefined, 'slot-disclosure'); disclosure.id = 'slot-disclosure'; disclosure.setAttribute('role', 'dialog'); disclosure.setAttribute('aria-label', 'Model options'); disclosure.setAttribute('data-floating', 'slot');
    popoverNodes.push({ panel: disclosure, key: slotDisclosure.key || 'details-' + disclosed.id });
    var detailHeading = keyed(node('h3', disclosed.name), 'detail-heading'); detailHeading.tabIndex = -1; disclosure.append(detailHeading, node('p', 'via ' + disclosed.provider.name, 'muted'));
    var names = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
    var caps = disclosed.capabilities || {}, levels = Array.isArray(caps.supportedReasoningEfforts) ? caps.supportedReasoningEfforts.map(function (e) { return e && e.reasoningEffort; }).filter(function (e, i, all) { return Object.prototype.hasOwnProperty.call(names, e) && all.indexOf(e) === i; }) : [];
    var defaultLevel = levels.indexOf(caps.defaultReasoningEffort) >= 0 ? caps.defaultReasoningEffort : null;
    var reasoning = 'Reasoning levels · ' + (levels.length ? levels.map(function (e) { return names[e]; }).join(', ') + (defaultLevel ? ' · default ' + names[defaultLevel] : '') : 'none listed');
    var router = disclosed.provider.baseUrl === 'https://openrouter.ai/api/v1';
    var explanation = levels.length ? 'Levels are chosen per chat in Codex.' : router ? (['openrouter/free', 'openrouter/auto'].indexOf(disclosed.name) >= 0 ? 'OpenRouter can pick a different model for each request, so it lists no levels.' : 'OpenRouter lists no levels for this model.') : "This endpoint’s model list doesn’t include reasoning levels.";
    if (!levels.length && disclosed.provider.protocol === 'responses') explanation += router ? " If a level is chosen in Codex, it’s passed to OpenRouter, which may ignore it." : " If a level is chosen in Codex, it’s passed to the endpoint, which may ignore it.";
    disclosure.append(node('hr'), node('p', reasoning, 'reasoning-label'), node('p', explanation, 'muted'));
    if (disclosed.unavailable) disclosure.append(node('p', 'Unavailable until its connection is refreshed.', 'unavailable'));
    disclosure.append(node('hr'));
    function moveSlot(delta) { var next = at + delta; if (next < 0 || next >= slotsDraft.models.length) return; var copy = slotsDraft.models.slice(); copy.splice(at, 1); copy.splice(next, 0, disclosed.id); focusAfterRender = delta < 0 ? 'move-earlier' : 'move-later'; editSelection(copy, disclosed.name + ' moved to position ' + (next + 1) + '.'); }
    button(disclosure, 'Move earlier', function () { moveSlot(-1); }, 'move-earlier', at <= 0); button(disclosure, 'Move later', function () { moveSlot(1); }, 'move-later', at >= slotsDraft.models.length - 1); disclosure.append(node('hr'));
    button(disclosure, 'Remove from picker', function () { var copy = slotsDraft.models.filter(function (id) { return id !== disclosed.id; }); slotDisclosure = null; focusAfterRender = 'slots-heading'; editSelection(copy, disclosed.name + ' removed from picker.'); }, 'remove-' + disclosed.id); target.append(disclosure);
  }
  slotSection.setAttribute('data-drop-active', 'false');
  slotSection.addEventListener('dragover', function (event) {
    if (!blocked && !uncertain && !pendingControl && view.handshake === 'connected') { event.preventDefault(); slotSection.setAttribute('data-drop-active', 'true'); }
  });
  slotSection.addEventListener('dragleave', function (event) { if (!event.relatedTarget || typeof slotSection.contains !== 'function' || !slotSection.contains(event.relatedTarget)) clearDrop(); });
  slotSection.addEventListener('drop', function (event) {
    event.preventDefault(); var insertion = dropIndex; clearDrop();
    if (blocked || uncertain || pendingControl || view.handshake !== 'connected' || !event.dataTransfer) return;
    var id = event.dataTransfer.getData('text/plain');
    var model = known.find(function (m) { return m.id === id; });
    if (!model || !available(model)) return;
    var previous = slotsDraft.models.indexOf(id);
    if (previous >= 0 && insertion === null) return;
    var copy = slotsDraft.models.slice();
    if (previous >= 0) { copy.splice(previous, 1); if (insertion > previous) insertion--; }
    copy.splice(insertion === null ? copy.length : insertion, 0, id);
    if (JSON.stringify(copy) === JSON.stringify(slotsDraft.models)) return;
    focusAfterRender = 'slots-heading'; editSelection(copy, 'Model picker order updated.');
  });
  workspace.append(slotSection, library);
  grid.append(providerDraft.settings ? connections : workspace); target.append(grid);
  // Diagnostics belong to the Connections overview footer only: never Home, never a connection's own page or the add form.
  document.getElementById('technical').hidden = !(providerDraft.settings && !providerDraft.detail && !providerDraft.open);
  var footer = node('div', undefined, 'toolbar');
  if (c.pickerRefresh && c.pickerRefresh.requested > c.pickerRefresh.observed) footer.append(node('p', 'Native catalog update pending. An idle app restart may be needed.', 'notice'));

  if (controlNotice && controlNotice !== 'Saved to your model picker.') { var notice = node('p', controlNotice, 'notice'); notice.setAttribute('role', 'status'); footer.append(notice); }
  if (!toolsAvailable) footer.append(node('p', 'This host has not enabled connection actions.', 'alert'));
  target.append(footer);
}
// Host context is optional and may arrive in part: only fields that are valid
// change anything. Without a theme the page follows the system colour scheme.
function applyContext(context) {
  if (!isObject(context)) return;
  if (context.theme === 'light' || context.theme === 'dark') {
    var root = document.documentElement;
    root.setAttribute('data-theme', context.theme);
    root.style.colorScheme = context.theme;
  }
  if (MODES.indexOf(context.displayMode) >= 0) view.mode = context.displayMode;
  if (isObject(context.containerDimensions)) {
    var d = context.containerDimensions;
    if (typeof d.height === 'number' && isFinite(d.height) && d.height > 0) view.fixedHeight = d.height;
    else view.fixedHeight = null;
    view.maxHeight = typeof d.maxHeight === 'number' && isFinite(d.maxHeight) && d.maxHeight > 0 ? d.maxHeight : null;
  }
  document.documentElement.setAttribute('data-fixed-container', String(!!view.fixedHeight));
  document.documentElement.setAttribute('data-display-mode', view.mode || 'inline');
  if (Array.isArray(context.availableDisplayModes)) view.modes = MODES.filter(function (mode) { return context.availableDisplayModes.indexOf(mode) >= 0; });
}
function alertText() {
  if (view.fault) return 'The view hit an internal error.';
  if (view.handshake !== 'connected') return HOST_ALERT[view.handshake];
  return DATA_ALERT[view.data];
}
function details() {
  return [
    'Host: ' + (view.hostName || 'not reported'),
    'Protocol: ' + (view.protocol || 'not negotiated'),
    'Display mode: ' + (view.mode || 'not reported') + (view.modes ? ' (host offers: ' + (view.modes.join(', ') || 'none') + ')' : ''),
    'Plugin: ' + (view.home ? view.home.pluginVersion : VERSION),
    'Control scope: ' + (view.home && view.home.controls ? 'declared profile ' + view.home.controls.profileId + ', Bridge ' + view.home.controls.bridgeId + ', revision ' + view.home.controls.revision : uncertain && recoveryScope ? 'recovery only: declared profile ' + recoveryScope.profileId + ', Bridge ' + recoveryScope.bridgeId + '; current state unknown' : 'unbound'),
    'Observed by the plugin server: ' + (view.home ? view.home.observedAt : 'no result yet')
  ];
}
// The page's content box, not the viewport: #app has automatic height, so a
// host that resizes the frame to the reported height cannot change the next measurement.
function reportSize() {
  if (view.handshake !== 'connected' || view.fixedHeight || view.maxHeight) return;
  var app = document.getElementById('app');
  var width = Math.ceil(app.scrollWidth), height = Math.ceil(app.offsetHeight);
  popoverNodes.forEach(function (entry) { if (entry.desiredBottom !== undefined) height = Math.max(height, Math.ceil(entry.desiredBottom)); else if (entry.panel.getBoundingClientRect) height = Math.max(height, Math.ceil(entry.panel.getBoundingClientRect().bottom + (window.scrollY || 0) + 12)); });
  if (!(isFinite(width) && isFinite(height) && width > 0 && height > 0)) return;
  var key = width + 'x' + height;
  if (key === view.size) return;
  view.size = key;
  send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: width, height: height } });
}
function onToggle() { reportSize(); }
function watchSize() {
  if (view.observer || typeof ResizeObserver !== 'function') return;
  try {
    view.observer = new ResizeObserver(function () { reportSize(); });
    view.observer.observe(document.getElementById('app'));
  } catch (error) { view.observer = null; }
}
function render() {
  var active = document.activeElement, focusKey = focusAfterRender || (active && active.getAttribute && active.getAttribute('data-focus-key'));
  var start = active && active.selectionStart, end = active && active.selectionEnd;
  focusAfterRender = null; focusNodes = {}; popoverNodes = [];
  var alert = document.getElementById('alert'), text = alertText();
  alert.textContent = text;
  alert.hidden = text === '';
  document.getElementById('status').replaceChildren(node('li', HANDSHAKE[view.handshake]), node('li', DATA[view.data]));
  document.getElementById('meta').replaceChildren.apply(document.getElementById('meta'), details().map(function (line) { return node('li', line); }));
  var list = document.getElementById('facts');
  list.replaceChildren();
  var home = view.home;
  if (home) FACTS.forEach(function (entry) {
    var fact = home.facts[entry[0]];
    var item = node('li', undefined, fact.state);
    item.append(node('span', MARKS[fact.state], 'mark'), node('b', entry[1] + ':'), document.createTextNode(' ' + fact.detail));
    list.append(item);
  });
  document.getElementById('next').textContent = home ? 'Next: ' + home.next : '';
  document.getElementById('technical').hidden = false;
  renderControls();
  if (!home || !home.controls || home.controls.kind !== 'responses-trial') document.getElementById('page-title').textContent = 'Model Bridge';
  // Menus are placed beside their trigger BEFORE anything inside them takes focus: a focused
  // element in an unpositioned absolute menu sits at the document start and would scroll there.
  positionPopovers();
  var focus = focusKey && focusNodes[focusKey];
  if (focus && focus.disabled && focusKey === 'save-slots') focus = focusNodes['slots-heading'];
  if (focus && !focus.disabled && focus.focus) {
    var inMenu = focusKey === 'detail-heading' || focusKey === 'default-search';
    if (inMenu) focus.focus({ preventScroll: true }); else focus.focus();
    // Keep the focused menu visible with the smallest possible scroll (document scroll only).
    var shownMenu = inMenu && popoverNodes.length ? popoverNodes[0].panel : null;
    if (shownMenu && shownMenu.scrollIntoView) try { shownMenu.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignored) {}
    if (focus === focusNodes[focusKey] && typeof start === 'number' && focus.setSelectionRange) try { focus.setSelectionRange(start, end); } catch (ignored) {}
  }
  reportSize(); scheduleStateRead();
}
function positionPopovers() {
  popoverNodes.forEach(function (entry) {
    var anchor = focusNodes[entry.key], panel = entry.panel;
    if (!anchor || !anchor.getBoundingClientRect || !panel.getBoundingClientRect) return;
    var a = anchor.getBoundingClientRect(), width = Math.min(260, document.documentElement.clientWidth - 24);
    panel.style.width = width + 'px';
    var height = panel.getBoundingClientRect().height;
    var top = a.bottom + (window.scrollY || 0) + 6;
    if (view.fixedHeight && top + height + 12 > document.documentElement.scrollHeight && a.top > height + 12) top = a.top + (window.scrollY || 0) - height - 6;
    panel.style.left = Math.max(12, Math.min(a.right - width, document.documentElement.clientWidth - width - 12)) + 'px';
    panel.style.top = top + 'px'; entry.desiredBottom = top + height + 12;
  });
}
function dismissPopover(event) {
  if (event.type === 'keydown' && event.key !== 'Escape') return;
  if (event.type === 'pointerdown' && event.target && event.target.closest && event.target.closest('[data-floating], [data-menu-trigger]')) return;
  if (!slotDisclosure && !filterOpen && !defaultOpen) return;
  focusAfterRender = slotDisclosure ? slotDisclosure.key || 'details-' + slotDisclosure.id : defaultOpen ? 'default-model' : 'filters'; slotDisclosure = null; filterOpen = false; defaultOpen = false; render();
}
function loadHome() {
  if (!toolsAvailable || view.handshake !== 'connected' || homeRequest || pendingControl || uncertain) return;
  homeRequest = nextId++;
  send({ jsonrpc: '2.0', id: homeRequest, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } });
  loadTimer = setTimeout(function () { homeRequest = null; view.data = 'error'; render(); }, TIMEOUT_MS);
  render();
}
// After this nothing is observed, listened to or sent.
function releaseView() {
  clearTimeout(savedTimer); savedUntil = 0;
  clearTimeout(timer); clearStateRead();
  clearTimeout(loadTimer); homeRequest = null;
  clearTimeout(controlTimer); pendingControl = null; clearLink(); slotDisclosure = null;
  if (view.observer) { view.observer.disconnect(); view.observer = null; }
  window.removeEventListener('message', onMessage); window.removeEventListener('resize', positionPopovers);
  if (document.removeEventListener) { document.removeEventListener('keydown', dismissPopover); document.removeEventListener('pointerdown', dismissPopover); document.removeEventListener('scroll', positionPopovers, true); }
  document.getElementById('technical').removeEventListener('toggle', onToggle);
}
// The first answer to this view's own request is final, even if it comes after
// the time bound: the status then moves from "still waiting" to what was answered.
function onResponse(message) {
  if (stateRequest && message.id === stateRequest.id) {
    var scope = stateRequest.scope; clearStateRead();
    var updated = !('error' in message) && isObject(message.result) && message.result.isError !== true ? parseHome(message.result.structuredContent) : null;
    if (!updated || !sameScope(updated.controls, scope) || updated.controls.kind !== scope.kind || updated.controls.revision < scope.revision) {
      stateReadFailed = true; unknownControl(scope, 'State update unavailable. Retry to check saved changes.'); render(); return;
    }
    var changed = uncertain || !view.home || JSON.stringify(updated.controls) !== JSON.stringify(view.home.controls);
    view.home = updated; view.data = 'received'; uncertain = false; recoveryScope = scopeOf(updated.controls);
    if (changed) { controlNotice = recoveryNotice; render(); } else scheduleStateRead();
    return;
  }
  if (linkRequest !== null && message.id === linkRequest) { clearLink(); controlNotice = 'error' in message || !isObject(message.result) || message.result.isError === true ? 'Browser opening was not confirmed. Use Open browser to try again, or cancel sign-in.' : 'Browser open requested. Finish sign-in in your browser. Status updates automatically.'; render(); return; }
  if (homeRequest !== null && message.id === homeRequest) {
    clearTimeout(loadTimer); homeRequest = null;
    view.home = !('error' in message) && isObject(message.result) && message.result.isError !== true ? parseHome(message.result.structuredContent) : null;
    view.data = view.home ? 'received' : 'error'; recoveryScope = scopeOf(view.home && view.home.controls); render(); return;
  }
  if (pendingControl && message.id === pendingControl.id) {
    var request = pendingControl; clearTimeout(controlTimer); pendingControl = null;
    var home = !('error' in message) && isObject(message.result) && message.result.isError !== true ? parseHome(message.result.structuredContent) : null;
    if (!home || !sameScope(home.controls, request.scope) || home.controls.kind !== request.scope.kind || home.controls.revision < request.scope.revision || (['status', 'auth_begin', 'auth_cancel', 'refresh'].indexOf(request.action) < 0 && home.controls.revision === request.scope.revision)) {
      unknownControl(request.scope, 'Action not confirmed for this test scope. Read current state before more changes.');
      if (request.scope.kind === 'responses-trial' && isObject(message.result) && message.result.isError === true && isObject(message.result.structuredContent)) {
        recoveryNotice = readableError(message.result.structuredContent.error); controlNotice = recoveryNotice;
      }
    } else {
      if (request.action === 'auth_cancel' || request.action === 'auth_begin') clearLink();
      view.home = home; view.data = 'received'; uncertain = false;
      recoveryScope = scopeOf(home.controls); selectionDraft = null;
      if (home.controls.kind === 'responses-trial' && ['select', 'status'].indexOf(request.action) >= 0) providerDraft.model = '';
      if (home.controls.kind === 'responses-trial' && request.action === 'connect') providerDraft.open = false;
      if (home.controls.kind === 'responses-trial' && request.action === 'slots') { slotsDraft = null; savedUntil = Date.now() + 3000; document.getElementById('announcement').textContent = 'Saved to your model picker.'; clearTimeout(savedTimer); savedTimer = setTimeout(function () { savedUntil = 0; document.getElementById('announcement').textContent = ''; render(); }, 3000); }
      controlNotice = home.controls.kind === 'responses-trial' ? ({ auth_begin: 'Sign-in prepared. Open your browser to authorize.', auth_cancel: 'Sign-in cancelled.', status: 'Current connection state received.', connect: 'Connection saved. Discover its models next.', refresh: 'Catalog update requested.', select: 'Connection default saved.', enabled: 'Connection state saved.', slots: 'Saved to your model picker.' }[request.action])
        : request.action === 'status' ? 'Current test state received.' : 'Saved to the declared test store. Native activation is unverified.';
    }
    render(); return;
  }
  if (message.id !== initId || view.replied) return;
  view.replied = true;
  clearTimeout(timer);
  var result = message.result;
  if ('error' in message) view.handshake = 'denied';
  else if (!isObject(result) || typeof result.protocolVersion !== 'string' || !isObject(result.hostCapabilities)) view.handshake = 'invalid';
  else if (SUPPORTED.indexOf(result.protocolVersion) < 0) view.handshake = 'unsupported';
  else {
    view.handshake = 'connected';
    view.protocol = result.protocolVersion;
    toolsAvailable = isObject(result.hostCapabilities.serverTools); linksAvailable = isObject(result.hostCapabilities.openLinks);
    var name = isObject(result.hostInfo) ? limited(result.hostInfo.name, 60) : null, build = isObject(result.hostInfo) ? limited(result.hostInfo.version, 30) : null;
    view.hostName = name ? name + (build ? " " + build : "") : null;
    applyContext(result.hostContext);
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    watchSize();
    // A global entrypoint needs no prompt/LLM. Accept the host's normal result
    // first; if it has not provided one, load the no-argument public Home tool.
    if (!view.home && toolsAvailable) loadTimer = setTimeout(function () { if (!view.home) loadHome(); }, 0);
  }
  render();
}
function onRequest(message) {
  if (!validId(message.id)) return;
  if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: {} });
  else if (message.method === 'ui/resource-teardown') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    view.handshake = 'closed';
    releaseView();
    render();
  } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}
function onNotification(message) {
  var params = message.params;
  if (message.method === 'ui/notifications/tool-result') {
    if (pendingControl || uncertain) return; // only a correlated status read clears uncertain state
    clearStateRead(); stateReadFailed = false;
    clearTimeout(loadTimer); homeRequest = null;
    view.home = null;
    if (!isObject(params)) view.data = 'unusable';
    else if (params.isError === true) view.data = 'error';
    else {
      view.home = parseHome(params.structuredContent);
      view.data = view.home ? 'received' : 'unusable';
    }
    recoveryScope = scopeOf(view.home && view.home.controls);
  } else if (message.method === 'ui/notifications/tool-cancelled') {
    clearTimeout(loadTimer); homeRequest = null;
    clearTimeout(controlTimer); clearStateRead(); stateReadFailed = false;
    unknownControl(pendingControl && pendingControl.scope || view.home && view.home.controls || recoveryScope, 'Cancelled; the action outcome is unknown.');
    pendingControl = null; view.data = 'cancelled';
  }
  else if (message.method === 'ui/notifications/host-context-changed') applyContext(params);
  else return;
  render();
}
function onMessage(event) {
  if (event.source !== host || view.handshake === 'closed') return;
  try {
    var message = event.data;
    if (!isObject(message) || message.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') { if ('id' in message) onRequest(message); else onNotification(message); }
    else if ('id' in message && ('result' in message) !== ('error' in message)) onResponse(message);
  } catch (error) {
    view.fault = true;
    try { render(); } catch (again) { /* nothing more can be shown */ }
  }
}
if (document.addEventListener) { document.addEventListener('keydown', dismissPopover); document.addEventListener('pointerdown', dismissPopover); document.addEventListener('scroll', positionPopovers, true); }
document.getElementById('technical').addEventListener('toggle', onToggle);
if (!host || host === window) view.handshake = 'nohost';
else {
  // Handlers are registered before the handshake so early host messages are not lost.
  window.addEventListener('message', onMessage); window.addEventListener('resize', positionPopovers);
  initId = nextId++;
  send({ jsonrpc: '2.0', id: initId, method: 'ui/initialize', params: { appInfo: { name: 'model-bridge-home', version: VERSION }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: SUPPORTED[0] } });
  timer = setTimeout(function () { if (!view.replied && view.handshake === 'connecting') { view.handshake = 'timeout'; render(); } }, TIMEOUT_MS);
}
render();
`;

// Static dashboard shell. Live state comes only from public MCP results.
const homeShell = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model Bridge</title><style>
:root{color-scheme:light dark;--surface:#f6f6f6;--hover:#efefef;--active:#e6e6e6;--border:#e5e5e5;--border-strong:#d0d0d0;--fg:#171717;--fg-2:#5c5c5c;--fg-3:#9a9a9a;--primary:#171717;--on-primary:#fff;--focus:#2563eb;--warning:#9a5b07;--success:#1a7f4b;--menu-shadow:0 12px 32px rgb(0 0 0/.12);--bottom-clear:32px}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--surface:#141414;--hover:#1c1c1c;--active:#262626;--border:#262626;--border-strong:#3a3a3a;--fg:#ededed;--fg-2:#a1a1a1;--fg-3:#6e6e6e;--primary:#ededed;--on-primary:#0a0a0a;--focus:#4d8dff;--warning:#e5a54b;--success:#4cc38a;--menu-shadow:0 12px 32px rgb(0 0 0/.5)}}
[data-theme=dark]{--surface:#141414;--hover:#1c1c1c;--active:#262626;--border:#262626;--border-strong:#3a3a3a;--fg:#ededed;--fg-2:#a1a1a1;--fg-3:#6e6e6e;--primary:#ededed;--on-primary:#0a0a0a;--focus:#4d8dff;--warning:#e5a54b;--success:#4cc38a;--menu-shadow:0 12px 32px rgb(0 0 0/.5)}
*{box-sizing:border-box}html{scroll-padding-bottom:calc(env(safe-area-inset-bottom,0px) + var(--bottom-clear))}body{margin:0;background:transparent;color:var(--fg);font:13px/18px -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}main{max-width:960px;margin:0 auto;padding:24px;padding-left:max(24px,env(safe-area-inset-left,0px));padding-right:max(24px,env(safe-area-inset-right,0px));padding-bottom:calc(env(safe-area-inset-bottom,0px) + var(--bottom-clear))}[data-display-mode=fullscreen],[data-fixed-container=true]{--bottom-clear:128px}[hidden]{display:none!important}
h1,h2,h3,p,ul{margin:0}h1{font-size:15px;line-height:20px;font-weight:600;letter-spacing:-.01em;min-width:0;display:flex;align-items:center;flex-wrap:wrap}h2{font-size:13px;line-height:18px;font-weight:600}h3{font-size:13px;line-height:18px;font-weight:500}ul{padding:0;list-style:none}small,.muted,summary{font-size:12px;line-height:16px;color:var(--fg-2)}p{margin:4px 0 12px}.muted{font-size:12px}header{min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}.breadcrumb-separator{color:var(--fg-3);margin:0 8px}.breadcrumb-link{font-size:15px;font-weight:600;color:var(--fg-2);padding:0;min-height:28px;border:0;background:none}.breadcrumb-link:hover{text-decoration:underline}
button,input,select{font:inherit;color:inherit;max-width:100%}button{min-height:28px;padding:4px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;font-size:12px;line-height:18px;font-weight:600;cursor:pointer;transition:background-color 120ms ease-out,border-color 120ms ease-out}button:hover:not(:disabled){background:var(--hover)}button.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary)}button.primary:hover:not(:disabled){opacity:.9;background:var(--primary)}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}input:focus-visible,select:focus-visible{border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 25%,transparent)}label{display:block;margin:12px 0 8px;font-size:12px;font-weight:500;color:var(--fg-2)}input,select{display:block;width:100%;min-width:0;height:32px;padding:6px 10px;margin-top:6px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:400}.dashboard-nav{display:flex;align-items:center}.dashboard-nav button{width:28px;height:28px;padding:0;border:0;background:transparent;color:var(--fg-2);font-size:20px}.dashboard-nav button:hover{background:var(--hover)}.dashboard-grid,.workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.panel{min-width:0}.selection-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:32px}.selection-label{display:flex;align-items:center;gap:8px;flex-shrink:0}.selection-count,.slot-number{font-variant-numeric:tabular-nums;color:var(--fg-2)}.selection-count{font-size:12px}.selection-subtitle{font-size:12px;line-height:16px;color:var(--fg-2);margin:4px 0 0}.save-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:32px;min-width:0}.save-bar p{margin:0;font-size:12px;line-height:16px}.save-bar button{flex-shrink:0}.save-bar button:not(.primary){border:0;color:var(--fg-2)}.saved-note{color:var(--success)}
.slot-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:12px 0 0}.slot-list>li{min-width:0;margin:0}.slot-tile,.slot-add{aspect-ratio:1;border:1px solid var(--border);border-radius:12px;padding:12px}.slot-tile{position:relative;background:var(--surface);display:flex;flex-direction:column;justify-content:space-between;gap:12px}.slot-tile:hover{border-color:var(--border-strong)}.slot-top{display:flex;align-items:center;gap:6px;padding-right:24px}.slot-number{font-size:11px;line-height:14px;font-weight:500}.slot-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere;font-size:13px;line-height:18px;font-weight:600}.slot-provider{display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:12px;line-height:16px;margin-top:4px}.slot-actions{position:absolute;top:8px;right:8px}.slot-actions button{border:0;color:var(--fg-3);min-height:24px;width:24px;padding:0;font-size:18px;letter-spacing:1px}.slot-actions button:hover,.slot-actions button:focus-visible{color:var(--fg)}.slot-empty{display:flex}.slot-add{background:transparent;width:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--fg-2);font-weight:400}.slot-plus{font-size:20px;line-height:20px}.slots[data-drop-active=true] .slot-add{border-color:var(--focus)}.slot-list>li[data-insert=before]{box-shadow:-2px 0 var(--focus)}.slot-list>li[data-insert=after]{box-shadow:2px 0 var(--focus)}.slot-add:hover{background:var(--hover)}
.connection-glyph{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--fg-2)}.connection-glyph svg{display:block;width:16px;height:16px}.connection-initial{border:1px solid currentColor;border-radius:50%;font-size:11px;line-height:16px;font-weight:600}.library-toolbar{display:flex;align-items:center;gap:8px;min-height:32px}.search-wrap{flex:1;min-width:180px;position:relative}.search-wrap:before{content:'⌕';position:absolute;left:10px;top:7px;color:var(--fg-2);font-size:18px;pointer-events:none}.search-wrap label{font-size:0;line-height:0;margin:0}.search-wrap input{margin:0;height:34px;padding-left:30px}.library-segments{display:flex;flex-shrink:0;border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:2px;gap:2px}.library-segments button{border:0;border-radius:6px;padding:4px 10px;font-weight:500;white-space:nowrap;color:var(--fg-2)}.library-segments button[aria-checked=true]{color:var(--fg);background:var(--active)}.model-count{min-height:20px;margin:8px 0 0;font-size:12px;line-height:20px;color:var(--fg-2);display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}.model-count button{padding:0;min-height:20px;border:0;color:var(--fg-2);text-decoration:underline;font-weight:400}.library-group{display:flex;align-items:center;gap:6px;margin:16px 0 4px;color:var(--fg-2);font-size:12px;font-weight:500}.library-group .connection-glyph{width:16px;height:16px}.library-group .connection-glyph svg{width:14px;height:14px}.model-row{display:flex;align-items:center;gap:8px;justify-content:space-between;min-height:36px;border-radius:8px;padding:4px 8px}.model-row:hover{background:var(--hover)}.model-row-text{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.model-row h3{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.model-row small{flex-shrink:0}.model-row button{flex-shrink:0;border:0;min-height:24px;min-width:24px;padding:0 6px;font-size:16px;font-weight:500;color:var(--fg-2)}.model-row button[aria-pressed=true]{background:var(--active);color:var(--fg);font-size:12px;border-radius:6px;min-height:22px}.picker-row button{font-size:18px}.drag-handle{color:var(--fg-3);opacity:0;font-size:12px}.picker-row:hover .drag-handle,.picker-row:focus-within .drag-handle{opacity:1}.unavailable{color:var(--warning)!important}.empty{padding:12px 0;color:var(--fg-2);font-size:12px}.alert{color:var(--warning);font-size:12px;font-weight:500;padding:8px 0}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:16px}.notice{font-size:12px;color:var(--fg-2);margin:0}
.slot-disclosure,.filter-popover{position:absolute;z-index:50;width:260px;max-width:calc(100% - 24px);padding:12px 4px 4px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--menu-shadow);margin:0;animation:menu-in 120ms ease-out}.slot-disclosure h3,.slot-disclosure p,.filter-popover h3{margin:0;padding:0 10px 4px}.slot-disclosure p{font-size:12px;line-height:16px}.slot-disclosure .reasoning-label{font-weight:500}.slot-disclosure button,.filter-popover button{display:block;text-align:left;width:100%;min-height:30px;padding:5px 10px;border:0;border-radius:6px;margin:0;font-size:13px;font-weight:500}.slot-disclosure hr,.filter-popover hr{border:0;border-top:1px solid var(--border);margin:4px 0}.filter-popover input{width:calc(100% - 12px);margin:4px 6px 8px}.slot-disclosure [tabindex]:focus-visible{outline-offset:0}@keyframes menu-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}
.connections{max-width:720px;width:100%;margin:0}.connection-status{font-size:12px;line-height:16px;margin:0 0 12px}.status-ok{color:var(--success)}.detail-group{margin:0 0 8px}.detail-group .detail-row{border-bottom:1px solid var(--border)}.detail-group .detail-row:not(:last-child){border-bottom:0;border-bottom:1px solid var(--border)}.detail-group .detail-row:last-child{border-bottom:1px solid var(--border)}.detail-row.row-action{padding:0}.row-target{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:52px;padding:12px;border:0;border-radius:inherit;background:transparent;text-align:left;font-weight:500}.row-target h3{font-size:13px}.row-chevron-plain{color:var(--fg-3);font-size:14px;line-height:14px}.boundary{margin:8px 0 16px}.connection-group{margin-bottom:24px}.connection-group>h2{font-size:12px;font-weight:500;color:var(--fg-2);margin-bottom:8px}.provider-card{position:relative;background:var(--surface);border:1px solid var(--border);border-bottom:0;padding:12px;min-height:52px}.provider-card:first-of-type{border-radius:12px 12px 0 0}.provider-card:last-of-type{border-bottom:1px solid var(--border);border-radius:0 0 12px 12px}.provider-card:only-of-type{border-radius:12px}.connection-pick{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:8px;align-items:center;width:100%;text-align:left;border:0;border-radius:0;background:none;padding:0 24px 0 0;font-size:13px;line-height:18px;font-weight:500}.connection-pick .connection-glyph{grid-row:1 / 3}.connection-pick small{grid-column:2}.row-chevron{position:absolute;right:12px;top:18px;color:var(--fg-3)}.connect-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.provider-card p{font-size:12px}.provider-card>small{display:block;margin-top:4px}.connection-form{margin:12px 0;padding:0}.connection-form p{font-size:12px}.connection-form>button{margin:12px 8px 0 0}.connection-options{margin:8px 0 0}.detail-row{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--border);border-bottom:0;padding:12px;min-height:52px}.detail-row:first-of-type{border-radius:12px 12px 0 0}.detail-row:last-of-type{border-bottom:1px solid var(--border);border-radius:0 0 12px 12px}.detail-row:only-of-type{border-radius:12px}.detail-row>div{min-width:0}.detail-row small{display:block;margin-top:4px}.detail-row>button{flex-shrink:0}.connection-options>details{margin:16px 0}.connection-options>p{font-size:12px;margin-top:8px}.endpoint{font-size:12px}.technical{margin-top:24px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--fg-2)}.technical h2{font-size:12px;margin:12px 0 4px}.technical li{margin:4px 0}.mark{display:inline-block;width:20px}.next{font-size:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(min-width:600px) and (max-width:959px){main{padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}.slot-list{grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}}
@media(max-width:599px){main{padding:12px;padding-bottom:calc(env(safe-area-inset-bottom,0px) + var(--bottom-clear));padding-left:max(12px,env(safe-area-inset-left,0px));padding-right:max(12px,env(safe-area-inset-right,0px))}header{min-height:40px}.slot-list{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}.library-toolbar{flex-wrap:wrap}.search-wrap{flex-basis:100%;min-width:0}.library-segments{width:100%}.library-segments button{flex:1}.save-bar{gap:4px}.save-bar .draft-note{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.save-bar button{padding:4px 8px}.picker-row .model-row-text{flex-wrap:wrap;gap:4px}.picker-row .model-row-text small{width:100%;padding-left:28px}.model-row-text>.unavailable{flex-shrink:1;font-size:11px}.model-count{font-size:11px}.selection-heading{gap:4px}.saved-note{font-size:11px!important;max-width:170px}.breadcrumb-link{font-size:13px}.breadcrumb-separator{margin:0 4px}h1{font-size:13px}}
@media(max-width:359px){.slot-list{grid-template-columns:repeat(2,minmax(0,1fr))}.slot-tile,.slot-add{padding:10px}.slot-top{padding-right:16px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media(prefers-contrast:more){.slot-tile,.slot-add,.provider-card,.detail-row,button,input,select,.library-segments,.slot-disclosure,.filter-popover{border:1px solid currentColor;box-shadow:none}}
@media(forced-colors:active){:root{--surface:Canvas;--hover:Canvas;--active:Highlight;--fg:CanvasText;--fg-2:CanvasText;--fg-3:CanvasText;--border:CanvasText;--focus:Highlight;--warning:CanvasText;--primary:ButtonFace;--on-primary:ButtonText}.connection-glyph{color:CanvasText}button{border:1px solid ButtonText}.library-segments button[aria-checked=true]{color:HighlightText}}
</style></head><body><main id="app"><p id="announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
<header id="page-header"><h1 id="page-title">Model Bridge</h1><div id="header-actions"></div></header>
<p class="alert" id="alert" role="status" aria-live="polite">Loading Model Bridge…</p>
<noscript><p>This view needs scripts; nothing has been checked.</p></noscript>
<section id="controls" aria-label="Bridge dashboard"></section>
<details id="technical" class="technical"><summary>Diagnostics</summary>
<p class="next" id="next"></p><ul id="facts"></ul><small>Observed means reported by the plugin server for this request. Unknown is not a failure.</small>
<h2>Capabilities and scope</h2><p class="muted">Slots curate model visibility, not permissions or hardware. Existing chats stay available. Custom-provider queues and cross-provider switches in existing chats remain limited; ordinary launch still requires the startup helper.</p>
<ul id="status"></ul><ul id="meta"></ul>
<p class="muted">The default unbound view reads no Bridge installation, settings, processes or chats and changes nothing. Explicitly bound controls act only on their declared store. A discovered catalog does not prove authentication, tool support, inference compatibility or native picker refresh.</p></details>
<script>${appScript}</script>
</main></body></html>`;
export const homeHtml = () => homeShell;
export { appScript };

// Minimal MCP over newline-delimited JSON-RPC on stdio. The default entrypoint
// has no binding or writable tools. The explicit test entrypoint injects only
// the pinned, synthetic controller; UI arguments can never select a path.
const tool = { name: 'bridge_home', title: 'Model Bridge Home',
  description: 'Show Model Bridge Home: this plugin connection, and what this view cannot confirm (the installed Bridge, Claude in this Codex app, chat history), with one next step. Read-only; reads no Bridge files.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  // The entrypoints only declare where Home may be offered; they do not show that a host does.
  _meta: { ui: { resourceUri: homeResource }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } };

// MCP versions whose tool fields used here (title, structuredContent) exist;
// a client asking for another version is offered the newest.
export const protocolVersions = ['2025-11-25', '2025-06-18'];
const validId = id => typeof id === 'string' || Number.isSafeInteger(id);
// Request and notification params: absent, or an object whose optional _meta is an object.
const validParams = params => params === undefined || (isObject(params) && (params._meta === undefined || isObject(params._meta)));
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// One stdio connection. It counts as connected only after a valid initialize
// was answered and the client confirmed it with notifications/initialized.
export function session(observe = observeHome, controls = null) {
  let phase = 'new';
  const home = controlState => {
    const value = observe({ connected: phase === 'connected' });
    if (!controls || phase !== 'connected') return value;
    try { return { ...value, controls: controlState ?? controls.snapshot(), next: controls.message ?? 'These controls apply only to the declared synthetic test store. Native activation, sign-in and model execution are unverified.' }; }
    catch { return { ...value, controls: null, bindingError: 'The declared test binding cannot be verified. No controls are available.' }; }
  };
  const render = format => { try { return format(home()); } catch { return null; } };
  const controlProperties = { bindingId: { type: 'string', pattern: '^[a-f0-9]{32}$' }, profileId: { type: 'string', pattern: '^[a-f0-9]{32}$' }, bridgeId: { type: 'string', pattern: '^[a-f0-9]{32}$' } };
  const controlDefinitions = controls?.definitions ?? [
    ['status', {}, 'Read the declared synthetic test connection.'],
    ['enabled', { revision: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' } }, 'Enable or disable new Claude work in the declared test store.'],
    ['refresh', { revision: { type: 'integer', minimum: 0 } }, 'Discover/refresh the synthetic fixture catalog; no real SDK or model call.'],
    ['visible', { revision: { type: 'integer', minimum: 0 }, visible: { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 64, uniqueItems: true }] } }, 'Choose visible Claude fixture models in the declared test store.'],
  ];
  const prefix = controls?.prefix ?? 'bridge_connection_';
  const controlTools = controlDefinitions.map(([action, properties, description, openWorld = false]) => ({ name: prefix + action, description,
    inputSchema: { type: 'object', properties: { ...controlProperties, ...properties }, required: [...Object.keys(controlProperties), ...Object.keys(properties)], additionalProperties: false },
    annotations: { readOnlyHint: action === 'status', destructiveHint: false, openWorldHint: openWorld, idempotentHint: action === 'status' },
    _meta: { ui: { visibility: ['app'] } } }));
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
    if (method === 'tools/list') return reply({ tools: [tool, ...(controls ? controlTools : [])] });
    if (method === 'tools/call') {
      const action = controlDefinitions.find(([name]) => params?.name === prefix + name)?.[0];
      if (action) {
        if (!controls || phase !== 'connected') return failure(id, -32600, 'No initialized synthetic test binding');
        return Promise.resolve().then(() => controls.call(action, params.arguments)).then(controlState => {
          const value = home(controlState);
          return reply({ content: [{ type: 'text', text: controls.message ?? 'Synthetic test connection updated/read. Native profile, authentication and inference remain unverified.' }], structuredContent: value });
        }).catch(error => {
          const code = ['invalid_request', 'wrong_scope', 'binding_invalid', 'store_unavailable', 'stale_revision', 'invalid', 'no_catalog', 'locked', 'generation_exhausted', 'catalog_invalid', 'catalog_timeout', 'catalog_failed', 'catalog_auth_required', 'catalog_rate_limited', 'catalog_unreachable', 'catalog_protocol_unsupported', 'endpoint_invalid', 'provider_invalid', 'provider_exists', 'credential_endpoint_mismatch', 'secret_storage_unavailable', 'free_model_required', 'auth_expired', 'auth_cancelled', 'auth_denied', 'auth_rate_limited', 'auth_unreachable', 'auth_timeout', 'harness_not_qualified', 'harness_runtime_not_found'].includes(error.code) ? error.code : 'action_failed';
          return reply({ isError: true, content: [{ type: 'text', text: `Action not confirmed (${code}). Read the current test state before trying again.` }], structuredContent: { error: code } });
        });
      }
      if (params?.name !== tool.name) return failure(id, -32602, 'Unknown tool');
      const result = render(home => ({ content: [{ type: 'text', text: homeText(home) }], structuredContent: home }));
      return result ? reply(result) : failure(id, -32603, 'Home could not be observed');
    }
    if (method === 'resources/list') return reply({ resources: [{ uri: homeResource, name: 'Model Bridge Home', mimeType: appMimeType, _meta: uiMeta }] });
    if (method === 'resources/read') {
      if (params?.uri !== homeResource) return failure(id, -32602, 'Unknown resource');
      return reply({ contents: [{ uri: homeResource, mimeType: appMimeType, text: homeHtml(), _meta: uiMeta }] });
    }
    return failure(id, -32601, 'Method not found');
  };
}

// The plugin cache may reach this file through a symlink.
export function serveSession(handle) {
  const write = response => { if (response) process.stdout.write(JSON.stringify(response) + '\n'); };
  createInterface({ input: process.stdin }).on('line', line => {
    let message, response;
    try {
      const bytes = Buffer.byteLength(line);
      if (bytes > 4 * 1024 * 1024 + 65536) throw new Error();
      message = JSON.parse(line);
      // Only the bounded multi-model slot setting needs a larger envelope.
      // All other methods keep their existing 64KiB input bound.
      if (bytes > 65536 && !(message?.method === 'tools/call' && message.params?.name === 'bridge_provider_slots')) throw new Error();
    } catch { response = failure(null, -32700, 'Parse error'); }
    if (!response) try { response = handle(message); } catch { response = failure(validId(message?.id) ? message.id : null, -32603, 'Internal error'); }
    if (response && typeof response.then === 'function') response.then(write).catch(() => write(failure(validId(message?.id) ? message.id : null, -32603, 'Internal error')));
    else write(response);
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) serveSession(session());
