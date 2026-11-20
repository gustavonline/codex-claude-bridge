import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, hostReply, handshakeId, toolResult, sample } from './support/home-host.mjs';
import { homeHtml } from '../plugins/codex-claude/home/server.mjs';
const nodes = n => [n, ...n.children.flatMap(nodes)];
// Everything the view renders: the page title (breadcrumbs), the header actions (gear) and the controls.
const everything = h => [...nodes(h.elements['page-title']), ...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)];
const find = (h, key) => everything(h).find(n => n.getAttribute('data-focus-key') === key);
function click(h, key) { const n = find(h, key); assert.ok(n, key); assert.equal(n.disabled, false, key); n.focus(); n.listeners.click.forEach(f => f({})); }
function change(h, key, value) { const n = find(h, key); n.value = value; n.focus(); (n.listeners[n.tag === 'select' ? 'change' : 'input'] ?? []).forEach(f => f({})); }
const library = h => nodes(h.elements.controls).filter(n => /(^| )model-row( |$)/.test(n.className));
const last = h => h.sent('tools/call').at(-1);
const answer = (h, req, value) => h.deliver({ jsonrpc: '2.0', id: req.id, result: { structuredContent: value } });
function data() { return sample({ controls: {
  kind: 'responses-trial', bindingId: 'a'.repeat(32), profileId: 'b'.repeat(32), bridgeId: 'c'.repeat(32), revision: 4,
  slots: { revision: 1, models: ['native-model'], scope: 'all', catalogRevision: 1 }, focusedProvider: null,
  pickerRefresh: { requested: 0, observed: 0, kind: 'native' },
  auth: { phase: 'idle', storageAvailable: true, authorizationUrl: null, error: null },
  authReferences: [{ id: 'native_' + 'f'.repeat(32), baseUrl: 'https://openrouter.ai/api/v1' }],
  providers: [
    { id: '00000000000000000000000000000001', kind: 'native', protocol: 'native', name: 'Codex / GPT', baseUrl: '', enabled: true, selected: null, catalogState: 'fresh', models: [{ id: 'native-model', name: 'Same model' }] },
    { id: 'd'.repeat(32), protocol: 'responses', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', authRef: 'native_' + 'f'.repeat(32), enabled: true, freeOnly: true, selected: null, catalogState: 'fresh', models: [{ id: 'router-free', name: 'Same model' }, { id: 'router-paid', name: 'Paid model', available: false }] }
  ]
} }); }
function ui(v = data()) { const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {}, openLinks: {} } })); h.deliver(toolResult(v)); return h; }

test('Home presents every connection in one All models library with a two-option switch; settings and diagnostics are secondary; Save appears only for a draft', () => {
  const h = ui(); assert.equal(library(h).length, 3); assert.equal(find(h, 'save-slots'), undefined);
  assert.equal(find(h, 'begin-auth'), undefined); assert.equal(find(h, 'add-connection'), undefined); assert.equal(h.elements.technical.hidden, true);
  assert.equal(find(h, 'filters'), undefined, 'the filter button and popover are gone');
  assert.deepEqual(['view-all', 'view-picker'].map(k => find(h, k).getAttribute('aria-checked')), ['true', 'false']);
  change(h, 'search', 'openrouter'); assert.equal(library(h).length, 2); assert.match(h.text('controls'), /2 of 3 match “openrouter”/);
  change(h, 'search', 'paid'); assert.equal(library(h).length, 1); assert.match(h.text('controls'), /Unavailable until refresh/);
  change(h, 'search', 'openrouter'); click(h, 'view-picker'); assert.equal(library(h).length, 0, 'In picker lists only the saved selection; the saved model is not an OpenRouter one');
  change(h, 'search', ''); assert.equal(library(h).length, 1); assert.match(h.text('controls'), /1 in picker/);
  click(h, 'view-all'); change(h, 'search', 'openrouter');
  click(h, 'settings'); assert.ok(find(h, 'add-connection')); assert.equal(h.elements.technical.hidden, false); assert.equal(h.text('page-title'), 'Model Bridge/Connections');
  click(h, 'settings'); assert.equal(find(h, 'search').value, 'openrouter', 'the search draft survives opening Connections and returning');
  change(h, 'search', ''); click(h, 'library-router-free'); assert.ok(find(h, 'save-slots'));
  assert.equal(h.sent('tools/call').length, 0, 'local edits do not refresh a network catalog');
});

test('status is automatically read on open and during sign-in; an unchanged read preserves DOM focus and drafts', () => {
  const v = data(), h = ui(v); change(h, 'search', 'same'); const search = find(h, 'search');
  h.advance(0); const req = last(h); assert.equal(req.params.name, 'bridge_provider_status'); assert.equal(req.params.arguments.profileId, v.controls.profileId);
  answer(h, req, v); assert.equal(find(h, 'search'), search); assert.equal(h.sandbox.document.activeElement, search);
  h.advance(9999); assert.equal(h.sent('tools/call').length, 1); h.advance(1); assert.equal(h.sent('tools/call').length, 2);
  const waiting = structuredClone(v); waiting.controls.auth.phase = 'exchanging'; answer(h, last(h), waiting);
  h.advance(1000); assert.equal(h.sent('tools/call').length, 3); assert.ok(h.sent('tools/call').every(r => r.params.name.endsWith('_status')));
});

test('automatic refresh preserves a dirty slot selection and exposes a concurrent save conflict rather than silently rebasing it', () => {
  const v = data(), h = ui(v); click(h, 'library-router-free'); h.advance(0); const next = structuredClone(v);
  next.controls.revision++; next.controls.slots.revision++; answer(h, last(h), next);
  assert.match(h.text('controls'), /Changed in another window/); assert.equal(find(h, 'save-slots'), undefined, 'a conflicted draft cannot be saved until Keep mine or Use saved');
  assert.ok(find(h, 'use-saved')); click(h, 'keep-draft'); click(h, 'save-slots'); const save = last(h);
  assert.deepEqual(save.params.arguments.models, ['native-model', 'router-free']); assert.equal(save.params.arguments.slotsRevision, 2);
  assert.equal(find(h, 'save-slots').textContent, 'Saving…');
});

test('a write supersedes an older background read, and cancellation recovers automatically without repeating the write', () => {
  const v = data(), h = ui(v); h.advance(0); const old = last(h); click(h, 'library-router-free'); click(h, 'save-slots'); const save = last(h);
  answer(h, old, v); assert.equal(find(h, 'save-slots').textContent, 'Saving…');
  h.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled' }); answer(h, save, v);
  h.advance(0); const status = last(h); assert.equal(status.params.name, 'bridge_provider_status');
  const committed = structuredClone(v); committed.controls.revision++; committed.controls.slots.revision++; committed.controls.slots.models.push('router-free'); answer(h, status, committed);
  assert.equal(find(h, 'save-slots'), undefined); assert.equal(h.sent('tools/call').filter(r => r.params.name.endsWith('_slots')).length, 1);
});

test('wrong-scope and backwards status responses fail closed; Retry reads only the original scope', () => {
  for (const mutate of [v => { v.controls.profileId = 'e'.repeat(32); }, v => { v.controls.revision--; }]) {
    const v = data(), h = ui(v); h.advance(0); const bad = structuredClone(v); mutate(bad); answer(h, last(h), bad);
    assert.equal(library(h).length, 0); assert.match(h.text('controls'), /State update unavailable/);
    h.advance(30000); assert.equal(h.sent('tools/call').length, 1); const retry = [...nodes(h.elements.controls),...nodes(h.elements['header-actions'])].find(n => n.textContent === 'Retry state update'); assert.ok(retry); retry.listeners.click.forEach(f => f({})); assert.equal(last(h).params.arguments.profileId, v.controls.profileId); answer(h, last(h), v); assert.equal(library(h).length, 3);
  }
});

test('timed-out reads stop polling, preserve the draft and recover once through Retry; teardown and hidden views send no new calls', () => {
  const v = data(), h = ui(v); click(h, 'library-router-free'); h.advance(0); h.advance(8001);
  h.advance(30000); assert.equal(h.sent('tools/call').length, 1);
  const retry = [...nodes(h.elements.controls),...nodes(h.elements['header-actions'])].find(n => n.textContent === 'Retry state update'); assert.ok(retry); retry.listeners.click.forEach(f => f({}));
  answer(h, last(h), v); assert.ok(find(h, 'save-slots')); h.sandbox.document.hidden = true; h.advance(10000); assert.equal(h.sent('tools/call').length, 2);
  h.deliver({ jsonrpc: '2.0', id: 'closed', method: 'ui/resource-teardown' }); h.advance(60000); assert.equal(h.sent('tools/call').length, 2);
});

test('a new host scope abandons the prior background read and cannot be overwritten by its late response', () => {
  const h = ui(), v = data(); h.advance(0); const old = last(h); v.controls.profileId = 'e'.repeat(32); h.deliver(toolResult(v)); answer(h, old, data());
  click(h, 'library-router-free'); click(h, 'save-slots'); assert.equal(last(h).params.arguments.profileId, 'e'.repeat(32));
});

test('durable OpenRouter connection wins over idle/failed PKCE display after reopen without offering a duplicate login', () => {
  for (const phase of ['idle', 'failed', 'cancelled', 'complete']) {
    const v = data(); v.controls.auth.phase = phase; v.controls.auth.error = 'auth_denied'; const h = ui(v); click(h, 'settings');
    assert.match(h.text('controls'), /Connected · Free-only/); assert.doesNotMatch(h.text('controls'), /Sign-in could not|Authorization was refused/); assert.equal(find(h, 'begin-auth'), undefined);
  }
});

test('a failed endpoint save keeps its actionable error and form draft after automatic status recovery', () => {
  const v = data(), h = ui(v); click(h, 'settings'); click(h, 'add-connection'); change(h, 'name', 'New local endpoint'); change(h, 'baseUrl', 'http://remote.example.invalid/v1'); click(h, 'connect');
  const req = last(h); h.deliver({ jsonrpc: '2.0', id: req.id, result: { isError: true, structuredContent: { error: 'endpoint_invalid' } } });
  h.advance(0); answer(h, last(h), v); assert.match(h.text('controls'), /Use an HTTPS endpoint/); assert.equal(find(h, 'name').value, 'New local endpoint'); assert.equal(find(h, 'baseUrl').value, 'http://remote.example.invalid/v1');
  assert.equal(h.sent('tools/call').filter(r => r.params.name.endsWith('_connect')).length, 1);
});


test('slot popover is outside the layout grid and keyboard alternatives reorder only the draft', () => {
 const h=ui(); click(h,'library-router-free'); click(h,'details-router-free');
 const pop=[...nodes(h.elements.controls),...nodes(h.elements['header-actions'])].find(n=>n.getAttribute('data-floating')==='slot'); assert.ok(pop);
 const workspace=[...nodes(h.elements.controls),...nodes(h.elements['header-actions'])].find(n=>n.className==='workspace'); assert.ok(!nodes(workspace).includes(pop));
 click(h,'move-earlier'); click(h,'save-slots'); assert.deepEqual(last(h).params.arguments.models,['router-free','native-model']);
});

test('connection overview opens a scoped detail and returns without modifying a connection', () => {
 const h=ui(); click(h,'settings'); assert.equal(find(h,'discover'),undefined);
 click(h,'provider-'+ 'd'.repeat(32)); assert.ok(find(h,'discover')); assert.ok(find(h,'provider-enabled'));
 assert.equal(find(h,'add-connection'),undefined); click(h,'connections-back'); assert.ok(find(h,'add-connection'));
 assert.equal(h.sent('tools/call').length,0);
});

test('Connection details: one status line, grouped Models / Default for new chats / Connection rows, boundary line, then Technical details; Diagnostics only on the overview', () => {
  const h = ui(); click(h, 'settings');
  assert.equal(h.elements.technical.hidden, false, 'Diagnostics is on the Connections overview'); assert.match(homeHtml(), /<summary>Diagnostics<\/summary>/, 'and it is named Diagnostics');
  click(h, 'provider-' + 'd'.repeat(32)); assert.equal(h.elements.technical.hidden, true, 'never on a connection page');
  const detail = nodes(h.elements.controls).find(n => n.className === 'connection-options');
  const kids = detail.children.filter(n => !n.hidden).map(n => n.className || n.tag);
  assert.deepEqual(kids, ['connection-status status-ok', 'detail-group', 'muted boundary', 'details'], 'status line, grouped rows, boundary line, Technical details last');
  assert.equal(detail.children.find(n => n.className.startsWith('connection-status')).textContent, '✓ Connected · free models only', 'one line, no second paragraph about free models');
  assert.doesNotMatch(h.text('controls'), /Only catalog-advertised free models/);
  const rows = nodes(detail.children.find(n => n.className === 'detail-group')).filter(n => /(^| )detail-row( |$)/.test(n.className));
  assert.deepEqual(rows.map(r => nodes(r).find(n => n.tag === 'h3').textContent), ['Models', 'Default for new chats', 'Connection']);
  assert.deepEqual([find(h, 'discover').textContent, find(h, 'provider-enabled').textContent], ['Refresh catalog', 'Disconnect']);
  const target = find(h, 'default-model'); assert.equal(target.className, 'row-target', 'the whole row is the target'); assert.match(target.textContent, /Default for new chats/); assert.equal(nodes(target).find(n => n.className === 'row-chevron-plain').textContent, '›');
  assert.equal(h.text('page-title'), 'Model Bridge/Connections/OpenRouter');
  const css = /<style>([\s\S]*?)<\/style>/.exec(homeHtml())[1]; assert.match(css, /\.connections\{max-width:720px;width:100%;margin:0\}/, 'the 720px body is left aligned with the page content, not centred');
  click(h, 'connections-back'); assert.equal(h.elements.technical.hidden, false);
  click(h, 'add-connection'); assert.equal(h.elements.technical.hidden, true, 'not beside the add form either');
});

test('Discard restores the saved slot order without a write or refreshing the catalog', () => {
 const h=ui(); click(h,'library-router-free'); click(h,'discard-slots');
 assert.equal(find(h,'save-slots'),undefined); assert.equal(find(h,'details-router-free'),undefined);
 assert.ok(find(h,'details-native-model')); assert.equal(h.sent('tools/call').length,0);
});

test('connection default menu selects one eligible model in the declared connection', () => {
 const h=ui(); click(h,'settings'); click(h,'provider-'+ 'd'.repeat(32)); click(h,'default-model');
 assert.ok(find(h,'default-router-free')); assert.equal(find(h,'default-router-paid'),undefined);
 click(h,'default-router-free'); const req=last(h);
 assert.equal(req.params.name,'bridge_provider_select'); assert.equal(req.params.arguments.providerId,'d'.repeat(32)); assert.equal(req.params.arguments.model,'router-free');
});

test('successful slot save briefly confirms in the reserved inline strip and teardown cancels its timer', () => {
 const value=data(),h=ui(value); click(h,'library-router-free'); click(h,'save-slots');
 const committed=structuredClone(value); committed.controls.revision++; committed.controls.slots.revision++; committed.controls.slots.models.push('router-free'); answer(h,last(h),committed);
 const bar=()=>nodes(h.elements.controls).find(n=>n.className==='save-bar');
 // Saving, Saved and Unsaved all live in the heading row's own save area, so no tile moves.
 const heading=nodes(h.elements.controls).find(n=>n.className==='selection-heading'); assert.ok(heading && nodes(heading).includes(bar()), 'the save area is part of the heading row');
 assert.equal(h.elements.announcement.textContent,'Saved to your model picker.'); assert.equal(bar().textContent,'✓ Saved to your model picker.');
 h.advance(3001); assert.equal(bar().textContent,''); assert.equal(h.elements.announcement.textContent,'');
 click(h,'library-router-free'); click(h,'save-slots'); answer(h,last(h),{...committed,controls:{...committed.controls,revision:committed.controls.revision+1,slots:{...committed.controls.slots,revision:committed.controls.slots.revision+1,models:['native-model']}}});
 h.deliver({jsonrpc:'2.0',id:'closed',method:'ui/resource-teardown'}); const before=h.posted.length; h.advance(4000); assert.equal(h.posted.length,before);
});
