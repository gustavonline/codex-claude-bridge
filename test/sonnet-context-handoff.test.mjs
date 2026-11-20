import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityError, buildTransfer } from '../continuity.mjs';
import { BudgetStore, PrivateMap, validGate, HANDOFF_VERSION, SUMMARY_VERSION, claudeContext, contextTokens, coverageLine, decide, estimateMethod, estimateTokens, fingerprint, fitsAtDispatch, limits, planBudget,
  qualifyNativeWindow, qualifySdkCompaction, qualifyUsage, validContext, validSummary } from '../context-handoff.mjs';
import { compactionHooks } from '../claude.mjs';

const SYNC = process.permission ? () => {} : undefined; // the permission runner forbids fsync; elsewhere the real one runs
// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------------
const FILL = 'filler words that make a message long enough to matter '.repeat(18); // ~1 KB
const user = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] });
const agent = (id, text) => ({ type: 'agentMessage', id, text });
const turns = (count, over = {}) => Array.from({ length: count }, (_, i) => ({ id: 'turn-' + (i + 1), status: 'completed', items: [user('u' + (i + 1), over[i + 1]?.[0] ?? `question ${i + 1} ${FILL}`), agent('a' + (i + 1), over[i + 1]?.[1] ?? `answer ${i + 1} ${FILL}`)] }));
const running = n => ({ id: 'turn-' + n, status: 'inProgress', items: [user('u' + n, 'right now')] });
const hook = (over = {}) => ({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'SUMMARY: the launch code is PELICAN-7731; the user wants tests; constraint: no network.', session_id: 'session-1', cwd: process.cwd(), ...over });
const ctx = (all, over = {}) => ({ sessionId: 'session-1', model: 'sonnet', cwd: process.cwd(), turns: all, currentTurnId: 'turn-current', revision: 1, now: 1000, ...over });
const sha = value => createHash('sha256').update(value).digest('hex');
const budget = (over = {}) => ({ version: 1, key: 'native:openai:gpt-test', route: 'native', model: 'gpt-test', provider: 'openai', contextWindow: 100_000, maxOutputTokens: 10_000, source: 'native-token-event', at: 5, ...over });
const summaryOf = (all, covered) => qualifySdkCompaction(hook(), ctx([...all.slice(0, covered), running(covered + 1)], { currentTurnId: 'turn-' + (covered + 1) })).snapshot;

// ---- 1. the provider's own compaction ----------------------------------------------------------------------------------------------------------
test('PostCompact: a callback of THIS session, with plaintext and a known trigger, is kept as an untrusted, versioned summary bound to session, model, route, revision and the exact settled prefix', () => {
  const all = [...turns(30), running(31)], q = qualifySdkCompaction(hook(), ctx(all, { currentTurnId: 'turn-31' }));
  assert.equal(q.ok, true); const s = q.snapshot;
  assert.deepEqual([s.version, s.kind, s.untrusted, s.trigger, s.sessionId, s.model, s.route, s.revision, s.createdAt], [SUMMARY_VERSION, 'sdk-postcompact', true, 'auto', 'session-1', 'sonnet', 'claude', 1, 1000]);
  assert.equal(s.text, hook().compact_summary); // exactly as the provider wrote it
  assert.equal(s.coverage.count, 30); assert.equal(s.coverage.ids.length, 30); assert.equal(s.coverage.lastTurnId, 'turn-30'); assert.equal(s.coverage.hash, fingerprint(all.slice(0, 30)).hash);
  assert.equal(s.coverage.coversActiveTurn, true, 'the live turn may be covered: recorded as uncertain, never as coverage');
  assert.equal(JSON.stringify(s).includes('right now'), false, 'the running turn is not part of what the summary is bound to');
  assert.equal(validSummary(s, turns(40)).ok, true);
  for (const trigger of ['manual', 'auto']) assert.equal(qualifySdkCompaction(hook({ trigger }), ctx(all, { currentTurnId: 'turn-31' })).ok, true);
});

test('PostCompact: stale, wrong-session, wrong-event, empty, oversized, unknown-trigger and uncovered callbacks are ignored, never repaired', () => {
  const all = [...turns(5), running(6)], good = c => qualifySdkCompaction(c, ctx(all, { currentTurnId: 'turn-6' }));
  const reason = (input, over) => { const q = qualifySdkCompaction(input, ctx(all, { currentTurnId: 'turn-6', ...over })); assert.equal(q.ok, false); return q.reason; };
  assert.equal(good(hook()).ok, true);
  assert.equal(reason(hook({ session_id: 'session-2' })), 'other_session'); assert.equal(reason(hook({ session_id: '' })), 'other_session'); assert.equal(reason(hook(), { sessionId: undefined }), 'other_session');
  assert.equal(reason(hook({ hook_event_name: 'PreCompact' })), 'not_a_postcompact_event'); assert.equal(reason(null), 'not_a_postcompact_event'); assert.equal(reason('text'), 'not_a_postcompact_event');
  assert.equal(reason(hook({ trigger: 'scheduled' })), 'unknown_trigger'); assert.equal(reason(hook({ trigger: undefined })), 'unknown_trigger');
  assert.equal(reason(hook({ compact_summary: '   ' })), 'no_summary_text'); assert.equal(reason(hook({ compact_summary: { text: 'x' } })), 'no_summary_text'); assert.equal(reason(hook({ compact_summary: undefined })), 'no_summary_text');
  assert.equal(reason(hook({ compact_summary: 'x'.repeat(limits.summaryChars + 1) })), 'summary_too_large');
  assert.equal(reason(hook(), { model: '' }), 'model_unknown');
  assert.equal(reason(hook(), { turns: [running(1)], currentTurnId: 'turn-1' }), 'no_settled_turns_covered');
  assert.equal(reason(hook(), { turns: [{ id: 3, items: [] }] }), 'history_unreadable');
});

test('a stored summary is usable only for exactly the history it was taken over; any change in ids, item ids, order or shape discards it', () => {
  const base = turns(20), s = summaryOf(base, 20);
  assert.equal(validSummary(s, base).ok, true); assert.equal(validSummary(s, [...base, ...turns(3).map((t, i) => ({ ...t, id: 'later-' + i }))]).ok, true, 'a longer history that STARTS with the covered prefix');
  const bad = (snapshot, history, expected) => assert.equal(validSummary(snapshot, history).reason, expected);
  bad(s, base.slice(0, 19), 'coverage_shape'); // shorter than the covered prefix
  bad(s, [{ ...base[0], id: 'other' }, ...base.slice(1)], 'coverage_changed');
  bad(s, [{ ...base[0], items: [user('changed-id', 'x'), agent('a1', 'y')] }, ...base.slice(1)], 'coverage_changed');
  bad(s, [base[1], base[0], ...base.slice(2)], 'coverage_changed');
  bad({ ...s, untrusted: false }, base, 'summary_shape'); bad({ ...s, version: 2 }, base, 'summary_shape'); bad({ ...s, kind: 'index' }, base, 'summary_shape'); bad(null, base, 'summary_shape');
  bad({ ...s, text: '  ' }, base, 'summary_text'); bad({ ...s, coverage: { ...s.coverage, count: 19 } }, base, 'coverage_shape'); bad({ ...s, coverage: { ...s.coverage, hash: 'x'.repeat(32) } }, base, 'coverage_changed');
});

test('the SDK hook wiring: the callback is observed through the PostCompact hook of the query options, always returns {}, and an error in observing never reaches the SDK', async () => {
  assert.equal(compactionHooks(undefined), undefined); assert.equal(compactionHooks('x'), undefined);
  const seen = [], hooks = compactionHooks(input => { seen.push(input); });
  assert.deepEqual(Object.keys(hooks), ['PostCompact']); assert.equal(hooks.PostCompact.length, 1); assert.equal(hooks.PostCompact[0].hooks.length, 1);
  assert.deepEqual(await hooks.PostCompact[0].hooks[0](hook(), 'tool-id', { signal: new AbortController().signal }), {}); assert.equal(seen.length, 1); assert.equal(seen[0].compact_summary, hook().compact_summary);
  const failing = compactionHooks(async () => { throw new Error('observer failed'); });
  assert.deepEqual(await failing.PostCompact[0].hooks[0](hook()), {});
});

// ---- 2. the context window -----------------------------------------------------------------------------------------------------------------------
test('window from the SDK ModelUsage: only the ONE entry that is the selected model, in the session that produced it; anything else is unknown', () => {
  const usage = (over = {}) => ({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 32_000, ...over });
  const pick = (usageMap, selected = { value: 'sonnet', resolvedModel: 'claude-sonnet-5' }, sessionId = 'session-1') => qualifyUsage({ usageMap, selected, sessionId, now: 7 });
  const ok = pick({ 'claude-sonnet-5': usage({ canonicalModel: 'claude-sonnet-5', provider: 'firstParty' }) });
  assert.deepEqual([ok.key, ok.route, ok.model, ok.servedName, ok.contextWindow, ok.maxOutputTokens, ok.source, ok.sessionId, ok.at, ok.provider], ['claude:sonnet', 'claude', 'sonnet', 'claude-sonnet-5', 200_000, 32_000, 'sdk-modelusage', 'session-1', 7, 'firstParty']);
  assert.equal(pick({ sonnet: usage() }).servedName, 'sonnet'); // by the selected name
  assert.equal(pick({ 'alias-key': usage({ canonicalModel: 'claude-sonnet-5' }) }).servedName, 'alias-key'); // by the canonical name
  assert.equal(pick({ 'claude-sonnet-5': usage(), 'claude-haiku-5': usage({ contextWindow: 50_000 }) }).contextWindow, 200_000, 'another model of the same map (a subagent) is never this model\'s window');
  assert.equal(pick({ 'claude-haiku-5': usage() }), null, 'no entry for the selected model'); assert.equal(pick({ 'claude-sonnet-5': usage(), sonnet: usage() }), null, 'two entries: ambiguous');
  assert.equal(pick({ sonnet: usage({ contextWindow: 999 }) }), null); assert.equal(pick({ sonnet: usage({ contextWindow: '200000' }) }), null); assert.equal(pick({ sonnet: usage({ maxOutputTokens: 200_000 }) }), null);
  assert.equal(pick({ sonnet: usage({ maxOutputTokens: -1 }) }), null); assert.equal(pick(null), null); assert.equal(pick({ sonnet: usage() }, null), null); assert.equal(pick({ sonnet: usage() }, { value: 'sonnet' }, ''), null);
  assert.equal(pick({ 'claude-sonnet-5': usage() }, { value: 'opus', resolvedModel: 'claude-opus-5' }), null, 'a different selected model does not read this window');
});

test('window from a native token event: only the OpenAI provider of the live native thread on the main connection; a custom endpoint or any other provider is unknown', () => {
  const scope = (over = {}) => ({ modelProvider: 'openai', model: 'gpt-test', ...over });
  const window = (over = {}) => qualifyNativeWindow({ window: 272_000, scope: scope(), mainConnection: true, now: 3, ...over });
  assert.deepEqual([window().key, window().route, window().provider, window().contextWindow, window().maxOutputTokens, window().source], ['native:openai:gpt-test', 'native', 'openai', 272_000, null, 'native-token-event']);
  assert.equal(window({ mainConnection: false }), null, 'a custom connection never'); assert.equal(window({ scope: scope({ modelProvider: 'bridge_custom_abc' }) }), null); assert.equal(window({ scope: scope({ modelProvider: 'ollama' }) }), null);
  assert.equal(window({ scope: scope({ model: null }) }), null); assert.equal(window({ scope: null }), null); assert.equal(window({ window: 12 }), null); assert.equal(window({ window: '272000' }), null); assert.equal(window({ window: undefined }), null);
});

test('budget provenance: modest, private, keyed by route and EXACT model, bounded, atomically replaced, and unreadable means unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-budget-')), path = join(dir, 'state', 'context-budgets.json'), store = new BudgetStore(path);
  assert.equal(store.get('native', 'gpt-test'), null);
  assert.equal(store.set(budget()), true); assert.equal(store.get('native', 'gpt-test').contextWindow, 100_000);
  assert.equal(store.get('native', 'gpt-other'), null, 'another model never reads this window'); assert.equal(store.get('claude', 'gpt-test'), null, 'another route neither');
  assert.equal(store.set(budget({ key: 'claude:sonnet', route: 'claude', model: 'sonnet', provider: null, source: 'sdk-modelusage' })), true); assert.equal(store.get('claude', 'sonnet').source, 'sdk-modelusage');
  assert.equal(new BudgetStore(path).get('native', 'gpt-test').at, 5, 'it survives a restart, with its source and time'); assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))), ['version', 'entries']);
  assert.equal(/auth|secret|credential|bearer/i.test(readFileSync(path, 'utf8')), false, 'windows only: no credential, no chat content');
  for (const bad of [budget({ contextWindow: 10 }), budget({ maxOutputTokens: 100_000 }), budget({ source: undefined }), budget({ at: 'now' }), { ...budget(), version: 2 }, null]) assert.equal(store.set(bad), false);
  for (let i = 0; i < limits.entries + 10; i++) store.set(budget({ key: 'native:openai:m' + i, model: 'm' + i }));
  assert.ok(store.entries.size <= limits.entries); assert.equal(store.get('native', 'gpt-test'), null, 'the oldest entries are the ones dropped');
  writeFileSync(path, '{ not json'); assert.equal(new BudgetStore(path).get('native', 'm5'), null);
  writeFileSync(path, JSON.stringify({ version: 1, entries: { 'native:openai:evil': { version: 1, key: 'other', contextWindow: 5e6, source: 's', at: 1, maxOutputTokens: null } } })); assert.equal(new BudgetStore(path).entries.size, 0, 'an entry whose key does not name itself is refused');
});

test('reserves are complete and their sources recorded; the estimate is labelled a heuristic; the real request is measured again at the first dispatch', () => {
  const b = budget(), plan = planBudget({ budget: b });
  assert.deepEqual(Object.keys(plan.parts).sort(), ['instructions', 'margin', 'output', 'request', 'tools']);
  assert.equal(plan.parts.output, 10_000); assert.equal(plan.parts.margin, 15_000); assert.equal(plan.fixed, 6000 + 3000 + 8000 + 10_000 + 15_000); assert.equal(plan.available, 100_000 - plan.fixed);
  assert.equal(plan.share, Math.min(40_000, plan.available)); assert.equal(plan.estimateMethod, estimateMethod); assert.match(estimateMethod, /heuristic/); assert.match(estimateMethod, /not a guarantee/);
  assert.match(plan.sources.request, /reserved capacity/); assert.match(plan.sources.output, /measured maxOutputTokens/); assert.match(plan.sources.margin, /assumption/); assert.equal(plan.sources.window, 'native-token-event');
  assert.match(planBudget({ budget: budget({ maxOutputTokens: null }) }).sources.output, /25% of the window/); assert.equal(planBudget({ budget: budget({ maxOutputTokens: null }) }).parts.output, 25_000);
  const real = planBudget({ budget: b, requestTokens: 123 }); assert.equal(real.parts.request, 123); assert.match(real.sources.request, /actual request/);
  assert.equal(estimateTokens('x'.repeat(3000)), 1000); assert.equal(estimateTokens('é'.repeat(3)), 2); // bytes / 3, rounded up
  const handoffTokens = 30_000, fits = fitsAtDispatch({ budget: b, handoffTokens, requestTokens: 1000 }), tooBig = fitsAtDispatch({ budget: b, handoffTokens, requestTokens: 80_000 });
  assert.equal(fits.fits, true); assert.equal(tooBig.fits, false); assert.equal(tooBig.needed, handoffTokens + tooBig.plan.fixed); assert.equal(tooBig.window, 100_000);
});

// ---- 3. what is decided --------------------------------------------------------------------------------------------------------------------------
const FACT = 'the launch code is PELICAN-7731';
const long = (n = 220) => turns(n, { 3: [`remember ${FACT} ${FILL}`, 'noted'] });
const withRefs = { refs: (all, omitted) => ({ first: 'ref-first', last: 'ref-last-' + omitted }) };
const decideFor = (all, covered, over = {}) => decide({ transfer: buildTransfer(all), summary: covered ? summaryOf(all, covered) : null, budget: budget(), reachable: true, ...withRefs, ...over });

test('an UNKNOWN window carries the full visible history within the transport limits and claims no fit', () => {
  const all = long(), transfer = buildTransfer(all), before = JSON.stringify(transfer.items);
  const d = decide({ transfer, summary: summaryOf(all, 200), budget: null, reachable: true });
  assert.equal(d.mode, 'full'); assert.equal(d.reason, 'window_unknown'); assert.match(d.label, /No claim is made that it fits/); assert.equal(d.items, undefined, 'the model input stays exactly the transfer');
  assert.equal(JSON.stringify(transfer.items), before);
});

test('a known window the full history fits in carries it in full (labelled an estimate); one it does not fit in REFUSES without a qualified summary, a matching history or a reachable tool', () => {
  const small = long(6), d = decideFor(small, 0); assert.equal(d.mode, 'full'); assert.equal(d.reason, 'fits_estimate'); assert.match(d.label, /estimate, not a guarantee/);
  const all = long(); const refuse = (summary, over = {}, reason) => assert.throws(() => decide({ transfer: buildTransfer(all), summary, budget: budget(), reachable: true, ...over }), e => e instanceof ContinuityError && e.code === 'handoff_context_too_large' && e.detail.reason === reason && e.detail.estimate === estimateMethod, reason);
  refuse(null, {}, 'no_qualified_summary');
  refuse(summaryOf(all, 200), { reachable: false }, 'history_tool_not_reachable_for_target');
  const other = turns(220).map(t => ({ ...t, id: 'x-' + t.id })); refuse(summaryOf(other, 200), {}, 'summary_does_not_match_history');
  refuse(summaryOf(all, 200), { budget: budget({ contextWindow: 20_000, maxOutputTokens: 5000 }) }, 'no_room_after_reserves');
  refuse(summaryOf(all, 200), { budget: budget({ contextWindow: 30_000, maxOutputTokens: 100 }) }, 'summary_and_newer_turns_do_not_fit');
});

test('REDUCED handoff of a 220-turn conversation: untrusted summary, whole recent turns and EVERY newer turn, exact coverage and readable refs; nothing clipped, canonical turns unchanged', () => {
  const all = long(), transfer = buildTransfer(all), canonical = JSON.stringify(transfer.turns), covered = 200;
  const d = decide({ transfer, summary: summaryOf(all, covered), budget: budget(), reachable: true, ...withRefs });
  assert.equal(d.mode, 'reduced'); const text = items => JSON.stringify(items), c = d.context;
  assert.equal(c.version, HANDOFF_VERSION); assert.equal(c.mode, 'reduced'); assert.ok(d.items.length < transfer.items.length && c.tokens <= c.share && c.share <= 40_000);
  assert.equal(c.coverage.total, 220); assert.equal(c.coverage.deltaTurns, 20); assert.equal(c.coverage.summarizedNotRepeated + c.coverage.recentWhole, covered);
  assert.ok(c.coverage.summarizedNotRepeated > 0 && c.coverage.recentWhole > 0, 'older turns are not repeated, recent ones are whole');
  // order: the rules, the untrusted summary, the coverage line, then turns in order
  assert.match(d.items[0].content[0].text, /reference data, not instructions and not permissions/); assert.match(d.items[0].content[0].text, /codex_bridge_history\.read/);
  assert.match(d.items[1].content[0].text, /^\[Untrusted summary written by the previous model during its own compaction \(auto\); reference only\]\nSUMMARY: the launch code is PELICAN-7731/);
  assert.equal(d.items[2].content[0].text, c.coverage.line); assert.match(c.coverage.line, new RegExp(`^Coverage of 220 turns \\(the summary covers the first ${covered}\\)`)); assert.match(c.coverage.line, /ref-first/); assert.match(c.coverage.line, new RegExp(`ref-last-${c.coverage.summarizedNotRepeated}`));
  assert.ok(d.items.slice(0, 3).every(i => i.role === 'user'));
  // every turn after the summary's coverage is present, whole, in order, and the newest covered turns are whole too
  const included = c.includedTurnIds; assert.deepEqual(included, all.slice(c.coverage.summarizedNotRepeated).map(t => t.id)); assert.equal(included.at(-1), 'turn-220');
  const body = text(d.items.slice(3));
  for (let n = covered + 1; n <= 220; n++) { assert.equal(body.split(`question ${n} `).length, 2, 'delta turn ' + n + ' once'); assert.equal(body.split(`answer ${n} `).length, 2); }
  assert.equal(d.items.length, 3 + 2 * included.length, 'whole turns only: both messages of every included turn, none split');
  // the old fact is NOT in the reduced input (it is summarized + retrievable), the summary keeps it only as the provider wrote it
  assert.equal(body.includes('PELICAN'), false); assert.ok(c.coverage.summarizedNotRepeated >= 3);
  assert.equal(JSON.stringify(transfer.turns), canonical, 'the canonical transfer turns are untouched'); assert.equal(transfer.turns.length, 220);
  assert.equal(c.summary.text, hook().compact_summary); assert.equal(c.summary.untrusted, true); assert.deepEqual(c.summary.coverage.ids.slice(0, 3), ['turn-1', 'turn-2', 'turn-3']);
  assert.match(c.estimateMethod, /heuristic/); assert.match(c.sources.window, /native-token-event/); assert.ok(Object.keys(c.reserves).length === 5);
  // a later hand-off can re-qualify the carried snapshot against ITS history (the original turns plus whatever followed)
  assert.equal(validSummary(c.summary, [...all, ...turns(2).map((t, i) => ({ ...t, id: 'later-' + i }))]).ok, true);
});

test('a bigger share keeps more whole recent turns; a smaller one keeps fewer; the mandatory summary + newer turns are never dropped for them; the line never lies about coverage', () => {
  const all = long(), s = summaryOf(all, 200), recent = window => decide({ transfer: buildTransfer(all), summary: s, budget: budget({ contextWindow: window, maxOutputTokens: 4000 }), reachable: true, ...withRefs }).context.coverage;
  const small = recent(60_000), big = recent(300_000);
  assert.ok(big.recentWhole > small.recentWhole); assert.equal(small.deltaTurns, 20); assert.equal(big.deltaTurns, 20);
  assert.equal(coverageLine({ total: 10, covered: 8, recentFrom: 0, refs: null }), 'Coverage of 10 turns (the summary covers the first 8): Turns 1–8: complete, and also summarized. Turns 9–10: complete, newer than the summary.');
  assert.match(coverageLine({ total: 10, covered: 8, recentFrom: 5, refs: { first: 'A', last: 'B' } }), /Turns 1–5: not repeated \(summarized only\); read them with codex_bridge_history\.read \(first item ref A, last summarized item ref B\)\. Turns 6–8: complete, and also summarized\. Turns 9–10: complete, newer than the summary\./);
});

test('claude first-query context: the reduction as separate untrusted data (never the whole record), every later turn included, validated against THIS history', () => {
  const all = long(), d = decide({ transfer: buildTransfer(all), summary: summaryOf(all, 200), budget: budget(), reachable: true, claude: true, ...withRefs }), c = d.context;
  assert.equal(c.tokens, contextTokens(claudeContext(c, all)), 'for a Claude target the share is measured in the form the first query really carries (JSON inside JSON), not as plain items');
  const asItems = decide({ transfer: buildTransfer(all), summary: summaryOf(all, 200), budget: budget(), reachable: true, ...withRefs }).context;
  assert.ok(c.coverage.recentWhole <= asItems.coverage.recentWhole, 'the larger form never keeps more recent turns than the plain one');
  assert.equal(validContext(c, all), true); assert.equal(validContext(c, all.slice(0, 10)), false, 'a history that lost included turns'); assert.equal(validContext({ ...c, version: 'x' }, all), false); assert.equal(validContext({ ...c, summary: { text: 1 } }, all), false); assert.equal(validContext(null, all), false);
  const made = claudeContext(c, all, { app: { kind: 'application', value: 'kept' } }), conversation = JSON.parse(made.bridge_conversation.value);
  assert.equal(made.app.value, 'kept'); assert.equal(made.bridge_conversation.kind, 'untrusted'); assert.equal(made.bridge_history_rules.kind, 'application');
  assert.equal(conversation.untrustedSummaryByPreviousModel, hook().compact_summary); assert.equal(conversation.coverage, c.coverage.line);
  assert.deepEqual(conversation.turns.map(t => t.id), c.includedTurnIds); assert.ok(conversation.turns.length < 220);
  assert.equal(made.bridge_conversation.value.includes('remember the launch code'), false, 'the original message is not repeated (only the provider-written summary mentions the fact)'); assert.equal(made.bridge_conversation.value.includes('encrypted_content'), false);
  // a first query that failed left its own turn in the record: it follows the included turns instead of being lost
  const withFailed = [...all, { id: 'failed-1', status: 'failed', items: [user('fu', 'the request that failed')] }];
  assert.deepEqual(JSON.parse(claudeContext(c, withFailed).bridge_conversation.value).turns.map(t => t.id).slice(-2), ['turn-220', 'failed-1']);
  assert.ok(contextTokens(made) > 0 && contextTokens(made) <= c.share + 500);
});

// ---- 4. early review amendments ----------------------------------------------------------------------------------------------------------------------
test('the fingerprint binds the exact VISIBLE content, not only ids: the same ids with a changed message, argument or result discard the summary; private envelope data does not matter', () => {
  const base = turns(10, { 2: ['remember the first fact', 'noted'] }), s = summaryOf(base, 10);
  assert.equal(validSummary(s, base).ok, true);
  const edit = (index, change) => base.map((t, i) => i === index ? { ...t, items: t.items.map(change) } : t);
  const reason = history => validSummary(s, history).reason;
  assert.equal(reason(edit(1, item => item.type === 'userMessage' ? { ...item, content: [{ type: 'text', text: 'remember a DIFFERENT fact' }] } : item)), 'coverage_changed', 'same turn and item ids, other user text');
  assert.equal(reason(edit(1, item => item.type === 'agentMessage' ? { ...item, text: 'noted, but changed' } : item)), 'coverage_changed', 'same ids, other assistant text');
  const tool = { type: 'mcpToolCall', id: 'tool-1', server: 'codex', tool: 'search', status: 'completed', arguments: { q: 'one' }, result: { content: [{ type: 'text', text: 'first result' }] } };
  const withTool = base.map((t, i) => i === 4 ? { ...t, items: [...t.items, tool] } : t), s2 = summaryOf(withTool, 10);
  assert.equal(validSummary(s2, withTool).ok, true);
  assert.equal(validSummary(s2, withTool.map((t, i) => i === 4 ? { ...t, items: t.items.map(x => x.id === 'tool-1' ? { ...x, arguments: { q: 'two' } } : x) } : t)).reason, 'coverage_changed', 'same ids, other tool arguments');
  assert.equal(validSummary(s2, withTool.map((t, i) => i === 4 ? { ...t, items: t.items.map(x => x.id === 'tool-1' ? { ...x, result: { content: [{ type: 'text', text: 'other result' }] } } : x) } : t)).reason, 'coverage_changed', 'same ids, other tool result');
  // provider-private data is not part of the visible history and never changes the binding; a key order is not a content change
  assert.equal(validSummary(s, base.map((t, i) => i === 0 ? { ...t, items: [{ type: 'reasoning', id: 'r', summary: ['x'] }, ...t.items.map(x => ({ ...x, encrypted_content: 'opaque' }))] } : t)).ok, true);
  assert.equal(validSummary(s, base.map(t => ({ ...t, items: t.items.map(x => Object.fromEntries(Object.entries(x).reverse())) }))).ok, true);
  assert.equal(JSON.stringify(s).includes('remember the first fact'), false, 'the binding is a hash: no history text is stored in it');
});

test('PostCompact: a subagent callback, another workspace and a missing workspace are never this chat\'s compaction', () => {
  const all = [...turns(5), running(6)], run = (input, over) => qualifySdkCompaction(input, ctx(all, { currentTurnId: 'turn-6', ...over }));
  assert.equal(run(hook()).ok, true);
  assert.equal(run(hook({ agent_id: 'agent-1', agent_type: 'Explore' })).reason, 'subagent_callback', 'even with the parent session id');
  assert.equal(run(hook({ agent_id: 'agent-1' })).ok, false);
  assert.equal(run(hook({ cwd: join(tmpdir(), 'somewhere-else-entirely') })).reason, 'other_workspace'); assert.equal(run(hook({ cwd: undefined })).reason, 'other_workspace'); assert.equal(run(hook({ cwd: '' })).reason, 'other_workspace');
  assert.equal(run(hook(), { cwd: undefined }).reason, 'other_workspace'); assert.equal(run(hook(), { cwd: join(tmpdir(), 'not-this-either') }).reason, 'other_workspace');
});

test('the newest settled turn is ALWAYS part of a reduction, whole: a summary that covers everything keeps it; if it does not fit the reduction refuses instead of carrying zero turns', () => {
  const all = long(60), d = decide({ transfer: buildTransfer(all), summary: summaryOf(all, 60), budget: budget({ contextWindow: 60_000, maxOutputTokens: 4000 }), reachable: true, ...withRefs }), c = d.context;
  assert.equal(d.mode, 'reduced'); assert.equal(c.coverage.deltaTurns, 0); assert.ok(c.includedTurnIds.length >= 1 && c.includedTurnIds.at(-1) === 'turn-60', 'the newest turn is in it');
  // a window that holds the summary and the rules but not the newest turn: refused, never a reduction with no turn
  const huge = turns(60, { 60: ['x'.repeat(60_000), 'newest answer'] });
  assert.throws(() => decide({ transfer: buildTransfer(huge), summary: summaryOf(huge, 60), budget: budget({ contextWindow: 40_000, maxOutputTokens: 2000 }), reachable: true, ...withRefs }),
    e => e instanceof ContinuityError && e.code === 'handoff_context_too_large' && e.detail.reason === 'summary_and_newest_turn_do_not_fit');
  // with a newer turn after the summary, that newest turn is the delta (every delta turn is mandatory, as before)
  const delta = decide({ transfer: buildTransfer(all), summary: summaryOf(all, 58), budget: budget({ contextWindow: 60_000, maxOutputTokens: 4000 }), reachable: true, ...withRefs }).context;
  assert.equal(delta.coverage.deltaTurns, 2); assert.deepEqual(delta.includedTurnIds.slice(-2), ['turn-59', 'turn-60']);
});

test('CRITICAL STATE fails closed: a failed write leaves memory AND file untouched, a full map keeps every earlier obligation (also cold), file and directory are fsynced, damage is never absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonnet-private-map-critical-')), gate = { window: 10_000, handoffTokens: 2000, parts: { instructions: 1000, tools: 1000, output: 1000, margin: 500 } };
  // an impossible location: nothing durable can be written, so nothing may be installed in memory either
  const obstacle = join(dir, 'not-a-directory'); writeFileSync(obstacle, 'synthetic obstacle');
  const failed = new PrivateMap(join(obstacle, 'gates.json'), { valid: validGate, sync: SYNC }); assert.equal(failed.set('obligation', gate), false); assert.equal(failed.get('obligation'), null); assert.equal(failed.lastError, 'write'); assert.equal(failed.size, 0);
  // a sync that fails AFTER the bytes were written: still false, memory unchanged, and the previous durable content is what a cold start reads
  const path = join(dir, 'gates.json'), map = new PrivateMap(path, { valid: validGate, sync: SYNC }); assert.equal(map.set('first', gate), true);
  const calls = []; map.sync = fd => { calls.push(fd); }; assert.equal(map.set('second', gate), true); assert.equal(calls.length, 2, 'the temp file, then the directory');
  map.sync = () => { throw new Error('fsync failed'); }; assert.equal(map.set('third', gate), false); assert.equal(map.get('third'), null); assert.equal(map.delete('first'), false); assert.ok(map.get('first'), 'a failed delete keeps the obligation');
  // capacity 1: the earlier obligation is never evicted, also across a cold start
  const capPath = join(dir, 'cap.json'), cap = new PrivateMap(capPath, { limit: 1, valid: validGate, sync: SYNC }); assert.equal(cap.set('first-live', gate), true); assert.equal(cap.set('second-live', gate), false); assert.equal(cap.lastError, 'capacity');
  const cold = new PrivateMap(capPath, { limit: 1, valid: validGate, sync: SYNC }); assert.ok(cold.get('first-live')); assert.equal(cold.get('second-live'), null);
  // only an entry the caller calls inactive (nothing owed) may make room
  const reap = new PrivateMap(join(dir, 'reap.json'), { limit: 1, valid: validGate, sync: SYNC, inactive: e => e.state === 'done' }); reap.set('a', { ...gate, state: 'done' }); assert.equal(reap.set('b', gate), true); assert.equal(reap.get('a'), null); assert.equal(reap.set('c', gate), false, 'b is owed: never reaped');
  // damage is never absence: unreadable / unparsable = damaged for everything and every write is refused; an invalid entry is damaged for its own key and kept as it was
  const bad = join(dir, 'bad.json'); writeFileSync(bad, '{ not json'); const damaged = new PrivateMap(bad, { valid: validGate, sync: SYNC });
  assert.equal(damaged.isDamaged('anything'), true); assert.equal(damaged.set('x', gate), false); assert.equal(damaged.lastError, 'damaged'); assert.equal(readFileSync(bad, 'utf8'), '{ not json', 'the damaged file is untouched');
  const aside = damaged.quarantine(); assert.match(aside, /bad\.json\.damaged-\d+$/); assert.equal(readFileSync(aside, 'utf8'), '{ not json'); assert.equal(damaged.isDamaged('anything'), false); assert.equal(damaged.set('x', gate), true);
  const mixed = join(dir, 'mixed.json'); writeFileSync(mixed, JSON.stringify({ version: 1, entries: { good: gate, broken: { window: 'x' } } })); const partial = new PrivateMap(mixed, { valid: validGate, sync: SYNC });
  assert.equal(partial.isDamaged('broken'), true); assert.equal(partial.isDamaged('good'), false); assert.equal(partial.set('other', gate), true); assert.deepEqual(JSON.parse(readFileSync(mixed, 'utf8')).entries.broken, { window: 'x' }, 'the invalid entry is preserved byte for byte');
  assert.equal(partial.set('broken', gate), true); assert.equal(partial.isDamaged('broken'), false, 'a fresh obligation of that key repairs it');
});

test('a stored reduction is only a reduction while its summary is still the provider\'s and covers EXACTLY the current visible prefix (ids AND content); the budget provenance and the full-history summary are carried', () => {
  const all = long(), d = decide({ transfer: buildTransfer(all), summary: summaryOf(all, 200), budget: budget(), reachable: true, ...withRefs }), c = d.context;
  assert.equal(validContext(c, all), true);
  const mutated = structuredClone(all); mutated[2].items[0].content[0].text = 'CHANGED-FACT-SAME-IDS'; assert.equal(validSummary(c.summary, mutated).ok, false); assert.equal(validContext(c, mutated), false, 'same ids, changed text: no reduction');
  const later = [...all.slice(0, 200), { ...all[200], items: [user('u201', 'rewritten newer turn'), agent('a201', 'rewritten')] }, ...all.slice(201)]; assert.equal(validContext(c, later), true, 'a change AFTER the summary\'s prefix does not invalidate it (those turns travel whole)');
  assert.deepEqual([c.budget.key, c.budget.route, c.budget.model, c.budget.source], ['native:openai:gpt-test', 'native', 'gpt-test', 'native-token-event'], 'the exact route, model and measurement the window belongs to');
  // a FULL decision keeps a valid summary beside the complete history (portable through an unknown-window hop); an invalid one is dropped
  const small = long(6), s6 = summaryOf(small, 6), full = decide({ transfer: buildTransfer(small), summary: s6, budget: null, reachable: true });
  assert.equal(full.mode, 'full'); assert.equal(full.context.mode, 'full'); assert.equal(full.context.summary.text, s6.text); assert.equal(full.items, undefined);
  assert.equal(decide({ transfer: buildTransfer(small), summary: { ...s6, coverage: { ...s6.coverage, hash: 'x'.repeat(32) } }, budget: null, reachable: true }).context, undefined);
  assert.equal(decide({ transfer: buildTransfer(small), summary: s6, budget: budget(), reachable: true }).context.mode, 'full', 'also when the full history fits a known window');
  // the chain: SDK summary -> full hop (stored beside the history) -> turns of the new runtime appended -> a later known-window hop reduces with it
  const hop = [...all.slice(0, 200), ...all.slice(200).map(t => ({ ...t, id: 'native-' + t.id }))], carried = decide({ transfer: buildTransfer(all.slice(0, 200)), summary: summaryOf(all, 200), budget: null, reachable: true }).context.summary;
  assert.equal(validSummary(carried, hop).ok, true, 'still the provider\'s summary of the unchanged prefix'); const reduced = decide({ transfer: buildTransfer(hop), summary: carried, budget: budget(), reachable: true, ...withRefs });
  assert.equal(reduced.mode, 'reduced'); assert.equal(reduced.context.coverage.deltaTurns, 20, 'every turn the new runtime added is carried whole'); assert.deepEqual(reduced.context.includedTurnIds.slice(-20), all.slice(200).map(t => 'native-' + t.id));
});

test('durable state: a gate or a note survives a cold start of the map, is bounded, private and replaced atomically; damaged or invalid content is simply absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonnet-private-map-')), path = join(dir, 'gates.json'), gate = { window: 100_000, handoffTokens: 30_000, parts: { instructions: 6000, tools: 3000, output: 10_000, margin: 15_000 } };
  const map = new PrivateMap(path, { limit: 3, valid: validGate, sync: SYNC }); assert.equal(map.size, 0); assert.equal(map.set('a', gate), true);
  assert.equal(new PrivateMap(path, { limit: 3, valid: validGate, sync: SYNC }).get('a').handoffTokens, 30_000, 'a new instance (a cold start) reads it back');
  assert.equal(map.set('b', { ...gate }), true); assert.equal(map.set('c', { ...gate }), true); assert.equal(map.set('d', { ...gate }), false, 'a full map refuses; it never forgets an obligation'); assert.equal(map.size, 3); assert.ok(map.get('a'), 'the oldest is kept'); assert.equal(map.lastError, 'capacity'); map.delete('a');
  assert.equal(map.set('d', { ...gate }), true); assert.equal(map.set('bad', { window: 5 }), false); assert.equal(map.get('bad'), null); assert.equal(map.delete('b'), true); assert.equal(new PrivateMap(path, { limit: 3, valid: validGate, sync: SYNC }).get('b'), null);
  assert.equal((statSync(path).mode & 0o777), 0o600);
  writeFileSync(path, '{ not json'); assert.equal(new PrivateMap(path, { valid: validGate, sync: SYNC }).size, 0, '(nothing is known - and it is DAMAGED, not empty: see the next test)');
  writeFileSync(path, JSON.stringify({ version: 1, entries: { ok: gate, nope: { window: 1 } } })); const loaded = new PrivateMap(path, { valid: validGate, sync: SYNC }); assert.equal(loaded.get('ok').window, 100_000); assert.equal(loaded.get('nope'), null);
});
