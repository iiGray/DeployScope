const initialNodes = [
  {
    id: 'node-a100-01',
    name: 'train-a100-01',
    host: '10.24.8.12',
    status: 'online',
    modelRoot: '/data/llm',
    driver: '550.54.15',
    heartbeat: '刚刚',
    cpu: 36,
    memory: 58,
    models: [
      { alias: 'Qwen2.5-32B-Instruct', path: '/data/llm/Qwen2.5-32B-Instruct', size: '65 GB' },
      { alias: 'Llama-3.3-70B-Instruct', path: '/data/llm/Llama-3.3-70B-Instruct', size: '141 GB' },
      { alias: 'Qwen2.5-VL-72B-Instruct', path: '/data/llm/Qwen2.5-VL-72B-Instruct', size: '146 GB' },
    ],
    gpus: [
      { id: 0, name: 'NVIDIA A100 80GB', memoryTotal: 80, memoryUsed: 71, utilization: 82, temperature: 68, deploymentId: 'dep-qwen-32b' },
      { id: 1, name: 'NVIDIA A100 80GB', memoryTotal: 80, memoryUsed: 70, utilization: 79, temperature: 66, deploymentId: 'dep-qwen-32b' },
      { id: 2, name: 'NVIDIA A100 80GB', memoryTotal: 80, memoryUsed: 3, utilization: 2, temperature: 38, deploymentId: null },
      { id: 3, name: 'NVIDIA A100 80GB', memoryTotal: 80, memoryUsed: 2, utilization: 1, temperature: 37, deploymentId: null },
    ],
  },
  {
    id: 'node-h20-02',
    name: 'infer-h20-02',
    host: '10.24.8.23',
    status: 'online',
    modelRoot: '/models/h20',
    driver: '550.90.07',
    heartbeat: '4 秒前',
    cpu: 22,
    memory: 44,
    models: [
      { alias: 'DeepSeek-R1-Distill-Qwen-32B', path: '/models/h20/DeepSeek-R1-Distill-Qwen-32B', size: '65 GB' },
      { alias: 'Qwen2.5-72B-Instruct', path: '/models/h20/Qwen2.5-72B-Instruct', size: '145 GB' },
    ],
    gpus: [
      { id: 0, name: 'NVIDIA H20 96GB', memoryTotal: 96, memoryUsed: 87, utilization: 91, temperature: 64, deploymentId: 'dep-deepseek' },
      { id: 1, name: 'NVIDIA H20 96GB', memoryTotal: 96, memoryUsed: 86, utilization: 88, temperature: 63, deploymentId: 'dep-deepseek' },
      { id: 2, name: 'NVIDIA H20 96GB', memoryTotal: 96, memoryUsed: 4, utilization: 3, temperature: 36, deploymentId: null },
      { id: 3, name: 'NVIDIA H20 96GB', memoryTotal: 96, memoryUsed: 4, utilization: 2, temperature: 36, deploymentId: null },
    ],
  },
  {
    id: 'node-4090-03',
    name: 'lab-4090-03',
    host: '10.24.9.31',
    status: 'online',
    modelRoot: '/mnt/models',
    driver: '550.54.15',
    heartbeat: '8 秒前',
    cpu: 17,
    memory: 31,
    models: [
      { alias: 'Qwen2.5-14B-Instruct-AWQ', path: '/mnt/models/Qwen2.5-14B-Instruct-AWQ', size: '10 GB' },
      { alias: 'Phi-4', path: '/mnt/models/Phi-4', size: '29 GB' },
      { alias: 'bge-m3', path: '/mnt/models/bge-m3', size: '2.3 GB' },
    ],
    gpus: [
      { id: 0, name: 'NVIDIA RTX 4090', memoryTotal: 24, memoryUsed: 20, utilization: 72, temperature: 71, deploymentId: 'dep-qwen-awq' },
      { id: 1, name: 'NVIDIA RTX 4090', memoryTotal: 24, memoryUsed: 2, utilization: 1, temperature: 41, deploymentId: null },
      { id: 2, name: 'NVIDIA RTX 4090', memoryTotal: 24, memoryUsed: 1, utilization: 0, temperature: 39, deploymentId: null },
      { id: 3, name: 'NVIDIA RTX 4090', memoryTotal: 24, memoryUsed: 1, utilization: 0, temperature: 39, deploymentId: null },
    ],
  },
];

const initialDeployments = [
  {
    id: 'dep-qwen-32b',
    alias: 'qwen-32b',
    modelPath: '/data/llm/Qwen2.5-32B-Instruct',
    nodeId: 'node-a100-01',
    gpuIds: [0, 1],
    tensorParallelSize: 2,
    status: 'running',
    maxModelLen: 32768,
    gpuMemoryUtilization: 0.92,
    dtype: 'bfloat16',
    requestsPerMinute: 84,
    uptime: '12天 6小时',
    updatedAt: '今天 14:32',
  },
  {
    id: 'dep-deepseek',
    alias: 'deepseek-r1-32b',
    modelPath: '/models/h20/DeepSeek-R1-Distill-Qwen-32B',
    nodeId: 'node-h20-02',
    gpuIds: [0, 1],
    tensorParallelSize: 2,
    status: 'running',
    maxModelLen: 65536,
    gpuMemoryUtilization: 0.9,
    dtype: 'auto',
    requestsPerMinute: 61,
    uptime: '4天 18小时',
    updatedAt: '昨天 19:08',
  },
  {
    id: 'dep-qwen-awq',
    alias: 'qwen-14b-fast',
    modelPath: '/mnt/models/Qwen2.5-14B-Instruct-AWQ',
    nodeId: 'node-4090-03',
    gpuIds: [0],
    tensorParallelSize: 1,
    status: 'running',
    maxModelLen: 16384,
    gpuMemoryUtilization: 0.88,
    dtype: 'auto',
    requestsPerMinute: 39,
    uptime: '2天 3小时',
    updatedAt: '今天 09:41',
  },
];

const clone = (value) => structuredClone(value);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function createInitialState() {
  return {
    nodes: clone(initialNodes),
    deployments: clone(initialDeployments),
    gateway: {
      baseUrl: 'http://10.24.8.12:8080/v1',
      status: 'healthy',
      requestsPerMinute: 184,
      p95LatencyMs: 1260,
    },
  };
}

export function getModelsForNode(state, nodeId) {
  return state.nodes.find((node) => node.id === nodeId)?.models ?? [];
}

export function validateDraft(draft, state, editingId = null) {
  const errors = {};
  if (!draft.alias?.trim()) errors.alias = '请输入服务别名';
  if (!draft.nodeId) errors.nodeId = '请选择部署机器';
  if (!draft.modelPath) errors.modelPath = '请选择模型';
  if (!draft.gpuIds?.length) errors.gpuIds = '请至少选择一张 GPU';

  const duplicate = state.deployments.find(
    (item) => item.alias === draft.alias?.trim() && item.id !== editingId,
  );
  if (duplicate) errors.alias = '服务别名已存在';

  const node = state.nodes.find((item) => item.id === draft.nodeId);
  if (node && draft.gpuIds?.length) {
    for (const gpuId of draft.gpuIds) {
      const gpu = node.gpus.find((item) => item.id === gpuId);
      if (!gpu) {
        errors.gpuIds = `GPU ${gpuId} 不存在`;
        break;
      }
      if (gpu.deploymentId && gpu.deploymentId !== editingId) {
        const owner = state.deployments.find((item) => item.id === gpu.deploymentId);
        errors.gpuIds = `GPU ${gpuId} 已被 ${owner?.alias ?? gpu.deploymentId} 占用`;
        break;
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

function reserveGpus(state, nodeId, gpuIds, deploymentId) {
  const node = state.nodes.find((item) => item.id === nodeId);
  for (const gpu of node.gpus) {
    if (gpuIds.includes(gpu.id)) gpu.deploymentId = deploymentId;
  }
}

function releaseGpus(state, deploymentId) {
  for (const node of state.nodes) {
    for (const gpu of node.gpus) {
      if (gpu.deploymentId === deploymentId) gpu.deploymentId = null;
    }
  }
}

function assertValidDraft(draft, state, editingId = null) {
  const result = validateDraft(draft, state, editingId);
  if (!result.valid) throw new Error(Object.values(result.errors)[0]);
}

export function createDeployment(state, draft) {
  assertValidDraft(draft, state);
  const next = clone(state);
  const id = `dep-${globalThis.crypto.randomUUID()}`;
  const deployment = {
    id,
    alias: draft.alias.trim(),
    modelPath: draft.modelPath,
    nodeId: draft.nodeId,
    gpuIds: [...draft.gpuIds].sort((a, b) => a - b),
    tensorParallelSize: draft.gpuIds.length,
    status: 'starting',
    maxModelLen: Number(draft.maxModelLen) || 32768,
    gpuMemoryUtilization: Number(draft.gpuMemoryUtilization) || 0.9,
    dtype: draft.dtype || 'auto',
    requestsPerMinute: 0,
    uptime: '刚刚创建',
    updatedAt: '刚刚',
  };
  next.deployments.unshift(deployment);
  reserveGpus(next, deployment.nodeId, deployment.gpuIds, deployment.id);
  return next;
}

export function updateDeployment(state, deploymentId, draft) {
  assertValidDraft(draft, state, deploymentId);
  const next = clone(state);
  const index = next.deployments.findIndex((item) => item.id === deploymentId);
  if (index === -1) throw new Error('部署不存在');

  releaseGpus(next, deploymentId);
  next.deployments[index] = {
    ...next.deployments[index],
    alias: draft.alias.trim(),
    nodeId: draft.nodeId,
    modelPath: draft.modelPath,
    gpuIds: [...draft.gpuIds].sort((a, b) => a - b),
    tensorParallelSize: draft.gpuIds.length,
    maxModelLen: Number(draft.maxModelLen) || 32768,
    gpuMemoryUtilization: Number(draft.gpuMemoryUtilization) || 0.9,
    dtype: draft.dtype || 'auto',
    status: 'restarting',
    updatedAt: '刚刚',
  };
  reserveGpus(next, draft.nodeId, draft.gpuIds, deploymentId);
  return next;
}

export function stopDeployment(state, deploymentId) {
  const next = clone(state);
  const deployment = next.deployments.find((item) => item.id === deploymentId);
  if (!deployment) throw new Error('部署不存在');
  releaseGpus(next, deploymentId);
  deployment.status = 'stopped';
  deployment.requestsPerMinute = 0;
  deployment.updatedAt = '刚刚';
  return next;
}

export function startDeployment(state, deploymentId) {
  const existing = state.deployments.find((item) => item.id === deploymentId);
  if (!existing) throw new Error('部署不存在');
  assertValidDraft(existing, state, deploymentId);

  const next = clone(state);
  const deployment = next.deployments.find((item) => item.id === deploymentId);
  reserveGpus(next, deployment.nodeId, deployment.gpuIds, deployment.id);
  deployment.status = 'starting';
  deployment.updatedAt = '刚刚';
  return next;
}
