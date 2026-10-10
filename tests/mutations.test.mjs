import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintMutation, getReceipt, pruneReceipts } from '../backend/mutations.mjs';

test('mutation identity is canonical, includes intent and revision, and excludes transport IDs', () => {
  const a = fingerprintMutation({ kind: 'start', serviceId: 'dep-a', payload: { expectedRevision: 1, requestId: 'first' } });
  assert.equal(a, fingerprintMutation({ kind: 'start', serviceId: 'dep-a', payload: { requestId: 'retry', expectedRevision: 1 } }));
  assert.notEqual(a, fingerprintMutation({ kind: 'stop', serviceId: 'dep-a', payload: { expectedRevision: 1 } }));
  assert.notEqual(a, fingerprintMutation({ kind: 'start', serviceId: 'dep-a', payload: { expectedRevision: 2 } }));
  const data = { mutationReceipts: [{ requestId: 'first', fingerprint: a, status: 'pending' }] };
  assert.equal(getReceipt(data, 'first', a).status, 'pending');
  assert.equal(getReceipt(data, 'missing', a), null);
  assert.throws(() => getReceipt(data, 'first', 'different'), { status: 409 });
});

test('receipt retention never discards pending work and bounds completed history by age and count', () => {
  const now = 20 * 86400000;
  const receipts = Array.from({ length: 10002 }, (_, i) => ({ requestId: `r-${i}`, status: 'confirmed', acceptedAt: now - i, completedAt: now - i }));
  receipts.push({ requestId: 'old', status: 'rejected', acceptedAt: now - 8 * 86400000, completedAt: now - 8 * 86400000 });
  receipts.push({ requestId: 'pending', status: 'pending', acceptedAt: 0 });
  const retained = pruneReceipts(receipts, now);
  assert.equal(retained.length, 10001); assert.ok(retained.some(r => r.requestId === 'pending'));
  assert.equal(retained.some(r => r.requestId === 'old'), false); assert.equal(retained.some(r => r.requestId === 'r-10001'), false);
});
