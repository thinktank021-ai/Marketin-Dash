import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the dashboard root is wrapped by a runtime error boundary", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const boundary = await readFile(new URL("../app/dashboard-runtime-boundary.tsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  const rangeChart = await readFile(new URL("../app/range-analytics-dashboard.tsx", import.meta.url), "utf8");
  assert.match(page, /DashboardRuntimeBoundary/);
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /dashboard-runtime-error/);
  assert.match(boundary, /DashboardSectionBoundary/);
  assert.match(boundary, /بارگذاری دوباره داشبورد/);
  assert.doesNotMatch(client, /selectedFilterChannel(?!s)/);
  assert.match(client, /dailyChannelCounts=\{selectedDateData\.dailyChannelCounts \|\| \{\}\}/);
  assert.match(rangeChart, /<BucketAxis buckets=\{buckets\} formatDate=\{formatDate\}/);
  assert.doesNotMatch(rangeChart, /<BucketAxis buckets=\{buckets\}\/>/);
  assert.match(rangeChart, /const safeDailyCounts = useMemo\(\(\) => Array\.isArray\(dailyCounts\)/);
  assert.match(rangeChart, /const safeChannels = useMemo\(\(\) => normalizeChannels\(channels\)/);
  assert.match(rangeChart, /const hoverBucket = hovered && TIME_CHARTS\.has\(hovered\.chart\)/);
  assert.doesNotMatch(rangeChart, /hoveredBucket/);
});
