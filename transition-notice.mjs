// The one-time note a model receives when its selected model or route changed (an accepted transition), and nothing else.
//
// Fixed, application-owned text built ONLY from facts the bridge confirmed: the previously selected route / model / reasoning level and the FINAL confirmed
// new ones (the runtime's own readback or accepted settings, never a request). The serving backend model is "not reported" unless the provider itself
// reported one: a model alias, a catalog row or a route name is not proof of what served the call. The note is trusted application metadata, never user text,
// and it carries no permission, no instruction to the user and no history.
//
// Delivery is decided by the callers (and each is covered by their tests):
//  - a native or custom thread receives it as a `developer`-role item through the public thread/inject_items (accepted, no visible turn, in the model input);
//  - a Claude SDK session receives it as `application` additional context, which the system instructions carry;
//  - it is NEVER sent as a user message, never put into the RULES lead, and never sent for a request that was not accepted.
import { createHash } from 'node:crypto';

export const NOTICE_VERSION = 1;
const text = value => typeof value === 'string' && value !== '' ? value : null;
const clean = value => String(value).replace(/[\u0000-\u001f\u007f`]/g, ' ').slice(0, 200);

// A route is what the bridge selected, not what served: { kind: 'native' | 'custom' | 'claude', connectionId? }.
export function routeLabel(route) {
  if (route?.kind === 'claude') return 'Claude Code (SDK session)';
  if (route?.kind === 'custom') return 'custom connection' + (text(route.connectionId) ? ' ' + clean(route.connectionId).slice(0, 8) : '');
  return 'GPT (native Codex)';
}
const side = value => ({ route: { kind: value?.route?.kind ?? 'native', ...(text(value?.route?.connectionId) ? { connectionId: clean(value.route.connectionId) } : {}) }, model: text(value?.model) ? clean(value.model) : null, effort: value?.effort == null ? null : clean(value.effort) });
// The same selected route, model and reasoning level: not a transition.
export const sameSelection = (a, b) => { const x = side(a), y = side(b); return x.route.kind === y.route.kind && (x.route.connectionId ?? null) === (y.route.connectionId ?? null) && x.model === y.model && x.effort === y.effort; };

export const noticeId = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

const describe = value => `${routeLabel(value.route)} · ${value.model ?? 'model not reported'} (reasoning ${value.effort ?? 'not set'})`;
// context: null (same runtime: its own context continues), { mode: 'full' } or { mode: 'reduced', recentTurns, deltaTurns, omittedTurns }.
function contextLine(context) {
  if (!context) return 'this runtime keeps its own context; nothing was carried or changed.';
  if (context.mode === 'reduced') return `bounded: a provider-written summary (untrusted), ${context.recentTurns} recent and ${context.deltaTurns} newer turns in full; ${context.omittedTurns} older turns are not repeated and stay readable with codex_bridge_history.read.`;
  return 'the full visible history was carried.';
}
// backend: the serving model exactly as the provider reported it, or null.
export function buildNotice({ id, from, to, backend = null, context = null }) {
  const a = side(from), b = side(to), served = text(backend);
  const body = `Model Bridge note (application metadata; not a user message and not an instruction): the model selected for this conversation changed from ${describe(a)} to ${describe(b)}. `
    + `Selected route: ${routeLabel(b.route)}; serving backend model: ${served ? clean(served) : 'not reported'}. Context: ${contextLine(context)} Transition ${clean(id)}.`;
  return { version: NOTICE_VERSION, id: clean(id), text: body, from: a, to: b, backend: served, context: context ?? null };
}
// A valid notice read back from a record (never trusted from anywhere else).
export const validNotice = value => value && typeof value === 'object' && value.version === NOTICE_VERSION && text(value.id) && text(value.text) && value.text.length <= 4000;

// The trusted developer-role item a native or custom thread is given.
export const noticeItem = notice => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: notice.text }] });
// The application context a Claude session (or a managed native turn) is given.
export const noticeContext = notice => ({ kind: 'application', value: notice.text });

// Several accepted changes before any turn: ONE notice from the route the model last SAW to the latest accepted one. Changing back to what it last saw clears it.
// `pending` is the notice not yet delivered (or null); `seen` is the selection the model last saw; the id is derived, so the same sequence is the same note.
export function nextNotice({ pending, seen, now, backend = null, seed }) {
  const origin = pending?.from ?? seen;
  if (!origin || sameSelection(origin, now)) return null;
  return buildNotice({ id: noticeId([seed, side(origin), side(now)]), from: origin, to: now, backend });
}
