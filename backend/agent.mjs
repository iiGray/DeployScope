import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, stat, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, serialQueue, readJson, writeJson, instanceLock, birthTime, bootId, pidAlive, requireToken, bodyJson, json, fail, relay } from './common.mjs';
import { readGpuStatus, validateDeployment, vllmLaunch } from './gpu.mjs';
import { checkedRoot, checkedModel, checkedDirectory, listDirectories, scanModels } from './models.mjs';

const occupiedStatuses = new Set(['starting', 'running', 'stopping', 'orphaned']);
const validId = (id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const publicDeployment = (record) => {
  const { apiKey, birth, bootId, port, ...publicRecord } = record;
  return structuredClone(publicRecord);
};
const groupAlive = (pid) => { if (!Number.isInteger(pid) || pid < 2) return false; try { process.kill(-pid, 0); return true; } catch (cause) { return cause.code === 'EPERM'; } };
async function freePort() { const server = netServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }

class AgentManager {
  constructor(config, dependencies) {
    this.config = config;
    this.readGpuStatus = dependencies.readGpuStatus || readGpuStatus;
    this.queue = serialQueue(); this.owned = new Map(); this.closed = false;
    this.directory = resolve(config.stateDir); this.file = join(this.directory, 'state.json');
  }
  async initialize() {
    this.releaseLock = await instanceLock(this.directory);
    this.bootId = await bootId();
    this.data = await readJson(this.file, { modelRoot: this.config.modelRoot || '/models', deployments: [] });
    for (const record of this.data.deployments) {
      if (!occupiedStatuses.has(record.status)) continue;
      if (!pidAlive(record.pid) && !groupAlive(record.pid)) { record.status = 'failed'; record.error = 'Agent 恢复时发现推理进程已退出'; }
      else if (!record.birth || record.bootId !== this.bootId || await birthTime(record.pid) !== record.birth) { record.status = 'orphaned'; record.error = '残留进程身份无法确认，请在机器上检查；GPU 保持锁定'; }
    }
    await this.persist();
    this.timer = setInterval(() => { this.queue(() => this.refresh()).catch(() => {}); }, this.config.pollMs || 1500);
    this.timer.unref();
  }
  persist() { return writeJson(this.file, this.data); }
  find(id) { const record = this.data.deployments.find((item) => item.id === id); if (!record) throw new ApiError(404, '部署不存在'); return record; }
  async identity(record) {
    if (!pidAlive(record.pid) || record.bootId !== this.bootId) return false;
    if (record.birth) return await birthTime(record.pid) === record.birth;
    const child = this.owned.get(record.id);
    return !!child && child.pid === record.pid && child.exitCode === null && child.signalCode === null;
  }
  async refresh(records = this.data.deployments) {
    let changed = false;
    for (const record of records) {
      if (!occupiedStatuses.has(record.status) || record.status === 'orphaned') continue;
      if (!pidAlive(record.pid)) {
        record.status = groupAlive(record.pid) ? 'orphaned' : 'failed';
        record.error = record.status === 'orphaned' ? '主进程已退出但进程组仍存在，GPU 保持锁定' : '推理进程已退出，请查看部署日志';
        changed = true; continue;
      }
      if (!await this.identity(record)) { record.status = 'orphaned'; record.error = '进程身份发生变化，GPU 保持锁定'; changed = true; continue; }
      if (record.status === 'starting') {
        try { const response = await fetch(`http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(800) }); if (response.ok) { record.status = 'running'; record.updatedAt = new Date().toISOString(); changed = true; } }
        catch {}
        if (record.status === 'starting' && Date.now() - Date.parse(record.createdAt) > (this.config.startTimeoutMs || 15 * 60 * 1000)) { await this.stopInternal(record); record.status = 'failed'; record.error = '模型启动超时，请检查日志和显存'; changed = true; }
      }
    }
    if (changed) await this.persist();
  }
  async hardware() {
    const result = await this.readGpuStatus();
    return { ...result, gpus: result.gpus.map((gpu) => {
      const owner = this.data.deployments.find((record) => occupiedStatuses.has(record.status) && record.gpuUuids?.includes(gpu.uuid));
      const compute = result.processes.filter((process) => process.uuid === gpu.uuid);
      return { ...gpu, deploymentId: owner?.id || null, externalBusy: !owner && compute.length > 0, processCount: compute.length };
    }) };
  }
  async snapshotInternal() {
    await this.refresh();
    let gpus = []; let gpuError = null; let models = []; let modelError = null;
    try { gpus = (await this.hardware()).gpus; } catch (cause) { gpuError = cause.message; }
    try { models = await scanModels(this.data.modelRoot); } catch (cause) { modelError = cause.message; }
    return { id: this.config.id, name: this.config.name || this.config.id, host: this.config.hostName || this.config.name || this.config.id, status: 'online', heartbeat: '刚刚', driver: gpus[0]?.driver || '—', modelRoot: this.data.modelRoot, defaultModelRoot: this.config.defaultModelRoot || '/data/hf_models', modelBrowseRoot:this.config.modelBrowseRoot || '/data', models, gpus, gpuError, modelError, deployments: this.data.deployments.map(publicDeployment) };
  }
  snapshot() { return this.queue(() => this.snapshotInternal()); }
  status(id) { return this.queue(async () => { const record = this.find(id); await this.refresh([record]); return publicDeployment(record); }); }
  browse(path = this.config.defaultModelRoot || '/data/hf_models') { return listDirectories(this.config.modelBrowseRoot || '/data',path); }
  async rootFor(draft) {
    if (draft.modelRoot === undefined) return this.data.modelRoot;
    draft.modelRoot = await checkedDirectory(this.config.modelBrowseRoot || '/data',draft.modelRoot);
    return draft.modelRoot;
  }
  async validateResources(draft, editingId = null) {
    draft.modelPath = await checkedModel(await this.rootFor(draft), draft.modelPath);
    const { gpus } = await this.hardware();
    for (const id of draft.gpuIds) {
      const gpu = gpus.find((item) => item.id === id);
      if (!gpu) throw new ApiError(400, `GPU ${id} 不存在`);
      if (gpu.externalBusy) throw new ApiError(409, `GPU ${id} 被外部进程占用`);
      if (gpu.deploymentId && gpu.deploymentId !== editingId) throw new ApiError(409, `GPU ${id} 已被其他部署占用`);
    }
    return gpus;
  }
  create(input) {
    return this.queue(async () => {
      if (this.closed) throw new ApiError(503, 'Agent 正在停止');
      await this.refresh();
      const draft = validateDeployment(input);
      const id = input.id || `dep-${randomUUID()}`;
      if (!validId(id)) throw new ApiError(400, '无效部署 ID');
      if (this.data.deletedDeployments?.some(record => record.id === id)) throw new ApiError(409, '该部署已删除，请新建部署');
      const existing = this.data.deployments.find((record) => record.id === id);
      if (existing) {
        if (Object.keys(draft).every((key) => JSON.stringify(draft[key]) === JSON.stringify(existing[key]))) return publicDeployment(existing);
        throw new ApiError(409, '部署 ID 已存在且配置不同');
      }
      if (this.data.deployments.some((record) => record.alias === draft.alias)) throw new ApiError(409, '服务别名已存在');
      const gpus = await this.validateResources(draft);
      const record = { ...draft, id, nodeId: this.config.id, status: 'starting', gpuUuids: draft.gpuIds.map((id) => gpus.find((gpu) => gpu.id === id).uuid), apiKey: randomBytes(24).toString('hex'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.data.deployments.push(record);
      await this.persist();
      await this.launch(record, gpus);
      return publicDeployment(record);
    });
  }
  async launch(record, gpus) {
    record.port = await freePort(); record.status = 'starting'; record.error = null; record.createdAt = new Date().toISOString(); record.updatedAt = record.createdAt;
    record.gpuUuids = record.gpuIds.map((id) => gpus.find((gpu) => gpu.id === id).uuid);
    record.pid = null; record.birth = null; record.bootId = this.bootId;
    await this.persist();
    const { args, env } = vllmLaunch(record, gpus, record.port, record.apiKey);
    const child = spawn(this.config.vllmExecutable || 'vllm', [...(this.config.vllmPrefixArgs || []), ...args], { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const logFile = join(this.directory, `${record.id}.log`);
    const stream = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    let written = 0; let truncated = false;
    stream.on('error', () => { child.stdout?.resume(); child.stderr?.resume(); });
    const capture = (input) => input.on('data', (chunk) => {
      const text = chunk.toString().replaceAll(record.apiKey, '[REDACTED]');
      written += Buffer.byteLength(text);
      if (written > 20 * 1024 * 1024) { if (!truncated) { stream.write('\n[日志达到 20 MiB 捕获上限]\n'); truncated = true; } return; }
      if (!stream.write(text)) { input.pause(); stream.once('drain', () => input.resume()); }
    });
    capture(child.stdout); capture(child.stderr);
    child.once('close', () => { stream.end(); if (this.owned.get(record.id) === child) this.owned.delete(record.id); this.queue(() => this.refresh()).catch(() => {}); });
    try {
      await once(child, 'spawn');
      record.pid = child.pid; record.birth = await birthTime(child.pid);
      this.owned.set(record.id, child);
      await this.persist();
    } catch {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      record.status = 'failed'; record.pid = null; record.birth = null; record.error = '无法启动 vLLM，请检查可执行文件路径和运行环境';
      stream.write(record.error + '\n'); stream.end();
      await this.persist();
    }
  }
  async stopInternal(record) {
    if (!record.pid || (!pidAlive(record.pid) && !groupAlive(record.pid))) { record.status = 'stopped'; record.pid = null; record.birth = null; await this.persist(); return; }
    if (!await this.identity(record)) { record.status = 'orphaned'; await this.persist(); throw new ApiError(409, '无法确认残留进程身份，拒绝停止；请在机器上检查'); }
    record.status = 'stopping'; await this.persist();
    try { process.kill(-record.pid, 'SIGTERM'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    const deadline = Date.now() + (this.config.stopTimeoutMs || 5000);
    while (groupAlive(record.pid) && Date.now() < deadline) await delay(30);
    if (groupAlive(record.pid)) {
      if (!await this.identity(record)) { record.status = 'orphaned'; await this.persist(); throw new ApiError(409, '进程身份已无法确认，拒绝强制停止；GPU 保持占用'); }
      try { process.kill(-record.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    }
    const killed = Date.now() + 2000;
    while (groupAlive(record.pid) && Date.now() < killed) await delay(30);
    if (groupAlive(record.pid)) { record.status = 'orphaned'; await this.persist(); throw new ApiError(409, '进程组尚未退出，GPU 保持占用'); }
    this.owned.delete(record.id); record.pid = null; record.birth = null; record.status = 'stopped'; record.error = null; record.updatedAt = new Date().toISOString();
    await this.persist();
  }
  stop(id) { return this.queue(async () => { const record = this.find(id); await this.stopInternal(record); return publicDeployment(record); }); }
  remove(id) {
    return this.queue(async () => {
      if (this.closed) throw new ApiError(503, 'Agent 正在停止');
      const record = this.data.deployments.find(item => item.id === id);
      if (!record) {
        if (this.data.deletedDeployments?.some(item => item.id === id)) return { id, deleted: true };
        throw new ApiError(404, '部署不存在');
      }
      if (record.status !== 'stopped') throw new ApiError(409, '只能删除已停止的部署，请先停止服务');
      if (pidAlive(record.pid) || groupAlive(record.pid) || this.owned.has(id)) throw new ApiError(409, '部署仍有进程，无法删除，请先检查并停止服务');
      const next = structuredClone(this.data);
      next.deployments = next.deployments.filter(item => item.id !== id);
      (next.deletedDeployments ||= []).push({ ...structuredClone(record), deletedAt: new Date().toISOString() });
      await writeJson(this.file, next); this.data = next;
      return { id, deleted: true };
    });
  }
  start(id) { return this.queue(async () => {
    const record = this.find(id);
    if (occupiedStatuses.has(record.status)) throw new ApiError(409, '部署仍在运行或存在未清理进程');
    const hardware = await this.hardware();
    const gpuIds = record.gpuUuids.map((uuid) => hardware.gpus.find((gpu) => gpu.uuid === uuid)?.id);
    if (gpuIds.some((id) => id === undefined)) throw new ApiError(409, '原部署的物理 GPU 不存在，请修改部署重新选择显卡');
    const draft = { ...record, gpuIds }; const gpus = await this.validateResources(draft);
    Object.assign(record, { gpuIds: draft.gpuIds, modelPath: draft.modelPath });
    await this.launch(record, gpus); return publicDeployment(record);
  }); }
  update(id, input) {
    return this.queue(async () => {
      const record = this.find(id); const draft = validateDeployment(input.modelRoot===undefined && record.modelRoot ? {...input,modelRoot:record.modelRoot} : input);
      if (input.operationId && !validId(input.operationId)) throw new ApiError(400, '无效的操作 ID');
      draft.modelPath = await checkedModel(await this.rootFor(draft), draft.modelPath);
      if (input.operationId && record.appliedOperationId === input.operationId) {
        if (!Object.keys(draft).every((key) => JSON.stringify(draft[key]) === JSON.stringify(record[key]))) throw new ApiError(409, '该操作 ID 已用于另一份配置');
        return publicDeployment(record);
      }
      if (this.data.deployments.some((item) => item.id !== id && item.alias === draft.alias)) throw new ApiError(409, '服务别名已存在');
      await this.validateResources(draft, id);
      await this.stopInternal(record);
      const gpus = await this.validateResources(draft);
      Object.assign(record, draft, { gpuUuids: draft.gpuIds.map((id) => gpus.find((gpu) => gpu.id === id).uuid), appliedOperationId: input.operationId || null });
      await this.persist(); await this.launch(record, gpus);
      return publicDeployment(record);
    });
  }
  setRoot(root) { return this.queue(async () => { this.data.modelRoot = await checkedRoot(root); await this.persist(); return this.snapshotInternal(); }); }
  async logs(id) {
    this.find(id);
    try { const file = join(this.directory, `${id}.log`); const size = (await stat(file)).size; const handle = await open(file, 'r'); try { const bytes = Buffer.alloc(Math.min(size, 64 * 1024)); await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); } finally { await handle.close(); } }
    catch (cause) { if (cause.code === 'ENOENT') return ''; throw cause; }
  }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true; clearInterval(this.timer);
    this.shutdownPromise = this.queue(async () => {
      for (const record of this.data.deployments) if (occupiedStatuses.has(record.status) && record.status !== 'orphaned') await this.stopInternal(record).catch(() => {});
      await this.releaseLock();
    });
    return this.shutdownPromise;
  }
}

export async function createAgent(config, dependencies = {}) {
  if (!config.id || !config.token || config.token.length < 16) throw new Error('Agent 需要机器 ID 和至少 16 位的访问密钥');
  const manager = new AgentManager(config, dependencies);
  await manager.initialize();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') { json(response, { service: 'gpu-monitor-agent', ok: true }); return; }
      requireToken(request, config.token);
      if (request.method === 'GET' && url.pathname === '/api/node') { json(response, await manager.snapshot()); return; }
      if (request.method === 'POST' && url.pathname === '/api/directories') { const input = await bodyJson(request); json(response, await manager.browse(input.path)); return; }
      if (request.method === 'PUT' && url.pathname === '/api/model-root') { json(response, await manager.setRoot((await bodyJson(request)).modelRoot)); return; }
      if (request.method === 'POST' && url.pathname === '/api/deployments') { json(response, await manager.create(await bodyJson(request)), 201); return; }
      const match = /^\/api\/deployments\/([a-zA-Z0-9_-]{1,80})(?:\/(start|stop|logs|inference\/(?:chat\/completions|completions)))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (!action && request.method === 'GET') { json(response, await manager.status(id)); return; }
        if (!action && request.method === 'DELETE') { await bodyJson(request); json(response, await manager.remove(id)); return; }
        if (action === 'logs' && request.method === 'GET') { json(response, { logs: await manager.logs(id) }); return; }
        if (action === 'start' && request.method === 'POST') { json(response, await manager.start(id)); return; }
        if (action === 'stop' && request.method === 'POST') { json(response, await manager.stop(id)); return; }
        if (!action && request.method === 'PATCH') { json(response, await manager.update(id, await bodyJson(request))); return; }
        if (action?.startsWith('inference/') && request.method === 'POST') {
          const record = manager.find(id);
          if (record.status !== 'running') throw new ApiError(503, '模型服务尚未就绪');
          const body = await bodyJson(request, 10 * 1024 * 1024);
          await relay(request, response, `http://127.0.0.1:${record.port}/v1/${action.slice('inference/'.length)}`, record.apiKey, { ...body, model: record.alias }, { timeoutMs: config.inferenceTimeoutMs }); return;
        }
      }
      throw new ApiError(404, '接口不存在');
    } catch (cause) { fail(response, cause); }
  });
  let closed;
  return { manager, server, close: () => closed ||= (async () => { server.closeAllConnections(); if (server.listening) await new Promise((resolve) => server.close(resolve)); await manager.shutdown(); })() };
}
