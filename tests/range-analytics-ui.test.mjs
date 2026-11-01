import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getRangeAnalyticsPlan } from "../app/range-analytics.ts";

test("range analytics keeps daily labels through 31 days and aggregates longer ranges dynamically", async () => {
  const source = await readFile(new URL("../app/range-analytics-dashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/enhancements.css", import.meta.url), "utf8");

  assert.equal(getRangeAnalyticsPlan(31).bucketDays, 1);
  assert.equal(getRangeAnalyticsPlan(60).bucketDays, 1);
  assert.equal(getRangeAnalyticsPlan(90).bucketDays, 7);
  assert.match(source, /if \(count <= 31\) return 1/);
  assert.match(source, /bucketAxisLabel\(bucket\)/);
  assert.doesNotMatch(source, /rangeAnalyticsDateStrip/);
  assert.match(css, /\.rangeAnalyticsCard\.rangeAnalyticsFullWidth \.rangeAnalyticsViewport svg\{height:202px/);
});

test("range analytics channel chips support multi-select without hiding the comparison context", async () => {
  const source = await readFile(new URL("../app/range-analytics-dashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /setChartChannelFilters\(current => current\.includes\(channel\.name\) \? current\.filter\(name => name !== channel\.name\) : \[\.\.\.current, channel\.name\]\)/);
  assert.match(source, /className=\{isSelected \? "selected" : hasChartChannelFilter \? "muted" : ""\}/);
  assert.match(source, /rangeAnalyticsLegendReset/);
});
