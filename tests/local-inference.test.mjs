import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAgent } from '../backend/agent.mjs';
import { createController } from '../backend/controller.mjs';
import { fixtureDirectory, fixtureExecutable, telemetry, draft, listen, waitFor } from './fixtures/helpers.mjs';

const keyA = 'local-inference-a-independent';
const keyB = 'local-inference-b-independent';
async function gateway(t, fixture, id, key) {
  const app = await createAgent({ id, token: 'agent-management-secret', stateDir: join(fixture.directory, id), modelRoot: fixture.models, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 60000, localInference: { enabled: true, port: 18080, apiKeys: [key] } }, { readGpuStatus: telemetry });
  fixture.cleanupWith(app.close);
  assert.ok(app.localInference, 'Agent must own an independent local gateway');
  const baseUrl = await listen(app.localInference.server);
  const managementUrl = await listen(app.server);
  const request = (path, body, token = key) => fetch(baseUrl + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { app, baseUrl, managementUrl, request };
}

test('local gateways only discover their own ready aliases and use independent keys', async t => {
  const f = await fixtureDirectory(t);
  const a = await gateway(t, f, 'node-a', keyA); const b = await gateway(t, f, 'node-b', keyB);
  const one = await a.app.manager.create(draft(f.models, { alias: 'model-a' }));
  await b.app.manager.create(draft(f.models, { alias: 'model-b' }));
  await waitFor(async () => (await a.app.manager.status(one.id)).status === 'running');
  await waitFor(async () => (await b.app.manager.localModels()).length === 1);
  assert.deepEqual((await (await a.request('/v1/models')).json()).data.map(m => m.id), ['model-a']);
  assert.equal((await a.request('/v1/chat/completions', { model: 'model-b' })).status, 404);
  assert.equal((await a.request('/v1/chat/completions', { model: 'model-a' }, keyB)).status, 401);
  const result = await (await a.request('/v1/completions', { model: 'model-a' })).json();
  assert.equal(result.model, 'model-a');
  const old = await fetch(`${a.managementUrl}/api/deployments/${one.id}/inference/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer agent-management-secret' }, body: JSON.stringify({ model: 'model-a' }) });
  assert.equal(old.status, 404);
  const snapshot = await a.app.manager.snapshot();
  assert.deepEqual(snapshot.inference, { scope: 'server-local', apiBase: 'http://127.0.0.1:18080/v1' });
  assert.equal(JSON.stringify(snapshot).includes(keyA), false);
  await a.app.manager.stop(one.id);
  assert.deepEqual((await (await a.request('/v1/models')).json()).data, []);
  assert.equal((await a.request('/v1/completions', { model: 'model-a' })).status, 503);
});

test('local inference streams first chunks promptly and does not serialize response streams', async t => {
  const f = await fixtureDirectory(t); const a = await gateway(t, f, 'node-a', keyA);
  const dep = await a.app.manager.create(draft(f.models));
  await waitFor(async () => (await a.app.manager.status(dep.id)).status === 'running');
  const response = await a.request('/v1/chat/completions', { model: dep.alias, stream: true });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(); const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /first/);
  assert.equal(first.done, false);
  const nextChunk = reader.read();
  const winner = await Promise.race([a.request('/v1/completions', { model: dep.alias }).then(r => ({ kind: 'other', status: r.status })), nextChunk.then(() => ({ kind: 'stream' }))]);
  assert.deepEqual(winner, { kind: 'other', status: 200 });
  await reader.cancel();
  await waitFor(async () => (await a.app.manager.logs(dep.id)).includes('Fixture stream closed'));
  await a.app.close(); await a.app.close();
  assert.equal(a.app.localInference.server.listening, false);
  const replacement = await createAgent(a.app.manager.config, { readGpuStatus: telemetry });
  f.cleanupWith(replacement.close);
});

test('starting deployments are excluded until their local health check is ready', async t => {
  const f = await fixtureDirectory(t);
  const app = await createAgent({ id: 'slow', token: keyA, stateDir: join(f.directory, 'slow'), modelRoot: f.models, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable, '--test-slow-health'], pollMs: 60000, localInference: { enabled: true, apiKeys: [keyA] } }, { readGpuStatus: telemetry });
  f.cleanupWith(app.close);
  const dep = await app.manager.create(draft(f.models));
  assert.deepEqual(await app.manager.localModels(), []);
  await assert.rejects(app.manager.localTarget(dep.alias), { status: 503 });
  await waitFor(async () => (await app.manager.localModels()).length === 1);
});

test('invalid local gateway configuration fails before acquiring an Agent lock', async t => {
  const f = await fixtureDirectory(t);
  const config = { id: 'invalid-node', token: keyA, stateDir: join(f.directory, 'invalid'), modelRoot: f.models, localInference: { enabled: true, apiKeys: ['short'] } };
  await assert.rejects(createAgent(config), /密钥/);
  const app = await createAgent({ ...config, localInference: { enabled: true, apiKeys: [keyA] } }, { readGpuStatus: telemetry });
  f.cleanupWith(app.close);
});

test('disabled Controller never exposes a cross-node inference entry', async t => {
  const f = await fixtureDirectory(t);
  const controller = await createController({ stateDir: join(f.directory, 'controller'), adminToken: keyA, apiKeys: [keyB], publicUrl: 'http://127.0.0.1:18081', inferenceEnabled: false });
  f.cleanupWith(controller.close); const url = await listen(controller.server);
  assert.equal((await fetch(url + '/v1/models', { headers: { Authorization: `Bearer ${keyB}` } })).status, 404);
  assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${keyB}` }, body: '{}' })).status, 404);
  const state = await controller.manager.state();
  assert.equal(state.inferenceMode, 'per-node'); assert.equal(state.apiBase, null);
});
