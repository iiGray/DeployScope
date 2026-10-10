import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutationIntent, mutationBody, newRequestId } from '../src/mutation.mjs';
test('explicit network retry preserves frozen payload, original ID and confirmation revision', () => {
  const payload = { alias: 'model-a', nodeId: 'node-a', modelPath: '/models/a', gpuIds: [0], apiKey: 'must-not-send' };
  const intent = createMutationIntent({ kind: 'update', id: 'dep-a', payload, revision: 1, shared: true }, 'first');
  payload.gpuIds.push(1); payload.alias = 'changed';
  const initial = mutationBody(intent); const retry = mutationBody(intent);
  assert.equal(initial.requestId, 'first'); assert.equal(retry.requestId, 'first'); assert.equal(retry.expectedRevision, 1);
  assert.equal(retry.alias, 'model-a'); assert.deepEqual(retry.gpuIds, [0]); assert.equal(retry.apiKey, undefined);
  const changed = createMutationIntent({ kind: 'update', id: 'dep-a', payload, revision: 2, shared: true }, 'second');
  assert.notEqual(mutationBody(changed).requestId, retry.requestId);
  assert.throws(() => { intent.payload.gpuIds.push(2); }, TypeError);
});
test('request IDs remain cryptographically generated on a trusted HTTP console without randomUUID', () => {
  const random = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const a = newRequestId(random); const b = newRequestId(random);
  assert.match(a, /^[a-f0-9]{32}$/); assert.notEqual(a, b);
});
test('legacy requests remain compatible and shared actions require a captured revision', () => {
  assert.deepEqual(mutationBody(createMutationIntent({ kind: 'stop', id: 'dep-a' }, 'unused')), {});
  assert.throws(() => createMutationIntent({ kind: 'delete', id: 'dep-a', shared: true }, 'invalid'), /版本/);
  assert.deepEqual(mutationBody(createMutationIntent({ kind: 'delete', id: 'dep-a', shared: true, revision: 2 }, 'delete-old')), { requestId: 'delete-old', expectedRevision: 2 });
});
