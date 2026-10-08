import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAgent } from '../backend/agent.mjs';
import { createController } from '../backend/controller.mjs';
import { ApiError } from '../backend/common.mjs';
import { fixtureDirectory, fixtureExecutable, telemetry, draft, waitFor, listen } from './fixtures/helpers.mjs';

async function cluster(t) {
  const { directory, models } = await fixtureDirectory(t);
  const nodes = []; const agents = [];
  for (const id of ['node-a', 'node-b']) {
    const token = `secret-agent-token-${id}`;
    const agent = await createAgent({ id, modelRoot: models, stateDir: join(directory, id), token, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 40, stopTimeoutMs: 800 }, { readGpuStatus: async () => telemetry() });
    t.after(() => agent.close()); agents.push(agent);
    nodes.push({ id, name: id, url: await listen(agent.server), token });
  }
  const config = { stateDir: join(directory, 'control'), adminToken: 'secret-controller-admin', apiKeys: ['secret-inference-key'], nodes, publicUrl: 'http://control:8080' };
  const controller = await createController(config); t.after(() => controller.close());
  const url = await listen(controller.server);
  const request = (path, method = 'GET', body, key = config.adminToken) => fetch(url + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { controller, config, request, url, agents, models };
}

test('global alias reservation is serialized across machines and admin credentials stay private', async (t) => {
  const c = await cluster(t);
  const responses = await Promise.all(['node-a', 'node-b'].map((nodeId) => c.request('/api/deployments', 'POST', draft(c.models, { nodeId }))));
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const state = await (await c.request('/api/state')).json();
  assert.equal(state.services.length, 1);
  assert.equal(state.nodes.length, 2);
  assert.equal(state.apiBase, 'http://control:8080/v1');
  assert.equal(JSON.stringify(state).includes('secret-'), false);
  assert.equal((await c.request('/api/state', 'GET', undefined, c.config.apiKeys[0])).status, 401);
});

test('gateway selects a ready alias, enforces inference key and streams first chunk before completion', async (t) => {
  const c = await cluster(t);
  const deployment = await (await c.request('/api/deployments', 'POST', draft(c.models, { nodeId: 'node-a' }))).json();
  await waitFor(async () => (await c.controller.manager.state()).services[0]?.status === 'running');
  assert.equal((await fetch(c.url + '/v1/models')).status, 401);
  const models = await (await c.request('/v1/models', 'GET', undefined, c.config.apiKeys[0])).json();
  assert.equal(models.data[0].id, 'qwen-test');
  assert.equal((await c.request('/v1/chat/completions', 'POST', { model: 'missing' }, c.config.apiKeys[0])).status, 404);
  const response = await c.request('/v1/chat/completions', 'POST', { model: 'qwen-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }, c.config.apiKeys[0]);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /first/); assert.doesNotMatch(first, /\[DONE\]/);
  let remainder = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; remainder += new TextDecoder().decode(chunk.value); }
  assert.match(remainder, /\[DONE\]/);
  assert.equal((await c.request(`/api/deployments/${deployment.id}/stop`, 'POST')).status, 200);
  assert.equal((await c.request('/v1/chat/completions', 'POST', { model: 'qwen-test' }, c.config.apiKeys[0])).status, 503);
});

test('node failure is shown as offline and persisted deployment identity survives controller restart', async (t) => {
  const c = await cluster(t);
  const dep = await (await c.request('/api/deployments', 'POST', draft(c.models, { nodeId: 'node-a' }))).json();
  await c.controller.close();
  const restarted = await createController(c.config); t.after(() => restarted.close());
  assert.equal((await restarted.manager.state()).services[0].id, dep.id);
  await c.agents[0].close();
  const state = await restarted.manager.state();
  assert.equal(state.nodes.find((n) => n.id === 'node-a').status, 'offline');
  assert.equal(state.services[0].status, 'unknown');
});

test('node registration authenticates the Agent and model root edits are shared', async (t) => {
  const c = await cluster(t);
  const node = c.config.nodes[0];
  assert.equal((await c.request('/api/nodes', 'POST', { url: node.url, token: 'incorrect-secret-token', name: 'renamed' })).status, 401);
  assert.equal((await c.request('/api/nodes', 'POST', { url: node.url, token: node.token, name: 'renamed' })).status, 200);
  const state = await (await c.request('/api/state')).json();
  assert.equal(state.nodes[0].name, 'renamed');
  assert.equal((await c.request('/api/nodes/node-a/model-root', 'PUT', { modelRoot: '/does/not/exist' })).status, 400);
  assert.equal((await c.request('/api/nodes/node-a/model-root', 'PUT', { modelRoot: c.models })).status, 200);
});

test('a lost update response reconciles by operation identity despite model realpath normalization', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' }));
  const original = manager.call.bind(manager); let loseResponse = true;
  manager.call = async (...args) => { const result = await original(...args); if (args[2] === 'PATCH' && loseResponse) { loseResponse = false; throw new ApiError(502, 'response lost'); } return result; };
  await assert.rejects(manager.update(dep.id, draft(c.models, { nodeId: 'node-a', alias: 'renamed' })), /response lost/);
  const state = await manager.state();
  assert.equal(state.services[0].alias, 'renamed');
  assert.notEqual(state.services[0].status, 'unknown');
});

test('a second unresolved update cannot drop a prior reserved alias', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' }));
  const original = manager.call.bind(manager); let phase = 0;
  manager.call = async (...args) => {
    if (args[2] === 'PATCH') {
      if (phase++ === 0) { await original(...args); throw new ApiError(502, 'response lost'); }
      throw new ApiError(502, 'not delivered');
    }
    if (phase > 0 && args[1] === '/api/node') throw new ApiError(502, 'offline');
    return original(...args);
  };
  await assert.rejects(manager.update(dep.id, draft(c.models, { nodeId: 'node-a', alias: 'reserved-b' })));
  await assert.rejects(manager.update(dep.id, draft(c.models, { nodeId: 'node-a', alias: 'reserved-c' })));
  await assert.rejects(manager.create(draft(c.models, { nodeId: 'node-b', alias: 'reserved-b' })), /别名已存在/);
});

test('inference on a healthy machine does not wait for an unrelated silent machine', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  await manager.create(draft(c.models, { nodeId: 'node-a' }));
  await waitFor(async () => (await manager.state()).services[0].status === 'running');
  const silent = createServer((_req, res) => { const timer = setTimeout(() => res.writeHead(503).end('{}'), 1500); res.on('close', () => clearTimeout(timer)); });
  const silentUrl = await listen(silent); t.after(() => { silent.closeAllConnections(); return new Promise((r) => silent.close(r)); });
  manager.data.nodes.push({ id: 'unrelated-silent', name: 'silent', url: silentUrl, token: 'silent-agent-test-token' });
  const before = performance.now();
  const response = await c.request('/v1/chat/completions', 'POST', { model: 'qwen-test', messages: [] }, c.config.apiKeys[0]);
  assert.equal(response.status, 200);
  assert.match((await response.json()).choices[0].message.content, /fixture/);
  assert.ok(performance.now() - before < 1000, 'healthy inference must not fan out to unrelated nodes');
});
