import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeHandoff } from '../runtime-handoff.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// PK1: the package ships every file the product imports. Statically, from the files this work added or changed: every relative
// import must resolve to a file that package.json "files" lists (or to something inside a listed directory).
test('PK1: package.json files lists every relative import of the handoff runtime; the three new modules are shipped', () => {
  const repo = fileURLToPath(new URL('../', import.meta.url)), pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')), listed = new Set(pkg.files);
  for (const name of ['continuity.mjs', 'runtime-handoff.mjs', 'custom-turns.mjs']) assert.ok(listed.has(name), name + ' is shipped');
  assert.equal(new Set(pkg.files).size, pkg.files.length, 'no duplicate entry'); assert.deepEqual(Object.keys(pkg).sort(), ['author', 'bin', 'dependencies', 'description', 'engines', 'files', 'license', 'name', 'private', 'repository', 'scripts', 'type', 'version'], 'no other metadata appeared');
  const shipped = rel => listed.has(rel) || pkg.files.some(entry => !entry.includes('.') && rel.startsWith(entry + '/'));
  const seen = new Set(), queue = ['bridge.mjs', 'providers.mjs', 'continuity.mjs', 'runtime-handoff.mjs', 'custom-turns.mjs', 'plugins/codex-claude/home/providers.mjs'];
  while (queue.length) {
    const rel = queue.pop(); if (seen.has(rel)) continue; seen.add(rel);
    assert.ok(shipped(rel), rel + ' is imported by shipped code but is not in package.json files');
    const source = readFileSync(join(repo, rel), 'utf8');
    for (const [, spec] of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(relative(repo, normalize(join(repo, dirname(rel), spec))));
  }
  for (const name of ['continuity.mjs', 'runtime-handoff.mjs', 'custom-turns.mjs', 'rpc.mjs', 'providers.mjs']) assert.ok(seen.has(name), name + ' is part of the checked closure');
});

// The sequence every provider/runtime continuation follows, with a recording adapter. Pure: no registry, process or network.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const user = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] });
const agent = (id, text) => ({ type: 'agentMessage', id, text });
const turns = [{ id: 't1', status: 'completed', items: [user('u1', 'EARLIER-CONTEXT-1'), agent('a1', 'ack'), { type: 'reasoning', id: 'r', summary: [], content: [], encrypted_content: 'OPAQUE' }] }];
const BEFORE = { thread: { id: 'src', status: { type: 'idle' } }, model: 'm-src', modelProvider: 'prov-src', reasoningEffort: 'medium', cwd: '/w', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: null };
function rig(over = {}) {
  const log = [], receipts = [], state = { effort: 'medium', ...over.state };
  const answer = () => ({ thread: { id: state.id ?? 'new' }, model: 'm-tgt', modelProvider: 'prov-tgt', reasoningEffort: state.effort, cwd: '/w', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: null, ...over.answer });
  const adapter = {
    pending: () => over.pending ?? false,
    checkOverrides: () => log.push('overrides'),
    start: async () => { log.push('start'); return answer(); },
    confirm: a => (log.push('confirm'), a.modelProvider === 'prov-tgt' && a.model === 'm-tgt' && a.thread.id !== 'src'),
    permissionsKept: (b, a) => ['cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'activePermissionProfile'].every(k => JSON.stringify(b[k] ?? null) === JSON.stringify(a[k] ?? null)),
    setEffort: async (id, effort) => { log.push('effort:' + effort); if (over.effortError) throw over.effortError; return { ...answer(), reasoningEffort: over.ignoreEffort ? state.effort : effort }; },
    deliver: async (id, items) => { log.push('deliver:' + items.length); if (over.deliverError) throw over.deliverError; state.delivered = [...(state.delivered ?? []), ...items]; },
    revalidate: () => { log.push('revalidate'); if (over.revalidate) over.revalidate(); },
    publish: async (a, c, t, p) => { log.push('publish'); if (over.publishError) throw over.publishError; state.published = { a, c, t, p }; },
    archive: async id => { log.push('archive:' + id); if (over.archiveError) throw over.archiveError; return true; },
    receipt: r => receipts.push(r),
  };
  return { adapter, log, receipts, state, run: (extra = {}) => runtimeHandoff({ sourceId: 'src', before: over.before ?? BEFORE, turns: over.turns ?? turns, adapter, fail, ...extra }) };
}

test('success: refuse-first checks, one start, readbacks, the carried conversation delivered once, then publish; nothing is archived', async () => {
  const r = rig(), done = await r.run();
  assert.deepEqual(r.log, ['overrides', 'start', 'confirm', 'deliver:3', 'revalidate', 'publish']); // the rules line, the user message and the assistant message
  assert.equal(done.created, 'new'); assert.notEqual(done.created, 'src'); assert.equal(done.provenance.sourceId, 'src'); assert.equal(done.provenance.targetId, 'new');
  assert.match(JSON.stringify(r.state.delivered), /EARLIER-CONTEXT-1/); assert.doesNotMatch(JSON.stringify(r.state.delivered), /OPAQUE/);
  assert.equal(done.transfer.report.omitted.reasoning, 1); assert.deepEqual(r.receipts, []);
});

test('an empty source is delivered nothing: no seed turn, no invented items', async () => {
  const r = rig({ turns: [] }); await r.run(); assert.deepEqual(r.log.filter(x => x.startsWith('deliver')), []); assert.ok(r.log.includes('publish'));
});

test('refusals happen before any thread exists: active source, wrong identity, unfit history, pending earlier outcome', async () => {
  const active = rig({ before: { ...BEFORE, thread: { id: 'src', status: { type: 'active' } } } });
  await assert.rejects(active.run(), { code: 'model_change_requires_idle' }); assert.deepEqual(active.log, []);
  const wrong = rig({ before: { ...BEFORE, thread: { id: 'other', status: { type: 'idle' } } } });
  await assert.rejects(wrong.run(), { code: 'native_thread_identity_invalid' }); assert.deepEqual(wrong.log, []);
  const huge = rig({ turns: [{ id: 't', status: 'completed', items: [user('u', 'x'.repeat(5 * 1024 * 1024))] }] });
  await assert.rejects(huge.run(), { code: 'handoff_context_too_large' }); assert.deepEqual(huge.log, [], 'no thread is created for a history that does not fit');
  const nothing = rig({ turns: [{ id: 't', status: 'completed', items: [{ type: 'sleep', id: 's' }] }] });
  await assert.rejects(nothing.run(), { code: 'handoff_content_unsupported' }); assert.deepEqual(nothing.log, [], 'a visible item that cannot be carried refuses the move before a thread exists');
  const pending = rig({ pending: true }); await assert.rejects(pending.run(), { code: 'native_thread_created_but_route_not_saved' }); assert.deepEqual(pending.log, []);
});

test('an unconfirmed target (wrong provider, model or the source ID) is withdrawn and only the just-created thread is archived', async () => {
  for (const answer of [{ modelProvider: 'prov-other' }, { model: 'm-other' }]) {
    const r = rig({ answer }); await assert.rejects(r.run(), { code: 'native_selection_not_confirmed' });
    assert.deepEqual(r.log, ['overrides', 'start', 'confirm', 'archive:new']); assert.deepEqual(r.receipts, []);
  }
  const same = rig({ state: { id: 'src' } }); await assert.rejects(same.run(), { code: 'native_selection_not_confirmed' });
  assert.ok(!same.log.some(x => x.startsWith('archive')), 'the source thread is never archived');
});

test('CF1: a target whose workspace, sandbox, approval, reviewer or permission profile differs is never published', async () => {
  for (const answer of [{ cwd: '/elsewhere' }, { sandbox: { type: 'dangerFullAccess' } }, { approvalPolicy: 'on-request' }, { approvalsReviewer: 'auto_review' }, { activePermissionProfile: { id: 'broader' } }]) {
    const r = rig({ answer }); await assert.rejects(r.run(), { code: 'native_permissions_changed' });
    assert.ok(r.log.includes('archive:new')); assert.ok(!r.log.some(x => x.startsWith('deliver')) && !r.log.includes('publish'), 'nothing is delivered to a target with different permissions');
  }
});

test('CF2: an explicit level is applied to the new thread and read back exactly, otherwise the target is withdrawn', async () => {
  const ok = rig(); const done = await ok.run({ wantedEffort: 'high' }); assert.equal(done.answer.reasoningEffort, 'high'); assert.ok(ok.log.includes('effort:high'));
  const same = rig(); await same.run({ wantedEffort: 'medium' }); assert.ok(!same.log.some(x => x.startsWith('effort')), 'already at the wanted level: nothing to apply');
  const ignored = rig({ ignoreEffort: true }); await assert.rejects(ignored.run({ wantedEffort: 'high' }), { code: 'native_selection_not_confirmed' }); assert.ok(ignored.log.includes('archive:new'));
  const refused = rig({ effortError: Object.assign(new Error('synthetic refusal'), { code: -32600 }) }); await assert.rejects(refused.run({ wantedEffort: 'high' }), /synthetic refusal/); assert.ok(refused.log.includes('archive:new'));
});

test('CF3: a connection, route or source that changed while this ran blocks publication and removes the new thread', async () => {
  const r = rig({ revalidate: () => fail('connection_changed') }); await assert.rejects(r.run(), { code: 'connection_changed' });
  assert.ok(r.log.includes('archive:new')); assert.ok(!r.log.includes('publish'));
});

test('CF4: a failed delivery or publication removes only the new thread; an unconfirmed cleanup leaves a receipt that blocks a blind retry', async () => {
  const delivery = rig({ deliverError: new Error('synthetic delivery failure') }); await assert.rejects(delivery.run(), /synthetic delivery failure/);
  assert.ok(delivery.log.includes('archive:new')); assert.deepEqual(delivery.receipts, []); assert.ok(!delivery.log.includes('publish'));
  const published = rig({ publishError: Object.assign(new Error('route'), { code: 'native_thread_created_but_route_not_saved' }) });
  await assert.rejects(published.run(), { code: 'native_thread_created_but_route_not_saved' });
  assert.ok(published.log.includes('archive:new')); assert.deepEqual(published.receipts, [], 'a confirmed cleanup leaves no record: the single intent is the authority');
  const stuck = rig({ publishError: new Error('route'), archiveError: new Error('archive failed') }); await assert.rejects(stuck.run(), /route/);
  assert.deepEqual(stuck.receipts.map(x => x.archived), [false], 'a cleanup that could not archive is recorded: the child may still exist');
  // LP9: a publication whose commit may have happened (uncertain) or whose abort could not be recorded (deferCleanup) triggers NO cleanup at all.
  for (const tag of ['uncertain', 'deferCleanup']) {
    const maybe = rig({ publishError: Object.assign(new Error('maybe committed'), { code: 'route_publication_uncertain', [tag]: true }) });
    await assert.rejects(maybe.run(), { code: 'route_publication_uncertain' }); assert.ok(!maybe.log.some(x => x.startsWith('archive')), tag + ': the child is never archived'); assert.deepEqual(maybe.receipts, [], tag + ': no receipt is rewritten');
  }
  const failedDelivery = rig({ deliverError: new Error('d'), archiveError: new Error('a') }); await assert.rejects(failedDelivery.run(), /d/);
  assert.deepEqual(failedDelivery.receipts.map(x => [x.state, x.archived]), [['failed_after_create', false]]);
});

// LONG HISTORY: a target that takes plain items gets them in chunks of 100; a target that takes the canonical history as one typed whole (a managed Claude chat) gets deliverAll exactly once.
const longTurns = [{ id: 'big', status: 'completed', items: Array.from({ length: 450 }, (_, i) => user('u' + i, i === 2 ? 'FIRST-FACT' : i === 449 ? 'LAST-FACT' : 'm' + i)) }];
test('LONG: chunked delivery keeps chunks of 100 in order, none dropped or repeated', async () => {
  const r = rig({ turns: longTurns }); await r.run();
  assert.deepEqual(r.log.filter(x => x.startsWith('deliver')), ['deliver:100', 'deliver:100', 'deliver:100', 'deliver:100', 'deliver:51']); // the rules line + 450 messages
  const text = JSON.stringify(r.state.delivered); assert.equal(r.state.delivered.length, 451); assert.equal(text.split('FIRST-FACT').length - 1, 1); assert.equal(text.split('LAST-FACT').length - 1, 1);
});
test('LONG: a whole-transfer target is given the one whole transfer exactly once, before the final revalidation and the commit; nothing is chunked', async () => {
  const r = rig({ turns: longTurns }), calls = []; delete r.adapter.deliver;
  r.adapter.deliverAll = async (id, transfer) => { r.log.push('deliverAll'); calls.push({ id, items: transfer.items.length, turns: transfer.turns.map(t => t.id), messages: transfer.turns.flatMap(t => t.items).length, text: JSON.stringify(transfer.turns) }); };
  await r.run();
  assert.equal(calls.length, 1); assert.equal(calls[0].id, 'new'); assert.equal(calls[0].items, 451); assert.deepEqual(calls[0].turns, ['big']); assert.equal(calls[0].messages, 450);
  assert.equal(calls[0].text.split('FIRST-FACT').length - 1, 1); assert.equal(calls[0].text.split('LAST-FACT').length - 1, 1);
  assert.deepEqual(r.log, ['overrides', 'start', 'confirm', 'deliverAll', 'revalidate', 'publish']);
});
test('CONTEXT: the adapter chooses the target\'s MODEL input (the canonical turns stay complete); a refusal withdraws the target; the note is staged after the final readback and before the source is validated again', async () => {
  const r = rig({ turns: longTurns }); let staged = null;
  r.adapter.reduce = async transfer => { r.log.push('reduce'); return { mode: 'reduced', items: transfer.items.slice(0, 4), context: { mode: 'reduced', marker: 1 } }; };
  r.adapter.settle = async () => { r.log.push('settle'); }; r.adapter.deliverNotice = async (id, given) => { r.log.push('notice'); staged = { id, turns: given.transfer.turns.length, items: given.transfer.items.length, handoff: given.transfer.handoff.mode, confirmedModel: given.confirmed.model, effort: given.confirmed.reasoningEffort }; };
  await r.run();
  assert.deepEqual(r.log, ['overrides', 'start', 'confirm', 'reduce', 'deliver:4', 'settle', 'notice', 'revalidate', 'publish']);
  assert.equal(r.state.delivered.length, 4, 'only the chosen model input was delivered'); assert.equal(r.state.published.t.turns.length, 1); assert.equal(r.state.published.t.turns[0].items.length, 450, 'the canonical turns are complete');
  assert.deepEqual(r.state.published.t.context, { mode: 'reduced', marker: 1 }); assert.equal(r.state.published.t.items.length, 451, 'the full item list is untouched');
  assert.deepEqual(staged, { id: 'new', turns: 1, items: 451, handoff: 'reduced', confirmedModel: 'm-tgt', effort: 'medium' }, 'built from the confirmed readback');
  const full = rig({ turns: longTurns }); full.adapter.reduce = async () => ({ mode: 'full', reason: 'window_unknown' }); await full.run();
  assert.equal(full.state.delivered.length, 451); assert.equal(full.state.published.t.context, undefined); assert.equal(full.state.published.t.handoff.mode, 'full');
  const refused = rig({ turns: longTurns }); refused.adapter.reduce = async () => { throw Object.assign(new Error('too large'), { code: 'handoff_context_too_large' }); }; let noted = false; refused.adapter.deliverNotice = async () => { noted = true; };
  await assert.rejects(refused.run(), { code: 'handoff_context_too_large' });
  assert.deepEqual(refused.log.filter(x => /^(deliver|publish|archive)/.test(x)), ['archive:new']); assert.equal(noted, false, 'no note was ever staged');
});
test('CONTEXT: a failed note, a failed final validation or an unpublished commit withdraw the target (no model consumed the note); an uncertain commit triggers no cleanup', async () => {
  const noteFails = rig(); noteFails.adapter.deliverNotice = async () => { throw new Error('note failed'); };
  await assert.rejects(noteFails.run(), /note failed/); assert.deepEqual(noteFails.log.filter(x => /^(publish|archive|revalidate)/.test(x)), ['archive:new']);
  const stale = rig({ revalidate: () => { throw Object.assign(new Error('stale'), { code: 'stale_revision' }); } }); let n = 0; stale.adapter.deliverNotice = async () => { n++; };
  await assert.rejects(stale.run(), { code: 'stale_revision' }); assert.equal(n, 1, 'staged, inert'); assert.deepEqual(stale.log.filter(x => /^(publish|archive)/.test(x)), ['archive:new']);
  const unpublished = rig({ publishError: new Error('route') }); unpublished.adapter.deliverNotice = async () => {}; await assert.rejects(unpublished.run(), /route/); assert.ok(unpublished.log.includes('archive:new'));
  const uncertain = rig({ publishError: Object.assign(new Error('maybe committed'), { code: 'route_publication_uncertain', uncertain: true }) }); uncertain.adapter.deliverNotice = async () => {};
  await assert.rejects(uncertain.run(), { code: 'route_publication_uncertain' }); assert.ok(!uncertain.log.some(x => x.startsWith('archive')), 'no destructive cleanup, no retry'); assert.deepEqual(uncertain.receipts, []);
});
test('LONG: a whole-transfer target that fails withdraws only the new thread, publishes nothing and is not retried; an empty source calls it never', async () => {
  const bad = rig({ turns: longTurns }); delete bad.adapter.deliver; let n = 0; bad.adapter.deliverAll = async () => { n++; throw new Error('import failed'); };
  await assert.rejects(bad.run(), /import failed/); assert.equal(n, 1); assert.deepEqual(bad.log.filter(x => x === 'publish' || x.startsWith('archive')), ['archive:new']); assert.deepEqual(bad.receipts, []);
  const none = rig({ turns: [] }); delete none.adapter.deliver; none.adapter.deliverAll = async () => { throw new Error('must not be called'); };
  await none.run(); assert.ok(none.log.includes('publish'));
});
