import test from 'node:test';
import assert from 'node:assert/strict';
import * as viewModel from '../src/app-state.mjs';

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

test('a log picker without a selection exposes a blank choice before other machine services', () => {
  assert.equal(typeof viewModel.renderLogOptions, 'function');
  const html = viewModel.renderLogOptions([{ id: 'beta-only', alias: 'beta-service', status: 'running' }], null);
  assert.match(html, /^<option value="" selected>/);
  assert.match(html, /<option value="beta-only">/);
  assert.equal((html.match(/ selected/g) || []).length, 1);
});

test('explicit log choices remain selected and service labels cannot inject markup', () => {
  assert.equal(typeof viewModel.renderLogOptions, 'function');
  const html = viewModel.renderLogOptions([{ id: 'selected', alias: '<img src=x onerror=alert(1)>', status: 'running' }], 'selected');
  assert.match(html, /^<option value="selected" selected>/);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
});

test('model discovery errors have their own visible alert, independently of remote logs', () => {
  assert.equal(typeof viewModel.renderModelIssue, 'function');
  const html = viewModel.renderModelIssue('model folder <missing>');
  assert.match(html, /role="alert"/);
  assert.ok(html.includes('model folder &lt;missing&gt;'));
  assert.equal(viewModel.renderModelIssue(null), '');
});

test('service alias copy controls identify the API model name independently of the folder name', () => {
  assert.equal(typeof viewModel.renderAliasCopyButton,'function');
  const html=viewModel.renderAliasCopyButton({id:'dep-alias',alias:'MemoryAgent_copy',modelPath:'/data/models/RL-MemoryAgent-14B',status:'stopped'});
  assert.match(html,/data-copy-alias="dep-alias"/);
  assert.match(html,/aria-label="复制服务别名 MemoryAgent_copy"/);
  assert.match(html,/复制 model 字段/);
  assert.doesNotMatch(html,/RL-MemoryAgent-14B|disabled/);
  assert.match(viewModel.renderAliasCopyButton({id:'dep-alias',alias:'ready-model',status:'running'}),/data-copy-alias/);
});

test('alias copy labels escape untrusted names and reject missing deployment identities', () => {
  assert.equal(typeof viewModel.renderAliasCopyButton,'function');
  const html=viewModel.renderAliasCopyButton({id:'dep-alias',alias:'<img src=x onerror=alert(1)>'});
  assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<img/);
  assert.equal(viewModel.renderAliasCopyButton({id:'../invalid',alias:'wrong'}),'');
  assert.equal(viewModel.renderAliasCopyButton({alias:'missing-id'}),'');
  assert.equal(viewModel.renderAliasCopyButton({id:'dep-alias',alias:''}),'');
});

test('only stopped deployments render a delete button, and busy actions disable it', () => {
  assert.equal(typeof viewModel.renderDeleteButton, 'function');
  for (const status of ['running', 'starting', 'stopping', 'failed', 'orphaned', 'unknown']) assert.equal(viewModel.renderDeleteButton({ id: 'dep-delete-test', status }), '', status);
  assert.match(viewModel.renderDeleteButton({ id: 'dep-delete-test', status: 'stopped' }), /data-delete="dep-delete-test"/);
  assert.match(viewModel.renderDeleteButton({ id: 'dep-delete-test', status: 'stopped' }, true), /disabled/);
  assert.equal(viewModel.renderDeleteButton({ id: '../other', status: 'stopped' }), '');
});

test('delete confirmation names the deployment, escapes markup and requires explicit confirmation', () => {
  assert.equal(typeof viewModel.renderDeleteDialog, 'function');
  const html = viewModel.renderDeleteDialog({ id: 'dep-delete-test', alias: '<img src=x>', status: 'stopped' });
  assert.match(html, /role="dialog"/); assert.match(html, /data-action="cancel-delete"/);
  assert.match(html, /data-confirm-delete="dep-delete-test"/);
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img'));
  assert.equal(viewModel.renderDeleteDialog({ id: 'dep-delete-test', alias: 'running', status: 'running' }), '');
});

test('demo deletion rejects active services and removes a stopped service without changing other deployments', () => {
  assert.equal(typeof viewModel.deleteDeployment, 'function');
  const initial = createInitialState(); const stopped = stopDeployment(initial, 'dep-qwen-32b');
  assert.throws(() => viewModel.deleteDeployment(initial, 'dep-qwen-32b'), /停止/);
  const result = viewModel.deleteDeployment(stopped, 'dep-qwen-32b');
  assert.equal(result.deployments.some(d => d.id === 'dep-qwen-32b'), false);
  assert.equal(stopped.deployments.length, initial.deployments.length);
  assert.deepEqual(result.deployments, stopped.deployments.filter(d => d.id !== 'dep-qwen-32b'));
});

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
