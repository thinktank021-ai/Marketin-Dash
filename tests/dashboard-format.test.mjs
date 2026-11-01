import assert from "node:assert/strict";
import test from "node:test";

import { formatDashboardNumber, formatDashboardToman } from "../app/dashboard-format.ts";

test("dashboard formatters never show fractional digits", () => {
  assert.equal(formatDashboardNumber(636465.4), "636,465");
  assert.equal(formatDashboardNumber(28927353.3), "28,927,353");
  assert.equal(formatDashboardNumber(10.8), "11");
  assert.equal(formatDashboardToman(636465.4), "تومان 636,465");
});
