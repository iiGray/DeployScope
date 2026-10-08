import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApi, emptyState, sharedState, readRuntime } from '../src/api.mjs';
import { listen } from './fixtures/helpers.mjs';

test('real mode starts empty and shared state never falls back to demo machines', () => {
  assert.deepEqual(emptyState().nodes, []);
  const result = sharedState({ nodes: [{ id: 'actual', gpus: [], models: [] }], services: [], apiBase: 'http://control/v1' });
  assert.equal(result.nodes[0].id, 'actual'); assert.deepEqual(result.deployments, []);
  assert.equal(result.gateway.baseUrl, 'http://control/v1');
});

test('frontend client sends the local console header and displays backend errors', async (t) => {
  const server = createServer((req, res) => {
    if (req.headers['x-gpu-console'] !== '1') { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/failure')) { res.writeHead(409).end(JSON.stringify({ error: { message: 'GPU occupied' } })); }
    else res.end('{"ok":true}');
  });
  t.after(() => new Promise((r) => server.close(r)));
  const api = createApi(await listen(server));
  assert.equal((await api('/state')).ok, true);
  await assert.rejects(api('/failure', { method: 'POST', body: {} }), /GPU occupied/);
});

test('selected log errors preserve a successfully loaded shared cluster snapshot', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/control/state') res.end(JSON.stringify({ nodes: [{ id: 'healthy', status: 'online', gpus: [], models: [] }], services: [], apiBase: 'http://control/v1' }));
    else res.writeHead(404).end('{"error":{"message":"logs unavailable"}}');
  });
  t.after(() => new Promise((r) => server.close(r)));
  const result = await readRuntime(createApi(await listen(server)), 'selected');
  assert.equal(result.snapshot.nodes[0].status, 'online');
  assert.equal(result.logError, 'logs unavailable');
});
