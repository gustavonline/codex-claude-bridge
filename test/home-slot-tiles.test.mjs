import test from 'node:test';
import assert from 'node:assert/strict';
import { homeHtml } from '../plugins/codex-claude/home/server.mjs';
import { harness, hostReply, handshakeId, toolResult, sample } from './support/home-host.mjs';

// Public, in-memory UI fixture only: no registry, SDK, endpoint, filesystem or model.
// These assertions execute the actual shipped script for the approved In picker / All models design.
const nodes = n => [n, ...n.children.flatMap(nodes)];
const everything = h => [...nodes(h.elements['page-title']), ...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)];
const find = (h, label) => everything(h).find(n => n.tag === 'button' && (n.getAttribute('aria-label') === label || n.textContent === label));
function click(h, label) {
  if (label === 'Close model options') { h.sandbox.document.listeners.keydown.forEach(fn => fn({ type: 'keydown', key: 'Escape' })); return; }
  let b = find(h, label);
  if (!b && label.startsWith('Remove from picker:')) { const trigger = 'Options for ' + label.slice('Remove from picker:'.length); click(h, trigger); b = find(h, 'Remove from picker'); }
  assert.ok(b, label); assert.equal(b.disabled, false); b.focus(); for (const fn of b.listeners.click ?? []) fn({});
}
const named = (h, name) => everything(h).find(n => n.getAttribute('aria-label') === name);
const tiles = h => named(h, 'Models in picker').children;
const occupiedTiles = h => tiles(h).filter(n => n.className === 'slot-tile');
const numberOf = tile => tile.children[0].children[1].textContent;
const nameOf = tile => tile.children[1].children[0].textContent;
const subtitleOf = tile => tile.children[1].children[1].textContent;
function data(count = 7, selected = count) {
  const providers = ['a', 'b'].map((letter, provider) => ({ id: letter.repeat(32), name: 'Fixture provider ' + (provider + 1),
    baseUrl: 'https://fixture-' + letter + '.example.invalid/v1', protocol: 'responses', enabled: true, selected: null, catalogState: 'fresh', models: [] }));
  const models = Array.from({ length: count }, (_, i) => ({ id: 'bridge-responses/' + providers[i % 2].id + '/' + Buffer.from('model-' + i).toString('base64url'), name: 'Model ' + (i + 1) }));
  models.forEach((m, i) => providers[i % 2].models.push(m));
  return sample({ controls: { kind: 'responses-trial', bindingId: 'c'.repeat(32), profileId: 'd'.repeat(32), bridgeId: 'e'.repeat(32),
    revision: 10, focusedProvider: null, providers, authReferences: [], slots: { revision: 1, models: models.slice(0, selected).map(m => m.id) } } });
}
function ui(value, host = {}) { const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} }, ...host })); h.deliver(toolResult(value)); return h; }
const ids = value => value.controls.providers.flatMap(p => p.models).map(m => m.id);
const answer = (h, request, value) => h.deliver({ jsonrpc: '2.0', id: request.id, result: { structuredContent: value } });
const menu = h => named(h, 'Model options');

test('an empty picker has one Add tile above the library, without persisted empty positions or tool calls', () => {
  const h = ui(data(7, 0)), workspace = everything(h).find(n => n.className === 'workspace');
  assert.deepEqual(workspace.children.map(n => n.getAttribute('aria-label')), ['In picker', 'Model library']);
  assert.equal(tiles(h).length, 1); assert.ok(tiles(h).every(n => n.className === 'slot-empty'));
  assert.equal(h.sent('tools/call').length, 0); assert.equal(find(h, 'Save'), undefined);
  assert.match(h.text('controls'), /No models selected\. Add at least one available model before saving\./);
  assert.ok(!nodes(named(h, 'Models in picker')).some(n => n.id === 'search'), 'search is not inside the tile grid');
  assert.ok(!nodes(named(h, 'Discovered models')).some(n => n.id === 'search'), 'search is not inside the scrolling-free list');
});

test('seven selections all render numbered with glyph, connection and full accessible names, plus the single Add tile', () => {
  const value = data(), long = 'A very long synthetic model name ' + 'readable '.repeat(25);
  value.controls.providers[0].models[0].name = long;
  const h = ui(value), occupied = occupiedTiles(h);
  assert.equal(occupied.length, 7); assert.equal(tiles(h).length, 8);
  assert.deepEqual(occupied.map(numberOf), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(occupied[0].getAttribute('aria-label'), 'Position 1: ' + long + ' from Fixture provider 1');
  assert.equal(occupied[0].getAttribute('title'), long + ' — Fixture provider 1');
  assert.equal(nameOf(occupied[0]), long); assert.equal(subtitleOf(occupied[0]), 'Fixture provider 1');
  assert.equal(occupied[0].children[0].children[0].className.includes('connection-glyph'), true); assert.equal(occupied[0].children[0].children[0].getAttribute('aria-hidden'), 'true');
  assert.ok(find(h, 'Options for Model 7 from Fixture provider 1')); assert.ok(find(h, 'Add model: browse all models'));
  assert.match(h.text('controls'), /In picker7/, 'the count sits beside the heading');
});

test('the Add tile switches to All models, focuses the existing search and preserves the unsaved search text without writes', () => {
  const h = ui(data(7, 2)); click(h, 'In picker');
  const search = everything(h).find(n => n.id === 'search'); search.value = 'Model'; search.listeners.input.forEach(fn => fn({}));
  click(h, 'Add model: browse all models');
  assert.equal(h.sandbox.document.activeElement.id, 'search'); assert.equal(h.sandbox.document.activeElement.value, 'Model');
  assert.deepEqual(['All models', 'In picker'].map(l => find(h, l).getAttribute('aria-checked')), ['true', 'false']);
  assert.equal(occupiedTiles(h).length, 2); assert.equal(h.sent('tools/call').length, 0);
});

test('tile remove and library Add keep a draft through theme/render changes; explicit Save sends only model IDs and a revision', () => {
  const value = data(), h = ui(value), original = structuredClone(value);
  click(h, 'Remove from picker:Model 2 from Fixture provider 2');
  assert.equal(occupiedTiles(h).length, 6);
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark', displayMode: 'fullscreen' } });
  assert.match(h.text('controls'), /Unsaved/); assert.equal(h.root.attributes['data-theme'], 'dark'); assert.equal(h.root.attributes['data-display-mode'], 'fullscreen');
  click(h, 'Add Model 2 from Fixture provider 2 to picker');
  assert.equal(h.sent('tools/call').length, 0); click(h, 'Save');
  const request = h.sent('tools/call').at(-1);
  assert.equal(request.params.name, 'bridge_provider_slots'); assert.equal(request.params.arguments.slotsRevision, 1);
  assert.equal(request.params.arguments.models.length, 7); assert.equal(new Set(request.params.arguments.models).size, 7);
  assert.ok(request.params.arguments.models.every(id => ids(value).includes(id))); assert.deepEqual(value, original);
  assert.ok(nodes(named(h, 'Models in picker')).filter(n => n.tag === 'button').every(n => n.disabled), 'a pending save disables local tile actions too');
  assert.equal(find(h, 'Save') ?? find(h, 'Saving…') ? true : false, true);
});

test('cancelled Save hides uncertain facts, ignores a late reply and automatically restores tiles after same-scope status without replay', () => {
  const value = data(), h = ui(value); click(h, 'Remove from picker:Model 2 from Fixture provider 2'); click(h, 'Save');
  const save = h.sent('tools/call').at(-1), committed = structuredClone(value);
  committed.controls.revision++; committed.controls.slots.revision++; committed.controls.slots.models = save.params.arguments.models;
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' }); answer(h, save, committed);
  assert.equal(h.sent('tools/call').length, 1); assert.equal(named(h, 'Models in picker'), undefined);
  h.advance(0);
  const status = h.sent('tools/call').at(-1); assert.equal(status.params.name, 'bridge_provider_status'); answer(h, status, committed);
  assert.equal(occupiedTiles(h).length, 6);
  assert.equal(h.sent('tools/call').filter(r => r.params.name === 'bridge_provider_slots').length, 1);
});

test('known-ID drop gets a clear target state, changes only the draft and rejects foreign/disabled models with no write', () => {
  const value = data(7, 0); value.controls.providers[1].enabled = false;
  const h = ui(value), section = () => named(h, 'In picker');
  const transfer = { value: value.controls.providers[0].models[0].id, getData(type) { assert.equal(type, 'text/plain'); return this.value; } };
  let prevented = false; section().listeners.dragover[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(section().getAttribute('data-drop-active'), 'true');
  section().listeners.dragleave[0]({}); assert.equal(section().getAttribute('data-drop-active'), 'false');
  section().listeners.drop[0]({ dataTransfer: transfer, preventDefault() {} });
  assert.equal(occupiedTiles(h).length, 1); assert.equal(section().getAttribute('data-drop-active'), 'false');
  for (const id of [transfer.value, value.controls.providers[1].models[0].id, 'https://foreign.example.invalid', '/not-a-model']) {
    transfer.value = id; section().listeners.drop[0]({ dataTransfer: transfer, preventDefault() {} });
  }
  assert.equal(occupiedTiles(h).length, 1); assert.equal(h.sent('tools/call').length, 0);
  const target = section(); h.deliver({ jsonrpc: '2.0', method: 'ui/resource-teardown', id: 'closed' });
  target.listeners.drop[0]({ dataTransfer: transfer, preventDefault() {} }); assert.equal(h.sent('tools/call').length, 0);
});

test('unavailable and hostile model labels stay inert and readable in tiles, without claiming picker availability', () => {
  const value = data(2); value.controls.providers[0].catalogState = 'stale'; value.controls.providers[0].models[0].name = '<script>not-code</script>';
  const h = ui(value), tile = occupiedTiles(h)[0]; assert.equal(nameOf(tile), '<script>not-code</script>'); assert.equal(subtitleOf(tile), '! Unavailable');
  assert.equal(tile.children[1].children[1].className.includes('unavailable'), true);
  assert.equal(h.created.some(n => n.tag === 'script' || n.tag === 'img'), false);
  assert.match(tile.getAttribute('aria-label'), /<script>not-code/); assert.ok(find(h, 'Options for <script>not-code</script> from Fixture provider 1'));
  assert.match(h.text('controls'), /Unavailable until refresh/, 'the library row says so too');
});

test('shipped CSS: square 140px tiles, responsive wrapping, focus and drop states, one scroll surface and no vh, fixed or inner-scroll boxes', () => {
  const html = homeHtml(), css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(css, /\.slot-list\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(140px,1fr\)\)/); assert.match(css, /\.slot-tile,\.slot-add\{aspect-ratio:1;/);
  assert.match(css, /minmax\(132px,1fr\)/); assert.match(css, /minmax\(120px,1fr\)/); assert.match(css, /@media\(max-width:359px\)\{\.slot-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:599px\)/); assert.match(css, /@media\(min-width:600px\) and \(max-width:959px\)/);
  assert.match(css, /\.slots\[data-drop-active=true\]/); assert.match(css, /:focus-visible/); assert.match(css, /outline:2px solid var\(--focus\)/); assert.match(css, /-webkit-line-clamp:2/);
  assert.doesNotMatch(css, /position:fixed/, 'nothing is pinned to the viewport'); assert.doesNotMatch(css, /overflow(-y)?:(auto|scroll)/, 'no inner scroll box');
  assert.doesNotMatch(css, /max-height|overscroll-behavior|[0-9.]v[hw]\b|svh|dvh|lvh/, 'no viewport-based or capped heights');
  assert.match(css, /main\{max-width:960px;margin:0 auto;[^}]*padding-bottom:calc\(env\(safe-area-inset-bottom,0px\) \+ var\(--bottom-clear\)\)/); assert.match(css, /html\{scroll-padding-bottom:calc\(env\(safe-area-inset-bottom,0px\) \+ var\(--bottom-clear\)\)/);
  assert.match(css, /--bottom-clear:32px/); assert.match(css, /\[data-display-mode=fullscreen\],\[data-fixed-container=true\]\{--bottom-clear:128px\}/);
  assert.match(css, /\.slot-disclosure,\.filter-popover\{position:absolute/); assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /prefers-contrast:more/); assert.match(css, /forced-colors:active/);
  assert.match(css, /--surface:#f6f6f6/); assert.match(css, /--surface:#141414/); assert.match(css, /--focus:#2563eb/); assert.match(css, /--focus:#4d8dff/);
  assert.doesNotMatch(css, /@font-face|backdrop-filter|\.panel\{[^}]*blur/); assert.doesNotMatch(css, /--soft|--accent/);
  assert.match(html, /slotsDraft\.models\.length/); assert.doesNotMatch(html, /slotsDraft\.models\.slice\(0, 5\)/);
});

test('long names use a bounded text area and a usable full-name menu without changing tile geometry', () => {
  const value = data(1), long = 'example-instruct-long-model-name-64k-preview:latest'; value.controls.providers[0].models[0].name = long;
  const h = ui(value), label = long + ' from Fixture provider 1';
  click(h, 'Options for ' + label);
  assert.ok(menu(h)); assert.equal(menu(h).getAttribute('role'), 'dialog'); assert.ok(menu(h).textContent.includes(long)); assert.ok(menu(h).textContent.includes('via Fixture provider 1'));
  assert.equal(h.sandbox.document.activeElement.textContent, long);
  assert.equal(find(h, 'Options for ' + label).getAttribute('aria-expanded'), 'true');
  assert.ok(find(h, 'Remove from picker')); assert.ok(find(h, 'Move earlier').disabled && find(h, 'Move later').disabled, 'a lone model cannot move'); assert.equal(h.sent('tools/call').length, 0);
  click(h, 'Close model options'); assert.equal(menu(h), undefined);
  assert.equal(h.sandbox.document.activeElement.getAttribute('aria-label'), 'Options for ' + label, 'Escape returns focus to the trigger');
});

test('two absent saved model IDs have distinguishable visible names, and the accessible labels name their connections', () => {
  const value = data(0, 0), missing = ['gone-alpha', 'gone-beta'].map(m => 'bridge-responses/' + 'a'.repeat(32) + '/' + Buffer.from(m).toString('base64url'));
  value.controls.slots.models = missing;
  const h = ui(value), occupied = occupiedTiles(h); assert.equal(occupied.length, 2);
  assert.equal(nameOf(occupied[0]), 'gone-alpha'); assert.equal(nameOf(occupied[1]), 'gone-beta'); assert.ok(occupied.every(t => subtitleOf(t) === '! Unavailable'));
  occupied.forEach((tile, i) => { const trigger = nodes(tile).find(n => n.tag === 'button'); click(h, trigger.getAttribute('aria-label')); assert.match(menu(h).textContent, /Unavailable until its connection is refreshed\./); click(h, 'Close model options'); });
  assert.equal(h.sent('tools/call').length, 0, 'the menu never mutates or refreshes the store');
  // Equal slugs under different connections: the visible line is the shared "! Unavailable", the accessible name keeps them apart.
  const equalNames = data(0, 0);
  equalNames.controls.slots.models = ['a', 'b'].map(p => 'bridge-responses/' + p.repeat(32) + '/' + Buffer.from('same-model').toString('base64url'));
  const pair = occupiedTiles(ui(equalNames));
  assert.deepEqual(pair.map(t => t.getAttribute('aria-label')), ['Position 1: same-model from Fixture provider 1', 'Position 2: same-model from Fixture provider 2']);
});

test('positional drop reorders existing models in the draft and saves the explicit order once', () => {
  const value = data(3), h = ui(value), initial = value.controls.slots.models, occupied = occupiedTiles(h);
  occupied[0].listeners.dragover[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(occupied[0].getAttribute('data-insert'), 'before');
  named(h, 'In picker').listeners.drop[0]({ preventDefault() {}, dataTransfer: { getData() { return initial[2]; } } });
  assert.equal(h.sent('tools/call').length, 0); click(h, 'Save');
  assert.deepEqual(h.sent('tools/call').at(-1).params.arguments.models, [initial[2], initial[0], initial[1]]);
});

test('Move earlier and Move later reorder the draft, announce the change and keep focus on the same action', () => {
  const value = data(3), h = ui(value), initial = value.controls.slots.models;
  click(h, 'Options for Model 1 from Fixture provider 1'); assert.ok(find(h, 'Move earlier').disabled, 'the first model cannot move earlier');
  click(h, 'Move later');
  assert.deepEqual(occupiedTiles(h).map(nameOf), ['Model 2', 'Model 1', 'Model 3']); assert.equal(h.elements.announcement.textContent, 'Model 1 moved to position 2.');
  assert.equal(h.sandbox.document.activeElement.getAttribute('data-focus-key'), 'move-later'); assert.equal(h.sent('tools/call').length, 0);
  click(h, 'Save'); assert.deepEqual(h.sent('tools/call').at(-1).params.arguments.models, [initial[1], initial[0], initial[2]]);
});

test('the segmented control is a keyboard radio group: arrows and Home/End move between All models and In picker', () => {
  const h = ui(data(3)), group = named(h, 'Models shown'); assert.equal(group.getAttribute('role'), 'radiogroup');
  const key = (label, name) => find(h, label).listeners.keydown.forEach(fn => fn({ key: name, preventDefault() {} }));
  assert.deepEqual(['All models', 'In picker'].map(l => [find(h, l).getAttribute('role'), find(h, l).tabIndex]), [['radio', 0], ['radio', -1]]);
  key('All models', 'ArrowRight'); assert.deepEqual(['All models', 'In picker'].map(l => find(h, l).getAttribute('aria-checked')), ['false', 'true']);
  assert.equal(h.sandbox.document.activeElement.getAttribute('data-focus-key'), 'view-picker');
  key('In picker', 'ArrowLeft'); assert.equal(find(h, 'All models').getAttribute('aria-checked'), 'true');
  key('All models', 'End'); assert.equal(find(h, 'In picker').getAttribute('aria-checked'), 'true'); key('In picker', 'Home'); assert.equal(find(h, 'All models').getAttribute('aria-checked'), 'true');
});

test('reasoning text describes only advertised levels and the default, never an invented Medium or High', () => {
  const value = data(4, 4);
  const withCaps = (provider, index, caps, name) => { provider.models[index].capabilities = caps; if (name) provider.models[index].name = name; };
  value.controls.providers[0].protocol = 'native'; value.controls.providers[0].id = '0'.repeat(31) + '1'; value.controls.providers[0].kind = 'native'; value.controls.providers[0].baseUrl = ''; value.controls.providers[0].name = 'Codex / GPT';
  value.controls.slots.models = ids(value);
  withCaps(value.controls.providers[0], 0, { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'high' });
  value.controls.providers[1].baseUrl = 'https://openrouter.ai/api/v1';
  withCaps(value.controls.providers[1], 0, { supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'medium' }, 'listed/model');
  withCaps(value.controls.providers[1], 1, undefined, 'openrouter/free');
  const open = (label, v = value) => { const h = ui(v); click(h, 'Options for ' + label); return menu(h).textContent; };
  const gptText = open('Model 1 from Codex / GPT');
  assert.match(gptText, /Reasoning levels · Low, Medium, High, Extra high · default High/); assert.match(gptText, /Levels are chosen per chat in Codex\./);
  assert.match(open('listed/model from Fixture provider 2'), /Reasoning levels · Low, Medium, High · default Medium.*Levels are chosen per chat in Codex\./);
  const dynamic = open('openrouter/free from Fixture provider 2');
  assert.match(dynamic, /Reasoning levels · none listed/); assert.doesNotMatch(dynamic, /Medium/);
  assert.match(dynamic, /OpenRouter can pick a different model for each request, so it lists no levels\. If a level is chosen in Codex, it’s passed to OpenRouter, which may ignore it\./);
  const other = data(1, 1); const text = open('Model 1 from Fixture provider 1', other);
  assert.match(text, /Reasoning levels · none listed/); assert.match(text, /This endpoint’s model list doesn’t include reasoning levels\. If a level is chosen in Codex, it’s passed to the endpoint, which may ignore it\./); assert.doesNotMatch(text, /Medium|High/);
});

test('advertised capabilities are bounded and validated: oversized or malformed reasoning data makes the whole result unusable', () => {
  const bad = [
    caps => { caps.supportedReasoningEfforts = Array.from({ length: 17 }, () => ({ reasoningEffort: 'low' })); },
    caps => { caps.supportedReasoningEfforts = [{ reasoningEffort: 'x'.repeat(33) }]; },
    caps => { caps.supportedReasoningEfforts = 'high'; },
    caps => { caps.supportedReasoningEfforts = [null]; },
    caps => { caps.defaultReasoningEffort = 7; },
  ];
  for (const mutate of bad) {
    const value = data(2, 2), caps = {}; mutate(caps); value.controls.providers[0].models[0].capabilities = caps;
    const h = ui(value); assert.equal(occupiedTiles_safe(h), 0); assert.match(h.text('controls'), /Connection setup is not available here/);
  }
  const ok = data(2, 2); ok.controls.providers[0].models[0].capabilities = { supportedReasoningEfforts: Array.from({ length: 16 }, () => ({ reasoningEffort: 'low' })), defaultReasoningEffort: null };
  assert.equal(occupiedTiles(ui(ok)).length, 2);
  function occupiedTiles_safe(h) { const list = named(h, 'Models in picker'); return list ? list.children.length : 0; }
});

test('with 68 library models the last row and the last tile menu are rendered, enabled and keyboard reachable, and menus anchor to their trigger', () => {
  const value = data(68, 12), h = ui(value);
  const rows = nodes(h.elements.controls).filter(n => /(^| )model-row( |$)/.test(n.className)); assert.equal(rows.length, 68);
  const lastAdd = nodes(rows.at(-1)).find(n => n.tag === 'button'); assert.equal(lastAdd.disabled, false); assert.equal(lastAdd.getAttribute('aria-pressed'), 'false');
  assert.equal(nodes(rows.at(-1)).filter(n => n.tag === 'button').length, 1);
  click(h, 'Options for Model 12 from Fixture provider 2'); assert.ok(menu(h)); assert.equal(menu(h).getAttribute('data-floating'), 'slot');
  assert.ok(everything(h).filter(n => n.id === 'slot-disclosure').length === 1, 'one menu at a time');
  assert.equal(find(h, 'Options for Model 12 from Fixture provider 2').getAttribute('aria-controls'), 'slot-disclosure');
  assert.equal(h.sent('tools/call').length, 0);
});

test('the gear opens Connections, the breadcrumb returns, and no Done, X or reset control exists anywhere', () => {
  const h = ui(data(3)), gear = find(h, 'Connections'); assert.ok(gear); assert.equal(gear.getAttribute('aria-expanded'), 'false'); assert.equal(h.text('page-title'), 'Model Bridge');
  click(h, 'Connections'); assert.equal(h.text('page-title'), 'Model Bridge/Connections'); assert.equal(find(h, 'Return to models').textContent, 'Model Bridge');
  const labels = everything(h).filter(n => n.tag === 'button').map(n => (n.getAttribute('aria-label') ?? n.textContent));
  assert.ok(!labels.some(l => /^(Done|×|✕|X|Close)$/.test(l)), 'no Done or X');
  click(h, 'Return to models'); assert.equal(h.text('page-title'), 'Model Bridge');
  const all = everything(h).filter(n => n.tag === 'button').map(n => (n.getAttribute('aria-label') ?? n.textContent).toLowerCase());
  assert.ok(!all.some(l => l.includes('reset')), 'reset stays out until BG4 is fixed'); assert.doesNotMatch(homeHtml(), /Reset (the )?picker|resetPicker|reset: true/);
});
