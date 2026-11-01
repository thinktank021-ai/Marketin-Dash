import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("Google Ads report omits the non-operational coding copy", () => {
  assert.doesNotMatch(page, /کدنویسی لازم نیست/);
});

test("daily leads and cost share one labelled point chart", () => {
  assert.equal((page.match(/className="adsCombinedTrend"/g) || []).length, 1);
  assert.match(page, /روند روزانه هزینه و لید/);
  assert.match(page, /className="adsCombinedLine cost"/);
  assert.match(page, /className="adsCombinedLine lead"/);
  assert.match(page, /className="adsCombinedValue cost"/);
  assert.match(page, /className="adsCombinedValue lead"/);
  assert.doesNotMatch(page, /<strong>روند روزانه لید<\/strong>/);
  assert.doesNotMatch(page, /<strong>روند روزانه هزینه<\/strong>/);
});

test("combined chart and route analysis are contained on narrow screens", () => {
  assert.match(css, /\.adsCombinedTrend\{max-width:100%;overflow:hidden\}/);
  assert.match(css, /\.adsCombinedViewport\{[^}]*max-width:100%;[^}]*overflow-x:auto;[^}]*overflow-y:hidden/);
  assert.match(css, /\.routePerformanceSection\{max-width:100%;min-width:0/);
  assert.match(css, /@media\(max-width:520px\)\{\.routePerformanceSection/);
});

test("both Google Ads tables expose independent sortable headers", () => {
  assert.match(page, /dailyTableSort/);
  assert.match(page, /campaignTableSort/);
  assert.match(page, /dailyTableRows\.map/);
  assert.match(page, /campaignTableRows\.map/);
  assert.equal((page.match(/<SortableTableHeader/g) || []).length, 21);
  assert.match(page, /label="تعداد لید" column="leads"/);
  assert.match(page, /label="قرارداد منتسب" column="contracts"/);
  assert.match(page, /label="هزینه \(تومان\)" column="costToman"/);
  assert.match(css, /\.tableSortButton\{/);
});

test("route-first analysis replaces empty campaign attribution and campaign totals use reconciled sums", () => {
  assert.match(page, /عملکرد مسیرهای Google Ads/);
  assert.match(page, /routePerformance\.unmatchedCampaigns/);
  assert.doesNotMatch(page, /هزینه و لید روزانه کمپین/);
  assert.doesNotMatch(page, /ماتریس کارایی کمپین‌ها/);
  assert.match(page, /campaignTotals\.impressions\.toLocaleString/);
  assert.match(page, /campaignTotals\.clicks \/ campaignTotals\.impressions/);
  assert.match(page, /campaignTotals\.cost \/ campaignTotals\.clicks/);
});
