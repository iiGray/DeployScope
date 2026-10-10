import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApi, emptyState, sharedState, readRuntime } from '../src/api.mjs';
import { listen } from './fixtures/helpers.mjs';
import { createMutationIntent, mutationBody } from '../src/mutation.mjs';

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
  await assert.rejects(api('/failure', { method: 'POST', body: {} }), { message: 'GPU occupied', status: 409 });
});

test('a truncated successful response is uncertain and replay keeps the original request identity', async t => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    bodies.push(JSON.parse(input));
    res.setHeader('Content-Type', 'application/json');
    if (bodies.length === 1) {
      res.writeHead(200, { 'Content-Length': '100' }); res.flushHeaders(); res.write('{"id":');
      setTimeout(() => res.destroy(), 20);
    } else res.end('{"id":"same-deployment"}');
  });
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const client = createApi(await listen(server));
  const frozen = createMutationIntent({ kind: 'start', id: 'same-deployment', revision: 2, shared: true }, 'original-request');
  let failure; try { await client('/start', { method: 'POST', body: mutationBody(frozen) }); } catch (cause) { failure = cause; }
  assert.equal(failure?.status, 0, 'unreadable success is not a definitive server rejection');
  assert.equal(!failure.status || failure.status >= 500, true, 'UI retains this frozen retry');
  assert.equal((await client('/start', { method: 'POST', body: mutationBody(frozen) })).id, 'same-deployment');
  assert.deepEqual(bodies[1], bodies[0]); assert.equal(bodies[1].requestId, 'original-request'); assert.equal(bodies[1].expectedRevision, 2);
});

test('selected log errors preserve a successfully loaded shared cluster snapshot', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/control/state') res.end(JSON.stringify({ nodes: [{ id: 'healthy', status: 'online', gpus: [], models: [] }], services: [{ id: 'selected', nodeId: 'healthy', status: 'running' }], apiBase: 'http://control/v1' }));
    else res.writeHead(404).end('{"error":{"message":"logs unavailable"}}');
  });
  t.after(() => new Promise((r) => server.close(r)));
  const result = await readRuntime(createApi(await listen(server)), 'selected');
  assert.equal(result.snapshot.nodes[0].status, 'online');
  assert.equal(result.logError, 'logs unavailable');
});

async function runtimeFixture(t, services) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/control/state') {
      res.end(JSON.stringify({ nodes: [{ id: 'alpha' }, { id: 'beta' }], services, apiBase: 'http://control/v1' }));
    } else {
      const id = /^\/api\/control\/deployments\/([^/]+)\/logs$/.exec(req.url)?.[1];
      if (services.some(s => s.id === id)) res.end(JSON.stringify({ logs: `vLLM log for ${id}` }));
      else res.writeHead(404).end('{"error":{"message":"deployment missing"}}');
    }
  });
  t.after(() => new Promise(r => server.close(r)));
  return createApi(await listen(server));
}

const services = [
  { id: 'old', nodeId: 'alpha', status: 'stopped', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'ready', nodeId: 'alpha', status: 'running', createdAt: '2026-10-02T00:00:00Z' },
  { id: 'loading', nodeId: 'alpha', status: 'starting', createdAt: '2026-10-03T00:00:00Z' },
  { id: 'other', nodeId: 'beta', status: 'running', createdAt: '2026-10-04T00:00:00Z' },
];

test('opening the page without a selection reads the current machine running vLLM log', async t => {
  const result = await readRuntime(await runtimeFixture(t, services), null, 'alpha');
  assert.equal(result.selectedId, 'ready');
  assert.equal(result.logs, 'vLLM log for ready');
  assert.equal(result.logError, null);
});

test('startup logs are selected when the machine has no running service', async t => {
  const result = await readRuntime(await runtimeFixture(t, services.filter(s => s.id !== 'ready')), null, 'alpha');
  assert.equal(result.selectedId, 'loading');
  assert.equal(result.logs, 'vLLM log for loading');
});

test('an explicit service choice keeps its log instead of switching to the default', async t => {
  const result = await readRuntime(await runtimeFixture(t, services), 'old', 'alpha');
  assert.equal(result.selectedId, 'old');
  assert.equal(result.logs, 'vLLM log for old');
});

test('first load chooses the first machine and a removed service falls back to its running log', async t => {
  const client = await runtimeFixture(t, services);
  const initial = await readRuntime(client, null);
  assert.equal(initial.selectedId, 'ready');
  const removed = await readRuntime(client, 'deleted', 'alpha');
  assert.equal(removed.selectedId, 'ready');
  assert.equal(removed.logs, 'vLLM log for ready');
});

test('a machine without deployments never displays logs belonging to another machine', async t => {
  const result = await readRuntime(await runtimeFixture(t, services.filter(s => s.nodeId === 'beta')), null, 'alpha');
  assert.equal(result.selectedId, null);
  assert.equal(result.logs, null);
  assert.equal(result.logError, null);
});
