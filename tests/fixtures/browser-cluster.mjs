// CPU-only browser fixture. Never imported by production.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAgent } from '../../backend/agent.mjs';
import { createController } from '../../backend/controller.mjs';
import { createConsole } from '../../backend/console.mjs';
import { hashPassword } from '../../backend/sessions.mjs';
import { fixtureExecutable, telemetry, listen, draft, waitFor } from './helpers.mjs';

const shared = process.argv.includes('--shared-preview');
const directory = await mkdtemp(join(tmpdir(), 'gpu-monitor-browser-test-'));
const models = join(directory, 'models'); const apps = []; let closing;
async function shutdown() {
  return closing ||= (async () => { for (const app of [...apps].reverse()) await app.close(); await rm(directory, { recursive: true, force: true }); })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown().catch(() => { process.exitCode = 1; }));
try {
  await mkdir(join(models, 'Qwen'), { recursive: true }); await writeFile(join(models, 'Qwen/config.json'), '{}');
  if (shared || process.argv.includes('--folder-preview')) {
    for (const name of ['Model-A', 'Model-B']) { await mkdir(join(models, 'Group', name), { recursive: true }); await writeFile(join(models, 'Group', name, 'config.json'), '{}'); }
    await mkdir(join(models, 'Empty'));
  }
  const nodes = [];
  for (const id of shared ? ['node-a', 'node-b'] : ['integration-test-node']) {
    const token = `browser-fixture-agent-${id}-token`;
    const agent = await createAgent({ id, name: shared ? `测试机器 ${id}（模拟 GPU）` : '测试机器（模拟 GPU）', modelRoot: models, modelBrowseRoot: directory, defaultModelRoot: models, stateDir: join(directory, id), token, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 100, coordinatedWrites: shared, ...(shared ? { localInference: { enabled: true, apiKeys: [`browser-inference-${id}-key`] } } : {}) }, { readGpuStatus: telemetry });
    apps.push(agent);
    if (process.argv.includes('--slow-preview')) {
      const browse = agent.manager.browse.bind(agent.manager); const logs = agent.manager.logs.bind(agent.manager);
      const delay = () => new Promise(r => setTimeout(r, 2000));
      agent.manager.browse = async path => { const result = await browse(path); await delay(); return result; };
      agent.manager.logs = async id => { const result = await logs(id); await delay(); return result; };
    }
    if (agent.localInference) await listen(agent.localInference.server);
    nodes.push({ id, name: agent.manager.config.name, url: await listen(agent.server), token });
  }
  const adminToken = 'browser-fixture-admin-token';
  const controller = await createController({ stateDir: join(directory, 'control'), adminToken, apiKeys: ['browser-fixture-inference-token'], publicUrl: 'http://127.0.0.1:5191', nodes, multiUser: shared, inferenceEnabled: !shared });
  apps.push(controller); const controllerUrl = await listen(controller.server);
  if (shared) {
    for (const node of nodes) {
      const dep = await controller.manager.create(draft(models, { nodeId: node.id, alias: `shared-${node.id}`, gpuIds: [1], requestId: `seed-${node.id}` }));
      await controller.manager.action(dep.id, 'stop', { requestId: `stop-seed-${node.id}`, expectedRevision: 1 });
    }
  } else if (process.argv.includes('--delete-preview')) {
    const stopped = await controller.manager.create(draft(models, { nodeId: nodes[0].id, alias: 'delete-preview-stopped', gpuIds: [0] }));
    await controller.manager.action(stopped.id, 'stop');
    const running = await controller.manager.create(draft(models, { nodeId: nodes[0].id, alias: 'delete-preview-running', gpuIds: [1] }));
    await waitFor(async () => (await controller.manager.state()).services.find(item => item.id === running.id)?.status === 'running');
  }
  let passwordHash;
  if (shared) {
    const password = randomBytes(24).toString('base64url'); passwordHash = await hashPassword(password);
    const file = join(directory, 'web-password.txt'); await writeFile(file, password + '\n', { mode: 0o600 }); console.log(`Credential file: ${file}`);
  }
  const ui = await createConsole({ settingsFile: join(directory, 'console.json'), controllerUrl, adminToken, ...(shared ? { mode: 'shared', host: '127.0.0.1', publicOrigins: ['http://127.0.0.1:5190'], passwordHash } : {}) });
  apps.push(ui);
  await new Promise((done, reject) => { ui.server.once('error', reject); ui.server.listen(5190, '127.0.0.1', done); });
  console.log(`Browser integration fixture · http://127.0.0.1:5190 · ${models}`);
} catch (cause) { console.error(cause.message); await shutdown(); process.exitCode = 1; }
