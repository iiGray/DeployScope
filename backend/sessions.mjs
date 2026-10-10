import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './common.mjs';

const derive = promisify(scrypt);
const lifetime = 12 * 60 * 60 * 1000;
const windowMs = 10 * 60 * 1000;
const validPassword = password => typeof password === 'string' && Buffer.byteLength(password) >= 16 && Buffer.byteLength(password) <= 256;
export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error('网页口令必须为 16–256 字节');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export function createSessions({ passwordHash, secureCookies = false }, { now = Date.now } = {}) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(passwordHash || '');
  if (!match) throw new Error('网页口令校验值格式无效');
  const expected = Buffer.from(match[2], 'hex');
  const sessions = new Map(); const sources = new Map(); let active = 0; let closed = false;
  const cookie = (id, age) => `deployscope_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookies ? '; Secure' : ''}`;
  const prune = () => {
    const time = now();
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
    for (const [key, value] of sources) if (!value.active && time - value.startedAt >= windowMs) sources.delete(key);
  };
  const timer = setInterval(prune, 60000); timer.unref();
  const idFrom = request => {
    const values = (request.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith('deployscope_session='));
    if (values.length !== 1) return null;
    const id = values[0].slice('deployscope_session='.length);
    return /^[a-f0-9]{64}$/.test(id) ? id : null;
  };
  return {
    async login(request, response, password) {
      prune();
      if (closed) throw new ApiError(503, '会话服务已关闭');
      const address = request.socket.remoteAddress || 'unknown';
      let source = sources.get(address);
      if (!source) {
        if (sources.size >= 10000) throw new ApiError(429, '登录请求过多，请稍后重试');
        source = { startedAt: now(), failures: 0, active: 0 }; sources.set(address, source);
      }
      if (source.failures + source.active >= 10 || active >= 8) throw new ApiError(429, '登录尝试过多，请稍后重试');
      source.active++; active++;
      try {
        const actual = validPassword(password) ? await derive(password, match[1], 64) : null;
        if (!actual || !timingSafeEqual(actual, expected)) { source.failures++; throw new ApiError(401, '网页口令不正确'); }
        if (closed) throw new ApiError(503, '会话服务已关闭');
        prune();
        if (sessions.size >= 10000) throw new ApiError(429, '会话数量已达上限，请稍后重试');
        // Re-login rotates only this browser's previous cookie, never another browser's.
        sessions.delete(idFrom(request));
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { createdAt: now(), expiresAt: now() + lifetime });
        response.setHeader('Set-Cookie', cookie(id, 43200));
        return { authenticated: true };
      } finally { source.active--; active--; }
    },
    require(request) {
      const id = idFrom(request); const session = sessions.get(id);
      if (closed || !session || session.expiresAt <= now()) { if (id) sessions.delete(id); throw new ApiError(401, '请登录团队管理网页'); }
      return { ...session };
    },
    logout(request, response) { sessions.delete(idFrom(request)); response.setHeader('Set-Cookie', cookie('', 0)); },
    close() { closed = true; clearInterval(timer); sessions.clear(); sources.clear(); },
  };
}
