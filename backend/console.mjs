import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { ApiError, readJson, writeJson, serialQueue, httpUrl, bodyJson, json, fail, remoteJson } from './common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Set(['/index.html', '/favicon.svg', '/src/app.mjs', '/src/app-state.mjs', '/src/model-browser.mjs', '/src/command.mjs', '/src/styles.css', '/src/api.mjs']);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };

export async function createConsole(config) {
  const settingsFile = resolve(config.settingsFile);
  let settings = await readJson(settingsFile, { controllerUrl: config.controllerUrl || '', adminToken: config.adminToken || '' });
  const queue = serialQueue();
  const safeSettings = () => ({ controllerUrl: settings.controllerUrl, configured: !!settings.adminToken });
  const server = createServer(async (request, response) => {
    try {
      const port = server.address().port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) throw new ApiError(403, '本地服务拒绝该 Host');
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path.startsWith('/api/')) {
        const expectedOrigin = `http://${request.headers.host}`;
        if (request.headers['x-gpu-console'] !== '1' || (request.headers.origin && request.headers.origin !== expectedOrigin) || (request.method !== 'GET' && request.headers.origin !== expectedOrigin)) throw new ApiError(403, '只允许本地控制台发起请求');
        if (path === '/api/local/settings' && request.method === 'GET') { json(response, safeSettings()); return; }
        if (path === '/api/local/settings' && request.method === 'PUT') {
          const input = await bodyJson(request);
          const result = await queue(async () => {
            const controllerUrl = httpUrl(input.controllerUrl);
            const adminToken = input.adminToken || settings.adminToken;
            if (typeof adminToken !== 'string' || adminToken.length < 16) throw new ApiError(400, '请输入控制节点管理密钥（至少 16 位）');
            await remoteJson(controllerUrl + '/api/state', adminToken, { timeout: 25000 });
            const next = { controllerUrl, adminToken }; await writeJson(settingsFile, next); settings = next;
            return safeSettings();
          });
          json(response, result); return;
        }
        if (path.startsWith('/api/control/')) {
          if (!settings.controllerUrl || !settings.adminToken) throw new ApiError(503, '请先在连接设置中配置共享控制节点');
          const remotePath = '/api/' + path.slice('/api/control/'.length);
          if (!/^\/api\/(state|nodes(?:\/[a-zA-Z0-9_-]{1,80}\/(?:connect|model-root|directories))?|deployments(?:\/[a-zA-Z0-9_-]{1,80}(?:\/(?:start|stop|logs))?)?)$/.test(remotePath)) throw new ApiError(404, '接口不存在');
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) throw new ApiError(405, '请求方法不支持');
          if (request.method === 'DELETE' && !/^\/api\/deployments\/[a-zA-Z0-9_-]{1,80}$/.test(remotePath)) throw new ApiError(405, '只允许删除部署记录');
          const body = request.method === 'GET' ? undefined : await bodyJson(request);
          const result = await remoteJson(httpUrl(settings.controllerUrl) + remotePath, settings.adminToken, { method: request.method, body, timeout: 60000 });
          json(response, result, request.method === 'POST' && remotePath === '/api/deployments' ? 201 : 200); return;
        }
        throw new ApiError(404, '接口不存在');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, '请求方法不支持');
      const asset = path === '/' ? '/index.html' : path;
      if (!assets.has(asset)) throw new ApiError(404, '文件不存在');
      const content = await readFile(resolve(root, '.' + asset));
      response.writeHead(200, { 'Content-Type': `${types[extname(asset)]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (cause) { fail(response, cause); }
  });
  let closed;
  return { server, close: () => closed ||= (async () => { server.closeAllConnections(); if (server.listening) await new Promise((r) => server.close(r)); })() };
}
