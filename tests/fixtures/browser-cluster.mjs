// Browser-only integration fixture: no real GPUs or vLLM. Never used by production scripts.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../backend/agent.mjs';
import { createController } from '../../backend/controller.mjs';
import { createConsole } from '../../backend/console.mjs';
import { fixtureExecutable, telemetry, listen, draft, waitFor } from './helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'gpu-monitor-browser-test-'));
const models = join(directory, 'models');
await mkdir(join(models, 'Qwen'), { recursive: true }); await writeFile(join(models, 'Qwen', 'config.json'), '{}');
if(process.argv.includes('--folder-preview')) {
  for(const name of ['Model-A','Model-B']) { await mkdir(join(models,'Group',name),{recursive:true}); await writeFile(join(models,'Group',name,'config.json'),'{}'); }
  await mkdir(join(models,'Empty'));
}
const agent = await createAgent({ id: 'integration-test-node', name: '测试机器（模拟 GPU）', modelRoot: models, modelBrowseRoot:directory, defaultModelRoot:models, stateDir: join(directory, 'agent'), token: 'browser-fixture-agent-token', vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 100 }, { readGpuStatus: async () => telemetry() });
const controller = await createController({ stateDir: join(directory, 'control'), adminToken: 'browser-fixture-admin-token', apiKeys: ['browser-fixture-inference-token'], publicUrl: 'http://127.0.0.1:5191', nodes: [{ id: 'integration-test-node', name: '测试机器（模拟 GPU）', url: await listen(agent.server), token: 'browser-fixture-agent-token' }] });
const controllerUrl = await listen(controller.server);
if (process.argv.includes('--delete-preview')) {
  const stopped = await controller.manager.create(draft(models, { nodeId: 'integration-test-node', alias: 'delete-preview-stopped', gpuIds: [0] }));
  await controller.manager.action(stopped.id, 'stop');
  const running = await controller.manager.create(draft(models, { nodeId: 'integration-test-node', alias: 'delete-preview-running', gpuIds: [1] }));
  await waitFor(async () => (await controller.manager.state()).services.find(item => item.id === running.id)?.status === 'running');
}
const ui = await createConsole({ settingsFile: join(directory, 'console.json'), controllerUrl, adminToken: 'browser-fixture-admin-token' });
await new Promise((done) => ui.server.listen(5190, '127.0.0.1', done));
console.log(`Browser integration fixture · http://127.0.0.1:5190 · ${models}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await ui.close(); await controller.close(); await agent.close(); await rm(directory, { recursive: true, force: true }); });
