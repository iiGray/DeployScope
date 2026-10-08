import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand } from '../src/command.mjs';

test('launch preview quotes model paths and aliases containing shell syntax', () => {
  const command = buildCommand({
    gpuIds: [2, 3],
    modelPath: '/models/team models/Qwen',
    alias: 'qwen; echo hello',
    maxModelLen: 32768,
    gpuMemoryUtilization: 0.9,
    dtype: 'auto',
  });

  assert.equal(command, [
    "CUDA_VISIBLE_DEVICES=2,3 vllm serve '/models/team models/Qwen' \\",
    "  --served-model-name 'qwen; echo hello' \\",
    '  --tensor-parallel-size 2 \\',
    '  --max-model-len 32768 \\',
    '  --gpu-memory-utilization 0.9 \\',
    '  --dtype auto',
  ].join('\n'));
});
