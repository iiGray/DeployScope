import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const fixtureExecutable = fileURLToPath(new URL('./inference.mjs', import.meta.url));
export const telemetry = () => ({ gpus: [0, 1].map((id) => ({ id, uuid: `GPU-test-${id}`, name: 'NVIDIA test GPU', memoryTotal: 24, memoryUsed: 0.5, utilization: 0, temperature: 40, driver: 'test', deploymentId: null })), processes: [] });
export async function fixtureDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gpu-monitor-test-'));
  const models = join(directory, 'models'); await mkdir(join(models, 'Qwen'), { recursive: true });
  await writeFile(join(models, 'Qwen/config.json'), '{}');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, models };
}
export async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
export async function waitFor(predicate, timeout = 6000) { const until = Date.now() + timeout; while (Date.now() < until) { const result = await predicate(); if (result) return result; await delay(25); } throw new Error('Condition did not become true'); }
export const draft = (models, extra = {}) => ({ alias: 'qwen-test', nodeId: 'test-node', modelPath: join(models, 'Qwen'), gpuIds: [0], maxModelLen: 32768, gpuMemoryUtilization: 0.9, dtype: 'auto', ...extra });
