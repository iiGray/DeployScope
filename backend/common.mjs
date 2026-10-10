import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function serialQueue() {
  let previous = Promise.resolve();
  return (fn) => { const result = previous.then(fn); previous = result.catch(() => {}); return result; };
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (cause) { if (cause.code === 'ENOENT') return structuredClone(fallback); throw cause; }
}
export async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
}
export function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(String(actual)), hash(String(expected)));
}
export function requireToken(request, tokens) {
  const value = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
  if (![tokens].flat().some((token) => tokenMatches(value, token))) throw new ApiError(401, '需要有效的访问密钥');
}
export function json(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
export function fail(response, cause) {
  if (response.headersSent) { response.destroy(); return; }
  json(response, { error: { message: cause.status ? cause.message : '服务内部错误', type: 'gpu_monitor_error' } }, cause.status || 500);
}
export async function bodyJson(request, maxBytes = 1024 * 1024, { timeoutMs } = {}) {
  const chunks = []; let size = 0;
  await new Promise((resolveBody, rejectBody) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted); };
    const reject = cause => { cleanup(); request.pause(); rejectBody(cause); };
    const onData = chunk => { size += chunk.length; if (size > maxBytes) { reject(new ApiError(413, '请求内容过大')); return; } chunks.push(Buffer.from(chunk)); };
    const onEnd = () => { cleanup(); resolveBody(); };
    const onError = () => reject(new ApiError(400, '请求接收失败'));
    const onAborted = () => reject(new ApiError(400, '请求已断开'));
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new ApiError(408, '请求内容接收超时')), timeoutMs);
  });
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new ApiError(400, '请求必须是 JSON 对象'); }
}
export function httpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, '请输入有效的 HTTP 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError(400, '地址必须为不含凭据的 HTTP/HTTPS 地址');
  return url.href.replace(/\/+$/, '');
}
export async function remoteJson(url, token, { method = 'GET', body, timeout = 8000 } = {}) {
  let response;
  try {
    response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch { throw new ApiError(502, '无法连接远端服务，请检查地址、网络和服务状态'); }
  let data;
  try { data = await response.json(); } catch { throw new ApiError(502, '远端未返回有效的 JSON'); }
  if (!response.ok) throw new ApiError(response.status, data.error?.message || `远端请求失败 (${response.status})`);
  return data;
}
export async function relay(request, response, url, token, body, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const abort = new AbortController();
  const onClose = () => { if (!response.writableEnded) abort.abort(); };
  response.on('close', onClose);
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: abort.signal });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch (cause) {
    if (!response.destroyed) fail(response, new ApiError(abort.signal.aborted ? 504 : 502, abort.signal.aborted ? '推理请求超时' : '推理服务连接中断或不可用'));
  } finally { clearTimeout(timeout); response.off('close', onClose); }
}
export async function birthTime(pid) {
  try { const text = await readFile(`/proc/${Number(pid)}/stat`, 'utf8'); return text.slice(text.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; }
}
export async function bootId() { try { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch { return null; } }
export function pidAlive(pid) { if (!Number.isInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch (cause) { return cause.code === 'EPERM'; } }
export async function instanceLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'instance.lock');
  const owner = { pid: process.pid, birth: await birthTime(process.pid) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner)); await handle.close();
      return async () => { const current = await readJson(file, null); if (current?.pid === owner.pid && current?.birth === owner.birth) await unlink(file); };
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      const current = await readJson(file, null);
      if (!current?.pid || (pidAlive(current.pid) && (!current.birth || await birthTime(current.pid) === current.birth))) throw new Error('同一状态目录已有运行中的实例');
      await unlink(file);
    }
  }
  throw new Error('无法取得实例锁');
}
