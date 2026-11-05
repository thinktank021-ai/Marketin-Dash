import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { derivePassword, guardAppRequest, isAppAuthenticated, SESSION_TTL_MS } from '../worker/app-auth.ts';

test('twenty-minute idle sessions renew only on explicit activity, never background traffic', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0011_quick_scarlet_spider.sql', import.meta.url), 'utf8'));
  const salt = '0123456789abcdef0123456789abcdef';
  const hash = `scrypt-v1:${salt}:${(await derivePassword('test-only-password', salt)).toString('hex')}`;
  const env = { DASHBOARD_ADMIN_PASSWORD_HASH: hash, DB: { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args); }, async run() { return db.prepare(sql).run(...args); } };
  } } };
  for (const remember of [false, true]) {
    const response = await guardAppRequest(new Request('https://example.test/api/auth/login', {
      method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Admin', password: 'test-only-password', remember }),
    }), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=1200/);
    const { expiresAt } = await response.json();
    const request = new Request('https://example.test/api/brands', { headers: { cookie: response.headers.get('set-cookie').split(';')[0] } });
    for (const elapsed of [0, 60000, 1199000, 1199999]) {
      assert.equal(await isAppAuthenticated(request, env, expiresAt - SESSION_TTL_MS + elapsed), true);
    }
    assert.equal(await isAppAuthenticated(request, env, expiresAt), false);
    assert.equal(await isAppAuthenticated(request, env, expiresAt + 1), false);
    assert.equal(db.prepare('SELECT expires_at FROM dashboard_login_sessions ORDER BY expires_at DESC').get().expires_at, expiresAt);
    assert.equal(await isAppAuthenticated(request, { ...env, DASHBOARD_ADMIN_PASSWORD_HASH: hash + 'changed' }), false, 'credential rotation revokes old sessions');
    const realNow = Date.now;
    try {
      let now = expiresAt - 60000;
      Date.now = () => now;
      const activity = (origin = 'https://example.test') => new Request('https://example.test/api/auth/activity', { method: 'POST', headers: { cookie: request.headers.get('cookie'), origin } });
      assert.equal((await guardAppRequest(activity('https://attacker.test'), env)).status, 403);
      assert.equal((await guardAppRequest(new Request('https://example.test/api/auth/activity', { headers: { cookie: request.headers.get('cookie') } }), env)).status, 405);
      const renewed = await guardAppRequest(activity(), env);
      assert.equal(renewed.status, 200);
      assert.match(renewed.headers.get('set-cookie'), /Max-Age=1200/);
      const renewedUntil = (await renewed.json()).expiresAt;
      assert.equal(renewedUntil, now + SESSION_TTL_MS);
      assert.equal(await isAppAuthenticated(request, env, expiresAt), true, 'active admin stays signed in beyond original expiry');
      now = expiresAt + 60000;
      await guardAppRequest(new Request('https://example.test/api/auth/session', { headers: { cookie: request.headers.get('cookie') } }), env);
      await guardAppRequest(request, env);
      assert.equal(db.prepare('SELECT expires_at FROM dashboard_login_sessions').get().expires_at, renewedUntil, 'polling does not renew');
      assert.equal(await isAppAuthenticated(request, env, renewedUntil - 1), true);
      now = renewedUntil;
      assert.equal(await isAppAuthenticated(request, env, now), false);
      assert.equal((await guardAppRequest(activity(), env)).status, 401, 'expired session cannot be resurrected');
    } finally { Date.now = realNow; }
    const logoutRequest = new Request('https://example.test/api/auth/logout', { method: 'POST', headers: { cookie: request.headers.get('cookie'), origin: 'https://example.test' } });
    assert.equal((await guardAppRequest(logoutRequest, env)).status, 200);
    assert.equal(await isAppAuthenticated(request, env, expiresAt - 1), false, 'manual logout revokes the server session');
  }
  assert.equal((await guardAppRequest(new Request('https://example.test/api/brands'), env)).status, 401);
  assert.equal((await guardAppRequest(new Request('https://example.test/api/auth/login', { method: 'POST', headers: { origin: 'https://attacker.test' } }), env)).status, 403);
  // Keep this independent test in one rate-limit bucket even when the suite
  // happens to run across a real quarter-hour boundary.
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  try {
    for (let i = 0; i < 11; i++) {
      const result = await guardAppRequest(new Request('https://example.test/api/auth/login', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Admin', password: 'incorrect' }) }), env);
      assert.equal(result.status, i < 10 ? 401 : 429);
    }
  } finally { Date.now = originalNow; }
  db.close();
});

test('Telegram scheduler credential header cannot bypass dashboard authentication for unrelated actions', async () => {
  const env = { DASHBOARD_ADMIN_PASSWORD_HASH: 'not-a-real-hash', DB: { prepare() { throw new Error('should not query DB for unauthenticated requests'); } } };
  const request = (action, headers = {}) => new Request('https://example.test/api/telegram-bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-scheduler-secret': 'unverified-secret', ...headers },
    body: JSON.stringify({ action }),
  });
  assert.equal(await guardAppRequest(request('scheduler'), env), null, 'the scheduler secret must be checked by the API route');
  for (const action of ['test', 'dispatch', 'approve', 'reject', 'discover', 'rotate_scheduler_secret']) {
    const response = await guardAppRequest(request(action), env);
    assert.equal(response?.status, 401, action);
  }
  assert.equal((await guardAppRequest(request('scheduler', { 'content-type': 'text/plain' }), env))?.status, 401);
});
