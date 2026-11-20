import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  ConnectionError, claudeDecision, claudePolicy, createConnections, defaultStore, limits, readConnections, recordCatalog, recordOffered,
  setEnabled, setVisible, storeFile, updateConnections, validateStore,
} from '../connections.mjs';

// The durable disable generation of the private connection store, on synthetic launch roots only. These need
// no SDK, Codex, Claude or Bridge, make no model call and touch no FIFO, device or other special file.
const modulePath = fileURLToPath(new URL('../connections.mjs', import.meta.url));
const sdk = (...values) => values.map(value => ({ value, displayName: value.toUpperCase(), description: `${value} model`, supportsEffort: false, supportedEffortLevels: [] }));
const root = () => mkdtempSync(join(tmpdir(), 'bridge-generation-'));
const code = fn => { try { fn(); } catch (error) { return error.code; } return undefined; };
const withRoot = fn => async () => { const dir = root(); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const file = dir => join(dir, storeFile);
const stored = dir => JSON.parse(readFileSync(file(dir), 'utf8'));
const connection = dir => stored(dir).connections.claude_code;
const generation = dir => connection(dir).disableGeneration;
const token = dir => claudeDecision(dir).token;
const put = (dir, value, mode = 0o600) => { writeFileSync(file(dir), typeof value === 'string' ? value : JSON.stringify(value), { mode }); chmodSync(file(dir), mode); return readFileSync(file(dir)); };
const legacyStore = (enabled = true) => {
  const s = defaultStore(); const c = s.connections.claude_code; delete c.disableGeneration; delete c.storeId; c.enabled = enabled; s.revision = 4; return s;
};
const current = (mutate = () => {}) => { const s = defaultStore(); s.revision = 1; mutate(s.connections.claude_code, s); return s; };

test('a new store starts at generation 0 with a random store id, holds no secret or path, and its policy shape is unchanged', withRoot(dir => {
  const created = createConnections(dir);
  assert.equal(generation(dir), 0); assert.match(connection(dir).storeId, /^[0-9a-f]{32}$/);
  assert.notEqual(defaultStore().connections.claude_code.storeId, defaultStore().connections.claude_code.storeId, 'each store has its own id');
  assert.doesNotMatch(readFileSync(file(dir), 'utf8'), /token|secret|password|key|command|http|\/|credential/i);
  assert.deepEqual([created.version, created.revision], [1, 1], 'still version 1');
  assert.deepEqual(claudePolicy(dir), { enabled: true, visible: null, state: 'store', revision: 1 });
  assert.equal(token(dir), `${connection(dir).storeId}:0`);
}));

test('only an enabled-to-disabled transition counts, once, saved in the same write as the revision; re-enabling erases nothing', withRoot(dir => {
  createConnections(dir); const id = connection(dir).storeId;
  assert.equal(setEnabled(dir, true).connections.claude_code.disableGeneration, 0, 'enabling an enabled connection is no event');
  const first = setEnabled(dir, false);
  assert.deepEqual([first.connections.claude_code.disableGeneration, first.revision], [1, 3]);
  assert.equal(generation(dir), 1, 'the generation is on disk, not only returned');
  assert.equal(setEnabled(dir, false).connections.claude_code.disableGeneration, 1, 'disabling a disabled connection is no new event');
  assert.equal(setEnabled(dir, true).connections.claude_code.disableGeneration, 1, 're-enabling keeps it');
  for (let round = 2; round <= 4; round++) { setEnabled(dir, false); assert.equal(generation(dir), round); setEnabled(dir, true); assert.equal(generation(dir), round); }
  assert.equal(connection(dir).storeId, id, 'the store id never changes');
}));

test('catalog, visibility, offered evidence and a failed refresh leave the generation and the store id as they are', withRoot(dir => {
  createConnections(dir); setEnabled(dir, false); setEnabled(dir, true);
  const before = { generation: generation(dir), id: connection(dir).storeId, token: token(dir) };
  const same = () => assert.deepEqual({ generation: generation(dir), id: connection(dir).storeId, token: token(dir) }, before);
  recordCatalog(dir, { models: sdk('a', 'b') }); same();
  setVisible(dir, ['a']); same(); setVisible(dir, null); same();
  recordOffered(dir, ['a']); same(); recordOffered(dir, []); same();
  recordCatalog(dir, { error: 'catalog_failed' }); same();
  updateConnections(dir, c => { c.evidence.catalog = 'observed'; }); same();
  setEnabled(dir, false); recordCatalog(dir, { models: sdk('c') }); recordOffered(dir, []); setVisible(dir, ['c']);
  assert.equal(generation(dir), before.generation + 1, 'while disabled, only the disable itself counted');
}));

test('a change cannot set, reset or forge the generation or the store id; the store alone counts transitions', withRoot(dir => {
  createConnections(dir); setEnabled(dir, false); setEnabled(dir, true); const bytes = readFileSync(file(dir));
  for (const [name, change] of [['reset', c => { c.disableGeneration = 0; }], ['forward', c => { c.disableGeneration += 1; }], ['id', c => { c.storeId = 'a'.repeat(32); }],
    ['replaced record', (c, draft) => { draft.connections.claude_code = { ...c, disableGeneration: 0 }; }],
    ['disable and forge', c => { c.enabled = false; c.disableGeneration = 99; }],
    ['record removed', (c, draft) => { delete draft.connections.claude_code; }]])
    assert.equal(code(() => updateConnections(dir, change)), 'invalid', name);
  assert.deepEqual(readFileSync(file(dir)), bytes, 'every refusal left the file as it was'); assert.deepEqual(readdirSync(dir), [storeFile]);
  assert.equal(code(() => updateConnections(dir, c => { c.enabled = false; })), undefined, 'a plain disable through the generic update counts too');
  assert.equal(generation(dir), 2);
}));

test('the generation is finite: at its limit a disable is refused without wrapping, saturating or changing the file; enabling still works', withRoot(dir => {
  assert.ok(Number.isSafeInteger(limits.generation) && limits.generation > 1000);
  put(dir, current(c => { c.disableGeneration = limits.generation - 1; }));
  setEnabled(dir, false); assert.equal(generation(dir), limits.generation, 'the last representable disable');
  setEnabled(dir, true); const bytes = readFileSync(file(dir)), revision = stored(dir).revision;
  assert.equal(code(() => setEnabled(dir, false)), 'generation_exhausted');
  assert.equal(code(() => updateConnections(dir, c => { c.enabled = false; })), 'generation_exhausted');
  assert.deepEqual(readFileSync(file(dir)), bytes, 'not wrapped, not saturated, not rewritten'); assert.equal(stored(dir).revision, revision);
  assert.equal(claudePolicy(dir).enabled, true, 'the refused disable is visible as an error, and the connection stays as it was');
  assert.equal(setEnabled(dir, true).connections.claude_code.disableGeneration, limits.generation, 'a no-op enable is not an event');
  assert.deepEqual(readdirSync(dir), [storeFile], 'no lock or temporary file remains');
  // Beyond the bound on disk is corrupt, never a larger counter.
  for (const bad of [limits.generation + 1, Number.MAX_SAFE_INTEGER, 2 ** 53, -1, 1.5, '3', null, NaN]) {
    put(dir, JSON.stringify(current(c => { c.disableGeneration = bad; })));
    assert.equal(readConnections(dir).status, 'corrupt', String(bad)); assert.equal(token(dir), null, String(bad));
  }
}));

test('malformed or unsupported generation fields are corrupt or unsupported, fail closed, are never repaired and give no token', withRoot(dir => {
  const cases = [
    ['generation without id', () => put(dir, current(c => { delete c.storeId; })), 'corrupt'],
    ['id without generation', () => put(dir, current(c => { delete c.disableGeneration; })), 'corrupt'],
    ['short id', () => put(dir, current(c => { c.storeId = 'ab'; })), 'corrupt'],
    ['upper-case id', () => put(dir, current(c => { c.storeId = 'A'.repeat(32); })), 'corrupt'],
    ['path-like id', () => put(dir, current(c => { c.storeId = '/'.repeat(32); })), 'corrupt'],
    ['numeric id', () => put(dir, current(c => { c.storeId = 7; })), 'corrupt'],
    ['extra field next to the generation', () => put(dir, current(c => { c.generationNote = 'x'; })), 'corrupt'],
    ['legacy plus extra field', () => { const s = legacyStore(); s.connections.claude_code.extra = 1; return put(dir, s); }, 'corrupt'],
    ['newer version with generation fields', () => put(dir, { ...current(), version: 2 }), 'unsupported'],
    ['generation at top level', () => put(dir, { ...current(), disableGeneration: 1 }), 'corrupt'],
    ['not JSON', () => put(dir, '{"disableGeneration":'), 'corrupt'],
  ];
  for (const [name, write, status] of cases) {
    const before = write(), read = readConnections(dir);
    assert.equal(read.status, status, name);
    const decision = claudeDecision(dir);
    assert.deepEqual([decision.token, decision.policy.enabled, decision.policy.state], [null, false, 'unreadable'], `${name}: unknown generation, Claude work refused`);
    for (const attempt of [() => setEnabled(dir, true), () => setEnabled(dir, false), () => setVisible(dir, null), () => recordCatalog(dir, { models: sdk('a') }), () => createConnections(dir)])
      assert.ok(['corrupt', 'unsupported', 'unsafe'].includes(code(attempt)), `${name}: nothing repairs it`);
    assert.equal(recordOffered(dir, []), null, `${name}: offered evidence is not written to a store that cannot be read`);
    assert.deepEqual(readFileSync(file(dir)), before, `${name}: untouched`); assert.deepEqual(readdirSync(dir), [storeFile], `${name}: no lock or temporary file`);
    rmSync(file(dir));
  }
}));

test('validateStore is strict about the generation: the writer never accepts the earlier layout and nothing in range is clipped', () => {
  assert.doesNotThrow(() => validateStore(defaultStore()));
  assert.throws(() => validateStore(legacyStore()), ConnectionError, 'the earlier layout is not something this code writes');
  assert.doesNotThrow(() => validateStore(legacyStore(), { allowLegacy: true }), 'only the reader may accept it');
  for (const mutate of [c => { c.disableGeneration = limits.generation + 1; }, c => { c.disableGeneration = -1; }, c => { c.storeId = ''; }, c => { delete c.storeId; }, c => { c.disableGeneration = 0.5; }])
    assert.throws(() => validateStore(current(mutate), { allowLegacy: true }), ConnectionError);
  assert.doesNotThrow(() => validateStore(current(c => { c.disableGeneration = limits.generation; })));
});

test('an earlier-layout store is read and enforced as before, has an unknown generation, and is never rewritten or migrated', withRoot(dir => {
  for (const enabled of [true, false]) {
    const before = put(dir, legacyStore(enabled)), read = readConnections(dir);
    assert.deepEqual([read.status, read.legacy], ['ok', true]);
    const decision = claudeDecision(dir);
    assert.equal(decision.token, null, 'unknown provenance is never a matching token');
    assert.deepEqual(decision.policy, { enabled, visible: null, state: 'store', revision: 4 }, 'enablement is enforced as the file says');
    for (const [name, attempt] of [['enable', () => setEnabled(dir, true)], ['disable', () => setEnabled(dir, false)], ['visible', () => setVisible(dir, null)],
      ['catalog', () => recordCatalog(dir, { models: sdk('a') })], ['offered', () => recordOffered(dir, ['a'])], ['generic', () => updateConnections(dir, () => {})], ['create', () => createConnections(dir)]])
      assert.equal(code(attempt), 'legacy', `${name} is refused, not migrated`);
    assert.deepEqual(readFileSync(file(dir)), before, 'the file is byte-for-byte as found'); assert.deepEqual(readdirSync(dir), [storeFile]);
    rmSync(file(dir));
  }
}));

test('the token: none without a store, store id plus generation with one, stable across readers and restarts, different for a replaced store', withRoot(dir => {
  assert.equal(claudeDecision(null).token, 'none'); assert.equal(claudeDecision(undefined).token, 'none'); assert.equal(token(dir), 'none', 'no file, no token');
  createConnections(dir); const t0 = token(dir);
  assert.match(t0, /^[0-9a-f]{32}:0$/); assert.equal(token(dir), t0, 'a second read of the same file agrees');
  setEnabled(dir, false); const t1 = token(dir); assert.notEqual(t1, t0); setEnabled(dir, true);
  assert.equal(token(dir), t1, 're-enabling does not move it back');
  rmSync(file(dir)); assert.equal(token(dir), 'none', 'a deleted store is the unconfigured state again');
  createConnections(dir); setEnabled(dir, false); setEnabled(dir, true);
  assert.equal(generation(dir), 1, 'the recreated store reached the same generation');
  assert.notEqual(token(dir), t1, 'but it is another store, so the old token does not match');
}));

test('another process disables and re-enables the shared store: the generation it left is seen by every later reader', withRoot(async dir => {
  createConnections(dir); const t0 = token(dir);
  const script = `import { setEnabled } from ${JSON.stringify(modulePath)}; const root = ${JSON.stringify(dir)}; setEnabled(root, false); setEnabled(root, true);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const [exit] = await once(child, 'exit'); assert.equal(exit, 0, stderr);
  assert.equal(claudePolicy(dir).enabled, true, 'enabled again, as a reader that never saw the disable would find it');
  assert.notEqual(token(dir), t0, 'yet the token shows that a disable happened');
  assert.equal(generation(dir), 1);
}));

test('competing processes cannot lose or invent a disable: the generation equals the transitions the writers saw inside the lock', withRoot(async dir => {
  createConnections(dir);
  const rounds = 25, children = 3;
  const script = `import { updateConnections } from ${JSON.stringify(modulePath)};
import { writeSync } from 'node:fs';
const root = ${JSON.stringify(dir)}; let transitions = 0;
const apply = (enabled) => { for (;;) { try { updateConnections(root, c => { if (!enabled && c.enabled) transitions++; c.enabled = enabled; }); return; } catch (e) { if (e.code !== 'locked') throw e; } } };
for (let i = 0; i < ${rounds}; i++) { apply(false); apply(true); }
// A small synchronous report is complete before shutdown, including on fixture hosts where
// an asynchronous process.stdout.write can be acknowledged without reaching the parent.
writeSync(1, String(transitions));`;
  const runs = Array.from({ length: children }, () => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', error, timedOut = false;
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('error', e => { error = e.message; });
    const timer = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, 5000);
    // exit does not guarantee that stdout/stderr have drained. Keep errors and the raw
    // close result; a missing report must fail explicitly rather than become Number('') = 0.
    return new Promise(resolve => c.on('close', (code, signal) => {
      clearTimeout(timer); resolve({ code, signal, out, err, error, timedOut });
    }));
  });
  const results = await Promise.all(runs);
  for (const r of results) {
    const detail = JSON.stringify(r);
    assert.equal(r.error, undefined, detail); assert.equal(r.timedOut, false, detail);
    assert.equal(r.signal, null, detail); assert.equal(r.code, 0, detail); assert.equal(r.err, '', detail);
    assert.match(r.out, /^(0|[1-9]\d*)$/, detail);
    assert.ok(Number(r.out) <= rounds, detail);
  }
  const total = results.reduce((sum, r) => sum + Number(r.out), 0);
  assert.ok(total >= 1 && total <= rounds * children);
  assert.equal(generation(dir), total, 'no increment was lost and none was invented');
  assert.equal(readConnections(dir).status, 'ok'); assert.deepEqual(readdirSync(dir), [storeFile]);
}));
