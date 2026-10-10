import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createAgent } from '../../backend/agent.mjs';
import { createController } from '../../backend/controller.mjs';
import { createConsole } from '../../backend/console.mjs';
import { hashPassword } from '../../backend/sessions.mjs';
import { writeJson } from '../../backend/common.mjs';
import { fixtureDirectory, fixtureExecutable, telemetry, listen } from './helpers.mjs';

export const TEST_PASSWORD = 'cpu-shared-console-test-password';
export async function sharedCluster(t, { guardedMutations = false } = {}) {
  const f = await fixtureDirectory(t); const agents = []; const nodes = [];
  for (const id of ['node-a', 'node-b']) {
    const token = `private-agent-${id}-secret`;
    const app = await createAgent({ id, name: id, token, stateDir: join(f.directory, id), modelRoot: f.models, modelBrowseRoot: f.directory, defaultModelRoot: f.models, vllmExecutable: process.execPath, vllmPrefixArgs: [fixtureExecutable], pollMs: 40, coordinatedWrites: guardedMutations, localInference: { enabled: true, apiKeys: [`local-key-${id}-independent`] } }, { readGpuStatus: telemetry });
    f.cleanupWith(app.close); agents.push(app);
    app.gatewayUrl = await listen(app.localInference.server);
    nodes.push({ id, name: id, token, url: await listen(app.server) });
  }
  const config = { stateDir: join(f.directory, 'controller'), adminToken: 'private-shared-controller-key', apiKeys: ['unused-legacy-inference-key'], publicUrl: 'http://127.0.0.1:18081', inferenceEnabled: false, multiUser: guardedMutations, nodes };
  const controller = await createController(config); f.cleanupWith(controller.close);
  const controllerUrl = await listen(controller.server);
  const settingsFile = join(f.directory, 'console.json');
  await writeJson(settingsFile, { controllerUrl: 'http://untrusted-old-settings', adminToken: 'old-settings-secret' });
  const origin = 'http://console.test:15173';
  const consoleConfig = { mode: 'shared', host: '127.0.0.1', publicOrigins: [origin], trustedNetwork: true, settingsFile, controllerUrl, adminToken: config.adminToken, passwordHash: await hashPassword(TEST_PASSWORD) };
  const ui = await createConsole(consoleConfig); f.cleanupWith(ui.close); const baseUrl = await listen(ui.server);
  const client = () => {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      request(path, { method = 'GET', body, headers = {} } = {}) {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        return new Promise((resolve, reject) => {
          const req = httpRequest(baseUrl + path, { method, headers: { Host: 'console.test:15173', Origin: origin, 'X-GPU-Console': '1', 'Content-Type': 'application/json', Cookie: cookie, ...(encoded === undefined ? {} : { 'Content-Length': Buffer.byteLength(encoded) }), ...headers } }, res => {
            if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) }); });
          });
          req.on('error', reject); req.end(encoded);
        });
      },
      login(password = TEST_PASSWORD) { return this.request('/api/session/login', { method: 'POST', body: { password } }); },
    };
  };
  return { ...f, baseUrl, origin, controller, config, agents, clients: [client(), client()], consoleConfig, ui };
}
