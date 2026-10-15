import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '../logging.mjs';
import { fixture } from './support/fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const logging = pathToFileURL(join(root, 'logging.mjs')).href;
const unverified = 'unverified-bridge-activity';

// A synthetic desktop owns synthetic Bridge processes. Each process uses the real
// logger as bridge.mjs does; no app, model, auth or user profile is involved.
// A legacy process stands in for a pre-rc.9 Bridge that only writes runtime.json.
function desktop() {
  const state = mkdtempSync(join(tmpdir(), 'bridge-runtime-guard-'));
  const codes = {
    current: `import { createLogger } from ${JSON.stringify(logging)}; import { join } from 'node:path';
const log = createLogger(join(${JSON.stringify(state)}, 'logs'), { runtimeDirectory: join(${JSON.stringify(state)}, 'runtime') });
process.send({ runId: log.runId });
process.on('message', events => { for (const [event, fields] of events) log(event, fields); process.send({}); });
process.on('disconnect', () => process.exit());`,
    legacy: `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
process.send({ runId: 'legacy' });
process.on('message', ([work]) => { writeFileSync(join(${JSON.stringify(state)}, 'runtime.json'), JSON.stringify({ pid: process.pid, ...work })); process.send({}); });
process.on('disconnect', () => process.exit());`,
  };
  const code = `const { spawn } = require('node:child_process'); const kids = {}, codes = ${JSON.stringify(codes)};
process.on('message', ({ id, kind, events, exit }) => {
  if (exit) return kids[id].disconnect();
  if (!kids[id]) {
    kids[id] = spawn(process.execPath, ['--input-type=module', '-e', codes[kind], '--', 'bridge.mjs'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    kids[id].on('message', reply => process.send({ id, pid: kids[id].pid, ...reply }));
    kids[id].on('exit', () => process.send({ id, exited: true }));
    kids[id].once('message', () => kids[id].send(events));
  } else kids[id].send(events);
});
process.on('disconnect', () => process.exit());`;
  const child = spawn(process.execPath, ['-e', code, '--', `--user-data-dir=${join(state, 'desktop')}`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => child.on('exit', resolve));
  writeFileSync(join(state, 'desktop.pid'), String(child.pid));
  const next = (id, predicate) => new Promise(resolve => {
    const listener = message => { if (message.id === id && predicate(message)) { child.off('message', listener); resolve(message); } };
    child.on('message', listener);
  });
  const instances = {};
  const launch = (...args) => spawnSync('python3', [join(root, 'launch.py'), '--state', state, ...args], { encoding: 'utf8' });
  const send = async (id, kind, events) => {
    const created = !instances[id] && next(id, m => m.runId);
    const done = next(id, m => !m.runId && !m.exited);
    child.send({ id, kind, events });
    if (created) instances[id] = await created;
    await done; return instances[id];
  };
  return {
    state, child, exited, instances,
    log: (id, ...events) => send(id, 'current', events),
    legacy: (id, work) => send(id, 'legacy', [work]),
    async exit(id) { const gone = next(id, m => m.exited); child.send({ id, exit: true }); await gone; },
    status: () => JSON.parse(launch('--status').stdout).activeThreads,
    stop: () => launch('--stop'),
    record: id => join(state, 'runtime', `${instances[id].pid}-${instances[id].runId}.json`),
    alive: () => !/Z|^$/.test(spawnSync('ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim()),
    async close() {
      try { chmodSync(join(state, 'runtime'), 0o700); } catch {}
      try { child.disconnect(); } catch {} child.kill(); await exited; rmSync(state, { recursive: true, force: true });
    },
  };
}

test('preparation and active turns stay visible across other instances starting, stopping and exiting', async () => {
  const d = desktop();
  const [preparing, active, stopping] = [randomUUID(), randomUUID(), randomUUID()];
  try {
    await d.log('A', ['process.started', {}], ['turn.preparing', { threadId: preparing }]);
    assert.deepEqual(d.status(), [preparing]);
    await d.log('B', ['process.started', {}], ['turn.started', { threadId: active, turnId: randomUUID() }]);
    await d.log('C', ['process.started', {}], ['turn.started', { threadId: stopping, turnId: randomUUID() }], ['process.stopping', {}]);
    assert.deepEqual(d.status(), [active, preparing, stopping].sort());
    rmSync(join(d.state, 'logs'), { recursive: true, force: true });
    assert.deepEqual(d.status(), [active, preparing, stopping].sort(), 'rotated or missing logs do not change runtime evidence');
    await d.exit('C');
    assert.equal(existsSync(join(d.state, 'runtime', `${d.instances.C.pid}-${d.instances.C.runId}.json`)), false);
    assert.deepEqual(d.status(), [active, preparing].sort(), 'an exited instance removes only its own work');
    const refused = d.stop();
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /chat is active/); assert.ok(d.alive());
    await d.log('A', ['turn.prepared', { threadId: preparing, status: 'accepted' }]);
    await d.log('B', ['turn.finished', { threadId: active, turnId: randomUUID() }]);
    assert.deepEqual(d.status(), [active], 'a mismatched finish keeps the active turn');
    await d.exit('B');
    assert.deepEqual(d.status(), []);
    const stopped = d.stop();
    assert.equal(stopped.status, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).running, false);
    await d.exited;
    assert.equal(JSON.parse(d.stop().stdout).running, false, 'stopping an already stopped profile stays idempotent');
  } finally { await d.close(); }
});

test('missing, malformed, recycled and unreadable runtime evidence is unverified, never idle', async () => {
  const d = desktop();
  try {
    await d.log('A');
    assert.deepEqual(d.status(), [unverified], 'a live instance without a record');
    const refused = d.stop();
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /could not be verified/); assert.ok(d.alive());
    await d.log('A', ['process.started', {}]);
    assert.deepEqual(d.status(), []);

    writeFileSync(d.record('A'), '{broken');
    assert.deepEqual(d.status(), [unverified]);
    writeFileSync(d.record('A'), JSON.stringify({ pid: d.instances.A.pid, runId: d.instances.A.runId, startedAt: Date.now(), activeThreads: 'all', startingThreads: [], pendingStarts: 0 }));
    assert.deepEqual(d.status(), [unverified], 'a record with an invalid shape');
    await d.log('A', ['process.started', {}]);

    const earlier = randomUUID(), runId = randomUUID(), stale = join(d.state, 'runtime', `${d.instances.A.pid}-${runId}.json`);
    writeFileSync(stale, JSON.stringify({ pid: d.instances.A.pid, runId, startedAt: Date.now() - 3600_000, activeThreads: [earlier], startingThreads: [], pendingStarts: 0 }));
    const other = randomUUID(), foreign = randomUUID();
    writeFileSync(join(d.state, 'runtime', `${d.child.pid}-${foreign}.json`), JSON.stringify({ pid: d.child.pid, runId: foreign, startedAt: Date.now(), activeThreads: [other], startingThreads: [], pendingStarts: 0 }));
    assert.deepEqual(d.status(), [], 'records from a recycled PID or a non-Bridge process do not count');
    rmSync(d.record('A'));
    assert.deepEqual(d.status(), [unverified], 'a recycled record cannot vouch for the current process');
    await d.log('A', ['process.started', {}]);
    assert.deepEqual(d.status(), []);

    chmodSync(join(d.state, 'runtime'), 0o000);
    try { assert.deepEqual(d.status(), [unverified]); }
    finally { chmodSync(join(d.state, 'runtime'), 0o700); }
  } finally { await d.close(); }
});

test('concurrent instances write separate records and leave none after exit', async () => {
  const state = mkdtempSync(join(tmpdir(), 'bridge-runtime-race-'));
  const code = `import { createLogger } from ${JSON.stringify(logging)};
const log = createLogger(${JSON.stringify(join(state, 'logs'))}, { runtimeDirectory: ${JSON.stringify(join(state, 'runtime'))} });
for (let i = 0; i < 2000; i++) log(i % 2 ? 'turn.prepared' : 'turn.preparing', { threadId: '00000000-0000-4000-8000-00000000000' + (i % 10) });`;
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; }); child.on('exit', status => resolve({ status, error }));
  });
  try {
    for (const result of await Promise.all([run(), run(), run(), run()])) assert.deepEqual(result, { status: 0, error: '' });
    assert.deepEqual(readdirSync(join(state, 'runtime')), []);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a failed runtime write invalidates the older record instead of leaving it to understate work', () => {
  const state = mkdtempSync(join(tmpdir(), 'bridge-runtime-write-'));
  const log = createLogger(join(state, 'logs'), { runtimeDirectory: join(state, 'runtime') });
  const record = join(state, 'runtime', `${process.pid}-${log.runId}.json`);
  try {
    log('process.started');
    assert.ok(existsSync(record));
    mkdirSync(join(state, 'runtime', `.${process.pid}-${log.runId}.tmp`));
    assert.notEqual(log('turn.preparing', { threadId: randomUUID() }), false, 'invalidation succeeded, so work may proceed');
    assert.equal(readFileSync(record, 'utf8'), '', 'the older idle record no longer certifies idle');
    assert.match(readFileSync(join(state, 'logs', `bridge-${process.pid}.jsonl`), 'utf8'), /turn\.preparing/, 'the diagnostic line is still written');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a record that can be neither updated nor removed is invalidated in place, so stop refuses during preparation', async () => {
  const d = desktop(), threadId = randomUUID();
  try {
    await d.log('A', ['process.started', {}]);
    assert.deepEqual(d.status(), []);
    chmodSync(join(d.state, 'runtime'), 0o500); // Task-owned fixture only.
    await d.log('A', ['turn.preparing', { threadId }]);
    assert.equal(readFileSync(d.record('A'), 'utf8'), '', 'the older idle record no longer certifies idle');
    assert.deepEqual(d.status(), [unverified]);
    const refused = d.stop();
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /could not be verified/); assert.ok(d.alive());
    chmodSync(join(d.state, 'runtime'), 0o700);
    await d.log('A', ['turn.prepared', { threadId, status: 'accepted' }]);
    assert.deepEqual(d.status(), [], 'the next successful publication recovers');
    assert.equal(d.stop().status, 0); await d.exited;
  } finally { await d.close(); }
});

test('malformed numbers and types never verify a process or certify idle', async () => {
  const d = desktop(), threadId = randomUUID();
  try {
    await d.log('A', ['process.started', {}], ['turn.preparing', { threadId }]);
    const genuine = JSON.parse(readFileSync(d.record('A'), 'utf8'));
    const idle = { ...genuine, activeThreads: [], startingThreads: [], pendingStarts: 0 };
    const raw = (value, field, text) => JSON.stringify({ ...value, [field]: 'RAW' }).replace('"RAW"', text);
    const cases = {
      'startedAt NaN': raw(idle, 'startedAt', 'NaN'), 'startedAt Infinity': raw(idle, 'startedAt', 'Infinity'),
      'startedAt -Infinity': raw(idle, 'startedAt', '-Infinity'), 'startedAt overflow': raw(idle, 'startedAt', '1e400'),
      'startedAt boolean': JSON.stringify({ ...idle, startedAt: true }), 'startedAt string': JSON.stringify({ ...idle, startedAt: String(idle.startedAt) }),
      'startedAt zero': JSON.stringify({ ...idle, startedAt: 0 }), 'startedAt missing': JSON.stringify({ ...idle, startedAt: undefined }),
      'pendingStarts false': JSON.stringify({ ...idle, pendingStarts: false }), 'pendingStarts true': JSON.stringify({ ...idle, pendingStarts: true }),
      'pendingStarts fraction': JSON.stringify({ ...idle, pendingStarts: 0.5 }), 'pendingStarts string': JSON.stringify({ ...idle, pendingStarts: '0' }),
      'pendingStarts null': JSON.stringify({ ...idle, pendingStarts: null }), 'pendingStarts NaN': raw(idle, 'pendingStarts', 'NaN'),
      'pid boolean': JSON.stringify({ ...idle, pid: true }), 'pid string': JSON.stringify({ ...idle, pid: String(idle.pid) }),
      'runId mismatch': JSON.stringify({ ...idle, runId: randomUUID() }), 'thread not a string': JSON.stringify({ ...idle, activeThreads: [1] }),
      'not an object': '[]', 'truncated': '',
    };
    for (const [name, bytes] of Object.entries(cases)) {
      writeFileSync(d.record('A'), bytes);
      assert.deepEqual(d.status(), [unverified], name);
    }
    writeFileSync(d.record('A'), JSON.stringify(genuine));
    assert.deepEqual(d.status(), [threadId], 'valid control');
    rmSync(d.record('A'));
    const runId = randomUUID();
    writeFileSync(join(d.state, 'runtime', `${d.instances.A.pid}-${runId}.json`), raw({ ...idle, runId }, 'startedAt', 'NaN'));
    assert.deepEqual(d.status(), [unverified], 'a different-run NaN record cannot vouch for the live process');
    const refused = d.stop();
    assert.notEqual(refused.status, 0); assert.ok(d.alive());
  } finally { await d.close(); }
});

test('redirected runtime directories, temporary entries and records are refused without touching their targets', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-runtime-redirect-'));
  const outside = join(base, 'outside'), state = join(base, 'state');
  mkdirSync(outside, { mode: 0o750 }); chmodSync(outside, 0o750); mkdirSync(state);
  const dead = join(outside, `2147483647-${randomUUID()}.json`), sentinel = join(outside, 'sentinel');
  writeFileSync(dead, 'KEEP'); writeFileSync(sentinel, 'KEEP_SENTINEL', { mode: 0o640 }); chmodSync(sentinel, 0o640);
  const untouched = () => {
    assert.equal(statSync(outside).mode & 0o777, 0o750); assert.equal(readFileSync(dead, 'utf8'), 'KEEP');
    assert.equal(readFileSync(sentinel, 'utf8'), 'KEEP_SENTINEL'); assert.equal(statSync(sentinel).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(outside).sort(), [dead, sentinel].map(p => p.slice(outside.length + 1)).sort());
  };
  try {
    symlinkSync(outside, join(state, 'runtime'));
    const validation = spawnSync('python3', ['-c', `import importlib.util, pathlib, sys
s = importlib.util.spec_from_file_location('launch', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.validate_paths(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))`, join(root, 'launch.py'), state, join(base, 'source')], { encoding: 'utf8' });
    assert.match(validation.stderr, /must not be symlinks/);
    const redirected = createLogger(join(state, 'logs'), { runtimeDirectory: join(state, 'runtime') });
    redirected('process.started'); redirected('turn.preparing', { threadId: randomUUID() });
    untouched();
    rmSync(join(state, 'runtime'));

    const runtime = join(state, 'runtime'), log = createLogger(join(state, 'logs'), { runtimeDirectory: runtime });
    const record = join(runtime, `${process.pid}-${log.runId}.json`);
    symlinkSync(sentinel, join(runtime, `.${process.pid}-${log.runId}.tmp`));
    const threadId = randomUUID();
    assert.notEqual(log('turn.preparing', { threadId }), false);
    untouched();
    assert.ok(lstatSync(record).isFile()); assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).startingThreads, [threadId]);
    rmSync(record); symlinkSync(sentinel, record);
    log('turn.prepared', { threadId, status: 'accepted' });
    untouched();
    assert.ok(lstatSync(record).isFile(), 'publication replaces a planted record link instead of writing through it');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the guard also refuses a redirected runtime directory or record entry for a live process', async () => {
  const d = desktop(), outside = mkdtempSync(join(tmpdir(), 'bridge-runtime-outside-'));
  try {
    await d.log('A', ['process.started', {}]);
    const record = d.record('A'), copy = join(outside, 'record.json');
    writeFileSync(copy, readFileSync(record));
    rmSync(record); symlinkSync(copy, record);
    assert.deepEqual(d.status(), [unverified], 'a record entry that is a link');
    rmSync(record);
    const runtime = join(d.state, 'runtime'), moved = join(outside, 'runtime');
    await d.log('A', ['process.started', {}]);
    mkdirSync(moved); writeFileSync(join(moved, record.slice(runtime.length + 1)), readFileSync(record));
    rmSync(runtime, { recursive: true }); symlinkSync(moved, runtime);
    assert.deepEqual(d.status(), [unverified], 'a runtime directory that is a link');
  } finally { await d.close(); rmSync(outside, { recursive: true, force: true }); }
});

test('an older live Bridge stays unverified after its work finishes; it recovers only when it exits', async () => {
  const d = desktop(), threadId = randomUUID();
  try {
    await d.legacy('old', { activeThreads: [threadId], startingThreads: [], pendingStarts: 0 });
    assert.deepEqual(d.status(), [unverified], 'the old shared snapshot is not trusted');
    await d.legacy('old', { activeThreads: [], startingThreads: [], pendingStarts: 0 });
    assert.deepEqual(d.status(), [unverified], 'finishing work cannot create a record for an older process');
    const refused = d.stop();
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /stays unverified until it exits; retrying does not change that/); assert.ok(d.alive());
    await d.log('A', ['process.started', {}]);
    assert.deepEqual(d.status(), [unverified], 'a current process does not vouch for an older sibling');
    await d.exit('old');
    assert.deepEqual(d.status(), [], 'recovery after the older process has exited');
    assert.ok(existsSync(join(d.state, 'runtime.json')));
    assert.equal(d.stop().status, 0); await d.exited;
    const again = d.stop();
    assert.equal(again.status, 0); assert.equal(JSON.parse(again.stdout).running, false, 'an already stopped profile is a no-op');
  } finally { await d.close(); }
});

test('a turn whose preparation cannot be recorded safely is refused before any work and retries cleanly', async () => {
  const f = fixture();
  try {
    const id = await f.start();
    const first = await f.send(id, 'BEFORE'); await f.done(first.turn.id);
    const events = []; let unsafe = true;
    f.bridge.log = (event, fields) => { events.push([event, fields.status]); return !(unsafe && event === 'turn.preparing'); };
    const calls = f.calls.length, queries = f.queries.length;
    const params = { threadId: id, input: [{ type: 'text', text: 'DENIED' }], clientUserMessageId: 'synthetic-denied' };
    await assert.rejects(f.bridge.request('turn/start', params), /could not be recorded safely/);
    const input = [{ type: 'text', text: 'QUEUED' }];
    const { queuedSubmission } = await f.bridge.request('thread/queue/add', { threadId: id, clientUserMessageId: 'synthetic-queued', input });
    await assert.rejects(f.bridge.request('thread/queue/start', { threadId: id }), /could not be recorded safely/);
    assert.equal(f.calls.length, calls, 'no native call'); assert.equal(f.queries.length, queries, 'no model query');
    const record = f.bridge.records.get(id);
    assert.equal(record.turns.length, 1); assert.deepEqual(record.queue, [queuedSubmission]);
    for (const state of [f.bridge.starting, f.bridge.pendingStarts, f.bridge.active]) assert.equal(state.size, 0);
    assert.deepEqual(events.filter(([e]) => e.startsWith('turn.prepar')),
      [['turn.preparing', undefined], ['turn.prepared', 'failed'], ['turn.preparing', undefined], ['turn.prepared', 'failed']]);
    unsafe = false;
    const retried = await f.bridge.request('turn/start', params); await f.done(retried.turn.id);
    // The completed retry resumes the preserved queue automatically.
    const queued = await f.wait(e => e.method === 'turn/started' && ![first.turn.id, retried.turn.id].includes(e.params.turn.id));
    await f.done(queued.params.turn.id);
    assert.deepEqual(record.turns.map(t => [t.status, t.items[0].content[0].text]), [['completed', 'BEFORE'], ['completed', 'DENIED'], ['completed', 'QUEUED']]);
    assert.deepEqual(record.queue, []);
  } finally { f.close(); }
});
