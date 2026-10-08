import { resolve } from 'node:path';
import { createConsole } from './backend/console.mjs';

const port = Number(process.env.GPU_MONITOR_PORT || 5173);
const consoleApp = await createConsole({ port, settingsFile: resolve('.gpu-monitor/console.json') });
consoleApp.server.on('error', (cause) => { console.error(cause.message); process.exitCode = 1; });
consoleApp.server.listen(port, '127.0.0.1', () => console.log(`GPU Monitor · http://127.0.0.1:${port}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await consoleApp.close(); });
