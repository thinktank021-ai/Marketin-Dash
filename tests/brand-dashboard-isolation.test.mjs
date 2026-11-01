import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("main dashboard snapshots and caches are isolated per active office", async () => {
  const source = await readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");
  assert.match(source, /const sourceIdentity = `\$\{activeBrand\.id\}:\$\{activeBrand\.sheetCsvUrl\}`/);
  assert.match(source, /DASHBOARD_CACHE_PREFIX\}v4:\$\{sourceIdentity\}/);
  assert.match(source, /setDashboardData\(createEmptyDashboardData\(today\.label\)\)/);
  assert.match(source, /registerSheetMonths\(activeBrand\.id, \[\]\)/);
  assert.match(source, /setRulesReady\(false\)/);
});
