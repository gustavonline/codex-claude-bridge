import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, hostReply, handshakeId, toolResult, sample } from './support/home-host.mjs';

// One persisted truth: a saved selection is never extended by catalog discovery, and a legacy
// custom-only curation (which silently adds built-in models) can be adopted explicitly with one Save.
const nodes = n => [n, ...n.children.flatMap(nodes)];
const everything = h => [...nodes(h.elements['page-title']), ...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)];
const find = (h, key) => everything(h).find(n => n.getAttribute('data-focus-key') === key);
const tileNames = h => everything(h).find(n => n.getAttribute('aria-label') === 'Models in picker').children.filter(n => n.className === 'slot-tile').map(n => n.children[1].children[0].textContent);
const NATIVE = '0'.repeat(31) + '1';
function data({ scope, saved, extra = [] }) {
  const native = { id: NATIVE, kind: 'native', protocol: 'native', name: 'Codex / GPT', baseUrl: '', enabled: true, selected: null, catalogState: 'fresh', models: [{ id: 'gpt-1', name: 'GPT One', available: true, defaultVisible: true }, { id: 'gpt-2', name: 'GPT Two', available: true, defaultVisible: true }, ...extra] };
  const custom = { id: 'd'.repeat(32), protocol: 'responses', name: 'Lab endpoint', baseUrl: 'https://lab.example.invalid/v1', enabled: true, selected: null, catalogState: 'fresh', models: [{ id: 'lab-1', name: 'Lab One' }, { id: 'lab-2', name: 'Lab Two' }] };
  return sample({ controls: { kind: 'responses-trial', bindingId: 'a'.repeat(32), profileId: 'b'.repeat(32), bridgeId: 'c'.repeat(32), revision: 5, focusedProvider: null, pickerRefresh: { requested: 0, observed: 0, kind: 'native' },
    authReferences: [], providers: [native, custom], slots: { revision: 3, models: saved, scope, catalogRevision: 7 } } });
}
function ui(value) { const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(value)); return h; }
const last = h => h.sent('tools/call').at(-1);

test('a legacy custom-only curation offers Save at once, and Save adopts exactly what is shown as the explicit selection', () => {
  const h = ui(data({ scope: 'custom', saved: ['lab-2'] }));
  assert.deepEqual(tileNames(h), ['GPT One', 'GPT Two', 'Lab Two'], 'built-in defaults plus the saved custom model are what the picker shows today');
  assert.ok(find(h, 'save-slots'), 'Save is available without any edit'); assert.equal(find(h, 'discard-slots'), undefined, 'nothing to discard before an edit');
  assert.match(h.text('controls'), /Unsaved/); assert.equal(h.sent('tools/call').length, 0, 'showing it writes nothing');
  find(h, 'save-slots').listeners.click.forEach(fn => fn({}));
  const request = last(h); assert.equal(request.params.name, 'bridge_provider_slots');
  assert.deepEqual(request.params.arguments.models, ['gpt-1', 'gpt-2', 'lab-2']); assert.equal(request.params.arguments.slotsRevision, 3); assert.equal(request.params.arguments.catalogRevision, 7); assert.equal(request.params.arguments.reset, false);
});

test('after an edit to a legacy curation, Discard returns to the adoptable view instead of a half state', () => {
  const h = ui(data({ scope: 'custom', saved: ['lab-2'] }));
  find(h, 'library-lab-1').listeners.click.forEach(fn => fn({})); assert.deepEqual(tileNames(h), ['GPT One', 'GPT Two', 'Lab Two', 'Lab One']); assert.ok(find(h, 'discard-slots'));
  find(h, 'discard-slots').listeners.click.forEach(fn => fn({})); assert.deepEqual(tileNames(h), ['GPT One', 'GPT Two', 'Lab Two']); assert.equal(find(h, 'discard-slots'), undefined);
});

test('a saved unified selection is never extended by newly discovered catalog models', () => {
  const before = data({ scope: 'all', saved: ['gpt-1', 'lab-1'] }), h = ui(before);
  assert.deepEqual(tileNames(h), ['GPT One', 'Lab One']); assert.equal(find(h, 'save-slots'), undefined);
  const after = structuredClone(before); after.controls.revision++; after.controls.providers[0].models.push({ id: 'gpt-new', name: 'GPT New', available: true, defaultVisible: true }); after.controls.providers[1].models.push({ id: 'lab-new', name: 'Lab New' });
  h.advance(0); h.deliver({ jsonrpc: '2.0', id: last(h).id, result: { structuredContent: after } });
  assert.deepEqual(tileNames(h), ['GPT One', 'Lab One'], 'neither a built-in nor a custom discovery joins the picker'); assert.equal(find(h, 'save-slots'), undefined);
  assert.ok(find(h, 'library-gpt-new') && find(h, 'library-lab-new'), 'both are available to add from All models'); assert.equal(find(h, 'library-gpt-new').textContent, '+');
});

test('with no saved selection the shown default (what the backend serves today) is not saved until the person edits it', () => {
  const h = ui(data({ scope: 'all', saved: null }));
  assert.deepEqual(tileNames(h), ['GPT One', 'GPT Two', 'Lab One', 'Lab Two'], 'an unsaved default shows every selectable model, exactly as the backend serves it');
  assert.equal(find(h, 'save-slots'), undefined, 'showing the default never writes it');
  assert.match(h.text('controls'), /Pick the few models you switch between\. 5 to 10 works well\./); assert.equal(h.sent('tools/call').length, 0);
  find(h, 'view-picker').listeners.click.forEach(fn => fn({})); find(h, 'details-lab-2').listeners.click.forEach(fn => fn({}));
  find(h, 'remove-lab-2').listeners.click.forEach(fn => fn({})); assert.ok(find(h, 'save-slots'));
  find(h, 'save-slots').listeners.click.forEach(fn => fn({})); assert.deepEqual(last(h).params.arguments.models, ['gpt-1', 'gpt-2', 'lab-1']);
});
