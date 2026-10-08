import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createController } from '../backend/controller.mjs';
import { createConsole } from '../backend/console.mjs';
import { initializeConfig } from '../backend/config.mjs';
import { fixtureDirectory, listen } from './fixtures/helpers.mjs';

test('local console forwards authenticated state but never serves credentials or backend files', async (t) => {
  const { directory } = await fixtureDirectory(t);
  const control = await createController({ stateDir: join(directory, 'controller'), adminToken: 'private-admin-secret', apiKeys: ['private-api-key-secret'], publicUrl: 'http://example:8080' });
  t.after(() => control.close()); const controllerUrl = await listen(control.server);
  const settingsFile = join(directory, 'console.json');
  const ui = await createConsole({ settingsFile }); t.after(() => ui.close()); const url = await listen(ui.server);
  const request = (path, method = 'GET', body, origin = url, header = '1') => fetch(url + path, { method, headers: { Origin: origin, 'X-GPU-Console': header, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request('/api/control/state')).status, 503);
  assert.equal((await request('/api/local/settings', 'PUT', { controllerUrl, adminToken: 'private-admin-secret' }, 'http://evil.test')).status, 403);
  assert.equal((await request('/api/local/settings', 'PUT', { controllerUrl, adminToken: 'private-admin-secret' })).status, 200);
  const settings = await (await request('/api/local/settings')).json();
  assert.equal(settings.configured, true); assert.equal(JSON.stringify(settings).includes('private-admin-secret'), false);
  const state = await (await request('/api/control/state')).json(); assert.equal(state.apiBase, 'http://example:8080/v1');
  assert.equal((await request('/api/control/state', 'GET', undefined, url, '')).status, 403);
  assert.equal((await fetch(url + '/backend/agent.mjs')).status, 404);
  assert.equal((await fetch(url + '/.gpu-monitor/config.json')).status, 404);
  assert.equal((await fetch(url + '/')).status, 200);
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).adminToken, 'private-admin-secret');
  assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
  await ui.close();
  const restarted = await createConsole({ settingsFile }); t.after(() => restarted.close());
  const restartedUrl = await listen(restarted.server);
  assert.equal((await fetch(restartedUrl + '/api/control/state', { headers: { 'X-GPU-Console': '1' } })).status, 200);
});

test('initialization creates isolated role secrets without overwriting existing configuration', async (t) => {
  const { directory } = await fixtureDirectory(t); const file = join(directory, 'config.json');
  const config = await initializeConfig(file);
  assert.notEqual(config.controller.adminToken, config.agent.token);
  assert.notEqual(config.controller.adminToken, config.controller.apiKeys[0]);
  assert.equal(config.agent.host, '127.0.0.1');
  assert.equal(config.controller.host, '127.0.0.1');
  assert.deepEqual(await initializeConfig(file), config);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
