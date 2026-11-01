import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("range analytics includes the five approved lightweight visual models", async () => {
  const source = await readFile(new URL("../app/range-analytics-dashboard.tsx", import.meta.url), "utf8");
  for (const id of ["range-donut", "range-heatmap", "range-bubble", "range-treemap", "range-waterfall"]) {
    assert.match(source, new RegExp(`ChartFrame id=\\"${id}\\"`), id);
  }
  assert.match(source, /layoutTreemap/);
  assert.match(source, /rangeAnalyticsDonutSegment/);
  assert.match(source, /rangeAnalyticsHeatmapCell/);
  assert.match(source, /rangeAnalyticsBubble/);
  assert.match(source, /rangeAnalyticsWaterfallBar/);
  assert.match(source, /onMouseEnter=\{\(\) => setHovered/);
  assert.match(source, /onResetSelection = \(\) => \{\}/);
});
