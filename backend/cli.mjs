import { resolve } from 'node:path';
import { initializeConfig } from './config.mjs';
import { createAgent } from './agent.mjs';
import { createController } from './controller.mjs';
import { createConsole } from './console.mjs';
import { readJson } from './common.mjs';

const role = process.argv[2] || 'dev';
const configArg = process.argv.indexOf('--config');
const file = resolve(configArg === -1 ? process.env.GPU_MONITOR_CONFIG || '.gpu-monitor/config.json' : process.argv[configArg + 1]);
const apps = [];
let closing = false;
async function shutdown() { if (closing) return; closing = true; for (const app of apps.reverse()) await app.close(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown().catch((cause) => { console.error(cause.message); process.exitCode = 1; }));
async function start(app, config, name, host = config.host || '127.0.0.1') {
  apps.push(app);
  await new Promise((done, reject) => { app.server.once('error', reject); app.server.listen(config.port, host, done); });
  console.log(`${name} · http://${host}:${config.port}`);
}
try {
  if (!['init', 'dev', 'agent', 'controller', 'console'].includes(role)) throw new Error('用法：node backend/cli.mjs init|dev|agent|controller|console [--config 配置路径]');
  const config = ['init', 'dev'].includes(role) ? await initializeConfig(file) : await readJson(file, null);
  if (!config) throw new Error('配置不存在，请先运行 npm run init');
  if (role === 'init') console.log(`私有配置已准备：${file}（不会覆盖已有配置）`);
  else {
    if (['dev', 'agent'].includes(role)) await start(await createAgent(config.agent), config.agent, 'Agent');
    if (['dev', 'controller'].includes(role)) await start(await createController(config.controller), config.controller, '统一 API / 控制节点');
    if (['dev', 'console'].includes(role)) {
      const ui = { ...config.console, port: Number(process.env.GPU_MONITOR_PORT || config.console.port || 5173) };
      await start(await createConsole(ui), ui, 'GPU Monitor', '127.0.0.1');
    }
  }
} catch (cause) { console.error(cause.message); await shutdown(); process.exitCode = 1; }
