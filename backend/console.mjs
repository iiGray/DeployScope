import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { ApiError, readJson, writeJson, serialQueue, httpUrl, bodyJson, json, fail, remoteJson } from './common.mjs';
import { createSessions } from './sessions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Set(['/index.html', '/favicon.svg', '/src/app.mjs', '/src/app-state.mjs', '/src/model-browser.mjs', '/src/command.mjs', '/src/styles.css', '/src/api.mjs']);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };

export async function createConsole(config) {
  const shared = config.mode === 'shared';
  let origins = [];
  if (shared) {
    if (!Array.isArray(config.publicOrigins) || !config.publicOrigins.length) throw new Error('共享网页需要明确的 publicOrigins');
    origins = config.publicOrigins.map(value => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('共享网页 Origin 配置无效');
      if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && config.trustedNetwork !== true) throw new Error('非回环网页需要可信管理网络或 HTTPS');
      return url.origin;
    });
    if (new Set(origins.map(origin => new URL(origin).protocol)).size > 1) throw new Error('共享网页 Origin 不允许混用 HTTP 和 HTTPS');
    httpUrl(config.controllerUrl);
    if (typeof config.adminToken !== 'string' || config.adminToken.length < 16) throw new Error('共享网页需要固定的服务端管理密钥');
  }
  const sessions = shared ? createSessions({ passwordHash: config.passwordHash, secureCookies: origins.every(origin => origin.startsWith('https:')) }) : null;
  const settingsFile = resolve(config.settingsFile || '.gpu-monitor/console.json');
  let settings = shared ? { controllerUrl: config.controllerUrl, adminToken: config.adminToken } : await readJson(settingsFile, { controllerUrl: config.controllerUrl || '', adminToken: config.adminToken || '' });
  const queue = serialQueue();
  const safeSettings = () => ({ mode: shared ? 'shared' : 'local', controllerUrl: settings.controllerUrl, configured: !!settings.adminToken });
  const readBody = (request, limit) => bodyJson(request, limit, { timeoutMs: shared ? 15000 : undefined });
  const server = createServer(async (request, response) => {
    try {
      const port = server.address().port;
      const hosts = shared ? origins.map(origin => new URL(origin).host) : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host)) throw new ApiError(403, '控制台拒绝该 Host');
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path.startsWith('/api/')) {
        const expectedOrigin = `http://${request.headers.host}`;
        const validOrigin = shared ? origins.includes(request.headers.origin) && new URL(request.headers.origin).host === request.headers.host : request.headers.origin === expectedOrigin;
        if (request.headers['x-gpu-console'] !== '1' || (request.headers.origin && !validOrigin) || (request.method !== 'GET' && !validOrigin)) throw new ApiError(403, '只允许同源控制台发起请求');
        if (path === '/api/session' && request.method === 'GET') {
          let authenticated = !shared;
          if (shared) { try { sessions.require(request); authenticated = true; } catch {} }
          json(response, { mode: shared ? 'shared' : 'local', authenticated, configured: !!settings.adminToken }); return;
        }
        if (shared && path === '/api/session/login' && request.method === 'POST') { const { password } = await readBody(request, 4096); json(response, await sessions.login(request, response, password)); return; }
        if (shared) sessions.require(request);
        if (shared && path === '/api/session/logout' && request.method === 'POST') { await readBody(request, 4096); sessions.logout(request, response); json(response, { authenticated: false }); return; }
        if (path === '/api/local/settings' && request.method === 'GET') { json(response, safeSettings()); return; }
        if (path === '/api/local/settings' && request.method === 'PUT') {
          if (shared) throw new ApiError(405, '共享连接由服务器配置，不允许浏览器修改');
          const input = await readBody(request);
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
          const body = request.method === 'GET' ? undefined : await readBody(request);
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
    } catch (cause) { if ([408, 413].includes(cause.status)) { response.setHeader('Connection', 'close'); request.resume(); } fail(response, cause); }
  });
  let closed;
  return { server, close: () => closed ||= (async () => { sessions?.close(); server.closeAllConnections(); if (server.listening) await new Promise((r) => server.close(r)); })() };
}
