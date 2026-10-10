import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../backend/controller.mjs';
import { createAgent } from '../backend/agent.mjs';
import { ApiError, writeJson } from '../backend/common.mjs';
import { fingerprintMutation } from '../backend/mutations.mjs';
import { join } from 'node:path';
import { sharedCluster } from './fixtures/shared-cluster.mjs';
import { draft, waitFor, fixtureDirectory, fixtureExecutable, telemetry } from './fixtures/helpers.mjs';
const submit = (client, payload) => client.request('/api/control/deployments', { method: 'POST', body: payload });
async function setup(t) { const c = await sharedCluster(t, { guardedMutations: true }); await Promise.all(c.clients.map(client => client.login())); return c; }
const input = (c, extra = {}) => draft(c.models, { nodeId: 'node-a', requestId: 'create-first', ...extra });
const action = (client, dep, kind, requestId, revision = dep.revision) => client.request(`/api/control/deployments/${dep.id}${kind === 'delete' ? '' : '/' + kind}`, { method: kind === 'delete' ? 'DELETE' : 'POST', body: { requestId, expectedRevision: revision } });

test('the first admitted HTTP submission reserves its entire GPU set, later conflicts reserve nothing', async t => {
  const c = await setup(t); const [a, b] = c.clients;
  let entered; const barrier = new Promise(r => entered = r); let release; const hold = new Promise(r => release = r);
  const original = c.agents[0].manager.readGpuStatus; let once = true;
  c.agents[0].manager.readGpuStatus = async () => { if (once) { once = false; entered(); await hold; } return original(); };
  const first = submit(a, input(c, { gpuIds: [0, 1] })); await barrier;
  const later = submit(b, input(c, { requestId: 'create-later', alias: 'later', gpuIds: [1] })); release();
  const results = await Promise.all([first, later]); assert.deepEqual(results.map(r => r.status), [201, 409]);
  const dep = await results[0].json();
  assert.equal(dep.revision, 1); assert.equal(dep.submissionSeq, 1);
  const hardware = await c.agents[0].manager.hardware(); assert.deepEqual(hardware.gpus.map(g => g.deploymentId), [dep.id, dep.id]);
  assert.equal(c.agents[0].manager.data.deployments.some(d => d.alias === 'later'), false);
});

test('same create replay is durable and a changed payload cannot reuse its request ID', async t => {
  const c = await setup(t); const [a] = c.clients; const body = input(c);
  const created = await (await submit(a, body)).json(); const pid = c.agents[0].manager.find(created.id).pid;
  const replayed = await (await submit(a, body)).json();
  assert.equal(replayed.id, created.id); assert.equal(replayed.revision, 1); assert.equal(c.controller.manager.data.lastSubmissionSeq, 1);
  assert.equal(c.agents[0].manager.find(created.id).pid, pid);
  assert.equal((await submit(a, { ...body, alias: 'changed' })).status, 409);
  assert.equal((await submit(a, { ...body, requestId: undefined })).status, 400);
});

test('different machines have independent GPU zero and multi-card conflicts never partly reserve', async t => {
  const c = await setup(t); const [a, b] = c.clients;
  assert.equal((await submit(a, input(c))).status, 201);
  assert.equal((await submit(b, input(c, { alias: 'other-machine', nodeId: 'node-b', requestId: 'other-create' }))).status, 201);
  assert.equal((await submit(b, input(c, { alias: 'multi-conflict', requestId: 'multi-create', gpuIds: [1, 0] }))).status, 409);
  assert.equal((await c.agents[0].manager.hardware()).gpus[1].deploymentId, null);
});

test('stale stop/delete confirmations are rejected and health polling never consumes revisions', async t => {
  const c = await setup(t); const [a, b] = c.clients; const dep = await (await submit(a, input(c))).json();
  const stopped = await (await action(a, dep, 'stop', 'stop-first')).json(); assert.equal(stopped.revision, 2);
  const start = await action(b, stopped, 'start', 'start-second'); assert.equal(start.status, 200);
  const started = await start.json(); const pid = c.agents[0].manager.find(dep.id).pid; assert.equal(started.revision, 3);
  assert.equal((await action(a, stopped, 'delete', 'stale-delete')).status, 409);
  assert.equal((await action(a, stopped, 'stop', 'stale-stop')).status, 409);
  for (let i = 0; i < 3; i++) assert.equal((await c.controller.manager.state()).services[0].revision, 3);
  assert.equal(c.agents[0].manager.find(dep.id).pid, pid);
});

test('two edits based on one version accept only the first, preserving the original replay identity', async t => {
  const c = await setup(t); const [a, b] = c.clients; const dep = await (await submit(a, input(c))).json();
  const edit = input(c, { alias: 'renamed', requestId: 'edit-a', expectedRevision: 1 });
  const changed = await a.request(`/api/control/deployments/${dep.id}`, { method: 'PATCH', body: edit }); assert.equal(changed.status, 200);
  assert.equal((await b.request(`/api/control/deployments/${dep.id}`, { method: 'PATCH', body: { ...edit, alias: 'other', requestId: 'edit-b' } })).status, 409);
  const replay = await a.request(`/api/control/deployments/${dep.id}`, { method: 'PATCH', body: edit }); assert.equal((await replay.json()).revision, 2);
});

test('lost Agent responses survive Controller restart without launching a duplicate child', async t => {
  const c = await setup(t); const manager = c.controller.manager; const original = manager.call.bind(manager); let lost = true;
  manager.call = async (...args) => { const result = await original(...args); if (args[2] === 'POST' && args[1] === '/api/deployments' && lost) { lost = false; throw new ApiError(502, 'response lost'); } return result; };
  await assert.rejects(manager.create(input(c)), /response lost/);
  const record = manager.data.services[0]; const pid = c.agents[0].manager.find(record.id).pid;
  await c.controller.close();
  const restored = await createController(c.config); c.cleanupWith(restored.close);
  const replay = await restored.manager.create(input(c));
  assert.equal(replay.id, record.id); assert.equal(replay.revision, 1); assert.equal(c.agents[0].manager.find(record.id).pid, pid);
  assert.equal(restored.manager.data.lastSubmissionSeq, 1);
});

test('old stop operation replay cannot stop a later restart, even after Controller restart', async t => {
  const c = await setup(t); const manager = c.controller.manager; const dep = await manager.create(input(c));
  const stopBody = { requestId: 'stop-original', expectedRevision: 1 };
  const original = manager.call.bind(manager); let lost = true;
  manager.call = async (...args) => { const result = await original(...args); if (args[1].endsWith('/stop') && lost) { lost = false; throw new ApiError(502, 'lost stop'); } return result; };
  await assert.rejects(manager.action(dep.id, 'stop', stopBody), /lost stop/);
  await c.controller.close(); const restored = await createController(c.config); c.cleanupWith(restored.close);
  const stopped = await restored.manager.action(dep.id, 'stop', stopBody); assert.equal(stopped.revision, 2);
  const started = await restored.manager.action(dep.id, 'start', { requestId: 'start-new', expectedRevision: 2 });
  const pid = c.agents[0].manager.find(dep.id).pid;
  assert.equal((await restored.manager.action(dep.id, 'stop', stopBody)).revision, 2);
  assert.equal(c.agents[0].manager.find(dep.id).pid, pid); assert.equal(started.revision, 3);
  const oldOp = c.agents[0].manager.data.mutationReceipts.find(r => r.kind === 'stop').requestId;
  await c.agents[0].manager.stop(dep.id, { operationId: oldOp });
  assert.equal(c.agents[0].manager.find(dep.id).pid, pid);
});

test('uncertain submissions block new intent and known resource rejection does not consume a service revision', async t => {
  const c = await setup(t); const manager = c.controller.manager; const dep = await manager.create(input(c));
  await manager.action(dep.id, 'stop', { requestId: 'stop', expectedRevision: 1 });
  const original = manager.call.bind(manager);
  manager.call = async (...args) => { if (args[1].endsWith('/start')) throw new ApiError(502, 'offline'); return original(...args); };
  await assert.rejects(manager.action(dep.id, 'start', { requestId: 'uncertain', expectedRevision: 2 }), /offline/);
  await assert.rejects(manager.action(dep.id, 'stop', { requestId: 'different-intent', expectedRevision: 3 }), { status: 409 });
  manager.call = original;
  const restarted = await manager.action(dep.id, 'start', { requestId: 'uncertain', expectedRevision: 2 }); assert.equal(restarted.revision, 3);
  await manager.action(dep.id, 'stop', { requestId: 'stop-again', expectedRevision: 3 });
  c.agents[0].manager.readGpuStatus = async () => ({ ...(await c.agents[1].manager.readGpuStatus()), processes: [{ uuid: 'GPU-test-0', pid: 99999 }] });
  await assert.rejects(manager.action(dep.id, 'start', { requestId: 'external-busy', expectedRevision: 4 }), { status: 409 });
  assert.equal(manager.service(dep.id).revision, 4);
});

test('a pending rename reserves both aliases across all machines until its operation is confirmed', async t => {
  const c = await setup(t); const manager = c.controller.manager; const dep = await manager.create(input(c));
  const original = manager.call.bind(manager);
  manager.call = async (...args) => { if (args[2] === 'PATCH') { await original(...args); throw new ApiError(502, 'lost rename'); } return original(...args); };
  await assert.rejects(manager.update(dep.id, input(c, { alias: 'pending-alias', requestId: 'rename', expectedRevision: 1 })), /lost rename/);
  await assert.rejects(manager.create(input(c, { alias: 'pending-alias', nodeId: 'node-b', requestId: 'steal-alias' })), { status: 409 });
});

test('a partial update cannot turn a later resource rejection into a false no-side-effects rollback', async t => {
  const c = await setup(t); const manager = c.controller.manager; const dep = await manager.create(input(c));
  const agent = c.agents[0].manager; let reads = 0; const original = agent.readGpuStatus;
  agent.readGpuStatus = async () => { const result = await original(); if (++reads >= 2) result.processes = [{ uuid: 'GPU-test-0', pid: 99999 }]; return result; };
  const edit = input(c, { alias: 'partial-update', requestId: 'partial', expectedRevision: 1 });
  await assert.rejects(manager.update(dep.id, edit), { status: 502 });
  assert.equal(agent.find(dep.id).status, 'stopped');
  await assert.rejects(manager.update(dep.id, edit), { status: 502 });
  assert.equal(manager.service(dep.id).revision, 2); assert.equal(manager.service(dep.id).pendingMutation, 'partial');
  agent.readGpuStatus = original;
  const recovered = await manager.update(dep.id, edit); assert.equal(recovered.revision, 2);
});

test('Agent recovery preserves an uncertain launch reservation instead of silently freeing its GPUs', async t => {
  const f = await fixtureDirectory(t); const stateDir = join(f.directory, 'agent');
  const payload = draft(f.models, { id: 'dep-uncertain', operationId: 'op-uncertain', gpuIds: [0, 1] });
  await writeJson(join(stateDir, 'state.json'), { modelRoot: f.models, deployments: [{ ...payload, gpuUuids: ['GPU-test-0', 'GPU-test-1'], reservedOperationId: 'op-uncertain', status: 'starting', pid: null }], mutationReceipts: [{ requestId: 'op-uncertain', serviceId: 'dep-uncertain', kind: 'create', status: 'pending', acceptedAt: Date.now(), fingerprint: fingerprintMutation({ kind: 'create', serviceId: 'dep-uncertain', payload }) }] });
  const agent = await createAgent({ id: 'test-node', token: 'recovery-agent-secret', modelRoot: f.models, stateDir, coordinatedWrites: true }, { readGpuStatus: telemetry }); f.cleanupWith(agent.close);
  assert.equal(agent.manager.find('dep-uncertain').status, 'orphaned');
  assert.deepEqual((await agent.manager.hardware()).gpus.map(g => g.deploymentId), ['dep-uncertain', 'dep-uncertain']);
  await assert.rejects(agent.manager.create(payload), { status: 503 });
  await assert.rejects(agent.manager.stop('dep-uncertain', { operationId: 'another-stop' }), { status: 409 });
});

test('an interrupted update before launch resumes its restart rather than confirming a stopped configuration', async t => {
  const f = await fixtureDirectory(t);
  const config = { id: 'test-node', token: 'update-recovery-secret', modelRoot: f.models, stateDir: join(f.directory, 'agent'), coordinatedWrites: true, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 40 };
  const agent = await createAgent(config, { readGpuStatus: telemetry }); f.cleanupWith(agent.close);
  const dep = await agent.manager.create(draft(f.models, { id: 'dep-update-recovery', operationId: 'op-create-recovery' }));
  agent.manager.launch = async () => { throw new ApiError(502, 'interrupted before launch'); };
  const edit = draft(f.models, { alias: 'updated', operationId: 'op-update-recovery' });
  await assert.rejects(agent.manager.update(dep.id, edit), /interrupted before launch/);
  await agent.close();
  const restored = await createAgent(config, { readGpuStatus: telemetry }); f.cleanupWith(restored.close);
  const result = await restored.manager.update(dep.id, edit);
  assert.ok(Number.isInteger(result.pid) && result.pid > 1, 'replay must actually restart the model');
  assert.equal(result.alias, 'updated');
  assert.equal(restored.manager.operation('op-update-recovery').status, 'confirmed');
  await waitFor(async () => (await restored.manager.status(dep.id)).status === 'running');
  assert.equal((await restored.manager.update(dep.id, edit)).pid, result.pid);
});

test('a live process group retains GPU ownership when its main process exits', async t => {
  const f = await fixtureDirectory(t);
  const agent = await createAgent({ id: 'test-node', token: 'group-agent-secret', modelRoot: f.models, stateDir: join(f.directory, 'agent'), coordinatedWrites: true, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable, '--test-group-child'], pollMs: 40 }, { readGpuStatus: telemetry }); f.cleanupWith(agent.close);
  const dep = await agent.manager.create(draft(f.models, { id: 'dep-group', operationId: 'op-group' }));
  f.cleanupWith(async () => { try { process.kill(-dep.pid, 'SIGKILL'); } catch {} });
  await waitFor(async () => (await agent.manager.status(dep.id)).status === 'running');
  process.kill(dep.pid, 'SIGKILL');
  await waitFor(async () => (await agent.manager.status(dep.id)).status === 'orphaned');
  assert.equal((await agent.manager.hardware()).gpus[0].deploymentId, dep.id);
  await assert.rejects(agent.manager.create(draft(f.models, { alias: 'later', id: 'dep-later', operationId: 'op-later' })), { status: 409 });
});

test('two authenticated HTTP clients share deployment state while local gateways keep model lists isolated', async t => {
  const c = await setup(t); const [a, b] = c.clients;
  const one = await (await submit(a, input(c, { alias: 'local-a' }))).json();
  await submit(b, input(c, { nodeId: 'node-b', alias: 'local-b', requestId: 'local-b-create' }));
  await waitFor(async () => (await c.controller.manager.state()).services.every(s => s.status === 'running'));
  const stateA = await (await a.request('/api/control/state')).json(); const stateB = await (await b.request('/api/control/state')).json();
  assert.deepEqual(stateA.services.map(s => s.id), stateB.services.map(s => s.id));
  for (const [index, alias] of ['local-a', 'local-b'].entries()) {
    const response = await fetch(c.agents[index].gatewayUrl + '/v1/models', { headers: { Authorization: `Bearer local-key-node-${index ? 'b' : 'a'}-independent` } });
    assert.deepEqual((await response.json()).data.map(m => m.id), [alias]);
  }
  const remote = await fetch(c.config.nodes[0].url + `/api/deployments/${one.id}/inference/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${c.config.nodes[0].token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'local-a' }) });
  assert.equal(remote.status, 404);
  const controllerUrl = `http://127.0.0.1:${c.controller.server.address().port}`;
  assert.equal((await fetch(controllerUrl + '/v1/models')).status, 404);
  await a.request('/api/session/logout', { method: 'POST', body: {} });
  assert.equal((await a.request('/api/control/state')).status, 401); assert.equal((await b.request('/api/control/state')).status, 200);
});
