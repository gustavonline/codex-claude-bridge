import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  ConnectionError, claudeDenial, claudePolicy, createConnections, defaultStore, limits, lockFile, mergeClaudeModels, normalizeModels, readConnections,
  recordCatalog, recordOffered, setEnabled, setVisible, storedModels, storeFile, updateConnections, validateStore,
} from '../connections.mjs';

// Synthetic launch roots only: nothing outside the temporary directory is read or written.
// These tests need no SDK, Codex or Claude, and make no model call.
const modulePath = fileURLToPath(new URL('../connections.mjs', import.meta.url));
const sdk = (...values) => values.map(value => ({ value, displayName: value.toUpperCase(), description: `${value} model`, supportsEffort: value === 'sonnet', supportedEffortLevels: value === 'sonnet' ? ['low', 'high'] : [] }));
const root = () => mkdtempSync(join(tmpdir(), 'bridge-connections-'));
const code = fn => { try { fn(); } catch (error) { return error.code; } return undefined; };
const withRoot = fn => async () => { const dir = root(); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const stored = dir => JSON.parse(readFileSync(join(dir, storeFile), 'utf8'));
const connection = dir => stored(dir).connections.claude_code;

test('the SDK catalog is normalised to bounded fields, and anything malformed or oversized is refused, not clipped', () => {
  const [haiku, sonnet] = normalizeModels(sdk('haiku', 'sonnet'));
  assert.deepEqual(haiku, { value: 'haiku', displayName: 'HAIKU', description: 'haiku model', supportsEffort: false, supportedEffortLevels: [] });
  assert.deepEqual(sonnet.supportedEffortLevels, ['low', 'high']);
  assert.deepEqual(normalizeModels([{ value: 'bare' }]), [{ value: 'bare', displayName: 'bare', description: '', supportsEffort: false, supportedEffortLevels: [] }]);
  assert.deepEqual(normalizeModels([{ value: 'opus[1m]', extra: 'dropped', resolvedModel: 'x' }]).map(model => Object.keys(model).sort()),
    [['description', 'displayName', 'supportedEffortLevels', 'supportsEffort', 'value']]);
  const refused = [
    ['not a list', {}], ['not a list either', null], ['too many', Array.from({ length: limits.models + 1 }, (_, i) => ({ value: `m${i}` }))],
    ['repeated id', [{ value: 'a' }, { value: 'a' }]], ['missing id', [{}]], ['empty id', [{ value: '' }]], ['id with a space', [{ value: 'a b' }]],
    ['non-string id', [{ value: 7 }]], ['control character', [{ value: 'a\nb' }]], ['id too long', [{ value: 'x'.repeat(limits.id + 1) }]],
    ['name too long', [{ value: 'a', displayName: 'n'.repeat(limits.name + 1) }]], ['description too long', [{ value: 'a', description: 'd'.repeat(limits.text + 1) }]],
    ['non-string name', [{ value: 'a', displayName: 5 }]], ['bad flag', [{ value: 'a', supportsEffort: 'yes' }]],
    ['bad levels', [{ value: 'a', supportedEffortLevels: 'low' }]], ['too many levels', [{ value: 'a', supportedEffortLevels: Array(limits.levels + 1).fill('x') }]],
    ['empty level', [{ value: 'a', supportedEffortLevels: [''] }]], ['entry not an object', ['a']],
  ];
  for (const [name, list] of refused) assert.equal(code(() => normalizeModels(list)), 'catalog_invalid', name);
  assert.equal(normalizeModels(Array.from({ length: limits.models }, (_, i) => ({ value: `m${i}` }))).length, limits.models, 'the limit itself is allowed');
});

test('a new store is private, versioned and holds no secret, path or command; defaults keep the earlier behaviour', withRoot(dir => {
  assert.deepEqual(readConnections(dir), { status: 'absent' });
  assert.deepEqual(claudePolicy(dir), { enabled: true, visible: null, state: 'default' }, 'no store: enabled with every model visible');
  assert.deepEqual(claudePolicy(null), { enabled: true, visible: null, state: 'default' }, 'no root: nothing is read');
  const created = createConnections(dir);
  assert.deepEqual([created.version, created.revision], [1, 1]);
  assert.equal(statSync(join(dir, storeFile)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), [storeFile], 'no lock or temporary file is left');
  const text = readFileSync(join(dir, storeFile), 'utf8');
  assert.doesNotMatch(text, /token|secret|password|key|command|http|\/|credential/i, 'no secret, address, command or path field');
  assert.doesNotMatch(text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(connection(dir).evidence, { catalog: 'never', authentication: 'unknown', inference: 'unverified', offered: null, picker: 'unknown' });
  assert.deepEqual(claudePolicy(dir), { enabled: true, visible: null, state: 'store', revision: 1 });
}));

test('visibility and enablement change only through the closed operations, with a revision that refuses stale writers', withRoot(dir => {
  createConnections(dir);
  assert.equal(code(() => setVisible(dir, ['sonnet'])), 'no_catalog', 'models must be discovered before they can be chosen');
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') });
  const afterDiscover = stored(dir).revision;
  setVisible(dir, ['sonnet']);
  assert.deepEqual(claudePolicy(dir).visible, new Set(['sonnet']));
  for (const [name, ids] of [['unknown model', ['opus']], ['path-like', ['../../etc/passwd']], ['repeated', ['sonnet', 'sonnet']], ['not a list', 'sonnet'], ['object', { a: 1 }], ['non-string', [5]]])
    assert.equal(code(() => setVisible(dir, ids)), 'invalid', name);
  assert.deepEqual(connection(dir).visible, ['sonnet'], 'a refused request changes nothing');
  assert.equal(code(() => setEnabled(dir, 'false')), 'invalid');
  assert.equal(code(() => setEnabled(dir, 1)), 'invalid');
  const current = stored(dir).revision;
  assert.equal(code(() => setEnabled(dir, false, { expectedRevision: current - 1 })), 'stale_revision');
  assert.equal(connection(dir).enabled, true);
  setEnabled(dir, false, { expectedRevision: current });
  assert.equal(claudePolicy(dir).enabled, false);
  setVisible(dir, null);
  assert.equal(claudePolicy(dir).visible, null, 'null restores every model');
  setVisible(dir, []);
  assert.deepEqual([...claudePolicy(dir).visible], [], 'an empty list hides all');
  assert.ok(stored(dir).revision > afterDiscover);
  assert.equal(code(() => updateConnections(dir, () => {})), undefined, 'an existing store updates without create');
}));

test('updating a missing store needs an explicit create; nothing writes it implicitly', withRoot(dir => {
  assert.equal(code(() => setEnabled(dir, false)), 'absent');
  assert.equal(recordCatalog(dir, { models: sdk('haiku') }), null, 'observing without a store writes nothing');
  assert.equal(recordOffered(dir, ['haiku']), null);
  assert.deepEqual(readdirSync(dir), []);
}));

test('a catalog is recorded fresh; a failed refresh keeps the last valid catalog, labelled stale; an invalid one never replaces it', withRoot(dir => {
  createConnections(dir);
  recordCatalog(dir, { error: 'catalog_failed' });
  assert.deepEqual([connection(dir).catalog, connection(dir).evidence.catalog], [null, 'failed'], 'a first failure invents no catalog');
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') }, { now: 1_700_000_000_000 });
  assert.deepEqual([connection(dir).catalog.status, connection(dir).catalog.observedAt, connection(dir).catalog.revision, connection(dir).evidence.catalog], ['fresh', 1_700_000_000_000, 1, 'observed']);
  recordCatalog(dir, { error: 'catalog_failed' });
  assert.deepEqual([connection(dir).catalog.status, connection(dir).catalog.error, connection(dir).catalog.models.map(m => m.value), connection(dir).evidence.catalog],
    ['stale', 'catalog_failed', ['haiku', 'sonnet'], 'failed'], 'the last valid catalog survives and is labelled stale');
  assert.equal(code(() => recordCatalog(dir, { models: [{ value: 'a' }, { value: 'a' }] })), 'catalog_invalid');
  assert.deepEqual(connection(dir).catalog.models.map(m => m.value), ['haiku', 'sonnet'], 'an invalid catalog changed nothing');
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') }, { now: 1_700_000_100_000 });
  assert.deepEqual([connection(dir).catalog.status, connection(dir).catalog.error, connection(dir).catalog.revision], ['fresh', null, 2]);
  setVisible(dir, ['haiku', 'sonnet']);
  recordCatalog(dir, { models: sdk('sonnet', 'opus') });
  assert.deepEqual(connection(dir).visible, ['haiku', 'sonnet'], 'the saved choice is kept as made; a model missing for now is unavailable, not forgotten, and a new one is not shown unasked');
  assert.deepEqual([...claudePolicy(dir).visible], ['haiku', 'sonnet']);
  recordCatalog(dir, { models: sdk('haiku', 'sonnet', 'opus') });
  assert.deepEqual(connection(dir).visible, ['haiku', 'sonnet'], 'haiku returns as chosen once a catalog lists it again');
  assert.equal(code(() => setVisible(dir, ['gone'])), 'invalid', 'a new choice can still only name an observed model');
}));

test('a transient partial catalog does not erase a visibility decision, and the model is only offered while the catalog lists it', withRoot(dir => {
  createConnections(dir);
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') });
  setVisible(dir, ['haiku', 'sonnet']);
  recordCatalog(dir, { models: sdk('sonnet') });
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') });
  assert.deepEqual(connection(dir).visible, ['haiku', 'sonnet']);
  const merged = mergeClaudeModels([], [{ id: 'sonnet', model: 'sonnet' }], claudePolicy(dir), false);
  assert.deepEqual(merged.models.map(m => m.model), ['sonnet'], 'only a model the catalog lists is offered');
}));

test('Bridge evidence writes take the lock once and never wait; a held lock is reported and not reclaimed', withRoot(dir => {
  createConnections(dir);
  recordCatalog(dir, { models: sdk('haiku') });
  writeFileSync(join(dir, lockFile), '99999', { mode: 0o600 });
  for (const attempt of [() => recordCatalog(dir, { models: sdk('sonnet') }, { wait: false }), () => recordOffered(dir, ['haiku'], { wait: false }),
    () => updateConnections(dir, () => {}, { wait: false })]) {
    const started = Date.now();
    assert.equal(code(attempt), 'locked');
    assert.ok(Date.now() - started < 250, 'it did not wait');
  }
  assert.equal(readFileSync(join(dir, lockFile), 'utf8'), '99999', 'the lock was not reclaimed');
  assert.equal(connection(dir).catalog.models[0].value, 'haiku', 'nothing was changed');
}));

test('a FIFO, device or other non-regular file at the store path is refused without blocking the Bridge', withRoot(async dir => {
  execFileSync('/usr/bin/mkfifo', [join(dir, storeFile)]);
  // Read in a child with a time bound so that a blocking open fails this test instead of hanging it.
  const script = `import { readConnections, claudePolicy } from ${JSON.stringify(modulePath)};
console.log(JSON.stringify([readConnections(${JSON.stringify(dir)}).status, claudePolicy(${JSON.stringify(dir)}).enabled]));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [status, signal] = await once(child, 'close'); clearTimeout(timer);
  assert.equal(signal, null, 'the reader returned instead of hanging in open()');
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), ['unsafe', false], 'refused, and new Claude work is refused');
}));

test('storedModels returns the last validated catalog only from a readable store', withRoot(dir => {
  assert.equal(storedModels(dir), null);
  createConnections(dir);
  assert.equal(storedModels(dir), null, 'no catalog yet');
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') });
  assert.deepEqual(storedModels(dir).map(m => m.value), ['haiku', 'sonnet']);
  writeFileSync(join(dir, storeFile), '{broken', { mode: 0o600 });
  assert.equal(storedModels(dir), null);
}));

test('what the attached Bridge offered is recorded only when it changed; authentication, inference and the picker are never claimed', withRoot(dir => {
  createConnections(dir);
  recordCatalog(dir, { models: sdk('haiku', 'sonnet') });
  recordOffered(dir, ['haiku', 'sonnet'], { now: 5 });
  const revision = stored(dir).revision;
  recordOffered(dir, ['haiku', 'sonnet'], { now: 6 });
  assert.equal(stored(dir).revision, revision, 'an unchanged offer is not rewritten');
  assert.equal(connection(dir).evidence.offered.at, 5);
  recordOffered(dir, ['sonnet'], { now: 7 });
  assert.deepEqual(connection(dir).evidence.offered, { at: 7, ids: ['sonnet'] });
  const evidence = connection(dir).evidence;
  assert.deepEqual([evidence.authentication, evidence.inference, evidence.picker], ['unknown', 'unverified', 'unknown']);
}));

test('an unreadable, unsafe, unsupported or oversized store is never repaired and keeps new Claude work refused, while GPT is untouched', withRoot(dir => {
  const path = join(dir, storeFile);
  const keep = (text, mode = 0o600) => { writeFileSync(path, text, { mode }); chmodSync(path, mode); return readFileSync(path); };
  const cases = [
    ['not JSON', () => keep('{broken'), 'corrupt'], ['not an object', () => keep('[]'), 'corrupt'],
    ['unknown field', () => keep(JSON.stringify({ ...defaultStore(), extra: 1 })), 'corrupt'],
    ['unknown connection field', () => { const s = defaultStore(); s.connections.claude_code.token = 'x'; return keep(JSON.stringify(s)); }, 'corrupt'],
    ['second connection', () => { const s = defaultStore(); s.connections.other = s.connections.claude_code; return keep(JSON.stringify(s)); }, 'corrupt'],
    ['authentication claimed', () => { const s = defaultStore(); s.connections.claude_code.evidence.authentication = 'observed'; return keep(JSON.stringify(s)); }, 'corrupt'],
    ['visible without a catalog', () => { const s = defaultStore(); s.connections.claude_code.visible = ['a']; return keep(JSON.stringify(s)); }, 'corrupt'],
    ['negative revision', () => keep(JSON.stringify({ ...defaultStore(), revision: -1 })), 'corrupt'],
    ['newer version', () => keep(JSON.stringify({ ...defaultStore(), version: 2, future: true })), 'unsupported'],
    ['too large', () => keep(' '.repeat(limits.bytes + 1)), 'corrupt'],
    ['readable by others', () => keep(JSON.stringify(defaultStore()), 0o644), 'unsafe'],
  ];
  for (const [name, write, status] of cases) {
    const before = write();
    const read = readConnections(dir);
    assert.equal(read.status, status, name);
    assert.deepEqual(claudePolicy(dir), { enabled: false, visible: new Set(), state: 'unreadable', reason: read.reason }, name);
    assert.match(claudeDenial(claudePolicy(dir)), /could not be read safely/, name);
    for (const attempt of [() => setEnabled(dir, true), () => setVisible(dir, null), () => recordCatalog(dir, { models: sdk('a') }), () => createConnections(dir)])
      assert.ok(['corrupt', 'unsupported', 'unsafe'].includes(code(attempt)), `${name}: no update repairs it`);
    assert.deepEqual(readFileSync(path), before, `${name}: the file is untouched`);
    assert.deepEqual(readdirSync(dir), [storeFile], `${name}: no lock or temporary file remains`);
    assert.doesNotMatch(read.reason ?? '', /\/tmp|bridge-connections/, `${name}: no path in the reason`);
    rmSync(path);
  }
}));

test('links, foreign-writable roots and non-directories are refused without following them', withRoot(dir => {
  const target = join(dir, 'target.json');
  writeFileSync(target, JSON.stringify(defaultStore()), { mode: 0o600 });
  symlinkSync(target, join(dir, storeFile));
  assert.equal(readConnections(dir).status, 'unsafe', 'a symlinked store');
  assert.equal(code(() => setEnabled(dir, false)), 'unsafe');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).connections.claude_code.enabled, true, 'the target was not written through the link');
  rmSync(join(dir, storeFile));
  const real = join(dir, 'real'); mkdirSync(real, { mode: 0o700 });
  const linked = join(dir, 'linked'); symlinkSync(real, linked);
  assert.equal(readConnections(linked).status, 'absent', 'no store behind a link is the unconfigured state');
  assert.equal(code(() => createConnections(linked)), 'unsafe', 'but nothing is written through a symlinked root');
  assert.deepEqual(readdirSync(real), [], 'nothing was written through the link');
  chmodSync(real, 0o777);
  assert.equal(readConnections(real).status, 'absent', 'a loose root with no store changes nothing: the earlier behaviour stays');
  assert.deepEqual(claudePolicy(real), { enabled: true, visible: null, state: 'default' });
  assert.equal(code(() => createConnections(real)), 'unsafe', 'a loose root is never written');
  chmodSync(real, 0o700);
  createConnections(real);
  chmodSync(real, 0o777);
  assert.equal(readConnections(real).status, 'unsafe', 'an existing store in a root others can write is refused');
  assert.equal(claudePolicy(real).enabled, false, 'and then new Claude work is refused');
  assert.equal(code(() => setEnabled(real, true)), 'unsafe');
  assert.equal(readConnections(join(dir, 'missing')).status, 'absent');
  assert.equal(code(() => createConnections(join(dir, 'missing'))), 'unsafe', 'a missing root is never created');
  for (const bad of ['relative/path', '', undefined, 5, `${dir}\0x`]) assert.equal(readConnections(bad).status, 'unsafe', String(bad));
}));

test('a held lock stops an update; it is never taken over, and a lock file planted as a link is not followed', withRoot(dir => {
  createConnections(dir);
  writeFileSync(join(dir, lockFile), '12345', { mode: 0o600 });
  const started = Date.now();
  assert.equal(code(() => setEnabled(dir, false)), 'locked');
  assert.ok(Date.now() - started >= 1500 && Date.now() - started < 6000, 'the wait is bounded');
  assert.equal(readFileSync(join(dir, lockFile), 'utf8'), '12345', 'the lock was not reclaimed');
  assert.equal(connection(dir).enabled, true);
  rmSync(join(dir, lockFile));
  const outside = join(dir, 'outside'); writeFileSync(outside, 'keep');
  symlinkSync(outside, join(dir, lockFile));
  assert.equal(code(() => setEnabled(dir, false)), 'locked', 'an existing link counts as held');
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
}));

test('competing processes cannot lose an update: every increment survives', withRoot(async dir => {
  createConnections(dir);
  recordCatalog(dir, { models: sdk('haiku') });
  const before = { store: stored(dir).revision, catalog: connection(dir).catalog.revision };
  const children = 6, rounds = 5;
  const script = `import { updateConnections } from ${JSON.stringify(modulePath)};
for (let i = 0; i < ${rounds}; i++) updateConnections(${JSON.stringify(dir)}, c => { c.catalog.revision += 1; });`;
  const runs = Array.from({ length: children }, () => { const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); return once(child, 'close').then(([status]) => ({ status, stderr })); });
  for (const { status, stderr } of await Promise.all(runs)) assert.equal(status, 0, stderr);
  assert.equal(connection(dir).catalog.revision, before.catalog + children * rounds, 'no concurrent update was lost');
  assert.equal(stored(dir).revision, before.store + children * rounds);
  assert.deepEqual(readdirSync(dir), [storeFile]);
  // A writer holding an old revision is refused rather than overwriting a newer decision.
  assert.equal(code(() => setEnabled(dir, false, { expectedRevision: before.store })), 'stale_revision');
}));

test('the policy refuses new Claude work when disabled and a new choice of a hidden model, but never an existing chat’s own model', () => {
  const on = { enabled: true, visible: null, state: 'default' };
  assert.equal(claudeDenial(on), null);
  assert.equal(claudeDenial(on, { model: 'haiku' }), null);
  const some = { enabled: true, visible: new Set(['sonnet']), state: 'store' };
  assert.equal(claudeDenial(some, { model: 'sonnet' }), null);
  assert.match(claudeDenial(some, { model: 'haiku' }), /hidden/);
  assert.equal(claudeDenial(some, { model: 'haiku', continuing: true }), null, 'a hidden model still serves the chat that already uses it');
  assert.equal(claudeDenial(some), null, 'no model named: only the enabled state matters');
  const off = { enabled: false, visible: new Set(['sonnet']), state: 'store' };
  for (const options of [undefined, { model: 'sonnet' }, { model: 'sonnet', continuing: true }])
    assert.match(claudeDenial(off, options), /disabled/, 'disabled also stops an existing chat’s new work');
});

test('the merged catalog keeps every native entry first and unchanged, applies visibility, and is explicit about hidden, colliding and malformed entries', () => {
  const native = [{ id: 'gpt-a', model: 'gpt-a', isDefault: true }, { id: 'gpt-b', model: 'gpt-b', hidden: true }];
  const claude = [{ id: 'haiku', model: 'haiku', hidden: false, isDefault: true }, { id: 'sonnet', model: 'sonnet', hidden: false }];
  const all = mergeClaudeModels(native, claude, { enabled: true, visible: null, state: 'default' }, false);
  assert.deepEqual(all.models.map(m => [m.model, m.hidden ?? false, m.isDefault ?? false]), [['gpt-a', false, true], ['gpt-b', true, false], ['haiku', false, false], ['sonnet', false, false]],
    'native defaults are kept; no Claude entry is the default');
  assert.deepEqual(all.models.slice(0, 2), native);
  assert.deepEqual(all.offered, ['haiku', 'sonnet']);
  const sonnetOnly = { enabled: true, visible: new Set(['sonnet']), state: 'store' };
  assert.deepEqual(mergeClaudeModels(native, claude, sonnetOnly, false).models.map(m => m.model), ['gpt-a', 'gpt-b', 'sonnet']);
  const withHidden = mergeClaudeModels(native, claude, sonnetOnly, true);
  assert.deepEqual(withHidden.models.map(m => [m.model, m.hidden ?? false]), [['gpt-a', false], ['gpt-b', true], ['haiku', true], ['sonnet', false]], 'includeHidden identifies the retained hidden model');
  assert.deepEqual(withHidden.offered, ['sonnet']);
  const off = { enabled: false, visible: null, state: 'store' };
  assert.deepEqual(mergeClaudeModels(native, claude, off, false).models, native, 'disabled leaves exactly the native catalog');
  assert.deepEqual(mergeClaudeModels(native, claude, off, true).models.slice(2).map(m => [m.model, m.hidden]), [['haiku', true], ['sonnet', true]]);
  const collision = mergeClaudeModels(native, [{ id: 'gpt-a', model: 'gpt-a' }, ...claude], { enabled: true, visible: null, state: 'default' }, false);
  assert.deepEqual([collision.collisions, collision.models.find(m => m.model === 'gpt-a')], [['gpt-a'], native[0]], 'a native model is never overwritten');
  assert.equal(code(() => mergeClaudeModels(native, [claude[0], claude[0]], on(), false)), 'catalog_invalid', 'a repeated Claude id fails explicitly');
  for (const bad of [null, {}, [null], [{ model: '' }], [{ model: 5 }], [{ id: 'x' }]]) assert.equal(code(() => mergeClaudeModels(native, bad, on(), false)), 'catalog_invalid', JSON.stringify(bad));
  assert.deepEqual(mergeClaudeModels([], [], on(), false).models, [], 'no models is an honest empty result');
  function on() { return { enabled: true, visible: null, state: 'default' }; }
});

test('validateStore accepts exactly what the code writes and rejects every other shape', () => {
  assert.doesNotThrow(() => validateStore(defaultStore()));
  const mutations = [s => { s.version = 2; }, s => { s.revision = 1.5; }, s => { delete s.connections; }, s => { s.connections.claude_code.adapter = 'local'; },
    s => { s.connections.claude_code.enabled = 1; }, s => { s.connections.claude_code.catalog = { observedAt: -1 }; },
    s => { s.connections.claude_code.catalog = { observedAt: 1, revision: 1, status: 'fresh', error: 'Bad Error!', models: [] }; },
    s => { s.connections.claude_code.evidence.offered = { at: 1, ids: ['a', 'a'] }; }, s => { s.connections.claude_code.evidence.catalog = 'verified'; }];
  for (const [index, mutate] of mutations.entries()) { const store = defaultStore(); mutate(store); assert.throws(() => validateStore(store), ConnectionError, `mutation ${index}`); }
});
