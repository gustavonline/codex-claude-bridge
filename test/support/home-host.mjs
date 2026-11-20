import assert from 'node:assert/strict';
import vm from 'node:vm';
import { homeHtml } from '../../plugins/codex-claude/home/server.mjs';

class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.own = ''; this.className = ''; this.listeners = {}; this.style = {}; }
  get textContent() { return this.own + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.own = String(value); }
  replaceChildren(...nodes) { this.children = nodes; this.own = ''; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener); }
  set innerHTML(value) { throw new Error('innerHTML is never allowed'); }
  set outerHTML(value) { throw new Error('outerHTML is never allowed'); }
}

function viewOf(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'exactly one inline script');
  return { script: scripts[0][1], ids: [...html.matchAll(/ id="([a-z-]+)"/g)].map(match => match[1]) };
}

// A host the view may talk to: records everything posted, delivers messages from
// a chosen source, and lays the page out so that its content box depends on its
// content and its width but never on the viewport height. `observer` is
// 'native' (a ResizeObserver that reports a changed box once settled), 'absent'
// or 'throws'. Observer callbacks run after every host action, until stable.
function harness(html = homeHtml(), { standalone = false, observer = 'native', width = 320 } = {}) {
  const { script, ids } = viewOf(html);
  const events = [], posted = [], listeners = [], observers = [];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeNode('#' + id)]));
  const root = new FakeNode('html');
  const layout = { width, viewport: 600, base: 120, row: 24, details: 100, unstable: false };
  // Narrow widths wrap text onto more lines; the viewport height is deliberately unused.
  const rowsIn = n => n.children.reduce((sum, child) => sum + (['button', 'label', 'article', 'h2'].includes(child.tag) ? 1 : 0) + (child.tag === 'details' && !child.open ? 0 : rowsIn(child)), 0);
  Object.defineProperties(elements.app, {
    scrollWidth: { get: () => layout.width },
    offsetHeight: { get: () => layout.base + rowsIn(elements.controls) * layout.row + (elements.alert.hidden ? 0 : 20) + (elements.technical.open ? layout.details + elements.facts.children.length * layout.row : 0) + (layout.width < 250 ? 60 : 0) },
  });
  const created = [];
  const documentListeners = {};
  const document = { listeners: documentListeners, addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn); }, removeEventListener(type, fn) { documentListeners[type] = (documentListeners[type] ?? []).filter(x => x !== fn); }, documentElement: root, getElementById: id => elements[id],
    createElement: tag => { const node = new FakeNode(tag); node.focus = () => { document.activeElement = node; }; node.setSelectionRange = (a, b) => { node.selectionStart = a; node.selectionEnd = b; }; created.push(node); return node; },
    createTextNode: text => { const node = new FakeNode('#text'); node.own = String(text); created.push(node); return node; } };
  const parent = { postMessage: (message, target) => { events.push('post'); posted.push({ message: JSON.parse(JSON.stringify(message)), target }); } };
  const timers = new Map();
  let now = 0, nextTimer = 1;
  const window = { listeners,
    addEventListener: (type, listener) => { events.push('listen:' + type); listeners.push(listener); },
    removeEventListener: (type, listener) => { events.push('unlisten:' + type); const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } };
  window.parent = standalone ? window : parent;
  // The viewport is observable (as in a browser) so that any dependence on it would show.
  Object.defineProperty(window, 'innerHeight', { get: () => layout.viewport });
  Object.defineProperty(root, 'clientHeight', { get: () => layout.viewport });
  class FakeResizeObserver {
    constructor(callback) {
      if (observer === 'throws') throw new Error('ResizeObserver unavailable');
      Object.assign(this, { callback, targets: [], disconnected: false, last: null, pending: false });
      observers.push(this);
    }
    observe(target) { this.targets.push(target); this.pending = true; }
    disconnect() { this.disconnected = true; this.targets = []; }
  }
  const sandbox = { window, document, atob, TextDecoder, URL, setTimeout: (fn, ms) => { timers.set(nextTimer, { fn, at: now + ms }); return nextTimer++; }, clearTimeout: id => { timers.delete(id); },
    ...(observer === 'absent' ? {} : { ResizeObserver: FakeResizeObserver }) };
  // Runs observer callbacks while a box changed; a loop that never settles is recorded.
  const settle = () => {
    for (let pass = 0; pass < 20; pass++) {
      let fired = false;
      for (const item of observers) {
        const box = `${elements.app.scrollWidth}x${elements.app.offsetHeight}`;
        if (item.disconnected || !item.targets.length || (!item.pending && box === item.last)) continue;
        item.pending = false; item.last = box; fired = true;
        item.callback([{ target: elements.app }]);
      }
      if (!fired) return;
    }
    layout.unstable = true;
  };
  vm.runInNewContext(script, sandbox);
  settle();
  const stranger = {};
  return {
    events, posted, elements, created, parent, stranger, root, sandbox, layout, observers, window,
    // Messages are copied through JSON so the host's objects are plain data.
    deliver(data, source = parent) { listeners.slice().forEach(listener => listener({ source, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) })); settle(); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } settle(); },
    toggle(open) { elements.technical.open = open; (elements.technical.listeners.toggle ?? []).slice().forEach(listener => listener({})); settle(); },
    resize(newWidth) { layout.width = newWidth; settle(); },
    text: id => elements[id].textContent,
    sent: method => posted.filter(({ message }) => message.method === method).map(({ message }) => message),
  };
}

const hostReply = (id, result = {}) => ({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'synthetic-host', version: '1' }, hostCapabilities: {}, hostContext: {}, ...result } });
const toolResult = (structuredContent, extra = {}) => ({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'fallback' }], structuredContent, ...extra } });
const sample = (overrides = {}) => ({ pluginVersion: '0.0.1', observedAt: '2026-01-01T00:00:00.000Z', next: 'Do the thing.', facts: {
  payload: { state: 'unknown', detail: 'Not checked.' }, connection: { state: 'observed', detail: 'Connected over MCP.' },
  activation: { state: 'unknown', detail: 'Not confirmed.' }, evidence: { state: 'unknown', detail: 'No history.' } }, ...overrides });
const marksOf = h => h.elements.facts.children.map(li => [li.className, li.children[0].textContent]);
const handshakeId = h => h.sent('ui/initialize')[0].id;
const sizes = h => h.sent('ui/notifications/size-changed').map(message => message.params);

export { FakeNode, viewOf, harness, hostReply, toolResult, sample, marksOf, handshakeId, sizes };
