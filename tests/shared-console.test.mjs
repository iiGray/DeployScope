import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../backend/console.mjs';
import { sharedCluster, TEST_PASSWORD } from './fixtures/shared-cluster.mjs';
import { listen } from './fixtures/helpers.mjs';
import { request as httpRequest, createServer } from 'node:http';
import { bodyJson, json, fail } from '../backend/common.mjs';

test('shared sessions protect all management data, remain independent and cannot reconfigure the proxy', async t => {
  const c = await sharedCluster(t); const [a, b] = c.clients;
  assert.equal((await a.request('/api/session')).status, 200);
  for (const path of ['/api/control/state', '/api/local/settings', '/api/control/deployments/missing/logs']) assert.equal((await a.request(path)).status, 401);
  assert.equal((await a.request('/api/control/nodes/node-a/directories', { method: 'POST', body: {} })).status, 401);
  assert.equal((await a.login()).status, 200); assert.equal((await b.login()).status, 200);
  assert.notEqual(a.cookie, b.cookie);
  const state = await (await a.request('/api/control/state')).json();
  assert.equal(state.nodes.length, 2); assert.equal(state.inferenceMode, 'per-node');
  const serialized = JSON.stringify(state);
  for (const secret of [TEST_PASSWORD, 'private-shared-controller-key', 'private-agent-node-a-secret', 'local-key-node-a-independent']) assert.equal(serialized.includes(secret), false);
  assert.equal((await a.request('/api/local/settings', { method: 'PUT', body: { controllerUrl: 'http://attacker' } })).status, 405);
  const settings = await (await b.request('/api/local/settings')).json();
  assert.equal(settings.mode, 'shared'); assert.equal(settings.controllerUrl, c.consoleConfig.controllerUrl);
  assert.equal((await a.request('/api/session/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await a.request('/api/control/state')).status, 401);
  assert.equal((await b.request('/api/control/state')).status, 200);
  assert.equal((await a.request('/')).status, 200); assert.equal((await a.request('/backend/sessions.mjs')).status, 404);
});

test('shared console validates configured Host and Origin without trusting spoofed forwarding headers', async t => {
  const c = await sharedCluster(t); const [a] = c.clients; await a.login();
  for (const headers of [{ Host: 'evil.test:15173' }, { Origin: 'http://evil.test' }, { Origin: 'null' }, { 'X-GPU-Console': '' }, { Cookie: a.cookie + 'x' }]) {
    assert.equal((await a.request('/api/control/state', { headers })).status, headers.Cookie ? 401 : 403);
  }
  assert.equal((await a.request('/api/session/logout', { method: 'POST', body: {}, headers: { Origin: '' } })).status, 403);
  assert.equal((await a.request('/api/control/state', { headers: { Host: 'evil.test', 'X-Forwarded-Host': 'console.test:15173', 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
  assert.equal((await a.request('/api/session/login', { method: 'POST', body: { password: 'x'.repeat(5000) } })).status, 413);
  await c.ui.close();
  const restarted = await createConsole(c.consoleConfig); c.cleanupWith(restarted.close);
  const url = await listen(restarted.server);
  const oldCookieStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(url + '/api/control/state', { headers: { Host: 'console.test:15173', Origin: c.origin, 'X-GPU-Console': '1', Cookie: a.cookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(oldCookieStatus, 401);
  await assert.rejects(createConsole({ ...c.consoleConfig, trustedNetwork: false, host: '174.1.59.7' }), /可信|HTTPS/);
});

test('JSON reception has a bounded deadline without blocking another request', async t => {
  const server = createServer(async (req, res) => {
    try { const value = await bodyJson(req, 1024, { timeoutMs: 50 }); json(res, value); }
    catch (cause) { res.setHeader('Connection', 'close'); fail(res, cause); }
  });
  const url = await listen(server); t.after(() => { server.closeAllConnections(); server.close(); });
  const slow = new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 100 } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{');
  });
  assert.equal((await fetch(url, { method: 'POST', body: '{"ok":true}' })).status, 200);
  assert.equal(await slow, 408);
  const following = await fetch(url, { method: 'POST', body: '{"ok":true}' });
  assert.deepEqual(await following.json(), { ok: true });
});

test('shared failed logins cannot evade rate limiting with forwarded addresses or oversized JSON', async t => {
  const c = await sharedCluster(t); const [a] = c.clients;
  for (let i = 0; i < 10; i++) assert.equal((await a.request('/api/session/login', { method: 'POST', body: { password: 'wrong-but-long-password' }, headers: { 'X-Forwarded-For': `spoof-${i}` } })).status, 401);
  assert.equal((await a.login()).status, 429);
});
