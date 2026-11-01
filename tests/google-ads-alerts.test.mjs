import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { accountStatusAlert, campaignLimitedAlert, policyAlert } from '../app/google-ads-alerts.ts';

test('only explicit account suspension, cancellation, or closure creates a critical account alert', () => {
  assert.equal(accountStatusAlert('ENABLED', 'Healthy'), null);
  for (const status of ['SUSPENDED', 'CANCELED', 'CLOSED']) {
    const alert = accountStatusAlert(status, 'Office account');
    assert.equal(alert?.severity, 'critical');
    assert.equal(alert?.kind, 'account');
    assert.match(alert?.title || '', /حساب Google Ads/);
  }
});

test('campaign and ad policy alerts are translated to manager-friendly Persian', () => {
  const campaign = campaignLimitedAlert({ id: '1', name: 'Istanbul', primaryStatus: 'LIMITED', primaryStatusReasons: ['BUDGET_CONSTRAINED'] });
  assert.equal(campaign?.severity, 'warning');
  assert.match(campaign?.detail || '', /بودجه/);
  assert.equal(campaignLimitedAlert({ primaryStatus: 'ELIGIBLE' }), null);

  const rejected = policyAlert({ adId: '2', campaignName: 'Dubai', approvalStatus: 'DISAPPROVED', topics: ['DESTINATION_NOT_WORKING'] });
  assert.equal(rejected?.severity, 'critical');
  assert.match(rejected?.detail || '', /صفحهٔ مقصد/);
  const limited = policyAlert({ adId: '3', approvalStatus: 'APPROVED_LIMITED' });
  assert.equal(limited?.severity, 'warning');
  assert.equal(policyAlert({ approvalStatus: 'APPROVED' }), null);
});

test('alert center placement and every Persian date menu readability override remain present', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.ok(page.indexOf('adsConnectionEntry') < page.indexOf('<GoogleAdsAlertCenter'));
  assert.match(page, /\(Boolean\(error\) \|\| report\?\.connected === false \|\| Boolean\(report\?\.stale\)\) && <div className="adsConnectionEntry">/);
  assert.ok(page.includes('googleAdsConnection.accountAlert'));
  assert.match(css, /\.persianCalendar\.glass\{[^}]*blur\(38px\)/);
  assert.match(css, /\.adsAlertCenter/);
  assert.match(css, /\.googleAdsAccountCritical/);
});
