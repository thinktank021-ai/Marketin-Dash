import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { authorizeTestEnv } from './auth-support.mjs';

test('active office survives a failed health check, serves same-source stale data, rejects changed/unapproved sources', async () => {
  const database = new DatabaseSync(':memory:');
  const DB = { database, prepare(sql) { let values = []; return {
    bind(...args) { values = args; return this; },
    async run() { const result = database.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    async first() { return database.prepare(sql).get(...values) || null; },
    async all() { return { results: database.prepare(sql).all(...values) }; },
  }; }, async batch(statements) { return Promise.all(statements.map(statement => statement.run())); } };
  const env = globalThis.__CLOUDFLARE_TEST_ENV = { DB, BUCKET: {} };
  const cookie = await authorizeTestEnv(env);
  const source = 'https://docs.google.com/spreadsheets/d/e/test-source/pub?output=csv';
  // Seed the persisted cache fixture without importing Worker-only database code into Node.
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  const fingerprint = (hash >>> 0).toString(36);
  const index = 'https://docs.google.com/spreadsheets/d/e/test-source/pubhtml';
  database.prepare("INSERT INTO dashboard_brands (id,name,short_name,sheet_csv_url,sheet_index_url,sheet_status,config_status) VALUES (?,?,?,?,?,'error','active')").run('test-office', 'دفتر آزمایشی', 'آزمایش', source, index);
  const csv = 'تاریخ,منبع فایل,مسیر\n1405/06/01,پیامک,تفلیس باتومی';
  database.prepare("INSERT INTO sheet_csv_cache (cache_key,brand_id,source_url,selector,payload,fetched_at) VALUES (?,?,?,?,?,'2000-01-01 00:00:00')").run(`test-office:${fingerprint}:gid=42`, 'test-office', source, 'gid=42', csv);
  const months = [{ value: '1405/06', label: 'شهریور', gid: '42' }];
  database.prepare("INSERT INTO sheet_month_registry_cache (brand_id,source_url,payload,fetched_at) VALUES (?,?,?,'2000-01-01 00:00:00')").run('test-office', index, JSON.stringify(months));
  const originalFetch = globalThis.fetch; let remoteCalls = 0;
  let remoteHealthy = false;
  const freshCsv = csv + '\n1405/06/02,پیامک,استانبول';
  globalThis.fetch = async url => { remoteCalls++; if (!remoteHealthy) throw new Error('simulated_google_timeout'); return new Response(String(url).includes('pubhtml') ? 'items.push({name:"شهریور 1405",gid:"42"})' : freshCsv); };
  try {
    const { default: worker } = await import(`../dist/server/index.js?recovery=${Date.now()}`);
    const request = (path, brand = 'test-office', manual = false) => worker.fetch(new Request(`http://localhost${path}`, { headers: { cookie, 'x-dashboard-brand': brand, ...(manual ? { 'x-dashboard-refresh': '1' } : {}) } }), env, { waitUntil() {}, passThroughOnException() {} });
    const response = await request('/api/sheet-data?gid=42');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-sheet-stale'), 'true');
    assert.equal(response.headers.get('x-dashboard-brand'), 'test-office');
    assert.equal(await response.text(), csv);
    const registry = await request('/api/sheet-months');
    assert.equal(registry.status, 200);
    assert.equal((await registry.json()).stale, true);
    assert.equal(remoteCalls, 2, 'one attempt per endpoint, no retry storm');
    const health = () => database.prepare("SELECT sheet_status,config_status FROM dashboard_brands WHERE id='test-office'").get();
    assert.equal(health().sheet_status, 'warning', 'stale fallback must not claim a green connection');
    database.prepare('UPDATE sheet_csv_cache SET fetched_at=CURRENT_TIMESTAMP').run();
    remoteHealthy = true;
    assert.equal(await (await request('/api/sheet-data?gid=42')).text(), csv, 'background reads still use the five-minute cache');
    assert.equal(remoteCalls, 2);
    assert.equal(await (await request('/api/sheet-data?gid=42', 'test-office', true)).text(), freshCsv, 'manual refresh bypasses a fresh server cache');
    assert.equal(remoteCalls, 3);
    assert.equal(health().sheet_status, 'connected', 'real recovery updates the settings card state');
    assert.equal(health().config_status, 'active');
    await request('/api/sheet-months', 'test-office', true);
    const beforeForcedRegistry = remoteCalls;
    await request('/api/sheet-months'); assert.equal(remoteCalls, beforeForcedRegistry);
    await request('/api/sheet-months', 'test-office', true); assert.equal(remoteCalls, beforeForcedRegistry + 1);
    remoteHealthy = false;
    assert.equal((await request('/api/sheet-data?gid=42', 'test-office', true)).headers.get('x-sheet-stale'), 'true');
    assert.equal(health().sheet_status, 'warning');
    assert.equal((await request('/api/sheet-data?gid=42', 'missing-office')).status, 404);
    database.prepare("UPDATE dashboard_brands SET config_status='draft' WHERE id='test-office'").run();
    assert.equal((await request('/api/sheet-data?gid=42')).status, 409);
    database.prepare("UPDATE dashboard_brands SET config_status='active', sheet_csv_url=?, sheet_index_url=? WHERE id='test-office'").run(source + '&changed=1', index + '?changed=1');
    assert.equal((await request('/api/sheet-data?gid=42')).status, 502, 'old source CSV cannot leak into new source');
    assert.equal((await request('/api/sheet-months')).status, 502, 'old registry cannot leak into new source');
  } finally { globalThis.fetch = originalFetch; database.close(); }
});
