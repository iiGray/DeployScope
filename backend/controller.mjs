import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, serialQueue, readJson, writeJson, instanceLock, requireToken, bodyJson, json, fail, httpUrl, remoteJson, relay } from './common.mjs';
import { validateDeployment } from './gpu.mjs';

const sameDraft = (a, b) => ['alias', 'modelPath', 'modelRoot', 'gpuIds', 'maxModelLen', 'gpuMemoryUtilization', 'dtype'].every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
const publicNode = ({ token, ...node }) => node;

class ControllerManager {
  constructor(config) { this.config = config; this.queue = serialQueue(); this.readyCache = new Map(); this.file = join(resolve(config.stateDir), 'state.json'); }
  async initialize() {
    this.releaseLock = await instanceLock(resolve(this.config.stateDir));
    this.data = await readJson(this.file, { nodes: (this.config.nodes || []).map((node) => ({ ...node, url: httpUrl(node.url) })), services: [] });
    await this.persist();
  }
  persist() { return writeJson(this.file, this.data); }
  async archiveRemoved(records) {
    const next = structuredClone(this.data); const ids = new Set(records.map(record => record.id));
    const archive = next.deletedServices ||= [];
    for (const record of records) {
      if (archive.some(item => item.id === record.id)) continue;
      const { deletePending, ...saved } = record;
      archive.push({ ...structuredClone(saved), deletedAt: new Date().toISOString() });
    }
    next.services = next.services.filter(record => !ids.has(record.id));
    await writeJson(this.file, next); this.data = next;
    for (const id of ids) this.readyCache.delete(id);
  }
  node(id) { const node = this.data.nodes.find((n) => n.id === id); if (!node) throw new ApiError(404, '机器未注册'); return node; }
  service(id) { const service = this.data.services.find((s) => s.id === id); if (!service) throw new ApiError(404, '部署不存在'); return service; }
  aliasAvailable(alias, exceptId) {
    if (this.data.services.some((s) => s.id !== exceptId && (s.alias === alias || s.pending?.alias === alias))) throw new ApiError(409, '服务别名已存在，请使用其他别名');
  }
  call(node, path, method = 'GET', body, timeout = 30000) { return remoteJson(node.url + path, node.token, { method, body, timeout }); }
  async stateInternal() {
    const nodes = await Promise.all(this.data.nodes.map(async (node) => {
      try { const snapshot = await this.call(node, '/api/node', 'GET', undefined, 6500); if (snapshot.id !== node.id) throw new ApiError(502, '机器 ID 与注册信息不一致'); return { ...snapshot, name: node.name || snapshot.name, agentUrl: node.url }; }
      catch (cause) { return { ...publicNode(node), agentUrl: node.url, host: new URL(node.url).host, status: 'offline', gpus: [], models: [], deployments: [], error: cause.message, modelRoot: '', heartbeat: '离线' }; }
    }));
    let changed = false; const removed = [];
    const services = this.data.services.map((record) => {
      const node = nodes.find((n) => n.id === record.nodeId);
      const remote = node?.deployments.find((d) => d.id === record.id);
      if (record.deletePending) {
        if (node?.status === 'online' && !remote) { removed.push(record); return null; }
        if (remote?.status === 'stopped') return { ...remote, nodeId: record.nodeId, deletePending: true, error: '删除结果尚未确认，请重试删除' };
        const { pending, pendingOperationId, ...safe } = record;
        return { ...safe, status: 'unknown', error: '删除结果尚未确认，请恢复机器连接后核对' };
      }
      if (remote && (!record.pending || (record.pendingOperationId && remote.appliedOperationId === record.pendingOperationId) || sameDraft(record.pending, remote))) {
        if (record.pending || !sameDraft(record, remote) || record.status !== remote.status) {
          Object.assign(record, remote); delete record.pending; delete record.pendingOperationId; changed = true;
        }
        return { ...remote, nodeId: record.nodeId };
      }
      const { pending, pendingOperationId, ...safe } = record;
      return { ...safe, ...(pending || {}), status: 'unknown', error: node?.status === 'offline' ? '机器离线，无法确认部署状态' : '操作结果尚未确认，请检查日志或重试' };
    }).filter(Boolean);
    if (removed.length) await this.archiveRemoved(removed);
    else if (changed) await this.persist();
    return { nodes: nodes.map(({ deployments, ...node }) => node), services, inferenceMode: this.config.inferenceEnabled === false ? 'per-node' : 'controller', apiBase: this.config.inferenceEnabled === false ? null : `${httpUrl(this.config.publicUrl)}/v1` };
  }
  state() { return this.queue(() => this.stateInternal()); }
  register(input) {
    return this.queue(async () => {
      const url = httpUrl(input.url);
      if (typeof input.token !== 'string' || input.token.length < 16) throw new ApiError(400, 'Agent 密钥至少需要 16 位');
      const snapshot = await remoteJson(url + '/api/node', input.token);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(snapshot.id)) throw new ApiError(400, 'Agent 返回了无效的机器 ID');
      const existing = this.data.nodes.find((n) => n.id === snapshot.id);
      if (existing && existing.url !== url && this.data.services.some((s) => s.nodeId === existing.id)) throw new ApiError(409, '机器已有部署，不能更换 Agent 地址');
      for (const dep of snapshot.deployments) this.aliasAvailable(dep.alias, dep.id);
      const node = { id: snapshot.id, name: String(input.name || snapshot.name || snapshot.id).slice(0, 80), url, token: input.token };
      if (existing) Object.assign(existing, node); else this.data.nodes.push(node);
      for (const dep of snapshot.deployments) if (!this.data.services.some((s) => s.id === dep.id)) this.data.services.push({ ...dep, nodeId: node.id });
      await this.persist(); return publicNode(node);
    });
  }
  connect(id) { return this.queue(async () => { const node = this.node(id); const snapshot = await this.call(node, '/api/node'); if (snapshot.id !== id) throw new ApiError(502, '机器身份不一致'); return { ...snapshot, name: node.name }; }); }
  setRoot(id, root) { return this.queue(() => this.call(this.node(id), '/api/model-root', 'PUT', { modelRoot: root })); }
  browse(id,path) { return this.call(this.node(id),'/api/directories','POST',path===undefined ? {} : {path}); }
  create(input) {
    return this.queue(async () => {
      const draft = validateDeployment(input); const node = this.node(input.nodeId);
      this.aliasAvailable(draft.alias);
      const record = { ...draft, id: `dep-${randomUUID()}`, nodeId: node.id, status: 'unknown', createdAt: new Date().toISOString() };
      this.data.services.push(record); await this.persist();
      try { Object.assign(record, await this.call(node, '/api/deployments', 'POST', record)); await this.persist(); return structuredClone(record); }
      catch (cause) {
        if (cause.status >= 400 && cause.status < 500) { this.data.services = this.data.services.filter((s) => s.id !== record.id); await this.persist(); }
        throw cause;
      }
    });
  }
  update(id, input) {
    return this.queue(async () => {
      let record = this.service(id);
      if (record.deletePending) throw new ApiError(409, '删除结果尚未确认，不能修改部署，请先完成删除确认');
      this.readyCache.delete(id);
      if (input.nodeId !== record.nodeId) throw new ApiError(400, '暂不支持跨机器修改，请停止旧部署并在目标机器新建');
      if (record.pending) { await this.stateInternal(); record = this.service(id); }
      const inheritedRoot=record.pending?.modelRoot ?? record.modelRoot;
      const draft = validateDeployment(input.modelRoot===undefined && inheritedRoot!==undefined ? {...input,modelRoot:inheritedRoot} : input);
      if (record.pending && !sameDraft(record.pending, draft)) throw new ApiError(409, '上一次修改结果尚未确认，请恢复连接或重试相同配置，不能提交另一份配置');
      this.aliasAvailable(draft.alias, id);
      const previous = record.pending; record.pending = draft; record.pendingOperationId ||= `op-${randomUUID()}`; await this.persist();
      try { Object.assign(record, await this.call(this.node(record.nodeId), `/api/deployments/${id}`, 'PATCH', { ...draft, operationId: record.pendingOperationId })); delete record.pending; delete record.pendingOperationId; await this.persist(); return structuredClone(record); }
      catch (cause) { if (cause.status >= 400 && cause.status < 500 && !previous) { delete record.pending; delete record.pendingOperationId; await this.persist(); } throw cause; }
    });
  }
  action(id, action) {
    return this.queue(async () => {
      const record = this.service(id); const node = this.node(record.nodeId);
      if (record.deletePending) throw new ApiError(409, '删除结果尚未确认，不能改变部署状态，请先完成删除确认');
      this.readyCache.delete(id);
      if (action === 'start' && record.pending) throw new ApiError(409, '上一次修改尚未确认，请先重试修改或恢复连接');
      let result;
      try { result = await this.call(node, `/api/deployments/${id}/${action}`, 'POST', {}); }
      catch (cause) {
        // An interrupted create may not have reached the Agent. Reuse its reserved identity.
        if (action !== 'start' || cause.status !== 404 || record.pending) throw cause;
        result = await this.call(node, '/api/deployments', 'POST', record);
      }
      Object.assign(record, result);
      if (record.pending && (sameDraft(record.pending, result) || result.appliedOperationId === record.pendingOperationId)) { delete record.pending; delete record.pendingOperationId; }
      await this.persist(); return structuredClone(record);
    });
  }
  logs(id) { const record = this.service(id); return this.call(this.node(record.nodeId), `/api/deployments/${id}/logs`); }
  remove(id) {
    return this.queue(async () => {
      let record = this.data.services.find(item => item.id === id);
      if (!record) {
        if (this.data.deletedServices?.some(item => item.id === id)) return { id, deleted: true };
        throw new ApiError(404, '部署不存在');
      }
      if (record.pending) throw new ApiError(409, '修改结果尚未确认，不能删除部署');
      if (record.status !== 'stopped' && !record.deletePending) throw new ApiError(409, '只能删除已停止的部署，请先停止服务');
      const previouslyPending = !!record.deletePending;
      const marked = structuredClone(this.data); marked.services.find(item => item.id === id).deletePending = true;
      await writeJson(this.file, marked); this.data = marked; record = this.service(id);
      this.readyCache.delete(id);
      try {
        const result = await this.call(this.node(record.nodeId), `/api/deployments/${id}`, 'DELETE', {});
        if (result?.id !== id || result.deleted !== true) throw new ApiError(502, 'Agent 未确认删除结果，请恢复连接后重试');
        await this.archiveRemoved([record]);
        return { id, deleted: true };
      } catch (cause) {
        if (cause.status >= 400 && cause.status < 500 && !previouslyPending) {
          const rollback = structuredClone(this.data); delete rollback.services.find(item => item.id === id).deletePending;
          await writeJson(this.file, rollback); this.data = rollback;
        }
        throw cause;
      }
    });
  }
  async inference(model) {
    if (typeof model !== 'string') throw new ApiError(400, 'model 必须为已部署的服务别名');
    const record = this.data.services.find((s) => s.alias === model || s.pending?.alias === model);
    if (!record) throw new ApiError(404, '模型别名不存在');
    if (record.pending || record.deletePending) throw new ApiError(503, '部署修改或删除结果尚未确认');
    const node = this.node(record.nodeId);
    let cached = this.readyCache.get(record.id);
    if (!cached || cached.expires < Date.now()) {
      cached = { expires: Date.now() + 500, promise: this.call(node, `/api/deployments/${record.id}`, 'GET', undefined, 8000) };
      this.readyCache.set(record.id, cached);
      cached.promise.catch(() => { if (this.readyCache.get(record.id) === cached) this.readyCache.delete(record.id); });
    }
    const actual = await cached.promise;
    const latest = this.data.services.find(service => service.id === record.id);
    if (!latest || latest.pending || latest.deletePending) throw new ApiError(503, '部署修改或删除结果尚未确认');
    if (actual.status !== 'running' || actual.alias !== model || latest.alias !== model) throw new ApiError(503, actual.error || '模型服务尚未就绪');
    return { record: actual, node };
  }
}

export async function createController(config) {
  if (typeof config.adminToken !== 'string' || config.adminToken.length < 16 || !Array.isArray(config.apiKeys) || !config.apiKeys.length || config.apiKeys.some((k) => typeof k !== 'string' || k.length < 16)) throw new Error('控制节点需要至少 16 位的管理密钥和推理密钥');
  httpUrl(config.publicUrl);
  const manager = new ControllerManager(config); await manager.initialize();
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/health' && request.method === 'GET') { json(response, { service: 'gpu-monitor-controller', ok: true }); return; }
      if (path.startsWith('/v1/')) {
        if (config.inferenceEnabled === false) throw new ApiError(404, '控制节点不提供跨机推理');
        requireToken(request, config.apiKeys);
        if (path === '/v1/models' && request.method === 'GET') { const state = await manager.state(); json(response, { object: 'list', data: state.services.filter((s) => s.status === 'running').map((s) => ({ id: s.alias, object: 'model', created: Math.floor(Date.parse(s.createdAt) / 1000) || 0, owned_by: 'gpu-monitor' })) }); return; }
        if (['/v1/chat/completions', '/v1/completions'].includes(path) && request.method === 'POST') {
          const body = await bodyJson(request, 10 * 1024 * 1024); const { record, node } = await manager.inference(body.model);
          await relay(request, response, `${node.url}/api/deployments/${record.id}/inference/${path.slice(4)}`, node.token, body, { timeoutMs: config.inferenceTimeoutMs }); return;
        }
        throw new ApiError(404, '推理接口不存在');
      }
      requireToken(request, config.adminToken);
      if (path === '/api/state' && request.method === 'GET') { json(response, await manager.state()); return; }
      if (path === '/api/nodes' && request.method === 'POST') { json(response, await manager.register(await bodyJson(request))); return; }
      const nodeMatch = /^\/api\/nodes\/([a-zA-Z0-9_-]{1,80})\/(connect|model-root|directories)$/.exec(path);
      if (nodeMatch?.[2] === 'connect' && request.method === 'POST') { json(response, await manager.connect(nodeMatch[1])); return; }
      if (nodeMatch?.[2] === 'model-root' && request.method === 'PUT') { json(response, await manager.setRoot(nodeMatch[1], (await bodyJson(request)).modelRoot)); return; }
      if (nodeMatch?.[2] === 'directories' && request.method === 'POST') { json(response, await manager.browse(nodeMatch[1], (await bodyJson(request)).path)); return; }
      if (path === '/api/deployments' && request.method === 'POST') { json(response, await manager.create(await bodyJson(request)), 201); return; }
      const depMatch = /^\/api\/deployments\/([a-zA-Z0-9_-]{1,80})(?:\/(start|stop|logs))?$/.exec(path);
      if (depMatch && !depMatch[2] && request.method === 'PATCH') { json(response, await manager.update(depMatch[1], await bodyJson(request))); return; }
      if (depMatch && !depMatch[2] && request.method === 'DELETE') { await bodyJson(request); json(response, await manager.remove(depMatch[1])); return; }
      if (depMatch && ['start', 'stop'].includes(depMatch[2]) && request.method === 'POST') { json(response, await manager.action(depMatch[1], depMatch[2])); return; }
      if (depMatch?.[2] === 'logs' && request.method === 'GET') { json(response, await manager.logs(depMatch[1])); return; }
      throw new ApiError(404, '接口不存在');
    } catch (cause) { fail(response, cause); }
  });
  let closed;
  return { manager, server, close: () => closed ||= (async () => { server.closeAllConnections(); if (server.listening) await new Promise((r) => server.close(r)); await manager.releaseLock(); })() };
}
