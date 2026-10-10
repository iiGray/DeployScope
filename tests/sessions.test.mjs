import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, createSessions } from '../backend/sessions.mjs';

const password = 'test-team-password-independent';
const request = (cookie = '', source = '127.0.0.1') => ({ headers: { cookie, 'x-forwarded-for': 'attacker-controlled' }, socket: { remoteAddress: source } });
const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; } });

test('password hashes use unique salts and sessions are independent, revocable and expire at 12 hours', async () => {
  const hash = await hashPassword(password); const other = await hashPassword(password);
  assert.notEqual(hash, other); assert.match(hash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  let now = 1000; const sessions = createSessions({ passwordHash: hash, secureCookies: true }, { now: () => now });
  const a = response(); const b = response();
  assert.deepEqual(await sessions.login(request(), a, password), { authenticated: true });
  await sessions.login(request(), b, password);
  assert.notEqual(a.headers['Set-Cookie'], b.headers['Set-Cookie']);
  const cookieA = a.headers['Set-Cookie'].split(';')[0]; const cookieB = b.headers['Set-Cookie'].split(';')[0];
  assert.match(a.headers['Set-Cookie'], /HttpOnly; SameSite=Strict/); assert.match(a.headers['Set-Cookie'], /Max-Age=43200/); assert.match(a.headers['Set-Cookie'], /Secure/);
  assert.equal(a.headers['Set-Cookie'].includes(password), false);
  sessions.require(request(cookieA));
  assert.throws(() => sessions.require(request(cookieA + '0')), { status: 401 });
  sessions.logout(request(cookieA), response());
  assert.throws(() => sessions.require(request(cookieA)), { status: 401 }); sessions.require(request(cookieB));
  now += 43200000; assert.throws(() => sessions.require(request(cookieB)), { status: 401 });
  sessions.close(); assert.throws(() => sessions.require(request(cookieB)), { status: 401 });
});

test('failed login limit is keyed by socket address, cannot be bypassed with forwarded headers, and resets', async () => {
  let now = 0; const sessions = createSessions({ passwordHash: await hashPassword(password) }, { now: () => now });
  for (let i = 0; i < 10; i++) {
    const req = request(); req.headers['x-forwarded-for'] = `forged-${i}`;
    await assert.rejects(sessions.login(req, response(), 'wrong-password-long-enough'), { status: 401 });
  }
  await assert.rejects(sessions.login(request(), response(), password), { status: 429 });
  await sessions.login(request('', '127.0.0.2'), response(), password);
  now = 600001; await sessions.login(request(), response(), password);
  sessions.close();
});

test('initialization rejects invalid hashes and password generation rejects weak or oversized inputs', async () => {
  for (const passwordHash of ['', 'plain-password', 'scrypt$abc$def']) assert.throws(() => createSessions({ passwordHash }), /口令/);
  await assert.rejects(hashPassword('short'), /口令/);
  await assert.rejects(hashPassword('x'.repeat(257)), /口令/);
});
