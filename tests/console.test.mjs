import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createController } from '../backend/controller.mjs';
import { createAgent } from '../backend/agent.mjs';
import { createConsole } from '../backend/console.mjs';
import { initializeConfig } from '../backend/config.mjs';
import { fixtureDirectory, listen, fixtureExecutable, telemetry, draft } from './fixtures/helpers.mjs';

test('local console forwards authenticated state but never serves credentials or backend files', async (t) => {
  const { directory, cleanupWith } = await fixtureDirectory(t);
  const control = await createController({ stateDir: join(directory, 'controller'), adminToken: 'private-admin-secret', apiKeys: ['private-api-key-secret'], publicUrl: 'http://example:8080' });
  cleanupWith(() => control.close()); const controllerUrl = await listen(control.server);
  const settingsFile = join(directory, 'console.json');
  const ui = await createConsole({ settingsFile }); cleanupWith(() => ui.close()); const url = await listen(ui.server);
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
  const restarted = await createConsole({ settingsFile }); cleanupWith(() => restarted.close());
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

test('the page loads versioned styles and script without changing private asset restrictions', async (t) => {
  const { directory, cleanupWith } = await fixtureDirectory(t);
  const ui = await createConsole({ settingsFile: join(directory, 'console.json') });
  cleanupWith(() => ui.close());
  const url = await listen(ui.server);
  const page = await fetch(url + '/?ui=compact-v2');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  const stylesheet = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
  const script = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
  for (const [asset, type] of [[stylesheet, 'text/css'], [script, 'text/javascript']]) {
    assert.ok(asset, 'The browser needs both entry assets');
    const assetUrl = new URL(asset, url);
    assert.ok(assetUrl.searchParams.get('v'), 'Each entry asset needs a version to bypass the old URL');
    const response = await fetch(assetUrl);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(url + '/.gpu-monitor/config.json?v=compact-v2')).status, 404);
});

test('console forwards deployment DELETE only with same-origin protection', async t => {
  const { directory, models, cleanupWith } = await fixtureDirectory(t);
  const token = 'fixture-delete-agent-key'; const adminToken = 'fixture-delete-admin-key';
  const agent = await createAgent({ id: 'delete-proxy-node', modelRoot: models, stateDir: join(directory, 'agent'), token, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable] }, { readGpuStatus: async () => telemetry() });
  cleanupWith(() => agent.close());
  const control = await createController({ stateDir: join(directory, 'controller'), adminToken, apiKeys: ['fixture-delete-api-key'], publicUrl: 'http://control/v1', nodes: [{ id: 'delete-proxy-node', url: await listen(agent.server), token }] });
  cleanupWith(() => control.close());
  const dep = await control.manager.create(draft(models, { nodeId: 'delete-proxy-node' })); await control.manager.action(dep.id, 'stop');
  const ui = await createConsole({ settingsFile: join(directory, 'console.json'), controllerUrl: await listen(control.server), adminToken }); cleanupWith(() => ui.close());
  const url = await listen(ui.server);
  const request = (path, origin = url, marker = '1') => fetch(url + path, { method: 'DELETE', headers: { Origin: origin, 'X-GPU-Console': marker, 'Content-Type': 'application/json' }, body: '{}' });
  const path = `/api/control/deployments/${dep.id}`;
  assert.equal((await request(path, 'http://evil.test')).status, 403);
  assert.equal((await request(path, url, '')).status, 403);
  assert.equal((await request('/api/control/state')).status, 405);
  const response = await request(path); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: dep.id, deleted: true });
  assert.equal((await control.manager.state()).services.length, 0);
});

test('console browses real remote folders through Controller without changing the saved model root', async t => {
  const { directory,models,cleanupWith } = await fixtureDirectory(t);
  const token='directory-agent-secret'; const adminToken='directory-admin-secret';
  const agent=await createAgent({ id:'folder-node',modelRoot:models,modelBrowseRoot:directory,defaultModelRoot:models,stateDir:join(directory,'agent'),token },{readGpuStatus:async()=>telemetry()}); cleanupWith(()=>agent.close());
  const control=await createController({stateDir:join(directory,'controller'),adminToken,apiKeys:['directory-api-secret'],publicUrl:'http://control',nodes:[{id:'folder-node',url:await listen(agent.server),token}]}); cleanupWith(()=>control.close());
  const ui=await createConsole({settingsFile:join(directory,'console.json'),controllerUrl:await listen(control.server),adminToken}); cleanupWith(()=>ui.close()); const url=await listen(ui.server);
  const request=(origin=url,path=models)=>fetch(url+'/api/control/nodes/folder-node/directories',{method:'POST',headers:{Origin:origin,'X-GPU-Console':'1','Content-Type':'application/json'},body:JSON.stringify({path})});
  assert.equal((await request('http://evil.test')).status,403);
  const response=await request(); assert.equal(response.status,200);
  const body=await response.json(); assert.deepEqual(body.children.map(c=>c.name),['Qwen']);
  assert.equal(JSON.stringify(body).includes(token),false);
  assert.equal((await request(url,'/')).status,400);
  assert.equal(agent.manager.data.modelRoot,models);
  assert.equal((await fetch(url+'/src/model-browser.mjs')).status,200);
});
