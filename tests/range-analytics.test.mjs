import assert from "node:assert/strict";
import test from "node:test";

import { buildMovingAverage, buildRangeAnalyticsBuckets, getRangeAnalyticsPlan } from "../app/range-analytics.ts";

const channels = [
  { name: "Google Ads", color: "teal", keys: ["Google Ads"] },
  { name: "اینستاگرام", color: "coral", keys: ["اینستاگرام"] },
];

function days(count) {
  return Array.from({ length: count }, (_, index) => ({
    date: `1405/06/${String(index + 1).padStart(2, "0")}`,
    value: index + 1,
    contracts: index % 3 === 0 ? 1 : 0,
  }));
}

test("range plan keeps daily points through 60 days and aggregates after that", () => {
  assert.equal(getRangeAnalyticsPlan(31).bucketDays, 1);
  assert.equal(getRangeAnalyticsPlan(60).bucketDays, 1);
  assert.equal(getRangeAnalyticsPlan(61).bucketDays, 7);
  assert.equal(getRangeAnalyticsPlan(181).bucketDays, 30);
});

test("range buckets preserve totals, date bounds, and bucket day counts", () => {
  const source = days(8);
  const dailyChannels = Object.fromEntries(source.map(day => [day.date, { "Google Ads": day.value, "اینستاگرام": 1 }]));
  const dailyContracts = Object.fromEntries(source.map(day => [day.date, { "Google Ads": day.contracts }]));
  const result = buildRangeAnalyticsBuckets(source, dailyChannels, dailyContracts, channels);
  assert.equal(result.plan.bucketDays, 1);
  assert.equal(result.buckets.length, 8);
  assert.deepEqual(result.buckets[0], {
    key: "1405/06/01-1405/06/01",
    startDate: "1405/06/01",
    endDate: "1405/06/01",
    days: 1,
    value: 1,
    contracts: 1,
    channelValues: { "Google Ads": 1, "اینستاگرام": 1 },
    channelContracts: { "Google Ads": 1, "اینستاگرام": 0 },
  });

  const longSource = days(61);
  const longChannels = Object.fromEntries(longSource.map(day => [day.date, { "Google Ads": 1 }]));
  const longResult = buildRangeAnalyticsBuckets(longSource, longChannels, {}, channels);
  assert.equal(longResult.plan.bucketDays, 7);
  assert.equal(longResult.buckets[0].days, 7);
  assert.equal(longResult.buckets.at(-1).days, 5);
  assert.equal(longResult.buckets.reduce((sum, bucket) => sum + bucket.value, 0), longSource.reduce((sum, day) => sum + day.value, 0));
});

test("moving average uses only available leading days and then a seven-day window", () => {
  assert.deepEqual(buildMovingAverage([2, 4, 6], 7), [2, 3, 4]);
  assert.deepEqual(buildMovingAverage([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);
});

test("range buckets tolerate incomplete cached channel payloads without throwing", () => {
  const result = buildRangeAnalyticsBuckets([
    { date: "1405/06/01", value: "3", contracts: undefined },
  ], {
    "1405/06/01": { "Google_Ads": "3", broken: "not-a-number" },
  }, undefined, [
    { name: "Google Ads", color: undefined, keys: ["Google Ads"] },
  ]);
  assert.equal(result.buckets[0].value, 3);
  assert.equal(result.buckets[0].contracts, 0);
  assert.deepEqual(result.buckets[0].channelValues, { "Google Ads": 3 });
});

test("range buckets tolerate malformed optional arrays and maps", () => {
  assert.doesNotThrow(() => buildRangeAnalyticsBuckets(
    { broken: true },
    null,
    { "1405/06/01": null },
    { broken: true },
  ));
  const result = buildRangeAnalyticsBuckets([
    { date: undefined, value: "not-a-number", contracts: null },
  ], null, null, [
    { name: "کانال ناقص", color: undefined, keys: undefined },
  ]);
  assert.equal(result.buckets[0].value, 0);
  assert.equal(result.buckets[0].contracts, 0);
  assert.deepEqual(result.buckets[0].channelValues, { "کانال ناقص": 0 });
});
