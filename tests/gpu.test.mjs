import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGpuCsv, parseProcessCsv, validateDeployment, vllmLaunch } from '../backend/gpu.mjs';

test('GPU telemetry converts NVIDIA MiB into GiB and preserves unknown readings', () => {
  const devices = parseGpuCsv('0, GPU-aaa, NVIDIA A100, 40960, 1024, 72, 65, 550.54.15\n1, GPU-bbb, NVIDIA H20, 98304, 0, [N/A], [Not Supported], 550.54.15\n');
  assert.equal(devices[0].memoryTotal, 40);
  assert.equal(devices[0].memoryUsed, 1);
  assert.equal(devices[0].uuid, 'GPU-aaa');
  assert.equal(devices[1].utilization, null);
  assert.equal(devices[1].temperature, null);
});

test('compute processes identify external GPU users even with unknown memory', () => {
  assert.deepEqual(parseProcessCsv('1234, GPU-aaa, 512\n2345, GPU-bbb, [N/A]\n'), [
    { pid: 1234, uuid: 'GPU-aaa', memoryUsed: 0.5 },
    { pid: 2345, uuid: 'GPU-bbb', memoryUsed: null },
  ]);
});

test('server validation rejects duplicate GPU ids and invalid memory fractions', () => {
  assert.throws(() => validateDeployment({ alias: 'ok', modelPath: '/models/Qwen', gpuIds: [0, 0] }), /GPU/);
  assert.throws(() => validateDeployment({ alias: 'ok', modelPath: '/models/Qwen', gpuIds: [0], gpuMemoryUtilization: 1.1 }), /显存/);
  assert.throws(() => validateDeployment({ alias: 'bad; echo pwned', modelPath: '/models/Qwen', gpuIds: [0] }), /别名/);
});

test('vLLM launch uses literal arguments, GPU UUIDs and loopback binding', () => {
  const command = vllmLaunch({ alias: 'qwen', modelPath: '/models/my Qwen', gpuIds: [1, 0], maxModelLen: 32768, gpuMemoryUtilization: 0.9, dtype: 'auto' }, [{ id: 0, uuid: 'GPU-aaa' }, { id: 1, uuid: 'GPU-bbb' }], 8123, 'internal-key');
  assert.equal(command.env.CUDA_VISIBLE_DEVICES, 'GPU-bbb,GPU-aaa');
  assert.deepEqual(command.args.slice(0, 4), ['serve', '/models/my Qwen', '--served-model-name', 'qwen']);
  assert.ok(command.args.includes('127.0.0.1'));
  assert.equal(command.args[command.args.indexOf('--port') + 1], '8123');
  assert.equal(command.args[command.args.indexOf('--api-key') + 1], 'internal-key');
});
