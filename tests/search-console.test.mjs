import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeSearchConsoleProperty } from '../app/search-console-setup.ts';
import { analyzeSeoOpportunities } from '../app/seo-opportunity-engine.ts';

const metric = ({ clicks = 0, impressions = 0, ctr = 0, position = 7 } = {}) => ({ clicks, impressions, ctr, position });
const row = (key, current, previous = {}) => ({ key, current: metric(current), previous: metric(previous) });
const assertFiniteAnalysis = (analysis) => {
  assert.ok(Number.isFinite(analysis.impressionThreshold));
  assert.ok(Number.isFinite(analysis.scoreThreshold));
  assert.ok(analysis.scoreThreshold >= 0 && analysis.scoreThreshold <= 10);
  for (const opportunity of analysis.opportunities) {
    for (const value of [opportunity.score, opportunity.potentialClicks, opportunity.expectedCtr, opportunity.ctrGap]) assert.ok(Number.isFinite(value), `${opportunity.key} has a non-finite score value`);
    assert.ok(opportunity.score >= 0 && opportunity.score <= 10, `${opportunity.key} score must be 0–10`);
  }
};

test('Search Console property identifiers accept exact domain and URL-prefix formats', () => {
  assert.equal(normalizeSearchConsoleProperty('sc-domain:Example.COM'), 'sc-domain:example.com');
  assert.equal(normalizeSearchConsoleProperty('https://example.com/blog/'), 'https://example.com/blog/');
  assert.throws(() => normalizeSearchConsoleProperty('example.com'), /search_console_property_invalid/);
  assert.throws(() => normalizeSearchConsoleProperty('https://example.com/?office=other'), /search_console_property_invalid/);
});

test('Search Console remains optional, brand-scoped, read-only and independently navigable', () => {
  const page = readFileSync(new URL('../app/dashboard-client.tsx', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../app/api/search-console/service-account.ts', import.meta.url), 'utf8');
  const report = readFileSync(new URL('../app/api/search-console/report/route.ts', import.meta.url), 'utf8');
  assert.match(page, /activeView === "search-console"/);
  assert.match(page, /Search Console اختیاری است/);
  assert.match(page, /وضعیت اتصال به Search Console/);
  assert.doesNotMatch(page, /<b>وضعیت Search Console<\/b>/);
  assert.match(page, /SearchConsolePage/);
  assert.match(page, /ConnectionStatusRail/);
  assert.match(auth, /webmasters\.readonly/);
  assert.match(auth, /WHERE brand_id = \?/);
  assert.match(report, /new Set\(\["query", "page", "country", "device"\]\)/);
  assert.match(report, /rowLimit: 25000/);
});

test('interactive Search Console table keeps comparison, filtering, sorting, paging and CSV export', () => {
  const component = readFileSync(new URL('../app/search-console-page.tsx', import.meta.url), 'utf8');
  for (const marker of ['previousTotals', 'previousDaily', 'changeSort', 'searchConsoleFilter', 'pageCount', 'exportCsv', 'خروجی CSV']) assert.ok(component.includes(marker), marker);
});

test('SEO action controls stay inside the SEO section and cannot crash the parent report', () => {
  const component = readFileSync(new URL('../app/search-console-page.tsx', import.meta.url), 'utf8');
  const parentReport = component.slice(component.indexOf('export function SearchConsolePage('));
  assert.doesNotMatch(parentReport, /sortedVisibleOpportunities|setShowAll|changeSeoSort/);
  assert.match(component, /sortedVisibleOpportunities\.length > 12/);
  assert.match(component, /نمایش همه \$\{sortedVisibleOpportunities\.length/);
});

test('dynamic SEO engine adapts thresholds to small, medium and large datasets', () => {
  const small = analyzeSeoOpportunities([
    row('target-small', { clicks: 5, impressions: 1000, ctr: 0.005, position: 7 }),
    ...Array.from({ length: 7 }, (_, index) => row(`small-${index}`, { clicks: 2, impressions: 20 + index, ctr: 0.1, position: 25 })),
  ]);
  const medium = analyzeSeoOpportunities([
    row('target-medium', { clicks: 5, impressions: 10000, ctr: 0.005, position: 7 }),
    ...Array.from({ length: 39 }, (_, index) => row(`medium-${index}`, { clicks: 2, impressions: 40 + index, ctr: 0.04, position: 25 })),
  ]);
  const large = analyzeSeoOpportunities([
    row('target-large', { clicks: 5, impressions: 20000, ctr: 0.005, position: 7 }),
    ...Array.from({ length: 319 }, (_, index) => row(`large-${index}`, { clicks: 2, impressions: 50 + index % 4, ctr: 0.04, position: 25 })),
  ]);
  assert.equal(small.profile, 'small');
  assert.equal(medium.profile, 'medium');
  assert.equal(large.profile, 'large');
  assert.ok(small.scoreThreshold < medium.scoreThreshold && medium.scoreThreshold < large.scoreThreshold);
  assert.ok(small.opportunities.some((item) => item.key === 'target-small'));
  assert.ok(medium.opportunities.some((item) => item.key === 'target-medium'));
  assert.ok(large.opportunities.some((item) => item.key === 'target-large' && item.confidence === 'بالا'));
  assertFiniteAnalysis(small);
  assertFiniteAnalysis(medium);
  assertFiniteAnalysis(large);
});

test('dynamic SEO engine uses rank-bucket fallbacks and observed baselines', () => {
  const sparse = analyzeSeoOpportunities([
    row('outside-top-50', { impressions: 100, clicks: 1, ctr: 0.01, position: 60 }),
    row('missing-position', { impressions: 1000, clicks: 0, ctr: 0, position: 0 }),
  ]);
  assert.equal(sparse.opportunities.length, 0);
  const observed = analyzeSeoOpportunities([
    row('low-ctr-target', { clicks: 20, impressions: 1000, ctr: 0.02, position: 7 }),
    row('high-ctr-1', { clicks: 70, impressions: 1000, ctr: 0.07, position: 7 }),
    row('high-ctr-2', { clicks: 70, impressions: 1000, ctr: 0.07, position: 7 }),
    row('high-ctr-3', { clicks: 70, impressions: 1000, ctr: 0.07, position: 7 }),
    row('high-ctr-4', { clicks: 70, impressions: 1000, ctr: 0.07, position: 7 }),
  ]);
  const target = observed.opportunities.find((item) => item.key === 'low-ctr-target');
  assert.ok(target);
  assert.ok(target.expectedCtr > 0.035);
  assert.ok(target.expectedCtr <= 0.035 * 1.6);
  assert.match(target.reason, /خط مبنای پویا/);
});

test('dynamic SEO engine remains finite and deterministic for zero and duplicate data', () => {
  const empty = analyzeSeoOpportunities([
    row('zero-a', { clicks: 0, impressions: 0, ctr: 0, position: 7 }, { clicks: 0, impressions: 0, ctr: 0, position: 7 }),
    row('zero-b', { clicks: 0, impressions: 0, ctr: 0, position: 18 }, { clicks: 0, impressions: 0, ctr: 0, position: 18 }),
  ]);
  assert.equal(empty.opportunities.length, 0);
  assertFiniteAnalysis(empty);
  const duplicateRows = Array.from({ length: 10 }, (_, index) => row(`duplicate-${index}`, { clicks: index === 0 ? 1 : 40, impressions: 500, ctr: index === 0 ? 0.002 : 0.08, position: 7 }));
  const first = analyzeSeoOpportunities(duplicateRows);
  const second = analyzeSeoOpportunities(duplicateRows);
  assert.deepEqual(first, second);
  assertFiniteAnalysis(first);
});
