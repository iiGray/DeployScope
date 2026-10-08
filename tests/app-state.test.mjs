import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeployment,
  createInitialState,
  escapeHtml,
  getModelsForNode,
  startDeployment,
  stopDeployment,
  updateDeployment,
  validateDraft,
} from '../src/app-state.mjs';

test('escaping user-entered aliases prevents markup injection in rendered tables', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)"> & lab'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; lab',
  );
});

test('switching nodes exposes only models stored on that node', () => {
  const state = createInitialState();

  assert.deepEqual(
    getModelsForNode(state, 'node-h20-02').map((model) => model.alias),
    ['DeepSeek-R1-Distill-Qwen-32B', 'Qwen2.5-72B-Instruct'],
  );
  assert.deepEqual(
    getModelsForNode(state, 'node-a100-01').map((model) => model.alias),
    ['Qwen2.5-32B-Instruct', 'Llama-3.3-70B-Instruct', 'Qwen2.5-VL-72B-Instruct'],
  );
});

test('validation rejects a GPU already reserved by another deployment', () => {
  const state = createInitialState();
  const result = validateDraft(
    {
      alias: 'new-service',
      nodeId: 'node-a100-01',
      modelPath: '/data/llm/Qwen2.5-32B-Instruct',
      gpuIds: [0],
    },
    state,
  );

  assert.deepEqual(result, {
    valid: false,
    errors: { gpuIds: 'GPU 0 已被 qwen-32b 占用' },
  });
});

test('creating a deployment reserves the selected GPUs and starts the service', () => {
  const state = createInitialState();
  const next = createDeployment(state, {
    alias: 'deepseek-32b-lab',
    nodeId: 'node-h20-02',
    modelPath: '/models/h20/DeepSeek-R1-Distill-Qwen-32B',
    gpuIds: [2, 3],
    maxModelLen: 32768,
    gpuMemoryUtilization: 0.9,
    dtype: 'auto',
  });

  const deployment = next.deployments.find((item) => item.alias === 'deepseek-32b-lab');
  assert.equal(deployment.status, 'starting');
  assert.equal(deployment.tensorParallelSize, 2);
  assert.deepEqual(deployment.gpuIds, [2, 3]);
  assert.equal(next.nodes.find((node) => node.id === 'node-h20-02').gpus[2].deploymentId, deployment.id);
  assert.equal(next.nodes.find((node) => node.id === 'node-h20-02').gpus[3].deploymentId, deployment.id);
});

test('editing a deployment releases old GPUs before reserving its new selection', () => {
  const state = createInitialState();
  const next = updateDeployment(state, 'dep-qwen-32b', {
    alias: 'qwen-32b',
    nodeId: 'node-a100-01',
    modelPath: '/data/llm/Qwen2.5-32B-Instruct',
    gpuIds: [2, 3],
    maxModelLen: 32768,
    gpuMemoryUtilization: 0.92,
    dtype: 'bfloat16',
  });
  const node = next.nodes.find((item) => item.id === 'node-a100-01');

  assert.equal(node.gpus[0].deploymentId, null);
  assert.equal(node.gpus[1].deploymentId, null);
  assert.equal(node.gpus[2].deploymentId, 'dep-qwen-32b');
  assert.equal(node.gpus[3].deploymentId, 'dep-qwen-32b');
  assert.equal(next.deployments.find((item) => item.id === 'dep-qwen-32b').status, 'restarting');
});

test('stopping a deployment releases its GPUs and preserves its configuration', () => {
  const state = createInitialState();
  const next = stopDeployment(state, 'dep-qwen-32b');
  const deployment = next.deployments.find((item) => item.id === 'dep-qwen-32b');
  const node = next.nodes.find((item) => item.id === 'node-a100-01');

  assert.equal(deployment.status, 'stopped');
  assert.deepEqual(deployment.gpuIds, [0, 1]);
  assert.equal(node.gpus[0].deploymentId, null);
  assert.equal(node.gpus[1].deploymentId, null);
});

test('starting a stopped deployment reclaims its configured GPUs', () => {
  const stopped = stopDeployment(createInitialState(), 'dep-qwen-32b');
  const next = startDeployment(stopped, 'dep-qwen-32b');
  const deployment = next.deployments.find((item) => item.id === 'dep-qwen-32b');
  const node = next.nodes.find((item) => item.id === 'node-a100-01');

  assert.equal(deployment.status, 'starting');
  assert.equal(node.gpus[0].deploymentId, 'dep-qwen-32b');
  assert.equal(node.gpus[1].deploymentId, 'dep-qwen-32b');
});
