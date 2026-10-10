import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createAgent } from '../backend/agent.mjs';
import { createController } from '../backend/controller.mjs';
import { ApiError } from '../backend/common.mjs';
import { fixtureDirectory, fixtureExecutable, telemetry, draft, waitFor, listen } from './fixtures/helpers.mjs';

async function cluster(t) {
  const { directory, models, cleanupWith } = await fixtureDirectory(t);
  const nodes = []; const agents = [];
  for (const id of ['node-a', 'node-b']) {
    const token = `secret-agent-token-${id}`;
    const agent = await createAgent({ id, modelRoot: models, modelBrowseRoot:directory, defaultModelRoot:models, stateDir: join(directory, id), token, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 40, stopTimeoutMs: 800 }, { readGpuStatus: async () => telemetry() });
    cleanupWith(() => agent.close()); agents.push(agent);
    nodes.push({ id, name: id, url: await listen(agent.server), token });
  }
  const config = { stateDir: join(directory, 'control'), adminToken: 'secret-controller-admin', apiKeys: ['secret-inference-key'], nodes, publicUrl: 'http://control:8080' };
  const controller = await createController(config); cleanupWith(() => controller.close());
  const url = await listen(controller.server);
  const request = (path, method = 'GET', body, key = config.adminToken) => fetch(url + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { controller, config, request, url, agents, models, cleanupWith };
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

test('Controller preserves the selected per-deployment root across updates from older clients', async t => {
  const c=await cluster(t); const manager=c.controller.manager;
  const dep=await manager.create(draft(c.models,{nodeId:'node-a',modelRoot:c.models}));
  assert.ok(dep.modelRoot);
  const response=await c.request(`/api/deployments/${dep.id}`,'PATCH',draft(c.models,{nodeId:'node-a',alias:'renamed'}));
  assert.equal(response.status,200); assert.equal((await response.json()).modelRoot,dep.modelRoot);
  assert.equal(manager.service(dep.id).modelRoot,dep.modelRoot);
  const denied=await c.request('/api/nodes/node-a/directories','POST',{},c.config.apiKeys[0]); assert.equal(denied.status,401);
});

test('an unresolved update cannot silently replace its reserved model folder', async t => {
  const c=await cluster(t); const manager=c.controller.manager;
  const dep=await manager.create(draft(c.models,{nodeId:'node-a',modelRoot:c.models}));
  const original=manager.call.bind(manager);
  manager.call=async (...args)=>{ if(args[2]==='PATCH') throw new ApiError(502,'not delivered'); return original(...args); };
  const change=draft(c.models,{nodeId:'node-a',alias:'renamed',modelRoot:c.models});
  await assert.rejects(manager.update(dep.id,change),/not delivered/);
  await assert.rejects(manager.update(dep.id,{...change,modelRoot:join(c.models,'Qwen')}),/另一份配置/);
  assert.equal(manager.service(dep.id).pending.modelRoot,c.models);
});

test('a legacy retry inherits the committed folder after a lost root-change response', async t => {
  const c=await cluster(t); const manager=c.controller.manager;
  const dep=await manager.create(draft(c.models,{nodeId:'node-a',modelRoot:join(c.models,'..')}));
  const original=manager.call.bind(manager); let lose=true;
  manager.call=async (...args)=>{const result=await original(...args); if(args[2]==='PATCH' && lose){lose=false;throw new ApiError(502,'response lost');} return result;};
  await assert.rejects(manager.update(dep.id,draft(c.models,{nodeId:'node-a',alias:'scope-moved',modelRoot:c.models})),/response lost/);
  const committedRoot=c.agents[0].manager.find(dep.id).modelRoot;
  const retried=await manager.update(dep.id,draft(c.models,{nodeId:'node-a',alias:'scope-moved'}));
  assert.equal(retried.modelRoot,committedRoot); assert.notEqual(retried.modelRoot,dep.modelRoot);
});

test('a legacy retry inherits an unresolved pending folder rather than the previous folder', async t => {
  const c=await cluster(t); const manager=c.controller.manager;
  const dep=await manager.create(draft(c.models,{nodeId:'node-a',modelRoot:join(c.models,'..')}));
  const original=manager.call.bind(manager); let blocked=true;
  manager.call=async (...args)=>{if(args[2]==='PATCH' && blocked) throw new ApiError(502,'not delivered'); return original(...args);};
  await assert.rejects(manager.update(dep.id,draft(c.models,{nodeId:'node-a',alias:'scope-moved',modelRoot:c.models})),/not delivered/);
  blocked=false;
  const retried=await manager.update(dep.id,draft(c.models,{nodeId:'node-a',alias:'scope-moved'}));
  assert.equal(retried.modelRoot,c.agents[0].manager.find(dep.id).modelRoot); assert.notEqual(retried.modelRoot,dep.modelRoot);
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
  const restarted = await createController(c.config); c.cleanupWith(() => restarted.close());
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

test('controller deletion removes routing, persists an archive and frees the global alias', async (t) => {
  const c = await cluster(t);
  const dep = await (await c.request('/api/deployments', 'POST', draft(c.models, { nodeId: 'node-a' }))).json();
  await c.controller.manager.action(dep.id, 'stop');
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {}, c.config.apiKeys[0])).status, 401);
  const response = await c.request(`/api/deployments/${dep.id}`, 'DELETE', {});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { id: dep.id, deleted: true });
  assert.equal((await c.controller.manager.state()).services.length, 0);
  assert.equal((await c.agents[0].manager.snapshot()).deployments.length, 0);
  assert.equal(await readFile(join(dep.modelPath, 'config.json'), 'utf8'), '{}');
  assert.equal(c.controller.manager.data.deletedServices[0].id, dep.id);
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 200);
  assert.equal((await c.request('/v1/chat/completions', 'POST', { model: 'qwen-test' }, c.config.apiKeys[0])).status, 404);
  await c.controller.close();
  const restarted = await createController(c.config); c.cleanupWith(() => restarted.close());
  assert.equal((await restarted.manager.state()).services.length, 0);
  const replacement = await restarted.manager.create(draft(c.models, { nodeId: 'node-b' }));
  assert.notEqual(replacement.id, dep.id);
});

test('controller rejects non-stopped and unresolved-edit records before deletion', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const record = manager.service(dep.id);
  try {
    for (const status of ['starting', 'running', 'stopping', 'failed', 'unknown', 'orphaned']) {
      record.status = status;
      assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 409, status);
    }
    record.status = 'stopped'; record.pending = draft(c.models, { alias: 'unconfirmed' });
    assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 409);
  } finally { record.status = 'stopped'; delete record.pending; }
  assert.equal(c.agents[0].manager.data.deployments.length, 1);
});

test('a stale controller snapshot cannot delete a deployment restarted directly at the Agent', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  await c.agents[0].manager.start(dep.id);
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 409);
  assert.equal(c.agents[0].manager.data.deployments.length, 1);
  assert.ok(['starting', 'running'].includes((await manager.state()).services[0].status));
});

test('an undelivered delete reserves its alias, blocks other changes and can be retried', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const original = manager.call.bind(manager); let fail = true;
  manager.call = async (...args) => { if (args[2] === 'DELETE' && fail) { fail = false; throw new ApiError(502, 'not delivered'); } return original(...args); };
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 502);
  const pending = (await manager.state()).services[0];
  assert.equal(pending.status, 'stopped'); assert.equal(pending.deletePending, true);
  assert.equal((await c.request(`/api/deployments/${dep.id}/start`, 'POST')).status, 409);
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'PATCH', draft(c.models, { nodeId: 'node-a' }))).status, 409);
  assert.equal((await c.request('/api/deployments', 'POST', draft(c.models, { nodeId: 'node-b' }))).status, 409);
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 200);
  assert.equal((await manager.state()).services.length, 0);
});

test('a lost delete response is reconciled only after a live snapshot confirms removal', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const original = manager.call.bind(manager); let lose = true;
  manager.call = async (...args) => { const result = await original(...args); if (args[2] === 'DELETE' && lose) { lose = false; throw new ApiError(502, 'response lost'); } return result; };
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 502);
  await assert.rejects(manager.create(draft(c.models, { nodeId: 'node-b' })), /别名已存在/);
  assert.equal((await manager.state()).services.length, 0);
  assert.equal(manager.data.deletedServices.length, 1);
  const replacement = await manager.create(draft(c.models, { nodeId: 'node-b' })); assert.notEqual(replacement.id, dep.id);
});

test('controller requires an explicit matching delete acknowledgement', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const original = manager.call.bind(manager);
  manager.call = async (...args) => { const result = await original(...args); return args[2] === 'DELETE' ? { ok: true } : result; };
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 502);
  assert.equal(manager.data.services[0].deletePending, true);
  assert.equal((await manager.state()).services.length, 0);
});

test('a rejected delete retry preserves earlier unresolved deletion intent', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const original = manager.call.bind(manager); let attempts = 0;
  manager.call = async (...args) => {
    if (args[2] === 'DELETE') {
      if (attempts++ === 0) { await original(...args); throw new ApiError(502, 'response lost'); }
      throw new ApiError(401, 'temporary credential rejection');
    }
    return original(...args);
  };
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 502);
  assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 401);
  assert.equal(manager.data.services[0].deletePending, true);
  await assert.rejects(manager.create(draft(c.models, { nodeId: 'node-b' })), /别名已存在/);
  assert.equal((await manager.state()).services.length, 0);
  assert.equal(manager.data.deletedServices[0].id, dep.id);
  const replacement = await manager.create(draft(c.models, { nodeId: 'node-b' })); assert.notEqual(replacement.id, dep.id);
});

test('controller retains an alias when its final deletion archive cannot be committed', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const original = manager.call.bind(manager); const file = manager.file;
  const blocked = join(c.config.stateDir, 'not-a-directory'); await writeFile(blocked, 'test');
  manager.call = async (...args) => { const result = await original(...args); if (args[2] === 'DELETE') manager.file = join(blocked, 'state.json'); return result; };
  try {
    assert.equal((await c.request(`/api/deployments/${dep.id}`, 'DELETE', {})).status, 500);
    assert.equal(manager.data.services[0].deletePending, true);
    await assert.rejects(manager.create(draft(c.models, { nodeId: 'node-b' })), /别名已存在/);
  } finally { manager.file = file; }
  assert.equal((await manager.state()).services.length, 0);
});

test('concurrent start and delete cannot remove an active model', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const dep = await manager.create(draft(c.models, { nodeId: 'node-a' })); await manager.action(dep.id, 'stop');
  const [remove, start] = await Promise.all([c.request(`/api/deployments/${dep.id}`, 'DELETE', {}), c.request(`/api/deployments/${dep.id}/start`, 'POST')]);
  if (remove.status === 200) { assert.equal(start.status, 404); assert.equal((await manager.state()).services.length, 0); }
  else { assert.equal(remove.status, 409); assert.equal(start.status, 200); assert.equal((await manager.state()).services.length, 1); }
});

test('reconciling another deletion during update does not lose the successful update state', async (t) => {
  const c = await cluster(t); const manager = c.controller.manager;
  const first = await manager.create(draft(c.models, { nodeId: 'node-a', alias: 'keep-a' })); await manager.action(first.id, 'stop');
  const second = await manager.create(draft(c.models, { nodeId: 'node-b', alias: 'delete-b' })); await manager.action(second.id, 'stop');
  const change = draft(c.models, { nodeId: 'node-a', alias: 'updated-a' });
  const original = manager.call.bind(manager); let blockPatch = true; let loseDelete = true;
  manager.call = async (...args) => {
    if (args[2] === 'PATCH' && blockPatch) { blockPatch = false; throw new ApiError(502, 'update not delivered'); }
    const result = await original(...args);
    if (args[2] === 'DELETE' && loseDelete) { loseDelete = false; throw new ApiError(502, 'delete response lost'); }
    return result;
  };
  await assert.rejects(manager.update(first.id, change)); await assert.rejects(manager.remove(second.id));
  await manager.update(first.id, change);
  assert.equal(manager.service(first.id).pending, undefined);
  assert.equal(manager.service(first.id).alias, 'updated-a');
  assert.equal(manager.data.services.length, 1);
});

test('in-flight readiness cannot bypass a pending update after another deletion replaces state', async t => {
  const c = await cluster(t); const manager = c.controller.manager;
  const first = await manager.create(draft(c.models, { nodeId: 'node-a', alias: 'live-a' }));
  const second = await manager.create(draft(c.models, { nodeId: 'node-b', alias: 'delete-b' })); await manager.action(second.id, 'stop');
  await waitFor(async () => (await manager.state()).services.find(d => d.id === first.id)?.status === 'running');
  const original = manager.call.bind(manager); let reached; let release;
  const ready = new Promise(resolve => reached = resolve); const gate = new Promise(resolve => release = resolve);
  manager.call = async (...args) => {
    if (args[2] === 'PATCH') throw new ApiError(502, 'update not delivered');
    const result = await original(...args);
    if (args[1] === `/api/deployments/${first.id}` && args[2] === 'GET') { reached(); await gate; }
    return result;
  };
  const flight = manager.inference('live-a'); await ready;
  await manager.remove(second.id);
  await assert.rejects(manager.update(first.id, draft(c.models, { nodeId: 'node-a', alias: 'updated-a' })));
  const check = assert.rejects(flight, /未确认/); release(); await check;
});
