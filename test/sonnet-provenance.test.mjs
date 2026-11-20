import test from 'node:test';
import assert from 'node:assert/strict';
import { provenance, buildTransfer } from '../continuity.mjs';


// The durable record of a continuation is small and technical: IDs, models, providers, counts. No transcript, no secret.
const turns = [{ id: 't1', status: 'completed', items: [
  { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'PRIVATE-CONTENT' }] },
  { type: 'reasoning', id: 'r1', summary: [], content: [], encrypted_content: 'x' }] }];

test('provenance names the true new ID and its source, the providers and models, and exactly what was left out', () => {
  const transfer = buildTransfer(turns);
  const record = provenance({ sourceId: 'src-1', sourceProvider: 'openai', sourceModel: 'gpt-x', targetProvider: 'bridge_custom_abc', targetModel: 'z13-model', targetId: 'new-1', transfer, now: 1700000000 });
  assert.deepEqual(record, { version: 1, sourceId: 'src-1', sourceProvider: 'openai', sourceModel: 'gpt-x', targetProvider: 'bridge_custom_abc', targetModel: 'z13-model', targetId: 'new-1', continuedAt: 1700000000,
    report: { turns: 1, sourceItems: 1, transferredItems: 1, bytes: transfer.report.bytes, omitted: { reasoning: 1, contextCompaction: 0, opaqueFields: 0 } } });
  assert.notEqual(record.sourceId, record.targetId, 'a continuation never claims the source ID');
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-CONTENT/, 'the record holds counts and IDs, not the conversation');
});
