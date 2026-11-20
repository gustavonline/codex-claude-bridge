import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnections, readConnections, setEnabled, setVisible, storeFile } from '../connections.mjs';
import { fixture } from './support/fixture.mjs';

// The vertical slice with the real Bridge: the persisted connection decision reaches
// model/list and the admission of new Claude work. The SDK catalog and query are the
// fixture's existing seams (getModels, runQuery): no Claude executable, login, model
// request or network is involved. Native GPT is the fixture's fake host, as in the
// other Bridge tests. This needs the pinned SDK package to import bridge.mjs, so it
// runs where the dependencies are installed.
const text = value => [{ type: 'text', text: value }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const models = result => result.data.map(model => model.model);
const stored = dir => readConnections(dir).store.connections.claude_code;

async function setup(run) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-connection-root-'));
  createConnections(dir);
  const f = fixture('openai', { connectionRoot: dir });
  try { await run(f, dir); } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('the persisted decision reaches model/list: native entries stay first and unchanged, hide and disable only change what is offered, and the choice survives re-enable', () => setup(async (f, dir) => {
  const nativeOnly = ['gpt-test', 'gpt-other'];
  assert.deepEqual(models(await f.bridge.request('model/list', {})), [...nativeOnly, 'haiku', 'sonnet'], 'a fresh store keeps the earlier behaviour');
  assert.deepEqual([stored(dir).catalog.models.map(m => m.value), stored(dir).catalog.status, stored(dir).evidence.catalog], [['haiku', 'sonnet'], 'fresh', 'observed'], 'the SDK catalog was observed and recorded');
  assert.deepEqual(stored(dir).evidence.offered.ids, ['haiku', 'sonnet']);
  assert.deepEqual([stored(dir).evidence.authentication, stored(dir).evidence.inference, stored(dir).evidence.picker], ['unknown', 'unverified', 'unknown']);
  const first = (await f.bridge.request('model/list', {})).data.slice(0, 2);
  assert.deepEqual(first.map(m => m.id), nativeOnly);

  setVisible(dir, ['sonnet']);
  assert.deepEqual(models(await f.bridge.request('model/list', {})), [...nativeOnly, 'sonnet'], 'a hidden model leaves new choices');
  const withHidden = (await f.bridge.request('model/list', { includeHidden: true })).data;
  assert.deepEqual(withHidden.map(m => [m.model, m.hidden ?? false]).slice(2), [['haiku', true], ['sonnet', false]], 'includeHidden identifies the retained hidden model');
  assert.deepEqual(stored(dir).evidence.offered.ids, ['sonnet'], 'what was offered is recorded as such, not as picker proof');

  setEnabled(dir, false);
  assert.deepEqual(models(await f.bridge.request('model/list', {})), nativeOnly, 'disabled leaves exactly the native catalog');
  assert.deepEqual((await f.bridge.request('model/list', { includeHidden: true })).data.slice(2).map(m => [m.model, m.hidden]), [['haiku', true], ['sonnet', true]]);

  setEnabled(dir, true);
  assert.deepEqual(models(await f.bridge.request('model/list', {})), [...nativeOnly, 'sonnet'], 'the visibility decision survived disable and re-enable');
  const page = await f.bridge.request('model/list', { limit: 2 });
  assert.deepEqual([models(page), page.nextCursor], [nativeOnly, '2'], 'paging runs over the merged list');
  assert.deepEqual(models(await f.bridge.request('model/list', { limit: 2, cursor: page.nextCursor })), ['sonnet']);
}));

test('disabled Claude Code refuses every route that would start new Claude work, while chats stay readable and GPT keeps working', () => setup(async (f, dir) => {
  const id = await f.start('haiku');
  const first = await f.send(id, 'one'); await f.done(first.turn.id);
  const turns = () => JSON.parse(readFileSync(join(f.statePath, `${id}.json`), 'utf8')).turns;
  const before = turns(), queriesBefore = f.queries.length;
  setEnabled(dir, false);

  await assert.rejects(f.start('haiku'), /disabled/, 'a new Claude chat');
  await assert.rejects(f.bridge.request('thread/start', { model: 'sonnet', cwd: f.statePath }), /disabled/, 'a stale direct request');
  await assert.rejects(f.send(id, 'two'), /disabled/, 'a new turn in an existing Claude chat');
  await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, model: 'sonnet', effort: 'high' }), /disabled/, 'a settings change to Claude');
  await assert.rejects(f.bridge.request('thread/fork', { threadId: id, model: 'haiku' }), /disabled/, 'a fork');
  await assert.rejects(f.bridge.selectModel('sonnet'), /disabled/, 'the selection used by the session create tool');
  const queued = (await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'Q1', input: text('later') })).queuedSubmission;
  await assert.rejects(f.bridge.request('thread/queue/start', { threadId: id }), /disabled/, 'starting a queued message');
  assert.equal(f.bridge.records.get(id).queue.length, 1, 'the queued message is kept, not dropped');
  assert.equal(f.queries.length, queriesBefore, 'no Claude query started');
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1, 'no native thread was created for a refused chat');

  assert.equal((await f.bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns.length, 1, 'history stays readable');
  const listed = []; let cursor;
  do { const page = await f.bridge.request('thread/list', { limit: 1, ...(cursor ? { cursor } : {}) }); listed.push(...page.data); cursor = page.nextCursor; } while (cursor);
  const row = listed.find(thread => thread.id === id);
  assert.ok(row, 'a retained Claude chat is still discoverable while disabled');
  assert.deepEqual([row.modelProvider, row.model, row.turns], ['claude_code', 'haiku', []], 'it keeps its Claude identity; the native seed is not substituted');
  assert.deepEqual(turns(), before, 'the transcript is unchanged');
  await f.bridge.request('thread/queue/delete', { threadId: id, queuedSubmissionId: queued.id });
  f.restart();
  assert.ok((await f.bridge.request('thread/resume', { threadId: id })).thread, 'an existing Claude chat can be reopened while disabled');
  assert.deepEqual(turns(), before, 'reopening did not change the transcript');
  assert.ok((await f.bridge.request('thread/list', {})).data.some(thread => thread.id === id), 'and is still listed after the restart');
  assert.equal(f.queries.length, queriesBefore, 'reading, listing and reopening started no Claude query');

  // GPT is untouched: the same chat can move to a GPT model and answer natively.
  await f.bridge.request('thread/settings/update', { threadId: id, model: 'gpt-test', effort: 'low' });
  const native = await f.send(id, 'gpt'); await f.done(native.turn.id);
  assert.equal(f.queries.length, queriesBefore, 'still no Claude query');
  assert.deepEqual(f.hosts.get((await f.start('gpt-test'))).settings.model, 'gpt-test', 'a new GPT chat starts normally');

  setEnabled(dir, true);
  assert.ok(await f.start('haiku'), 're-enabling allows new Claude work again');
}));

test('hiding a model blocks a new choice of it but never an existing chat that already uses it', () => setup(async (f, dir) => {
  const id = await f.start('haiku');
  const first = await f.send(id, 'one'); await f.done(first.turn.id);
  setVisible(dir, ['sonnet']);
  const second = await f.send(id, 'still works'); await f.done(second.turn.id);
  assert.equal(f.queries.length, 2, 'an existing chat keeps its hidden model');
  await assert.rejects(f.start('haiku'), /hidden/, 'a new chat cannot choose it');
  const fresh = await f.start('sonnet');
  await assert.rejects(f.bridge.request('thread/settings/update', { threadId: fresh, model: 'haiku', effort: 'none' }), /hidden/, 'switching to it is a new choice');
  const fork = await f.bridge.request('thread/fork', { threadId: id, model: 'haiku' });
  assert.equal(fork.model, 'haiku', 'a fork keeps the known model of its source');
}));

test('a change made while a turn is being prepared still applies at the last check before the turn is accepted', () => setup(async (f, dir) => {
  const id = await f.start('haiku');
  const queries = f.queries.length;
  await assert.rejects(f.bridge.request('turn/start', { threadId: id, input: text('x'), clientUserMessageId: randomUUID() },
    { admit: () => setEnabled(dir, false) }), /disabled/);
  assert.equal(f.queries.length, queries, 'no query started');
  assert.equal(f.bridge.records.get(id).turns.length, 0, 'no turn was recorded');
  assert.equal(f.bridge.starting.has(id), false);
}));

test('a running turn finishes, accepted steering completes, queued work stays paused, and re-enabling replays nothing', () => setup(async (f, dir) => {
  const id = await f.start('haiku');
  const held = deferred(), resume = deferred();
  f.controls.query = async () => { held.resolve(); await resume.promise; };
  // The receipt a real steered turn ends with: the replayed user message, then a result naming its UUID.
  f.controls.messages = async function* (args) {
    f.controls.messages = undefined;
    for await (const message of args.steeringInput) { yield { ...message, isReplay: true }; yield { type: 'result', subtype: 'success', user_message_uuids: [args.promptId, message.uuid] }; break; }
  };
  const turn = await f.send(id, 'running'); await held.promise;
  await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'Q1', input: text('queued') });
  setEnabled(dir, false);
  await f.bridge.request('turn/steer', { threadId: id, expectedTurnId: turn.turn.id, input: text('steer'), clientUserMessageId: 'S1' });
  f.controls.query = undefined; resume.resolve();
  assert.equal((await f.done(turn.turn.id)).params.turn.status, 'completed', 'the admitted turn finished');
  assert.deepEqual(f.bridge.records.get(id).turns[0].steering.map(s => s.status), ['delivered'], 'the accepted steering was delivered');
  await pause(60);
  assert.equal(f.queries.length, 1, 'the queued message did not start');
  assert.equal(f.bridge.records.get(id).queue.length, 1);
  setEnabled(dir, true);
  await pause(60);
  assert.equal(f.queries.length, 1, 're-enabling does not replay queued work');
  assert.equal(f.bridge.records.get(id).queue.length, 1);
  const next = await f.bridge.request('thread/queue/start', { threadId: id }); await f.done(next.turn.id);
  assert.equal(f.queries.length, 2, 'an explicit start works again');
}));

test('restarting the Bridge keeps the decision, and hide, disable and re-enable never rewrite a transcript', () => setup(async (f, dir) => {
  const id = await f.start('sonnet');
  const first = await f.send(id, 'keep'); await f.done(first.turn.id);
  const file = join(f.statePath, `${id}.json`), snapshot = readFileSync(file);
  setVisible(dir, ['sonnet']); setEnabled(dir, false);
  f.restart();
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other'], 'disabled survives a restart');
  await assert.rejects(f.send(id, 'no'), /disabled/);
  setEnabled(dir, true);
  f.restart();
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'sonnet'], 'visibility survived');
  assert.deepEqual(readFileSync(file), snapshot, 'the stored transcript bytes never changed');
  assert.equal(f.bridge.records.get(id).turns[0].id, first.turn.id);
}));

test('the SDK catalog refreshes once at a time, a failed refresh keeps the last catalog labelled stale, and a first failure is not cached', () => setup(async (f, dir) => {
  let calls = 0;
  f.bridge.getModels = async () => { calls += 1; await pause(20); return [{ value: 'haiku' }, { value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }]; };
  await Promise.all([f.bridge.refreshCatalog(), f.bridge.refreshCatalog()]);
  assert.equal(calls, 1, 'two concurrent refreshes share one SDK query');
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'haiku', 'opus']);
  assert.deepEqual([stored(dir).catalog.status, stored(dir).catalog.models.map(m => m.value)], ['fresh', ['haiku', 'opus']]);
  f.bridge.getModels = async () => { throw new Error('SYNTHETIC SDK DOWN at /private/secret/path'); };
  await assert.rejects(f.bridge.refreshCatalog(), /SYNTHETIC/);
  assert.deepEqual([stored(dir).catalog.status, stored(dir).catalog.error, stored(dir).evidence.catalog], ['stale', 'catalog_failed', 'failed'], 'labelled stale, not fresh');
  assert.deepEqual(stored(dir).catalog.models.map(m => m.value), ['haiku', 'opus'], 'the last valid catalog is kept');
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'haiku', 'opus'], 'the offered catalog is unchanged');
  assert.doesNotMatch(readFileSync(join(dir, storeFile), 'utf8'), /SYNTHETIC|private|secret/, 'no error text or path reaches the store');
  f.bridge.getModels = async () => [{ value: 'haiku' }];
  await f.bridge.refreshCatalog();
  assert.deepEqual([stored(dir).catalog.status, stored(dir).catalog.models.length], ['fresh', 1]);
}));

test('a failing first catalog is not cached and leaves GPT intact; a colliding or repeating Claude catalog never overwrites GPT', () => setup(async (f, dir) => {
  let broken = true;
  f.bridge.getModels = async () => { if (broken) throw new Error('SYNTHETIC'); return [{ value: 'haiku' }]; };
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other'], 'GPT is listed without Claude');
  assert.equal(stored(dir).evidence.catalog, 'failed');
  broken = false;
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other', 'haiku'], 'the failure was not cached');
  f.bridge.modelPromise = null;
  f.bridge.getModels = async () => [{ value: 'gpt-test' }, { value: 'haiku' }];
  const list = (await f.bridge.request('model/list', {})).data;
  assert.deepEqual(models({ data: list }), ['gpt-test', 'gpt-other', 'haiku']);
  assert.equal(list[0].id, 'gpt-test', 'the native entry was not replaced');
  f.bridge.modelPromise = null;
  f.bridge.getModels = async () => [{ value: 'a' }, { value: 'a' }];
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other'], 'a repeating Claude catalog adds nothing');
  assert.equal(stored(dir).evidence.catalog, 'failed');
}));

test('an unreadable connection store refuses new Claude work visibly and leaves GPT alone', () => setup(async (f, dir) => {
  const id = await f.start('haiku');
  const first = await f.send(id, 'one'); await f.done(first.turn.id);
  writeFileSync(join(dir, storeFile), '{broken', { mode: 0o600 });
  assert.deepEqual(models(await f.bridge.request('model/list', {})), ['gpt-test', 'gpt-other']);
  assert.deepEqual((await f.bridge.request('model/list', { includeHidden: true })).data.slice(2).map(m => m.hidden), [true, true]);
  await assert.rejects(f.start('haiku'), /could not be read safely/);
  await assert.rejects(f.send(id, 'two'), /could not be read safely/);
  assert.equal(readFileSync(join(dir, storeFile), 'utf8'), '{broken', 'the file was not repaired');
  assert.ok(await f.start('gpt-test'), 'GPT chats still start');
}));
