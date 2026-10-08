import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { relay } from '../backend/common.mjs';
import { listen } from './fixtures/helpers.mjs';

test('inference deadline sends a downstream error when upstream never sends headers', async (t) => {
  const upstream = createServer(() => {}); const upstreamUrl = await listen(upstream);
  const proxy = createServer((req, res) => relay(req, res, upstreamUrl, 'test-relay-token', {}, { timeoutMs: 100 }));
  const proxyUrl = await listen(proxy);
  t.after(async () => { upstream.closeAllConnections(); proxy.closeAllConnections(); await Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => proxy.close(r))]); });
  const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(800) });
  assert.equal(response.status, 504);
});
