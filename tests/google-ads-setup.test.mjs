import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { authorizeTestEnv } from './auth-support.mjs';
import { normalizeAdsId, validateAdsAccountIds, adsSetupError } from '../app/google-ads-setup.ts';

test('Ads IDs normalize Persian/Arabic digits without silently truncating invalid input', () => {
  assert.equal(normalizeAdsId('۱۲۳-۴۵۶-۷۸۹۰'), '1234567890');
  assert.equal(normalizeAdsId('١٢٣ ٤٥٦ ٧٨٩٠'), '1234567890');
  assert.equal(normalizeAdsId('12345678901'), '12345678901');
});
test('account validation accepts direct access and rejects wrong customer or manager IDs', () => {
  assert.equal(validateAdsAccountIds('۱۲۳-۴۵۶-۷۸۹۰', ''), '');
  for (const invalid of ['', '12345678901', 'abc1234567890']) assert.match(validateAdsAccountIds(invalid, ''), /Customer ID/);
  assert.match(validateAdsAccountIds('1234567890', '123'), /MCC ID/);
});
test('Service Account errors are actionable and never echo provider secrets', () => {
  assert.match(adsSetupError('google_ads_encryption_not_configured'), /مدیر فنی/);
  assert.match(adsSetupError('google_ads_credentials_incomplete'), /JSON/);
  assert.match(adsSetupError('google_ads_service_account_json_invalid'), /JSON معتبر/);
  assert.match(adsSetupError('google_ads_service_account_key_invalid'), /کلید خصوصی/);
  assert.match(adsSetupError('DEVELOPER_TOKEN_NOT_APPROVED'), /حساب واقعی/);
  assert.match(adsSetupError('USER_PERMISSION_DENIED'), /Service Account/);
  assert.ok(!adsSetupError('private-provider-value').includes('private-provider-value'));
});
test('setup card exposes one Service Account path for every office and no legacy controls', () => {
  const source = readFileSync(new URL('../app/google-ads-connection-card.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; new Function('React', 'exports', code)(React, exports);
  const props = { brand: { id: 'test-office', name: 'دفتر آزمایشی', googleAdsStatus: 'pending', googleAdsMessage: '', googleAdsCustomerId: '', googleAdsLoginCustomerId: '' }, settings: { hasDeveloperToken: true, hasServiceAccount: true, serviceAccountEmail: 'office@test.iam.gserviceaccount.com' }, developerToken: '', serviceAccountJson: '', busy: false, onBrandChange() {}, onToken() {}, onServiceAccountJson() {}, onConnect() {} };
  const html = renderToStaticMarkup(React.createElement(exports.GoogleAdsConnectionCard, props));
  for (const field of ['customer', 'manager', 'service-json', 'token']) {
    assert.ok(html.includes(`aria-describedby="ads-${field}-help"`));
    assert.ok(html.includes(`id="ads-${field}-help"`));
  }
  for (const text of ['Service Account', 'Customer ID', 'MCC (اختیاری)', 'Read only', 'برای حفظ کلید قبلی خالی بگذارید']) assert.ok(html.includes(text), text);
  for (const removed of ['OAuth Client ID', 'Client Secret', 'ورود جیمیل', 'redirect_uri_mismatch', 'اتصال امن قبلی']) assert.ok(!html.includes(removed), removed);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  const busy = renderToStaticMarkup(React.createElement(exports.GoogleAdsConnectionCard, { ...props, busy: true }));
  assert.match(busy, /button[^>]+disabled/);
});

let database, env, worker, cookie, serviceJson, otherServiceJson, tokenCalls = 0, adsCalls = 0;
const originalFetch = globalThis.fetch;
async function createServiceJson(email) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64').match(/.{1,64}/g).join('\n');
  return JSON.stringify({ type: 'service_account', project_id: `project-${email.split('@')[0]}`, client_email: email, private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` });
}
before(async () => {
  database = new DatabaseSync(':memory:');
  const DB = { database, prepare(sql) { let values = []; return {
    bind(...args) { values = args; return this; },
    async run() { const r = database.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return database.prepare(sql).get(...values) || null; },
    async all() { return { results: database.prepare(sql).all(...values) }; },
  }; }, async batch(statements) { return Promise.all(statements.map(s => s.run())); } };
  env = globalThis.__CLOUDFLARE_TEST_ENV = { DB, BUCKET: {}, GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  cookie = await authorizeTestEnv(env);
  for (const id of ['test-office', 'other-office']) database.prepare("INSERT INTO dashboard_brands(id,name,short_name,google_ads_customer_id,config_status) VALUES(?,?,?,'1234567890','active')").run(id, id, id);
  serviceJson = await createServiceJson('test-office@test-project.iam.gserviceaccount.com');
  otherServiceJson = await createServiceJson('other-office@other-project.iam.gserviceaccount.com');
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenCalls++; assert.equal(init.method, 'POST'); assert.match(String(init.body), /jwt-bearer/);
      return Response.json({ access_token: 'fake-access-test-only' });
    }
    adsCalls++;
    assert.match(String(url), /googleads.googleapis.com\/v25\/customers\/1234567890\/googleAds:searchStream/);
    assert.equal(init.headers['developer-token'], 'fake-developer-test-only');
    const query = JSON.parse(init.body).query;
    if (query.startsWith('SELECT customer.')) return Response.json([{ results: [{ customer: { descriptiveName: 'Test account', currencyCode: 'TRY', timeZone: 'Europe/Istanbul', status: 'ENABLED' } }] }]);
    if (query.includes('campaign.primary_status')) return Response.json([{ results: [{ campaign: { id: '7', name: 'Campaign', status: 'ENABLED', primaryStatus: 'LIMITED', primaryStatusReasons: ['BUDGET_CONSTRAINED'] } }] }]);
    if (query.includes('ad_group_ad.policy_summary')) return Response.json([{ results: [{ campaign: { id: '7', name: 'Campaign' }, adGroupAd: { ad: { id: '77' }, status: 'ENABLED', policySummary: { approvalStatus: 'DISAPPROVED', policyTopicEntries: [{ topic: 'DESTINATION_NOT_WORKING' }] } } }] }]);
    return Response.json([{ results: [{ segments: { date: '2026-09-01' }, campaign: { id: '7', name: 'Campaign', status: 'ENABLED' }, metrics: { impressions: '50', clicks: '5', costMicros: '2500000' } }] }]);
  };
  worker = (await import(`../dist/server/index.js?ads-setup=${Date.now()}`)).default;
});
after(() => { globalThis.fetch = originalFetch; database?.close(); });
const request = (path, body, brandId = 'test-office') => worker.fetch(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json', 'x-dashboard-brand': brandId }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil() {}, passThroughOnException() {} });
const settings = (extra = {}) => request('/api/google-ads/settings', { id: 'test-office', ...extra });
const credential = (id = 'test-office') => database.prepare('SELECT * FROM brand_google_ads_service_accounts WHERE brand_id=?').get(id);

test('settings require a complete Service Account, encrypt both secrets and omit them from GET', async () => {
  assert.equal((await settings()).status, 400);
  assert.equal((await settings({ serviceAccountJson: serviceJson, developerToken: 'fake-developer-test-only' })).status, 200);
  const row = credential();
  assert.notEqual(row.private_key_encrypted, JSON.parse(serviceJson).private_key);
  assert.notEqual(row.developer_token_encrypted, 'fake-developer-test-only');
  const publicText = await (await request('/api/google-ads/settings?id=test-office')).text();
  assert.ok(!publicText.includes('PRIVATE KEY')); assert.ok(!publicText.includes('fake-developer-test-only'));
  assert.match(publicText, /test-office@test-project\.iam\.gserviceaccount\.com/);
});
test('blank secret fields preserve the already encrypted values', async () => {
  const before = credential();
  assert.equal((await settings({ serviceAccountJson: '', developerToken: '' })).status, 200);
  const after = credential();
  assert.equal(after.private_key_encrypted, before.private_key_encrypted);
  assert.equal(after.developer_token_encrypted, before.developer_token_encrypted);
});
test('credentials remain isolated and Service Account works for every office', async () => {
  const response = await request('/api/google-ads/settings', { id: 'other-office', serviceAccountJson: otherServiceJson, developerToken: 'other-token-test-only' }, 'other-office');
  assert.equal(response.status, 200);
  assert.notEqual(credential('other-office').private_key_encrypted, credential().private_key_encrypted);
  const first = await (await request('/api/google-ads/settings?id=test-office')).json();
  const other = await (await request('/api/google-ads/settings?id=other-office', undefined, 'other-office')).json();
  assert.notEqual(first.serviceAccountEmail, other.serviceAccountEmail);
});
test('live status and report use only the selected office Service Account', async () => {
  const status = await (await request('/api/google-ads/status')).json();
  assert.equal(status.status, 'connected'); assert.equal(status.accountName, 'Test account'); assert.equal(status.accountStatus, 'ENABLED'); assert.equal(status.accountAlert, null);
  const reportResponse = await request('/api/google-ads/report?from=2026-09-01&to=2026-09-02');
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.totals.impressions, 50); assert.equal(report.totals.cost, 2.5);
  assert.deepEqual(report.alertScan, { campaignsComplete: true, policiesComplete: true });
  assert.equal(report.alerts.length, 2);
  assert.match(report.alerts.find(alert => alert.kind === 'campaign').detail, /بودجه/);
  assert.match(report.alerts.find(alert => alert.kind === 'policy').detail, /صفحهٔ مقصد/);
  assert.ok(tokenCalls >= 3); assert.ok(adsCalls >= 3);
});
test('incomplete office reports exact missing field and cannot borrow another office credentials', async () => {
  database.prepare("INSERT INTO dashboard_brands(id,name,short_name,google_ads_customer_id,config_status) VALUES('empty-office','Empty','Empty','1234567890','active')").run();
  const response = await request('/api/google-ads/status', undefined, 'empty-office');
  assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.reason, 'service_account_not_configured'); assert.equal(payload.field, 'serviceAccount');
});
test('legacy connect and callback endpoints no longer exist', async () => {
  assert.equal((await request('/api/google-ads/connect', { id: 'test-office' })).status, 404);
  assert.equal((await request('/api/google-ads/callback?code=x&state=y')).status, 404);
});
test('encryption misconfiguration blocks saving without creating credentials', async () => {
  delete env.GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY;
  database.prepare("INSERT INTO dashboard_brands(id,name,short_name,google_ads_customer_id,config_status) VALUES('no-key-office','No key','No key','1234567890','active')").run();
  const r = await request('/api/google-ads/settings', { id: 'no-key-office', serviceAccountJson: serviceJson, developerToken: 'fake' }, 'no-key-office');
  assert.equal(r.status, 400); assert.match((await r.json()).error, /مدیر فنی/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM brand_google_ads_service_accounts WHERE brand_id='no-key-office'").get().count, 0);
  env.GOOGLE_ADS_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});
