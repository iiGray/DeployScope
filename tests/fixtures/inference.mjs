import { createServer } from 'node:http';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const alias = args[args.indexOf('--served-model-name') + 1];
const key = args[args.indexOf('--api-key') + 1];
const server = createServer(async (request, response) => {
  if (request.url === '/health') { response.end('ok'); return; }
  if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end(); return; }
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || '{}');
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"model":"' + alias + '","choices":[{"delta":{"content":"first"}}]}\n\n');
    const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 350);
    response.on('close', () => clearTimeout(timer));
  } else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: alias, choices: [{ message: { role: 'assistant', content: 'fixture response' } }] })); }
});
server.listen(port, '127.0.0.1', () => console.log('Fixture ready; CUDA_VISIBLE_DEVICES=' + process.env.CUDA_VISIBLE_DEVICES));
process.on('SIGTERM', () => { if (!args.includes('--test-ignore-sigterm')) server.close(() => process.exit(0)); });
