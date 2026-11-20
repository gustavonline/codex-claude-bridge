import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './support/fixture.mjs';
import { createLogger, safeFields } from '../logging.mjs';

test('actual Bridge model/list records bounded flags, counts and IDs, preserving results without raw request/result data', async () => {
  const state = mkdtempSync(join(tmpdir(), 'bridge-model-diag-')), log = createLogger(state), f = fixture('openai', { log });
  const secret = 'PRIVATE-not-a-model-label@example.invalid';
  try {
    const result = await f.bridge.request('model/list', { includeHidden: true, limit: 1, arbitrary: secret });
    assert.equal(result.data.length, 1);
    const entries = readFileSync(log.path, 'utf8').trim().split('\n').map(JSON.parse), req = entries.find(e => e.event === 'models.requested'), res = entries.find(e => e.event === 'models.listed');
    assert.equal(req.includeHidden, true); assert.equal(req.limit, 1); assert.equal(req.cursorPresent, false);
    assert.equal(res.returnedRows, 1); assert.ok(res.catalogRows >= 2); assert.equal(res.hiddenRows, 0);
    assert.equal(entries.find(e => e.event === 'models.row').model, result.data[0].id);
    assert.equal(JSON.stringify(entries).includes(secret), false);
    await f.bridge.request('model/list', { includeHidden: false, limit: 1, cursor: result.nextCursor });
    const next = readFileSync(log.path, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.event === 'models.requested').at(-1);
    assert.equal(next.includeHidden, false); assert.equal(next.cursorPresent, true);
    assert.deepEqual(safeFields({ includeHidden: true, cursorPresent: true, hidden: false, limit: 10, params: secret, result: secret, cursor: secret, auth: secret, model: secret }), { includeHidden: true, cursorPresent: true, hidden: false, limit: 10 });
  } finally { f.bridge.mirror?.stop(); rmSync(state, { recursive: true, force: true }); }
});

test('model/list diagnostics sample at most 16 rows, omit unsafe IDs and keep failure requests visible without synthetic success', async () => {
  const entries = [], f = fixture('openai', { log: (event, fields) => entries.push({ event, ...safeFields(fields) }) });
  f.bridge.native.request = async () => ({ data: Array.from({ length: 30 }, (_, i) => ({ id: i === 0 ? 'unsafe\nprivate label' : 'model-' + i, model: 'model-' + i })) });
  const result = await f.bridge.request('model/list', { limit: 100 }); assert.ok(result.data.length >= 30);
  const rows = entries.filter(e => e.event === 'models.row'); assert.equal(rows.length, 16); assert.equal(rows[0].model, undefined); assert.equal(rows[15].model, 'model-15');
  entries.length = 0; f.bridge.native.request = async () => { throw Error('PRIVATE NATIVE FAILURE'); };
  await assert.rejects(f.bridge.request('model/list', { includeHidden: true }));
  assert.equal(entries.filter(e => e.event === 'models.requested').length, 1); assert.equal(entries.some(e => e.event === 'models.listed'), false); assert.equal(JSON.stringify(entries).includes('PRIVATE'), false);
});
