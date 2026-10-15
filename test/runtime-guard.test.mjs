import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getPriority, setPriority, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '../logging.mjs';
import { fixture } from './support/fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const logging = pathToFileURL(join(root, 'logging.mjs')).href;
const unverified = 'unverified-bridge-activity';
// launch.py resolves --state, so the desktop's --user-data-dir is always the
// canonical path. Fixtures match that, including when TMPDIR is a link (macOS).
const tempState = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const bounded = async (predicate, message) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
};

// A synthetic desktop owns synthetic Bridge processes. Each process uses the real
// logger as bridge.mjs does; no app, model, auth or user profile is involved.
// A legacy process stands in for a pre-rc.9 Bridge that only writes runtime.json.
// Records here are edited by hand, so the periodic refresh is deferred beyond
// any test; lease expiry and refresh have their own test below.
function desktop() {
  const state = tempState('bridge-runtime-guard-');
  const codes = {
    current: `import { createLogger } from ${JSON.stringify(logging)}; import { join } from 'node:path';
const log = createLogger(join(${JSON.stringify(state)}, 'logs'), { runtimeDirectory: join(${JSON.stringify(state)}, 'runtime'), refreshMs: 3_600_000 });
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
    writeFileSync(stale, JSON.stringify({ pid: d.instances.A.pid, runId, startedAt: Date.now() - 3600_000, updatedAt: new Date(Date.now() - 3000_000).toISOString(), nice: 0, activeThreads: [earlier], startingThreads: [], pendingStarts: 0 }));
    const other = randomUUID(), foreign = randomUUID();
    writeFileSync(join(d.state, 'runtime', `${d.child.pid}-${foreign}.json`), JSON.stringify({ pid: d.child.pid, runId: foreign, startedAt: Date.now(), updatedAt: new Date().toISOString(), activeThreads: [other], startingThreads: [], pendingStarts: 0 }));
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
  } finally { log.close(); rmSync(state, { recursive: true, force: true }); }
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
      'updatedAt missing': JSON.stringify({ ...idle, updatedAt: undefined }), 'updatedAt number': JSON.stringify({ ...idle, updatedAt: Date.now() }),
      'updatedAt not a time': JSON.stringify({ ...idle, updatedAt: 'recent' }), 'updatedAt without zone': JSON.stringify({ ...idle, updatedAt: idle.updatedAt.replace('Z', '') }),
      'updatedAt expired': JSON.stringify({ ...idle, updatedAt: new Date(Date.now() - 60_000).toISOString() }),
      'updatedAt in the future': JSON.stringify({ ...idle, updatedAt: new Date(Date.now() + 60_000).toISOString() }),
      'nice missing': JSON.stringify({ ...idle, nice: undefined }), 'nice boolean': JSON.stringify({ ...idle, nice: false }),
      'nice string': JSON.stringify({ ...idle, nice: String(idle.nice) }), 'nice fraction': JSON.stringify({ ...idle, nice: idle.nice + 0.5 }),
      'nice not the live value': JSON.stringify({ ...idle, nice: idle.nice - 1 }),
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
    writeFileSync(join(d.state, 'runtime', `${d.instances.A.pid}-${runId}.json`), raw({ ...idle, runId, updatedAt: new Date().toISOString() }, 'startedAt', 'NaN'));
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
    redirected('process.started'); redirected('turn.preparing', { threadId: randomUUID() }); redirected.close();
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
    log.close();
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

// The stop guard's own evaluation of one state directory, over the real process
// list, independent of the Bridge under test.
const guard = state => {
  const result = spawnSync('python3', ['-B', '-c', `import importlib.util, json, pathlib, sys
s = importlib.util.spec_from_file_location('launch', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(json.dumps(m.active_threads(pathlib.Path(sys.argv[2]))))`, join(root, 'launch.py'), state], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
};

// One synthetic Bridge process (support/native-start-worker.mjs): real logger,
// Peer and Bridge, a native stub that executes nothing, labelled EIO injection.
async function nativeWorker(refreshMs, mode = 'signal') {
  const state = tempState('bridge-runtime-native-');
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./support/native-start-worker.mjs', import.meta.url)), state, String(refreshMs), mode, '--', 'bridge.mjs'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', sequence = 0; worker.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  const close = async () => { try { worker.disconnect(); } catch {} worker.kill(); await exited; rmSync(state, { recursive: true, force: true }); };
  const reply = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`worker reply timeout; stderr ${JSON.stringify(stderr)}`)), 5000);
    const listener = value => { if (predicate(value)) done(null, value); };
    const gone = code => done(new Error(`worker exited ${code}; stderr ${JSON.stringify(stderr)}`));
    const done = (error, value) => { clearTimeout(timer); worker.off('message', listener); worker.off('exit', gone); error ? reject(error) : resolve(value); };
    worker.on('message', listener); worker.once('exit', gone);
  });
  const call = async (action, fields = {}) => {
    const id = ++sequence, answer = reply(value => value.id === id);
    worker.send({ id, action, ...fields });
    const value = await answer; assert.equal(value.fixtureError, undefined); return value;
  };
  let ready;
  try { ready = await reply(value => value.ready); } catch (error) { await close(); throw error; }
  const record = join(state, 'runtime', `${ready.pid}-${ready.runId}.json`);
  return { state, pid: ready.pid, record, call, close, read: () => JSON.parse(readFileSync(record, 'utf8')) };
}
const input = [{ type: 'text', text: 'synthetic' }];

test('an unrecordable native turn is unverified at once with the old idle bytes present; other work is refused before dispatch', async () => {
  const w = await nativeWorker(500), { state, pid, record, call, read } = w;
  try {
    assert.deepEqual(guard(state), [], 'healthy idle control');
    const control = randomUUID();
    const healthy = await call('request', { method: 'turn/start', params: { threadId: control, input } });
    assert.ok(healthy.reply.result.turn); assert.deepEqual(healthy.forwarded, ['turn/start']);
    assert.deepEqual(guard(state), [control], 'healthy control: native work is busy');
    await call('notify', { method: 'turn/completed', params: { threadId: control, turn: { id: healthy.reply.result.turn.id, status: 'completed' } } });
    assert.deepEqual(guard(state), [], 'healthy control: completion restores idle');

    // First failure during native work that cannot be refused: the turn is
    // already running, and neither publication nor invalidation can succeed.
    const idleBytes = readFileSync(record, 'utf8'), idleNice = read().nice;
    await call('fail');
    const native = randomUUID(), nativeTurn = randomUUID();
    const notified = await call('notify', { method: 'turn/started', params: { threadId: native, turn: { id: nativeTurn, status: 'inProgress' } } });
    assert.deepEqual(notified.returns, [['turn.started', false]]);
    assert.equal(readFileSync(record, 'utf8'), idleBytes, 'the old idle bytes are still present');
    assert.equal(getPriority(pid), idleNice + 1, 'the process signalled through its public nice value');
    assert.deepEqual(guard(state), [unverified], 'the guard is not idle at once, with no expiry wait');

    // Every request that could start or change work is refused before dispatch,
    // including routes no list names; plain reads continue.
    const thread = randomUUID();
    for (const [method, params] of [['turn/start', { threadId: thread, input }], ['turn/steer', { threadId: thread, expectedTurnId: randomUUID(), input }],
      ['thread/queue/start', { threadId: thread }], ['review/start', { threadId: thread, target: { type: 'uncommittedChanges' } }],
      ['thread/compact/start', { threadId: thread }], ['thread/shellCommand', { threadId: thread, command: 'true' }],
      ['command/exec', { command: ['true'] }], ['thread/synthetic-future-work', { threadId: thread }]]) {
      const refused = await call('request', { method, params });
      assert.match(refused.reply.error?.message ?? '', /could not be recorded safely/, method);
      assert.deepEqual(refused.forwarded, [], `${method} is not forwarded`);
      assert.deepEqual(refused.returns.find(([event]) => event === 'rpc.start'), ['rpc.start', false], method);
      assert.equal(refused.savedRecords, 0);
    }
    const served = await call('request', { method: 'config/read', params: {} });
    assert.deepEqual([served.reply.result, served.forwarded], [{}, ['config/read']], 'a plain read is still served');
    assert.equal(readFileSync(record, 'utf8'), idleBytes);
    assert.deepEqual(guard(state), [unverified]);

    // Recovery: the older healthy-looking record never restores idle; only a new
    // publication of the full current state does, and it shows the native turn.
    await call('restore');
    assert.notDeepEqual(guard(state), [], 'the stale idle record cannot certify idle after the fault ends');
    await bounded(() => read().activeThreads.includes(native), 'the next refresh publishes the unrefused native turn');
    assert.deepEqual([read().startingThreads, read().pendingStarts, read().nice], [[], 0, idleNice + 1], 'refused requests left no phantom work');
    assert.deepEqual(guard(state), [native], 'verified again, and busy');
    await call('notify', { method: 'turn/completed', params: { threadId: native, turn: { id: nativeTurn, status: 'completed' } } });
    assert.deepEqual(guard(state), [], 'genuine idle after the native turn completes');
    const later = await call('request', { method: 'turn/start', params: { threadId: randomUUID(), input } });
    assert.ok(later.reply.result.turn, 'starts are admitted again after recovery'); assert.deepEqual(later.forwarded, ['turn/start']);
  } finally { await w.close(); }
});

test('the FIRST request after a recording failure is refused before dispatch, for every kind of possible work', async () => {
  // No periodic refresh: nothing else may encounter the failure before the request.
  const w = await nativeWorker(3_600_000), { state, pid, record, call } = w;
  const thread = randomUUID(), command = { command: ['SYNTHETIC_NOT_EXECUTED'] };
  try {
    for (const [method, params] of [['command/exec', command], ['turn/start', { threadId: thread, input }],
      ['thread/shellCommand', { threadId: thread, command: 'SYNTHETIC_NOT_EXECUTED' }],
      ['mcpServerStatus/list', {}], ['thread/synthetic/list', { threadId: thread }], ['thread/synthetic-future-work', { threadId: thread }]]) {
      assert.deepEqual(guard(state), [], `${method}: healthy idle before the first failure`);
      const idleBytes = readFileSync(record, 'utf8'), nice = getPriority(pid);
      await call('fail');
      const refused = await call('request', { method, params });
      assert.match(refused.reply.error?.message ?? '', /could not be recorded safely/, method);
      assert.deepEqual(refused.forwarded, [], `${method} is not forwarded`);
      assert.deepEqual(refused.returns.find(([event]) => event === 'rpc.start'), ['rpc.start', false], method);
      assert.equal(readFileSync(record, 'utf8'), idleBytes, `${method}: old idle bytes still present`);
      assert.equal(getPriority(pid), nice + 1, `${method}: signalled`);
      assert.deepEqual(guard(state), [unverified], `${method}: never idle`);
      await call('restore');
      assert.deepEqual(guard(state), [unverified], `${method}: the old record cannot restore idle after the fault ends`);
      // Recovery: a healthy request publishes trustworthy current state again.
      const recovered = await call('request', { method: 'command/exec', params: command });
      assert.deepEqual([recovered.reply.result, recovered.forwarded], [{}, ['command/exec']]);
      assert.deepEqual(guard(state), [], `${method}: genuine idle after recovery, with no phantom work`);
    }
  } finally { await w.close(); }
});

test('a healthy command is busy while in flight; cancellations and reads are never refused by a recording failure', async () => {
  const w = await nativeWorker(3_600_000), { state, call } = w;
  try {
    assert.deepEqual(guard(state), []);
    const pending = call('request', { method: 'command/exec', params: { command: ['SYNTHETIC_NOT_EXECUTED'], hold: 'held-command' } });
    await bounded(() => guard(state).length > 0, 'the in-flight command is visible');
    assert.deepEqual(guard(state), ['turn-starting'], 'a command without a thread still counts as work');
    assert.deepEqual((await call('held', { hold: 'held-command' })).held, true);
    await call('release', { hold: 'held-command' });
    assert.deepEqual((await pending).forwarded, ['command/exec']);
    assert.deepEqual(guard(state), [], 'completion restores idle');

    await call('fail');
    const thread = randomUUID();
    for (const [method, params] of [['turn/interrupt', { threadId: thread, turnId: randomUUID() }], ['command/exec/terminate', { processId: 'synthetic' }],
      ['thread/queue/delete', { threadId: thread, queuedSubmissionId: randomUUID() }], ['thread/read', { threadId: thread }], ['config/read', {}]]) {
      const served = await call('request', { method, params });
      assert.equal(served.reply.error, undefined, method); assert.deepEqual(served.forwarded, [method], `${method} is still forwarded`);
    }
    assert.deepEqual(guard(state), [], 'cancellations and reads add no work and need no record');
  } finally { await w.close(); }
});

test('a Bridge that cannot use the process signal is never verified', async () => {
  const w = await nativeWorker(3_600_000, 'no-signal'), { state, call, read } = w;
  try {
    assert.equal(read().nice, null, 'records carry no nice value');
    assert.deepEqual(guard(state), [unverified], 'unverified even while healthy and idle');
    const served = await call('request', { method: 'command/exec', params: { command: ['SYNTHETIC_NOT_EXECUTED'] } });
    assert.deepEqual(served.forwarded, ['command/exec'], 'work is still served while records can be written');
    assert.deepEqual(guard(state), [unverified]);
  } finally { await w.close(); }
});

test('an expired or future-dated record is unverified, and a live logger refreshes its own record', async () => {
  const d = desktop();
  try {
    await d.log('A', ['process.started', {}]);
    const genuine = JSON.parse(readFileSync(d.record('A'), 'utf8'));
    for (const offset of [-60_000, 60_000]) {
      writeFileSync(d.record('A'), JSON.stringify({ ...genuine, updatedAt: new Date(Date.now() + offset).toISOString() }));
      assert.deepEqual(d.status(), [unverified], `updatedAt offset ${offset}`);
      const refused = d.stop();
      assert.notEqual(refused.status, 0); assert.match(refused.stderr, /could not be verified/); assert.ok(d.alive());
    }
    await d.log('A', ['process.started', {}]);
    assert.deepEqual(d.status(), [], 'a fresh publication is verified again');
  } finally { await d.close(); }
  const state = tempState('bridge-runtime-refresh-');
  const log = createLogger(join(state, 'logs'), { runtimeDirectory: join(state, 'runtime'), refreshMs: 50 });
  try {
    log('process.started');
    const record = join(state, 'runtime', `${process.pid}-${log.runId}.json`), first = JSON.parse(readFileSync(record, 'utf8')).updatedAt;
    await bounded(() => JSON.parse(readFileSync(record, 'utf8')).updatedAt !== first, 'the record is refreshed without new events');
  } finally { log.close(); rmSync(state, { recursive: true, force: true }); }
});

test('a Bridge whose nice value changed, or that can signal no further, is never verified', async () => {
  const d = desktop();
  try {
    await d.log('A', ['process.started', {}]);
    assert.deepEqual(d.status(), [], 'control');
    setPriority(d.instances.A.pid, 19); // Raising another own process's nice value needs no privilege.
    assert.deepEqual(d.status(), [unverified], 'the record no longer matches the live value');
    await d.log('A', ['process.started', {}]);
    assert.equal(JSON.parse(readFileSync(d.record('A'), 'utf8')).nice, 19);
    assert.deepEqual(d.status(), [unverified], 'even a matching record at 19 is not verified');
    const refused = d.stop();
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /could not be verified/); assert.ok(d.alive());
  } finally { await d.close(); }
});

test('the guard treats an unknown live nice value as unverified', () => {
  const state = tempState('bridge-runtime-nice-'), runId = randomUUID(), pid = 4242, startedAt = Date.now();
  try {
    mkdirSync(join(state, 'runtime'));
    const write = nice => writeFileSync(join(state, 'runtime', `${pid}-${runId}.json`), JSON.stringify({ pid, runId, startedAt,
      updatedAt: new Date().toISOString(), nice, stopping: false, activeThreads: [], startingThreads: [], pendingStarts: 0 }));
    // Pure guard evaluation with a substituted process listing; no real process.
    const evaluate = live => {
      const result = spawnSync('python3', ['-B', '-c', `import importlib.util, json, pathlib, sys
s = importlib.util.spec_from_file_location('launch', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
live = json.loads(sys.argv[4])
m.bridge_processes = lambda: ({${pid}: (1, float(sys.argv[3]), live)}, {${pid}: 1})
print(json.dumps(m.active_threads(pathlib.Path(sys.argv[2]))))`, join(root, 'launch.py'), state, String(startedAt / 1000), JSON.stringify(live)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    write(0);
    assert.deepEqual(evaluate(0), [], 'matching control');
    assert.deepEqual(evaluate(null), [unverified], 'nice value unknown or not reported by ps');
    assert.deepEqual(evaluate(1), [unverified], 'signalled after this record');
    write(19);
    assert.deepEqual(evaluate(19), [unverified], 'no further signal possible');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a runtime directory replaced after start is never written through or cleaned up through', async () => {
  const d = desktop(), outside = tempState('bridge-runtime-replaced-'), threadId = randomUUID();
  chmodSync(outside, 0o750);
  try {
    await d.log('A', ['process.started', {}]); await d.log('B', ['process.started', {}]);
    const names = id => [basename(d.record(id)), `.${d.instances[id].pid}-${d.instances[id].runId}.tmp`];
    const runtime = join(d.state, 'runtime'), original = join(d.state, 'runtime-original');
    const plant = (directory, id) => { for (const name of names(id)) { writeFileSync(join(directory, name), `KEEP ${name}`); chmodSync(join(directory, name), 0o640); } };
    const untouched = (directory, id) => {
      assert.equal(statSync(directory).mode & 0o777, 0o750);
      assert.deepEqual(readdirSync(directory).sort(), names(id).sort());
      for (const name of names(id)) {
        assert.equal(readFileSync(join(directory, name), 'utf8'), `KEEP ${name}`); assert.equal(statSync(join(directory, name)).mode & 0o777, 0o640);
      }
    };
    plant(outside, 'A');
    renameSync(runtime, original); symlinkSync(outside, runtime);
    await d.log('A', ['turn.preparing', { threadId }]);
    untouched(outside, 'A');
    assert.equal(readFileSync(join(original, basename(d.record('A'))), 'utf8'), '', 'its own record is invalidated in place instead');
    assert.deepEqual(d.status(), [unverified]);
    await d.exit('A');
    untouched(outside, 'A');

    rmSync(runtime); mkdirSync(runtime); chmodSync(runtime, 0o750); plant(runtime, 'B');
    await d.log('B', ['turn.preparing', { threadId }]);
    untouched(runtime, 'B');
    assert.equal(readFileSync(join(original, basename(d.record('B'))), 'utf8'), '', 'a replacement real directory is refused too');
    await d.exit('B');
    untouched(runtime, 'B');
  } finally { await d.close(); rmSync(outside, { recursive: true, force: true }); }
});
