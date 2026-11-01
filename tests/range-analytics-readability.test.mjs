import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("range analytics uses collision-safe labels and one custom hover surface", async () => {
  const source = await readFile(new URL("../app/range-analytics-dashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/enhancements.css", import.meta.url), "utf8");

  assert.match(source, /function compactChartValue\(value: number \| null\)/);
  assert.match(source, /function valueLabelStep\(count: number\)/);
  assert.match(source, /function axisLabelStep\(count: number\)/);
  assert.match(source, /return <desc>\{text\}<\/desc>/);
  assert.match(source, /rangeAnalyticsCard-\$\{id\}/);
  assert.match(source, /compactChartValue\(leads\[index\]\)/);
  assert.match(source, /compactChartValue\(row\.metric\.cpl\)/);
  assert.match(source, /shortChartLabel\(route\.name\)/);
  assert.match(css, /\.rangeAnalyticsHover\{display:flex/);
  assert.match(css, /\.rangeAnalyticsValue\{font-size:7\.2px/);
  assert.match(css, /\.rangeAnalyticsCard\.rangeAnalyticsFullWidth \.rangeAnalyticsViewport svg\{height:202px/);
});
