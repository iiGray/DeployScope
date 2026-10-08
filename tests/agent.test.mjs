import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { once } from 'node:events';
import { createAgent } from '../backend/agent.mjs';
import { pidAlive } from '../backend/common.mjs';
import { fixtureDirectory, fixtureExecutable, telemetry, draft, waitFor, listen } from './fixtures/helpers.mjs';

async function agentFixture(t, overrides = {}, deps = {}) {
  const { directory, models } = await fixtureDirectory(t);
  const config = { id: 'test-node', name: 'test-node', modelRoot: models, stateDir: join(directory, 'agent'), token: 'agent-secret-test-token', vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 40, stopTimeoutMs: 800, ...overrides };
  const agent = await createAgent(config, { readGpuStatus: async () => telemetry(), ...deps });
  t.after(() => agent.close());
  return { ...agent, models, config };
}

test('Agent starts a real child process, reports readiness and stops only its own group', async (t) => {
  const agent = await agentFixture(t);
  const item = await agent.manager.create(draft(agent.models));
  assert.equal(item.status, 'starting');
  await waitFor(async () => (await agent.manager.snapshot()).deployments.find((candidate) => candidate.id === item.id)?.status === 'running');
  assert.match(await agent.manager.logs(item.id), /CUDA_VISIBLE_DEVICES=GPU-test-0/);
  assert.equal((await agent.manager.snapshot()).gpus[0].deploymentId, item.id);
  const stopped = await agent.manager.stop(item.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal((await agent.manager.snapshot()).gpus[0].deploymentId, null);
});

test('simultaneous requests cannot reserve the same GPU twice', async (t) => {
  const agent = await agentFixture(t);
  const results = await Promise.allSettled([agent.manager.create(draft(agent.models)), agent.manager.create(draft(agent.models, { alias: 'other' }))]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.match(results.find((item) => item.status === 'rejected').reason.message, /GPU.*占用/);
});

test('external compute processes block deployment without being terminated', async (t) => {
  const agent = await agentFixture(t, {}, { readGpuStatus: async () => ({ ...telemetry(), processes: [{ pid: 12345, uuid: 'GPU-test-0', memoryUsed: 1 }] }) });
  await assert.rejects(agent.manager.create(draft(agent.models)), /外部进程/);
  assert.equal((await agent.manager.snapshot()).gpus[0].externalBusy, true);
});

test('Agent rejects paths outside the selected model root and authenticates APIs', async (t) => {
  const agent = await agentFixture(t);
  await assert.rejects(agent.manager.create(draft(agent.models, { modelPath: '/tmp' })), /模型目录/);
  const url = await listen(agent.server);
  assert.equal((await fetch(url + '/api/node')).status, 401);
  const response = await fetch(url + '/api/node', { headers: { Authorization: 'Bearer agent-secret-test-token' } });
  const body = await response.json();
  assert.equal(body.models[0].alias, 'Qwen');
  assert.equal(JSON.stringify(body).includes('agent-secret-test-token'), false);
});

test('failed launches release GPU reservations and retained configurations survive restart', async (t) => {
  const agent = await agentFixture(t, { vllmExecutable: '/definitely/missing/vllm', vllmPrefixArgs: [] });
  const item = await agent.manager.create(draft(agent.models));
  assert.equal(item.status, 'failed');
  assert.equal((await agent.manager.snapshot()).gpus[0].deploymentId, null);
  await agent.close();
  const restarted = await createAgent(agent.config, { readGpuStatus: async () => telemetry() });
  t.after(() => restarted.close());
  assert.equal((await restarted.manager.snapshot()).deployments[0].alias, 'qwen-test');
});

test('an exited child is no longer evidence of process ownership', async (t) => {
  const agent = await agentFixture(t);
  const item = await agent.manager.create(draft(agent.models));
  const child = agent.manager.owned.get(item.id);
  const exited = once(child, 'close'); process.kill(-child.pid, 'SIGTERM'); await exited;
  assert.equal(!!await agent.manager.identity(agent.manager.find(item.id)), false);
});

test('restart preserves physical GPU identity when numeric indexes are reordered', async (t) => {
  let swapped = false;
  const agent = await agentFixture(t, {}, { readGpuStatus: async () => {
    const data = telemetry(); if (swapped) for (const gpu of data.gpus) gpu.uuid = `GPU-test-${1 - gpu.id}`;
    return data;
  } });
  const item = await agent.manager.create(draft(agent.models)); await agent.manager.stop(item.id); swapped = true;
  const restarted = await agent.manager.start(item.id);
  assert.deepEqual(restarted.gpuIds, [1]);
  const snapshot = await agent.manager.snapshot();
  assert.equal(snapshot.gpus[1].deploymentId, item.id);
  await assert.rejects(agent.manager.create(draft(agent.models, { alias: 'conflict', gpuIds: [1] })), /占用/);
});

test('repeating an applied update operation does not restart a running child again', async (t) => {
  const agent = await agentFixture(t);
  const item = await agent.manager.create(draft(agent.models));
  const change = draft(agent.models, { alias: 'updated', operationId: 'op-test-retry' });
  const first = await agent.manager.update(item.id, change);
  const retry = await agent.manager.update(item.id, change);
  assert.equal(retry.pid, first.pid);
});

test('process records from another boot never authorize signaling a live PID', async (t) => {
  const agent = await agentFixture(t); const item = await agent.manager.create(draft(agent.models));
  const record = agent.manager.find(item.id); const original = record.bootId;
  try { record.bootId = 'previous-boot-test'; assert.equal(!!await agent.manager.identity(record), false); }
  finally { record.bootId = original; }
});

test('stop escalation rechecks process identity before sending SIGKILL', async (t) => {
  const agent = await agentFixture(t, { vllmPrefixArgs: [fixtureExecutable, '--test-ignore-sigterm'], stopTimeoutMs: 80 });
  const item = await agent.manager.create(draft(agent.models));
  await waitFor(async () => (await agent.manager.status(item.id)).status === 'running');
  const original = agent.manager.identity.bind(agent.manager); let calls = 0;
  agent.manager.identity = async (record) => ++calls === 1 ? original(record) : false;
  try {
    await assert.rejects(agent.manager.stop(item.id), /身份/);
    assert.equal(pidAlive(item.pid), true);
  } finally { agent.manager.identity = original; await agent.manager.stop(item.id); }
});
