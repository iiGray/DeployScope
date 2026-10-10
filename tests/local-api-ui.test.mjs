import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLocalApi } from '../src/app-state.mjs';
test('each service local API names its calling server and copies by service identity', () => {
  const service = { id: 'dep-a', nodeId: 'node-a' };
  const node = { id: 'node-a', name: '6kd_7<script>', inference: { scope: 'server-local', apiBase: 'http://127.0.0.1:18080/v1' } };
  const html = renderLocalApi(service, node);
  assert.match(html, /127\.0\.0\.1:18080\/v1/); assert.match(html, /6kd_7&lt;script&gt;/);
  assert.match(html, /data-copy-local-api="dep-a"/); assert.doesNotMatch(html, /<script>/);
  assert.equal(renderLocalApi(service, { ...node, id: 'node-b' }), '');
  assert.equal(renderLocalApi(service, { ...node, inference: { scope: 'server-local', apiBase: 'http://remote:18080/v1' } }), '');
});
