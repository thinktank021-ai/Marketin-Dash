import assert from "node:assert/strict";
import test from "node:test";

import { calculateFunnelRates, combineInitialInteractions, estimateSmsMessages } from "../app/funnel-metrics.ts";

test("estimates SMS count by flooring actual spend per workday", () => {
  const result = estimateSmsMessages(
    ["1405/06/01", "1405/06/02"],
    new Map([["1405/06/01", 1000], ["1405/06/02", 479]]),
    new Map([["1405/06", 480]]),
  );
  assert.deepEqual(result, { total: 2, missingBudgetDates: [], missingPriceMonths: [] });
  assert.equal(combineInitialInteractions(result.total, 900), 902);
});

test("keeps missing SMS inputs unknown instead of converting them to zero", () => {
  const missingBudget = estimateSmsMessages(["1405/06/01"], new Map(), new Map([["1405/06", 480]]));
  assert.equal(missingBudget.total, null);
  assert.deepEqual(missingBudget.missingBudgetDates, ["1405/06/01"]);

  const missingPrice = estimateSmsMessages(["1405/06/01"], new Map([["1405/06/01", 0]]), new Map());
  assert.equal(missingPrice.total, null);
  assert.deepEqual(missingPrice.missingPriceMonths, ["1405/06"]);
  assert.equal(combineInitialInteractions(null, 900), 900, "available Ads data remains visible when SMS data is missing");
  assert.equal(combineInitialInteractions(25, null), 25, "available SMS data remains visible when Ads is disconnected");
  assert.equal(combineInitialInteractions(null, null), null, "all-missing inputs remain unknown");
  assert.equal(combineInitialInteractions(0, 0), 0, "confirmed zero remains a valid value");
});

test("calculates every funnel stage cumulatively from the first input", () => {
  const rates = calculateFunnelRates(918786, 1103, 1102, 21);
  assert.equal(rates.awarenessRate, 100);
  assert.ok(Math.abs((rates.leadsRate || 0) - 0.12005) < 0.00001);
  assert.ok(Math.abs((rates.resolvedRate || 0) - 0.119941) < 0.00001);
  assert.ok(Math.abs((rates.contractsRate || 0) - 0.002286) < 0.00001);
  assert.ok(Math.abs((rates.resolvedStepRate || 0) - 99.9093) < 0.001);
  assert.ok(Math.abs((rates.contractStepRate || 0) - 1.9056) < 0.001);
});

test("does not invent percentages when the first funnel input is unavailable", () => {
  const rates = calculateFunnelRates(null, 1103, 1102, 21);
  assert.equal(rates.awarenessRate, null);
  assert.equal(rates.leadsRate, null);
  assert.equal(rates.resolvedRate, null);
  assert.equal(rates.contractsRate, null);
  assert.equal(rates.overallLeadToContractRate, (21 / 1103) * 100);
});
