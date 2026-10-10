import { createServer } from 'node:http';
import { ApiError, requireToken, bodyJson, json, fail, relay } from './common.mjs';

export function validateLocalInference({ port = 18080, apiKeys } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本机推理端口无效');
  if (!Array.isArray(apiKeys) || !apiKeys.length || apiKeys.some(key => typeof key !== 'string' || key.length < 16)) throw new Error('本机推理需要至少 16 位的独立密钥');
}

export function createLocalInference(manager, config) {
  validateLocalInference(config);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/health' && request.method === 'GET') { json(response, { service: 'deployscope-local-inference', scope: 'server-local', nodeId: manager.config.id, ok: true }); return; }
      requireToken(request, config.apiKeys);
      if (path === '/v1/models' && request.method === 'GET') { json(response, { object: 'list', data: await manager.localModels() }); return; }
      if (['/v1/chat/completions', '/v1/completions'].includes(path) && request.method === 'POST') {
        const body = await bodyJson(request, 10 * 1024 * 1024);
        const target = await manager.localTarget(body.model);
        await relay(request, response, target.url + path, target.apiKey, { ...body, model: target.alias }, { timeoutMs: config.inferenceTimeoutMs }); return;
      }
      throw new ApiError(404, '本机推理接口不存在');
    } catch (cause) { fail(response, cause); }
  });
  let closed;
  return { server, close: () => closed ||= (async () => { server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r)); })() };
}
