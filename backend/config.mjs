import { resolve, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { open, mkdir } from 'node:fs/promises';
import { readJson } from './common.mjs';

export async function initializeConfig(file) {
  file = resolve(file);
  const existing = await readJson(file, null); if (existing) return existing;
  const base = dirname(file); const secret = () => randomBytes(32).toString('hex');
  const id = hostname().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'local-node';
  const token = secret(); const adminToken = secret();
  const config = {
    agent: { id, name: hostname(), host: '127.0.0.1', port: 9000, token, modelRoot: '/models', stateDir: join(base, 'agent'), vllmExecutable: 'vllm' },
    controller: { host: '127.0.0.1', port: 8080, publicUrl: 'http://127.0.0.1:8080', stateDir: join(base, 'controller'), adminToken, apiKeys: [secret()], nodes: [{ id, name: hostname(), url: 'http://127.0.0.1:9000', token }] },
    console: { port: 5173, settingsFile: join(base, 'console.json'), controllerUrl: 'http://127.0.0.1:8080', adminToken },
  };
  await mkdir(base, { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify(config, null, 2)); }
  catch (cause) { if (cause.code === 'EEXIST') return readJson(file); throw cause; }
  finally { await handle?.close(); }
  return config;
}
