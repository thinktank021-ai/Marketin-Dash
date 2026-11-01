import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the selected-range summary symmetric without a duplicate range card", async () => {
  const [page, css, globals] = await Promise.all([
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/enhancements.css", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /className="selectedDateIdentity"/);
  assert.match(css, /\.selectedDateSummary\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.selectedDateTopContractRoutes\{grid-column:1\/-1!important/);
  assert.match(css, /\.selectedDateTopContractRoutes ol\{display:grid;grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(page, /className="contractRouteChannels"/);
  assert.doesNotMatch(page, /className="contractRouteRank"/);
  assert.match(page, /className="contractRouteName"><b>\{route.count.toLocaleString\("fa-IR"\)\}<\/b> قرارداد \{route.name\}/);
  assert.doesNotMatch(page, /در حال دریافت اطلاعات بازهٔ انتخابی/);
  assert.match(page, /selectedDateRefreshIndicator/);
  assert.match(page, /aria-busy=\{selectedDateLoading\}/);
  assert.match(page, /<RangeConversionFunnel[\s\S]*?<section className=\{`rangeInsight/);
  assert.match(page, /resolvedOutcomeCount: resolvedOutcomeChannels\.size/);
  assert.match(page, /outcomeCountsByChannel/);
  assert.match(globals, /\.conversionFunnelStack\{[^}]*display:grid;[^}]*justify-items:center/);
  assert.match(globals, /\.conversionFunnelStage\.awareness\{width:100%/);
  assert.match(globals, /\.conversionFunnelStage\.resolved\{width:75%/);
  assert.match(globals, /\.conversionFunnelStage\.contracts\{width:62%/);
  assert.match(globals, /@media\(max-width:680px\)[^{]*\{[\s\S]*?\.conversionFunnelStage\.contracts\{width:82%/);
  assert.match(globals, /backdrop-filter:blur\(10px\) saturate\(120%\)/);
  assert.match(globals, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(page, /<span>نمایش و ارسال اولیه<\/span>/);
  assert.doesNotMatch(page, /<span>[1-4]\. /);
  assert.match(page, /Impressions گوگل ادز \+ برآورد پیامک‌های ارسالی/);
  assert.match(page, /className="funnelStageHelp"/);
  assert.match(globals, /@media\(hover:none\)/);
  assert.match(page, /className="channelPerformanceMetrics"/);
  assert.match(page, /className="summaryChips"/);
  assert.match(page, /className="summaryChips summaryContractChips"/);
  assert.match(page, /cost > 0/);
  assert.match(page, /<small>قرارداد<\/small><b>\{contracts\.toLocaleString\("en-US"\)\}/);
  assert.match(page, /<small>نرخ تبدیل<\/small><b>\{formatDashboardNumber\(conversionRate\)\}%/);
  assert.match(page, /<small>CAC کانال<\/small><b>\{cacLabel\}/);
  assert.match(globals, /\.channelPerformanceMetrics\{grid-column:1\/-1/);
  assert.match(globals, /\.conversionFunnelStage\.leads\{width:86%/);
  assert.match(globals, /\.conversionFunnelStage\.contracts\{width:58%/);
  assert.match(globals, /\.conversionFunnelStack:before\{display:none\}/);
  assert.match(globals, /\.conversionFunnelStage:after\{content:"↓"/);
  assert.match(globals, /\.conversionFunnelStage:after\{display:none\}/);
  assert.match(globals, /\.conversionFunnelDrop\{[^}]*margin:4px 0/);
});
