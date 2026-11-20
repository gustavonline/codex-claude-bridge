import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { homeHtml } from '../plugins/codex-claude/home/server.mjs';
import { harness, hostReply, handshakeId, toolResult, sample, FakeNode } from './support/home-host.mjs';

// The Node VM harness runs the script text directly, but a browser first parses the HTML:
// an actual NUL becomes U+FFFD before JavaScript sees it. The served text must therefore
// carry no control character at all, and must still compile after that substitution.
const scriptOf = html => /<script>([\s\S]*?)<\/script>/.exec(html)[1];

test('the served HTML has no NUL, other raw control character or replacement character, and the script compiles after HTML-parser substitution', () => {
  const html = homeHtml();
  const bad = [...html].filter(ch => { const code = ch.codePointAt(0); return (code < 32 && ch !== '\n' && ch !== '\t' && ch !== '\r') || code === 127 || code === 0xfffd; });
  assert.deepEqual(bad.map(ch => ch.codePointAt(0).toString(16)), []);
  const parsed = html.replaceAll('\u0000', '�');
  assert.doesNotThrow(() => new vm.Script(scriptOf(parsed)), 'the browser-parsed script is valid JavaScript');
  assert.doesNotMatch(scriptOf(html), /\\x[0-9a-f]{2}|\\u00[01][0-9a-f]/i, 'no escape in the template literal can serialise to a control character');
  assert.equal(scriptOf(html).includes(String.fromCharCode(92)), false, 'the served script holds no backslash at all, as the source comment requires');
});

test('a model menu is placed beside its trigger BEFORE its heading takes focus, and only a minimal document scroll keeps it visible', () => {
  const src = scriptOf(homeHtml()), render = src.slice(src.indexOf('function render()'), src.indexOf('function positionPopovers()'));
  assert.ok(render.indexOf('positionPopovers();') >= 0 && render.indexOf('positionPopovers();') < render.indexOf('focus.focus('), 'positioning precedes focusing in render');
  assert.match(render, /focus\.focus\(\{ preventScroll: true \}\)/); assert.match(render, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/);
  const provider = { id: 'a'.repeat(32), name: 'Provider a', baseUrl: 'https://fixture-a.example.invalid/v1', protocol: 'responses', enabled: true, selected: null, catalogState: 'fresh', models: [{ id: 'm1', name: 'Model one' }] };
  const value = sample({ controls: { kind: 'responses-trial', bindingId: 'c'.repeat(32), profileId: 'd'.repeat(32), bridgeId: 'e'.repeat(32), revision: 1, focusedProvider: null, providers: [provider], authReferences: [], slots: { revision: 1, models: ['m1'] } } });
  const shown = [];
  FakeNode.prototype.getBoundingClientRect = function () { return this.tag === 'button' ? { top: 900, bottom: 924, left: 200, right: 224, width: 24, height: 24 } : { top: 0, bottom: 263, left: 0, right: 260, width: 260, height: 263 }; };
  FakeNode.prototype.scrollIntoView = function (options) { shown.push({ top: this.style.top, left: this.style.left, options }); };
  try {
    const h = harness(); h.root.clientWidth = 320; h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(value));
    const nodes = n => [n, ...n.children.flatMap(nodes)], trigger = nodes(h.elements.controls).find(n => n.getAttribute('data-focus-key') === 'details-m1');
    trigger.listeners.click.forEach(fn => fn({}));
    assert.deepEqual(shown.map(s => [s.top, s.options.block]), [['930px', 'nearest']], 'the menu already sits 6px under its trigger when the scroll is requested');
    assert.equal(h.sandbox.document.activeElement.getAttribute('data-focus-key'), 'detail-heading');
  } finally { delete FakeNode.prototype.getBoundingClientRect; delete FakeNode.prototype.scrollIntoView; }
});

test('saved-model labels with control characters fall back to a neutral name instead of showing them', () => {
  const provider = letter => ({ id: letter.repeat(32), name: 'Provider ' + letter, baseUrl: 'https://fixture-' + letter + '.example.invalid/v1', protocol: 'responses', enabled: true, selected: null, catalogState: 'fresh', models: [] });
  const ids = ['bad\u0001name', 'clean-name'].map(name => 'bridge-responses/' + 'a'.repeat(32) + '/' + Buffer.from(name).toString('base64url'));
  const value = sample({ controls: { kind: 'responses-trial', bindingId: 'c'.repeat(32), profileId: 'd'.repeat(32), bridgeId: 'e'.repeat(32), revision: 1, focusedProvider: null,
    providers: [provider('a')], authReferences: [], slots: { revision: 1, models: ids } } });
  const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {} } })); h.deliver(toolResult(value));
  const text = h.text('controls');
  assert.match(text, /Saved model 1/); assert.match(text, /clean-name/); assert.doesNotMatch(text, /bad/);
  assert.ok(![...text].some(ch => ch.codePointAt(0) < 32), 'no control character reaches the DOM');
});
