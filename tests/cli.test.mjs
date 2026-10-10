import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeJson } from '../backend/common.mjs';
import { fixtureDirectory, listen, waitFor } from './fixtures/helpers.mjs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { access, readFile, stat } from 'node:fs/promises';
async function port() { const server = createServer(); const url = await listen(server); await new Promise(r => server.close(r)); return Number(new URL(url).port); }

test('CLI agent starts its companion on IPv4 loopback and closes both on termination', async t => {
  const f = await fixtureDirectory(t); const managementPort = await port(); const inferencePort = await port();
  const file = join(f.directory, 'config.json');
  await writeJson(file, { agent: { id: 'cli-test', token: 'cli-management-secret', host: '127.0.0.1', port: managementPort, stateDir: join(f.directory, 'agent'), modelRoot: f.models, localInference: { enabled: true, host: '0.0.0.0', port: inferencePort, apiKeys: ['cli-inference-secret'] } } });
  const child = spawn(process.execPath, ['backend/cli.mjs', 'agent', '--config', file]);
  let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  f.cleanupWith(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  await waitFor(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await fetch(`http://127.0.0.1:${inferencePort}/health`)).ok; } catch { return false; } });
  assert.match(output, new RegExp(`127\\.0\\.0\\.1:${inferencePort}`));
  assert.doesNotMatch(output, /0\.0\.0\.0|cli-inference-secret/);
  assert.equal((await fetch(`http://127.0.0.1:${managementPort}/health`)).status, 200);
  const external = Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal);
  if (external) await assert.rejects(fetch(`http://${external.address}:${inferencePort}/health`, { signal: AbortSignal.timeout(1500) }));
  child.kill('SIGTERM'); await once(child, 'exit');
  await assert.rejects(fetch(`http://127.0.0.1:${inferencePort}/health`));
});

test('a companion bind failure shuts down management and releases the Agent instance lock', async t => {
  const f = await fixtureDirectory(t); const blocker = createServer(); const occupied = await listen(blocker);
  f.cleanupWith(() => new Promise(r => blocker.close(r)));
  const managementPort = await port(); const file = join(f.directory, 'config.json');
  await writeJson(file, { agent: { id: 'cli-bind-test', token: 'cli-management-secret', host: '127.0.0.1', port: managementPort, stateDir: join(f.directory, 'agent'), modelRoot: f.models, localInference: { enabled: true, port: Number(new URL(occupied).port), apiKeys: ['cli-inference-secret'] } } });
  const child = spawn(process.execPath, ['backend/cli.mjs', 'agent', '--config', file]);
  let error = ''; child.stderr.on('data', c => error += c);
  const [code] = await once(child, 'exit');
  assert.equal(code, 1); assert.match(error, /EADDRINUSE/);
  await assert.rejects(fetch(`http://127.0.0.1:${managementPort}/health`));
  await assert.rejects(access(join(f.directory, 'agent/instance.lock')), { code: 'ENOENT' });
});

test('shared browser fixture runs two agents with private login credentials and cleans up on exit', async t => {
  const child = spawn(process.execPath, ['tests/fixtures/browser-cluster.mjs', '--shared-preview']);
  let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  await waitFor(() => output.includes('http://127.0.0.1:5190'));
  const api = path => fetch('http://127.0.0.1:5190' + path, { headers: { 'X-GPU-Console': '1' } });
  const session = await (await api('/api/session')).json(); assert.equal(session.mode, 'shared'); assert.equal(session.authenticated, false);
  assert.equal((await api('/api/control/state')).status, 401);
  const path = /^Credential file: (.+)$/m.exec(output)?.[1]; assert.ok(path);
  const password = (await readFile(path, 'utf8')).trim(); assert.equal(output.includes(password), false); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const loggedIn = await fetch('http://127.0.0.1:5190/api/session/login', { method: 'POST', headers: { 'X-GPU-Console': '1', Origin: 'http://127.0.0.1:5190', 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
  const state = await (await fetch('http://127.0.0.1:5190/api/control/state', { headers: { 'X-GPU-Console': '1', Cookie: cookie } })).json();
  assert.equal(state.nodes.length, 2); assert.equal(state.services.length, 2); assert.equal(state.inferenceMode, 'per-node');
  child.kill('SIGTERM'); await once(child, 'exit');
  await assert.rejects(access(path), { code: 'ENOENT' });
});
